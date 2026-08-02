import { canonicalizeChain, ChainInputSchema } from '@onchain-intel/core';
import { defineTool } from './registry.js';
import { z } from 'zod';
import type { CapabilityRegistry } from '@onchain-intel/core';
import { resolveCapability, type CacheMeta } from './resolve-capability.js';

const CAPABILITY = 'chain.supply';

/**
 * Input for `onchain_chain_supply` (TASK-009, R-86 — interfaces.md §5.1.5).
 *
 * Chain and nothing else: supply is a property of the chain itself, not of an address or a contract.
 */
export const ChainSupplyInputSchema = z.object({ chain: ChainInputSchema }).strict();
export type ChainSupplyInput = z.infer<typeof ChainSupplyInputSchema>;

/**
 * Output for `onchain_chain_supply`.
 *
 * **Two supply figures, deliberately, and this is the contract's whole point.** They are different
 * facts: `emission` is what the halving schedule has released, `circulating` is what miners actually
 * claimed, and the difference is coinbase subsidy nobody ever took (~29–32 BTC as measured on
 * 2026-07-29, about 0.00016%). A single "supply" field would have to pick one and mislabel it, at
 * an error no reader could catch.
 *
 * Exact values are strings in the smallest unit (DB-SCHEMA §1.7); the `…Btc` fields are declared
 * lossy and exist for charts and comparisons. `blockCount` is published rather than kept internal
 * because it is the one field an independent source can genuinely contradict — see the eval's
 * cross-check, which grades it against `mempool.space` in blocks of subsidy.
 */
export const ChainSupplyOutputSchema = z
  .object({
    chain: ChainInputSchema,
    symbol: z.string(),
    decimals: z.number().int().nonnegative(),
    emissionRaw: z.string(),
    emissionBtc: z.number().nonnegative(),
    circulatingRaw: z.string(),
    circulatingBtc: z.number().nonnegative(),
    blockCount: z.number().int().nonnegative(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type ChainSupplyOutput = z.infer<typeof ChainSupplyOutputSchema>;

export interface ChainSupplyContext {
  registry: CapabilityRegistry;
}

export type ChainSupplyOutcome =
  { ok: true; value: ChainSupplyOutput; cache: CacheMeta } | { ok: false; reason: string };

export async function chainSupplyHandler(
  input: ChainSupplyInput,
  ctx: ChainSupplyContext,
): Promise<ChainSupplyOutcome> {
  // Canonicalize before `args`, against the registry THIS `CapabilityRegistry` gates on — the same
  // rule every other chain-taking tool follows (data-model.md §4.2.2).
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const outcome = await resolveCapability(ctx.registry, CAPABILITY, chain, { chain });
  if (!outcome.ok) return outcome;

  // `safeParse`, never `parse`: a provider result that fails the contract is reported as
  // `{ok:false, reason}` and never throws out of the handler.
  const parsed = ChainSupplyOutputSchema.safeParse(outcome.output);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `chain.supply result failed contract validation: ${parsed.error.message}`,
    };
  }
  return { ok: true, value: parsed.data, cache: outcome.cache };
}

export const chainSupplyToolSpec = defineTool({
  name: 'onchain_chain_supply',
  title: 'Chain native-asset supply',
  description:
    'How much of a chain\'s native asset exists. Returns TWO distinct figures: "emission" — ' +
    'what the issuance schedule has released — and "circulating" — what was actually claimed. ' +
    'They differ by unclaimed block subsidy and must not be used interchangeably. Exact values ' +
    'are the *Raw strings in the smallest unit; the *Btc fields are lossy conveniences. ' +
    'Bitcoin only today; call onchain_list_chains to see where the capability is served.',
  inputSchema: ChainSupplyInputSchema,
  outputSchema: ChainSupplyOutputSchema,
  capability: CAPABILITY,
  needs: ['registry'],
  handler: async (input, ctx) => {
    const outcome = await chainSupplyHandler(input, ctx);
    return outcome.ok ? { ok: true, output: outcome.value, cache: outcome.cache } : outcome;
  },
});
