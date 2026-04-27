import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IdentityStore,
  getSharedIdentityStore,
  sessionKeyIsDm,
  computeSenderIsOwner,
  deriveGroupId,
} from "../identity-store.js";

describe("IdentityStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-identity-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("upsert + get", () => {
    it("stores and retrieves an identity record", () => {
      const store = new IdentityStore(tmpDir);
      store.upsert({
        sessionKey: "agent:tank:discord:dm:owner",
        senderId: "U1",
        senderName: "Eddie",
        senderIsOwner: true,
        sourceProvider: "discord",
        groupId: null,
        spawnedBy: null,
      });
      const r = store.get("agent:tank:discord:dm:owner");
      expect(r).toBeDefined();
      expect(r?.senderId).toBe("U1");
      expect(r?.senderName).toBe("Eddie");
      expect(r?.senderIsOwner).toBe(true);
      expect(r?.sourceProvider).toBe("discord");
      expect(r?.groupId).toBeNull();
      expect(r?.spawnedBy).toBeNull();
      expect(r?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("returns undefined for unknown sessionKey", () => {
      const store = new IdentityStore(tmpDir);
      expect(store.get("nonexistent")).toBeUndefined();
    });

    it("merges fields on upsert (preserves prior fields)", () => {
      const store = new IdentityStore(tmpDir);
      store.upsert({
        sessionKey: "s1",
        senderId: "U1",
        senderIsOwner: true,
        sourceProvider: "discord",
      });
      // Subsequent upsert without senderId — should preserve prior
      store.upsert({
        sessionKey: "s1",
        senderName: "Eddie",
      });
      const r = store.get("s1");
      expect(r?.senderId).toBe("U1");
      expect(r?.senderIsOwner).toBe(true);
      expect(r?.sourceProvider).toBe("discord");
      expect(r?.senderName).toBe("Eddie");
    });
  });

  describe("setSpawnedBy", () => {
    it("sets spawnedBy on an existing record", () => {
      const store = new IdentityStore(tmpDir);
      store.upsert({ sessionKey: "child", senderIsOwner: false });
      store.setSpawnedBy("child", "parent");
      expect(store.get("child")?.spawnedBy).toBe("parent");
    });

    it("creates a stub record when spawn arrives before any inbound", () => {
      const store = new IdentityStore(tmpDir);
      store.setSpawnedBy("orphan", "parent");
      const r = store.get("orphan");
      expect(r).toBeDefined();
      expect(r?.spawnedBy).toBe("parent");
      expect(r?.senderIsOwner).toBe(false); // safe default
    });
  });

  describe("isOwner / isOwnerDm", () => {
    it("isOwner true only when senderIsOwner is true", () => {
      const store = new IdentityStore(tmpDir);
      store.upsert({ sessionKey: "owner", senderIsOwner: true });
      store.upsert({ sessionKey: "guest", senderIsOwner: false });
      expect(store.isOwner("owner")).toBe(true);
      expect(store.isOwner("guest")).toBe(false);
      expect(store.isOwner("missing")).toBe(false);
    });

    it("isOwnerDm requires owner + no group + no spawnedBy", () => {
      const store = new IdentityStore(tmpDir);
      store.upsert({ sessionKey: "owner-dm", senderIsOwner: true });
      store.upsert({
        sessionKey: "owner-group",
        senderIsOwner: true,
        groupId: "G1",
      });
      store.upsert({
        sessionKey: "owner-spawn",
        senderIsOwner: true,
        spawnedBy: "parent",
      });
      expect(store.isOwnerDm("owner-dm")).toBe(true);
      expect(store.isOwnerDm("owner-group")).toBe(false);
      expect(store.isOwnerDm("owner-spawn")).toBe(false);
      expect(store.isOwnerDm("missing")).toBe(false);
    });
  });

  describe("persistence", () => {
    it("flushes to disk on upsert (debounced) — flush() forces immediate write", () => {
      const store = new IdentityStore(tmpDir);
      store.upsert({ sessionKey: "s1", senderIsOwner: true });
      store.flush();
      const file = join(tmpDir, ".provenance", "identity.json");
      expect(existsSync(file)).toBe(true);
      const raw = readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.records.s1.senderIsOwner).toBe(true);
    });

    it("survives across constructor invocations (load on init)", () => {
      const store1 = new IdentityStore(tmpDir);
      store1.upsert({ sessionKey: "s1", senderIsOwner: true, senderId: "U1" });
      store1.flush();

      const store2 = new IdentityStore(tmpDir);
      const r = store2.get("s1");
      expect(r?.senderIsOwner).toBe(true);
      expect(r?.senderId).toBe("U1");
    });

    it("returns empty store when file is corrupt", () => {
      const dir = join(tmpDir, ".provenance");
      const file = join(dir, "identity.json");
      // Write garbage
      const { mkdirSync, writeFileSync } = require("node:fs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, "not json", "utf-8");
      const store = new IdentityStore(tmpDir);
      expect(store.size()).toBe(0);
    });
  });

  describe("remove", () => {
    it("removes a record", () => {
      const store = new IdentityStore(tmpDir);
      store.upsert({ sessionKey: "s1", senderIsOwner: true });
      expect(store.get("s1")).toBeDefined();
      store.remove("s1");
      expect(store.get("s1")).toBeUndefined();
    });
  });

  describe("getSharedIdentityStore singleton", () => {
    it("returns the same instance for the same workspaceDir", () => {
      const a = getSharedIdentityStore(tmpDir);
      const b = getSharedIdentityStore(tmpDir);
      expect(a).toBe(b);
    });

    it("returns different instances for different workspaceDirs", () => {
      const tmpDir2 = mkdtempSync(join(tmpdir(), "provenance-identity-test2-"));
      try {
        const a = getSharedIdentityStore(tmpDir);
        const b = getSharedIdentityStore(tmpDir2);
        expect(a).not.toBe(b);
      } finally {
        rmSync(tmpDir2, { recursive: true, force: true });
      }
    });
  });
});

