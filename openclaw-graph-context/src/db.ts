/**
 * SQLite graph schema and DB initialization.
 *
 * Graph model:
 *
 * NODES — typed content units:
 *   session    — one per JSONL file (root of a conversation thread)
 *   message    — one user or assistant turn within a session
 *   tool_call  — one node per toolCall content block in an assistant message
 *   tool_result— one node per toolResult JSONL message entry
 *   summary    — compaction summary replacing a pruned message range
 *
 * EDGES — typed relationships:
 *   sequence      — A→B: B follows A in the same session (total order within session)
 *   invokes       — assistant_message→tool_call: the message invoked this tool
 *   returns       — tool_call→tool_result: the tool call produced this result
 *   peer          — session→peer_id: this session involves this peer identity
 *   channel       — session→channel_key: which channel/surface this session lives on
 *   agent         — session→agent_id: which OpenClaw agent owns this session
 *   task          — message→task_id: this message is tagged to a task (future)
 *   summarizes    — summary→message: this summary replaced these messages
 *   session_key   — session→raw_session_key: the full routing key string
 *
 * All edges are directed. The `properties` column is a JSON blob for extra metadata.
 *
 * Node granularity: Option B — tool calls and tool results are separate typed nodes,
 * linked to their parent message via invokes/returns edges. This enables querying
 * "all sessions that called exec" or inspecting tool inputs/outputs independently.
 */

import Database from "better-sqlite3";
import { homedir } from "node:os";

// Hard cap for any session list returned to the UI (sidebar, ref_files expansion, etc).
// A ref_files set with a large fan-out can otherwise return hundreds of session nodes
// in one shot, which both floods the UI and produces unusably large graph layouts.
export const MAX_SESSION_LIST = 100;

export type NodeType =
  | "session"
  | "message"
  | "tool_call"
  | "tool_result"
  | "summary"
  // Virtual structural nodes (no conversation content, exist for context-engine assembly):
  | "root"          // singleton root of the entire graph
  | "agent"         // one per OpenClaw agent identity
  | "session_type"  // classifies why the RefFiles set is what it is (normal/subagent/cron/heartbeat/…)
  | "ref_files";    // the exact set of workspace files injected into runs of this type

export type EdgeType =
  | "sequence"
  | "invokes"
  | "returns"
  | "peer"
  | "channel"
  | "agent"
  | "task"
  | "summarizes"
  | "session_key"
  | "contains";     // structural: root→agent, agent→session_type, session_type→ref_files, ref_files→session

export type MessageRole = "user" | "assistant";

export interface GraphNode {
  id: string;              // UUID or stable hash
  type: NodeType;
  agent_id: string;        // which openclaw agent (tank, main, narcissus, ...)
  session_id: string;      // JSONL session UUID
  session_key: string;     // routing key (agent:tank:discord:tank:direct:...)
  role?: MessageRole;      // only for message nodes
  ts: number;              // unix ms
  content_text?: string;   // plaintext content (truncated for large messages)
  content_tokens?: number; // estimated token count
  properties?: string;     // JSON blob for extra fields
}

export interface GraphEdge {
  id: string;
  src: string;      // source node id
  dst: string;      // destination node id
  type: EdgeType;
  weight: number;   // 1.0 default; can be tuned by salience scoring
  properties?: string;
}

export function resolveDbPath(configured?: string): string {
  const raw = configured ?? "~/.openclaw/graph-context.db";
  return raw.startsWith("~/") ? raw.replace("~", homedir()) : raw;
}

