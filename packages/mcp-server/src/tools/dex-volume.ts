import { canonicalizeChain, ChainInputSchema } from '@onchain-intel/core';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CapabilityRegistry } from '@onchain-intel/core';
import { resolveCapability, type CacheMeta } from './resolve-capability.js';

const CAPABILITY = 'dex.volume.history';

/** Window default, materialized HERE rather than left to the adapter — see `dexVolumeHandler`. */
const DEFAULT_DAYS = 90;
const MAX_DAYS = 1825;

/**
 * Input for `onchain_dex_volume` (TASK-007 task 007-6, R-69 — interfaces.md §5.1.4).
 *
 * A separate tool from `onchain_chain_tvl` for the same reason that one is separate from
 * `onchain_protocol_tvl`: a different subject (volume traded, not value locked), a different source
 * endpoint, and — measured — a different chain set (274 against 458).
 */
export const DexVolumeInputSchema = z
  .object({
    chain: ChainInputSchema,
    /** Window length in days, counted back from the newest day the vendor has published. */
    days: z.number().int().min(1).max(MAX_DAYS).optional(),
    /** Set false to get only the aggregates — a much smaller answer when the daily series is not
     * what the question needs. */
    includeSeries: z.boolean().optional(),
  })
  .strict();
export type DexVolumeInput = z.infer<typeof DexVolumeInputSchema>;

/**
 * Output for `onchain_dex_volume`. USD figures are `number`, following the `ChainTvlResult`
 * precedent: DB-SCHEMA §1.7 prescribes exact-integer-as-string for wei/lamports/credits, whereas a
 * USD volume aggregate is approximate to begin with. `ts` is epoch-ms UTC (§1.2).
 *
 * The aggregates are nullable because absence is real and measured: the 274-chain echo probe
 * (2026-07-28) found `doge` — a COVERED chain — answering HTTP 200 with `total24h: null`. Rendering
 * that as `0` would report a measurement nobody made.
 */
export const DexVolumeOutputSchema = z
  .object({
    chain: ChainInputSchema,
    name: z.string(),
    /** The window ACTUALLY covered. `days` is what was asked for when the chain has that much
     * history, and less when it does not — so a caller comparing it with its own `days` learns the
     * chain is younger than the question (TASK-007 adversarial cycle 3, logic L-1). */
    window: z
      .object({
        fromMs: z.number().int(),
        toMs: z.number().int(),
        days: z.number().int().positive(),
      })
      .strict(),
    series: z.array(
      z.object({ ts: z.number().int(), volumeUsd: z.number().nonnegative() }).strict(),
    ),
    points: z.number().int().nonnegative(),
    /** Daily steps missing inside the covered window. Counted, never stitched. Invariant when a
     * series was requested: `points + gapDays === window.days` — a chain the vendor covers but
     * publishes nothing for reports the whole window as missing, not `0` (L-5). With
     * `includeSeries: false` the invariant does not apply and `points: 0` is the signal. */
    gapDays: z.number().int().nonnegative(),
    totals: z
      .object({
        h24: z.number().nullable(),
        d7: z.number().nullable(),
        d30: z.number().nullable(),
        d1y: z.number().nullable(),
        allTime: z.number().nullable(),
      })
      .strict(),
    truncated: z.object({ series: z.boolean(), reason: z.string() }).strict(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type DexVolumeOutput = z.infer<typeof DexVolumeOutputSchema>;

export interface DexVolumeContext {
  registry: CapabilityRegistry;
}

export type DexVolumeOutcome =
  { ok: true; value: DexVolumeOutput; cache: CacheMeta } | { ok: false; reason: string };

export async function dexVolumeHandler(
  input: DexVolumeInput,
  ctx: DexVolumeContext,
): Promise<DexVolumeOutcome> {
  // Canonicalize before `args`, against the registry THIS `CapabilityRegistry` gates on — never a
  // second copy (vdd-multi cycle 5, H-4).
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());

  // Defaults are materialized BEFORE `args` is built, deliberately: an omitted `days` and an
  // explicit `days: 90` are one logical request, and letting them reach `deriveArgsHash` as
  // different shapes would split the cache and duplicate the upstream fetch. Same fix, same
  // reason, as `onchain_new_pairs`' `limit`.
  const days = input.days ?? DEFAULT_DAYS;
  const includeSeries = input.includeSeries ?? true;

  const outcome = await resolveCapability(ctx.registry, CAPABILITY, chain, {
    chain,
    days,
    includeSeries,
  });
  if (!outcome.ok) return outcome;

  // `safeParse`, never `parse` — a provider result that fails the contract is reported as
  // `{ok:false, reason}`; it never throws out of the handler (M1 adversarial cycle 2, finding 1a).
  const parsed = DexVolumeOutputSchema.safeParse(outcome.output);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `dex.volume.history result failed contract validation: ${parsed.error.message}`,
    };
  }
  return { ok: true, value: parsed.data, cache: outcome.cache };
}

export function registerDexVolumeTool(server: McpServer, ctx: DexVolumeContext): void {
  server.registerTool(
    'onchain_dex_volume',
    {
      title: 'DEX volume of a chain',
      description:
        'Daily DEX trading volume of a CHAIN, from DeFiLlama — free and keyless. Returns the ' +
        'daily series in the requested window plus the vendor 24h/7d/30d/1y/all-time totals. ' +
        'Set includeSeries:false for the totals alone. This is volume TRADED, not value locked — ' +
        'use onchain_chain_tvl for TVL. Served on fewer chains than TVL is: call ' +
        'onchain_list_chains with capability "dex.volume.history" to see where.',
      inputSchema: DexVolumeInputSchema,
      outputSchema: DexVolumeOutputSchema,
    },
    async (input: DexVolumeInput) => {
      const outcome = await dexVolumeHandler(input, ctx);
      if (!outcome.ok) {
        return { isError: true, content: [{ type: 'text' as const, text: outcome.reason }] };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(outcome.value) }],
        structuredContent: outcome.value,
        _meta: { cache: outcome.cache },
      };
    },
  );
}
