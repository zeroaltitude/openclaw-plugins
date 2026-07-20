/**
 * Cross-platform positive-evidence sampler for the native-tool activity
 * emitter (turn-runner.ts). Having made the bridge the liveness authority —
 * consumers translate its `toolActivity` notifications into watchdog progress
 * touches — the bridge is obligated to verify the thing it vouches for, not
 * vouch on a timer. This module gathers the evidence.
 *
 * Design: ONE platform-agnostic policy (see hasPositiveEvidence + the
 * emitter's grace-tick logic) over ONE sensor interface with three thin
 * implementations, selected once by process.platform:
 *
 *   linux  — /proc walk: full evidence (CPU + IO + tree + zombie), ~1ms.
 *   darwin — POSIX `ps -eo pid=,ppid=,state=,time=`: CPU + tree + zombie;
 *            per-process IO is not readable without elevated tooling, so
 *            ioBytesDelta is null (disk-bound CPU-quiet work on macOS relies
 *            on tree churn / the grace window).
 *   win32  — PowerShell CIM Win32_Process: CPU + IO + tree.
 *
 * The tree is rooted at THIS process (the bridge): the `claude` CLI is our
 * direct child and the tool's real work (Bash's command, its compilers/git)
 * runs as grandchildren — so enumerating by parent-chain from our own pid
 * needs no SDK pid exposure and credits the whole tree's work as evidence.
 *
 * Deliberately dependency-free: this process forwards Anthropic credentials,
 * and instantaneous-%cpu snapshot libraries measure the wrong thing anyway —
 * the policy wants cumulative-time DELTAS between ticks.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export type ProcessEvidence = {
  /** At least one live (non-zombie) descendant process exists. */
  childAlive: boolean;
  /** Milliseconds of CPU time the tree consumed since the previous sample. */
  cpuMsDelta: number;
  /** Bytes read+written by the tree since the previous sample; null when the platform can't measure it. */
  ioBytesDelta: number | null;
  /** Live descendant count this sample. */
  descendantCount: number;
  /** The descendant pid set changed since the previous sample (spawn/exit churn). */
  descendantChurn: boolean;
};

export type EvidenceSampler = {
  sample(): Promise<ProcessEvidence>;
};

/** The platform-agnostic policy predicate: does this sample prove work happened? */
export function hasPositiveEvidence(e: ProcessEvidence): boolean {
  return e.cpuMsDelta > 0 || (e.ioBytesDelta ?? 0) > 0 || e.descendantChurn;
}

export type ProcRow = {
  pid: number;
  ppid: number;
  zombie: boolean;
  cpuMs: number;
  ioBytes: number | null;
};

/** Shared delta bookkeeping over per-platform row enumeration. */
function createDeltaSampler(rootPid: number, enumerate: () => Promise<ProcRow[]>): EvidenceSampler {
  let lastCpuMs: number | undefined;
  let lastIoBytes: number | undefined;
  let lastPids: Set<number> | undefined;
  let inFlight = false;

  return {
    async sample(): Promise<ProcessEvidence> {
      // Never stack samples: a slow helper (Windows CIM) must not pile up.
      if (inFlight) {
        return { childAlive: true, cpuMsDelta: 0, ioBytesDelta: null, descendantCount: 0, descendantChurn: false };
      }
      inFlight = true;
      try {
        const rows = await enumerate();
        // Build the descendant closure of rootPid (excluding rootPid itself).
        const children = new Map<number, ProcRow[]>();
        for (const row of rows) {
          const siblings = children.get(row.ppid);
          if (siblings) {
            siblings.push(row);
          } else {
            children.set(row.ppid, [row]);
          }
        }
        const tree: ProcRow[] = [];
        const queue = [rootPid];
        while (queue.length > 0) {
          const parent = queue.shift()!;
          for (const row of children.get(parent) ?? []) {
            tree.push(row);
            queue.push(row.pid);
          }
        }

        const live = tree.filter((row) => !row.zombie);
        const cpuMs = tree.reduce((sum, row) => sum + row.cpuMs, 0);
        const ioKnown = tree.some((row) => row.ioBytes !== null);
        const ioBytes = ioKnown ? tree.reduce((sum, row) => sum + (row.ioBytes ?? 0), 0) : null;
        const pids = new Set(tree.map((row) => row.pid));

        // Cumulative counters vanish with their processes, so a raw delta can
        // go negative when a busy child exits between ticks. Clamp to 0 — the
        // exit itself registers as churn.
        const cpuMsDelta = lastCpuMs === undefined ? 0 : Math.max(0, cpuMs - lastCpuMs);
        const ioBytesDelta =
          ioBytes === null ? null : lastIoBytes === undefined ? 0 : Math.max(0, ioBytes - lastIoBytes);
        let descendantChurn = false;
        if (lastPids !== undefined) {
          const prev = lastPids;
          descendantChurn = pids.size !== prev.size || [...pids].some((pid) => !prev.has(pid));
        }

        lastCpuMs = cpuMs;
        lastIoBytes = ioBytes ?? undefined;
        lastPids = pids;

        return {
          childAlive: live.length > 0,
          cpuMsDelta,
          ioBytesDelta,
          descendantCount: live.length,
          descendantChurn,
        };
      } catch {
        // Enumeration failure must never kill a healthy tool's vouching —
        // report neutral "alive, no evidence" and let the grace window and
        // the SDK's own timeouts govern.
        return { childAlive: true, cpuMsDelta: 0, ioBytesDelta: null, descendantCount: 0, descendantChurn: false };
      } finally {
        inFlight = false;
      }
    },
  };
}

