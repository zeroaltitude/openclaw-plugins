import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  createDeltaSamplerForTest,
  createEvidenceSampler,
  hasPositiveEvidence,
  parsePsCpuTime,
  type ProcRow,
} from "../src/process-evidence.js";

describe("hasPositiveEvidence", () => {
  it("counts CPU, IO, or tree churn as evidence; stillness as none", () => {
    const base = { childAlive: true, cpuMsDelta: 0, ioBytesDelta: 0 as number | null, descendantCount: 1, descendantChurn: false };
    expect(hasPositiveEvidence({ ...base })).toBe(false);
    expect(hasPositiveEvidence({ ...base, cpuMsDelta: 10 })).toBe(true);
    expect(hasPositiveEvidence({ ...base, ioBytesDelta: 4096 })).toBe(true);
    expect(hasPositiveEvidence({ ...base, descendantChurn: true })).toBe(true);
    // Platform without IO visibility (macOS): null IO is not evidence by itself.
    expect(hasPositiveEvidence({ ...base, ioBytesDelta: null })).toBe(false);
  });
});

describe("parsePsCpuTime", () => {
  it("handles macOS mm:ss.cc, hh:mm:ss, and dd-hh:mm:ss", () => {
    expect(parsePsCpuTime("0:00.05")).toBe(50);
    expect(parsePsCpuTime("1:02.50")).toBe(62500);
    expect(parsePsCpuTime("01:02:03")).toBe(3723000);
    expect(parsePsCpuTime("2-01:00:00")).toBe(2 * 86400000 + 3600000);
    expect(parsePsCpuTime("garbage")).toBe(0);
  });
});

describe("delta sampler over a scripted process table", () => {
  const row = (pid: number, ppid: number, cpuMs: number, extra: Partial<ProcRow> = {}): ProcRow => ({
    pid,
    ppid,
    zombie: false,
    cpuMs,
    ioBytes: null,
    ...extra,
  });

  it("computes tree-scoped CPU deltas and churn across ticks", async () => {
    const tables: ProcRow[][] = [
      [row(10, 1, 100), row(20, 1, 500), row(21, 20, 50)], // rootPid=1: whole table minus root
      [row(10, 1, 100), row(20, 1, 700), row(21, 20, 90)], // +240ms across the tree
      [row(10, 1, 100), row(20, 1, 700)], // 21 exited → churn, zero cpu delta... (700+100 vs 890 clamps to 0)
    ];
    let tick = 0;
    const sampler = createDeltaSamplerForTest(1, () => Promise.resolve(tables[Math.min(tick++, tables.length - 1)]!));

    const first = await sampler.sample(); // baseline
    expect(first.childAlive).toBe(true);
    expect(first.cpuMsDelta).toBe(0);
    expect(first.descendantChurn).toBe(false);

    const second = await sampler.sample();
    expect(second.cpuMsDelta).toBe(240);
    expect(hasPositiveEvidence(second)).toBe(true);

    const third = await sampler.sample();
    expect(third.cpuMsDelta).toBe(0); // clamped (counter loss on exit)
    expect(third.descendantChurn).toBe(true); // the exit IS the evidence
    expect(hasPositiveEvidence(third)).toBe(true);
  });

  it("only counts the tree under the root, and zombies don't count as alive", async () => {
    const table = [
      row(30, 999, 1_000_000), // unrelated process — not our tree
      row(40, 1, 0, { zombie: true }),
    ];
    const sampler = createDeltaSamplerForTest(1, () => Promise.resolve(table));
    const first = await sampler.sample();
    expect(first.childAlive).toBe(false); // only descendant is a zombie
    expect(first.descendantCount).toBe(0);
    const second = await sampler.sample();
    expect(second.cpuMsDelta).toBe(0); // pid 30's million ms never entered the tree
  });

  it("reports neutral evidence when enumeration fails (never kills healthy vouching)", async () => {
    const sampler = createDeltaSamplerForTest(1, () => Promise.reject(new Error("ps exploded")));
    const result = await sampler.sample();
    expect(result.childAlive).toBe(true);
    expect(hasPositiveEvidence(result)).toBe(false);
  });
});

describe("real platform sampler (integration)", () => {
  it("detects a real busy child's CPU and its exit as churn", async () => {
    // Busy child: burn CPU for ~1.5s.
    const child = spawn(process.execPath, ["-e", "const end = Date.now() + 1500; while (Date.now() < end) {}"], {
      stdio: "ignore",
    });
    const sampler = createEvidenceSampler(process.pid);
    try {
      await sampler.sample(); // baseline
      await new Promise((resolve) => setTimeout(resolve, 700));
      const busy = await sampler.sample();
      expect(busy.childAlive).toBe(true);
      expect(busy.descendantCount).toBeGreaterThanOrEqual(1);
      expect(hasPositiveEvidence(busy)).toBe(true); // CPU delta from the spin loop
    } finally {
      child.kill("SIGKILL");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await sampler.sample();
    expect(after.descendantChurn).toBe(true); // the exit registered
  }, 15_000);
});
