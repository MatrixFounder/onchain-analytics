import { z } from 'zod';
import { ChainSchema } from './chain.js';

/**
 * Canonical `OHLCV` entity (ARCHITECTURE.md §3.2/§4.1) — reserved: R-1 requires the type to
 * exist, but no M1 MCP tool consumes it yet. First consumer is a future candlestick/chart tool
 * (M1.5+).
 */
export const OhlcvSchema = z
  .object({
    chain: ChainSchema,
    pairAddress: z.string(),
    ts: z.number().int(),
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    volumeUsd: z.number().nonnegative().optional(),
    source: z.string(),
  })
  .strict();
export type Ohlcv = z.infer<typeof OhlcvSchema>;
