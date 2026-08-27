/**
 * Regression tests for openclaw-1lw7 — the 3-agent claim collision.
 *
 * The incident: three agents claimed the same `assignee: any` issue off three
 * parallel heartbeat wakes, and two spawned implementation subagents four
 * seconds apart onto worktrees cut from the same base SHA. One run deleted the
 * other's worktree and branch mid-flight.
 *
 * What must stay true, in order of how load-bearing it is:
 *
 *   1. `bd update <id> --claim` arbitrates: concurrent racers on one issue
 *      produce exactly ONE winner and N-1 losers who are TOLD they lost.
 *      Covered against a real bd/Dolt database, not a mock, because the whole
 *      guarantee is a conditional UPDATE inside a transaction — a mock would
 *      only test our belief about it.
 *   2. `assignee: any` specifically. bd reads the literal string as a real
 *      claimant and refuses EVERYONE, which is why the fleet fell back to
 *      last-write-wins. This is the case the incident was made of.
 *   3. The block never hands one shared issue id to two agents at once, so a
 *      collision cannot happen even if an agent ignores the claim instruction.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';

import {
  SHARED_ASSIGNEE_SENTINELS,
  SharedOfferRegistry,
  admitSharedIssue,
  classifyClaimFailure,
  formatClaimOutcome,
  formatPlansAndTasksBlock,
  isSharedAssignee,
  normalizeAssignee,
  shouldIncludeReadyIssue,
} from '../dist/index.js';
import { claimIssue, normalizeSentinelAssignees, showIssue } from '../dist/beads-cli.js';

const execFileAsync = promisify(execFile);

describe('assignee sentinels', () => {
  it('collapses every pseudo-owner to unassigned', () => {
    for (const sentinel of SHARED_ASSIGNEE_SENTINELS) {
      assert.equal(normalizeAssignee(sentinel), '', `${sentinel} must normalize to unassigned`);
      assert.equal(isSharedAssignee(sentinel), true);
    }
    // Case and whitespace tolerant: bd stores whatever was typed.
    assert.equal(normalizeAssignee('  ANY '), '');
    assert.equal(normalizeAssignee('Unassigned'), '');
  });

  it('leaves real owners alone', () => {
    assert.equal(normalizeAssignee('shiva'), 'shiva');
    assert.equal(normalizeAssignee(' tank '), 'tank');
    assert.equal(isSharedAssignee('shiva'), false);
    // "anybody" is not in the sentinel set; only exact matches collapse, so a
    // real handle that merely starts with "any" is never silently unassigned.
    assert.equal(normalizeAssignee('anybody'), 'anybody');
    assert.equal(isSharedAssignee('anybody'), false);
  });

  it('keeps legacy `any` rows visible while they await normalization', () => {
    // A visibility regression here would be worse than the race: agents would
    // idle while shared work sat in the queue unseen.
    assert.equal(shouldIncludeReadyIssue({ id: 'a', title: 'A', assignee: 'any' }, 'shiva', false), true);
    assert.equal(shouldIncludeReadyIssue({ id: 'b', title: 'B', assignee: 'shiva' }, 'shiva', false), true);
    assert.equal(shouldIncludeReadyIssue({ id: 'c', title: 'C', assignee: 'tank' }, 'shiva', false), false);
    // Properly unassigned shared work is governed by includeUnassigned, which
    // now defaults to true precisely because it is the shared bucket.
    assert.equal(shouldIncludeReadyIssue({ id: 'd', title: 'D' }, 'shiva', true), true);
    assert.equal(shouldIncludeReadyIssue({ id: 'e', title: 'E' }, 'shiva', false), false);
  });
});

describe('claim failure classification', () => {
  // These stderr strings are verbatim from bd 1.0.3, captured during triage.
  it('names the winner on a lost race and calls it a lost race', () => {
    const outcome = classifyClaimFailure({
      id: 'probe-s7g',
      actor: 'bob',
      stderr: 'Error claiming probe-s7g: issue already claimed by alice',
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'already-claimed');
    assert.equal(outcome.heldBy, 'alice');
    assert.match(outcome.detail, /already claimed by alice/);
    assert.match(formatClaimOutcome(outcome), /claim LOST .*reason=already-claimed heldBy=alice/);
  });

  it('distinguishes the `any` sentinel from a real claimant', () => {
    // The heart of openclaw-1lw7: bd says "already claimed by any", which LOOKS
    // like a lost race but means nobody owns it and nobody CAN. Misreading this
    // as a lost race would make every agent stand down from shared work
    // forever; misreading it as a win would put two agents on one issue.
    const outcome = classifyClaimFailure({
      id: 'probe-rag',
      actor: 'alice',
      stderr: 'Error claiming probe-rag: issue already claimed by any',
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'sentinel-blocked');
    assert.equal(outcome.heldBy, 'any');
    assert.match(outcome.detail, /NOBODY owns this issue/);
    assert.match(outcome.detail, /never take it with --assignee\/--status/i);
  });

  it('treats an unexplained failure as UNKNOWN ownership, not a win', () => {
    const outcome = classifyClaimFailure({
      id: 'x-1',
      actor: 'shiva',
      stderr: '',
      fallbackDetail: 'bd update x-1 --claim failed: killed with SIGTERM',
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'error');
    assert.match(outcome.detail, /ownership is UNKNOWN/);
    assert.match(outcome.detail, /SIGTERM/);
  });
});

describe('shared-offer admission gate', () => {
  const issue = (assignee) => ({ id: 'openclaw-vaon', title: 'shared work', assignee });

  it('hands one shared issue to exactly one of two racing agents', () => {
    // This is the openclaw-vaon scenario with the model taken out of the loop:
    // two heartbeat wakes build blocks in the same gateway process, and only
    // one of them may even SEE the id.
    const registry = new SharedOfferRegistry();
    const admit = (agentId) =>
      admitSharedIssue({ issue: issue('any'), agentId, repoName: 'openclaw', offerTtlMs: 300_000, registry });

    const results = ['main', 'narcissus', 'shiva'].map(admit);
    assert.deepEqual(results, [true, false, false]);
    assert.equal(results.filter(Boolean).length, 1, 'exactly one agent may receive the id');
  });

  it('is idempotent for the holder across repeated prompt builds', () => {
    const registry = new SharedOfferRegistry();
    const admit = (agentId) =>
      admitSharedIssue({ issue: issue(''), agentId, repoName: 'openclaw', offerTtlMs: 300_000, registry });
    assert.equal(admit('shiva'), true);
    assert.equal(admit('shiva'), true, 'the holder keeps its own offer');
    assert.equal(admit('tank'), false);
  });

  it('releases the offer once a claim has landed, and never gates owned work', () => {
    const registry = new SharedOfferRegistry();
    const key = 'openclaw:openclaw-vaon';
    assert.equal(
      admitSharedIssue({ issue: issue('any'), agentId: 'shiva', repoName: 'openclaw', offerTtlMs: 300_000, registry }),
      true,
    );
    assert.equal(registry.holder(key), 'shiva');
    // shiva's claim lands: the issue is no longer shared. tank must still be
    // able to see its own directly-assigned work, and the key is dropped.
    assert.equal(
      admitSharedIssue({ issue: issue('shiva'), agentId: 'tank', repoName: 'openclaw', offerTtlMs: 300_000, registry }),
      true,
      'a directly-assigned issue is never withheld (owner filtering handles it)',
    );
    assert.equal(registry.holder(key), undefined, 'offer released once ownership is real');
  });

  it('expires an unused offer so a parked issue is not starved forever', () => {
    let now = 1_000_000;
    const registry = new SharedOfferRegistry(() => now);
    const admit = (agentId) =>
      admitSharedIssue({ issue: issue('any'), agentId, repoName: 'openclaw', offerTtlMs: 60_000, registry });
    assert.equal(admit('main'), true);
    assert.equal(admit('shiva'), false);
    now += 60_001;
    assert.equal(admit('shiva'), true, 'a lapsed offer returns to the shared pool');
    assert.equal(admit('main'), false, 'and the new holder now excludes the old one');
  });

  it('can be disabled, leaving the compare-and-set as the only arbiter', () => {
    const registry = new SharedOfferRegistry();
    const admit = (agentId) =>
      admitSharedIssue({ issue: issue('any'), agentId, repoName: 'openclaw', offerTtlMs: 0, registry });
    assert.equal(admit('main'), true);
    assert.equal(admit('shiva'), true);
    assert.equal(registry.size(), 0, 'a disabled gate takes no offers at all');
  });
});

describe('run-loop preamble states the claim protocol', () => {
  const block = formatPlansAndTasksBlock({
    agentId: 'shiva',
    repos: [
      {
        repo: { name: 'openclaw', path: '/tmp/openclaw' },
        issues: [{ id: 'openclaw-vaon', title: 'shared', status: 'open', priority: 2, assignee: '' }],
        counts: {
          readyTotal: 3,
          shown: 1,
          filteredUnassigned: 0,
          filteredOtherOwner: 0,
          offeredElsewhere: 2,
          truncated: 0,
        },
      },
    ],
  });

  it('prescribes --claim with the agent id and an abort on nonzero exit', () => {
    assert.match(block, /CLAIM ATOMICALLY BEFORE YOU START/);
    assert.match(block, /bd update <id> --claim --actor shiva/);
    assert.match(block, /CHECK THE EXIT CODE/);
    assert.match(block, /NONZERO means another agent won the race/);
    assert.match(block, /create NOTHING, spawn NOTHING and cut NO worktree/);
  });

  it('forbids the last-write-wins path that caused the incident', () => {
    assert.match(block, /Do NOT substitute `--assignee <you> --status in_progress`/);
    assert.match(block, /every racing agent believes it won/);
  });

  it('routes a sentinel-blocked claim to a stand-down, not a hand-normalization', () => {
    // The clear-then-claim the task brief warned about: two writes, and the
    // second clear wipes the first agent's claim.
    assert.match(block, /NOT a lost race/);
    assert.match(block, /clearing and claiming are two writes/);
    assert.doesNotMatch(block, /Normalize first with/);
  });

  it('accounts for withheld shared issues instead of shortening the queue silently', () => {
    // openclaw-beads-7sz: a short queue must always be explainable.
    assert.match(block, /hidden_offered_elsewhere="2"/);
    assert.match(block, /withheld from you on purpose/);
  });
});

// ---------------------------------------------------------------------------
// Integration: the real compare-and-set, against a real bd/Dolt database.
// ---------------------------------------------------------------------------

const bdAvailable = await execFileAsync('bd', ['version'])
  .then(() => true)
  .catch(() => false);

describe('claim compare-and-set (integration, real bd)', { skip: bdAvailable ? false : 'bd binary not on PATH' }, () => {
  let dir;
  const opts = () => ({ cwd: dir, timeoutMs: 30_000 });

  const create = async (title) => {
    const { stdout } = await execFileAsync('bd', ['create', title, '-p', '1', '--json'], { cwd: dir });
    // bd prefixes JSON with human-readable warnings on some invocations; start
    // at the first structural character rather than trusting the whole stream.
    const start = stdout.search(/[[{]/);
    assert.ok(start >= 0, `bd create returned no JSON: ${stdout.slice(0, 200)}`);
    const parsed = JSON.parse(stdout.slice(start));
    return (Array.isArray(parsed) ? parsed[0] : parsed).id;
  };
  const assigneeOf = async (id) => {
    // `bd show --json` answers with an array; the JSONL fast path answers with
    // a bare record. Unwrap both, and read from bd directly (forceFresh) so an
    // unrefreshed export can never make a wiped assignee look intact.
    const detail = await showIssue(id, opts(), { forceFresh: true });
    const issue = Array.isArray(detail) ? detail[0] : detail;
    return String(issue?.assignee ?? '');
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'beads-claim-cas-'));
    await execFileAsync('bd', ['init', '--prefix', 'cas'], { cwd: dir });
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('yields exactly one winner and loud losers when three agents race', async () => {
    const id = await create('three-way race');
    const outcomes = await Promise.all(
      ['main', 'narcissus', 'shiva'].map((actor) => claimIssue(id, actor, opts())),
    );

    const winners = outcomes.filter((o) => o.ok);
    const losers = outcomes.filter((o) => !o.ok);
    assert.equal(winners.length, 1, `exactly one winner, got ${JSON.stringify(outcomes)}`);
    assert.equal(losers.length, 2);

    // The loser must LEARN it lost — a swallowed failure is the whole bug.
    for (const loser of losers) {
      assert.equal(loser.reason, 'already-claimed', `loser must know it lost: ${loser.detail}`);
      assert.equal(loser.heldBy, winners[0].actor, 'loser must be told who won');
      assert.match(loser.detail, /must stand down/);
    }
    // And the database agrees with the winner.
    assert.equal(await assigneeOf(id), winners[0].actor);
  });

  it('is idempotent for the winner and still refuses everyone else', async () => {
    const id = await create('idempotent re-claim');
    assert.equal((await claimIssue(id, 'shiva', opts())).ok, true);
    assert.equal((await claimIssue(id, 'shiva', opts())).ok, true, 're-claim by the owner is a no-op success');
    const loser = await claimIssue(id, 'tank', opts());
    assert.equal(loser.ok, false);
    assert.equal(loser.heldBy, 'shiva');
  });

  it('reports `assignee: any` as sentinel-blocked rather than a lost race', async () => {
    // THE regression. Before the fix this returned exit 1 to every agent, was
    // read as an opaque failure, and drove the fleet to the last-write-wins
    // fallback that let three agents "win" at once.
    const id = await create('legacy any sentinel');
    await execFileAsync('bd', ['update', id, '--assignee', 'any'], { cwd: dir });
    assert.equal(await assigneeOf(id), 'any', 'precondition: the row carries the sentinel');

    for (const actor of ['main', 'shiva']) {
      const outcome = await claimIssue(id, actor, opts());
      assert.equal(outcome.ok, false, 'a sentinel row is claimable by nobody');
      assert.equal(outcome.reason, 'sentinel-blocked');
      assert.equal(outcome.heldBy, 'any');
    }
    // Crucially: nobody won, so nothing was silently taken.
    assert.equal(await assigneeOf(id), 'any');
  });

  it('retires the sentinel, after which the race has exactly one winner', async () => {
    const id = await create('any then normalized then raced');
    await execFileAsync('bd', ['update', id, '--assignee', 'any'], { cwd: dir });

    const result = await normalizeSentinelAssignees(opts());
    assert.equal(result.error, undefined, `normalization must not fail: ${result.error}`);
    assert.ok(
      result.normalized.some((n) => n.id === id && n.was === 'any'),
      `expected ${id} to be normalized, got ${JSON.stringify(result.normalized)}`,
    );
    assert.equal(await assigneeOf(id), '', 'sentinel retired to unassigned');

    const outcomes = await Promise.all(
      ['main', 'narcissus', 'shiva'].map((actor) => claimIssue(id, actor, opts())),
    );
    assert.equal(outcomes.filter((o) => o.ok).length, 1, 'exactly one winner after normalization');
    const winner = outcomes.find((o) => o.ok);
    assert.equal(await assigneeOf(id), winner.actor);
  });

  it('never wipes a live claim while retiring sentinels', async () => {
    // The safety invariant that lets normalization run beside live agents:
    // it only touches rows whose assignee is EXACTLY a sentinel, and a real
    // claim's assignee is an agent id. If this ever regresses, normalization
    // becomes the "clear then claim" race it exists to avoid.
    const claimed = await create('already owned');
    assert.equal((await claimIssue(claimed, 'shiva', opts())).ok, true);
    const sentinel = await create('still shared');
    await execFileAsync('bd', ['update', sentinel, '--assignee', 'any'], { cwd: dir });

    const result = await normalizeSentinelAssignees(opts());
    assert.equal(
      result.normalized.some((n) => n.id === claimed),
      false,
      'a claimed issue must never be normalized',
    );
    assert.equal(await assigneeOf(claimed), 'shiva', "shiva's claim survives normalization");
    assert.equal(await assigneeOf(sentinel), '');
  });

  it('refuses to claim as a sentinel, so nobody can make an issue unclaimable', async () => {
    const id = await create('claiming as a pseudo-owner');
    const outcome = await claimIssue(id, 'any', opts());
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'error');
    assert.match(outcome.detail, /shared-work pseudo-owner, not an agent/);
    assert.equal(await assigneeOf(id), '', 'and the row is untouched');
  });
});
