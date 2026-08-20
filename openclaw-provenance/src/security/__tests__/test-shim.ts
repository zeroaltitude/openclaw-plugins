/**
 * Test compatibility shim for the legacy → mainline hook surface migration.
 *
 * The pre-migration test suite drove provenance through scenarios by
 * firing legacy hooks directly (`api.fire("context_assembled", ...)`,
 * `api.fire("before_llm_call", ...)`, etc.). Those hook names no longer
 * have subscribers in the migrated provenance plugin.
 *
 * Rewriting every fire-site across 6 test files is mechanical but
 * tedious. This shim instead intercepts legacy fire() calls inside
 * `makeApi()` and translates them to the equivalent new-hook fire()
 * sequences. Tests keep their existing structure.
 *
 * Translation map (matches the production migration):
 *
 *   Legacy hook         | New hook(s)
 *   --------------------|-----------------------------------------------
 *   context_assembled   | before_prompt_build (event remapped:
 *                       |   {systemPrompt,messages,messageCount} →
 *                       |   {prompt: <last user>, messages})
 *   before_llm_call     | (no-op — the mutation work is done inside
 *                       |  before_prompt_build above; legacy fires of
 *                       |  this hook in tests just trigger no-side-
 *                       |  effects since the only thing that mattered
 *                       |  was the systemPrompt return value, which
 *                       |  was driving via before_prompt_build now)
 *   after_llm_call      | llm_output (event remapped:
 *                       |   {toolCalls,iteration,...} →
 *                       |   {assistantTexts:[],lastAssistant:undefined})
 *                       |
 *                       | Tests that previously fired after_llm_call
 *                       | with toolCalls were exercising the legacy
 *                       | tool-gating code path inside that hook.
 *                       | That path now lives in before_tool_call
 *                       | (per-tool gating). Tests that need to
 *                       | exercise tool gating should fire
 *                       | before_tool_call directly.
 *   before_response_emit| agent_end (event remapped:
 *                       |   {content} → {messages:[...,assistant
 *                       |    content], success:true, durationMs:0})
 *   loop_iteration_*    | no-op (observation-only hooks dropped from
 *                       |  the new architecture)
 *
 * Tests that exercise identity-driven behaviour (senderIsOwner,
 * groupId, sourceProvider, etc.) should call seedIdentity() before
 * firing agent-loop hooks. Pre-migration these came from the agent
 * hookCtx; now they come from the IdentityStore (populated by
 * inbound_claim in production).
 *
 * ── Identity auto-seeding is legacy-only. New tests must opt out. ──
 *
 * By default `makeApi()` also auto-seeds the IdentityStore from identity
 * fields found on the fire() ctx (see autoSeedFromCtx below). That default
 * exists solely to keep the pre-migration corpus green, and it is a
 * FICTION — see MakeApiOptions.autoSeedIdentity for what it hides. Pass
 * `{ autoSeedIdentity: false }` in any new test.
 */

import { getSharedIdentityStore, type IdentityRecord } from "../identity-store.js";

interface HookHandler {
  (...args: any[]): any;
}

/**
 * Auto-seed the IdentityStore from a legacy test ctx that carries
 * identity fields directly (senderId, senderIsOwner, etc.). Pre-migration
 * these came from agent hookCtx; tests still construct them that way.
 * Idempotent: subsequent calls upsert the same fields and only flush
 * once per change.
 *
 * Looks at multiple env-var hints and ctx fields to find the workspaceDir.
 * If none is found, falls back to the literal string "unknown" — most
 * tests construct the IdentityStore via registerSecurityHooks(), which
 * sets the workspace via config; this fallback is only for tests that
 * don't go through that path.
 */
function autoSeedFromCtx(workspaceDir: string, ctx: any): void {
  if (!ctx || typeof ctx !== "object") return;
  const sessionKey = ctx.sessionKey;
  if (typeof sessionKey !== "string" || sessionKey.length === 0) return;
  // Only seed identity-relevant fields if at least one is present on ctx;
  // pure agent-hookCtx fires (no identity) shouldn't churn the store.
  const hasIdentity =
    ctx.senderId !== undefined ||
    ctx.senderIsOwner !== undefined ||
    ctx.senderName !== undefined ||
    ctx.sourceProvider !== undefined ||
    ctx.groupId !== undefined ||
    ctx.spawnedBy !== undefined ||
    ctx.messageProvider !== undefined;
  if (!hasIdentity) return;
  const store = getSharedIdentityStore(workspaceDir);
  store.upsert({
    sessionKey,
    senderId: ctx.senderId !== undefined ? ctx.senderId : null,
    senderName: ctx.senderName !== undefined ? ctx.senderName : null,
    senderIsOwner: ctx.senderIsOwner === true,
    sourceProvider:
      typeof ctx.sourceProvider === "string"
        ? ctx.sourceProvider
        : typeof ctx.messageProvider === "string"
          ? ctx.messageProvider
          : undefined,
    groupId: ctx.groupId !== undefined ? ctx.groupId : null,
    spawnedBy: ctx.spawnedBy !== undefined ? ctx.spawnedBy : null,
  });
  store.flush();
}

