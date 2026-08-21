import { z } from 'zod';
import { defineTool } from './registry.js';
import {
  canonicalizeChain,
  ChainInputSchema,
  isValidAddress,
  PoolSchema,
  type CapabilityResolver,
} from '@onchain-intel/core';
import {
  DeadlineMsInputSchema,
  metaFrom,
  resolveCapability,
  type CacheMeta,
  type TimingMeta,
} from './resolve-capability.js';
import { contractViolation } from './contract-violation.js';

/**
 * `onchain_pool_info` — ONE pool, by address (T-014, R-21.1, `interfaces.md` §5.1.7).
 *
 * **Shipped in two commits on purpose.** Task 014-32b registered the `ToolSpec` and both schemas
 * with a stub handler, so the `tools/list` snapshot moved ONCE for two tools (AC-2); task 014-32c
 * replaced the stub with the vendor route, the fee derivation and the eval case.
 *
 * **Why the tool exists.** `pool.info` is declared by the manifest and resolved by no registered
 * tool (L-15). Owner decision `OQ-T014-F` selects variant 1: ship the tool. The capability, the
 * route and the adapter declaration all existed before this task; what was missing was a tool over
 * them.
 *
 * **Why the token ADDRESSES are the point.** `onchain_active_pairs` answers with both token SYMBOLS
 * and never an address (`types/pool.ts`), so symbol → contract address — WI-56's first link — was
 * served by nothing.
 */
const SUPPORTED_CHAIN = ChainInputSchema;

/** The bound `WalletBalancesInputSchema` already carries, for the identical reason: an over-length
 * value must not reach `isValidAddress`'s decode work, and the length is re-checked at the top of
 * `superRefine` because zod runs the refinement even after `.max()` has already flagged an issue. */
const MAX_ADDRESS_LENGTH = 64;

export const PoolInfoInputSchema = z
  .object({
    chain: SUPPORTED_CHAIN,
    pairAddress: z.string().min(1).max(MAX_ADDRESS_LENGTH),
  })
  .extend({ deadlineMs: DeadlineMsInputSchema })
  .strict()
  .superRefine((val, ctx) => {
    if (val.pairAddress.length > MAX_ADDRESS_LENGTH) {
      return;
    }
    if (!isValidAddress(val.chain, val.pairAddress)) {
      ctx.addIssue({
        code: 'custom',
        message: `invalid pool address for chain ${val.chain}`,
        path: ['pairAddress'],
      });
    }
  });
export type PoolInfoInput = z.infer<typeof PoolInfoInputSchema>;

/**
 * Output copied from `interfaces.md` §5.1.7 rather than paraphrased.
 *
 * **`resolved` and a nullable `pool` carry the unknown-pool case together.** The vendor answers
 * HTTP 200 with `"pairs":null` for an address it knows no pool at, and an empty `Pool` rendered as
 * success would read as a pool holding no tokens and no liquidity — the L-10 failure class. `pool`
 * is `null` exactly when `resolved` is `false`.
 *
 * **`chain` is OUR canonical slug**, never the vendor's `chainId`: the vendor vocabulary stops at
 * the anti-corruption layer (D4).
 */
export const PoolInfoOutputSchema = z
  .object({
    chain: SUPPORTED_CHAIN,
    resolved: z
      .boolean()
      .describe(
        'False when this vendor knows no pool at that address on that chain. `pool` is null ' +
          'exactly then — never an empty pool object.',
      ),
    pool: PoolSchema.nullable(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type PoolInfoOutput = z.infer<typeof PoolInfoOutputSchema>;

export interface PoolInfoContext {
  registry: CapabilityResolver;
}

const CAPABILITY = 'pool.info';

export type PoolInfoOutcome =
  | { ok: true; output: PoolInfoOutput; cache: CacheMeta; timing?: TimingMeta }
  | { ok: false; reason: string; refusalClass?: string };

/**
 * Resolves one pool by address — task 014-32c.
 *
 * **The chain is canonicalised BEFORE `args` is built**, and therefore before `deriveArgsHash`:
 * `eth` and `ethereum` would otherwise hash to two cache entries for one logical request, which on
 * a paid route is two charges (data-model.md §4.2.2). Resolved against `ctx.registry`, never the
 * default registry — the rule `get-token.ts` carries for the same reason.
 *
 * **The address is NOT re-normalised here.** `PoolInfoInputSchema.superRefine` already refused an
 * address the chain's own format rejects, and a pool address is a contract address the vendor
 * matches case-sensitively on some chains — normalising it to a checksum form is the defect DF-1
 * recorded on a different vendor's endpoint. It reaches the adapter as the caller wrote it.
 */
export async function poolInfoHandler(
  input: PoolInfoInput,
  ctx: PoolInfoContext,
): Promise<PoolInfoOutcome> {
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const args: Record<string, unknown> = { chain, pairAddress: input.pairAddress };

  const outcome = await resolveCapability(ctx.registry, CAPABILITY, chain, args, input.deadlineMs);
  if (!outcome.ok) return outcome;

  const answer = outcome.output as { resolved?: unknown; pool?: unknown };
  // `safeParse`, never `parse` (vdd-multi cycle 6, M): this handler declares
  // `Promise<PoolInfoOutcome>` and every sibling reports a contract violation as `{ok:false,
  // reason}`. A throw here would escape that contract and surface as a generic transport error
  // instead of this tool's own message.
  const parsed = PoolInfoOutputSchema.safeParse({
    chain,
    resolved: answer?.resolved,
    pool: answer?.pool ?? null,
    source: outcome.cache.provider,
    fetchedAt: Date.now(),
  });
  if (!parsed.success) {
    return contractViolation(CAPABILITY, parsed.error);
  }
  return { ok: true, output: parsed.data, ...metaFrom(outcome) };
}

/** The `ToolSpec` for `onchain_pool_info` — the name is declared here and nowhere else (R-18). */
export const poolInfoToolSpec = defineTool({
  name: 'onchain_pool_info',
  title: 'Pool info by address',
  description:
    'ONE DEX pool, looked up by its pair address on a chain: the CONTRACT ADDRESSES of both ' +
    'tokens, the per-side reserves, and the fee tier where it can be derived. Use this to turn a ' +
    'pair address into token addresses — onchain_active_pairs answers with symbols only. ' +
    '`resolved: false` means this vendor knows no pool at that address on that chain; it is not ' +
    'an empty pool. Reserves are the vendor’s own rounded numbers, not exact base units, and ' +
    '`feeTierBps` is absent wherever the derivation does not answer — never inferred from the ' +
    'version label. Call onchain_list_chains({capability:"pool.info"}) to see where it is served ' +
    '(DexScreener-backed, keyless).',
  inputSchema: PoolInfoInputSchema,
  outputSchema: PoolInfoOutputSchema,
  capability: CAPABILITY,
  needs: ['registry', 'principal'],
  handler: poolInfoHandler,
});
