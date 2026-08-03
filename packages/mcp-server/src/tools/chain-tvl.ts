import { canonicalizeChain, ChainInputSchema } from '@onchain-intel/core';
import { defineTool } from './registry.js';
import { z } from 'zod';
import type { CapabilityRegistry } from '@onchain-intel/core';
import { resolveCapability, type CacheMeta } from './resolve-capability.js';
import { contractViolationReason } from './contract-violation.js';

const CAPABILITY = 'chain.tvl';

/**
 * Input for `onchain_chain_tvl` (TASK-006 task 006-7, R-53 — interfaces.md §5.1.3).
 *
 * **A separate tool from `onchain_protocol_tvl`, not a mode of it.** A chain and a protocol are
 * different subjects with different sources (`/v2/chains` vs `/protocol/{slug}`) and different
 * outputs: a protocol has `totalTvlUsd` across all chains, a chain has no such notion. Merging
 * them would mean a parameter that silently changes what every other field means — the worst kind
 * of contract overloading.
 */
export const ChainTvlInputSchema = z.object({ chain: ChainInputSchema }).strict();
export type ChainTvlInput = z.infer<typeof ChainTvlInputSchema>;

/**
 * Output for `onchain_chain_tvl`. Follows the `ProtocolTvlResult` precedent — `tvlUsd: number`,
 * not the `value_raw` string discipline: DB-SCHEMA §1.7 prescribes that for exact integers beyond
 * 2^53 (wei, credits), whereas a USD TVL is an approximate aggregate to begin with. The adapter
 * rejects non-finite/negative values BEFORE caching, so this schema is a backstop, not the guard.
 */
export const ChainTvlOutputSchema = z
  .object({
    chain: ChainInputSchema,
    name: z.string(),
    tvlUsd: z.number().nonnegative(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type ChainTvlOutput = z.infer<typeof ChainTvlOutputSchema>;

export interface ChainTvlContext {
  registry: CapabilityRegistry;
}

export type ChainTvlOutcome =
  { ok: true; value: ChainTvlOutput; cache: CacheMeta } | { ok: false; reason: string };

export async function chainTvlHandler(
  input: ChainTvlInput,
  ctx: ChainTvlContext,
): Promise<ChainTvlOutcome> {
  // Canonicalize before `args` — same reasoning as every other tool (data-model.md §4.2.2).
  // Against the registry THIS `CapabilityRegistry` gates on, never a second copy — see
  // `get-token.ts` for both reasons (vdd-multi cycle 5, H-4).
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const outcome = await resolveCapability(ctx.registry, CAPABILITY, chain, { chain });
  if (!outcome.ok) return outcome;

  // `safeParse`, never `parse` — a provider result that fails the contract is reported as
  // `{ok:false, reason}`, it never throws out of the handler (M1 adversarial cycle 2, finding 1a).
  const parsed = ChainTvlOutputSchema.safeParse(outcome.output);
  if (!parsed.success) {
    return { ok: false, reason: contractViolationReason(CAPABILITY, parsed.error) };
  }
  return { ok: true, value: parsed.data, cache: outcome.cache };
}

export const chainTvlToolSpec = defineTool({
  name: 'onchain_chain_tvl',
  title: 'Chain TVL',
  description:
    'Total value locked of a CHAIN (not a protocol), from DeFiLlama. Use onchain_protocol_tvl ' +
    'for a single protocol. Call onchain_list_chains to discover valid chain values.',
  inputSchema: ChainTvlInputSchema,
  outputSchema: ChainTvlOutputSchema,
  capability: CAPABILITY,
  needs: ['registry'],
  handler: async (input, ctx) => {
    const outcome = await chainTvlHandler(input, ctx);
    return outcome.ok ? { ok: true, output: outcome.value, cache: outcome.cache } : outcome;
  },
});
