/**
 * `thread/start` handler. Allocates a new thread record on disk and returns
 * the codex-shaped ThreadStartResponse the plugin will validate via ajv.
 *
 * Per codex's protocol, `thread/start` does NOT run the first turn — the
 * client follows up with `turn/start`. We only persist metadata here.
 */

import {
  isJsonObject,
  RPC_INVALID_PARAMS,
  type AskForApproval,
  type ApprovalsReviewer,
  type DynamicToolSpec,
  type JsonValue,
  type SandboxPolicyResponse,
  type Thread,
  type ThreadStartParams,
  type ThreadStartResponse,
} from "../protocol.js";
import { RpcError } from "../server.js";
import { ANTHROPIC_PROVIDER_ID, defaultModelId, isKnownModel } from "../models.js";
import type { ThreadStore } from "../thread-store.js";
import type { Logger } from "../transport.js";
import { validateOutbound } from "../validators.js";
import { OPENCLAW_CLAUDE_APP_SERVER_VERSION } from "../version.js";

export function createThreadStartHandler(threadStore: ThreadStore, logger: Logger) {
  return async function handleThreadStart(rawParams: JsonValue | undefined): Promise<JsonValue> {
    const params = parseThreadStartParams(rawParams);

    const model = pickModel(params.model);
    const modelProvider = params.modelProvider ?? ANTHROPIC_PROVIDER_ID;
    const cwd = params.cwd ?? process.cwd();
    const approvalPolicy = resolveApprovalPolicy(params.approvalPolicy);
    const approvalsReviewer = resolveApprovalsReviewer(params.approvalsReviewer);
    const sandbox = resolveSandbox(params.sandbox);

    const dynamicTools = normalizeDynamicTools(params.dynamicTools);
    const mcpServersConfig = extractMcpServersConfig(params.config);

    const meta = await threadStore.createThread({
      cwd,
      model,
      modelProvider,
      approvalPolicy,
      approvalsReviewer,
      sandbox,
      serviceTier: params.serviceTier ?? null,
      developerInstructions: params.developerInstructions,
      dynamicTools: dynamicTools.length > 0 ? dynamicTools : undefined,
      mcpServersConfig,
      cliVersion: OPENCLAW_CLAUDE_APP_SERVER_VERSION,
    });

    const thread: Thread = {
      id: meta.id,
      sessionId: meta.sessionId,
      cliVersion: meta.cliVersion,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      cwd: meta.cwd,
      ephemeral: meta.ephemeral,
      modelProvider: meta.modelProvider,
      preview: "",
      source: meta.source,
      status: { type: "idle" },
      turns: [],
    };

    const response: ThreadStartResponse = {
      thread,
      model: meta.model,
      modelProvider: meta.modelProvider,
      cwd: meta.cwd,
      approvalPolicy: meta.approvalPolicy,
      approvalsReviewer: meta.approvalsReviewer,
      sandbox: meta.sandbox,
      serviceTier: meta.serviceTier ?? null,
      instructionSources: [],
      runtimeWorkspaceRoots: [],
    };

    validateOutbound("threadStart", response, logger);
    logger.info("[thread/start] created", {
      threadId: meta.id,
      model: meta.model,
      cwd: meta.cwd,
    });
    return response as unknown as JsonValue;
  };
}

function parseThreadStartParams(raw: JsonValue | undefined): ThreadStartParams {
  if (!isJsonObject(raw)) {
    throw new RpcError(RPC_INVALID_PARAMS, "thread/start requires an object params");
  }
  return raw as ThreadStartParams;
}

function pickModel(requested: string | undefined): string {
  if (!requested) return defaultModelId();
  if (!isKnownModel(requested)) {
    // We don't reject — the SDK may still accept a model id we don't have in
    // our static catalog (Anthropic ships new ones; we'd rather be permissive
    // than block until our catalog catches up).
    return requested;
  }
  return requested;
}

function resolveApprovalPolicy(raw: ThreadStartParams["approvalPolicy"]): AskForApproval {
  if (typeof raw === "string") {
    if (raw === "untrusted" || raw === "on-failure" || raw === "on-request" || raw === "never") {
      return raw;
    }
    // Unknown string; codex defaults to untrusted, mirror that.
    return "untrusted";
  }
  if (isJsonObject(raw) && isJsonObject(raw.granular)) {
    return raw as unknown as AskForApproval;
  }
  return "untrusted";
}

function resolveApprovalsReviewer(raw: string | null | undefined): ApprovalsReviewer {
  if (raw === "user" || raw === "auto_review" || raw === "guardian_subagent") return raw;
  return "user";
}

function extractMcpServersConfig(rawConfig: unknown): import("../protocol.js").JsonObject | undefined {
  if (!isJsonObject(rawConfig)) return undefined;
  // Codex sends snake_case `mcp_servers`. We tolerate camelCase `mcpServers`
  // too so non-codex clients have a reasonable on-ramp.
  const raw = rawConfig.mcp_servers ?? rawConfig.mcpServers;
  if (!isJsonObject(raw)) return undefined;
  return raw as import("../protocol.js").JsonObject;
}

function normalizeDynamicTools(raw: unknown): DynamicToolSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: DynamicToolSpec[] = [];
  for (const t of raw) {
    if (
      t &&
      typeof t === "object" &&
      typeof (t as { name?: unknown }).name === "string" &&
      typeof (t as { description?: unknown }).description === "string"
    ) {
      out.push(t as DynamicToolSpec);
    }
  }
  return out;
}

function resolveSandbox(raw: ThreadStartParams["sandbox"]): SandboxPolicyResponse {
  if (isJsonObject(raw) && typeof raw.type === "string") {
    return raw as unknown as SandboxPolicyResponse;
  }
  if (typeof raw === "string") {
    // Codex sometimes passes a string sandbox; normalize to discriminated.
    return { type: raw };
  }
  return { type: "dangerFullAccess" };
}
