/**
 * Local duck-typed copies of the OpenClaw AgentHarness contract and the
 * codex-shaped JSON-RPC protocol that our @zeroaltitude/openclaw-claude-bridge speaks.
 *
 * Shapes mirror openclaw/extensions/codex/src/app-server/protocol.ts so the
 * same harness pattern works for both OpenAI Codex and Anthropic Claude
 * provider plugins.
 */

export type ClaudeAllowAllPolicy = "always" | "default";

export type ClaudePluginConfig = {
  bin?: string;
  binArgs?: string[];
  env?: Record<string, string>;
  /**
   * Codex approval policy to send to the server at thread/start.
   *   "never"      → server skips approval gates (recommended; mirrors the
   *                  previous "bypassPermissions" behaviour).
   *   "untrusted"  → server asks for approval on every tool call.
   *   "on-failure" → only after a tool failure.
   *   "on-request" → only when the model explicitly requests.
   */
  approvalPolicy?: "never" | "untrusted" | "on-failure" | "on-request";
  /** Harness priority over the built-in PI harness. */
  priority?: number;
  /** Hard per-turn timeout in ms. */
  turnTimeoutMs?: number;
  /** Idle watchdog (notifications must arrive within this window). */
  turnIdleTimeoutMs?: number;
  /** Override the on-disk thread persistence path. */
  statePath?: string;
};

// ─── OpenClaw AgentHarness contract (duck-typed) ─────────────────────────────

export type AgentHarnessSupportContext = {
  provider: string;
  modelId?: string;
  requestedRuntime: string;
};

export type AgentHarnessSupport =
  | { supported: true; priority?: number; reason?: string }
  | { supported: false; reason?: string };

export type AgentHarnessDeliveryDefaults = {
  sourceVisibleReplies?: "automatic" | "message_tool";
};

export type AttemptParams = {
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  workspaceDir?: string;
  prompt: string;
  provider: string;
  modelId: string;
  runId?: string;
  resolvedApiKey?: string;
  toolsAllow?: string[];
  abortSignal?: AbortSignal;
  thinkLevel?: string;
  images?: Array<{ mimeType: string; data: string }>;
  [key: string]: unknown;
};

export type ResetParams = {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  reason?: string;
};

export type AttemptResult = {
  aborted: boolean;
  externalAbort: boolean;
  timedOut: boolean;
  idleTimedOut: boolean;
  timedOutDuringCompaction: boolean;
  promptError: unknown;
  promptErrorSource:
    | "prompt"
    | "compaction"
    | "precheck"
    | "hook:before_agent_run"
    | null;
  sessionIdUsed: string;
  sessionFileUsed?: string;
  assistantTexts: string[];
  messagesSnapshot: unknown[];
  toolMetas: Array<{ toolName: string; meta?: string }>;
  lastAssistant: unknown;
  didSendViaMessagingTool: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: unknown[];
  cloudCodeAssistFormatError: boolean;
  replayMetadata: Record<string, unknown>;
  itemLifecycle: { startedCount: number; completedCount: number; activeCount: number };
  agentHarnessId?: string;
  agentHarnessResultClassification?: "empty" | "reasoning-only" | "planning-only";
  [key: string]: unknown;
};

export type AgentHarness = {
  id: string;
  label: string;
  pluginId?: string;
  deliveryDefaults?: AgentHarnessDeliveryDefaults;
  supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport;
  runAttempt(params: AttemptParams): Promise<AttemptResult>;
  reset?(params: ResetParams): Promise<void> | void;
  dispose?(): Promise<void> | void;
};

export type PluginApi = {
  registerAgentHarness: (harness: AgentHarness) => void;
  pluginConfig: Record<string, unknown> | undefined;
  config: Record<string, unknown>;
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
};

// ─── @zeroaltitude/openclaw-claude-bridge JSON-RPC protocol (codex-shaped) ────────────

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type RpcId = number | string;

export type RpcRequest = {
  jsonrpc?: "2.0";
  id?: RpcId;
  method: string;
  params?: unknown;
};

export type RpcResponse = {
  jsonrpc?: "2.0";
  id: RpcId;
  result?: JsonValue;
  error?: { code: number; message: string; data?: JsonValue };
};

export type RpcNotification = {
  jsonrpc?: "2.0";
  method: string;
  params?: JsonValue;
};

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export type ApprovalPolicy = "never" | "untrusted" | "on-failure" | "on-request";

export type SandboxPolicy = { type: string; [key: string]: unknown };

export type UserInput =
  | { type: "text"; text: string; text_elements?: JsonValue[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

export type InitializeParams = {
  clientInfo: { name: string; title?: string; version?: string };
  capabilities?: JsonObject;
};

export type ThreadStartParams = {
  cwd?: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: "user" | "auto_review";
  sandbox?: SandboxPolicy;
  serviceTier?: string | null;
  dynamicTools?: Array<{ name: string; description: string; inputSchema: JsonValue }>;
  developerInstructions?: string;
  config?: JsonObject;
};

export type ThreadResumeParams = {
  threadId: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: "user" | "auto_review";
  sandbox?: SandboxPolicy;
};

export type TurnStartParams = {
  threadId: string;
  input: UserInput[];
  cwd?: string;
  model?: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
};

export type TurnInterruptParams = {
  threadId: string;
  turnId: string;
};

export type Thread = {
  id: string;
  sessionId: string;
  cliVersion: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  ephemeral: boolean;
  modelProvider: string;
  preview: string;
  source: string | { custom: string };
  status: { type: string; [key: string]: unknown };
  turns: unknown[];
  [key: string]: unknown;
};

export type ThreadStartResponse = {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: unknown;
  approvalsReviewer: string;
  sandbox: SandboxPolicy;
};

export type Turn = {
  id: string;
  threadId?: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  items: ThreadItem[];
  error?: { message: string; [key: string]: unknown } | null;
};

export type ThreadItem = {
  id: string;
  type: string;
  title: string | null;
  status: string | null;
  name: string | null;
  tool: string | null;
  server: string | null;
  command: string | null;
  cwd: string | null;
  query: string | null;
  text: string;
  changes: Array<{ path: string; kind: string }>;
  aggregatedOutput: string | null;
  [key: string]: unknown;
};
