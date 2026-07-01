/**
 * Issue ↔ session mapping for the openclaw-beads plugin.
 *
 * On gateway:startup, this module is responsible for one thing: deciding,
 * for each open/in_progress beads issue assigned to a known agent, which of
 * that agent's recent sessions is the right vehicle to carry the work.
 *
 * The output is a JSON cache file the heartbeat / plans_and_tasks injection
 * can consult to route ready-issues to the right session per agent.
 *
 * Hybrid heuristic:
 *   1. Explicit override: an issue whose `notes` field contains a line
 *      `Session: <key>` binds to that exact sessionKey if it exists.
 *   2. Heuristic fallback: prefer recent (within recencyMs) live human
 *      channel sessions, tie-broken by most recent interaction.
 *   3. No match → omit from mapping. The heartbeat still ticks the agent's
 *      default session via the runner's broadcast loop.
 *
 * Live channel surfaces are the human-touched ones: discord, slack,
 * telegram, signal, whatsapp, imessage, irc, matrix, line, twitch,
 * mattermost, googlechat, etc. NOT cron, NOT subagent, NOT main:heartbeat.
 *
 * See bead openclaw-beads-vkm for design rationale.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { BdIssue, BdRepo } from "./beads-cli.js";
import { ensureFreshExport, readIssuesJsonl } from "./beads-cli.js";

/** Surfaces we consider "live human channels" for heuristic matching. */
export const LIVE_CHANNEL_SURFACES = new Set<string>([
  "discord",
  "slack",
  "telegram",
  "signal",
  "whatsapp",
  "imessage",
  "irc",
  "matrix",
  "line",
  "twitch",
  "mattermost",
  "googlechat",
  "feishu",
  "wecom",
  "msteams",
  "nextcloud-talk",
  "bluebubbles",
  "synology-chat",
  "tlon",
  "qa-channel",
  "zalo",
  "qqbot",
]);

export interface SessionEntry {
  sessionKey: string;
  agentId: string;
  surface: string; // first segment after `agent:<agentId>:`
  lastInteractionAt: number;
  isLiveChannel: boolean;
}

export interface IssueSessionBinding {
  agentId: string;
  issueId: string;
  repoName: string;
  sessionKey: string;
  /** "explicit" if from issue.notes Session: line; "heuristic" otherwise. */
  source: "explicit" | "heuristic";
  /** Issue title for diagnostic logging. */
  title?: string;
}

export interface SessionMapCache {
  /** ISO timestamp when this cache was written. */
  generatedAt: string;
  /** Recency cutoff used (ms) when filtering candidate sessions. */
  recencyMs: number;
  /** Each binding represents one issue → session pairing. */
  bindings: IssueSessionBinding[];
  /** Diagnostic: issues that had no eligible session. */
  unbound: Array<{ agentId: string; issueId: string; repoName: string; reason: string }>;
}

/**
 * Parse the `Session: <key>` override from an issue's notes field.
 * Returns the trimmed sessionKey or undefined.
 */
export function parseSessionOverrideFromNotes(notes?: string | null): string | undefined {
  if (!notes || typeof notes !== "string") return undefined;
  for (const line of notes.split("\n")) {
    const m = line.match(/^Session:\s*(\S+)\s*$/);
    if (m) return m[1];
  }
  return undefined;
}

/** Derive surface name from a sessionKey: `agent:<agentId>:<surface>:...`. */
export function surfaceFromSessionKey(sessionKey: string): string {
  const parts = sessionKey.split(":");
  // parts[0]="agent", parts[1]=<agentId>, parts[2]=<surface>
  return parts[2] ?? "";
}

/** True if the surface is a live human channel. */
export function isLiveChannelSurface(surface: string): boolean {
  return LIVE_CHANNEL_SURFACES.has(surface);
}

/**
 * Read all sessions for a given agent from its sessions.json index.
 * Filters to entries with `lastInteractionAt` newer than now - recencyMs.
 */
