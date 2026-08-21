/**
 * Measures how long Blockscout takes to answer `token.holders`, and whether the delay belongs to
 * the ROUTE or to the vendor — task 014-42, L-12.
 *
 * **Why this exists as an instrument rather than as one measurement.** `capability-manifest.ts`
 * gives `token.holders` a deadline, and `blockscout/index.ts` gives its holders route a hop
 * timeout. Both are numbers about a vendor we do not control, so both go stale silently: the
 * capability keeps answering until the vendor drifts past the ceiling, and then it stops, and
 * nothing in the repository can say whether the vendor got slower or our number was always wrong.
 * The suite cannot answer it either — R-21 forbids network in CI, so every fixture-backed test
 * measures our code against yesterday's snapshot of the vendor. This script is where the number
 * gets re-derived.
 *
 * **The control column is the point.** Each round asks the holders route AND `/api/v2/stats` on the
 * SAME chain, through the same host, with the same key, seconds apart. `stats` is a stored document
 * and holders is an aggregate over an index, so the pair separates two explanations that a bare
 * latency table cannot:
 *
 * | holders | stats | reading |
 * | :-- | :-- | :-- |
 * | slow | fast | the holders INDEX is slow — raise this capability's ceiling, leave the others |
 * | slow | slow | the VENDOR is slow — a per-capability ceiling buys nothing, revisit the adapter |
 * | fast | fast | the ceiling can come back down |
 *
 * Measured 2026-08-21 by this script, the table read `route-is-slow` on four chains and `both-fast`
 * on the fifth, `vendor-is-slow` on none: holders 1.137–45.831 s against a `stats` control of
 * 0.387–0.988 s. That is what licensed a ceiling on ONE capability instead of on the adapter. The
 * figures are the ones in the evidence file this script writes, not a separate hand measurement.
 *
 * **Why the other three routes keep the 5 s default, stated here because this is where someone
 * will come to change it.** Raising the adapter-wide timeout would absorb a future vendor-wide
 * slowdown into longer waits and green rows. Leaving `gas.price` and `chain.transactions` at 5 s —
 * the routes the `stats` control above measures, at 0.39–0.99 s — means such a slowdown surfaces as
 * failures in the live gate, which is the signal, not the noise.
 *
 * **What counts as an answer.** Holder ROWS, not HTTP 200. The facade wraps the vendor payload as
 * `data.items`, and a 200 carrying an empty list is the L-10 shape: a confident answer to a
 * question the vendor did not answer.
 *
 * Read-only, zero credits, one PRO key from the repo-root `.env` which is never printed. Run by
 * hand; never by CI (R-21).
 *
 *   pnpm --filter @onchain-intel/core probe:holders-latency
 *   ONCHAIN_PROBE_ROUNDS=5 ONCHAIN_PROBE_CEILING_MS=90000 pnpm --filter … probe:holders-latency
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCKSCOUT_CHAIN_IDS } from '../src/adapters/blockscout/chains.js';
import { loadChainRegistry } from '../src/chain/registry.js';
import type { ChainInfo } from '../src/chain/registry-core.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');

/** The facade the adapter uses. Same host, same header name — this measures OUR route. */
const FACADE = 'https://mcp.blockscout.com/v1/direct_api_call';
const PRO_KEY_HEADER = 'Blockscout-MCP-Pro-Api-Key';

const ROUNDS = Number(process.env['ONCHAIN_PROBE_ROUNDS'] ?? 3);
/**
 * The probe's own ceiling, deliberately ABOVE any ceiling we would ship.
 *
 * A probe that timed out where production times out could only ever confirm the number already in
 * the code. This one has to be able to report "the vendor answered, and it took longer than we
 * allow" — which is a different finding from "the vendor did not answer" and the one that moves a
 * tier.
 */
const CEILING_MS = Number(process.env['ONCHAIN_PROBE_CEILING_MS'] ?? 60_000);
/** Between requests, so a slow round is the vendor's doing and not a burst of our own. */
const PACE_MS = 500;

interface Attempt {
  readonly round: number;
  readonly httpStatus: number;
  readonly elapsedMs: number;
  /** Holder rows parsed out of the body. `null` when the body carried none to parse. */
  readonly rows: number | null;
  readonly note: string;
}

