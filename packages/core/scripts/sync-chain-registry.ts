/**
 * `sync-chain-registry` — regenerates `src/chain/registry.data.json` from three keyless vendor
 * catalogs (TASK-006 task 006-2, R-49; ARCHITECTURE.md §3.2 "Модуль scripts/sync-chain-registry.ts").
 *
 * **A DEV SCRIPT. Nothing under `src/` may import it** — the engine never syncs the registry at
 * runtime (data-model.md §4.2.1: offline gate, CI determinism, reviewability of `rpcHosts`).
 * A test asserts that isolation, because breaking it would be invisible otherwise.
 *
 * Usage:
 *   pnpm --filter @onchain-intel/core exec tsx scripts/sync-chain-registry.ts [options]
 *     --offline            read fixtures instead of the network (used by tests)
 *     --fixtures <dir>     fixture directory for --offline
 *     --out <path>         output snapshot (default: src/chain/registry.data.json)
 *     --report <path>      write the human diff report here (default: stdout)
 *     --now <epoch-ms>     timestamp stamped ONLY when the data actually changed
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { buildChainRegistry } from '../src/chain/registry-core.js';

// ---------------------------------------------------------------------------------------------
// Vendor sources. All three are keyless (verified by live probe 2026-07-26 — evidence:
// docs/onchain-analytics/raw/chain-registry-probe-2026-07-26.json).
// ---------------------------------------------------------------------------------------------
const SOURCES = {
  defillama: 'https://api.llama.fi/v2/chains',
  coingecko: 'https://api.coingecko.com/api/v3/asset_platforms',
  eip155: 'https://chainid.network/chains_mini.json',
} as const;

/**
 * The DexScreener coverage witness (task 014-32a, R-33).
 *
 * **The rule is unchanged and the instrument is new.** This generator has always been forbidden to
 * invent vendor identifiers — the vendor publishes no chain catalogue, so a value here can only be
 * WITNESSED. What changed is that the witness is now per chain instead of one spot-check of three:
 * the literal this replaces left 455 rows `null`, and `data-model.md` reads that `null` as "the
 * vendor does not have this chain" — false for 62 of them (L-18).
 *
 * The map is emitted by `scripts/gen-dexscreener-chains.ts` from committed evidence and lives under
 * `src/` because it has TWO readers: this generator takes the column, and the runtime takes the
 * third state (R-33.5). The precedent is `nansen/chain-coverage.ts`, which the adapter imports.
 */
import { DEXSCREENER_CHAIN_COVERAGE } from '../src/adapters/dexscreener/chain-coverage.js';

/** CAIP-2 reference for Solana mainnet-beta (first 32 chars of the genesis hash, per the CAIP
 * solana namespace). Hardcoded because there is no catalog to derive it from. */
const SOLANA_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/**
 * Chains whose DexScreener `chainId` we have actually OBSERVED in a response — the vendor
 * publishes no chain catalog, so this cannot be derived, only witnessed.
 *
 * Deliberately an evidence list, not a guess: `vendors.dexscreener` being non-null is what makes
 * `dexscreener.chainSupport()` return true (data-model.md §4.2.3), so inventing plausible ids here
 * would claim coverage we never verified — the exact failure mode the architecture forbids for
 * `nansen` (R-58d). Values below come from the 2026-07-26 live probe of `/latest/dex/search`.
 * Anything absent stays `null` and is carried forward from the previous snapshot if present.
 */
/**
 * Gas-token decimals for chains the EIP-155 registry cannot know about (vdd-multi cycle 6, H-1).
 *
 * `nativeDecimals` otherwise comes only from `nativeCurrency.decimals`, which exists for EVM chains
 * and nowhere else — so every non-EVM row is `null`, and `rpc-solana` now REFUSES a chain whose
 * decimals it does not know rather than labelling the balance with a literal. Solana's 9 is not a
 * new claim: it is the `decimals: 9` that lived hardcoded in `rpc-solana/index.ts` since M1
 * (lamports per SOL = 10^9, and the adapter's own docstring reasons about that constant). This
 * moves it from code into data, which is the whole point of the registry.
 *
 * A curated column: the generator never overwrites a value it did not produce (see the row build),
 * so an operator can add a chain here or in the previous snapshot and the sync will carry it.
 */
