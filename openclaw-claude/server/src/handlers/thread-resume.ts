/**
 * `thread/resume` handler. Reads thread metadata + transcript from disk and
 * returns the codex-shaped ThreadResumeResponse. The actual transcript
 * replay into a new SDK session happens on the next `turn/start`.
 */

import { promises as fs } from "node:fs";

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

    const thread: Thread = {
      id: effective.id,
      sessionId: effective.sessionId,
      cliVersion: effective.cliVersion,
      createdAt: effective.createdAt,
      updatedAt: effective.updatedAt,
      cwd: effective.cwd,
      ephemeral: effective.ephemeral,
      modelProvider: effective.modelProvider,
      preview: await derivePreview(threadStore.messagesPath(effective.id)),
      source: effective.source,
      status: { type: "idle" },
      turns,
    };

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
  if (Object.keys(patch).length === 0) return null;
  return threadStore.updateMeta(threadId, patch);
}

async function derivePreview(messagesPath: string): Promise<string> {
  // Preview is "usually the first user message" per the codex schema.
  // We scan the JSONL for the first entry with role=user and a text body.
  let raw: string;
  try {
    raw = await fs.readFile(messagesPath, "utf8");
  } catch {
    return "";
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      const text = extractUserText(entry);
      if (text) return text.slice(0, 200);
    } catch {
      continue;
    }
  }
  return "";
}

function extractUserText(entry: Record<string, unknown>): string | null {
  // SDK entry shapes vary; defensively look at common locations.
  if (entry.type === "user" || entry.role === "user") {
    const message = (entry.message ?? entry.content) as unknown;
    if (typeof message === "string") return message;
    if (Array.isArray(message)) {
      for (const block of message) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          const text = (block as { text?: unknown }).text;
          if (typeof text === "string") return text;
        }
      }
    }
    if (message && typeof message === "object") {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;
    }
  }
  return null;
}
