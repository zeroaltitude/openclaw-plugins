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
  resolveIdentitySeedReason,
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

/**
 * openclaw-ax8s. Identity used to be sourced solely from inbound_claim, which
 * is a TARGETED CLAIMING hook that provenance never receives (measured: zero
 * such log lines ever, sender=unknown on 16996 of 16996 turns). The effect was
 * that trustedSenderIds could never match and every turn fell through to
 * missingIdentityTrust — fail-open on a security plugin.
 *
 * before_prompt_build now seeds the store from the agent hook context. These
 * pin the semantics that path relies on.
 */
describe("computeSenderIsOwner + upsert semantics for hookCtx-seeded identity", () => {
  it("marks a configured owner id as owner", () => {
    expect(computeSenderIsOwner("159471966640799744", ["159471966640799744"])).toBe(true);
  });

  it("does NOT mark an unlisted sender as owner", () => {
    expect(computeSenderIsOwner("999", ["159471966640799744"])).toBe(false);
  });

  it("returns false — never throws — when the owner list is empty", () => {
    // Was the live state for the whole life of this plugin: ownerNumbers was
    // absent from the manifest configSchema, so it could not be set at all
    // (openclaw-provenance-yct). It must degrade quietly rather than break turns.
    expect(computeSenderIsOwner("159471966640799744", [])).toBe(false);
  });

  it("returns false for a missing senderId", () => {
    expect(computeSenderIsOwner(null, ["159471966640799744"])).toBe(false);
    expect(computeSenderIsOwner(undefined, ["159471966640799744"])).toBe(false);
  });

  it("upsert MERGES rather than clobbers, so a later inbound_claim still wins", () => {
    // The hookCtx seed sets senderId/senderIsOwner only. If core ever does
    // deliver inbound_claim to us it carries richer fields (senderName,
    // groupId); merging is what lets both coexist instead of one erasing the
    // other.
    const dir = mkdtempSync(join(tmpdir(), "prov-identity-merge-"));
    try {
    const store = new IdentityStore(dir);
    store.upsert({ sessionKey: "s1", senderId: "abc", senderIsOwner: true });
    store.upsert({ sessionKey: "s1", senderName: "Eddie", groupId: "g1" });
    const rec = store.get("s1");
    expect(rec?.senderId).toBe("abc");
    expect(rec?.senderIsOwner).toBe(true);
    expect(rec?.senderName).toBe("Eddie");
    expect(rec?.groupId).toBe("g1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * openclaw-provenance-yct. The seed guard originally fired only when the
 * senderId differed from what was stored — chosen deliberately to keep writes
 * at one per session. Because the store is PERSISTED, that made a stale owner
 * flag permanent: the live record for Eddie's Discord DM held
 * `senderIsOwner: false` (written while ownerNumbers was unsettable), and after
 * ownerNumbers was fixed the senderId still matched, so the guard short-circuited
 * and CLASSIFY_INITIAL_TRUST kept reporting owner=false across restarts.
 */
describe("resolveIdentitySeedReason", () => {
  const SENDER = "159471966640799744";

  it("seeds when there is no cached record at all", () => {
    expect(
      resolveIdentitySeedReason({ cached: undefined, hookSenderId: SENDER, computedIsOwner: true, ownerListConfigured: true }),
    ).toBe("new-sender");
  });

  it("seeds when the cached sender differs", () => {
    expect(
      resolveIdentitySeedReason({
        cached: { senderId: "999", senderIsOwner: false },
        hookSenderId: SENDER,
        computedIsOwner: true,
        ownerListConfigured: true,
      }),
    ).toBe("new-sender");
  });

  it("re-seeds on owner drift — the actual live regression", () => {
    // Exactly the persisted record observed in identity.json.
    expect(
      resolveIdentitySeedReason({
        cached: { senderId: SENDER, senderIsOwner: false },
        hookSenderId: SENDER,
        computedIsOwner: true,
        ownerListConfigured: true,
      }),
    ).toBe("owner-drift");
  });

  it("re-seeds when owner is REVOKED, not just granted", () => {
    // Removing an id from ownerNumbers must also take effect, otherwise the
    // store would keep handing out owner authority after it was withdrawn —
    // the security-relevant direction of this bug.
    expect(
      resolveIdentitySeedReason({
        cached: { senderId: SENDER, senderIsOwner: true },
        hookSenderId: SENDER,
        computedIsOwner: false,
        ownerListConfigured: true,
      }),
    ).toBe("owner-drift");
  });

  it("does NOT write when the cached record already agrees", () => {
    // Preserves the one-write-per-session steady state; without this the hook
    // would write to disk on every turn.
    expect(
      resolveIdentitySeedReason({
        cached: { senderId: SENDER, senderIsOwner: true },
        hookSenderId: SENDER,
        computedIsOwner: true,
        ownerListConfigured: true,
      }),
    ).toBeUndefined();
    expect(
      resolveIdentitySeedReason({
        cached: { senderId: SENDER, senderIsOwner: false },
        hookSenderId: SENDER,
        computedIsOwner: false,
        ownerListConfigured: true,
      }),
    ).toBeUndefined();
  });

  it("treats a cached record with no senderId as a new sender", () => {
    expect(
      resolveIdentitySeedReason({
        cached: { senderId: null, senderIsOwner: false },
        hookSenderId: SENDER,
        computedIsOwner: false,
        ownerListConfigured: true,
      }),
    ).toBe("new-sender");
  });
});

/**
 * The empty-list guard. Caught by the existing browser-taint suites rather than
 * by design: the first version of the drift rule downgraded 14 of them from
 * `trusted` to `external`, because those fixtures establish an owner identity
 * directly while the plugin config carries no ownerNumbers. With ownerNumbers
 * unset — the DEFAULT — an unguarded rule revokes owner status that
 * inbound_claim legitimately set, on the next turn, in every deployment.
 */
describe("resolveIdentitySeedReason — empty ownerNumbers is 'no opinion', not 'not owner'", () => {
  const SENDER = "159471966640799744";

  it("does NOT revoke a stored owner when no owner list is configured", () => {
    expect(
      resolveIdentitySeedReason({
        cached: { senderId: SENDER, senderIsOwner: true },
        hookSenderId: SENDER,
        computedIsOwner: false, // computeSenderIsOwner's empty-list fallback
        ownerListConfigured: false,
      }),
    ).toBeUndefined();
  });

  it("still records a genuinely new sender when no owner list is configured", () => {
    // The senderId path must keep working; the guard is only about the owner flag.
    expect(
      resolveIdentitySeedReason({
        cached: undefined,
        hookSenderId: SENDER,
        computedIsOwner: false,
        ownerListConfigured: false,
      }),
    ).toBe("new-sender");
  });

  it("revokes owner when the id is dropped from a NON-empty list", () => {
    // Revocation is a real answer when there is a list to be authoritative
    // about, so this must not be swallowed by the guard above.
    expect(
      resolveIdentitySeedReason({
        cached: { senderId: SENDER, senderIsOwner: true },
        hookSenderId: SENDER,
        computedIsOwner: false,
        ownerListConfigured: true,
      }),
    ).toBe("owner-drift");
  });
});
