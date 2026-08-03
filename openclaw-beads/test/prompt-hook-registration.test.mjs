// Regression tests for openclaw-beads-7k3: <plans_and_tasks> was absent from
// EVERY turn from 2026-07-30 onward because the host refused to register the
// plugin's `before_prompt_build` hook — non-bundled plugins need
// plugins.entries.beads.hooks.allowConversationAccess=true, which was unset.
// The refusal is a host-side warn line; the plugin could not tell and logged
// nothing, so every openclaw-beads-7sz guarantee was inert (the code that
// makes failure loud never ran).
//
// The fix has three parts, one test group each:
//   1. also register `heartbeat_prompt_contribution`, which is NOT in the
//      host's conversation-hook gate list, so heartbeats keep their queue;
//   2. dedup on runId so a granted-access heartbeat turn gets one block, not two;
//   3. say out loud at activation whether the gate is blocking us.
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activate,
  resolveConversationAccess,
  formatConversationAccessBlockedDiagnostic,
  markHeartbeatContribution,
  hasHeartbeatContribution,
} from '../dist/index.js';

let repo;

/** A repo whose JSONL export answers readiness without needing a real `bd`. */
before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'beads-hook-'));
  await mkdir(join(repo, '.beads'), { recursive: true });
  const records = [
    {
      _type: 'issue',
      id: 'openclaw-beads-7k3',
      title: 'Investigate absent plans_and_tasks block',
      status: 'open',
      priority: 2,
      assignee: 'tank',
      dependency_count: 0,
      created_at: '2026-08-03T06:00:00Z',
    },
  ];
  await writeFile(
    join(repo, '.beads', 'issues.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
});

