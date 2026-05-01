import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldIncludeReadyIssue, formatPlansAndTasksBlock } from '../dist/index.js';

describe('run loop prompt helpers', () => {
  it('includes issues assigned to the current agent or any only', () => {
    assert.equal(shouldIncludeReadyIssue({ id: 'a', title: 'A', assignee: 'tank' }, 'tank', false), true);
    assert.equal(shouldIncludeReadyIssue({ id: 'b', title: 'B', assignee: 'any' }, 'tank', false), true);
    assert.equal(shouldIncludeReadyIssue({ id: 'c', title: 'C', assignee: 'eddie' }, 'tank', false), false);
    assert.equal(shouldIncludeReadyIssue({ id: 'd', title: 'D' }, 'tank', false), false);
    assert.equal(shouldIncludeReadyIssue({ id: 'e', title: 'E' }, 'tank', true), true);
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
