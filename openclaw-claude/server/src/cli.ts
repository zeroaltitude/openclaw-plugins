/**
 * CLI entrypoint. Wires the stdio transport to the JSON-RPC server and
 * registers method handlers. Logs go to stderr (stdout is the wire).
 */

import { ActiveTurnRegistry } from "./active-turns.js";
import { createInitializeHandler, type InitializeState } from "./handlers/initialize.js";
import { createModelListHandler } from "./handlers/model-list.js";
import { createThreadForkHandler } from "./handlers/thread-fork.js";
import { createThreadInjectItemsHandler } from "./handlers/thread-inject-items.js";
import { createThreadResumeHandler } from "./handlers/thread-resume.js";
import { createThreadStartHandler } from "./handlers/thread-start.js";
import { createThreadUnsubscribeHandler } from "./handlers/thread-unsubscribe.js";
import { createTurnInterruptHandler } from "./handlers/turn-interrupt.js";
import { createTurnStartHandler } from "./handlers/turn-start.js";
import { createTurnSteerHandler } from "./handlers/turn-steer.js";
import {
  RPC_METHOD_NOT_FOUND,
  type JsonValue,
} from "./protocol.js";
import { JsonRpcServer, RpcError } from "./server.js";
import { OpenClawSessionStore } from "./session-store.js";
import { DEFAULT_STATE_ROOT, ThreadStore } from "./thread-store.js";
import { StdioTransport, type Logger } from "./transport.js";
import { OPENCLAW_CLAUDE_APP_SERVER_NAME, OPENCLAW_CLAUDE_APP_SERVER_VERSION } from "./version.js";

const STDERR_LOGGER: Logger = {
  debug: (msg, ...rest) => writeStderrLog("debug", msg, rest),
  info: (msg, ...rest) => writeStderrLog("info", msg, rest),
  warn: (msg, ...rest) => writeStderrLog("warn", msg, rest),
  error: (msg, ...rest) => writeStderrLog("error", msg, rest),
};

function writeStderrLog(level: string, message: string, rest: unknown[]): void {
  const line = rest.length > 0
    ? `[${level}] ${message} ${rest.map((r) => safeStringify(r)).join(" ")}`
    : `[${level}] ${message}`;
  process.stderr.write(`${line}\n`);
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function main(argv: string[]): Promise<void> {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${OPENCLAW_CLAUDE_APP_SERVER_NAME} ${OPENCLAW_CLAUDE_APP_SERVER_VERSION}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      [
        `${OPENCLAW_CLAUDE_APP_SERVER_NAME} ${OPENCLAW_CLAUDE_APP_SERVER_VERSION}`,
        "",
        "A JSON-RPC 2.0 server over stdio that exposes Anthropic Claude via the",
        "codex-app-server protocol shape. Designed to be spawned by the OpenClaw",
        "claude plugin; not intended for direct human use.",
        "",
        "Flags:",
        "  --version, -v   Print version and exit",
        "  --help, -h      Print this help",
        "",
      ].join("\n"),
    );
    return;
  }

  STDERR_LOGGER.info(`${OPENCLAW_CLAUDE_APP_SERVER_NAME} ${OPENCLAW_CLAUDE_APP_SERVER_VERSION} listening on stdio`);

  let server: JsonRpcServer | null = null;
  const transport = new StdioTransport({ logger: STDERR_LOGGER }, (msg) => {
    server?.ingest(msg);
  });
  server = new JsonRpcServer((msg) => transport.send(msg), STDERR_LOGGER);

  // Codex-ecosystem-only methods: empty stubs (codex's describeControlFailure
  // treats both -32601 and empty responses as "unsupported by this app-server").
  registerStub(server, "account/read", () => ({ account: null, requiresOpenaiAuth: false }));
  registerStub(server, "account/rateLimits/read", () => ({}));
  registerStub(server, "app/list", () => ({ data: [], nextCursor: null }));
  registerStub(server, "plugin/list", () => ({ marketplaces: [] }));
  registerStub(server, "skills/list", () => ({ data: [], nextCursor: null }));
  registerStub(server, "hooks/list", () => ({ data: [], nextCursor: null }));
  registerStub(server, "mcpServerStatus/list", () => ({ data: [], nextCursor: null }));

  const initState: InitializeState = { initialized: false };
  server.onMethod("initialize", createInitializeHandler(initState));

  const stateRoot = process.env.OPENCLAW_CLAUDE_APP_SERVER_STATE_ROOT ?? DEFAULT_STATE_ROOT;
  const threadStore = new ThreadStore(stateRoot, STDERR_LOGGER);
  const sessionStore = new OpenClawSessionStore(threadStore, STDERR_LOGGER);
  const activeTurns = new ActiveTurnRegistry();

  const notify = (method: string, params: unknown) => server.notify(method, params);

  server.onMethod("model/list", createModelListHandler(STDERR_LOGGER));
  server.onMethod("thread/start", createThreadStartHandler(threadStore, STDERR_LOGGER));
  server.onMethod("thread/resume", createThreadResumeHandler(threadStore, STDERR_LOGGER));
  const requestClient = (
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => server.request(method, params, options) as Promise<unknown>;

  server.onMethod(
    "turn/start",
    createTurnStartHandler({
      threadStore,
      sessionStore,
      activeTurns,
      notify,
      requestClient,
      logger: STDERR_LOGGER,
    }),
  );
  server.onMethod("turn/interrupt", createTurnInterruptHandler(activeTurns, STDERR_LOGGER));
  server.onMethod("turn/steer", createTurnSteerHandler(activeTurns, STDERR_LOGGER));
  server.onMethod("thread/fork", createThreadForkHandler(threadStore, STDERR_LOGGER));
  server.onMethod("thread/inject_items", createThreadInjectItemsHandler(threadStore, STDERR_LOGGER));
  server.onMethod("thread/unsubscribe", createThreadUnsubscribeHandler(threadStore));

  // Hold the process open until stdin closes.
  await new Promise<void>((resolve) => {
    process.stdin.on("end", () => {
      STDERR_LOGGER.info("stdin closed; shutting down");
      server?.close();
      transport.close();
      resolve();
    });
    process.on("SIGINT", () => {
      STDERR_LOGGER.info("SIGINT received; shutting down");
      server?.close();
      transport.close();
      resolve();
    });
    process.on("SIGTERM", () => {
      STDERR_LOGGER.info("SIGTERM received; shutting down");
      server?.close();
      transport.close();
      resolve();
    });
  });
}

function registerStub(
  server: JsonRpcServer,
  method: string,
  resultFactory: () => JsonValue,
): void {
  server.onMethod(method, () => resultFactory());
}

function registerNotImplemented(server: JsonRpcServer, method: string): void {
  server.onMethod(method, () => {
    throw new RpcError(RPC_METHOD_NOT_FOUND, `${method} not implemented in this build`);
  });
}
