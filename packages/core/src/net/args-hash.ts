import { createHash } from 'node:crypto';

/**
 * Recursively sorts object keys (ARCHITECTURE.md §7.2, reviewer note cycle 1) so that
 * `{chain, address}` and `{address, chain}` — the same logical args, built in a different key
 * order — produce the identical canonical form, and therefore the identical hash. Arrays keep
 * their element order (only object *keys* are canonicalized); primitives pass through unchanged.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>(
        (acc, key) => {
          acc[key] = canonicalize(record[key]);
          return acc;
        },
        // `Object.create(null)`, NOT `{}` (adversarial cycle 1, security): `JSON.parse` yields
        // `__proto__` as an OWN key, and `Object.keys` returns it — but on a normal object literal
        // `acc['__proto__'] = v` invokes the PROTOTYPE SETTER instead of creating an own property,
        // so the key silently vanishes from the canonical form. `{a:1}` and `{a:1,__proto__:{…}}`
        // would then hash identically → two different logical requests sharing one cache entry and
        // one singleflight slot. Not exploitable through today's tools (all three M2 input schemas
        // are `.strict()`, so zod rejects `__proto__` at the boundary), but `deriveArgsHash` is a
        // PUBLICLY EXPORTED helper and that protection lives three layers away in unrelated files.
        // A null-prototype accumulator has no setter to hit.
        Object.create(null) as Record<string, unknown>,
      );
  }
  return value;
}

/**
 * `args_hash` for the `cache_entries` cache key (ARCHITECTURE.md §3.2/§7.2): `args` is ALWAYS the
 * normalized tool-input (`chain`, address, `limit`, ...) obtained AFTER zod validation and
 * `normalizeAddress` — NEVER `process.env` or any secret (D10). `capability` is folded into the
 * hash input alongside `args` (not just used as a separate cache-key column) so that two
 * different capabilities called with coincidentally identical `args` don't collide.
 */
export function deriveArgsHash(capability: string, args: Record<string, unknown>): string {
  const payload = JSON.stringify({ capability, args: canonicalize(args) });
  return createHash('sha256').update(payload).digest('hex');
}
