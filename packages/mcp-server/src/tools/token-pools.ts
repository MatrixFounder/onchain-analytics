import { z } from 'zod';
import { defineTool } from './registry.js';
import { ChainInputSchema, PoolSchema, type CapabilityResolver } from '@onchain-intel/core';
import { DeadlineMsInputSchema, type CacheMeta, type TimingMeta } from './resolve-capability.js';
import { stubRefusal } from './stub-refusal.js';

/**
 * `onchain_token_pools` — the pools one token trades in (T-014, R-34, `interfaces.md` §5.1.8).
 *
 * **What this file is today.** The `ToolSpec`, both schemas and a stub handler; the logic ships in
 * task 014-32d. Registered in the same commit as `onchain_pool_info` so the `tools/list` snapshot
 * moves once (AC-2).
 *
 * **Why it is a capability of its own and not a mode of `pool.info`.** `onchain_pool_info` answers
 * by pool address: that is identification. One token trades in several pools, on several DEXes and
 * on several chains, and asking for those is discovery. The repository already draws this line on
 * three tests — a different endpoint, a different output contract, a different chain set — and all
 * three hold here, the same way they separate `chain.tvl` from `protocol.tvl`.
 *
 * **Rejected: one tool with a discriminated input.** It saves one `ToolSpec` and merges an exact,
 * complete answer with a capped sample into one output shape, leaving the caller unable to tell
 * which they received — class L-10.
 */
const SUPPORTED_CHAIN = ChainInputSchema;

/**
 * `token` is bounded but NOT format-checked against a chain, and that is a consequence of the
 * cross-chain form.
 *
 * `isValidAddress` takes a chain, and on the `token`-alone form there is none — the tool asks the
 * vendor which chains the address appears on. Checking the format against a chain the caller did
 * not name would either reject valid non-EVM input or accept it by guessing a family. The bound is
 * still here, because an unbounded string on a published schema is an unbounded string.
 */
const MAX_TOKEN_LENGTH = 128;

/** The same ceiling `onchain_active_pairs` carries, for the same reason: `limit` would otherwise be
 * an unbounded knob on how much VENDOR-AUTHORED text (pair and token symbols, attacker-choosable on
 * a permissionless DEX) one call pours into the model's context. Both vendor routes cap their page
 * at 30 rows anyway, so a value above this could never return more. */
const MAX_LIMIT = 100;

export const TokenPoolsInputSchema = z
  .object({
    token: z.string().min(1).max(MAX_TOKEN_LENGTH),
    chain: SUPPORTED_CHAIN.optional(),
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  })
  .extend({ deadlineMs: DeadlineMsInputSchema })
  .strict();
export type TokenPoolsInput = z.infer<typeof TokenPoolsInputSchema>;

/**
 * Output copied from `interfaces.md` §5.1.8.
 *
 * **`chain` is nullable, and every ROW carries its own.** A token address is not unique across
 * chains — a fork reproduces the addresses of the chain it forked. Measured 2026-08-18, the USDC
 * address of `ethereum` queried without a chain returned 30 rows of which 29 were `pulsechain`.
 * Presenting those as "this token's pools" would attribute another chain's pools to it, so the
 * cross-chain form answers `chain: null` and each row states where it lives.
 *
 * **`truncated` names its causes separately and never folds them.** The vendor page cap, which no
 * argument of either route widens; the `limit` cut, which a larger `limit` recovers; and dropped
 * rows, which nothing recovers. This is the L-14 contract the `pairs.active` route already carries.
 */
export const TokenPoolsOutputSchema = z
  .object({
    chain: SUPPORTED_CHAIN.nullable().describe(
      'OUR canonical slug when the caller named a chain; null on the cross-chain form, where ' +
        'each row carries its own chain instead.',
    ),
    pools: z.array(PoolSchema),
    truncated: z
      .object({
        pairs: z
          .boolean()
          .describe(
            'True when this page is not the whole answer — the vendor capped its page, `limit` ' +
              'cut rows, rows failed validation and were dropped, or several of those.',
          ),
        reason: z
          .string()
          .describe(
            'Which causes applied, with counts, named separately. Empty string when nothing was ' +
              'lost. A larger `limit` recovers only the `limit` cut: neither the vendor page cap ' +
              'nor dropped rows can be recovered by any argument.',
          ),
      })
      .strict(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type TokenPoolsOutput = z.infer<typeof TokenPoolsOutputSchema>;

export interface TokenPoolsContext {
  registry: CapabilityResolver;
}

const CAPABILITY = 'token.pools';

/** The task that replaces the stub below. Named in the refusal the caller receives. */
const LOGIC_TASK = '014-32d';

export type TokenPoolsOutcome =
  | { ok: true; output: TokenPoolsOutput; cache: CacheMeta; timing?: TimingMeta }
  | { ok: false; reason: string; refusalClass?: string };

/**
 * Stub handler — refuses, and the refusal names task 014-32d.
 *
 * Declared with the full signature and implemented with none — see `pool-info.ts` for why.
 *
 * An empty `pools` array is exactly what "this token trades nowhere" looks like, so the stub must
 * not return one. See `stub-refusal.ts` for the whole argument.
 */
export const tokenPoolsHandler: (
  input: TokenPoolsInput,
  ctx: TokenPoolsContext,
) => Promise<TokenPoolsOutcome> = () => Promise.resolve(stubRefusal(CAPABILITY, LOGIC_TASK));

/** The `ToolSpec` for `onchain_token_pools` — the name is declared here and nowhere else (R-18). */
export const tokenPoolsToolSpec = defineTool({
  name: 'onchain_token_pools',
  title: 'Pools a token trades in',
  description:
    'The DEX pools one token trades in, by token ADDRESS. With `chain`, the answer covers every ' +
    'DEX on that chain; without it, the answer is a SAMPLE across chains and each row states its ' +
    'own chain — a token address is not unique across chains, and a fork reproduces the ' +
    'addresses of the chain it forked, so never read the cross-chain form as complete. Read ' +
    '`truncated` before concluding a token is thinly traded: the vendor caps its page, and that ' +
    'cap is not widened by `limit`. Call onchain_list_chains({capability:"token.pools"}) to see ' +
    'where it is served (DexScreener-backed, keyless).',
  inputSchema: TokenPoolsInputSchema,
  outputSchema: TokenPoolsOutputSchema,
  capability: CAPABILITY,
  needs: ['registry', 'principal'],
  handler: tokenPoolsHandler,
});
