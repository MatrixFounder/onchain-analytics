import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  isValidAddress,
  normalizeAddress,
  TokenSchema,
  type CapabilityRegistry,
  type Token,
} from '@onchain-intel/core';
import { resolveCapability, type CacheMeta } from './resolve-capability.js';

/**
 * Input contract for `onchain_get_token` (ARCHITECTURE.md §5.1, R-16). `chain` is narrowed to just
 * the two supported networks below — NOT the full `ChainSchema` (task 003-7 reviewer note, Major-2
 * from architecture review cycle 1): `isValidAddress`/`normalizeAddress` don't implement Dash
 * address validation (dash-platform works through `Snapshot`, not `Token`/`Wallet`), so accepting
 * `'dash'` here would be a value that always, unconditionally fails the `superRefine` below — a
 * misleading contract rather than a genuinely supported input.
 */
export const GetTokenInputSchema = z
  .object({
    chain: z.enum(['ethereum', 'solana']),
    address: z.string().min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (!isValidAddress(val.chain, val.address)) {
      ctx.addIssue({
        code: 'custom',
        message: `invalid address for chain ${val.chain}`,
        path: ['address'],
      });
    }
  });
export type GetTokenInput = z.infer<typeof GetTokenInputSchema>;

/** Output is the canonical `Token` type re-exported from `@onchain-intel/core` verbatim (task
 * 003-7 scope: "outputs = canonical types from @onchain-intel/core") — no new zod schema
 * introduced for a shape that already has one. */
export const GetTokenOutputSchema = TokenSchema;
export type GetTokenOutput = Token;

export interface GetTokenContext {
  registry: CapabilityRegistry;
}

/** `token.metadata` (not `token.price`) — both route to `coingecko` and its `normalize()` produces
 * the byte-identical `Token` either way (CoinGecko's one contract endpoint returns price and
 * metadata together, task 003-4's own adapter docstring) — `token.metadata` is the more accurate
 * capability name for what `onchain_get_token`'s full-object contract represents. */
const CAPABILITY = 'token.metadata';

export type GetTokenOutcome =
  { ok: true; output: GetTokenOutput; cache: CacheMeta } | { ok: false; reason: string };

/**
 * Pure handler for `onchain_get_token` — separated from `registerGetTokenTool` (SDK wiring),
 * mirrors `ping.ts`'s split (unit-testable without a transport, ARCHITECTURE.md §5.2). Re-
 * normalizes `input.address` before it becomes part of the cache-key `args` (net/args-hash.ts's
 * own documented contract: args must be the normalized, post-zod-validation tool input) — the
 * adapter's own defensive re-normalization inside its HTTP step makes this idempotent either way.
 */
export async function getTokenHandler(
  input: GetTokenInput,
  ctx: GetTokenContext,
): Promise<GetTokenOutcome> {
  const address = normalizeAddress(input.chain, input.address);
  const outcome = await resolveCapability(ctx.registry, CAPABILITY, input.chain, {
    chain: input.chain,
    address,
  });
  if (!outcome.ok) return outcome;
  return { ok: true, output: TokenSchema.parse(outcome.output), cache: outcome.cache };
}

/**
 * Registers `onchain_get_token` — exactly this name (R-16) — on `server`. Same `registerTool`
 * pattern as `ping.ts`: zod schemas are the single source of truth for both runtime validation and
 * the MCP tool-schema; on `CapabilityUnavailableError` (surfaced by `resolveCapability` as
 * `{ok: false, reason}`) returns `{isError: true, content: [...]}` EXPLICITLY (task 003-7 reviewer
 * note — never relies on the SDK's automatic `isError` conversion, which M0's `.AGENTS.md`
 * documents as covering only zod input-validation failures, not business-logic errors).
 * `_meta.cache` sits OUTSIDE `structuredContent`/`outputSchema` (ARCHITECTURE.md §3.2/§5.1).
 */
export function registerGetTokenTool(server: McpServer, ctx: GetTokenContext): void {
  server.registerTool(
    'onchain_get_token',
    {
      description:
        'Token metadata and USD price for a contract address on ethereum or solana (CoinGecko-backed).',
      inputSchema: GetTokenInputSchema,
      outputSchema: GetTokenOutputSchema,
    },
    async (input) => {
      const outcome = await getTokenHandler(input, ctx);
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
