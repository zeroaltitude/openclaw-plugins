import { describe, expect, it } from "vitest";

import { handleStreamEvent } from "../src/turn-runner.js";

/**
 * Regression for the 2026-07-20 production failure: the activity emitter armed
 * at a tool_use block's content_block_stop was killed within milliseconds by
 * the message_delta/message_stop envelope events that CLOSE the same
 * tool-calling assistant message — all of which arrive BEFORE the tool's
 * silent execution begins. A 150s Bash call ran entirely unvouched.
 *
 * These drive handleStreamEvent over the real SDK event sequence with a spy
 * controller and assert the arm survives the envelope and through the silent
 * window, disarming only when genuinely-resumed content or the next block
 * arrives.
 */
type Action = { type: "arm" | "disarm"; kind?: string; tool?: string };

function harness() {
  const actions: Action[] = [];
  const controller = {
    arm: (kind?: string, tool?: string) => actions.push({ type: "arm", kind, tool }),
    disarm: () => actions.push({ type: "disarm" }),
  };
  const blocks = new Map<number, unknown>();
  const turn = { turnId: "turn-1", items: [] as unknown[] } as never;
  const meta = { id: "thread-1" } as never;
  const tracker = {} as never;
  const notify = () => {};
  const feed = (event: Record<string, unknown>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleStreamEvent({ event } as never, blocks as never, turn, meta, notify, tracker, controller as never);
  return { actions, feed };
}

const toolUse = (idx: number, id: string, name: string) => ({
  type: "content_block_start",
  index: idx,
  content_block: { type: "tool_use", id, name },
});
const inputDelta = (idx: number, json: string) => ({
  type: "content_block_delta",
  index: idx,
  delta: { type: "input_json_delta", partial_json: json },
});
const blockStop = (idx: number) => ({ type: "content_block_stop", index: idx });
const textStart = (idx: number, id: string) => ({
  type: "content_block_start",
  index: idx,
  content_block: { type: "text", id },
});

describe("native-tool activity emitter lifecycle (handleStreamEvent)", () => {
  it("keeps the arm alive across the tool-call message envelope, then disarms when new content resumes", () => {
    const { actions, feed } = harness();
    // Bash tool call being described:
    feed(toolUse(0, "tool-1", "Bash"));
    feed(inputDelta(0, '{"command":"sleep 150"}'));
    feed(blockStop(0)); // ← ARM (toolActivity, Bash)
    // Envelope events that close the assistant message (pre-execution):
    feed({ type: "message_delta", delta: { stop_reason: "tool_use" } });
    feed({ type: "message_stop" });
    // [150s of silent execution — emitter MUST stay armed here]
    // Post-execution: a fresh assistant message begins with text.
    feed({ type: "message_start", message: { role: "assistant" } });
    feed(textStart(0, "text-1")); // ← DISARM (real output resumed)

    const armIndex = actions.findIndex((a) => a.type === "arm");
    const disarmAfterArm = actions.findIndex((a, i) => i > armIndex && a.type === "disarm");
    // The arm must be for the tool, and the FIRST disarm after it must be the
    // text-resume — not one of the two envelope events in between.
    expect(actions[armIndex]).toEqual({ type: "arm", kind: "toolActivity", tool: "Bash" });
    // No disarm occurred during the envelope + silent window (indices between
    // the arm and the final text-start feed).
    const between = actions.slice(armIndex + 1, disarmAfterArm);
    expect(between).toEqual([]); // envelope produced zero disarms
    expect(disarmAfterArm).toBeGreaterThan(armIndex); // it does eventually disarm on resume
  });

  it("arms a native subagent tool with the subagentActivity kind", () => {
    const { actions, feed } = harness();
    feed(toolUse(0, "t", "Task"));
    feed(blockStop(0));
    expect(actions.some((a) => a.type === "arm" && a.kind === "subagentActivity" && a.tool === "Task")).toBe(true);
  });
});
