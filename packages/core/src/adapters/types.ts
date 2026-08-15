import type { TokenBucketConfig } from '../net/rate-limit.js';
import type { Chain } from '../types/chain.js';
import type { ChainInfo } from '../chain/registry-core.js';
import type { PolicyDescriptor } from './policy.js';

/**
 * A single routable data capability (ARCHITECTURE.md §3.2, D4). `chains` narrows which chains the
 * capability applies to; omitted means the capability isn't chain-scoped.
 */
export interface CapabilityDescriptor {
  id: string; // e.g. 'token.price' | 'wallet.balances.native' | 'pairs.active' | ...
  chains?: Chain[];
}

/**
 * The stable internal interface every provider integration implements (D4, R-3, task 003-2). The
 * `CapabilityRegistry` depends only on this — never on a concrete provider's own SDK/DTO shape
 * (anti-corruption layer, ARCHITECTURE.md §2.1/§3.2): `fetch()` returns a provider-specific raw
 * shape (`unknown` here, narrowed internally by the adapter's own `normalize()`), which
 * `normalize()` turns into the canonical zod type before it ever reaches the Registry's caller.
 */
export interface ProviderAdapter {
  /** Adapter id, e.g. 'coingecko' | 'rpc-evm' | 'dash-platform' | ... (D4 — explicit id field). */
  id: string;
  capabilities(): CapabilityDescriptor[];
  costOf(cap: string, args: Record<string, unknown>): { credits: number };
  /**
   * `deadlineAtMs` (ADR-002 D4, task 012-8) is the ABSOLUTE moment (epoch-ms, `Date.now()` scale)
   * after which this call's answer is worthless — never a duration, for the reason
   * `SafeFetchOptions.deadlineAtMs` gives: a duration would be re-granted in full at every step that
   * forwarded it, and a moment forwards itself.
   *
   * **Optional ON PURPOSE, and an adapter that ignores it is not broken (R-140e).** It then
   * degrades to exactly today's behaviour — its own per-hop `timeoutMs` and `MAX_WAIT_MS` — while
   * `CapabilityRegistry` still refuses every adapter it has not yet reached once the moment passes.
   * That guarantee is what made a staged uptake safe, it is still tested
   * (`registry.deadline.test.ts` TC-INT-07), and it is no longer describing the shipped tree.
   *
   * **10 of the 12 adapters read it (measured 2026-08-05, WI-37)** — every one except `dune` and
   * `dash-platform`, which are M1 stubs that spend no time at all: `isAvailable()` is
   * unconditionally false and `fetch()` throws, so there is nothing for a ceiling to cut. By
   * CAPABILITY that is 20 of 20. (This line has been wrong in both directions before — it said
   * "11 … as of task 012-8", a count correct for one task and then read as the current state, and
   * then "10 ignore it" after 012-9. It is now re-derived on every run: `capability-manifest.test.ts`'s
   * TC-F5-GATE scans the adapter sources and fails if the ENFORCEMENT prose disagrees.) See that
   * section of `capability-manifest.ts` for the measurement.
   *
   * An adapter that DOES read it must pass it on to `throttle()` and `safeFetch()` unchanged —
   * never re-derive a remainder from it — and must not honour it after a payment has committed
   * (ADR-002 D4 §2: cancelling there means paying without receiving).
   */
  /**
   * `onCoalesced` (task 014-30, R-27.3) is called SYNCHRONOUSLY when this call is a follower on
   * somebody else's in-flight vendor request. Optional and additive, exactly as `deadlineAtMs` was
   * (D4/R-140): an adapter that declares no coalescing never reads it. Today one adapter does —
   * `nansen`, through `createSingleflight`.
   */
  fetch(
    cap: string,
    args: Record<string, unknown>,
    deadlineAtMs?: number,
    onCoalesced?: () => void,
  ): Promise<unknown>;
  /** Narrows the provider-specific `raw` shape into the canonical domain type for `cap`. */
  normalize(cap: string, raw: unknown): unknown;
  /**
   * Env/key-readiness check (R-24) — returns a structured reason BEFORE any network attempt,
   * instead of letting `fetch()` fail opaquely. Optional: an adapter with no env/key precondition
   * (e.g. a keyless REST API) can omit it entirely — `CapabilityRegistry` then treats it as
   * "always available".
   */
  isAvailable?(): { ok: true } | { ok: false; reason: string };
  /**
   * "Can I serve this chain?" (TASK-006 R-51a/R-54c) — a PREDICATE over the resolved `ChainInfo`,
   * deliberately not a list of chain ids.
   *
   * A list would have to be kept in sync with the registry and would drift on the first change;
   * a predicate reads the registry's own columns (`vendors.<id>`, `family`, `rpcHosts`) and
   * therefore cannot disagree with it. The registry stays the single source of facts about a
   * CHAIN, the adapter the single source of facts about ITSELF.
   *
   * Distinct from `isAvailable()`: this answers "does this chain exist for me at all", which is
   * permanent, whereas `isAvailable()` answers "am I configured and reachable right now", which
   * is fixable. The two produce different errors on purpose (see `CapabilityNotCoveredOnChainError`).
   *
   * **`capability` is a parameter because coverage is a property of the PAIR, not of the adapter.**
   * `nansen` proves it: `smart-money.flows` reaches 17 chains while `token.risk` reaches 25, since
   * the composite capability is only covered where BOTH of its sub-calls are. A predicate blind to
   * the capability could only answer with a union (over-claiming, and the union's extra chains
   * half-succeed AFTER credits are spent) or an intersection (under-claiming). Adapters whose
   * coverage does not vary by capability simply ignore the argument.
   *
   * Optional: an adapter that omits it is treated as not chain-bound, exactly as before.
   */
  chainSupport?(chain: ChainInfo, capability: string): boolean;
}

