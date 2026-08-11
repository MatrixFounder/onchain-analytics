import { canonicalizeChain, ChainInputSchema } from '@onchain-intel/core';
import { defineTool } from './registry.js';
import { z } from 'zod';
import type { CapabilityRegistry } from '@onchain-intel/core';
import {
  resolveCapability,
  type CacheMeta,
  type TimingMeta,
  metaFrom,
} from './resolve-capability.js';
import { contractViolationReason } from './contract-violation.js';

const CAPABILITY = 'dex.volume.history';

/** Window default, materialized HERE rather than left to the adapter — see `dexVolumeHandler`. */
const DEFAULT_DAYS = 90;
const MAX_DAYS = 1825;

/**
 * Input for `onchain_dex_volume` (TASK-007 task 007-6, R-69 — interfaces.md §5.1.4).
 *
 * A separate tool from `onchain_chain_tvl` for the same reason that one is separate from
 * `onchain_protocol_tvl`: a different subject (volume traded, not value locked), a different source
 * endpoint, and — measured — a different chain set (274 against 458).
 */
export const DexVolumeInputSchema = z
  .object({
    chain: ChainInputSchema,
    /** Window length in days, counted back from the newest day the vendor has published. */
    days: z.number().int().min(1).max(MAX_DAYS).optional(),
    /** Set false to get only the aggregates — a much smaller answer when the daily series is not
     * what the question needs. */
    includeSeries: z.boolean().optional(),
  })
  .strict();
export type DexVolumeInput = z.infer<typeof DexVolumeInputSchema>;

/**
 * Output for `onchain_dex_volume`. USD figures are `number`, following the `ChainTvlResult`
 * precedent: DB-SCHEMA §1.7 prescribes exact-integer-as-string for wei/lamports/credits, whereas a
 * USD volume aggregate is approximate to begin with. `ts` is epoch-ms UTC (§1.2).
 *
 * The aggregates are nullable because absence is real and measured: the 274-chain echo probe
 * (2026-07-28) found `doge` — a COVERED chain — answering HTTP 200 with `total24h: null`. Rendering
 * that as `0` would report a measurement nobody made.
 */
export const DexVolumeOutputSchema = z
  .object({
    chain: ChainInputSchema,
    name: z.string(),
    /** The window ACTUALLY covered. `days` is what was asked for when the chain has that much
     * history, and less when it does not — so a caller comparing it with its own `days` learns the
     * chain is younger than the question (TASK-007 adversarial cycle 3, logic L-1). */
    window: z
      .object({
        fromMs: z.number().int(),
        toMs: z.number().int(),
        days: z.number().int().positive(),
      })
      .strict(),
    series: z.array(
      z
        .object({
          ts: z.number().int(),
          volumeUsd: z.number().nonnegative(),
          partial: z
            .boolean()
            .describe(
              'Q-7: true for the CURRENT UTC day, which is still accumulating. Such a point is ' +
                'not comparable with the finished days beside it — drop it before computing a ' +
                'trend, keep it for an intraday read. It is never dropped for you: removing it ' +
                'would silently shorten every window by one.',
            ),
        })
        .strict(),
    ),
    points: z.number().int().nonnegative(),
    /** Daily steps missing inside the covered window. Counted, never stitched. Invariant when a
     * series was requested: `points + gapDays === window.days` — a chain the vendor covers but
     * publishes nothing for reports the whole window as missing, not `0` (L-5). With
     * `includeSeries: false` the invariant does not apply and `points: 0` is the signal. */
    gapDays: z.number().int().nonnegative(),
    totals: z
      .object({
        h24: z.number().nullable(),
        d7: z.number().nullable(),
        d30: z.number().nullable(),
        d1y: z.number().nullable(),
        allTime: z.number().nullable(),
        asOfTs: z
          .number()
          .int()
          .nullable()
          .describe(
            'Q-7: the day `h24` covers, epoch-ms UTC. Measured, `h24` is the last COMPLETE day — ' +
              'NOT the last series point, which is today and partial. Never add `h24` to a sum ' +
              'over `series` (double-counts a day) and never compare it against the last point ' +
              '(a 35-56% phantom jump). Null means the alignment could NOT be verified against ' +
              'this response — treat `h24` as unaligned, not as absent.',
          ),
      })
      .strict(),
    truncated: z.object({ series: z.boolean(), reason: z.string() }).strict(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type DexVolumeOutput = z.infer<typeof DexVolumeOutputSchema>;

export interface DexVolumeContext {
  registry: CapabilityRegistry;
}

export type DexVolumeOutcome =
  | { ok: true; value: DexVolumeOutput; cache: CacheMeta; timing?: TimingMeta }
  | { ok: false; reason: string };

export async function dexVolumeHandler(
  input: DexVolumeInput,
  ctx: DexVolumeContext,
): Promise<DexVolumeOutcome> {
  // Canonicalize before `args`, against the registry THIS `CapabilityRegistry` gates on — never a
  // second copy (vdd-multi cycle 5, H-4).
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());

  // Defaults are materialized BEFORE `args` is built, deliberately: an omitted `days` and an
  // explicit `days: 90` are one logical request, and letting them reach `deriveArgsHash` as
  // different shapes would split the cache and duplicate the upstream fetch. Same fix, same
  // reason, as `onchain_active_pairs`' `limit`.
  const days = input.days ?? DEFAULT_DAYS;
  const includeSeries = input.includeSeries ?? true;

  const outcome = await resolveCapability(ctx.registry, CAPABILITY, chain, {
    chain,
    days,
    includeSeries,
  });
  if (!outcome.ok) return outcome;

  // `safeParse`, never `parse` — a provider result that fails the contract is reported as
  // `{ok:false, reason}`; it never throws out of the handler (M1 adversarial cycle 2, finding 1a).
  const parsed = DexVolumeOutputSchema.safeParse(outcome.output);
  if (!parsed.success) {
    return { ok: false, reason: contractViolationReason(CAPABILITY, parsed.error) };
  }
  return { ok: true, value: parsed.data, ...metaFrom(outcome) };
}

export const dexVolumeToolSpec = defineTool({
  name: 'onchain_dex_volume',
  title: 'DEX volume of a chain',
  description:
    'Daily DEX trading volume of a CHAIN, from DeFiLlama — free and keyless. Returns the ' +
    'daily series in the requested window plus the vendor 24h/7d/30d/1y/all-time totals. ' +
    'Set includeSeries:false for the totals alone. This is volume TRADED, not value locked — ' +
    'use onchain_chain_tvl for TVL. THE TOTALS AND THE SERIES ARE OFFSET BY A DAY: totals.h24 is ' +
    'the last COMPLETE day (see totals.asOfTs) while the last series point is today and carries ' +
    'partial:true. Never add h24 to a sum over series, and never compare h24 against the last ' +
    'point — both readings are wrong by one day. Served on fewer chains than TVL is: call ' +
    'onchain_list_chains with capability "dex.volume.history" to see where.',
  inputSchema: DexVolumeInputSchema,
  outputSchema: DexVolumeOutputSchema,
  capability: CAPABILITY,
  needs: ['registry'],
  handler: async (input, ctx) => {
    const outcome = await dexVolumeHandler(input, ctx);
    return outcome.ok ? { ok: true, output: outcome.value, ...metaFrom(outcome) } : outcome;
  },
});
