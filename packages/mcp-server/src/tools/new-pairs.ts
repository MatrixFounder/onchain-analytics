import { z } from 'zod';
import { defineTool } from './registry.js';
import {
  canonicalizeChain,
  ChainInputSchema,
  PoolSchema,
  type CapabilityRegistry,
} from '@onchain-intel/core';
import { resolveCapability, type CacheMeta } from './resolve-capability.js';

/**
 * TASK-006 (task 006-6, R-50): `chain` is an OPEN string resolved against the chain registry,
 * replacing the `z.enum(['ethereum','solana'])` literal that this file (and six others) carried.
 * The closed enum for all 458 chains measured ~8.7k tokens of schema across the chain-taking
 * tools — paid on EVERY request to the model. Correctness moved into the runtime resolve, which
 * fails with a "did you mean" list and zero network calls (owner decision 2026-07-26).
 */
const SUPPORTED_CHAIN = ChainInputSchema;

/**
 * Input contract for `onchain_new_pairs` (ARCHITECTURE.md §5.1, R-18): `limit` is optional, a
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

export const NewPairsInputSchema = z
  .object({
    chain: SUPPORTED_CHAIN,
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  })
  .strict();
export type NewPairsInput = z.infer<typeof NewPairsInputSchema>;

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
export const NewPairsOutputSchema = z
  .object({
    chain: SUPPORTED_CHAIN,
    pairs: z.array(PoolSchema),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type NewPairsOutput = z.infer<typeof NewPairsOutputSchema>;

export interface NewPairsContext {
  registry: CapabilityRegistry;
}

const CAPABILITY = 'pairs.new';

/** `dexscreener`'s own default when a caller omits `limit` (`packages/core/src/adapters/
 * dexscreener/index.ts`'s `DEFAULT_LIMIT`) — duplicated here rather than widening
 * `@onchain-intel/core`'s public export surface for one internal constant (developer-guidelines
 * §1.6). Kept in sync manually; `pairs.new`'s only registered adapter is `dexscreener`
 * (`providers.config.ts`), so this literal is this tool's own canonical default too. **Post-M1
 * polish fix 1:** materializing it HERE, before `args` is built, is what fixes the cache-key split
 * below — see `newPairsHandler`'s own docstring. */
const DEFAULT_LIMIT = 10;

export type NewPairsOutcome =
  { ok: true; output: NewPairsOutput; cache: CacheMeta } | { ok: false; reason: string };

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
export async function newPairsHandler(
  input: NewPairsInput,
  ctx: NewPairsContext,
): Promise<NewPairsOutcome> {
  // TASK-006 (task 006-6, R-50/R-59): resolve the alias to its canonical slug HERE, before the
  // value reaches `args` and therefore before `deriveArgsHash` — otherwise `eth` and `ethereum`
  // would hash to two different cache entries for one logical request, which on a paid route is
  // two charges (data-model.md §4.2.2).
  //
  // Resolved against `ctx.registry`, never the default — see `get-token.ts` (vdd-multi cycle 5, H-4).
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const limit = input.limit ?? DEFAULT_LIMIT;
  const args: Record<string, unknown> = { chain, limit };

  const outcome = await resolveCapability(ctx.registry, CAPABILITY, chain, args);
  if (!outcome.ok) return outcome;

  // Adversarial cycle 1, fix I: `outcome.output` (the adapter's `Pool[]`) is validated exactly
  // ONCE, as part of the single `NewPairsOutputSchema.parse(...)` below (its `pairs` field is
  // `z.array(PoolSchema)`) — this used to ALSO run a standalone `z.array(PoolSchema).parse(...)`
  // first, a redundant double-validation of the same data against the same schema.
  // `safeParse`, never `parse` (vdd-multi cycle 6, M): this handler declares
  // `Promise<NewPairsOutcome>` and its six siblings all report a contract violation as
  // `{ok:false, reason}`. A throw here escapes that contract and surfaces as a generic transport
  // error instead of this tool's own message — see `protocol-tvl.ts` for the same argument.
  const parsed = NewPairsOutputSchema.safeParse({
    chain,
    pairs: outcome.output,
    source: outcome.cache.provider,
    fetchedAt: Date.now(),
  });
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const path = firstIssue && firstIssue.path.length > 0 ? firstIssue.path.join('.') : '(root)';
    const message = firstIssue?.message ?? 'invalid output shape';
    return {
      ok: false,
      reason: `provider returned data violating the tool contract: ${path}: ${message}`,
    };
  }
  return { ok: true, output: parsed.data, cache: outcome.cache };
}

/** The `ToolSpec` for `onchain_new_pairs` — this name is declared here and nowhere else (R-18).
 * Registration happens in `registry.ts`; see `get-token.ts`'s spec docstring for the shared
 * `isError`/`_meta.cache` wiring rationale. */
export const newPairsToolSpec = defineTool({
  name: 'onchain_new_pairs',
  title: 'Recent DEX pairs',
  description:
    'Recently active DEX trading pairs on a chain. Call ' +
    'onchain_list_chains({capability:"pairs.new"}) to see where it is served ' +
    '(DexScreener-backed).',
  inputSchema: NewPairsInputSchema,
  outputSchema: NewPairsOutputSchema,
  capability: CAPABILITY,
  needs: ['registry'],
  handler: newPairsHandler,
});
