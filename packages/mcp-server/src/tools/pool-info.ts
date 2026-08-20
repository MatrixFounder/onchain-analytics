import { z } from 'zod';
import { defineTool } from './registry.js';
import {
  ChainInputSchema,
  isValidAddress,
  PoolSchema,
  type CapabilityResolver,
} from '@onchain-intel/core';
import { DeadlineMsInputSchema, type CacheMeta, type TimingMeta } from './resolve-capability.js';
import { stubRefusal } from './stub-refusal.js';

/**
 * `onchain_pool_info` — ONE pool, by address (T-014, R-21.1, `interfaces.md` §5.1.7).
 *
 * **What this file is today.** The `ToolSpec`, both schemas and a stub handler. The logic ships in
 * task 014-32c, which also adds the vendor branch, the eval case and the fee derivation. The form
 * lands first and once, because the `tools/list` snapshot freezes the tool inventory and AC-2
 * accepts a move of it only with a justification in the commit — two separate stubs would move that
 * snapshot twice.
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

/** The task that replaces the stub below with the vendor call. Named in the refusal the caller
 * receives, so the interval is visible in the response and not only in a list. */
const LOGIC_TASK = '014-32c';

export type PoolInfoOutcome =
  | { ok: true; output: PoolInfoOutput; cache: CacheMeta; timing?: TimingMeta }
  | { ok: false; reason: string; refusalClass?: string };

/**
 * Stub handler — refuses, and the refusal names task 014-32c.
 *
 * **Declared with the full signature and implemented with none.** The type is the contract the
 * logic task inherits unchanged; the body takes no parameter because a stub that read one would
 * imply it does something with it.
 *
 * **It does not touch the registry.** Resolving the capability and then discarding the answer would
 * spend a vendor call and a cache slot to produce a refusal, and would make the stub interval
 * invisible in every counter that watches vendor traffic.
 */
export const poolInfoHandler: (
  input: PoolInfoInput,
  ctx: PoolInfoContext,
) => Promise<PoolInfoOutcome> = () => Promise.resolve(stubRefusal(CAPABILITY, LOGIC_TASK));

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
