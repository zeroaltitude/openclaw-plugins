/**
 * Per-turn latency tracker.
 *
 * A "turn" is born at message_received (or lazily at the first lifecycle hook
 * that references a session nobody has a turn open for — heartbeats and cron
 * runs have no inbound message) and dies at message_sent, or shortly after
 * agent_end when nothing gets delivered. Every hook appends a mark; the
 * summary renders the mark chain with deltas so slowness names its segment
 * instead of hiding in an end-to-end total.
 */
import { randomUUID } from "node:crypto";

export interface TurnMark {
  hook: string;
  /** ms since turn start */
  atMs: number;
  detail?: string;
}

export interface TurnRecord {
  turnId: string;
  origin: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  messageId?: string;
  startedAtMs: number;
  endedAtMs?: number;
  llmIterations: number;
  toolCalls: number;
  toolTotalMs: number;
  marks: TurnMark[];
  finalized: boolean;
}

export interface FinalizedTurnSummary {
  turn: TurnRecord;
  totalMs: number;
  /** The largest inter-mark gap: [label, ms] */
  topGap: [string, number];
  line: string;
}

const AGENT_END_LINGER_MS = 5_000;

export class TurnTracker {
  private openBySession = new Map<string, TurnRecord>();
  /** Ingress turns whose session is not yet known; claimed by the first run-side mark. */
  private unclaimedIngress: TurnRecord[] = [];
  private lingerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly buffer: TurnRecord[] = [];

  constructor(
    private readonly options: {
      maxRetainedTurns: number;
      onFinalized: (summary: FinalizedTurnSummary) => void;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Session correlation key: sessionKey is stable; sessionId is the fallback. */
  private turnKey(ctx: { sessionKey?: string; sessionId?: string }): string | undefined {
    return ctx.sessionKey ?? ctx.sessionId;
  }

  /** How stale an unclaimed ingress turn may be before run-side claiming skips it. */
  private static readonly INGRESS_CLAIM_WINDOW_MS = 120_000;

  private claimIngressTurn(key: string, ctx: TurnContext): TurnRecord | undefined {
    const now = this.now();
    // Drop expired ingress turns so a lost message cannot pollute a later run.
    this.unclaimedIngress = this.unclaimedIngress.filter((turn) => {
      if (now - turn.startedAtMs > TurnTracker.INGRESS_CLAIM_WINDOW_MS) {
        this.finalizeRecord(turn, "unclaimed");
        return false;
      }
      return !turn.finalized;
    });
    // Prefer a channel match, else oldest. Single-gateway traffic makes the
    // heuristic safe enough; a mis-claim skews one turn, not the system.
    const index = this.unclaimedIngress.findIndex(
      (turn) => !ctx.channel || !turn.channel || turn.channel === ctx.channel,
    );
    if (index === -1) {
      return undefined;
    }
    const [turn] = this.unclaimedIngress.splice(index, 1);
    turn.sessionKey ??= ctx.sessionKey;
    turn.sessionId ??= ctx.sessionId;
    turn.agentId ??= ctx.agentId;
    this.openBySession.set(key, turn);
    return turn;
  }

  beginTurn(origin: string, ctx: TurnContext): TurnRecord | undefined {
    const key = this.turnKey(ctx);
    if (key) {
      const existing = this.openBySession.get(key);
      if (existing && !existing.finalized) {
        // A new inbound message while a turn is open: finalize the old one as
        // interrupted so its marks are not blended into the new turn.
        this.finalize(key, "superseded");
      }
    }
    const startedAtMs = this.now();
    const turn: TurnRecord = {
      turnId: randomUUID().slice(0, 8),
      origin,
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      channel: ctx.channel,
      messageId: ctx.messageId,
      startedAtMs,
      llmIterations: 0,
      toolCalls: 0,
      toolTotalMs: 0,
      marks: [{ hook: origin, atMs: 0 }],
      finalized: false,
    };
    if (key) {
      this.openBySession.set(key, turn);
    } else {
      // message_received fires before routing resolves a session; park the
      // turn until the first run-side mark claims it by recency/channel.
      this.unclaimedIngress.push(turn);
    }
    return turn;
  }

  mark(hook: string, ctx: TurnContext, detail?: string): TurnRecord | undefined {
    const key = this.turnKey(ctx);
    if (!key) {
      return undefined;
    }
    let turn = this.openBySession.get(key);
    if (!turn || turn.finalized) {
      turn = this.claimIngressTurn(key, ctx);
    }
    if (!turn || turn.finalized) {
      // Background runs (heartbeat/cron/subagent) have no inbound message;
      // their first lifecycle hook opens the turn so they are traced too.
      turn = this.beginTurn(hook, ctx);
      if (!turn) {
        return undefined;
      }
      if (detail) {
        turn.marks[0] = { hook, atMs: 0, detail };
      }
      return turn;
    }
    // Later hooks often carry ids the opener lacked.
    turn.sessionId ??= ctx.sessionId;
    turn.agentId ??= ctx.agentId;
    const mark: TurnMark = { hook, atMs: this.now() - turn.startedAtMs };
    if (detail) {
      mark.detail = detail;
    }
    turn.marks.push(mark);
    if (hook === "llm_input") {
      turn.llmIterations += 1;
      mark.detail = `iter=${turn.llmIterations}`;
    }
    if (hook === "after_tool_call") {
      turn.toolCalls += 1;
    }
    if (hook === "agent_end") {
      this.scheduleLinger(key);
    }
    if (hook === "message_sent") {
      this.finalize(key, "delivered");
    }
    return turn;
  }

  private scheduleLinger(key: string): void {
    const existing = this.lingerTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    // agent_end without a delivery (recorded non-outcome, heartbeat OK-quiet)
    // still finalizes so the turn is never stuck open.
    const timer = setTimeout(() => {
      this.lingerTimers.delete(key);
      this.finalize(key, "no-delivery");
    }, AGENT_END_LINGER_MS);
    timer.unref?.();
    this.lingerTimers.set(key, timer);
  }

  finalize(key: string, reason: string): void {
    const timer = this.lingerTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.lingerTimers.delete(key);
    }
    const turn = this.openBySession.get(key);
    if (!turn || turn.finalized) {
      return;
    }
    this.openBySession.delete(key);
    this.finalizeRecord(turn, reason);
  }

  private finalizeRecord(turn: TurnRecord, reason: string): void {
    if (turn.finalized) {
      return;
    }
    turn.finalized = true;
    turn.endedAtMs = this.now();
    this.buffer.push(turn);
    if (this.buffer.length > this.options.maxRetainedTurns) {
      this.buffer.splice(0, this.buffer.length - this.options.maxRetainedTurns);
    }
    this.options.onFinalized(summarizeTurn(turn, reason));
  }

  recentTurns(): TurnRecord[] {
    return [...this.buffer].reverse();
  }

  openTurns(): TurnRecord[] {
    return Array.from(this.openBySession.values());
  }

  shutdown(): void {
    for (const timer of this.lingerTimers.values()) {
      clearTimeout(timer);
    }
    this.lingerTimers.clear();
  }
}

export interface TurnContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  messageId?: string;
}

