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
  /** GAS-token symbol (`BERA`, `XDAI`) — consumed by `pairs.new` (R-57a) and by
   * `wallet.balances.native` to label the balance, instead of a hardcoded map. **The gas token, not
   * the chain's listed/governance token** (vdd-multi cycle 5, M-1): `arbitrum` is `ETH`, not `ARB`.
   * `null` ⇒ we do not know it, and any capability that needs it is honestly uncovered. */
  readonly nativeSymbol: string | null;
  /** Decimals of that gas token. Paired with `nativeSymbol` and for the same reason (vdd-multi
   * cycle 5, H-3): `eth_getBalance` returns an integer in the smallest unit, so a consumer needs
   * BOTH to render it. 18 is the EVM convention but not a rule — 29 chains in the EIP-155 catalog
   * use something else — and a hardcoded 18 is a wrong answer that looks exactly like a right one. */
  readonly nativeDecimals: number | null;
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

/**
 * May this string be admitted to the per-chain SSRF allowlist? (vdd-multi cycle 6, security M-1.)
 *
 * Deliberately strict, because everything downstream trusts this column: `https:` only (no other
 * scheme can be reached anyway, so anything else is a curation mistake worth surfacing), no
 * userinfo (`https://looks-legit@evil.example` resolves to `evil.example` — the classic way to
 * make a hostile host read as a friendly one in review), and no IP literal (a curated allowlist
 * entry should name a host a human recognizes; `safeFetch` does no private-range check, so a
 * loopback or metadata address here would simply be dialled).
 */
const RPC_URL_REQUIREMENT =
  'rpcHosts entries must be https:// URLs with a plain hostname (no userinfo, no IP literal)';

function isApprovableRpcUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  // `URL` wraps an IPv6 literal in brackets; IPv4 is four dotted decimal groups.
  if (url.hostname.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)) return false;
  return url.hostname.includes('.');
}

const ChainInfoSchema = z
  .object({
    caip2: z.string().regex(CAIP2_RE, 'caip2 must match <namespace>:<reference>'),
    slug: z.string().min(1),
    name: z.string().min(1),
    family: z.enum(['evm', 'svm', 'move', 'cosmos', 'utxo', 'other']),
    aliases: z.array(z.string().min(1)),
    nativeSymbol: z.string().min(1).nullable(),
    nativeDecimals: z.number().int().nonnegative().max(36).nullable(),
    vendors: z.record(z.string(), z.string().min(1).nullable()),
    // `.min(1)` — an EMPTY array is a load failure, not "no hosts" (vdd-multi cycle 5, M-3). The
    // two states a curator can mean are `null` ("we never approved a host") and a non-empty list;
    // `[]` reads like the first but passed `rpcHosts !== null`, so `rpc-evm` claimed coverage and
    // then fell back to ETHEREUM's endpoints — answering with another chain's balance, cached and
    // schema-valid. `[]` is exactly what someone writes for "looked, found none".
    //
    // Each entry is also SHAPE-CHECKED (vdd-multi cycle 6, security M-1). This column is the SSRF
    // allowlist, and its only automated gate used to be `.min(1)` on the string — so
    // `https://rpc.legit.org@evil.example` (userinfo: the real host is `evil.example`),
    // `https://127.0.0.1:8545`, and a bare `evil.example` all loaded fine and all read as
    // plausible entries in a 458-row diff. A malformed entry is now a LOAD failure, the same class
    // as a duplicate `caip2` — which is the point of shipping the registry as a reviewed artifact.
    rpcHosts: z
      .array(z.string().min(1).refine(isApprovableRpcUrl, RPC_URL_REQUIREMENT))
      .min(1)
      .nullable(),
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

/**
 * Hard upper bound on a chain string this module will do ANY per-candidate work for (vdd-multi
 * cycle 5, H-2).
 *
 * The bound is not a formatting preference, it is a liveness guard. `suggest()` runs a Levenshtein
 * against ~1300 candidates, so its cost is linear in the input length with a factor of a thousand —
 * measured at 416 ms for a 20 000-char input, i.e. seconds-to-minutes of FULL blockage of this
 * single-threaded stdio server for a request that is already known to be invalid. The schema's own
 * `.max(64)` does NOT prevent this: zod 4 marks `too_big` with `continue: true`, so `superRefine`
 * still runs on a string of any length.
 *
 * The same class of defect is already closed one module over — `chain/address.ts`'s
 * `MAX_DECODABLE_ADDRESS_LENGTH` before an O(n²) base58 decode — and this is its chain-string twin.
 * The longest real value is a CAIP-2 id (`namespace:reference`, ≤ 41 chars), so 64 is slack.
 */
export const MAX_CHAIN_INPUT_LENGTH = 64;

/** Case- and punctuation-insensitive form used only as the LAST resolution step. */
function normalizeKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Classic iterative Levenshtein, **bounded**: returns the exact distance when it is ≤ `max`, and
 * some value > `max` otherwise (never a meaningful number above the bound). Only ever called after
 * resolution has already failed, so its O(n·m) cost never touches the hot path.
 *
 * The length-difference bail is what makes the bound cheap rather than merely correct: a distance
 * can never be smaller than the difference in lengths, so a candidate that cannot possibly qualify
 * is rejected in O(1) instead of O(n·m). At the caller's `max = 3` that discards nearly the whole
 * registry before a single matrix row is allocated.
 */
function boundedLevenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const curr: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const d = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      curr[j] = d;
      if (d < rowMin) rowMin = d;
    }
    // Every subsequent row is ≥ this row's minimum, so once the whole row exceeds `max` the final
    // distance cannot come back under it.
    if (rowMin > max) return max + 1;
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
  /** Everything a "did you mean" suggestion may propose, each paired with its normalized form.
   * The key is precomputed at build time because `suggest()` would otherwise recompute all ~1300
   * of them on every failed resolution (vdd-multi cycle 5, H-2) — work that is identical every
   * time and depends only on the snapshot. */
  readonly suggestable: readonly SuggestCandidate[];
  /** `caip2 → the normalized concatenation of slug, name, caip2 and every alias`, for `list()`'s
   * substring search. Precomputed for the same reason as `suggestable` (vdd-multi cycle 6, perf) —
   * see the call site in `list()`. */
  readonly searchKeys: ReadonlyMap<string, string>;
}

