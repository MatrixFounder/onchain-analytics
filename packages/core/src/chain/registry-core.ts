import { z } from 'zod';
import { ChainRegistryLoadError, UnknownChainError } from './errors.js';

/**
 * Chain registry (TASK-006, R-48/R-60 — ARCHITECTURE.md §3.2 "Модуль `src/chain/registry.ts`",
 * data-model.md §4.1 `ChainInfo` / §4.2.1).
 *
 * The single source of truth about chains. Before this module the engine knew its chains as a
 * literal (`z.enum(['ethereum','solana','dash'])`) duplicated across five layers; here a chain
 * becomes a ROW, and adding one is a data edit rather than a code change across those layers.
 *
 * **This is a build artifact, not a database table and not a startup fetch** (§4.2.1). Three hard
 * reasons, none of them taste:
 *   1. the offline gate ("a full run makes zero network calls") inherited from M1/M2 — a registry
 *      fetched at startup breaks it the same day;
 *   2. CI determinism — a test whose outcome depends on what a vendor served today is not a test;
 *   3. reviewability — changing the set of chains is a git diff a human reads, which matters most
 *      for `rpcHosts`: that column is SSRF surface (security.md §7.2.1).
 *
 * The stated consequence: registry freshness is the OPERATOR's job, not the runtime's. A chain
 * that appeared at a vendor becomes available after the generator runs and the snapshot is
 * committed (task 006-2), never automatically.
 *
 * **This module deliberately does NOT import the data file.** `registry.ts` supplies the shipped
 * snapshot; everything here is a pure function of whatever document it is handed. The split
 * exists so `scripts/sync-chain-registry.ts` can validate its OUTPUT with the very same validator
 * the runtime uses, without importing the file it is in the middle of generating — otherwise
 * deleting the snapshot would break the only tool that can regenerate it.
 */

/** Address-shape family. Drives address validation (R-55) and which adapters can serve the chain
 * — NOT a vendor concept: two chains from the same vendor can differ here. */
export type ChainFamily = 'evm' | 'svm' | 'move' | 'cosmos' | 'utxo' | 'other';

export interface ChainInfo {
  /** Canonical id, CAIP-2 (`eip155:80094`, `solana:5eykt4…`). The ONLY chain value that reaches a
   * cache key or a route — see §4.2.2 for why an alias must never get that far. */
  readonly caip2: string;
  /** Human-facing canonical slug (`berachain`) — what an agent writes and what tools return. */
  readonly slug: string;
  readonly name: string;
  readonly family: ChainFamily;
  /** Every other accepted spelling, including the perpetual legacy `ethereum`/`solana` (R-59a).
   * Globally unique: an alias may not collide with any OTHER chain's slug or alias. */
  readonly aliases: readonly string[];
  /** Native currency symbol (`BERA`) — consumed by `pairs.new` (R-57a) instead of a hardcoded map. */
  readonly nativeSymbol: string | null;
  /** Vendor NAMING only — "what this chain is called at vendor X". Never coverage: conflating the
   * two makes "the vendor has no such chain" indistinguishable from "we never checked" (R-58d). */
  readonly vendors: Readonly<Record<string, string | null>>;
  /** Curated SSRF allowlist for this chain (security.md §7.2.1). `null` ⇒ `wallet.balances.native`
   * is honestly uncovered, NOT broken at runtime. Never auto-filled from a vendor catalog. */
  readonly rpcHosts: readonly string[] | null;
  /** TVL as of registry sync — deliberately stale. Exists ONLY to rank/filter inside
   * `onchain_list_chains` without a network call; never an answer to "what is the TVL"
   * (that is `chain.tvl`, R-53). Surfaced to callers as `tvlUsdAtRegistrySync`. */
  readonly tvlUsdAtSync: number | null;
  /** Chain vanished from the vendor catalogs but the row is kept (R-49f): dropping it would break
   * resolution of ids already stored elsewhere. */
  readonly deprecated: boolean;
}

export interface ChainListFilter {
  /** Substring match over slug, name, and aliases (case-insensitive). */
  readonly query?: string;
  readonly family?: ChainFamily;
  /** Deprecated chains are excluded unless this is true. */
  readonly includeDeprecated?: boolean;
}

