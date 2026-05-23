import { describe, expect, it } from "vitest";
import {
  buildCompositeToolMap,
  resolveToolKey,
} from "../composite-tools.js";
import {
  buildUriExtractorMap,
  extractToolSourceUris,
  normalizeUri,
} from "../uri-extractor.js";
import { buildUriTrustConfig, classifyUris } from "../uri-trust.js";
import {
  buildToolOutputTaintMap,
  getToolTrust,
} from "../trust-levels.js";
import { buildPolicyConfig, getToolMode } from "../policy-engine.js";

describe("TweetClaw custom plugin configuration", () => {
  it("maps TweetClaw endpoint paths to virtual URIs", () => {
    expect(normalizeUri("/api/v1/x/tweets/search", undefined, "xquik")).toBe(
      "xquik://api/v1/x/tweets/search",
    );

    const toolKey = resolveToolKey(
      "tweetclaw",
      { path: "/api/v1/x/tweets/search" },
      buildCompositeToolMap({
        tweetclaw: { actionParam: "path" },
      }),
    );

    const sourceUris = extractToolSourceUris(
      toolKey,
      "tweetclaw",
      { path: "/api/v1/x/tweets/search" },
      buildUriExtractorMap({
        tweetclaw: {
          params: ["path"],
          absolutePathScheme: "xquik",
        },
      }),
    );

    expect(toolKey).toBe("tweetclaw./api/v1/x/tweets/search");
    expect(sourceUris).toEqual(["xquik://api/v1/x/tweets/search"]);
  });

  it("lets exact TweetClaw read policies override the tool-wide fallback", () => {
    const config = buildPolicyConfig(undefined, {
      tweetclaw: { "*": "confirm" },
      "tweetclaw./api/v1/x/tweets/search": { "*": "allow" },
    });

    expect(
      getToolMode("tweetclaw./api/v1/x/tweets/search", "trusted", config),
    ).toBe("allow");
    expect(
      getToolMode("tweetclaw./api/v1/x/tweets", "trusted", config),
    ).toBe("confirm");
  });

  it("uses bare TweetClaw output taint for endpoint composite keys", () => {
    const toolTaints = buildToolOutputTaintMap({
      tweetclaw: "external",
    });

    expect(
      getToolTrust("tweetclaw./api/v1/x/tweets/search", toolTaints),
    ).toBe("external");
  });

  it("classifies TweetClaw account endpoints more strictly than public reads", () => {
    const uriTrust = buildUriTrustConfig({
      "xquik://api/v1/x/accounts/**": "untrusted",
      "xquik://api/v1/x/tweets/**": "external",
      "xquik://api/v1/radar/**": "external",
    });

    expect(
      classifyUris(["xquik://api/v1/x/tweets/search"], uriTrust),
    ).toBe("external");
    expect(
      classifyUris(["xquik://api/v1/x/accounts/list"], uriTrust),
    ).toBe("untrusted");
  });
});
