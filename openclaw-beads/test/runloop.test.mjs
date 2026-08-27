import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  shouldIncludeReadyIssue,
  formatPlansAndTasksBlock,
  compareReadyIssuesForAgent,
  isBroadcastAssignee,
} from '../dist/index.js';

describe('run loop prompt helpers', () => {
  it('includes issues assigned to the current agent or any only', () => {
    assert.equal(shouldIncludeReadyIssue({ id: 'a', title: 'A', assignee: 'tank' }, 'tank', false), true);
    assert.equal(shouldIncludeReadyIssue({ id: 'b', title: 'B', assignee: 'any' }, 'tank', false), true);
    assert.equal(shouldIncludeReadyIssue({ id: 'c', title: 'C', assignee: 'eddie' }, 'tank', false), false);
    assert.equal(shouldIncludeReadyIssue({ id: 'd', title: 'D' }, 'tank', false), false);
    assert.equal(shouldIncludeReadyIssue({ id: 'e', title: 'E' }, 'tank', true), true);
  });

  // openclaw-1lw7: the `any` sentinel is retired. "Anyone may claim this" is
  // now an unassigned issue, because `bd` reads the literal string "any" as a
  // real claimant and refuses `--claim` from everyone.
  it('treats unassigned and the legacy any sentinel as the same broadcast tier', () => {
    assert.equal(isBroadcastAssignee(''), true, 'unassigned is broadcast backlog');
    assert.equal(isBroadcastAssignee('any'), true, 'legacy any is still read as broadcast');
    assert.equal(isBroadcastAssignee('tank'), false);
    assert.equal(isBroadcastAssignee('narcissus'), false);
  });

  it('keeps legacy any-assigned issues visible regardless of includeUnassigned', () => {
    // `any` predates the fix and cannot be claimed until normalized, so it must
    // never be silently filtered out — an invisible un-claimable issue is worse
    // than a visible one.
    assert.equal(shouldIncludeReadyIssue({ id: 'l', title: 'L', assignee: 'any' }, 'tank', false), true);
    assert.equal(shouldIncludeReadyIssue({ id: 'l', title: 'L', assignee: 'any' }, 'tank', true), true);
  });

  it('orders direct-assignee issues ahead of any-assigned ones, then by priority (Shiva starvation regression)', () => {
    const anyHigherPriority = { id: 'openclaw-vestige-7j3', title: 'A', assignee: 'any', priority: 2 };
    const directLowerPriority = { id: 'openclaw-vestige-odd', title: 'B', assignee: 'shiva', priority: 3 };
    const sorted = [anyHigherPriority, directLowerPriority].sort((a, b) =>
      compareReadyIssuesForAgent(a, b, 'shiva'),
    );
    assert.equal(sorted[0].id, 'openclaw-vestige-odd', 'direct-assignee must come first even at lower priority');
    assert.equal(sorted[1].id, 'openclaw-vestige-7j3');
    // With readyLimitPerRepo=1 the direct issue would have been starved before the fix.
    const limited = sorted.slice(0, 1);
    assert.equal(limited[0].id, 'openclaw-vestige-odd');
  });

  it('breaks priority ties by id within the same assignee tier', () => {
    const a = { id: 'b-2', title: 'b', assignee: 'tank', priority: 2 };
    const b = { id: 'a-1', title: 'a', assignee: 'tank', priority: 2 };
    const sorted = [a, b].sort((x, y) => compareReadyIssuesForAgent(x, y, 'tank'));
    assert.equal(sorted[0].id, 'a-1');
    assert.equal(sorted[1].id, 'b-2');
  });

  it('renders core run-loop discipline and ready issues', () => {
    const block = formatPlansAndTasksBlock({
      agentId: 'tank',
      repos: [
        {
          repo: { name: 'openclaw-beads', path: '/tmp/openclaw-beads' },
          issues: [
            {
              id: 'openclaw-beads-123',
              title: 'Implement thing <safely>',
              status: 'open',
              priority: 1,
              issue_type: 'task',
              assignee: 'tank',
              labels: ['ref:src/index.ts'],
              target_datetime: '2026-05-02T09:00:00-07:00',
            },
          ],
        },
      ],
    });
    assert.match(block, /<plans_and_tasks>/);
    assert.match(block, /assign it to your own agent id \(tank\)/);
    assert.match(block, /Never treat issues from repos whose configured repo name matches \/test\/i/);
    assert.match(block, /not triggered by direct user input/);
    assert.match(block, /heartbeat, gateway startup\/resume, cron wake/);
    assert.match(block, /explicitly reply with a concise summary/);
    assert.match(block, /id="openclaw-beads-123"/);
    assert.match(block, /Implement thing &lt;safely&gt;/);
    assert.match(block, /<ref>src\/index\.ts<\/ref>/);
    assert.match(block, /<target_datetime>2026-05-02T09:00:00-07:00<\/target_datetime>/);
  });

  // openclaw-1lw7. Three agents claimed openclaw-vaon within four seconds
  // because the prose said "mark the issue in_progress" — a read-then-write
  // that every racer wins. The block is the only instruction an agent gets on
  // a heartbeat wake, so the atomic verb, the exit-code check, and the abort
  // are a contract, not stylistic prose.
  it('prescribes the atomic claim, the exit-code check, and the abort-on-loss', () => {
    const block = formatPlansAndTasksBlock({ agentId: 'narcissus', repos: [] });
    assert.match(block, /bd update <id> --claim --actor narcissus/, 'must name the atomic claim verb');
    assert.match(block, /CHECK THE EXIT CODE/, 'a claim whose exit code is ignored is not a claim');
    assert.match(block, /NONZERO means another agent won the race/);
    assert.match(block, /MUST create NOTHING, spawn NOTHING and cut NO worktree/, 'the loser must abort');
    assert.match(
      block,
      /Do NOT substitute `--assignee <you> --status in_progress`/,
      'the losing read-then-write must be named and forbidden',
    );
  });

  it('no longer tells agents to file shared backlog as owner "any"', () => {
    // The old prose said backlog "belongs in general backlog (owner any)",
    // which manufactured exactly the un-claimable population that races.
    const block = formatPlansAndTasksBlock({ agentId: 'tank', repos: [] });
    assert.doesNotMatch(block, /general backlog \(owner any\)/);
    assert.match(block, /leave it UNASSIGNED/);
  });

  it('tells the agent to STAND DOWN on a sentinel row, not to hand-normalize it', () => {
    // Deliberately inverted from an earlier revision of this test, which
    // required the block to say `Normalize first with bd update <id>
    // --assignee ""` and then claim. That is two writes and it reopens the
    // race it looks like it closes: A clears the sentinel, A claims, then B —
    // which read the sentinel before A moved — clears the field again, wiping
    // A's claim, and claims too. Two winners, which is the openclaw-1lw7
    // incident with extra steps. Retiring a sentinel is a startup migration
    // (normalizeSentinelAssignees), never part of claiming.
    const block = formatPlansAndTasksBlock({ agentId: 'tank', repos: [] });
    assert.doesNotMatch(
      block,
      /Normalize first with `bd update <id> --assignee ""`/,
      'the block must not prescribe a clear-then-claim, which is a lost-update race',
    );
    assert.match(block, /NOT a lost race/, 'sentinel-blocked is distinct from losing a race');
    assert.match(block, /Stand down and report it/);
    assert.match(block, /clearing and claiming are two writes/, 'and it must say WHY not to do it by hand');
  });

  it('renders an empty ready marker when nothing is available', () => {
    const block = formatPlansAndTasksBlock({ agentId: 'tank', repos: [] });
    assert.match(block, /<ready_issues none="true" \/>/);
  });
});
