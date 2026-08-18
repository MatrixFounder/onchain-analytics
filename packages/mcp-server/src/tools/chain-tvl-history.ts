import { canonicalizeChain, ChainInputSchema } from '@onchain-intel/core';
import { defineTool } from './registry.js';
import { WindowChangeSchema } from './window-change.js';
import { z } from 'zod';
import type { CapabilityResolver } from '@onchain-intel/core';
import {
  DeadlineMsInputSchema,
  metaFrom,
  resolveCapability,
  type CacheMeta,
  type TimingMeta,
} from './resolve-capability.js';
import { contractViolation } from './contract-violation.js';

const CAPABILITY = 'chain.tvl.history';

/** Window default, materialized HERE and not left to the adapter — see the handler. */
const DEFAULT_DAYS = 90;
const MAX_DAYS = 1825;

/**
 * Input for `onchain_chain_tvl_history` (WI-50 option 1).
 *
 * A separate tool from `onchain_chain_tvl` rather than a `days` parameter on it, for the reason the
 * project keeps giving: a scalar and a run over time are different subjects with different cache
 * TTLs (300 s against an hour) and different answer sizes, and merging them needs a parameter that
 * changes the meaning of every other field.
 */
export const ChainTvlHistoryInputSchema = z
  .object({
    chain: ChainInputSchema,
    /** Window length in days, counted back from the newest day the vendor has published — never
     * from the clock, because the current day is not published until it closes. */
    days: z.number().int().min(1).max(MAX_DAYS).optional(),
  })
  .extend({ deadlineMs: DeadlineMsInputSchema })
  .strict();
export type ChainTvlHistoryInput = z.infer<typeof ChainTvlHistoryInputSchema>;

/**
 * Output for `onchain_chain_tvl_history`. The series contract is byte-for-byte the one
 * `onchain_dex_volume` publishes, because it is produced by the same code — a caller that has
 * learned to read `points`/`gapDays`/`truncated` once does not have to learn it twice.
 */
export const ChainTvlHistoryOutputSchema = z
  .object({
    chain: ChainInputSchema,
    name: z.string(),
    window: z
      .object({ fromMs: z.number().int(), toMs: z.number().int(), days: z.number().int() })
      .strict()
      .describe(
        'The window ACTUALLY covered — `days` is what you asked for when the chain has that much ' +
          'history, and less when it does not.',
      ),
    series: z
      .array(z.object({ ts: z.number().int(), tvlUsd: z.number().nonnegative() }).strict())
      .describe('Daily points, ts epoch-ms UTC, oldest first. One point per day, never stitched.'),
    points: z.number().int().nonnegative(),
    gapDays: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Daily steps MISSING inside the covered window. `points + gapDays === window.days` — so a ' +
          'gap is distinguishable from a real zero rather than being guessed at.',
      ),
    change: WindowChangeSchema,
    truncated: z.object({ series: z.boolean(), reason: z.string() }).strict(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type ChainTvlHistoryOutput = z.infer<typeof ChainTvlHistoryOutputSchema>;

export interface ChainTvlHistoryContext {
  registry: CapabilityResolver;
}

export type ChainTvlHistoryOutcome =
  | { ok: true; value: ChainTvlHistoryOutput; cache: CacheMeta; timing?: TimingMeta }
  | { ok: false; reason: string; refusalClass?: string };

export async function chainTvlHistoryHandler(
  input: ChainTvlHistoryInput,
  ctx: ChainTvlHistoryContext,
): Promise<ChainTvlHistoryOutcome> {
  // Canonicalize before `args`, against the registry THIS `CapabilityRegistry` gates on.
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  // The default is materialized BEFORE `args` is built: an omitted `days` and an explicit
  // `days: 90` are one logical request, and letting them reach `deriveArgsHash` as different shapes
  // would split the cache and duplicate the upstream fetch.
  const days = input.days ?? DEFAULT_DAYS;

  const outcome = await resolveCapability(
    ctx.registry,
    CAPABILITY,
    chain,
    { chain, days },
    input.deadlineMs,
  );
  if (!outcome.ok) return outcome;

  const parsed = ChainTvlHistoryOutputSchema.safeParse(outcome.output);
  if (!parsed.success) {
    return contractViolation(CAPABILITY, parsed.error);
  }
  return { ok: true, value: parsed.data, ...metaFrom(outcome) };
}

export const chainTvlHistoryToolSpec = defineTool({
  name: 'onchain_chain_tvl_history',
  title: 'Chain TVL history',
  description:
    "How a CHAIN's total value locked changed over time, from DeFiLlama — free and keyless. " +
    'Returns the daily series plus a ready-made `change` (absolute and percent) across the window, ' +
    'so "how much did TVL move in 30 days" is one call and no arithmetic. Use onchain_chain_tvl ' +
    'for the current figure alone, and onchain_protocol_tvl_history for one protocol; ' +
    'onchain_list_chains to find the `chain` value.',
  inputSchema: ChainTvlHistoryInputSchema,
  outputSchema: ChainTvlHistoryOutputSchema,
  capability: CAPABILITY,
  needs: ['registry', 'principal'],
  handler: async (input, ctx) => {
    const outcome = await chainTvlHistoryHandler(input, ctx);
    return outcome.ok ? { ok: true, output: outcome.value, ...metaFrom(outcome) } : outcome;
  },
});
