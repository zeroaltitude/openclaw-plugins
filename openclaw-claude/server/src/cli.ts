/**
 * CLI entrypoint. Wires the stdio transport to the JSON-RPC server and
 * registers method handlers. Logs go to stderr (stdout is the wire).
 */

import { ActiveTurnRegistry } from "./active-turns.js";
import { AttemptRegistry } from "./attempt-registry.js";
import { createInitializeHandler, type InitializeState } from "./handlers/initialize.js";
import { createModelListHandler } from "./handlers/model-list.js";
import { createThreadArchiveHandler, createThreadUnarchiveHandler } from "./handlers/thread-archive.js";
import { createThreadCompactStartHandler } from "./handlers/thread-compact.js";
import { createThreadForkHandler } from "./handlers/thread-fork.js";
import { createThreadInjectItemsHandler } from "./handlers/thread-inject-items.js";
import { createThreadListHandler } from "./handlers/thread-list.js";
import { createThreadReadHandler } from "./handlers/thread-read.js";
import { createThreadResumeHandler } from "./handlers/thread-resume.js";
import { createThreadSetNameHandler } from "./handlers/thread-name-set.js";
import { createThreadStartHandler } from "./handlers/thread-start.js";
import { createThreadUnsubscribeHandler } from "./handlers/thread-unsubscribe.js";
import { createTurnInterruptHandler } from "./handlers/turn-interrupt.js";
import { createTurnStartHandler } from "./handlers/turn-start.js";
import { createTurnSteerHandler } from "./handlers/turn-steer.js";
import { type JsonValue } from "./protocol.js";
import { JsonRpcServer } from "./server.js";
import { OpenClawSessionStore } from "./session-store.js";
import { DEFAULT_STATE_ROOT, ThreadStore, migrateLegacyStateRootIfNeeded } from "./thread-store.js";
import { StdioTransport, type Logger } from "./transport.js";
import { OPENCLAW_CLAUDE_BRIDGE_NAME, OPENCLAW_CLAUDE_BRIDGE_VERSION } from "./version.js";

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
    process.stdout.write(`${OPENCLAW_CLAUDE_BRIDGE_NAME} ${OPENCLAW_CLAUDE_BRIDGE_VERSION}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      [
        `${OPENCLAW_CLAUDE_BRIDGE_NAME} ${OPENCLAW_CLAUDE_BRIDGE_VERSION}`,
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

  // The bridge is a single shared process serving every concurrent turn for
  // every agent. An unhandled REJECTION is almost always a benign background
  // promise (e.g. a fire-and-forget notify); killing the shared process over it
  // would fail every other agent's in-flight turn, so we log and keep serving.
  process.on("unhandledRejection", (reason) => {
    STDERR_LOGGER.error("unhandledRejection (kept alive)", reason);
  });
  // An uncaught EXCEPTION leaves the process in an undefined state. Staying alive
  // is worse than exiting here: a turn whose async context threw out-of-band can
  // be left orphaned while its 30s heartbeat keeps firing, which masks the dead
  // turn from the consumer's idle watchdog and stalls it until the 30-min hard
  // ceiling. Log and exit so the child dies cleanly and the consumer's
  // onExit/child-exit path fails every in-flight turn fast (P0 #1) and the next
  // turn respawns a healthy bridge.
  process.on("uncaughtException", (err) => {
    STDERR_LOGGER.error("uncaughtException; exiting for a clean respawn", err);
    process.exit(1);
  });

  STDERR_LOGGER.info(`${OPENCLAW_CLAUDE_BRIDGE_NAME} ${OPENCLAW_CLAUDE_BRIDGE_VERSION} listening on stdio`);

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

  const stateRoot = process.env.OPENCLAW_CLAUDE_BRIDGE_STATE_ROOT ?? DEFAULT_STATE_ROOT;
  await migrateLegacyStateRootIfNeeded(stateRoot, STDERR_LOGGER);
  const threadStore = new ThreadStore(stateRoot, STDERR_LOGGER);
  const sessionStore = new OpenClawSessionStore(threadStore, STDERR_LOGGER);
  const activeTurns = new ActiveTurnRegistry();
  const attemptRegistry = new AttemptRegistry(STDERR_LOGGER);

  // Bound how long a persistent attempt (and its live `claude` subprocess)
  // survives with no turns feeding it. Without this, a bridge process that
  // serves many threads over a long lifetime would accumulate one live
  // subprocess per thread ever touched, forever. First-class consumer config
  // key: appServer.queryThreadTimeoutMs (extensions/claude/src/app-server/
  // config.ts), threaded here as an env var since this bounds the bridge
  // PROCESS's own internal registry, not any single turn/request.
  const QUERY_THREAD_TIMEOUT_MS = Number(
    process.env.OPENCLAW_CLAUDE_BRIDGE_QUERY_THREAD_TIMEOUT_MS ?? 30 * 60_000,
  );
  const attemptSweepTimer = setInterval(() => {
    attemptRegistry.sweepIdle(QUERY_THREAD_TIMEOUT_MS);
  }, 5 * 60_000);
  attemptSweepTimer.unref?.();

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
      attemptRegistry,
      notify,
      requestClient,
      logger: STDERR_LOGGER,
    }),
  );
  server.onMethod(
    "thread/compact/start",
    createThreadCompactStartHandler({
      threadStore,
      sessionStore,
      activeTurns,
      attemptRegistry,
      notify,
      requestClient,
      logger: STDERR_LOGGER,
    }),
  );
  server.onMethod(
    "turn/interrupt",
    createTurnInterruptHandler(activeTurns, attemptRegistry, STDERR_LOGGER),
  );
  server.onMethod("turn/steer", createTurnSteerHandler(activeTurns, STDERR_LOGGER));
  server.onMethod("thread/fork", createThreadForkHandler(threadStore, STDERR_LOGGER));
  server.onMethod("thread/inject_items", createThreadInjectItemsHandler(threadStore, STDERR_LOGGER));
  server.onMethod("thread/unsubscribe", createThreadUnsubscribeHandler(threadStore));
  server.onMethod("thread/list", createThreadListHandler(threadStore, attemptRegistry, STDERR_LOGGER));
  server.onMethod("thread/read", createThreadReadHandler(threadStore, STDERR_LOGGER));
  server.onMethod("thread/name/set", createThreadSetNameHandler(threadStore, STDERR_LOGGER));
  server.onMethod("thread/archive", createThreadArchiveHandler(threadStore, STDERR_LOGGER));
  server.onMethod("thread/unarchive", createThreadUnarchiveHandler(threadStore, STDERR_LOGGER));

  // Hold the process open until stdin closes.
  await new Promise<void>((resolve) => {
    const shutdown = (reason: string) => {
      clearInterval(attemptSweepTimer);
      attemptRegistry.discardAll(reason);
      server?.close();
      transport.close();
      resolve();
    };
    process.stdin.on("end", () => {
      STDERR_LOGGER.info("stdin closed; shutting down");
      shutdown("stdin closed");
    });
    process.on("SIGINT", () => {
      STDERR_LOGGER.info("SIGINT received; shutting down");
      shutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
      STDERR_LOGGER.info("SIGTERM received; shutting down");
      shutdown("SIGTERM");
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

