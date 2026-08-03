/**
 * Thin shell-out wrapper around the `bd` CLI.
 *
 * v0.1 scope: read-only queries via `bd list --json` and `bd dep list --json`
 * (or equivalent commands that expose dependency edges).
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BdMutateInput {
  title?: string;
  description?: string;
  type?: string;
  priority?: number | string;
  status?: string;
  /** Owner / assignee — required by plugin policy on create. */
  owner?: string;
  /** Reference file paths relevant for context. Stored as labels `ref:<path>`. Optional. */
  references?: string[];
  /** Calendarable target/deadline. Stored as bd due_at plus metadata.target_datetime. */
  target_datetime?: string;
}

export const REFERENCE_LABEL_PREFIX = "ref:";
/** Legacy prefix from earlier v0.1.6 ("memories"). Kept for read compatibility. */
export const LEGACY_MEMORY_LABEL_PREFIX = "memory:";

export function referencesFromLabels(labels: string[] | undefined | null): string[] {
  if (!Array.isArray(labels)) return [];
  const out: string[] = [];
  for (const l of labels) {
    if (typeof l !== "string") continue;
    if (l.startsWith(REFERENCE_LABEL_PREFIX)) {
      const v = l.slice(REFERENCE_LABEL_PREFIX.length);
      if (v) out.push(v);
    } else if (l.startsWith(LEGACY_MEMORY_LABEL_PREFIX)) {
      const v = l.slice(LEGACY_MEMORY_LABEL_PREFIX.length);
      if (v) out.push(v);
    }
  }
  return out;
}

export interface BdRepo {
  name: string;
  path: string;
}

export interface BdIssue {
  id: string;
  title: string;
  description?: string;
  status?: string;
  priority?: number | string;
  type?: string;
  owner?: string;
  created?: string;
  updated?: string;
  labels?: string[];
  // Permissive — Beads' JSON shape varies across versions; pass through unknowns.
  [k: string]: unknown;
}

export interface BdEdge {
  from: string; // dependent issue
  to: string;   // dependency target
  type?: string;
}

export interface BdRunOptions {
  bdBinary?: string;
  cwd: string;
  timeoutMs?: number;
  /**
   * Wall-clock epoch ms after which no new `bd` attempt may start. Lets a
   * caller with an overall budget (the heartbeat block builder) stop a
   * retry chain from overrunning it. Attempt timeouts are also clamped to
   * the time remaining.
   */
  deadlineMs?: number;
  /**
   * Extra attempts for *transient* failures (timeout kills, Dolt lock
   * contention). Only read-only commands set this; mutations stay
   * single-shot so a partially-applied write is never replayed.
   */
  retries?: number;
  /** Base backoff between retry attempts; doubles each attempt. Default 200ms. */
  retryBackoffMs?: number;
}

export interface IssueDetail {
  raw: any;
  id: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** Retry budget for read-only commands. See {@link BdRunOptions.retries}. */
export const DEFAULT_READ_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_MS = 200;

/**
 * Structured failure from a `bd` shell-out.
 *
 * Exists because the previous bare `new Error(stderr || message)` threw away
 * every signal that distinguishes "bd is broken" from "we killed bd at our
 * own 4s timeout" — and a SIGTERM'd child exits with EMPTY stderr, so the
 * heartbeat block rendered a useless `Command failed: bd ...` with no detail
 * (openclaw-beads-7sz, observed 2026-07-27). Keep every field: the message is
 * what ends up in the injected `<error>` element, and it is often the only
 * forensic record of a nondeterministic failure.
 */
export class BdCommandError extends Error {
  readonly args: string[];
  readonly cwd: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly killed: boolean;
  /** True when the child was killed by our own `timeout` option. */
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly attempts: number;
  /** libuv spawn failure code (ENOENT, EAGAIN, …) when the child never ran. */
  readonly spawnCode: string;
  /** True when a retry could plausibly succeed (timeout kill, lock contention). */
  readonly transient: boolean;