// ── linux: /proc walk ────────────────────────────────────────────────────────

const LINUX_CLOCK_TICK_MS = 10; // 1000 / sysconf(_SC_CLK_TCK); 100Hz on every mainstream kernel

function enumerateLinux(excludePid: number): Promise<ProcRow[]> {
  const rows: ProcRow[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const pid = Number(entry);
    if (pid === excludePid) {
      continue;
    }
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      // comm (field 2) may contain spaces/parens — parse around the LAST ')'.
      const close = stat.lastIndexOf(")");
      const rest = stat.slice(close + 2).split(" ");
      const state = rest[0] ?? "";
      const ppid = Number(rest[1] ?? "0");
      const utime = Number(rest[11] ?? "0");
      const stime = Number(rest[12] ?? "0");
      let ioBytes: number | null = null;
      try {
        const io = readFileSync(`/proc/${entry}/io`, "utf8");
        const read = /read_bytes:\s*(\d+)/.exec(io);
        const write = /write_bytes:\s*(\d+)/.exec(io);
        ioBytes = Number(read?.[1] ?? 0) + Number(write?.[1] ?? 0);
      } catch {
        // /proc/<pid>/io needs same-uid or CAP_SYS_PTRACE; skip quietly.
      }
      rows.push({ pid, ppid, zombie: state === "Z", cpuMs: (utime + stime) * LINUX_CLOCK_TICK_MS, ioBytes });
    } catch {
      // Process exited mid-walk — normal, skip.
    }
  }
  return Promise.resolve(rows);
}

// ── darwin (and POSIX fallback): ps ─────────────────────────────────────────

/** Parse ps TIME values: "mm:ss.cc" (macOS), "hh:mm:ss", "dd-hh:mm:ss". Exported for tests. */
export function parsePsCpuTime(value: string): number {
  let days = 0;
  let rest = value.trim();
  const dayMatch = /^(\d+)-/.exec(rest);
  if (dayMatch) {
    days = Number(dayMatch[1]);
    rest = rest.slice(dayMatch[0].length);
  }
  const parts = rest.split(":").map((part) => Number.parseFloat(part));
  if (parts.length === 0 || parts.some((part) => Number.isNaN(part))) {
    return 0;
  }
  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + part;
  }
  return Math.round((days * 86400 + seconds) * 1000);
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

async function enumeratePosixPs(excludePid: number): Promise<ProcRow[]> {
  const stdout = await execFileText("ps", ["-eo", "pid=,ppid=,state=,time="]);
  const rows: ProcRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    if (pid === excludePid) {
      continue;
    }
    rows.push({
      pid,
      ppid: Number(match[2] ?? "0"),
      zombie: (match[3] ?? "").startsWith("Z"),
      cpuMs: parsePsCpuTime(match[4] ?? "0:00"),
      ioBytes: null,
    });
  }
  return rows;
}

// ── win32: PowerShell CIM ────────────────────────────────────────────────────

const WIN_CIM_QUERY =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,ReadTransferCount,WriteTransferCount | ConvertTo-Json -Compress";

async function enumerateWindows(excludePid: number): Promise<ProcRow[]> {
  const stdout = await execFileText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_CIM_QUERY]);
  const parsed: unknown = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const rows: ProcRow[] = [];
  for (const raw of list) {
    const proc = raw as Record<string, unknown>;
    const pid = Number(proc.ProcessId ?? Number.NaN);
    if (!Number.isFinite(pid) || pid === excludePid) {
      continue;
    }
    // Kernel/UserModeTime are in 100ns units.
    const cpuMs = (Number(proc.KernelModeTime ?? 0) + Number(proc.UserModeTime ?? 0)) / 10_000;
    rows.push({
      pid,
      ppid: Number(proc.ParentProcessId ?? 0),
      zombie: false, // Windows has no zombie state; exited processes just disappear from CIM.
      cpuMs,
      ioBytes: Number(proc.ReadTransferCount ?? 0) + Number(proc.WriteTransferCount ?? 0),
    });
  }
  return rows;
}

/**
 * Creates the platform-appropriate sampler for the tree rooted at `rootPid`
 * (normally process.pid — the bridge; the claude CLI and the tool's real
 * processes are its descendants).
 */
export function createEvidenceSampler(rootPid: number = process.pid): EvidenceSampler {
  if (process.platform === "linux") {
    return createDeltaSampler(rootPid, () => enumerateLinux(rootPid));
  }
  if (process.platform === "win32") {
    return createDeltaSampler(rootPid, () => enumerateWindows(rootPid));
  }
  // darwin + other POSIX: ps is portable enough.
  return createDeltaSampler(rootPid, () => enumeratePosixPs(rootPid));
}

/** Test seam: the shared delta/tree logic over a scripted process table. */
export function createDeltaSamplerForTest(rootPid: number, enumerate: () => Promise<ProcRow[]>): EvidenceSampler {
  return createDeltaSampler(rootPid, enumerate);
}
