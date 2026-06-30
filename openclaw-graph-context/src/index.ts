/**
 * OpenClaw Graph Context plugin
 *
 * Registers gateway HTTP routes:
 *   GET /graph-context            → UI shell (Reaflow visualizer)
 *   GET /graph-context/api/stats  → graph stats JSON
 *   GET /graph-context/api/sessions → recent session nodes
 *   GET /graph-context/api/neighbourhood?sessionId=<id> → subgraph around a session
 *   POST /graph-context/api/ingest → trigger incremental ingest
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSchema, openDb, graphStats, recentSessions, neighbourhood, hierarchyGraph, resolveDbPath, classifyHeartbeats, markDuplicateNodes, migrateVirtualHierarchy } from "./db.js";
import { ingestAll, buildVirtualHierarchy } from "./ingest.js";
import type Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = __dirname;

interface PluginApi {
  registerHttpRoute(params: {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
    replaceExisting?: boolean;
  }): void;
  pluginConfig?: Record<string, unknown>;
  logger: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  on?: (hookName: string, handler: (event: unknown, ctx: unknown) => unknown, opts?: { priority?: number }) => void;
  registerHook?: (events: string | string[], handler: (event: unknown) => unknown, opts?: { name?: string; description?: string }) => void;
}

interface GraphContextConfig {
  dbPath?: string;
  agentsDir?: string;
}

function cfg(api: PluginApi): GraphContextConfig {
  return (api.pluginConfig ?? {}) as GraphContextConfig;
}

// --- HTTP helpers (same pattern as beads) ---

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
  return true;
}

function sendText(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): true {
  res.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
  return true;
}

function parseQuery(url: string): Record<string, string> {
  try {
    const u = new URL(url, "http://localhost");
    const q: Record<string, string> = {};
    for (const [k, v] of u.searchParams) q[k] = v;
    return q;
  } catch {
    return {};
  }
}

function pathFromUrl(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return url ?? "/";
  }
}

// --- UI shell loader ---

const FALLBACK_UI = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Graph Context — UI shell missing</title></head>
<body><h1>UI shell not found</h1><p>Looked for ui/index.html alongside the plugin.</p></body></html>`;

async function loadUiShell(): Promise<string> {
  const candidates = [
    join(PLUGIN_DIR, "..", "ui", "index.html"),
    join(PLUGIN_DIR, "ui", "index.html"),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p, "utf8");
    } catch {
      // try next
    }
  }
  return FALLBACK_UI;
}

// --- Plugin activation ---

export function activate(api: PluginApi): void {
  const log = api.logger;
  const ROUTE_AUTH = "plugin" as const;

  // Open (or create) the SQLite graph DB once at activation time.
  const config = cfg(api);
  const dbPath = resolveDbPath(config.dbPath);
  const agentsDir = (config.agentsDir ?? join(homedir(), ".openclaw", "agents")).replace("~", homedir());

  let db: Database.Database;
  try {
    db = openDb(dbPath);
    initSchema(db);
    log.info(`[graph-context] DB opened: ${dbPath}`);
  } catch (err) {
    log.error(`[graph-context] Failed to open DB at ${dbPath}:`, err);
    return;
  }

  // --- UI shell routes ---
  const serveUiShell = async (_req: IncomingMessage, res: ServerResponse) => {
    const html = await loadUiShell();
    return sendText(res, 200, html, "text/html; charset=utf-8");
  };

  api.registerHttpRoute({ path: "/graph-context", auth: ROUTE_AUTH, match: "exact", handler: serveUiShell });
  api.registerHttpRoute({ path: "/graph-context/", auth: ROUTE_AUTH, match: "prefix", handler: async (req, res) => {
    const path = pathFromUrl(req.url);

    // --- GET /graph-context/api/stats ---
    if (path === "/graph-context/api/stats") {
      try {
        return sendJson(res, 200, graphStats(db));
      } catch (err) {
        return sendJson(res, 500, { error: String(err) });
      }
    }

    // --- GET /graph-context/api/sessions ---
    if (path === "/graph-context/api/sessions") {
      const q = parseQuery(req.url ?? "");
      const limit = Math.min(parseInt(q.limit ?? "100", 10) || 100, 500);
      const agentId = q.agent;
      const includeHeartbeats = q.heartbeats !== "false";
      try {
        return sendJson(res, 200, recentSessions(db, limit, agentId, includeHeartbeats));
      } catch (err) {
        return sendJson(res, 500, { error: String(err) });
      }
    }

    // --- POST /graph-context/api/classify ---
    if (path === "/graph-context/api/classify" && (req.method ?? "GET").toUpperCase() === "POST") {
      try {
        const updated = classifyHeartbeats(db);
        log.info(`[graph-context] classify: ${updated} sessions marked as heartbeat`);
        return sendJson(res, 200, { updated });
      } catch (err) {
        return sendJson(res, 500, { error: String(err) });
      }
    }

    // --- GET /graph-context/api/hierarchy ---
    if (path === "/graph-context/api/hierarchy") {
      const q = parseQuery(req.url ?? "");
      // ?hidden=true → include nodes tagged display=hidden (debug view)
      const includeHidden = q.hidden === "true";
      try {
        return sendJson(res, 200, hierarchyGraph(db, includeHidden));
      } catch (err) {
        return sendJson(res, 500, { error: String(err) });
      }
    }

    // --- POST /graph-context/api/prune ---
    if (path === "/graph-context/api/prune" && (req.method ?? "GET").toUpperCase() === "POST") {
      try {
        const result = markDuplicateNodes(db);
        log.info(`[graph-context] prune: heartbeats=${result.heartbeatSessionsHidden} dup-ref_files=${result.duplicateRefFilesHidden} empty-session_types=${result.emptySessionTypesHidden}`);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 500, { error: String(err) });
      }
    }

    // --- POST /graph-context/api/migrate ---
    // Wipe stale virtual hierarchy nodes, reclassify sessions, rebuild hierarchy, re-prune.
    // Use this after pulling a new version of the plugin to apply schema migrations.
    if (path === "/graph-context/api/migrate" && (req.method ?? "GET").toUpperCase() === "POST") {
      try {
        const migration = migrateVirtualHierarchy(db);
        log.info(`[graph-context] migrate: wipedNodes=${migration.wipedNodes} reclassified=${migration.reclassified}`);
        db.transaction(() => buildVirtualHierarchy(db, agentsDir))();
        const classified = classifyHeartbeats(db);
        const pruned = markDuplicateNodes(db);
        log.info(`[graph-context] migrate complete: classified=${classified} heartbeats=${pruned.heartbeatSessionsHidden}`);
        return sendJson(res, 200, { ...migration, classified, pruned });
      } catch (err) {
        return sendJson(res, 500, { error: String(err) });
      }
    }

    // --- GET /graph-context/api/neighbourhood ---
    if (path === "/graph-context/api/neighbourhood") {
      const q = parseQuery(req.url ?? "");
      const sessionId = q.sessionId;
      if (!sessionId) return sendJson(res, 400, { error: "sessionId required" });
      try {
        return sendJson(res, 200, neighbourhood(db, sessionId, parseInt(q.maxNodes ?? "200", 10) || 200));
      } catch (err) {
        return sendJson(res, 500, { error: String(err) });
      }
    }

    // --- POST /graph-context/api/ingest ---
    if (path === "/graph-context/api/ingest" && (req.method ?? "GET").toUpperCase() === "POST") {
      // Non-blocking: kick off ingest and return immediately with a job token.
      const jobId = Date.now().toString();
      void ingestAll(db, {
        agentsDir,
        onProgress: (msg) => log.info(msg),
      }).then((results) => {
        const total = Object.values(results).reduce(
          (acc, r) => ({ nodes: acc.nodes + r.nodesAdded, edges: acc.edges + r.edgesAdded }), { nodes: 0, edges: 0 }
        );
        log.info(`[graph-context] ingest job ${jobId} complete: nodes=${total.nodes} edges=${total.edges}`);
        // Auto-classify any new heartbeat sessions after every ingest
        try {
          const classified = classifyHeartbeats(db);
          if (classified > 0) log.info(`[graph-context] ingest job ${jobId} classified ${classified} new heartbeat sessions`);
        } catch (err) {
          log.warn(`[graph-context] post-ingest classify failed:`, err);
        }
        // Re-run display=hidden pruning so hierarchy stays clean
        try {
          const pruned = markDuplicateNodes(db);
          log.info(`[graph-context] ingest job ${jobId} pruned: heartbeats=${pruned.heartbeatSessionsHidden} dup-ref_files=${pruned.duplicateRefFilesHidden} empty-session_types=${pruned.emptySessionTypesHidden}`);
        } catch (err) {
          log.warn(`[graph-context] post-ingest prune failed:`, err);
        }
      }).catch((err) => {
        log.error(`[graph-context] ingest job ${jobId} failed:`, err);
      });
      return sendJson(res, 202, { jobId, status: "started" });
    }

    // Serve UI for any unmatched /graph-context/... path
    return serveUiShell(req, res);
  }});

  log.info("[graph-context] routes registered: /graph-context");
}

export default { activate };
