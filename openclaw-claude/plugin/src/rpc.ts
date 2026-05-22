/**
 * JSON-RPC 2.0 client over a stdio child process — talks to our
 * @zeroaltitude/openclaw-claude-bridge binary.
 *
 * Bidirectional: the server can send REQUESTS to us (e.g. approval prompts,
 * dynamic-tool calls). We route them to a default-respond function. If
 * the server's request method matches a registered handler we use that;
 * otherwise we send a generic decline so the SDK loop doesn't hang.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type {
  ClaudePluginConfig,
  JsonValue,
  PluginApi,
  RpcMessage,
  RpcNotification,
  RpcRequest,
  RpcResponse,
} from "./types.js";

export type NotificationHandler = (notification: RpcNotification) => void;

export type ServerRequestHandler = (
  request: { id: number | string; method: string; params?: JsonValue },
) => Promise<JsonValue | undefined> | JsonValue | undefined;

type PendingRequest = {
  method: string;
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
};

const FORCE_KILL_DELAY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 600_000;
const STDERR_TAIL_MAX = 2_000;
const INIT_TIMEOUT_MS = 30_000;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: JsonValue,
    readonly method?: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export class ClaudeAppServerClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers: NotificationHandler[] = [];
  private serverRequestHandlers: ServerRequestHandler[] = [];
  private stopped = false;
  private initializePromise: Promise<JsonValue> | null = null;
  private initialized = false;
  private stderrRl: ReadlineInterface | null = null;
  private stdoutRl: ReadlineInterface | null = null;
  private stderrTail = "";
  private serverInfo: { name?: string; version?: string } | null = null;

  constructor(
    private readonly cfg: Required<
      Pick<ClaudePluginConfig, "bin" | "binArgs" | "env">
    > & { logger: PluginApi["logger"] },
  ) {}

  async start(): Promise<void> {
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }
    this.stopped = false;
    this.initialized = false;
    this.stderrTail = "";

    const env: NodeJS.ProcessEnv = { ...process.env, ...this.cfg.env };

    this.child = spawn(this.cfg.bin, this.cfg.binArgs, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    this.cfg.logger.info("[claude] spawned openclaw-claude-bridge", {
      pid: this.child.pid,
      bin: this.cfg.bin,
    });

    this.stderrRl = createInterface({ input: this.child.stderr! });
    this.stderrRl.on("line", (line) => {
      if (!line.trim()) return;
      this.stderrTail = appendBoundedTail(this.stderrTail, `${line}\n`, STDERR_TAIL_MAX);
      this.cfg.logger.warn("[claude:stderr]", line);
    });

    this.stdoutRl = createInterface({ input: this.child.stdout! });
    this.stdoutRl.on("line", (line) => this.onLine(line));

    this.child.once("exit", (code, signal) => {
      this.cfg.logger.warn("[claude] process exited", { code, signal });
      const suffix = this.stderrTail
        ? ` stderr=${JSON.stringify(this.stderrTail.slice(-STDERR_TAIL_MAX))}`
        : "";
      this.handleChildExit(
        new Error(
          `openclaw-claude-bridge exited (code=${formatExitValue(code)} signal=${formatExitValue(signal)})${suffix}`,
        ),
      );
    });

    this.child.stdin?.on("error", (err) => {
      this.cfg.logger.error("[claude] stdin error", err.message);
      this.handleChildExit(new Error(`openclaw-claude-bridge stdin error: ${err.message}`));
    });

    this.initializePromise = this.sendRequest<JsonValue>(
      "initialize",
      {
        clientInfo: { name: "openclaw-claude", version: "0.4.0" },
        capabilities: { experimentalApi: true },
      },
      AbortSignal.timeout(INIT_TIMEOUT_MS),
    ).then((result) => {
      this.initialized = true;
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const info = (result as Record<string, unknown>).serverInfo;
        if (info && typeof info === "object" && !Array.isArray(info)) {
          this.serverInfo = info as { name?: string; version?: string };
        }
      }
      this.cfg.logger.info("[claude] server initialized", { server: this.serverInfo });
      return result;
    });

    try {
      await this.initializePromise;
    } catch (err) {
      this.initializePromise = null;
      this.stop();
      throw err;
    }
  }

  getServerInfo(): { name?: string; version?: string } | null {
    return this.serverInfo;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const child = this.child;
    this.child = null;
    this.initialized = false;
    this.initializePromise = null;
    this.closeReaders();
    if (!child) return;
    child.stdin?.end();
    child.stdin?.destroy();
    const forceKill = setTimeout(() => {
      try {
        if (child.pid && process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch { /* ignore */ }
    }, FORCE_KILL_DELAY_MS);
    forceKill.unref?.();
    child.once("exit", () => clearTimeout(forceKill));
    child.unref?.();
    this.rejectAll(new Error("openclaw-claude-bridge stopped"));
  }

  isRunning(): boolean {
    return this.child !== null && !this.stopped;
  }

  async request<T = JsonValue>(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (method !== "initialize") {
      if (this.initializePromise) {
        await this.initializePromise.catch(() => {});
      }
      if (!this.initialized) {
        throw new Error("openclaw-claude-bridge is not initialized");
      }
    }
    return this.sendRequest<T>(method, params, signal);
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter((h) => h !== handler);
    };
  }

  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.push(handler);
    return () => {
      this.serverRequestHandlers = this.serverRequestHandlers.filter((h) => h !== handler);
    };
  }

  private async sendRequest<T>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.child) {
      throw new Error("openclaw-claude-bridge is not running");
    }
    const id = this.nextId++;
    const msg: RpcRequest = { jsonrpc: "2.0", id, method, params };

    const result = await new Promise<JsonValue>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`RPC ${method} timed out`, undefined, undefined, method));
      }, REQUEST_TIMEOUT_MS);
      const onAbort = () => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new RpcError(`RPC ${method} aborted`, undefined, undefined, method));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      try {
        this.writeLine(JSON.stringify(msg));
      } catch (writeErr) {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        reject(writeErr instanceof Error ? writeErr : new Error(String(writeErr)));
      }
    });

    return result as T;
  }

  private writeLine(line: string): void {
    if (!this.child?.stdin) {
      throw new Error("stdin unavailable — server not running");
    }
    this.child.stdin.write(line + "\n");
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(trimmed) as RpcMessage;
    } catch {
      this.cfg.logger.warn("[claude] unparseable line", trimmed.slice(0, 200));
      return;
    }

    // Server→client REQUEST (has both id and method)
    if ("id" in msg && msg.id !== undefined && "method" in msg) {
      void this.handleServerRequest(msg as RpcRequest);
      return;
    }
    // Response (has id, no method)
    if ("id" in msg && msg.id !== undefined) {
      const resp = msg as RpcResponse;
      const pending = this.pending.get(resp.id as number);
      if (!pending) {
        this.cfg.logger.warn("[claude] unexpected response id", resp.id);
        return;
      }
      this.pending.delete(resp.id as number);
      if (resp.error) {
        pending.reject(
          new RpcError(
            resp.error.message || `RPC ${pending.method} failed`,
            resp.error.code,
            resp.error.data,
            pending.method,
          ),
        );
      } else {
        pending.resolve((resp.result ?? null) as JsonValue);
      }
      return;
    }
    // Notification (method only)
    if ("method" in msg) {
      const notif = msg as RpcNotification;
      for (const handler of this.notificationHandlers) {
        try {
          handler(notif);
        } catch (err) {
          this.cfg.logger.error("[claude] notification handler error", String(err));
        }
      }
    }
  }

  private async handleServerRequest(req: RpcRequest): Promise<void> {
    const id = req.id!;
    try {
      for (const handler of this.serverRequestHandlers) {
        const result = await handler({ id: id as number, method: req.method, params: req.params as JsonValue | undefined });
        if (result !== undefined) {
          this.writeLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
          return;
        }
      }
      // No handler matched — return a default that won't hang the server.
      this.writeLine(JSON.stringify({ jsonrpc: "2.0", id, result: defaultServerResponse(req.method) }));
    } catch (err) {
      this.writeLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        }),
      );
    }
  }

  private handleChildExit(error: Error): void {
    if (this.child === null) return;
    this.rejectAll(error);
    this.closeReaders();
    this.child = null;
    this.initialized = false;
    this.initializePromise = null;
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private closeReaders(): void {
    this.stderrRl?.close();
    this.stderrRl = null;
    this.stdoutRl?.close();
    this.stdoutRl = null;
  }
}

