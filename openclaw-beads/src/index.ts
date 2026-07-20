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

export function shouldIncludeReadyIssue(issue: BdIssue, agentId: string, includeUnassigned: boolean): boolean {
  const owner = issueAssignee(issue);
  if (!owner) return includeUnassigned;
  return owner === "any" || owner === agentId;
}

/**
 * Heartbeat selection ordering for `<plans_and_tasks>`. Sorts by:
 *   1. Direct-assignee match first (assignee === agentId), so an
 *      agent's own work is never starved by `any` backlog when the
 *      list is capped by `readyLimitPerRepo`.
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

export function formatPlansAndTasksBlock(params: {
  agentId: string;
  repos: Array<{ repo: BdRepo; issues: BdIssue[]; error?: string }>;
}): string {
  const lines: string[] = [];
  lines.push("<plans_and_tasks>");
  lines.push("These are active Beads issues that are ready for assessment. Treat them as background work opportunities, not as higher priority than the user's latest request.");
  lines.push("");
  lines.push("Run-loop discipline:");
  lines.push("- First satisfy the user's current request. If ready Beads work conflicts with it, explain the tradeoff and ask what to prioritize.");
  lines.push("- For non-trivial work you are about to perform, ensure there is a Beads issue tracking it. Simple exchanges (date/time, quick clarification, casual chat, one-shot answers with no durable follow-up) do not need an issue.");
  lines.push(`- When creating a Beads issue for work you will do, assign it to your own agent id (${params.agentId}) by default unless the user specified someone else or it belongs in general backlog (owner any).`);
  lines.push("- Ignore issues assigned to another owner. You may act on issues assigned to you or to any.");
  lines.push("- Never treat issues from repos whose configured repo name matches /test/i as ready work.");
  lines.push("- If you start meaningful work, mark the issue in_progress. If completed, close it. If waiting on the user, mark waiting_for_user. If waiting on an available agent/resource, mark waiting_for_available_agent. If blocked with no path forward, mark blocked. Keep state truthful.");
  lines.push("- An `in_progress` issue listed below is active work you (or a previous turn) already claimed. Resume it; do NOT restart it as if it were a fresh `open` issue. If a single `in_progress` issue represents a long-running multi-turn loop (e.g. cyclical PR review), advance it as far as the current turn allows, leave it `in_progress`, and let the next heartbeat pick up where you left off.");
  lines.push("- If the user suggests future work, bugs, investigations, reminders, or other durable trackables, create/update Beads issues for them and include target_datetime metadata when timing is implied.");
  lines.push("- If this turn was not triggered by direct user input (for example heartbeat, gateway startup/resume, cron wake, or other autonomous wake) and you take action on Beads work, explicitly reply with a concise summary of the Beads issue(s) touched and actions taken. If no action was taken, stay quiet unless there is a meaningful blocker or decision for the user.");
  lines.push("");

  const readyRepos = params.repos.filter((entry) => entry.issues.length > 0 || entry.error);
  if (!readyRepos.length) {
    lines.push("<ready_issues none=\"true\" />");
  } else {
    lines.push("<ready_issues>");
    for (const entry of readyRepos) {
      lines.push(`  <repo name=\"${escapeXml(entry.repo.name)}\">`);
      if (entry.error) lines.push(`    <error>${escapeXml(entry.error)}</error>`);
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

async function buildPlansAndTasksBlock(api: PluginApi, agentId: string): Promise<string | null> {
  const config = cfg(api);
  if (config.runLoop?.enabled === false) return null;
  const repos = config.repos ?? [];
  if (!repos.length) return null;
  const limit = Math.max(1, config.runLoop?.readyLimitPerRepo ?? 3);
  const includeUnassigned = config.runLoop?.includeUnassigned ?? false;
  const actionableRepos = repos.filter((repo) => !/test/i.test(repo.name));
  const ttlMs = Math.max(0, config.runLoop?.readyCacheTtlMs ?? DEFAULT_PROMPT_BLOCK_TTL_MS);
  const cacheKey = JSON.stringify({
    agentId,
    limit,
    includeUnassigned,
    bdBinary: config.bdBinary ?? "",
    repos: actionableRepos.map((r) => [r.name, r.path]),
  });
  return promptBlockCache.getOrLoad(cacheKey, ttlMs, async () => {
    const results = await Promise.all(
      actionableRepos.map(async (repo) => {
        try {
          // Reader-side self-heal (bighat-p5j): re-export the JSONL from the
          // live Dolt DB before trusting the fast path for status truth. bd
          // 1.0.3 does NOT auto-export after shell-initiated mutations
          // (`bd close`/`bd update` run in a shell as HEARTBEAT.md
          // instructs), so without this the heartbeat can present an
          // already-closed issue as ready. `bd export` is cheap (<1s per
          // repo) and the whole block is TTL-cached anyway.
          await ensureFreshExport({
            cwd: repo.path,
            bdBinary: config.bdBinary,
            timeoutMs: 5_000,
          });
          const ready = await readyIssues(Math.max(10, limit * 4), {
            cwd: repo.path,
            bdBinary: config.bdBinary,
            timeoutMs: 4_000,
            // Include `in_progress` issues so the heartbeat surface shows
            // active work the agent has already claimed (cyclical loops,
            // multi-turn fixes). Without this, an `in_progress` issue
            // disappears from `<ready_issues>` after it's claimed and any
            // heartbeat that lands while no `open` work exists will idle
            // even though the agent has work to resume.
            includeInProgress: true,
          });
          const issues = ready
            .filter((issue) => shouldIncludeReadyIssue(issue, agentId, includeUnassigned))
            .sort((a, b) => compareReadyIssuesForAgent(a, b, agentId))
            .slice(0, limit);
          return { repo, issues };
        } catch (err: any) {
          return { repo, issues: [] as BdIssue[], error: String(err?.message ?? err).slice(0, 300) };
        }
      }),
    );
    return formatPlansAndTasksBlock({ agentId, repos: results });
  });
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

export function activate(api: PluginApi): void {
  const log = api.logger;

  // Auth: "plugin" so the browser can hit these without a token.
  // The gateway is loopback-bound (127.0.0.1 / ::1 only), so any caller
  // is already on this host. No further auth needed for a local dev tool.
  const ROUTE_AUTH = "plugin" as const;

  if (api.on) {
    api.on(
      "before_prompt_build",
      async (_event, ctx) => {
        const agentId = typeof ctx?.agentId === "string" && ctx.agentId.trim() ? ctx.agentId.trim() : "agent";
        const block = await buildPlansAndTasksBlock(api, agentId);
        return block ? { prependContext: block } : undefined;
      },
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

  log.info(`[beads] plugin activated, ${cfg(api).repos?.length ?? 0} repos configured`);
}

// CommonJS-style default export for OpenClaw plugin loader compat.
// Upstream loader contract (July 2026): a `register` function is resolved from
// the default export; named `activate` alone fails validation. Alias it.
export default { id: "beads", register: activate, activate };
