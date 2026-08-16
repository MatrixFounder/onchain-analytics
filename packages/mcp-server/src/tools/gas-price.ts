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
import { contractViolation } from './contract-violation.js';

const CAPABILITY = 'gas.price';

/** Input for `onchain_gas_price` (WI-51) — a chain and nothing else. */
export const GasPriceInputSchema = z.object({ chain: ChainInputSchema }).strict();
export type GasPriceInput = z.infer<typeof GasPriceInputSchema>;

/**
 * Output for `onchain_gas_price`.
 *
 * Every numeric field is nullable and every `.describe()` says what a null MEANS, because the two
 * sources behind this capability answer with genuinely different shapes: a node states one exact
 * price in wei, an indexer states three rounded Gwei tiers and a measurement time. A schema that
 * demanded both would force one of them to invent the half it does not have.
 */
export const GasPriceOutputSchema = z
  .object({
    chain: ChainInputSchema,
    gasPriceWei: z
      .string()
      .nullable()
      .describe(
        'Exact price of one gas unit in wei, as a decimal string. Non-null only when the answer ' +
          'came from a node (source "rpc-evm"); an indexer publishes rounded Gwei and cannot ' +
          'state this. A string because on-chain integers must not pass through a JS number.',
      ),
    gasPriceGwei: z
      .number()
      .nullable()
      .describe(
        'The same price in Gwei, lossy and for comparison. Derived from gasPriceWei on the node ' +
          'path; the vendor\'s own "average" tier on the indexer path. Null means the source ' +
          'published no gas price at all for this chain — NOT that gas is free.',
      ),
    tiers: z
      .object({
        slowGwei: z.number(),
        averageGwei: z.number(),
        fastGwei: z.number(),
      })
      .nullable()
      .describe(
        'Slow/average/fast estimates in Gwei, when the source publishes them. Null on the node ' +
          'path, where one suggested price is all that exists — three copies of it would be a ' +
          'confidence interval nobody measured.',
      ),
    nativeSymbol: z
      .string()
      .nullable()
      .describe(
        'The chain\'s gas token. Read it before comparing chains: "386 Gwei" on polygon is POL ' +
          'and "0.3 Gwei" on ethereum is ETH, so the raw numbers are not comparable.',
      ),
    measuredAt: z
      .number()
      .int()
      .nullable()
      .describe(
        'When the SOURCE says it measured, epoch-ms UTC — not when this server fetched. Non-null ' +
          'only on the indexer path, which stamps it (and re-stamps roughly every minute). Null ' +
          'from a node, whose answer is for the head of the chain as of the request.',
      ),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type GasPriceOutput = z.infer<typeof GasPriceOutputSchema>;

export interface GasPriceContext {
  registry: CapabilityRegistry;
}

export type GasPriceOutcome =
  | { ok: true; value: GasPriceOutput; cache: CacheMeta; timing?: TimingMeta }
  | { ok: false; reason: string; refusalClass?: string };

export async function gasPriceHandler(
  input: GasPriceInput,
  ctx: GasPriceContext,
): Promise<GasPriceOutcome> {
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const outcome = await resolveCapability(ctx.registry, CAPABILITY, chain, { chain });
  if (!outcome.ok) return outcome;

  const parsed = GasPriceOutputSchema.safeParse(outcome.output);
  if (!parsed.success) {
    return contractViolation(CAPABILITY, parsed.error);
  }
  return { ok: true, value: parsed.data, ...metaFrom(outcome) };
}

export const gasPriceToolSpec = defineTool({
  name: 'onchain_gas_price',
  title: 'Gas price',
  description:
    'Current cost of one gas unit on an EVM chain, read from a node where one is approved and ' +
    'from the Blockscout indexer otherwise. Compare chains by gasPriceGwei ONLY together with ' +
    'nativeSymbol — the tokens differ. Call onchain_list_chains({capability: "gas.price"}) to ' +
    'discover which chains are served.',
  inputSchema: GasPriceInputSchema,
  outputSchema: GasPriceOutputSchema,
  capability: CAPABILITY,
  needs: ['registry', 'principal'],
  handler: async (input, ctx) => {
    const outcome = await gasPriceHandler(input, ctx);
    return outcome.ok ? { ok: true, output: outcome.value, ...metaFrom(outcome) } : outcome;
  },
});
