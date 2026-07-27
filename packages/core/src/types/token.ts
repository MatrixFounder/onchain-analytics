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
    address: z.string().max(128),
    // Backstops for VENDOR-AUTHORED text (vdd-multi cycle 5, M-6). The adapters truncate to these
    // same bounds in `normalize()` (`adapters/truncate-vendor-text.ts`), so these caps should never
    // be the thing that rejects a response — a post-fetch parse throw discards a response already
    // in hand, which for a paid provider means paying again to be rejected identically.
    symbol: z.string().max(64),
    name: z.string().max(256),
    decimals: z.number().int().nonnegative().optional(),
    priceUsd: z.number().nonnegative().optional(),
    marketCapUsd: z.number().nonnegative().optional(),
    source: z.string(), // id адаптера-источника
    fetchedAt: z.number().int(), // epoch-ms UTC
  })
  .strict();
export type Token = z.infer<typeof TokenSchema>;