export async function readRecentAgentSessions(
  workspaceDir: string,
  agentId: string,
  recencyMs: number,
  nowMs: number = Date.now(),
): Promise<SessionEntry[]> {
  const sessionsJson = join(workspaceDir, "agents", agentId, "sessions", "sessions.json");
  let text: string;
  try {
    text = await readFile(sessionsJson, "utf8");
  } catch {
    return [];
  }
  let store: any;
  try {
    store = JSON.parse(text);
  } catch {
    return [];
  }
  if (!store || typeof store !== "object") return [];
  const cutoff = nowMs - recencyMs;
  const out: SessionEntry[] = [];
  for (const [sessionKey, entry] of Object.entries(store as Record<string, any>)) {
    if (!entry || typeof entry !== "object") continue;
    const lastInteractionAt = Number((entry as any).lastInteractionAt) || 0;
    if (lastInteractionAt < cutoff) continue;
    const surface = surfaceFromSessionKey(sessionKey);
    out.push({
      sessionKey,
      agentId,
      surface,
      lastInteractionAt,
      isLiveChannel: isLiveChannelSurface(surface),
    });
  }
  return out;
}

/** List configured agent ids by reading the workspace agents/ directory. */
export async function listKnownAgents(workspaceDir: string): Promise<string[]> {
  const agentsDir = join(workspaceDir, "agents");
  if (!existsSync(agentsDir)) return [];
  try {
    const entries = await readdir(agentsDir);
    return entries.filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

/**
 * Pick the best session for an issue using the hybrid heuristic.
 *
 * - Explicit override wins if the referenced sessionKey is in the candidate
 *   list (implies it's recent enough).
 * - Otherwise prefer live-channel sessions, then most recent interaction.
 *
 * Returns undefined if no candidate is suitable.
 */
export function pickSessionForIssue(
  issue: BdIssue,
  candidates: SessionEntry[],
): { sessionKey: string; source: "explicit" | "heuristic" } | undefined {
  if (candidates.length === 0) return undefined;
  const notes = (issue as any).notes;
  const override = parseSessionOverrideFromNotes(typeof notes === "string" ? notes : undefined);
  if (override) {
    const match = candidates.find((c) => c.sessionKey === override);
    if (match) return { sessionKey: match.sessionKey, source: "explicit" };
    // Override doesn't match a recent session: fall through to heuristic. The
    // override is stale or refers to a session outside the recency window;
    // either way, picking a vehicle is better than emitting nothing.
  }
  // Heuristic: live-channel first, then most recent. Stable sort: sort by
  // (-isLiveChannel, -lastInteractionAt) ascending lexicographic.
  const sorted = [...candidates].sort((a, b) => {
    if (a.isLiveChannel !== b.isLiveChannel) return a.isLiveChannel ? -1 : 1;
    return b.lastInteractionAt - a.lastInteractionAt;
  });
  return { sessionKey: sorted[0].sessionKey, source: "heuristic" };
}

/** Issues that should be considered for binding. */
function isActiveIssue(issue: BdIssue): boolean {
  const status = String((issue as any).status ?? "").toLowerCase();
  return status === "open" || status === "in_progress";
}

/** Match issues whose assignee is this agent or "any". */
function isIssueForAgent(issue: BdIssue, agentId: string): boolean {
  const raw = String((issue as any).assignee ?? "").trim();
  if (!raw) return false;
  return raw === agentId || raw === "any";
}

export interface BuildSessionMapOptions {
  workspaceDir: string;
  repos: BdRepo[];
  recencyMs: number;
  nowMs?: number;
  bdBinary?: string;
  /** Skip repos whose name matches /test/i. */
  skipTestRepos?: boolean;
}

export interface SessionMapTimings {
  /** Time to enumerate agent dirs. */
  listAgentsMs: number;
  /** Time to read all sessions.json index files. */
  readSessionsMs: number;
  /** Time to read all .beads/issues.jsonl files (parallel). */
  readIssuesMs: number;
  /** Time to compute bindings + write cache. */
  bindAndWriteMs: number;
  /** Wall-clock total. */
  totalMs: number;
  /** Per-repo issue read times (ms), sorted slowest first. */
  slowestRepos: Array<{ name: string; ms: number }>;
  /** Repos whose .beads/issues.jsonl is missing (skipped on fast path). */
  reposWithoutJsonl: string[];
}

/**
 * Walk all configured repos × all known agents, build the issue↔session map.
 *
 * Returns the cache plus per-phase timings so callers can log where time is
 * being spent during gateway:startup.
 */
export async function buildSessionMap(
  opts: BuildSessionMapOptions,
): Promise<{ cache: SessionMapCache; timings: SessionMapTimings }> {
  const startedAt = Date.now();
  const nowMs = opts.nowMs ?? startedAt;
  const skipTest = opts.skipTestRepos ?? true;
  const reposToScan = skipTest
    ? opts.repos.filter((r) => !/test/i.test(r.name))
    : opts.repos;

  const t0 = Date.now();
  const agents = await listKnownAgents(opts.workspaceDir);
  const listAgentsMs = Date.now() - t0;

  // Read all agents' sessions.json in parallel — independent files.
  const t1 = Date.now();
  const sessionsEntries = await Promise.all(
    agents.map(async (agentId) => [
      agentId,
      await readRecentAgentSessions(opts.workspaceDir, agentId, opts.recencyMs, nowMs),
    ] as const),
  );
  const sessionsByAgent = new Map<string, SessionEntry[]>(sessionsEntries);
  const readSessionsMs = Date.now() - t1;

  // Read all repos' issues.jsonl in parallel — independent files.
  //
  // Reader-side self-heal (bighat-p5j): `.beads/issues.jsonl` is a DERIVED
  // export of the live Dolt DB and bd (v1.0.3, Dolt backend) does NOT
  // auto-export after shell-initiated mutations (`bd close`/`bd update` run
  // directly in a shell — the pattern HEARTBEAT.md instructs everywhere).
  // Before trusting the JSONL for status truth in the session-map cache, we
  // run `bd export` per repo so the file reflects the live store. Cheap
  // (well under a second per repo for typical issue counts) and amortized
  // by the caller's own cache TTL. If the export fails, we still read the
  // (possibly stale) JSONL — degraded, but no worse than before this fix.
  const t2 = Date.now();
  const repoTimings: Array<{ name: string; ms: number; missingJsonl?: boolean }> = [];
  const repoIssues = await Promise.all(
    reposToScan.map(async (repo) => {
      const rt = Date.now();
      await ensureFreshExport({
        cwd: repo.path,
        bdBinary: opts.bdBinary,
        timeoutMs: 5_000,
      });
      const exported = await readIssuesJsonl(repo.path).catch(() => null);
      const issues: BdIssue[] = exported ?? [];
      repoTimings.push({
        name: repo.name,
        ms: Date.now() - rt,
        missingJsonl: exported === null,
      });
      return { repo, issues };
    }),
  );
  const readIssuesMs = Date.now() - t2;

  // Compute bindings.
  const t3 = Date.now();
  const bindings: IssueSessionBinding[] = [];
  const unbound: SessionMapCache["unbound"] = [];
  for (const { repo, issues } of repoIssues) {
    const active = issues.filter(isActiveIssue);
    for (const agentId of agents) {
      const candidates = sessionsByAgent.get(agentId) ?? [];
      const agentIssues = active.filter((i) => isIssueForAgent(i, agentId));
      for (const issue of agentIssues) {
        const issueId = String((issue as any).id ?? "");
        if (!issueId) continue;
        const pick = pickSessionForIssue(issue, candidates);
        if (!pick) {
          unbound.push({
            agentId,
            issueId,
            repoName: repo.name,
            reason: candidates.length === 0 ? "no-recent-sessions" : "no-suitable-session",
          });
          continue;
        }
        bindings.push({
          agentId,
          issueId,
          repoName: repo.name,
          sessionKey: pick.sessionKey,
          source: pick.source,
          title: typeof (issue as any).title === "string" ? (issue as any).title : undefined,
        });
      }
    }
  }
  const bindAndWriteMs = Date.now() - t3;

  const cache: SessionMapCache = {
    generatedAt: new Date(nowMs).toISOString(),
    recencyMs: opts.recencyMs,
    bindings,
    unbound,
  };
  const reposWithoutJsonl = repoTimings.filter((r) => r.missingJsonl).map((r) => r.name);
  const timings: SessionMapTimings = {
    listAgentsMs,
    readSessionsMs,
    readIssuesMs,
    bindAndWriteMs,
    totalMs: Date.now() - startedAt,
    slowestRepos: repoTimings
      .map(({ name, ms }) => ({ name, ms }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 3),
    reposWithoutJsonl,
  };
  return { cache, timings };
}

/** Default cache file path. */
export function defaultSessionMapCachePath(homeDir: string): string {
  return join(homeDir, ".openclaw", "plugins", "openclaw-beads", "session-map.json");
}

/** Atomic write of cache to disk. */
export async function writeSessionMapCache(
  cachePath: string,
  cache: SessionMapCache,
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(cache, null, 2);
  await writeFile(tmpPath, body, "utf8");
  // Rename is atomic on the same filesystem.
  const { rename } = await import("node:fs/promises");
  await rename(tmpPath, cachePath);
}
