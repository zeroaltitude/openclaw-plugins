/**
 * Manifest <-> code agreement for the plugin config surface.
 *
 * The manifest's `configSchema` sets `additionalProperties: false`, and OpenClaw
 * core validates `plugins.entries.provenance.config` against it at STARTUP,
 * refusing to boot on a violation. So a config key the code reads but the
 * manifest omits is not a soft documentation gap — it is unsettable, and an
 * operator who sets it takes the gateway down until `openclaw doctor --fix`
 * runs, which "repairs" by disabling the plugin and stripping its entire config
 * block (measured: 163 config leaves lost, including taintPolicy and
 * trustedSenderIds).
 *
 * That is exactly what `ownerNumbers` did: read by the code since the first
 * identity-store commit, never declared in the manifest. It was therefore
 * always `[]`, so `computeSenderIsOwner` could not return true no matter what
 * the operator configured — the owner branch of the trust ladder was dead code
 * in every deployment.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

/**
 * Members of `SecurityPluginConfig` that the manifest deliberately does not
 * declare, because they are not operator-settable. Verified against the single
 * construction site in `src/index.ts` rather than assumed:
 *
 * - `workspaceDir`   — host-injected from `api.config.agents.*.workspace`.
 * - `verbose`        — hardcoded `true` at the call site.
 * - `toolTrustOverrides`, `maxCompletedGraphs`, `execCommandRules` — not
 *   forwarded at all, so they are dead config surface. Declaring them in the
 *   manifest would advertise settings that silently do nothing, which is worse
 *   than omitting them; wiring them up is a separate decision.
 *   (`execCommandRules` still gets its 16 built-in defaults internally.)
 *
 * Anything NOT in this set must be declared, or setting it hard-fails gateway
 * startup the way `ownerNumbers` did. This set may only shrink.
 */
const KNOWN_UNDECLARED = new Set([
  "toolTrustOverrides",
  "maxCompletedGraphs",
  "verbose",
  "workspaceDir",
  "execCommandRules",
]);

/**
 * Manifest-declared keys that `register()` does not forward, so they are
 * accepted and then ignored.
 *
 * `developerMode` appears zero times in the plugin source outside tests and is
 * not a member of `SecurityPluginConfig`, yet it is declared and operators have
 * it set. It cannot simply be deleted from the manifest: `additionalProperties`
 * is false, so undeclaring a key that live configs already set would hard-fail
 * gateway startup — the same failure this file exists to prevent. Removing it
 * needs a deprecation path (accept-and-warn, then drop), and wiring it up needs
 * its intended semantics, which no longer exist anywhere in the code.
 * Tracked in openclaw-provenance-yct.
 */
const KNOWN_UNFORWARDED = new Set(["developerMode"]);

function schemaProperties(): Set<string> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "openclaw.plugin.json"), "utf8"),
  ) as {
    configSchema?: { properties?: Record<string, unknown>; additionalProperties?: boolean };
  };
  const schema = manifest.configSchema;
  expect(schema, "manifest must declare configSchema").toBeTruthy();
  // This test only bites because unknown keys are rejected. If that ever flips
  // to permissive, the invariant changes and this file should be revisited
  // rather than left silently passing.
  expect(schema?.additionalProperties).toBe(false);
  return new Set(Object.keys(schema?.properties ?? {}));
}

/** Optional members declared on the `SecurityPluginConfig` interface. */
function declaredConfigMembers(): string[] {
  const src = readFileSync(join(REPO_ROOT, "src/security/index.ts"), "utf8");
  const start = src.indexOf("export interface SecurityPluginConfig");
  expect(start, "SecurityPluginConfig must exist in src/security/index.ts").toBeGreaterThan(-1);
  const open = src.indexOf("{", start);
  // The interface body is brace-balanced; members include inline object types,
  // so a naive "next }" would truncate the member list and weaken the test.
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end).toBeGreaterThan(open);
  const body = src.slice(open + 1, end);

  const members: string[] = [];
  for (const match of body.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\??\s*:/gm)) {
    const name = match[1];
    if (name && !members.includes(name)) members.push(name);
  }
  return members;
}

describe("manifest configSchema", () => {
  it("declares ownerNumbers, which the code reads to compute senderIsOwner", () => {
    expect([...schemaProperties()]).toContain("ownerNumbers");
  });

  it("parses the config interface (guards the parser itself)", () => {
    const members = declaredConfigMembers();
    // If the brace matcher or regex breaks, the drift test below would pass
    // vacuously, so assert the parser actually found a plausible member list.
    expect(members.length).toBeGreaterThan(10);
    expect(members).toContain("ownerNumbers");
    expect(members).toContain("taintPolicy");
  });

  it("declares every config member except the pinned known-undeclared set", () => {
    const props = schemaProperties();
    const undeclared = declaredConfigMembers().filter((m) => !props.has(m));
    const unexpected = undeclared.filter((m) => !KNOWN_UNDECLARED.has(m));

    expect(
      unexpected,
      unexpected.length
        ? `Config members read by the code but absent from openclaw.plugin.json.\n` +
            `additionalProperties=false, so setting any of these hard-fails gateway ` +
            `startup and provokes a doctor --fix that strips the whole config block.\n` +
            `Declare them in the manifest, or add to KNOWN_UNDECLARED with a reason:\n` +
            unexpected.map((m) => `  ${m}`).join("\n")
        : "",
    ).toEqual([]);
  });

  /**
   * The complementary invariant, and the one that actually bit: `register()` in
   * src/index.ts forwards config to `registerSecurityHooks` by explicit
   * key-by-key enumeration. A key can therefore be valid in the manifest, present
   * on disk, accepted at startup — and still never reach the code that reads it,
   * which is precisely what happened to `ownerNumbers`. Declaring a setting and
   * dropping it on the floor is worse than rejecting it, because it fails silently.
   */
  it("forwards every manifest-declared key from api.pluginConfig", () => {
    const src = readFileSync(join(REPO_ROOT, "src/index.ts"), "utf8");
    const start = src.indexOf("registerSecurityHooks(");
    expect(start, "register() must call registerSecurityHooks").toBeGreaterThan(-1);
    const callSite = src.slice(start);

    const notForwarded = [...schemaProperties()].filter(
      (key) =>
        !KNOWN_UNFORWARDED.has(key) && !new RegExp(`\\bcfg\\s*\\.\\s*${key}\\b`).test(callSite),
    );

    expect(
      notForwarded,
      notForwarded.length
        ? `Declared in openclaw.plugin.json but never read off cfg in src/index.ts, ` +
            `so the setting is accepted and then silently ignored:\n` +
            notForwarded.map((k) => `  ${k}`).join("\n")
        : "",
    ).toEqual([]);
  });

  it("keeps KNOWN_UNDECLARED honest — no entry that is actually declared", () => {
    const props = schemaProperties();
    const stale = [...KNOWN_UNDECLARED].filter((m) => props.has(m));
    expect(
      stale,
      `These are now declared in the manifest; remove them from KNOWN_UNDECLARED: ${stale.join(", ")}`,
    ).toEqual([]);
  });
});
