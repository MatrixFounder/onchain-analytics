import { PassthroughCacheStore } from './cache-store.js';
import type { CacheGetResult, CacheStore } from './cache-store.js';
import { policyClasses, type PolicyPredicate } from './policy.js';
import type { CapabilityRoute, ProviderAdapter } from './types.js';
import { deriveArgsHash } from '../net/args-hash.js';
import { NEGATIVE_TTL_SECONDS } from '../cache/ttl.js';
import { capabilityManifests, type CapabilityManifest } from '../capability-manifest.js';
import { createCoverage, type Coverage } from '../chain/coverage.js';
import { loadChainRegistry } from '../chain/registry.js';
import type { ChainRegistry } from '../chain/registry-core.js';
import { CapabilityNotCoveredOnChainError } from '../chain/errors.js';
import { DeadlineExceededError } from '../net/safe-fetch.js';

/** One failed/unavailable attempt recorded while walking a route's `adapterIds` (R-24). */
export interface CapabilityAttempt {
  adapterId: string;
  reason: string;
}

/**
 * Thrown when every adapter in a route's `adapterIds` was unavailable or failed (R-24/R-11) — or
 * when no route exists at all for `(capability, chain)`. Callers (future MCP tool handlers, tasks
 * 003-6/003-7) turn this into an explicit `isError: true` tool response — never a silent empty
 * result (ARCHITECTURE.md §9.1).
 */
export class CapabilityUnavailableError extends Error {
  readonly capability: string;
  /** Widened from the closed `Chain` enum to `string` in TASK-006 (task 006-4): the engine's chain
   * vocabulary now lives in the registry, not in a type literal. */
  readonly chain: string;
  readonly tried: CapabilityAttempt[];

  constructor(details: { capability: string; chain: string; tried: CapabilityAttempt[] }) {
    const triedText = details.tried.length
      ? details.tried.map((t) => `${t.adapterId} (${t.reason})`).join(', ')
      : 'no route registered for this capability/chain';
    super(
      `capability unavailable: ${details.capability} on ${details.chain} — tried: ${triedText}`,
    );
    this.name = 'CapabilityUnavailableError';
    this.capability = details.capability;
    this.chain = details.chain;
    this.tried = details.tried;
  }
}

/**
 * The THIRD outcome of a capability traversal (ADR-002 D4, R-145, task 012-8): our own time budget
 * is spent. Deliberately a sibling of `CapabilityUnavailableError` rather than a subclass — the
 * distinction is the entire requirement, and `instanceof CapabilityUnavailableError` answering
 * `true` for this class would erase it at every call site that already handles the older one.
 *
 * The three outcomes state three different facts, and a caller acts differently on each:
 *
 * | Class                              | Fact                                    | What the caller should do |
 * | ---------------------------------- | --------------------------------------- | ------------------------- |
 * | `CapabilityNotCoveredOnChainError` | this pair is not served, permanently    | stop asking               |
 * | `CapabilityUnavailableError`       | every source failed or declined         | retry later               |
 * | `CapabilityDeadlineExceededError`  | WE ran out of time; sources may be fine | retry with more time      |
 *
 * **OD-4 — expiry ALWAYS throws, and that is why this class carries `tried[]` instead of data.**
 * The alternative considered (and rejected by the owner, 2026-08-03) was to return the
 * truthful-but-unsatisfying answer of whoever DID reply before the clock ran out. "Nansen was not
 * asked" and "Nansen answered: no labels" are different statements about a sanctioned address, and
 * publishing the second when the first is true is the H-1 defect wearing a deadline's clothes. So
 * `tried[]` names BOTH groups — who answered (and with what) before the moment passed, and who was
 * never attempted at all — and no partial result is ever returned.
 */
export class CapabilityDeadlineExceededError extends Error {
  readonly capability: string;
  readonly chain: string;
  readonly tried: CapabilityAttempt[];

  constructor(details: { capability: string; chain: string; tried: CapabilityAttempt[] }) {
    // Same rendering as `CapabilityUnavailableError`'s, with a different EMPTY-list wording: an
    // empty `tried` here does not mean "no route registered" (that outcome throws the other class);
    // it means the caller's own deadline had already passed when the call arrived, so there was
    // nothing to attempt.
    const triedText = details.tried.length
      ? details.tried.map((t) => `${t.adapterId} (${t.reason})`).join(', ')
      : 'no source was attempted — the requested deadline had already passed';
    super(
      `capability deadline exceeded: ${details.capability} on ${details.chain} — tried: ${triedText}`,
    );
    this.name = 'CapabilityDeadlineExceededError';
    this.capability = details.capability;
    this.chain = details.chain;
    this.tried = details.tried;
  }
}

/**
 * Thrown by the `CapabilityRegistry` CONSTRUCTOR (validation step 1, task 012-4) when a route names
 * a capability with no row in the manifest table (ADR-002 D3, R-136).
 *
 * **Construction, not `resolve()`, is deliberate.** A missing manifest is a configuration defect,
 * and a lazy check would surface it on the first call of that one capability — in production,
 * possibly months later, and only for whoever asked for it. Failing at construction means the
 * process that owns the misconfigured table cannot start (`mcp-server`'s entry point), which is the
 * same discipline `assertValidAdapterRegistrations()` (task 012-2) applies to registrations.
 */
export class MissingCapabilityManifestError extends Error {
  readonly capability: string;

  constructor(capability: string) {
    super(
      `no capability manifest for '${capability}' — every routed capability needs a row in ` +
        `src/capability-manifest.ts (shape + ttlSeconds + deadlineMs, ADR-002 D3)`,
    );
    this.name = 'MissingCapabilityManifestError';
    this.capability = capability;
  }
}

/**
 * Thrown by the `CapabilityRegistry` CONSTRUCTOR (validation step 1, adversarial cycle 2 F-8) when a
 * manifest row EXISTS but carries a `deadlineMs` no arithmetic can use.
 *
 * **Its own class, not a reuse of `MissingCapabilityManifestError`.** "There is no row" and "the row
 * is unusable" send a reader to two different places — the route table versus the manifest — and the
 * message that fits one is a wrong lead for the other.
 *
 * **Why the check exists at all.** `resolve()` guards the CALLER's `requestedDeadlineAtMs` with
 * `Number.isSafeInteger` and records the harm in place: `Math.min(a, NaN)` is `NaN`, `NaN <= 0` is
 * `false`, and every later comparison then silently never fires. `manifest.deadlineMs` enters the
 * SAME `Math.min` and was not checked at all — the identical defect, one argument to the left, and
 * reachable without any caller at all (a hand-edited table, a JSON-shaped config, a future
 * generated manifest).
 *
 * The value is rendered with `String(...)` rather than interpolated: a `deadlineMs` that arrived
 * through a cast can be any type, and `String` states what was there for every one of them.
 */
export class InvalidCapabilityManifestError extends Error {
  readonly capability: string;
  readonly field: string;

  constructor(capability: string, field: string, value: unknown) {
    super(
      `capability manifest for '${capability}' has an unusable ${field}: ${String(value)} — it must ` +
        `be a positive safe integer (src/capability-manifest.ts, ADR-002 D3/D4)`,
    );
    this.name = 'InvalidCapabilityManifestError';
    this.capability = capability;
    this.field = field;
  }
}

/**
 * Thrown by the `CapabilityRegistry` CONSTRUCTOR (validation step 2, task 012-6) when a route's
 * `policy.kind` names no class in `adapters/policy.ts`'s dictionary (ADR-002 D2, R-135).
 *
 * **Names BOTH the capability and the `kind`.** A message carrying only one of them sends the
 * reader either to a route table to guess which entry, or to a class dictionary to guess which
 * route wanted the missing name; the pair is what makes the diagnostic a single lookup.
 *
 * Construction, not `resolve()`, for the same reason as `MissingCapabilityManifestError` above: a
 * `kind` that resolves nowhere is a configuration defect, and a lazy check would surface it on the
 * first call of that one capability — in production, possibly months after the deploy, and only for
 * whoever happened to ask for it (UC-2).
 */
export class UnregisteredPolicyClassError extends Error {
  readonly capability: string;
  readonly kind: string;

  constructor(capability: string, kind: string) {
    super(
      `route '${capability}' names an unregistered policy class '${kind}' — every route policy ` +
        `must resolve against the class dictionary in src/adapters/policy.ts (ADR-002 D2)`,
    );
    this.name = 'UnregisteredPolicyClassError';
    this.capability = capability;
    this.kind = kind;
  }
}

/**
 * Thrown by the `CapabilityRegistry` CONSTRUCTOR (validation step 3, task 013-2, R-183, UC-20) when
 * a route activates merging (`route.merge === true`) for a capability whose manifest row — the SAME
 * row validation step 1 already found — does not declare `mergeable: true`.
 *
 * **Two independent axes, one gate.** `CapabilityRoute.merge` (013-2, this task) TURNS ON merging
 * per route; `capabilityManifests[capability].mergeable` (013-1) declares a capability's results
 * ELIGIBLE to be merged in the first place. Neither implies the other in the type system — a route
 * can activate merging for a capability nobody ever declared eligible, and this class is what
 * refuses to build when that happens, exactly the failure UC-20 names: "activation молча включает
 * слияние для способности, для которой оно никогда не было объявлено допустимым" (activation
 * silently turns merging on for a capability it was never declared valid for).
 *
 * **Names BOTH the capability and the missing eligibility**, the same "one lookup" diagnostic
 * discipline as `UnregisteredPolicyClassError` right above: a message naming only the capability
 * sends the reader to `capability-manifest.ts` to guess which field is missing.
 *
 * **Construction, not `resolve()`**, for the same reason as every sibling validation error in this
 * file: an inconsistency between a route's activation and its capability's eligibility is a
 * configuration defect, and a lazy check would surface it on the first merged request — in
 * production, possibly months after the deploy that introduced it.
 *
 * **A route broken by BOTH `policy.kind` (step 2) and `merge` (step 3) is reported by step 2's
 * `UnregisteredPolicyClassError` first.** This is a deterministic tie-break, not a claim that one
 * defect matters more: the constructor runs three SEPARATE sequential loops over `this.routes` (see
 * the constructor's own overview comment), and step 2's loop throws on the offending route before
 * step 3's loop ever starts — the identical mechanism that already orders step 1 ahead of step 2.
 */
export class MergeEligibilityNotDeclaredError extends Error {
  readonly capability: string;

  constructor(capability: string) {
    super(
      `route '${capability}' activates merge (route.merge === true), but its capability manifest ` +
        `does not declare 'mergeable: true' on the matching set|series row — merge activation ` +
        `requires manifest eligibility to be declared first, in src/capability-manifest.ts ` +
        `(T-013, tasks 013-1/013-2, R-183)`,
    );
    this.name = 'MergeEligibilityNotDeclaredError';
    this.capability = capability;
  }
}

