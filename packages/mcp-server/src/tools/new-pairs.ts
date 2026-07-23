import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PoolSchema, type CapabilityRegistry } from '@onchain-intel/core';
import { resolveCapability, type CacheMeta } from './resolve-capability.js';

/** The two supported networks (task 003-7 reviewer note, Major-2 — see `get-token.ts`'s
 * docstring for why the full `ChainSchema` isn't used here) — declared once and reused for both
 * the input and output `chain` fields below, so this file states the narrowing exactly once. */
const SUPPORTED_CHAIN = z.enum(['ethereum', 'solana']);

/**
 * Input contract for `onchain_new_pairs` (ARCHITECTURE.md §5.1, R-18): `limit` is optional, a
 * positive integer when present — `dexscreener`'s own adapter already defaults an absent/
 * non-positive `limit` to `DEFAULT_LIMIT` (task 003-4), this schema just keeps a caller-supplied
 * value honest (never zero/negative) before it reaches the adapter.
 */
export const NewPairsInputSchema = z
  .object({
    chain: SUPPORTED_CHAIN,
    limit: z.number().int().positive().optional(),
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
  const limit = input.limit ?? DEFAULT_LIMIT;
  const args: Record<string, unknown> = { chain: input.chain, limit };

  const outcome = await resolveCapability(ctx.registry, CAPABILITY, input.chain, args);
  if (!outcome.ok) return outcome;

  // Adversarial cycle 1, fix I: `outcome.output` (the adapter's `Pool[]`) is validated exactly
  // ONCE, as part of the single `NewPairsOutputSchema.parse(...)` below (its `pairs` field is
  // `z.array(PoolSchema)`) — this used to ALSO run a standalone `z.array(PoolSchema).parse(...)`
  // first, a redundant double-validation of the same data against the same schema.
  const output = NewPairsOutputSchema.parse({
    chain: input.chain,
    pairs: outcome.output,
    source: outcome.cache.provider,
    fetchedAt: Date.now(),
  });
  return { ok: true, output, cache: outcome.cache };
}

/** Registers `onchain_new_pairs` — exactly this name (R-18). See `get-token.ts`'s
 * `registerGetTokenTool` docstring for the shared `isError`/`_meta.cache` wiring rationale. */
export function registerNewPairsTool(server: McpServer, ctx: NewPairsContext): void {
  server.registerTool(
    'onchain_new_pairs',
    {
      description: 'Recently active DEX trading pairs on ethereum or solana (DexScreener-backed).',
      inputSchema: NewPairsInputSchema,
      outputSchema: NewPairsOutputSchema,
    },
    async (input) => {
      const outcome = await newPairsHandler(input, ctx);
      if (!outcome.ok) {
        return { isError: true, content: [{ type: 'text', text: outcome.reason }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(outcome.output) }],
        structuredContent: outcome.output,
        _meta: { cache: outcome.cache },
      };
    },
  );
}
