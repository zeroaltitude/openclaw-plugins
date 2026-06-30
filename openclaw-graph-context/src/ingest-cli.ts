/**
 * CLI entry point for one-shot full ingestion.
 * Usage: node dist/ingest-cli.js [--db <path>] [--agents-dir <path>] [--agent <id>]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { initSchema, openDb, graphStats, resolveDbPath } from "./db.js";
import { ingestAll } from "./ingest.js";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

const dbPath = resolveDbPath(flag("--db"));
const agentsDir = (flag("--agents-dir") ?? join(homedir(), ".openclaw", "agents")).replace("~", homedir());
const agentId = flag("--agent");

console.log(`[graph-context] Opening DB: ${dbPath}`);
const db = openDb(dbPath);
initSchema(db);

const statsBefore = graphStats(db);
console.log(`[graph-context] Before: nodes=${statsBefore.nodeCount} edges=${statsBefore.edgeCount}`);

console.log(`[graph-context] Starting ingestion from: ${agentsDir}`);
const t0 = Date.now();

const results = await ingestAll(db, {
  agentsDir,
  agentId,
  onProgress: (msg) => console.log(msg),
});

const elapsed = Date.now() - t0;
const statsAfter = graphStats(db);

console.log("\n=== Ingestion complete ===");
console.log(`Elapsed: ${elapsed}ms`);
console.log(`After: nodes=${statsAfter.nodeCount} edges=${statsAfter.edgeCount} sessions=${statsAfter.sessionCount}`);
console.log("Agent counts:", statsAfter.agentCounts);
console.log("Node types:", statsAfter.typeCounts);
console.log("Edge types:", statsAfter.edgeTypeCounts);

for (const [agent, r] of Object.entries(results)) {
  if (r.errors.length > 0) {
    console.warn(`\nErrors for ${agent}:`);
    for (const e of r.errors.slice(0, 10)) console.warn("  ", e);
  }
}

db.close();
