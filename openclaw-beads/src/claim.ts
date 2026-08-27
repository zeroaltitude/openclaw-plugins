/**
 * The claim contract: assignee sentinels, and compare-and-set outcome
 * classification for `bd update <id> --claim`.
 *
 * ## Why this file exists (openclaw-1lw7)
 *
 * Three agents (main, narcissus, shiva) each claimed the same `assignee: any`
 * issue off three parallel heartbeat wakes inside four minutes. Two of them
 * spawned implementation subagents four seconds apart onto separate worktrees
 * cut from the same base SHA, and one run deleted the other's worktree and
 * branch mid-flight.
 *
 * The fix is NOT to build a compare-and-set — `bd update <id> --claim` already
 * is one. Measured against bd 1.0.3 with three concurrent racers on one
 * unassigned issue, three rounds out of three yielded exactly one `exit 0`
 * winner and two `exit 1` losers whose stderr named the winner. It is a real
 * conditional UPDATE inside a Dolt transaction, so it is durable and works
 * across processes and hosts — not just across agents in one gateway.
 *
 * The bug is that bd's claim predicate only admits an assignee that is empty,
 * NULL, or the actor itself. The literal string `any` reads as a real
 * claimant, so on an `assignee: any` issue `--claim` refuses *everyone*:
 *
 *     $ bd update probe-rag --claim --actor alice   # issue has assignee=any
 *     Error claiming probe-rag: issue already claimed by any
 *     exit=1
 *
 * Our fleet filed shared work as `assignee: any`. So the one class of issue
 * that most needs a compare-and-set — broadcast to every agent on every wake —
 * was precisely the class where the existing compare-and-set was unusable, and
 * every agent fell back to `bd update --assignee <me> --status in_progress`.
 * That is last-write-wins: every racer's write succeeds, the last one wins the
 * field, and no racer is ever told it lost.
 *
 * So this plugin does three things, in order of how much they are load-bearing:
 *
 *  1. Sentinels never reach bd from here. `normalizeAssignee` collapses them
 *     to unassigned on every write path, so `--claim` keeps working.
 *  2. `--claim` is the ONLY sanctioned way to take ownership. Taking it with
 *     `--assignee`/`--status` is the bug, not a shortcut around it.
 *  3. The loser is told, loudly. `classifyClaimFailure` turns bd's stderr into
 *     a typed outcome so "another agent owns this" can never be swallowed as
 *     a generic command failure.
 *
 * ### Do not "clear the assignee, then claim"
 *
 * It is two writes and it reopens the exact race it looks like it closes:
 * A clears `any`, A claims (assignee=A), then B — which read `any` before A
 * moved — clears again and wipes A's claim, and B claims too. Two winners.
 * There is no compare-and-set-guarded transition out of `any`, because bd's
 * predicate does not admit `any`. The only safe place to retire a sentinel row
 * is a dedicated normalization pass (see `normalizeSentinelAssignees`), whose
 * safety rests on a different invariant: it only ever touches rows whose
 * assignee is *exactly* a sentinel, and a genuine claim's assignee is never a
 * sentinel — so it cannot destroy a live claim.
 */

/**
 * Assignee strings that mean "nobody in particular owns this yet".
 *
 * These are pseudo-owners our own conventions and UI invented; bd has no
 * concept of them, which is the whole problem. Anything in this set is
 * equivalent to unassigned and is collapsed to `""` before it reaches bd.
 */
export const SHARED_ASSIGNEE_SENTINELS: readonly string[] = [
  "any",
  "anyone",
  "unassigned",
  "none",
  "nobody",
];

const SENTINEL_SET = new Set(SHARED_ASSIGNEE_SENTINELS);

/** True when `raw` is one of the pseudo-owner sentinels (case/space tolerant). */
export function isSharedAssigneeSentinel(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  return SENTINEL_SET.has(raw.trim().toLowerCase());
}

/**
 * Canonical assignee for a write: a real owner id, or `""` for unassigned.
 *
 * Every sentinel collapses to `""`. This is what keeps `bd update --claim`
 * usable: bd's claim predicate admits `assignee = '' OR assignee IS NULL OR
 * assignee = <actor>`, and nothing else.
 */
export function normalizeAssignee(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return isSharedAssigneeSentinel(trimmed) ? "" : trimmed;
}

/**
 * True when nobody has taken ownership yet — unassigned, or still carrying a
 * legacy sentinel. These are the issues broadcast to every agent, so they are
 * the ones that must go through a claim before any work starts.
 */
export function isSharedAssignee(raw: unknown): boolean {
  return normalizeAssignee(raw) === "";
}

