import { z } from 'zod';
import { ChainSchema } from './chain.js';

/**
 * Canonical `Pool` entity (ARCHITECTURE.md §3.2/§4.1) — a DEX trading pair, the shape returned by
 * `onchain_active_pairs` (M1 MCP tool, implemented in `packages/mcp-server`, not this package).
 */
export const PoolSchema = z
  .object({
    id: z.string().max(256),
    chain: ChainSchema,
    // Same vendor-authored backstops as `TokenSchema` (vdd-multi cycle 5, M-6) — on a
    // permissionless DEX every one of these is chosen by whoever deployed the pair.
    dexId: z.string().max(64),
    baseTokenSymbol: z.string().max(64),
    quoteTokenSymbol: z.string().max(64),
    pairAddress: z.string().max(128),
    createdAt: z.number().int().optional(),
    liquidityUsd: z.number().nonnegative().optional(),
    volume24hUsd: z.number().nonnegative().optional(),
    /**
     * The six fields T-014 adds (task 014-32b, `interfaces.md` §5.1.7). All OPTIONAL, so every
     * shipped producer of this type keeps compiling and `onchain_active_pairs`'s published schema
     * grows without a single row of its output changing shape.
     *
     * **The two ADDRESSES are the point of the pool tool.** `onchain_active_pairs` returns both
     * token SYMBOLS and never an address, so symbol → contract address — WI-56's first link — was
     * served by no registered tool.
     */
    baseTokenAddress: z.string().max(128).optional(),
    quoteTokenAddress: z.string().max(128).optional(),
    /**
     * Per-side reserves in TOKEN UNITS, and LOSSY by contract. The vendor publishes
     * `liquidity.base`/`liquidity.quote` as JSON numbers it has already rounded, so these play the
     * projection role `emissionBtc` plays beside `emissionRaw` (§5.1.5). An exact base-unit reading
     * needs an on-chain call this engine does not make here — which is why there is no
     * `reserveBaseRaw` string beside them to imply one.
     */
    reserveBase: z.number().nonnegative().optional(),
    reserveQuote: z.number().nonnegative().optional(),
    /**
     * The pool's fee tier in basis points, DERIVED — never taken from the vendor, which publishes
     * no fee field at all (measured 2026-08-13 over the single-pool response and all 60 rows of
     * the two committed search fixtures). The derivation is one `eth_call` of `fee()`, selector
     * `0xddca3f43`; a pool without that method reverts, and a revert is distinguishable from a
     * returned tier, so "this pool declares no fee tier" never reaches a caller as a number.
     * Absent where the derivation does not answer, and never guessed (owner decision closing
     * `OQ-T014-IF-3`, 2026-08-13).
     */
    feeTierBps: z.number().int().nonnegative().optional(),
    /**
     * The vendor's own AMM version label — `"v2"`, `"v3"`, `"v4"`, `"CLMM"`. It is NOT a fee and
     * must not be read as one: `labels` is what the vendor publishes in place of a fee field, and
     * mapping a version to a tier would fabricate the number `feeTierBps` above refuses to guess.
     */
    versionLabel: z.string().max(64).optional(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type Pool = z.infer<typeof PoolSchema>;