interface ChainRow {
  readonly slug: string;
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly holders: readonly Attempt[];
  /** The control: the same vendor, the same chain, a stored document instead of an aggregate. */
  readonly stats: readonly Attempt[];
  readonly holdersAnswered: number;
  readonly holdersMaxMs: number | null;
  readonly statsMaxMs: number | null;
  readonly reading: 'route-is-slow' | 'vendor-is-slow' | 'both-fast' | 'no-answer';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The curated probe token per chain, READ from the eval rather than copied.
 *
 * A second list of addresses here would drift from the one the gate actually asks about, and the
 * copy is always the one that drifts (the RF-5 shape). This measures what the gate measures.
 */
function curatedTokens(): Map<string, string> {
  const probesPath = path.join(repoRoot, 'packages', 'mcp-server', 'eval', 'probes.json');
  const parsed = JSON.parse(readFileSync(probesPath, 'utf8')) as {
    chains: Record<string, { token?: unknown }>;
  };
  const out = new Map<string, string>();
  for (const [slug, row] of Object.entries(parsed.chains)) {
    if (typeof row.token === 'string' && row.token.length > 0) out.set(slug, row.token);
  }
  return out;
}

/** The chain id `servesChain()` derives, by the same rule and from the same field. */
function evmChainId(chain: ChainInfo): number | undefined {
  const match = /^eip155:(\d+)$/.exec(chain.caip2);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

async function ask(
  chainId: number,
  endpointPath: string,
  apiKey: string,
  round: number,
): Promise<Attempt> {
  const url = new URL(FACADE);
  url.searchParams.set('chain_id', String(chainId));
  url.searchParams.set('endpoint_path', endpointPath);

  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { [PRO_KEY_HEADER]: apiKey },
      signal: AbortSignal.timeout(CEILING_MS),
    });
  } catch (error) {
    // A timeout and a transport failure are both "no answer" to a caller, and the note keeps them
    // apart for whoever reads the evidence file.
    const message = error instanceof Error ? error.message : String(error);
    return {
      round,
      httpStatus: 0,
      elapsedMs: Date.now() - started,
      rows: null,
      note: /abort|timeout/i.test(message) ? `no answer within ${String(CEILING_MS)}ms` : message,
    };
  }
  const text = await response.text();
  const elapsedMs = Date.now() - started;
  if (response.status !== 200) {
    // The vendor's error bodies are short and carry the useful half; truncated because this text
    // is third-party and lands in a committed file.
    return { round, httpStatus: response.status, elapsedMs, rows: null, note: text.slice(0, 120) };
  }
  let rows: number | null = null;
  try {
    const body = JSON.parse(text) as { data?: { items?: unknown } };
    if (Array.isArray(body.data?.items)) rows = body.data.items.length;
  } catch {
    return { round, httpStatus: 200, elapsedMs, rows: null, note: 'body did not parse as JSON' };
  }
  return {
    round,
    httpStatus: 200,
    elapsedMs,
    rows,
    note: rows === 0 ? 'HTTP 200 with an EMPTY item list — an answer to nothing' : '',
  };
}

const answered = (a: Attempt): boolean => a.httpStatus === 200 && (a.rows === null || a.rows > 0);

function maxMs(attempts: readonly Attempt[]): number | null {
  const ok = attempts.filter(answered).map((a) => a.elapsedMs);
  return ok.length === 0 ? null : Math.max(...ok);
}

