/**
 * Session JSONL ingester — Option B node granularity.
 *
 * Reads ~/.openclaw/agents/<agentId>/sessions/*.jsonl files and ingests them
 * into the SQLite graph. Incremental: tracks byte offsets per file so
 * re-runs only process new content.
 *
 * Graph decisions made here:
 *   - Each JSONL file → one session node
 *   - Each message entry (role=user|assistant) → one message node
 *   - Each toolCall content block in an assistant message → one tool_call node
 *     linked to the parent message via an "invokes" edge
 *   - Each toolResult JSONL entry → one tool_result node linked to its
 *     matching tool_call node via a "returns" edge (correlated by toolCallId)
 *   - sequence edges link consecutive nodes in the conversation flow
 *   - agent, channel, peer, session_key edges hang off the session node
 *
 * Session key parsing (from the routing layer):
 *   agent:<agentId>:discord:tank:direct:<userId>
 *   agent:<agentId>:slack:channel:<channelId>:thread:<ts>
 *   agent:<agentId>:direct:eddie
 *   agent:<agentId>:cron:<uuid>
 *   etc.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { EdgeType, GraphEdge, GraphNode, NodeType } from "./db.js";
import { insertEdge, upsertNode, isHeartbeatFirstMessage, markDuplicateNodes, migrateVirtualHierarchy } from "./db.js";

export interface IngestOptions {
  agentsDir?: string;
  /** If set, only ingest this agent. */
  agentId?: string;
  /** Max chars to store for content_text (avoids huge blobs). */
  maxContentChars?: number;
  /**
   * Base directory for Claude Code transcript files.
   * Defaults to ~/.claude/projects.
   * Used to cross-reference .claude-binding.json → threadId → user prompts.
   */
  claudeProjectsDir?: string;
  onProgress?: (msg: string) => void;
}

export interface IngestResult {
  filesProcessed: number;
  filesSkipped: number;
  nodesAdded: number;
  edgesAdded: number;
  errors: string[];
}

function shortHash(...parts: string[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

function parseSessionKey(key: string): {
  agentId: string;
  channel?: string;
  peerKind?: string;
  peerId?: string;
  groupId?: string;
  threadId?: string;
  cronId?: string;
} {
  // agent:<agentId>:...
  const m = key.match(/^agent:([^:]+):(.+)$/);
  if (!m) return { agentId: key };
  const agentId = m[1];
  const rest = m[2];

  // cron:<uuid>
  const cron = rest.match(/^cron:(.+)$/);
  if (cron) return { agentId, cronId: cron[1] };

  // direct:<peerId>  (legacy per-peer)
  const direct = rest.match(/^direct:(.+)$/);
  if (direct) return { agentId, peerKind: "direct", peerId: direct[1] };

  // <channel>:<agentId>:direct:<userId>
  const chanDirect = rest.match(/^([^:]+):[^:]+:direct:(.+)$/);
  if (chanDirect) return { agentId, channel: chanDirect[1], peerKind: "direct", peerId: chanDirect[2] };

  // <channel>:channel:<groupId>:thread:<threadId>
  const chanThread = rest.match(/^([^:]+):channel:([^:]+):thread:(.+)$/);
  if (chanThread)
    return { agentId, channel: chanThread[1], peerKind: "channel", groupId: chanThread[2], threadId: chanThread[3] };

  // <channel>:channel:<groupId>
  const chanGroup = rest.match(/^([^:]+):channel:([^:]+)$/);
  if (chanGroup) return { agentId, channel: chanGroup[1], peerKind: "channel", groupId: chanGroup[2] };

  // <channel>:group:<groupId>
  const chanGrp = rest.match(/^([^:]+):group:([^:]+)$/);
  if (chanGrp) return { agentId, channel: chanGrp[1], peerKind: "group", groupId: chanGrp[2] };

  return { agentId };
}

function extractText(content: unknown, maxChars: number): string {
  if (typeof content === "string") return content.slice(0, maxChars);
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        if (typeof c === "string") return c;
        if (!c || typeof c !== "object") return "";
        const block = c as Record<string, unknown>;
        if (typeof block.text === "string") return block.text;
        // Skip toolCall blocks — they are now separate nodes, not embedded text
        if (block.type === "toolCall") return "";
        // toolResult block — content may be string or array
        if (block.type === "toolResult") {
          return extractText(block.content, maxChars);
        }
        if (block.type === "thinking" && typeof block.thinking === "string") {
          return `<thinking:${block.thinking.slice(0, 100)}>`;
        }
        return "";
      })
      .join(" ")
      .trim()
      .slice(0, maxChars);
  }
  return "";
}

/** Extract tool calls from an assistant message's content blocks. */
interface ToolCallBlock {
  toolCallId: string;
  name: string;
  args: string;    // JSON-stringified, truncated
}

