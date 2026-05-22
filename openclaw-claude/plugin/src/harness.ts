/**
 * AgentHarness implementation that delegates Anthropic turns to a local
 * @zeroaltitude/openclaw-claude-bridge child process.
 *
 * The server owns the entire turn lifecycle (SDK call, streaming, tool
 * dispatch, approval routing, persistence). The plugin's job is to bridge
 * OpenClaw's AgentHarness contract to the codex-shaped JSON-RPC the server
 * speaks, plus persist a sessionId↔threadId mapping across plugin restarts.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type {
  AgentHarness,
  AgentHarnessSupport,
  AgentHarnessSupportContext,
  ApprovalPolicy,
  AttemptParams,
  AttemptResult,
  ClaudePluginConfig,
  PluginApi,
  ResetParams,
  ThreadItem,
  ThreadStartParams,
  ThreadStartResponse,
  Turn,
  TurnStartParams,
  UserInput,
} from "./types.js";
import { ClaudeAppServerClient, RpcError } from "./rpc.js";

export const HARNESS_ID = "claude-bridge";

const THREAD_TTL_MS = 6 * 60 * 60 * 1000;
const THREAD_MAP_MAX_ENTRIES = 500;
const STATE_SCHEMA_VERSION = 2;
const THREAD_NOT_FOUND_RE = /thread not found/i;

class IdleTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdleTimeoutError";
  }
}

export type HarnessConfig = {
  client: ClaudeAppServerClient;
  approvalPolicy: ApprovalPolicy;
  priority: number;
  turnTimeoutMs: number;
  turnIdleTimeoutMs: number;
  statePath: string;
  logger: PluginApi["logger"];
};

type ThreadEntry = {
  threadId: string;
  approvalPolicy: ApprovalPolicy;
  lastUsedAt: number;
};

type ThreadStateFile = {
  schemaVersion: number;
  threads: Record<string, ThreadEntry>;
};

function emptyResult(params: AttemptParams): AttemptResult {
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: params.sessionId,
    sessionFileUsed: params.sessionFile,
    assistantTexts: [],
    messagesSnapshot: [],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: {},
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    agentHarnessId: HARNESS_ID,
  };
}

// ─── Thread persistence ─────────────────────────────────────────────────────

async function loadThreadState(
  statePath: string,
  logger: PluginApi["logger"],
): Promise<Map<string, ThreadEntry>> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as ThreadStateFile;
    if (parsed.schemaVersion !== STATE_SCHEMA_VERSION || !parsed.threads) {
      logger.warn("[claude] thread state schema mismatch, ignoring", {
        statePath,
        gotSchema: parsed.schemaVersion,
      });
      return new Map();
    }
    return new Map(Object.entries(parsed.threads));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    logger.warn("[claude] failed to read thread state", {
      statePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

async function saveThreadState(
  statePath: string,
  threads: Map<string, ThreadEntry>,
  logger: PluginApi["logger"],
): Promise<void> {
  const data: ThreadStateFile = {
    schemaVersion: STATE_SCHEMA_VERSION,
    threads: Object.fromEntries(threads),
  };
  try {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, statePath);
  } catch (err) {
    logger.warn("[claude] failed to persist thread state", {
      statePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

type Persistor = (() => void) & { flush: () => Promise<void> };

function createPersistor(
  statePath: string,
  threadMap: Map<string, ThreadEntry>,
  logger: PluginApi["logger"],
): Persistor {
  let queued = false;
  let running = false;
  const flush = async () => {
    if (running) { queued = true; return; }
    running = true;
    try {
      do {
        queued = false;
        await saveThreadState(statePath, new Map(threadMap), logger);
      } while (queued);
    } finally {
      running = false;
    }
  };
  const schedule = (() => {
    queued = true;
    if (!running) void flush();
  }) as Persistor;
  schedule.flush = flush;
  return schedule;
}

function pruneThreadMap(threadMap: Map<string, ThreadEntry>): boolean {
  const now = Date.now();
  let changed = false;
  for (const [sessionId, entry] of threadMap) {
    if (now - entry.lastUsedAt > THREAD_TTL_MS) {
      threadMap.delete(sessionId);
      changed = true;
    }
  }
  while (threadMap.size > THREAD_MAP_MAX_ENTRIES) {
    let oldest: string | null = null;
    let oldestT = Infinity;
    for (const [k, e] of threadMap) {
      if (e.lastUsedAt < oldestT) { oldest = k; oldestT = e.lastUsedAt; }
    }
    if (!oldest) break;
    threadMap.delete(oldest);
    changed = true;
  }
  return changed;
}

function isThreadNotFound(err: unknown): boolean {
  if (!(err instanceof RpcError)) return false;
  if (err.message && THREAD_NOT_FOUND_RE.test(err.message)) return true;
  if (err.data && typeof err.data === "object" && !Array.isArray(err.data)) {
    const msg = (err.data as Record<string, unknown>).message;
    if (typeof msg === "string" && THREAD_NOT_FOUND_RE.test(msg)) return true;
  }
  return false;
}

async function ensureThread(
  client: ClaudeAppServerClient,
  params: AttemptParams,
  approvalPolicy: ApprovalPolicy,
  threadMap: Map<string, ThreadEntry>,
  persist: Persistor,
  logger: PluginApi["logger"],
): Promise<ThreadEntry> {
  if (pruneThreadMap(threadMap)) persist();
  const existing = threadMap.get(params.sessionId);
  if (existing) {
    if (existing.approvalPolicy !== approvalPolicy) {
      logger.info("[claude] approvalPolicy changed, starting fresh thread", {
        sessionId: params.sessionId,
        previous: existing.approvalPolicy,
        next: approvalPolicy,
      });
      threadMap.delete(params.sessionId);
      persist();
    } else {
      try {
        await client.request("thread/resume", { threadId: existing.threadId });
        existing.lastUsedAt = Date.now();
        persist();
        return existing;
      } catch (err) {
        if (isThreadNotFound(err)) {
          logger.warn("[claude] thread not found, starting fresh", {
            sessionId: params.sessionId,
            threadId: existing.threadId,
          });
          threadMap.delete(params.sessionId);
          persist();
        } else {
          throw err;
        }
      }
    }
  }

  const startParams: ThreadStartParams = {
    cwd: params.workspaceDir ?? process.cwd(),
    model: params.modelId,
    modelProvider: "anthropic",
    approvalPolicy,
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
  };
  const result = await client.request<ThreadStartResponse>("thread/start", startParams);
  const threadId = result.thread?.id;
  if (typeof threadId !== "string" || !threadId) {
    throw new Error(`thread/start returned invalid thread.id: ${JSON.stringify(threadId)}`);
  }
  const entry: ThreadEntry = {
    threadId,
    approvalPolicy,
    lastUsedAt: Date.now(),
  };
  threadMap.set(params.sessionId, entry);
  persist();
  return entry;
}

// ─── Turn execution ─────────────────────────────────────────────────────────

type TurnAccumulator = {
  textParts: string[];
  reasoningParts: string[];
  toolMetas: Array<{ toolName: string; meta?: string }>;
  items: ThreadItem[];
};

function newAccumulator(): TurnAccumulator {
  return { textParts: [], reasoningParts: [], toolMetas: [], items: [] };
}

function buildInput(params: AttemptParams): UserInput[] {
  const blocks: UserInput[] = [{ type: "text", text: params.prompt }];
  if (params.images) {
    for (const img of params.images) {
      // Convert OpenClaw {mimeType, data: base64} into a data: URL the server
      // can dispatch as a content block. The server further normalises to
      // Anthropic's source format.
      const url = `data:${img.mimeType};base64,${img.data}`;
      blocks.push({ type: "image", url });
    }
  }
  return blocks;
}

async function runTurnViaServer(
  cfg: HarnessConfig,
  threadEntry: ThreadEntry,
  params: AttemptParams,
  ac: AbortController,
): Promise<{ outcome: "ok" | "error"; finalTurn: Turn | null; acc: TurnAccumulator; errorMessage?: string }> {
  const turnStartParams: TurnStartParams = {
    threadId: threadEntry.threadId,
    input: buildInput(params),
    cwd: params.workspaceDir,
    model: params.modelId,
  };
  const startResp = await cfg.client.request<{ turn: Turn }>(
    "turn/start",
    turnStartParams,
    ac.signal,
  );
  const turnId = startResp.turn.id;
  const acc = newAccumulator();

  return await new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      ac.signal.removeEventListener("abort", onAbort);
      unsubscribe();
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      cfg.client
        .request("turn/interrupt", { threadId: threadEntry.threadId, turnId })
        .catch(() => {});
      reject(new Error("Turn aborted"));
    };
    ac.signal.addEventListener("abort", onAbort, { once: true });

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        cfg.client
          .request("turn/interrupt", { threadId: threadEntry.threadId, turnId })
          .catch(() => {});
        reject(new IdleTimeoutError(`Claude turn idle for ${cfg.turnIdleTimeoutMs}ms`));
      }, cfg.turnIdleTimeoutMs);
      idleTimer.unref?.();
    };

    unsubscribe = cfg.client.onNotification((notif) => {
      const p = notif.params as Record<string, unknown> | undefined;
      if (!p) return;
      // Filter by turnId where applicable. turn/completed carries the turn
      // object with its id; everything else carries turnId directly.
      const ntid = typeof p.turnId === "string" ? p.turnId : undefined;
      const turnObj = p.turn as { id?: string } | undefined;
      const matches =
        (ntid && ntid === turnId) ||
        (turnObj && typeof turnObj.id === "string" && turnObj.id === turnId);
      if (!matches) return;

      resetIdleTimer();

      switch (notif.method) {
        case "turn/started":
          break;
        case "item/started": {
          const item = p.item as ThreadItem | undefined;
          if (item) {
            if (item.type === "dynamicToolCall" || item.type === "toolCall") {
              acc.toolMetas.push({ toolName: item.name ?? item.tool ?? "unknown" });
            }
          }
          break;
        }
        case "item/completed": {
          const item = p.item as ThreadItem | undefined;
          if (item) acc.items.push(item);
          break;
        }
        case "item/agentMessage/delta": {
          if (typeof p.delta === "string") acc.textParts.push(p.delta);
          break;
        }
        case "item/reasoning/delta": {
          if (typeof p.delta === "string") acc.reasoningParts.push(p.delta);
          break;
        }
        case "turn/error": {
          if (settled) return;
          settled = true;
          cleanup();
          const err = p.error as { message?: string } | undefined;
          resolve({ outcome: "error", finalTurn: null, acc, errorMessage: err?.message ?? "turn/error" });
          break;
        }
        case "turn/completed": {
          if (settled) return;
          settled = true;
          cleanup();
          const turn = p.turn as Turn | undefined;
          if (turn?.status === "failed") {
            resolve({
              outcome: "error",
              finalTurn: turn,
              acc,
              errorMessage: turn.error?.message ?? "turn failed",
            });
          } else {
            resolve({ outcome: "ok", finalTurn: turn ?? null, acc });
          }
          break;
        }
      }
    });

    resetIdleTimer();
  });
}

// ─── AgentHarness factory ───────────────────────────────────────────────────

export function createClaudeHarness(cfg: HarnessConfig): AgentHarness {
  const { client, logger } = cfg;

  const initPromise = client.start().catch((err: unknown) => {
    logger.error("[claude] failed to initialize", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  const threadMapPromise = loadThreadState(cfg.statePath, logger);

  let state: { threadMap: Map<string, ThreadEntry>; persist: Persistor } | null = null;

  const ensureReady = async () => {
    await initPromise;
    if (!state) {
      const threadMap = await threadMapPromise;
      pruneThreadMap(threadMap);
      const persist = createPersistor(cfg.statePath, threadMap, logger);
      state = { threadMap, persist };
    }
    return state;
  };

  return {
    id: HARNESS_ID,
    label: "Claude (openclaw-claude-bridge)",
    pluginId: "claude",

    supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport {
      if (ctx.requestedRuntime === HARNESS_ID) {
        return { supported: true, priority: cfg.priority + 1000 };
      }
      if (ctx.provider === "anthropic" && ctx.requestedRuntime === "auto") {
        return { supported: true, priority: cfg.priority };
      }
      return {
        supported: false,
        reason: `claude-bridge handles provider=anthropic only (got provider=${ctx.provider}, runtime=${ctx.requestedRuntime})`,
      };
    },

    async runAttempt(params: AttemptParams): Promise<AttemptResult> {
      const result = emptyResult(params);
      const ac = new AbortController();
      const onExternalAbort = () => ac.abort();
      params.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });
      const turnDeadline = setTimeout(() => ac.abort(), cfg.turnTimeoutMs);
      turnDeadline.unref?.();

      try {
        const { threadMap, persist } = await ensureReady();
        const threadEntry = await ensureThread(
          client,
          params,
          cfg.approvalPolicy,
          threadMap,
          persist,
          logger,
        );

        const { outcome, finalTurn, acc, errorMessage } = await runTurnViaServer(
          cfg,
          threadEntry,
          params,
          ac,
        );

        if (outcome === "error") {
          throw new Error(`Claude turn error: ${errorMessage}`);
        }

        const itemsFromTurn = finalTurn?.items ?? acc.items;
        const agentMessages = itemsFromTurn.filter((i) => i.type === "agentMessage");
        const reasoningItems = itemsFromTurn.filter((i) => i.type === "reasoning");
        const toolItems = itemsFromTurn.filter(
          (i) => i.type === "dynamicToolCall" || i.type === "toolCall",
        );

        const streamedText = acc.textParts.join("");
        const itemText = agentMessages.map((i) => i.text).filter(Boolean).join("\n\n");
        const text = streamedText || itemText;

        result.assistantTexts = text ? [text] : [];
        result.toolMetas = toolItems.map((i) => ({
          toolName: i.name ?? i.tool ?? "unknown",
        }));
        if (acc.reasoningParts.length > 0 || reasoningItems.length > 0) {
          result.replayMetadata = {
            ...result.replayMetadata,
            reasoning:
              acc.reasoningParts.join("") || reasoningItems.map((i) => i.text).join("\n\n"),
          };
        }
        const itemCount = itemsFromTurn.length;
        result.itemLifecycle = {
          startedCount: itemCount,
          completedCount: itemCount,
          activeCount: 0,
        };

        const hasText = result.assistantTexts.length > 0;
        const hasTools = result.toolMetas.length > 0;
        const hasReasoning = (acc.reasoningParts.length + reasoningItems.length) > 0;
        if (!hasText && hasTools) result.agentHarnessResultClassification = "planning-only";
        else if (!hasText && hasReasoning) result.agentHarnessResultClassification = "reasoning-only";
        else if (!hasText && !hasTools && !hasReasoning) result.agentHarnessResultClassification = "empty";

        return result;
      } catch (err) {
        const externalAbort = params.abortSignal?.aborted ?? false;
        const idle = err instanceof IdleTimeoutError;
        const aborted = ac.signal.aborted || idle;
        const timedOut = aborted && !externalAbort;
        result.aborted = aborted;
        result.externalAbort = externalAbort;
        result.timedOut = timedOut;
        result.idleTimedOut = idle;
        result.promptError = err instanceof Error ? err : new Error(String(err));
        result.promptErrorSource = "prompt";
        logger.error("[claude] runAttempt failed", {
          sessionId: params.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return result;
      } finally {
        clearTimeout(turnDeadline);
        params.abortSignal?.removeEventListener("abort", onExternalAbort);
      }
    },

    reset(params: ResetParams): void {
      if (!state || !params.sessionId) return;
      const entry = state.threadMap.get(params.sessionId);
      if (!entry) return;
      logger.info("[claude] reset: dropping thread mapping", {
        sessionId: params.sessionId,
        threadId: entry.threadId,
        reason: params.reason,
      });
      state.threadMap.delete(params.sessionId);
      state.persist();
    },

    async dispose(): Promise<void> {
      if (state) await state.persist.flush();
      cfg.client.stop();
    },
  };
}

export type { ClaudePluginConfig };
