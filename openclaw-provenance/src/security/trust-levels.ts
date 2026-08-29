/**
 * Trust level taxonomy for content provenance.
 *
 * Four levels, ordered from most trusted to least trusted:
 *   trusted  — system prompts, owner messages, local tool output
 *   shared   — cross-agent data (Vestige, shared memory)
 *   external — known external sources (email, Slack, calendar)
 *   untrusted — web content, unknown webhooks
 *
 * The previous six-level model (system/owner/local/shared/external/untrusted)
 * collapsed the top three into "trusted" because they all behaved identically.
 */

export type TrustLevel = "trusted" | "shared" | "external" | "untrusted";

/** Ordered from most trusted to least trusted */
export const TRUST_ORDER: TrustLevel[] = ["trusted", "shared", "external", "untrusted"];

/** Returns the lower (less trusted) of two trust levels */
export function minTrust(a: TrustLevel, b: TrustLevel): TrustLevel {
  const idxA = TRUST_ORDER.indexOf(a);
  const idxB = TRUST_ORDER.indexOf(b);
  return idxA >= idxB ? a : b; // higher index = lower trust
}

// ── Legacy 6-level mapping ──────────────────────────────────────────────────

/** Legacy trust level names from the old 6-level model */
export type LegacyTrustLevel =
  | "system"
  | "owner"
  | "local"
  | "shared"
  | "external"
  | "untrusted";

/** Map a legacy 6-level trust to the new 4-level model */
export function mapLegacyTrust(level: string): TrustLevel {
  switch (level) {
    case "trusted":
    case "system":
    case "owner":
    case "local":
      return "trusted";
    case "shared":
      return "shared";
    case "external":
      return "external";
    case "untrusted":
      return "untrusted";
    default:
      return "untrusted"; // unknown → untrusted (secure default)
  }
}

/** Check if a taint policy config uses legacy 6-level keys */
export function hasLegacyKeys(
  policy: Record<string, unknown>,
): boolean {
  return ["system", "owner", "local"].some((k) => k in policy);
}

/**
 * Map a legacy 6-level taint policy to 4-level.
 * For trusted: uses the most permissive of system/owner/local (they should all be "allow").
 * Returns the mapped policy and any warnings.
 */
export function mapLegacyTaintPolicy(
  legacy: Record<string, string>,
): { mapped: Record<string, string>; warnings: string[] } {
  const warnings: string[] = [];
  const mapped: Record<string, string> = {};

  if (hasLegacyKeys(legacy)) {
    warnings.push(
      "taintPolicy uses deprecated 6-level keys (system/owner/local). " +
        "These are mapped to 'trusted' automatically. Please update to 4-level format.",
    );
    // Pick the most permissive of system/owner/local for "trusted"
    const MODE_ORDER = ["allow", "confirm", "restrict"];
    const candidates = ["system", "owner", "local"]
      .map((k) => legacy[k])
      .filter(Boolean);
    if (candidates.length > 0) {
      mapped.trusted = candidates.reduce((a, b) =>
        MODE_ORDER.indexOf(a) <= MODE_ORDER.indexOf(b) ? a : b,
      );
    }
  }

  // Pass through 4-level keys
  if (legacy.trusted) mapped.trusted = legacy.trusted;
  if (legacy.shared) mapped.shared = legacy.shared;
  if (legacy.external) mapped.external = legacy.external;
  if (legacy.untrusted) mapped.untrusted = legacy.untrusted;

  return { mapped, warnings };
}

/**
 * Map legacy 6-level tool override keys to 4-level.
 * system/owner/local keys → "trusted". shared/external/untrusted pass through.
 */
export function mapLegacyToolOverride(
  override: Record<string, string>,
): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(override)) {
    if (key === "system" || key === "owner" || key === "local") {
      // Use the most permissive if multiple legacy keys map to trusted
      const MODE_ORDER = ["allow", "confirm", "restrict"];
      if (
        !mapped.trusted ||
        MODE_ORDER.indexOf(value) < MODE_ORDER.indexOf(mapped.trusted)
      ) {
        mapped.trusted = value;
      }
    } else {
      mapped[key] = value;
    }
  }
  return mapped;
}

