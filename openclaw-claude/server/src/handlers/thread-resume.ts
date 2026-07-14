/**
 * `thread/resume` handler. Reads thread metadata + transcript from disk and
 * returns the codex-shaped ThreadResumeResponse. The actual transcript
 * replay into a new SDK session happens on the next `turn/start`.
 */

import {
  isJsonObject,
  RPC_INVALID_PARAMS,
  type JsonValue,
  type Thread,
  type ThreadResumeParams,
  type ThreadResumeResponse,
  type Turn,
} from "../protocol.js";
import { RpcError } from "../server.js";
import { derivePreview, metaToThread } from "../thread-mapper.js";
import type { ThreadStore } from "../thread-store.js";
import type { Logger } from "../transport.js";
import { validateOutbound } from "../validators.js";

const THREAD_NOT_FOUND_CODE = -32004;

export function createThreadResumeHandler(threadStore: ThreadStore, logger: Logger) {
  return async function handleThreadResume(rawParams: JsonValue | undefined): Promise<JsonValue> {
    const params = parseThreadResumeParams(rawParams);
    const meta = await threadStore.readMeta(params.threadId);
    if (!meta) {
      throw new RpcError(THREAD_NOT_FOUND_CODE, `Thread not found: ${params.threadId}`);
    }

    // The Thread.turns field is only populated on thread/resume per codex's
    // schema description ("only populated on thread/resume, thread/rollback,
    // thread/fork, and thread/read"). We surface an empty list for now — the
    // SDK resume path replays via SessionStore.load, not via our `turns`
    // field, so leaving this empty is correct in our architecture.
    const turns: Turn[] = [];

    const patch = await applyResumeOverrides(threadStore, meta.id, params);
    const effective = patch ?? meta;

    const thread: Thread = metaToThread(effective, {
      status: { type: "idle" },
      turns,
      preview: await derivePreview(threadStore.messagesPath(effective.id)),
    });

    const response: ThreadResumeResponse = {
      thread,
      model: effective.model,
      modelProvider: effective.modelProvider,
      cwd: effective.cwd,
      approvalPolicy: effective.approvalPolicy,
      approvalsReviewer: effective.approvalsReviewer,
      sandbox: effective.sandbox,
      serviceTier: effective.serviceTier ?? null,
      instructionSources: [],
      runtimeWorkspaceRoots: [],
    };

    validateOutbound("threadResume", response, logger);
    logger.info("[thread/resume] resumed", { threadId: effective.id, model: effective.model });
    return response as unknown as JsonValue;
  };
}

function parseThreadResumeParams(raw: JsonValue | undefined): ThreadResumeParams {
  if (!isJsonObject(raw) || typeof raw.threadId !== "string") {
    throw new RpcError(RPC_INVALID_PARAMS, "thread/resume requires { threadId: string }");
  }
  return raw as ThreadResumeParams;
}

async function applyResumeOverrides(
  threadStore: ThreadStore,
  threadId: string,
  params: ThreadResumeParams,
) {
  const patch: Record<string, unknown> = {};
  if (typeof params.model === "string") patch.model = params.model;
  if (typeof params.modelProvider === "string") patch.modelProvider = params.modelProvider;
  if (params.approvalPolicy !== undefined) patch.approvalPolicy = params.approvalPolicy;
  if (params.approvalsReviewer !== undefined) patch.approvalsReviewer = params.approvalsReviewer;
  if (params.sandbox !== undefined) patch.sandbox = params.sandbox;
  if (params.serviceTier !== undefined) patch.serviceTier = params.serviceTier;
  if (typeof params.developerInstructions === "string") {
    patch.developerInstructions = params.developerInstructions;
  }
  // Plugin can update the workspace pin on resume so the SDK's next turn
  // (which reads cwd off meta.cwd into sdkOptions.cwd) picks up the new
  // effectiveWorkspace without losing transcript history.
  if (typeof params.cwd === "string" && params.cwd.length > 0) patch.cwd = params.cwd;
  if (Object.keys(patch).length === 0) return null;
  return threadStore.updateMeta(threadId, patch);
}