/**
 * Marker for a NEGATIVE cache entry (issue L-1): a record that this exact `(provider, capability,
 * argsHash)` produced a deterministic `normalize()` failure, so the next identical call can fail
 * the same way **without paying for the vendor response again**.
 *
 * Why this exists at all: `resolve()` caches only after `normalize()` returns, so every throw
 * there discarded an already-PAID response — nothing cached, the adapter recorded as failed, the
 * agent's retry paying full price for a response that will be rejected identically. On Nansen that
 * is 10cr per `smart-money.flows` attempt and 100cr for the exhaustive `entity.labels` tier, on a
 * loop with no exit. The mechanism cost 35 real credits to discover (see `docs/issues/df-1-*.md`).
 *
 * Only `normalize()` failures are cached, never `fetch()` failures — see `resolve()` for why that
 * line is where it is.
 *
 * `expiresAtMs` is carried IN the entry rather than left to the store. The two-level store promotes
 * a cold hit into its hot layer using `ttlFor(capability)`, which for a negative entry is the wrong
 * (much longer) number; checking the timestamp here makes the expiry correct regardless of what any
 * layer decides to do with it.
 */
interface NegativeCacheEntry {
  __onchainNegative: true;
  reason: string;
  expiresAtMs: number;
}

function isNegativeEntry(value: unknown): value is NegativeCacheEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __onchainNegative?: unknown }).__onchainNegative === true
  );
}

/**
 * The minimal structural shape the MERGE walk (T-013, task 013-4, R-161/R-167) reads from one
 * element of a `set`/`series` capability's result — the same three field names the canonical
 * `Snapshot` schema (`types/snapshot.ts`) carries for them, read STRUCTURALLY rather than by
 * importing that domain type: `resolve()` stays provider-agnostic (every `normalize()` result is
 * `unknown` here, same as everywhere else in this file), and the dedup key touches only these
 * three fields — `valueRaw`/`source`/`height`/`valueNum` ride along inside the stored point,
 * untouched and unread (TC-INT-03). `ts` is the point's own epoch-ms field, never derived from
 * `valueRaw` — the two are unrelated fields on the same point.
 *
 * **`ts` here is the point's OWN field, read but never rewritten — the dedup KEY buckets it
 * (`MERGE_DEDUP_BUCKET_MS`, `mergeInto` below); the stored point does not.** See the owner decision
 * this corrects (F-0, `docs/architectures/open-questions.md` "T-013 task 013-4"): exact-`ts`
 * equality was the original R-161 reading, and it cannot fire between the two real participants —
 * `pg-history` reads back the n8n snapshotter's wall-clock write time
 * (`adapters/pg-history/index.ts`'s `toFiniteNumber(row.ts)`, sourced from
 * `n8n-workflows/exported/onchain-snapshotter.json`'s `Normalize` node, `const fetchTs =
 * Date.now();`), while `platform-explorer` reports the VENDOR's own history label
 * (`adapters/platform-explorer/index.ts`'s `Date.parse(timestamp)`) — two different clocks for the
 * "same" hour.
 */
interface MergePoint {
  metric: string;
  asset: string;
  ts: number;
}

/**
 * The width of the merge dedup KEY's time bucket (F-0, owner decision 2026-08-07) — one hour,
 * mirroring the persistence layer's OWN convention for the identical reason: the n8n snapshotter's
 * `ts_bucket = floor(ts/3600000)*3600000` (`CLAUDE.n8n.md`) and the Postgres `snapshots` table's own
 * dedup key, `UNIQUE ... ON CONFLICT (source, asset, metric, ts_bucket)` — never raw `ts`. The DB
 * buckets for exactly the reason this key now does: two sources can legitimately disagree, by
 * seconds to minutes, on the exact millisecond that names "this hour's" observation, and `UC-11`'s
 * one-point-per-hour promise has to survive that disagreement. A named constant, not a bare literal,
 * so a reader (or a mutation) sees ONE number rather than a `3_600_000` that could be a typo of
 * `dayBucketMs`'s `86_400_000` (`cache/day-bucket.ts`) — deliberately NOT that shared helper: this
 * bucket is a MERGE-DEDUP concept (one call site today), `dayBucketMs` is a BUDGET-LEDGER concept,
 * and the two happen to want the same arithmetic shape for unrelated reasons.
 */
const MERGE_DEDUP_BUCKET_MS = 3_600_000;

/**
 * Structurally validates and narrows one array element from a participant's `normalize()` result
 * into a `MergePoint` — or refuses it (M-3, fix pass 2026-08-07, `docs/architectures/open-
 * questions.md` "T-013 task 013-4"). Before this guard existed, `mergeInto` built its key by
 * template-string interpolation with no validation at all: a point missing `metric`/`asset`/a
 * finite `ts` coerced into the literal key `"undefined\0undefined\0undefined"`, so every malformed
 * point from every participant collided on that ONE key and exactly one of them "survived" the
 * merge — a probe fed three `{address, label}`-shaped objects (a different capability's own point
 * shape entirely) through this path and only one came back. **Refuses rather than guesses**,
 * CLAUDE.md's own rule for the derived-metric path: a point that fails this check is dropped, never
 * merged, and never silently coerced into looking valid. `ts: "1700…"` (a string) and `ts: 1700…`
 * (a number) are deliberately NOT treated as equivalent — the same reason `Number.isFinite`, not a
 * looser `!Number.isNaN(Number(...))`, decides it.
 */
function asMergePoint(value: unknown): MergePoint | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { metric, asset, ts } = value as Record<string, unknown>;
  if (typeof metric !== 'string' || typeof asset !== 'string') return undefined;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return undefined;
  return { metric, asset, ts };
}

/** `CapabilityRegistry.resolve()`'s return shape (ARCHITECTURE.md §2.1/§5.2/§9.1). */
export interface CapabilityResolution {
  result: unknown;
  source: string;
  cache: 'hit' | 'miss';
  ageMs?: number;
  /**
   * Adapter ids whose `fetch()` this traversal actually ENTERED, in walk order — including the one
   * that answered, and including any that threw (adversarial cycle 2, F-4).
   *
   * **`source` is who ANSWERED; this is who was ASKED, and on this route they differ.** The walk
   * enters a paid adapter and can still return an earlier adapter's answer: that is the semantics of
   * `unsatisfying ??=` below (a truthful-but-unsatisfying free answer is kept and returned when the
   * paid source turns out to have nothing either). `mcp-server`'s `_meta.budget` used to be derived
   * from `source` alone, so an `entity.labels` miss that cost credits at `nansen` and came back
   * labelled `blockscout` reported no spend at all — the under-reporting direction, which invites the
   * agent to repeat a call it believes is free (R-41).
   *
   * **Deliberately NOT filtered by tier here.** `tier` lives on `AdapterRegistration` (ADR-002 D8)
   * and this class is constructed from an INJECTED adapters map that need not correspond to
   * `providers.config.ts` at all — reading the global registration table inside `resolve()` would
   * contradict this class's own "routes and adapters are constructor parameters" contract and give
   * the classification a second home. The registry states the traversal FACT; the one consumer that
   * cares about paidness applies the classification where it already lives
   * (`mcp-server/src/tools/budget-meta.ts`).
   *
   * **Omitted when empty** (a pure cache hit reached no adapter's `fetch()`), for the same reason
   * `ageMs` is omitted on a miss rather than coerced: an absent field says "nothing happened here",
   * an empty array invites the reader to look for a meaning it does not have.
   */
  attempted?: string[];
  /**
   * How far past `effectiveDeadlineAtMs` this answer was produced, in ms — present ONLY when it is
   * positive (OQ-T012-6, owner decision 2026-08-05).
   *
   * **The call deadline bounds SPENDING, not answering, and this field is the price of saying so.**
   * A walk in which every source was entered and every one answered can cross the ceiling on its
   * last adapter: nothing was prevented and nothing was aborted, so neither the pre-check nor the
   * translating catch fires, and the H-1 return hands back a complete answer late. The owner
   * resolved that in favour of returning it — discarding data already paid for buys the caller
   * nothing, and only the caller knows whether a late-but-complete answer is still worth something.
   *
   * What the decision does NOT permit is returning it **silently**. That is the shape this project
   * has ruled against repeatedly (a healed metric that hides the vendor gap; a diagnostic nothing
   * reads), and a caller that reads `deadlineMs` as a latency contract would never learn otherwise.
   * So the overrun travels with the answer and `mcp-server` publishes it as `_meta.timing`.
   *
   * Measured at the moment of RETURN, against the same `effectiveDeadlineAtMs` the walk enforced —
   * not against `manifest.deadlineMs`, which ignores a caller's own narrowing (R-144).
   */
  deadlineOverrunMs?: number;
  /**
   * Contributors on a MERGE-ENABLED walk (T-013, task 013-3, R-174(a)) — participant ids whose
   * points are actually present in `result`, NOT every participant who merely answered. The
   * distinction is the field's whole reason to exist: on the ordinary composition where
   * `platform-explorer` answers `[]` and `pg-history` returns 40 points, an "answered" reading
   * would include a participant that contributed none of `result`'s own data.
   *
   * **Declared here (013-3); populated by the merge walk (013-4) — this task never sets it.** The
   * 18 non-merge capabilities never carry this field, on a cache hit or a fresh answer alike, and
   * their `resolve()` return shape is byte-identical to before this task (R-174d).
   *
   * Omitted when empty, the same idiom `attempted`/`deadlineOverrunMs` above already follow: this
   * happens when every participant of a merge walk answered with zero points, so `result` is an
   * empty array and nobody contributed to it.
   */
  sources?: string[];
  /**
   * Participants NOT reflected in `result` on a merge-enabled walk (R-174(b)), each with why —
   * "not asked" (skipped before `fetch()`: chain-scoped skip, no adapter registered,
   * `isAvailable()` false) or "asked, did not answer" (`fetch`/`normalize` threw). Positive-only,
   * by the SAME idiom `deadlineOverrunMs` above already uses: absent when empty, never an empty
   * array — a caller must not have to distinguish "nobody was missing" from "the field forgot to
   * mention who".
   *
   * **Declared here (013-3); populated by the merge walk (013-5) — this task never sets it.**
   * Present only on a merge-enabled walk; the 18 non-merge capabilities never carry it.
   *
   * **Independent of `sources`/`perSourceCache`, not coupled to either (roast round 1, B-2).** An
   * earlier draft of this docstring said "present only alongside `sources`/`perSourceCache`", which
   * over-claimed a coupling `resolveCapability()`'s passthrough never enforces — each of the three
   * fields is forwarded on its OWN `!== undefined` check. R-164 branch (a) (every participant
   * answered, none contributed) is the concrete case where the over-claim would have been read as a
   * guarantee: `sources` is correctly omitted, while `missingSources` and `perSourceCache` may each,
   * independently, be present or absent depending on what the walk actually observed.
   */
  missingSources?: { adapterId: string; reason: string }[];
  /**
   * One entry per participant that ANSWERED on a merge-enabled walk — deliberately NOT filtered to
   * `sources` (contributors only). A participant that answers with an empty array, from cache or
   * fresh, contributes no point and is therefore correctly absent from `sources` — but its cache
   * status is a fact about the ANSWER, not about the contribution (R-174(c)): a narrower,
   * contributors-only reading would drop that participant from `perSourceCache` too, and a walk
   * where one participant served from cache and another from the network would report only the
   * second, losing the very fact R-174(c) exists to keep. Full argument, and the composition on
   * which the narrower reading loses the fact, recorded in `docs/architectures/open-questions.md`
   * ("T-013 task 013-3") — this is a deliberate departure from an earlier, narrower architecture
   * reading, not an oversight.
   *
   * **Declared here (013-3); populated by the merge walk (013-4) — this task never sets it.**
   * Present only on a merge-enabled walk; the 18 non-merge capabilities never carry it.
   */
  perSourceCache?: { adapterId: string; cache: 'hit' | 'miss'; ageMs?: number }[];
}