const CURATED_NATIVE_DECIMALS: Readonly<Record<string, number>> = {
  [SOLANA_CAIP2]: 9,
};

/**
 * Aliases no upstream catalogue proposes, added because a VENDOR routes the chain under that
 * spelling (task 014-32a).
 *
 * **Curated here rather than edited into `registry.data.json`.** A hand-edit to the data survives
 * the next `sync` only by accident — the generator rebuilds every row — so the spelling has to live
 * where the row is built. The three below are the candidates the DexScreener probe answered on while
 * the row's own slug did not: measured 2026-08-18, `sei` answers 400 and `seiv2` answers 200.
 *
 * They go through pass 2 like any other candidate, so a collision with another row's slug or alias
 * is dropped and reported rather than silently claimed.
 */
const CURATED_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'other:sei': ['seiv2'],
  'eip155:747': ['flowevm'],
  'eip155:1234': ['stepnetwork'],
};

interface Args {
  offline: boolean;
  fixtures: string;
  out: string;
  report: string | null;
  now: number;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  return {
    offline: argv.includes('--offline'),
    fixtures: get('--fixtures') ?? 'test/fixtures/chain-registry',
    out: get('--out') ?? 'src/chain/registry.data.json',
    report: get('--report'),
    now: Number(get('--now') ?? Date.now()),
  };
}

// --- vendor row shapes (only the fields this script reads) ------------------------------------

interface DefillamaChain {
  name?: unknown;
  gecko_id?: unknown;
  tvl?: unknown;
  tokenSymbol?: unknown;
  chainId?: unknown;
}
interface CoingeckoPlatform {
  id?: unknown;
  name?: unknown;
  chain_identifier?: unknown;
  native_coin_id?: unknown;
}
interface Eip155Chain {
  chainId?: unknown;
  name?: unknown;
  shortName?: unknown;
  nativeCurrency?: { symbol?: unknown; decimals?: unknown };
  rpc?: unknown;
}

interface Catalogs {
  defillama: DefillamaChain[];
  coingecko: CoingeckoPlatform[];
  eip155: Eip155Chain[];
}

/** Output row. Key order here IS the serialized key order — part of the determinism contract. */
interface SnapshotChain {
  caip2: string;
  slug: string;
  name: string;
  family: 'evm' | 'svm' | 'move' | 'cosmos' | 'utxo' | 'other';
  aliases: string[];
  nativeSymbol: string | null;
  nativeDecimals: number | null;
  vendors: {
    defillama: string | null;
    coingecko: string | null;
    dexscreener: string | null;
    nansen: string | null;
  };
  rpcHosts: string[] | null;
  tvlUsdAtSync: number | null;
  deprecated: boolean;
}

interface Snapshot {
  $comment: string;
  syncedAt: number;
  chains: SnapshotChain[];
}

interface Report {
  added: string[];
  deprecated: string[];
  changed: string[];
  ambiguousJoins: string[];
  fuzzyJoined: string[];
  slugConflicts: string[];
  aliasDropped: string[];
  rpcCandidates: string[];
}

// --- helpers ----------------------------------------------------------------------------------

const norm = (raw: string): string => raw.toLowerCase().replace(/[^a-z0-9]/g, '');
const slugify = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return (await response.json()) as unknown;
}

/**
 * Fetches all three catalogs. **Any failure aborts the whole run** (R-49e) — a partially written
 * snapshot is worse than none: it would pass load validation and silently shrink the known world.
 */