// ── Tool output taint classifications ───────────────────────────────────────

/**
 * Default tool output taint classifications.
 *
 * Each entry maps a tool name to the trust level of its *output* —
 * i.e., the taint that its response introduces into the context.
 * This is independent of whether the tool is safe to *call*.
 *
 * These defaults can be overridden via the `toolOutputTaints` config block.
 * Unknown tools default to "untrusted".
 */
export const DEFAULT_TOOL_OUTPUT_TAINTS: Record<string, TrustLevel> = {
  // ── Trusted operations ────────────────────────────────────────────
  Read: "trusted",
  Edit: "trusted",
  Write: "trusted",
  // dir_list / dir_fetch / file_fetch / file_write: read or write to paired
  // nodes the owner has provisioned. All four are policy-gated by
  // gateway.nodes.allowCommands plus per-node allowReadPaths/allowWritePaths;
  // unconfigured calls are denied. Treating their output as untrusted by
  // default poisons agent heartbeat watermarks (see
  // provenance:agent:<id>:<channel>:heartbeat) without protecting anything
  // the policy layer hasn't already authorized.
  dir_list: "trusted",
  dir_fetch: "trusted",
  file_fetch: "trusted",
  file_write: "trusted",
  // apply_patch and edit are SDK-native file-edit primitives used by both
  // codex and claude harnesses (apply_patch is codex's edit tool;
  // edit is openclaw's bundled write tool). Their output is patch-result
  // metadata, not external data — same shape as file_write above. Treating
  // them as untrusted-by-default was inconsistent and meant every
  // file-editing turn silently tainted its session (visible as "tool
  // output: apply_patch" in /provenance across every agent doing coding).
  apply_patch: "trusted",
  edit: "trusted",
  exec: "trusted",
  process: "trusted",

  // ── Claude SDK native tools (trusted: agent-local primitives) ────
  // Output trust is *not* the same as execute trust. These tools'
  // outputs are under user control via OpenClaw's execute management
  // system (tool-policy allow/disallow, sandbox modes, approval
  // gates). The provenance plugin defers the "should this tool run?"
  // question to that system and only judges where output came from
  // for downstream context-influence purposes. For agent-local file
  // edits / shell exec / search / planning, the output's origin is
  // the agent's own execution context — trusted-by-default is the
  // right architectural answer. Web tools (WebFetch/WebSearch) stay
  // untrusted because their output crosses a real trust boundary.
  Bash: "trusted",
  Glob: "trusted",
  Grep: "trusted",
  MultiEdit: "trusted",
  NotebookEdit: "trusted",
  NotebookRead: "trusted",
  TodoWrite: "trusted",
  Task: "trusted", // codex parallel: sessions_spawn (also trusted above)
  spawn_agent: "trusted", // native Codex subagent spawn result; agent-local orchestration
  ExitPlanMode: "trusted",
  // Claude Code SDK harness-internal tools — not external MCP, not user data.
  // These are harness primitives whose output is agent-local state, owner input,
  // or schedule/task metadata — none cross an external trust boundary.
  Agent: "trusted",       // native subagent tool (inline reasoning, not cross-agent)
  Skill: "trusted",       // skill invocation — agent-local orchestration; external content a skill pulls in is tainted at the specific tool it calls (e.g. web_fetch)
  ToolSearch: "trusted",  // deferred tool schema loader (returns tool definitions, not external content)
  AskUserQuestion: "trusted", // owner's answer to an agent-posed question — owner input, not external content
  EnterPlanMode: "trusted",   // plan-mode lifecycle (matches ExitPlanMode)
  EnterWorktree: "trusted",   // worktree lifecycle — harness state transition
  ExitWorktree: "trusted",
  TaskCreate: "trusted",      // subagent task management; subagents are agent-local
  TaskGet: "trusted",
  TaskList: "trusted",
  TaskOutput: "trusted",      // returns agent-local subagent results
  TaskStop: "trusted",
  TaskUpdate: "trusted",
  CronCreate: "trusted",      // schedule management (matches the cron tool)
  CronDelete: "trusted",
  CronList: "trusted",
  ScheduleWakeup: "trusted",  // self-wake scheduler (dynamic /loop); output is a delay/confirmation echo — same category as CronCreate
  Monitor: "trusted",         // background process/condition watcher; output is status
  PushNotification: "trusted",// sends a notification; output is an ack
  RemoteTrigger: "trusted",   // harness primitive to trigger remote actions; owner-controlled
  DesignSync: "trusted",      // harness design-sync lifecycle primitive; output is a state transition, no external boundary
  // Workflow runs a multi-agent orchestration script; its output is agent-local
  // orchestration results (the same category as Task/TaskOutput/Agent above).
  // External content a workflow pulls in is tainted at the specific tool the
  // workflow calls (e.g. web_fetch), not here — mirroring the Skill rationale.
  Workflow: "trusted",
  // ShareOnboardingGuide uploads the local ONBOARDING.md and returns a share
  // link + status. Output is an agent-local action ack (a URL we generated),
  // not inbound external content — same shape as PushNotification's ack.
  ShareOnboardingGuide: "trusted",
  ListMcpResourcesTool: "trusted",
  ReadMcpResourceTool: "trusted",
  tts: "trusted",
  cron: "trusted",
  sessions_spawn: "trusted",
  sessions_send: "trusted",
  sessions_list: "trusted",
  sessions_history: "trusted",
  sessions_yield: "trusted",
  // sessions_search: same local-history family as sessions_list/history above.
  // Missing here is what actually blocked Tank on 2026-08-29 (watermark
  // "tool output: sessions_search, sessions_search, sessions_search, computer,
  // view_image") — see openclaw-provenance-4ob's full Codex-native audit.
  sessions_search: "trusted",
  agents_list: "trusted",
  nodes: "trusted",
  canvas: "trusted",
  gateway: "trusted",
  heartbeat_respond: "trusted",
  session_status: "trusted",
  subagents: "trusted",
  update_plan: "trusted",
  // skill_workshop: built-in skill authoring tool (create/update/review/apply
  // skill proposals). Output is proposal metadata, agent-local orchestration —
  // same category as Skill above. External content a proposal pulls in is
  // tainted at the specific tool that fetched it (e.g. web_fetch), not here.
  skill_workshop: "trusted",

  // ── Local wiki vault (trusted: on-machine markdown vault, owner-controlled) ──
  wiki_status: "trusted",
  wiki_search: "trusted",
  wiki_get: "trusted",
  wiki_lint: "trusted",
  wiki_apply: "trusted",

  // ── Local memory (trusted: writes are guarded, so reads are safe) ──
  memory_search: "trusted",
  memory_get: "trusted",

  // ── Local project-analysis (understand_*) — read-only, agent-local ──
  // These tools analyze on-machine project state (status, code search, node
  // graph, project registry). Their output is agent-local, not inbound
  // external content — same category as memory_search / wiki_search above.
  // They MUST be enumerated here because on the native Claude Code harness
  // they arrive under BARE names (understand_status, not
  // mcp__openclaw__understand_status), so they miss the mcp__openclaw__
  // prefix fallback and hit the "untrusted" secure-default in getToolTrust().
  // Left unmapped, a single read-only understand_status call re-taints the
  // session every turn (escalatedBy="tool output: understand_status"),
  // silently overriding /reset-trust and /approve-exec approvals on the next
  // turn. Same bug class as commit c69e13f ("local tool taints") — a
  // read-only local tool family classified untrusted only because it reaches
  // the trust layer bare on the native harness.
  understand_status: "trusted",
  understand_search: "trusted",
  understand_analyze_project: "trusted",
  understand_get_node: "trusted",
  understand_list_projects: "trusted",

  // ── Additional OpenClaw native tools — owner-controlled output ──
  // pdf: classified trusted on the basis that the owner only parses PDFs
  // they have intentionally opened. If you ever ingest PDFs from external
  // channels (email/Slack/web), reclassify this to "external".
  pdf: "trusted",
  meeting_notes: "trusted",
  qqbot_remind: "trusted",

  // ── Shared (cross-agent memory) ───────────────────────────────────
  vestige_search: "trusted", // local cognitive memory; default trusted (override if shared)
  vestige_smart_ingest: "trusted", // write-only, output is confirmation
  vestige_ingest: "trusted", // write-only, output is confirmation
  vestige_promote: "trusted", // write-only, output is confirmation
  vestige_demote: "trusted", // write-only, output is confirmation
  vestige_dream: "trusted", // local memory consolidation; output is insights
  vestige_consolidate: "trusted", // FSRS-6 maintenance cycle; output is stats
  vestige_importance_score: "trusted", // scoring helper; no external data
  vestige_explore_connections: "trusted", // graph traversal of local memory
  vestige_predict: "trusted", // prediction from local memory state
  vestige_session_context: "trusted", // combined session init from local memory
  vestige_backup: "trusted", // local SQLite VACUUM INTO; output is path/status
  // Legacy/generated OpenClaw Vestige tool aliases. Some dynamic-tool surfaces
  // flatten the plugin namespace into the tool name (openclawvestige_*), so
  // keep these as trusted siblings of the canonical vestige_* entries.
  openclawvestige_search: "trusted",
  openclawvestige_smart_ingest: "trusted",
  openclawvestige_ingest: "trusted",
  openclawvestige_promote: "trusted",
  openclawvestige_demote: "trusted",
  openclawvestige_dream: "trusted",
  openclawvestige_consolidate: "trusted",
  openclawvestige_importance_score: "trusted",
  openclawvestige_explore_connections: "trusted",
  openclawvestige_predict: "trusted",
  openclawvestige_session_context: "trusted",
  openclawvestige_backup: "trusted",

  // ── External sources ──────────────────────────────────────────────
  message: "external", // channel messages contain external content

  // ── message subtools: internal platform metadata (shared by default; deployments can elevate) ──
  "message.member-info": "shared",      // guild member data; internal platform metadata
  "message.channel-members": "shared",  // channel membership; internal platform metadata
  "message.channel-info": "shared",     // channel metadata; internal platform
  "message.channel-list": "shared",     // channel listing; internal platform
  "message.role-info": "shared",        // role metadata; internal platform

  gog: "external", // email/calendar content
  image: "external", // analyzing external images

  // ── claude.ai MCP Slack integration ──────────────────────────────────────
  // Read/search tools return Slack message content — same trust bucket as
  // gog/message (known external source, not raw web crawl).
  // Write/create tools return confirmation metadata only — no external content.
  "mcp__claude_ai_Slack__slack_read_channel": "external",
  "mcp__claude_ai_Slack__slack_read_thread": "external",
  "mcp__claude_ai_Slack__slack_read_canvas": "external",
  "mcp__claude_ai_Slack__slack_read_user_profile": "external",
  "mcp__claude_ai_Slack__slack_search_channels": "external",
  "mcp__claude_ai_Slack__slack_search_public": "external",
  "mcp__claude_ai_Slack__slack_search_public_and_private": "external",
  "mcp__claude_ai_Slack__slack_search_users": "external",
  "mcp__claude_ai_Slack__slack_send_message": "trusted",
  "mcp__claude_ai_Slack__slack_send_message_draft": "trusted",
  "mcp__claude_ai_Slack__slack_schedule_message": "trusted",
  "mcp__claude_ai_Slack__slack_create_canvas": "trusted",
  "mcp__claude_ai_Slack__slack_update_canvas": "trusted",

  // ── Generative media (trusted: output is model-generated, not fetched externally) ──
  image_generate: "trusted",
  music_generate: "trusted",
  video_generate: "trusted",

  // ── Runtime execution (trusted: agent-local, same as exec/process) ────────
  code_execution: "trusted",

  // ── External social / web ─────────────────────────────────────────────────
  // x_search returns X/Twitter content — user-generated external content,
  // same trust bucket as gog/message (known external source, not raw web crawl).
  x_search: "external",

  // ── Untrusted / web ───────────────────────────────────────────────
  web_fetch: "untrusted",
  web_search: "untrusted",
  web_search_preview: "untrusted", // Codex preview variant of web_search
  // Claude SDK uses CamelCase tool names for these:
  WebFetch: "untrusted",
  WebSearch: "untrusted",
  browser: "untrusted",
  // "computer" is a RESERVED_RESPONSES_NAMESPACES entry in Codex's own source
  // (openai/codex, app-server/src/request_processors/thread_processor.rs) —
  // a hosted, provider-executed computer-use tool, registered via
  // registry.register_external(...) in Codex's own tool spec (core/src/tools/
  // spec_plan.rs), the SAME registration path as its standalone web.run/
  // web_search tool. Its own schema description says outright: "The screen is
  // untrusted." Same conservative default as its web_fetch/web_search/webrun
  // siblings — genuinely renders external, possibly adversarial on-screen
  // content, never blanket-trust this (openclaw-provenance-4ob).
  computer: "untrusted",

  // ── Codex native tools (audited against openai/codex source, 2026-08-29:
  // core/src/tools/handlers/*.rs, core/src/tools/spec_plan.rs) ─────────────
  // Every entry below is registered in Codex's OWN source via registry.add()/
  // register_trusted*(), which Codex's own ToolRegistry::add() defines as a
  // convenience wrapper over register_trusted (registry.rs). Same
  // architectural category as apply_patch/exec above: first-party Codex
  // primitives, output is agent-local state or harness metadata, not
  // externally-sourced content. Discovered via openclaw-provenance-4ob after
  // sessions_search/computer/view_image left unclassified tainted Tank's
  // session (agent:tank:direct:eddie, 2026-08-29 12:28) three incidents in a
  // row on one evening — this block exists to stop finding these one at a time.
  request_permissions: "trusted", // core/src/tools/handlers/request_permissions.rs
  curr_time: "trusted", // clock.curr_time — core/src/tools/handlers/current_time.rs
  sleep: "trusted", // clock.sleep — core/src/tools/handlers/sleep.rs
  send_user_message_async: "trusted", // core/src/tools/handlers/send_user_message_async.rs
  new_context: "trusted", // core/src/tools/handlers/new_context_window.rs
  get_context_remaining: "trusted", // core/src/tools/handlers/get_context_remaining.rs
  list_available_plugins_to_install: "trusted", // core/src/tools/handlers/list_available_plugins_to_install.rs
  request_plugin_install: "trusted", // core/src/tools/handlers/request_plugin_install.rs
  tool_search: "trusted", // core/src/tools/handlers/tool_search.rs
  wait_for_environment: "trusted", // core/src/tools/handlers/wait_for_environment.rs
  read_mcp_resource: "trusted", // core/src/tools/handlers/mcp_resource/read_mcp_resource.rs
  list_mcp_resources: "trusted", // core/src/tools/handlers/mcp_resource/list_mcp_resources.rs
  list_mcp_resource_templates: "trusted", // core/src/tools/handlers/mcp_resource/list_mcp_resource_templates.rs
  request_user_input: "trusted", // core/src/tools/handlers/request_user_input.rs
  write_stdin: "trusted", // core/src/tools/handlers/unified_exec/write_stdin.rs — same exec family as exec_command below
  exec_command: "trusted", // core/src/tools/handlers/unified_exec/exec_command.rs — same family as exec/Bash above
  // view_image: Codex's OWN native tool (core/src/tools/handlers/
  // view_image_spec.rs) only ever accepts a LOCAL filesystem `path` — its
  // schema literally has no url field, description: "View a local image file
  // from the filesystem... images already available on disk." Genuinely as
  // safe as Read/Write/Edit above, and registered via .add() (= trusted) in
  // Codex's own source. OpenClaw ALSO has its own separate view_image MCP
  // tool sharing this exact name, which DOES accept a remote URL — it gets
  // filtered out whenever Codex's native image inspection is active
  // (extensions/codex/src/app-server/vision-tools.ts), which is the common
  // case, but provenance classifies by bare name and can't tell which
  // implementation actually served a given call. See uri-extractor.ts's
  // "view_image" entry: if a URL ever does reach this name (the hybrid
  // OpenClaw-tool case), extraction+uri-trust classification overrides this
  // "trusted" default down to "external" via the built-in https://** catch-all,
  // exactly like it does for webrun — this default only actually governs the
  // common, genuinely-local case.
  view_image: "trusted",
};