/** Outcome of one compare-and-set claim attempt. */
export type ClaimOutcome =
  | {
      ok: true;
      id: string;
      actor: string;
      /** True when the actor already held the issue and the claim was a no-op. */
      idempotent: boolean;
      /**
       * Set when the claim landed in the DB but the `.beads/issues.jsonl`
       * re-export failed. The claim IS valid; the readiness fast path may keep
       * showing the issue as unassigned until the next successful export, so
       * this must be reported rather than swallowed (openclaw-beads-7sz).
       */
      exportWarning?: string;
    }
  | {
      ok: false;
      id: string;
      actor: string;
      /**
       * - `already-claimed`  another agent owns it. Stand down. Expected, not an error.
       * - `sentinel-blocked` the row still carries a pseudo-owner, so bd refuses
       *                      everyone. Nobody may proceed; needs normalization.
       * - `not-claimable`    wrong status (closed, deferred, …).
       * - `not-found`        no such issue in this repo.
       * - `error`            bd itself failed; ownership is UNKNOWN.
       */
      reason: "already-claimed" | "sentinel-blocked" | "not-claimable" | "not-found" | "error";
      /** Winning claimant when known (`already-claimed`), or the sentinel string. */
      heldBy?: string;
      /** Human-readable, already includes bd's stderr where there was any. */
      detail: string;
    };

const ALREADY_CLAIMED_RE = /already claimed by\s+(.+?)\s*$/im;
const NOT_CLAIMABLE_RE = /not claimable(?::\s*status\s+(\S+))?/i;
const NOT_FOUND_RE = /not found/i;

/**
 * Classify a failed claim from bd's stderr.
 *
 * Split out from the shell-out so the mapping is unit-testable without a bd
 * binary or a Dolt database. The distinction that matters most:
 * `already-claimed` is a NORMAL outcome that means "stand down quietly and
 * say so", whereas `error` means ownership is unknown and nobody should
 * assume they may proceed.
 */
export function classifyClaimFailure(params: {
  id: string;
  actor: string;
  stderr: string;
  /** Fallback description when stderr is empty (SIGTERM'd child, spawn failure). */
  fallbackDetail?: string;
}): Extract<ClaimOutcome, { ok: false }> {
  const { id, actor } = params;
  const stderr = (params.stderr ?? "").trim();
  const detail = stderr || (params.fallbackDetail ?? "").trim() || "bd claim failed with no stderr";

  const claimed = ALREADY_CLAIMED_RE.exec(stderr);
  if (claimed) {
    const heldBy = claimed[1].trim();
    if (isSharedAssigneeSentinel(heldBy)) {
      return {
        ok: false,
        id,
        actor,
        reason: "sentinel-blocked",
        heldBy,
        detail:
          `${id} still carries the pseudo-owner "${heldBy}", which bd reads as a real claimant, so ` +
          `it refuses every actor including ${actor}. NOBODY owns this issue and nobody may start ` +
          `work on it. Retire the sentinel (set the assignee empty) and claim again — never take it ` +
          `with --assignee/--status, which is last-write-wins (openclaw-1lw7). bd said: ${detail}`,
      };
    }
    return {
      ok: false,
      id,
      actor,
      reason: "already-claimed",
      heldBy,
      detail: `${id} is already claimed by ${heldBy}; ${actor} must stand down. bd said: ${detail}`,
    };
  }

  if (NOT_CLAIMABLE_RE.test(stderr)) {
    return {
      ok: false,
      id,
      actor,
      reason: "not-claimable",
      detail: `${id} is not in a claimable state. bd said: ${detail}`,
    };
  }

  if (NOT_FOUND_RE.test(stderr)) {
    return { ok: false, id, actor, reason: "not-found", detail: `${id} not found. bd said: ${detail}` };
  }

  return {
    ok: false,
    id,
    actor,
    reason: "error",
    detail:
      `claim of ${id} by ${actor} failed and the reason is NOT a lost race — ownership is UNKNOWN, ` +
      `so do not proceed as though you won. bd said: ${detail}`,
  };
}

/**
 * One-line, log-safe rendering of an outcome. Used for the accounting line so
 * a stand-down leaves a forensic trace in the gateway journal rather than
 * living only in whatever the model chose to say.
 */
export function formatClaimOutcome(outcome: ClaimOutcome): string {
  if (outcome.ok) {
    return `claim WON id=${outcome.id} actor=${outcome.actor}${outcome.idempotent ? " (idempotent re-claim)" : ""}`;
  }
  return `claim LOST id=${outcome.id} actor=${outcome.actor} reason=${outcome.reason}${
    outcome.heldBy ? ` heldBy=${outcome.heldBy}` : ""
  }`;
}
