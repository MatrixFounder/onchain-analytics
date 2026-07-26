import { z } from 'zod';

/**
 * Canonical chain identifier carried INSIDE domain types (ADR-001 D5, ARCHITECTURE.md §3.2/§4.1).
 *
 * **TASK-006 (task 006-5): widened from `z.enum(['ethereum','solana','dash'])` to the chain's
 * canonical SLUG.** The engine's chain vocabulary lives in the registry now
 * (`src/chain/registry-core.ts`), not in a type literal that had to be edited across five layers
 * for every new chain.
 *
 * **Recorded deviation from ARCHITECTURE.md §3.2, which specifies a CAIP-2-branded `ChainSchema`.**
 * Domain types carry the slug (`ethereum`), not the CAIP-2 id (`eip155:1`), because TASK.md R-59d
 * requires that the SHAPE OF TOOL RESPONSES not change — and `onchain_get_token` has always
 * answered `chain: "ethereum"`. Emitting `eip155:1` there would break a Must requirement to
 * satisfy an implementation preference.
 *
 * The architecture's actual concern is served in full, because the two values address different
 * things:
 *   - **slug** — the canonical value a human or an agent reads back. Unique, 1:1 with the CAIP-2
 *     id, and never an alias.
 *   - **CAIP-2** — the registry's stable primary key, and what §4.2.2 requires the CACHE KEY to be
 *     derived from (stable even if a vendor renames a chain).
 *
 * What §4.2.2 genuinely demands is that an ALIAS never reach a cache key; both values satisfy that.
 * Task 006-6 canonicalizes tool input at the boundary and feeds CAIP-2 to `deriveArgsHash`.
 *
 * Registry-membership validation arrives with `ChainInputSchema` in task 006-6, which owns the
 * schema layer — keeping it out of here avoids two competing validators mid-migration.
 */
export const ChainSchema = z.string().min(1);
export type Chain = z.infer<typeof ChainSchema>;
