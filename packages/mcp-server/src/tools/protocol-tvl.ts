import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CapabilityRegistry } from '@onchain-intel/core';
import { resolveCapability, type CacheMeta } from './resolve-capability.js';

/** The two supported networks (task 003-7 reviewer note, Major-2 — see `get-token.ts`'s
 * docstring for why the full `ChainSchema` isn't used here) — declared once and reused for both
 * the input and output `chain` fields below, so this file states the narrowing exactly once. */
const SUPPORTED_CHAIN = z.enum(['ethereum', 'solana']);

/**
 * Input contract for `onchain_protocol_tvl` (ARCHITECTURE.md §5.1, R-19): `protocolSlug` is the
 * DeFiLlama protocol slug (e.g. `'uniswap'`, `'raydium'`) — a plain non-empty string, not an
 * address, so there's no `superRefine` step here. **Bounded (post-M1 polish, cheap-fix backlog
 * item 2):** `.max(128)` — no real DeFiLlama protocol slug is anywhere near that long; this rejects
 * a pathologically long input (e.g. a 10k-character string) at the schema layer, cheaply, before it
 * could otherwise be built into a URL/cache-key args.
 */
export const ProtocolTvlInputSchema = z
  .object({
    chain: SUPPORTED_CHAIN,
    protocolSlug: z.string().min(1).max(128),
  })
  .strict();
export type ProtocolTvlInput = z.infer<typeof ProtocolTvlInputSchema>;

/**
 * Output shape copied literally from ARCHITECTURE.md §5.1: `{ protocol, chain, tvlUsd, totalTvlUsd,
 * source, fetchedAt }` — the exact shape `defillama`'s own `ProtocolTvlResult` (task 003-4, a plain
 * TS interface, not a zod schema — that adapter's own documented choice) already produces; this is
 * the FIRST zod schema for that shape (the tool-contract layer's own single source of truth,
 * ARCHITECTURE.md §5.1), not a duplicate of anything already zod-shaped in `@onchain-intel/core`.
 * `tvlUsd`/`totalTvlUsd` are `.nonnegative()` — a TVL is never negative — mirroring the same
 * constraint `PoolSchema.liquidityUsd`/`volume24hUsd` already apply (task 003-1) to analogous
 * USD-denominated fields.
 */
export const ProtocolTvlOutputSchema = z
  .object({
    protocol: z.string(),
    chain: SUPPORTED_CHAIN,
    tvlUsd: z.number().nonnegative(),
    totalTvlUsd: z.number().nonnegative(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type ProtocolTvlOutput = z.infer<typeof ProtocolTvlOutputSchema>;

export interface ProtocolTvlContext {
  registry: CapabilityRegistry;
}

const CAPABILITY = 'protocol.tvl';

export type ProtocolTvlOutcome =
  { ok: true; output: ProtocolTvlOutput; cache: CacheMeta } | { ok: false; reason: string };

/** Pure handler — `defillama.normalize()` already returns this exact shape 1:1 (task 003-4), so
 * this handler's only job beyond `resolveCapability` is the defensive zod re-parse (the tool layer
 * re-asserts its own advertised contract rather than trusting the adapter's plain-interface shape
 * blindly).
 *
 * **`safeParse`, never `parse` (adversarial cycle 2, finding 1a):** this handler's own documented
 * return type is the discriminated union `{ok:true,...} | {ok:false, reason}` — a `.parse()` call
 * that THROWS on a provider returning contract-violating data breaks that very contract (the
 * installed MCP SDK, 1.29, does catch the throw and still produces an `isError: true` response at
 * the wire level, so nothing crashes end-to-end, but `protocolTvlHandler` itself — unit-testable
 * without a transport — would incorrectly reject/throw instead of resolving to `{ok:false,
 * reason}` like every other failure path here). `safeParse` failure returns a reason string built
 * from the FIRST zod issue only (path + message) — never a raw, multi-issue zod-error dump, which
 * could be arbitrarily long and unhelpfully technical for an MCP client to render. */
export async function protocolTvlHandler(
  input: ProtocolTvlInput,
  ctx: ProtocolTvlContext,
): Promise<ProtocolTvlOutcome> {
  const outcome = await resolveCapability(ctx.registry, CAPABILITY, input.chain, {
    chain: input.chain,
    protocolSlug: input.protocolSlug,
  });
  if (!outcome.ok) return outcome;

  const parsed = ProtocolTvlOutputSchema.safeParse(outcome.output);
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

/** Registers `onchain_protocol_tvl` — exactly this name (R-19). See `get-token.ts`'s
 * `registerGetTokenTool` docstring for the shared `isError`/`_meta.cache` wiring rationale. */
export function registerProtocolTvlTool(server: McpServer, ctx: ProtocolTvlContext): void {
  server.registerTool(
    'onchain_protocol_tvl',
    {
      description:
        'Protocol TVL (chain-scoped and total) for a DeFiLlama protocol slug on ethereum or solana.',
      inputSchema: ProtocolTvlInputSchema,
      outputSchema: ProtocolTvlOutputSchema,
    },
    async (input) => {
      const outcome = await protocolTvlHandler(input, ctx);
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
