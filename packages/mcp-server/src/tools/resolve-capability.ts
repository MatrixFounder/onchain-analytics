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
/**
 * `_meta.timing` — present ONLY when the answer was produced past the call's own ceiling
 * (OQ-T012-6, owner decision 2026-08-05).
 *
 * The deadline bounds what a call may SPEND, not the moment it may answer: a walk whose sources were
 * all entered and all answered can cross the ceiling on its last adapter, and the owner resolved that
 * such an answer is returned rather than discarded — nothing was prevented, nothing was aborted, and
 * throwing away data already paid for buys the caller nothing.
 *
 * Returning it **silently** is what the decision does not permit, and this object is the other half.
 * A caller that treats `deadlineMs` as a latency contract learns here that it is not one, and a
 * caller for whom late data is worthless can discard it — that judgement belongs to whoever set the
 * deadline, not to the engine.
 *
 * An object rather than a bare number so `_meta` keeps one shape (`cache`, `budget`, `timing` are
 * all objects), and absent rather than `{overrunMs: 0}` on the ordinary call — the same rule
 * `ageMs` and `attempted` follow.
 */
export interface TimingMeta {
  /** Milliseconds past the effective deadline. Always > 0 when this object is present. */
  overrunMs: number;
}

export interface ResolveSuccess {
  ok: true;
  output: unknown;
  cache: CacheMeta;
  /** See {@link TimingMeta}. Absent on every call that finished inside its ceiling. */
  timing?: TimingMeta;
  /**
   * `CapabilityResolution.attempted` forwarded verbatim — the adapters whose `fetch()` the
   * traversal actually entered, which is NOT the same set as `cache.provider` (adversarial cycle 2,
   * F-4). Read by `budgetMeta()` and by nothing else: it never reaches the wire, and no tool's zod
   * output schema grows to carry it (the same rule `_meta.cache` follows).
   *
   * That last sentence was a promise with no gate behind it until cycle 3 — the only thing keeping
   * the field off the wire was that each handler builds its return value field by field, and the
   * ordinary `return { ...outcome, … }` refactor would have published our route composition with
   * every test still green. `test/tool-response-shape.test.ts` now scans for the key.
   *
   * Absent whenever the registry omitted it (a pure cache hit entered nobody).
   */
  attempted?: string[];
  /**
   * `CapabilityResolution.sources`/`missingSources`/`perSourceCache` forwarded verbatim (T-013,
   * task 013-3, R-174/R-175) — present only when the registry set them, which today (013-3) is
   * NEVER: the merge walk that actually populates them ships in 013-4 (`sources`/`perSourceCache`)
   * and 013-5 (`missingSources`). Declared now, ahead of its producer, the same sequencing
   * `attempted` above and `timing`/`TimingMeta` both already followed on this interface.
   *
   * **Strictly additive (R-175b).** None of the 11 existing tools on `resolveCapability()` can ever
   * see these fields: their capabilities (`token.price`, `wallet.balances.native`, `pairs.new`,
   * `protocol.tvl`, `chain.tvl`, `chain.supply`, `dex.volume.history`, `token.holders`,
   * `entity.labels`, `smart-money.flows`, `token.risk`) are disjoint from the two capabilities
   * `capability-manifest.ts` declares `mergeable: true` (`privacy.shielded_pool.history`,
   * `platform.metrics.history`, task 013-1) — so their routes cannot carry `merge: true` without a
   * capability reassignment outside this task's scope. `metaFrom()` does not read any of the three:
   * they are NOT part of `_meta.cache`, the same way `attempted` is read only by `budgetMeta()` and
   * never becomes an `_meta` key of its own.
   */
  sources?: string[];
  /** See {@link ResolveSuccess.sources} — same forwarding rule, same producer (013-5). Positive-only
   * (R-174b): absent when the registry omitted it, never an empty array. */
  missingSources?: { adapterId: string; reason: string }[];
  /** See {@link ResolveSuccess.sources} — same forwarding rule, same producer (013-4). Covers every
   * ANSWERED participant of a merge walk, not only contributors (R-174(c)) — the deviation from an
   * earlier, narrower architecture reading is recorded in `docs/architectures/open-questions.md`
   * ("T-013 task 013-3"). */
  perSourceCache?: { adapterId: string; cache: 'hit' | 'miss'; ageMs?: number }[];
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
 * `defineTool` callback maps to `{isError: true, content: [...]}` — never an unhandled
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
      ...(resolution.attempted !== undefined ? { attempted: resolution.attempted } : {}),
      ...(resolution.deadlineOverrunMs !== undefined
        ? { timing: { overrunMs: resolution.deadlineOverrunMs } }
        : {}),
      // T-013, task 013-3 (R-174/R-175) — same conditional-spread idiom as `attempted`/`timing`
      // above: `exactOptionalPropertyTypes` is NOT enabled (tsconfig.base.json), so an unconditional
      // `sources: resolution.sources` would compile and pass a naive `toBeUndefined()` check even
      // while publishing `{sources: undefined}` on every non-merge call. The conditional spread is
      // what makes the key genuinely ABSENT, not merely undefined-valued.
      ...(resolution.sources !== undefined ? { sources: resolution.sources } : {}),
      ...(resolution.missingSources !== undefined
        ? { missingSources: resolution.missingSources }
        : {}),
      ...(resolution.perSourceCache !== undefined
        ? { perSourceCache: resolution.perSourceCache }
        : {}),
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The `_meta` a resolution produces, ready to be spread into a handler's return value.
 *
 * **Exists so "which fields of a resolution reach `_meta`" is answered ONCE.** Fifteen call sites
 * across eleven tools each wrote `cache: outcome.cache` by hand, so `_meta` gaining a second
 * resolution-derived field meant fifteen edits and fifteen chances to miss one — which is precisely
 * how adversarial cycle 3's F-A happened one layer up (one rule, three handlers, one of them wrong).
 * Handlers now spread this instead, and the next field is free.
 *
 * Accepts anything carrying the two fields, not `ResolveSuccess` specifically: three tools re-wrap
 * their own outcome (`value` → `output`) inside `defineTool`, and that re-wrap must forward the same
 * meta rather than a hand-copied subset of it.
 */
export function metaFrom(source: { cache: CacheMeta; timing?: TimingMeta }): {
  cache: CacheMeta;
  timing?: TimingMeta;
} {
  return { cache: source.cache, ...(source.timing ? { timing: source.timing } : {}) };
}
