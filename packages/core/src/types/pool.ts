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
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type Pool = z.infer<typeof PoolSchema>;
