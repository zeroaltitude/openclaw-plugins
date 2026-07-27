import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TabUrlStore, getSharedTabUrlStore } from "../tab-url-store.js";

describe("TabUrlStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-tab-url-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves a tab by its raw targetId", () => {
    const store = new TabUrlStore();
    store.recordTabs([{ targetId: "CDP-1", url: "https://example.com" }]);
    expect(store.resolveTabUrl("CDP-1")).toBe("https://example.com");
  });

  it("resolves a tab by its tabId alias, not just the raw targetId (the reported bug)", () => {
    const store = new TabUrlStore();
    // Shape of a browser.tabs / browser.open tab entry: raw CDP targetId
    // plus the friendly tabId alias the model is told to prefer passing.
    store.recordTabs([
      { targetId: "CDP-1", tabId: "t1", url: "https://example.com" },
    ]);
    // Previously: tabUrlMap was keyed only by targetId, so resolving "t1"
    // (what the model actually sends as the targetId *value*) failed.
    expect(store.resolveTabUrl("t1")).toBe("https://example.com");
    expect(store.resolveTabUrl("CDP-1")).toBe("https://example.com");
  });

  it("resolves by suggestedTargetId and label aliases too", () => {
    const store = new TabUrlStore();
    store.recordTabs([
      {
        targetId: "CDP-2",
        tabId: "t2",
        suggestedTargetId: "checkout",
        label: "checkout",
        url: "https://shop.example.com/cart",
      },
    ]);
    expect(store.resolveTabUrl("checkout")).toBe("https://shop.example.com/cart");
    expect(store.resolveTabUrl("t2")).toBe("https://shop.example.com/cart");
  });

  it("records the alias link at open time, not only from a browser.tabs listing", () => {
    const store = new TabUrlStore();
    // browser.open's result (BrowserOpenResult = BrowserTab & {...}) carries
    // targetId + tabId + url together, same as a browser.tabs entry would.
    store.recordTabs([
      { targetId: "CDP-3", tabId: "t3", url: "https://newly-opened.example.com" },
    ]);
    expect(store.resolveTabUrl("t3")).toBe("https://newly-opened.example.com");
  });

  it("follows browser.navigate: updating targetId->url alone keeps the alias resolving to the new URL", () => {
    const store = new TabUrlStore();
    // Tab opened, alias recorded.
    store.recordTabs([{ targetId: "CDP-4", tabId: "t4", url: "https://old.example.com" }]);
    expect(store.resolveTabUrl("t4")).toBe("https://old.example.com");

    // browser.navigate's result never carries tabId/label — only
    // {ok, targetId, url} (BrowserActionTabResult). Simulate that: record
    // just the raw targetId + new URL, no alias fields.
    store.recordTabs([{ targetId: "CDP-4", url: "https://new.example.com" }]);

    // The alias "t4" must now resolve to the post-navigation URL, because
    // it was never re-keyed to the URL directly -- it chains through the
    // stable targetId.
    expect(store.resolveTabUrl("t4")).toBe("https://new.example.com");
    expect(store.resolveTabUrl("CDP-4")).toBe("https://new.example.com");
  });

  it("does not resolve an unknown alias (fails closed, not open)", () => {
    const store = new TabUrlStore();
    store.recordTabs([{ targetId: "CDP-5", tabId: "t5", url: "https://example.com" }]);
    expect(store.resolveTabUrl("t99")).toBeUndefined();
  });

  it("treats stale entries as unresolvable past maxAgeMs", () => {
    // Negative maxAgeMs deterministically makes every entry "older than
    // the cutoff" the instant it's written, avoiding timing flakiness.
    const store = new TabUrlStore(undefined, { maxAgeMs: -1 });
    store.recordTabs([{ targetId: "CDP-6", tabId: "t6", url: "https://example.com" }]);
    expect(store.resolveTabUrl("CDP-6")).toBeUndefined();
    expect(store.resolveTabUrl("t6")).toBeUndefined();
  });

  it("persists alias and URL links to disk and reloads them in a fresh instance (survives gateway restart)", () => {
    const store1 = new TabUrlStore(tmpDir);
    store1.recordTabs([
      { targetId: "CDP-7", tabId: "t7", url: "https://persisted.example.com" },
    ]);
    store1.flush();

    const filePath = join(tmpDir, ".provenance", "tab-urls.json");
    expect(existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(onDisk.version).toBe(1);
    expect(onDisk.targetToUrl["CDP-7"].url).toBe("https://persisted.example.com");
    expect(onDisk.aliasToTarget["t7"].targetId).toBe("CDP-7");

    // Simulate a gateway restart: a brand new store instance pointed at the
    // same workspace should recover the alias link from disk.
    const store2 = new TabUrlStore(tmpDir);
    expect(store2.resolveTabUrl("t7")).toBe("https://persisted.example.com");
  });

  it("getSharedTabUrlStore returns the same instance for the same workspace", () => {
    const a = getSharedTabUrlStore(tmpDir);
    const b = getSharedTabUrlStore(tmpDir);
    expect(a).toBe(b);
  });

  it("pruneOlderThan removes stale entries and stops them from resolving", () => {
    const store = new TabUrlStore();
    store.recordTabs([{ targetId: "CDP-8", tabId: "t8", url: "https://example.com" }]);
    expect(store.resolveTabUrl("t8")).toBe("https://example.com");
    const pruned = store.pruneOlderThan(-1); // negative age → everything is "older"
    expect(pruned).toBeGreaterThan(0);
    expect(store.resolveTabUrl("t8")).toBeUndefined();
  });
});
