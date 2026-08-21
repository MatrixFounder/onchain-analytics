/**
 * Measures the two vendor routes behind `token.pools` — task 014-32d, `interfaces.md` §5.1.8.
 *
 * **Three obligations, and the task states all three as acceptance criteria.** The page cap of
 * `token-pairs/v1/{chainId}/{tokenAddress}`, the page cap of `/latest/dex/tokens/{tokenAddress}`,
 * and whether either route's row ORDER is stable or means anything. None of them may be inherited
 * from `/latest/dex/search`: `VENDOR_PAGE_SIZE = 30` was measured there, on a route that takes a
 * `q` parameter these two do not have, and carrying a number between routes is how a measurement
 * becomes a guess (the task forbids it by name).
 *
 * **A cap is only a cap if something under it comes back short.** Every route here is asked for a
 * token with no pools as well as for the most-traded ones. Without that row a full page carries no
 * information — it could equally be a fixed-size response — which is the reasoning
 * `page-size.evidence.md` already records for the search route.
 *
 * **The ordering probe needs an INTERVAL, so the interval is part of the instrument.** Two samples
 * of the same address separated by `ONCHAIN_PROBE_ORDER_GAP_MS`, compared on three questions: is the
 * row set the same, is the row ORDER the same, and is either sample sorted by liquidity. A single
 * sample cannot answer any of them, and a human remembering to come back later is not a measurement.
 *
 * Keyless, read-only, zero credits. Run by hand; never by CI (R-21).
 *
 *   pnpm --filter @onchain-intel/core probe:token-routes
 *   ONCHAIN_PROBE_ORDER_GAP_MS=600000 pnpm --filter @onchain-intel/core probe:token-routes
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChainRegistry } from '../src/chain/registry.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');

const BASE = 'https://api.dexscreener.com';
/** The pace task 014-32a settled on for this host: 60 req/min with headroom. */
const PACE_MS = 320;
const ORDER_GAP_MS = Number(process.env['ONCHAIN_PROBE_ORDER_GAP_MS'] ?? 300_000);

/**
 * Probe subjects: our canonical chain slug, the token, and why it is here.
 *
 * The deliberately-absent address is the control the cap claim rests on. It is a well-formed EVM
 * address that no deployment uses, so a 0-row answer is the vendor saying "nothing", not an error.
 */
const SUBJECTS: { chain: string; token: string; note: string }[] = [
  {
    chain: 'ethereum',
    token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    note: 'WETH — the most-traded token on the chain',
  },
  {
    chain: 'ethereum',
    token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    note: 'USDC — the cross-chain form of this address is the fork case',
  },
  {
    chain: 'bsc',
    token: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    note: 'WBNB — a second chain, to separate "cap" from "one chain is small"',
  },
  {
    chain: 'berachain',
    token: '0xD2C41BF4033A83C0FC3A7F58a392Bf37d6dCDb58',
    note: 'osBGT — the task’s own example, measured at 6 pools on 2 DEXes',
  },
  {
    chain: 'ethereum',
    token: '0x00000000000000000000000000000000DeaDBeef',
    note: 'CONTROL: a well-formed address nothing deploys — proves 30 is a cap, not a fixed size',
  },
];

/** The address whose ordering is sampled twice. USDC-on-ethereum, i.e. the fork case as well. */
const ORDER_SUBJECT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Pair {
  chainId?: unknown;
  dexId?: unknown;
  pairAddress?: unknown;
  liquidity?: { usd?: unknown };
}

interface Sample {
  url: string;
  httpStatus: number;
  rows: number;
  chains: Record<string, number>;
  dexes: string[];
  pairAddresses: string[];
  liquidityUsd: (number | null)[];
}

async function sample(url: string): Promise<Sample> {
  const response = await fetch(url);
  const empty: Sample = {
    url,
    httpStatus: response.status,
    rows: 0,
    chains: {},
    dexes: [],
    pairAddresses: [],
    liquidityUsd: [],
  };
  if (response.status !== 200) return empty;

  const body = (await response.json()) as { pairs?: Pair[] | null } | Pair[] | null;
  // `/latest/dex/tokens` answers `{pairs: [...]}`; `token-pairs/v1` answers a bare ARRAY. Both
  // shapes are handled here rather than assumed, because assuming one is how a route change reads
  // as "this token trades nowhere".
  const rows: Pair[] = Array.isArray(body) ? body : (body?.pairs ?? []);

  const chains: Record<string, number> = {};
  for (const row of rows) {
    const id = typeof row.chainId === 'string' ? row.chainId : '(missing)';
    chains[id] = (chains[id] ?? 0) + 1;
  }
  return {
    url,
    httpStatus: 200,
    rows: rows.length,
    chains,
    dexes: [...new Set(rows.map((r) => (typeof r.dexId === 'string' ? r.dexId : '(missing)')))],
    pairAddresses: rows.map((r) => (typeof r.pairAddress === 'string' ? r.pairAddress : '')),
    liquidityUsd: rows.map((r) => {
      const usd = r.liquidity?.usd;
      return typeof usd === 'number' ? usd : null;
    }),
  };
}

