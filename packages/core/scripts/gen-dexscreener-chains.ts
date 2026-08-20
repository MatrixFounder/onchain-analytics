/**
 * DexScreener chain coverage, WITNESSED per chain — task 014-32a, R-33.
 *
 * **The rule did not change; the instrument did.** `sync-chain-registry.ts` has always forbidden
 * inventing vendor identifiers: DexScreener publishes no chain catalogue, "so this cannot be
 * derived, only witnessed". The literal `DEXSCREENER_OBSERVED` witnessed three chains from one
 * spot-check, and the registry then read `null` on the other 455 as "the vendor does not have this
 * chain" — 62 of which the vendor demonstrably serves (L-18). There is no catalogue, but there IS a
 * per-chain witness, and this script is it.
 *
 * **Two modes, and only one of them touches the network.**
 *
 * - `--record` probes the vendor and writes the evidence file. Run by hand, never by CI.
 * - the default mode reads the COMMITTED evidence and emits the committed `.ts` module. It is what
 *   a test can re-run to prove the module still matches its evidence.
 *
 * This split is the shape all five existing generators use: the script itself is imported from
 * nothing under `src/`, review happens on the git diff, and freshness is an operator's obligation.
 * A chain the vendor adds becomes available after a `--record` run and a commit. Never automatically.
 *
 * ## The two questions the probe asks, and why one is not enough
 *
 * 1. **Is the segment routable?** `GET /latest/dex/pairs/{candidate}/{address}` answers `200` with
 *    `{"pairs":null}` for a routable chain segment and `400` with an HTML body for one the vendor
 *    does not route. Measured 2026-08-18 and reproduced 2026-08-20: `base` 200, `seiv2` 200,
 *    `sei` 400, `zcash` 400, `gnosis` 400.
 * 2. **Does the vendor ECHO that identifier on a real row?** A `200` is returned both by a segment
 *    holding data and by one holding none, so status alone cannot tell them apart — reading an empty
 *    answer as coverage is the L-10 class. A candidate the vendor never emits as `pair.chainId` is
 *    recorded `unverified` and never reaches the column.
 *
 * **The echo is accumulated across every response of the run, not per query.** A per-candidate name
 * search is a weak witness: measured 2026-08-20, `q=story` returns 30 rows and none on `story`,
 * while `q=USDC` alone echoes 16 distinct chain ids including `robinhood` and `seiv2`. So every row
 * of every response contributes its `chainId` to one observed set, and a candidate is confirmed if
 * it appears there. The queries are written into the evidence so the measurement is reproducible.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = 'src/adapters/dexscreener/chain-coverage.ts';
const REGISTRY = 'src/chain/registry.data.json';
const RAW_DIR = '../../docs/onchain-analytics/raw';

/**
 * A well-formed address used only to make the route resolvable. Its existence on a chain is
 * irrelevant: the oracle is the SEGMENT, and every routable segment answers `pairs:null` for an
 * address it does not know.
 */
const PROBE_ADDRESS = '0x6c9A33E3b592C0d65B3Ba59355d5Be0d38259285';

/**
 * Pacing, measured 2026-08-18: four parallel requests at 220 ms produced 348 `429`s out of 849.
 * 320 ms with no parallelism completed two rounds with none. A `429` is retried; if any remain after
 * four rounds the run fails rather than emitting a partial catalogue.
 */
const PACE_MS = 320;
const MAX_ROUNDS = 4;

/**
 * Floor on a plausible result. Below it the route shape changed or the probe was cut off, and an
 * accepted recording would narrow coverage to nothing — indistinguishable from the task never having
 * been done. This is where memory M6's question is answered: `unverified` is a new legal answer, and
 * what it would mask is "the probe broke and quietly returned nothing", so the guard lives here.
 */
const MIN_PLAUSIBLE_CHAINS = 20;

/**
 * Identifiers that may be emitted into a committed `.ts` literal. The emit builds `'<value>'` by
 * hand, so a quote or a backslash would close the literal early and inject source. Refusing is safe
 * AND visible; escaping would be safe and silent (the `safeName` doctrine of
 * `gen-defillama-dex-chains.ts`).
 */