export interface ChainRegistry {
  /** @throws {UnknownChainError} with candidates. Pure and offline. */
  resolve(input: string): ChainInfo;
  tryResolve(input: string): ChainInfo | null;
  get(caip2: string): ChainInfo | null;
  list(filter?: ChainListFilter): ChainInfo[];
  size(): number;
  /** epoch-ms UTC of the snapshot this registry was built from — surfaced by
   * `onchain_list_chains` so a caller can tell stale data from missing support. */
  syncedAt(): number;
}

export interface ChainRegistryDeps {
  /** Injected registry document. Tests pass a small synthetic registry instead of the shipped
   * snapshot — same DI convention as `CacheStore`/`BudgetStore` (§3.2). Omitted ⇒ the committed
   * `registry.data.json`. */
  readonly data?: unknown;
}

/** CAIP-2 shape: `namespace:reference`. Namespace/reference bounds follow the CAIP-2 spec; the
 * `other:` namespace is our documented fallback for chains with no registered namespace (task
 * 006-2), so the pattern intentionally admits it rather than hardcoding a namespace allowlist. */
const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

const ChainInfoSchema = z
  .object({
    caip2: z.string().regex(CAIP2_RE, 'caip2 must match <namespace>:<reference>'),
    slug: z.string().min(1),
    name: z.string().min(1),
    family: z.enum(['evm', 'svm', 'move', 'cosmos', 'utxo', 'other']),
    aliases: z.array(z.string().min(1)),
    nativeSymbol: z.string().min(1).nullable(),
    vendors: z.record(z.string(), z.string().min(1).nullable()),
    rpcHosts: z.array(z.string().min(1)).nullable(),
    tvlUsdAtSync: z.number().nullable(),
    deprecated: z.boolean(),
  })
  .strict();

const RegistryDocumentSchema = z
  .object({
    // `$comment` is documentation carried inside the data file itself (the generator writes it);
    // declared explicitly rather than relaxing the object to passthrough, so a genuinely unknown
    // key is still a load failure.
    $comment: z.string().optional(),
    syncedAt: z.number().int().nonnegative(),
    // `.min(1)` is load-bearing, not decoration: an empty registry would turn EVERY request into
    // "unknown chain" while the process still looked healthy (R-60d).
    chains: z.array(ChainInfoSchema).min(1),
  })
  .strict();

/** Case- and punctuation-insensitive form used only as the LAST resolution step. */
function normalizeKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Classic iterative Levenshtein. Only ever called after resolution has already failed, so its
 * O(n·m) cost never touches the hot path. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const curr: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = curr;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

interface ChainIndexes {
  readonly byCaip2: ReadonlyMap<string, ChainInfo>;
  readonly bySlug: ReadonlyMap<string, ChainInfo>;
  readonly byAlias: ReadonlyMap<string, ChainInfo>;
  /** Fuzzy key → chain. Keys that would map to MORE THAN ONE chain are removed entirely (see
   * `buildIndexes`): an ambiguous fuzzy match must fail loudly with candidates, never silently
   * pick whichever row happened to be first. */
  readonly byNormalized: ReadonlyMap<string, ChainInfo>;
  /** Everything a "did you mean" suggestion may propose. */
  readonly suggestable: readonly string[];
}