/**
 * Whether serving a capability through this adapter costs money at the VENDOR (ADR-002 **D8**,
 * task 012-2). Two values, deliberately: this is the single classification of paidness, introduced
 * to replace the four that had been competing (`PAID_PROVIDER_IDS`, the `providers.kind` column,
 * `BudgetMeta.provider`'s hand-picked literal type, and `costOf()` read as a de-facto tier signal).
 */
export type AdapterTier = 'free' | 'paid';

/**
 * How far the DATA an adapter returns can be trusted (ADR-002 **D9**, task 012-2) — a property of
 * the CONTENT's editability, not of the operator's officialness:
 *
 * - `authoritative` — the vendor is the origin of the fact and outsiders cannot edit it (consensus
 *   data, machine-aggregated counters, a vendor's own measurements);
 * - `derived` — computed by us from other sources rather than reported by a vendor (the `derived`
 *   convention already used per-ROW in the snapshot ledger's `source` column);
 * - `community` — content anyone can edit (`blockscout`'s user-submitted token/address metadata is
 *   ADR-002 D9's own example).
 */
export type AdapterTrust = 'authoritative' | 'derived' | 'community';

/**
 * Declarative per-adapter registration (D4/R-4/R-25/R-26, `providers.config.ts`): `hosts` is the
 * SSRF allowlist source-of-truth for THIS adapter only (§7.2/§5.3 — never a merged/global list),
 * `rateLimit` feeds the token-bucket limiter (R-26), `requiresEnv` documents (informationally)
 * which env keys the adapter needs — the actual availability decision is always the adapter's own
 * `isAvailable()`, not this list.
 *
 * `tier` and `trust` (task 012-2) are both REQUIRED: a rank that can be omitted is a rank that gets
 * defaulted, and ADR-002 D9 rejected exactly that on the `zechub` precedent — a silent
 * `authoritative` default hides the one case the field exists to flag. `assertValidAdapterRegistrations()`
 * below is the runtime half of the same guarantee, for values that arrive through a cast.
 */
