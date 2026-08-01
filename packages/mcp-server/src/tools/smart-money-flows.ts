import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  canonicalizeChain,
  ChainInputSchema,
  isValidAddress,
  normalizeAddress,
  SmartMoneyFlowSchema,
  type BudgetStore,
  type CapabilityRegistry,
  type SmartMoneyFlow,
} from '@onchain-intel/core';
import { budgetMeta, type BudgetMeta } from './budget-meta.js';
import { resolveCapability, type CacheMeta } from './resolve-capability.js';

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
  registry: CapabilityRegistry;
  /** Injectable the SAME way as `registry` (interfaces.md §5.1.2/§5.2) — used ONLY for read-only
   * `_meta.budget` visibility; the actual budget GATE already ran inside `nansen.fetch()` (that
   * adapter's OWN, separately-injected `budgetStore`, wired at `index.ts`'s construction site). */
  budgetStore?: BudgetStore;
}

const CAPABILITY = 'smart-money.flows';

export type SmartMoneyFlowsOutcome =
  | { ok: true; output: SmartMoneyFlowsOutput; cache: CacheMeta; budget?: BudgetMeta }
  | { ok: false; reason: string };

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
 * `_meta.budget` (interfaces.md §5.1.2): read via `budgetMeta()` ONLY when `outcome.cache.status
 * === 'miss'` — on a `'hit'` the gate/`costOf()`/network never ran at all, so there is nothing new
 * to report (the budget figure would be stale/misleading, not merely omitted for tidiness).
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

/**
 * Registers `onchain_smart_money_flows` — exactly this name (R-41) — on `server`. Same wiring
 * pattern as `get-token.ts`'s `registerGetTokenTool` (`isError`/`_meta.cache`), plus `_meta.budget`
 * as a sibling key when the handler returned one (Phase 2).
 */
export function registerSmartMoneyFlowsTool(server: McpServer, ctx: SmartMoneyFlowsContext): void {
  server.registerTool(
    'onchain_smart_money_flows',
    {
      // See `get-token.ts` for the M-2 rationale. On a PAID route the discovery call is not a
      // nicety: a wrong `chain` guess is refused before any credits are reserved, but only if the
      // model knows to ask instead of guessing.
      title: 'Smart-money flows for a token',
      description:
        'Smart-money net-flow (1h/24h/7d/30d) and top holders for a token. ' +
        'Coverage is per chain — call onchain_list_chains({capability:"smart-money.flows"}) ' +
        'first (Nansen-backed, paid).',
      inputSchema: SmartMoneyFlowsInputSchema,
      outputSchema: SmartMoneyFlowsOutputSchema,
    },
    async (input) => {
      const outcome = await smartMoneyFlowsHandler(input, ctx);
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
