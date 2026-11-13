/**
 * A tool call the harness REFUSED must taint nothing.
 *
 * ## The incident
 *
 * On 2026-11-12 a model named two tools that do not exist — `mcp__observe`
 * (19:18:46) and `mcp__invoke` (19:22:56). Claude Code refused both calls
 * outright: nothing was dispatched, no tool ran, and no content of any kind
 * entered the turn. OpenClaw still relayed an `after_tool_call` for each name,
 * `getToolTrust()` found no entry, the unknown-tool default labelled it
 * `untrusted`, and `before_tool_call` then refused every later tool call in
 * the session (`TOOL_TAINT_ESCALATION … caused by: mcp__invoke(untrusted)`).
 * A release run and the 1.0.6 dispatcher both died that way.
 *
 * ## Why this module reads ONE boolean and nothing else
 *
 * Here is exactly what the plugin receives for a refused call in the
 * claude-cli runtime (established from openclaw source and from the two real
 * transcript payloads — see `~/reports/openclaw-provenance-rejected-call/REPORT.md`):
 *
 *   toolName:  "mcp__invoke"
 *   params:    {}                                   // the model's own input
 *   result:    "<tool_use_error>Error: No such tool available: mcp__invoke</tool_use_error>"
 *   error:     "CLI tool execution failed"          // a constant placeholder
 *   durationMs: ~3
 *
 * and here is what it receives for a real tool that RAN and returned an
 * error: the same `toolName`/`params` shape, a result from the tool, and
 * `error` set from that result. **`error` is populated in both cases.** The
 * stream contract the gateway reads this from (`CliToolResultDelta` in
 * openclaw `src/agents/cli-output-contracts.ts`) is
 * `{ toolCallId, name, isError, result? }` — there is no rejection field, no
 * code, and no registry membership on it. So:
 *
 *   - **Error text is not a rule.** `"No such tool available"` lives in the
 *     tool result, and a tool result is content: any MCP server could return
 *     that exact string with `is_error: true`. Keying on it is how you build
 *     an under-tainting bypass, which is why the previous patch
 *     (`openclaw-provenance-0ii`, §7 item 2) deliberately left this undone.
 *   - **A name shape is not a rule.** `mcp__observe` looks like an MCP
 *     namespace, but a name tells you nothing about whether a call ran.
 *   - **`error` alone is not a rule.** A tool that ran and failed sets it too,
 *     and such a tool keeps its label — its output is still its output.
 *
 * What is left is registry knowledge — *was this name among the tools the
 * gateway offered this run?* — and only the gateway has it. So this module
 * reads a single structural boolean that the **gateway** sets on the hook
 * event, `event.rejected === true`, and refuses to infer rejection from
 * anything else.
 *
 * ## Why this cannot be forged, and cannot under-taint
 *
 * `after_tool_call` events are built field-by-field by openclaw's own
 * `runAgentHarnessAfterToolCallHook` (`src/agents/harness/hook-helpers.ts`)
 * from an explicit field list. A tool's *output* only ever reaches the plugin
 * nested under `event.result`; it can never become a top-level `event` field.
 * This module therefore reads `rejected` off the event root only — never from
 * `result`, `details`, `params`, or any text — and demands the boolean `true`,
 * so a result that merely *contains* `"rejected": true`, or the words of the
 * rejection, gets no exemption.
 *
 * The signal does not exist in OpenClaw yet (as of 2026.11.3). Until the
 * gateway sets it, this predicate is always false and the plugin behaves
 * exactly as before — it fails closed, in the tainting direction. The one
 * localized gateway change that would supply it is specified in the report.
 */

/** The field the gateway sets when it refused to dispatch a named tool. */
export const REJECTED_CALL_EVENT_FIELD = "rejected" as const;

/**
 * True only when the gateway itself declared that it never dispatched this
 * call, i.e. the harness had no such tool and nothing ran.
 *
 * Deliberately strict: the event root, the exact field, the boolean `true`.
 * Nothing about the result, the error, or the name participates.
 */
export function isHarnessRejectedToolCall(event: unknown): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return false;
  }
  return (event as Record<string, unknown>)[REJECTED_CALL_EVENT_FIELD] === true;
}
