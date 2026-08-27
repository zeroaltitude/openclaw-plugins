/**
 * OpenClaw Beads Visualizer plugin
 *
 * Registers the gateway HTTP routes:
 *   GET /beads                  → UI shell HTML (DAG visualizer)
 *   GET /beads/api/repos        → list configured repos
 *   GET /beads/api/issues       → bd list (per repo)
 *   GET /beads/api/deps         → DAG edges
 *
 * v0.1: read-only, single-repo focus, inline UI (no Vite build).
 */

import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  listIssues,
  listEdges,
  showIssue,
  createIssue,
  updateIssue,
  closeIssue,
  reopenIssue,
  deleteIssue,
  addDependency,
  removeDependency,
  readyIssues,
  readyIssuesFromExport,
  ensureFreshExport,
  setIssueMetadata,
  referencesFromLabels,
  type BdIssue,
  type BdRepo,
  type BdMutateInput,
} from "./beads-cli.js";
import {
  buildSessionMap,
  defaultSessionMapCachePath,
  writeSessionMapCache,
} from "./session-map.js";
import { TtlCache } from "./ttl-cache.js";

export { TtlCache } from "./ttl-cache.js";

const DEFAULT_PROMPT_BLOCK_TTL_MS = 60_000;
const DEFAULT_READY_API_TTL_MS = 20_000;
/**
 * Overall wall-clock budget for building the heartbeat block. Deliberately
 * well under the runtime's 15s `before_prompt_build` modifying-hook timeout
 * (openclaw src/plugins/hooks.ts): if WE overrun, the runtime discards the
 * whole contribution and the turn silently loses its queue. Overrunning one
 * repo must instead degrade to a marker inside a block we still emit.
 */
const DEFAULT_READY_BUDGET_MS = 10_000;
/** How long a degraded block may be served from cache before we retry. */
const DEGRADED_BLOCK_TTL_MS = 5_000;

const promptBlockCache = new TtlCache<string>();
const readyApiCache = new TtlCache<unknown>();

interface PluginApi {
  registerHttpRoute(params: {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
    replaceExisting?: boolean;
  }): void;
  pluginConfig?: Record<string, unknown>;
  config?: Record<string, unknown>;
  logger: { info(...a: any[]): void; warn(...a: any[]): void; error(...a: any[]): void };
  on?: (hookName: string, handler: (event: any, ctx: any) => any, opts?: { priority?: number }) => void;
  registerHook?: (
    events: string | string[],
    handler: (event: any) => any,
    opts?: { name?: string; description?: string },
  ) => void;
  runtime?: {
    system?: {
      requestHeartbeatNow?: (opts?: {
        reason?: string;
        coalesceMs?: number;
        sessionKey?: string;
        agentId?: string;
        heartbeat?: { target?: string };
      }) => void;
      enqueueSystemEvent?: (text: string, options: {
        sessionKey: string;
        contextKey?: string;
        deliveryContext?: unknown;
        trusted?: boolean;
      }) => boolean;
    };
  };
}

interface BeadsPluginConfig {
  repos?: BdRepo[];
  bdBinary?: string;
  defaultRepo?: string;
  ownerOptions?: string[];
  runLoop?: {
    enabled?: boolean;
    readyLimitPerRepo?: number;
    includeUnassigned?: boolean;
    startupWake?: boolean;
    startupWakeTarget?: string;
    startupWakeDelayMs?: number;
    /**
     * TTL for the cached `<plans_and_tasks>` block injected into agent
     * turns. Defaults to 60s. Set to 0 to disable caching (still dedupes
     * concurrent calls). Hot path: fires every prompt build.
     */
    readyCacheTtlMs?: number;
    /**
     * TTL for the cached `/beads/api/ready` response. Defaults to 20s.
     * Set to 0 to disable caching (still dedupes concurrent calls).
     */
    readyApiCacheTtlMs?: number;
    /**
     * Overall wall-clock budget for building the `<plans_and_tasks>` block.
     * Defaults to 10s. Must stay below the runtime's 15s
     * `before_prompt_build` hook timeout — past that, the runtime drops the
     * entire contribution and the turn gets no queue at all.
     */
    readyBudgetMs?: number;
    /**
     * On gateway:startup, build an issue↔session mapping (Phase 1) and
     * fire one broadcast heartbeat wake (Phase 2). The mapping is written
     * to a JSON cache file for prompt-build consumers to read.
     * Default: enabled. See bead openclaw-beads-vkm.
     */
    startupSessionMapping?: boolean;
    /**
     * Recency window in milliseconds for sessions considered as candidates
     * for issue↔session binding. Sessions older than this are ignored.
     * Default: 3_600_000 (1 hour).
     */
    sessionMappingRecencyMs?: number;
    /**
     * Override the workspace directory used for session discovery.
     * Default: $HOME/.openclaw (the standard OpenClaw layout).
     */
    workspaceDir?: string;
  };
  calendarSync?: {
    enabled?: boolean;
    account?: string;
    calendarId?: string;
    defaultTimedDurationMinutes?: number;
    gogBinary?: string;
  };
}

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

function cfg(api: PluginApi): BeadsPluginConfig {
  return (api.pluginConfig ?? {}) as BeadsPluginConfig;
}

function repoByName(api: PluginApi, name: string | undefined): BdRepo | undefined {
  const repos = cfg(api).repos ?? [];
  if (!repos.length) return undefined;
  if (!name) {
    const def = cfg(api).defaultRepo;
    return repos.find((r) => r.name === def) ?? repos[0];
  }
  return repos.find((r) => r.name === name);
}