const EMITTABLE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Rows whose ambiguity the owner resolved by hand. The generator's refusal to choose between two
 * answering candidates is NOT relaxed by this map — the second candidate is still named in the
 * curation report; the map only supplies the value the refusal would otherwise leave `null`.
 *
 * `hyperliquid-l1` → `hyperevm` (owner decision 2026-08-19). The registry row carries
 * `caip2: eip155:999` and `family: evm`, so it names an EVM chain and not an order book; measured
 * 2026-08-19, `hyperevm` returns 29 rows over 8 `dexId`s with `liquidity.usd` on all of them, while
 * `hyperliquid` returns 14 rows over one `dexId` with `liquidity.usd` on none — and a `Pool` without
 * `liquidityUsd` is missing the field that IS the answer on this capability.
 */
const CURATED: Readonly<Record<string, string>> = { 'eip155:999': 'hyperevm' };

export type ProbeStatus = 'verified' | 'excluded' | 'unverified';

interface RegistryRow {
  caip2: string;
  slug: string;
  aliases?: string[];
  deprecated?: boolean;
}

interface CandidateRecord {
  readonly caip2: string;
  readonly slug: string;
  readonly candidate: string;
  /** HTTP status of the routability probe, or `null` when the request never completed. */
  readonly status: number | null;
}

export interface ProbeEvidence {
  readonly recordedAt: string;
  readonly probeAddress: string;
  /** The search queries whose responses contributed echoes — the measurement is reproducible only
   * if the queries are part of the record. */
  readonly echoQueries: readonly string[];
  /** Every `pair.chainId` the vendor emitted anywhere in this run. */
  readonly observedChainIds: readonly string[];
  readonly candidates: readonly CandidateRecord[];
}