  constructor(params: {
    args: string[];
    cwd: string;
    stderr: string;
    exitCode: number | null;
    signal: string | null;
    killed: boolean;
    timedOut: boolean;
    durationMs: number;
    timeoutMs: number;
    attempts: number;
    spawnCode: string;
    transient: boolean;
    rawMessage: string;
  }) {
    const cause = params.timedOut
      ? `timed out after ${params.timeoutMs}ms, killed with ${params.signal ?? "SIGTERM"}`
      : params.signal
        ? `killed with ${params.signal}`
        : params.spawnCode
          ? `spawn failed: ${params.spawnCode}`
          : `exit code ${params.exitCode ?? "unknown"}`;
    const detail = params.stderr.trim()
      ? params.stderr.trim().slice(0, 500)
      : `(no stderr) ${params.rawMessage.split("\n")[0] ?? ""}`.trim();
    super(
      `bd ${params.args.join(" ")} failed in ${params.cwd} after ${params.durationMs}ms ` +
        `[attempt ${params.attempts}] (${cause}): ${detail}`,
    );
    this.name = "BdCommandError";
    this.args = params.args;
    this.cwd = params.cwd;
    this.stderr = params.stderr;
    this.exitCode = params.exitCode;
    this.signal = params.signal;
    this.killed = params.killed;
    this.timedOut = params.timedOut;
    this.durationMs = params.durationMs;
    this.attempts = params.attempts;
    this.spawnCode = params.spawnCode;
    this.transient = params.transient;
  }
}

/** stderr fragments that indicate a retry has a real chance of succeeding. */
const TRANSIENT_STDERR_RE =
  /lock|locked|busy|deadlock|try again|temporarily unavailable|connection (?:refused|reset)|EAGAIN|ENOMEM|i\/o timeout|context deadline exceeded/i;

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as any).toString === "function" && Buffer.isBuffer(value))
    return (value as Buffer).toString("utf8");
  return "";
}

