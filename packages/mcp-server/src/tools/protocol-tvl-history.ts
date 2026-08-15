import { canonicalizeChain, ChainInputSchema } from '@onchain-intel/core';
import { defineTool } from './registry.js';
import { WindowChangeSchema } from './window-change.js';
import { z } from 'zod';
import type { CapabilityRegistry } from '@onchain-intel/core';
import {
  resolveCapability,
  type CacheMeta,
  type TimingMeta,
  metaFrom,
} from './resolve-capability.js';
import { contractViolationReason } from './contract-violation.js';

const CAPABILITY = 'protocol.tvl.history';

const DEFAULT_DAYS = 90;
const MAX_DAYS = 1825;

/**
 * Input for `onchain_protocol_tvl_history` (WI-50 option 2).
 *
 * ONE protocol at a time, deliberately. The only free source of a protocol's own history is the
 * per-protocol document, measured at 27.57 MiB for `aave-v3` on 2026-08-11, so this is not the tool
 * for ranking — `onchain_list_protocols` ranks by growth out of shared documents and costs nothing
 * extra.
 */
export const ProtocolTvlHistoryInputSchema = z
  .object({
    chain: ChainInputSchema,
    protocolSlug: z.string().min(1).max(128),
    days: z.number().int().min(1).max(MAX_DAYS).optional(),
  })
  .strict();
export type ProtocolTvlHistoryInput = z.infer<typeof ProtocolTvlHistoryInputSchema>;

export const ProtocolTvlHistoryOutputSchema = z
  .object({
    protocol: z.string(),
    chain: ChainInputSchema,
    deployed: z
      .boolean()
      .describe(
        'Whether the protocol is on this chain at all. false comes with an empty series and ' +
          'window.days 0 — an answer, not an error.',
      ),
    window: z
      .object({ fromMs: z.number().int(), toMs: z.number().int(), days: z.number().int() })
      .strict(),
    series: z.array(z.object({ ts: z.number().int(), tvlUsd: z.number().nonnegative() }).strict()),
    points: z.number().int().nonnegative(),
    gapDays: z
      .number()
      .int()
      .nonnegative()
      .describe('`points + gapDays === window.days` always — including when deployed is false.'),
    change: WindowChangeSchema,
    truncated: z.object({ series: z.boolean(), reason: z.string() }).strict(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type ProtocolTvlHistoryOutput = z.infer<typeof ProtocolTvlHistoryOutputSchema>;

export interface ProtocolTvlHistoryContext {
  registry: CapabilityRegistry;
}

export type ProtocolTvlHistoryOutcome =
  | { ok: true; value: ProtocolTvlHistoryOutput; cache: CacheMeta; timing?: TimingMeta }
  | { ok: false; reason: string };

export async function protocolTvlHistoryHandler(
  input: ProtocolTvlHistoryInput,
  ctx: ProtocolTvlHistoryContext,
): Promise<ProtocolTvlHistoryOutcome> {
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const days = input.days ?? DEFAULT_DAYS;

  const outcome = await resolveCapability(ctx.registry, CAPABILITY, chain, {
    chain,
    protocolSlug: input.protocolSlug,
    days,
  });
  if (!outcome.ok) return outcome;

  const parsed = ProtocolTvlHistoryOutputSchema.safeParse(outcome.output);
  if (!parsed.success) {
    return { ok: false, reason: contractViolationReason(CAPABILITY, parsed.error) };
  }
  return { ok: true, value: parsed.data, ...metaFrom(outcome) };
}

export const protocolTvlHistoryToolSpec = defineTool({
  name: 'onchain_protocol_tvl_history',
  title: 'Protocol TVL history',
  description:
    "How ONE protocol's TVL on ONE chain changed over time, with a ready-made `change` across " +
    'the window. Free and keyless (DeFiLlama). Use onchain_list_protocols to rank many protocols ' +
    "by growth — that is a shared cheap document, while this route downloads the protocol's full " +
    'history and refuses the few that are too large (mostly exchange trackers, not protocols). ' +
    'Use onchain_list_chains to find the `chain` value.',
  inputSchema: ProtocolTvlHistoryInputSchema,
  outputSchema: ProtocolTvlHistoryOutputSchema,
  capability: CAPABILITY,
  needs: ['registry', 'principal'],
  handler: async (input, ctx) => {
    const outcome = await protocolTvlHistoryHandler(input, ctx);
    return outcome.ok ? { ok: true, output: outcome.value, ...metaFrom(outcome) } : outcome;
  },
});
