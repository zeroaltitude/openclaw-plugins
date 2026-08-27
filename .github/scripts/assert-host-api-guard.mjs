#!/usr/bin/env node
/**
 * Report — and optionally enforce — whether `openclaw-provenance`'s host-API
 * typecheck guard is actually LIVE in this environment.
 *
 * Why this exists
 * ---------------
 * `openclaw-provenance/src/index.ts` types `register()`'s parameter as
 * `OpenClawPluginApi`, imported from `openclaw/plugin-sdk/core`. That import is
 * the only thing making `npm run typecheck` catch host-API drift — a call to a
 * member OpenClaw no longer exposes. The import carries an explicit
 * `// @ts-ignore TS2307`, because the `openclaw` devDependency is
 * `file:../../openclaw` — a path OUTSIDE this repo (the core checkout a
 * developer keeps as a sibling of openclaw-plugins).
 *
 * When that path is absent, `npm ci` leaves a DANGLING symlink and exits 0, the
 * `@ts-ignore` swallows TS2307, `OpenClawPluginApi` degrades to `any`, and the
 * typecheck passes anything at all. The guard does not weaken — it disappears,
 * silently, and the job stays green. That is strictly worse than no guard,
 * because green reads as "verified".
 *
 * Measured on a `git archive` extraction of main with no sibling directory
 * (openclaw-vestige-ive, 2026-08-26): `npm ci` exit 0, and
 * `api.thisMemberDoesNotExistOnTheHostApi()` inside `register()` typechecks
 * EXIT 0. With the sibling present and built, the same line is
 * `TS2339: Property ... does not exist on type 'OpenClawPluginApi'`.
 *
 * Why this probes the TYPES and not the symlink
 * ---------------------------------------------
 * The obvious assertion — "does `node_modules/openclaw` dereference?" — is not
 * sufficient, and this was measured, not assumed. `openclaw`'s `dist/` is
 * gitignored and untracked, so a plain `actions/checkout` of the core repo
 * produces a sibling whose `package.json` reads fine while
 * `dist/plugin-sdk/core.d.ts` does not exist. In that state the symlink
 * dereferences, a symlink assertion passes, TS2307 fires anyway, and the guard
 * is still dead. Only compiling the real module specifier proves anything.
 *
 * How the probe works
 * -------------------
 * It writes a throwaway `.ts` file that imports `OpenClawPluginApi` from the
 * same specifier `src/index.ts` uses — deliberately WITHOUT the `@ts-ignore` —
 * and references a member that cannot exist on the host API. Then it reads the
 * compiler's verdict:
 *
 *   TS2339 (no such property)      -> types resolved. Guard is LIVE.
 *   TS2307 (cannot find module)    -> types absent. Guard is DEAD.
 *   TS2305 (no such export)        -> module resolved, type gone. Guard is DEAD.
 *   exit 0 (no diagnostic at all)  -> the probe itself is broken; fail loudly
 *                                     rather than report a guard we did not see.
 *
 * Enforcement
 * -----------
 * `HOST_API_GUARD_REQUIRED=true` makes a DEAD guard exit non-zero. It is a
 * ratchet in the same spirit as `MIN_TESTS` in assert-junit-min-tests.py: flip
 * it on in the same commit that makes the host types reachable on a runner, and
 * never flip it back off to turn a red build green. Until then the step reports
 * DEAD as a GitHub warning annotation and exits 0, so the job tells the truth
 * about its own coverage without going red on every run for a gap it cannot fix
 * by itself.
 *
 * Usage: assert-host-api-guard.mjs [package-dir]   (default: cwd)
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SPECIFIER = "openclaw/plugin-sdk/core";
const TYPE_NAME = "OpenClawPluginApi";
const PROBE_MEMBER = "__hostApiGuardProbe_thisCannotExist__";

const pkgDir = resolve(process.argv[2] ?? process.cwd());
const required = String(process.env.HOST_API_GUARD_REQUIRED ?? "false") === "true";

/** Best-effort diagnostics: what does the dependency look like on disk? */
function describeDependency() {
  const depPkgJson = join(pkgDir, "node_modules", "openclaw", "package.json");
  if (!existsSync(depPkgJson)) {
    return "node_modules/openclaw/package.json is NOT readable (missing install, or a dangling symlink whose target does not exist)";
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(depPkgJson, "utf8"));
  } catch (err) {
    return `node_modules/openclaw/package.json is unreadable: ${err.message}`;
  }
  const entry = manifest?.exports?.[`./${SPECIFIER.split("/").slice(1).join("/")}`];
  const typesRel = typeof entry === "object" && entry !== null ? entry.types : undefined;
  if (!typesRel) {
    return `openclaw@${manifest.version} declares no "./plugin-sdk/core" types export`;
  }
  const typesAbs = join(pkgDir, "node_modules", "openclaw", typesRel);
  return existsSync(typesAbs)
    ? `openclaw@${manifest.version} -> ${typesRel} (present)`
    : `openclaw@${manifest.version} declares ${typesRel} but that file does NOT exist (an unbuilt checkout: openclaw's dist/ is gitignored)`;
}