function extractToolCalls(content: unknown, maxArgChars = 500): ToolCallBlock[] {
  if (!Array.isArray(content)) return [];
  const calls: ToolCallBlock[] = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const block = c as Record<string, unknown>;
    if (block.type !== "toolCall" || typeof block.name !== "string") continue;
    const id = typeof block.id === "string" ? block.id : "";
    const args = block.arguments
      ? JSON.stringify(block.arguments).slice(0, maxArgChars)
      : "";
    calls.push({ toolCallId: id, name: block.name, args });
  }
  return calls;
}

function estimateTokens(text: string): number {
  // ~4 chars per token rough estimate
  return Math.ceil(text.length / 4);
}

async function readJsonlLines(filePath: string): Promise<{ lines: string[]; totalBytes: number }> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let totalBytes = 0;
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      totalBytes += Buffer.byteLength(line, "utf8") + 1; // +1 for newline
      lines.push(line);
    });
    rl.on("close", () => resolve({ lines, totalBytes }));
    rl.on("error", reject);
    stream.on("error", reject);
  });
}

/**
 * Extract user-turn text from a Claude Code transcript JSONL.
 *
 * Claude Code records each session under:
 *   ~/.claude/projects/<cwd-with-slashes-and-dots-as-dashes>/<threadId>.jsonl
 *
 * Each entry is typed. We want `type: "user"` entries whose message.content
 * array contains `{type:"text"}` blocks — these are the actual human prompts.
 * Tool result turns are also `type:"user"` but contain `{type:"tool_result"}`
 * blocks with no text, so filtering for non-empty text naturally excludes them.
 *
 * Injected OpenClaw context blocks (<system-reminder>, <plans_and_tasks>, etc.)
 * are stripped so only the human's actual words are stored.
 *
 * Returns an array of { ts, text } in chronological order.
 */
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024; // skip transcripts > 2 MB

async function readClaudeTranscriptUserTurns(
  threadId: string,
  cwd: string,
  claudeProjectsBase: string,
  maxChars: number,
): Promise<Array<{ ts: number; text: string }>> {
  try {
    // Map cwd → Claude project dir: every / and . becomes -
    const projectKey = cwd.replace(/[/.]/g, "-");
    const transcriptPath = join(claudeProjectsBase, projectKey, `${threadId}.jsonl`);

    // Guard: skip very large transcripts to avoid OOM
    const fileStat = await stat(transcriptPath);
    if (fileStat.size > MAX_TRANSCRIPT_BYTES) return [];

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(transcriptPath, "utf8");
    const results: Array<{ ts: number; text: string }> = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type !== "user") continue;
        const ts = entry.timestamp ? new Date(entry.timestamp as string).getTime() : 0;
        const msg = entry.message as Record<string, unknown> | undefined;
        if (!msg) continue;
        const content = msg.content;
        if (!Array.isArray(content)) continue;
        // Collect text blocks only (not tool_result blocks)
        const textParts: string[] = [];
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            textParts.push(b.text);
          }
        }
        if (textParts.length === 0) continue;
        let text = textParts.join("\n").trim();
        // Strip OpenClaw-injected XML context blocks
        text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
        text = text.replace(/<plans_and_tasks>[\s\S]*?<\/plans_and_tasks>/g, "").trim();
        text = text.replace(/<[a-z_-]+>[^<]{0,20}<\/[a-z_-]+>/g, "").trim();
        if (text) results.push({ ts, text: text.slice(0, maxChars) });
      } catch { continue; }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Try to read sessionKey from the companion .trajectory.jsonl file.
 * The trajectory's first "session.started" entry has a `sessionKey` field
 * that is the authoritative routing key for this session.
 */
async function resolveSessionKeyFromTrajectory(trajectoryPath: string): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(trajectoryPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === "session.started" && typeof entry.sessionKey === "string") {
          return entry.sessionKey;
        }
      } catch { continue; }
    }
  } catch {
    // trajectory file doesn't exist or is unreadable — not an error
  }
  return undefined;
}

