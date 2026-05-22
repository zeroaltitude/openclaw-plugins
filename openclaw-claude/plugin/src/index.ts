/**
 * openclaw-claude plugin entry point.
 *
 * Registers an AgentHarness that delegates Anthropic turns to a local
 * @zeroaltitude/openclaw-claude-bridge process spoken via codex-shaped JSON-RPC.
 * The server owns the agentic loop, persistence, approvals, tool dispatch,
 * and SDK streaming; the plugin is a thin bridge.
 */

import * as os from "node:os";
import * as path from "node:path";

import { createClaudeHarness } from "./harness.js";
import { ClaudeAppServerClient } from "./rpc.js";
import type {
  ApprovalPolicy,
  ClaudePluginConfig,
  PluginApi,
} from "./types.js";

const VALID_APPROVAL_POLICIES: ApprovalPolicy[] = [
  "never",
  "untrusted",
  "on-failure",
  "on-request",
];

const DEFAULT_STATE_PATH = path.join(
  process.env.HOME ?? os.homedir(),
  ".openclaw",
  "state",
  "claude-threads.json",
);

type ResolvedConfig = {
  bin: string;
  binArgs: string[];
  env: Record<string, string>;
  approvalPolicy: ApprovalPolicy;
  priority: number;
  turnTimeoutMs: number;
  turnIdleTimeoutMs: number;
  statePath: string;
};

const DEFAULTS: ResolvedConfig = {
  bin: "openclaw-claude-bridge",
  binArgs: [],
  env: {},
  // "never" mirrors the previous "bypassPermissions" behaviour: the server
  // skips canUseTool entirely and no approval round-trips occur. Operators
  // who want approvals can switch to "untrusted" or "on-request".
  approvalPolicy: "never",
  priority: 10,
  turnTimeoutMs: 600_000,
  turnIdleTimeoutMs: 90_000,
  statePath: DEFAULT_STATE_PATH,
};

function resolveConfig(raw: Record<string, unknown> | undefined): ResolvedConfig {
  const cfg = (raw ?? {}) as ClaudePluginConfig;
  const approvalPolicy = (cfg.approvalPolicy ?? DEFAULTS.approvalPolicy) as ApprovalPolicy;
  if (!VALID_APPROVAL_POLICIES.includes(approvalPolicy)) {
    throw new Error(
      `[claude] invalid approvalPolicy "${approvalPolicy}". Must be one of: ${VALID_APPROVAL_POLICIES.join(", ")}`,
    );
  }
  return {
    bin: cfg.bin ?? DEFAULTS.bin,
    binArgs: Array.isArray(cfg.binArgs) ? (cfg.binArgs as string[]) : DEFAULTS.binArgs,
    env: cfg.env ?? DEFAULTS.env,
    approvalPolicy,
    priority: typeof cfg.priority === "number" ? cfg.priority : DEFAULTS.priority,
    turnTimeoutMs:
      typeof cfg.turnTimeoutMs === "number" ? cfg.turnTimeoutMs : DEFAULTS.turnTimeoutMs,
    turnIdleTimeoutMs:
      typeof cfg.turnIdleTimeoutMs === "number"
        ? cfg.turnIdleTimeoutMs
        : DEFAULTS.turnIdleTimeoutMs,
    statePath: cfg.statePath ?? DEFAULTS.statePath,
  };
}

// OpenClaw requires plugin register to be synchronous — no top-level await.
export default function register(api: PluginApi): void {
  const cfg = resolveConfig(api.pluginConfig);

  api.logger.info("[claude] plugin registering", {
    bin: cfg.bin,
    approvalPolicy: cfg.approvalPolicy,
    priority: cfg.priority,
    statePath: cfg.statePath,
  });

  const client = new ClaudeAppServerClient({
    bin: cfg.bin,
    binArgs: cfg.binArgs,
    env: cfg.env,
    logger: api.logger,
  });

  const harness = createClaudeHarness({
    client,
    approvalPolicy: cfg.approvalPolicy,
    priority: cfg.priority,
    turnTimeoutMs: cfg.turnTimeoutMs,
    turnIdleTimeoutMs: cfg.turnIdleTimeoutMs,
    statePath: cfg.statePath,
    logger: api.logger,
  });

  api.registerAgentHarness(harness);
  api.logger.info("[claude] AgentHarness registered", { id: harness.id });
}
