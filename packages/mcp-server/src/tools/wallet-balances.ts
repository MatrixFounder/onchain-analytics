import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  isValidAddress,
  normalizeAddress,
  WalletSchema,
  type CapabilityRegistry,
  type Wallet,
} from '@onchain-intel/core';
import { resolveCapability, type CacheMeta } from './resolve-capability.js';

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
const MAX_ADDRESS_LENGTH = 64;

export const WalletBalancesInputSchema = z
  .object({
    chain: z.enum(['ethereum', 'solana']),
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
  { ok: true; output: WalletBalancesOutput; cache: CacheMeta } | { ok: false; reason: string };

/** Pure handler — see `get-token.ts`'s `getTokenHandler` docstring for the shared re-normalize-
 * before-cache-key rationale. */
export async function walletBalancesHandler(
  input: WalletBalancesInput,
  ctx: WalletBalancesContext,
): Promise<WalletBalancesOutcome> {
  const address = normalizeAddress(input.chain, input.address);
  const outcome = await resolveCapability(ctx.registry, CAPABILITY, input.chain, {
    chain: input.chain,
    address,
  });
  if (!outcome.ok) return outcome;
  return { ok: true, output: WalletSchema.parse(outcome.output), cache: outcome.cache };
}

/** Registers `onchain_wallet_balances` — exactly this name (R-17). See `get-token.ts`'s
 * `registerGetTokenTool` docstring for the shared `isError`/`_meta.cache` wiring rationale. */
export function registerWalletBalancesTool(server: McpServer, ctx: WalletBalancesContext): void {
  server.registerTool(
    'onchain_wallet_balances',
    {
      description:
        'Native asset balance (ETH or SOL) for a wallet address on ethereum or solana (JSON-RPC-backed).',
      inputSchema: WalletBalancesInputSchema,
      outputSchema: WalletBalancesOutputSchema,
    },
    async (input) => {
      const outcome = await walletBalancesHandler(input, ctx);
      if (!outcome.ok) {
        return { isError: true, content: [{ type: 'text', text: outcome.reason }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(outcome.output) }],
        structuredContent: outcome.output,
        _meta: { cache: outcome.cache },
      };
    },
  );
}