after(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

/**
 * Minimal stand-in for the host's PluginApi. Records hook registrations and log
 * lines; `bdBinary` points at a name that does not exist so every `bd`
 * shell-out fails and the JSONL fallback answers — which is also the shape the
 * live gateway degrades to.
 */
function fakeApi(overrides = {}) {
  const hooks = new Map();
  const logs = { info: [], warn: [], error: [] };
  const api = {
    registerHttpRoute() {},
    logger: {
      info: (...a) => logs.info.push(a.join(' ')),
      warn: (...a) => logs.warn.push(a.join(' ')),
      error: (...a) => logs.error.push(a.join(' ')),
    },
    on(hookName, handler) {
      hooks.set(hookName, handler);
    },
    pluginConfig: {
      repos: [{ name: 'openclaw-beads', path: repo }],
      bdBinary: '/nonexistent/bd-for-tests',
      runLoop: { readyCacheTtlMs: 0, readyBudgetMs: 2_000 },
    },
    config: { plugins: { entries: { beads: {} } } },
    ...overrides,
  };
  return { api, hooks, logs };
}

describe('conversation-access gate detection (openclaw-beads-7k3)', () => {
  it('reports granted only when the flag is literally true', () => {
    const granted = { plugins: { entries: { beads: { hooks: { allowConversationAccess: true } } } } };
    assert.equal(resolveConversationAccess(granted), true);
  });

  it('reports blocked when the hooks key is absent — the live 2026-07-30 config', () => {
    const live = { plugins: { entries: { beads: { enabled: true, config: { repos: [] } } } } };
    assert.equal(resolveConversationAccess(live), false);
  });

  it('reports blocked when the flag is explicitly false', () => {
    const off = { plugins: { entries: { beads: { hooks: { allowConversationAccess: false } } } } };
    assert.equal(resolveConversationAccess(off), false);
  });

  it('reports unknown (not blocked) when the plugin cannot see plugins.entries', () => {
    assert.equal(resolveConversationAccess(undefined), undefined);
    assert.equal(resolveConversationAccess({}), undefined);
    assert.equal(resolveConversationAccess({ plugins: {} }), undefined);
  });

  it('names the exact config path and the verification command in the diagnostic', () => {
    const msg = formatConversationAccessBlockedDiagnostic();
    assert.match(msg, /plugins\.entries\.beads\.hooks\.allowConversationAccess/);
    assert.match(msg, /allowConversationAccess": true/);
    assert.match(msg, /journalctl/);
    assert.match(msg, /heartbeat_prompt_contribution/);
  });
});

describe('prompt hook registration (openclaw-beads-7k3)', () => {
  it('registers the ungated heartbeat hook as well as before_prompt_build', () => {
    const { api, hooks } = fakeApi();
    activate(api);
    assert.ok(
      hooks.has('heartbeat_prompt_contribution'),
      'heartbeat_prompt_contribution must be registered — it is the only prompt hook the host will accept from a non-bundled plugin without allowConversationAccess',
    );
    assert.ok(hooks.has('before_prompt_build'));
  });

  it('logs the blocked diagnostic at error level when access is not granted', () => {
    const { api, logs } = fakeApi();
    activate(api);
    assert.equal(logs.error.length, 1, 'exactly one loud line about the blocked hook');
    assert.match(logs.error[0], /before_prompt_build is BLOCKED by the host/);
  });

  it('logs registration confirmation instead when access IS granted', () => {
    const { api, logs } = fakeApi({
      config: { plugins: { entries: { beads: { hooks: { allowConversationAccess: true } } } } },
    });
    activate(api);
    assert.equal(logs.error.length, 0);
    assert.ok(
      logs.info.some((line) => /prompt hooks registered/.test(line)),
      'activation must state that both hooks are live',
    );
  });

  it('warns (does not cry wolf) when the flag is not knowable from the config', () => {
    const { api, logs } = fakeApi({ config: {} });
    activate(api);
    assert.equal(logs.error.length, 0);
    assert.ok(logs.warn.some((line) => /could not determine/.test(line)));
  });
});

describe('heartbeat contribution and runId dedup (openclaw-beads-7k3)', () => {
  it('the heartbeat hook produces the ready-work block on its own', async () => {
    const { api, hooks } = fakeApi();
    activate(api);
    const result = await hooks.get('heartbeat_prompt_contribution')(
      { sessionKey: 'agent:tank:main:heartbeat', agentId: 'tank' },
      { agentId: 'tank', runId: 'run-1', trigger: 'heartbeat' },
    );
    assert.ok(result?.prependContext, 'heartbeat turns must receive a block');
    assert.match(result.prependContext, /<plans_and_tasks/);
    assert.match(result.prependContext, /openclaw-beads-7k3/);
  });

  it('before_prompt_build skips a run the heartbeat hook already served', async () => {
    const { api, hooks } = fakeApi();
    activate(api);
    const ctx = { agentId: 'tank', runId: 'run-2', trigger: 'heartbeat' };
    const first = await hooks.get('heartbeat_prompt_contribution')({}, ctx);
    assert.ok(first?.prependContext);
    const second = await hooks.get('before_prompt_build')({}, ctx);
    assert.equal(second, undefined, 'the same run must not get the block twice');
  });

  it('before_prompt_build still contributes for a run the heartbeat hook did not serve', async () => {
    const { api, hooks } = fakeApi();
    activate(api);
    const result = await hooks.get('before_prompt_build')(
      {},
      { agentId: 'tank', runId: 'run-3', trigger: 'user' },
    );
    assert.ok(result?.prependContext, 'ordinary turns must still get the block when access is granted');
  });

  it('never suppresses when there is no runId — a duplicate block beats a missing one', async () => {
    const { api, hooks } = fakeApi();
    activate(api);
    const ctx = { agentId: 'tank', trigger: 'heartbeat' };
    await hooks.get('heartbeat_prompt_contribution')({}, ctx);
    const second = await hooks.get('before_prompt_build')({}, ctx);
    assert.ok(second?.prependContext, 'without a runId the block must still be emitted');
  });

  it('falls back to the event agentId when ctx carries none', async () => {
    const { api, hooks } = fakeApi();
    activate(api);
    const result = await hooks.get('heartbeat_prompt_contribution')(
      { agentId: 'tank' },
      { runId: 'run-4' },
    );
    assert.match(result.prependContext, /assign it to your own agent id \(tank\)/);
  });

  it('logs one accounting line per contribution with agent, run and block size', async () => {
    const { api, hooks, logs } = fakeApi();
    activate(api);
    await hooks.get('heartbeat_prompt_contribution')({}, { agentId: 'tank', runId: 'run-5' });
    const line = logs.info.find((l) => l.includes('plans_and_tasks via heartbeat_prompt_contribution'));
    assert.ok(line, 'every contribution must leave a forensic line in the gateway log');
    assert.match(line, /agent=tank/);
    assert.match(line, /run=run-5/);
    assert.match(line, /chars=[1-9][0-9]*/);
  });

  it('marks/reads run ids and never matches an absent one', () => {
    markHeartbeatContribution('run-marked');
    assert.equal(hasHeartbeatContribution('run-marked'), true);
    assert.equal(hasHeartbeatContribution('run-not-marked'), false);
    markHeartbeatContribution(undefined);
    assert.equal(hasHeartbeatContribution(undefined), false);
  });

  it('bounds the dedup set so a long-lived gateway does not leak run ids', () => {
    for (let i = 0; i < 400; i++) markHeartbeatContribution(`bulk-${i}`);
    assert.equal(hasHeartbeatContribution('bulk-399'), true);
    assert.equal(hasHeartbeatContribution('bulk-0'), false, 'oldest entries must be evicted');
  });
});

describe('suppression is never silent (openclaw-beads-7k3)', () => {
  it('logs a warning and no block when no repos are configured', async () => {
    const { api, hooks, logs } = fakeApi({ pluginConfig: { repos: [] } });
    activate(api);
    const result = await hooks.get('heartbeat_prompt_contribution')({}, { agentId: 'tank', runId: 'run-6' });
    assert.equal(result, undefined);
    assert.ok(logs.warn.some((l) => /SUPPRESSED.*repos is empty/.test(l)));
    assert.ok(logs.info.some((l) => /chars=0 SUPPRESSED/.test(l)));
  });

  it('logs a warning and no block when the run loop is disabled', async () => {
    const { api, hooks, logs } = fakeApi({
      pluginConfig: { repos: [{ name: 'openclaw-beads', path: repo }], runLoop: { enabled: false } },
    });
    activate(api);
    const result = await hooks.get('before_prompt_build')({}, { agentId: 'tank', runId: 'run-7' });
    assert.equal(result, undefined);
    assert.ok(logs.warn.some((l) => /SUPPRESSED.*runLoop\.enabled=false/.test(l)));
  });
});
