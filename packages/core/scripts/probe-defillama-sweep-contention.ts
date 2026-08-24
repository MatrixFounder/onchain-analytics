/**
 * L-25's experiment: do `dex.volume.history` rows fail because the VENDOR is rotating, or because
 * this process is still downloading documents nobody is waiting for any more?
 *
 * **Why an experiment and not more observation.** Two consecutive gate runs on a link the gate
 * itself measured stable (WI-65) reported `dex.volume.history` failing on 5 and then 9 of its 11
 * chains. Minutes later the same eleven documents answered to `curl` in 0.58–8.81 s, and
 * `onchain_dex_volume` on `bsc` — red in the second run — returned a full series through the real
 * adapter. Fail inside the sweep, pass outside it. Observation cannot separate the two candidate
 * causes, because both predict exactly that.
 *
 * **The mechanism under test, read out of the code.** `awaitSharedDocument` bounds the CALLER's
 * wait, never the download. That is deliberate and argued for (WI-37): documents are shared between
 * concurrent callers, so one caller's deadline must not abort a transfer another is awaiting. The
 * consequence nobody weighed is that a caller who gives up does not stop the work — and
 * `protocol.tvl.history` documents were measured taking 40–60 s each. If several of those are still
 * streaming, a later `dex.volume.history` call runs its own 15 s clock behind them.
 *
 * **Three arms, because two would not exclude time.** The vendor could simply be degrading over the
 * ten minutes this takes, which would produce "control good, treatment bad" on its own. So the
 * control runs AGAIN afterwards:
 *
 *   A  — sweep alone                          (control)
 *   B  — sweep with abandoned downloads in flight   (treatment)
 *   A' — sweep alone again                    (control, after)
 *
 * A ≈ A' and B worse ⇒ the contention is ours. A > A' ⇒ the vendor drifted during the probe and the
 * run says nothing; report it that way rather than reading B as a result.
 *
 * Every call carries the REAL capability deadline (15 s, `capability-manifest.ts`), so a failure
 * here is the same failure the gate reports rather than an analogue of it.
 *
 * Keyless, read-only, zero credits. Run by hand; never by CI (R-21).
 *
 *   pnpm --filter @onchain-intel/core probe:sweep-contention
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefillamaAdapter } from '../src/adapters/defillama/index.js';
import { capabilityManifests } from '../src/capability-manifest.js';
import { loadChainRegistry } from '../src/chain/registry.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');

/** The eleven chains the gate exercises `dex.volume.history` on, in its own order. */
const SWEEP_CHAINS = [
  'ethereum',
  'solana',
  'base',
  'arbitrum',
  'polygon',
  'bsc',
  'avalanche',
  'berachain',
  'gnosis',
  'tron',
  'bitcoin',
];

/**
 * The load: protocol documents measured SLOW on 2026-08-24 (`aave` 39.9 s; `curve-finance`,
 * `quickswap` and `raydium` no answer in 60 s). Each is abandoned at its own 15 s deadline and keeps
 * downloading, which is the state under test — not a synthetic delay, the real one.
 */
const SLOW_LOAD = [
  { chain: 'ethereum', protocolSlug: 'aave' },
  { chain: 'ethereum', protocolSlug: 'curve-finance' },
  { chain: 'polygon', protocolSlug: 'quickswap' },
  { chain: 'solana', protocolSlug: 'raydium' },
];

/** Long enough for the limiter to refill and for a previous arm's transfers to finish or die. */
const COOLDOWN_MS = Number(process.env['ONCHAIN_PROBE_COOLDOWN_MS'] ?? 90_000);

const DEX_DEADLINE_MS = capabilityManifests['dex.volume.history']?.deadlineMs ?? 15_000;
const HISTORY_DEADLINE_MS = capabilityManifests['protocol.tvl.history']?.deadlineMs ?? 15_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Row {
  chain: string;
  ok: boolean;
  ms: number;
  error: string | null;
}

