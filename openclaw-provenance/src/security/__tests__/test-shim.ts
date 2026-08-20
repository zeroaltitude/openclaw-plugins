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
 * ── Identity is never invented from the ctx ──
 *
 * `makeApi()` used to auto-seed the IdentityStore from identity fields found
 * on the fire() ctx, so that pre-migration tests declaring `senderIsOwner`,
 * `groupId`, `sourceProvider` or `spawnedBy` on a ctx kept passing. That was a
 * fiction — mainline's `PluginHookAgentContext` carries only `senderId` (and
 * only for `trigger === "user"`) plus `messageProvider` — and it hid the
 * plugin's own seed, up to and including letting a test declare itself the
 * owner. It is gone (openclaw-provenance-iz3).
 *
 * A ctx now passes through untouched, so the plugin does its own seeding.
 * Tests that need identity-driven behaviour have two routes:
 *
 *   - ownership: configure `ownerNumbers` and put the matching `senderId` on
 *     the ctx. `before_prompt_build` computes `senderIsOwner` itself — the
 *     only way production ever derives it.
 *   - groupId / spawnedBy / sourceProvider: call seedIdentity() (or fire
 *     `inbound_claim` / `subagent_spawned`), which is where these come from in
 *     production. No hook ctx carries them.
 */

import { getSharedIdentityStore, type IdentityRecord } from "../identity-store.js";

interface HookHandler {
  (...args: any[]): any;
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
   * Always `false` (the default). Retained so the flag that carried the
   * migration reads as settled rather than forgotten, and so a test rebased
   * from before openclaw-provenance-iz3 fails loudly instead of silently
   * losing its identity setup.
   *
   * The auto-seed this used to enable invented an IdentityStore record from
   * identity fields on the fire() ctx. Mainline's `PluginHookAgentContext`
   * (openclaw `src/plugins/hook-types.ts`) carries only `senderId` — and only
   * for `trigger === "user"`, since
   * `buildAgentHookContextIdentityFields()` returns `{}` for every other
   * trigger — plus `messageProvider`. It never carries `senderIsOwner`,
   * `sourceProvider`, `groupId` or `spawnedBy`. Seeding from those fields hid
   * three things:
   *
   *  1. **The production seed never ran.** `before_prompt_build` seeds the
   *     store itself from `ctx.senderId`, computing `senderIsOwner` via
   *     `computeSenderIsOwner()` against configured `ownerNumbers`. It gates
   *     that write on `resolveIdentitySeedReason()`, which returns
   *     `undefined` when the cached record's `senderId` already equals the
   *     hook's. Because the shim wrote exactly such a record before the
   *     handler ran, the reason resolved to `undefined` and the whole
   *     ownerNumbers → senderIsOwner → policy chain was skipped. Three
   *     production bugs shipped in that chain (manifest configSchema,
   *     pluginConfig forwarding, owner-flag drift) with a green suite.
   *
   *  2. **`senderIsOwner` was test-assertable.** A test could declare
   *     `senderIsOwner: true` on ctx and be treated as owner — a privilege
   *     production can only ever derive from `ownerNumbers`.
   *
   *  3. **The no-identity path was unreachable.** Any ctx carrying
   *     `messageProvider` — nearly every test ctx — got a *synthesized*
   *     record (`senderId: null`) instead of no record at all, so a
   *     fail-closed `if (!identity)` branch could not be tested.
   */
  autoSeedIdentity?: false;
}

/**
 * Construct a test API with the legacy-hook compat shim.
 */
export function makeApi(
  /**
   * Unused since the identity auto-seed was removed — the shim no longer
   * touches any store. Kept so every call site still reads
   * `makeApi(tmpDir)` next to `registerSecurityHooks(api, logger,
   * { workspaceDir: tmpDir })` and `seedIdentity(tmpDir, …)`, which is the
   * pairing that matters; dropping it would churn every call site to delete a
   * harmless argument.
   */
  _workspaceDir: string = "__test_default__",
  opts: MakeApiOptions = {},
): TestApi {
  // The type says `false`, but vitest does not typecheck. Fail loudly rather
  // than silently ignoring a rebased test's identity setup.
  if ((opts as { autoSeedIdentity?: unknown }).autoSeedIdentity === true) {
    throw new Error(
      "makeApi({ autoSeedIdentity: true }) was removed (openclaw-provenance-iz3): " +
        "the shim no longer invents identity records from the fire() ctx. " +
        "Configure ownerNumbers + ctx.senderId for ownership, or call " +
        "seedIdentity() for groupId/spawnedBy/sourceProvider.",
    );
  }
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
      // ctx passes through untouched: identity comes from the plugin's own
      // before_prompt_build seed, from inbound_claim/subagent_spawned, or from
      // seedIdentity() — never from fields a test puts on the ctx.

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
