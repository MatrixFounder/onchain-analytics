/**
 * TTL-per-capability, in seconds (ARCHITECTURE.md §3.2 table, D6 ranges applied to M1's concrete
 * capability set). Rows copied literally from that table; `platform.*` there is expanded here into
 * its four concrete capabilities (`platform.identities`/`contracts`/`documents`/`credits`).
 */
const TTL_SECONDS: Readonly<Record<string, number>> = {
  'token.price': 60,
  'token.metadata': 3600,
  'wallet.balances.native': 60,
  'pairs.new': 30,
  'protocol.tvl': 300,
  'privacy.shielded_pool': 3600,
  'platform.identities': 3600,
  'platform.contracts': 3600,
  'platform.documents': 3600,
  'platform.credits': 3600,
  'token.holders': 3600,

  // Not explicit rows in ARCHITECTURE.md §3.2's TTL table — implementation decision (developer-
  // guidelines §1.5 "implementation ambiguity"), documented here rather than silently guessed:
  // `pool.info` shares its adapter (dexscreener) and its liquidity/volume-style volatility with
  // `protocol.tvl`, not the "new"-freshness-critical `pairs.new` — same 300s bucket.
  'pool.info': 300,
  // The two `*.history` capabilities are historical views of an already-3600s-bucketed live
  // capability; the table's own stated rationale for that 3600s row ("no point polling faster than
  // the existing hourly snapshotter cadence") applies identically to their history counterparts.
  'privacy.shielded_pool.history': 3600,
  'platform.metrics.history': 3600,
};

/**
 * Safety net for any capability string not present in `TTL_SECONDS` above — kept explicit (a
 * conservative mid-range default matching the `protocol.tvl` bucket) rather than throwing, so an
 * unanticipated future capability degrades gracefully instead of crashing the cache path. Should
 * not be hit for M1's known capability set (`providers.config.ts`'s `routes`).
 */
const DEFAULT_TTL_SECONDS = 300;

/** Returns the TTL, in seconds, for `capability` (ARCHITECTURE.md §3.2). */
export function ttlFor(capability: string): number {
  return TTL_SECONDS[capability] ?? DEFAULT_TTL_SECONDS;
}
