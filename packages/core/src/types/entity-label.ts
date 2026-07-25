import { z } from 'zod';
import { ChainSchema } from './chain.js';

/**
 * Canonical `EntityLabel` entity (ARCHITECTURE.md §4.1, D5-extension, M2/TASK-005, R-32) — a
 * label/metadata record for an address or a cross-chain entity (wallet, fund, exchange, known
 * trader), used by `onchain_entity_label`. Source depends on the call tier (§3.2 `costOf()`
 * table): default `POST /search/general` (`EntitySearchResult`/`TokenSearchResult`), token-scoped
 * enrichment via `TGMHolder.address_label`, or the `exhaustive: true` escalation
 * (`POST /profiler/address/labels`).
 *
 * **The ONLY M2 type where BOTH `chain` and `address` are optional** (data-model.md §4.1): a
 * Nansen `EntitySearchResult` carries neither — an entity can be cross-chain (name/tags with no
 * single address). This is the real response shape, not a modeling shortcut.
 *
 * **`tags[]`/`labels[]` default to `[]` — an empty array is a VALID result** ("no labels found",
 * not an error, R-32 acceptance): `tags` comes from `EntitySearchResult.tags`, `labels` comes from
 * `TGMHolder.address_label` wrapped into a single-element array (or `[]` when absent).
 *
 * **Business rule (not enforced by this schema, same convention as `Token.address`):** `address`,
 * when present, must always be the output of `normalizeAddress(chain, raw)` before landing here.
 */
export const EntityLabelSchema = z
  .object({
    chain: ChainSchema.optional(),
    address: z.string().optional(),
    // Length/count caps on VENDOR-AUTHORED free text (adversarial cycle 1, security F-2).
    // `name`/`tags`/`labels` derive from on-chain token and entity names — which ANYONE can author
    // by deploying a token and choosing its name. These strings are returned to the model as
    // `structuredContent`, and this same tool exposes the `exhaustive: true` escalation priced at
    // 100 credits — so unbounded attacker-authored text is a direct channel for steering an agent's
    // spend, not merely a hygiene issue. Bounds are generous for legitimate labels ("Wintermute",
    // "Binance 14", ENS names) and only bite on abuse.
    name: z.string().max(256).optional(),
    tags: z.array(z.string().max(256)).max(64).default([]),
    labels: z.array(z.string().max(256)).max(64).default([]),
    // true only when the call actually went through the exhaustive: true path (R-42) — never
    // inferred from the presence/absence of labels.
    premiumRequested: z.boolean(),
    source: z.string(), // id адаптера-источника
    fetchedAt: z.number().int(), // epoch-ms UTC
  })
  .strict();
export type EntityLabel = z.infer<typeof EntityLabelSchema>;
