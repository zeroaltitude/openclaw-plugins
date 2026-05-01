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
}

export interface IssueDetail {
  raw: any;
  id: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

async function runBd(args: string[], opts: BdRunOptions): Promise<string> {
  const bin = opts.bdBinary ?? "bd";
  try {
    const { stdout } = await execFileAsync(bin, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    const msg = err?.stderr || err?.message || String(err);
    throw new Error(`bd ${args.join(" ")} failed in ${opts.cwd}: ${msg}`);
  }
}

/**
 * List all issues in a repo as JSON.
 *
 * `bd list --json` returns an array of issues by default; we pass
 * `--all` so closed/deferred issues appear too (the visualizer wants
 * the full graph including past work).
 */
export async function listIssues(opts: BdRunOptions): Promise<BdIssue[]> {
  // Fast path: Beads auto-exports a JSONL cache after writes. It contains
  // the same issue records plus dependency arrays, and avoids spawning bd.
  const exported = await listIssuesFromExport(opts.cwd).catch(() => null);
  if (exported) return exported;

  const out = await runBd(["list", "--all", "--json"], opts);
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

async function listIssuesFromExport(cwd: string): Promise<BdIssue[] | null> {
  const path = join(cwd, ".beads", "issues.jsonl");
  const text = await readFile(path, "utf8");
  const issues: BdIssue[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed);
    if (parsed && (parsed._type === undefined || parsed._type === "issue") && typeof parsed.id === "string") {
      issues.push(parsed as BdIssue);
    }
  }
  return issues;
}

function stripWarnings(stdout: string): string {
  // bd writes "Warning: ...\nRun: ...\n" preamble to stdout when permissions are off.
  // Drop those lines so JSON.parse works.
  const lines = stdout.split("\n").filter((l) => !l.startsWith("Warning:") && !l.startsWith("Run:"));
  return lines.join("\n").trim();
}

/** Fetch a single issue's full detail (description, comments, etc.) */
export async function showIssue(id: string, opts: BdRunOptions): Promise<any> {
  const out = await runBd(["show", id, "--json"], opts);
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
  // bd create --json returns the created issue
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed[0];
    return parsed;
  } catch {
    throw new Error(`bd create returned non-JSON: ${trimmed.slice(0, 200)}`);
  }
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
    const current = await showIssue(id, opts).catch(() => null);
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
}

/** Close an issue. */
export async function closeIssue(id: string, reason: string | undefined, opts: BdRunOptions): Promise<void> {
  const args = ["close", id];
  if (reason) args.push("--reason", reason);
  await runBd(args, opts);
}

/** Reopen a closed issue. */
export async function reopenIssue(id: string, opts: BdRunOptions): Promise<void> {
  await runBd(["reopen", id], opts);
}

/** Permanently delete an issue. */
export async function deleteIssue(id: string, opts: BdRunOptions): Promise<void> {
  await runBd(["delete", id, "--force"], opts);
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
  if (args.length > 2) await runBd(args, opts);
}

/** List dependency-ready work using Beads' own ready-work semantics. */
export async function readyIssues(limit: number, opts: BdRunOptions): Promise<BdIssue[]> {
  const out = await runBd(["ready", "--json", "--limit", String(Math.max(1, limit))], {
    ...opts,
    timeoutMs: opts.timeoutMs ?? 5_000,
  });
  const trimmed = stripWarnings(out);
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed as BdIssue[];
    if (parsed && Array.isArray((parsed as any).issues)) return (parsed as any).issues as BdIssue[];
    return [];
  } catch {
    throw new Error(`bd ready returned non-JSON output: ${trimmed.slice(0, 200)}`);
  }
}

/** Add a dependency edge: `child` depends on `parent` (child is blocked by parent). */
export async function addDependency(child: string, parent: string, opts: BdRunOptions): Promise<void> {
  // bd dep add <blocked> <blocker> — i.e., child depends on parent.
  await runBd(["dep", "add", child, parent], opts);
}

/** Remove a dependency edge. */
export async function removeDependency(child: string, parent: string, opts: BdRunOptions): Promise<void> {
  await runBd(["dep", "remove", child, parent], opts);
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
      const out = await runBd(["dep", "list", ...issueIds, "--json"], opts);
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
      const out = await runBd(["show", issue.id, "--json"], opts);
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
  const edges: BdEdge[] = [];
  for (const issue of issues) {
    if (hasDependencyField(issue)) sawDependencyField = true;
    for (const dep of collectDeps(issue)) {
      edges.push({ from: issue.id, to: dep.id, type: dep.type });
    }
  }
  return sawDependencyField ? edges : null;
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
