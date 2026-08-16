import { z } from 'zod';
import { defineTool } from './registry.js';
import {
  canonicalizeChain,
  ChainInputSchema,
  isValidAddress,
  normalizeAddress,
  SmartMoneyFlowSchema,
  type BudgetStore,
  type CapabilityResolver,
  type SmartMoneyFlow,
} from '@onchain-intel/core';
import { budgetMeta, type BudgetMeta } from './budget-meta.js';
import {
  resolveCapability,
  type CacheMeta,
  type TimingMeta,
  metaFrom,
} from './resolve-capability.js';
import { contractViolation } from './contract-violation.js';

/**
 * Input contract for `onchain_smart_money_flows` (interfaces.md §5.1.2, R-41): `chain` narrowed
 * to the same two networks every M1/M2 tool uses (OQ-3) — see `get-token.ts`'s own docstring for
 * the full rationale. `tokenAddress` reuses the exact `.max(MAX_ADDRESS_LENGTH)` +
 * length-guarded `superRefine`/`isValidAddress` idiom from `get-token.ts` VERBATIM (task 005-6
 * reviewer note: "переиспользовать M1-паттерн из get-token.ts, не изобретать заново").
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

export const SmartMoneyFlowsInputSchema = z
  .object({
    chain: SUPPORTED_CHAIN,
    tokenAddress: z.string().min(1).max(MAX_ADDRESS_LENGTH),
  })
  .strict()
  .superRefine((val, ctx) => {
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
  });
export type SmartMoneyFlowsInput = z.infer<typeof SmartMoneyFlowsInputSchema>;

/** Output is the canonical `SmartMoneyFlow` type re-exported from `@onchain-intel/core` verbatim
 * (same "canonical types from @onchain-intel/core" convention as `get-token.ts`'s `TokenSchema`). */
export const SmartMoneyFlowsOutputSchema = SmartMoneyFlowSchema;
export type SmartMoneyFlowsOutput = SmartMoneyFlow;

export interface SmartMoneyFlowsContext {
  registry: CapabilityResolver;
  /** Injectable the SAME way as `registry` (interfaces.md §5.1.2/§5.2) — used ONLY for read-only
   * `_meta.budget` visibility; the actual budget GATE already ran inside `nansen.fetch()` (that
   * adapter's OWN, separately-injected `budgetStore`, wired at `index.ts`'s construction site). */
  budgetStore?: BudgetStore;
}

const CAPABILITY = 'smart-money.flows';

export type SmartMoneyFlowsOutcome =
  | {
      ok: true;
      output: SmartMoneyFlowsOutput;
      cache: CacheMeta;
      timing?: TimingMeta;
      budget?: BudgetMeta;
    }
  | { ok: false; reason: string; refusalClass?: string };

/**
 * Pure handler for `onchain_smart_money_flows` — mirrors `get-token.ts`'s `getTokenHandler` split
 * (unit-testable without a transport). Re-normalizes `input.tokenAddress` before it becomes part
 * of the cache-key `args` (same convention as `get-token.ts`'s own `address`).
 *
 * **Output validated with `safeParse`, never `parse` (task 005-6 reviewer note — the handler is a
 * pure `{ok:true,...}|{ok:false,reason}` function, never throws):** unlike `get-token.ts`
 * (task 003-7, `.parse()`), this task's own Phase 2 instruction is explicit — a provider returning
 * data violating the tool's own contract degrades to `{ok:false, reason}`, mirroring
 * `protocol-tvl.ts`'s established `safeParse` precedent (adversarial cycle 2, finding 1a).
 *
 * `_meta.budget` (interfaces.md §5.1.2): read via `budgetMeta()` on every successful resolution, and
 * present in the response exactly when the traversal ENTERED a paid adapter. It used to be gated on
 * `outcome.cache.status === 'miss'`, on the reasoning that a `'hit'` means the gate/`costOf()`/network
 * never ran — true of the ANSWERING adapter, and not of the walk: the registry's H-1 return can hand
 * back an earlier adapter's cache hit after entering and paying the source behind it (adversarial
 * cycle 3, F-A). The condition now lives in one place, `budgetMeta()`, which reports nothing when the
 * walk entered nobody — the pure-hit case the old gate was aiming at.
 */
export async function smartMoneyFlowsHandler(
  input: SmartMoneyFlowsInput,
  ctx: SmartMoneyFlowsContext,
): Promise<SmartMoneyFlowsOutcome> {
  // TASK-006 (task 006-6, R-50/R-59): resolve the alias to its canonical slug HERE, before the
  // value reaches `args` and therefore before `deriveArgsHash` — otherwise `eth` and `ethereum`
  // would hash to two different cache entries for one logical request, which on a paid route is
  // two charges (data-model.md §4.2.2).
  //
  // Resolved against `ctx.registry`, never the default — see `get-token.ts` (vdd-multi cycle 5,
  // H-4). It matters most on THIS route: it is paid, so a per-call registry rebuild sat on the
  // cache-hit path that exists precisely to avoid paying twice.
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const tokenAddress = normalizeAddress(chain, input.tokenAddress);
  const outcome = await resolveCapability(ctx.registry, CAPABILITY, chain, {
    chain,
    tokenAddress,
  });
  if (!outcome.ok) return outcome;

  const parsed = SmartMoneyFlowsOutputSchema.safeParse(outcome.output);
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

/**
 * The `ToolSpec` for `onchain_smart_money_flows` — this name is declared here and nowhere else (R-41). Same wiring
 * pattern as `get-token.ts`'s `defineTool` (`isError`/`_meta.cache`), plus `_meta.budget`
 * as a sibling key when the handler returned one (Phase 2).
 */
export const smartMoneyFlowsToolSpec = defineTool({
  name: 'onchain_smart_money_flows',
  title: 'Smart-money flows for a token',
  description:
    'Smart-money net-flow (1h/24h/7d/30d) and top holders for a token. ' +
    'Coverage is per chain — call onchain_list_chains({capability:"smart-money.flows"}) ' +
    'first (Nansen-backed, paid).',
  inputSchema: SmartMoneyFlowsInputSchema,
  outputSchema: SmartMoneyFlowsOutputSchema,
  capability: CAPABILITY,
  needs: ['registry', 'budgetStore', 'principal'],
  handler: smartMoneyFlowsHandler,
});
