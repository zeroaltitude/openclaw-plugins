import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TtlCache } from '../dist/ttl-cache.js';

describe('TtlCache', () => {
  it('reuses cached value within TTL', async () => {
    const cache = new TtlCache();
    let calls = 0;
    const loader = async () => { calls++; return 'hi'; };
    const v1 = await cache.getOrLoad('k', 60_000, loader);
    const v2 = await cache.getOrLoad('k', 60_000, loader);
    assert.equal(v1, 'hi');
    assert.equal(v2, 'hi');
    assert.equal(calls, 1);
  });

  it('shares concurrent inflight promises for identical key', async () => {
    const cache = new TtlCache();
    let calls = 0;
    let resolveLoader;
    const loader = () => {
      calls++;
      return new Promise((r) => { resolveLoader = r; });
    };
    const p1 = cache.getOrLoad('k', 60_000, loader);
    const p2 = cache.getOrLoad('k', 60_000, loader);
    resolveLoader('shared');
    assert.equal(await p1, 'shared');
    assert.equal(await p2, 'shared');
    assert.equal(calls, 1);
  });

  it('reloads after TTL expires', async () => {
    const cache = new TtlCache();
    let calls = 0;
    const loader = async () => { calls++; return calls; };
    await cache.getOrLoad('k', 1, loader);
    await new Promise((r) => setTimeout(r, 8));
    await cache.getOrLoad('k', 1, loader);
    assert.equal(calls, 2);
  });

  it('keeps separate entries per key', async () => {
    const cache = new TtlCache();
    let calls = 0;
    const loader = async (label) => { calls++; return label; };
    const a1 = await cache.getOrLoad('a', 60_000, () => loader('a'));
    const b1 = await cache.getOrLoad('b', 60_000, () => loader('b'));
    const a2 = await cache.getOrLoad('a', 60_000, () => loader('a'));
    assert.equal(a1, 'a');
    assert.equal(b1, 'b');
    assert.equal(a2, 'a');
    assert.equal(calls, 2);
  });

  it('bypasses cache when ttlMs <= 0 but still dedupes inflight', async () => {
    const cache = new TtlCache();
    let calls = 0;
    const loader = async () => { calls++; await new Promise((r) => setTimeout(r, 0)); return calls; };
    // Sequential calls with ttlMs=0 must each invoke loader.
    await cache.getOrLoad('k', 0, loader);
    await cache.getOrLoad('k', 0, loader);
    assert.equal(calls, 2);
    // Concurrent calls with ttlMs=0 still share the inflight promise.
    let resolveSecond;
    const slow = () => { calls++; return new Promise((r) => { resolveSecond = r; }); };
    const p1 = cache.getOrLoad('k', 0, slow);
    const p2 = cache.getOrLoad('k', 0, slow);
    resolveSecond('x');
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, 'x');
    assert.equal(r2, 'x');
    assert.equal(calls, 3);
  });

  it('does not poison cache when loader throws', async () => {
    const cache = new TtlCache();
    let calls = 0;
    const loader = async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return 'ok';
    };
    await assert.rejects(() => cache.getOrLoad('k', 60_000, loader), /boom/);
    const v = await cache.getOrLoad('k', 60_000, loader);
    assert.equal(v, 'ok');
    assert.equal(calls, 2);
  });
});
