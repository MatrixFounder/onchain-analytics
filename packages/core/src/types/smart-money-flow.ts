import { z } from 'zod';
import { ChainSchema } from './chain.js';

/**
 * One entry of `SmartMoneyFlow.topHolders` — a deliberate SUBSET of Nansen's `TGMHolder` DTO
 * (`nansen-openapi-2026-07-23.json`), not the full wire shape (anti-corruption layer, D4/§4.1):
 * only the fields this canonical type actually needs (`address`, `addressLabel`, `tokenAmount`,
 * `valueUsd`, `ownershipPercentage`) — `total_outflow`/`total_inflow`/`balance_change_*` are
 * dropped. Not separately exported (data-model.md §4.1 names only `SmartMoneyFlowSchema` as this
 * file's public surface) — it only ever appears embedded in `topHolders`.
 */
const SmartMoneyTopHolderSchema = z
  .object({
    address: z.string(),
    addressLabel: z.string().optional(),
    tokenAmount: z.number().optional(),
    valueUsd: z.number().optional(),
    ownershipPercentage: z.number().optional(),
  })
  .strict();

/**
 * Canonical `SmartMoneyFlow` entity (ARCHITECTURE.md §4.1, D5-extension, M2/TASK-005, R-31) —
 * net-flow of "smart money" for a token across four fixed sliding windows, plus its top holders.
 * Composite type: built from TWO Nansen endpoints (`POST /smart-money/netflow` +
 * `POST /tgm/holders`) merged inside a single `nansen.fetch()` call (§3.2) — not two separate
 * canonical types.
 *
 * **Business rule (not enforced by this schema, same convention as `Token.address`):**
 * `tokenAddress`/`topHolders[].address` must always be the output of `normalizeAddress(chain, raw)`
 * before landing here — no adapter puts a raw vendor/user address string into this type directly.
 *
 * **Four fixed windows, not an abstract `windowStart`/`windowEnd`** (data-model.md §4.1): the real
 * `SmartMoneyNetflow` response only ever returns this exact set
 * (`net_flow_{1h,24h,7d,30d}_usd`) — `netflow24hUsd` alone satisfies R-31's illustrative
 * "netflowUsd" wording; the other three are additional precision, not scope creep.
 */
export const SmartMoneyFlowSchema = z
  .object({
    chain: ChainSchema,
    tokenAddress: z.string(),
    // Capped: vendor-authored free text (anyone can deploy a token and name it) — see the
    // rationale on EntityLabelSchema. Adversarial cycle 1, security F-2.
    tokenSymbol: z.string().max(256),
    netflow1hUsd: z.number(),
    netflow24hUsd: z.number(),
    netflow7dUsd: z.number(),
    netflow30dUsd: z.number(),
    traderCount: z.number().int().nonnegative().optional(),
    tokenAgeDays: z.number().int().nonnegative().optional(),
    tokenSectors: z.array(z.string().max(256)).max(64).optional(),
    // `.max(200)` matches `MAX_VENDOR_ROWS` in normalize.ts, which slices BEFORE mapping — so this
    // cap is a backstop that can never turn a large-but-valid vendor response into a normalization
    // failure. No pagination is sent to `/tgm/holders`, so response size is the vendor's choice and
    // flows straight into the cached row and the model's context (adversarial cycle 1).
    topHolders: z.array(SmartMoneyTopHolderSchema).max(200),
    source: z.string(), // id адаптера-источника
    fetchedAt: z.number().int(), // epoch-ms UTC
  })
  .strict();
export type SmartMoneyFlow = z.infer<typeof SmartMoneyFlowSchema>;
