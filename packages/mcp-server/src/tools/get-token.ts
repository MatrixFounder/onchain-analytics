import { z } from 'zod';
import { defineTool } from './registry.js';
import {
  canonicalizeChain,
  ChainInputSchema,
  isValidAddress,
  normalizeAddress,
  TokenSchema,
  type CapabilityResolver,
  type Token,
} from '@onchain-intel/core';
import {
  DeadlineMsInputSchema,
  metaFrom,
  resolveCapability,
  type CacheMeta,
  type TimingMeta,
} from './resolve-capability.js';
import { contractViolation } from './contract-violation.js';

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
/**
 * TASK-006 (task 006-6, R-50): `chain` is an OPEN string resolved against the chain registry,
 * replacing the `z.enum(['ethereum','solana'])` literal that this file (and six others) carried.
 * The closed enum for all 458 chains measured ~8.7k tokens of schema across the chain-taking
 * tools — paid on EVERY request to the model. Correctness moved into the runtime resolve, which
 * fails with a "did you mean" list and zero network calls (owner decision 2026-07-26).
 */
const SUPPORTED_CHAIN = ChainInputSchema;

const MAX_ADDRESS_LENGTH = 64;

export const GetTokenInputSchema = z
  .object({
    chain: SUPPORTED_CHAIN,
    address: z.string().min(1).max(MAX_ADDRESS_LENGTH),
  })
  .extend({ deadlineMs: DeadlineMsInputSchema })
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
  registry: CapabilityResolver;
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
  | { ok: true; output: GetTokenOutput; cache: CacheMeta; timing?: TimingMeta }
  | { ok: false; reason: string; refusalClass?: string };

/**
 * Pure handler for `onchain_get_token` — separated from `defineTool` (SDK wiring),
 * mirrors `ping.ts`'s split (unit-testable without a transport, ARCHITECTURE.md §5.2). Re-
 * normalizes `input.address` before it becomes part of the cache-key `args` (net/args-hash.ts's
 * own documented contract: args must be the normalized, post-zod-validation tool input) — the
 * adapter's own defensive re-normalization inside its HTTP step makes this idempotent either way.
 */
export async function getTokenHandler(
  input: GetTokenInput,
  ctx: GetTokenContext,
): Promise<GetTokenOutcome> {
  // TASK-006 (task 006-6, R-50/R-59): resolve the alias to its canonical slug HERE, before the
  // value reaches `args` and therefore before `deriveArgsHash` — otherwise `eth` and `ethereum`
  // would hash to two different cache entries for one logical request, which on a paid route is
  // two charges (data-model.md §4.2.2).
  //
  // The registry is taken from `ctx.registry`, never left to default (vdd-multi cycle 5, H-4).
  // Two defects in one line: (a) the default path REBUILDS the 458-row snapshot on every call —
  // ~0.55 ms of zod parsing plus four indexes to perform a single `Map.get`, measured ×5500 the
  // cost of the lookup itself, and paid even on a cache hit; (b) it canonicalizes against a
  // DIFFERENT dictionary than the coverage gate one line below resolves with, so an injected
  // registry made the two disagree silently.
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const address = normalizeAddress(chain, input.address);
  const outcome = await resolveCapability(
    ctx.registry,
    CAPABILITY,
    chain,
    {
      chain,
      address,
    },
    input.deadlineMs,
  );
  if (!outcome.ok) return outcome;
  // `safeParse`, never `parse` (WI-27, adversarial cycle 2). This line used to be `.parse`, so a
  // provider result that violated the contract threw a ZodError out of the handler — and the SDK's
  // own catch renders `error.message`, which for zod IS `JSON.stringify(issues, null, 2)`. That is
  // the exact defect WI-27 removed from three tools while two more kept it by a different spelling,
  // invisible to a gate that looked for `OutputSchema.safeParse`.
  const parsed = TokenSchema.safeParse(outcome.output);
  if (!parsed.success) {
    return contractViolation(CAPABILITY, parsed.error);
  }
  return { ok: true, output: parsed.data, ...metaFrom(outcome) };
}

/**
 * The `ToolSpec` for `onchain_get_token` — this name is declared here and nowhere else (R-16). As in
 * `ping.ts`, zod schemas are the single source of truth for both runtime validation and the MCP
 * tool-schema; a `CapabilityUnavailableError` is surfaced by `resolveCapability` as
 * `{ok: false, reason}` and becomes `{isError: true, content: [...]}` on the wire (task 003-7
 * reviewer note) — rendered by `defineTool`, not here, since TASK-011.
 *
 * **Corrected (adversarial cycle 2, finding 1 — the PREVIOUS wording here was stale/inaccurate):**
 * this is NOT because the SDK's own automatic `isError` conversion is somehow insufficient — the
 * installed SDK (`@modelcontextprotocol/sdk@1.29.0`) actually wraps its ENTIRE `tools/call` request
 * handler (input validation, the handler callback itself, AND output-schema validation) in one
 * `try/catch` that converts ANY thrown error into `{isError: true, content: [...]}` at the wire
 * level — not just zod input-validation failures (verified by reading the installed
 * `server/mcp.js`'s `setRequestHandler(CallToolRequestSchema, ...)`). The `{ok:false, reason}`
 * contract exists anyway so that `getTokenHandler` is unit-testable at the pure-handler level,
 * without a transport. **Since TASK-011 the `{isError: true, …}` object is built by `defineTool`'s
 * shared renderer** (`registry.ts`), not here — this file no longer touches the SDK at all.
 *
 * **What `reason` actually carries** (corrected in adversarial cycle 2 — the previous wording
 * claimed it is "a deliberately chosen, tool-specific message, never a thrown error's `.message`",
 * and that is false on the dominant path). On the capability path `resolveCapability` returns
 * `error.message` **verbatim**, and this handler forwards it unchanged; for a
 * `CapabilityUnavailableError` that message concatenates every adapter's failure, which can include
 * up to 500 characters of a vendor's own response body. That is deliberate — it is the diagnostic
 * channel R-24/R-40 asked for — but it means the error path is **not** sanitized the way the success
 * path is (`blockscout/sanitize.ts`, `truncate-vendor-text.ts`). Secrets do not reach it: every
 * adapter redacts keys before throwing, and `safeFetch` reduces URLs to origin+pathname. Anyone
 * adding a new failure path should assume vendor-authored text reaches the model and treat it as
 * untrusted input, not as curated copy.
 *
 * `_meta.cache` sits OUTSIDE `structuredContent`/`outputSchema` (ARCHITECTURE.md §3.2/§5.1).
 */
export const getTokenToolSpec = defineTool({
  name: 'onchain_get_token',
  title: 'Token price and metadata',
  description:
    'Token metadata and USD price for a contract address, on any supported chain. ' +
    'Call onchain_list_chains({capability:"token.price"}) to see where it is served ' +
    '(CoinGecko-backed).',
  inputSchema: GetTokenInputSchema,
  outputSchema: GetTokenOutputSchema,
  capability: CAPABILITY,
  needs: ['registry', 'principal'],
  handler: getTokenHandler,
});