export interface TestApi {
  on(name: string, handler: HookHandler): void;
  fire(name: string, event: any, ctx: any): any;
  registerCommand(opts: { name: string; handler: (ctx: any) => any }): void;
  invokeCommand(name: string, ctx?: any): any;
  hooks: Map<string, HookHandler[]>;
  commands: Map<string, { name: string; handler: (ctx: any) => any }>;
}

export interface MakeApiOptions {
  /**
   * Auto-seed the IdentityStore from identity fields found on the fire()
   * ctx. Defaults to `true` for backwards compatibility with the
   * pre-migration test corpus; **new tests should pass `false`.**
   *
   * Why it is a fiction: mainline's `PluginHookAgentContext`
   * (openclaw `src/plugins/hook-types.ts`) carries only `senderId` — and
   * only for `trigger === "user"`, since
   * `buildAgentHookContextIdentityFields()` returns `{}` for every other
   * trigger — plus `messageProvider`. It never carries `senderIsOwner`,
   * `sourceProvider`, `groupId` or `spawnedBy`. Auto-seeding invents an
   * identity record from fields production never supplies, which hides two
   * things:
   *
   *  1. **The production seed never runs.** `before_prompt_build` seeds the
   *     store itself from `ctx.senderId`, computing `senderIsOwner` via
   *     `computeSenderIsOwner()` against configured `ownerNumbers`. It gates
   *     that write on `resolveIdentitySeedReason()`, which returns
   *     `undefined` when the cached record's `senderId` already equals the
   *     hook's. Because the shim writes exactly such a record before the
   *     handler runs, the reason resolves to `undefined` and the whole
   *     ownerNumbers → senderIsOwner → policy chain is skipped. Three
   *     production bugs shipped in that chain (manifest configSchema,
   *     pluginConfig forwarding, owner-flag drift) with a green suite.
   *
   *  2. **`senderIsOwner` becomes test-assertable.** A test can declare
   *     `senderIsOwner: true` on ctx and be treated as owner — a privilege
   *     production can only ever derive from `ownerNumbers`.
   *
   * It also means the no-identity path is only reachable with a *synthesized*
   * record (`senderId: null`) rather than with no record at all: any ctx
   * carrying `messageProvider` — which is nearly every test ctx — trips the
   * `hasIdentity` check below. Policy outcomes happen to agree today, but a
   * future fail-closed `if (!identity)` branch would be untestable.
   *
   * With `autoSeedIdentity: false` the shim passes ctx through untouched, so
   * the plugin's own seeding logic runs and both the seeded and the genuinely
   * absent identity paths are reachable. See
   * `production-identity-seed.test.ts`.
   */
  autoSeedIdentity?: boolean;
}

/**
 * Construct a test API with the legacy-hook compat shim. Tests should
 * pass the workspaceDir they will pass to registerSecurityHooks() so
 * the shim can auto-seed identity into the same IdentityStore.
 */
