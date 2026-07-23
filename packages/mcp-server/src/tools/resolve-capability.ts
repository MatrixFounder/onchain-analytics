import type { CapabilityRegistry, Chain } from '@onchain-intel/core';

/**
 * `_meta.cache` shape every one of the 4 new M1 tools attaches to its MCP response (ARCHITECTURE.md
 * §3.2/§5.1, R-15 — the tool-level proof that the two-level cache is real): deliberately a sibling
 * of `structuredContent`/`content`, never folded into either — the zod output contract per tool
 * never grows just to carry cache observability (task 003-7 reviewer note). `ageMs` is omitted
 * entirely on a `'miss'` (there is no age to report yet), never coerced to `0`/`null`.
 */
export interface CacheMeta {
  status: 'hit' | 'miss';
  ageMs?: number;
  provider: string;
  capability: string;
}

/** Successful `registry.resolve()` outcome — `output` is the adapter's raw `normalize()` result,
 * still `unknown` here; each tool's own handler re-validates it against ITS canonical zod output
 * schema before returning (the anti-corruption layer doesn't stop at the Registry boundary — the
 * MCP tool layer re-asserts the exact contract it advertises, task 003-7). */
export interface ResolveSuccess {
  ok: true;
  output: unknown;
  cache: CacheMeta;
}

/** Failure outcome — `reason` is always `error.message` from whatever `registry.resolve()` threw
 * (`CapabilityUnavailableError` in the documented case, ARCHITECTURE.md §9.1/§9.1). That error's own
 * constructor already builds a message with NO secret values (D10) — this function never inspects
 * or rewrites it, just forwards it verbatim. */
export interface ResolveFailure {
  ok: false;
  reason: string;
}

export type ResolveOutcome = ResolveSuccess | ResolveFailure;

/**
 * Shared `registry.resolve()` wrapper for the 4 new M1 tools (`get-token`/`wallet-balances`/
 * `new-pairs`/`protocol-tvl`) — extracted because all 4 handlers need the byte-identical
 * try/catch + `_meta.cache`-shape logic (DRY; developer-guidelines §1.6 "internal abstraction —
 * apply professional engineering judgment"; mirrors `packages/core`'s own precedent of sharing
 * near-identical small helpers across sibling files, e.g. `not-implemented-error.ts`/
 * `dash-metrics.ts`). `onchain_ping` does NOT use this (R-20, unchanged — it has no registry/
 * capability to resolve).
 *
 * Never throws: `registry.resolve()`'s only documented rejection is `CapabilityUnavailableError`
 * (ARCHITECTURE.md §9.1), but this function treats ANY thrown error identically (defensive —
 * mirrors `CapabilityRegistry.resolve()`'s own "never trust the specific error type" internal
 * `fetch`/`normalize` catch), turning it into a structured `{ok: false, reason}` the tool's
 * `registerXTool` callback maps to `{isError: true, content: [...]}` — never an unhandled
 * rejection that would crash the MCP request handler (ARCHITECTURE.md §9.1/§7.3 invariant,
 * inherited from M0).
 */
export async function resolveCapability(
  registry: CapabilityRegistry,
  capability: string,
  chain: Chain,
  args: Record<string, unknown>,
): Promise<ResolveOutcome> {
  try {
    const resolution = await registry.resolve(capability, chain, args);
    return {
      ok: true,
      output: resolution.result,
      cache: {
        status: resolution.cache,
        ...(resolution.ageMs !== undefined ? { ageMs: resolution.ageMs } : {}),
        provider: resolution.source,
        capability,
      },
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
