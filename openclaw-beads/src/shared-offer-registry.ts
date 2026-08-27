/**
 * Single-offer registry for shared (unassigned) ready issues.
 *
 * ## What this is for (openclaw-1lw7, second gate)
 *
 * `bd update <id> --claim` is a durable compare-and-set and is the primary
 * mechanism: if two agents both claim, exactly one wins and the other is told.
 * But that only arbitrates agents that actually *run the claim*. The incident
 * that motivated this happened because there was no claim step at all — the
 * run-loop preamble said "mark the issue in_progress", which is last-write-wins
 * — so both racers believed they had it and both spawned.
 *
 * Instructing the model to claim first is prose, and prose has now failed three
 * times. This registry is the part that does not depend on the model obeying
 * anything: a shared issue id is handed to exactly ONE agent at a time. An
 * agent that is not the holder never receives the id, so it cannot spawn work
 * on it however it chooses to interpret its instructions.
 *
 * ## Why an in-process map is sufficient here, and honest about its limits
 *
 * Every agent's prompt is built by the same `openclaw-beads` plugin instance
 * inside the one gateway process, and JavaScript runs those builds on a single
 * thread. So a synchronous check-and-set on a `Map` is genuinely atomic with
 * respect to every competing prompt build — which is exactly the population
 * that collided (three heartbeat wakes, `Promise.all`, one process).
 *
 * It is NOT durable and NOT multi-host, and it is deliberately not the only
 * defense: it is a coarse admission gate in front of the real arbiter. If the
 * gateway restarts, or a subagent shells out to `bd` directly, the registry
 * knows nothing — and the compare-and-set behind it still holds the line. Do
 * not promote this to "the mechanism"; the claim is the mechanism.
 *
 * ## Starvation is bounded on purpose
 *
 * An offer expires (default 5 minutes, `runLoop.sharedOfferTtlMs`), so an agent
 * that takes an offer and then does nothing with it parks the issue for at most
 * one heartbeat cycle rather than forever. Withheld issues are still COUNTED and
 * explained in the block (`hidden_offered_elsewhere`), because per
 * openclaw-beads-7sz a silently shortened queue is indistinguishable from an
 * empty one.
 */

export interface SharedOfferResult {
  /** The agent the issue is currently offered to. */
  holder: string;
  /** True when this call is what acquired (or renewed) the offer. */
  acquired: boolean;
  /** Epoch ms at which the offer lapses. */
  expiresAt: number;
}

export const DEFAULT_SHARED_OFFER_TTL_MS = 300_000;

interface Offer {
  agentId: string;
  expiresAt: number;
}

export class SharedOfferRegistry {
  private readonly offers = new Map<string, Offer>();
  private readonly now: () => number;

  /** `now` is injectable so TTL expiry is testable without sleeping. */
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Offer `key` to `agentId` if it is free (or already theirs, or lapsed).
   *
   * Synchronous and side-effecting in one step — never split this into a
   * "check" and a later "take", which would be the very read-then-write race
   * this exists to close.
   */
  offer(key: string, agentId: string, ttlMs: number): SharedOfferResult {
    const t = this.now();
    const existing = this.offers.get(key);
    if (existing && existing.expiresAt > t && existing.agentId !== agentId) {
      return { holder: existing.agentId, acquired: false, expiresAt: existing.expiresAt };
    }
    const expiresAt = t + Math.max(0, ttlMs);
    this.offers.set(key, { agentId, expiresAt });
    return { holder: agentId, acquired: true, expiresAt };
  }

  /** Current holder, or undefined when free or lapsed. */
  holder(key: string): string | undefined {
    const existing = this.offers.get(key);
    if (!existing) return undefined;
    if (existing.expiresAt <= this.now()) {
      this.offers.delete(key);
      return undefined;
    }
    return existing.agentId;
  }

  /**
   * Drop an offer. Called once an issue stops being shared (somebody's claim
   * landed, or it left the ready set) so the map does not accumulate keys for
   * issues nobody is racing any more.
   */
  release(key: string): void {
    this.offers.delete(key);
  }

  /** Drop every lapsed entry. Cheap; the map is bounded by the ready set. */
  prune(): void {
    const t = this.now();
    for (const [key, offer] of this.offers) {
      if (offer.expiresAt <= t) this.offers.delete(key);
    }
  }

  /** Live (unlapsed) offer count — for tests and diagnostics. */
  size(): number {
    this.prune();
    return this.offers.size;
  }
}
