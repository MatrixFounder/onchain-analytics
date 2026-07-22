import { z } from 'zod';
import { ChainSchema } from './chain.js';

/**
 * Canonical `Token` entity (ARCHITECTURE.md §3.2/§4.1, D5) — metadata + price for a token on a
 * given chain/address.
 *
 * Business rule (ARCHITECTURE.md §4.1, not enforced by this schema): `address` must always be the
 * output of `normalizeAddress(chain, raw)` (`src/chain/address.ts`) before it lands in a `Token` —
 * no adapter puts raw user/provider input into the canonical object directly.
 */
export const TokenSchema = z
  .object({
    chain: ChainSchema,
    address: z.string(),
    symbol: z.string(),
    name: z.string(),
    decimals: z.number().int().nonnegative().optional(),
    priceUsd: z.number().nonnegative().optional(),
    marketCapUsd: z.number().nonnegative().optional(),
    source: z.string(), // id адаптера-источника
    fetchedAt: z.number().int(), // epoch-ms UTC
  })
  .strict();
export type Token = z.infer<typeof TokenSchema>;
