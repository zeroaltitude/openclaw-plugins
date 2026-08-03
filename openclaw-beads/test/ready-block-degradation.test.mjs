// Regression tests for openclaw-beads-7sz: the heartbeat ready_issues block
// used to fail silently — bare "Command failed" with no stderr, or no block at
// all. Every case below asserts that a failure is VISIBLE in the emitted block.
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatPlansAndTasksBlock,
  formatDegradedPlansAndTasksBlock,
  TtlCache,
} from '../dist/index.js';
import {
  BdCommandError,
  listIssues,
  refreshExport,
  readyIssuesFromExport,
} from '../dist/beads-cli.js';

let dir;

/** Write an executable stub that stands in for the `bd` binary. */
async function writeFakeBd(name, body) {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8');
  await chmod(path, 0o755);
  return path;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'beads-degraded-'));
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('bd shell-out diagnostics (openclaw-beads-7sz mode 1)', () => {
  it('surfaces stderr, exit code and cwd instead of a bare "Command failed"', async () => {
    const bd = await writeFakeBd('bd-stderr', 'echo "dolt: exhausted retries" >&2; exit 3');
    const cwd = join(dir, 'repo-stderr');
    await mkdir(cwd, { recursive: true });
    const err = await listIssues({ cwd, bdBinary: bd, retries: 0 }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof BdCommandError, 'expected a BdCommandError');
    assert.equal(err.exitCode, 3);
    assert.equal(err.timedOut, false);
    assert.match(err.message, /dolt: exhausted retries/);
    assert.match(err.message, /exit code 3/);
    assert.match(err.message, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('labels a timeout kill as a timeout rather than an opaque failure', async () => {
    // The 2026-07-27 report: a SIGTERM'd child exits with EMPTY stderr, so the
    // old wrapper rendered "Command failed" with nothing to diagnose.
    const bd = await writeFakeBd('bd-hang', 'sleep 5');
    const cwd = join(dir, 'repo-hang');
    await mkdir(cwd, { recursive: true });
    const err = await listIssues({ cwd, bdBinary: bd, timeoutMs: 250, retries: 0 }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof BdCommandError);
    assert.equal(err.timedOut, true);
    assert.equal(err.transient, true, 'a timeout kill must be retryable');
    assert.match(err.message, /timed out after 250ms/);
    assert.match(err.message, /SIGTERM/);
  });

  it('retries transient lock contention and succeeds', async () => {
    const counter = join(dir, 'lock-counter');
    const bd = await writeFakeBd(
      'bd-lock',
      [
        `n=$(cat ${counter} 2>/dev/null || echo 0)`,
        'n=$((n+1))',
        `echo $n > ${counter}`,
        'if [ "$n" -lt 3 ]; then echo "error: database is locked" >&2; exit 1; fi',
        "echo '[]'",
      ].join('\n'),
    );
    const cwd = join(dir, 'repo-lock');
    await mkdir(cwd, { recursive: true });
    const issues = await listIssues({ cwd, bdBinary: bd, retryBackoffMs: 1 });
    assert.deepEqual(issues, [], 'third attempt should succeed');
  });

  it('does not retry a permanent failure', async () => {
    const counter = join(dir, 'perm-counter');
    const bd = await writeFakeBd(
      'bd-perm',
      [
        `n=$(cat ${counter} 2>/dev/null || echo 0)`,
        'n=$((n+1))',
        `echo $n > ${counter}`,
        'echo "unknown command" >&2',
        'exit 2',
      ].join('\n'),
    );
    const cwd = join(dir, 'repo-perm');
    await mkdir(cwd, { recursive: true });
    const err = await listIssues({ cwd, bdBinary: bd, retryBackoffMs: 1 }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof BdCommandError);
    assert.equal(err.attempts, 1, 'a non-transient failure must not be retried');
  });

  it('reports export failure instead of swallowing it', async () => {
    const bd = await writeFakeBd('bd-noexport', 'echo "export failed" >&2; exit 1');
    const cwd = join(dir, 'repo-export');
    await mkdir(cwd, { recursive: true });
    const result = await refreshExport({ cwd, bdBinary: bd, retries: 0 });
    assert.equal(result.ok, false);
    assert.match(result.error, /export failed/);
  });
});

describe('lenient JSONL fallback', () => {
  it('answers from the export when strict mode would bail on an unknown blocker', async () => {
    const cwd = join(dir, 'repo-lenient');
    await mkdir(join(cwd, '.beads'), { recursive: true });
    await writeFile(
      join(cwd, '.beads', 'issues.jsonl'),
      [
        JSON.stringify({
          _type: 'issue',
          id: 'l-1',
          title: 'blocked by an issue that is not in this export',
          status: 'open',
          priority: 1,
          dependency_count: 1,
          dependencies: [{ issue_id: 'l-1', depends_on_id: 'other-repo-9', type: 'blocks' }],
        }),
      ].join('\n'),
      'utf8',
    );
    assert.equal(await readyIssuesFromExport(cwd, 10), null, 'strict mode defers to bd');
    const lenient = await readyIssuesFromExport(cwd, 10, { lenient: true });
    assert.equal(lenient.length, 1);
    assert.equal(lenient[0].id, 'l-1');
  });
});

describe('block rendering never hides a failure (openclaw-beads-7sz mode 2)', () => {
  it('emits a loud degraded block when the queue cannot be built at all', () => {
    const block = formatDegradedPlansAndTasksBlock({
      agentId: 'tank',
      reason: 'bd ready failed in /repo <everywhere>',
    });
    assert.match(block, /<plans_and_tasks degraded="true">/);
    assert.match(block, /<ready_issues unavailable="true">/);
    assert.match(block, /Do NOT conclude that there is no ready work/);
    assert.match(block, /bd ready failed in \/repo &lt;everywhere&gt;/, 'reason must be escaped');
  });

  it('keeps the block (and the healthy repos) when one repo fails', () => {
    const block = formatPlansAndTasksBlock({
      agentId: 'tank',
      repos: [
        {
          repo: { name: 'openclaw', path: '/repo/openclaw' },
          issues: [],
          error: 'bd ready --json failed in /repo/openclaw after 4002ms [attempt 3] (timed out after 4000ms, killed with SIGTERM): (no stderr)',
        },
        {
          repo: { name: 'openclaw-beads', path: '/repo/beads' },
          issues: [{ id: 'openclaw-beads-7sz', title: 'fix it', status: 'in_progress', assignee: 'tank', priority: 2 }],
          counts: { readyTotal: 1, shown: 1, filteredUnassigned: 0, filteredOtherOwner: 0, truncated: 0 },
        },
      ],
    });
    assert.match(block, /<plans_and_tasks degraded="true">/);
    assert.match(block, /QUEUE HEALTH: DEGRADED/);
    assert.match(block, /timed out after 4000ms/);
    assert.match(block, /id="openclaw-beads-7sz"/, 'healthy repo must still render');
  });

  it('explains an empty queue caused by the owner filter', () => {
    // The 2026-08-03 symptom: `bd ready` lists ~20 issues, the block shows
    // nothing, and the agent concludes there is no work.
    const block = formatPlansAndTasksBlock({
      agentId: 'tank',
      repos: [
        {
          repo: { name: 'bighat-general', path: '/repo/bighat-general' },
          issues: [],
          counts: { readyTotal: 20, shown: 0, filteredUnassigned: 20, filteredOtherOwner: 0, truncated: 0 },
        },
      ],
    });
    assert.doesNotMatch(block, /<ready_issues none="true" \/>/);
    assert.match(block, /ready_total="20"/);
    assert.match(block, /hidden_unassigned="20"/);
    assert.match(block, /hidden by the owner filter/);
  });

  it('still emits the plain empty marker when the queue is genuinely empty', () => {
    const block = formatPlansAndTasksBlock({
      agentId: 'tank',
      repos: [
        {
          repo: { name: 'bh-ai', path: '/repo/bh-ai' },
          issues: [],
          counts: { readyTotal: 0, shown: 0, filteredUnassigned: 0, filteredOtherOwner: 0, truncated: 0 },
        },
      ],
    });
    assert.match(block, /<ready_issues none="true" \/>/);
    assert.doesNotMatch(block, /degraded="true"/);
  });
});

describe('TtlCache.resolveTtlMs', () => {
  it('lets a caller shorten caching for a degraded value', async () => {
    const cache = new TtlCache();
    let n = 0;
    const load = () => cache.getOrLoad('k', 60_000, async () => `v${++n}`, {
      resolveTtlMs: (value) => (value === 'v1' ? 0 : 60_000),
    });
    assert.equal(await load(), 'v1');
    assert.equal(await load(), 'v2', 'ttl 0 must not pin the first value');
    assert.equal(await load(), 'v2', 'second value is cached normally');
  });
});
