import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityStore } from "../identity-store.js";
import {
  createInboundClaimHandler,
  createSubagentSpawnedHandler,
} from "../inbound-handlers.js";

function makeLogger() {
  const logs: string[] = [];
  return {
    info: (...a: any[]) => logs.push(a.join(" ")),
    warn: (...a: any[]) => logs.push("WARN: " + a.join(" ")),
    error: (...a: any[]) => logs.push("ERROR: " + a.join(" ")),
    logs,
  };
}

describe("createInboundClaimHandler", () => {
  let tmpDir: string;
  let store: IdentityStore;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-inbound-test-"));
    store = new IdentityStore(tmpDir);
    logger = makeLogger();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("caches identity from a DM inbound event", () => {
    const handler = createInboundClaimHandler({
      identityStore: store,
      ownerNumbers: ["159471966640799744"],
      logger,
    });
    handler(
      {
        channel: "discord",
        senderId: "159471966640799744",
        senderName: "Eddie",
        sessionKey: "agent:tank:discord:dm:owner",
        isGroup: false,
        conversationId: "159471966640799744",
      },
      { sessionKey: "agent:tank:discord:dm:owner" },
    );
    const r = store.get("agent:tank:discord:dm:owner");
    expect(r).toBeDefined();
    expect(r?.senderId).toBe("159471966640799744");
    expect(r?.senderName).toBe("Eddie");
    expect(r?.senderIsOwner).toBe(true);
    expect(r?.sourceProvider).toBe("discord");
    expect(r?.groupId).toBeNull(); // isGroup=false
  });

  it("caches identity from a group inbound event", () => {
    const handler = createInboundClaimHandler({
      identityStore: store,
      ownerNumbers: ["159471966640799744"],
      logger,
    });
    handler(
      {
        channel: "discord",
        senderId: "999",
        senderName: "Anon",
        sessionKey: "agent:main:discord:group:G1",
        isGroup: true,
        conversationId: "G1",
        metadata: { groupId: "G1" },
      },
      { sessionKey: "agent:main:discord:group:G1" },
    );
    const r = store.get("agent:main:discord:group:G1");
    expect(r?.senderIsOwner).toBe(false); // not in ownerNumbers
    expect(r?.groupId).toBe("G1");
    expect(r?.sourceProvider).toBe("discord");
  });

  it("falls back to ctx.sessionKey when event.sessionKey is missing", () => {
    const handler = createInboundClaimHandler({
      identityStore: store,
      ownerNumbers: [],
      logger,
    });
    handler(
      { channel: "slack", senderId: "U1" },
      { sessionKey: "from-ctx" },
    );
    expect(store.get("from-ctx")?.senderId).toBe("U1");
  });

  it("warns and skips when no sessionKey is available anywhere", () => {
    const handler = createInboundClaimHandler({
      identityStore: store,
      ownerNumbers: [],
      logger,
    });
    handler({ channel: "slack", senderId: "U1" }, {});
    expect(store.size()).toBe(0);
    expect(logger.logs.some((l) => l.includes("WARN") && l.includes("missing sessionKey"))).toBe(
      true,
    );
  });

  it("computes senderIsOwner only when senderId is in ownerNumbers", () => {
    const handler = createInboundClaimHandler({
      identityStore: store,
      ownerNumbers: ["A"],
      logger,
    });
    handler(
      { channel: "slack", senderId: "A", sessionKey: "s1" },
      { sessionKey: "s1" },
    );
    handler(
      { channel: "slack", senderId: "B", sessionKey: "s2" },
      { sessionKey: "s2" },
    );
    expect(store.get("s1")?.senderIsOwner).toBe(true);
    expect(store.get("s2")?.senderIsOwner).toBe(false);
  });
});

describe("createSubagentSpawnedHandler", () => {
  let tmpDir: string;
  let store: IdentityStore;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-spawn-test-"));
    store = new IdentityStore(tmpDir);
    logger = makeLogger();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records parent→child relationship using named-fields shape", () => {
    const handler = createSubagentSpawnedHandler({ identityStore: store, logger });
    handler(
      {
        parentSessionKey: "parent",
        childSessionKey: "child",
      },
      {},
    );
    expect(store.get("child")?.spawnedBy).toBe("parent");
  });

  it("accepts the alternate { sessionKey, spawnedBy } shape", () => {
    const handler = createSubagentSpawnedHandler({ identityStore: store, logger });
    handler({ sessionKey: "child", spawnedBy: "parent" }, {});
    expect(store.get("child")?.spawnedBy).toBe("parent");
  });

  it("warns and skips when parent or child is missing", () => {
    const handler = createSubagentSpawnedHandler({ identityStore: store, logger });
    handler({}, {});
    expect(store.size()).toBe(0);
    expect(logger.logs.some((l) => l.includes("WARN"))).toBe(true);
  });
});
