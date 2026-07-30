/**
 * Bitcoin's emission schedule, computed exactly (TASK-009, R-85).
 *
 * **Why this exists at all.** `chain.supply` reports a number a vendor hands us, and TASK-009's
 * whole subject is not trusting that number on its own. This module is the independent half: the
 * subsidy schedule is consensus, so the total ever released is a pure function of how many blocks
 * exist. Nothing here talks to a network, and nothing here can be wrong in a way a vendor could
 * cause.
 *
 * **What it can and cannot prove, stated up front so the check is not over-read.** Re-deriving
 * `blockchain.info`'s `/stats.totalbc` from this function matched it **bit-exactly at both heights
 * probed on 2026-07-29** — and that agreement is close to a tautology, because the vendor computes
 * the field the same way. It is still worth asserting (it pins the SEMANTICS of `n_blocks_total` as
 * a block COUNT rather than a tip height, which is a genuine off-by-one waiting to happen), but the
 * value that a second source can actually contradict is the block count itself. That comparison
 * lives in the eval, against an unrelated vendor — see `eval/checks.mjs`.
 *
 * @module
 */

/** Blocks per halving epoch — consensus (`SubsidyHalvingInterval`). */
const HALVING_INTERVAL = 210_000n;

/** The genesis-epoch subsidy, in satoshi: 50 BTC. */
const INITIAL_SUBSIDY_SAT = 5_000_000_000n;

/**
 * Satoshi per BTC. Exported because the ONE legitimate use of a lossy projection — a chart or a
 * comparison — still needs the divisor, and a second copy of `1e8` in a caller is how a unit bug
 * starts. The registry cannot supply it: `nativeDecimals` for `bitcoin` is `null` (the registry is
 * DeFiLlama-synced and that source does not carry decimals), so 8 comes from consensus.
 */
export const SATOSHI_PER_BTC = 100_000_000n;

/** Decimals of the native asset, from Bitcoin consensus rather than from the chain registry. */
export const BITCOIN_DECIMALS = 8;

/**
 * Total satoshi released by the subsidy schedule after `blockCount` blocks have been mined.
 *
 * `blockCount` is a **COUNT, not a tip height** — the two differ by one, and one block is 3.125 BTC
 * at the current epoch, which is 0.000016% of the supply: an off-by-one here is invisible to every
 * plausibility check a human would write. Genesis is block height 0, so a chain whose tip is at
 * height `h` has a count of `h + 1`.
 *
 * Exact by construction: the accumulator is `bigint` throughout and the subsidy halves by a shift,
 * never by division. **Never `number`** — this is the same rule that makes `value_raw` a TEXT
 * column (DB-SCHEMA §1.7). The current total (~2.006e15 sat) does fit in a double today, which is
 * exactly the reasoning that rots: the rule is that the value is an exact integer, not that it
 * currently happens to be small enough to survive being treated as a float.
 *
 * @throws RangeError when `blockCount` is negative, fractional, or not a number at all — refusing
 * beats coercing, because every coercion here returns a plausible wrong number rather than an error.
 */
export function bitcoinEmissionSat(blockCount: bigint | number): bigint {
  const count = toBlockCount(blockCount);

  let total = 0n;
  let epoch = 0n;
  for (;;) {
    // The shift is the halving. Past epoch 32 it yields 0 — that is the schedule ending, and it is
    // also what terminates this loop: without it, a caller passing an absurd count would spin
    // forever adding nothing. (Consensus itself stops paying there; Bitcoin Core's own
    // `GetBlockSubsidy` returns 0 for `halvings >= 64`, and integer arithmetic reaches zero first.)
    const subsidy = INITIAL_SUBSIDY_SAT >> epoch;
    if (subsidy === 0n) break;

    const firstBlockOfEpoch = epoch * HALVING_INTERVAL;
    if (firstBlockOfEpoch >= count) break;

    const endOfEpoch = (epoch + 1n) * HALVING_INTERVAL;
    const blocksInEpoch = (endOfEpoch < count ? endOfEpoch : count) - firstBlockOfEpoch;
    total += blocksInEpoch * subsidy;
    epoch += 1n;
  }
  return total;
}

/**
 * The block subsidy paid at `height`, in satoshi — `50 BTC >> floor(height / 210_000)`.
 *
 * Exists so that a difference between two supply figures can be reported **in blocks of subsidy**
 * rather than as a percentage, which is the unit this whole area has to be measured in: one block
 * is 3.125 BTC today, i.e. 0.000016% of supply, so on any percentage scale a human would pick, an
 * off-by-one and a full day of vendor staleness (144 blocks, 0.0023%) both round to zero.
 *
 * Returns `0` once the schedule is exhausted — a real answer, and callers dividing by it must say
 * what they mean for that case rather than let it become a division by zero.
 *
 * @throws RangeError on the same inputs `bitcoinEmissionSat` refuses.
 */
export function bitcoinSubsidyAtHeightSat(height: bigint | number): bigint {
  const epoch = toBlockCount(height) / HALVING_INTERVAL;
  // Shifting by an absurd epoch is defined but pointless; past 32 the subsidy is 0 regardless.
  return epoch > 64n ? 0n : INITIAL_SUBSIDY_SAT >> epoch;
}

/**
 * Normalizes the input to a non-negative `bigint` block count, or throws.
 *
 * A `number` is accepted because callers legitimately hold one (a vendor's JSON field arrives as a
 * JSON number), but it must be a safe integer: a value past 2^53 has already lost precision before
 * this function was called, and silently converting it would launder that loss into an exact-looking
 * `bigint`.
 */
function toBlockCount(value: bigint | number): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new RangeError(`block count must be >= 0, got ${value}`);
    return value;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RangeError(
      `block count must be a safe integer or a bigint, got ${typeof value} ${String(value)}`,
    );
  }
  if (value < 0) throw new RangeError(`block count must be >= 0, got ${value}`);
  return BigInt(value);
}
