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
import { classifyUris, buildUriTrustConfig } from "../uri-trust.js";
import { getToolTrust } from "../trust-levels.js";

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

describe("uri-extractor: webrun (OpenAI native web tool)", () => {
  const extractors = buildUriExtractorMap();

  it("extracts the URL nested under action.url (the actual wire shape for an open_page call)", () => {
    const uris = extractToolSourceUris(
      "webrun",
      "webrun",
      { action: { type: "open_page", url: "https://example.com/page" } },
      extractors,
    );
    expect(uris).toEqual(["https://example.com/page"]);
  });

  it("also extracts a flat top-level url (in case a relay layer flattens it)", () => {
    const uris = extractToolSourceUris(
      "webrun",
      "webrun",
      { url: "https://example.com/flat" },
      extractors,
    );
    expect(uris).toEqual(["https://example.com/flat"]);
  });

  it("extracts nothing for a search action (queries, not a URL — falls back to the tool's default taint)", () => {
    const uris = extractToolSourceUris(
      "webrun",
      "webrun",
      { action: { type: "search", queries: ["site:github.com foo"] } },
      extractors,
    );
    expect(uris).toEqual([]);
  });

  it("with no URL extracted, falls back to webrun's own default (untrusted)", () => {
    const trust = getToolTrust("webrun");
    expect(trust).toBe("untrusted");
  });

  it("a URI-trust pattern match overrides webrun's default — the actual point of extraction", () => {
    // This is the end-to-end chain index.ts's after_tool_call runs: extract
    // -> classify the URI -> the URI's classification wins over the tool's
    // own default. A page on a pattern-matched domain resolves "trusted"
    // even though webrun's own default is "untrusted".
    const uriTrustConfig = buildUriTrustConfig({
      "https://docs.openclaw.ai/**": "trusted",
    });
    const uris = extractToolSourceUris(
      "webrun",
      "webrun",
      { action: { type: "open_page", url: "https://docs.openclaw.ai/some/page" } },
      extractors,
    );
    expect(uris).toEqual(["https://docs.openclaw.ai/some/page"]);
    const uriTrust = classifyUris(uris, uriTrustConfig);
    expect(uriTrust).toBe("trusted");
    // An unrelated domain matches only the built-in "https://**" catch-all
    // ("external"), never webrun's own "untrusted" default — the catch-all
    // covers every extracted http(s) URL. webrun's "untrusted" default only
    // matters when NO URL is extracted at all (e.g. its search action).
    const unmatchedUris = extractToolSourceUris(
      "webrun",
      "webrun",
      { action: { type: "open_page", url: "https://evil.example.com/phish" } },
      extractors,
    );
    expect(classifyUris(unmatchedUris, uriTrustConfig)).toBe("external");
  });
});

describe("uri-extractor: Write/Edit have no URI extraction (2026-08-30 Tank incident)", () => {
  const extractors = buildUriExtractorMap();
  const uriTrustConfig = buildUriTrustConfig();

  it("Write to a path outside the workspace extracts nothing, staying at its own trusted default", () => {
    // Regression: Write(file:///tmp/stratajam-ci-trust.json) previously
    // extracted the destination path as a URI, which matched the built-in
    // "file:///**" -> "shared" catch-all and overrode Write's correct
    // "trusted" tool-output default — even though Write's content flows
    // OUT (agent-authored), not in. Same bug class as the vestige-write/
    // memory_search omissions already documented in uri-extractor.ts.
    const uris = extractToolSourceUris(
      "Write",
      "Write",
      { file_path: "/tmp/stratajam-ci-trust.json" },
      extractors,
    );
    expect(uris).toEqual([]);
    expect(getToolTrust("Write")).toBe("trusted");
  });

  it("Edit to a path outside the workspace extracts nothing, staying at its own trusted default", () => {
    const uris = extractToolSourceUris(
      "Edit",
      "Edit",
      { file_path: "/tmp/stratajam-ci-policy.json" },
      extractors,
    );
    expect(uris).toEqual([]);
    expect(getToolTrust("Edit")).toBe("trusted");
  });

  it("Read is unaffected — still extracts a file:// URI for path-sensitive classification", () => {
    // Read brings existing file content INTO context, so it must stay
    // path-sensitive (a file outside the workspace might not be the
    // agent's own content). Only Write/Edit's directionality changed.
    const uris = extractToolSourceUris(
      "Read",
      "Read",
      { file_path: "/tmp/some-external-file.json" },
      extractors,
    );
    expect(uris).toEqual(["file:///tmp/some-external-file.json"]);
  });
});
