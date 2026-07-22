import { z } from 'zod';

/**
 * Canonical chain identifier (ADR-001 D5, ARCHITECTURE.md §3.2/§4.1). `dash` participates in the
 * enum for vocabulary consistency with DB-SCHEMA-CONCEPT's `assets.chain_family`, but no M1 MCP
 * tool accepts `dash` as an input value (tools narrow to `z.enum(['ethereum', 'solana'])`,
 * ARCHITECTURE.md §5.1), and `Wallet`/`Balance` are not populated for it in M1 — `dash-platform`
 * emits `Snapshot`, not `Wallet`/`Balance` (ARCHITECTURE.md §2.1).
 */
export const ChainSchema = z.enum(['ethereum', 'solana', 'dash']);
export type Chain = z.infer<typeof ChainSchema>;
