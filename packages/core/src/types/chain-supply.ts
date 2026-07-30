import { z } from 'zod';
import { ChainSchema } from './chain.js';

/**
 * Canonical `ChainSupply` entity (TASK-009, R-83/R-84) — how much of a chain's native asset exists.
 *
 * The first canonical type whose subject is a chain's **monetary state** rather than a token,
 * wallet, pool or label. Served for `bitcoin` only, from the keyless `blockchain-info` adapter.
 *
 * **Two supply figures, because there are two facts — and this is the whole point of the type.**
 * A live keyless probe on 2026-07-29 settled what the two vendor surfaces actually mean, using a
 * test that admits no interpretation: how many WHOLE block subsidies fit between the value and the
 * halving boundary at block 840 000.
 *
 * - `/stats.totalbc` → `120102` subsidies — an **integer**, so it is the halving formula itself.
 *   That is `emission`: what the schedule has released.
 * - `/q/totalbc` → `120092.8` subsidies — **fractional**, so it cannot be the formula, nor a stale
 *   copy of it (a stale copy would sit at an integer offset). That is `circulating`: what miners
 *   actually claimed.
 *
 * The difference — measured at 28.75–31.88 BTC, about 0.00016% — is coinbase subsidy that was never
 * claimed. Serving either figure under the other's name would be a fabrication no reader could
 * catch, which is precisely why they are two named fields instead of one convenient "supply".
 *
 * **Exact values are strings** (DB-SCHEMA-CONCEPT §1.7). The current totals fit in a double, and
 * that is exactly the reasoning that rots: the rule is that the value is an exact integer, not that
 * it currently happens to be small enough. The `…Btc` companions are declared lossy and exist for
 * charts and comparisons only.
 */
export const ChainSupplySchema = z
  .object({
    chain: ChainSchema,
    /** Native asset symbol — `BTC`. From our chain registry, not from the vendor's free text. */
    symbol: z.string().max(16),
    /**
     * Decimals of the native asset. A **consensus** constant (8), not a registry lookup: the
     * registry's `nativeDecimals` for `bitcoin` is `null`, because it is DeFiLlama-synced and that
     * source carries no decimals. Stated in the output so a caller can scale `…Raw` itself.
     */
    decimals: z.number().int().nonnegative(),

    /** Satoshi released by the halving schedule, exact, as a decimal string. */
    emissionRaw: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .max(32),
    /** Lossy projection of `emissionRaw` into BTC — for charts and comparisons, never for accounting. */
    emissionBtc: z.number().nonnegative(),

    /** Satoshi actually claimed by miners, exact, as a decimal string. Always `<= emissionRaw`. */
    circulatingRaw: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .max(32),
    /** Lossy projection of `circulatingRaw` into BTC. */
    circulatingBtc: z.number().nonnegative(),

    /**
     * The block COUNT the emission figure is consistent with — not a tip height; the two differ by
     * one, and one block is 3.125 BTC (0.000016% of supply) at the current epoch.
     *
     * This is the field that carries real information, and the reason it is published rather than
     * kept internal: re-deriving `emissionRaw` from the schedule cannot contradict the vendor, since
     * the vendor derives it the same way. A second, unrelated source CAN contradict the block count,
     * and the deterministic schedule then propagates that disagreement into the supply figures. The
     * eval does exactly this against `mempool.space` (`eval/checks.mjs`).
     */
    blockCount: z.number().int().nonnegative(),

    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();

export type ChainSupply = z.infer<typeof ChainSupplySchema>;