/** Whether the sample is sorted by liquidity, descending — the ranking a caller would ASSUME. */
function descendingByLiquidity(values: (number | null)[]): boolean {
  const known = values.filter((v): v is number => v !== null);
  return known.every((v, i) => i === 0 || (known[i - 1] as number) >= v);
}

async function main(): Promise<void> {
  const chains = loadChainRegistry();
  const vendorId = (slug: string): string => {
    const id = chains.resolve(slug).vendors['dexscreener'];
    if (typeof id !== 'string') throw new Error(`${slug} has no dexscreener vendor id`);
    return id;
  };

  const startedAt = Date.now();
  let issued = 0;

  const perChain = [];
  const crossChain = [];
  for (const subject of SUBJECTS) {
    const a = await sample(`${BASE}/token-pairs/v1/${vendorId(subject.chain)}/${subject.token}`);
    issued += 1;
    await sleep(PACE_MS);
    const b = await sample(`${BASE}/latest/dex/tokens/${subject.token}`);
    issued += 1;
    await sleep(PACE_MS);
    perChain.push({ ...subject, ...a });
    crossChain.push({ ...subject, ...b });
    process.stdout.write(
      `${subject.chain.padEnd(10)} ${subject.token.slice(0, 10)}  per-chain ${String(a.rows).padStart(2)} rows / ${String(a.dexes.length)} dex` +
        `  ·  cross-chain ${String(b.rows).padStart(2)} rows / ${String(Object.keys(b.chains).length)} chains\n`,
    );
  }

  process.stdout.write(`\nordering: sample 1, then again in ${String(ORDER_GAP_MS / 1000)}s\n`);
  const orderUrl = `${BASE}/latest/dex/tokens/${ORDER_SUBJECT}`;
  const first = await sample(orderUrl);
  issued += 1;
  await sleep(ORDER_GAP_MS);
  const second = await sample(orderUrl);
  issued += 1;

  const sameOrder =
    first.pairAddresses.length === second.pairAddresses.length &&
    first.pairAddresses.every((a, i) => a === second.pairAddresses[i]);
  const setA = new Set(first.pairAddresses);
  const setB = new Set(second.pairAddresses);
  const sameSet = setA.size === setB.size && [...setA].every((a) => setB.has(a));

  const ordering = {
    endpoint: orderUrl,
    gapMs: ORDER_GAP_MS,
    rowsFirst: first.rows,
    rowsSecond: second.rows,
    sameSet,
    sameOrder,
    leftTheSample: [...setA].filter((a) => !setB.has(a)),
    joinedTheSample: [...setB].filter((a) => !setA.has(a)),
    sortedByLiquidityFirst: descendingByLiquidity(first.liquidityUsd),
    sortedByLiquiditySecond: descendingByLiquidity(second.liquidityUsd),
    liquidityFirst: first.liquidityUsd,
    liquiditySecond: second.liquidityUsd,
  };

  const probedAt = new Date().toISOString().slice(0, 10);
  const evidence = {
    $comment:
      'Task 014-32d / R-34 — the two vendor routes behind `token.pools`. Measured here rather ' +
      'than inherited from `/latest/dex/search`, whose 30-row cap was measured on a route these ' +
      'two do not share. The CONTROL subject (an address nothing deploys) is what makes a 30-row ' +
      'answer readable as a cap rather than as a fixed-size response. `ordering` answers whether ' +
      'the row order may be presented to a caller as a ranking: it may not unless `sameOrder` and ' +
      'a `sortedByLiquidity` flag are both true.',
    probedAt,
    base: BASE,
    auth: 'none (keyless)',
    paceMs: PACE_MS,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    requestsIssued: issued,
    perChainRoute: { path: '/token-pairs/v1/{chainId}/{tokenAddress}', samples: perChain },
    crossChainRoute: { path: '/latest/dex/tokens/{tokenAddress}', samples: crossChain },
    ordering,
  };
  const out = path.join(
    repoRoot,
    'docs',
    'onchain-analytics',
    'raw',
    `dexscreener-token-routes-${probedAt}.json`,
  );
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `\nevidence -> ${path.relative(repoRoot, out)}\n` +
      `per-chain max rows: ${String(Math.max(...perChain.map((s) => s.rows)))}\n` +
      `cross-chain max rows: ${String(Math.max(...crossChain.map((s) => s.rows)))}\n` +
      `ordering: sameSet=${String(sameSet)} sameOrder=${String(sameOrder)} ` +
      `sortedByLiquidity=${String(ordering.sortedByLiquidityFirst)}/${String(ordering.sortedByLiquiditySecond)}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
