import type { TokenBucketConfig } from '../net/rate-limit.js';
import type { Chain } from '../types/chain.js';
import type { ChainInfo } from '../chain/registry-core.js';
import type { PolicyDescriptor } from './policy.js';

/**
 * A single routable data capability (ARCHITECTURE.md §3.2, D4). `chains` narrows which chains the
 * capability applies to; omitted means the capability isn't chain-scoped.
 */
export interface CapabilityDescriptor {
  id: string; // e.g. 'token.price' | 'wallet.balances.native' | 'pairs.new' | ...
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
   * **10 of the 12 adapters ignore it in the shipped tree** — `blockscout` (012-8) and `nansen`
   * (012-9, where the paid leg makes the boundary a correctness condition) are the two that read it.
   * (Adversarial cycle 2, F-7: this line said "11 … as of task 012-8", a count that was correct for
   * one task and then read as the current state.) By CAPABILITY that is 4 of 20 — see the
   * ENFORCEMENT section of `capability-manifest.ts` for the measurement and WI-37 for the gap.
   *
   * An adapter that DOES read it must pass it on to `throttle()` and `safeFetch()` unchanged —
   * never re-derive a remainder from it — and must not honour it after a payment has committed
   * (ADR-002 D4 §2: cancelling there means paying without receiving).
   */
  fetch(cap: string, args: Record<string, unknown>, deadlineAtMs?: number): Promise<unknown>;
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
