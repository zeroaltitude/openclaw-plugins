import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractToolSourceUris,
  buildUriExtractorMap,
  recordTabUrls,
  resolveTabUrl,
  initTabUrlPersistence,
} from "../uri-extractor.js";

describe("uri-extractor: browser tab URL resolution", () => {
  let tmpDir: string;
  const extractors = buildUriExtractorMap();

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-uri-extractor-test-"));
    // Each test gets its own workspace-scoped tab URL store so tests don't
    // pollute each other's tab alias state through the shared module
    // singleton.
    initTabUrlPersistence(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("browser.snapshot with a raw targetId resolves via the tab URL map (pre-existing behavior)", () => {
    recordTabUrls([{ targetId: "CDP-1", url: "https://example.com" }]);
    const uris = extractToolSourceUris(
      "browser.snapshot",
      "browser",
      { targetId: "CDP-1" },
      extractors,
    );
    expect(uris).toEqual(["https://example.com"]);
  });

  it("browser.snapshot with a tabId-style alias in the targetId field resolves to the tab's URL (the reported bug)", () => {
    // browser.tabs / browser.open responses carry both the raw CDP targetId
    // and the friendly tabId alias (e.g. "t1"). The tool schema tells the
    // model to prefer sending the alias. Before the fix, resolveTabUrl
    // only ever recognized the raw targetId, so this returned [].
    recordTabUrls([{ targetId: "CDP-2", tabId: "t1", url: "https://trusted.example.com" }]);
    const uris = extractToolSourceUris(
      "browser.snapshot",
      "browser",
      { targetId: "t1" },
      extractors,
    );
    expect(uris).toEqual(["https://trusted.example.com"]);
  });

  it("browser.snapshot resolves when the alias is sent under a literal tabId param instead of targetId", () => {
    recordTabUrls([{ targetId: "CDP-3", tabId: "t2", url: "https://example.com/page" }]);
    const uris = extractToolSourceUris(
      "browser.snapshot",
      "browser",
      { tabId: "t2" },
      extractors,
    );
    expect(uris).toEqual(["https://example.com/page"]);
  });

  it("browser.open time populates the alias link (not only browser.tabs)", () => {
    // Simulates the after_tool_call handler recording a browser.open result,
    // which carries targetId + tabId + url together (BrowserOpenResult).
    recordTabUrls([{ targetId: "CDP-4", tabId: "t3", url: "https://opened.example.com" }]);
    expect(resolveTabUrl("t3")).toBe("https://opened.example.com");

    const uris = extractToolSourceUris(
      "browser.screenshot",
      "browser",
      { targetId: "t3" },
      extractors,
    );
    expect(uris).toEqual(["https://opened.example.com"]);
  });

  it("browser.navigate updates the URL an existing alias resolves to", () => {
    recordTabUrls([{ targetId: "CDP-5", tabId: "t4", url: "https://before-nav.example.com" }]);
    // browser.navigate's result never carries alias fields — only
    // {targetId, url}. This is the exact shape after_tool_call passes
    // through for a browser.navigate result.
    recordTabUrls([{ targetId: "CDP-5", url: "https://after-nav.example.com" }]);

    const uris = extractToolSourceUris(
      "browser.snapshot",
      "browser",
      { targetId: "t4" },
      extractors,
    );
    expect(uris).toEqual(["https://after-nav.example.com"]);
  });

  it("an unresolvable tab reference yields no source URIs (fails closed to the tool's default taint, not open)", () => {
    const uris = extractToolSourceUris(
      "browser.snapshot",
      "browser",
      { targetId: "t-never-seen" },
      extractors,
    );
    expect(uris).toEqual([]);
  });
});