async function fetchCatalogs(): Promise<Catalogs> {
  const [defillama, coingecko, eip155] = await Promise.all([
    fetchJson(SOURCES.defillama),
    fetchJson(SOURCES.coingecko),
    fetchJson(SOURCES.eip155),
  ]);
  return asCatalogs({ defillama, coingecko, eip155 });
}

function readFixtures(dir: string): Catalogs {
  const read = (file: string): unknown =>
    JSON.parse(readFileSync(resolvePath(dir, file), 'utf8')) as unknown;
  return asCatalogs({
    defillama: read('defillama-chains.json'),
    coingecko: read('coingecko-platforms.json'),
    eip155: read('eip155-chains.json'),
  });
}

function asCatalogs(raw: { defillama: unknown; coingecko: unknown; eip155: unknown }): Catalogs {
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`catalog '${key}' is empty or not an array — refusing to write a snapshot`);
    }
  }
  return {
    defillama: raw.defillama as DefillamaChain[],
    coingecko: raw.coingecko as CoingeckoPlatform[],
    eip155: raw.eip155 as Eip155Chain[],
  };
}

/**
 * Reads the snapshot being replaced. `null` ONLY when there is no file yet (the genuine
 * bootstrap case).
 *
 * **A parse failure is fatal, not `null`** (vdd-multi cycle 5, L-6). Every curated column —
 * `rpcHosts` (the SSRF allowlist, §7.2.1) and `vendors.nansen` — exists only in this file and is
 * carried forward from it. Swallowing a parse error turned "the snapshot is corrupt" into "there
 * is no snapshot", and the very next write erased 458 rows of hand-curation with `null`s. The
 * generator would report it as a clean run, because from its point of view nothing was lost.
 * A truncated write or a bad merge conflict is exactly how that file gets malformed.
 */
function loadPrevious(out: string): Snapshot | null {
  if (!existsSync(out)) return null;
  try {
    return JSON.parse(readFileSync(out, 'utf8')) as Snapshot;
  } catch (error) {
    throw new Error(
      `previous snapshot at ${out} exists but does not parse. ` +
        'Refusing to run: continuing would silently discard every curated rpcHosts/vendors.nansen ' +
        'value. Restore the file from git, or delete it deliberately to bootstrap from scratch.',
      { cause: error },
    );
  }
}

// --- the join ---------------------------------------------------------------------------------

/**
 * Three-way join, DeFiLlama as the base list.
 *
 * Join keys, in strict preference order (measured 2026-07-26):
 *   1. `defillama.gecko_id` → `coingecko.native_coin_id` — an EXPLICIT vendor cross-reference,
 *      235 hits. This is the trustworthy key.
 *   2. normalized name — 255 hits but FUZZY. Every row joined this way is listed in its own report
 *      section and requires a human to confirm the commit (R-49b). A silent fuzzy join surfaces
 *      later as "the TVL of the wrong chain", with nothing left to diagnose it by.
 */
