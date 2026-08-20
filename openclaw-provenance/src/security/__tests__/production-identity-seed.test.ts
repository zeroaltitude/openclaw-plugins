/**
 * Identity seeding as production actually performs it — no shim auto-seed.
 *
 * Every other integration test in this directory drives `makeApi()` with
 * identity auto-seeding on, which writes an IdentityStore record from
 * whatever identity fields the test put on its ctx. That is a fiction:
 * mainline's `PluginHookAgentContext` (openclaw `src/plugins/hook-types.ts`)
 * carries only `senderId` — and only for `trigger === "user"`, because
 * `buildAgentHookContextIdentityFields()` returns `{}` for every other
 * trigger — plus `messageProvider`. It never carries `senderIsOwner`,
 * `sourceProvider`, `groupId` or `spawnedBy`.
 *
 * Two consequences the auto-seed hid, and which these tests pin down:
 *
 *  1. The plugin's OWN seed in `before_prompt_build` — the one that calls
 *     `computeSenderIsOwner()` against configured `ownerNumbers` — never ran
 *     under test. The shim pre-wrote a record whose `senderId` matched the
 *     hook's, so `resolveIdentitySeedReason()` returned `undefined` and the
 *     handler skipped the write. Three production bugs shipped in that exact
 *     chain against a green suite (`09d6cb7` manifest configSchema,
 *     `72700d8` pluginConfig forwarding, `4b8ce31` owner-flag drift).
 *
 *  2. Ownership was assertable straight from ctx. A test could set
 *     `senderIsOwner: true` and be classified `trusted` without any
 *     `ownerNumbers` entry — a privilege production can only ever derive
 *     from that configured list.
 *
 * These tests run with `{ autoSeedIdentity: false }`, so the ctx shape here
 * is one mainline can genuinely produce.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSecurityHooks, type SecurityPluginConfig } from "../index.js";
import { getSharedIdentityStore } from "../identity-store.js";
import { makeApi, seedIdentity } from "./test-shim.js";

// ── Helpers ──────────────────────────────────────────────────

function makeLogger() {
  const logs: string[] = [];
  return {
    info: (...args: any[]) => logs.push(args.join(" ")),
    warn: (...args: any[]) => logs.push("WARN: " + args.join(" ")),
    error: (...args: any[]) => logs.push("ERROR: " + args.join(" ")),
    logs,
  };
}

/** The turn-start event shape `before_prompt_build` receives. */
const TURN = { prompt: "hello", messages: [{ role: "user", content: "hello" }] };