/**
 * Routes `(capability, chain)` to an ordered list of adapters (D4/R-4/R-11) and returns only the
 * `normalize()`d canonical result — a raw provider DTO never reaches the caller (anti-corruption
 * layer, ARCHITECTURE.md §2.1).
 *
 * A factory, not a module singleton (ARCHITECTURE.md §8; task 003-2 reviewer note): callers
 * construct their own instance from their own `routes`/`adapters`/`cache`. `routes` and `adapters`
 * are both constructor parameters — not read from an internal import of `providers.config.ts` —
 * so tests can exercise routing/fallback with small, purpose-built route tables and mock adapters
 * instead of the full real 9-adapter M1 configuration (which future tasks 003-4/003-5/003-6 will
 * assemble once real adapters exist). This also keeps the door open for future multi-instance use
 * (§8) without a refactor.
 */
export class CapabilityRegistry {
  /** Built lazily and memoized per instance (never a module singleton, §8): the shipped registry
   * is ~458 rows, and constructing one per `CapabilityRegistry` in a test suite would be pure
   * waste when most tests never reach the coverage gate. */
  private coverageCache: Coverage | null = null;
  private chainsCache: ChainRegistry | null = null;
  /**
   * Each route's answer policy, resolved to a predicate ONCE at construction (task 012-6).
   *
   * **Keyed by the ROUTE OBJECT, not by capability.** One capability can be served by several
   * routes (`wallet.balances.native` already ships as two), and a map keyed by capability would
   * re-create the exact defect M-2 fixed in TASK-008: one route's policy judging another route's
   * adapters. `resolve()` reads this map inside the per-route loop that also collects that route's
   * `adapterIds`, so the pairing cannot come apart.
   */
  private readonly policies = new Map<CapabilityRoute, PolicyPredicate>();

  constructor(
    private readonly routes: CapabilityRoute[],
    private readonly adapters: Map<string, ProviderAdapter>,
    private readonly cache: CacheStore = new PassthroughCacheStore(),
    /** Chain registry used by the coverage gate (TASK-006 R-51). Defaults to the shipped snapshot
     * so production wiring cannot forget it; injectable so tests can use a synthetic registry. */
    private readonly chains: ChainRegistry | null = null,
    /**
     * Per-capability manifest (ADR-002 D3, task 012-4). Same injection seam as `chains` one
     * parameter to the left: the DEFAULT is the real shipped table, so production wiring cannot
     * forget it, and a test that routes a synthetic capability passes its own small map instead of
     * having to add a row to the production one.
     */
    private readonly manifests: Readonly<Record<string, CapabilityManifest>> = capabilityManifests,
  ) {
    // ------------------------------------------------------------------------------------------
    // CONSTRUCTION-TIME VALIDATION. The ORDER of its steps is fixed here, in the docstring, before
    // there is a second step to order — so that each requirement's negative test can break exactly
    // one thing:
    //
    //   step 1 — every route's capability has a manifest row, and that row's `deadlineMs` is a
    //            usable number                                    (task 012-4; the number, cycle 2 F-8)
    //   step 2 — every route's policy names a known policy class  (task 012-6)
    //   step 3 — every route with `merge: true` names a capability whose manifest row (the SAME row
    //            step 1 already found) declares `mergeable: true`  (task 013-2, R-183, UC-20)
    //
    // A test for step 2 written against a route whose capability ALSO lacks a manifest would fail
    // at step 1 and prove nothing about policies; stating the order is what makes that avoidable
    // rather than a coincidence of how the loops happen to be written. The same reasoning fixes step
    // 3 AFTER step 2: a route broken by both `policy.kind` and `merge` reports step 2's
    // `UnregisteredPolicyClassError`, and that is a deterministic tie-break stated here rather than
    // an accident of which `if` happens to be written first.
    //
    // The three steps are three SEPARATE loops, not one loop with three conditions: with a single
    // loop the order would hold per ROUTE (route #1's policy checked before route #2's manifest, or
    // route #1's merge eligibility before route #2's policy), and the ordering tests above and below
    // would pass or fail depending on which row the broken route occupies. Step 1's own two parts
    // (presence, then the number) DO share a loop, and must: there is no row to validate until it is
    // known to exist, so per-route ordering is the only ordering they can have.
    //
    // **`Object.hasOwn`, never `=== undefined` on the index (adversarial cycle 2, F-8).** Both
    // dictionaries are plain object literals, so `manifests['constructor']`, `['toString']`,
    // `['valueOf']` and `['hasOwnProperty']` answer with `Object.prototype`'s members instead of
    // `undefined` — a route named after one of them passed BOTH validations. Downstream that is
    // silent: `nowMs + (row as CapabilityManifest).deadlineMs` is `NaN`, and `Date.now() >= NaN` is
    // false at the per-adapter pre-check AND at the terminal branch, so the deadline for that
    // capability is simply switched off; on the policy side `policyClasses['constructor']` resolves
    // to `Object`, `UnregisteredPolicyClassError` never fires, and the route's answer policy
    // fail-opens to "everything satisfies" — H-1 disabled by a name. Step 3 (below) applies the same
    // `Object.hasOwn` discipline to its own manifest re-lookup, for the identical reason.
    // ------------------------------------------------------------------------------------------
    for (const route of this.routes) {
      const manifest = Object.hasOwn(this.manifests, route.capability)
        ? this.manifests[route.capability]
        : undefined;
      if (manifest === undefined) {
        throw new MissingCapabilityManifestError(route.capability);
      }
      // The number, checked with the SAME test `resolve()` already applies to the CALLER's requested
      // deadline (`Number.isSafeInteger`) — the two feed the same `Math.min`, and only one of them
      // was guarded. A `NaN`/`Infinity`/string `deadlineMs` poisons that `min` exactly as a
      // malformed request would, and `> 0` is added because a zero or negative budget makes every
      // adapter unreachable while reading like a configured value.
      if (!Number.isSafeInteger(manifest.deadlineMs) || manifest.deadlineMs <= 0) {
        throw new InvalidCapabilityManifestError(
          route.capability,
          'deadlineMs',
          manifest.deadlineMs,
        );
      }
    }

    for (const route of this.routes) {
      if (route.policy === undefined) continue; // absence IS `{ kind: 'any' }`
      // `Object.hasOwn` first — see the F-8 note above: a plain index lookup finds `Object`'s own
      // inherited members and fail-opens the route's policy.
      const build = Object.hasOwn(policyClasses, route.policy.kind)
        ? policyClasses[route.policy.kind]
        : undefined;
      if (build === undefined) {
        throw new UnregisteredPolicyClassError(route.capability, route.policy.kind);
      }
      // Resolved ONCE, per route, and cached — `resolve()` is on the request path and re-reading a
      // descriptor per answer would buy nothing. It also means a class whose construction throws
      // takes down the build rather than a request.
      this.policies.set(route, build(route.policy));
    }

    // step 3 (task 013-2, R-183, UC-20) — merge ACTIVATION vs merge ELIGIBILITY. `route.merge` is
    // the per-ROUTE switch 013-2 adds (`CapabilityRoute.merge`'s own docstring); `manifest.mergeable`
    // is the per-CAPABILITY fact 013-1 already declared. The two are independent axes on purpose —
    // this step refuses the one combination where a route turns merging ON for a capability nobody
    // ever declared eligible for it.
    //
    // Its OWN loop, run AFTER step 2's completes — see the constructor's overview comment above for
    // why: three SEQUENTIAL loops over `this.routes` are what make the step-2-reports-first
    // tie-break deterministic rather than accidental.
    //
    for (const route of this.routes) {
      if (route.merge !== true) continue; // absence/false: step 3 is inert on an unactivated route
      // `Object.hasOwn` — see the F-8 note above: step 1 already guarantees this lookup finds a
      // row for every route in `this.routes` (this loop cannot run until step 1's has completed
      // without throwing), but the lookup is repeated rather than trusted with a `!` assertion.
      const manifest = Object.hasOwn(this.manifests, route.capability)
        ? this.manifests[route.capability]
        : undefined;
      // `manifest.shape !== 'point'` is checked EXPLICITLY, not left to the type-level `'mergeable'
      // in manifest` narrowing alone. `mergeable` is not a field of the `point` branch at the TYPE
      // level (`capability-manifest.ts`) — true for a literal built inside this file — but
      // `manifests` is CONSTRUCTOR-INJECTED (the same F-8 threat model as the `Object.hasOwn`
      // lookup two lines up: a cast, a JSON-shaped config, a hand-edited table), and `in` is a pure
      // RUNTIME property check that cannot see what `shape` claims. Without this line, a malformed
      // row carrying both `shape: 'point'` and a stray `mergeable: true` would read eligible. With
      // it, TC-INT-01's claim — a `point` row can never read `true` here — holds unconditionally,
      // not merely for a manifest the compiler happened to see as a literal.
      const eligible =
        manifest !== undefined &&
        manifest.shape !== 'point' &&
        'mergeable' in manifest &&
        manifest.mergeable === true;
      if (!eligible) {
        throw new MergeEligibilityNotDeclaredError(route.capability);
      }
    }
  }

  /**
   * The coverage matrix derived from THIS registry's routes and adapters (TASK-006 R-51/R-52).
   *
   * Public because `onchain_list_chains` answers "where is this capability available" and must do
   * so from the same two sources the gate uses — a tool building its own matrix could disagree
   * with the engine that will actually serve the call.
   */
  getCoverage(): Coverage {
    this.coverageCache ??= createCoverage({
      routes: this.routes,
      adapters: this.adapters,
      chains: this.getChainRegistry(),
    });
    return this.coverageCache;
  }

