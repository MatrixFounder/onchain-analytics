import { z } from 'zod';
import { defineTool } from './registry.js';
import {
  canonicalizeChain,
  ChainInputSchema,
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
/**
 * TASK-006 (task 006-6, R-50): `chain` is an OPEN string resolved against the chain registry,
 * replacing the `z.enum(['ethereum','solana'])` literal that this file (and six others) carried.
 * The closed enum for all 458 chains measured ~8.7k tokens of schema across the chain-taking
 * tools — paid on EVERY request to the model. Correctness moved into the runtime resolve, which
 * fails with a "did you mean" list and zero network calls (owner decision 2026-07-26).
 */
const SUPPORTED_CHAIN = ChainInputSchema;

const MAX_ADDRESS_LENGTH = 64;

export const TokenRiskInputSchema = z
  .object({
    chain: SUPPORTED_CHAIN,
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
  // TASK-006 (task 006-6, R-50/R-59): resolve the alias to its canonical slug HERE, before the
  // value reaches `args` and therefore before `deriveArgsHash` — otherwise `eth` and `ethereum`
  // would hash to two different cache entries for one logical request, which on a paid route is
  // two charges (data-model.md §4.2.2).
  //
  // Resolved against `ctx.registry`, never the default — see `get-token.ts` (vdd-multi cycle 5,
  // H-4); the paid-route note in `smart-money-flows.ts` applies here identically.
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const tokenAddress = normalizeAddress(chain, input.tokenAddress);
  const outcome = await resolveCapability(ctx.registry, CAPABILITY, chain, {
    chain,
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
export const tokenRiskToolSpec = defineTool({
  name: 'onchain_token_risk',
  title: 'Token risk and reward indicators',
  description:
    'Risk/reward indicators for a token. Coverage is per chain — call ' +
    'onchain_list_chains({capability:"token.risk"}) first (Nansen-backed, paid).',
  inputSchema: TokenRiskInputSchema,
  outputSchema: TokenRiskOutputSchema,
  capability: 'token.risk',
  needs: ['registry', 'budgetStore'],
  handler: tokenRiskHandler,
});
