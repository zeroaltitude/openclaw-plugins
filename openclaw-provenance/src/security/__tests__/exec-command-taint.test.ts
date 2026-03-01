import { describe, it, expect } from "vitest";
import {
  matchExecCommand,
  resolveExecToolKey,
  extractExecUris,
  buildExecCommandRules,
  buildExecOutputTaints,
  DEFAULT_EXEC_COMMAND_RULES,
} from "../exec-command-taint.js";

describe("matchExecCommand", () => {
  it("matches curl", () => {
    const rule = matchExecCommand("curl https://example.com");
    expect(rule?.key).toBe("curl");
    expect(rule?.outputTaint).toBe("external");
  });

  it("matches wget", () => {
    const rule = matchExecCommand("wget -O /tmp/file.html https://evil.com/payload");
    expect(rule?.key).toBe("wget");
  });

  it("matches agent-browser snapshot", () => {
    const rule = matchExecCommand("agent-browser snapshot");
    expect(rule?.key).toBe("agent-browser-snapshot");
    expect(rule?.outputTaint).toBe("external");
  });

  it("matches agent-browser open as trusted", () => {
    const rule = matchExecCommand("agent-browser open https://example.com");
    expect(rule?.key).toBe("agent-browser-open");
    expect(rule?.outputTaint).toBe("trusted");
  });

  it("matches agent-browser click as trusted action", () => {
    const rule = matchExecCommand("agent-browser click @e5");
    expect(rule?.key).toBe("agent-browser-action");
    expect(rule?.outputTaint).toBe("trusted");
  });

  it("matches ssh as shared", () => {
    const rule = matchExecCommand("ssh user@host ls -la");
    expect(rule?.key).toBe("ssh");
    expect(rule?.outputTaint).toBe("shared");
  });

  it("does not match python scripts (wrong layer)", () => {
    expect(matchExecCommand("python3 -c 'import requests; requests.get(\"https://api.example.com\")'")).toBeUndefined();
    expect(matchExecCommand("node -e 'fetch(\"https://example.com\")'")).toBeUndefined();
  });

  it("matches httpie", () => {
    const rule = matchExecCommand("http GET https://api.example.com/data");
    expect(rule?.key).toBe("httpie");
  });

  it("matches lynx", () => {
    const rule = matchExecCommand("lynx -dump https://example.com");
    expect(rule?.key).toBe("lynx");
  });

  it("does not match package managers (install logs, not injectable)", () => {
    expect(matchExecCommand("npm install some-package")).toBeUndefined();
    expect(matchExecCommand("npx some-package")).toBeUndefined();
    expect(matchExecCommand("pip install some-lib")).toBeUndefined();
  });

  it("returns undefined for safe commands (fail-working)", () => {
    expect(matchExecCommand("ls -la")).toBeUndefined();
    expect(matchExecCommand("git status")).toBeUndefined();
    expect(matchExecCommand("cat /etc/hostname")).toBeUndefined();
    expect(matchExecCommand("grep -r 'pattern' .")).toBeUndefined();
    expect(matchExecCommand("echo hello")).toBeUndefined();
  });

  it("matches curl in piped commands", () => {
    const rule = matchExecCommand("curl https://example.com | jq .");
    expect(rule?.key).toBe("curl");
  });

  it("matches curl with flags before URL", () => {
    const rule = matchExecCommand("curl -sS -H 'Accept: application/json' https://api.example.com/data");
    expect(rule?.key).toBe("curl");
  });

  it("does not match DNS tools (structured output, low injection risk)", () => {
    expect(matchExecCommand("dig example.com MX")).toBeUndefined();
    expect(matchExecCommand("nslookup example.com")).toBeUndefined();
    expect(matchExecCommand("whois example.com")).toBeUndefined();
  });
});

describe("resolveExecToolKey", () => {
  it("returns exec.curl for curl command", () => {
    expect(resolveExecToolKey({ command: "curl https://example.com" })).toBe("exec.curl");
  });

  it("returns exec for unmatched command", () => {
    expect(resolveExecToolKey({ command: "ls -la" })).toBe("exec");
  });

  it("returns exec for missing command param", () => {
    expect(resolveExecToolKey({})).toBe("exec");
  });

  it("returns exec for non-string command", () => {
    expect(resolveExecToolKey({ command: 42 })).toBe("exec");
  });
});

describe("extractExecUris", () => {
  it("extracts URLs from curl command", () => {
    const uris = extractExecUris({ command: "curl https://example.com/api/data" });
    expect(uris).toEqual(["https://example.com/api/data"]);
  });

  it("extracts multiple URLs", () => {
    const uris = extractExecUris({
      command: "curl https://api.example.com/a && curl https://evil.com/b",
    });
    expect(uris).toContain("https://api.example.com/a");
    expect(uris).toContain("https://evil.com/b");
  });

  it("extracts URLs from agent-browser snapshot", () => {
    const uris = extractExecUris({
      command: "agent-browser open https://news.ycombinator.com && agent-browser snapshot",
    });
    expect(uris).toContain("https://news.ycombinator.com");
  });

  it("returns empty for unmatched commands", () => {
    expect(extractExecUris({ command: "ls -la" })).toEqual([]);
  });

  it("returns empty for commands with uriExtraction: none", () => {
    expect(extractExecUris({ command: "ssh user@host" })).toEqual([]);
    expect(extractExecUris({ command: "dig example.com" })).toEqual([]);
  });

  it("returns empty for missing command", () => {
    expect(extractExecUris({})).toEqual([]);
  });
});

describe("buildExecCommandRules", () => {
  it("returns defaults with no overrides", () => {
    const rules = buildExecCommandRules();
    expect(rules.length).toBe(DEFAULT_EXEC_COMMAND_RULES.length);
  });

  it("prepends user rules", () => {
    const rules = buildExecCommandRules([
      {
        pattern: "\\bmy-custom-fetcher\\b",
        key: "custom-fetcher",
        outputTaint: "external",
      },
    ]);
    expect(rules.length).toBe(DEFAULT_EXEC_COMMAND_RULES.length + 1);
    expect(rules[0].key).toBe("custom-fetcher");

    // Verify the user rule actually works
    const result = resolveExecToolKey(
      { command: "my-custom-fetcher https://example.com" },
      rules,
    );
    expect(result).toBe("exec.custom-fetcher");
  });
});

describe("buildExecOutputTaints", () => {
  it("generates taint map from default rules", () => {
    const taints = buildExecOutputTaints();
    expect(taints["exec.curl"]).toBe("external");
    expect(taints["exec.wget"]).toBe("external");
    expect(taints["exec.agent-browser-snapshot"]).toBe("external");
    expect(taints["exec.agent-browser-screenshot"]).toBe("trusted");
    expect(taints["exec.agent-browser-open"]).toBe("trusted");
    expect(taints["exec.agent-browser-action"]).toBe("trusted");
    expect(taints["exec.ssh"]).toBe("shared");
  });
});
