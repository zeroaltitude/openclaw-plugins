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
 * Members of `SecurityPluginConfig` that the code reads but the manifest does
 * not declare. Every entry is a latent startup-crash landmine of exactly the
 * `ownerNumbers` kind: setting it hard-fails the gateway.
 *
 * Pinned rather than fixed on purpose — writing a schema for each needs its
 * real semantics (is `workspaceDir` operator-settable or host-injected?), and a
 * wrong `type` would trade a latent crash for an immediate one. Tracked in
 * openclaw-provenance-yct. The value of pinning is that this set may only
 * SHRINK: a newly-added undeclared key fails this test.
 */
const KNOWN_UNDECLARED = new Set([
  "toolTrustOverrides",
  "maxCompletedGraphs",
  "verbose",
  "workspaceDir",
  "execCommandRules",
]);

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

  it("keeps KNOWN_UNDECLARED honest — no entry that is actually declared", () => {
    const props = schemaProperties();
    const stale = [...KNOWN_UNDECLARED].filter((m) => props.has(m));
    expect(
      stale,
      `These are now declared in the manifest; remove them from KNOWN_UNDECLARED: ${stale.join(", ")}`,
    ).toEqual([]);
  });
});