/** One sweep of `dex.volume.history`, sequential, each call under the real capability deadline. */
async function sweep(adapter: ReturnType<typeof createDefillamaAdapter>): Promise<Row[]> {
  const rows: Row[] = [];
  for (const chain of SWEEP_CHAINS) {
    const started = Date.now();
    try {
      await adapter.fetch('dex.volume.history', { chain, days: 7 }, Date.now() + DEX_DEADLINE_MS);
      rows.push({ chain, ok: true, ms: Date.now() - started, error: null });
    } catch (err) {
      rows.push({
        chain,
        ok: false,
        ms: Date.now() - started,
        error: String((err as Error)?.message ?? err).slice(0, 120),
      });
    }
    process.stdout.write(`    ${chain} ${rows[rows.length - 1]?.ok ? 'ok' : 'FAIL'}\n`);
  }
  return rows;
}

function summarize(label: string, rows: Row[]): string {
  const failed = rows.filter((r) => !r.ok);
  const worst = Math.max(...rows.map((r) => r.ms));
  return (
    `${label}: ${String(rows.length - failed.length)}/${String(rows.length)} ok, slowest ${String(worst)}ms` +
    (failed.length ? ` — failed: ${failed.map((f) => f.chain).join(', ')}` : '')
  );
}

async function main(): Promise<void> {
  loadChainRegistry();
  process.stdout.write(
    `L-25 contention probe — deadline ${String(DEX_DEADLINE_MS)}ms, cooldown ${String(COOLDOWN_MS)}ms\n`,
  );

  // A fresh adapter per arm: the in-process document cache must not carry a previous arm's answers,
  // or the second sweep would measure the cache. The LIMITER is a module singleton and is shared on
  // purpose — that is part of what is under test.
  process.stdout.write('\n  arm A — sweep alone\n');
  const armA = await sweep(createDefillamaAdapter());

  process.stdout.write(`\n  cooldown ${String(COOLDOWN_MS)}ms\n`);
  await sleep(COOLDOWN_MS);

  process.stdout.write('\n  arm B — sweep with abandoned downloads in flight\n');
  const loadAdapter = createDefillamaAdapter();
  let settled = 0;
  const load = SLOW_LOAD.map((t) =>
    loadAdapter
      .fetch(
        'protocol.tvl.history',
        { chain: t.chain, protocolSlug: t.protocolSlug, days: 30 },
        Date.now() + HISTORY_DEADLINE_MS,
      )
      // The rejection at 15s is the POINT: the caller walks away, the transfer does not stop.
      .catch(() => undefined)
      .finally(() => {
        settled += 1;
      }),
  );
  // Let them get past the limiter and start streaming before the sweep begins.
  await sleep(2_000);
  const armB = await sweep(createDefillamaAdapter());
  const stillInFlight = SLOW_LOAD.length - settled;

  process.stdout.write(`\n  cooldown ${String(COOLDOWN_MS)}ms\n`);
  await Promise.all(load);
  await sleep(COOLDOWN_MS);

  process.stdout.write("\n  arm A' — sweep alone again\n");
  const armAPrime = await sweep(createDefillamaAdapter());

  const failed = (rows: Row[]): number => rows.filter((r) => !r.ok).length;
  const verdict =
    failed(armA) === failed(armAPrime) && failed(armB) > failed(armA) + 1
      ? 'contention: the sweep degrades only while abandoned downloads are in flight'
      : failed(armA) !== failed(armAPrime)
        ? 'INCONCLUSIVE: the two controls disagree, so the vendor drifted during the probe'
        : 'no contention effect measured: arm B is not worse than the controls';

  process.stdout.write(`\n  ${summarize('A ', armA)}\n`);
  process.stdout.write(`  ${summarize('B ', armB)}\n`);
  process.stdout.write(`  ${summarize("A'", armAPrime)}\n`);
  process.stdout.write(
    `  abandoned transfers still in flight when arm B ended: ${String(stillInFlight)}\n`,
  );
  process.stdout.write(`\n  ${verdict}\n`);

  const out = path.join(
    repoRoot,
    'docs/onchain-analytics/raw/defillama-sweep-contention-2026-08-24.json',
  );
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        probedAt: new Date().toISOString(),
        deadlineMs: DEX_DEADLINE_MS,
        cooldownMs: COOLDOWN_MS,
        load: SLOW_LOAD,
        stillInFlight,
        verdict,
        arms: { A: armA, B: armB, "A'": armAPrime },
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`  written → ${path.relative(repoRoot, out)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `probe-defillama-sweep-contention: ${String((err as Error)?.stack ?? err)}\n`,
  );
  process.exitCode = 1;
});
