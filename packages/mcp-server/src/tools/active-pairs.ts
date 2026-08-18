import { z } from 'zod';
import { defineTool } from './registry.js';
import {
  canonicalizeChain,
  ChainInputSchema,
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
 * TASK-006 (task 006-6, R-50): `chain` is an OPEN string resolved against the chain registry,
 * replacing the `z.enum(['ethereum','solana'])` literal that this file (and six others) carried.
 * The closed enum for all 458 chains measured ~8.7k tokens of schema across the chain-taking
 * tools — paid on EVERY request to the model. Correctness moved into the runtime resolve, which
 * fails with a "did you mean" list and zero network calls (owner decision 2026-07-26).
 */
const SUPPORTED_CHAIN = ChainInputSchema;

/**
 * Input contract for `onchain_active_pairs` (ARCHITECTURE.md §5.1, R-18): `limit` is optional, a
 * positive integer when present — `dexscreener`'s own adapter already defaults an absent/
 * non-positive `limit` to `DEFAULT_LIMIT` (task 003-4), this schema just keeps a caller-supplied
 * value honest (never zero/negative) before it reaches the adapter.
 */
/** Upper bound on `limit` (vdd-multi cycle 5, M-6). Without one, `limit` was an unbounded knob on
 * how much VENDOR-AUTHORED text (`baseTokenSymbol`/`quoteTokenSymbol`, attacker-choosable on a
 * permissionless DEX) a single call pours into the model's context — and after TASK-006 this tool
 * reaches 458 chains, where the long tail is exactly where adversarial pair names are cheap to
 * create. `dexscreener`'s search response is a fixed page anyway, so a value above this bound could
 * never return more rows; it could only enlarge the blast radius. */
const MAX_LIMIT = 100;

export const ActivePairsInputSchema = z
  .object({
    chain: SUPPORTED_CHAIN,
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  })
  .extend({ deadlineMs: DeadlineMsInputSchema })
  .strict();
export type ActivePairsInput = z.infer<typeof ActivePairsInputSchema>;

/**
 * Output shape copied literally from ARCHITECTURE.md §5.1: `{ chain, pairs: Pool[], source,
 * fetchedAt }` — NOT one of the six canonical `types/*` schemas re-exported from
 * `@onchain-intel/core` (only `Pool`, the array ELEMENT type, is); this wrapper is new,
 * tool-contract-level data (mirrors `defillama`'s own `ProtocolTvlResult` precedent — a plain
 * shape ARCHITECTURE.md defines at the tool-contract level, not a canonical domain entity).
 * `source`/`fetchedAt` at the wrapper level describe the RESPONSE as a whole (which adapter
 * answered, when this response was built) — distinct from each `Pool` entry's OWN `source`/
 * `fetchedAt` fields, which describe when/how THAT entry's data was fetched (may be older, on a
 * cache hit).
 */
export const ActivePairsOutputSchema = z
  .object({
    chain: SUPPORTED_CHAIN,
    pairs: z.array(PoolSchema),
    /**
     * Q-10 — the answer to "why did I get fewer pairs than I asked for".
     *
     * Before this field, a short page was uninterpretable: the adapter dropped rows that failed
     * validation, counted them, and wrote the count to `process.stderr`, which an MCP client cannot
     * see. So `limit: 5` returning two pairs meant either "this chain has two matching pools" or
     * "three rows were thrown away", with nothing in the payload to tell them apart. Its siblings
     * `onchain_dex_volume` and `onchain_dash_platform_history` already carry this signal; this tool
     * was the outlier.
     */
    truncated: z
      .object({
        pairs: z
          .boolean()
          .describe(
            'True when this page is not the whole answer — rows failed validation and were ' +
              'dropped, or the vendor had more rows on this chain than `limit` allowed, or both.',
          ),
        reason: z
          .string()
          .describe(
            'Which of the two happened, with counts. Empty string when nothing was lost. Dropped ' +
              'rows cannot be recovered by any argument; rows cut by `limit` can.',
          ),
      })
      .strict(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type ActivePairsOutput = z.infer<typeof ActivePairsOutputSchema>;

export interface ActivePairsContext {
  registry: CapabilityResolver;
}

const CAPABILITY = 'pairs.active';

/** `dexscreener`'s own default when a caller omits `limit` (`packages/core/src/adapters/
 * dexscreener/index.ts`'s `DEFAULT_LIMIT`) — duplicated here rather than widening
 * `@onchain-intel/core`'s public export surface for one internal constant (developer-guidelines
 * §1.6). Kept in sync manually; `pairs.active`'s only registered adapter is `dexscreener`
 * (`providers.config.ts`), so this literal is this tool's own canonical default too. **Post-M1
 * polish fix 1:** materializing it HERE, before `args` is built, is what fixes the cache-key split
 * below — see `activePairsHandler`'s own docstring. */
const DEFAULT_LIMIT = 10;

export type ActivePairsOutcome =
  | { ok: true; output: ActivePairsOutput; cache: CacheMeta; timing?: TimingMeta }
  | { ok: false; reason: string; refusalClass?: string };

/**
 * Pure handler — no address to (re-)normalize here, unlike `get-token.ts`/`wallet-balances.ts`.
 *
 * **Cache-key split fix (post-M1 polish, cheap-fix backlog item 1):** an omitted `limit` used to
 * build `args = {chain}` while an explicit, default-valued `limit: 10` built
 * `args = {chain, limit: 10}` — two DIFFERENT `deriveArgsHash` keys for the exact same logical
 * query, so the two calls never shared a cache entry (a duplicate upstream `dexscreener` fetch for
 * what a caller would reasonably expect to be one cached query). The default is now materialized
 * into `limit` BEFORE `args` is built, so both call shapes produce the byte-identical `args` object
 * (and therefore the identical cache key) regardless of whether the caller passed the default
 * explicitly or omitted it.
 */
export async function activePairsHandler(
  input: ActivePairsInput,
  ctx: ActivePairsContext,
): Promise<ActivePairsOutcome> {
  // TASK-006 (task 006-6, R-50/R-59): resolve the alias to its canonical slug HERE, before the
  // value reaches `args` and therefore before `deriveArgsHash` — otherwise `eth` and `ethereum`
  // would hash to two different cache entries for one logical request, which on a paid route is
  // two charges (data-model.md §4.2.2).
  //
  // Resolved against `ctx.registry`, never the default — see `get-token.ts` (vdd-multi cycle 5, H-4).
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const limit = input.limit ?? DEFAULT_LIMIT;
  const args: Record<string, unknown> = { chain, limit };

  const outcome = await resolveCapability(ctx.registry, CAPABILITY, chain, args, input.deadlineMs);
  if (!outcome.ok) return outcome;

  // Adversarial cycle 1, fix I: `outcome.output` (the adapter's `Pool[]`) is validated exactly
  // ONCE, as part of the single `ActivePairsOutputSchema.parse(...)` below (its `pairs` field is
  // `z.array(PoolSchema)`) — this used to ALSO run a standalone `z.array(PoolSchema).parse(...)`
  // first, a redundant double-validation of the same data against the same schema.
  // `safeParse`, never `parse` (vdd-multi cycle 6, M): this handler declares
  // `Promise<ActivePairsOutcome>` and its six siblings all report a contract violation as
  // `{ok:false, reason}`. A throw here escapes that contract and surfaces as a generic transport
  // error instead of this tool's own message — see `protocol-tvl.ts` for the same argument.
  // Q-10: the adapter now hands back a PAGE (`{pools, truncated}`), not a bare array — the counts
  // it already computed had no way to reach the caller through an array.
  const page = outcome.output as { pools?: unknown; truncated?: unknown };
  const parsed = ActivePairsOutputSchema.safeParse({
    chain,
    pairs: page?.pools,
    truncated: page?.truncated,
    source: outcome.cache.provider,
    fetchedAt: Date.now(),
  });
  if (!parsed.success) {
    return contractViolation(CAPABILITY, parsed.error);
  }
  return { ok: true, output: parsed.data, ...metaFrom(outcome) };
}

/** The `ToolSpec` for `onchain_active_pairs` — this name is declared here and nowhere else (R-18).
 * Registration happens in `registry.ts`; see `get-token.ts`'s spec docstring for the shared
 * `isError`/`_meta.cache` wiring rationale. */
export const activePairsToolSpec = defineTool({
  name: 'onchain_active_pairs',
  title: 'Active DEX pairs',
  description:
    "ACTIVE DEX trading pairs on a chain, ranked by the vendor's own relevance — NOT newly " +
    'created ones. The underlying route is a search index with no recency semantics: measured, ' +
    'the freshest pair in a page was 155 days old and many rows are over a year old. This engine ' +
    'cannot answer "what launched recently" on any chain — say the question is unserved rather ' +
    'than presenting these as new listings. `createdAt` is per-pair and may be absent. Read ' +
    '`truncated` before concluding a chain is thin: a short page can mean rows were dropped. Call ' +
    'onchain_list_chains({capability:"pairs.active"}) to see where it is served (DexScreener-backed).',
  inputSchema: ActivePairsInputSchema,
  outputSchema: ActivePairsOutputSchema,
  capability: CAPABILITY,
  needs: ['registry', 'principal'],
  handler: activePairsHandler,
});
