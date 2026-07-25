import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  isValidAddress,
  normalizeAddress,
  TokenRiskScoreSchema,
  type BudgetStore,
  type CapabilityRegistry,
  type TokenRiskScore,
} from '@onchain-intel/core';
import { budgetMeta, type BudgetMeta } from './budget-meta.js';
import { resolveCapability, type CacheMeta } from './resolve-capability.js';

/**
 * Input contract for `onchain_token_risk` (interfaces.md §5.1.2, R-43): same `chain` narrowing +
 * `.max(MAX_ADDRESS_LENGTH)`-bounded, length-guarded `superRefine`/`isValidAddress` idiom as
 * `get-token.ts`/`smart-money-flows.ts` — reused verbatim, not reinvented.
 */
const MAX_ADDRESS_LENGTH = 64;

export const TokenRiskInputSchema = z
  .object({
    chain: z.enum(['ethereum', 'solana']),
    tokenAddress: z.string().min(1).max(MAX_ADDRESS_LENGTH),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.tokenAddress.length > MAX_ADDRESS_LENGTH) {
      return;
    }
    if (!isValidAddress(val.chain, val.tokenAddress)) {
      ctx.addIssue({
        code: 'custom',
        message: `invalid address for chain ${val.chain}`,
        path: ['tokenAddress'],
      });
    }
  });
export type TokenRiskInput = z.infer<typeof TokenRiskInputSchema>;

/** Output is the canonical `TokenRiskScore` type re-exported from `@onchain-intel/core` verbatim. */
export const TokenRiskOutputSchema = TokenRiskScoreSchema;
export type TokenRiskOutput = TokenRiskScore;

export interface TokenRiskContext {
  registry: CapabilityRegistry;
  /** Injectable the SAME way as `registry` — read-only `_meta.budget` visibility only (see
   * `smart-money-flows.ts`'s `SmartMoneyFlowsContext` docstring for the full rationale). */
  budgetStore?: BudgetStore;
}

const CAPABILITY = 'token.risk';

export type TokenRiskOutcome =
  | { ok: true; output: TokenRiskOutput; cache: CacheMeta; budget?: BudgetMeta }
  | { ok: false; reason: string };

/**
 * Pure handler for `onchain_token_risk` (R-43 — Nansen is the sole source; `token.risk`'s only
 * registered route/adapter, `providers.config.ts` — this file itself is grepped in acceptance for
 * ANY mention of the OTHER, four-letter-named token-holders provider, so that other name is
 * deliberately never spelled out anywhere in this file, comments included).
 *
 * **Output validated with `safeParse`, never `parse`** — see `smart-money-flows.ts`'s own
 * `smartMoneyFlowsHandler` docstring for the full rationale (task 005-6 reviewer note: the handler
 * is a pure `{ok:true,...}|{ok:false,reason}` function, never throws).
 *
 * `_meta.budget` via `budgetMeta()` ONLY when `outcome.cache.status === 'miss'` (interfaces.md
 * §5.1.2) — see `smart-money-flows.ts` for the full rationale.
 */
export async function tokenRiskHandler(
  input: TokenRiskInput,
  ctx: TokenRiskContext,
): Promise<TokenRiskOutcome> {
  const tokenAddress = normalizeAddress(input.chain, input.tokenAddress);
  const outcome = await resolveCapability(ctx.registry, CAPABILITY, input.chain, {
    chain: input.chain,
    tokenAddress,
  });
  if (!outcome.ok) return outcome;

  const parsed = TokenRiskOutputSchema.safeParse(outcome.output);
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

/** Registers `onchain_token_risk` — exactly this name (R-43) — on `server`. Same wiring pattern
 * as `smart-money-flows.ts`'s `registerSmartMoneyFlowsTool`. */
export function registerTokenRiskTool(server: McpServer, ctx: TokenRiskContext): void {
  server.registerTool(
    'onchain_token_risk',
    {
      description:
        'Risk/reward indicators for a token on ethereum or solana (Nansen-backed, paid).',
      inputSchema: TokenRiskInputSchema,
      outputSchema: TokenRiskOutputSchema,
    },
    async (input) => {
      const outcome = await tokenRiskHandler(input, ctx);
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