// Legacy alias for backward compatibility
export const DEFAULT_TOOL_TRUST = DEFAULT_TOOL_OUTPUT_TAINTS;

// ── MCP-namespaced tool name handling ──────────────────────────────────────
//
// When Claude or Codex calls an OpenClaw tool via an MCP server, the tool
// name arrives prefixed with the MCP server identifier — e.g.,
// `mcp__openclaw__sessions_spawn` (claude extension's openclaw bridge) or
// `mcp__codex_apps__github_list_installed_account_repositories` (codex's
// app marketplace tools).
//
// Two recognition rules are applied during getToolTrust():
//   1. Strip the MCP prefix and try the bare name in the trust map first —
//      this routes `mcp__openclaw__sessions_spawn` to the existing
//      `sessions_spawn: "trusted"` entry without duplicating entries per
//      namespace.
//   2. If the bare name has no entry, fall back to the per-prefix default
//      below — for known trusted MCP namespaces this means "trusted"
//      rather than the global "untrusted" fallback.
//
// The two prefixes default to "trusted" because they're owned by OpenClaw
// integration code (the claude extension's dynamic-tools bridge and codex's
// own app server). Adding a third-party MCP server's tools would require
// explicit overrides via the `toolOutputTaints` config block.
//
// Note: mcp__claude_ai__* is intentionally absent from this list. That
// namespace includes external productivity integrations (Gmail, Calendar,
// Slack, Granola, etc.) whose outputs contain real external data — email
// bodies, calendar events, Slack messages — and should remain untrusted
// or external. Blanket-trusting the whole namespace would suppress taint
// on genuine external content. Tools in that namespace that are truly
// internal can be added to DEFAULT_TOOL_OUTPUT_TAINTS individually.
const MCP_PREFIX_DEFAULTS: ReadonlyArray<[string, TrustLevel]> = [
  ["mcp__openclaw__", "trusted"],
  ["mcp__codex_apps__", "trusted"],
];

