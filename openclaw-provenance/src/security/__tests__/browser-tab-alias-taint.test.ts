/**
 * Browser Tab Alias Taint — Regression Suite for openclaw-provenance-40x
 *
 * End-to-end coverage (through registerSecurityHooks' real hook wiring,
 * not just the isolated uri-extractor/tab-url-store units) for:
 *   1. Resolving a browser.snapshot/screenshot targetId that is actually a
 *      tabId-style alias (e.g. "t1"), not the raw CDP targetId.
 *   2. The alias link being recorded at browser.open time, not only from a
 *      browser.tabs listing.
 *   3. A later browser.navigate on the same tab updating what the alias
 *      resolves to.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSecurityHooks, type SecurityPluginConfig } from "../index.js";
import { getSharedTabUrlStore } from "../tab-url-store.js";
import { makeApi } from "./test-shim.js";

function makeLogger() {
  const logs: string[] = [];
  return {
    info: (...args: any[]) => logs.push(args.join(" ")),
    warn: (...args: any[]) => logs.push("WARN: " + args.join(" ")),
    error: (...args: any[]) => logs.push("ERROR: " + args.join(" ")),
    logs,
  };
}

const ownerCtx = {
  agentId: "main",
  sessionKey: "agent:main:discord:dm:owner",
  messageProvider: "discord",
  senderId: "owner-123",
  senderIsOwner: true,
};

describe("Browser tab alias taint resolution (openclaw-provenance-40x)", () => {
  let tmpDir: string;
  let turnsStarted: Set<string>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-browser-alias-test-"));
    turnsStarted = new Set();
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

  /** after_tool_call is a no-op until a turn exists (store.startTurn, via
   *  context_assembled -> before_prompt_build). Establish one per session
   *  the first time fireToolComplete is called for it. */
  function fireToolComplete(
    api: ReturnType<typeof makeApi>,
    ctx: typeof ownerCtx,
    params: Record<string, unknown>,
    resultText: Record<string, unknown>,
  ) {
    if (!turnsStarted.has(ctx.sessionKey)) {
      api.fire(
        "context_assembled",
        { systemPrompt: "test", messages: [{ role: "user", content: "test" }], messageCount: 1 },
        ctx,
      );
      turnsStarted.add(ctx.sessionKey);
    }
    api.fire(
      "after_tool_call",
      {
        toolName: "browser",
        params,
        result: { content: [{ type: "text", text: JSON.stringify(resultText) }] },
      },
      ctx,
    );
  }

  it("browser.open records the tabId alias, and a later browser.snapshot using that alias classifies by the tab's real URL", () => {
    const { api, store } = setup({
      uriTrust: { "https://hackers.example/**": "untrusted" },
    });

    // browser.open's result carries targetId + tabId + url together
    // (BrowserOpenResult = BrowserTab & {...}).
    fireToolComplete(
      api,
      ownerCtx,
      { action: "open", targetUrl: "https://hackers.example/login" },
      { targetId: "CDP-1", tabId: "t1", url: "https://hackers.example/login", title: "Login" },
    );

    // Agent follows the tool's own guidance ("prefer tabId ... from tabs
    // output") and calls snapshot with the alias, not the raw CDP id.
    fireToolComplete(
      api,
      ownerCtx,
      { action: "snapshot", targetId: "t1" },
      { snapshot: "page content" },
    );

    const graph = store.getActive(ownerCtx.sessionKey);
    expect(graph).toBeDefined();
    expect(graph!.maxTaint).toBe("untrusted");
  });

  it("browser.navigate on an aliased tab updates what the alias resolves to for a later snapshot", () => {
    const { api, store } = setup({
      uriTrust: {
        "https://safe.example/**": "trusted",
        "https://hackers.example/**": "untrusted",
      },
    });

    // Open a tab on a trusted site; alias t1 recorded pointing at it.
    fireToolComplete(
      api,
      ownerCtx,
      { action: "open", targetUrl: "https://safe.example/" },
      { targetId: "CDP-2", tabId: "t1", url: "https://safe.example/" },
    );
    fireToolComplete(api, ownerCtx, { action: "snapshot", targetId: "t1" }, { snapshot: "safe page" });
    expect(store.getActive(ownerCtx.sessionKey)!.maxTaint).toBe("trusted");

    // Navigate the same tab to an untrusted site. browser.navigate's result
    // never carries tabId/label -- only {ok, targetId, url}.
    fireToolComplete(
      api,
      ownerCtx,
      { action: "navigate", targetId: "CDP-2", targetUrl: "https://hackers.example/" },
      { ok: true, targetId: "CDP-2", url: "https://hackers.example/" },
    );

    // A subsequent snapshot still referring to the tab by its alias must
    // pick up the post-navigation URL, not the stale pre-navigation one.
    fireToolComplete(api, ownerCtx, { action: "snapshot", targetId: "t1" }, { snapshot: "hostile page" });

    expect(store.getActive(ownerCtx.sessionKey)!.maxTaint).toBe("untrusted");
  });

  it("registerSecurityHooks wires the tab URL store to disk under this workspace's .provenance dir", () => {
    // Proves the *wiring* (registerSecurityHooks -> initTabUrlPersistence ->
    // TabUrlStore writing to <workspaceDir>/.provenance/tab-urls.json).
    // TabUrlStore's own reload-from-disk-in-a-fresh-instance behavior (what
    // actually makes this survive a real gateway restart, i.e. a fresh
    // process) is covered directly in tab-url-store.test.ts, since
    // registerSecurityHooks always fetches the process-wide singleton and
    // can't simulate a truly fresh process within one test file.
    const { api } = setup();
    fireToolComplete(
      api,
      ownerCtx,
      { action: "open", targetUrl: "https://hackers.example/" },
      { targetId: "CDP-3", tabId: "t1", url: "https://hackers.example/" },
    );

    const tabUrlStore = getSharedTabUrlStore(tmpDir);
    tabUrlStore.flush();

    const filePath = join(tmpDir, ".provenance", "tab-urls.json");
    expect(existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(onDisk.aliasToTarget["t1"].targetId).toBe("CDP-3");
    expect(onDisk.targetToUrl["CDP-3"].url).toBe("https://hackers.example/");
  });
});
