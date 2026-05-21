/**
 * Registry of in-flight turns. Keyed by turnId. Tracks the AbortController so
 * `turn/interrupt` can find and cancel a turn from a different request.
 */

import type { ThreadItem, TurnStatus } from "./protocol.js";
import type { ControllableUserInputQueue } from "./user-input.js";

export type ActiveTurn = {
  threadId: string;
  turnId: string;
  abortController: AbortController;
  /** Unix seconds when the turn started (for codex Turn.startedAt). */
  startedAtSeconds: number;
  /** Milliseconds since epoch when the turn started (for duration calc). */
  startedAtMs: number;
  items: ThreadItem[];
  status: TurnStatus;
  /**
   * The user-input queue feeding the SDK's `query({prompt: …})`. `turn/steer`
   * pushes additional SDKUserMessage entries into it; the runner closes the
   * queue when the turn terminates so the SDK iteration ends.
   */
  inputQueue?: ControllableUserInputQueue;
};

export class ActiveTurnRegistry {
  private readonly byId = new Map<string, ActiveTurn>();

  register(turn: ActiveTurn): void {
    this.byId.set(turn.turnId, turn);
  }

  get(turnId: string): ActiveTurn | undefined {
    return this.byId.get(turnId);
  }

  /** Find a turn by (threadId, turnId). Returns undefined if either mismatches. */
  find(threadId: string, turnId: string): ActiveTurn | undefined {
    const t = this.byId.get(turnId);
    return t && t.threadId === threadId ? t : undefined;
  }

  /** Find the most-recently-started active turn for a thread. */
  findByThread(threadId: string): ActiveTurn | undefined {
    let latest: ActiveTurn | undefined;
    for (const t of this.byId.values()) {
      if (t.threadId !== threadId) continue;
      if (!latest || t.startedAtMs > latest.startedAtMs) latest = t;
    }
    return latest;
  }

  remove(turnId: string): void {
    this.byId.delete(turnId);
  }

  size(): number {
    return this.byId.size;
  }
}