function defaultServerResponse(method: string): JsonValue {
  // Auto-approve known approval requests so a thread configured with
  // approvalPolicy other than "never" still works without an explicit handler.
  // The plugin's default posture mirrors codex's "decline" for safety, with
  // an explicit allow only for our own dynamic-tool surface (which the plugin
  // hasn't registered any of yet).
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    return { decision: "decline", reason: "no approval handler registered" };
  }
  if (method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (method === "item/tool/call") {
    return {
      contentItems: [
        { type: "inputText", text: "openclaw-claude plugin has no dynamic-tool handler registered." },
      ],
      success: false,
    };
  }
  return {};
}

function appendBoundedTail(current: string, next: string, maxLength: number): string {
  const combined = current + next;
  return combined.length > maxLength ? combined.slice(combined.length - maxLength) : combined;
}

function formatExitValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "unknown";
}

export function compareServerVersion(
  version: string | undefined,
  minimum: string,
): number {
  if (!version) return -1;
  const parse = (v: string) =>
    (v.split("-")[0] ?? "0").split(".").map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const lhs = parse(version);
  const rhs = parse(minimum);
  for (let i = 0; i < Math.max(lhs.length, rhs.length); i++) {
    const a = lhs[i] ?? 0;
    const b = rhs[i] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}