function ownerOptions(api: PluginApi): string[] {
  const out = new Set<string>();
  for (const v of cfg(api).ownerOptions ?? []) {
    if (typeof v === "string" && v.trim()) out.add(v.trim());
  }
  out.add("any");
  out.add("eddie");
  const agents = (api.config as any)?.agents?.list;
  if (Array.isArray(agents)) {
    for (const agent of agents) {
      const id = typeof agent?.id === "string" ? agent.id.trim() : "";
      if (id) out.add(id);
    }
  }
  // Stable, opinionated ordering: pseudo/human owners first, then agents.
  return [...out].sort((a, b) => {
    const rank = (x: string) => (x === "any" ? 0 : x === "eddie" ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}


function escapeXml(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function issueAssignee(issue: BdIssue): string {
  const raw = (issue as any).assignee ?? "";
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * The retired `any` sentinel (openclaw-1lw7).
 *
 * `any` used to be written into `assignee` to mean "anyone may take this".
 * `bd` does not share that reading: it treats the literal string `any` as a
 * real claimant, so `bd update <id> --claim` on such an issue fails for
 * *everyone* with `issue already claimed by any` (measured, bd 1.0.3). That
 * made the atomic claim path unusable on exactly the population that races —
 * broadcast backlog — which is how three agents claimed openclaw-vaon in the
 * same minute.
 *
 * "Anyone may claim this" is now expressed as a genuinely **unassigned**
 * issue, which is what `--claim` understands. We still *read* `any` as a
 * claimable-by-anyone synonym so historical and externally-created issues stay
 * visible, but we never *write* it — see `createIssue` in `beads-cli.ts`.
 */
export function isBroadcastAssignee(owner: string): boolean {
  return owner === "" || owner === "any";
}

export function shouldIncludeReadyIssue(issue: BdIssue, agentId: string, includeUnassigned: boolean): boolean {
  const owner = issueAssignee(issue);
  // Legacy `any` stays visible unconditionally; genuinely-unassigned work is
  // the new normal claimable state, so it is shown unless an operator has
  // explicitly opted out via runLoop.includeUnassigned=false.
  if (owner === "any") return true;
  if (!owner) return includeUnassigned;
  return owner === agentId;
}

/**
 * Heartbeat selection ordering for `<plans_and_tasks>`. Sorts by:
 *   1. Direct-assignee match first (assignee === agentId), so an
 *      agent's own work is never starved by broadcast backlog
 *      (unassigned, or the legacy `any`) when the list is capped by
 *      `readyLimitPerRepo`.
 *   2. Numeric priority ascending (lower number = higher priority).
 *   3. Stable on issue id as a tie-breaker.
 */
export function compareReadyIssuesForAgent(a: BdIssue, b: BdIssue, agentId: string): number {
  const aDirect = issueAssignee(a) === agentId ? 0 : 1;
  const bDirect = issueAssignee(b) === agentId ? 0 : 1;
  if (aDirect !== bDirect) return aDirect - bDirect;
  const ap = Number((a as any).priority ?? 2);
  const bp = Number((b as any).priority ?? 2);
  if (ap !== bp) return ap - bp;
  return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

/**
 * Per-repo accounting for one readiness build. `counts` exists so an empty
 * queue is *explainable*: `<ready_issues none="true"/>` alone cannot tell an
 * agent whether the repo has no ready work or has twenty ready issues that
 * were all filtered out by the assignee policy (openclaw-beads-7sz — the
 * 2026-08-03 report of "no work shown while `bd ready` lists ~20").
 */
export interface ReadyRepoEntry {
  repo: BdRepo;
  /** Issues actually rendered (post-filter, post-cap). */
  issues: BdIssue[];
  /** Hard failure: nothing could be read for this repo. */
  error?: string;
  /** Soft failure: results are present but stale or best-effort. */
  warning?: string;
  counts?: {
    /** Ready+in-progress issues bd/the export reported before owner filtering. */
    readyTotal: number;
    /** Rendered count (after owner filter and the per-repo cap). */
    shown: number;
    /** Dropped because they carry no assignee and includeUnassigned is false. */
    filteredUnassigned: number;
    /** Dropped because they are assigned to a different agent. */
    filteredOtherOwner: number;
    /** Dropped only by the per-repo render cap. */
    truncated: number;
  };
}

/**
 * Block emitted when the readiness queue could not be built at all.
 *
 * The whole point of openclaw-beads-7sz: a heartbeat that sees no
 * `<plans_and_tasks>` block cannot distinguish "no work" from "the plugin
 * failed", and yields HEARTBEAT_OK either way. So the failure path emits a
 * block too — a loud one.
 */
export function formatDegradedPlansAndTasksBlock(params: {
  agentId: string;
  reason: string;
}): string {
  return [
    '<plans_and_tasks degraded="true">',
    "The Beads ready-work queue could NOT be built for this turn. This is a plugin/tooling failure, not an empty queue.",
    `Reason: ${escapeXml(params.reason)}`,
    "",
    "- Do NOT conclude that there is no ready work, and do NOT yield an idle/OK heartbeat on the strength of this block.",
    "- If you are about to idle, run `bd ready --json` yourself in the configured repos first.",
    "- Mention this degradation in your reply so the failure is visible instead of silent.",
    '<ready_issues unavailable="true">',
    `  <error>${escapeXml(params.reason)}</error>`,
    "</ready_issues>",
    "</plans_and_tasks>",
  ].join("\n");
}

export function formatPlansAndTasksBlock(params: {
  agentId: string;
  repos: ReadyRepoEntry[];
}): string {
  const degradedRepos = params.repos.filter((entry) => entry.error || entry.warning);
  const lines: string[] = [];
  lines.push(degradedRepos.length ? '<plans_and_tasks degraded="true">' : "<plans_and_tasks>");
  lines.push("These are active Beads issues that are ready for assessment. Treat them as background work opportunities, not as higher priority than the user's latest request.");
  lines.push("");
  lines.push("Run-loop discipline:");
  lines.push("- First satisfy the user's current request. If ready Beads work conflicts with it, explain the tradeoff and ask what to prioritize.");
  lines.push("- For non-trivial work you are about to perform, ensure there is a Beads issue tracking it. Simple exchanges (date/time, quick clarification, casual chat, one-shot answers with no durable follow-up) do not need an issue.");
  lines.push(`- When creating a Beads issue for work you will do, assign it to your own agent id (${params.agentId}) by default unless the user specified someone else. If it belongs in general backlog, leave it UNASSIGNED — do not set the assignee to the string "any", which blocks the atomic claim below.`);
  lines.push("- Ignore issues assigned to another owner. You may act on issues assigned to you, and on unassigned issues (shown with owner=\"unassigned\").");
  lines.push("- Never treat issues from repos whose configured repo name matches /test/i as ready work.");
  lines.push(
    `- CLAIM ATOMICALLY BEFORE YOU START. Other agents wake on their own heartbeats and read this same queue, so "it looked unassigned" is not ownership. To take an issue, run \`bd update <id> --claim --actor ${params.agentId}\` in that repo and CHECK THE EXIT CODE. Exit 0 means you own it (assignee and in_progress are set atomically) — proceed. NONZERO means another agent won the race; the error names the winner (\`issue already claimed by <agent>\`). On nonzero you MUST NOT start the work, spawn a subagent, or cut a worktree — pick different work, and say who won. Do NOT substitute \`--assignee <you> --status in_progress\`: that is last-write-wins and every racing agent believes it won.`,
  );
  lines.push("- Legacy issues whose owner is literally \"any\" cannot be claimed by anyone — `bd` reads \"any\" as a claimant. Normalize first with `bd update <id> --assignee \"\"`, then claim it atomically as above.");
  lines.push("- Re-claiming an issue you already own is idempotent (exit 0), so it is always safe to re-run the claim to confirm ownership before resuming work.");
  lines.push("- When completed, close it. If waiting on the user, mark waiting_for_user. If waiting on an available agent/resource, mark waiting_for_available_agent. If blocked with no path forward, mark blocked. Keep state truthful.");
  lines.push("- An `in_progress` issue listed below is active work you (or a previous turn) already claimed. Resume it; do NOT restart it as if it were a fresh `open` issue. If a single `in_progress` issue represents a long-running multi-turn loop (e.g. cyclical PR review), advance it as far as the current turn allows, leave it `in_progress`, and let the next heartbeat pick up where you left off.");
  lines.push("- If the user suggests future work, bugs, investigations, reminders, or other durable trackables, create/update Beads issues for them and include target_datetime metadata when timing is implied.");
  lines.push("- If this turn was not triggered by direct user input (for example heartbeat, gateway startup/resume, cron wake, or other autonomous wake) and you take action on Beads work, explicitly reply with a concise summary of the Beads issue(s) touched and actions taken. If no action was taken, stay quiet unless there is a meaningful blocker or decision for the user.");
  if (degradedRepos.length) {
    lines.push("");
    lines.push(
      `QUEUE HEALTH: DEGRADED — ${degradedRepos.length} repo(s) could not be read cleanly this turn (see <error>/<warning> below). ` +
        "A short or empty list is NOT evidence that there is no ready work. Re-check the affected repos with `bd ready` before idling, and say so in your reply.",
    );
  }
  lines.push("");

  const hasHiddenWork = (entry: ReadyRepoEntry): boolean =>
    !!entry.counts && entry.counts.readyTotal > entry.counts.shown;
  const readyRepos = params.repos.filter(
    (entry) => entry.issues.length > 0 || entry.error || entry.warning || hasHiddenWork(entry),
  );
  if (!readyRepos.length) {
    lines.push("<ready_issues none=\"true\" />");
  } else {
    lines.push(degradedRepos.length ? '<ready_issues degraded="true">' : "<ready_issues>");
    for (const entry of readyRepos) {
      const counts = entry.counts;
      const attrs = [`name=\"${escapeXml(entry.repo.name)}\"`];
      if (counts) {
        attrs.push(`ready_total=\"${counts.readyTotal}\"`, `shown=\"${counts.shown}\"`);
        if (counts.filteredUnassigned > 0)
          attrs.push(`hidden_unassigned=\"${counts.filteredUnassigned}\"`);
        if (counts.filteredOtherOwner > 0)
          attrs.push(`hidden_other_owner=\"${counts.filteredOtherOwner}\"`);
        if (counts.truncated > 0) attrs.push(`hidden_over_limit=\"${counts.truncated}\"`);
      }
      lines.push(`  <repo ${attrs.join(" ")}>`);
      if (entry.error) lines.push(`    <error>${escapeXml(entry.error)}</error>`);
      if (entry.warning) lines.push(`    <warning>${escapeXml(entry.warning)}</warning>`);
      if (counts && counts.filteredUnassigned > 0 && counts.shown === 0) {
        lines.push(
          `    <note>All ${counts.filteredUnassigned} ready issue(s) here are unassigned and hidden because an operator set runLoop.includeUnassigned=false. Since openclaw-1lw7, unassigned is the normal claimable state for shared backlog, so this setting is hiding real, claimable work. Claim one explicitly (\`bd update <id> --claim --actor ${escapeXml(params.agentId)}\`) if nothing else is pending.</note>`,
        );
      }
      for (const issue of entry.issues) {
        const owner = issueAssignee(issue) || "unassigned";
        const refs = referencesFromLabels(issue.labels as string[] | undefined);
        lines.push(`    <issue id=\"${escapeXml(issue.id)}\" owner=\"${escapeXml(owner)}\" priority=\"${escapeXml(issue.priority ?? "")}\" status=\"${escapeXml(issue.status ?? "")}\" type=\"${escapeXml((issue as any).issue_type ?? issue.type ?? "")}\">`);
        lines.push(`      <title>${escapeXml(issue.title)}</title>`);
        if (refs.length) {
          lines.push("      <references>");
          for (const ref of refs.slice(0, 8)) lines.push(`        <ref>${escapeXml(ref)}</ref>`);
          lines.push("      </references>");
        }
        const target =
          (issue as any).target_datetime ??
          (issue as any).targetDatetime ??
          (issue as any).metadata?.target_datetime ??
          (issue as any).due_at;
        if (target) lines.push(`      <target_datetime>${escapeXml(target)}</target_datetime>`);
        lines.push("    </issue>");
      }
      lines.push("  </repo>");
    }
    lines.push("</ready_issues>");
  }
  lines.push("</plans_and_tasks>");
  return lines.join("\n");
}

function unwrapIssue(payload: any): any {
  return Array.isArray(payload) ? payload[0] : payload;
}

function targetDateTimeOf(issue: any): string {
  const unwrapped = unwrapIssue(issue);
  const raw =
    unwrapped?.target_datetime ??
    unwrapped?.targetDatetime ??
    unwrapped?.metadata?.target_datetime ??
    unwrapped?.due_at ??
    "";
  return typeof raw === "string" ? raw.trim() : "";
}

function calendarEventIdOf(issue: any): string {
  const unwrapped = unwrapIssue(issue);
  const raw = unwrapped?.metadata?.calendar_event_id ?? "";
  return typeof raw === "string" ? raw.trim() : "";
}

function targetHasExplicitTime(rawTarget: string): boolean {
  const value = rawTarget.trim().toLowerCase();
  if (!value) return false;
  // ISO/datetype with explicit time, e.g. 2026-05-02T09:00 or 2026-05-02 09:00.
  if (/^\d{4}-\d{2}-\d{2}(?:t|\s+)\d{1,2}:\d{2}/u.test(value)) return true;
  // Clock-ish natural language, e.g. "next monday at 3pm", "3:30pm".
  if (/\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/u.test(value)) return true;
  if (/\bat\s+\d{1,2}(?::\d{2})?\b/u.test(value)) return true;
  // Relative hours/minutes imply a timed target; relative days/weeks do not.
  if (/^\+\s*\d+\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes)$/u.test(value)) return true;
  return false;
}

function shouldCreateAllDayEvent(rawTarget: string): boolean {
  const value = rawTarget.trim().toLowerCase();
  if (!value) return false;
  if (targetHasExplicitTime(value)) return false;
  // Date-only ISO.
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return true;
  // Relative day/week/month/year forms: +2d, +1w, +3 months.
  if (/^\+\s*\d+\s*(?:d|day|days|w|week|weeks|mo|month|months|y|yr|year|years)$/u.test(value)) return true;
  // Natural date phrases without clock.
  if (/^(?:today|tomorrow|next\s+\w+|this\s+\w+)$/u.test(value)) return true;
  return false;
}

function dateOnlyFromIssueTarget(issue: any, rawTarget: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(rawTarget.trim())) return rawTarget.trim();
  const due = typeof issue?.due_at === "string" ? issue.due_at : "";
  if (/^\d{4}-\d{2}-\d{2}/u.test(due)) return due.slice(0, 10);
  return rawTarget.trim();
}

function addMinutesIso(iso: string, minutes: number): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

function addOneDay(dateOnly: string): string {
  const date = new Date(`${dateOnly}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return dateOnly;
  return new Date(date.getTime() + 24 * 60 * 60_000).toISOString().slice(0, 10);
}

function buildCalendarDescription(params: { repo: BdRepo; issue: any; target: string }): string {
  const issue = unwrapIssue(params.issue);
  const lines = [
    `Beads issue: ${issue.id}`,
    `Repo: ${params.repo.name}`,
    `Status: ${issue.status ?? ""}`,
    `Owner: ${issue.assignee ?? issue.owner ?? ""}`,
    `Target: ${params.target}`,
    "",
    issue.description ? String(issue.description).slice(0, 1500) : "",
  ];
  return lines.join("\n").trim();
}

function scheduleCalendarEventCreate(params: {
  api: PluginApi;
  repo: BdRepo;
  issue: any;
  previousIssue?: any;
  opts: { cwd: string; bdBinary?: string };
  reason: "create" | "target-added";
}): void {
  void maybeCreateCalendarEvent(params).catch((err) =>
    params.api.logger.warn(`[beads] calendar sync ${params.reason} failed for ${unwrapIssue(params.issue)?.id ?? "unknown"}:`, err?.message ?? err),
  );
}

async function maybeCreateCalendarEvent(params: {
  api: PluginApi;
  repo: BdRepo;
  issue: any;
  previousIssue?: any;
  opts: { cwd: string; bdBinary?: string };
  reason: "create" | "target-added";
}): Promise<void> {
  const calendarSync = cfg(params.api).calendarSync ?? {};
  if (calendarSync.enabled === false) return;
  const issue = unwrapIssue(params.issue);
  if (!issue?.id) return;
  if (calendarEventIdOf(issue)) return;
  if (params.previousIssue && targetDateTimeOf(params.previousIssue)) return;
  const rawTarget = targetDateTimeOf(issue);
  if (!rawTarget) return;

  const account = calendarSync.account ?? "eddie@bighatbio.com";
  const calendarId = calendarSync.calendarId ?? "primary";
  const gogBinary = calendarSync.gogBinary ?? "gog";
  const durationMinutes = Math.max(1, calendarSync.defaultTimedDurationMinutes ?? 30);
  const allDay = shouldCreateAllDayEvent(rawTarget);
  const allDayDate = allDay ? dateOnlyFromIssueTarget(issue, rawTarget) : "";
  const from = allDay ? allDayDate : (issue.due_at ?? rawTarget);
  const to = allDay ? addOneDay(allDayDate) : addMinutesIso(from, durationMinutes);
  const summary = `[${params.repo.name}] ${issue.title ?? issue.id}`;
  const description = buildCalendarDescription({ repo: params.repo, issue, target: rawTarget });
  const args = [
    "calendar",
    "create",
    calendarId,
    "--account",
    account,
    "--summary",
    summary,
    "--from",
    from,
    "--to",
    to,
    "--description",
    description,
    "--send-updates",
    "none",
    "--no-input",
    "--json",
    "--private-prop",
    `beads_issue_id=${issue.id}`,
    "--private-prop",
    `beads_repo=${params.repo.name}`,
  ];
  if (allDay) args.push("--all-day");
  const { stdout } = await execFileAsync(gogBinary, args, {
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(stdout.trim() || "{}");
  const eventId = parsed.id ?? parsed.event?.id;
  if (typeof eventId === "string" && eventId.trim()) {
    await setIssueMetadata(
      issue.id,
      {
        calendar_event_id: eventId.trim(),
        calendar_id: calendarId,
        calendar_account: account,
        calendar_synced_at: new Date().toISOString(),
      },
      params.opts,
    );
  }
}

/**
 * Resolve `promise` but never wait past `deadlineMs`; on expiry, resolve with
 * `onTimeout()` instead. The abandoned work keeps running (we cannot cancel a
 * spawned `bd`), but the caller's overall budget is honored.
 *
 * This is the structural half of the openclaw-beads-7sz fix: the runtime caps
 * `before_prompt_build` at 15s (openclaw src/plugins/hooks.ts,
 * DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK) and DISCARDS the contribution
 * when the budget blows — the block vanishes from the turn with only a
 * gateway-log line. Overrunning must therefore be impossible from our side:
 * one slow repo degrades to a `<repo>` timeout marker instead of taking the
 * whole block down.
 */
async function withDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remaining = Math.max(0, deadlineMs - Date.now());
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), remaining);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function collectRepoReady(params: {
  repo: BdRepo;
  agentId: string;
  bdBinary?: string;
  limit: number;
  includeUnassigned: boolean;
  deadlineMs: number;
}): Promise<ReadyRepoEntry> {
  const { repo, agentId, bdBinary, limit, includeUnassigned, deadlineMs } = params;
  const runOpts = { cwd: repo.path, bdBinary, deadlineMs };
  const warnings: string[] = [];

  // Reader-side self-heal (bighat-p5j): re-export the JSONL from the live
  // Dolt DB before trusting the fast path for status truth. bd 1.0.3 does
  // NOT auto-export after shell-initiated mutations (`bd close`/`bd update`
  // run in a shell as HEARTBEAT.md instructs), so without this the heartbeat
  // can present an already-closed issue as ready. A FAILED export is not
  // fatal — the previous snapshot is still usable — but it is reported,
  // because silently serving stale status is how a closed issue keeps
  // reappearing as ready.
  const exported = await ensureFreshExport({ ...runOpts, timeoutMs: 5_000 });
  if (!exported.ok) {
    warnings.push(`export failed (data may be stale): ${exported.error ?? "unknown error"}`);
  }

  // Pull a generous slice: the owner filter below runs AFTER this cap, so a
  // small pre-filter limit can hide this agent's own issues behind a wall of
  // unassigned backlog (bighat-general routinely has ~20 ready issues). The
  // read is a JSONL scan in the common case, so a wide slice is nearly free.
  const fetchLimit = Math.max(200, limit * 4);
  let ready: BdIssue[];
  try {
    ready = await readyIssues(fetchLimit, {
      ...runOpts,
      timeoutMs: 4_000,
      // Include `in_progress` issues so the heartbeat surface shows active
      // work the agent has already claimed (cyclical loops, multi-turn
      // fixes). Without this, an `in_progress` issue disappears from
      // `<ready_issues>` after it's claimed and any heartbeat that lands
      // while no `open` work exists will idle even though the agent has
      // work to resume.
      includeInProgress: true,
    });
  } catch (err: any) {
    // Last resort before giving up on this repo: answer from the JSONL
    // export directly, in lenient mode. It can over-report (an unresolvable
    // blocker is treated as non-blocking), so it is labeled degraded — but
    // an over-reported queue is recoverable and an empty one is not.
    const fallback = await readyIssuesFromExport(repo.path, fetchLimit, {
      includeInProgress: true,
      lenient: true,
    }).catch(() => null);
    if (!fallback) {
      return {
        repo,
        issues: [],
        error: `${String(err?.message ?? err).slice(0, 400)} | .beads/issues.jsonl fallback also unavailable`,
      };
    }
    ready = fallback;
    warnings.push(
      `bd unavailable, served from .beads/issues.jsonl (may be stale or over-report readiness): ${String(
        err?.message ?? err,
      ).slice(0, 300)}`,
    );
  }

  let filteredUnassigned = 0;
  let filteredOtherOwner = 0;
  const kept: BdIssue[] = [];
  for (const issue of ready) {
    if (shouldIncludeReadyIssue(issue, agentId, includeUnassigned)) {
      kept.push(issue);
      continue;
    }
    const owner = String((issue as any).assignee ?? "").trim();
    if (owner) filteredOtherOwner++;
    else filteredUnassigned++;
  }
  const issues = kept
    .sort((a, b) => compareReadyIssuesForAgent(a, b, agentId))
    .slice(0, limit);

  return {
    repo,
    issues,
    ...(warnings.length ? { warning: warnings.join(" | ") } : {}),
    counts: {
      readyTotal: ready.length,
      shown: issues.length,
      filteredUnassigned,
      filteredOtherOwner,
      truncated: Math.max(0, kept.length - issues.length),
    },
  };
}

async function buildPlansAndTasksBlock(api: PluginApi, agentId: string): Promise<string | null> {
  const config = cfg(api);
  // Both of these return NO contribution at all, which is indistinguishable
  // from an empty queue at the prompt. They are legitimate (the operator
  // turned the run loop off / configured no repos) but they must never be
  // silent — an absent block was the whole subject of openclaw-beads-7k3.
  if (config.runLoop?.enabled === false) {
    api.logger.warn(
      `[beads] plans_and_tasks SUPPRESSED for ${agentId}: runLoop.enabled=false in plugins.entries.beads.config. No ready-work block will reach any turn.`,
    );
    return null;
  }
  const repos = config.repos ?? [];
  if (!repos.length) {
    api.logger.warn(
      `[beads] plans_and_tasks SUPPRESSED for ${agentId}: plugins.entries.beads.config.repos is empty, so there is nothing to read. No ready-work block will reach any turn.`,
    );
    return null;
  }
  const limit = Math.max(1, config.runLoop?.readyLimitPerRepo ?? 3);
  // Defaults to TRUE since openclaw-1lw7 retired the `any` sentinel: "anyone
  // may claim this" is now expressed as an unassigned issue, so defaulting
  // this to false would hide the entire broadcast backlog and silence the
  // queue. Operators can still opt out explicitly.
  const includeUnassigned = config.runLoop?.includeUnassigned ?? true;
  const actionableRepos = repos.filter((repo) => !/test/i.test(repo.name));
  const ttlMs = Math.max(0, config.runLoop?.readyCacheTtlMs ?? DEFAULT_PROMPT_BLOCK_TTL_MS);
  const budgetMs = Math.max(1_000, config.runLoop?.readyBudgetMs ?? DEFAULT_READY_BUDGET_MS);
  const cacheKey = JSON.stringify({
    agentId,
    limit,
    includeUnassigned,
    bdBinary: config.bdBinary ?? "",
    repos: actionableRepos.map((r) => [r.name, r.path]),
  });
  try {
    return await promptBlockCache.getOrLoad(
      cacheKey,
      ttlMs,
      async () => {
        const deadlineMs = Date.now() + budgetMs;
        const results = await Promise.all(
          actionableRepos.map((repo) =>
            withDeadline(
              collectRepoReady({
                repo,
                agentId,
                bdBinary: config.bdBinary,
                limit,
                includeUnassigned,
                deadlineMs,
              }).catch(
                (err: any): ReadyRepoEntry => ({
                  repo,
                  issues: [],
                  error: String(err?.message ?? err).slice(0, 400),
                }),
              ),
              deadlineMs,
              (): ReadyRepoEntry => ({
                repo,
                issues: [],
                error: `readiness read exceeded the ${budgetMs}ms block budget; this repo's queue is UNKNOWN, not empty`,
              }),
            ),
          ),
        );
        for (const entry of results) {
          if (entry.error) api.logger.warn(`[beads] ready block: ${entry.repo.name}: ${entry.error}`);
          else if (entry.warning)
            api.logger.warn(`[beads] ready block: ${entry.repo.name}: ${entry.warning}`);
        }
        return formatPlansAndTasksBlock({ agentId, repos: results });
      },
      {
        // A degraded block must not be pinned for the full TTL — a transient
        // bd failure should cost one turn, not a minute of turns.
        resolveTtlMs: (block) => (block.includes('degraded="true"') ? DEGRADED_BLOCK_TTL_MS : ttlMs),
      },
    );
  } catch (err: any) {
    // The block builder itself failed. Emitting nothing here is precisely the
    // failure this issue is about: the heartbeat then sees no queue at all and
    // yields OK. Emit a loud degraded block instead.
    const reason = String(err?.message ?? err).slice(0, 400);
    api.logger.error(`[beads] plans_and_tasks block build failed for ${agentId}: ${reason}`);
    return formatDegradedPlansAndTasksBlock({ agentId, reason });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): boolean {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
  return true;
}

