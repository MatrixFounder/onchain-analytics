import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PoolSchema, type CapabilityRegistry, type Pool } from '@onchain-intel/core';
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

export type NewPairsOutcome =
  { ok: true; output: NewPairsOutput; cache: CacheMeta } | { ok: false; reason: string };

/** Pure handler — no address to (re-)normalize here, unlike `get-token.ts`/`wallet-balances.ts`. */
export async function newPairsHandler(
  input: NewPairsInput,
  ctx: NewPairsContext,
): Promise<NewPairsOutcome> {
  const args: Record<string, unknown> = { chain: input.chain };
  if (input.limit !== undefined) {
    args['limit'] = input.limit;
  }

  const outcome = await resolveCapability(ctx.registry, CAPABILITY, input.chain, args);
  if (!outcome.ok) return outcome;

  const pairs: Pool[] = z.array(PoolSchema).parse(outcome.output);
  const output = NewPairsOutputSchema.parse({
    chain: input.chain,
    pairs,
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