/** Recognized MCP namespace prefixes (OpenClaw bridge, codex app server). */
export const KNOWN_MCP_PREFIXES: readonly string[] = MCP_PREFIX_DEFAULTS.map(
  ([prefix]) => prefix,
);

/**
 * If `toolName` carries a recognized MCP namespace prefix, return the bare
 * name with that prefix stripped; otherwise return undefined. Used by composite
 * key resolution so that bridge-routed composites (e.g. `mcp__openclaw__message`)
 * still resolve their `.action` subtool keys instead of collapsing to the bare
 * external default.
 */
export function stripKnownMcpPrefix(toolName: string): string | undefined {
  for (const prefix of KNOWN_MCP_PREFIXES) {
    if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  }
  return undefined;
}

// ── Taint policy ────────────────────────────────────────────────────────────

// "confirm" is accepted on input for backward compatibility but normalized to
// "restrict" (see normalizePolicyMode in policy-engine.ts). Two canonical modes:
// allow (run) and restrict (block, owner-overridable via /approve-exec).
export type TaintPolicyMode = "allow" | "restrict" | "confirm";

export interface TaintPolicyConfig {
  /** Policy for trusted content — system, owner, local (default: allow) */
  trusted?: TaintPolicyMode;
  /** Policy for shared/cross-agent data (default: restrict) */
  shared?: TaintPolicyMode;
  /** Policy for external sources (default: restrict) */
  external?: TaintPolicyMode;
  /** Policy for untrusted content (default: restrict) */
  untrusted?: TaintPolicyMode;
}