function joinCatalogs(
  catalogs: Catalogs,
  previous: Snapshot | null,
  report: Report,
): SnapshotChain[] {
  // `native_coin_id` is NOT unique — 28 native coins are shared by 109 platforms, because every
  // L2 that pays gas in ETH reports `native_coin_id: "ethereum"` (49 of them). Taking the first
  // hit mapped Ethereum→alienx, BSC→opbnb, Solana→sonic-svm and Bitcoin→trustless-computer, i.e.
  // it would have sent token lookups to a different chain's platform. So the key is indexed as a
  // LIST and is only trusted when it is unambiguous or a name disambiguates it.
  const cgByNative = new Map<string, CoingeckoPlatform[]>();
  const cgByName = new Map<string, CoingeckoPlatform>();
  const cgByEvmId = new Map<number, CoingeckoPlatform>();
  for (const platform of catalogs.coingecko) {
    const native = str(platform.native_coin_id);
    const name = str(platform.name);
    const evmId = num(platform.chain_identifier);
    if (native) cgByNative.set(native, [...(cgByNative.get(native) ?? []), platform]);
    if (name && !cgByName.has(norm(name))) cgByName.set(norm(name), platform);
    if (evmId !== null && !cgByEvmId.has(evmId)) cgByEvmId.set(evmId, platform);
  }

  // **Testnet rows are excluded from the EIP-155 index** (vdd-multi cycle 5, M-1 follow-on).
  //
  // Our base list is DeFiLlama's MAINNET TVL catalog, so a testnet EIP-155 row can never be the
  // correct match for one of our chains — but chain ids are not globally unique across the two
  // catalogs, and where they collide the testnet wins by arriving first. Two rows were joined this
  // way, and all three things this script derives from the EIP row were wrong for both:
  //
  //   - `hyperliquid-l1` (chainId 999, also Wanchain **Testnet**) → gas symbol `WAN`, alias `twan`,
  //     and the RPC candidate `gwan-ssl.wandevs.org` — the same wrong-chain host that had to be
  //     rejected by hand during the 006-8 curation, whose automated liveness check PASSED because
  //     the endpoint really does answer `chainId 999`.
  //   - `mantra` (MANTRACHAIN **Testnet**) → alias `dukong`.
  //
  // Dropping the row entirely is the honest outcome: no EIP data beats another chain's EIP data.
  // A live chain that only appears in the registry as a testnet simply gets `nativeSymbol` from
  // DeFiLlama and no `shortName` alias.
  const isTestnet = (chain: Eip155Chain): boolean =>
    /\b(testnet|devnet)\b/i.test(str(chain.name) ?? '');

  // Reported only where a dropped row would ACTUALLY have been used — the catalog holds ~1000
  // testnets and listing them all would bury the two lines a reviewer needs.
  const droppedTestnets = new Map<number, string>();
  const eipById = new Map<number, Eip155Chain>();
  for (const chain of catalogs.eip155) {
    const id = num(chain.chainId);
    if (id === null || eipById.has(id)) continue;
    if (isTestnet(chain)) {
      if (!droppedTestnets.has(id)) droppedTestnets.set(id, str(chain.name) ?? '?');
      continue;
    }
    eipById.set(id, chain);
  }

  const prevByCaip2 = new Map<string, SnapshotChain>();
  for (const chain of previous?.chains ?? []) prevByCaip2.set(chain.caip2, chain);

  const takenSlugs = new Map<string, string>(); // slug → caip2
  const takenAliases = new Map<string, string>(); // alias → caip2

  // **Every name the PREVIOUS snapshot used is reserved before the main loop runs** (vdd-multi
  // cycle 6, M-2). Cycle 5 reserved deprecated rows' names, but did it AFTER the main loop had
  // already handed out slugs — so it protected pass 2 and not slug assignment. A live chain could
  // still take the slug of a row that was about to be re-emitted as deprecated, and the generator
  // then produced a snapshot its OWN validator rejects (`duplicate slug`), aborting before
  // `renderReport` ever ran: the operator saw a load error and no line explaining which name
  // caused it — verbatim the failure the L-5 fix was written to eliminate.
  //
  // A reservation is RELEASED below the moment the same `caip2` reappears in the catalogs, so a
  // chain keeps its own names across syncs; only a DIFFERENT chain is blocked from taking them.
  for (const prev of prevByCaip2.values()) {
    takenSlugs.set(prev.slug, prev.caip2);
    for (const alias of prev.aliases) takenAliases.set(alias, prev.caip2);
  }
  const aliasCandidates = new Map<string, string[]>(); // caip2 → proposed aliases (pass 2)
  const out: SnapshotChain[] = [];
  const seenCaip2 = new Set<string>();

  for (const dl of catalogs.defillama) {
    const name = str(dl.name);
    if (!name) continue;

    const geckoId = str(dl.gecko_id);
    const dlEvmId = num(dl.chainId);

    // Join ladder, strongest key first. Each rung is either EXACT (a shared identifier, or a name
    // used only to break a tie inside an already-narrowed candidate set) or FUZZY (a bare name
    // match across the whole catalog) — and every fuzzy hit is reported for human review.
    let cg: CoingeckoPlatform | undefined;
    let fuzzy = false;
    const shared = geckoId ? (cgByNative.get(geckoId) ?? []) : [];

    if (dlEvmId !== null && cgByEvmId.has(dlEvmId)) {
      cg = cgByEvmId.get(dlEvmId); // 1. EIP-155 chain id on both sides — unambiguous by construction
    } else if (shared.length === 1) {
      cg = shared[0]; // 2. gecko_id → exactly one platform
    } else if (shared.length > 1) {
      // 3. ambiguous gecko_id — accept only if exactly one candidate's name matches exactly
      const exact = shared.filter((p) => norm(str(p.name) ?? '') === norm(name));
      if (exact.length === 1) cg = exact[0];
      else
        report.ambiguousJoins.push(
          `${name}: gecko_id '${geckoId ?? '?'}' shared by ${shared.length} platforms — unresolved`,
        );
    }
    if (!cg) {
      cg = cgByName.get(norm(name)); // 4. bare name match across the catalog — FUZZY
      fuzzy = cg !== undefined;
    }
    // Consistency guard: a match whose EVM id contradicts DeFiLlama's is wrong no matter which
    // rung produced it. Better no vendor id than a confidently wrong one.
    const cgEvmId = num(cg?.chain_identifier);
    if (cg && dlEvmId !== null && cgEvmId !== null && cgEvmId !== dlEvmId) {
      report.ambiguousJoins.push(
        `${name}: rejected coingecko '${str(cg.id) ?? '?'}' — chain_identifier ${cgEvmId} ≠ ${dlEvmId}`,
      );
      cg = undefined;
      fuzzy = false;
    }

    const evmChainId = dlEvmId ?? num(cg?.chain_identifier);
    const baseSlug = slugify(name);
    if (baseSlug.length === 0) continue;

    const caip2 =
      evmChainId !== null
        ? `eip155:${evmChainId}`
        : baseSlug === 'solana'
          ? SOLANA_CAIP2
          : `other:${baseSlug}`;

    // Two catalog rows can denote the SAME chain under different names ("BSC"/"Binance",
    // "OP Mainnet"/"Optimism"). Dropping the later row outright would also drop the name a user
    // is most likely to type, so the duplicate is MERGED as an alias of the row that won.
    if (seenCaip2.has(caip2)) {
      const winner = out.find((row) => row.caip2 === caip2);
      const candidate = slugify(name);
      if (winner && candidate.length > 0) {
        const proposed = aliasCandidates.get(caip2) ?? [];
        if (!proposed.includes(candidate)) proposed.push(candidate);
        aliasCandidates.set(caip2, proposed);
        report.slugConflicts.push(`'${name}' duplicates ${caip2} → merged into '${winner.slug}'`);
      }
      continue;
    }

    // Slug collision: disambiguate deterministically where we can, otherwise skip and report.
    // Never invent a silent suffix for a chain we cannot tell apart. A reservation held by THIS
    // chain's own previous row is not a collision — release it (see the seeding above).
    let slug = baseSlug;
    const slugOwner = takenSlugs.get(slug);
    if (slugOwner === caip2) takenSlugs.delete(slug);
    if (slugOwner !== undefined && slugOwner !== caip2) {
      if (evmChainId !== null) {
        slug = `${baseSlug}-${evmChainId}`;
        report.slugConflicts.push(`${name}: slug '${baseSlug}' taken by ${slugOwner} → '${slug}'`);
      } else {
        report.slugConflicts.push(
          `${name}: slug '${baseSlug}' taken by ${slugOwner} — row skipped`,
        );
        continue;
      }
    }

    // Alias candidates are COLLECTED here and only ASSIGNED in a second pass (see below): a
    // candidate may collide with the slug of a chain that has not been processed yet, and an
    // order-dependent check would emit a document the loader rejects. Deduplicated up front —
    // `slugify(name)`, the CoinGecko id and `gecko_id` frequently coincide, and without this the
    // same rejection is reported two or three times over.
    const aliases: string[] = [];
    const eip = evmChainId !== null ? eipById.get(evmChainId) : undefined;
    if (evmChainId !== null && !eip && droppedTestnets.has(evmChainId)) {
      report.ambiguousJoins.push(
        `${slug}: eip155:${evmChainId} resolves to '${droppedTestnets.get(evmChainId) ?? '?'}' (a TESTNET) — ` +
          'EIP row dropped; no gas symbol, shortName alias or RPC candidate derived from it',
      );
    }
    // The EIP-155 registry's `shortName` ('eth', 'arb1', 'bera') is how people actually write a
    // chain. Without it an agent typing `eth` gets "unknown chain" on the single most common
    // spelling there is — and this parameter exists precisely so an agent can type a chain name.
    // Collisions go through pass 2 like any other candidate.
    aliasCandidates.set(caip2, [
      ...new Set(
        [
          slugify(name),
          str(cg?.id),
          geckoId,
          str(eip?.shortName)?.toLowerCase() ?? null,
          ...(CURATED_ALIASES[caip2] ?? []),
        ].filter(
          (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
        ),
      ),
    ]);

    const prev = prevByCaip2.get(caip2);

    // Curated columns are CARRIED FORWARD, never invented and never erased (§7.2.1 for rpcHosts;
    // task 006-9 owns vendors.nansen). A generator that reset them would silently undo the
    // curation on the next sync — the most expensive kind of "harmless" regression.
    const row: SnapshotChain = {
      caip2,
      slug,
      name,
      family: evmChainId !== null ? 'evm' : caip2 === SOLANA_CAIP2 ? 'svm' : 'other',
      aliases,
      // GAS token first, listed token second (vdd-multi cycle 5, M-1). DeFiLlama's `tokenSymbol`
      // is the chain's *listed* asset, which for an L2 is usually its governance token, not what
      // it charges gas in: `op-mainnet → OP`, `arbitrum → ARB`, `gnosis → GNO` — all three
      // actually pay gas in ETH/xDAI. The EIP-155 registry's `nativeCurrency.symbol` is the gas
      // token by definition, so it wins wherever it exists (i.e. for EVM chains). `tokenSymbol`
      // remains the source for everything outside that registry, where it is right (`solana → SOL`,
      // `bitcoin → BTC`).
      //
      // This is not cosmetic: `nativeSymbol` labels the balance `rpc-evm` returns and is the query
      // `dexscreener` searches by. A wrong symbol here is a wrong ANSWER downstream — a BNB balance
      // reported as OP — which is why the correction lands before the consumers (H-3).
      nativeSymbol: str(eip?.nativeCurrency?.symbol) ?? str(dl.tokenSymbol),
      // The EIP-155 registry's value, else a curated one, else whatever the previous snapshot
      // carried. Never a guessed 18 — that is precisely the hardcode this column exists to remove
      // (H-3). `null` where we do not know, which makes `wallet.balances.native` honestly uncovered
      // rather than wrongly labelled.
      nativeDecimals:
        num(eip?.nativeCurrency?.decimals) ??
        CURATED_NATIVE_DECIMALS[caip2] ??
        prev?.nativeDecimals ??
        null,
      vendors: {
        defillama: name,
        coingecko: str(cg?.id),
        // Task 014-32a. The column is now a projection of a per-chain WITNESS, not of a
        // three-entry spot-check: `DEXSCREENER_CHAIN_COVERAGE` is generated by
        // `gen-dexscreener-chains.ts` from committed probe evidence, and its `chainId` is the
        // candidate the vendor actually answered on — which is not always the slug. The carry
        // forward stays: a value the generator did not produce is never erased.
        dexscreener:
          DEXSCREENER_CHAIN_COVERAGE[caip2]?.chainId ?? prev?.vendors.dexscreener ?? null,
        nansen: prev?.vendors.nansen ?? null,
      },
      rpcHosts: prev?.rpcHosts ?? null,
      tvlUsdAtSync: num(dl.tvl),
      deprecated: false,
    };

    takenSlugs.set(slug, caip2);
    seenCaip2.add(caip2);
    out.push(row);

    if (fuzzy) {
      report.fuzzyJoined.push(`${slug} ← coingecko '${str(cg?.id) ?? '?'}' matched by NAME only`);
    }

    // RPC candidates are only ever PROPOSED here (R-56a). https-only: an http endpoint could not
    // be admitted to the allowlist anyway, so proposing one would just waste a reviewer's time.
    if (eip && Array.isArray(eip.rpc)) {
      const https = eip.rpc.filter(
        (url): url is string => typeof url === 'string' && url.startsWith('https://'),
      );
      if (https.length > 0 && row.rpcHosts === null) {
        report.rpcCandidates.push(`${slug}: ${https.slice(0, 3).join(', ')}`);
      }
    }
  }

  // A chain that vanished from the catalogs keeps its row, flagged (R-49f): deleting it would
  // break resolution of ids already stored elsewhere, and "the chain died" is indistinguishable
  // from "the vendor hiccuped" at this distance.
  const newlyDeprecated = new Set<string>();
  for (const [caip2, prev] of prevByCaip2) {
    if (seenCaip2.has(caip2)) continue;
    out.push({ ...prev, deprecated: true });
    report.deprecated.push(prev.slug);
    newlyDeprecated.add(caip2);
    // A deprecated row still OCCUPIES its slug and aliases (vdd-multi cycle 5, L-5). The loader
    // rejects a collision regardless of the `deprecated` flag — the row is still resolvable, which
    // is the whole reason it is kept — so leaving these names unclaimed let pass 2 hand a live
    // chain an alias that a dead chain already owned. The generator then wrote a snapshot its own
    // validator refuses, and the failure surfaced as a load error with no line in the report
    // explaining which alias caused it.
    // (Reservation already made before the main loop — see the seeding of `takenSlugs`/
    // `takenAliases` above, which is what makes it effective for slug ASSIGNMENT and not just for
    // pass 2.)
  }

  // --- pass 2: aliases, now that EVERY slug is known ------------------------------------------
  // Order-independent by construction. A candidate is rejected when it is any chain's slug (other
  // than this chain's own) or already another chain's alias — the loader treats either as a fatal
  // error, so the generator must not be able to emit one no matter what order the catalog is in.
  for (const row of out) {
    for (const candidate of aliasCandidates.get(row.caip2) ?? []) {
      if (row.aliases.includes(candidate)) continue;
      const slugOwner = takenSlugs.get(candidate);
      if (slugOwner !== undefined && slugOwner !== row.caip2) {
        report.aliasDropped.push(`${row.slug}: alias '${candidate}' is the slug of ${slugOwner}`);
        continue;
      }
      const aliasOwner = takenAliases.get(candidate);
      if (aliasOwner === row.caip2) takenAliases.delete(candidate);
      if (aliasOwner !== undefined && aliasOwner !== row.caip2) {
        report.aliasDropped.push(
          `${row.slug}: alias '${candidate}' already claimed by ${aliasOwner}`,
        );
        continue;
      }
      row.aliases.push(candidate);
      takenAliases.set(candidate, row.caip2);
    }
  }

  // Stable order — part of the determinism contract (R-49c).
  out.sort((a, b) => a.caip2.localeCompare(b.caip2));

  // Added/changed detection runs HERE, after every mutation, not inline in the loop. The
  // duplicate-caip2 merge above appends an alias to a row that was already pushed, so an inline
  // comparison would have reported "no change" while the file on disk did change — a report that
  // lies is worse than no report, since the whole point is that a human reviews the diff.
  for (const row of out) {
    if (newlyDeprecated.has(row.caip2)) continue; // already its own report section
    const prev = prevByCaip2.get(row.caip2);
    if (!prev) report.added.push(row.slug);
    else if (JSON.stringify(prev) !== JSON.stringify(row)) report.changed.push(row.slug);
  }
  return out;
}

function renderReport(report: Report): string {
  const section = (title: string, lines: readonly string[]): string =>
    `## ${title} (${lines.length})\n${lines.length ? lines.map((l) => `- ${l}`).join('\n') : '- none'}\n`;
  return [
    '# chain registry sync report\n',
    section('Added', report.added),
    section('Deprecated (vanished from catalogs, row kept)', report.deprecated),
    section('Changed', report.changed),
    section(
      'Ambiguous / rejected vendor joins — vendors.coingecko left null',
      report.ambiguousJoins,
    ),
    section('FUZZY name-joined — REVIEW BY HAND before committing', report.fuzzyJoined),
    section('Slug conflicts', report.slugConflicts),
    section('Aliases dropped (collision)', report.aliasDropped),
    section(
      'RPC candidates — NOT written to rpcHosts; curate manually in task 006-8',
      report.rpcCandidates,
    ),
  ].join('\n');
}

const SNAPSHOT_COMMENT =
  'GENERATED by scripts/sync-chain-registry.ts (TASK-006 R-49) — do not hand-edit, except the ' +
  'CURATED columns `rpcHosts` (task 006-8, security.md §7.2.1) and `vendors.nansen` (task 006-9), ' +
  'which the generator carries forward and never overwrites. Alias policy: aliases are hard-unique ' +
  'across the registry and a collision is a LOAD FAILURE, so generic cluster words ("mainnet") are ' +
  'never emitted. Regenerate with: pnpm --filter @onchain-intel/core sync:chains';

export async function syncChainRegistry(argv: readonly string[] = []): Promise<void> {
  const args = parseArgs(argv);
  const catalogs = args.offline ? readFixtures(args.fixtures) : await fetchCatalogs();

  const report: Report = {
    added: [],
    deprecated: [],
    changed: [],
    ambiguousJoins: [],
    fuzzyJoined: [],
    slugConflicts: [],
    aliasDropped: [],
    rpcCandidates: [],
  };

  const previous = loadPrevious(args.out);
  const chains = joinCatalogs(catalogs, previous, report);
  if (chains.length === 0) throw new Error('join produced zero chains — refusing to write');

  // `syncedAt` moves ONLY when the data actually changed. Without this, every run would rewrite
  // the file and the "two consecutive runs are byte-identical" guarantee (R-49c) would be false
  // by construction — and every sync would produce a meaningless diff.
  const unchanged = previous !== null && JSON.stringify(previous.chains) === JSON.stringify(chains);
  const snapshot: Snapshot = {
    $comment: SNAPSHOT_COMMENT,
    syncedAt: unchanged ? previous.syncedAt : args.now,
    chains,
  };

  // **The report is emitted BEFORE the validation gate** (vdd-multi cycle 6, M-2). It used to come
  // after, so a rejected run printed a bare `duplicate slug 'foo'` and discarded the one artifact
  // that says WHICH rows collided and why — the exact "failure with no diagnostics" the report
  // exists to prevent. The report describes the run that was attempted; whether the snapshot was
  // then accepted is a separate fact, stated below.
  const rendered = renderReport(report);
  if (args.report) writeFileSync(args.report, rendered, 'utf8');
  else process.stdout.write(rendered);

  // The generator must never emit a document the RUNTIME loader would reject: the loader's
  // invariants (unique caip2/slug, globally non-overlapping aliases) are exactly what caught the
  // ambiguous-join defect, and re-running them here turns "the build breaks for every consumer"
  // into "the sync refuses to write". Same validator, not a reimplementation of it.
  buildChainRegistry(snapshot);

  writeFileSync(args.out, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

const invokedDirectly = process.argv[1]?.endsWith('sync-chain-registry.ts') ?? false;
if (invokedDirectly) {
  syncChainRegistry(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`sync-chain-registry failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
