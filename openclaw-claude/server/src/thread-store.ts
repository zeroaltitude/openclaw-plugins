/**
 * On-disk persistence for thread metadata. Lives separately from the SDK's
 * own session JSONL (which session-store.ts handles); both share the same
 * per-thread directory.
 *
 * Layout: <stateRoot>/threads/<threadId>/
 *   meta.json          — thread metadata we own (cwd, model, sandbox, etc.)
 *   messages.jsonl     — SDK session entries (one JSON per line, append-only)
 *
 * meta.json is intentionally separate from messages.jsonl so that:
 *   - we can update meta without rewriting the transcript
 *   - the SDK SessionStore only owns the JSONL
 *   - migrations/cleanups can touch metadata without parsing the transcript
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  AskForApproval,
  ApprovalsReviewer,
  DynamicToolSpec,
  JsonObject,
  SandboxPolicyResponse,
} from "./protocol.js";
import type { Logger } from "./transport.js";

const META_SCHEMA_VERSION = 1;

export const DEFAULT_STATE_ROOT = path.join(
  process.env.HOME ?? os.homedir(),
  ".openclaw",
  "state",
  "claude-app-server",
);

export type ThreadMeta = {
  schemaVersion: number;
  id: string;
  sessionId: string;
  cliVersion: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  model: string;
  modelProvider: string;
  approvalPolicy: AskForApproval;
  approvalsReviewer: ApprovalsReviewer;
  sandbox: SandboxPolicyResponse;
  serviceTier?: string | null;
  developerInstructions?: string;
  dynamicToolsFingerprint?: string;
  dynamicTools?: DynamicToolSpec[];
  /**
   * Codex's `config.mcp_servers` patch — a map of MCP server configs the
   * plugin wants Claude to connect to during this thread. Persisted verbatim
   * and forwarded to the SDK's `Options.mcpServers` at turn time, merged with
   * our own openclaw dynamic-tools server.
   */
  mcpServersConfig?: JsonObject;
  /**
   * Plugin-supplied native (Claude Code preset) tool names to block for
   * this thread. Merged with the server's env-derived default
   * (OPENCLAW_CLAUDE_APP_SERVER_DISALLOWED_TOOLS, default empty under
   * Option X — native Agent/Task remain available as the inline-sync
   * subagent path analogous to codex's spawn_agent) at sdkOptions time so
   * OpenClaw's tool policy (disableTools / restrictive toolsAllow) reaches
   * the SDK's native tools, which bypass the dynamic-tools bridge.
   */
  disallowedTools?: string[];
  ephemeral: boolean;
  source: "appServer";
  forkedFromId?: string | null;
};

export type CreateThreadInput = {
  cwd: string;
  model: string;
  modelProvider: string;
  approvalPolicy: AskForApproval;
  approvalsReviewer: ApprovalsReviewer;
  sandbox: SandboxPolicyResponse;
  serviceTier?: string | null;
  developerInstructions?: string;
  dynamicToolsFingerprint?: string;
  dynamicTools?: DynamicToolSpec[];
  mcpServersConfig?: JsonObject;
  disallowedTools?: string[];
  forkedFromId?: string | null;
  cliVersion: string;
};

export class ThreadStore {
  constructor(
    private readonly stateRoot: string,
    private readonly logger: Logger,
  ) {}

  threadDir(threadId: string): string {
    return path.join(this.stateRoot, "threads", threadId);
  }

  messagesPath(threadId: string): string {
    return path.join(this.threadDir(threadId), "messages.jsonl");
  }

  private metaPath(threadId: string): string {
    return path.join(this.threadDir(threadId), "meta.json");
  }

  async createThread(input: CreateThreadInput): Promise<ThreadMeta> {
    const id = randomUUID();
    const now = nowSeconds();
    const meta: ThreadMeta = {
      schemaVersion: META_SCHEMA_VERSION,
      id,
      sessionId: id,
      cliVersion: input.cliVersion,
      createdAt: now,
      updatedAt: now,
      cwd: input.cwd,
      model: input.model,
      modelProvider: input.modelProvider,
      approvalPolicy: input.approvalPolicy,
      approvalsReviewer: input.approvalsReviewer,
      sandbox: input.sandbox,
      serviceTier: input.serviceTier ?? null,
      developerInstructions: input.developerInstructions,
      dynamicToolsFingerprint: input.dynamicToolsFingerprint,
      dynamicTools: input.dynamicTools,
      mcpServersConfig: input.mcpServersConfig,
      ...(input.disallowedTools && input.disallowedTools.length > 0
        ? { disallowedTools: input.disallowedTools }
        : {}),
      ephemeral: false,
      source: "appServer",
      forkedFromId: input.forkedFromId ?? null,
    };
    await fs.mkdir(this.threadDir(id), { recursive: true });
    await this.writeMeta(meta);
    return meta;
  }

  async readMeta(threadId: string): Promise<ThreadMeta | null> {
    try {
      const raw = await fs.readFile(this.metaPath(threadId), "utf8");
      const parsed = JSON.parse(raw) as ThreadMeta;
      if (parsed.schemaVersion !== META_SCHEMA_VERSION) {
        this.logger.warn("[thread-store] meta schemaVersion mismatch", {
          threadId,
          got: parsed.schemaVersion,
          want: META_SCHEMA_VERSION,
        });
        return null;
      }
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.logger.warn("[thread-store] failed to read meta", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async updateMeta(threadId: string, patch: Partial<ThreadMeta>): Promise<ThreadMeta | null> {
    const current = await this.readMeta(threadId);
    if (!current) return null;
    const next: ThreadMeta = {
      ...current,
      ...patch,
      id: current.id,
      sessionId: current.sessionId,
      schemaVersion: META_SCHEMA_VERSION,
      updatedAt: nowSeconds(),
    };
    await this.writeMeta(next);
    return next;
  }

  async deleteThread(threadId: string): Promise<void> {
    try {
      await fs.rm(this.threadDir(threadId), { recursive: true, force: true });
    } catch (err) {
      this.logger.warn("[thread-store] failed to delete thread dir", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async writeMeta(meta: ThreadMeta): Promise<void> {
    const target = this.metaPath(meta.id);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    await fs.rename(tmp, target);
  }
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
