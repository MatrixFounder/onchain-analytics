/**
 * Measures which query strategy `pairs.active` can be served by — task 014-32c, L-19.
 *
 * **The question, and why it needed measuring rather than deciding.** The adapter serves
 * `pairs.active` from the keyless SEARCH endpoint, queried by the chain's NATIVE SYMBOL, and then
 * filters the rows by `pair.chainId`. That endpoint is a global relevance ranking, so on a chain
 * whose ticker does not rank on itself the filter has nothing left to keep and the tool answers an
 * empty page with HTTP 200 — a false statement about the chain (L-19).
 *
 * L-19's own fix-path note pointed at the two per-chain routes
 * (`/token-pairs/v1/{chainId}/{tokenAddress}`, `/latest/dex/pairs/{chainId}/{pairId}`). Neither
 * answers "the active pairs on this chain": both need a token or pair address the caller does not
 * have. Probed 2026-08-20, the list forms of those paths — `/latest/dex/pairs/{chainId}`,
 * `/token-pairs/v1/{chainId}`, `/latest/dex/chains/{chainId}`, `/latest/dex/chains` — all answer
 * HTTP 404. The promotion feeds (`/token-boosts/*`, `/token-profiles/latest/v1`) carry a `chainId`
 * but no liquidity or volume, cap at 30 rows, and are ranked by who paid.
 *
 * So there is no route that lists a chain's pairs, and every implementation of this capability is a
 * query-string heuristic over one global index. This script measures the candidates instead of
 * picking one.
 *
 * **The candidates, all derivable from the registry — no new curated column.**
 *
 * | key | query |
 * | :-- | :-- |
 * | `nativeSymbol` | today's strategy, the one L-19 was filed against |
 * | `slug` | our canonical chain slug |
 * | `vendorId` | `vendors.dexscreener` — the vendor's own chain id |
 * | `name` | the registry's display name |
 * | `wrappedGuess` | `W` + `nativeSymbol` — the wrapped-native ticker, GUESSED not curated |
 *
 * `wrappedGuess` is included because it is the obvious next guess and the measurement is the place
 * to find out that it is a bad one: `WETH` is the wrapped native of several chains at once, so it
 * ranks for none of them in particular.
 *
 * **What is counted.** For each query, the number of returned rows whose `chainId` equals the
 * chain's own vendor id — that is exactly what the adapter's filter keeps. Then the UNION over the
 * candidate set, deduplicated by `pairAddress`, which is what a multi-query strategy would yield.
 * A chain whose union is 0 is a chain this capability cannot serve by any of these strategies, and
 * the honest answer there is a refusal, not an empty page.
 *
 * Keyless, read-only, zero credits. Run by hand; never by CI (R-21).
 */
import { writeFileSync } from 'node:fs';
import { loadChainRegistry } from '../src/chain/registry.js';
import type { ChainInfo } from '../src/chain/registry-core.js';

const ENDPOINT = 'https://api.dexscreener.com/latest/dex/search?q=';
/** The vendor's own page cap, pinned by `dexscreener/index.ts` and re-measured by every row here. */
const VENDOR_PAGE_SIZE = 30;
/** The pace task 014-32a settled on for this host: 60 req/min with headroom. */
const PACE_MS = 320;

type StrategyKey = 'nativeSymbol' | 'slug' | 'vendorId' | 'name' | 'wrappedGuess';

interface QueryResult {
  readonly query: string;
  readonly httpStatus: number;
  readonly rowsReturned: number;
  readonly onChain: number;
  /** `pairAddress` of every on-chain row, so the union can be deduplicated honestly. */
  readonly onChainPairs: readonly string[];
}

