/**
 * NDJSON transport over stdin/stdout. Reads newline-delimited JSON messages
 * from stdin, dispatches them to a handler. Writes outbound messages to
 * stdout with a trailing newline.
 *
 * Mirrors the stdio transport behavior of codex-app-server, but kept minimal:
 * we don't support websocket — this server is stdio-only by design.
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { RpcMessage } from "./protocol.js";

export type IncomingMessageHandler = (msg: unknown) => void;

export type Logger = {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
};

export class StdioTransport {
  private readonly stdoutWrite: (line: string) => void;
  private readonly rl: ReadlineInterface;
  private closed = false;

  constructor(
    options: {
      stdin?: NodeJS.ReadableStream;
      stdout?: NodeJS.WritableStream;
      logger: Logger;
    },
    private readonly onMessage: IncomingMessageHandler,
  ) {
    const stdin = options.stdin ?? process.stdin;
    const stdout = options.stdout ?? process.stdout;
    this.stdoutWrite = (line) => {
      stdout.write(line);
    };
    this.rl = createInterface({ input: stdin });
    this.rl.on("line", (line) => this.handleLine(line, options.logger));
    this.rl.on("close", () => {
      this.closed = true;
      options.logger.debug("[transport] stdin closed");
    });
  }

  send(message: RpcMessage): void {
    if (this.closed) return;
    const line = stringifyMessage(message);
    this.stdoutWrite(`${line}\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rl.close();
  }

  isClosed(): boolean {
    return this.closed;
  }

  private handleLine(line: string, logger: Logger): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      // Mirrors codex's lenient parser: log + drop, don't crash.
      logger.warn(
        "[transport] failed to parse incoming line",
        { error: err instanceof Error ? err.message : String(err), preview: trimmed.slice(0, 200) },
      );
      return;
    }
    this.onMessage(parsed);
  }
}

const UNPAIRED_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * JSON-serialize a message, stripping unpaired UTF-16 surrogates which the
 * codex client also strips. Matters when assistant output contains lone
 * surrogates that would otherwise break clients that re-parse strictly.
 */
export function stringifyMessage(message: RpcMessage): string {
  return (
    JSON.stringify(message, (_key, value) =>
      typeof value === "string" ? value.replace(UNPAIRED_SURROGATE_RE, "") : value,
    ) ?? "null"
  );
}
