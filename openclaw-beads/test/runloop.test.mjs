import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldIncludeReadyIssue, formatPlansAndTasksBlock, compareReadyIssuesForAgent } from '../dist/index.js';

describe('run loop prompt helpers', () => {
  it('includes issues assigned to the current agent or any only', () => {
    assert.equal(shouldIncludeReadyIssue({ id: 'a', title: 'A', assignee: 'tank' }, 'tank', false), true);
    assert.equal(shouldIncludeReadyIssue({ id: 'b', title: 'B', assignee: 'any' }, 'tank', false), true);
    assert.equal(shouldIncludeReadyIssue({ id: 'c', title: 'C', assignee: 'eddie' }, 'tank', false), false);
    assert.equal(shouldIncludeReadyIssue({ id: 'd', title: 'D' }, 'tank', false), false);
    assert.equal(shouldIncludeReadyIssue({ id: 'e', title: 'E' }, 'tank', true), true);
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

  it('renders an empty ready marker when nothing is available', () => {
    const block = formatPlansAndTasksBlock({ agentId: 'tank', repos: [] });
    assert.match(block, /<ready_issues none="true" \/>/);
  });
});
