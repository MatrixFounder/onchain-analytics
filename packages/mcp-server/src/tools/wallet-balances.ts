import { z } from 'zod';
import { defineTool } from './registry.js';
import {
  canonicalizeChain,
  ChainInputSchema,
  isValidAddress,
  normalizeAddress,
  WalletSchema,
  type CapabilityRegistry,
  type Wallet,
} from '@onchain-intel/core';
import {
  resolveCapability,
  type CacheMeta,
  type TimingMeta,
  metaFrom,
} from './resolve-capability.js';
import { contractViolationReason } from './contract-violation.js';

/**
 * Input contract for `onchain_wallet_balances` (ARCHITECTURE.md §5.1, R-17) — the literal
 * `WalletBalancesInputSchema` sample from ARCHITECTURE.md §5.1 (task 003-7 reviewer note, Major-2):
 * `chain` narrowed to just the two supported networks below, not the full `ChainSchema` — see
 * `get-token.ts`'s own docstring for why `'dash'` would be a misleading, always-failing value here.
 * `address` is bounded with `.max(MAX_ADDRESS_LENGTH)` (adversarial cycle 2, finding 3) — see
 * `get-token.ts`'s own docstring for the exact rationale, including why the same length is ALSO
 * checked at the top of `superRefine` itself (zod still runs it even after `.max()` already
 * flagged an issue — this guard is what actually guarantees the expensive
 * `isValidAddress`/`bs58.decode` work is skipped for an over-length address).
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

export const WalletBalancesInputSchema = z
  .object({
    chain: SUPPORTED_CHAIN,
    address: z.string().min(1).max(MAX_ADDRESS_LENGTH),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.address.length > MAX_ADDRESS_LENGTH) {
      return;
    }
    if (!isValidAddress(val.chain, val.address)) {
      ctx.addIssue({
        code: 'custom',
        message: `invalid address for chain ${val.chain}`,
        path: ['address'],
      });
    }
  });
export type WalletBalancesInput = z.infer<typeof WalletBalancesInputSchema>;

/** Output is the canonical `Wallet` type re-exported from `@onchain-intel/core` verbatim — in M1
 * `balances` only ever contains `assetType: 'native'` entries (`rpc-evm`/`rpc-solana`, OQ-1). */
export const WalletBalancesOutputSchema = WalletSchema;
export type WalletBalancesOutput = Wallet;

export interface WalletBalancesContext {
  registry: CapabilityRegistry;
}

const CAPABILITY = 'wallet.balances.native';

export type WalletBalancesOutcome =
  | { ok: true; output: WalletBalancesOutput; cache: CacheMeta; timing?: TimingMeta }
  | { ok: false; reason: string };

/** Pure handler — see `get-token.ts`'s `getTokenHandler` docstring for the shared re-normalize-
 * before-cache-key rationale. */
export async function walletBalancesHandler(
  input: WalletBalancesInput,
  ctx: WalletBalancesContext,
): Promise<WalletBalancesOutcome> {
  // TASK-006 (task 006-6, R-50/R-59): resolve the alias to its canonical slug HERE, before the
  // value reaches `args` and therefore before `deriveArgsHash` — otherwise `eth` and `ethereum`
  // would hash to two different cache entries for one logical request, which on a paid route is
  // two charges (data-model.md §4.2.2).
  //
  // Resolved against `ctx.registry`, never the default — see `get-token.ts` for both halves of
  // that (vdd-multi cycle 5, H-4).
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const address = normalizeAddress(chain, input.address);
  const outcome = await resolveCapability(ctx.registry, CAPABILITY, chain, {
    chain,
    address,
  });
  if (!outcome.ok) return outcome;
  // `safeParse`, never `parse` — see `get-token.ts` for why this was the same WI-27 defect under a
  // different spelling. `WalletSchema.balances` is an array, so the per-element scaling was here too.
  const parsed = WalletSchema.safeParse(outcome.output);
  if (!parsed.success) {
    return { ok: false, reason: contractViolationReason(CAPABILITY, parsed.error) };
  }
  return { ok: true, output: parsed.data, ...metaFrom(outcome) };
}

/** The `ToolSpec` for `onchain_wallet_balances` — this name is declared here and nowhere else
 * (R-17). Registration happens in `registry.ts`; see `get-token.ts`'s spec docstring for the shared
 * `isError`/`_meta.cache` wiring rationale. */
export const walletBalancesToolSpec = defineTool({
  name: 'onchain_wallet_balances',
  title: 'Native balance of a wallet',
  description:
    'Native asset balance for a wallet address, from a curated JSON-RPC endpoint. ' +
    'Served only on chains with an approved RPC host — call ' +
    'onchain_list_chains({capability:"wallet.balances.native"}) for the list.',
  inputSchema: WalletBalancesInputSchema,
  outputSchema: WalletBalancesOutputSchema,
  capability: CAPABILITY,
  needs: ['registry'],
  handler: walletBalancesHandler,
});
