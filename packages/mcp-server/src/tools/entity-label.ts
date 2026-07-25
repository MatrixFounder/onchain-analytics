import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  EntityLabelSchema,
  isValidAddress,
  normalizeAddress,
  type BudgetStore,
  type CapabilityRegistry,
} from '@onchain-intel/core';
import { budgetMeta, type BudgetMeta } from './budget-meta.js';
import { resolveCapability, type CacheMeta } from './resolve-capability.js';

/** The two supported networks (same narrowing as every other M1/M2 tool — see `get-token.ts`'s
 * docstring). Declared once, reused for both the input and output `chain` fields below. */
const SUPPORTED_CHAIN = z.enum(['ethereum', 'solana']);

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
 * the handler, unlike `new-pairs.ts`'s `limit`) — this keeps the CACHE-KEY args always carrying an
 * explicit `exhaustive` boolean regardless of whether the caller passed it, avoiding the exact
 * "omitted vs. explicit-default" cache-key split `new-pairs.ts`'s own post-M1 polish fix 1
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
 * source, fetchedAt }` — mirrors `new-pairs.ts`'s own `NewPairsOutputSchema` wrapper precedent (a
 * tool-contract-level shape wrapping a canonical array-element type, `EntityLabelSchema`).
 */
export const EntityLabelOutputSchema = z
  .object({
    chain: SUPPORTED_CHAIN,
    entities: z.array(EntityLabelSchema),
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
  | { ok: true; output: EntityLabelOutput; cache: CacheMeta; budget?: BudgetMeta }
  | { ok: false; reason: string };

/**
 * Pure handler for `onchain_entity_label`. Builds `args = {chain, exhaustive, query?,
 * tokenAddress?}` — only the optional fields the caller actually supplied are included (mirrors
 * `nansen`'s own `extractEntityLabelArgs()` expectations, `@onchain-intel/core`'s
 * `adapters/nansen/index.ts`) — `tokenAddress`, when present, is re-normalized first (same
 * `normalizeAddress`-before-cache-key convention as `get-token.ts`'s `address`).
 *
 * Output is validated exactly ONCE, as part of the single `EntityLabelOutputSchema.safeParse(...)`
 * below (its `entities` field is `z.array(EntityLabelSchema)`) — mirrors `new-pairs.ts`'s own
 * de-duplicated-validation precedent (adversarial cycle 1 fix I). `safeParse`, never `parse` — see
 * `smart-money-flows.ts`'s own `smartMoneyFlowsHandler` docstring for the full rationale.
 *
 * `_meta.budget` via `budgetMeta()` ONLY when `outcome.cache.status === 'miss'`.
 */
export async function entityLabelHandler(
  input: EntityLabelInput,
  ctx: EntityLabelContext,
): Promise<EntityLabelOutcome> {
  const args: Record<string, unknown> = { chain: input.chain, exhaustive: input.exhaustive };
  if (input.query !== undefined) {
    args['query'] = input.query;
  }
  if (input.tokenAddress !== undefined) {
    args['tokenAddress'] = normalizeAddress(input.chain, input.tokenAddress);
  }

  const outcome = await resolveCapability(ctx.registry, CAPABILITY, input.chain, args);
  if (!outcome.ok) return outcome;

  const parsed = EntityLabelOutputSchema.safeParse({
    chain: input.chain,
    entities: outcome.output,
    source: outcome.cache.provider,
    fetchedAt: Date.now(),
  });
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const path = firstIssue && firstIssue.path.length > 0 ? firstIssue.path.join('.') : '(root)';
    const message = firstIssue?.message ?? 'invalid output shape';
    return {
      ok: false,
      reason: `provider returned data violating the tool contract: ${path}: ${message}`,
    };
  }

  const budget =
    outcome.cache.status === 'miss' ? await budgetMeta(ctx.budgetStore, Date.now) : undefined;
  return { ok: true, output: parsed.data, cache: outcome.cache, budget };
}

/** Registers `onchain_entity_label` — exactly this name (R-42) — on `server`. Same wiring pattern
 * as `smart-money-flows.ts`'s `registerSmartMoneyFlowsTool`. */
export function registerEntityLabelTool(server: McpServer, ctx: EntityLabelContext): void {
  server.registerTool(
    'onchain_entity_label',
    {
      description:
        'Entity/address labels for a search query and/or token address on ethereum or solana ' +
        '(Nansen-backed, paid; exhaustive escalation is opt-in).',
      inputSchema: EntityLabelInputSchema,
      outputSchema: EntityLabelOutputSchema,
    },
    async (input) => {
      const outcome = await entityLabelHandler(input, ctx);
      if (!outcome.ok) {
        return { isError: true, content: [{ type: 'text', text: outcome.reason }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(outcome.output) }],
        structuredContent: outcome.output,
        _meta: { cache: outcome.cache, ...(outcome.budget ? { budget: outcome.budget } : {}) },
      };
    },
  );
}