export interface AdapterRegistration {
  id: string;
  hosts: string[];
  rateLimit: TokenBucketConfig;
  requiresEnv: string[];
  /**
   * How this provider's rate-limit bucket SPLITS (task 014-17, R-7, AC-40/AC-42). Absent means one
   * bucket for every call the provider makes, which is what twelve of the thirteen declare and what
   * they do today.
   *
   * **Why the unit is the chain and not the host.** `rpc-evm` calls the limiter before it reads
   * `chain.rpcHosts` and before the loop over endpoints, so at the call site the hostname is not yet
   * known and the chain is. `coingecko` picks exactly one host per installation, so its two
   * registered hosts never live at once and a host split there is unobservable.
   */
  scopeKey?: 'chain';
  /**
   * Free or paid at this vendor (ADR-002 D8) — a STATIC property of the vendor RELATIONSHIP, held
   * here so that "is this a paid provider" has exactly one answer in the codebase.
   *
   * **Never derived from `costOf()`, in either direction.** A price is a function of the ARGUMENTS
   * and of the live account plan, so it cannot classify the relationship: `nansen` prices per
   * endpoint off a real table under the current plan (`adapters/nansen/index.ts:573`), and
   * `blockchain-info` — a free, keyless vendor — returns `0` or `Infinity` purely as a
   * configuration switch (`adapters/blockchain-info/index.ts:144`), so a `costOf() > 0` reading
   * would classify a disabled free adapter as paid. `test/adapter-registrations.test.ts` keeps a
   * structural gate over every package's `src` tree against that drift (R-150(c)).
   */
  tier: AdapterTier;
  /**
   * Trust rank of this adapter's data (ADR-002 D9).
   *
   * **Declare-only in T-012 (R-155).** The single reader in the whole codebase is
   * `assertValidAdapterRegistrations()` below; nothing routes, merges or filters on it yet. Merge
   * segmentation by rank, community marking on the response, and the per-ROW `source → trust`
   * dictionary (which is what `pg-history` actually needs — its rank lives in the row, not in the
   * adapter) are **T-016**. The field is declared now because a rank retrofitted after the merge
   * code exists is a rank chosen to fit the code.
   */
  trust: AdapterTrust;
}

/** The declared ranks, in one place — `assertValidAdapterRegistrations()`'s allowed-value source. */
const DECLARED_RANKS = {
  tier: ['free', 'paid'],
  trust: ['authoritative', 'derived', 'community'],
} as const satisfies Record<'tier' | 'trust', readonly string[]>;

/**
 * Constructor-time gate: every registration must DECLARE both ranks (task 012-2, R-153/R-154/AC-15).
 *
 * The compiler already refuses a registration literal missing `tier` or `trust`. This is the other
 * half — the one that survives a cast, a JSON-shaped config, or a `filter()`ed array assembled at
 * runtime — and it exists so that the failure lands at PROCESS START (`mcp-server/src/index.ts`
 * calls it before any store or registry is constructed) rather than on the first request that
 * happens to route through the offending adapter.
 *
 * **The array is a PARAMETER, never a module import.** This function must not import the
 * `providers.config.ts` array it validates: a validator that reads its own subject can only ever be
 * exercised against the one real, complete input, so no test could hand it a small deliberately
 * broken array and watch it throw in isolation.
 *
 * **It lives here, beside the interface it validates, and not on `CapabilityRegistry`.**
 * `AdapterRegistration` never reaches the registry at all — it is passed to `SqliteCacheStore`'s
 * and `SqliteBudgetStore`'s `bootstrapProviders()` and nowhere else — so a check hosted by the
 * registry would sit on a path the data does not travel.
 *
 * @throws Error naming the offending registration's `id` AND the field it failed to declare — a
 * diagnostic that says only "invalid registration" sends the reader to a twelve-entry table.
 */
export function assertValidAdapterRegistrations(registrations: AdapterRegistration[]): void {
  for (const [index, registration] of registrations.entries()) {
    // The id is what makes the diagnostic actionable, so it gets its own fallback rather than
    // being interpolated blindly — a registration broken badly enough to lose `trust` may have
    // lost `id` too, and `'undefined' does not declare 'trust'` names nothing.
    const id =
      typeof registration.id === 'string' && registration.id !== ''
        ? registration.id
        : `<registration #${index}, no id>`;

    for (const field of ['tier', 'trust'] as const) {
      const value: unknown = registration[field];
      const allowed: readonly string[] = DECLARED_RANKS[field];
      if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new Error(
          `adapter registration '${id}' does not declare '${field}': expected one of ` +
            `${allowed.join(' | ')}, got ${JSON.stringify(value)} ` +
            `(ADR-002 D8/D9, task 012-2 — a rank that can be omitted is a rank that gets defaulted)`,
        );
      }
    }
  }
}

