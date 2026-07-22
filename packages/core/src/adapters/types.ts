import type { TokenBucketConfig } from '../net/rate-limit.js';
import type { Chain } from '../types/chain.js';

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
