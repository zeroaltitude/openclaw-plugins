/**
 * Protocol types for the openclaw-claude-bridge JSON-RPC server. These mirror the shapes
 * that the OpenAI codex-app-server emits, so the same OpenClaw harness bridge
 * can drive both. Field names are intentionally identical to codex's
 * (camelCase, sometimes snake_case where codex uses it for legacy reasons).
 *
 * Sourced from openclaw/extensions/codex/src/app-server/protocol.ts with the
 * OpenAI-ecosystem-only types (account/plugin/marketplace/feedback) trimmed.
 */

// ─── JSON / JSON-RPC envelope ────────────────────────────────────────────────

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type RpcId = number | string;

export type RpcRequest = {
  jsonrpc?: "2.0";
  id?: RpcId;
  method: string;
  params?: JsonValue;
};

export type RpcSuccessResponse = {
  jsonrpc?: "2.0";
  id: RpcId;
  result: JsonValue | undefined;
};

export type RpcErrorResponse = {
  jsonrpc?: "2.0";
  id: RpcId;
  error: RpcErrorPayload;
};

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

export type RpcErrorPayload = {
  code: number;
  message: string;
  data?: JsonValue;
};

export type RpcNotification = {
  jsonrpc?: "2.0";
  method: string;
  params?: JsonValue;
};

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

// JSON-RPC 2.0 standard error codes (https://www.jsonrpc.org/specification)
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

// ─── initialize ──────────────────────────────────────────────────────────────

export type InitializeParams = {
  clientInfo: {
    name: string;
    title?: string;
    version?: string;
  };
  capabilities?: JsonObject;
};

export type InitializeResponse = {
  serverInfo?: {
    name?: string;
    version?: string;
  };
  protocolVersion?: string;
  userAgent?: string;
  capabilities?: JsonObject;
};

// ─── Thread shapes (codex parity) ────────────────────────────────────────────

export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "active"; activeFlags?: string[] }
  | { type: "systemError" };

export type SessionSource =
  | "cli"
  | "vscode"
  | "exec"
  | "appServer"
  | "unknown"
  | { custom: string };

/**
 * Thread shape required by codex's ajv schema. Every field listed in the
 * `required` array of v2/ThreadStartResponse#Thread MUST be present or codex's
 * client will throw on `assertCodexThreadStartResponse`.
 */
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
  source: SessionSource;
  status: ThreadStatus;
  turns: Turn[];
  name?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  threadSource?: string | null;
  forkedFromId?: string | null;
  gitInfo?: JsonObject | null;
  path?: string | null;
};

// ─── Dynamic tools (codex's `dynamicTools` array shape) ──────────────────────

export type DynamicToolSpec = JsonObject & {
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
  searchHint?: string;
  alwaysLoad?: boolean;
};

export type DynamicToolCallOutputContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string }
  | JsonObject;

// Server→client request: when the model invokes a dynamic tool we emit this
// JSON-RPC request to the client and await its response.
export type DynamicToolCallParams = {
  namespace?: string | null;
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments?: JsonValue;
};

export type DynamicToolDiagnosticTerminalType = "blocked" | "completed" | "error";

export type DynamicToolCallResponse = {
  contentItems: DynamicToolCallOutputContentItem[];
  diagnosticTerminalType?: DynamicToolDiagnosticTerminalType;
  success: boolean;
};

// ─── User input (turn/start `input` field) ───────────────────────────────────