/**
 * Startup-time gate: every capability that ACTIVATES merging (at least one of its routes carries
 * `CapabilityRoute.merge === true`) must have EVERY adapter reachable through that capability's
 * routes registered as `tier: 'free'` (T-013, task 013-2, R-162/R-163).
 *
 * **Why this has to be a gate at all.** The conflict rank a merge walk uses (`013-4`) is
 * `adapterIds`' own compiled order — see `CapabilityRoute.merge`'s docstring below — a mechanism
 * this task REUSES rather than replaces (`OQ-T013-3`). That order encodes SPEND priority
 * (free/cheap first, R-11), and the walk visits it in the SAME order to decide which participant
 * wins a same-key conflict. A paid adapter sorted last for spend reasons would therefore also be
 * lowest-ranked for the merge — it would lose every conflict silently, for free, until a real
 * per-row priority rank exists (T-016). This gate turns that silent loss into a refusal to start.
 *
 * **The union of ALL of the capability's routes, never one route's own `adapterIds`.**
 * `CapabilityRegistry.resolve()` already builds its walk `plan` this way (`registry.ts`'s own
 * docstring on `plan`): every route matching a capability contributes its adapters, de-duplicated
 * by id, first occurrence wins. An adapter reachable ONLY through a sibling route that does not
 * itself carry `merge: true` still enters the SAME merged walk the moment any one of the
 * capability's routes does — so checking one route's `adapterIds` in isolation would let it
 * through unverified. No shipped route is in that shape today; this check closes the possibility
 * by construction rather than by audit.
 *
 * **Reads `tier`, never `.trust`.** `tier` (ADR-002 D8) is the one classification of paidness
 * (`AdapterRegistration`'s own docstring above); `trust` (D9) classifies data provenance and has no
 * reader outside `assertValidAdapterRegistrations`'s own declare-only check
 * (`tier-single-source.test.ts`'s `TC-GATE-02`) — this function must not become a second one.
 *
 * **Lives here, beside `assertValidAdapterRegistrations`, and NOT on `CapabilityRegistry`.** Both
 * parameter types (`CapabilityRoute[]`, `AdapterRegistration[]`) are declared in this same file, so
 * no new import is needed either way — but the constructor is the wrong home regardless of that
 * convenience: `013-4`'s own merge-walk test needs to build a `CapabilityRegistry` around a route
 * that pairs a free and a paid adapter, to observe the walk's polling ORDER directly, and a
 * constructor-embedded version of this check would make that fixture unconstructible (PLAN §0.7).
 * Kept as an independent function, it is called exactly once, from `mcp-server/src/index.ts`,
 * immediately after `assertValidAdapterRegistrations` and before any store or registry is
 * constructed — so an inconsistent configuration fails PROCESS START, never the first merged
 * request (the same discipline `assertValidAdapterRegistrations` applies to undeclared ranks).
 *
 * **The array parameters are PARAMETERS, never a module import of `providers.config.ts`** — same
 * reasoning as `assertValidAdapterRegistrations`'s own docstring: a validator that reads its own
 * subject can only ever be exercised against the one real, complete input.
 *
 * **Two scope notes, recorded rather than fixed (fix pass 2026-08-07 — see the task's own "Noted,
 * do NOT fix here" list, `docs/architectures/open-questions.md` "T-013 task 013-4").** (1) This
 * gate is enforced at exactly ONE call site (`mcp-server/src/index.ts`, at module scope, before
 * any store or registry is constructed) — `CapabilityRegistry` itself is a PUBLIC class, and
 * `new CapabilityRegistry(routes, adapters, ...)` built directly (as every test in this package
 * does, and as any future call site could) bypasses this check entirely; nothing in the class
 * itself re-verifies it. (2) `tier: 'free'` (ADR-002 D8) means "no cost at the VENDOR", never
 * "unmetered" — `blockscout` is `tier: 'free'` and still carries a real, unenforced-by-this-
 * function ceiling of roughly **625 calls/day** before its own upstream credits run out
 * (`providers.config.ts`'s own `blockscout` registration comment) — this gate refuses a PAID
 * participant from silently losing a merge conflict, not a free one from silently running out of
 * quota.
 *
 * @throws Error naming the offending capability AND the first non-free participant found while
 * walking the union in route-then-adapterIds encounter order — the same "both halves in the
 * message" discipline as `UnregisteredPolicyClassError`.
 */