function buildIndexes(chains: readonly ChainInfo[]): ChainIndexes {
  const byCaip2 = new Map<string, ChainInfo>();
  const bySlug = new Map<string, ChainInfo>();
  const byAlias = new Map<string, ChainInfo>();
  const normalized = new Map<string, ChainInfo | null>(); // null marks an ambiguous key
  const suggestable: string[] = [];

  for (const chain of chains) {
    if (byCaip2.has(chain.caip2)) {
      throw new ChainRegistryLoadError(`duplicate caip2 '${chain.caip2}'`);
    }
    byCaip2.set(chain.caip2, chain);

    if (bySlug.has(chain.slug)) {
      throw new ChainRegistryLoadError(`duplicate slug '${chain.slug}'`);
    }
    bySlug.set(chain.slug, chain);
    suggestable.push(chain.slug);
  }

  for (const chain of chains) {
    for (const alias of chain.aliases) {
      // An alias may repeat this chain's OWN slug/caip2 (the data file does exactly that for
      // `ethereum`), but colliding with a DIFFERENT chain makes resolution ambiguous.
      const slugOwner = bySlug.get(alias);
      if (slugOwner && slugOwner.caip2 !== chain.caip2) {
        throw new ChainRegistryLoadError(
          `alias '${alias}' of '${chain.slug}' collides with slug of '${slugOwner.slug}'`,
        );
      }
      const aliasOwner = byAlias.get(alias);
      if (aliasOwner && aliasOwner.caip2 !== chain.caip2) {
        throw new ChainRegistryLoadError(
          `alias '${alias}' is claimed by both '${aliasOwner.slug}' and '${chain.slug}'`,
        );
      }
      byAlias.set(alias, chain);
      suggestable.push(alias);
    }
  }

  for (const chain of chains) {
    for (const key of [chain.caip2, chain.slug, ...chain.aliases]) {
      const nk = normalizeKey(key);
      if (nk.length === 0) continue;
      const existing = normalized.get(nk);
      if (existing === undefined) {
        normalized.set(nk, chain);
      } else if (existing !== null && existing.caip2 !== chain.caip2) {
        normalized.set(nk, null);
      }
    }
  }

  const byNormalized = new Map<string, ChainInfo>();
  for (const [key, chain] of normalized) {
    if (chain !== null) byNormalized.set(key, chain);
  }

  return {
    byCaip2,
    bySlug,
    byAlias,
    byNormalized,
    suggestable: [...new Set(suggestable)],
  };
}

/** Up to 3 nearest suggestions, capped at edit distance 3 so a wildly wrong input suggests
 * nothing rather than something arbitrary. */
function suggest(input: string, suggestable: readonly string[]): string[] {
  const needle = normalizeKey(input);
  if (needle.length === 0) return [];
  return suggestable
    .map((candidate) => ({ candidate, d: levenshtein(needle, normalizeKey(candidate)) }))
    .filter((entry) => entry.d <= 3)
    .sort((a, b) => a.d - b.d || a.candidate.localeCompare(b.candidate))
    .slice(0, 3)
    .map((entry) => entry.candidate);
}

/**
 * Builds a `ChainRegistry` from a registry document, validating it first.
 *
 * A FACTORY, not a module singleton — mirroring `CapabilityRegistry`/`SqliteCacheStore`
 * (ARCHITECTURE.md §8: nothing in the engine introduces singleton state that scaling would have
 * to unwind).
 *
 * Validation happens HERE, at load, not at first request (R-60c): a malformed registry is a
 * startup failure with a precise message, not a mysterious "unknown chain" hours later.
 *
 * @throws {ChainRegistryLoadError} on a missing/malformed document or any invariant violation.
 */
export function buildChainRegistry(raw: unknown): ChainRegistry {
  const parsed = RegistryDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    // Never degrade to an empty registry — see ChainRegistryLoadError's docstring (R-60d).
    throw new ChainRegistryLoadError(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    );
  }

  const chains: readonly ChainInfo[] = parsed.data.chains;
  const idx = buildIndexes(chains);
  const syncedAtMs = parsed.data.syncedAt;

  function tryResolve(input: string): ChainInfo | null {
    if (typeof input !== 'string' || input.length === 0) return null;
    // Resolution order (§3.2): exact caip2 → slug → alias → normalized. First match wins.
    return (
      idx.byCaip2.get(input) ??
      idx.bySlug.get(input) ??
      idx.byAlias.get(input) ??
      idx.byNormalized.get(normalizeKey(input)) ??
      null
    );
  }

  return {
    tryResolve,
    resolve(input: string): ChainInfo {
      const found = tryResolve(input);
      if (found) return found;
      throw new UnknownChainError(input, suggest(input, idx.suggestable), chains.length);
    },
    get(caip2: string): ChainInfo | null {
      return idx.byCaip2.get(caip2) ?? null;
    },
    list(filter: ChainListFilter = {}): ChainInfo[] {
      const q = filter.query ? normalizeKey(filter.query) : null;
      return chains.filter((chain) => {
        if (!filter.includeDeprecated && chain.deprecated) return false;
        if (filter.family && chain.family !== filter.family) return false;
        if (q) {
          const haystack = [chain.slug, chain.name, ...chain.aliases].map(normalizeKey);
          if (!haystack.some((entry) => entry.includes(q))) return false;
        }
        return true;
      });
    },
    size(): number {
      return chains.length;
    },
    syncedAt(): number {
      return syncedAtMs;
    },
  };
}
