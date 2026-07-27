import { LRUCache } from 'lru-cache';
import type { CacheGetResult } from '../adapters/cache-store.js';

/** Entry-count cap for the in-process hot layer — an implementation choice
 * (developer-guidelines §1.5): large enough that a single MCP session's working set of
 * (provider, capability, args) combinations won't thrash. It is NOT the memory bound; see
 * `DEFAULT_MAX_BYTES`, which is. */
const DEFAULT_MAX_ENTRIES = 500;

/**
 * Byte budget for the hot layer (WI-11).
 *
 * **Why a second bound was needed.** `max: 500` was chosen when the largest cached value was a
 * `ProtocolTvlResult` — six scalar fields, ~200 B — so the implied ceiling was 500 × 200 B = 100 KB,
 * a rounding error nobody had to think about. TASK-007's `dex.volume.history` result at
 * `days: 1825` is ~95 KB (1825 daily points), which moved that ceiling to **~47.5 MB without a
 * single line changing in this file**. A bound that only holds while nobody caches anything large
 * is not a bound, and the next capability to return an array would have moved it again, silently.
 *
 * **Stated in the unit it is actually measured in.** This budget counts SERIALIZED bytes
 * (`JSON.stringify`), because that is what can be measured cheaply and deterministically. Retained
 * V8 heap for the same value is larger — roughly 1.6–2.2× for object-heavy JSON — so 16 MB here is
 * on the order of 26–35 MB of heap. Saying "16 MB" and meaning heap would repeat the exact mistake
 * an earlier comment in this task made (multiplying wire bytes by a slot count to describe a heap
 * budget); the ratio is named instead of hidden.
 */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

interface HotEntry {
  value: unknown;
  createdAt: number;
}

/**
 * Serialized size of `value`, in bytes, for the byte budget.
 *
 * Computed HERE rather than threaded down from `SqliteCacheStore` (which already stringifies the
 * same value on the write path), and that is a deliberate deviation from WI-11's suggested "the
 * size hint is free" route. Threading it would change the `CacheStore.set` signature — a seam
 * implemented by `SqliteCacheStore`, `PassthroughCacheStore`, `TwoLevelStore` and several test
 * doubles — to save one `JSON.stringify` on the cache-MISS path, which is already behind a network
 * round trip of 50–300 ms. At the largest value this cache holds (~95 KB) that stringify is
 * sub-millisecond, and the HIT path — the one the two-level cache exists to make fast — is
 * untouched. Self-contained bound beats a wider interface for that price.
 *
 * A value that cannot be serialized never reaches this layer in production (`SqliteCacheStore.set`
 * runs first in `TwoLevelStore.set` and would throw on it), but this class is independently
 * constructible, so the failure is handled rather than assumed away: an unmeasurable value is
 * reported as oversized and simply not hot-cached.
 */
function serializedBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return Number.POSITIVE_INFINITY;
    // `lru-cache` requires a positive integer; `null`/`""` serialize to a few bytes but an empty
    // string would be 0, which it rejects outright.
    return Math.max(1, Buffer.byteLength(json, 'utf8'));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * In-process hot layer (`lru-cache`, ARCHITECTURE.md §3.2) — the first level `TwoLevelStore` checks
 * before falling through to the persistent `better-sqlite3` layer. TTL is supplied explicitly, in
 * milliseconds, on every `set()` call (never derived internally from `ttlFor`): a fresh write uses
 * the full capability TTL, while `TwoLevelStore`'s promotion-on-cold-hit path uses the entry's
 * REMAINING ttl — keeping that derivation logic entirely in the caller also lets lower-level tests
 * use small real TTLs without waiting out a capability's full real-world duration (e.g. 60s for
 * `token.price`).
 *
 * **Bounded twice, by count and by bytes** (WI-11). The two are independent: `max` stops a flood of
 * tiny entries, `maxSize` stops a handful of large ones. `lru-cache` sets `maxEntrySize` to
 * `maxSize` by default and, for an entry above it, deletes any existing value for that key and
 * silently declines to store the new one — verified in the installed source, not assumed. That is
 * the behaviour we want: an outsized value is simply not hot-cached, the persistent layer still has
 * it, and nothing throws on a write path that the Registry treats as best-effort anyway.
 *
 * **`ttlAutopurge` is on.** Without it `lru-cache` only drops an expired entry when something
 * touches it or capacity forces it out, so entries whose TTL elapsed hours ago stay resident in a
 * long-lived stdio process. The obvious objection — a timer per entry keeping the process alive —
 * was checked against the installed implementation rather than assumed: it calls `unref()` on every
 * purge timer where the platform supports it, so an idle process still exits.
 */
export class LruHotLayer {
  private readonly cache: LRUCache<string, HotEntry>;
  private readonly maxBytes: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES, maxBytes: number = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes;
    this.cache = new LRUCache<string, HotEntry>({
      max: maxEntries,
      maxSize: maxBytes,
      ttlAutopurge: true,
    });
  }

  private key(provider: string, capability: string, argsHash: string): string {
    // NUL-separated — none of the three components can legitimately contain it, unlike a plain
    // colon/`:` (adapter ids and capability strings already use `.`/`-`; argsHash is a hex digest).
    return `${provider}\u0000${capability}\u0000${argsHash}`;
  }

  get(provider: string, capability: string, argsHash: string): CacheGetResult | undefined {
    const entry = this.cache.get(this.key(provider, capability, argsHash));
    if (!entry) return undefined;
    return { value: entry.value, ageMs: Date.now() - entry.createdAt };
  }

  /**
   * @param ttlMs Remaining time-to-live, in milliseconds. An entry with `ttlMs <= 0` is not stored
   *   (used when `TwoLevelStore` promotes a cold hit whose persistent-layer TTL has already fully
   *   elapsed by the time it's read — should be rare in practice, since the persistent layer itself
   *   already treats such rows as a miss on read).
   * @param createdAt Optional explicit write timestamp (epoch-ms), defaulting to `Date.now()` for
   *   a genuinely fresh write. Adversarial cycle 2, fix 2: `TwoLevelStore`'s cold→hot PROMOTION
   *   path passes an already-back-dated value here (`Date.now() - coldHit.ageMs`) so the promoted
   *   entry's `ageMs` stays anchored to the value's ORIGINAL persistent-layer write time, instead
   *   of resetting to ~0 at promotion time and under-reporting `_meta.cache.ageMs` on every
   *   subsequent hot hit until the entry naturally expires.
   */
  set(
    provider: string,
    capability: string,
    argsHash: string,
    value: unknown,
    ttlMs: number,
    createdAt: number = Date.now(),
  ): void {
    if (ttlMs <= 0) return;
    const size = serializedBytes(value);
    // Checked here as well as inside `lru-cache` so an unserializable value (size `Infinity`) never
    // reaches a library that requires a positive integer.
    if (!Number.isFinite(size) || size > this.maxBytes) return;
    this.cache.set(
      this.key(provider, capability, argsHash),
      { value, createdAt },
      {
        ttl: ttlMs,
        size,
      },
    );
  }
}
