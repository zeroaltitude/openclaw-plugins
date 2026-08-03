/**
 * Tiny in-memory TTL cache with shared inflight promises.
 *
 * Two concrete instances of this protect the Beads plugin from
 * repeatedly shelling out to `bd` on hot paths:
 *   - the `before_prompt_build` plans-and-tasks block, which fires every
 *     agent turn, and
 *   - the `/beads/api/ready` HTTP route, which the UI polls.
 *
 * Concurrent callers with the same key share one in-flight `bd` scan;
 * subsequent callers within `ttlMs` get the cached value without touching
 * the child process at all.
 */

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private inflight = new Map<string, Promise<T>>();

  /**
   * Returns the cached value if fresh, otherwise loads it (sharing the
   * promise across concurrent callers with the same key).
   *
   * `ttlMs <= 0` bypasses the cache entirely, but inflight dedup still
   * applies — duplicate concurrent calls with the same key share one load.
   *
   * `options.resolveTtlMs` lets the caller shorten (or drop) caching for a
   * particular value. The heartbeat block uses it so a DEGRADED block isn't
   * pinned for the full TTL: a transient `bd` failure should cost one turn,
   * not a minute of turns.
   */
  async getOrLoad(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    options: { resolveTtlMs?: (value: T) => number } = {},
  ): Promise<T> {
    if (ttlMs > 0) {
      const hit = this.store.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
    }
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      try {
        const value = await loader();
        const effectiveTtlMs = options.resolveTtlMs ? options.resolveTtlMs(value) : ttlMs;
        if (effectiveTtlMs > 0) {
          this.store.set(key, { expiresAt: Date.now() + effectiveTtlMs, value });
        } else {
          this.store.delete(key);
        }
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }

  size(): number {
    return this.store.size;
  }
}
