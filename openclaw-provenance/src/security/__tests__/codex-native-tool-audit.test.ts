import { describe, it, expect } from "vitest";
import { getToolTrust } from "../trust-levels.js";
import { extractToolSourceUris, buildUriExtractorMap } from "../uri-extractor.js";
import { classifyUris, buildUriTrustConfig } from "../uri-trust.js";

// Regression coverage for openclaw-provenance-4ob: a full audit of Codex's
// native tool surface (openai/codex source, core/src/tools/{spec_plan,
// handlers}/*.rs) against provenance's DEFAULT_TOOL_OUTPUT_TAINTS, done after
// sessions_search/computer/view_image tainted Tank's session three times in
// one evening (agent:tank:direct:eddie, 2026-08-29 12:28) with no entry in
// either direction. Every name below was confirmed reachable and unclassified
// before this fix; each is annotated with its Codex source registration.

describe("codex native tool audit — straightforwardly trusted (register_trusted / .add())", () => {
  const trustedNames = [
    "request_permissions",
    "curr_time",
    "sleep",
    "send_user_message_async",
    "new_context",
    "get_context_remaining",
    "list_available_plugins_to_install",
    "request_plugin_install",
    "tool_search",
    "wait_for_environment",
    "read_mcp_resource",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "request_user_input",
    "write_stdin",
    "exec_command",
  ];

  it.each(trustedNames)("%s is trusted", (name) => {
    expect(getToolTrust(name)).toBe("trusted");
  });
});

describe("codex native tool audit — sessions_search", () => {
  it("is trusted, same local-history family as sessions_list/sessions_history", () => {
    expect(getToolTrust("sessions_search")).toBe("trusted");
  });
});

describe("codex native tool audit — computer (hosted, reserved Responses namespace)", () => {
  it("defaults to untrusted, same registration path as webrun/web_search in Codex's own source", () => {
    // Codex's own tool description says outright: "The screen is untrusted."
    expect(getToolTrust("computer")).toBe("untrusted");
  });
});

describe("codex native tool audit — view_image (dual-implementation name)", () => {
  const extractors = buildUriExtractorMap();

  it("defaults to trusted (Codex's own native tool: local path only)", () => {
    expect(getToolTrust("view_image")).toBe("trusted");
  });

  it("extracts a local path as a file:// URI (consistent with Read/Write/Edit)", () => {
    const uris = extractToolSourceUris(
      "view_image",
      "view_image",
      { path: "/home/user/screenshot.png" },
      extractors,
    );
    expect(uris).toEqual(["file:///home/user/screenshot.png"]);
  });

  it("extracts multiple paths from the paths array param", () => {
    const uris = extractToolSourceUris(
      "view_image",
      "view_image",
      { paths: ["/tmp/a.png", "/tmp/b.png"] },
      extractors,
    );
    expect(uris).toEqual(["file:///tmp/a.png", "file:///tmp/b.png"]);
  });

  it("a remote URL (the hybrid OpenClaw-tool case) overrides trusted down to external", () => {
    // Codex's native view_image schema has no url field at all — this can
    // only happen via OpenClaw's own separate view_image MCP tool, which
    // does accept "one local image path or permitted URL". Since provenance
    // classifies by bare name and can't tell which implementation served a
    // given call, this is the safety net: any URL that does arrive under
    // this name gets independently reclassified, same as webrun.
    const uriTrustConfig = buildUriTrustConfig();
    const uris = extractToolSourceUris(
      "view_image",
      "view_image",
      { path: "https://evil.example.com/payload.png" },
      extractors,
    );
    expect(uris).toEqual(["https://evil.example.com/payload.png"]);
    expect(classifyUris(uris, uriTrustConfig)).toBe("external");
  });
});

describe("codex native tool audit — wait (Code Mode subsystem, missed in the first pass)", () => {
  it("is trusted — Code Mode's own polling primitive, not core-registry content", () => {
    // "wait" lives in a genuinely separate Codex subsystem (code-mode-
    // protocol/code-mode-host), not the core tool registry this audit
    // otherwise covers (spec_plan.rs/handlers/*.rs). Missed in the initial
    // pass even though raw evidence for it (repeated "function_call wait"
    // entries in rollout-log dumps) was already in hand at the time — see
    // openclaw-provenance-4ob. It waits on an async Code Mode runtime cell
    // finishing: pure control-flow, same category as sleep/
    // wait_for_environment/code_execution.
    expect(getToolTrust("wait")).toBe("trusted");
  });

  it("Code Mode's own submit-code tool ('exec') is already covered, confirming no gap", () => {
    // core/src/tools/code_mode/execute_handler.rs's PUBLIC_TOOL_NAME is
    // literally "exec" — already trusted via the exec/apply_patch block.
    expect(getToolTrust("exec")).toBe("trusted");
  });
});

describe("codex native tool audit — multi-agent orchestration v1 + v2 (2026-08-30 follow-up sweep)", () => {
  // PR #43 explicitly flagged the v2 handlers as an unconfirmed residual gap
  // ("could NOT be located via grep"). This sweep found and confirmed both
  // v1 (namespaced "multi_agent_v1") and v2 (plain names) — both actively
  // wired into spec_plan.rs, not dead code.
  const v1Names = [
    "multi_agent_v1wait_agent",
    "multi_agent_v1resume_agent",
    "multi_agent_v1send_input",
    "multi_agent_v1spawn_agent",
    "multi_agent_v1close_agent",
  ];
  it.each(v1Names)("%s is trusted", (name) => {
    expect(getToolTrust(name)).toBe("trusted");
  });

  const v2Names = [
    "interrupt_agent",
    "wait_agent",
    "followup_task",
    "spawn_agent",
    "list_agents",
    "send_message",
  ];
  it.each(v2Names)("%s is trusted", (name) => {
    expect(getToolTrust(name)).toBe("trusted");
  });
});

describe("codex native tool audit — ext/* extension crates (2026-08-30 follow-up sweep)", () => {
  const trustedExtNames = [
    "get_goal",
    "create_goal",
    "update_goal",
    "memorieslist",
    "memoriesread",
    "memoriessearch",
    "memoriesadd_ad_hoc_note",
    "historylist_windows",
    "historylist_items",
    "historyread_item",
    "historysearch_contents",
    "noteslist_files_by_prefix",
    "notesread_file",
    "notessearch_contents",
    "notesappend_to_file",
    "noteswrite_file",
    "image_genimagegen",
  ];
  it.each(trustedExtNames)("%s is trusted", (name) => {
    expect(getToolTrust(name)).toBe("trusted");
  });

  it("skillslist defaults to external — skills can be remote/plugin-installed, not blanket-trusted", () => {
    // ext/skills/src/catalog.rs's SkillSourceKind::Host doc comment lists
    // "downloaded/materialized remote skills" as a real source category.
    expect(getToolTrust("skillslist")).toBe("external");
  });

  it("skillsread defaults to external for the same reason (reading remote skill content)", () => {
    expect(getToolTrust("skillsread")).toBe("external");
  });

  it("web.run's ext/web-search registration resolves to the same webrun entry already covered", () => {
    // ext/web-search/src/tool.rs registers ToolName::namespaced("web", "run")
    // — identical wire name to the one already covered by PR #42.
    expect(getToolTrust("webrun")).toBe("untrusted");
  });
});
