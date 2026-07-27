import { z } from 'zod';
import { loadChainRegistry } from './registry.js';
import { MAX_CHAIN_INPUT_LENGTH, type ChainRegistry } from './registry-core.js';

/**
 * `chain` as accepted at the MCP tool boundary (TASK-006 R-50, interfaces.md §5.1.3).
 *
 * **Two schemas, deliberately, not one** (system-architecture.md §3.2):
 *   - `ChainSchema` (`types/chain.ts`) is the CANONICAL form carried inside domain types.
 *   - `ChainInputSchema` — this one — accepts anything an agent might plausibly write (`ethereum`,
 *     `berachain`, `eth`, `eip155:1`) and is paired with `canonicalizeChain()` in the handler.
 *
 * One schema serving both ends would let an alias reach the inside of a canonical object and from
 * there the cache key, so `"ethereum"` and `"eth"` would produce TWO cache entries for one logical
 * request — two paid calls on a paid route (data-model.md §4.2.2).
 *
 * **Why validation here and canonicalization in the handler, rather than a `.transform()`.**
 * A transforming schema is the obvious design and it does not work: the MCP SDK renders every tool
 * input schema to JSON Schema for `tools/list`, and a zod transform has no JSON Schema
 * representation — the SDK answers `tools/list` with `-32603 Transforms cannot be represented in
 * JSON Schema`, which takes down tool DISCOVERY, i.e. the whole server. So the schema only
 * *validates* (representable), and `canonicalizeChain()` does the resolving one line into the
 * handler, still well before `deriveArgsHash`.
 *
 * **Why an open string instead of `z.enum([...458 chains])`** (owner decision 2026-07-26): the
 * closed enum measured ~1249 tokens per tool × 7 chain-taking tools ≈ **8.7k tokens of schema in
 * every single request to the model**. This costs ~5. The correctness the enum bought is not lost,
 * only moved: an unknown chain fails in validation with a "did you mean" list and — the part that
 * matters — **zero network calls and zero credits**, because a mistyped chain name is the most
 * common way an agent misses on a PAID route.
 */
export function createChainInputSchema(deps: { chains?: ChainRegistry } = {}) {
  let registry = deps.chains ?? null;
  const resolveRegistry = (): ChainRegistry => (registry ??= loadChainRegistry());

  return z
    .string()
    .min(1)
    .max(MAX_CHAIN_INPUT_LENGTH)
    .superRefine((raw, ctx) => {
      // **`.max()` above does NOT short-circuit this refinement** (vdd-multi cycle 5, H-2). In
      // zod 4 a `too_big` issue is raised with `continue: true`, so `superRefine` runs on a string
      // of ANY length — and everything below it (registry lookup, then a ~1300-candidate
      // Levenshtein) is linear in that length. Measured: 416 ms at 20 000 chars, i.e. a 1 MB
      // argument buys seconds-to-minutes of total blockage of this single-threaded stdio server,
      // for a request already known to be invalid. Returning here is not a second rejection —
      // `too_big` has already failed the parse; this only declines to do work for it.
      if (raw.length > MAX_CHAIN_INPUT_LENGTH) return;
      if (resolveRegistry().tryResolve(raw) !== null) return;
      // The registry builds its "did you mean" list only on the failure path, so the happy path
      // pays nothing for it.
      let message = `unknown chain '${raw}'.`;
      try {
        resolveRegistry().resolve(raw);
      } catch (error) {
        if (error instanceof Error) message = error.message;
      }
      ctx.addIssue({ code: 'custom', message });
    });
}

/**
 * The shared instance bound to the shipped registry — what the tool schemas use. The registry is
 * built lazily on first parse, so importing this module never loads the 458-row snapshot.
 */
export const ChainInputSchema = createChainInputSchema();

/**
 * Turns a validated chain input into its canonical slug (TASK-006 R-50/R-59).
 *
 * Called at the top of each tool handler, BEFORE the value reaches `args` and therefore before
 * `deriveArgsHash` — which is the whole point: an alias must never reach a cache key
 * (data-model.md §4.2.2).
 *
 * @throws {UnknownChainError} if the chain is unknown. In practice the schema has already
 * rejected that, so this is a backstop, not the reporting path.
 */
export function canonicalizeChain(raw: string, chains?: ChainRegistry): string {
  return (chains ?? loadChainRegistry()).resolve(raw).slug;
}