interface SuggestCandidate {
  readonly value: string;
  readonly key: string;
}

function buildIndexes(chains: readonly ChainInfo[]): ChainIndexes {
  const byCaip2 = new Map<string, ChainInfo>();
  const bySlug = new Map<string, ChainInfo>();
  const byAlias = new Map<string, ChainInfo>();
  const normalized = new Map<string, ChainInfo | null>(); // null marks an ambiguous key
  const suggestable: string[] = [];
  // Deprecated rows still resolve (R-49f), but they are never OFFERED as a suggestion: proposing a
  // dead chain is worse than proposing nothing, and `list()`/`chainsFor()` already exclude them.
  const isSuggestable = (chain: ChainInfo): boolean => !chain.deprecated;

  for (const chain of chains) {
    if (byCaip2.has(chain.caip2)) {
      throw new ChainRegistryLoadError(`duplicate caip2 '${chain.caip2}'`);
    }
    byCaip2.set(chain.caip2, chain);

    if (bySlug.has(chain.slug)) {
      throw new ChainRegistryLoadError(`duplicate slug '${chain.slug}'`);
    }
    bySlug.set(chain.slug, chain);
    if (isSuggestable(chain)) suggestable.push(chain.slug);
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
      // ...and colliding with another chain's CAIP-2 id is the same defect one index over
      // (vdd-multi cycle 5, L-8): `tryResolve` checks `byCaip2` FIRST, so such an alias is dead
      // on arrival — the caller silently gets the other chain. Only the two collisions below were
      // checked before, which let a third, equally silent one through.
      const caip2Owner = byCaip2.get(alias);
      if (caip2Owner && caip2Owner.caip2 !== chain.caip2) {
        throw new ChainRegistryLoadError(
          `alias '${alias}' of '${chain.slug}' collides with caip2 of '${caip2Owner.slug}'`,
        );
      }
      const aliasOwner = byAlias.get(alias);
      if (aliasOwner && aliasOwner.caip2 !== chain.caip2) {
        throw new ChainRegistryLoadError(
          `alias '${alias}' is claimed by both '${aliasOwner.slug}' and '${chain.slug}'`,
        );
      }
      byAlias.set(alias, chain);
      if (isSuggestable(chain)) suggestable.push(alias);
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

  // Space-joined, which is a SAFE separator here precisely because `normalizeKey` has already
  // stripped every non-alphanumeric character from each field — and the query is normalized the
  // same way, so it can never contain a space. A match therefore cannot straddle two fields (the
  // tail of `name` plus the head of an alias).
  const searchKeys = new Map<string, string>();
  for (const chain of chains) {
    searchKeys.set(
      chain.caip2,
      [chain.slug, chain.name, chain.caip2, ...chain.aliases].map(normalizeKey).join(' '),
    );
  }

  return {
    byCaip2,
    bySlug,
    byAlias,
    byNormalized,
    suggestable: [...new Set(suggestable)].map((value) => ({ value, key: normalizeKey(value) })),
    searchKeys,
  };
}

/** How far a suggestion may be from the input. Also the bound handed to `boundedLevenshtein`, so
 * a candidate that cannot qualify costs O(1) instead of a full matrix. */
const MAX_SUGGEST_DISTANCE = 3;

/**
 * Up to 3 nearest suggestions, capped at edit distance 3 so a wildly wrong input suggests nothing
 * rather than something arbitrary.
 *
 * The length guard is load-bearing, not defensive (vdd-multi cycle 5, H-2): this is the ONLY
 * unbounded per-candidate work in the module, and it is reachable from an untrusted MCP argument.
 * A suggestion for an input longer than any real chain id could not be useful anyway — nothing in
 * the registry is within 3 edits of it — so refusing to compute it loses nothing.
 */
function suggest(input: string, suggestable: readonly SuggestCandidate[]): string[] {
  if (input.length > MAX_CHAIN_INPUT_LENGTH) return [];
  const needle = normalizeKey(input);
  if (needle.length === 0) return [];
  return suggestable
    .map((candidate) => ({
      candidate: candidate.value,
      d: boundedLevenshtein(needle, candidate.key, MAX_SUGGEST_DISTANCE),
    }))
    .filter((entry) => entry.d <= MAX_SUGGEST_DISTANCE)
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
          // One PRECOMPUTED string per row, joined with NUL so a match cannot straddle two fields
          // (vdd-multi cycle 6, perf). This used to build the haystack per call: ~2 290
          // `normalizeKey` calls and ~4 600 transient strings for a single query'd `list()`, all
          // of it identical every time — and `.map()` before `.some()` materialised every field
          // first, so the short-circuit bought nothing. `onchain_list_chains` is the tool every
          // other tool's description now tells the model to call.
          //
          // `caip2` is part of the key because `resolve()` accepts a CAIP-2 id (cycle 5, L-7): a
          // caller holding one otherwise got an empty page for a chain the engine resolves fine.
          if (!(idx.searchKeys.get(chain.caip2) ?? '').includes(q)) return false;
          // (`?? ''` is unreachable — every row is indexed — but a silent `undefined.includes`
          // would be a crash, and a silent `true` would be a wrong page.)
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