interface ChainRow {
  readonly slug: string;
  readonly vendorId: string;
  readonly queries: Partial<Record<StrategyKey, QueryResult>>;
  /** Distinct on-chain pair addresses across every candidate. */
  readonly unionOnChain: number;
  /** The single best candidate, and how many it found. */
  readonly bestStrategy: StrategyKey | null;
  readonly bestOnChain: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function candidatesFor(chain: ChainInfo): Partial<Record<StrategyKey, string>> {
  const vendorId = chain.vendors['dexscreener'];
  const out: Partial<Record<StrategyKey, string>> = {};
  if (chain.nativeSymbol !== null && chain.nativeSymbol !== undefined) {
    out.nativeSymbol = chain.nativeSymbol;
    out.wrappedGuess = `W${chain.nativeSymbol}`;
  }
  out.slug = chain.slug;
  if (typeof vendorId === 'string') out.vendorId = vendorId;
  out.name = chain.name;
  return out;
}

async function runQuery(query: string, vendorId: string): Promise<QueryResult> {
  const response = await fetch(`${ENDPOINT}${encodeURIComponent(query)}`);
  if (response.status !== 200) {
    return { query, httpStatus: response.status, rowsReturned: 0, onChain: 0, onChainPairs: [] };
  }
  const body = (await response.json()) as {
    pairs?: { chainId?: unknown; pairAddress?: unknown }[];
  };
  const rows = body.pairs ?? [];
  const onChainPairs = rows
    .filter((row) => row.chainId === vendorId)
    .map((row) => row.pairAddress)
    .filter((address): address is string => typeof address === 'string');
  return {
    query,
    httpStatus: 200,
    rowsReturned: rows.length,
    onChain: onChainPairs.length,
    onChainPairs,
  };
}

async function main(): Promise<void> {
  const chains = loadChainRegistry();
  const covered = chains
    .list()
    .filter((chain): chain is ChainInfo => typeof chain.vendors['dexscreener'] === 'string');
  process.stdout.write(
    `probing ${String(covered.length)} covered chains at ${String(PACE_MS)}ms\n`,
  );

  const startedAt = Date.now();
  const results: ChainRow[] = [];
  let issued = 0;

  for (const chain of covered) {
    const vendorId = chain.vendors['dexscreener'] as string;
    const candidates = candidatesFor(chain);
    // One request per DISTINCT string: `slug` and `vendorId` are the same word on most chains, and
    // paying twice for it would inflate the cost of the measurement without changing any number.
    const byQuery = new Map<string, QueryResult>();
    const queries: Partial<Record<StrategyKey, QueryResult>> = {};
    for (const [key, query] of Object.entries(candidates) as [StrategyKey, string][]) {
      let result = byQuery.get(query);
      if (result === undefined) {
        await sleep(PACE_MS);
        result = await runQuery(query, vendorId);
        issued += 1;
        byQuery.set(query, result);
      }
      queries[key] = result;
    }

    const union = new Set<string>();
    for (const result of byQuery.values()) for (const pair of result.onChainPairs) union.add(pair);
    let bestStrategy: StrategyKey | null = null;
    let bestOnChain = 0;
    for (const [key, result] of Object.entries(queries) as [StrategyKey, QueryResult][]) {
      if (result.onChain > bestOnChain) {
        bestOnChain = result.onChain;
        bestStrategy = key;
      }
    }
    results.push({
      slug: chain.slug,
      vendorId,
      queries,
      unionOnChain: union.size,
      bestStrategy,
      bestOnChain,
    });
    process.stdout.write(
      `  ${String(results.length)}/${String(covered.length)} ${chain.slug}: union ${String(union.size)}\r`,
    );
  }

  const elapsedSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));
  const perStrategy = (['nativeSymbol', 'slug', 'vendorId', 'name', 'wrappedGuess'] as const).map(
    (key) => ({
      strategy: key,
      chainsMeasured: results.filter((row) => row.queries[key] !== undefined).length,
      chainsWithAtLeastOneRow: results.filter((row) => (row.queries[key]?.onChain ?? 0) > 0).length,
      totalOnChainRows: results.reduce((sum, row) => sum + (row.queries[key]?.onChain ?? 0), 0),
    }),
  );
  const emptyUnion = results.filter((row) => row.unionOnChain === 0).map((row) => row.slug);
  const emptyToday = results
    .filter((row) => (row.queries.nativeSymbol?.onChain ?? 0) === 0)
    .map((row) => row.slug);

  const probedAt = new Date().toISOString().slice(0, 10);
  const evidence = {
    $comment:
      'Task 014-32c / L-19 — which query strategy can serve `pairs.active`, measured over every ' +
      'chain the coverage predicate admits. The vendor publishes NO per-chain listing route: ' +
      '/latest/dex/pairs/{chainId}, /token-pairs/v1/{chainId}, /latest/dex/chains/{chainId} and ' +
      '/latest/dex/chains all answer HTTP 404, and the promotion feeds carry no liquidity or ' +
      'volume. So every implementation is a query heuristic over one global relevance index, and ' +
      'the load-bearing fields here are `emptyUnionChains` — chains no candidate reaches, where ' +
      'the honest answer is a refusal rather than an empty page.',
    probedAt,
    endpoint: `${ENDPOINT}<query>`,
    auth: 'none (keyless)',
    paceMs: PACE_MS,
    vendorPageSize: VENDOR_PAGE_SIZE,
    elapsedSeconds,
    requestsIssued: issued,
    chainsProbed: results.length,
    perStrategy,
    emptyUnionCount: emptyUnion.length,
    emptyUnionChains: emptyUnion,
    emptyUnderTodaysStrategyCount: emptyToday.length,
    emptyUnderTodaysStrategy: emptyToday,
    results,
  };
  const path = `../../docs/onchain-analytics/raw/dexscreener-pairs-strategy-${probedAt}.json`;
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `\nevidence -> ${path}\n${String(issued)} requests, ${String(elapsedSeconds)}s\n\n`,
  );
  for (const row of perStrategy) {
    process.stdout.write(
      `${row.strategy.padEnd(14)} answers on ${String(row.chainsWithAtLeastOneRow).padStart(3)}/${String(row.chainsMeasured)} chains, ${String(row.totalOnChainRows)} rows total\n`,
    );
  }
  process.stdout.write(
    `\nempty under TODAY's strategy: ${String(emptyToday.length)} chains\n` +
      `empty under the UNION of all candidates: ${String(emptyUnion.length)} chains${emptyUnion.length > 0 ? ` — ${emptyUnion.join(', ')}` : ''}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
