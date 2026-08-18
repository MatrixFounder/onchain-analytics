import { canonicalizeChain, ChainInputSchema } from '@onchain-intel/core';
import { defineTool } from './registry.js';
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

const CAPABILITY = 'protocol.list';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

/**
 * Input for `onchain_list_protocols` (WI-49 option 1) — the tool that removes the need to know a
 * slug before asking a protocol question.
 *
 * Every default is materialized in the handler BEFORE `args` is built, so an omitted `limit` and an
 * explicit `limit: 20` are one cache entry rather than two.
 */
export const ListProtocolsInputSchema = z
  .object({
    chain: ChainInputSchema,
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    sortedBy: z
      .enum(['tvl', 'change1d', 'change7d', 'change30d'])
      .optional()
      .describe(
        'Ranking key, descending. Protocols the provider publishes no figure for always sort ' +
          'LAST, never as a zero.',
      ),
    minTvlUsd: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        "Floor on this chain's TVL, applied BEFORE ranking. Use it with a change* sort: without " +
          'a floor the top of a growth ranking is dust doubling from nothing.',
      ),
  })
  .extend({ deadlineMs: DeadlineMsInputSchema })
  .strict();
export type ListProtocolsInput = z.infer<typeof ListProtocolsInputSchema>;

export const ListProtocolsOutputSchema = z
  .object({
    chain: ChainInputSchema,
    name: z.string(),
    protocols: z.array(
      z
        .object({
          slug: z.string(),
          name: z.string(),
          category: z.string().nullable(),
          tvlUsd: z
            .number()
            .nonnegative()
            .nullable()
            .describe(
              'TVL on THIS chain. null means the protocol is listed here but the provider ' +
                'publishes only staking/borrowed buckets for it — unknown, not zero.',
            ),
          totalTvlUsd: z.number().nonnegative().nullable(),
          change: z
            .object({
              d1: z.number().nullable(),
              d7: z.number().nullable(),
              d30: z.number().nullable(),
            })
            .strict()
            .describe(
              'Percent change of the protocol TOTAL TVL. null where the provider publishes ' +
                'nothing — never 0, because a missing measurement and a flat month are different.',
            ),
          parent: z
            .string()
            .nullable()
            .describe(
              'The family this belongs to ("uniswap" for "uniswap-v3"). Pass it to ' +
                'onchain_protocol_tvl to get the family total.',
            ),
        })
        .strict(),
    ),
    matched: z
      .number()
      .int()
      .nonnegative()
      .describe('How many protocols matched BEFORE `limit` — so a truncated list looks truncated.'),
    limit: z.number().int().positive(),
    sortedBy: z.string(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type ListProtocolsOutput = z.infer<typeof ListProtocolsOutputSchema>;

export interface ListProtocolsContext {
  registry: CapabilityResolver;
}

export type ListProtocolsOutcome =
  | { ok: true; value: ListProtocolsOutput; cache: CacheMeta; timing?: TimingMeta }
  | { ok: false; reason: string; refusalClass?: string };

export async function listProtocolsHandler(
  input: ListProtocolsInput,
  ctx: ListProtocolsContext,
): Promise<ListProtocolsOutcome> {
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const limit = input.limit ?? DEFAULT_LIMIT;
  const sortedBy = input.sortedBy ?? 'tvl';
  const minTvlUsd = input.minTvlUsd ?? 0;

  const outcome = await resolveCapability(
    ctx.registry,
    CAPABILITY,
    chain,
    {
      chain,
      limit,
      sortedBy,
      minTvlUsd,
    },
    input.deadlineMs,
  );
  if (!outcome.ok) return outcome;

  const parsed = ListProtocolsOutputSchema.safeParse(outcome.output);
  if (!parsed.success) {
    return contractViolation(CAPABILITY, parsed.error);
  }
  return { ok: true, value: parsed.data, ...metaFrom(outcome) };
}

export const listProtocolsToolSpec = defineTool({
  name: 'onchain_list_protocols',
  title: 'Protocols on a chain',
  description:
    'Which DeFi protocols are on a chain, ranked — by TVL or by 1d/7d/30d TVL growth. Start here ' +
    'when you do not already know a protocol slug: it answers "the five largest protocols on X" ' +
    'and "what is growing fastest on X" without guessing names, and the slugs it returns are what ' +
    'onchain_protocol_tvl and onchain_protocol_tvl_history take. Free and keyless (DeFiLlama); ' +
    'onchain_list_chains to find the `chain` value.',
  inputSchema: ListProtocolsInputSchema,
  outputSchema: ListProtocolsOutputSchema,
  capability: CAPABILITY,
  needs: ['registry', 'principal'],
  handler: async (input, ctx) => {
    const outcome = await listProtocolsHandler(input, ctx);
    return outcome.ok ? { ok: true, output: outcome.value, ...metaFrom(outcome) } : outcome;
  },
});
