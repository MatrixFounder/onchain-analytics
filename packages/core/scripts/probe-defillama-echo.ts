/**
 * Re-records the DeFiLlama `chain` echo evidence — task 014-32d.
 *
 * **Why this script exists at all, and why it did not before.** The original probe (WI-16,
 * 2026-07-28) was a one-off: it answered its question, its evidence was committed, and
 * `defillama-dex-coverage.test.ts` turned the answer into a standing invariant — "the probe covered
 * EXACTLY the chains the predicate admits today, no more, no fewer". That test's own comment states
 * the obligation it creates: *if the registry or the vendor list changes, this fails and the probe
 * has to be re-run*. Task 014-32a regenerates the registry, so the obligation came due — and there
 * was nothing to run. A one-off probe plus a standing invariant is a maintenance debt that only
 * shows up on the day somebody else's task is blocked by it.
 *
 * **What it verifies.** `normalizeDexVolume` refuses a document whose `chain` field does not equal
 * the `vendors.defillama` name we sent. A vendor that canonicalised one display name into another
 * would break that chain PERMANENTLY, and break it expensively: `normalize()` refuses → negative
 * cache → `CapabilityUnavailableError`, whose documented meaning to an agent is "retry". An agent
 * varying `days` bypasses the negative cache entirely, so the failure mode is a silent infinite
 * retry. The vendor's list contains display-name twins — `Plume`/`Plume Mainnet`,
 * `SX Network`/`SX Rollup`, `DefiChain`/`DeFiChain EVM`, `Doge`/`Dogechain` — which is what made the
 * assumption worth measuring rather than asserting.
 *
 * **The probed set is DERIVED from the coverage predicate, never listed here.** The invariant is an
 * equality between two sets, so a hand-written list would let the two drift apart and would make the
 * test pass for the wrong reason on the day they did.
 *
 * Keyless, read-only, zero credits. Run by hand; never by CI (R-21).
 */
import { writeFileSync } from 'node:fs';
import { createCoverage } from '../src/chain/coverage.js';
import { loadChainRegistry } from '../src/chain/registry.js';
import { routes } from '../src/providers.config.js';
import { createDefillamaAdapter } from '../src/adapters/defillama/index.js';
import type { ProviderAdapter } from '../src/adapters/types.js';

const CAPABILITY = 'dex.volume.history';
const ENDPOINT =
  'https://api.llama.fi/overview/dexs/{vendorName}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true';
/** The original run's value, kept so the two recordings are comparable rather than merely similar. */
const CONCURRENCY = 8;

interface ProbeRow {
  readonly slug: string;
  readonly requested: string;
  readonly httpStatus: number;
  readonly echo: string | null;
  readonly match: boolean;
  readonly total24h: number | null;
  readonly totalAllTime: number | null;
  readonly allChainsCount: number | null;
}

async function probeOne(slug: string, vendorName: string): Promise<ProbeRow> {
  const url = ENDPOINT.replace('{vendorName}', encodeURIComponent(vendorName));
  const response = await fetch(url);
  if (response.status !== 200) {
    return {
      slug,
      requested: vendorName,
      httpStatus: response.status,
      echo: null,
      match: false,
      total24h: null,
      totalAllTime: null,
      allChainsCount: null,
    };
  }
  const body = (await response.json()) as {
    chain?: unknown;
    total24h?: unknown;
    totalAllTime?: unknown;
    allChains?: unknown;
  };
  const echo = typeof body.chain === 'string' ? body.chain : null;
  return {
    slug,
    requested: vendorName,
    httpStatus: 200,
    echo,
    // The load-bearing comparison, and it is EXACTLY the one `normalizeDexVolume` makes.
    match: echo === vendorName,
    total24h: typeof body.total24h === 'number' ? body.total24h : null,
    totalAllTime: typeof body.totalAllTime === 'number' ? body.totalAllTime : null,
    allChainsCount: Array.isArray(body.allChains) ? body.allChains.length : null,
  };
}

async function main(): Promise<void> {
  const chains = loadChainRegistry();
  const adapters = new Map<string, ProviderAdapter>([['defillama', createDefillamaAdapter()]]);
  const coverage = createCoverage({ routes: [...routes], adapters, chains });
  const covered = coverage.chainsFor(CAPABILITY);

  const targets = covered
    .map((chain) => ({ slug: chain.slug, vendorName: chain.vendors['defillama'] }))
    .filter((t): t is { slug: string; vendorName: string } => typeof t.vendorName === 'string');
  if (targets.length !== covered.length) {
    // The predicate requires a non-null `vendors.defillama`, so this cannot happen — and if it
    // does, the probed set would silently be smaller than the covered set, which is the exact
    // drift the invariant exists to catch.
    throw new Error(
      `probe-defillama-echo: ${String(covered.length - targets.length)} covered chains carry no ` +
        'defillama vendor name — the coverage predicate and this script disagree',
    );
  }
  process.stdout.write(
    `probing ${String(targets.length)} covered chains at ${String(CONCURRENCY)}x\n`,
  );

  const startedAt = Date.now();
  const results: ProbeRow[] = [];
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(batch.map((t) => probeOne(t.slug, t.vendorName)))));
    process.stdout.write(`  ${String(results.length)}/${String(targets.length)}\r`);
  }
  const elapsedSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));

  results.sort((a, b) => a.slug.localeCompare(b.slug));
  const mismatches = results.filter((row) => !row.match);
  const noVolume = results.filter((row) => row.match && row.total24h === null);

  const probedAt = new Date().toISOString().slice(0, 10);
  const evidence = {
    $comment:
      'Task 014-32d — live re-verification that DeFiLlama’s `chain` echo equals the ' +
      '`vendors.defillama` name we send, for EVERY chain the coverage predicate admits. Re-run ' +
      'because task 014-32a regenerated the chain registry and the standing invariant in ' +
      'defillama-dex-coverage.test.ts requires the probed set to equal the covered set. Keyless, ' +
      'read-only, 0 credits. `mismatches` is the load-bearing field: an entry there is a chain ' +
      'normalize() would refuse permanently while the error class tells the agent to retry.',
    probedAt,
    endpoint: ENDPOINT,
    auth: 'none (keyless)',
    concurrency: CONCURRENCY,
    elapsedSeconds,
    chainsProbed: results.length,
    mismatchCount: mismatches.length,
    mismatches,
    echoMatchedButNoVolumeCount: noVolume.length,
    echoMatchedButNoVolume: noVolume.map((row) => row.slug),
    results,
  };
  const path = `../../docs/onchain-analytics/raw/defillama-dex-echo-probe-${probedAt}.json`;
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `\nevidence -> ${path}\nprobed ${String(results.length)}, mismatches ${String(mismatches.length)}, ` +
      `no-volume ${String(noVolume.length)}, ${String(elapsedSeconds)}s\n`,
  );
  if (mismatches.length > 0) {
    process.stdout.write(
      `MISMATCHES:\n${mismatches.map((m) => `  ${m.slug}: sent ${m.requested}, echoed ${String(m.echo)} (HTTP ${String(m.httpStatus)})`).join('\n')}\n`,
    );
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