  /** The chain registry this instance resolves against (injected, or the shipped snapshot). */
  getChainRegistry(): ChainRegistry {
    this.chainsCache ??= this.chains ?? loadChainRegistry();
    return this.chainsCache;
  }

  /**
   * Routes `(capability, chain)` to an ordered adapter list and returns only the `normalize()`d
   * canonical result (ARCHITECTURE.md §3.2/§9.1 + task 003-2 reviewer note — the exact contract):
   *
   * 1. Find every route matching `capability` (chain narrowing happens per-adapter, step 2, via
   *    `chainSupport()` — task 012-1, OQ-C). No match → `CapabilityUnavailableError` with an empty
   *    `tried` list (no route registered).
   * 2. Walk `route.adapterIds` in order (priority + fallback, R-11):
   *    - No `ProviderAdapter` registered for that id in the constructor-injected `adapters` Map →
   *      treated exactly like an unavailable adapter (skip-to-next, `providers.config.ts`'s own
   *      documented contract for ids with no real adapter yet, tasks 003-4/003-5).
   *    - `adapter.isAvailable?.()` reports `{ok: false}` → record the reason, skip-to-next.
   *    - Otherwise check `cache.get(adapter.id, capability, argsHash)` (keyed the same way as the
   *      `cache_entries` UNIQUE constraint, §4.2) — a hit returns immediately with `cache: 'hit'`
   *      and the stored `ageMs`, without calling `fetch`/`normalize` at all.
   *    - Cache miss → `fetch(capability, args)` → `normalize(capability, raw)` → `cache.set(...)`
   *      → return `{cache: 'miss'}`. A throw from either `fetch` or `normalize` is caught, recorded
   *      as a `tried` entry, and moves on to the next `adapterId` — never fails the whole call.
   * 3. Every adapter in the route unavailable/failed → `CapabilityUnavailableError` with the full
   *    `tried` list (R-24 explicit degradation, never a silent empty result).
   *
   * Anti-corruption layer: only the `normalize()` result is ever returned — the raw provider DTO
   * from `fetch()` never leaves this method.
   *
   * **Cache-fault contract (adversarial cycle 1, findings A1/A2) — cache errors are ALWAYS
   * best-effort, never fatal:** a faulty/misbehaving `CacheStore` must never turn an otherwise
   * successful `fetch`/`normalize` into a `CapabilityUnavailableError`, and must never abort the
   * whole `resolve()` call. Concretely:
   * - A throw from `cache.get(...)` is caught, logged to stderr (one line, no args/secret values),
   *   and treated exactly like a cache MISS — `resolve()` falls straight through to `fetch`.
   * - A throw from `cache.set(...)` is caught in its OWN try/catch, nested inside the
   *   `fetch`/`normalize` try block (never sharing that block's catch) — it is logged to stderr and
   *   otherwise ignored; the already-fetched/normalized `result` is still returned as a `'miss'`.
   *
   * This is a DIFFERENT contract from the `fetch`/`normalize` catch above: a `fetch`/`normalize`
   * failure means "this adapter couldn't answer, try the next one" (recorded in `tried`); a cache
   * failure means "the cache itself is unwell, but the adapter it wraps answered fine" — the cache
   * is a pure side channel and is never allowed to fail the call it's merely trying to memoize.
   *
   * **The call deadline (ADR-002 D4, task 012-8) — a THIRD outcome, never a partial answer.**
   * `requestedDeadlineAtMs` is the caller's own ask; it can only NARROW the capability manifest's
   * `deadlineMs`, never widen it (R-144), and `effectiveDeadlineAtMs = min(now + manifest.deadlineMs,
   * requested ?? Infinity)` is computed ONCE and passed unchanged to every `fetch()` of the walk.
   * Two malformed shapes are separated deliberately (see the computation below): a value that is not
   * a safe integer is read as ABSENCE, while a well-formed moment already in the past is an
   * immediate `CapabilityDeadlineExceededError` with an empty `tried`.
   *
   * Once the moment passes, the walk refuses every source it has not yet reached — free, with no
   * `fetch()` and no cache read — and ends in `CapabilityDeadlineExceededError`, whose `tried[]`
   * names BOTH groups: who answered (and with what) before the clock ran out, and who was never
   * asked at all. It NEVER returns the truthful-but-unsatisfying answer of the first group instead
   * (OD-4): "Nansen was not asked" and "Nansen answered: no labels" are different statements about
   * a sanctioned address, and only one of them is true.
   */
  async resolve(
    capability: string,
    chain: string,
    args: Record<string, unknown>,
    requestedDeadlineAtMs?: number,
  ): Promise<CapabilityResolution> {
    const tried: CapabilityAttempt[] = [];
    const chainInfo = this.getChainRegistry().tryResolve(chain);

    // TASK-006 (task 006-5): ALL routes for the capability contribute their adapters, in
    // declaration order. Before TASK-006, a single `find()` picked the first route and a route-level
    // `chains` literal was what separated e.g. `wallet.balances.native` → `rpc-evm` from the same
    // capability → `rpc-solana`. TASK-006 moved that separation into `chainSupport()`, per ADAPTER
    // (below) — an adapter that cannot serve the chain is skipped there, so the route-level literal
    // became redundant the moment a predicate existed for the same distinction.
    //
    // task 012-1 (OQ-C): the literal itself is now gone. An audit of all 21 production routes in
    // `providers.config.ts` found none setting it, and the two mechanisms agreeing was exactly the
    // risk — nothing forced them to keep agreeing on a future route. One mechanism now decides chain
    // coverage: `chainSupport()`, checked below per adapter.
    const matching = this.routes.filter((candidate) => candidate.capability === capability);

    if (matching.length === 0) {
      throw new CapabilityUnavailableError({ capability, chain, tried });
    }

    // ------------------------------------------------------------------------------------------
    // THE CALL DEADLINE (ADR-002 D4, R-140/R-144, task 012-8) — computed ONCE, here, and threaded
    // UNCHANGED into every `adapter.fetch()` below. The same "fix it and pass it" discipline the
    // budget gate applies to `dayBucketMs`: re-deriving it per adapter would hand each one a fresh
    // full budget, which is exactly what carrying an ABSOLUTE moment rather than a duration exists
    // to make unrepresentable (a moment forwards itself; a duration is re-granted by whoever
    // forwards it).
    //
    // POSITION, relative to GATE 2 (coverage) below: above it, deliberately. The refusal for an
    // already-spent caller deadline is specified as IMMEDIATE with `tried: []`, and the coverage
    // gate is not free on a cold instance — `getCoverage()` builds the matrix over the 458-row chain
    // registry on first use. Work done to describe an answer we have already refused to give is
    // work the caller cannot observe and did not ask for. (The reverse order was considered: it
    // would prefer the PERMANENT verdict "this pair is never served" over the temporal one. It was
    // rejected because "immediate" is the specified contract for this branch, and because the
    // caller who sent an expired deadline learns nothing actionable from a coverage fact it had no
    // time to use.)
    // ------------------------------------------------------------------------------------------
    // `Object.hasOwn` for the same reason the constructor uses it (cycle 2, F-8): a bare index finds
    // `Object.prototype`'s members, and `nowMs + undefined` is `NaN`, which turns every later
    // deadline comparison false instead of failing.
    const manifest = Object.hasOwn(this.manifests, capability)
      ? this.manifests[capability]
      : undefined;
    if (manifest === undefined) {
      // Unreachable via a routed capability: construction validated a manifest row for EVERY route
      // (step 1), and `matching` is non-empty by the check above. Stated rather than asserted away
      // with a `!`, because `manifests` is constructor-injected — a caller can hand in a map that
      // disagrees with its own routes, and this is the same diagnostic construction would give.
      throw new MissingCapabilityManifestError(capability);
    }

    // ONE clock sample for the whole decision — the validation, the refusal and the `min()` all
    // read it, so they cannot disagree about what "now" was (the discipline `throttle()` already
    // follows for refill/spend/refuse).
    const nowMs = Date.now();
    // L-1, FORM 1 — a value that is not a safe integer (`NaN`, a string arriving through a cast,
    // `±Infinity`) is read as ABSENCE. The harm of leaving it unguarded is not a wrong deadline but
    // an inert one: `Math.min(a, NaN)` is `NaN`, `NaN <= 0` is `false`, and every later comparison
    // then silently never fires. T-012's only caller is this engine, which passes nothing; the first
    // caller with any incentive to send a malformed value is T-014's paying client.
    const requested =
      requestedDeadlineAtMs !== undefined && Number.isSafeInteger(requestedDeadlineAtMs)
        ? requestedDeadlineAtMs
        : undefined;
    // L-1, FORM 2 — a WELL-FORMED moment that has already passed is an immediate typed refusal, and
    // deliberately not folded into form 1. "Absence" means the full manifest budget, i.e. strictly
    // MORE time than the caller asked for, and R-144 forbids widening in either direction — including
    // from "already out of time" to "no preference". (Clamping to `nowMs` was considered and
    // rejected: for one tick it makes an expired deadline behave exactly like an absent one.)
    // `tried: []` is the whole content of "immediate": no adapter was attempted, no cache slot was
    // read, and the error says so rather than listing sources that were never asked.
    if (requested !== undefined && requested <= nowMs) {
      throw new CapabilityDeadlineExceededError({ capability, chain, tried });
    }
    const effectiveDeadlineAtMs = Math.min(nowMs + manifest.deadlineMs, requested ?? Infinity);

    /**
     * The walk plan: each adapter paired with the answer policy of the route that CONTRIBUTED it.
     *
     * vdd-multi TASK-008 iteration 2 (M-2/M-3). The first version unioned every matching route's
     * `adapterIds` and then took the policy from whichever route happened to declare one first —
     * so a policy written for route B would silently judge route A's adapters, and a second route's
     * own policy would be dropped without a diagnostic. `wallet.balances.native` already ships as
     * two routes for one capability, so the multi-route shape is live; only the absence of a second
     * policy kept it inert. Pairing at plan time makes the trap unrepresentable.
     *
     * De-duplicated by adapter id, first route wins — the pre-existing `new Set(...)` semantics.
     *
     * task 012-6: what is paired is now the predicate RESOLVED from that route's descriptor at
     * construction (`this.policies`, keyed by the route object), instead of a literal function the
     * route carried. The pairing itself is unchanged — `policy` is read from `route` inside the
     * loop over `matching`, so an adapter can only ever be planned with the policy of the route
     * that contributed it.
     */
    const plan: { adapterId: string; policy?: PolicyPredicate }[] = [];
    const planned = new Set<string>();
    for (const route of matching) {
      const policy = this.policies.get(route);
      for (const adapterId of route.adapterIds) {
        if (planned.has(adapterId)) continue;
        planned.add(adapterId);
        plan.push({
          adapterId,
          ...(policy ? { policy } : {}),
        });
      }
    }

    /**
     * Whether THIS call runs the MERGE walk instead of the single-winner one below (T-013, task
     * 013-4, R-161/R-165/R-166/R-167/R-182) — true when at least one of `matching`'s routes carries
     * `merge: true`. A capability served by more than one route agreeing/disagreeing on `merge` is
     * explicitly out of scope (PLAN §0.5 item 5; no route-agreement check exists anywhere in this
     * tree), so `.some(...)` — not "the first matching route" or "every matching route" — is the
     * whole rule.
     *
     * Computed here, right after `plan`, but the branch itself sits BELOW GATE 2/`argsHash`: the
     * preceding order (`effectiveDeadlineAtMs` → `plan` → GATE 2) does not change for either path,
     * because the merge walk needs both exactly as much as the walk below does.
     */
    const mergeMode = matching.some((route) => route.merge === true);

    /**
     * Applies a route's answer policy, FAILING OPEN.
     *
     * iteration 2 (M-1): the predicate used to be called inside the same `try` that treats a throw
     * as a `normalize()` failure — so a bug in the ROUTE's policy was recorded as a defect of the
     * PROVIDER, negative-cached under the provider's key for 60 s, and its message travelled into
     * `tried[].reason` → the tool's isError text → the model. The cache-hit call site had the
     * opposite flaw: outside every `try`, so the same throw aborted `resolve()` untyped.
     *
     * Failing open restores the pre-policy behaviour, which is the only safe direction: a broken
     * policy must not be able to suppress a provider's real answer.
     *
     * task 012-6 changed WHAT is called here (a predicate resolved from the route's descriptor at
     * construction) and nothing else: same fail-open, same single stderr line, same verdict. A
     * policy CLASS that throws is a bug of this package rather than of a route literal, which makes
     * the guard more necessary, not less.
     */
    const satisfies = (
      policy: PolicyPredicate | undefined,
      value: unknown,
      adapterId: string,
    ): boolean => {
      if (!policy) return true;
      try {
        return policy(value);
      } catch (error) {
        process.stderr.write(
          `route policy for ${capability} threw on ${adapterId}'s answer: ${
            error instanceof Error ? error.message : String(error)
          } — treating the answer as satisfying\n`,
        );
        return true;
      }
    };

    /**
     * The first truthful-but-unsatisfying answer, kept so the walk can end with it rather than with
     * an outage. "No provider has labels for this address" is a fact, and turning it into a
     * `CapabilityUnavailableError` would tell the caller to retry something that cannot change.
     */
    let unsatisfying: CapabilityResolution | undefined;
    /**
     * Whether any adapter FAILED, as opposed to answering unsatisfyingly (iteration 2, H-1).
     *
     * The distinction is the whole correctness of the fallback. "Everyone answered and nobody had
     * labels" is a legitimate result. "The free source has nothing and the paid one could not be
     * asked" is an outage wearing that result's clothes — and the first version returned the second
     * as if it were the first, discarding `tried[]` on the way out. On a stock install with no
     * `NANSEN_API_KEY` that turned R-40's explicit `isError` into a confident "this address has no
     * entity labels", which on a mixer or sanctioned address is a false negative delivered with
     * full authority.
     */
    let hadFailure = false;
    /**
     * Whether the walk ran out of OUR OWN time, as opposed to running out of adapters (task 012-8).
     *
     * Set by exactly two things, and by nothing else: the pre-iteration check below (the clock has
     * passed `effectiveDeadlineAtMs`) and the per-adapter catch recognising the NET-layer
     * `DeadlineExceededError`. **`DeadlineWouldExceedError` never sets it** — a saturated bucket is
     * a per-PROVIDER fact and the deadline is global, so treating one provider's backlog as the
     * route's expiry would stop the walk before the paid adapter whose bucket is idle and for whom
     * the remaining seconds are entirely real (H-A; H-1 one floor down).
     */
    let deadlineHit = false;
    /**
     * Every adapter whose `fetch()` was entered, in walk order (cycle 2, F-4) — see
     * `CapabilityResolution.attempted` for what it is for and why it is not filtered by tier here.
     *
     * Appended at the CALL, not at its outcome: a `fetch()` that throws may still have spent money
     * (nansen commits its reservation before the sub-calls that can fail), so "was it entered" is
     * the question a budget reading has to ask, and "did it succeed" is not.
     */
    const attempted: string[] = [];
    /**
     * Attaches what is known only at RETURN time to whichever resolution is about to be returned:
     * the walk's `attempted`, and the deadline overrun if there is one.
     *
     * Neither can be attached where a resolution is CONSTRUCTED. The `unsatisfying` one is built
     * before the walk continues into the sources that spend — and those are exactly the ones it must
     * name — and the overrun is by definition unknown until the walk stops. One function, so a third
     * return-time fact needs no third edit at every `return` in the loop (there are three).
     */
    const withDiagnostics = (resolution: CapabilityResolution): CapabilityResolution => {
      const overrunMs = Date.now() - effectiveDeadlineAtMs;
      // `> 0`, so the field is absent on every ordinary call rather than present as `0`. Same rule
      // as `attempted` and `ageMs`: an absent field says nothing happened, a zero invites a reader
      // to look for a meaning it does not have.
      const late = overrunMs > 0 ? { deadlineOverrunMs: overrunMs } : {};
      const walk = attempted.length > 0 ? { attempted: [...attempted] } : {};
      return Object.keys(late).length + Object.keys(walk).length > 0
        ? { ...resolution, ...walk, ...late }
        : resolution;
    };

    // GATE 2 — coverage (TASK-006 R-51d). Positioned deliberately: after the route is known, but
    // BEFORE the cache read, before `isAvailable()`, before the budget gate and before any HTTP.
    //
    // Widening the chain set from 2 to 458 multiplies the ways a caller can miss coverage. If a
    // miss cost a credit reservation, the widening would itself become a way to spend money — so
    // this check has to sit above the paid path, not merely somewhere before the network call.
    //
    // A chain string that does not resolve leaves the gate inert: canonicalizing tool input is
    // task 006-6's job at the boundary, and this method must not start rejecting chains that the
    // pre-TASK-006 contract accepted.
    if (chainInfo && !this.getCoverage().isCovered(capability, chainInfo)) {
      const coverage = this.getCoverage();
      // BOUNDED (vdd-multi cycle 6, perf): `chainsFor(...).map(slug)` built a ~450-element array
      // so the constructor could render ten of them, which made the refusal path cost more than
      // the cache-HIT success path — on exactly the request a confused agent repeats.
      const served = coverage.servedSlugs(capability, 10);
      throw new CapabilityNotCoveredOnChainError({
        capability,
        chain: chainInfo.slug,
        availableChains: served.slugs,
        totalServedChains: served.total,
        availableCapabilities: coverage.capabilitiesFor(chainInfo),
      });
    }

    const argsHash = deriveArgsHash(capability, args);

    if (mergeMode) {
      // ---------------------------------------------------------------------------------------
      // THE MERGE WALK (T-013, task 013-4, R-161/R-165/R-166/R-167/R-182). Walks `plan` in the
      // SAME rank order as the loop below (rank = spend order = `adapterIds` order — D5: «Порядок
      // адаптеров был и остаётся правилом траты, а не предпочтением, и слияние не имеет права его
      // нарушить, вызвав платного участника раньше, чем исчерпан бесплатный» (ADR-002-configurable-
      // routing.md, D5), R-166(c), `CapabilityRoute.merge`'s own docstring), and reuses every
      // per-adapter step of that loop UNCHANGED: the deadline pre-check, the adapter lookup, the
      // chain-scoped skip, `isAvailable()`, the cache read (including its negative-entry branch),
      // and the `fetch`/`normalize`/`cache.set` triad. Each step's own comment on the loop below
      // states its rationale; it is not repeated here.
      //
      // **Where the route's answer-sufficiency policy is evaluated: PER PARTICIPANT, on that
      // participant's own answer, never once on the assembled merged array (R-182(a), AC-44,
      // `OQ-T013-4`).** Both call sites below are `satisfies(policy, <that participant's value>,
      // adapterId)` — the same signature and the same predicate instance the single-winner walk
      // uses, applied to a cached answer and a fresh one alike. Naming the choice here because it
      // is genuinely a choice: evaluating the merged whole would be a different, defensible design,
      // and on today's two real merge routes the two are INDISTINGUISHABLE — both carry the
      // `{kind: 'any'}` default, so every non-empty answer satisfies either way (R-182(c),
      // TC-INT-13 pins that equivalence). The choice becomes observable the first time a merge
      // route carries a selective policy, which is exactly when a reader needs to already know
      // which one was made.
      //
      // A participant whose answer does NOT satisfy is recorded in `tried` and, deliberately, in
      // `perSourceCache` — it ANSWERED, and its cache status is a fact about that answer, not about
      // whether the answer passed the policy (R-174(c), 013-3's recorded deviation; TC-INT-11).
      // It is absent from `sources` and from `missingSources`, so — for THIS participant, the
      // policy-excluded one — that `perSourceCache` entry is the only surviving evidence it was
      // asked at all.
      //
      // **That "only surviving evidence" claim does NOT extend to a FAILED participant (corrected,
      // M-4, fix pass 2026-08-07).** A participant that never reaches an answer — unregistered,
      // chain-skipped, `isAvailable()` false, a live negative-cache entry, or a `fetch`/`normalize`
      // throw — gets NO `perSourceCache` entry at all (that array is populated only on the two
      // ANSWERED branches below). Its only trace on THIS walk is `tried`, written 8 times in this
      // block and, deliberately, READ BY NOTHING on the merge path today — a window left open ON
      // PURPOSE for 013-5, whose four-branch outcome contract is what reads `tried` (and the
      // structural `skipped` record declared below, F-7) to build `missingSources`. Until then a
      // failed participant leaves no trace on the RETURNED resolution at all, only in `tried`'s
      // memory during this one call.
      //
      // **Exactly one difference, in two places: the single-winner walk's early `return`s become
      // "record the answer, accumulate it if it satisfies the policy, and keep walking".** The
      // merge walk never ends mid-traversal — every participant in `plan` is visited — and the
      // answer is assembled AFTER the loop from whatever was accumulated. `unsatisfying` (the
      // single-winner walk's truthful-but-unsatisfying fallback) is deliberately never touched
      // here: the merge path does not inherit it (task file "Запасной ответ `unsatisfying` на
      // слитом пути не применяется" — returning one participant's raw answer would un-merge exactly
      // the answer that was requested merged; TC-INT-12).
      //
      // 013-4's OWN scope ends at "always return a merged success, including empty" (PLAN's own
      // words: "013-4 владеет телом цикла, 013-5 — кодом после него") — WITH ONE NAMED EXCEPTION
      // carved out here rather than left for AC-47 to keep failing until 013-5 lands (B-1, fix pass
      // 2026-08-07): when NOBODY answered at all (`perSourceCache.length === 0`), `source` has
      // nothing non-empty to fall back to, and AC-47 forbids `''` unconditionally — so this one
      // outcome throws `CapabilityUnavailableError` instead of returning a hollow success. 013-5
      // KEEPS this branch as its own "nobody answered" outcome (a named special case of its branch
      // (c)/(d)), so the exception is forward-compatible, not throwaway. Every OTHER four-branch
      // outcome — `missingSources`, the two remaining failure branches, the deadline precondition —
      // is still 013-5's, which replaces the single unconditional `return` at the end of this block.
      //
      // **`hadFailure`/`deadlineHit` (the shared flags the walk below sets and reads) are
      // DELIBERATELY NOT written here.** This loop never reads them — it always returns success (or
      // the one B-1 exception above, which reads only `perSourceCache`, neither flag) — so writing
      // them now would be a dead store (`no-useless-assignment` catches exactly this, correctly:
      // nothing in 013-4's own code observes them). 013-5's outcome contract is what consumes them,
      // and it reintroduces the same one-line assignments at the same points below when it lands,
      // alongside the branch logic that reads them — a small, targeted addition to this loop's
      // body, not a rewrite of it.
      // ---------------------------------------------------------------------------------------
      const merged = new Map<string, unknown>();
      /** Participants whose points actually WON at least one key — R-174(a)'s `sources`. Updated by
       * `mergeInto` at the moment a point is inserted, never derived from "satisfied the policy"
       * afterward: a participant whose every point loses its key to an earlier duplicate satisfies
       * the policy and still contributes nothing to `result`. */
      const contributors = new Set<string>();
      /** One entry per participant that ANSWERED (cache hit OR fresh fetch+normalize), regardless
       * of policy or contribution (R-174(c); `perSourceCache`'s own docstring; TC-INT-11; the
       * roast-round-1/B-4 argument in `open-questions.md` "T-013 task 013-3"). Appended at the
       * point of ANSWERING, never filtered from `contributors`/`sources` afterward — that filtering
       * is exactly the narrow reading this project rejected. */
      const perSourceCache: { adapterId: string; cache: 'hit' | 'miss'; ageMs?: number }[] = [];
      /** The highest-rank participant that answered at all — set once, on the first answer seen,
       * and never overwritten, so "first" already means "highest-ranked" (the walk is rank order).
       * Exists so `source` never becomes '' while ANYONE answered, even with zero points (AC-47,
       * TC-INT-10), independently of whether that answer went on to satisfy the route's policy. */
      let firstAnswered: string | undefined;
      /**
       * Structural record of every participant SKIPPED or EXCLUDED during this walk — added for
       * 013-5 (F-7, fix pass 2026-08-07, `docs/architectures/open-questions.md` "T-013 task
       * 013-4"). 013-5's four-branch outcome contract needs to classify every non-contributing
       * participant by WHY, and doing that by string-matching `tried[].reason` (e.g. the literal
       * `'answered, but not with what was asked for'`) would be fragile and would force 013-5 to
       * edit THIS loop body to add its own classification — contradicting this file's own claim,
       * two paragraphs up, that 013-5's change is purely additive. `kind` mirrors R-164's
       * three-state model (`'unregistered'`/`'unavailable'`/`'chain'` → never asked;
       * `'failed'` → asked, did not answer) plus `'policy-excluded'`, which R-174(c)/`OQ-T013-4`
       * place outside the three states on purpose (the participant DID answer). Deliberately
       * scoped to the shipped `kind`s only — a malformed-points answer (`mergeInto`'s own refusal,
       * M-3) does not cleanly fit any of the five and is left to `tried` alone rather than guessed
       * at here, since classifying it is 013-5's call, not this fix pass's to make.
       *
       * **Raw material only — NOT yet read by anything.** `CapabilityResolution.missingSources` is
       * still 013-5's field to populate (013-3's own docstring on it); this array exists so 013-5
       * has structured data to populate it FROM, without touching this loop.
       */
      const skipped: {
        adapterId: string;
        kind: 'chain' | 'unregistered' | 'unavailable' | 'failed' | 'policy-excluded';
      }[] = [];

      /**
       * Inserts one participant's points into `merged`, INSERT-IF-ABSENT (R-161): a key already
       * present survives untouched, so the FIRST participant to claim a key — the highest-ranked
       * one, since `plan` (and this loop) is walked in rank order — keeps it, and its WHOLE point
       * (never a value read out of it, R-167) is what ends up in `result`. `value_raw` is not read
       * anywhere in this function or the loop around it.
       *
       * **The key buckets `ts` to the hour (`MERGE_DEDUP_BUCKET_MS`); the STORED point keeps its
       * own real `ts` untouched (F-0, owner decision 2026-08-07)** — see `MergePoint`'s own
       * docstring for the measurement that forced this and `MERGE_DEDUP_BUCKET_MS`'s for the
       * persistence-layer parallel.
       *
       * **Refuses a structurally malformed point rather than merging it (M-3, fix pass
       * 2026-08-07)** — `asMergePoint` validates each element; one that fails is dropped, and the
       * adapter's `tried` entry says how many. **A wholly non-array answer is recorded, never
       * silently discarded (F-5, same fix pass)** — the caller already recorded this participant's
       * cache status in `perSourceCache` before calling this function, so a silent `return` here
       * left it indistinguishable from an honest empty answer; `tried` now says otherwise.
       */
      const mergeInto = (adapterId: string, points: unknown): void => {
        if (!Array.isArray(points)) {
          tried.push({
            adapterId,
            reason: 'answered, but the result was not an array of points — dropped, never merged',
          });
          return;
        }
        let malformed = 0;
        for (const raw of points) {
          const point = asMergePoint(raw);
          if (!point) {
            malformed += 1;
            continue;
          }
          const bucket = Math.floor(point.ts / MERGE_DEDUP_BUCKET_MS);
          const key = `${point.metric}\0${point.asset}\0${bucket}`;
          if (merged.has(key)) continue;
          // The WHOLE original element (`raw`), never the narrowed 3-field `point` above, which
          // exists only to build the key (R-167(b)) — `valueRaw`/`source`/`height`/`valueNum` ride
          // along untouched, exactly as before this fix.
          merged.set(key, raw);
          contributors.add(adapterId);
        }
        if (malformed > 0) {
          tried.push({
            adapterId,
            reason: `answered with ${malformed} malformed point(s) (missing/invalid metric, asset, or ts) — dropped, never merged`,
          });
        }
      };

      for (const { adapterId, policy } of plan) {
        if (Date.now() >= effectiveDeadlineAtMs) {
          tried.push({
            adapterId,
            reason: 'deadline exceeded before this source could be attempted',
          });
          continue;
        }

        const adapter = this.adapters.get(adapterId);
        if (!adapter) {
          tried.push({ adapterId, reason: 'no adapter registered for this id' });
          skipped.push({ adapterId, kind: 'unregistered' });
          continue;
        }

        if (chainInfo && adapter.chainSupport && !adapter.chainSupport(chainInfo, capability)) {
          // `tried[]` stays silent here, matching the single-winner loop below — a chain-scoped
          // skip is a coverage fact, not an attempt that failed. `skipped` (F-7) records it anyway:
          // it is the ONE state this walk observes that `tried` structurally cannot carry, and
          // leaving it unrecorded here is exactly what forced the stale claim, corrected in M-1
          // below, that 013-5's own change would be purely additive.
          skipped.push({ adapterId, kind: 'chain' });
          continue;
        }

        const availability = adapter.isAvailable?.() ?? { ok: true };
        if (!availability.ok) {
          tried.push({ adapterId, reason: availability.reason });
          skipped.push({ adapterId, kind: 'unavailable' });
          continue;
        }

        let cached: CacheGetResult | undefined;
        try {
          cached = await this.cache.get(adapter.id, capability, argsHash);
        } catch (error) {
          process.stderr.write(
            `cache.get failed provider=${adapter.id} capability=${capability}: ${
              error instanceof Error ? error.message : String(error)
            } — treating as a miss\n`,
          );
          cached = undefined;
        }
        if (cached && isNegativeEntry(cached.value)) {
          if (Date.now() < cached.value.expiresAtMs) {
            tried.push({ adapterId, reason: `${cached.value.reason} [cached negative]` });
            skipped.push({ adapterId, kind: 'failed' });
            continue;
          }
          // Expired negative: fall through and pay again, same as the single-winner walk below.
        } else if (cached) {
          // DIFFERENCE (cache-hit side): the single-winner walk's
          // `if (satisfies(policy, cached.value, adapterId)) return withDiagnostics(hit);` (below —
          // grep that line, not a number: coordinates in this file have shifted repeatedly in one
          // day, WI-43) becomes "record the answer, accumulate it if it satisfies, keep walking" —
          // the participant ANSWERED regardless of what follows, so `perSourceCache`/`firstAnswered`
          // record that unconditionally.
          firstAnswered ??= adapter.id;
          perSourceCache.push({ adapterId: adapter.id, cache: 'hit', ageMs: cached.ageMs });
          if (satisfies(policy, cached.value, adapterId)) {
            // M-2 (fix pass 2026-08-07): its OWN try/catch — this call site sat OUTSIDE every
            // try/catch before this fix, so a bug in OUR merge code (never the provider's) aborted
            // the whole `resolve()` call with an untyped `TypeError` instead of being handled like
            // every other per-participant fault in this loop. M-7: `adapter.id`, not the route's
            // requested `adapterId` — matching `perSourceCache`/`firstAnswered` two lines up, so
            // `contributors`/`sources` cannot disagree with them about a participant's identity.
            try {
              mergeInto(adapter.id, cached.value);
            } catch (error) {
              process.stderr.write(
                `merge failed on ${adapter.id}'s own cached answer for ${capability}: ${
                  error instanceof Error ? error.message : String(error)
                } — this participant's points are dropped, NOT negative-cached [cached] (M-2: this ` +
                  `is our bug, not the provider's)\n`,
              );
              tried.push({
                adapterId,
                reason: `merge failed on this participant's own cached answer: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              });
            }
          } else {
            tried.push({
              adapterId,
              reason: 'answered, but not with what was asked for [cached]',
            });
            skipped.push({ adapterId, kind: 'policy-excluded' });
          }
          continue;
        }

        let raw: unknown;
        try {
          attempted.push(adapterId);
          raw = await adapter.fetch(capability, args, effectiveDeadlineAtMs);
        } catch (error) {
          if (error instanceof CapabilityNotCoveredOnChainError) throw error;
          tried.push({ adapterId, reason: error instanceof Error ? error.message : String(error) });
          skipped.push({ adapterId, kind: 'failed' });
          continue;
        }

        try {
          const result = adapter.normalize(capability, raw);
          try {
            await this.cache.set(adapter.id, capability, argsHash, result);
          } catch (error) {
            process.stderr.write(
              `cache.set failed provider=${adapter.id} capability=${capability}: ${
                error instanceof Error ? error.message : String(error)
              } — result still returned (best-effort cache write)\n`,
            );
          }
          // DIFFERENCE (fresh-answer side): the single-winner walk's
          // `if (satisfies(policy, result, adapterId)) return withDiagnostics(answer);` (below —
          // grep the line, not a number, for the reason given on the cache-hit side) becomes the
          // same "record, accumulate, keep walking" as the cache-hit side above.
          firstAnswered ??= adapter.id;
          perSourceCache.push({ adapterId: adapter.id, cache: 'miss' });
          if (satisfies(policy, result, adapterId)) {
            // M-2/M-7 (fix pass 2026-08-07) — same reasoning as the cache-hit site above: its OWN
            // try/catch, never sharing the OUTER catch below (which exists for `normalize()`
            // failures and negative-caches under the PROVIDER's key); `adapter.id`, matching
            // `perSourceCache`/`firstAnswered`.
            try {
              mergeInto(adapter.id, result);
            } catch (error) {
              process.stderr.write(
                `merge failed on ${adapter.id}'s own answer for ${capability}: ${
                  error instanceof Error ? error.message : String(error)
                } — this participant's points are dropped, NOT negative-cached (M-2: this is our ` +
                  `bug, not the provider's)\n`,
              );
              tried.push({
                adapterId,
                reason: `merge failed on this participant's own answer: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              });
            }
          } else {
            tried.push({ adapterId, reason: 'answered, but not with what was asked for' });
            skipped.push({ adapterId, kind: 'policy-excluded' });
          }
          continue;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          try {
            const expiresAtMs = Date.now() + NEGATIVE_TTL_SECONDS * 1000;
            const entry: NegativeCacheEntry = { __onchainNegative: true, reason, expiresAtMs };
            await this.cache.set(adapter.id, capability, argsHash, entry, NEGATIVE_TTL_SECONDS);
          } catch (cacheError) {
            process.stderr.write(
              `cache.set (negative) failed provider=${adapter.id} capability=${capability}: ${
                cacheError instanceof Error ? cacheError.message : String(cacheError)
              } — the next identical call will pay again\n`,
            );
          }
          tried.push({ adapterId, reason });
          skipped.push({ adapterId, kind: 'failed' });
        }
      }

      // B-1 (fix pass 2026-08-07, AC-47) — the ONE outcome this loop does not turn into a merged
      // success. `perSourceCache.length === 0` means NOBODY in `plan` ever reached an answered
      // branch (cache hit or fresh fetch+normalize) — every participant was unregistered,
      // chain-skipped, unavailable, negative-cached, deadline-cut, or failed. `firstAnswered` is
      // therefore `undefined`, `contributors` is empty, and the fallback chain below would publish
      // `source: ''` — the exact defect AC-47 forbids unconditionally ("никогда не пустая строка",
      // `docs/TASK.md`). This is a narrow, NAMED exception to "013-4 always returns a merged
      // success" (see the block overview comment above): 013-5 KEEPS this branch as its own
      // "nobody answered" outcome, so it is forward-compatible, not throwaway.
      if (perSourceCache.length === 0) {
        throw new CapabilityUnavailableError({ capability, chain, tried });
      }

      // `sources`/`source` (task file "sources и source", R-174(a), AC-47). `sources` lists
      // contributors in RANK order and is omitted when empty, the same idiom every optional field
      // on `CapabilityResolution` already follows; `source` is the highest-rank contributor,
      // falling back to the highest-rank participant that merely ANSWERED so the required field is
      // never '' while anyone answered at all (TC-INT-10; the doubly-empty case above now THROWS
      // rather than falling back to '', B-1).
      //
      // **M-7 (fix pass 2026-08-07) — derived directly from `contributors`, not re-cross-referenced
      // against `plan`.** `contributors` is populated by `mergeInto`, which is now called with
      // `adapter.id` at both call sites (the RESOLVED adapter's own reported id), matching
      // `perSourceCache`/`firstAnswered` two sections up. The former derivation —
      // `plan.map((p) => p.adapterId).filter((id) => contributors.has(id))` — cross-referenced
      // `contributors` against `plan`'s ROUTE-declared `adapterId`, which is identical to
      // `adapter.id` only as long as `this.adapters`'s map key agrees with the constructed
      // adapter's own `.id` — nothing enforces that agreement structurally, and a mismatch would
      // have made `perSourceCache`/`sources` name two different identities for the same
      // participant in one resolution object. `[...contributors]` needs no cross-reference: a `Set`
      // iterates in INSERTION order (the same guarantee `assertMergeParticipantsAreFree` already
      // relies on, `adapters/types.ts`), and insertion happens inside this loop's own rank-order
      // walk, so `[...contributors]` is already rank-ordered.
      const sources = contributors.size > 0 ? [...contributors] : undefined;
      const source = sources?.[0] ?? firstAnswered ?? '';

      const resolution: CapabilityResolution = {
        result: [...merged.values()],
        source,
        // R-174(c)/013-3 §3.5: the aggregate is 'hit' only when EVERY `perSourceCache` entry is
        // 'hit'. `.every()` on an empty array is vacuously `true`, but that case now throws above
        // (B-1) before this line is ever reached, so the `.length > 0` guard here is retained only
        // as a second, independent safeguard against the vacuous-truth trap, not because it is
        // still reachable in the all-empty shape.
        cache:
          perSourceCache.length > 0 && perSourceCache.every((entry) => entry.cache === 'hit')
            ? 'hit'
            : 'miss',
        ...(sources !== undefined ? { sources } : {}),
        ...(perSourceCache.length > 0 ? { perSourceCache } : {}),
        // M-5 (fix pass 2026-08-07): every OTHER path on `CapabilityResolution` follows "hit ⇒
        // `ageMs` present" (the single-winner walk's own `cached.ageMs`, `withDiagnostics`'s
        // `deadlineOverrunMs`, `attempted`'s own presence rule) — an all-hit merge used to be the
        // one shape that said `cache: 'hit'` with no top-level `ageMs` at all. Every entry
        // contributing to an all-hit aggregate carries its OWN `ageMs` (`CacheGetResult.ageMs` is
        // required, never optional — `cache-store.ts`), so the oldest of them, not an arbitrary
        // pick, is what the aggregate reports; `?? 0` only satisfies the optional-field type and is
        // never actually reached in this branch.
        ...(perSourceCache.length > 0 && perSourceCache.every((entry) => entry.cache === 'hit')
          ? { ageMs: Math.max(...perSourceCache.map((entry) => entry.ageMs ?? 0)) }
          : {}),
      };
      return withDiagnostics(resolution);
    }

    for (const { adapterId, policy } of plan) {
      // THE PRE-CHECK (task 012-8). First statement of the loop body, and ABOVE the cache read
      // below — both positions are decisions:
      //
      // - **Above the cache read.** A deadline bounds what a call may SPEND, and serving a cached
      //   entry is a way of spending it: the caller cannot predict which of its sources will be warm,
      //   so "cheap enough to serve past the ceiling" is a distinction it never asked for. Refusing
      //   to SERVE the entry is not the same as touching it — nothing here evicts or negative-writes,
      //   so the next call that fits in budget still gets it (TC-INT-09 and TC-INT-10 assert the two
      //   directions).
      //
      //   The original wording was "a deadline means: after this moment we do not answer", and it
      //   was FALSE of this same method — the H-1 return below hands back a complete answer past the
      //   ceiling when every source was entered and every one replied. OQ-T012-6 put the two
      //   readings to the owner; the decision (2026-08-05) keeps that return and rewrites this
      //   sentence, because a justification that the code contradicts is worse than none: the next
      //   reader designs against it. The ceiling constrains SPENDING (time, and on a paid route
      //   credits); it is not a promise about the moment of delivery, and `deadlineOverrunMs` on the
      //   resolution is how a caller finds out when delivery slipped anyway.
      // - **Time is the ONLY condition.** Never "some earlier adapter in this walk threw something
      //   deadline-flavoured": `DeadlineWouldExceedError` is a fact about ONE provider's bucket,
      //   and ORing it in here would let a free source's saturation skip every source behind it.
      //
      // `hadFailure` is set TOGETHER with `deadlineHit` (OD-4): a deadline is a failure of OUR
      // availability, exactly like a missing key or a 5xx. Without it, the H-1 return below
      // (`unsatisfying && !hadFailure`) would publish the answer of whoever replied before the
      // clock ran out — "Nansen answered: no labels" where the truth is "Nansen was never asked".
      //
      // Costs one `Date.now()` and no network call at all, which is what makes it affordable to
      // give every unreached adapter its own honest `tried[]` entry instead of a silent skip.
      if (Date.now() >= effectiveDeadlineAtMs) {
        deadlineHit = true;
        hadFailure = true;
        tried.push({
          adapterId,
          reason: 'deadline exceeded before this source could be attempted',
        });
        continue;
      }

      const adapter = this.adapters.get(adapterId);
      if (!adapter) {
        // NOT a failure for the H-1 distinction, deliberately. An id in the route with no adapter
        // behind it is a CONFIGURATION fact — this method's own contract calls it "skip-to-next,
        // `providers.config.ts`'s own documented contract for ids with no real adapter yet" — and in
        // production every id has one. Counting it as a failure made every route containing a
        // not-yet-built adapter unable to return a partial answer, which is how the first version of
        // the H-1 fix broke R-32 ("an empty `entities[]` is a VALID success, not an error"): the M2
        // suite registers only `nansen`, so `blockscout`'s absence turned nansen's legitimate empty
        // answer into an outage. Recorded in `tried` as before, so it is still visible.
        tried.push({ adapterId, reason: 'no adapter registered for this id' });
        continue;
      }

      // Chain-scoped skip (TASK-006): this is what the route-level `chains` literal used to do.
      // Not recorded in `tried` — "this adapter does not serve this chain" is not an attempt that
      // failed, and listing it would make a coverage fact look like an outage.
      if (chainInfo && adapter.chainSupport && !adapter.chainSupport(chainInfo, capability)) {
        continue;
      }

      const availability = adapter.isAvailable?.() ?? { ok: true };
      if (!availability.ok) {
        hadFailure = true;
        tried.push({ adapterId, reason: availability.reason });
        continue;
      }

      // Cache-read fault (finding A2): never abort resolve() — log and treat as a plain miss,
      // falling through to fetch/normalize exactly as if nothing had ever been cached.
      let cached: CacheGetResult | undefined;
      try {
        cached = await this.cache.get(adapter.id, capability, argsHash);
      } catch (error) {
        process.stderr.write(
          `cache.get failed provider=${adapter.id} capability=${capability}: ${
            error instanceof Error ? error.message : String(error)
          } — treating as a miss\n`,
        );
        cached = undefined;
      }
      if (cached && isNegativeEntry(cached.value)) {
        // A remembered deterministic failure (L-1). Record it exactly as if the adapter had just
        // failed — the caller still gets a loud `CapabilityUnavailableError`, never a fabricated
        // empty result — but ZERO network calls and ZERO credits were spent to say so. Marked in
        // the reason text so an operator debugging a just-fixed request bug can tell a cached
        // verdict from a fresh one instead of concluding the fix did not work.
        if (Date.now() < cached.value.expiresAtMs) {
          hadFailure = true;
          tried.push({ adapterId, reason: `${cached.value.reason} [cached negative]` });
          continue;
        }
        // Expired negative: fall through and pay again, deliberately. The vendor may now have data.
      } else if (cached) {
        const hit: CapabilityResolution = {
          result: cached.value,
          source: adapter.id,
          cache: 'hit',
          ageMs: cached.ageMs,
        };
        // H-1: the policy applies to CACHE HITS too. Checking only fresh results would let the
        // shadowing return through the cache the moment the first empty answer was stored —
        // and stored answers outlive the deploy that fixed the code.
        if (satisfies(policy, cached.value, adapterId)) return withDiagnostics(hit);
        unsatisfying ??= hit;
        tried.push({ adapterId, reason: 'answered, but not with what was asked for [cached]' });
        continue;
      }

      let raw: unknown;
      try {
        attempted.push(adapterId);
        // The deadline travels as the THIRD argument, unchanged (task 012-8). An adapter that
        // ignores it degrades to its own per-hop timeout and is not broken by it (R-140e) — the
        // guarantee that made the uptake stageable, and still tested by TC-INT-07. **10 of the 12
        // now read it** (WI-37); the two that do not are M1 stubs the loop never reaches, since
        // `isAvailable()` refuses them a few lines above. Coverage by CAPABILITY, measured
        // 2026-08-05: 20 of 20 (`capability-manifest.ts`'s ENFORCEMENT section, re-derived by
        // TC-F5-GATE on every run rather than transcribed here).
        raw = await adapter.fetch(capability, args, effectiveDeadlineAtMs);
      } catch (error) {
        // A PERMANENT refusal propagates as itself (vdd-multi cycle 5, H-1). Everything else in
        // this catch is treated as "this adapter could not answer right now, try the next one",
        // and the call ends as `CapabilityUnavailableError` — which tells the caller to RETRY.
        // For "this capability is not served on this chain" that advice is wrong in a way that
        // costs: the agent retries forever, and on a paid route each retry is a reservation
        // attempt. The gate above catches this for coverage it can see; an adapter can also
        // discover it deeper (Nansen's exhaustive `entity.labels` tier has a narrower chain list
        // than the default tier, and `chainSupport()` cannot see `args.exhaustive`).
        if (error instanceof CapabilityNotCoveredOnChainError) throw error;
        // C-1 TRANSLATION (task 012-8). The NET-layer `DeadlineExceededError` never leaves this
        // method as itself: it carries a URL or a provider id and knows nothing of
        // `{capability, chain, tried}`, which is precisely why there are two classes. Caught here,
        // it sets `deadlineHit` and is otherwise recorded like any other failure.
        //
        // Unlike `CapabilityNotCoveredOnChainError` one line above, it does NOT rethrow
        // immediately: the adapters behind this one still need their own `tried[]` entries, and the
        // pre-check at the top of the loop produces them for free on the next iterations.
        //
        // `DeadlineWouldExceedError` (the limiter's saturated-bucket refusal) deliberately has NO
        // branch here — it falls into the generic "this adapter could not answer, try the next one"
        // handling below, without setting `deadlineHit`. That absence is the mechanism, not an
        // omission: see the flag's own docstring.
        if (error instanceof DeadlineExceededError) deadlineHit = true;
        // FETCH failures are NOT negative-cached (L-1). A transport error, a 429, a 5xx or a budget
        // refusal is transient by nature: the same call a second later can legitimately succeed.
        // Caching that verdict would turn a blip into a self-inflicted outage lasting the whole
        // negative TTL — strictly worse than paying twice. Only the deterministic half is cached.
        hadFailure = true;
        tried.push({ adapterId, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }

      try {
        const result = adapter.normalize(capability, raw);
        // Cache-write fault (finding A1): its OWN try/catch, deliberately NOT sharing the
        // fetch/normalize catch below — a cache.set() failure must never be recorded as a
        // "tried" failure for this adapter (it already answered successfully) and must never
        // fall through to the next adapterId; the result is still returned as a genuine 'miss'.
        try {
          await this.cache.set(adapter.id, capability, argsHash, result);
        } catch (error) {
          process.stderr.write(
            `cache.set failed provider=${adapter.id} capability=${capability}: ${
              error instanceof Error ? error.message : String(error)
            } — result still returned (best-effort cache write)\n`,
          );
        }
        const answer: CapabilityResolution = { result, source: adapter.id, cache: 'miss' };
        // H-1. The result is cached above REGARDLESS — it is this adapter's truthful answer, the
        // cache key is scoped to `adapter.id`, and remembering "blockscout has nothing for X" is
        // what makes the next identical call skip straight to the provider that might.
        if (satisfies(policy, result, adapterId)) return withDiagnostics(answer);
        unsatisfying ??= answer;
        tried.push({ adapterId, reason: 'answered, but not with what was asked for' });
        continue;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // NORMALIZE failed on a response we already have in hand (and, for a paid provider, already
        // paid for). That verdict is DETERMINISTIC: the identical vendor body will be rejected the
        // identical way, so replaying the call can only spend money to reach the same conclusion.
        // Remember it briefly (L-1). Best-effort — the same reasoning as the positive-write catch
        // above: failing to record a negative must never change what the caller is told.
        try {
          const expiresAtMs = Date.now() + NEGATIVE_TTL_SECONDS * 1000;
          const entry: NegativeCacheEntry = { __onchainNegative: true, reason, expiresAtMs };
          await this.cache.set(adapter.id, capability, argsHash, entry, NEGATIVE_TTL_SECONDS);
        } catch (cacheError) {
          process.stderr.write(
            `cache.set (negative) failed provider=${adapter.id} capability=${capability}: ${
              cacheError instanceof Error ? cacheError.message : String(cacheError)
            } — the next identical call will pay again\n`,
          );
        }
        hadFailure = true;
        tried.push({ adapterId, reason });
      }
    }

    // H-1: nobody satisfied the route's policy — but the two ways that can happen are not the same
    // answer, and iteration 2 found the first version conflating them.
    //
    // `!hadFailure` means EVERY adapter was asked and every one of them answered; none of them had
    // what was requested. That is a fact about the data, and reporting it as
    // `CapabilityUnavailableError` would tell the caller to retry something that cannot change.
    //
    // `hadFailure` means at least one adapter could not be asked or could not answer — no key, no
    // budget, a 5xx, a rejected body. Returning the surviving partial answer there publishes "this
    // address has no entity labels" when the truthful statement is "the source that would know was
    // unreachable". On a stock install with no `NANSEN_API_KEY` that is the ORDINARY path, and it
    // silently voided R-40's contract (an explicit `isError` naming the missing key). It also makes
    // the `tried` entries below reachable, which is what a diagnostic has to be to be one.
    // `withDiagnostics` (F-4): the answer returned here is an EARLIER adapter's, and the sources the
    // walk entered after it — the paid ones, on the only route where this branch is reachable — are
    // exactly what a budget reading has to see. Attaching at construction would have named none.
    if (unsatisfying && !hadFailure) return withDiagnostics(unsatisfying);

    // OD-4 (task 012-8): expiry ALWAYS throws, and it throws the class that says whose fault it is.
    //
    // `deadlineHit` is the PRIMARY signal — set by the pre-check above or by the catch that
    // recognised the net-layer class. The SECOND disjunct is a duplicate on purpose: it catches a
    // path that arrives here with the time already gone WITHOUT having passed through that catch —
    // an adapter whose own error handling swallowed the typed class before the registry could see
    // it. Reporting "unavailable" there would tell the caller to retry a route that failed because
    // WE ran out of time.
    //
    // **No shipped adapter is in that shape any more (WI-36, 2026-08-05), and the disjunct stays.**
    // It was not hypothetical when this was written: `blockscout` and `blockchain-info` re-messaged
    // every transport throw by CLASS NAME (M-7, so a URL carrying `?apikey=` cannot reach the
    // model), so a deadline failure arrived as a plain `Error` with the typed one only on `cause`.
    // Both now rethrow the listed transport classes as themselves
    // (`net/safe-fetch.ts`'s `PASS_THROUGH_TRANSPORT_ERRORS`), so `deadlineHit` is set on those
    // paths. The reason to keep this line is the one WI-36 itself gives, and it is a measurement
    // rather than caution: the disjunct covers all TWELVE adapters and every future one, while
    // unwrapping fixed two. Removing a general guard because a specific instance was fixed trades
    // coverage for less coverage.
    //
    // Pinned by **TC-INT-11b** in `test/registry.deadline.test.ts`, which drives a fake adapter that
    // reproduces exactly the shape those two had — the only way left to construct this branch's
    // input. It used to be TC-INT-11, driving the real `blockscout`; that case still exists as
    // TC-INT-11a and now asserts the opposite fact (the class arrives intact). Before either
    // existed, deleting this disjunct left all 1404 tests green, which is how WI-36 was found.
    //
    // `DeadlineWouldExceedError` does not set `deadlineHit` — but it CAN still reach this branch
    // through the second disjunct, and an earlier version of this comment claimed it could not
    // ("by construction the limiter only throws it while `remainingMs > 0`, i.e. strictly before
    // `Date.now() >= effectiveDeadlineAtMs` can be true"). That is a statement about the moment of
    // the THROW; the disjunct is evaluated later. A single-adapter route whose bucket refuses with
    // `remainingMs = 1 ms` left arrives here after the millisecond has passed and ends as
    // `CapabilityDeadlineExceededError`, even though the only failure was a saturated bucket.
    //
    // Corrected, not changed (adversarial cycle 2, F-7): the OUTCOME is defensible — the walk
    // genuinely has no time left by then, and telling the caller "retry with more time" is truthful
    // — so this is a narrowing of the claim, not a fix of behaviour. What the two classes still
    // guarantee is the part that matters: a `DeadlineWouldExceedError` never STOPS the walk, so the
    // adapters behind the saturated one are asked. The mirror of this note lives on
    // `DeadlineWouldExceedError` in `net/rate-limit.ts`; cycle 2's F-2 made the window smaller by
    // requiring the refusal to leave `MIN_POST_WAIT_REMAINDER_MS` behind it, but not empty.
    if (deadlineHit || Date.now() >= effectiveDeadlineAtMs) {
      throw new CapabilityDeadlineExceededError({ capability, chain, tried });
    }

    throw new CapabilityUnavailableError({ capability, chain, tried });
  }
}
