import { z } from 'zod';
import { ChainSchema } from './chain.js';

/**
 * One risk/reward indicator entry (`TGMIndicator`, `nansen-openapi-2026-07-23.json`) — the same
 * shape is reused for both `riskIndicators` and `rewardIndicators` (only the grouping array
 * differs, not the element shape). Not separately exported (data-model.md §4.1 names only
 * `TokenRiskScoreSchema` as this file's public surface).
 *
 * `score` is a QUALITATIVE string (risk: low/medium/high, reward: bearish/neutral/bullish), while
 * `signal`/`signalPercentile` are plain JS `number` — **not strings**: these are NOT wei-like
 * on-chain integers (DB-SCHEMA-CONCEPT §1.7's exact-value-as-string rule doesn't apply here), so a
 * lossy `REAL`/JS-number representation is safe (R-33).
 */
const TokenRiskIndicatorSchema = z
  .object({
    // `.max(256)` on every vendor-authored string (cycle-2 review R-3): the cycle-1 cap fix landed
    // on EntityLabel and SmartMoneyFlow but MISSED this third canonical type, leaving `token.risk`
    // the one uncapped path into the cache row and the model's context.
    indicatorType: z.string().max(256),
    score: z.string().max(256).optional(),
    signal: z.number().optional(),
    signalPercentile: z.number().optional(),
    lastTriggerOn: z.string().max(256).optional(), // YYYY-MM-DD, vendor-supplied
  })
  .strict();

/**
 * Canonical `TokenRiskScore` entity (ARCHITECTURE.md §4.1, D5-extension, M2/TASK-005, R-33) —
 * risk/reward indicators for a token, used by `onchain_token_risk`. Composite type: built from TWO
 * Nansen endpoints (`POST /tgm/indicators` + `POST /tgm/token-information`) merged inside a single
 * `nansen.fetch()` call (§3.2).
 *
 * **`riskIndicators`/`rewardIndicators` are two SEPARATE arrays, never flattened into one list**
 * (R-33 "not flattened") — mirrors `TGMIndicatorsResponse.risk_indicators`/`.reward_indicators`.
 *
 * **Business rule (not enforced by this schema, same convention as `Token.address`):** `address`
 * must always be the output of `normalizeAddress(chain, raw)` before landing here.
 */
export const TokenRiskScoreSchema = z
  .object({
    chain: ChainSchema,
    address: z.string(),
    marketCapUsd: z.number().nonnegative().optional(),
    marketCapGroup: z.string().max(256).optional(),
    isStablecoin: z.boolean().optional(),
    // Bounded for the same reason as `SmartMoneyFlow.topHolders` (cycle-2 R-3): no pagination is
    // sent to `/tgm/indicators`, `safeFetch`'s size cap is Content-Length-based and concedes
    // chunked bodies are uncapped mid-stream, and this result is cached for 1800s — so an oversized
    // body would be mapped, parsed, stored AND re-served repeatedly. `normalize.ts` slices to
    // MAX_VENDOR_ROWS before mapping, so this cap is a backstop that never fails a valid response.
    riskIndicators: z.array(TokenRiskIndicatorSchema).max(200),
    rewardIndicators: z.array(TokenRiskIndicatorSchema).max(200),
    source: z.string(), // id адаптера-источника
    fetchedAt: z.number().int(), // epoch-ms UTC
  })
  .strict();
export type TokenRiskScore = z.infer<typeof TokenRiskScoreSchema>;
