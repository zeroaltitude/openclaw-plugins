import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listIssues,
  readIssuesJsonl,
  readyIssuesFromExport,
  showIssue,
} from '../dist/beads-cli.js';

let repo;

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'beads-fast-'));
  await mkdir(join(repo, '.beads'), { recursive: true });
  const records = [
    { _type: 'issue', id: 'r-1', title: 'open, no deps, p0', status: 'open', priority: 0, dependency_count: 0, created_at: '2026-04-01T00:00:00Z' },
    { _type: 'issue', id: 'r-2', title: 'open, no deps, p2', status: 'open', priority: 2, dependency_count: 0, created_at: '2026-04-02T00:00:00Z' },
    { _type: 'issue', id: 'r-3', title: 'closed', status: 'closed', priority: 0, dependency_count: 0 },
    { _type: 'issue', id: 'r-4', title: 'in_progress', status: 'in_progress', priority: 0, dependency_count: 0 },
    {
      _type: 'issue', id: 'r-5', title: 'open, blocked by open', status: 'open', priority: 0,
      dependency_count: 1,
      dependencies: [{ issue_id: 'r-5', depends_on_id: 'r-2', type: 'blocks' }],
    },
    {
      _type: 'issue', id: 'r-6', title: 'open, all deps closed', status: 'open', priority: 1,
      dependency_count: 1,
      dependencies: [{ issue_id: 'r-6', depends_on_id: 'r-3', type: 'blocks' }],
      created_at: '2026-04-03T00:00:00Z',
    },
    {
      _type: 'issue', id: 'r-7', title: 'open, deferred future', status: 'open', priority: 0,
      dependency_count: 0, defer_until: '3000-01-01T00:00:00Z',
    },
    {
      _type: 'issue', id: 'r-8', title: 'open, deferred past', status: 'open', priority: 3,
      dependency_count: 0, defer_until: '2020-01-01T00:00:00Z',
      created_at: '2026-04-04T00:00:00Z',
    },
  ];
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(join(repo, '.beads', 'issues.jsonl'), lines);
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

describe('JSONL fast path', () => {
  it('readIssuesJsonl returns null when file missing', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'beads-empty-'));
    try {
      assert.equal(await readIssuesJsonl(fresh), null);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it('listIssues uses JSONL fast path (no bd needed)', async () => {
    const issues = await listIssues({ cwd: repo });
    const ids = issues.map((i) => i.id).sort();
    assert.deepEqual(ids, ['r-1', 'r-2', 'r-3', 'r-4', 'r-5', 'r-6', 'r-7', 'r-8']);
  });

  it('showIssue resolves from JSONL by id', async () => {
    const issue = await showIssue('r-1', { cwd: repo });
    assert.equal(issue.id, 'r-1');
    assert.equal(issue.status, 'open');
  });

  it('readyIssuesFromExport applies bd ready semantics', async () => {
    const ready = await readyIssuesFromExport(repo, 10);
    assert.ok(Array.isArray(ready));
    const ids = ready.map((i) => i.id);
    // r-1 (p0), r-6 (p1, dep closed), r-2 (p2), r-8 (p3, defer past).
    // Excludes: r-3 (closed), r-4 (in_progress), r-5 (blocked by open), r-7 (deferred future).
    assert.deepEqual(ids, ['r-1', 'r-6', 'r-2', 'r-8']);
  });

  it('readyIssuesFromExport respects limit', async () => {
    const ready = await readyIssuesFromExport(repo, 2);
    assert.deepEqual(ready.map((i) => i.id), ['r-1', 'r-6']);
  });

  it('readyIssuesFromExport with includeInProgress merges in_progress alongside open', async () => {
    const ready = await readyIssuesFromExport(repo, 10, { includeInProgress: true });
    assert.ok(Array.isArray(ready));
    const ids = ready.map((i) => i.id);
    // r-1 (open p0), r-4 (in_progress p0), r-6 (open p1), r-2 (open p2), r-8 (open p3).
    // r-4 sorts among the p0s by created_at; the fixture omits r-4.created_at
    // so it falls to id-order tiebreak, placing r-4 after r-1.
    // Still excludes: r-3 (closed), r-5 (blocked by open), r-7 (deferred future).
    assert.deepEqual(ids, ['r-1', 'r-4', 'r-6', 'r-2', 'r-8']);
  });

  it('readyIssuesFromExport with includeInProgress does NOT apply defer / blocker checks to in_progress', async () => {
    // Even an in_progress issue with a future defer_until or an unresolved
    // blocker must surface, because it has already been claimed: defer and
    // blocker filters are about "safe to start", not "safe to keep going".
    const ipRepo = await mkdtemp(join(tmpdir(), 'beads-ip-'));
    try {
      await mkdir(join(ipRepo, '.beads'), { recursive: true });
      const recs = [
        {
          _type: 'issue', id: 'ip-1', status: 'in_progress', priority: 0,
          dependency_count: 1,
          dependencies: [{ issue_id: 'ip-1', depends_on_id: 'ip-2', type: 'blocks' }],
          defer_until: '3000-01-01T00:00:00Z',
        },
        { _type: 'issue', id: 'ip-2', status: 'open', priority: 0, dependency_count: 0 },
      ];
      await writeFile(
        join(ipRepo, '.beads', 'issues.jsonl'),
        recs.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
      const ready = await readyIssuesFromExport(ipRepo, 10, { includeInProgress: true });
      assert.ok(Array.isArray(ready));
      const ids = ready.map((i) => i.id).sort();
      assert.deepEqual(ids, ['ip-1', 'ip-2']);
    } finally {
      await rm(ipRepo, { recursive: true, force: true });
    }
  });

  it('readyIssuesFromExport returns null when dependency_count is missing on every record', async () => {
    const noDepRepo = await mkdtemp(join(tmpdir(), 'beads-nodep-'));
    try {
      await mkdir(join(noDepRepo, '.beads'), { recursive: true });
      await writeFile(
        join(noDepRepo, '.beads', 'issues.jsonl'),
        JSON.stringify({ _type: 'issue', id: 'x-1', title: 't', status: 'open', priority: 0 }) + '\n',
      );
      assert.equal(await readyIssuesFromExport(noDepRepo, 10), null);
    } finally {
      await rm(noDepRepo, { recursive: true, force: true });
    }
  });

  it('readyIssuesFromExport bails when a blocker is unknown', async () => {
    const unknownRepo = await mkdtemp(join(tmpdir(), 'beads-unknown-'));
    try {
      await mkdir(join(unknownRepo, '.beads'), { recursive: true });
      const recs = [
        {
          _type: 'issue', id: 'a', status: 'open', priority: 0, dependency_count: 1,
          dependencies: [{ issue_id: 'a', depends_on_id: 'cross-repo-x', type: 'blocks' }],
        },
      ];
      await writeFile(
        join(unknownRepo, '.beads', 'issues.jsonl'),
        recs.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
      assert.equal(await readyIssuesFromExport(unknownRepo, 10), null);
    } finally {
      await rm(unknownRepo, { recursive: true, force: true });
    }
  });
});