export async function ingestAgent(
  db: Database.Database,
  agentId: string,
  agentsDir: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const maxContent = opts.maxContentChars ?? 2000;
  const claudeProjectsDir = (opts.claudeProjectsDir ?? join(homedir(), ".claude", "projects"))
    .replace("~", homedir());
  const log = opts.onProgress ?? (() => {});
  const sessionsDir = join(agentsDir, agentId, "sessions");
  const result: IngestResult = { filesProcessed: 0, filesSkipped: 0, nodesAdded: 0, edgesAdded: 0, errors: [] };

  let files: string[];
  try {
    const entries = await readdir(sessionsDir);
    files = entries.filter((f) => f.endsWith(".jsonl") && !f.includes(".trajectory."));
  } catch {
    log(`[graph-context] no sessions dir for agent ${agentId}, skipping`);
    return result;
  }

  // Load sessions.json once for this agent
  let sessionKeyMap: Record<string, string> = {};
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(sessionsDir, "sessions.json"), "utf8");
    const map = JSON.parse(raw) as Record<string, { sessionId?: string }>;
    for (const [key, val] of Object.entries(map)) {
      if (val?.sessionId) sessionKeyMap[val.sessionId] = key;
    }
  } catch {
    // best effort
  }

  // Bulk-load all ingest_state records for this agent into a Map to avoid per-file DB lookups.
  type IngestStateRow = { session_file: string; bytes_read: number; session_id: string };
  const ingestStateMap = new Map<string, IngestStateRow>(
    (db.prepare("SELECT session_file, bytes_read, session_id FROM ingest_state WHERE agent_id = ?")
      .all(agentId) as IngestStateRow[])
      .map((r) => [r.session_file, r])
  );

  // Bulk-load session IDs that already have user-role message nodes, so the backfill
  // path can be skipped without a per-session DB query.
  const sessionsWithUserTurns = new Set<string>(
    (db.prepare(
      "SELECT DISTINCT session_id FROM nodes WHERE agent_id = ? AND type = 'message' AND role = 'user'"
    ).all(agentId) as { session_id: string }[]).map((r) => r.session_id)
  );

  for (const file of files) {
    const filePath = join(sessionsDir, file);
    try {
      const existing = ingestStateMap.get(filePath);

      // Fast skip: if already fully ingested and user turns are present, no work to do.
      // Avoid stat entirely for these — they are the vast majority on repeated ingests.
      if (existing && existing.bytes_read > 0 && sessionsWithUserTurns.has(existing.session_id)) {
        result.filesSkipped++;
        continue;
      }

      const fileStat = await stat(filePath);
      const fileSize = fileStat.size;

      if (existing && existing.bytes_read >= fileSize) {
        // File is fully ingested — but user turns from the Claude transcript may not
        // have been added yet (they come from a separate file, not the JSONL).
        // Backfill them now if none exist for this session.
        const hasUserTurns = (db.prepare(
          "SELECT COUNT(*) as c FROM nodes WHERE session_id=? AND type='message' AND role='user'"
        ).get(existing.session_id) as { c: number }).c > 0;

        if (!hasUserTurns) {
          const bindingPath = filePath.replace(/\.jsonl$/, ".jsonl.claude-binding.json");
          try {
            const { readFile } = await import("node:fs/promises");
            const binding = JSON.parse(await readFile(bindingPath, "utf8")) as Record<string, unknown>;
            const threadId = typeof binding.threadId === "string" ? binding.threadId : null;
            const bindingCwd = typeof binding.cwd === "string" ? binding.cwd : null;
            if (threadId && bindingCwd) {
              const turns = await readClaudeTranscriptUserTurns(threadId, bindingCwd, claudeProjectsDir, maxContent);
              if (turns.length > 0) {
                // Need the session_key to create nodes — look it up from the session node
                const sessionRow = db.prepare(
                  "SELECT session_key FROM nodes WHERE session_id=? AND type='session' LIMIT 1"
                ).get(existing.session_id) as { session_key: string } | undefined;
                const sessionKey = sessionRow?.session_key ?? `agent:${agentId}:unknown:${existing.session_id}`;
                const sessionNodeId = `session:${existing.session_id}`;
                const firstSeqNode = db.prepare(
                  "SELECT id FROM nodes WHERE session_id=? AND type='message' ORDER BY ts ASC LIMIT 1"
                ).get(existing.session_id) as { id: string } | undefined;

                db.transaction(() => {
                  let prevId: string | null = null;
                  for (const turn of turns) {
                    const turnNodeId = `msg:${existing.session_id}:${shortHash("user_turn", existing.session_id, String(turn.ts))}`;
                    upsertNode(db, {
                      id: turnNodeId, type: "message" as NodeType,
                      agent_id: agentId, session_id: existing.session_id,
                      session_key: sessionKey, role: "user",
                      ts: turn.ts, content_text: turn.text,
                      content_tokens: estimateTokens(turn.text),
                    });
                    result.nodesAdded++;
                    const seqSrc = prevId ?? sessionNodeId;
                    insertEdge(db, { id: shortHash("seq", seqSrc, turnNodeId), src: seqSrc, dst: turnNodeId, type: "sequence", weight: 1 });
                    result.edgesAdded++;
                    prevId = turnNodeId;
                  }
                  // Link last user turn → first existing message so the chain connects
                  if (prevId && firstSeqNode) {
                    insertEdge(db, { id: shortHash("seq", prevId, firstSeqNode.id), src: prevId, dst: firstSeqNode.id, type: "sequence", weight: 1 });
                    result.edgesAdded++;
                  }
                })();
              }
            }
          } catch { /* no binding or transcript — skip silently */ }
        }

        result.filesSkipped++;
        continue;
      }

      const { lines } = await readJsonlLines(filePath);
      if (lines.length === 0) {
        result.filesSkipped++;
        continue;
      }

      // Parse session header (first line)
      let sessionHeader: { id?: string; timestamp?: string; cwd?: string } = {};
      try {
        const firstLine = JSON.parse(lines[0]);
        if (firstLine.type === "session") sessionHeader = firstLine;
      } catch {
        result.filesSkipped++;
        continue;
      }

      const sessionId = sessionHeader.id ?? file.replace(".jsonl", "");
      const fileUuid = file.replace(".jsonl", "");
      const sessionTs = sessionHeader.timestamp ? new Date(sessionHeader.timestamp).getTime() : 0;

      // Resolve session key: sessions.json (Slack sessions) → trajectory file → unknown fallback.
      // sessions.json uses the filename UUID as the sessionId key; the JSONL header may have a
      // different internal ID. Try both.
      const trajectoryPath = filePath.replace(/\.jsonl$/, ".trajectory.jsonl");
      const sessionKey =
        sessionKeyMap[sessionId] ??
        sessionKeyMap[fileUuid] ??
        (await resolveSessionKeyFromTrajectory(trajectoryPath)) ??
        `agent:${agentId}:unknown:${sessionId}`;
      const parsed = parseSessionKey(sessionKey);

      // Cross-reference Claude Code transcript for user prompts, and capture the
      // developerInstructionsFingerprint which identifies the exact RefFiles set injected.
      const bindingPath = filePath.replace(/\.jsonl$/, ".jsonl.claude-binding.json");
      let claudeUserTurns: Array<{ ts: number; text: string }> = [];
      let devInstructionsFingerprint: string | null = null;
      try {
        const { readFile } = await import("node:fs/promises");
        const binding = JSON.parse(await readFile(bindingPath, "utf8")) as Record<string, unknown>;
        const threadId = typeof binding.threadId === "string" ? binding.threadId : null;
        const bindingCwd = typeof binding.cwd === "string" ? binding.cwd : null;
        devInstructionsFingerprint = typeof binding.developerInstructionsFingerprint === "string"
          ? binding.developerInstructionsFingerprint : null;
        if (threadId && bindingCwd) {
          claudeUserTurns = await readClaudeTranscriptUserTurns(
            threadId, bindingCwd, claudeProjectsDir, maxContent,
          );
        }
      } catch {
        // No binding file or unreadable — normal for non-claude-server sessions
      }

      // Wrap the entire file's inserts in a transaction for speed + atomicity.
      const ingestFile = db.transaction(() => {
      // --- Session node ---
      // Detect heartbeat sessions: first message content is exactly "HEARTBEAT_OK"
      // (or the session key contains ":heartbeat" from the trajectory resolution).
      const isHeartbeatByKey = sessionKey.includes(":heartbeat") || sessionKey.includes("unknown:") || sessionKey.includes(":cron:");
      const isHeartbeatByContent = (() => {
        for (const line of lines.slice(1)) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            if (entry.type !== "message") continue;
            const msg = entry.message as { role?: string; content?: unknown } | undefined;
            if (!msg?.role || msg.role === "toolResult") continue;
            const text = extractText(msg.content, 60).trim();
            return isHeartbeatFirstMessage(text);
          } catch { continue; }
        }
        return false;
      })();
      const kind = (isHeartbeatByKey || isHeartbeatByContent) ? "heartbeat" : undefined;

      // Classify session type for the virtual hierarchy.
      // Derived from the transport segment of the session key: agent:<id>:<transport>:...
      // This is the canonical classification — transport determines both the session_type
      // node and the expected ref_files list.
      const sessionType: string = (() => {
        if (sessionKey.includes(":heartbeat")) return "heartbeat";
        if (sessionKey.includes(":cron:")) return "cron";
        if (sessionKey.includes(":subagent:")) return "subagent";
        const parts = sessionKey.split(":");
        const transport = parts[2] ?? "";
        if (transport === "slack") return "slack";
        if (transport === "discord") return "discord";
        if (transport === "direct") return "direct";
        // Sessions with unknown routing key but a real devInstructions fingerprint
        // are genuine interactive sessions whose routing was not recorded.
        if (transport === "unknown" && devInstructionsFingerprint) return "direct";
        return "unknown";
      })();

      const sessionNodeId = `session:${sessionId}`;
      const sessionNode: GraphNode = {
        id: sessionNodeId,
        type: "session" as NodeType,
        agent_id: agentId,
        session_id: sessionId,
        session_key: sessionKey,
        ts: sessionTs,
        properties: JSON.stringify({
          cwd: sessionHeader.cwd,
          ...(kind ? { kind } : {}),
          sessionType,
          ...(devInstructionsFingerprint ? { devInstructionsFingerprint } : {}),
        }),
      };
      upsertNode(db, sessionNode);
      result.nodesAdded++;

      // --- Session-level edges (agent, channel, peer) ---
      const agentEdgeId = shortHash("agent", sessionNodeId, agentId);
      insertEdge(db, {
        id: agentEdgeId,
        src: sessionNodeId,
        dst: `agent:${agentId}`,
        type: "agent",
        weight: 1,
      });
      result.edgesAdded++;

      if (parsed.channel) {
        const channelEdgeId = shortHash("channel", sessionNodeId, parsed.channel);
        insertEdge(db, {
          id: channelEdgeId,
          src: sessionNodeId,
          dst: `channel:${parsed.channel}`,
          type: "channel",
          weight: 1,
        });
        result.edgesAdded++;
      }

      if (parsed.peerId) {
        const peerEdgeId = shortHash("peer", sessionNodeId, parsed.peerId);
        insertEdge(db, {
          id: peerEdgeId,
          src: sessionNodeId,
          dst: `peer:${parsed.peerId}`,
          type: "peer",
          weight: 1,
        });
        result.edgesAdded++;
      }

      if (parsed.groupId) {
        const groupEdgeId = shortHash("peer", sessionNodeId, `group:${parsed.groupId}`);
        insertEdge(db, {
          id: groupEdgeId,
          src: sessionNodeId,
          dst: `peer:group:${parsed.groupId}`,
          type: "peer",
          weight: 1,
        });
        result.edgesAdded++;
      }

      // session_key edge (raw string, for querying)
      const skEdgeId = shortHash("session_key", sessionNodeId, sessionKey);
      insertEdge(db, {
        id: skEdgeId,
        src: sessionNodeId,
        dst: `session_key:${sessionKey}`,
        type: "session_key",
        weight: 1,
      });
      result.edgesAdded++;

      // --- Message, tool_call, and tool_result nodes ---
      // We maintain two maps:
      //   prevNodeId — the last node in the sequence flow (for sequence edges)
      //   toolCallNodeById — toolCallId → tool_call node id (for returns edges)
      let prevNodeId: string | null = null;
      const toolCallNodeById = new Map<string, string>(); // toolCallId → nodeId

      // Build a merged, timestamp-ordered event list: user turns from the Claude
      // transcript interleaved with JSONL messages. This gives a chronological
      // conversation flow: user prompt → tool calls → assistant reply → user prompt → …
      type UserTurnEvent = { kind: "user_turn"; ts: number; text: string };
      type JsonlEvent = { kind: "jsonl"; ts: number; line: string };
      type Event = UserTurnEvent | JsonlEvent;

      // Parse JSONL message timestamps for sorting
      const jsonlEvents: JsonlEvent[] = [];
      for (const line of lines.slice(1)) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (entry.type !== "message") continue;
          const msg = entry.message as { timestamp?: number } | undefined;
          const entryTs = typeof entry.timestamp === "string"
            ? new Date(entry.timestamp).getTime()
            : (msg?.timestamp ?? sessionTs);
          jsonlEvents.push({ kind: "jsonl", ts: entryTs, line });
        } catch { continue; }
      }

      const userTurnEvents: UserTurnEvent[] = claudeUserTurns.map(t => ({
        kind: "user_turn", ts: t.ts, text: t.text,
      }));

      // Merge by timestamp. User turns go before JSONL events at the same ts.
      const allEvents: Event[] = [...userTurnEvents, ...jsonlEvents].sort(
        (a, b) => a.ts !== b.ts ? a.ts - b.ts : (a.kind === "user_turn" ? -1 : 1)
      );

      for (const ev of allEvents) {
        if (ev.kind === "user_turn") {
          const turnId = shortHash("user_turn", sessionId, String(ev.ts));
          const nodeId = `msg:${sessionId}:${turnId}`;
          upsertNode(db, {
            id: nodeId,
            type: "message" as NodeType,
            agent_id: agentId,
            session_id: sessionId,
            session_key: sessionKey,
            role: "user",
            ts: ev.ts,
            content_text: ev.text,
            content_tokens: estimateTokens(ev.text),
          });
          result.nodesAdded++;
          const seqSrc = prevNodeId ?? sessionNodeId;
          insertEdge(db, { id: shortHash("seq", seqSrc, nodeId), src: seqSrc, dst: nodeId, type: "sequence", weight: 1 });
          result.edgesAdded++;
          prevNodeId = nodeId;
          continue;
        }

        // jsonl event — parse and handle below
        const line = ev.line;
        {
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        if (entry.type !== "message") continue;

        const msg = entry.message as {
          role?: string;
          content?: unknown;
          timestamp?: number;
          usage?: unknown;
          model?: string;
          toolCallId?: string;  // legacy: some formats put it at top level
          meta?: {              // current format: toolCallId/toolName live here
            toolCallId?: string;
            toolName?: string;
            isError?: boolean;
            exitCode?: number;
            startedAt?: number;
          };
        } | undefined;
        if (!msg?.role) continue;

        const msgTs = typeof entry.timestamp === "string"
          ? new Date(entry.timestamp).getTime()
          : (typeof msg.timestamp === "number" ? msg.timestamp : sessionTs);

        const entryId = typeof entry.id === "string" ? entry.id : shortHash("msg", sessionId, String(msgTs));

        // --- toolResult entries → tool_result nodes ---
        if (msg.role === "toolResult") {
          // toolCallId and toolName live in msg.meta (current format) or msg directly (legacy)
          const toolCallId = msg.meta?.toolCallId ?? msg.toolCallId ?? "";
          const toolName = msg.meta?.toolName ?? "";

          // content_text: prefer actual content, fall back to labeling by tool name
          const rawText = extractText(msg.content, maxContent * 2);
          const contentText = (rawText || toolName
            ? (rawText || `[${toolName} result]`).slice(0, maxContent)
            : "");
          const tokens = estimateTokens(rawText);

          // Collect exit code from meta or content blocks
          const exitCode = msg.meta?.exitCode ?? (() => {
            if (Array.isArray(msg.content)) {
              for (const b of msg.content) {
                if (b && typeof b === "object") {
                  const details = (b as Record<string, unknown>).details;
                  if (details && typeof details === "object") {
                    const ec = (details as Record<string, unknown>).exitCode;
                    if (ec !== undefined) return ec;
                  }
                }
              }
            }
            return undefined;
          })();

          const trProps: Record<string, unknown> = { toolCallId };
          if (toolName) trProps.name = toolName;
          if (msg.meta?.isError) trProps.isError = true;
          if (exitCode !== undefined) trProps.exitCode = exitCode;

          const trNodeId = `tool_result:${sessionId}:${entryId}`;
          upsertNode(db, {
            id: trNodeId,
            type: "tool_result" as NodeType,
            agent_id: agentId,
            session_id: sessionId,
            session_key: sessionKey,
            ts: msgTs,
            content_text: contentText,
            content_tokens: tokens,
            properties: JSON.stringify(trProps),
          });
          result.nodesAdded++;

          // sequence edge from prev node
          const seqSrc = prevNodeId ?? sessionNodeId;
          insertEdge(db, {
            id: shortHash("seq", seqSrc, trNodeId),
            src: seqSrc, dst: trNodeId, type: "sequence", weight: 1,
          });
          result.edgesAdded++;

          // returns edge: tool_call → tool_result (if we have the tool_call node)
          if (toolCallId && toolCallNodeById.has(toolCallId)) {
            const tcNodeId = toolCallNodeById.get(toolCallId)!;
            insertEdge(db, {
              id: shortHash("returns", tcNodeId, trNodeId),
              src: tcNodeId, dst: trNodeId, type: "returns", weight: 1,
            });
            result.edgesAdded++;
          }

          prevNodeId = trNodeId;
          continue;
        }

        // --- user / assistant message nodes ---
        if (msg.role !== "user" && msg.role !== "assistant") continue;

        const rawText = extractText(msg.content, maxContent * 2);
        const contentText = rawText.slice(0, maxContent);
        const tokens = estimateTokens(rawText);

        const props: Record<string, unknown> = {};
        if (msg.model) props.model = msg.model;

        const msgNodeId = `msg:${sessionId}:${entryId}`;
        upsertNode(db, {
          id: msgNodeId,
          type: "message" as NodeType,
          agent_id: agentId,
          session_id: sessionId,
          session_key: sessionKey,
          role: msg.role as "user" | "assistant",
          ts: msgTs,
          content_text: contentText,
          content_tokens: tokens,
          properties: Object.keys(props).length > 0 ? JSON.stringify(props) : undefined,
        });
        result.nodesAdded++;

        // sequence edge from prev node (or session node if first)
        const seqSrc = prevNodeId ?? sessionNodeId;
        insertEdge(db, {
          id: shortHash("seq", seqSrc, msgNodeId),
          src: seqSrc, dst: msgNodeId, type: "sequence", weight: 1,
        });
        result.edgesAdded++;

        prevNodeId = msgNodeId;

        // --- For assistant messages: expand toolCall blocks into tool_call nodes ---
        if (msg.role === "assistant") {
          const toolCalls = extractToolCalls(msg.content);
          for (const tc of toolCalls) {
            const tcNodeId = tc.toolCallId
              ? `tool_call:${tc.toolCallId}`
              : shortHash("tool_call", sessionId, entryId, tc.name);

            upsertNode(db, {
              id: tcNodeId,
              type: "tool_call" as NodeType,
              agent_id: agentId,
              session_id: sessionId,
              session_key: sessionKey,
              ts: msgTs,
              content_text: `${tc.name}(${tc.args})`.slice(0, maxContent),
              content_tokens: estimateTokens(tc.args),
              properties: JSON.stringify({ toolCallId: tc.toolCallId, name: tc.name }),
            });
            result.nodesAdded++;

            // invokes edge: message → tool_call
            insertEdge(db, {
              id: shortHash("invokes", msgNodeId, tcNodeId),
              src: msgNodeId, dst: tcNodeId, type: "invokes", weight: 1,
            });
            result.edgesAdded++;

            // Register for returns edge correlation
            if (tc.toolCallId) toolCallNodeById.set(tc.toolCallId, tcNodeId);
          }
        }
        } // end jsonl event block
      } // end allEvents loop

      // Update ingest state (inside transaction)
      db.prepare(`
        INSERT OR REPLACE INTO ingest_state
          (session_file, agent_id, session_id, session_key, bytes_read, node_count, last_ingested)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(filePath, agentId, sessionId, sessionKey, fileSize, result.nodesAdded, Date.now());

      }); // end transaction
      ingestFile();

      result.filesProcessed++;
      log(`[graph-context] ingested ${agentId}/${file}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${file}: ${msg}`);
    }
  }

  return result;
}

/**
 * The canonical workspace files OpenClaw injects per session type.
 * Mirrors filterBootstrapFilesForSession in openclaw/src/agents/workspace.ts.
 */
const REF_FILES_BY_SESSION_TYPE: Record<string, string[]> = {
  slack:     ["SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "AGENTS.md", "HEARTBEAT.md", "MEMORY.md"],
  discord:   ["SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "AGENTS.md", "HEARTBEAT.md", "MEMORY.md"],
  direct:    ["SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "AGENTS.md", "HEARTBEAT.md", "MEMORY.md"],
  heartbeat: ["HEARTBEAT.md"],
  cron:      ["SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "AGENTS.md"],
  subagent:  [],
  unknown:   [],
};

/**
 * Build (or rebuild) the virtual structural hierarchy on top of the ingested sessions:
 *
 *   root → agent:<id> → session_type:<type> → ref_files:<agent>:<type> → session
 *
 * One ref_files node per (agent, sessionType) — the file list is determined by
 * session type, not by the devInstructions fingerprint. Fingerprints are stored
 * as a collected set in ref_files properties for informational purposes only.
 *
 * All virtual nodes are upserted so this is safe to run after every ingest pass.
 */
export function buildVirtualHierarchy(db: Database.Database, _agentsDir: string): void {
  const VIRTUAL_AGENT_ID = "__virtual__";
  const VIRTUAL_SESSION_ID = "__virtual__";
  const VIRTUAL_SESSION_KEY = "__virtual__";
  const now = Date.now();

  const ensureNode = (node: GraphNode) => upsertNode(db, node);
  const ensureEdge = (edge: GraphEdge) => insertEdge(db, edge);

  // 1. Root node
  const rootId = "root";
  ensureNode({
    id: rootId, type: "root" as NodeType,
    agent_id: VIRTUAL_AGENT_ID, session_id: VIRTUAL_SESSION_ID,
    session_key: VIRTUAL_SESSION_KEY, ts: now,
    content_text: "OpenClaw",
  });

  // 2. Query all sessions
  type SessionRow = { session_id: string; agent_id: string; properties: string | null };
  const sessions = db.prepare(
    "SELECT session_id, agent_id, properties FROM nodes WHERE type='session'"
  ).all() as SessionRow[];

  // Track created virtual nodes to avoid redundant upserts
  const createdAgents = new Set<string>();
  const createdSessionTypes = new Set<string>();
  const createdRefFiles = new Set<string>();

  // Collect fingerprints per ref_files node for informational storage
  const refFilesFingerprints = new Map<string, Set<string>>();

  for (const row of sessions) {
    const props = (() => { try { return JSON.parse(row.properties ?? "{}"); } catch { return {}; } })();
    const sessionType: string = props.sessionType ?? "unknown";
    const fingerprint: string | undefined = props.devInstructionsFingerprint;
    const agentId = row.agent_id;

    // 2a. Agent node
    const agentNodeId = `agent:${agentId}`;
    if (!createdAgents.has(agentNodeId)) {
      ensureNode({
        id: agentNodeId, type: "agent" as NodeType,
        agent_id: agentId, session_id: VIRTUAL_SESSION_ID,
        session_key: VIRTUAL_SESSION_KEY, ts: now,
        content_text: agentId,
      });
      ensureEdge({
        id: shortHash("contains", rootId, agentNodeId),
        src: rootId, dst: agentNodeId, type: "contains" as EdgeType, weight: 1,
      });
      createdAgents.add(agentNodeId);
    }

    // 2b. SessionType node — one per (agent, sessionType)
    const sessionTypeNodeId = `session_type:${agentId}:${sessionType}`;
    if (!createdSessionTypes.has(sessionTypeNodeId)) {
      ensureNode({
        id: sessionTypeNodeId, type: "session_type" as NodeType,
        agent_id: agentId, session_id: VIRTUAL_SESSION_ID,
        session_key: VIRTUAL_SESSION_KEY, ts: now,
        content_text: sessionType,
      });
      ensureEdge({
        id: shortHash("contains", agentNodeId, sessionTypeNodeId),
        src: agentNodeId, dst: sessionTypeNodeId, type: "contains" as EdgeType, weight: 1,
      });
      createdSessionTypes.add(sessionTypeNodeId);
    }

    // 2c. RefFiles node — exactly one per (agent, sessionType)
    // ID uses no fingerprint so all sessions of the same type share one ref_files node.
    const refFilesNodeId = `ref_files:${agentId}:${sessionType}`;
    if (!refFilesFingerprints.has(refFilesNodeId)) {
      refFilesFingerprints.set(refFilesNodeId, new Set());
    }
    if (fingerprint) refFilesFingerprints.get(refFilesNodeId)!.add(fingerprint);

    if (!createdRefFiles.has(refFilesNodeId)) {
      const fileList: string[] = REF_FILES_BY_SESSION_TYPE[sessionType] ?? [];
      ensureNode({
        id: refFilesNodeId, type: "ref_files" as NodeType,
        agent_id: agentId, session_id: VIRTUAL_SESSION_ID,
        session_key: VIRTUAL_SESSION_KEY, ts: now,
        // content_text is a JSON array for UI rendering; human-readable fallback to "(none)"
        content_text: fileList.length ? JSON.stringify(fileList) : "(none)",
        properties: JSON.stringify({ files: fileList }),
      });
      ensureEdge({
        id: shortHash("contains", sessionTypeNodeId, refFilesNodeId),
        src: sessionTypeNodeId, dst: refFilesNodeId, type: "contains" as EdgeType, weight: 1,
      });
      createdRefFiles.add(refFilesNodeId);
    }

    // 2d. Link session → ref_files via contains edge
    const sessionNodeId = `session:${row.session_id}`;
    ensureEdge({
      id: shortHash("contains", refFilesNodeId, sessionNodeId),
      src: refFilesNodeId, dst: sessionNodeId, type: "contains" as EdgeType, weight: 1,
    });
  }

  // 2e. Update ref_files nodes with the collected fingerprint set
  const updateRefFiles = db.prepare(`
    UPDATE nodes SET properties = json_set(COALESCE(properties,'{}'), '$.fingerprints', ?)
    WHERE id = ?
  `);
  db.transaction(() => {
    for (const [id, fps] of refFilesFingerprints) {
      updateRefFiles.run(JSON.stringify([...fps]), id);
    }
  })();
}

export async function ingestAll(
  db: Database.Database,
  opts: IngestOptions = {},
): Promise<Record<string, IngestResult>> {
  const agentsDir = opts.agentsDir
    ? opts.agentsDir.replace("~", homedir())
    : join(homedir(), ".openclaw", "agents");

  const log = opts.onProgress ?? (() => {});
  const results: Record<string, IngestResult> = {};

  let agents: string[];
  try {
    agents = await readdir(agentsDir);
  } catch {
    log("[graph-context] cannot read agents dir: " + agentsDir);
    return results;
  }

  if (opts.agentId) {
    agents = agents.filter((a) => a === opts.agentId);
  }

  log("[graph-context] migrating virtual hierarchy (wipe stale nodes, reclassify sessions)");
  const migration = migrateVirtualHierarchy(db);
  log(`[graph-context] migration complete: wipedNodes=${migration.wipedNodes} reclassified=${migration.reclassified}`);

  for (const agentId of agents) {
    log(`[graph-context] ingesting agent: ${agentId}`);
    results[agentId] = await ingestAgent(db, agentId, agentsDir, opts);
    const r = results[agentId];
    log(
      `[graph-context] ${agentId}: processed=${r.filesProcessed} skipped=${r.filesSkipped} ` +
      `nodes=${r.nodesAdded} edges=${r.edgesAdded} errors=${r.errors.length}`,
    );
  }

  log("[graph-context] building virtual hierarchy (root → agent → session_type → ref_files → session)");
  db.transaction(() => buildVirtualHierarchy(db, agentsDir))();
  log("[graph-context] virtual hierarchy complete");

  log("[graph-context] marking duplicate/heartbeat/empty nodes as display=hidden");
  const pruned = markDuplicateNodes(db);
  log(
    `[graph-context] pruning complete: heartbeats=${pruned.heartbeatSessionsHidden} ` +
    `dup-ref_files=${pruned.duplicateRefFilesHidden} ` +
    `empty-session_types=${pruned.emptySessionTypesHidden}`,
  );

  return results;
}