function findTsc() {
  const candidates = [
    join(pkgDir, "node_modules", ".bin", "tsc"),
    join(pkgDir, "node_modules", "typescript", "bin", "tsc"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error(
      `FAIL [host-api-guard]: no local tsc under ${pkgDir}/node_modules. ` +
        "Run this step after `npm ci`.",
    );
    process.exit(1);
  }
  return found;
}

/**
 * Compile the probe and return tsc's raw output. The probe lives inside the
 * package so Node16 resolution walks the package's own node_modules; only the
 * tsbuildinfo/temp scratch goes to the OS temp dir.
 */
function runProbe() {
  const scratch = mkdtempSync(join(tmpdir(), "host-api-guard-"));
  const probePath = join(pkgDir, ".host-api-guard-probe.ts");
  const probeSrc = [
    "// Generated by .github/scripts/assert-host-api-guard.mjs. Deleted on exit.",
    "// No @ts-ignore here, deliberately: the whole point is to see the diagnostic",
    "// that src/index.ts suppresses.",
    `import type { ${TYPE_NAME} } from "${SPECIFIER}" assert { "resolution-mode": "require" };`,
    "",
    `declare const api: ${TYPE_NAME};`,
    `api.${PROBE_MEMBER}();`,
    "",
  ].join("\n");
  writeFileSync(probePath, probeSrc);

  try {
    // Flags mirror openclaw-provenance/tsconfig.json, which is the authority on
    // what the shipped build must satisfy. Passing files on the command line
    // means no tsconfig is read, so they must be spelled out here.
    execFileSync(
      process.execPath,
      [
        findTsc(),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ES2022",
        "--module",
        "Node16",
        "--moduleResolution",
        "Node16",
        probePath,
      ],
      { cwd: pkgDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { exitCode: 0, output: "" };
  } catch (err) {
    return {
      exitCode: typeof err.status === "number" ? err.status : 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  } finally {
    rmSync(probePath, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

const dependency = describeDependency();
const { exitCode, output } = runProbe();
const codes = new Set([...output.matchAll(/error (TS\d+):/g)].map((m) => m[1]));

console.log(`host-api-guard: dependency  ${dependency}`);
console.log(`host-api-guard: probe       tsc exit ${exitCode}, diagnostics ${[...codes].join(", ") || "(none)"}`);

if (exitCode !== 0 && codes.has("TS2339")) {
  console.log(
    `host-api-guard: verdict     LIVE — '${SPECIFIER}' resolved and ${TYPE_NAME} rejected ` +
      `an unknown member. The typecheck steps below really do check the host API.`,
  );
  process.exit(0);
}

if (exitCode === 0) {
  console.error(output.trim());
  console.error(
    `FAIL [host-api-guard]: the probe compiled CLEANLY. It references ` +
      `api.${PROBE_MEMBER}(), which no host API can have, so a clean compile means ` +
      `the probe is not measuring what it claims — most likely ${TYPE_NAME} silently ` +
      "resolved to `any`, or the flags above drifted from tsconfig.json. Fix the probe; " +
      "do not delete this step.",
  );
  process.exit(1);
}

// TS2307 / TS2305 / anything else that is not TS2339: the host types are not
// reachable, so `@ts-ignore` in src/index.ts is doing the same thing here and
// OpenClawPluginApi is `any` for the typecheck steps that follow.
const why = codes.has("TS2307")
  ? `'${SPECIFIER}' does not resolve`
  : codes.has("TS2305")
    ? `'${SPECIFIER}' resolves but exports no ${TYPE_NAME}`
    : `the probe failed with ${[...codes].join(", ") || "no recognizable diagnostic"}`;

const message =
  `host-API typecheck guard is DEAD: ${why}, so the '// @ts-ignore TS2307' in ` +
  `src/index.ts degrades ${TYPE_NAME} to 'any' and the typecheck steps in this job ` +
  `cannot catch host-API drift. Dependency: ${dependency}. ` +
  "Cause: the 'openclaw' devDependency is 'file:../../openclaw', a sibling checkout " +
  "that does not exist on a runner. See openclaw-vestige-ive.";

console.log(`host-api-guard: verdict     DEAD`);
if (output.trim()) console.log(output.trim());

if (required) {
  console.error(`FAIL [host-api-guard]: ${message}`);
  process.exit(1);
}

console.log(`::warning title=host-API typecheck guard is inert::${message}`);
console.log(
  "host-api-guard: not failing the job — HOST_API_GUARD_REQUIRED is not 'true'. " +
    "Flip it on in the same commit that makes the host types reachable here.",
);
process.exit(0);
