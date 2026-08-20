import { z } from 'zod';
import { capabilityManifests, type CapabilityResolver, type Chain } from '@onchain-intel/core';

/**
 * The deadline a NETWORK client may send — task 014-23, R-16, `interfaces.md` §5.4.5.
 *
 * **A duration, never a moment.** `registry.resolve()`'s fourth parameter is an absolute epoch-ms
 * instant, and accepting one from the wire would let a remote clock's skew set our spending bound.
 * The server converts from its own clock at admission.
 *
 * **`.int().positive().safe()`, and each of the three earns its place.** A non-integer or unsafe
 * value would reach the registry's own guard, which reads a malformed number as ABSENCE — i.e. as
 * the FULL manifest budget, which is more time than the caller asked for. Refusing the shape here
 * means a client is told its value was unusable instead of quietly receiving the opposite of it.
 */
export const DeadlineMsInputSchema = z
  .number()
  .int()
  .positive()
  .safe()
  .optional()
  .describe(
    'Optional: cap this call at N milliseconds. May only narrow the capability’s own limit.',
  );

/**
 * Thrown-shaped refusal for a deadline that would WIDEN the capability's declared budget (AC-12).
 *
 * **Refused, not clamped.** Clamping answers under a bound the caller is never told about: they ask
 * for 120 s, get 15 s of work, and read the shorter answer as the vendor's. The refusal names both
 * numbers, so the correction is mechanical.
 *
 * It is a class rather than a bare string because `refusalClass` is what `request_trace` records,
 * and `transport/failure-classes.ts` demonstrates that classifying a message back into a class is
 * not injective. `name` is assigned explicitly, so it survives bundling.
 */
export class DeadlineWideningRefusedError extends Error {
  constructor(
    readonly capability: string,
    readonly requestedMs: number,
    readonly declaredMs: number,
  ) {
    super(
      `deadlineMs ${requestedMs} exceeds the ${declaredMs}ms this capability declares for ` +
        `${capability} — a caller may narrow the limit, never widen it`,
    );
    this.name = 'DeadlineWideningRefusedError';
  }
}

/**
 * Thrown-shaped refusal for a capability with no manifest row.
 *
 * **Why this refuses rather than ignoring the requested deadline.** Ignoring it would apply the full
 * budget — more time than the caller asked for — which is the widening R-16.2 forbids, arrived at by
 * omission instead of by request. Every routed capability has a row
 * (`packages/core/test/capability-manifest.test.ts`), so this is unreachable today and says so
 * loudly if that stops being true.
 */
export class CapabilityManifestMissingError extends Error {
  constructor(readonly capability: string) {
    super(`no capability manifest declares a deadline for ${capability}`);
    this.name = 'CapabilityManifestMissingError';
  }
}

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

/**
 * The `_meta.cache` shape a MERGED answer publishes instead of {@link CacheMeta} (T-013, R-174(e)).
 *
 * **Why a sibling type rather than optional fields on `CacheMeta`.** `provider` is a single string
 * that a merge has no honest value for — two participants answered — and `capability` would restate
 * what the tool's own `series` input already says. Making those two optional on `CacheMeta` would
 * have been a WEAKENING of a type eleven tools depend on, and R-175(b) permits only strictly
 * additive changes there. A separate shape leaves those eleven untouched and states its own
 * contract, and `perSource` — which participant was warm, which was paid for — is the fact a merged
 * answer has that a single-winner one does not.
 *
 * Both shapes are accepted by `ToolOutcome.cache`; nothing downstream reads either one's fields,
 * since `_meta` is passed through to the client verbatim.
 */
