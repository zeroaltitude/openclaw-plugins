/**
 * Core JSON-RPC 2.0 server. Owns method-handler registration, notification
 * emission, and the server→client request channel used for things like
 * `item/tool/call` and approval requests.
 *
 * The dispatcher is transport-agnostic — it receives parsed objects and emits
 * parsed messages back. `StdioTransport` provides the NDJSON wire.
 */

import {
  isJsonObject,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  type JsonValue,
  type RpcErrorPayload,
  type RpcId,
  type RpcMessage,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
} from "./protocol.js";
import type { Logger } from "./transport.js";

export type MethodHandler = (params: JsonValue | undefined) => Promise<JsonValue | undefined> | JsonValue | undefined;

type MessageSender = (msg: RpcMessage) => void;

type PendingClientRequest = {
  method: string;
  resolve: (value: JsonValue | undefined) => void;
  reject: (err: RpcError) => void;
  cleanup: () => void;
};

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: JsonValue,
  ) {
    super(message);
    this.name = "RpcError";
  }

  toPayload(): RpcErrorPayload {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export class JsonRpcServer {
  private readonly handlers = new Map<string, MethodHandler>();
  private readonly pendingClientRequests = new Map<RpcId, PendingClientRequest>();
  private nextOutboundId = 1;
  private closeHandlers: Array<() => void> = [];

  constructor(
    private readonly sender: MessageSender,
    private readonly logger: Logger,
  ) {}

  onMethod(method: string, handler: MethodHandler): void {
    if (this.handlers.has(method)) {
      throw new Error(`[server] duplicate handler registration for ${method}`);
    }
    this.handlers.set(method, handler);
  }

  notify(method: string, params?: unknown): void {
    const message: RpcNotification = { jsonrpc: "2.0", method, params: params as JsonValue };
    this.sender(message);
  }

  /**
   * Send a server→client request and await its response. Used for
   * `item/tool/call`, `item/commandExecution/requestApproval`, etc.
   */
  async request<T = JsonValue | undefined>(
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    const id = this.nextOutboundId++;
    const message: RpcRequest = { jsonrpc: "2.0", id, method, params: params as JsonValue };
    return new Promise<T>((resolve, reject) => {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (abortListener && options?.signal) {
          options.signal.removeEventListener("abort", abortListener);
        }
      };
      if (options?.timeoutMs && options.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          if (!this.pendingClientRequests.has(id)) return;
          this.pendingClientRequests.delete(id);
          cleanup();
          reject(new RpcError(RPC_INTERNAL_ERROR, `request ${method} timed out`));
        }, options.timeoutMs);
        timeoutHandle.unref?.();
      }
      if (options?.signal) {
        if (options.signal.aborted) {
          cleanup();
          reject(new RpcError(RPC_INTERNAL_ERROR, `request ${method} aborted`));
          return;
        }
        abortListener = () => {
          if (!this.pendingClientRequests.has(id)) return;
          this.pendingClientRequests.delete(id);
          cleanup();
          reject(new RpcError(RPC_INTERNAL_ERROR, `request ${method} aborted`));
        };
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
      this.pendingClientRequests.set(id, {
        method,
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
        cleanup,
      });
      this.sender(message);
    });
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    for (const pending of this.pendingClientRequests.values()) {
      pending.cleanup();
      pending.reject(new RpcError(RPC_INTERNAL_ERROR, "server closing"));
    }
    this.pendingClientRequests.clear();
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch (err) {
        this.logger.warn("[server] close handler threw", err);
      }
    }
  }

  /** Called by the transport when a parsed object arrives. */
  ingest(parsed: unknown): void {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.logger.warn("[server] dropping non-object message", { preview: previewValue(parsed) });
      return;
    }
    const msg = parsed as Record<string, unknown>;
    if ("method" in msg) {
      if ("id" in msg && msg.id !== undefined) {
        void this.handleRequest(msg as unknown as RpcRequest);
      } else {
        this.handleNotification(msg as unknown as RpcNotification);
      }
      return;
    }
    if ("id" in msg && msg.id !== undefined) {
      this.handleResponse(msg as unknown as RpcResponse);
      return;
    }
    this.logger.warn("[server] dropping unrecognized message shape", { preview: previewValue(parsed) });
  }

  private async handleRequest(request: RpcRequest): Promise<void> {
    const handler = this.handlers.get(request.method);
    if (!handler) {
      this.respondError(request.id, RPC_METHOD_NOT_FOUND, `Method not found: ${request.method}`);
      return;
    }
    try {
      const result = await handler(request.params);
      this.respondSuccess(request.id, result);
    } catch (err) {
      if (err instanceof RpcError) {
        this.respondError(request.id, err.code, err.message, err.data);
        return;
      }
      this.logger.error("[server] handler threw", {
        method: request.method,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      this.respondError(
        request.id,
        RPC_INTERNAL_ERROR,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private handleNotification(notif: RpcNotification): void {
    // The codex client doesn't actually send notifications to us today; we
    // tolerate but ignore unknown ones rather than failing.
    this.logger.debug("[server] ignoring inbound notification", { method: notif.method });
  }

  private handleResponse(response: RpcResponse): void {
    const id = response.id;
    if (id === undefined) {
      this.logger.warn("[server] response missing id");
      return;
    }
    const pending = this.pendingClientRequests.get(id);
    if (!pending) {
      this.logger.warn("[server] response for unknown id", { id });
      return;
    }
    this.pendingClientRequests.delete(id);
    if ("error" in response && response.error) {
      pending.reject(new RpcError(response.error.code, response.error.message, response.error.data));
      return;
    }
    if ("result" in response) {
      pending.resolve(response.result);
      return;
    }
    pending.reject(new RpcError(RPC_INVALID_REQUEST, "response missing result and error"));
  }

  private respondSuccess(id: RpcId | undefined, result: JsonValue | undefined): void {
    if (id === undefined) return;
    this.sender({ jsonrpc: "2.0", id, result } as RpcResponse);
  }

  private respondError(id: RpcId | undefined, code: number, message: string, data?: JsonValue): void {
    if (id === undefined) return;
    const error: RpcErrorPayload = data === undefined ? { code, message } : { code, message, data };
    this.sender({ jsonrpc: "2.0", id, error } as RpcResponse);
  }
}

function previewValue(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (!json) return String(value);
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return String(value);
  }
}

export { isJsonObject };
