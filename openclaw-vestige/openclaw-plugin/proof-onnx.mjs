// Proof for openclaw-npk1: importing the vestige hooks barrel must not start
// ONNX Runtime's thread pool. process.moduleLoadList does NOT observe napi
// addons, so thread count is the discriminating probe.
import fs from 'node:fs';
const threads = () => fs.readdirSync('/proc/self/task').length;
const before = threads();
await import("./dist/hooks/index.js");
await new Promise(r => setTimeout(r, 1500));
const after = threads();
const delta = after - before;
console.log(`threads before=${before} after=${after} delta=${delta}`);
console.log(delta > 0 ? `FAIL: hooks import started ${delta} thread(s)` : "PASS: no threads started");
process.exit(delta > 0 ? 1 : 0);
