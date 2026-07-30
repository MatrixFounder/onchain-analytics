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
  // TASK-006 (task 006-7, R-53d): `/v2/chains` is an aggregate DeFiLlama recomputes on its own
  // cadence — a chain's total TVL does not move meaningfully faster than a protocol's, so it gets
  // the same 300s bucket as `protocol.tvl` rather than a separately invented number.
  'chain.tvl': 300,
  // TASK-007 (task 007-1, R-64). The vendor's own step for this dataset is ONE DAY
  // (`totalDataChart` is `[[unix_ts, usd], …]` with an exact 86400s stride — measured over 2825
  // points, 2824 of them exactly one day apart), so a TTL shorter than a day cannot buy a fresher
  // number. It can only buy a second identical 250KB download.
  //
  // The row is mandatory, not polish: without it this capability falls through to
  // `DEFAULT_TTL_SECONDS = 300` below — a constant whose own docstring says it should not be hit.
  // That exact accident already happened once, to all three of M2's PAID capabilities.
  'dex.volume.history': 3600,
  'privacy.shielded_pool': 3600,
  'platform.identities': 3600,
  'platform.contracts': 3600,
  'platform.documents': 3600,
  'platform.credits': 3600,
  'token.holders': 3600,
  // TASK-009 (R-82b). Mandatory, not polish: without this row the capability falls through to
  // `DEFAULT_TTL_SECONDS` below, whose own docstring says it should not be hit — an accident that
  // has already happened twice in this file (all three M2 paid capabilities, then
  // `dex.volume.history`). 600s is the Bitcoin target block interval: the value changes ONLY when a
  // block is found, so a shorter TTL cannot buy a fresher number, it can only buy a second identical
  // pair of requests.
  'chain.supply': 600,

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

  // ---------------------------------------------------------------------------------------------
  // M2 (TASK-005) — the first PAID capabilities. Explicit rows are mandatory here, not optional
  // polish: adversarial review cycle 1 found (independently, by both the performance and the
  // security critic) that these three were falling through to `DEFAULT_TTL_SECONDS` below — a
  // constant whose own docstring says it "should not be hit", chosen as an M1 *free*-tier safety
  // net. Letting the spend rate of the project's first paid provider be decided by that fallback
  // is an accident, not a decision. Each row below is a deliberate cost-vs-freshness call.
  // ---------------------------------------------------------------------------------------------
  // Genuinely volatile: `netflow1hUsd` is a 1-hour rolling window, so a short TTL is correct here.
  // (300s coincides with the old fallback — but now by decision, not by omission.) 10cr/miss.
  'smart-money.flows': 300,
  // Nansen Score risk/reward indicators are daily-ish quantitative scores, not tick data; caching
  // for 30 minutes costs no meaningful freshness. 6cr/miss.
  'token.risk': 1800,
  // Entity/profiler labels change on a timescale of DAYS (ENS, CEX, fund attributions). This is
  // also the most expensive call in the system — the `exhaustive: true` escalation is 100cr, the
  // entire free-plan balance. At the old 300s fallback, an agent revisiting one address four times
  // across a 25-minute investigation paid 400cr instead of 100cr. 1 hour is still conservative.
  'entity.labels': 3600,
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

/**
 * TTL for a NEGATIVE cache entry — a deterministic `normalize()` failure recorded so the next
 * identical call does not pay for the same rejected response again (issue L-1).
 *
 * Deliberately short, and deliberately NOT per-capability. The two forces pull opposite ways:
 *
 * - Longer is cheaper. `smart-money.flows` is 10cr per attempt and `entity.labels`' exhaustive tier
 *   is 100cr — the whole free-plan balance — so every second of negative TTL is money saved on a
 *   token the vendor genuinely has no row for.
 * - Shorter is safer. A negative entry is a cached *error*, and DF-1 proved an empty vendor
 *   response can also mean **our own request was malformed**. A long negative TTL would make a
 *   developer's fix appear not to work until it expired — the cache lying about a bug we just
 *   fixed. Sixty seconds is short enough that nobody debugs against a stale negative for long, and
 *   long enough to collapse an agent's retry storm from "per attempt" to "once a minute".
 */
export const NEGATIVE_TTL_SECONDS = 60;