export function makeApi(
  workspaceDir: string = "__test_default__",
  opts: MakeApiOptions = {},
): TestApi {
  const autoSeedIdentity = opts.autoSeedIdentity !== false;
  const hooks = new Map<string, HookHandler[]>();
  const commands = new Map<string, { name: string; handler: (ctx: any) => any }>();
  function rawFire(name: string, event: any, ctx: any): any {
    const handlers = hooks.get(name) ?? [];
    let result: any;
    for (const h of handlers) {
      result = h(event, ctx);
    }
    return result;
  }

  return {
    on(name: string, handler: HookHandler) {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name)!.push(handler);
    },
    fire(name: string, event: any, ctx: any): any {
      // Auto-seed identity from any ctx that carries identity fields.
      // Pre-migration tests constructed ctx with senderIsOwner/groupId/
      // etc. directly; in production those flow from inbound_claim into
      // IdentityStore. Doing it here keeps tests un-touched while making
      // the new lookup path work.
      //
      // Opt-out (autoSeedIdentity: false) leaves ctx alone so the plugin's
      // own before_prompt_build seed runs — the production path. See
      // MakeApiOptions.autoSeedIdentity.
      if (autoSeedIdentity) autoSeedFromCtx(workspaceDir, ctx);

      // Pass through new hook names unchanged.
      if (
        name === "before_prompt_build" ||
        name === "llm_input" ||
        name === "llm_output" ||
        name === "agent_end" ||
        name === "message_sending" ||
        name === "before_tool_call" ||
        name === "after_tool_call" ||
        name === "before_reset" ||
        name === "inbound_claim" ||
        name === "subagent_spawned"
      ) {
        return rawFire(name, event, ctx);
      }

      // Legacy hook translation.
      switch (name) {
        case "context_assembled": {
          const messages = Array.isArray(event?.messages) ? event.messages : [];
          // Extract last user message text as the new "prompt" field.
          let prompt = "";
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m?.role !== "user") continue;
            if (typeof m.content === "string") {
              prompt = m.content;
              break;
            }
            if (Array.isArray(m.content)) {
              prompt = m.content
                .filter((p: any) => p?.type === "text" && typeof p.text === "string")
                .map((p: any) => p.text)
                .join("\n");
              break;
            }
          }
          return rawFire("before_prompt_build", { prompt, messages }, ctx);
        }
        case "before_llm_call": {
          // The mutation portion (systemPrompt taint footer) lives in
          // before_prompt_build now. The observation portion (llm_input)
          // does not need event.tools/iteration, so we synthesize a
          // minimal llm_input fire here for tests that only fire
          // before_llm_call without a context_assembled first.
          rawFire(
            "llm_input",
            {
              runId: event?.runId ?? "test-run",
              sessionId: ctx?.sessionId ?? "test-session",
              provider: event?.provider ?? "anthropic",
              model: event?.model ?? "test-model",
              systemPrompt: event?.systemPrompt ?? "",
              prompt: "",
              historyMessages: event?.messages ?? [],
              imagesCount: 0,
            },
            ctx,
          );
          // Tool-gating compat: legacy before_llm_call could return
          // { tools: filteredList } when at least one tool was filtered
          // out at the current taint level. Tests rely on that shape:
          //   - return undefined when nothing was filtered
          //   - return { tools: allowedList } when at least one was blocked
          // The new architecture does per-tool gating in before_tool_call.
          // We synthesize the legacy result by firing before_tool_call
          // per tool and assembling the allowed list.
          const tools = Array.isArray(event?.tools) ? event.tools : [];
          if (tools.length === 0) return undefined;
          const allowed: any[] = [];
          let blockedAny = false;
          for (const t of tools) {
            const toolName =
              typeof t === "string" ? t : typeof t?.name === "string" ? t.name : null;
            if (!toolName) continue;
            const btcResult = rawFire(
              "before_tool_call",
              { toolName, params: {} },
              ctx,
            );
            // before_tool_call returns undefined to allow, or { block: true } to block
            if (btcResult && btcResult.block === true) {
              blockedAny = true;
            } else {
              allowed.push(typeof t === "string" ? { name: t } : t);
            }
          }
          // Only return the filtered shape when something was actually
          // blocked — matches legacy before_llm_call return semantics.
          if (blockedAny) return { tools: allowed };
          return undefined;
        }
        case "after_llm_call": {
          // Most legacy after_llm_call test fires were exercising tool
          // gating. That path is now in before_tool_call (per-tool).
          // We translate to llm_output for observation, but tests that
          // need tool gating need to also fire before_tool_call for
          // each tool in event.toolCalls.
          rawFire(
            "llm_output",
            {
              runId: event?.runId ?? "test-run",
              sessionId: ctx?.sessionId ?? "test-session",
              provider: event?.provider ?? "anthropic",
              model: event?.model ?? "test-model",
              assistantTexts: [],
              lastAssistant: undefined,
            },
            ctx,
          );
          // For each proposed tool call, fire before_tool_call to
          // exercise per-tool gating (was inline in legacy after_llm_call).
          const toolCalls = Array.isArray(event?.toolCalls) ? event.toolCalls : [];
          for (const tc of toolCalls) {
            rawFire(
              "before_tool_call",
              {
                toolName: tc?.name,
                params: tc?.params ?? tc?.arguments ?? {},
              },
              ctx,
            );
          }
          return undefined;
        }
        case "before_response_emit": {
          // Build a minimal agent_end event with the assistant content.
          const content = typeof event?.content === "string" ? event.content : "";
          const fakeAssistant = { role: "assistant", content };
          const messages: any[] = [];
          if (content.length > 0) messages.push(fakeAssistant);
          return rawFire(
            "agent_end",
            { messages, success: true, durationMs: 0, runId: event?.runId },
            ctx,
          );
        }
        case "loop_iteration_start":
        case "loop_iteration_end":
          // Observation-only hooks dropped in the new architecture.
          return undefined;
        default:
          return rawFire(name, event, ctx);
      }
    },
    registerCommand(opts: { name: string; handler: (ctx: any) => any }) {
      commands.set(opts.name, opts);
    },
    invokeCommand(name: string, ctx: any = {}) {
      const cmd = commands.get(name);
      if (!cmd) throw new Error(`Command not registered: ${name}`);
      return cmd.handler(ctx);
    },
    hooks,
    commands,
  };
}

/**
 * Seed identity for a session as if an inbound_claim event had fired.
 * Tests that exercise senderIsOwner / groupId / sourceProvider / spawnedBy
 * should call this before firing agent-loop hooks.
 *
 * Uses the IdentityStore singleton scoped to the workspaceDir, so tests
 * MUST pass the same workspaceDir they passed to registerSecurityHooks.
 */
export function seedIdentity(
  workspaceDir: string,
  sessionKey: string,
  identity: Partial<IdentityRecord>,
): void {
  const store = getSharedIdentityStore(workspaceDir);
  store.upsert({
    sessionKey,
    senderIsOwner: identity.senderIsOwner ?? false,
    senderId: identity.senderId,
    senderName: identity.senderName,
    sourceProvider: identity.sourceProvider,
    groupId: identity.groupId,
    spawnedBy: identity.spawnedBy,
  });
  // Force immediate flush so nothing depends on debounce timing.
  store.flush();
}