export type UserInput =
  | { type: "text"; text: string; text_elements?: JsonValue[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

// ─── Sandbox / approval policy (opaque pass-through fields) ──────────────────

export type SandboxPolicy = string | JsonObject;

// ─── thread/start ────────────────────────────────────────────────────────────

export type ThreadStartParams = JsonObject & {
  input?: UserInput[];
  cwd?: string;
  model?: string;
  modelProvider?: string | null;
  approvalPolicy?: string | JsonObject;
  approvalsReviewer?: string | null;
  sandbox?: SandboxPolicy;
  serviceTier?: string | null;
  dynamicTools?: DynamicToolSpec[] | null;
  developerInstructions?: string;
  experimentalRawEvents?: boolean;
  persistExtendedHistory?: boolean;
  serviceName?: string;
  config?: JsonObject;
  environments?: JsonValue[];
  /**
   * Additional Claude Code preset native tool names to block for this
   * thread. Merged with the server's env-derived default
   * (OPENCLAW_CLAUDE_BRIDGE_DISALLOWED_TOOLS, default empty so the
   * SDK's `Agent` / `Task*` tools stay available as the inline-sync
   * subagent path — analogous to codex's native `spawn_agent`).
   * Plugin uses this to relay OpenClaw's tool policy (disableTools,
   * toolsAllow) onto the SDK's native tools (Read/Edit/Bash/etc.) which
   * don't otherwise traverse the dynamic-tools bridge.
   */
  disallowedTools?: string[] | null;
};

export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";

export type AskForApproval =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never"
  | {
      granular: {
        mcp_elicitations: boolean;
        rules: boolean;
        sandbox_approval: boolean;
        request_permissions?: boolean;
        skill_approval?: boolean;
      };
    };

export type SandboxPolicyResponse =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess?: boolean }
  | { type: "externalSandbox"; networkAccess?: JsonValue }
  | { type: string; [key: string]: unknown };

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * The full ThreadStartResponse shape codex validates against. Required
 * fields per v2/ThreadStartResponse.json: approvalPolicy, approvalsReviewer,
 * cwd, model, modelProvider, sandbox, thread.
 */
export type ThreadStartResponse = {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: AskForApproval;
  approvalsReviewer: ApprovalsReviewer;
  sandbox: SandboxPolicyResponse;
  instructionSources?: string[];
  runtimeWorkspaceRoots?: string[];
  reasoningEffort?: ReasoningEffort | null;
  serviceTier?: string | null;
  activePermissionProfile?: JsonValue | null;
  permissionProfile?: JsonValue | null;
};

// ─── thread/resume ───────────────────────────────────────────────────────────

export type ThreadResumeParams = JsonObject & {
  threadId: string;
  model?: string;
  modelProvider?: string | null;
  approvalPolicy?: string | JsonObject;
  approvalsReviewer?: string | null;
  sandbox?: SandboxPolicy;
  serviceTier?: string | null;
  config?: JsonObject;
  developerInstructions?: string;
  persistExtendedHistory?: boolean;
  /**
   * Workspace path the plugin wants the SDK's native tools to operate in.
   * When provided, the server patches meta.cwd so subsequent turns
   * (which pin sdkOptions.cwd from meta.cwd) pick up the new path
   * without rotating the thread / losing transcript history. Used by the
   * claude extension when openclaw's resolveSandboxContext switches
   * effectiveWorkspace mid-session.
   */
  cwd?: string;
};

export type ThreadResumeResponse = ThreadStartResponse;

// ─── thread/fork ─────────────────────────────────────────────────────────────

export type ThreadForkParams = ThreadStartParams & {
  threadId: string;
  baseInstructions?: string;
  ephemeral?: boolean;
  threadSource?: string | JsonObject;
  excludeTurns?: boolean;
};

export type ThreadForkResponse = ThreadStartResponse;

// ─── thread/inject_items ─────────────────────────────────────────────────────

export type ThreadInjectItemsParams = JsonObject & {
  threadId: string;
  items: JsonValue[];
};

// ─── thread/unsubscribe ──────────────────────────────────────────────────────

export type ThreadUnsubscribeParams = JsonObject & {
  threadId: string;
};

// ─── turn/start ──────────────────────────────────────────────────────────────

export type TurnCollaborationMode = {
  mode: string;
  settings: JsonObject & {
    developer_instructions: string | null;
  };
};

export type TurnStartParams = JsonObject & {
  threadId: string;
  input?: UserInput[];
  cwd?: string;
  model?: string;
  approvalPolicy?: string | JsonObject;
  approvalsReviewer?: string | null;
  sandboxPolicy?: SandboxPolicy;
  serviceTier?: string | null;
  effort?: string | null;
  /**
   * Per-turn Fast mode opt-in. The bridge forwards this verbatim to the
   * Claude Agent SDK's `settings.fastMode`. The bridge does not gate on
   * model capability — the caller (e.g. the openclaw claude-bridge harness)
   * is responsible for setting this only when the resolved model has
   * `supportsFastMode: true`, and for handling the SDK's per-result
   * `fast_mode_state: "off" | "cooldown" | "on"` reporting back.
   */
  fastMode?: boolean | null;
  collaborationMode?: TurnCollaborationMode | null;
  /**
   * Set by the caller when this turn's thread is known to be one-shot —
   * heartbeat, cron, or subagent-dispatched runs that never return to reuse
   * their thread (as opposed to an interactive chat, which may send another
   * turn on the same thread at any time). When true, the bridge discards the
   * attempt (closes the underlying subprocess) immediately after this turn
   * completes, regardless of whether a later turn with matching settings
   * could otherwise have reused it — there's no reuse to wait for, so
   * holding the subprocess idle until the query-thread-timeout sweep would
   * just waste memory. Omit (or false) for anything that might come back.
   */
  oneShot?: boolean;
};

export type TurnStartResponse = {
  turn: Turn;
};

// ─── turn/interrupt / turn/steer ─────────────────────────────────────────────

export type TurnInterruptParams = JsonObject & {
  threadId: string;
  turnId: string;
};

export type TurnSteerParams = JsonObject & {
  threadId: string;
  content: string;
};

// ─── Turn + items ────────────────────────────────────────────────────────────

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export type TurnError = {
  message: string;
  additionalDetails?: string | null;
  codexErrorInfo?: JsonValue | null;
};

export type Turn = {
  id: string;
  status: TurnStatus;
  items: ThreadItem[];
  threadId?: string;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  error?: TurnError | null;
  itemsView?: "notLoaded" | "summary" | "full";
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
  arguments?: JsonValue;
  result?: JsonValue;
  error?: ErrorNotification["error"];
  exitCode?: number | null;
  durationMs?: number | null;
  aggregatedOutput: string | null;
  text: string;
  contentItems?: DynamicToolCallOutputContentItem[] | null;
  changes: Array<{ path: string; kind: string }>;
  [key: string]: unknown;
};

// ─── Notifications (server → client, no id) ──────────────────────────────────

export type ThreadStartedNotification = {
  thread: Thread;
};

export type ThreadStatusChangedNotification = {
  threadId: string;
  status: ThreadStatus;
};

export type TurnStartedNotification = {
  threadId: string;
  turnId: string;
};

export type TurnCompletedNotification = {
  turn: Turn;
};

export type ItemStartedNotification = {
  threadId: string;
  turnId: string;
  item: ThreadItem;
};

export type ItemCompletedNotification = {
  threadId: string;
  turnId: string;
  item: ThreadItem;
};

export type AgentMessageDeltaParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
};