export function summarizeTurn(turn: TurnRecord, reason: string): FinalizedTurnSummary {
  const totalMs = (turn.endedAtMs ?? turn.startedAtMs) - turn.startedAtMs;
  let topGap: [string, number] = ["none", 0];
  const chain: string[] = [];
  for (let index = 0; index < turn.marks.length; index += 1) {
    const mark = turn.marks[index];
    const prevAt = index === 0 ? 0 : turn.marks[index - 1].atMs;
    const gap = mark.atMs - prevAt;
    if (gap > topGap[1]) {
      topGap = [`${index === 0 ? "start" : turn.marks[index - 1].hook}→${mark.hook}`, gap];
    }
    chain.push(`${mark.hook}${mark.detail ? `[${mark.detail}]` : ""}+${gap}`);
  }
  const tail = turn.endedAtMs !== undefined && turn.marks.length > 0;
  if (tail) {
    const lastMark = turn.marks[turn.marks.length - 1];
    const endGap = totalMs - lastMark.atMs;
    if (endGap > topGap[1]) {
      topGap = [`${lastMark.hook}→end`, endGap];
    }
  }
  const line =
    `turn=${turn.turnId} agent=${turn.agentId ?? "?"} total=${totalMs}ms ` +
    `outcome=${reason} llm_iters=${turn.llmIterations} tools=${turn.toolCalls} ` +
    `top=${topGap[0]}:${topGap[1]}ms session=${turn.sessionKey ?? turn.sessionId ?? "?"} ` +
    `chain: ${chain.join(" ")}`;
  return { turn, totalMs, topGap, line };
}