export interface ChainCoverageEntry {
  readonly chainId: string | null;
  readonly status: ProbeStatus;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Mode 1 — record
// ════════════════════════════════════════════════════════════════════════════════════════════════

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `slug` plus every alias, de-duplicated, for every non-deprecated row. */
export function candidatesOf(rows: readonly RegistryRow[]): CandidateRecord[] {
  const out: CandidateRecord[] = [];
  for (const row of rows) {
    for (const candidate of new Set([row.slug, ...(row.aliases ?? [])])) {
      out.push({ caip2: row.caip2, slug: row.slug, candidate, status: null });
    }
  }
  return out;
}

async function recordEvidence(): Promise<string> {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8')) as { chains: RegistryRow[] };
  const candidates = candidatesOf(registry.chains);
  process.stdout.write(`probing ${String(candidates.length)} candidates at ${String(PACE_MS)}ms\n`);

  const status = new Map<string, number>();
  const observed = new Set<string>();
  const echoQueries: string[] = [];

  /** Adds every `chainId` a response carried — the echo set is the union over the whole run. */
  const harvest = (body: unknown): void => {
    const pairs = (body as { pairs?: unknown } | null)?.pairs;
    if (!Array.isArray(pairs)) return;
    for (const pair of pairs) {
      const id = (pair as { chainId?: unknown }).chainId;
      if (typeof id === 'string') observed.add(id);
    }
  };

  let pending = candidates.map((c) => c.candidate).filter((c, i, a) => a.indexOf(c) === i);
  for (let round = 1; round <= MAX_ROUNDS && pending.length > 0; round += 1) {
    const retry: string[] = [];
    for (const candidate of pending) {
      const url = `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(candidate)}/${PROBE_ADDRESS}`;
      let code: number | null = null;
      try {
        const response = await fetch(url);
        code = response.status;
        if (code === 429) {
          retry.push(candidate);
        } else if (code === 200) {
          harvest(await response.json());
        }
      } catch {
        retry.push(candidate);
      }
      if (code !== null && code !== 429) status.set(candidate, code);
      await sleep(PACE_MS);
    }
    process.stdout.write(
      `round ${String(round)}: ${String(pending.length - retry.length)} answered, ` +
        `${String(retry.length)} to retry\n`,
    );
    pending = retry;
  }
  if (pending.length > 0) {
    throw new Error(
      `gen-dexscreener-chains: ${String(pending.length)} candidates still unanswered after ` +
        `${String(MAX_ROUNDS)} rounds — refusing to write a partial recording`,
    );
  }

  // The echo pass: one search per ROUTABLE candidate. Every response feeds the shared observed set,
  // so a chain whose own name is a poor search term is still confirmed by somebody else's rows.
  const routable = [...status.entries()].filter(([, code]) => code === 200).map(([c]) => c);
  process.stdout.write(`echo pass over ${String(routable.length)} routable candidates\n`);
  for (const candidate of routable) {
    echoQueries.push(candidate);
    try {
      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(candidate)}`,
      );
      if (response.status === 200) harvest(await response.json());
    } catch {
      // An echo query that fails costs a confirmation, never a wrong one: the candidate simply
      // stays `unverified`, which is the honest answer for "we did not witness it".
    }
    await sleep(PACE_MS);
  }

  const recordedAt = new Date().toISOString().slice(0, 10);
  const evidence: ProbeEvidence = {
    recordedAt,
    probeAddress: PROBE_ADDRESS,
    echoQueries,
    observedChainIds: [...observed].sort(),
    candidates: candidates.map((c) => ({ ...c, status: status.get(c.candidate) ?? null })),
  };
  const path = `${RAW_DIR}/dexscreener-chain-probe-${recordedAt}.json`;
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`evidence -> ${path}\n`);
  return path;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Mode 2 — emit
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface EmitResult {
  readonly coverage: Record<string, ChainCoverageEntry>;
  /** Rows an operator must look at: ambiguous, unemittable, or routable without an echo. */
  readonly curation: string[];
}

/** Decides one row from its candidates. Pure — the whole reason the emit mode is testable offline. */
export function decideRow(
  caip2: string,
  records: readonly CandidateRecord[],
  observed: ReadonlySet<string>,
  curation: string[],
): ChainCoverageEntry {
  const answered = records.filter((r) => r.status !== null);
  const routable = answered.filter((r) => r.status === 200).map((r) => r.candidate);
  const echoed = routable.filter((c) => observed.has(c));

  for (const candidate of echoed) {
    if (!EMITTABLE.test(candidate)) {
      throw new Error(
        `gen-dexscreener-chains: refusing to emit chain id ${JSON.stringify(candidate)} for ` +
          `${caip2} — expected ${String(EMITTABLE)}. Inspect the evidence before widening this guard.`,
      );
    }
  }
  const unemittable = routable.filter((c) => !EMITTABLE.test(c));
  if (unemittable.length > 0) {
    curation.push(
      `${caip2}: routable candidate outside the emittable class — ${unemittable.join(', ')}`,
    );
  }

  if (echoed.length > 1) {
    // The refusal stands even where a curated value exists: the second candidate is still reported.
    curation.push(
      `${caip2}: ${String(echoed.length)} candidates answered and echoed — ${echoed.join(', ')}`,
    );
    const curated = CURATED[caip2];
    if (curated === undefined) return { chainId: null, status: 'unverified' };
    if (!echoed.includes(curated)) {
      throw new Error(
        `gen-dexscreener-chains: curated override ${curated} for ${caip2} was not among the ` +
          `echoed candidates (${echoed.join(', ')}) — the override is stale`,
      );
    }
    return { chainId: curated, status: 'verified' };
  }
  const only = echoed[0];
  if (only !== undefined) return { chainId: only, status: 'verified' };

  if (routable.length > 0) {
    curation.push(`${caip2}: routable but never echoed — ${routable.join(', ')}`);
    return { chainId: null, status: 'unverified' };
  }
  // Every candidate was probed and every one was refused: the vendor does not route this chain.
  if (answered.length === records.length && records.length > 0) {
    return { chainId: null, status: 'excluded' };
  }
  return { chainId: null, status: 'unverified' };
}

export function generateDexscreenerChains(evidencePath: string, outPath = OUT): EmitResult {
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as ProbeEvidence;
  const observed = new Set(evidence.observedChainIds);
  const byChain = new Map<string, CandidateRecord[]>();
  for (const record of evidence.candidates) {
    const list = byChain.get(record.caip2) ?? [];
    list.push(record);
    byChain.set(record.caip2, list);
  }

  const curation: string[] = [];
  const coverage: Record<string, ChainCoverageEntry> = {};
  for (const [caip2, records] of [...byChain.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    coverage[caip2] = decideRow(caip2, records, observed, curation);
  }

  const verified = Object.values(coverage).filter((entry) => entry.status === 'verified').length;
  if (verified < MIN_PLAUSIBLE_CHAINS) {
    throw new Error(
      `gen-dexscreener-chains: only ${String(verified)} verified chains in the evidence ` +
        `(< ${String(MIN_PLAUSIBLE_CHAINS)}). Refusing to emit — a near-empty catalogue is ` +
        'indistinguishable from a broken probe, and it would narrow coverage to nothing.',
    );
  }

  const rows = Object.entries(coverage)
    .map(
      ([caip2, entry]) =>
        `  '${caip2}': { chainId: ${entry.chainId === null ? 'null' : `'${entry.chainId}'`}, status: '${entry.status}' },`,
    )
    .join('\n');

  const body = `// GENERATED by scripts/gen-dexscreener-chains.ts from the committed
// docs/onchain-analytics/raw/${evidencePath.split('/').pop() ?? ''} — do not edit by hand.
//
// DexScreener publishes no chain catalogue, so this is WITNESSED and not derived (task 014-32a,
// R-33). Two questions were asked of every candidate — the row's slug and each of its aliases:
// whether the vendor routes the segment (\`200\` vs \`400\`), and whether the vendor ever echoes that
// identifier as \`pair.chainId\` on a real row. A \`200\` alone does not distinguish a segment holding
// data from one holding none, so status alone would read an empty answer as coverage (L-10).
//
// \`chainId\` is the ANSWERING CANDIDATE and never the slug: \`normalize()\` filters vendor rows by
// \`pair.chainId === chain.vendors['dexscreener']\`, so a slug recorded in place of the vendor's own
// identifier drops every row and the capability answers an empty page.
//
// \`status\` carries the third state R-33.5 needs. It is NOT coverage: the adapter's predicate decides
// that, and this only decides the wording of a refusal the predicate has already produced.

export type DexscreenerProbeStatus = 'verified' | 'excluded' | 'unverified';

export interface DexscreenerChainCoverage {
  readonly chainId: string | null;
  readonly status: DexscreenerProbeStatus;
}

export const DEXSCREENER_CHAIN_COVERAGE: Readonly<Record<string, DexscreenerChainCoverage>> = {
${rows}
};
`;
  writeFileSync(outPath, body, 'utf8');
  return { coverage, curation };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════

const invokedDirectly = process.argv[1]?.endsWith('gen-dexscreener-chains.ts') ?? false;
if (invokedDirectly) {
  const recordMode = process.argv.includes('--record');
  const run = async (): Promise<void> => {
    const evidencePath = recordMode
      ? await recordEvidence()
      : (process.argv.find((arg) => arg.endsWith('.json')) ??
        (() => {
          throw new Error(
            'gen-dexscreener-chains: pass the committed evidence path, or --record to probe',
          );
        })());
    const { coverage, curation } = generateDexscreenerChains(evidencePath);
    const counts = { verified: 0, excluded: 0, unverified: 0 };
    for (const entry of Object.values(coverage)) counts[entry.status] += 1;
    process.stdout.write(
      `DEXSCREENER_CHAIN_COVERAGE -> ${String(Object.keys(coverage).length)} rows ` +
        `(verified ${String(counts.verified)}, excluded ${String(counts.excluded)}, ` +
        `unverified ${String(counts.unverified)})\n`,
    );
    if (curation.length > 0) {
      process.stdout.write(`\nCURATION (${String(curation.length)}):\n${curation.join('\n')}\n`);
    }
  };
  void run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