export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id              TEXT PRIMARY KEY,
      type            TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      session_key     TEXT NOT NULL,
      role            TEXT,
      ts              INTEGER NOT NULL,
      content_text    TEXT,
      content_tokens  INTEGER,
      properties      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_session_id  ON nodes(session_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_agent_id    ON nodes(agent_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_session_key ON nodes(session_key);
    CREATE INDEX IF NOT EXISTS idx_nodes_type        ON nodes(type);
    CREATE INDEX IF NOT EXISTS idx_nodes_ts          ON nodes(ts);

    CREATE TABLE IF NOT EXISTS edges (
      id          TEXT PRIMARY KEY,
      src         TEXT NOT NULL,
      dst         TEXT NOT NULL,
      type        TEXT NOT NULL,
      weight      REAL NOT NULL DEFAULT 1.0,
      properties  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_edges_src      ON edges(src);
    CREATE INDEX IF NOT EXISTS idx_edges_dst      ON edges(dst);
    CREATE INDEX IF NOT EXISTS idx_edges_type     ON edges(type);
    CREATE INDEX IF NOT EXISTS idx_edges_src_type ON edges(src, type);

    -- Ingestion tracking: which session files have been processed and up to
    -- what byte offset. Allows incremental re-ingestion without re-reading
    -- everything from scratch.
    CREATE TABLE IF NOT EXISTS ingest_state (
      session_file  TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      session_key   TEXT,
      bytes_read    INTEGER NOT NULL DEFAULT 0,
      node_count    INTEGER NOT NULL DEFAULT 0,
      last_ingested INTEGER NOT NULL DEFAULT 0  -- unix ms
    );

    CREATE INDEX IF NOT EXISTS idx_ingest_agent ON ingest_state(agent_id);
  `);
}

/** Upsert a node (idempotent — safe to call on re-ingest). */
export function upsertNode(db: Database.Database, node: GraphNode): void {
  db.prepare(`
    INSERT OR REPLACE INTO nodes
      (id, type, agent_id, session_id, session_key, role, ts, content_text, content_tokens, properties)
    VALUES
      (@id, @type, @agent_id, @session_id, @session_key, @role, @ts, @content_text, @content_tokens, @properties)
  `).run({
    id: node.id,
    type: node.type,
    agent_id: node.agent_id,
    session_id: node.session_id,
    session_key: node.session_key,
    role: node.role ?? null,
    ts: node.ts,
    content_text: node.content_text ?? null,
    content_tokens: node.content_tokens ?? null,
    properties: node.properties ?? null,
  });
}

/** Insert an edge (ignore if already exists). */
export function insertEdge(db: Database.Database, edge: GraphEdge): void {
  db.prepare(`
    INSERT OR IGNORE INTO edges (id, src, dst, type, weight, properties)
    VALUES (@id, @src, @dst, @type, @weight, @properties)
  `).run({
    id: edge.id,
    src: edge.src,
    dst: edge.dst,
    type: edge.type,
    weight: edge.weight,
    properties: edge.properties ?? null,
  });
}

/** Stats for the API / UI. */
export function graphStats(db: Database.Database): {
  nodeCount: number;
  edgeCount: number;
  sessionCount: number;
  agentCounts: Record<string, number>;
  typeCounts: Record<string, number>;
  edgeTypeCounts: Record<string, number>;
} {
  const nodeCount = (db.prepare("SELECT COUNT(*) as c FROM nodes").get() as { c: number }).c;
  const edgeCount = (db.prepare("SELECT COUNT(*) as c FROM edges").get() as { c: number }).c;
  const sessionCount = (
    db.prepare("SELECT COUNT(DISTINCT session_id) as c FROM nodes").get() as { c: number }
  ).c;

  const agentRows = db
    .prepare("SELECT agent_id, COUNT(*) as c FROM nodes GROUP BY agent_id")
    .all() as { agent_id: string; c: number }[];
  const agentCounts: Record<string, number> = {};
  for (const r of agentRows) agentCounts[r.agent_id] = r.c;

  const typeRows = db
    .prepare("SELECT type, COUNT(*) as c FROM nodes GROUP BY type")
    .all() as { type: string; c: number }[];
  const typeCounts: Record<string, number> = {};
  for (const r of typeRows) typeCounts[r.type] = r.c;

  const edgeTypeRows = db
    .prepare("SELECT type, COUNT(*) as c FROM edges GROUP BY type")
    .all() as { type: string; c: number }[];
  const edgeTypeCounts: Record<string, number> = {};
  for (const r of edgeTypeRows) edgeTypeCounts[r.type] = r.c;

  return { nodeCount, edgeCount, sessionCount, agentCounts, typeCounts, edgeTypeCounts };
}

/** Fetch nodes for a session (ordered by ts). */
export function sessionNodes(db: Database.Database, sessionId: string): GraphNode[] {
  return db
    .prepare("SELECT * FROM nodes WHERE session_id = ? ORDER BY ts ASC")
    .all(sessionId) as GraphNode[];
}

/** Fetch all edges where src or dst is in a set of node ids. */
export function edgesForNodes(db: Database.Database, nodeIds: string[]): GraphEdge[] {
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM edges WHERE src IN (${placeholders}) OR dst IN (${placeholders})`,
    )
    .all(...nodeIds, ...nodeIds) as GraphEdge[];
}

/**
 * Fetch a neighbourhood subgraph: all nodes reachable from a root session
 * within maxHops hops, limited to maxNodes total. Returns nodes + edges.
 * Used by the visualizer to render a focused subgraph.
 */
export function neighbourhood(
  db: Database.Database,
  rootSessionId: string,
  maxNodes = 200,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  // Start from all nodes in the root session, then expand via edges
  const rootNodes = sessionNodes(db, rootSessionId);
  const visited = new Set(rootNodes.map((n) => n.id));
  const allNodes: GraphNode[] = [...rootNodes];

  // One hop outward via all edge types — enough for the visualizer
  if (rootNodes.length > 0) {
    const edges = edgesForNodes(db, rootNodes.map((n) => n.id));
    const neighborIds = new Set<string>();
    for (const e of edges) {
      if (!visited.has(e.src)) neighborIds.add(e.src);
      if (!visited.has(e.dst)) neighborIds.add(e.dst);
    }
    if (neighborIds.size > 0) {
      const placeholders = [...neighborIds].map(() => "?").join(",");
      const neighbors = db
        .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders}) AND type NOT IN ('root','agent','session_type','ref_files') LIMIT ?`)
        .all(...neighborIds, maxNodes - allNodes.length) as GraphNode[];
      for (const n of neighbors) {
        visited.add(n.id);
        allNodes.push(n);
      }
    }
  }

  const finalNodeIds = allNodes.map((n) => n.id);
  const finalNodeSet = new Set(finalNodeIds);
  const allEdges = edgesForNodes(db, finalNodeIds);

  // Only keep edges where BOTH src and dst are present in the node set.
  // ELK will crash if an edge references a node that doesn't exist in the layout.
  // This can happen when: (a) the node count cap truncated some neighbors, or
  // (b) virtual "agent:", "channel:", "peer:", "session_key:" dst values have no node row.
  const edges = allEdges.filter(e => finalNodeSet.has(e.src) && finalNodeSet.has(e.dst));

  return { nodes: allNodes, edges };
}

/** List recent sessions (session nodes), most recent first. */
export function recentSessions(
  db: Database.Database,
  limit = 50,
  agentId?: string,
  includeHeartbeats = true,
): GraphNode[] {
  limit = Math.min(limit, MAX_SESSION_LIST);
  const heartbeatFilter = includeHeartbeats
    ? ""
    : "AND (properties IS NULL OR json_extract(properties,'$.kind') IS NOT 'heartbeat')";

  if (agentId) {
    return db
      .prepare(
        `SELECT * FROM nodes WHERE type='session' AND agent_id=? ${heartbeatFilter} ORDER BY ts DESC LIMIT ?`,
      )
      .all(agentId, limit) as GraphNode[];
  }
  return db
    .prepare(`SELECT * FROM nodes WHERE type='session' ${heartbeatFilter} ORDER BY ts DESC LIMIT ?`)
    .all(limit) as GraphNode[];
}

/**
 * Return the hierarchy skeleton: root → agent → session_type → ref_files only.
 * Session nodes are NOT included — they are loaded on demand via refFilesSessionNodes().
 *
 * By default, nodes tagged with properties.display="hidden" are excluded.
 * Pass includeHidden=true for admin/debug views.
 */
export function hierarchyGraph(
  db: Database.Database,
  includeHidden = false,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  let structuralNodes: GraphNode[];

  if (includeHidden) {
    structuralNodes = db.prepare(
      "SELECT * FROM nodes WHERE type IN ('root','agent','session_type','ref_files')"
    ).all() as GraphNode[];
  } else {
    structuralNodes = db.prepare(`
      SELECT * FROM nodes
      WHERE type IN ('root','agent','session_type','ref_files')
        AND (properties IS NULL OR json_extract(properties,'$.display') IS NOT 'hidden')
    `).all() as GraphNode[];
  }

  const nodeIds = new Set(structuralNodes.map((n) => n.id));

  const allEdges = db.prepare(
    "SELECT * FROM edges WHERE type='contains'"
  ).all() as GraphEdge[];
  // Only keep edges that connect nodes within our skeleton set
  const edges = allEdges.filter(e => nodeIds.has(e.src) && nodeIds.has(e.dst));

  return { nodes: structuralNodes, edges };
}

/**
 * Return the session nodes (and their contains edges from the ref_files parent)
 * for a single ref_files node, for on-demand expansion in the hierarchy view.
 *
 * Excludes sessions tagged display=hidden unless includeHidden is true.
 */
export function refFilesSessionNodes(
  db: Database.Database,
  refFilesId: string,
  includeHidden = false,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  // Find all session node IDs that are children of this ref_files node
  const childEdges = db.prepare(
    "SELECT * FROM edges WHERE type='contains' AND src=?"
  ).all(refFilesId) as GraphEdge[];

  if (childEdges.length === 0) return { nodes: [], edges: [] };

  const sessionIds = childEdges.map(e => e.dst);
  const placeholders = sessionIds.map(() => "?").join(",");

  let sessionNodes: GraphNode[];
  if (includeHidden) {
    sessionNodes = db.prepare(
      `SELECT * FROM nodes WHERE id IN (${placeholders}) AND type='session' ORDER BY ts DESC LIMIT ?`
    ).all(...sessionIds, MAX_SESSION_LIST) as GraphNode[];
  } else {
    sessionNodes = db.prepare(`
      SELECT * FROM nodes
      WHERE id IN (${placeholders}) AND type='session'
        AND (properties IS NULL OR json_extract(properties,'$.display') IS NOT 'hidden')
      ORDER BY ts DESC
      LIMIT ?
    `).all(...sessionIds, MAX_SESSION_LIST) as GraphNode[];
  }

  const visibleIds = new Set(sessionNodes.map(n => n.id));
  const edges = childEdges.filter(e => visibleIds.has(e.dst));

  return { nodes: sessionNodes, edges };
}

/**
 * Migrate the virtual hierarchy to the current schema.
 *
 * Safe to call before every full ingest. Idempotent.
 *
 * What it does:
 * 1. Wipes all virtual structural nodes (root, agent, session_type, ref_files)
 *    and their edges — these are 100% derived from session data and will be
 *    rebuilt by buildVirtualHierarchy().
 * 2. Re-classifies all existing session nodes' sessionType property using the
 *    transport segment of their session_key via a single SQL UPDATE (fast).
 *
 * This is a no-op on a fresh DB (no virtual nodes to wipe, no sessions to
 * reclassify). On an existing DB it corrects any schema drift from old code.
 */
export function migrateVirtualHierarchy(db: Database.Database): { wipedNodes: number; reclassified: number } {
  // Step 1: wipe all virtual structural nodes and their edges
  let wipedNodes = 0;
  for (const type of ["root", "agent", "session_type", "ref_files"] as const) {
    const nodes = db.prepare(`SELECT id FROM nodes WHERE type = '${type}'`).all() as { id: string }[];
    db.transaction(() => {
      const delNode = db.prepare("DELETE FROM nodes WHERE id = ?");
      const delSrc  = db.prepare("DELETE FROM edges WHERE src = ?");
      const delDst  = db.prepare("DELETE FROM edges WHERE dst = ?");
      for (const { id } of nodes) {
        delSrc.run(id);
        delDst.run(id);
        delNode.run(id);
        wipedNodes++;
      }
    })();
  }

  // Step 2: reclassify session nodes — derive sessionType from session_key transport segment
  const result = db.prepare(`
    UPDATE nodes SET properties = json_set(
      COALESCE(properties, '{}'),
      '$.sessionType',
      CASE
        WHEN session_key LIKE '%:heartbeat%'    THEN 'heartbeat'
        WHEN session_key LIKE '%:cron:%'        THEN 'cron'
        WHEN session_key LIKE '%:subagent:%'    THEN 'subagent'
        WHEN session_key LIKE 'agent:%:slack:%'    THEN 'slack'
        WHEN session_key LIKE 'agent:%:discord:%'  THEN 'discord'
        WHEN session_key LIKE 'agent:%:direct:%'   THEN 'direct'
        WHEN session_key LIKE 'agent:%:unknown:%'
          AND json_extract(properties, '$.devInstructionsFingerprint') IS NOT NULL
          THEN 'direct'
        ELSE 'unknown'
      END
    )
    WHERE type = 'session'
  `).run();

  return { wipedNodes, reclassified: result.changes };
}

/**
 * Mark near-duplicate and near-empty hierarchy nodes with display="hidden" so
 * they are omitted from the hierarchy view without destroying the data.
 *
 * Rules (all non-destructive — data stays, only properties.display changes):
 *
 * 1. Heartbeat sessions — already tagged kind=heartbeat. Mark display=hidden.
 *
 * 2. Duplicate ref_files nodes — within each (agent_id, session_type) pair,
 *    keep the ref_files node with the most sessions attached; mark the rest hidden.
 *    "default" fingerprint nodes (no real fingerprint) are always the least-preferred.
 *
 * 3. Near-empty session_type nodes — session_type nodes whose only attached sessions
 *    are all hidden after rules 1+2. Mark them hidden too.
 *
 * 4. session_type nodes with zero visible sessions after pruning — same, mark hidden.
 *
 * Returns counts of nodes updated per category.
 */
export function markDuplicateNodes(db: Database.Database): {
  heartbeatSessionsHidden: number;
  duplicateRefFilesHidden: number;
  emptySessionTypesHidden: number;
} {
  const setHidden = db.prepare(
    "UPDATE nodes SET properties = json_set(COALESCE(properties,'{}'), '$.display', 'hidden') WHERE id = ?"
  );

  db.transaction(() => {
    // First, clear all existing display=hidden flags so we recompute from scratch.
    // This makes the function idempotent and corrects any drift.
    db.prepare(`
      UPDATE nodes SET properties = json_remove(COALESCE(properties,'{}'), '$.display')
      WHERE type IN ('session','ref_files','session_type','agent')
        AND json_extract(properties,'$.display') = 'hidden'
    `).run();
  })();

  // --- Rule 1: heartbeat sessions ---
  const heartbeatSessions = db.prepare(`
    SELECT id FROM nodes
    WHERE type = 'session'
      AND json_extract(properties,'$.kind') = 'heartbeat'
  `).all() as { id: string }[];

  db.transaction(() => {
    for (const { id } of heartbeatSessions) setHidden.run(id);
  })();

  // --- Rule 2: hide ref_files nodes for session types that are always hidden ---
  // With the new scheme (one ref_files per agent+session_type), there are no duplicates
  // to collapse. Instead, hide the ref_files nodes for heartbeat/cron session types,
  // since all their sessions will be hidden anyway.
  const ALWAYS_HIDDEN_TYPES = ["heartbeat", "cron"];
  const hiddenRefFilesIds: string[] = [];
  db.transaction(() => {
    for (const sessionType of ALWAYS_HIDDEN_TYPES) {
      const nodes = db.prepare(
        `SELECT id FROM nodes WHERE type = 'ref_files' AND id LIKE 'ref_files:%:${sessionType}'`
      ).all() as { id: string }[];
      for (const { id } of nodes) {
        setHidden.run(id);
        hiddenRefFilesIds.push(id);
      }
    }
  })();
  const duplicateRefFilesHidden = hiddenRefFilesIds.length;

  // --- Rule 3: hide session_type nodes for always-hidden session types ---
  // Heartbeat and cron session_type nodes are never useful in the hierarchy view.
  // Other session_types (slack, discord, direct, subagent, unknown) are kept visible
  // even if they currently have few sessions — they represent real interaction channels.
  let emptySessionTypesHidden = 0;
  db.transaction(() => {
    for (const sessionType of ALWAYS_HIDDEN_TYPES) {
      const nodes = db.prepare(
        `SELECT id FROM nodes WHERE type = 'session_type' AND id LIKE 'session_type:%:${sessionType}'`
      ).all() as { id: string }[];
      for (const { id } of nodes) {
        setHidden.run(id);
        emptySessionTypesHidden++;
      }
    }
  })();

  return {
    heartbeatSessionsHidden: heartbeatSessions.length,
    duplicateRefFilesHidden,
    emptySessionTypesHidden,
  };
}

/**
 * Returns true if a session's first message content indicates it is a heartbeat.
 * Handles: bare HEARTBEAT_OK, backtick/quote-wrapped variants, and Tabitha-style summaries.
 */
export function isHeartbeatFirstMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const stripped = text.trim().replace(/^[`"']+|[`"']+$/g, "").trim();
  if (stripped.toUpperCase() === "HEARTBEAT_OK") return true;
  if (stripped.startsWith("✓ Heartbeat") || stripped.startsWith("✓ **Heartbeat")) return true;
  if (/^heartbeat (complete|ok|done)/i.test(stripped)) return true;
  if (/^read heartbeat\.md/i.test(stripped)) return true;
  return false;
}

/**
 * Classify existing session nodes in the DB as heartbeats without re-ingesting.
 * Checks: (1) session_key contains ":heartbeat", (2) first message content is "HEARTBEAT_OK".
 *
 * Uses a single SQL query (JOIN + aggregation) rather than per-row nested lookups,
 * so the write transaction is brief and does not block the event loop for long.
 *
 * Returns count of sessions updated.
 */
export function classifyHeartbeats(db: Database.Database): number {
  type SessionRow = { id: string; session_id: string; session_key: string; properties: string | null };

  // Pass 1: session_key signals:
  //   - ":heartbeat" suffix
  //   - "unknown:"    (no real channel — dreams, nightly runs, subagent work)
  //   - ":cron:"      (scheduled automated sessions)
  const byKey = db.prepare(`
    SELECT id, session_id, session_key, properties FROM nodes
    WHERE type = 'session'
      AND (properties IS NULL OR json_extract(properties, '$.kind') IS NULL)
      AND (
        instr(session_key, ':heartbeat') > 0
        OR instr(session_key, 'unknown:') > 0
        OR instr(session_key, ':cron:') > 0
      )
  `).all() as SessionRow[];

  // Pass 2: sessions whose first message content is "HEARTBEAT_OK".
  // Pre-aggregate min(ts) per session once, then look up individual messages —
  // avoids correlated subqueries that stall on large DBs.
  const firstMsgs = db.prepare(
    "SELECT session_id, MIN(ts) as min_ts FROM nodes WHERE type = 'message' GROUP BY session_id"
  ).all() as { session_id: string; min_ts: number }[];

  const byKeyIds = new Set(byKey.map((s) => s.session_id));
  const getMsg = db.prepare(
    "SELECT content_text FROM nodes WHERE session_id = ? AND type = 'message' AND ts = ? LIMIT 1"
  );
  const heartbeatSids = new Set<string>();
  for (const row of firstMsgs) {
    if (byKeyIds.has(row.session_id)) continue;
    const msg = getMsg.get(row.session_id, row.min_ts) as { content_text: string | null } | undefined;
    if (isHeartbeatFirstMessage(msg?.content_text)) heartbeatSids.add(row.session_id);
  }

  const byContentIds = [...heartbeatSids];
  const CHUNK = 900;
  const byContent: SessionRow[] = [];
  for (let i = 0; i < byContentIds.length; i += CHUNK) {
    const chunk = byContentIds.slice(i, i + CHUNK);
    const rows = db.prepare(`
      SELECT id, session_id, session_key, properties FROM nodes
      WHERE type = 'session'
        AND session_id IN (${chunk.map(() => "?").join(",")})
        AND (properties IS NULL OR json_extract(properties, '$.kind') IS NULL)
    `).all(...chunk) as SessionRow[];
    byContent.push(...rows);
  }

  const candidates = [...byKey, ...byContent];
  if (candidates.length === 0) return 0;

  const update = db.prepare("UPDATE nodes SET properties = ? WHERE id = ?");
  const run = db.transaction(() => {
    for (const s of candidates) {
      let props: Record<string, unknown> = {};
      try { props = s.properties ? JSON.parse(s.properties) : {}; } catch { /* ignore */ }
      props.kind = "heartbeat";
      update.run(JSON.stringify(props), s.id);
    }
  });

  run();
  return candidates.length;
}

/**
 * Retroactively fix false-positive heartbeat sessions from before the fix that
 * removed the "unknown:" key-substring heuristic from ingest's isHeartbeatByKey.
 * That heuristic used to mark ANY session whose session_key resolution failed
 * (falling back to "agent:<id>:unknown:<sessionId>") as a heartbeat, hiding real
 * Slack/Discord DMs and direct requests whose channel just couldn't be resolved.
 *
 * Re-evaluates every session tagged kind=heartbeat whose session_key does NOT
 * genuinely route through ":heartbeat" or ":cron:" (i.e. was only caught by the
 * removed key heuristic) against its actual first-message content. Sessions that
 * still look like a real heartbeat by content keep kind=heartbeat; everything
 * else gets the kind flag cleared so it's no longer hidden by markDuplicateNodes.
 *
 * Idempotent — safe to call on every ingest/migrate.
 */
export function reclassifyUnknownHeartbeats(db: Database.Database): { reevaluated: number; cleared: number } {
  const candidates = db.prepare(`
    SELECT id, session_id FROM nodes
    WHERE type = 'session'
      AND json_extract(properties, '$.kind') = 'heartbeat'
      AND session_key NOT LIKE '%:heartbeat%'
      AND session_key NOT LIKE '%:cron:%'
  `).all() as { id: string; session_id: string }[];

  if (candidates.length === 0) return { reevaluated: 0, cleared: 0 };

  const firstTsBySession = new Map<string, number>(
    (db.prepare("SELECT session_id, MIN(ts) as min_ts FROM nodes WHERE type = 'message' GROUP BY session_id")
      .all() as { session_id: string; min_ts: number }[])
      .map((r) => [r.session_id, r.min_ts])
  );
  const getMsg = db.prepare(
    "SELECT content_text FROM nodes WHERE session_id = ? AND type = 'message' AND ts = ? AND role IS NOT NULL AND role != 'toolResult' LIMIT 1"
  );
  const clearKind = db.prepare("UPDATE nodes SET properties = json_remove(properties, '$.kind') WHERE id = ?");

  let cleared = 0;
  const run = db.transaction(() => {
    for (const c of candidates) {
      const minTs = firstTsBySession.get(c.session_id);
      const msg = minTs !== undefined
        ? getMsg.get(c.session_id, minTs) as { content_text: string | null } | undefined
        : undefined;
      if (!isHeartbeatFirstMessage(msg?.content_text)) {
        clearKind.run(c.id);
        cleared++;
      }
    }
  });
  run();

  return { reevaluated: candidates.length, cleared };
}
