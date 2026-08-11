import { z } from 'zod';
import { defineTool } from './registry.js';
import type { CapabilityRegistry } from '@onchain-intel/core';
import {
  resolveCapability,
  type CacheMeta,
  type TimingMeta,
  metaFrom,
} from './resolve-capability.js';
import { contractViolationReason } from './contract-violation.js';

const CAPABILITY = 'protocol.incidents';

/** Input for `onchain_protocol_incidents` (WI-52) — one protocol slug, no chain. */
export const ProtocolIncidentsInputSchema = z
  .object({
    protocolSlug: z
      .string()
      .min(1)
      .max(128)
      .describe(
        'DeFiLlama protocol slug, e.g. "aave-v3" or the parent "aave". A parent slug also ' +
          "surfaces incidents recorded against its versions — see each incident's matchedBy.",
      ),
  })
  .strict();
export type ProtocolIncidentsInput = z.infer<typeof ProtocolIncidentsInputSchema>;

const IncidentSchema = z
  .object({
    ts: z.number().int().describe('When the incident happened, epoch-ms UTC.'),
    name: z.string(),
    amountUsd: z.number().nullable().describe('Funds lost, when the record states one.'),
    classification: z.string().nullable(),
    technique: z.string().nullable(),
    targetType: z.string().nullable(),
    chains: z.array(z.string()),
    bridgeHack: z.boolean(),
    returnedFundsUsd: z.number().nullable(),
    matchedBy: z
      .enum(['protocol', 'parent'])
      .describe(
        '"protocol" — the record names this exact protocol. "parent" — it names a sibling under ' +
          'the same parent. Both are real risk signals and they are NOT the same claim.',
      ),
  })
  .strict();

/**
 * Output for `onchain_protocol_incidents`.
 *
 * Every field beside `incidents` exists so an empty list cannot be read as "this protocol is safe".
 * That reading is the failure this tool is most likely to cause, so the payload is built to make it
 * impossible to reach honestly: `resolved` separates "we know of no incident" from "we never
 * identified the protocol", and `feedThroughTs` / `unattributedRecords` bound what the silence can
 * mean.
 */
export const ProtocolIncidentsOutputSchema = z
  .object({
    protocol: z.string(),
    resolved: z
      .boolean()
      .describe(
        'False means the slug was NOT found in the vendor catalog, so NO statement is made about ' +
          'incidents — this is not "none found". Check the slug with onchain_list_protocols.',
      ),
    incidents: z.array(IncidentSchema),
    totalAmountUsd: z
      .number()
      .nullable()
      .describe('Sum of the stated amounts. Null when no matched incident stated one — not zero.'),
    feedThroughTs: z
      .number()
      .int()
      .describe(
        'Newest record in the WHOLE feed, epoch-ms UTC. This bounds how current any answer here ' +
          'can be: an incident from yesterday may simply not be written up yet.',
      ),
    feedRecords: z.number().int().describe('Records in the feed, total.'),
    unattributedRecords: z
      .number()
      .int()
      .describe(
        'Feed records naming no protocol id at all — exchange, bridge and individual incidents ' +
          'that can never be attributed to a protocol by this route. An empty result does not ' +
          'rule these out.',
      ),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type ProtocolIncidentsOutput = z.infer<typeof ProtocolIncidentsOutputSchema>;

export interface ProtocolIncidentsContext {
  registry: CapabilityRegistry;
}

export type ProtocolIncidentsOutcome =
  | { ok: true; value: ProtocolIncidentsOutput; cache: CacheMeta; timing?: TimingMeta }
  | { ok: false; reason: string };

export async function protocolIncidentsHandler(
  input: ProtocolIncidentsInput,
  ctx: ProtocolIncidentsContext,
): Promise<ProtocolIncidentsOutcome> {
  // Protocol-scoped, not chain-scoped. `ethereum` is the structural chain argument the registry's
  // coverage gate needs; it selects nothing here — the feed is global.
  const outcome = await resolveCapability(ctx.registry, CAPABILITY, 'ethereum', {
    protocolSlug: input.protocolSlug,
  });
  if (!outcome.ok) return outcome;

  const parsed = ProtocolIncidentsOutputSchema.safeParse(outcome.output);
  if (!parsed.success) {
    return { ok: false, reason: contractViolationReason(CAPABILITY, parsed.error) };
  }
  return { ok: true, value: parsed.data, ...metaFrom(outcome) };
}

export const protocolIncidentsToolSpec = defineTool({
  name: 'onchain_protocol_incidents',
  title: 'Protocol security incidents',
  description:
    'Recorded security incidents (hacks, exploits, rugpulls) for one protocol, from the DeFiLlama ' +
    'incident feed. THIS IS EDITORIAL DATA, NOT ON-CHAIN: it is written up after the fact, so ' +
    'read feedThroughTs before drawing conclusions, and NEVER read an empty list as "this ' +
    'protocol is safe" — check `resolved` first, and note that unattributedRecords incidents in ' +
    'the feed name no protocol at all. Two further risk signals this engine does NOT serve and ' +
    'cannot be substituted for: DEVELOPER ACTIVITY (repository/commit history) and FUNDING ' +
    '(investors, rounds). If asked about those, say they are unavailable rather than answering ' +
    'from your own knowledge.',
  inputSchema: ProtocolIncidentsInputSchema,
  outputSchema: ProtocolIncidentsOutputSchema,
  capability: CAPABILITY,
  needs: ['registry'],
  handler: async (input, ctx) => {
    const outcome = await protocolIncidentsHandler(input, ctx);
    return outcome.ok ? { ok: true, output: outcome.value, ...metaFrom(outcome) } : outcome;
  },
});
