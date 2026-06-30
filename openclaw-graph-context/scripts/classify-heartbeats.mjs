#!/usr/bin/env node
/**
 * Standalone heartbeat classifier.
 *
 * Opens graph-context.db with a generous busy_timeout so it waits gracefully
 * if the gateway is holding a write lock, then runs a single-query classify
 * pass without blocking the gateway event loop.
 *
 * Usage:
 *   node scripts/classify-heartbeats.mjs [--db /path/to/graph-context.db]
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const { values } = parseArgs({
  options: { db: { type: "string" } },
  strict: false,
});

const rawDb = values.db ?? `${homedir()}/.openclaw/graph-context.db`;
const dbPath = rawDb.startsWith("~/") ? rawDb.replace("~", homedir()) : rawDb;

console.log(`Opening DB: ${dbPath}`);
const db = new Database(dbPath);

// Wait up to 30s if gateway holds a write lock — WAL allows concurrent readers,
// so reads are instant; the busy timeout only kicks in during our write transaction.
db.pragma("busy_timeout = 30000");
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

// Two-pass approach: avoid correlated subqueries on a large DB.
// Pass 1: classify by session_key (instant index scan).
// Pass 2: find sessions whose *first* message is HEARTBEAT_OK via a pre-aggregated join.

console.log("Pass 1: classifying by session_key…");
const byKey = db.prepare(`
  SELECT id, session_id, session_key, properties
  FROM nodes
  WHERE type = 'session'
    AND (properties IS NULL OR json_extract(properties, '$.kind') IS NULL)
    AND (
      instr(session_key, ':heartbeat') > 0
      OR instr(session_key, 'unknown:') > 0
      OR instr(session_key, ':cron:') > 0
    )
`).all();
console.log(`  Found ${byKey.length} by session_key.`);

console.log("Pass 2: computing first-message content per session…");
// Materialize first message per session once, then filter for HEARTBEAT_OK.
const firstMsgs = db.prepare(`
  SELECT session_id, MIN(ts) as min_ts
  FROM nodes
  WHERE type = 'message'
  GROUP BY session_id
`).all();

// Build a Set of session_ids whose earliest message indicates a heartbeat.
// Matches: HEARTBEAT_OK (bare, backtick-quoted, double-quoted, or any combo),
// and Tabitha-style "✓ Heartbeat complete" summary messages.
function isHeartbeatContent(text) {
  if (!text) return false;
  const stripped = text.trim().replace(/^[`"']+|[`"']+$/g, "").trim();
  if (stripped === "HEARTBEAT_OK") return true;
  if (stripped.toUpperCase() === "HEARTBEAT_OK") return true;
  // Tabitha-style summaries
  if (stripped.startsWith("✓ Heartbeat") || stripped.startsWith("✓ **Heartbeat")) return true;
  if (/^heartbeat (complete|ok|done)/i.test(stripped)) return true;
  return false;
}

const heartbeatSessionIds = new Set();
const getMsg = db.prepare(`
  SELECT content_text FROM nodes
  WHERE session_id = ? AND type = 'message' AND ts = ?
  LIMIT 1
`);
console.log(`  Checking ${firstMsgs.length} sessions' first messages…`);
let checked = 0;
for (const row of firstMsgs) {
  const msg = getMsg.get(row.session_id, row.min_ts);
  if (isHeartbeatContent(msg?.content_text)) {
    heartbeatSessionIds.add(row.session_id);
  }
  checked++;
  if (checked % 5000 === 0) console.log(`  … ${checked}/${firstMsgs.length}`);
}
console.log(`  Found ${heartbeatSessionIds.size} by first-message content.`);

// Get the session nodes for content-detected sessions that aren't already tagged.
// SQLite has a 999-variable limit on IN (?,...), so chunk the lookups.
const byKeyIds = new Set(byKey.map(s => s.session_id));
const byContentIds = [...heartbeatSessionIds].filter(sid => !byKeyIds.has(sid));

const CHUNK = 900;
const byContent = [];
for (let i = 0; i < byContentIds.length; i += CHUNK) {
  const chunk = byContentIds.slice(i, i + CHUNK);
  const rows = db.prepare(`
    SELECT id, session_id, session_key, properties
    FROM nodes
    WHERE type = 'session'
      AND session_id IN (${chunk.map(() => "?").join(",")})
      AND (properties IS NULL OR json_extract(properties, '$.kind') IS NULL)
  `).all(...chunk);
  byContent.push(...rows);
}

const candidates = [...byKey, ...byContent];
console.log(`Total candidates to update: ${candidates.length}`);

console.log(`Found ${candidates.length} unclassified heartbeat sessions.`);

if (candidates.length === 0) {
  console.log("Nothing to update.");
  db.close();
  process.exit(0);
}

// Brief write transaction — only touches the candidate rows.
const update = db.prepare("UPDATE nodes SET properties = ? WHERE id = ?");
const run = db.transaction(() => {
  for (const s of candidates) {
    let props = {};
    try { props = s.properties ? JSON.parse(s.properties) : {}; } catch {}
    props.kind = "heartbeat";
    update.run(JSON.stringify(props), s.id);
  }
});

console.log("Writing classifications…");
run();

// Checkpoint WAL so gateway picks up the changes.
db.pragma("wal_checkpoint(PASSIVE)");
db.close();

console.log(`Done. ${candidates.length} sessions marked as heartbeat.`);
