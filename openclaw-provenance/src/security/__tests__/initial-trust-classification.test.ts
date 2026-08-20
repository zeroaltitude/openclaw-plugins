/**
 * classifyInitialTrust — the identity.sourceProvider branch.
 *
 * These four cases used to live in `heartbeat-trust.test.ts` labelled as
 * heartbeat/cron/exec-event scenarios. They were not: they drove
 * classification by putting `sourceProvider` on the agent hook ctx, which
 * mainline never does. The old shim auto-seed copied that ctx field into the
 * IdentityStore, so the tests passed and read like end-to-end heartbeat
 * coverage while exercising a route production has no way to take.
 *
 * What they actually pin is worth keeping: the first branch of
 * classifyInitialTrust — an identity record whose `sourceProvider` is a
 * system source (heartbeat / cron / cron-event / exec-event / webchat)
 * classifies `trusted` regardless of the delivery channel on
 * `ctx.messageProvider`. The only production writer of that field is the
 * `inbound_claim` handler (from `event.channel`), so these are seeded through
 * `seedIdentity()` and labelled for what they are: a unit contract on the
 * provider branch, driven through the real hook pipeline.
 *
 * The defenses a REAL heartbeat/cron turn depends on — the sessionKey-segment
 * fallback and `missingIdentityTrust` — are covered in
 * `heartbeat-trust.test.ts` and `cron-briefing-taint.test.ts`. Session keys
 * here deliberately carry no system-source segment, so a pass can only come
 * from the provider branch under test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerSecurityHooks,
  type SecurityPluginConfig,
} from "../index.js";
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

/** No system-source segment: only the provider branch can grant trust here. */
const SESSION_KEY = "agent:main:discord:channel:123";

describe("classifyInitialTrust: identity.sourceProvider overrides the delivery channel", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-initial-trust-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(config?: Partial<SecurityPluginConfig>) {
    const logger = makeLogger();
    const api = makeApi(tmpDir);
    const { store } = registerSecurityHooks(api, logger, {
      workspaceDir: tmpDir,
      verbose: true,
      ...config,
    });
    return { api, logger, store };
  }

  /** A turn delivered over discord, on a session inbound_claim has cached. */
  function fireTurn(api: ReturnType<typeof makeApi>, text: string) {
    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: text }],
      messageCount: 1,
    }, {
      agentId: "main",
      sessionKey: SESSION_KEY,
      messageProvider: "discord",
    });
  }

  function trustLine(logger: { logs: string[] }): string | undefined {
    return logger.logs.find((l) => l.includes("CLASSIFY_INITIAL_TRUST:"));
  }

  for (const provider of ["heartbeat", "cron-event", "exec-event"]) {
    it(`classifies a record with sourceProvider=${provider} as trusted`, () => {
      const { api, logger } = setup();
      seedIdentity(tmpDir, SESSION_KEY, { sourceProvider: provider });

      fireTurn(api, "system-sourced turn");

      expect(trustLine(logger)).toContain("CLASSIFY_INITIAL_TRUST: trusted");
      expect(trustLine(logger)).toContain(`sourceProvider=${provider}`);
    });
  }

  it("logs sourceProvider and effectiveProvider when they differ from messageProvider", () => {
    const { api, logger } = setup();
    seedIdentity(tmpDir, SESSION_KEY, { sourceProvider: "heartbeat" });

    fireTurn(api, "system-sourced turn");

    expect(trustLine(logger)).toContain("provider=discord");
    expect(trustLine(logger)).toContain("sourceProvider=heartbeat");
    expect(trustLine(logger)).toContain("effectiveProvider=heartbeat");
  });

  it("does not trust a record whose sourceProvider is an ordinary channel", () => {
    // Negative control: the branch keys on the system-source set, not on the
    // mere presence of sourceProvider.
    const { api, logger } = setup();
    seedIdentity(tmpDir, SESSION_KEY, {
      senderId: "someone-456",
      sourceProvider: "discord",
    });

    fireTurn(api, "hello");

    expect(trustLine(logger)).toContain("CLASSIFY_INITIAL_TRUST: external");
  });
});
