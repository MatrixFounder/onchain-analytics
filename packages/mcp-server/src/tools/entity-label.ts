import { z } from 'zod';
import { defineTool } from './registry.js';
import {
  canonicalizeChain,
  ChainInputSchema,
  EntityLabelSchema,
  isValidAddress,
  normalizeAddress,
  type BudgetStore,
  type CapabilityRegistry,
} from '@onchain-intel/core';
import { budgetMeta, type BudgetMeta } from './budget-meta.js';
import {
  resolveCapability,
  type CacheMeta,
  type TimingMeta,
  metaFrom,
} from './resolve-capability.js';
import { contractViolation } from './contract-violation.js';

/** The two supported networks (same narrowing as every other M1/M2 tool — see `get-token.ts`'s
 * docstring). Declared once, reused for both the input and output `chain` fields below. */
/**
 * TASK-006 (task 006-6, R-50): `chain` is an OPEN string resolved against the chain registry,
 * replacing the `z.enum(['ethereum','solana'])` literal that this file (and six others) carried.
 * The closed enum for all 458 chains measured ~8.7k tokens of schema across the chain-taking
 * tools — paid on EVERY request to the model. Correctness moved into the runtime resolve, which
 * fails with a "did you mean" list and zero network calls (owner decision 2026-07-26).
 */
const SUPPORTED_CHAIN = ChainInputSchema;

/** No real `query` (name/symbol/address search text) is anywhere near this long (interfaces.md
 * §5.1.2's own literal bound). */
const MAX_QUERY_LENGTH = 200;
/** Same bound as every other address-bearing M2/M1 input (`get-token.ts`'s `MAX_ADDRESS_LENGTH`). */
const MAX_ADDRESS_LENGTH = 64;

/**
 * Input contract for `onchain_entity_label` (interfaces.md §5.1.2, R-42) — the ONLY one of the 7
 * MCP tools with a COMPOUND `superRefine` (task 005-6 reviewer note):
 * 1. At least one of `query`/`tokenAddress` is required (otherwise there is nothing to search).
 * 2. `exhaustive: true` REQUIRES `tokenAddress` (the expensive `/profiler/address/labels`
 *    escalation is always address-scoped, never a free-text search).
 * 3. When `tokenAddress` IS present, it's validated with the same length-guarded
 *    `superRefine`/`isValidAddress` idiom as `get-token.ts` (reused verbatim) — the length guard
 *    runs regardless of (1)/(2) above, since a too-long `tokenAddress` is still "present" for
 *    those two structural checks, just also independently `.max()`-rejected.
 *
 * `exhaustive` defaults to `false` via zod's own `.default(false)` (not a value materialized in
 * the handler, unlike `active-pairs.ts`'s `limit`) — this keeps the CACHE-KEY args always carrying an
 * explicit `exhaustive` boolean regardless of whether the caller passed it, avoiding the exact
 * "omitted vs. explicit-default" cache-key split `active-pairs.ts`'s own post-M1 polish fix 1
 * document ed (developer-guidelines §1.6 implementation choice).
 */
export const EntityLabelInputSchema = z
  .object({
    chain: SUPPORTED_CHAIN,
    query: z.string().min(1).max(MAX_QUERY_LENGTH).optional(),
    tokenAddress: z.string().min(1).max(MAX_ADDRESS_LENGTH).optional(),
    exhaustive: z.boolean().default(false),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.query === undefined && val.tokenAddress === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'at least one of query or tokenAddress is required',
        path: ['query'],
      });
    }
    if (val.exhaustive && val.tokenAddress === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'exhaustive: true requires tokenAddress',
        path: ['tokenAddress'],
      });
    }
    if (val.tokenAddress !== undefined) {
      if (val.tokenAddress.length > MAX_ADDRESS_LENGTH) {
        // Already reported by `.max()` above — skip the expensive isValidAddress/bs58.decode work.
        return;
      }
      if (!isValidAddress(val.chain, val.tokenAddress)) {
        ctx.addIssue({
          code: 'custom',
          message: `invalid address for chain ${val.chain}`,
          path: ['tokenAddress'],
        });
      }
    }
  });
export type EntityLabelInput = z.infer<typeof EntityLabelInputSchema>;

/**
 * Output shape copied literally from interfaces.md §5.1.2: `{ chain, entities: EntityLabel[],
 * source, fetchedAt }` — mirrors `active-pairs.ts`'s own `ActivePairsOutputSchema` wrapper precedent (a
 * tool-contract-level shape wrapping a canonical array-element type, `EntityLabelSchema`).
 */