export function assertMergeParticipantsAreFree(
  routes: CapabilityRoute[],
  registrations: AdapterRegistration[],
): void {
  // One id -> tier lookup, built FAIL-CLOSED on a duplicate id, STICKY-NON-FREE: once a
  // registration for an id resolves to anything OTHER than `'free'`, that id stays non-free for the
  // rest of this pass, regardless of array order. Deliberately `known !== 'free'`, not `known ===
  // 'paid'` (an earlier version of this line, review round 2 M-2/LOW-1): `AdapterTier` is `'free' |
  // 'paid'` at the TYPE level, but this function takes a runtime-assembled array — the same
  // cast/JSON-config threat model `assertValidAdapterRegistrations`'s own docstring names — so a
  // stray THIRD value (`tier: 'trial' as AdapterTier`) can arrive. Checking for literal `'paid'`
  // let such a value be silently overwritten back to `'free'` by whichever order put a
  // genuinely-`'free'` copy later; checking for "not confirmed free" does not care WHAT the sticky
  // value is, only that it isn't `'free'`.
  //
  // **The ABSENT tier is the same hole one level down, and is why the value is normalised before it
  // is stored** (roast round 3). A registration whose `tier` key is missing entirely — the canonical
  // shape of the JSON/cast threat model this comment already invokes — yields `undefined`, and an
  // earlier `known !== undefined && known !== 'free'` guard read that as "nothing known yet", so a
  // later genuinely-`'free'` copy un-stuck it: `[no-tier, free]` PASSED while `[free, no-tier]`
  // threw. Order decided again, which is exactly the property the sticky rule exists to remove.
  // Storing `registration.tier ?? UNDECLARED_TIER` makes the absent case a first-class non-free
  // value, so the single `!== 'free'` test covers all three arrivals — declared-paid, stray-third,
  // and absent — without a second condition to keep in sync.
  //
  // `assertValidAdapterRegistrations` rejects every one of these shapes one call earlier at the
  // production entry point (`mcp-server/src/index.ts`), so none of it is reachable there. It is
  // reachable through this function's own export, which is what the standalone tests exercise.
  //
  // **Why this matters, and why "first wins" / "last wins" were both rejected first.** On
  // `[{id:'x',tier:'paid'}, {id:'x',tier:'free'}]`, first-wins THROWS and last-wins PASSES a paid
  // participant through the one gate whose entire purpose is refusing it — neither is fail-closed,
  // and an earlier draft here picked last-wins for a reason (`adapter-registrations.test.ts` "owns"
  // duplicate ids) that does not hold: that file has no id-uniqueness test at all (its own
  // TC-UNIT-05 builds its expectation via `Object.fromEntries(...)`, which itself silently
  // collapses a duplicate id last-wins).
  //
  // **Still safe against `tier-single-source.test.ts`'s paidness-classification gate (task 012-3,
  // R-151(e)), confirmed by running it** (see `.AGENTS.md`): `known`'s last segment is not an
  // `ID_WORDS` token, so neither comparison against it matches that scanner's LITERAL_EQUALITY
  // detector, and `.get`/`.set` are not in its MEMBERSHIP alternation at all — NOT because the
  // id-bearing read and the paidness-bearing read sit in separate statements (they do not: the
  // `.set()` call below names both `registration.id` and `registration.tier`), but because neither
  // method this uses is one the scanner watches.
  // Widened past `AdapterTier` on purpose: the map has to be able to HOLD the absent case in order
  // to make it sticky, and `'undeclared'` is deliberately distinguishable from `undefined` when the
  // refusal below renders it — `undefined` means "no registration carries this id at all",
  // `'undeclared'` means "a registration does, and it declared no tier".
  const UNDECLARED_TIER = 'undeclared' as const;
  const tierById = new Map<string, AdapterTier | typeof UNDECLARED_TIER>();
  for (const registration of registrations) {
    const known = tierById.get(registration.id);
    // Normalise the ABSENT case at the point of STORAGE, so `!== 'free'` stays the single test that
    // has to be right (see the docstring above). A guard written instead as
    // `known !== undefined && known !== 'free'` reads the absent case as "nothing known yet" and
    // lets a later free copy un-stick it — the round-3 hole.
    const arriving = registration.tier ?? UNDECLARED_TIER;
    tierById.set(registration.id, known !== undefined && known !== 'free' ? known : arriving);
  }

  // Every capability with at least one merge-activated route, in first-encounter order (`Set`
  // preserves insertion order).
  const mergingCapabilities = new Set<string>();
  for (const route of routes) {
    if (route.merge === true) mergingCapabilities.add(route.capability);
  }

  for (const capability of mergingCapabilities) {
    // The UNION, de-duplicated, in the same encounter order `resolve()`'s own `plan` uses: every
    // matching route in array order, every id within it in `adapterIds` order, first occurrence
    // wins. This is what makes an adapter reachable only through a sibling non-merge route of the
    // SAME capability get checked too — never just the merge-flagged route's own `adapterIds`.
    const participants = new Set<string>();
    for (const route of routes) {
      if (route.capability !== capability) continue;
      for (const adapterId of route.adapterIds) participants.add(adapterId);
    }

    for (const adapterId of participants) {
      const tier = tierById.get(adapterId);
      if (tier !== 'free') {
        throw new Error(
          `capability '${capability}' activates merge, but participant '${adapterId}' is not ` +
            `tier: 'free' (${
              tier === undefined ? 'no adapter registration found for this id' : `tier: '${tier}'`
            }) — every adapter reachable through a merged capability's routes must be free, or ` +
            `the paid one silently loses every dedup conflict (adapterIds order is the conflict ` +
            `rank, and the last position is the lowest rank; T-013, task 013-2, R-162/R-163)`,
        );
      }
    }
  }
}

