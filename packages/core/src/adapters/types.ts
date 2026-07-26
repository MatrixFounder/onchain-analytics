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
}