describe("identity seeding without the shim auto-seed (production ctx shape)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-prod-identity-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(config?: Partial<SecurityPluginConfig>) {
    const logger = makeLogger();
    const api = makeApi(tmpDir, { autoSeedIdentity: false });
    const { store } = registerSecurityHooks(api, logger, {
      workspaceDir: tmpDir,
      verbose: true,
      ...config,
    });
    return { api, logger, store, identityStore: getSharedIdentityStore(tmpDir) };
  }

  function trustLine(logger: { logs: string[] }): string | undefined {
    return logger.logs.find((l) => l.includes("CLASSIFY_INITIAL_TRUST:"));
  }

  // ── The no-identity path: no record at all, not a synthesized one ──

  it("writes no identity record when the hook ctx carries no senderId", () => {
    // Mainline strips senderId for every non-user trigger (heartbeat, cron,
    // subagent announce, exec-event), so this is the shape those turns have.
    const { api, identityStore } = setup();
    const sessionKey = "agent:main:discord:channel:123";

    api.fire("before_prompt_build", TURN, {
      agentId: "main",
      sessionKey,
      messageProvider: "discord",
    });

    expect(identityStore.get(sessionKey)).toBeUndefined();
    expect(identityStore.size()).toBe(0);
  });

  it("classifies a turn with no identity record using missingIdentityTrust", () => {
    const { api, logger } = setup();

    api.fire("before_prompt_build", TURN, {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:123",
      messageProvider: "discord",
    });

    // Default missingIdentityTrust, reached with identity === undefined.
    expect(trustLine(logger)).toContain("CLASSIFY_INITIAL_TRUST: shared");
    expect(trustLine(logger)).toContain("owner=unset");
  });

  it("honours a fail-closed missingIdentityTrust on the no-identity path", () => {
    const { api, logger } = setup({ missingIdentityTrust: "untrusted" });

    api.fire("before_prompt_build", TURN, {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:123",
      messageProvider: "discord",
    });

    expect(trustLine(logger)).toContain("CLASSIFY_INITIAL_TRUST: untrusted");
  });

  // ── The production seed: ownerNumbers → senderIsOwner → policy ──

  it("seeds the store from ctx.senderId and derives owner from ownerNumbers", () => {
    const { api, logger, identityStore } = setup({ ownerNumbers: ["owner-1"] });
    const sessionKey = "agent:main:discord:direct:owner-1";

    api.fire("before_prompt_build", TURN, {
      agentId: "main",
      sessionKey,
      messageProvider: "discord",
      senderId: "owner-1",
    });

    const record = identityStore.get(sessionKey);
    expect(record?.senderId).toBe("owner-1");
    expect(record?.senderIsOwner).toBe(true);
    expect(record?.sourceProvider).toBe("discord");
    expect(logger.logs.some((l) => l.includes("identity from hookCtx") && l.includes("reason=new-sender"))).toBe(true);
    expect(trustLine(logger)).toContain("CLASSIFY_INITIAL_TRUST: trusted");
  });

  it("classifies a senderId absent from ownerNumbers as external, not owner", () => {
    const { api, logger, identityStore } = setup({ ownerNumbers: ["owner-1"] });
    const sessionKey = "agent:main:discord:channel:123";

    api.fire("before_prompt_build", TURN, {
      agentId: "main",
      sessionKey,
      messageProvider: "discord",
      senderId: "someone-else",
    });

    expect(identityStore.get(sessionKey)?.senderIsOwner).toBe(false);
    expect(trustLine(logger)).toContain("CLASSIFY_INITIAL_TRUST: external");
  });

  it("cannot be talked into owner status by a senderIsOwner field on ctx", () => {
    // Regression guard for the shim fiction: with auto-seed on, this exact
    // ctx yielded `trusted` on an empty ownerNumbers list. Ownership must
    // come from configuration alone.
    const { api, logger, identityStore } = setup();
    const sessionKey = "agent:main:discord:channel:123";

    api.fire("before_prompt_build", TURN, {
      agentId: "main",
      sessionKey,
      messageProvider: "discord",
      senderId: "not-the-owner",
      senderIsOwner: true,
    });

    expect(identityStore.get(sessionKey)?.senderIsOwner).toBe(false);
    expect(trustLine(logger)).toContain("CLASSIFY_INITIAL_TRUST: external");
  });

  it("re-seeds a stale non-owner record once ownerNumbers names the sender", () => {
    // End-to-end counterpart to the resolveIdentitySeedReason unit tests:
    // a persisted record written while ownerNumbers was empty must self-heal
    // rather than pin the sender to non-owner forever.
    const sessionKey = "agent:main:discord:direct:owner-1";
    const { api, logger, identityStore } = setup({ ownerNumbers: ["owner-1"] });
    seedIdentity(tmpDir, sessionKey, { senderId: "owner-1", senderIsOwner: false });
    expect(identityStore.get(sessionKey)?.senderIsOwner).toBe(false);

    api.fire("before_prompt_build", TURN, {
      agentId: "main",
      sessionKey,
      messageProvider: "discord",
      senderId: "owner-1",
    });

    expect(identityStore.get(sessionKey)?.senderIsOwner).toBe(true);
    expect(logger.logs.some((l) => l.includes("reason=owner-drift"))).toBe(true);
    expect(trustLine(logger)).toContain("CLASSIFY_INITIAL_TRUST: trusted");
  });

  it("leaves an owner record alone when ownerNumbers is unset (no-opinion, not revocation)", () => {
    // computeSenderIsOwner() returns false for an empty list as a fallback,
    // not as an authoritative "not the owner". A deployment that never sets
    // ownerNumbers must not revoke what inbound_claim established.
    const sessionKey = "agent:main:discord:direct:owner-1";
    const { api, identityStore } = setup();
    seedIdentity(tmpDir, sessionKey, { senderId: "owner-1", senderIsOwner: true });

    api.fire("before_prompt_build", TURN, {
      agentId: "main",
      sessionKey,
      messageProvider: "discord",
      senderId: "owner-1",
    });

    expect(identityStore.get(sessionKey)?.senderIsOwner).toBe(true);
  });
});
