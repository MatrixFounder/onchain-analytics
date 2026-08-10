import { canonicalizeChain, ChainInputSchema } from '@onchain-intel/core';
import { defineTool } from './registry.js';
import { z } from 'zod';
import type { CapabilityRegistry } from '@onchain-intel/core';
import {
  resolveCapability,
  type CacheMeta,
  type TimingMeta,
  metaFrom,
} from './resolve-capability.js';
import { contractViolationReason } from './contract-violation.js';

/** The two supported networks (task 003-7 reviewer note, Major-2 — see `get-token.ts`'s
 * docstring for why the full `ChainSchema` isn't used here) — declared once and reused for both
 * the input and output `chain` fields below, so this file states the narrowing exactly once. */
/**
 * TASK-006 (task 006-6, R-50): `chain` is an OPEN string resolved against the chain registry,
 * replacing the `z.enum(['ethereum','solana'])` literal that this file (and six others) carried.
 * The closed enum for all 458 chains measured ~8.7k tokens of schema across the chain-taking
 * tools — paid on EVERY request to the model. Correctness moved into the runtime resolve, which
 * fails with a "did you mean" list and zero network calls (owner decision 2026-07-26).
 */
const SUPPORTED_CHAIN = ChainInputSchema;

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
 *
 * **Widened by L-9**, which is a contract change and not a cosmetic one: `tvlUsd` became
 * `.nullable()`, and four fields joined it. The defect was that "this protocol is not on this chain"
 * — a correct answer whose value is zero — arrived as `capability unavailable`, the same shape as a
 * DeFiLlama outage or a renamed slug, so a caller could not tell a fact about the world from a fault
 * in the engine. `deployed` splits those, `null` marks the third state (deployed, but the vendor
 * publishes only staking/borrowed buckets for this chain, so the figure is unknown rather than
 * zero), and `deployments` makes the chain-by-chain sweep unnecessary — that sweep was undecidable,
 * because a miss and a failure looked alike. Every `.describe()` below is paid on every request, and
 * is there because the model is the consumer that has to tell these states apart.
 */
export const ProtocolTvlOutputSchema = z
  .object({
    protocol: z.string(),
    chain: SUPPORTED_CHAIN,
    tvlUsd: z
      .number()
      .nonnegative()
      .nullable()
      .describe(
        'Current TVL on `chain`. 0 with deployed=false means the protocol is not on this chain ' +
          '(a true answer, not an error). null with deployed=true means it IS on this chain but ' +
          'the provider publishes no plain-TVL figure there — only staking/borrowed/pool2 ' +
          'buckets — so the value is unknown rather than zero.',
      ),
    totalTvlUsd: z.number().nonnegative(),
    deployed: z
      .boolean()
      .describe(
        'Whether the protocol is deployed on `chain` at all. false is an answer, not a failure.',
      ),
    deployments: z
      .array(z.object({ chain: z.string(), tvlUsd: z.number().nonnegative().nullable() }).strict())
      .describe(
        'Every chain the protocol is deployed on, TVL-descending. Answers "where is this ' +
          'protocol" in one call — do not sweep chain by chain.',
      ),
    unmappedDeployments: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Deployment chains this engine has no registry entry for, so they are absent from ' +
          '`deployments`. 0 means the list is complete.',
      ),
    aggregatedFrom: z
      .array(z.string())
      .describe(
        'Non-empty when `protocolSlug` names a family rather than one protocol (e.g. "uniswap"): ' +
          'the slugs whose TVL was summed. Empty when a single protocol answered.',
      ),
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
  | { ok: true; output: ProtocolTvlOutput; cache: CacheMeta; timing?: TimingMeta }
  | { ok: false; reason: string };

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
  // TASK-006 (task 006-6, R-50/R-59): resolve the alias to its canonical slug HERE, before the
  // value reaches `args` and therefore before `deriveArgsHash` — otherwise `eth` and `ethereum`
  // would hash to two different cache entries for one logical request, which on a paid route is
  // two charges (data-model.md §4.2.2).
  //
  // Resolved against `ctx.registry`, never the default — see `get-token.ts` (vdd-multi cycle 5, H-4).
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const outcome = await resolveCapability(ctx.registry, CAPABILITY, chain, {
    chain,
    protocolSlug: input.protocolSlug,
  });
  if (!outcome.ok) return outcome;

  const parsed = ProtocolTvlOutputSchema.safeParse(outcome.output);
  if (!parsed.success) {
    return { ok: false, reason: contractViolationReason(CAPABILITY, parsed.error) };
  }
  return { ok: true, output: parsed.data, ...metaFrom(outcome) };
}

/** The `ToolSpec` for `onchain_protocol_tvl` — this name is declared here and nowhere else (R-19).
 * Registration happens in `registry.ts`; see `get-token.ts`'s spec docstring for the shared
 * `isError`/`_meta.cache` wiring rationale. */
export const protocolTvlToolSpec = defineTool({
  name: 'onchain_protocol_tvl',
  title: 'Protocol TVL',
  description:
    'Protocol TVL (chain-scoped and total) for a DeFiLlama protocol slug, plus the full list of ' +
    'chains the protocol is deployed on. A protocol that is not on the requested chain answers ' +
    'deployed=false with tvlUsd=0 — that is the answer, not an error. Use onchain_chain_tvl for a ' +
    'whole chain; onchain_list_chains to find the `chain` value.',
  inputSchema: ProtocolTvlInputSchema,
  outputSchema: ProtocolTvlOutputSchema,
  capability: CAPABILITY,
  needs: ['registry'],
  handler: protocolTvlHandler,
});