/**
 * A routing entry: which adapters (in priority/fallback order, R-11) serve `capability`.
 *
 * Chain coverage is NOT a property of the route — it is a property of the pair (adapter,
 * capability), and it is derived from `ProviderAdapter.chainSupport()` (TASK-006 R-51a/R-54c), the
 * coverage matrix built on top of it (`chain/coverage.ts`), and the chain-scoped skip in
 * `CapabilityRegistry.resolve()`. A route USED to also carry an optional `chains?: Chain[]` literal
 * that narrowed it the same way; T-012's OQ-C audit found zero of the 21 production routes setting
 * it, so it was removed (task 012-1) rather than kept as a second mechanism that could silently
 * drift from `chainSupport()`.
 */
export interface CapabilityRoute {
  capability: string;
  adapterIds: string[]; // order = priority + fallback chain (R-11)
  /**
   * Activates merge-walk semantics for THIS route (T-013, task 013-2, R-159/R-160/R-183) —
   * deliberately a fact about the ROUTE, independent of `capabilityManifests[capability].mergeable`
   * (013-1), which is a fact about the CAPABILITY's key identity. Two axes, two owners:
   *
   * - `mergeable` (manifest, `set | series` branch only) says a capability's results are ELIGIBLE
   *   to be combined instead of returned from one winning adapter — a fact that does not change
   *   per deployment.
   * - `merge` (here) TURNS IT ON for one route. `providers.config.ts` (013-6) is the only place
   *   production ever sets it to `true`, and it may do so only where the manifest already says
   *   `mergeable: true` — `CapabilityRegistry`'s constructor (validation step 3, `registry.ts`)
   *   refuses to build otherwise, naming the capability and the missing eligibility
   *   (`MergeEligibilityNotDeclaredError`, UC-20).
   *
   * **Absence/`false` behaves exactly as before this task: `resolve()` runs the pre-existing
   * single-winner walk, byte-identical.** Corrected here (M-1, fix pass 2026-08-07) — this
   * docstring used to say "`resolve()` does not read this field yet (the walk itself is `013-4`)",
   * true only until 013-4 landed; the correction was written into a `merge-activation.test.ts`
   * comment at the time and never propagated back to its own source. `merge: true` on at least one
   * matching route now makes `resolve()` run the MERGE walk instead (T-013, task 013-4,
   * `CapabilityRegistry.resolve()`'s own docstring) — the two checks above (eligibility,
   * all-participants-free) still gate whether a route may set it at all.
   *
   * **The conflict rank is `adapterIds`' own order, and NOTHING ELSE.** `resolve()` already builds
   * `plan` — the de-duplicated union of every matching route's `adapterIds`, in encounter order
   * (`registry.ts`'s own docstring on `plan`) — for the pre-existing single-winner walk; `013-4`'s
   * merge walk reuses that SAME order as the rank that decides which value wins a same-key conflict
   * (highest-priority answering participant wins, R-162). No separate rank table exists anywhere in
   * this tree, and `assertMergeParticipantsAreFree` above is what makes reusing an order meant for
   * fallback-priority safe as a paidness-blind conflict rank: the participant sorted last (lowest
   * rank) can never silently be a `tier: 'paid'` adapter that loses every conflict for free.
   *
   * **This reuse is PROVISIONAL, stated so on purpose.** `adapterIds`' order was designed for
   * fallback priority (R-11), not for conflict resolution, and the two questions happen to accept
   * the same answer only for today's two participants. `OQ-T013-3`'s owner decision (2026-08-05)
   * chose the reuse over a new explicit rank table for exactly this task; a dedicated structure —
   * if a future capability's fallback order and conflict rank ever need to differ — is addressed to
   * **T-016**, not solved here by generalizing this field.
   */
  merge?: boolean;
  /**
   * "Does this normalized result answer the request, or should the route keep walking?" — declared
   * as DATA: a `{ kind, ...params }` descriptor resolved against the class dictionary in
   * `adapters/policy.ts` (ADR-002 **D2**, task 012-6).
   *
   * **Absence means `{ kind: 'any' }`** — 20 of the 21 production routes carry no descriptor.
   *
   * vdd-multi TASK-008, H-1 — why a route has a policy at all. Without one the registry has exactly
   * two signals — a throw means *failed*, a return means *done* — so a provider that truthfully
   * answers "I have nothing for this address" terminates the route and shadows every provider
   * behind it. The first fix attempted was to make the provider THROW on an empty result. That
   * works and is wrong: it puts knowledge of the successor inside the provider. `blockscout` would
   * then be reporting a failure it did not have, and would keep doing so when deployed with no
   * Nansen behind it — a provider whose correctness depends on its neighbours cannot be developed
   * or deployed independently.
   *
   * So the provider states its own truth and **this descriptor carries the cross-provider policy**,
   * next to the adapter ORDER that already encodes the spend rule. `CapabilityRegistry` resolves it
   * to a predicate ONCE, when it is constructed — an unknown `kind` fails the build there
   * (`UnregisteredPolicyClassError`), never on the first request months later — and applies it to
   * cache hits as well as to fresh results, since otherwise the same shadowing returns through the
   * cache.
   *
   * When no adapter satisfies it, the walk does not fail: the first truthful-but-unsatisfying
   * result is returned. "No provider has labels for this address" is an answer, not an outage.
   *
   * **The class that the one live route names is `someElementHasAny`, and it is deliberately NOT
   * called `nonEmpty`.** The predicate must reject a non-empty array of contentless entries —
   * exactly what Blockscout returns for an unlabelled address — so a literal "non-empty" reading
   * would reintroduce H-1 under a name that sounds like the fix. The ban covers identifiers (export
   * name, dictionary key, alias, variable/type name); this paragraph is the reason it exists, which
   * is why R-134c requires the explanation to survive in prose.
   *
   * **This is the smallest hook that keeps the defect out of production, NOT the router.** The
   * owner's decision (2026-07-28) is that the real design is settled at a redesign stage, and that
   * it will differ in two ways: the router must be able to call a COMBINATION of adapters and
   * aggregate their results, and the policy should be configured partly in the DB, as classes,
   * rather than as a literal in `providers.config.ts`. ADR-002 D2 landed the first half of that —
   * classes, resolved by name — and the second half ("is what I have COLLECTED enough", joined by a
   * merge rule) is D5/T-013 and does not exist yet.
   *
   * So: do not grow the dictionary into a policy engine. Weights, partial merges and multi-source
   * collection are the router's job, and adding them here would make the redesign harder, not
   * easier.
   */
  policy?: PolicyDescriptor;
}
