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

export function truncateVendorText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  // Cut on a CODE POINT boundary, not a UTF-16 code unit (vdd-multi cycle 6, L). `slice` through a
  // surrogate pair emits a lone surrogate, which then travels into the JSON-RPC frame and into a
  // `better-sqlite3` TEXT bind (silently mangled to U+FFFD). The cut offset is attacker-chosen —
  // a token whose emoji straddles position 64 is a one-line thing to deploy on a permissionless
  // DEX. `Array.from` also makes `maxLength` mean visible characters, which is what a reader of
  // this function's name expects.
  return Array.from(value).slice(0, maxLength).join('');
}
