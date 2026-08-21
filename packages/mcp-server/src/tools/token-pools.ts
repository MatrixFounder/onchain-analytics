import { z } from 'zod';
import { defineTool } from './registry.js';
import {
  canonicalizeChain,
  ChainInputSchema,
  PoolSchema,
  type CapabilityResolver,
} from '@onchain-intel/core';
import { contractViolation } from './contract-violation.js';
import {
  capabilityUnavailable,
  metaFrom,
  resolveCapability,
  type CacheMeta,
  type TimingMeta,
  DeadlineMsInputSchema,
} from './resolve-capability.js';

/**
 * `onchain_token_pools` — the pools one token trades in (T-014, R-34, `interfaces.md` §5.1.8).
 *
 * The `ToolSpec` and both schemas shipped with task 014-32b, registered alongside
 * `onchain_pool_info` so the `tools/list` snapshot moved once (AC-2); task 014-32d replaced the stub
 * handler with the logic below.
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

export type TokenPoolsOutcome =
  | { ok: true; output: TokenPoolsOutput; cache: CacheMeta; timing?: TimingMeta }
  | { ok: false; reason: string; refusalClass?: string };

/**
 * Answers the pools a token trades in — task 014-32d.
 *
 * **The cross-chain form still has to be ROUTED somewhere, and this is the one design decision the
 * contract left open.** `registry.resolve()` takes a chain and uses it for exactly one thing here:
 * asking each candidate adapter's `chainSupport()` whether it serves the capability there. It is
 * NOT part of the cache key — that is `(capability, args)` (`net/args-hash.ts`) — so a routing
 * chain does not leak into what a cached answer is keyed on, and the caller's own `chain` reaches
 * the adapter through `args` or not at all.
 *
 * The anchor is therefore DERIVED from coverage rather than written down: the first chain the
 * registry says serves `token.pools`. A hardcoded `'ethereum'` would break the cross-chain form the
 * day that chain left the vendor's list, for a reason having nothing to do with the question asked.
 * When coverage is empty the tool refuses instead of resolving against a chain nobody serves —
 * which is the honest answer and not an empty pool list (class L-10).
 *
 * **The chain is canonicalised BEFORE `args` is built**, so `eth` and `ethereum` do not hash to two
 * cache entries for one logical request (data-model.md §4.2.2) — the rule `pool-info.ts` carries.
 *
 * **The token address is NOT normalised.** On the cross-chain form there is no chain to normalise
 * it against; on the per-chain form normalising to a checksum form is the DF-1 defect, since some
 * vendors match a contract address case-sensitively. It reaches the adapter as the caller wrote it.
 */
export async function tokenPoolsHandler(
  input: TokenPoolsInput,
  ctx: TokenPoolsContext,
): Promise<TokenPoolsOutcome> {
  const chain =
    input.chain === undefined
      ? null
      : canonicalizeChain(input.chain, ctx.registry.getChainRegistry());

  const routingChain = chain ?? ctx.registry.getCoverage().chainsFor(CAPABILITY)[0]?.slug;
  if (routingChain === undefined) {
    // Built by `resolve-capability.ts`, never here: a tool module constructing its own `{ok:false}`
    // is what `tools-refusal-class.test.ts` forbids, because such a refusal can ship without the
    // `refusalClass` that `request_trace`'s NOT NULL column requires.
    return capabilityUnavailable(
      CAPABILITY,
      'it is served on no chain this registry knows, so the cross-chain form has no route to ' +
        'take. This is a coverage fact, not an answer about the token.',
    );
  }

  const args: Record<string, unknown> = { token: input.token };
  // ABSENT, never `chain: undefined`: `canonicalize` in the args hash would otherwise have to
  // decide whether a present-but-undefined key differs from a missing one, and the two forms of
  // this call must key differently on purpose — they ask the vendor different questions.
  if (chain !== null) args['chain'] = chain;
  if (input.limit !== undefined) args['limit'] = input.limit;

  const outcome = await resolveCapability(
    ctx.registry,
    CAPABILITY,
    routingChain,
    args,
    input.deadlineMs,
  );
  if (!outcome.ok) return outcome;

  const answer = outcome.output as { pools?: unknown; truncated?: unknown };
  // `safeParse`, never `parse`: this handler declares `Promise<TokenPoolsOutcome>`, and a throw
  // would escape that contract and surface as a generic transport error rather than this tool's own
  // message — the rule every sibling handler follows.
  const parsed = TokenPoolsOutputSchema.safeParse({
    chain,
    pools: answer?.pools ?? [],
    truncated: answer?.truncated,
    source: outcome.cache.provider,
    fetchedAt: Date.now(),
  });
  if (!parsed.success) {
    return contractViolation(CAPABILITY, parsed.error);
  }
  return { ok: true, output: parsed.data, ...metaFrom(outcome) };
}

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