export interface MergedCacheMeta {
  status: 'hit' | 'miss';
  perSource?: { adapterId: string; cache: 'hit' | 'miss'; ageMs?: number }[];
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
   * see these fields: their capabilities (`token.price`, `wallet.balances.native`, `pairs.active`,
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
  /**
   * The `name` of the class that was thrown (task 014-30, `OD-014-30-11`) — what
   * `request_trace.refusal_class` records.
   *
   * **REQUIRED, not optional.** The column is `NOT NULL` on every refusal row by CHECK constraint,
   * and this interface has exactly one construction site: an optional field here would let that
   * site be edited into producing a row the engine rejects, at runtime, on the failure path.
   *
   * **Why the class and not the message.** They answer different questions and only one is stable:
   * `reason` is `error.message`, which for `CapabilityUnavailableError` concatenates every adapter's
   * own failure text and can embed up to 500 characters of a vendor's response body. Classifying
   * that text back into a class is not merely fragile — `transport/failure-classes.ts` carries
   * byte-identical markers for two distinct classes, so it is not injective.
   *
   * **Why it is taken here.** This is the one place the thrown INSTANCE still exists; one line
   * below, it is gone. Every error class in both packages assigns `this.name` explicitly, so the
   * value survives bundling.
   */
  refusalClass: string;
}

export type ResolveOutcome = ResolveSuccess | ResolveFailure;

/**
 * Shared `registry.resolve()` wrapper for the 4 new M1 tools (`get-token`/`wallet-balances`/
 * `active-pairs`/`protocol-tvl`) — extracted because all 4 handlers need the byte-identical
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
  // The narrow interface, not the class (task 014-30, `OD-014-30-7`): `mcp-server`'s wrapper
  // interposes a per-request observer here, and a structural wrapper cannot satisfy a class type.
  registry: CapabilityResolver,
  capability: string,
  chain: Chain,
  args: Record<string, unknown>,
  /**
   * The caller's own bound, in MILLISECONDS (task 014-23, AC-12). Absent means the capability's
   * declared budget, which is what every caller got before this task.
   *
   * **Deliberately NOT part of `args`.** `args` is what the argument hash — and therefore the cache
   * key — is built from. Two callers asking the same question with different patience must share a
   * cache entry; folding the deadline in would give them separate ones and buy a second vendor call
   * for a difference the vendor never saw.
   */
  requestedDeadlineMs?: number,
): Promise<ResolveOutcome> {
  // The boundary, and it is here because this is the single place tools reach the registry
  // (`interfaces.md` §5.4.5). The registry keeps its own `Math.min` as a backstop; both read
  // `capabilityManifests`, so the boundary and the backstop cannot disagree about the ceiling.
  //
  // **`shareable` is NOT enforced here, and the task that shipped it named this file** (014-31
  // part 2). Being the single funnel is not enough: this function is ABOVE the cache, and both
  // cache legs live inside `registry.resolve()`. A check here could refuse the call; it could not
  // make the call uncached. The rule is applied in `core/src/adapters/registry.ts`, where the
  // manifest row is already validated and one binding covers all six cache call sites
  // (`interfaces.md` §5.4.6, OD-014-31-4).
  let requestedDeadlineAtMs: number | undefined;
  if (requestedDeadlineMs !== undefined) {
    const declared = capabilityManifests[capability]?.deadlineMs;
    const refusal =
      declared === undefined
        ? new CapabilityManifestMissingError(capability)
        : requestedDeadlineMs > declared
          ? new DeadlineWideningRefusedError(capability, requestedDeadlineMs, declared)
          : undefined;
    // AC-12's second half: the call is NOT STARTED. The refusal is returned before `resolve()`, so
    // no adapter is entered, no cache slot is read and no credit can be reserved.
    if (refusal !== undefined) {
      return { ok: false, reason: refusal.message, refusalClass: refusal.name };
    }
    // Converted from OUR clock, once. A duration on the wire and a moment in the registry is the
    // whole reason this conversion exists rather than a pass-through.
    requestedDeadlineAtMs = Date.now() + requestedDeadlineMs;
  }

  try {
    const resolution = await registry.resolve(capability, chain, args, requestedDeadlineAtMs);
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
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      // A non-Error throw is recorded as such rather than as an empty class: the column is NOT NULL,
      // and a row saying "some refusal" is not the same claim as a row naming what refused.
      refusalClass: error instanceof Error ? error.name : 'NonErrorThrow',
    };
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
