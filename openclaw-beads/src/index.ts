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

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
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
  referencesFromLabels,
  type BdIssue,
  type BdRepo,
  type BdMutateInput,
} from "./beads-cli.js";

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
  };
}

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

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

function shouldIncludeReadyIssue(issue: BdIssue, agentId: string, includeUnassigned: boolean): boolean {
  const owner = issueAssignee(issue);
  if (!owner) return includeUnassigned;
  return owner === "any" || owner === agentId;
}

function formatPlansAndTasksBlock(params: {
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
  lines.push("- If the user suggests future work, bugs, investigations, reminders, or other durable trackables, create/update Beads issues for them and include target_datetime metadata when timing is implied.");
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
        const target = (issue as any).target_datetime ?? (issue as any).targetDatetime;
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

async function buildPlansAndTasksBlock(api: PluginApi, agentId: string): Promise<string | null> {
  const config = cfg(api);
  if (config.runLoop?.enabled === false) return null;
  const repos = config.repos ?? [];
  if (!repos.length) return null;
  const limit = Math.max(1, config.runLoop?.readyLimitPerRepo ?? 1);
  const includeUnassigned = config.runLoop?.includeUnassigned ?? false;
  const actionableRepos = repos.filter((repo) => !/test/i.test(repo.name));
  const results = await Promise.all(
    actionableRepos.map(async (repo) => {
      try {
        const ready = await readyIssues(Math.max(10, limit * 4), {
          cwd: repo.path,
          bdBinary: config.bdBinary,
          timeoutMs: 4_000,
        });
        const issues = ready
          .filter((issue) => shouldIncludeReadyIssue(issue, agentId, includeUnassigned))
          .slice(0, limit);
        return { repo, issues };
      } catch (err: any) {
        return { repo, issues: [] as BdIssue[], error: String(err?.message ?? err).slice(0, 300) };
      }
    }),
  );
  return formatPlansAndTasksBlock({ agentId, repos: results });
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
          await updateIssue(id, body, opts);
          const detail = await showIssue(id, opts);
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
        const issue = await createIssue(
          { ...body, owner: body.owner.trim(), references },
          { cwd: repo.path, bdBinary: cfg(api).bdBinary },
        );
        return sendJson(res, 200, { repo: repo.name, issue });
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
export default { activate };
