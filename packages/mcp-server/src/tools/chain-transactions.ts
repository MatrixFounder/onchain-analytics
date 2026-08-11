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

const CAPABILITY = 'chain.transactions';

/** Input for `onchain_chain_transactions` (WI-51) — a chain and nothing else. */
export const ChainTransactionsInputSchema = z.object({ chain: ChainInputSchema }).strict();
export type ChainTransactionsInput = z.infer<typeof ChainTransactionsInputSchema>;

/**
 * Output for `onchain_chain_transactions`.
 *
 * **What is deliberately absent: active addresses.** WI-51 asked for them and this tool does not
 * answer them — the source publishes only a cumulative-since-genesis address count, which is a
 * different statistic wearing a similar name. The gap is stated in the tool description too, so a
 * model reading the catalogue learns it before asking rather than after.
 */
export const ChainTransactionsOutputSchema = z
  .object({
    chain: ChainInputSchema,
    transactionsPerDay: z
      .number()
      .int()
      .nullable()
      .describe(
        "The vendor's DAILY transaction aggregate. Do NOT read it as a running count of the " +
          'current day and do NOT difference two readings to get a rate: measured, it does not ' +
          'advance between block-by-block updates — it is recomputed periodically. Null means the ' +
          'source published no figure.',
      ),
    totalTransactions: z
      .number()
      .int()
      .nullable()
      .describe('Cumulative transactions since genesis.'),
    totalBlocks: z.number().int().nullable().describe('Cumulative blocks since genesis.'),
    averageBlockTimeMs: z
      .number()
      .nullable()
      .describe('Mean block interval in milliseconds, as the source computes it.'),
    networkUtilizationPct: z
      .number()
      .nullable()
      .describe(
        'Percent of block gas capacity in use. The one field here scoped to NOW rather than to ' +
          'all time, so it is the honest answer to "how busy is this chain right now".',
      ),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type ChainTransactionsOutput = z.infer<typeof ChainTransactionsOutputSchema>;

export interface ChainTransactionsContext {
  registry: CapabilityRegistry;
}

export type ChainTransactionsOutcome =
  | { ok: true; value: ChainTransactionsOutput; cache: CacheMeta; timing?: TimingMeta }
  | { ok: false; reason: string };

export async function chainTransactionsHandler(
  input: ChainTransactionsInput,
  ctx: ChainTransactionsContext,
): Promise<ChainTransactionsOutcome> {
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const outcome = await resolveCapability(ctx.registry, CAPABILITY, chain, { chain });
  if (!outcome.ok) return outcome;

  const parsed = ChainTransactionsOutputSchema.safeParse(outcome.output);
  if (!parsed.success) {
    return { ok: false, reason: contractViolationReason(CAPABILITY, parsed.error) };
  }
  return { ok: true, value: parsed.data, ...metaFrom(outcome) };
}

export const chainTransactionsToolSpec = defineTool({
  name: 'onchain_chain_transactions',
  title: 'Chain transaction activity',
  description:
    'How much a chain is used: daily and cumulative transaction counts, block totals, mean block ' +
    'time and current network utilization, from the Blockscout indexer. ACTIVE ADDRESSES ARE NOT ' +
    'SERVED by this engine — no wired provider publishes an activity-scoped address count, and ' +
    'the cumulative all-time count that exists is a different statistic. Do not substitute DEX ' +
    'volume or transaction counts for it; say the metric is unavailable. Call onchain_list_chains ' +
    'to discover valid chain values.',
  inputSchema: ChainTransactionsInputSchema,
  outputSchema: ChainTransactionsOutputSchema,
  capability: CAPABILITY,
  needs: ['registry'],
  handler: async (input, ctx) => {
    const outcome = await chainTransactionsHandler(input, ctx);
    return outcome.ok ? { ok: true, output: outcome.value, ...metaFrom(outcome) } : outcome;
  },
});
