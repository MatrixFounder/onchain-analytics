/**
 * Caps a VENDOR-AUTHORED string before it enters a canonical entity (vdd-multi cycle 5, M-6).
 *
 * Token names, symbols and DEX pair labels are chosen by whoever deployed the contract, and every
 * one of them ends up verbatim in the model's context. On a permissionless DEX that is an
 * attacker-controlled channel, not merely a data-quality question — and TASK-006 widened
 * `token.price`/`pairs.new` from two chains to 458, where the long tail is exactly where creating
 * an adversarial token name is cheapest.
 *
 * **Truncation, not rejection** — the same conclusion `nansen/normalize.ts` reached in cycle 2 and
 * for the same reason: a `.max()` enforced only through `Schema.parse` throws AFTER the response is
 * in hand, so nothing is cached, the adapter is recorded as failed, and the tool reports an outage.
 * A 300-character token name would make that token permanently unreadable rather than merely
 * abbreviated. The schema caps stay as backstops that this function keeps unreachable.
 */
export const MAX_VENDOR_SYMBOL_LENGTH = 64;
export const MAX_VENDOR_NAME_LENGTH = 256;

/**
 * Caps `value` at `maxLength` **UTF-16 code units**, cutting only on code-point boundaries.
 *
 * `maxLength` counts code units because that is what the schema backstops count: zod's `.max()`
 * measures `input.length`. Cycle-1 read it as code points, which made the two disagree on exactly
 * the input an attacker chooses — 300 astral characters survive `Array.from(...).slice(0, 256)` as
 * 512 code units, and `parse()` then throws, i.e. the backstop this function claims to keep
 * unreachable fires. `token.holders` routes to `['blockscout']` alone, so that throw is a hard
 * capability failure plus a negative-cache entry; `entity.labels` escalates to PAID Nansen. Either
 * way the party choosing the label chooses the outcome, and Blockscout ingests user-submitted tags.
 *
 * Cutting on a code-point boundary is still non-negotiable: a bare `slice` through a surrogate pair
 * emits a lone surrogate, which travels into the JSON-RPC frame and into a `better-sqlite3` TEXT
 * bind (silently mangled to U+FFFD).
 *
 * Cost is **O(maxLength), not O(value.length)** — nothing bounds the input (`sanitize.ts`'s
 * `readString` checks only `typeof` and non-empty), so a 1 MB vendor `name` must not become a
 * 1M-element array to yield 256 characters. A code point is at most 2 code units, so the
 * `maxLength * 2` window provably contains the first `maxLength` code points; the loop stops at
 * `maxLength` units, which is far short of the window's (possibly severed) tail, so the severed
 * trailing surrogate is unreachable rather than merely unlikely.
 */
export function truncateVendorText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let out = '';
  let units = 0;
  for (const codePoint of value.slice(0, maxLength * 2)) {
    if (units + codePoint.length > maxLength) break;
    out += codePoint;
    units += codePoint.length;
  }
  return out;
}