export type ErrorNotification = {
  error: {
    message?: string;
    errorCode?: string;
    detail?: string;
    [key: string]: unknown;
  };
  message?: string;
};

// ─── Server→client request: approvals (codex shapes) ─────────────────────────

export type CommandExecutionApprovalRequest = {
  threadId: string;
  turnId: string;
  callId: string;
  command: string[];
  cwd?: string;
  reason?: string;
};

export type CommandExecutionApprovalResponse = {
  decision: "approve" | "approve_for_session" | "decline";
  reason?: string;
};

export type FileChangeApprovalRequest = {
  threadId: string;
  turnId: string;
  callId: string;
  changes: Array<{ path: string; kind: string }>;
  reason?: string;
};

export type FileChangeApprovalResponse = {
  decision: "approve" | "approve_for_session" | "decline";
  reason?: string;
};

export type PermissionsApprovalRequest = {
  threadId: string;
  turnId: string;
  callId: string;
  requestedPermissions: JsonObject;
};

export type PermissionsApprovalResponse = {
  permissions: JsonObject;
  scope: "turn" | "session";
};

// ─── Model catalog (model/list) ──────────────────────────────────────────────

export type InputModality = "text" | "image" | string;

export type ReasoningEffortOption = {
  reasoningEffort: ReasoningEffort;
  description: string;
};

export type Model = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: ReasoningEffortOption[];
  inputModalities?: InputModality[];
  serviceTiers?: string[];
  supportsPersonality?: boolean;
  upgrade?: string | null;
  upgradeInfo?: JsonValue | null;
  availabilityNux?: JsonValue | null;
};

export type ModelListResponse = {
  data: Model[];
  nextCursor?: string | null;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isRpcResponse(message: RpcMessage): message is RpcResponse {
  return "id" in message && !("method" in message);
}

export function isRpcRequest(message: RpcMessage): message is RpcRequest {
  return "method" in message && "id" in message && message.id !== undefined;
}

export function isRpcNotification(message: RpcMessage): message is RpcNotification {
  return "method" in message && !("id" in message);
}
