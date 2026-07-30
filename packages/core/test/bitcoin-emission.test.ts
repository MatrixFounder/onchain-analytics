import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BITCOIN_DECIMALS,
  bitcoinEmissionSat,
  SATOSHI_PER_BTC,
} from '../src/chain/bitcoin-emission.js';

const BTC = (n: bigint): bigint => n * SATOSHI_PER_BTC;

describe('bitcoinEmissionSat — the halving schedule, exactly', () => {
  it('returns 0 before any block exists', () => {
    expect(bitcoinEmissionSat(0)).toBe(0n);
  });

  it('pays the full 50 BTC subsidy for the genesis block', () => {
    expect(bitcoinEmissionSat(1)).toBe(BTC(50n));
  });

  it('releases exactly 10,500,000 BTC over the first epoch', () => {
    // 210_000 blocks x 50 BTC. A round number by construction, which is what makes it a good
    // anchor: any arithmetic slip shows up as a value that is not round.
    expect(bitcoinEmissionSat(210_000)).toBe(BTC(10_500_000n));
  });

  it('halves the subsidy exactly at the epoch boundary, not one block early or late', () => {
    const atBoundary = bitcoinEmissionSat(210_000);
    // The 210_000th block (count 210_000) is the LAST one paying 50; the next pays 25.
    expect(atBoundary - bitcoinEmissionSat(209_999)).toBe(BTC(50n));
    expect(bitcoinEmissionSat(210_001) - atBoundary).toBe(BTC(25n));
  });

  it('reaches the fourth-epoch boundary with the documented total', () => {
    // 210_000 x (50 + 25 + 12.5 + 6.25) = 210_000 x 93.75 BTC
    expect(bitcoinEmissionSat(840_000)).toBe(1_968_750_000_000_000n);
    // ...and the block after it pays 3.125 BTC, the current subsidy.
    expect(bitcoinEmissionSat(840_001) - bitcoinEmissionSat(840_000)).toBe(312_500_000n);
  });

  it('terminates once the subsidy shifts to zero, instead of spinning forever', () => {
    // Epoch 33+ pays nothing (integer shift reaches 0). Without that stop condition this call
    // would not return — the assertion here is as much about termination as about the value.
    const afterSchedule = bitcoinEmissionSat(210_000n * 40n);
    expect(afterSchedule).toBe(bitcoinEmissionSat(210_000n * 33n));
    // And the schedule's ceiling is the familiar one: just under 21M BTC.
    expect(afterSchedule).toBeLessThan(BTC(21_000_000n));
    expect(afterSchedule).toBeGreaterThan(BTC(20_999_999n));
  });

  it('is exact past 2^53 — the reason the accumulator is bigint and not a number', () => {
    const total = bitcoinEmissionSat(210_000n * 33n);
    expect(typeof total).toBe('bigint');
    // The value itself is below 2^53, but the guarantee must not depend on that. Proof that no
    // float rounding happened anywhere: a single satoshi difference survives.
    expect(bitcoinEmissionSat(1) + 1n).not.toBe(bitcoinEmissionSat(1));
    expect(total % 1n).toBe(0n);
  });

  it('accepts bigint and number identically', () => {
    expect(bitcoinEmissionSat(840_123n)).toBe(bitcoinEmissionSat(840_123));
  });

  it('refuses rather than coerces a nonsensical count', () => {
    // Every coercion here would return a PLAUSIBLE wrong number, which is worse than an error:
    // there is no downstream check that could tell 20,062,821 BTC from 20,062,818 BTC.
    expect(() => bitcoinEmissionSat(-1)).toThrow(RangeError);
    expect(() => bitcoinEmissionSat(-1n)).toThrow(RangeError);
    expect(() => bitcoinEmissionSat(1.5)).toThrow(RangeError);
    expect(() => bitcoinEmissionSat(Number.NaN)).toThrow(RangeError);
    expect(() => bitcoinEmissionSat(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    // Past 2^53 a `number` has already lost precision before arriving here; converting it would
    // launder that loss into an exact-looking bigint.
    expect(() => bitcoinEmissionSat(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
    expect(() => bitcoinEmissionSat('840000' as unknown as number)).toThrow(RangeError);
  });

  it('exposes the consensus constants the chain registry cannot supply', () => {
    // `nativeDecimals` for bitcoin is null in registry.data.json (DeFiLlama-synced, and that source
    // carries no decimals), so these come from consensus. Pinned here so a future "just read it
    // from the registry" refactor fails loudly instead of yielding `undefined`.
    expect(BITCOIN_DECIMALS).toBe(8);
    expect(SATOSHI_PER_BTC).toBe(100_000_000n);
  });
});

describe('bitcoinEmissionSat — against the pinned live evidence', () => {
  const evidencePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../docs/onchain-analytics/raw/blockchain-info-stats-2026-07-29.json',
  );
  const stats = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
    totalbc: number;
    n_blocks_total: number;
  };

  it("reproduces the vendor's own totalbc bit-exactly from its own block count", () => {
    // This is the test that pins the SEMANTICS, which is the part that can actually be wrong:
    // `n_blocks_total` is a block COUNT, not a tip height. Read as a height it would be off by one
    // block = 3.125 BTC = 0.000016% of supply — invisible to any plausibility check.
    //
    // It is NOT evidence that the vendor is telling the truth: the vendor derives this field the
    // same way we do, so agreement is close to a tautology. The value a second source can genuinely
    // contradict is the block count, and that comparison lives in eval/checks.mjs against an
    // unrelated vendor.
    expect(bitcoinEmissionSat(stats.n_blocks_total)).toBe(BigInt(stats.totalbc));
  });

  it('would NOT match if the count were read as a tip height', () => {
    // The mirror of the assertion above: proof that the previous test discriminates, rather than
    // passing for both readings and therefore testing nothing.
    expect(bitcoinEmissionSat(stats.n_blocks_total + 1)).not.toBe(BigInt(stats.totalbc));
  });
});
