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
import { listIssues } from "./beads-cli.js";

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

/**
 * Walk all configured repos × all known agents, build the issue↔session map.
 */
export async function buildSessionMap(
  opts: BuildSessionMapOptions,
): Promise<SessionMapCache> {
  const nowMs = opts.nowMs ?? Date.now();
  const skipTest = opts.skipTestRepos ?? true;
  const reposToScan = skipTest
    ? opts.repos.filter((r) => !/test/i.test(r.name))
    : opts.repos;

  const agents = await listKnownAgents(opts.workspaceDir);
  // Cache sessions per agent so we read sessions.json once.
  const sessionsByAgent = new Map<string, SessionEntry[]>();
  for (const agentId of agents) {
    sessionsByAgent.set(
      agentId,
      await readRecentAgentSessions(opts.workspaceDir, agentId, opts.recencyMs, nowMs),
    );
  }

  const bindings: IssueSessionBinding[] = [];
  const unbound: SessionMapCache["unbound"] = [];

  for (const repo of reposToScan) {
    let issues: BdIssue[] = [];
    try {
      issues = await listIssues({ cwd: repo.path, bdBinary: opts.bdBinary });
    } catch {
      // Repo unreadable: nothing to bind.
      continue;
    }
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

  return {
    generatedAt: new Date(nowMs).toISOString(),
    recencyMs: opts.recencyMs,
    bindings,
    unbound,
  };
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