describe("sessionKeyIsDm", () => {
  it("returns true for :dm: marker", () => {
    expect(sessionKeyIsDm("agent:main:slack:tabitha:dm:owner-123")).toBe(true);
  });

  it("returns true for :direct: marker", () => {
    expect(sessionKeyIsDm("agent:tank:discord:tank:direct:159471966640799744")).toBe(true);
  });

  it("returns false for :group: marker", () => {
    expect(sessionKeyIsDm("agent:main:discord:group:1234567890")).toBe(false);
  });

  it("returns false for empty / unparseable keys", () => {
    expect(sessionKeyIsDm("")).toBe(false);
    expect(sessionKeyIsDm("nonsense-key")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(sessionKeyIsDm("AGENT:TANK:DISCORD:DIRECT:owner")).toBe(true);
  });
});

describe("computeSenderIsOwner", () => {
  it("returns true when senderId matches an entry in ownerNumbers", () => {
    expect(computeSenderIsOwner("U1", ["U1", "U2"])).toBe(true);
  });

  it("returns false when senderId is null/undefined", () => {
    expect(computeSenderIsOwner(null, ["U1"])).toBe(false);
    expect(computeSenderIsOwner(undefined, ["U1"])).toBe(false);
  });

  it("returns false when ownerNumbers is empty", () => {
    expect(computeSenderIsOwner("U1", [])).toBe(false);
  });

  it("returns false when senderId is not in ownerNumbers", () => {
    expect(computeSenderIsOwner("U1", ["U2", "U3"])).toBe(false);
  });
});

describe("deriveGroupId", () => {
  it("returns null when isGroup is false", () => {
    expect(
      deriveGroupId({
        sessionKey: "agent:main:discord:dm:owner",
        isGroup: false,
        metadataGroupId: "G1",
        conversationId: "C1",
      }),
    ).toBeNull();
  });

  it("uses metadata.groupId when isGroup is true", () => {
    expect(
      deriveGroupId({
        sessionKey: "agent:main:discord:group:G1",
        isGroup: true,
        metadataGroupId: "G1",
        conversationId: "C1",
      }),
    ).toBe("G1");
  });

  it("falls back to conversationId when metadata.groupId is missing", () => {
    expect(
      deriveGroupId({
        sessionKey: "agent:main:discord:group:C1",
        isGroup: true,
        conversationId: "C1",
      }),
    ).toBe("C1");
  });

  it("uses sessionKey markers when isGroup is undefined", () => {
    expect(
      deriveGroupId({
        sessionKey: "agent:main:slack:tabitha:dm:owner",
      }),
    ).toBeNull();
    expect(
      deriveGroupId({
        sessionKey: "agent:main:discord:group:G1",
        conversationId: "G1",
      }),
    ).toBe("G1");
  });

  it("falls back to threadId when other sources are unavailable", () => {
    expect(
      deriveGroupId({
        sessionKey: "agent:main:slack:group:foo",
        isGroup: true,
        threadId: 1234,
      }),
    ).toBe("1234");
  });
});