/** The two-column reading the docstring's table describes, computed rather than eyeballed. */
function readingOf(holdersMax: number | null, statsMax: number | null): ChainRow['reading'] {
  if (holdersMax === null) return 'no-answer';
  if (statsMax !== null && statsMax > 5_000) return 'vendor-is-slow';
  if (holdersMax > 5_000) return 'route-is-slow';
  return 'both-fast';
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(path.join(repoRoot, '.env'));
  } catch {
    // Non-fatal, matching `loadEnv`'s own treatment — the refusal below says what is missing.
  }
  const apiKey = process.env['BLOCKSCOUT_PRO_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      'BLOCKSCOUT_PRO_API_KEY is not set in the repo-root .env — this probe measures the PRO ' +
        'facade our adapter uses, and a keyless run would measure a different route',
    );
  }

  const tokens = curatedTokens();
  const served = new Set(BLOCKSCOUT_CHAIN_IDS);
  const registry = loadChainRegistry();
  const targets: { chain: ChainInfo; chainId: number; token: string }[] = [];
  for (const chain of registry.list()) {
    const chainId = evmChainId(chain);
    const token = tokens.get(chain.slug);
    if (chainId === undefined || !served.has(chainId) || token === undefined) continue;
    targets.push({ chain, chainId, token });
  }

  const probedAt = new Date().toISOString().slice(0, 10);
  const startedAt = Date.now();
  const rows: ChainRow[] = [];
  let issued = 0;

  for (const { chain, chainId, token } of targets) {
    const holders: Attempt[] = [];
    const stats: Attempt[] = [];
    for (let round = 1; round <= ROUNDS; round += 1) {
      holders.push(await ask(chainId, `/api/v2/tokens/${token}/holders`, apiKey, round));
      issued += 1;
      await sleep(PACE_MS);
      stats.push(await ask(chainId, '/api/v2/stats', apiKey, round));
      issued += 1;
      await sleep(PACE_MS);
    }
    const holdersMaxMs = maxMs(holders);
    const statsMaxMs = maxMs(stats);
    rows.push({
      slug: chain.slug,
      chainId,
      tokenAddress: token,
      holders,
      stats,
      holdersAnswered: holders.filter(answered).length,
      holdersMaxMs,
      statsMaxMs,
      reading: readingOf(holdersMaxMs, statsMaxMs),
    });
    process.stdout.write(
      `${chain.slug.padEnd(10)} holders ${String(holders.filter(answered).length)}/${String(ROUNDS)}` +
        ` max ${holdersMaxMs === null ? '—' : `${String(holdersMaxMs)}ms`}` +
        `  ·  stats max ${statsMaxMs === null ? '—' : `${String(statsMaxMs)}ms`}` +
        `  ·  ${readingOf(holdersMaxMs, statsMaxMs)}\n`,
    );
  }

  const answeringMaxima = rows.map((r) => r.holdersMaxMs).filter((ms): ms is number => ms !== null);
  /**
   * The number a tier is chosen against: the slowest SUCCESSFUL holders answer anywhere.
   *
   * A ceiling below this refuses a call the vendor was going to answer, which is the failure L-12
   * spent ten days being. A mean would hide it — the cold entry is the case that matters, and it is
   * by definition the tail.
   */
  const slowestAnswerMs = answeringMaxima.length === 0 ? null : Math.max(...answeringMaxima);

  const evidence = {
    $comment:
      'Task 014-42 / L-12 — how long Blockscout takes to answer `token.holders`, with ' +
      '`/api/v2/stats` on the same chain as the control. `reading` per row separates "this ROUTE ' +
      'is slow" from "this VENDOR is slow": the first licenses a ceiling on one capability, the ' +
      'second does not. `slowestAnswerMs` is the number a deadline tier must clear — a ceiling ' +
      'below it refuses calls the vendor would have answered.',
    probedAt,
    facade: FACADE,
    auth: 'PRO key from the repo-root .env (never recorded here)',
    rounds: ROUNDS,
    ceilingMs: CEILING_MS,
    paceMs: PACE_MS,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    requestsIssued: issued,
    chainsProbed: rows.length,
    slowestAnswerMs,
    readings: Object.fromEntries(
      (['route-is-slow', 'vendor-is-slow', 'both-fast', 'no-answer'] as const).map((key) => [
        key,
        rows.filter((r) => r.reading === key).map((r) => r.slug),
      ]),
    ),
    results: rows,
  };
  const out = path.join(
    repoRoot,
    'docs',
    'onchain-analytics',
    'raw',
    `blockscout-holders-latency-${probedAt}.json`,
  );
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `\nevidence -> ${path.relative(repoRoot, out)}\n` +
      `${String(issued)} requests, ${String(evidence.elapsedSeconds)}s\n` +
      `slowest SUCCESSFUL holders answer: ${slowestAnswerMs === null ? 'none answered' : `${String(slowestAnswerMs)}ms`}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
