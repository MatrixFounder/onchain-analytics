import { z } from 'zod';
import { defineTool } from './registry.js';
import {
  canonicalizeChain,
  ChainInputSchema,
  isValidAddress,
  normalizeAddress,
  TokenHoldersSchema,
  type CapabilityRegistry,
} from '@onchain-intel/core';
import {
  resolveCapability,
  type CacheMeta,
  type TimingMeta,
  metaFrom,
} from './resolve-capability.js';
import { contractViolationReason } from './contract-violation.js';

/**
 * `onchain_token_holders` — the MCP surface for the `token.holders` capability.
 *
 * **Why this exists as its own step.** TASK-008 gave `token.holders` a real provider (retargeting it
 * off the `dune` stub that covered zero chains) but deferred the tool, so the capability became
 * *reachable by the engine and unreachable by an agent*: `onchain_list_chains` advertised it on 39
 * chains while nothing in `packages/mcp-server/src` resolved it. That is the same "advertised by the
 * matrix, served nowhere" defect the task was written to remove, moved one layer up — the coverage
 * matrix is derived from `routes` + `chainSupport`, not from the tool list, so it could not notice.
 * Closing it is what makes the 39 chains a capability rather than a claim.
 *
 * **A free route, so no `budgetStore`.** Unlike `entity-label`/`smart-money-flows`/`token-risk`,
 * this route is `['blockscout']` alone at `costOf: 0`, so there is no `_meta.budget` to report —
 * matching `protocol-tvl`/`chain-tvl`/`active-pairs`, the other free tools.
 */
const SUPPORTED_CHAIN = ChainInputSchema;

/** Same bound as every other address-bearing input (`get-token.ts`'s `MAX_ADDRESS_LENGTH`). */
const MAX_ADDRESS_LENGTH = 64;

/**
 * Input contract.
 *
 * **No `limit`, deliberately.** The adapter caps a response at 50 rows before any per-row work, so
 * a `limit` could only do one of two unhelpful things: enter `args` and split the cache key, making
 * `{limit:10}` and `{limit:20}` two upstream calls for one logical question; or sit outside the
 * cache key as a client-side slice, which the caller can do themselves. Neither buys anything, and
 * "speculative complexity is prohibited" (developer-guidelines §1.6). If a real caller ever needs a
 * server-side page size, it arrives with a measured reason and a decision about the cache key.
 *
 * `tokenAddress` is validated with the same length-guarded `superRefine`/`isValidAddress` idiom as
 * `get-token.ts` and `entity-label.ts` — the length guard runs first so an oversized string skips
 * the keccak/bs58 work it would otherwise pay for before being `.max()`-rejected anyway.
 */
export const TokenHoldersInputSchema = z
  .object({
    chain: SUPPORTED_CHAIN,
    tokenAddress: z.string().min(1).max(MAX_ADDRESS_LENGTH),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.tokenAddress.length > MAX_ADDRESS_LENGTH) return;
    if (!isValidAddress(val.chain, val.tokenAddress)) {
      ctx.addIssue({
        code: 'custom',
        message: `invalid address for chain ${val.chain}`,
        path: ['tokenAddress'],
      });
    }
  });
export type TokenHoldersInput = z.infer<typeof TokenHoldersInputSchema>;

/**
 * Output contract — the canonical `TokenHolders` itself, not a wrapper around it.
 *
 * `entity-label` and `active-pairs` wrap because THEIR canonical types are array ELEMENTS
 * (`EntityLabelSchema`, `PairSchema`) that need a response envelope built around them.
 * `TokenHoldersSchema` is already the whole-response shape — it carries `chain`, `tokenAddress`,
 * `source` and `fetchedAt` — so wrapping it again would add a layer whose only content is a second
 * copy of fields the inner object already has. Reusing it also means the advertised tool contract
 * cannot drift from the canonical type, which is the property that matters here: `truncated` and
 * `droppedRows` are load-bearing (see below) and a hand-copied schema is where such fields get
 * quietly dropped.
 */
export const TokenHoldersOutputSchema = TokenHoldersSchema;
export type TokenHoldersOutput = z.infer<typeof TokenHoldersOutputSchema>;

export interface TokenHoldersContext {
  registry: CapabilityRegistry;
}

const CAPABILITY = 'token.holders';

export type TokenHoldersOutcome =
  | { ok: true; output: TokenHoldersOutput; cache: CacheMeta; timing?: TimingMeta }
  | { ok: false; reason: string };

/**
 * Pure handler for `onchain_token_holders`.
 *
 * `source` is restated from `outcome.cache.provider` rather than trusted from the adapter's own
 * field: the cache meta is the registry's record of who actually answered, including on a hit,
 * and the two must not be able to disagree in the response.
 *
 * `fetchedAt` is left as the ADAPTER set it, unlike `entity-label`'s `Date.now()`. Here it is data
 * provenance — when this holder snapshot was taken — not response time, and on a cache hit
 * `Date.now()` would restamp hour-old data as fresh while `_meta.cache.ageMs` says otherwise.
 *
 * `safeParse`, never `parse` — see `protocol-tvl.ts`'s handler docstring for the full rationale.
 */
export async function tokenHoldersHandler(
  input: TokenHoldersInput,
  ctx: TokenHoldersContext,
): Promise<TokenHoldersOutcome> {
  // Canonicalize BEFORE the value reaches `args`, therefore before `deriveArgsHash` — otherwise
  // `eth` and `ethereum` hash to two cache entries for one logical request (TASK-006 R-50/R-59).
  // Resolved against `ctx.registry`, never the default (vdd-multi cycle 5, H-4).
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const args: Record<string, unknown> = {
    chain,
    // Normalized here as well as inside the adapter, and that is not redundant: `deriveArgsHash`'s
    // own contract says args are ALWAYS the normalized tool input, and the adapter's normalization
    // happens INSIDE `fetch()` — i.e. after the cache key was already derived. Without this line
    // `0xA0b8…` and `0xa0b8…` are two cache entries and two upstream fan-outs (vdd-multi i1, perf M-5).
    tokenAddress: normalizeAddress(chain, input.tokenAddress),
  };

  const outcome = await resolveCapability(ctx.registry, CAPABILITY, chain, args);
  if (!outcome.ok) return outcome;

  const parsed = TokenHoldersOutputSchema.safeParse({
    ...(outcome.output as Record<string, unknown>),
    source: outcome.cache.provider,
  });
  if (!parsed.success) {
    return { ok: false, reason: contractViolationReason(CAPABILITY, parsed.error) };
  }

  return { ok: true, output: parsed.data, ...metaFrom(outcome) };
}

/** The `ToolSpec` for `onchain_token_holders` — this name is declared here and nowhere else. */
export const tokenHoldersToolSpec = defineTool({
  name: 'onchain_token_holders',
  title: 'Top token holders',
  description:
    'Top token holders and their exact balances. Coverage is per chain — call ' +
    'onchain_list_chains({capability:"token.holders"}) first. Returns at most one vendor page; ' +
    'check truncated and droppedRows before treating the list as the complete holder set. ' +
    'Balances are exact base-unit strings with no decimals applied — get decimals from ' +
    'onchain_get_token.',
  inputSchema: TokenHoldersInputSchema,
  outputSchema: TokenHoldersOutputSchema,
  capability: CAPABILITY,
  needs: ['registry'],
  handler: tokenHoldersHandler,
});