export const EntityLabelOutputSchema = z
  .object({
    chain: SUPPORTED_CHAIN,
    // **Bounded in aggregate, not only per field** (vdd-multi cycle 6, security L-5). The
    // per-field caps compose badly: the default tier can emit up to 200 token rows + 200 entity
    // rows + 200 holder rows, and each entry allows `tags`/`labels` of 64 × 256 chars — a product
    // in the megabytes, in one `structuredContent`, one JSON-RPC frame and one SQLite row, on a
    // single-threaded stdio server. Every individual cap was defended in a comment; the product of
    // them was not.
    entities: z.array(EntityLabelSchema).max(600),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type EntityLabelOutput = z.infer<typeof EntityLabelOutputSchema>;

export interface EntityLabelContext {
  registry: CapabilityRegistry;
  /** Injectable the SAME way as `registry` — read-only `_meta.budget` visibility only. */
  budgetStore?: BudgetStore;
}

const CAPABILITY = 'entity.labels';

export type EntityLabelOutcome =
  | {
      ok: true;
      output: EntityLabelOutput;
      cache: CacheMeta;
      timing?: TimingMeta;
      budget?: BudgetMeta;
    }
  | { ok: false; reason: string; refusalClass?: string };

/**
 * Pure handler for `onchain_entity_label`. Builds `args = {chain, exhaustive, query?,
 * tokenAddress?}` — only the optional fields the caller actually supplied are included (mirrors
 * `nansen`'s own `extractEntityLabelArgs()` expectations, `@onchain-intel/core`'s
 * `adapters/nansen/index.ts`) — `tokenAddress`, when present, is re-normalized first (same
 * `normalizeAddress`-before-cache-key convention as `get-token.ts`'s `address`).
 *
 * Output is validated exactly ONCE, as part of the single `EntityLabelOutputSchema.safeParse(...)`
 * below (its `entities` field is `z.array(EntityLabelSchema)`) — mirrors `active-pairs.ts`'s own
 * de-duplicated-validation precedent (adversarial cycle 1 fix I). `safeParse`, never `parse` — see
 * `smart-money-flows.ts`'s own `smartMoneyFlowsHandler` docstring for the full rationale.
 *
 * `_meta.budget` via `budgetMeta()` on every successful resolution, present exactly when the
 * traversal ENTERED a paid adapter — see `smart-money-flows.ts`. This capability is the one where
 * the difference is observable: `blockscout` first, `nansen` behind it, and the H-1 return hands back
 * blockscout's answer — cached or fresh — after nansen has spent.
 */
export async function entityLabelHandler(
  input: EntityLabelInput,
  ctx: EntityLabelContext,
): Promise<EntityLabelOutcome> {
  // TASK-006 (task 006-6, R-50/R-59): resolve the alias to its canonical slug HERE, before the
  // value reaches `args` and therefore before `deriveArgsHash` — otherwise `eth` and `ethereum`
  // would hash to two different cache entries for one logical request, which on a paid route is
  // two charges (data-model.md §4.2.2).
  //
  // Resolved against `ctx.registry`, never the default — see `get-token.ts` (vdd-multi cycle 5,
  // H-4); the paid-route note in `smart-money-flows.ts` applies here identically.
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const args: Record<string, unknown> = { chain, exhaustive: input.exhaustive };
  if (input.query !== undefined) {
    args['query'] = input.query;
  }
  if (input.tokenAddress !== undefined) {
    args['tokenAddress'] = normalizeAddress(chain, input.tokenAddress);
  }

  const outcome = await resolveCapability(ctx.registry, CAPABILITY, chain, args);
  if (!outcome.ok) return outcome;

  const parsed = EntityLabelOutputSchema.safeParse({
    chain,
    entities: outcome.output,
    source: outcome.cache.provider,
    fetchedAt: Date.now(),
  });
  if (!parsed.success) {
    return contractViolation(CAPABILITY, parsed.error);
  }

  // Gated on the TRAVERSAL, never on `outcome.cache.status` (adversarial cycle 3, F-A). A `'hit'`
  // is not evidence that nothing was spent: the registry's H-1 return can hand back an EARLIER
  // adapter's cache hit after the walk entered and paid the source behind it, and a `'miss'` gate
  // dropped `_meta.budget` on exactly that route. `budgetMeta` reports nothing when nobody was
  // entered, which is what a pure hit is — so the branch has no work left to do.
  const budget = await budgetMeta(ctx.budgetStore, Date.now, outcome.attempted);
  return { ok: true, output: parsed.data, ...metaFrom(outcome), budget };
}

/** The `ToolSpec` for `onchain_entity_label` — this name is declared here and nowhere else (R-42). */
export const entityLabelToolSpec = defineTool({
  name: 'onchain_entity_label',
  title: 'Entity and address labels',
  description:
    'Entity/address labels for a search query and/or token address. Coverage is per chain — ' +
    'call onchain_list_chains({capability:"entity.labels"}) first (Nansen-backed, paid; ' +
    'the opt-in exhaustive escalation costs more and is served on fewer chains).',
  inputSchema: EntityLabelInputSchema,
  outputSchema: EntityLabelOutputSchema,
  capability: CAPABILITY,
  needs: ['registry', 'budgetStore', 'principal'],
  handler: entityLabelHandler,
});