export const DEFAULT_TAINT_POLICY: Required<TaintPolicyConfig> = {
  trusted: "allow",
  shared: "restrict",
  external: "restrict",
  untrusted: "restrict",
};

/**
 * Build a resolved tool output taint map by merging defaults with config overrides.
 * Call once at startup; pass the result to getToolTrust() for each lookup.
 */
export function buildToolOutputTaintMap(
  overrides?: Record<string, TrustLevel | string>,
): Record<string, TrustLevel> {
  const base = { ...DEFAULT_TOOL_OUTPUT_TAINTS };
  if (!overrides || Object.keys(overrides).length === 0) {
    return base;
  }
  // Map any legacy trust level names in overrides
  for (const [tool, level] of Object.entries(overrides)) {
    base[tool] = mapLegacyTrust(level);
  }
  return base;
}

/**
 * Get trust level for a tool's output. Uses a pre-merged map if provided, otherwise defaults.
 * Unknown tools (not in defaults or overrides) default to "untrusted" — this prevents
 * tool rename attacks where a dangerous tool is re-registered under an unlisted name.
 */
export function getToolTrust(
  toolName: string,
  resolvedMap?: Record<string, TrustLevel>,
): TrustLevel {
  // Exact match first (fast path)
  if (resolvedMap?.[toolName]) return resolvedMap[toolName];
  if (DEFAULT_TOOL_OUTPUT_TAINTS[toolName])
    return DEFAULT_TOOL_OUTPUT_TAINTS[toolName];

  // Case-insensitive fallback: tool names from LLM responses may differ in
  // casing from the trust map (e.g. "edit" vs "Edit", "read" vs "Read").
  const lower = toolName.toLowerCase();
  if (resolvedMap) {
    for (const [key, value] of Object.entries(resolvedMap)) {
      if (key.toLowerCase() === lower) return value;
    }
  }
  for (const [key, value] of Object.entries(DEFAULT_TOOL_OUTPUT_TAINTS)) {
    if (key.toLowerCase() === lower) return value;
  }

  // Composite key fallback: plugin tools can resolve to keys such as
  // tweetclaw./api/v1/x/tweets/search while sharing a bare tool taint.
  if (lower.includes(".")) {
    const bareName = lower.slice(0, lower.indexOf("."));
    // Exact and case-insensitive composite-key lookup already missed above.
    if (resolvedMap) {
      for (const [key, value] of Object.entries(resolvedMap)) {
        if (key.toLowerCase() === bareName) return value;
      }
    }
    for (const [key, value] of Object.entries(DEFAULT_TOOL_OUTPUT_TAINTS)) {
      if (key.toLowerCase() === bareName) return value;
    }
  }

  // MCP-namespaced lookup: strip the prefix and try the bare name, then
  // fall back to the per-prefix default for known trusted namespaces.
  for (const [prefix, prefixDefault] of MCP_PREFIX_DEFAULTS) {
    if (!toolName.startsWith(prefix)) continue;
    const bareName = toolName.slice(prefix.length);
    if (resolvedMap?.[bareName]) return resolvedMap[bareName];
    if (DEFAULT_TOOL_OUTPUT_TAINTS[bareName]) return DEFAULT_TOOL_OUTPUT_TAINTS[bareName];
    const bareLower = bareName.toLowerCase();
    // MCP prefixes are stripped only after non-namespaced composite fallbacks miss.
    if (resolvedMap) {
      for (const [key, value] of Object.entries(resolvedMap)) {
        if (key.toLowerCase() === bareLower) return value;
      }
    }
    for (const [key, value] of Object.entries(DEFAULT_TOOL_OUTPUT_TAINTS)) {
      if (key.toLowerCase() === bareLower) return value;
    }
    return prefixDefault;
  }

  return "untrusted";
}