function sendText(res: ServerResponse, status: number, body: string, contentType: string): boolean {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
  return true;
}

function parseQuery(url: string): URLSearchParams {
  const idx = url.indexOf("?");
  return new URLSearchParams(idx >= 0 ? url.slice(idx + 1) : "");
}

function pathFromUrl(url: string | undefined): string {
  const u = url ?? "";
  const idx = u.indexOf("?");
  return idx >= 0 ? u.slice(0, idx) : u;
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`request body exceeded ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function loadUiShell(): Promise<string> {
  // The UI shell ships alongside dist/ in plugin layout: ../ui/index.html
  // Look in ../ui first (when running compiled from dist), then ./ui (dev).
  const candidates = [
    join(PLUGIN_DIR, "..", "ui", "index.html"),
    join(PLUGIN_DIR, "ui", "index.html"),
  ];
  for (const path of candidates) {
    try {
      return await readFile(path, "utf8");
    } catch {
      /* try next */
    }
  }
  return FALLBACK_UI;
}

const FALLBACK_UI = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Beads — UI shell missing</title></head>
<body><h1>UI shell not found</h1><p>Looked for ui/index.html alongside the plugin. Ship one or rebuild.</p></body></html>`;

/** This plugin's id, as the host knows it (`plugins.entries.<id>`). */
const PLUGIN_ID = "beads";

/**
 * Whether the host will let this plugin register CONVERSATION hooks —
 * `before_prompt_build` among them.
 *
 * openclaw-beads-7k3: the host (openclaw
 * `src/plugins/registry-registrars-tools-hooks.ts`, gate list in
 * `src/plugins/hook-types.ts` `CONVERSATION_HOOK_NAMES`) refuses a
 * conversation-hook registration from a NON-BUNDLED plugin unless
 * `plugins.entries.<id>.hooks.allowConversationAccess === true`. The refusal is
 * a `warn` diagnostic at gateway startup and nothing else: `api.on()` returns
 * void either way, so from inside the plugin the hook looks registered while
 * the handler is never invoked. Every `<plans_and_tasks>` guarantee added by
 * openclaw-beads-7sz is inert in that state, because none of it runs.
 *
 * Returns `undefined` when the answer is not knowable from the config the
 * plugin was handed (don't cry wolf in that case).
 */
export function resolveConversationAccess(config: unknown): boolean | undefined {
  const entries = (config as any)?.plugins?.entries;
  if (!entries || typeof entries !== "object") return undefined;
  const value = (entries as any)[PLUGIN_ID]?.hooks?.allowConversationAccess;
  return value === true;
}

/**
 * The operator-facing remedy for a blocked `before_prompt_build`. Kept as a
 * function so the message is identical wherever it is emitted.
 */
export function formatConversationAccessBlockedDiagnostic(): string {
  return (
    `[beads] before_prompt_build is BLOCKED by the host: plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess is not true, ` +
    "so <plans_and_tasks> CANNOT reach ordinary (non-heartbeat) turns. Heartbeat turns are still covered by the " +
    'heartbeat_prompt_contribution fallback. Fix: add "hooks": { "allowConversationAccess": true } to ' +
    `plugins.entries.${PLUGIN_ID} in ~/.openclaw/openclaw.json, then reload/restart the gateway. ` +
    'Confirm with: journalctl --user -u openclaw-gateway | grep \'plugin=beads\' — the "typed hook \\"before_prompt_build\\" blocked" line must be gone.'
  );
}

/**
 * Runs that already received the block from `heartbeat_prompt_contribution`.
 *
 * On a heartbeat turn with conversation access granted, BOTH hooks fire in the
 * same prompt build (openclaw `attempt.prompt-helpers.ts`
 * `resolvePromptBuildHookResult` joins heartbeat contributions ahead of
 * `before_prompt_build`), which would emit the block twice. Dedup is keyed
 * strictly on `ctx.runId`: when there is no runId we deliberately allow the
 * duplicate, because a duplicated block costs tokens while a missing one costs
 * the whole work queue.
 */
const HEARTBEAT_CONTRIBUTED_RUNS_MAX = 256;
const heartbeatContributedRuns = new Set<string>();

export function markHeartbeatContribution(runId: string | undefined): void {
  if (!runId) return;
  if (heartbeatContributedRuns.size >= HEARTBEAT_CONTRIBUTED_RUNS_MAX) {
    const oldest = heartbeatContributedRuns.values().next().value;
    if (oldest !== undefined) heartbeatContributedRuns.delete(oldest);
  }
  heartbeatContributedRuns.add(runId);
}

export function hasHeartbeatContribution(runId: string | undefined): boolean {
  return !!runId && heartbeatContributedRuns.has(runId);
}

export function activate(api: PluginApi): void {
  const log = api.logger;

  // Auth: "plugin" so the browser can hit these without a token.
  // The gateway is loopback-bound (127.0.0.1 / ::1 only), so any caller
  // is already on this host. No further auth needed for a local dev tool.
  const ROUTE_AUTH = "plugin" as const;

  if (api.on) {
    /**
     * One contribution path shared by both prompt hooks. `hookName` is only
     * used for logging — the caller decides which hook it is registering.
     */
    const contribute = async (
      hookName: "before_prompt_build" | "heartbeat_prompt_contribution",
      event: any,
      ctx: any,
    ): Promise<{ prependContext: string } | undefined> => {
      const agentId =
        typeof ctx?.agentId === "string" && ctx.agentId.trim()
          ? ctx.agentId.trim()
          : typeof event?.agentId === "string" && event.agentId.trim()
            ? event.agentId.trim()
            : "agent";
      const runId = typeof ctx?.runId === "string" && ctx.runId.trim() ? ctx.runId.trim() : undefined;
      if (hookName === "before_prompt_build" && hasHeartbeatContribution(runId)) {
        // Already contributed for this run via the heartbeat hook.
        return undefined;
      }
      try {
        const block = await buildPlansAndTasksBlock(api, agentId);
        // One line per contribution attempt. The gateway journal is the only
        // forensic surface for a missing block (openclaw-beads-7k3 spent four
        // recurrences being unattributable), so record the resolved agent id,
        // the hook that produced it, and the block size — a `chars=0` line
        // says "the plugin ran and deliberately emitted nothing", which no
        // amount of host-side log reading could establish before.
        log.info(
          `[beads] plans_and_tasks via ${hookName}: agent=${agentId} run=${runId ?? "-"} chars=${block?.length ?? 0}${
            block ? (block.includes('degraded="true"') ? " degraded=true" : "") : " SUPPRESSED"
          }`,
        );
        if (!block) return undefined;
        if (hookName === "heartbeat_prompt_contribution") markHeartbeatContribution(runId);
        return { prependContext: block };
      } catch (err: any) {
        // Belt and braces: a throw here is swallowed by the runtime's hook
        // runner, which logs one line and drops the contribution — the turn
        // then has no queue and no idea it lost one (openclaw-beads-7sz).
        const reason = String(err?.message ?? err).slice(0, 400);
        log.error(`[beads] ${hookName} failed for ${agentId}: ${reason}`);
        if (hookName === "heartbeat_prompt_contribution") markHeartbeatContribution(runId);
        return { prependContext: formatDegradedPlansAndTasksBlock({ agentId, reason }) };
      }
    };

    /**
     * `heartbeat_prompt_contribution` is a prompt-injection hook but NOT a
     * conversation hook (openclaw `hook-types.ts`: it is absent from
     * `CONVERSATION_HOOK_NAMES`), so the host registers it for a non-bundled
     * plugin without `allowConversationAccess`. Registering the block here as
     * well is what makes the heartbeat surface — the one that decides whether
     * an agent works or idles — survive the gate that silently removed
     * `before_prompt_build` from every turn since 2026-07-30 (openclaw-beads-7k3).
     */
    api.on(
      "heartbeat_prompt_contribution",
      async (event, ctx) => contribute("heartbeat_prompt_contribution", event, ctx),
      { priority: -20 },
    );

    api.on(
      "before_prompt_build",
      async (event, ctx) => contribute("before_prompt_build", event, ctx),
      { priority: -20 },
    );
  }

  if (api.registerHook && api.runtime?.system?.requestHeartbeatNow) {
    api.registerHook(
      "gateway:startup",
      (event) => {
        const runLoop = cfg(api).runLoop;
        if (runLoop?.enabled === false || runLoop?.startupWake === false) return;
        if (runLoop?.startupSessionMapping === false) {
          // Mapping disabled by config: fall back to legacy single-broadcast
          // wake only, and skip discovery entirely.
          api.runtime?.system?.requestHeartbeatNow?.({
            reason: "beads:gateway-startup",
            coalesceMs: runLoop?.startupWakeDelayMs ?? 1_000,
            heartbeat: { target: runLoop?.startupWakeTarget ?? "last" },
          });
          return;
        }

        const workspaceDir =
          runLoop?.workspaceDir ||
          (typeof event === "object" && event && typeof (event as any).workspaceDir === "string"
            ? ((event as any).workspaceDir as string)
            : join(homedir(), ".openclaw"));
        const recencyMs = Math.max(0, runLoop?.sessionMappingRecencyMs ?? 60 * 60 * 1_000);
        const repos = cfg(api).repos ?? [];
        const bdBinary = cfg(api).bdBinary;
        // PHASE 1 first (synchronously, immediately): single broadcast
        // heartbeat wake. Fires before any expensive work so it beats the
        // restart-sentinel path's MIN_WAKE_SPACING_MS=30000 window and
        // produces visible per-agent stamps. The heartbeat: target="last"
        // semantics mean each agent's most-recently-used session gets
        // poked, where prompt-build will pick up the soon-to-be-fresh
        // session-map cache.
        const wakeT0 = Date.now();
        api.runtime?.system?.requestHeartbeatNow?.({
          reason: "beads:gateway-startup",
          coalesceMs: runLoop?.startupWakeDelayMs ?? 1_000,
          heartbeat: { target: runLoop?.startupWakeTarget ?? "last" },
        });
        log.info(
          `[beads] gateway-startup: broadcast wake requested in ${Date.now() - wakeT0}ms ` +
            `(coalesceMs=${runLoop?.startupWakeDelayMs ?? 1_000}, target=${runLoop?.startupWakeTarget ?? "last"})`,
        );

        // PHASE 2 (async, non-blocking): build the issue↔session map and
        // persist it. The hook handler returns immediately so it never
        // blocks gateway boot. Failures are best-effort: the heartbeat
        // already fired above, so the agents are awake regardless.
        void (async () => {
          const phaseStart = Date.now();
          try {
            const { cache, timings } = await buildSessionMap({
              workspaceDir,
              repos,
              recencyMs,
              bdBinary,
            });
            const cacheT0 = Date.now();
            const cachePath = defaultSessionMapCachePath(homedir());
            let cacheWriteMs = 0;
            try {
              await writeSessionMapCache(cachePath, cache);
              cacheWriteMs = Date.now() - cacheT0;
            } catch (err: any) {
              log.warn(`[beads] gateway-startup: cache write failed: ${err?.message ?? err}`);
            }
            const explicit = cache.bindings.filter((b) => b.source === "explicit").length;
            const heuristic = cache.bindings.filter((b) => b.source === "heuristic").length;
            log.info(
              `[beads] gateway-startup: built session-map with ${cache.bindings.length} bindings ` +
                `(${explicit} explicit, ${heuristic} heuristic, ${cache.unbound.length} unbound) ` +
                `across ${new Set(cache.bindings.map((b) => b.agentId)).size} agents in ${Date.now() - phaseStart}ms ` +
                `(listAgents=${timings.listAgentsMs}ms readSessions=${timings.readSessionsMs}ms ` +
                `readIssues=${timings.readIssuesMs}ms bind=${timings.bindAndWriteMs}ms ` +
                `cacheWrite=${cacheWriteMs}ms) ` +
                `slowestRepos=[${timings.slowestRepos.map((r) => `${r.name}:${r.ms}ms`).join(", ")}]` +
                (timings.reposWithoutJsonl.length > 0
                  ? ` reposWithoutJsonl=[${timings.reposWithoutJsonl.join(", ")}]`
                  : ""),
            );
          } catch (err: any) {
            log.warn(`[beads] gateway-startup: session-map build failed: ${err?.message ?? err}`);
          }
        })();
      },
      {
        name: "beads-gateway-startup-wake",
        description:
          "On gateway startup: build issue↔session mapping cache, then fire one broadcast heartbeat wake.",
      },
    );
  }

  const serveUiShell = async (_req: IncomingMessage, res: ServerResponse) => {
    const html = await loadUiShell();
    return sendText(res, 200, html, "text/html; charset=utf-8");
  };

  // --- GET /beads → UI shell -----------------------------------------------
  api.registerHttpRoute({
    path: "/beads",
    auth: ROUTE_AUTH,
    match: "exact",
    handler: serveUiShell,
  });

  // --- GET /beads/<repo> → UI shell with path-backed repo selection ---------
  api.registerHttpRoute({
    path: "/beads/",
    auth: ROUTE_AUTH,
    match: "prefix",
    handler: serveUiShell,
  });

  // --- GET /beads/api/repos ------------------------------------------------
  api.registerHttpRoute({
    path: "/beads/api/repos",
    auth: ROUTE_AUTH,
    match: "exact",
    handler: async (_req, res) => {
      const repos = (cfg(api).repos ?? []).map((r) => ({ name: r.name, path: r.path }));
      const defaultRepo = repoByName(api, undefined)?.name;
      return sendJson(res, 200, { repos, defaultRepo, ownerOptions: ownerOptions(api) });
    },
  });

  // --- GET /beads/api/ready?limit=1 ----------------------------------------
  api.registerHttpRoute({
    path: "/beads/api/ready",
    auth: ROUTE_AUTH,
    match: "exact",
    handler: async (req, res) => {
      const params = parseQuery(req.url ?? "");
      const rawLimit = Number(params.get("limit") ?? "1");
      const limit = Math.max(1, Math.min(10, Number.isFinite(rawLimit) ? rawLimit : 1));
      const includeTest = params.get("includeTest") === "1" || params.get("includeTest") === "true";
      const repos = (cfg(api).repos ?? []).filter((repo) => includeTest || !/test/i.test(repo.name));
      const ttlMs = Math.max(0, cfg(api).runLoop?.readyApiCacheTtlMs ?? DEFAULT_READY_API_TTL_MS);
      const cacheKey = JSON.stringify({
        limit,
        includeTest,
        bdBinary: cfg(api).bdBinary ?? "",
        repos: repos.map((r) => [r.name, r.path]),
      });
      try {
        const body = await readyApiCache.getOrLoad(cacheKey, ttlMs, async () => {
          const results = await Promise.all(
            repos.map(async (repo) => {
              try {
                // Pull a generous slice for accurate totals; render-side
                // pagination still happens via `limit`. Without this the
                // project-header count would always be capped at `limit`
                // even when the repo has many more ready issues.
                //
                // Include in_progress issues (openclaw-beads-3yb): the
                // active work dashboard is meant to surface ANY active work
                // across agents, and an in_progress issue is the most
                // actively-worked state there is. Without this flag, claimed
                // multi-turn work (cyclical loops, claimed bugs, in-flight
                // refactors) silently disappears from the dashboard the
                // moment any agent moves it past `open`, which is
                // counterintuitive for a view called "active work."
                const allReady = await readyIssues(500, {
                  cwd: repo.path,
                  bdBinary: cfg(api).bdBinary,
                  timeoutMs: 5_000,
                  includeInProgress: true,
                });
                const totalReady = allReady.length;
                const issues = allReady.slice(0, limit);
                const issueIds = new Set(issues.map((issue) => issue.id));
                const edges = await listEdges(issues, { cwd: repo.path, bdBinary: cfg(api).bdBinary, timeoutMs: 5_000 });
                const behindIds = new Set(edges.filter((edge) => issueIds.has(edge.to)).map((edge) => edge.from));
                // Always pull the full issue list so we can derive both 'behind'
                // (dep-blocked by a ready issue) and 'stuck' (open issues in a
                // non-actionable status like blocked / deferred / waiting_for_*).
                const allIssues = await listIssues({ cwd: repo.path, bdBinary: cfg(api).bdBinary });
                const isStuckStatus = (s: unknown): boolean => {
                  const v = String(s ?? "").toLowerCase();
                  if (v === "blocked" || v === "deferred") return true;
                  if (v.startsWith("waiting_") || v.startsWith("waiting-")) return true;
                  return false;
                };
                const isOpenIsh = (s: unknown): boolean => {
                  const v = String(s ?? "").toLowerCase();
                  return v !== "closed" && v !== "done" && v !== "resolved";
                };
                const behind = allIssues
                  .filter((issue) => behindIds.has(issue.id) && !issueIds.has(issue.id))
                  .sort((a, b) => Number(a.priority ?? 2) - Number(b.priority ?? 2));
                const behindIdSet = new Set(behind.map((i) => i.id));
                const stuck = allIssues
                  .filter((issue) =>
                    isOpenIsh(issue.status) &&
                    isStuckStatus(issue.status) &&
                    !issueIds.has(issue.id) &&
                    !behindIdSet.has(issue.id),
                  )
                  .sort((a, b) => Number(a.priority ?? 2) - Number(b.priority ?? 2));
                return {
                  repo: repo.name,
                  path: repo.path,
                  issues,
                  totalReady,
                  behind,
                  stuck,
                };
              } catch (err: any) {
                return {
                  repo: repo.name,
                  path: repo.path,
                  issues: [] as BdIssue[],
                  totalReady: 0,
                  behind: [] as BdIssue[],
                  stuck: [] as BdIssue[],
                  error: String(err?.message ?? err).slice(0, 300),
                };
              }
            }),
          );
          return { repos: results, limit };
        });
        return sendJson(res, 200, body);
      } catch (err: any) {
        log.warn(`[beads] /beads/api/ready failed:`, err?.message ?? err);
        return sendJson(res, 500, { error: String(err?.message ?? err) });
      }
    },
  });

  // --- GET /beads/api/issues?repo=<name> -----------------------------------
  api.registerHttpRoute({
    path: "/beads/api/issues",
    auth: ROUTE_AUTH,
    match: "exact",
    handler: async (req, res) => {
      const url = req.url ?? "";
      const params = parseQuery(url);
      const repo = repoByName(api, params.get("repo") ?? undefined);
      if (!repo) return sendJson(res, 400, { error: "no repo configured or named repo not found" });
      try {
        const issues = await listIssues({ cwd: repo.path, bdBinary: cfg(api).bdBinary });
        return sendJson(res, 200, { repo: repo.name, issues });
      } catch (err: any) {
        log.warn(`[beads] /beads/api/issues failed for ${repo.name}:`, err?.message ?? err);
        return sendJson(res, 500, { error: String(err?.message ?? err) });
      }
    },
  });

  // --- GET /beads/api/issue/:id?repo=<name> --------------------------------
  // Implemented as prefix match because exact doesn't support path params.
  api.registerHttpRoute({
    path: "/beads/api/issue/",
    auth: ROUTE_AUTH,
    match: "prefix",
    handler: async (req, res) => {
      const path = pathFromUrl(req.url);
      const id = path.replace(/^\/beads\/api\/issue\//, "").replace(/\/.*$/, "");
      if (!id) return sendJson(res, 400, { error: "missing issue id" });
      const params = parseQuery(req.url ?? "");
      const repo = repoByName(api, params.get("repo") ?? undefined);
      if (!repo) return sendJson(res, 400, { error: "no repo configured or named repo not found" });

      const method = (req.method ?? "GET").toUpperCase();
      const cwd = repo.path;
      const bdBinary = cfg(api).bdBinary;
      const opts = { cwd, bdBinary };

      try {
        if (method === "GET") {
          const detail = await showIssue(id, opts);
          return sendJson(res, 200, { repo: repo.name, issue: detail });
        }
        if (method === "PATCH") {
          const body = (await readJsonBody(req)) as BdMutateInput;
          const before = await showIssue(id, opts).catch(() => null);
          await updateIssue(id, body, opts);
          const detail = await showIssue(id, opts);
          scheduleCalendarEventCreate({
            api,
            repo,
            issue: detail,
            previousIssue: before,
            opts,
            reason: "target-added",
          });
          return sendJson(res, 200, { repo: repo.name, issue: detail });
        }
        if (method === "DELETE") {
          await deleteIssue(id, opts);
          return sendJson(res, 200, { repo: repo.name, deleted: id });
        }
        if (method === "POST") {
          // Path: /beads/api/issue/<id>/close or /reopen
          const action = path.replace(/^\/beads\/api\/issue\/[^/]+\//, "");
          if (action === "close") {
            const body = (await readJsonBody(req).catch(() => ({}))) as { reason?: string };
            await closeIssue(id, body?.reason, opts);
            const detail = await showIssue(id, opts);
            return sendJson(res, 200, { repo: repo.name, issue: detail });
          }
          if (action === "reopen") {
            await reopenIssue(id, opts);
            const detail = await showIssue(id, opts);
            return sendJson(res, 200, { repo: repo.name, issue: detail });
          }
          return sendJson(res, 400, { error: `unknown action: ${action}` });
        }
        return sendJson(res, 405, { error: `method not allowed: ${method}` });
      } catch (err: any) {
        log.warn(`[beads] /beads/api/issue/${id} ${method} failed:`, err?.message ?? err);
        return sendJson(res, 500, { error: String(err?.message ?? err) });
      }
    },
  });

  // --- POST/DELETE /beads/api/deps?repo=<name>&from=X&to=Y -----------------
  api.registerHttpRoute({
    path: "/beads/api/deps/edit",
    auth: ROUTE_AUTH,
    match: "exact",
    handler: async (req, res) => {
      const params = parseQuery(req.url ?? "");
      const repo = repoByName(api, params.get("repo") ?? undefined);
      if (!repo) return sendJson(res, 400, { error: "no repo configured" });
      const method = (req.method ?? "GET").toUpperCase();
      if (method !== "POST" && method !== "DELETE")
        return sendJson(res, 405, { error: "POST or DELETE only" });
      try {
        const body = (await readJsonBody(req)) as { from?: string; to?: string };
        const from = (body.from || "").trim();
        const to = (body.to || "").trim();
        if (!from || !to) return sendJson(res, 400, { error: "from and to are required" });
        if (from === to) return sendJson(res, 400, { error: "cannot link an issue to itself" });
        const opts = { cwd: repo.path, bdBinary: cfg(api).bdBinary };
        if (method === "POST") await addDependency(from, to, opts);
        else await removeDependency(from, to, opts);
        return sendJson(res, 200, { repo: repo.name, from, to, action: method === "POST" ? "added" : "removed" });
      } catch (err: any) {
        log.warn(`[beads] /beads/api/deps/edit ${method} failed:`, err?.message ?? err);
        return sendJson(res, 500, { error: String(err?.message ?? err) });
      }
    },
  });

  // --- POST /beads/api/issues?repo=<name> (create) -------------------------
  api.registerHttpRoute({
    path: "/beads/api/issues/create",
    auth: ROUTE_AUTH,
    match: "exact",
    handler: async (req, res) => {
      if ((req.method ?? "GET").toUpperCase() !== "POST")
        return sendJson(res, 405, { error: "POST only" });
      const params = parseQuery(req.url ?? "");
      const repo = repoByName(api, params.get("repo") ?? undefined);
      if (!repo) return sendJson(res, 400, { error: "no repo configured" });
      try {
        const body = (await readJsonBody(req)) as BdMutateInput & {
          title: string;
          owner?: string;
          references?: string[];
        };
        if (!body.title || !body.title.trim())
          return sendJson(res, 400, { error: "title is required" });
        if (!body.owner || !body.owner.trim())
          return sendJson(res, 400, { error: "owner is required" });
        const references = (body.references ?? []).map((r) => r.trim()).filter(Boolean);
        const opts = { cwd: repo.path, bdBinary: cfg(api).bdBinary };
        const issue = await createIssue(
          { ...body, owner: body.owner.trim(), references },
          opts,
        );
        const detail = issue?.id ? await showIssue(issue.id, opts).catch(() => issue) : issue;
        scheduleCalendarEventCreate({
          api,
          repo,
          issue: detail,
          opts,
          reason: "create",
        });
        return sendJson(res, 200, { repo: repo.name, issue: detail });
      } catch (err: any) {
        log.warn(`[beads] create failed:`, err?.message ?? err);
        return sendJson(res, 500, { error: String(err?.message ?? err) });
      }
    },
  });

  // --- GET /beads/api/deps?repo=<name> -------------------------------------
  api.registerHttpRoute({
    path: "/beads/api/deps",
    auth: ROUTE_AUTH,
    match: "exact",
    handler: async (req, res) => {
      const params = parseQuery(req.url ?? "");
      const repo = repoByName(api, params.get("repo") ?? undefined);
      if (!repo) return sendJson(res, 400, { error: "no repo configured or named repo not found" });
      try {
        // listIssues prefers .beads/issues.jsonl, which already includes
        // dependency arrays. That makes /deps a cheap file read in the common
        // case and falls back to bd only when the export is missing/stale.
        const issues = await listIssues({ cwd: repo.path, bdBinary: cfg(api).bdBinary });
        const edges = await listEdges(issues, { cwd: repo.path, bdBinary: cfg(api).bdBinary });
        return sendJson(res, 200, { repo: repo.name, edges });
      } catch (err: any) {
        log.warn(`[beads] /beads/api/deps failed for ${repo.name}:`, err?.message ?? err);
        return sendJson(res, 500, { error: String(err?.message ?? err) });
      }
    },
  });

  // Say out loud, once per activation, whether the block can actually reach a
  // prompt. openclaw-beads-7k3: the host's refusal to register
  // `before_prompt_build` is a single host-side warn line that nobody was
  // reading, and the plugin looked perfectly healthy from its own logs.
  const conversationAccess = resolveConversationAccess(api.config);
  if (conversationAccess === true) {
    log.info(
      `[beads] prompt hooks registered: heartbeat_prompt_contribution + before_prompt_build (allowConversationAccess=true)`,
    );
  } else if (conversationAccess === false) {
    log.error(formatConversationAccessBlockedDiagnostic());
  } else {
    log.warn(
      `[beads] could not determine plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess from the config handed to this plugin; if <plans_and_tasks> is missing from non-heartbeat turns, check the gateway log for 'typed hook "before_prompt_build" blocked'.`,
    );
  }

  log.info(`[beads] plugin activated, ${cfg(api).repos?.length ?? 0} repos configured`);
}

// CommonJS-style default export for OpenClaw plugin loader compat.
// Upstream loader contract (July 2026): a `register` function is resolved from
// the default export; named `activate` alone fails validation. Alias it.
export default { id: "beads", register: activate, activate };
