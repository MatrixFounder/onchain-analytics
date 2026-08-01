import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CapabilityRegistry, ChainFamily, ChainInfo } from '@onchain-intel/core';

/** Default page size. Small on purpose — see `ListChainsOutputSchema.total`. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Input for `onchain_list_chains` (TASK-006 task 006-7, R-52 — interfaces.md §5.1.3).
 *
 * This tool exists as the counterpart to the decision that `chain` is an OPEN string rather than a
 * 458-value enum: the enum would have shown the model every valid value at a cost of ~8.7k tokens
 * of schema per request, so discovery moved here, where it is paid only when actually needed.
 *
 * **Zero network calls.** Every answer comes from the committed registry and the coverage matrix,
 * both in memory (data-model.md §4.2.1/§4.2.3).
 */
export const ListChainsInputSchema = z
  .object({
    /** Substring match over slug, display name and aliases. */
    query: z.string().min(1).max(64).optional(),
    family: z.enum(['evm', 'svm', 'move', 'cosmos', 'utxo', 'other']).optional(),
    /** Keep only chains where THIS capability is actually served (e.g. `chain.tvl`). */
    capability: z.string().min(1).max(64).optional(),
    /** Filter on the registry's stale TVL snapshot — see `tvlUsdAtRegistrySync`. */
    minTvlUsd: z.number().nonnegative().optional(),
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  })
  .strict();
export type ListChainsInput = z.infer<typeof ListChainsInputSchema>;

const ListChainsRowSchema = z
  .object({
    slug: z.string(),
    caip2: z.string(),
    name: z.string(),
    family: z.string(),
    nativeSymbol: z.string().nullable(),
    /** Capabilities actually covered on this chain, from the same matrix the engine gates on. */
    capabilities: z.array(z.string()),
    /**
     * TVL **as of the last registry sync**, deliberately stale. Named `…AtRegistrySync`, not
     * `tvlUsd`, so it cannot be mistaken for an answer to "what is the TVL" — that question is
     * `onchain_chain_tvl`, which is live (data-model.md §4.1, business rule 3).
     */
    tvlUsdAtRegistrySync: z.number().nullable(),
  })
  .strict();

export const ListChainsOutputSchema = z
  .object({
    chains: z.array(ListChainsRowSchema),
    /**
     * How many chains matched BEFORE `limit` was applied. Without it a truncated page is
     * indistinguishable from "that is all there is", and the agent would silently conclude the
     * engine supports 50 chains.
     */
    total: z.number().int().nonnegative(),
    /** epoch-ms UTC of the registry snapshot — lets a caller tell stale data from missing support. */
    registrySyncedAt: z.number().int(),
  })
  .strict();
export type ListChainsOutput = z.infer<typeof ListChainsOutputSchema>;

export interface ListChainsContext {
  registry: CapabilityRegistry;
}

/**
 * `chain → its covered capabilities`, computed once per `CapabilityRegistry` (vdd-multi cycle 5,
 * M-8).
 *
 * `capabilitiesFor()` walks every route and every route's adapters, and the handler called it once
 * per row of the page — while `list()` above had already re-scanned all 458 rows. All of it is a
 * pure function of inputs that cannot change within a process: the committed registry snapshot and
 * the constructed route/adapter tables. The `WeakMap` keys on the registry instance rather than
 * living in module scope, so it holds no process-lifetime state of its own (ARCHITECTURE.md §8) and
 * a test that builds its own `CapabilityRegistry` gets its own entry.
 */
const capabilityCache = new WeakMap<CapabilityRegistry, Map<string, string[]>>();

function capabilitiesOf(ctx: ListChainsContext, chain: ChainInfo): string[] {
  let perRegistry = capabilityCache.get(ctx.registry);
  if (!perRegistry) {
    perRegistry = new Map<string, string[]>();
    capabilityCache.set(ctx.registry, perRegistry);
  }
  let capabilities = perRegistry.get(chain.caip2);
  if (!capabilities) {
    capabilities = ctx.registry.getCoverage().capabilitiesFor(chain);
    perRegistry.set(chain.caip2, capabilities);
  }
  // A COPY (vdd-multi cycle 6, L): the memo exists for the computation, not for object identity.
  // Handing out the cached array put it straight into the response, where any consumer that sorts
  // or pushes in place would corrupt the memo for every later call on this registry.
  return [...capabilities];
}

export function listChainsHandler(
  input: ListChainsInput,
  ctx: ListChainsContext,
): ListChainsOutput {
  // Both come from the CapabilityRegistry rather than being rebuilt here: a second matrix could
  // disagree with the one that actually gates the call.
  const chains = ctx.registry.getChainRegistry();
  const coverage = ctx.registry.getCoverage();

  const matched = chains
    .list({
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.family !== undefined ? { family: input.family as ChainFamily } : {}),
    })
    .filter((chain: ChainInfo) => {
      if (input.capability !== undefined && !coverage.isCovered(input.capability, chain)) {
        return false;
      }
      if (input.minTvlUsd !== undefined && (chain.tvlUsdAtSync ?? 0) < input.minTvlUsd) {
        return false;
      }
      return true;
    });

  // Rank by the stale TVL so the truncated page is the USEFUL half rather than an alphabetical
  // accident — the long tail of near-empty chains is real (top-50 ≈ 99% of all TVL).
  const ranked = [...matched].sort(
    (a, b) => (b.tvlUsdAtSync ?? 0) - (a.tvlUsdAtSync ?? 0) || a.slug.localeCompare(b.slug),
  );

  return {
    chains: ranked.slice(0, input.limit ?? DEFAULT_LIMIT).map((chain) => ({
      slug: chain.slug,
      caip2: chain.caip2,
      name: chain.name,
      family: chain.family,
      nativeSymbol: chain.nativeSymbol,
      capabilities: capabilitiesOf(ctx, chain),
      tvlUsdAtRegistrySync: chain.tvlUsdAtSync,
    })),
    total: ranked.length,
    registrySyncedAt: chains.syncedAt(),
  };
}

export function registerListChainsTool(server: McpServer, ctx: ListChainsContext): void {
  server.registerTool(
    'onchain_list_chains',
    {
      title: 'List supported chains',
      description:
        'Discover which chains this engine knows and which capabilities are actually served on ' +
        'each. Use it to find the right `chain` value for the other tools, or to check where a ' +
        'capability is available. Makes no network calls.',
      inputSchema: ListChainsInputSchema,
      outputSchema: ListChainsOutputSchema,
    },
    (input: ListChainsInput) => {
      const value = listChainsHandler(input, ctx);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(value) }],
        structuredContent: value,
      };
    },
  );
}
