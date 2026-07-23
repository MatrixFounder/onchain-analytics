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
 *
 * `address` is bounded with `.max(MAX_ADDRESS_LENGTH)` (adversarial cycle 2, finding 3) — a real EVM
 * address is <=42 chars and a real Solana base58 pubkey is <=44, so 64 gives comfortable headroom
 * for either while still rejecting a pathological, arbitrarily-long input (e.g. a 100k-character
 * string). **Empirically verified this schema's own `superRefine` still runs even when `.max()`
 * already flagged an issue** (zod doesn't abort early here — it keeps collecting every issue it
 * can) — so the length guard is ALSO checked, redundantly but cheaply, at the very top of
 * `superRefine` itself, to guarantee the actually-expensive `isValidAddress` check (which runs
 * `bs58.decode` for solana — quadratic-ish for very long inputs) is skipped entirely for an
 * over-length address, not merely "eventually rejected after also doing the expensive work".
 */
const MAX_ADDRESS_LENGTH = 64;

export const GetTokenInputSchema = z
  .object({
    chain: z.enum(['ethereum', 'solana']),
    address: z.string().min(1).max(MAX_ADDRESS_LENGTH),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.address.length > MAX_ADDRESS_LENGTH) {
      // Already reported by `.max()` above — skip the expensive isValidAddress/bs58.decode work.
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
export type GetTokenInput = z.infer<typeof GetTokenInputSchema>;

/** Output is the canonical `Token` type re-exported from `@onchain-intel/core` verbatim (task
 * 003-7 scope: "outputs = canonical types from @onchain-intel/core") — no new zod schema
 * introduced for a shape that already has one. */
export const GetTokenOutputSchema = TokenSchema;
export type GetTokenOutput = Token;

export interface GetTokenContext {
  registry: CapabilityRegistry;
}

/** `token.price` (not `token.metadata`) — both route to `coingecko` and its `normalize()` produces
 * the byte-identical `Token` either way (CoinGecko's one contract endpoint returns price and
 * metadata together). The combined payload is cached under the TTL of its most VOLATILE
 * constituent: `priceUsd` freshness is governed by `token.price` = 60s (D6 TTL table), whereas
 * caching under `token.metadata` (3600s) would legally serve an hour-stale price — the exact
 * defect adversarial cycle 3 flagged. The `token.metadata` route stays registered for future
 * metadata-only consumers that can afford the longer TTL. */
const CAPABILITY = 'token.price';

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
 * note).
 *
 * **Corrected (adversarial cycle 2, finding 1 — the PREVIOUS wording here was stale/inaccurate):**
 * this is NOT because the SDK's own automatic `isError` conversion is somehow insufficient — the
 * installed SDK (`@modelcontextprotocol/sdk@1.29.0`) actually wraps its ENTIRE `tools/call` request
 * handler (input validation, the handler callback itself, AND output-schema validation) in one
 * `try/catch` that converts ANY thrown error into `{isError: true, content: [...]}` at the wire
 * level — not just zod input-validation failures (verified by reading the installed
 * `server/mcp.js`'s `setRequestHandler(CallToolRequestSchema, ...)`). This tool builds
 * `{isError: true, ...}` explicitly anyway so that (a) `getTokenHandler`'s own `{ok:false, reason}`
 * contract is unit-testable at the pure-handler level, without a transport, and (b) `reason` is a
 * deliberately chosen, tool-specific message — never whatever generic text a thrown error's own
 * `.message` happens to produce.
 *
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