function toBdCommandError(
  err: any,
  ctx: { args: string[]; cwd: string; durationMs: number; timeoutMs: number; attempts: number },
): BdCommandError {
  const stderr = asString(err?.stderr);
  const rawMessage = String(err?.message ?? err ?? "");
  const killed = err?.killed === true;
  const signal = typeof err?.signal === "string" ? err.signal : null;
  // execFile reports the timeout kill as killed=true + SIGTERM with a null
  // exit code; there is no dedicated error code to key off.
  const timedOut = killed && err?.code !== "ENOENT";
  const exitCode = typeof err?.code === "number" ? err.code : null;
  const spawnCode = typeof err?.code === "string" ? err.code : "";
  const transient =
    timedOut ||
    spawnCode === "EAGAIN" ||
    spawnCode === "ENOMEM" ||
    TRANSIENT_STDERR_RE.test(stderr) ||
    TRANSIENT_STDERR_RE.test(rawMessage);
  return new BdCommandError({
    args: ctx.args,
    cwd: ctx.cwd,
    stderr,
    exitCode,
    signal,
    killed,
    timedOut,
    durationMs: ctx.durationMs,
    timeoutMs: ctx.timeoutMs,
    attempts: ctx.attempts,
    spawnCode,
    transient,
    rawMessage: rawMessage,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve this attempt's timeout, clamped to any remaining overall budget.
 * Returns 0 when the caller's deadline has already passed.
 */
function attemptTimeoutMs(opts: BdRunOptions): number {
  const base = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (opts.deadlineMs === undefined) return base;
  return Math.min(base, opts.deadlineMs - Date.now());
}

async function runBd(args: string[], opts: BdRunOptions): Promise<string> {
  const bin = opts.bdBinary ?? "bd";
  const maxAttempts = Math.max(0, opts.retries ?? 0) + 1;
  const backoffBase = Math.max(0, opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS);
  let lastErr: BdCommandError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const timeoutMs = attemptTimeoutMs(opts);
    if (timeoutMs <= 0) {
      throw (
        lastErr ??
        new BdCommandError({
          args,
          cwd: opts.cwd,
          stderr: "",
          exitCode: null,
          signal: null,
          killed: false,
          timedOut: true,
          durationMs: 0,
          timeoutMs: 0,
          attempts: attempt,
          spawnCode: "",
          transient: true,
          rawMessage: "overall time budget exhausted before this command could start",
        })
      );
    }
    const startedAt = Date.now();
    try {
      const { stdout } = await execFileAsync(bin, args, {
        cwd: opts.cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch (err: any) {
      lastErr = toBdCommandError(err, {
        args,
        cwd: opts.cwd,
        durationMs: Date.now() - startedAt,
        timeoutMs,
        attempts: attempt,
      });
      if (attempt >= maxAttempts || !lastErr.transient) throw lastErr;
      const backoff = backoffBase * 2 ** (attempt - 1);
      if (opts.deadlineMs !== undefined && Date.now() + backoff >= opts.deadlineMs) throw lastErr;
      await delay(backoff);
    }
  }
  // Unreachable: the loop either returns or throws.
  throw lastErr ?? new Error(`bd ${args.join(" ")} failed in ${opts.cwd}`);
}

/** Read-only variant: same as runBd but retries transient failures by default. */
function runBdRead(args: string[], opts: BdRunOptions): Promise<string> {
  return runBd(args, { ...opts, retries: opts.retries ?? DEFAULT_READ_RETRIES });
}

/**
 * List all issues in a repo as JSON.
 *
 * `bd list --json` returns an array of issues by default; we pass
 * `--all` so closed/deferred issues appear too (the visualizer wants
 * the full graph including past work).
 */
export async function listIssues(opts: BdRunOptions): Promise<BdIssue[]> {
  // Fast path: read the exported `.beads/issues.jsonl` snapshot instead of
  // spawning bd. It carries the same issue records plus dependency arrays.
  //
  // CAVEAT: this snapshot is a DERIVED EXPORT of the live Dolt DB, not the
  // store itself, and bd (v1.0.3, Dolt backend) does NOT auto-export after
  // shell-initiated mutations (`bd close`/`bd update` run directly in a
  // shell). It is only refreshed by an explicit `bd export` — either the
  // plugin's own write path (see refreshExport) or ensureFreshExport() on
  // the readiness build path. So this snapshot can lag the live DB whenever
  // a mutation happened outside the plugin. Callers that need status truth
  // (e.g. building the ready-issues heartbeat block) must ensureFreshExport
  // first; see index.ts buildPlansAndTasksBlock.
  const exported = await readIssuesJsonl(opts.cwd).catch(() => null);
  if (exported) return exported;

  const out = await runBdRead(["list", "--all", "--json"], opts);
  const trimmed = stripWarnings(out);
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed as BdIssue[];
    if (parsed && Array.isArray((parsed as any).issues)) return (parsed as any).issues as BdIssue[];
    return [];
  } catch (err) {
    throw new Error(`bd list returned non-JSON output: ${trimmed.slice(0, 200)}`);
  }
}

/**
 * Read every issue record from `.beads/issues.jsonl`.
 *
 * This is the fast path for every plugin read (list/ready/show). It reads a
 * DERIVED EXPORT of the live Dolt DB, so it is only as fresh as the last
 * `bd export`. bd does NOT auto-export after shell-initiated mutations, so
 * the snapshot can be stale relative to the live store; callers that need
 * status truth must ensureFreshExport() first (see index.ts). Returns null
 * when the cache file is missing or unparseable so callers can fall back to
 * spawning `bd`.
 *
 * Exceptions to the fast path (still require a `bd` spawn):
 *   - All write paths (create/update/close/reopen/delete/dep add/dep
 *     remove/set-metadata/export) — bd is the only safe writer to the
 *     Dolt-backed store.
 *   - bd's `ready` semantics that aren't surfaced in the JSONL: the
 *     ephemeral (wisp) flag and the molecule "hooked" flag aren't
 *     recorded as top-level fields, so the fast path can't filter
 *     them. Current callers don't use those filters; document for
 *     review if that changes.
 */
export async function readIssuesJsonl(cwd: string): Promise<BdIssue[] | null> {
  const path = join(cwd, ".beads", "issues.jsonl");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const issues: BdIssue[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // One bad line invalidates the fast path — fall back to bd.
      return null;
    }
    if (parsed && (parsed._type === undefined || parsed._type === "issue") && typeof parsed.id === "string") {
      issues.push(parsed as BdIssue);
    }
  }
  return issues;
}

/** Back-compat alias retained in case downstream code imports it. */
async function listIssuesFromExport(cwd: string): Promise<BdIssue[] | null> {
  return readIssuesJsonl(cwd);
}
void listIssuesFromExport;

function stripWarnings(stdout: string): string {
  // bd writes "Warning: ...\nRun: ...\n" preamble to stdout when permissions are off.
  // Drop those lines so JSON.parse works.
  const lines = stdout.split("\n").filter((l) => !l.startsWith("Warning:") && !l.startsWith("Run:"));
  return lines.join("\n").trim();
}

/** Fetch a single issue's full detail (description, comments, etc.).
 *
 * Fast path reads `.beads/issues.jsonl`. Pass `forceFresh: true` when the
 * caller has just mutated the issue and needs the post-write state
 * authoritatively (e.g. label reconciliation inside updateIssue), or when
 * the JSONL may be stale because the mutation happened outside the plugin
 * (a shell `bd close`/`bd update`). The plugin's own write path refreshes
 * the JSONL after each write, but bd itself does not auto-export, so the
 * bd CLI is the only authoritative source when the writer wasn't us.
 */
export async function showIssue(
  id: string,
  opts: BdRunOptions,
  showOpts: { forceFresh?: boolean } = {},
): Promise<any> {
  if (!showOpts.forceFresh) {
    const issues = await readIssuesJsonl(opts.cwd).catch(() => null);
    if (issues) {
      const match = issues.find((issue) => issue.id === id);
      if (match) return match;
      // Issue not in the export. Could be ephemeral/wisp or freshly created
      // before the next refresh. Fall through to bd.
    }
  }
  const out = await runBdRead(["show", id, "--json"], opts);
  const trimmed = stripWarnings(out);
  return JSON.parse(trimmed);
}

/** Create a new issue. Returns the created issue. */
export async function createIssue(
  input: BdMutateInput & { title: string; owner: string; references?: string[] },
  opts: BdRunOptions,
): Promise<BdIssue> {
  const args = ["create", input.title, "--json"];
  if (input.description) args.push("--description", input.description);
  if (input.type) args.push("--type", input.type);
  if (input.priority !== undefined && input.priority !== null && input.priority !== "")
    args.push("--priority", String(input.priority));
  if (input.owner) args.push("--assignee", input.owner);
  if (input.target_datetime) {
    args.push("--due", input.target_datetime);
    args.push("--metadata", JSON.stringify({ target_datetime: input.target_datetime }));
  }
  // bd create takes labels via repeated --label
  for (const r of input.references ?? []) {
    if (r && r.trim()) args.push("--label", `${REFERENCE_LABEL_PREFIX}${r.trim()}`);
  }
  const out = await runBd(args, opts);
  const trimmed = stripWarnings(out);
  // bd create --json returns the created issue.
  let created: BdIssue;
  try {
    const parsed = JSON.parse(trimmed);
    created = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    await refreshExport(opts);
    throw new Error(`bd create returned non-JSON: ${trimmed.slice(0, 200)}`);
  }
  // bd create has no --status flag (issues always start "open"). Honor a requested
  // non-open status with a follow-up update so the UI can file work directly as
  // e.g. waiting_for_user.
  if (input.status && input.status !== "open" && created?.id) {
    await runBd(["update", created.id, "--status", input.status], opts);
    created = { ...created, status: input.status };
  }
  await refreshExport(opts);
  return created;
}

/** Update fields on an existing issue. */
export async function updateIssue(
  id: string,
  patch: BdMutateInput,
  opts: BdRunOptions,
): Promise<void> {
  const args = ["update", id];
  if (patch.title !== undefined) args.push("--title", patch.title);
  if (patch.description !== undefined) args.push("--description", patch.description);
  if (patch.priority !== undefined && patch.priority !== null && patch.priority !== "")
    args.push("--priority", String(patch.priority));
  if (patch.status !== undefined && patch.status !== "") args.push("--status", patch.status);
  if (patch.type !== undefined && patch.type !== "") args.push("--type", patch.type);
  if (patch.owner !== undefined) args.push("--assignee", patch.owner);
  if (patch.target_datetime !== undefined) {
    const target = patch.target_datetime.trim();
    args.push("--due", target);
    if (target) args.push("--set-metadata", `target_datetime=${target}`);
    else {
      args.push("--unset-metadata", "target_datetime");
      args.push("--unset-metadata", "calendar_event_id");
      args.push("--unset-metadata", "calendar_id");
      args.push("--unset-metadata", "calendar_account");
      args.push("--unset-metadata", "calendar_synced_at");
    }
  }
  if (args.length > 2) await runBd(args, opts);

  // Reference labels are reconciled separately because bd's update CLI uses
  // additive --add-label / --remove-label rather than replacing the full set.
  if (patch.references !== undefined) {
    // forceFresh: we just wrote above and need authoritative live labels,
    // not the JSONL snapshot which may briefly lag.
    const current = await showIssue(id, opts, { forceFresh: true }).catch(() => null);
    const currentRefs = new Set(referencesFromLabels(current?.labels));
    const desiredRefs = new Set((patch.references ?? []).map((r) => r.trim()).filter(Boolean));
    const toAdd: string[] = [];
    const toRemove: string[] = [];
    for (const r of desiredRefs) if (!currentRefs.has(r)) toAdd.push(r);
    // Build remove list from the LIVE labels so legacy memory:* labels are removed
    // when the user edits the references and doesn't include them.
    const liveLabels: string[] = Array.isArray(current?.labels) ? current.labels : [];
    const toRemoveLabels: string[] = [];
    for (const l of liveLabels) {
      if (typeof l !== "string") continue;
      if (l.startsWith(REFERENCE_LABEL_PREFIX)) {
        const v = l.slice(REFERENCE_LABEL_PREFIX.length);
        if (v && !desiredRefs.has(v)) toRemoveLabels.push(l);
      } else if (l.startsWith(LEGACY_MEMORY_LABEL_PREFIX)) {
        const v = l.slice(LEGACY_MEMORY_LABEL_PREFIX.length);
        if (v && !desiredRefs.has(v)) toRemoveLabels.push(l);
      }
    }
    if (toAdd.length || toRemoveLabels.length) {
      const labelArgs: string[] = ["update", id];
      for (const r of toAdd) labelArgs.push("--add-label", `${REFERENCE_LABEL_PREFIX}${r}`);
      for (const lab of toRemoveLabels) labelArgs.push("--remove-label", lab);
      await runBd(labelArgs, opts);
    }
  }
  await refreshExport(opts);
}

/**
 * Refresh `.beads/issues.jsonl` from the live Dolt DB after a write.
 *
 * The dashboard/heartbeat fast path reads from this file. bd (v1.0.3, Dolt
 * backend) does NOT auto-export after mutations — the JSONL is a derived
 * export that only advances when `bd export` runs. So without this explicit
 * refresh, mutations made through the plugin API would read stale state on
 * the very next poll, and there is no background process that "catches up."
 *
 * Awaited so the HTTP response only returns after the cache is consistent.
 * Never throws: a failed export leaves the previous (possibly stale) snapshot
 * in place, which is degraded but usable. It DOES report the failure in its
 * return value — a swallowed export failure means every subsequent read is
 * silently serving stale status, and the heartbeat block must be able to say
 * so out loud (openclaw-beads-7sz).
 */
export interface ExportResult {
  ok: boolean;
  /** Populated when ok === false; already human-readable with stderr + cause. */
  error?: string;
  durationMs: number;
}

export async function refreshExport(opts: BdRunOptions): Promise<ExportResult> {
  const startedAt = Date.now();
  try {
    await runBdRead(["export", "-q", "-o", ".beads/issues.jsonl"], {
      ...opts,
      timeoutMs: opts.timeoutMs ?? 10_000,
    });
    return { ok: true, durationMs: Date.now() - startedAt };
  } catch (err: any) {
    return {
      ok: false,
      error: String(err?.message ?? err),
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Reader-side self-heal: force `.beads/issues.jsonl` to reflect the live
 * Dolt DB before a caller trusts the snapshot for status truth.
 *
 * This is the durable fix for the staleness gap (bighat-p5j). The JSONL is
 * a derived export; bd does not auto-export after shell-initiated mutations
 * (`bd close`/`bd update` run directly in a shell, as HEARTBEAT.md instructs
 * everywhere). We proved the cheap "is it stale?" signals unreliable for
 * shell closes: the per-repo export-state.json timestamp, `~/.beads/
 * last-touched` mtime, and the JSONL mtime do NOT all move on a shell
 * `bd close`. The only correct signal is re-exporting from the live store,
 * which is also cheap (`bd export -q` of ~100 issues is well under a second)
 * and is amortized by the caller's own TTL cache, so we run it
 * unconditionally on the readiness build path rather than trying to guess
 * freshness.
 *
 * Best-effort and identical in effect to refreshExport(); named separately
 * so the READ path's intent (heal before trusting) is distinct from the
 * WRITE path's (persist after mutating). Failures leave the possibly-stale
 * snapshot in place — degraded, but no worse than before this fix. Callers
 * that render a queue MUST surface a non-ok result rather than silently
 * trusting the snapshot.
 */
export async function ensureFreshExport(opts: BdRunOptions): Promise<ExportResult> {
  return refreshExport(opts);
}

/** Close an issue. */
export async function closeIssue(id: string, reason: string | undefined, opts: BdRunOptions): Promise<void> {
  const args = ["close", id];
  if (reason) args.push("--reason", reason);
  await runBd(args, opts);
  await refreshExport(opts);
}

/** Reopen a closed issue. */
export async function reopenIssue(id: string, opts: BdRunOptions): Promise<void> {
  await runBd(["reopen", id], opts);
  await refreshExport(opts);
}

/** Permanently delete an issue. */
export async function deleteIssue(id: string, opts: BdRunOptions): Promise<void> {
  await runBd(["delete", id, "--force"], opts);
  await refreshExport(opts);
}

/** Set custom metadata fields on an issue. */
export async function setIssueMetadata(
  id: string,
  metadata: Record<string, string>,
  opts: BdRunOptions,
): Promise<void> {
  const args = ["update", id];
  for (const [key, value] of Object.entries(metadata)) {
    args.push("--set-metadata", `${key}=${value}`);
  }
  if (args.length > 2) {
    await runBd(args, opts);
    await refreshExport(opts);
  }
}

/** List dependency-ready work using Beads' own ready-work semantics.
 *
 * Fast path: compute readiness from `.beads/issues.jsonl` so the prompt-block
 * builder doesn't fork `bd` per repo on every cache miss. Falls back to
 * `bd ready --json` when the JSONL is missing/unparseable, when any issue
 * record is missing the `dependency_count` signal we use to detect
 * dep-aware exports, or when a blocker reference can't be resolved
 * locally (defensive: lets bd's authoritative GetReadyWork API decide).
 *
 * Exceptions — the JSONL fast path does NOT replicate these bd `ready`
 * filters because the data isn't surfaced in the export:
 *   - ephemeral (wisp) issues are not flagged as a top-level field
 *   - molecule "hooked" state is not flagged as a top-level field
 * Current callers don't pass those filters; if a caller starts using them
 * we should either extend the JSONL exporter or force the bd fallback for
 * that call.
 */
/** Options for {@link readyIssues}. */
export type ReadyIssuesOptions = BdRunOptions & {
  /**
   * When true, also include issues with `status === "in_progress"` in the
   * returned list. These are issues an agent has already claimed and is
   * actively driving — they're "active work" from the agent's perspective
   * even though `bd ready` (and the strict JSONL fast path) excludes them
   * to avoid double-claiming. Use this for surfaces that should show "work
   * I should keep advancing" (e.g. heartbeat injection, cyclical-loop
   * resumption) rather than "work I should claim next."
   *
   * Defaults to false to preserve strict `bd ready` semantics for callers
   * that want unstarted work only (e.g. dashboards that count ready work
   * separately from in-flight work).
   */
  includeInProgress?: boolean;
};

export async function readyIssues(limit: number, opts: ReadyIssuesOptions): Promise<BdIssue[]> {
  const safeLimit = Math.max(1, limit);
  const includeInProgress = opts.includeInProgress === true;
  const fast = await readyIssuesFromExport(opts.cwd, safeLimit, { includeInProgress }).catch(
    () => null,
  );
  if (fast) return fast;

  const out = await runBdRead(["ready", "--json", "--limit", String(safeLimit)], {
    ...opts,
    timeoutMs: opts.timeoutMs ?? 5_000,
  });
  const trimmed = stripWarnings(out);
  let bdReady: BdIssue[] = [];
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) bdReady = parsed as BdIssue[];
      else if (parsed && Array.isArray((parsed as any).issues))
        bdReady = (parsed as any).issues as BdIssue[];
    } catch {
      throw new Error(`bd ready returned non-JSON output: ${trimmed.slice(0, 200)}`);
    }
  }
  if (!includeInProgress) return bdReady;

  // The bd CLI's `ready` command intentionally excludes in_progress (it's
  // designed for "what to claim next"). When the caller asked for active
  // work that includes in-flight items, supplement the bd-ready output
  // with a separate `bd list --status in_progress` pass and merge.
  const ipOut = await runBdRead(["list", "--status", "in_progress", "--json"], {
    ...opts,
    timeoutMs: opts.timeoutMs ?? 5_000,
  });
  const ipTrimmed = stripWarnings(ipOut);
  let inProgress: BdIssue[] = [];
  if (ipTrimmed) {
    try {
      const parsed = JSON.parse(ipTrimmed);
      if (Array.isArray(parsed)) inProgress = parsed as BdIssue[];
      else if (parsed && Array.isArray((parsed as any).issues))
        inProgress = (parsed as any).issues as BdIssue[];
    } catch {
      // Ignore parse failures here — better to return the strict-ready set
      // than to throw and lose all of it.
    }
  }
  const seen = new Set(bdReady.map((i) => i.id));
  const merged = [...bdReady];
  for (const issue of inProgress) {
    if (!seen.has(issue.id)) merged.push(issue);
  }
  merged.sort(compareReadyIssues);
  return merged.slice(0, safeLimit);
}

/** Options for {@link readyIssuesFromExport}. */
export type ReadyIssuesFromExportOptions = {
  /** See {@link ReadyIssuesOptions.includeInProgress}. */
  includeInProgress?: boolean;
  /**
   * Degraded-mode escape hatch: answer from the JSONL even when the export
   * lacks the metadata needed to be certain (no `dependency_count` anywhere,
   * a blocker id that isn't in the export, a `dependency_count > 0` record
   * with no `dependencies` array). Those cases normally return null so the
   * caller defers to bd's authoritative API; when bd itself is unavailable
   * there is nothing to defer to, and a best-effort list beats an empty one.
   *
   * Callers MUST label lenient results as degraded — an unresolvable blocker
   * is treated as non-blocking here, so the list can over-report readiness.
   */
  lenient?: boolean;
};

/** Compute ready issues from the JSONL export, mirroring `bd ready` semantics:
 *  - status === "open" (excludes in_progress / blocked / deferred / closed)
 *  - defer_until missing or already in the past
 *  - every entry in `dependencies` resolves to a closed issue
 *  - sorted by priority asc, then created_at asc (matches bd default)
 *  - capped to `limit`
 *
 *  Pass `{ includeInProgress: true }` to additionally include
 *  `status === "in_progress"` entries in the result. In-progress issues
 *  are emitted alongside ready issues without the dependency-resolution
 *  filter (they're already started, blocker bookkeeping doesn't apply
 *  retroactively) and without the defer_until filter. The strict
 *  `bd ready` fast-path semantics are preserved when this option is
 *  unset (the default).
 *
 *  Returns null when the JSONL is missing, unparseable, or doesn't carry
 *  enough metadata to safely answer (e.g. a blocker isn't in the export,
 *  or the export predates `dependency_count` and we can't tell whether
 *  zero-dep issues actually have hidden blockers).
 */
export async function readyIssuesFromExport(
  cwd: string,
  limit: number,
  opts: ReadyIssuesFromExportOptions = {},
): Promise<BdIssue[] | null> {
  const lenient = opts.lenient === true;
  const issues = await readIssuesJsonl(cwd);
  if (!issues) return null;

  const byId = new Map<string, BdIssue>();
  for (const issue of issues) byId.set(issue.id, issue);

  // The exporter started writing dependency_count later in bd's life. If
  // we don't see it on any record, we can't safely declare an issue
  // unblocked from the JSONL alone — fall back to bd.
  let sawDependencyCount = false;
  for (const issue of issues) {
    if (typeof (issue as any).dependency_count === "number") {
      sawDependencyCount = true;
      break;
    }
  }
  if (!sawDependencyCount && !lenient) return null;

  const includeInProgress = opts.includeInProgress === true;
  const now = Date.now();
  const ready: BdIssue[] = [];
  for (const issue of issues) {
    const status = (issue as any).status;

    // Strict ready path: only `open` issues, with full defer + dependency
    // checks applied. In-progress issues take a separate, simpler path
    // below (they're already claimed, so blocker / defer bookkeeping is
    // not retroactively meaningful for them).
    if (status === "in_progress") {
      if (includeInProgress) ready.push(issue);
      continue;
    }
    if (status !== "open") continue;

    const deferUntil = (issue as any).defer_until ?? (issue as any).deferUntil;
    if (typeof deferUntil === "string" && deferUntil) {
      const t = Date.parse(deferUntil);
      if (Number.isFinite(t) && t > now) continue;
    }

    const depCount = Number((issue as any).dependency_count ?? 0);
    if (depCount > 0) {
      const deps = collectDeps(issue);
      if (!deps.length) {
        // Export claims this issue has deps but didn't include the array.
        // Can't confirm readiness locally — bail (or, in lenient mode,
        // include it and let the agent discover the blocker).
        if (!lenient) return null;
      }
      let blocked = false;
      for (const dep of deps) {
        const target = byId.get(dep.id);
        if (!target) {
          // Unknown blocker (cross-repo? exported before target?). Be
          // conservative and let bd decide for this whole repo.
          if (!lenient) return null;
          continue;
        }
        if ((target as any).status !== "closed") {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
    }

    ready.push(issue);
  }

  ready.sort(compareReadyIssues);
  return ready.slice(0, limit);
}

function compareReadyIssues(a: BdIssue, b: BdIssue): number {
  const pa = priorityRank((a as any).priority);
  const pb = priorityRank((b as any).priority);
  if (pa !== pb) return pa - pb;
  const ca = String((a as any).created_at ?? "");
  const cb = String((b as any).created_at ?? "");
  if (ca && cb && ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function priorityRank(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  // Treat missing priority as lowest urgency.
  return Number.MAX_SAFE_INTEGER;
}

/** Add a dependency edge: `child` depends on `parent` (child is blocked by parent). */
export async function addDependency(child: string, parent: string, opts: BdRunOptions): Promise<void> {
  // bd dep add <blocked> <blocker> — i.e., child depends on parent.
  await runBd(["dep", "add", child, parent], opts);
  await refreshExport(opts);
}

/** Remove a dependency edge. */
export async function removeDependency(child: string, parent: string, opts: BdRunOptions): Promise<void> {
  await runBd(["dep", "remove", child, parent], opts);
  await refreshExport(opts);
}

/**
 * Extract dependency edges. v0.1 walks each issue and asks `bd show <id> --json`
 * for its dependencies; we'll iterate. Heavy for large repos but OK for now.
 *
 * If a future bd version exposes `bd dep list --json` repo-wide, swap that in.
 */
export async function listEdges(issues: BdIssue[], opts: BdRunOptions): Promise<BdEdge[]> {
  const issueIds = issues.map((issue) => issue.id).filter(Boolean);
  if (!issueIds.length) return [];

  // Fast path: exported/listed issue records may already carry dependency
  // arrays. This is what .beads/issues.jsonl provides, and it avoids the
  // expensive `bd dep list <all ids>` spawn/query on every graph load.
  const collected = collectEdgesFromIssueRecords(issues);
  if (collected) return collected;

  // Fallback: authoritative dependency API. With multiple issue IDs,
  // `bd dep list --json` returns records shaped like:
  //   { issue_id, depends_on_id, type }
  // With a single issue ID, bd currently returns issue records instead, so
  // we fall back to `bd show` parsing for that case.
  if (issueIds.length > 1) {
    try {
      const out = await runBdRead(["dep", "list", ...issueIds, "--json"], opts);
      const trimmed = stripWarnings(out);
      const parsed = trimmed ? JSON.parse(trimmed) : [];
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry: any) => {
            const from = entry?.issue_id ?? entry?.issueId ?? entry?.from;
            const to = entry?.depends_on_id ?? entry?.dependsOnId ?? entry?.to;
            if (typeof from !== "string" || typeof to !== "string") return null;
            return { from, to, type: typeof entry?.type === "string" ? entry.type : undefined };
          })
          .filter(Boolean) as BdEdge[];
      }
    } catch {
      // Fall through to per-issue detail parsing below.
    }
  }

  const edges: BdEdge[] = [];
  // Sequential to avoid Dolt lockfile contention on the embedded store.
  for (const issue of issues) {
    try {
      const out = await runBdRead(["show", issue.id, "--json"], opts);
      const parsed = JSON.parse(stripWarnings(out));
      const deps = collectDeps(parsed);
      for (const dep of deps) {
        edges.push({ from: issue.id, to: dep.id, type: dep.type });
      }
    } catch {
      // Best-effort: skip issues whose detail we can't fetch.
    }
  }
  return edges;
}

interface DepRef {
  id: string;
  type?: string;
}

function collectEdgesFromIssueRecords(issues: BdIssue[]): BdEdge[] | null {
  let sawDependencyField = false;
  let countAware = true;
  let anyMissingArrayWithCount = false;
  const edges: BdEdge[] = [];
  for (const issue of issues) {
    if (hasDependencyField(issue)) sawDependencyField = true;
    const count = (issue as any)?.dependency_count;
    if (typeof count !== "number") {
      countAware = false;
    } else if (count > 0 && !hasDependencyField(issue)) {
      // Export claims this issue has deps but didn't include the array;
      // we can't trust the count alone in that case.
      anyMissingArrayWithCount = true;
    }
    for (const dep of collectDeps(issue)) {
      edges.push({ from: issue.id, to: dep.id, type: dep.type });
    }
  }
  if (sawDependencyField) return edges;
  // Treat dependency_count as a signal that the export is dep-aware.
  // bd export omits the dependencies array when dependency_count is 0,
  // so a repo where every issue has zero deps would otherwise fall through
  // to an expensive `bd dep list` even though we already know the answer.
  if (countAware && !anyMissingArrayWithCount) return edges;
  return null;
}

function hasDependencyField(payload: any): boolean {
  if (!payload || typeof payload !== "object") return false;
  const issue = Array.isArray(payload) ? payload[0] : payload;
  if (!issue || typeof issue !== "object") return false;
  const candidateKeys = ["dependencies", "deps", "blocked_by", "blockedBy", "parents", "depends_on", "dependsOn"];
  return candidateKeys.some((key) => Array.isArray(issue[key]));
}

/** Pull dependency-like fields out of a `bd show --json` payload. */
function collectDeps(payload: any): DepRef[] {
  const out: DepRef[] = [];
  if (!payload || typeof payload !== "object") return out;

  // bd show --json currently returns an array with one issue object.
  // Older versions returned the object directly. Support both.
  const issue = Array.isArray(payload) ? payload[0] : payload;
  if (!issue || typeof issue !== "object") return out;

  const candidateKeys = ["dependencies", "deps", "blocked_by", "blockedBy", "parents", "depends_on", "dependsOn"];
  for (const key of candidateKeys) {
    const val = issue[key];
    if (Array.isArray(val)) {
      for (const entry of val) {
        if (typeof entry === "string") out.push({ id: entry });
        else if (entry && typeof entry === "object") {
          const id = entry.id ?? entry.target ?? entry.to ?? entry.depends_on_id ?? entry.dependsOnId;
          const type = entry.type ?? entry.dependency_type ?? key;
          if (typeof id === "string") out.push({ id, type: typeof type === "string" ? type : key });
        }
      }
    }
  }
  return out;
}
