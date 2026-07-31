import type { TokenBucketConfig } from '../net/rate-limit.js';
import type { Chain } from '../types/chain.js';
import type { ChainInfo } from '../chain/registry-core.js';

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
  fetch(cap: string, args: Record<string, unknown>): Promise<unknown>;
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
 * Declarative per-adapter registration (D4/R-4/R-25/R-26, `providers.config.ts`): `hosts` is the
 * SSRF allowlist source-of-truth for THIS adapter only (§7.2/§5.3 — never a merged/global list),
 * `rateLimit` feeds the token-bucket limiter (R-26), `requiresEnv` documents (informationally)
 * which env keys the adapter needs — the actual availability decision is always the adapter's own
 * `isAvailable()`, not this list.
 */
export interface AdapterRegistration {
  id: string;
  hosts: string[];
  rateLimit: TokenBucketConfig;
  requiresEnv: string[];
}

/**
 * A routing entry: which adapters (in priority/fallback order, R-11) serve `capability` on
 * `chains` (or any chain, if `chains` is omitted).
 */
export interface CapabilityRoute {
  capability: string;
  chains?: Chain[];
  adapterIds: string[]; // order = priority + fallback chain (R-11)
  /**
   * "Does this normalized result answer the request, or should the route keep walking?"
   *
   * vdd-multi TASK-008, H-1. Without this the registry has exactly two signals — a throw means
   * *failed*, a return means *done* — so a provider that truthfully answers "I have nothing for
   * this address" terminates the route and shadows every provider behind it. The first fix
   * attempted was to make the provider THROW on an empty result. That works and is wrong: it puts
   * knowledge of the successor inside the provider. `blockscout` would then be reporting a failure
   * it did not have, and would keep doing so when deployed with no Nansen behind it — a provider
   * whose correctness depends on its neighbours cannot be developed or deployed independently.
   *
   * So the provider states its own truth and **this predicate carries the cross-provider policy**,
   * as data, next to the adapter ORDER that already encodes the spend rule. Applied to cache hits
   * as well as to fresh results — otherwise the same shadowing returns through the cache.
   *
   * When no adapter satisfies it, the walk does not fail: the first truthful-but-unsatisfying
   * result is returned. "No provider has labels for this address" is an answer, not an outage.
   *
   * **PROVISIONAL — superseded by ADR-002 D2**
   * (`docs/onchain-analytics/ADR-002-configurable-routing.md`), which closes OQ-4: this predicate
   * becomes a serialisable descriptor resolved against a registry of policy classes in core —
   * `{ kind: 'any' }` or, for the one route that has a policy today,
   * `{ kind: 'someElementHasAny', fields: [...] }`. The class is deliberately NOT called
   * `nonEmpty`: this predicate accepts a non-empty array of contentless entries as unsatisfying,
   * and a literal "non-empty" reading would reintroduce H-1. Until T-012 lands the descriptor, the
   * text below still describes what is here.
   *
   * This is the smallest hook that keeps the defect
   * out of production, NOT the router. The owner's decision (2026-07-28) is that the real design is
   * settled at a redesign stage, and that it will differ in two ways: the router must be able to
   * call a COMBINATION of adapters and aggregate their results, and the policy should be configured
   * partly in the DB, as classes, rather than as a literal in `providers.config.ts`. In that design
   * this predicate becomes "is what I have collected enough, or do I need another source", joined
   * by the merge rule that does not exist yet.
   *
   * So: do not grow this into a policy engine. Weights, partial merges and multi-source collection
   * are the router's job, and adding them here would make the redesign harder, not easier.
   */
  isSatisfying?: (result: unknown) => boolean;
}
