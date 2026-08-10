// The live-eval GATE — run at task completion, locally, by a human or an agent.
//
// WHY A GATE AND NOT A SCHEDULE. Two different failures need two different instruments. A test
// suite catches "we broke it" and runs on every change. What nothing caught was "they broke it":
// `token.holders` answered 50 rows at TASK-008 acceptance on 2026-07-28 and answers HTTP 403 today,
// with no commit of ours in between (L-6). Every one of the 1651 fixture-backed tests stayed green
// through that, by design — R-21 forbids network in CI, so fixtures verify our code against
// yesterday's snapshot of the vendor, never against the vendor. This gate is the one place the
// question gets asked for real, and it is asked when it matters: before a task is called done.
//
// WHAT IT ADDS OVER `pnpm eval`. `eval/run.mjs` already exits 1 on any error/degraded row. That is
// the right behaviour for a release gate and the wrong behaviour for a gate a human runs every day,
// because a KNOWN, FILED failure would block every task until it is fixed. So this wrapper splits
// the failures:
//
//   unacknowledged — a failure nobody has filed. BLOCKS. This is the signal.
//   known          — in `eval/acknowledged.json` with an issue id. Named in the report, does not block.
//   stale          — an acknowledged row that now PASSES, or vanished from the matrix. BLOCKS.
//
// The third one is what keeps the second honest. Without it the acknowledged list only ever grows,
// and each entry silently covers a row nobody checks again — a blindfold assembled one honest
// decision at a time. Blocking on it costs one line of JSON to clear and is the cheapest guard here.
//
// `pnpm eval` is untouched and still exits 1 while L-6 is open: a release gate that goes green over
// an open defect is worse than no gate. Acknowledgement is a property of THIS report, not of the
// grading.
//
// Usage:
//   node scripts/eval-gate.mjs                     # full matrix, append to the ledger
//   node scripts/eval-gate.mjs --task 013a         # record which task this run gated
//   node scripts/eval-gate.mjs --dry-run           # no ledger write
//   node scripts/eval-gate.mjs --from <file.json>  # reuse a saved artifact, run nothing
//   ONCHAIN_EVAL_CHAINS=ethereum node scripts/eval-gate.mjs   # narrow, for a fast check
//
// Exit codes: 0 = nothing new and nothing stale — the task may be called done. 1 = blocked, or the
// gate itself could not run. The second is deliberately not distinguished by code: a gate that
// could not run has not passed, and treating "no answer" as "yes" is the failure this whole file is
// about.

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : (args[i + 1] ?? null);
};

const DRY_RUN = has('--dry-run');
const FROM_FILE = valueOf('--from');
const TASK = valueOf('--task');

const LEDGER = path.join(packageRoot, 'eval', 'ledger.jsonl');
const ACK_PATH =
  process.env.ONCHAIN_EVAL_ACK ?? path.join(packageRoot, 'eval', 'acknowledged.json');

/** The two verdicts `eval/run.mjs` counts as failures — the same two that drive its own exit code. */
const FAILING = new Set(['error', 'degraded']);

const key = (row) => `${row.chain}/${row.capability}`;

function die(message) {
  process.stderr.write(`eval-gate: ${message}\n`);
  process.exitCode = 1;
}

/** Short sha of the tree being gated, so a ledger line can be tied to what was actually running. */
function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: packageRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Runs the eval to completion and returns its parsed JSON artifact.
 *
 * stdout/stderr are inherited so the full human-readable table stays on screen: the artifact is
 * what this script reasons over, the table is what a human reads when a verdict is surprising.
 */
async function runEval(artifactPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(packageRoot, 'eval', 'run.mjs')], {
      cwd: packageRoot,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, ONCHAIN_EVAL_JSON: artifactPath },
    });
    child.on('error', (err) => resolve({ spawnError: err }));
    child.on('close', (code) => resolve({ exitCode: code }));
  });
}

/**
 * Splits the matrix against the acknowledged list.
 *
 * `stale` covers both ways an entry stops covering anything: the row passes now, or the row is gone
 * from the matrix entirely. The second also means coverage silently shrank — a capability dropped
 * from `eval/cases/` would look exactly like this, which is the RF-5 shape.
 */
function partition(results, ack) {
  const byKey = new Map(results.map((row) => [key(row), row]));

  const unacknowledged = [];
  const known = [];
  for (const row of results) {
    if (!FAILING.has(row.verdict)) continue;
    const k = key(row);
    const entry = ack[k];
    if (entry) known.push({ key: k, issue: entry.issue, since: entry.since });
    else
      unacknowledged.push({
        key: k,
        verdict: row.verdict,
        problem: (row.problems ?? [])[0] ?? 'no detail reported',
      });
  }

  const stale = [];
  for (const [k, entry] of Object.entries(ack)) {
    const row = byKey.get(k);
    if (!row) stale.push({ key: k, issue: entry.issue, reason: 'no longer in the eval matrix' });
    else if (!FAILING.has(row.verdict))
      stale.push({ key: k, issue: entry.issue, reason: `now passes (${row.verdict})` });
  }

  return { unacknowledged, known, stale };
}

function report({ counts, unacknowledged, known, stale, blocked }) {
  const out = [];
  out.push('');
  out.push(`  eval-gate: ${blocked ? 'BLOCKED' : 'pass'}`);
  out.push(
    `  ok ${counts.ok ?? 0} · error ${counts.error ?? 0} · unsupported ${counts.unsupported ?? 0} ` +
      `· no-probe ${counts['no-probe'] ?? 0}`,
  );
  if (unacknowledged.length) {
    out.push('');
    out.push(`  NEW failures (${unacknowledged.length}) — nothing filed, so the gate blocks:`);
    for (const u of unacknowledged) out.push(`   ✗ ${u.key} [${u.verdict}] ${u.problem}`);
    out.push('');
    out.push(
      '  File it (docs/KNOWN_ISSUES.md), then add it to eval/acknowledged.json with the id.',
    );
  }
  if (stale.length) {
    out.push('');
    out.push(`  STALE acknowledgements (${stale.length}) — remove from eval/acknowledged.json:`);
    for (const s of stale) out.push(`   ✗ ${s.key} (${s.issue}): ${s.reason}`);
  }
  // Named on every run on purpose: acknowledged is not hidden (L-2). Closing the report does not
  // close the obligation to chase the vendor or retire the capability.
  if (known.length) {
    out.push('');
    out.push(`  Known, filed, still open (${known.length}) — does not block:`);
    for (const k of known) out.push(`   · ${k.key} → ${k.issue}, since ${k.since}`);
  }
  if (!unacknowledged.length && !stale.length && !known.length) {
    out.push('');
    out.push('  No failures and no acknowledgements — registry and providers agree.');
  }
  out.push('');
  process.stdout.write(out.join('\n'));
}

async function main() {
  let artifact;
  let evalExitCode = null;

  if (FROM_FILE) {
    artifact = JSON.parse(readFileSync(FROM_FILE, 'utf8'));
  } else {
    const tmp = mkdtempSync(path.join(tmpdir(), 'eval-gate-'));
    const artifactPath = path.join(tmp, 'eval.json');
    const outcome = await runEval(artifactPath);
    if (outcome.spawnError) {
      rmSync(tmp, { recursive: true, force: true });
      return die(`could not start the eval: ${outcome.spawnError.message}`);
    }
    evalExitCode = outcome.exitCode;
    try {
      artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      // A non-zero eval exit is expected and fine; producing no readable artifact is not.
      return die(`the eval left no readable artifact (exit ${evalExitCode}): ${err.message}`);
    }
    rmSync(tmp, { recursive: true, force: true });
  }

  const ack = JSON.parse(readFileSync(ACK_PATH, 'utf8')).acknowledged ?? {};
  const { unacknowledged, known, stale } = partition(artifact.results ?? [], ack);
  const blocked = unacknowledged.length > 0 || stale.length > 0;
  const counts = artifact.counts ?? {};

  report({ counts, unacknowledged, known, stale, blocked });

  if (!DRY_RUN) {
    // Append-only, one line per gate run. This is the evidence that the gate actually ran at a
    // task's completion — the question "was this checked against live providers, and when?" has an
    // answer in the repo instead of in someone's memory.
    const line = {
      ranAt: artifact.ranAt,
      task: TASK,
      gitSha: gitSha(),
      counts,
      // The eval's own exit code, kept beside our verdict: they answer different questions, and a
      // ledger that recorded only ours could not later show that `pnpm eval` was red at the time.
      evalExitCode,
      verdict: blocked ? 'blocked' : 'pass',
      unacknowledged: unacknowledged.map((u) => u.key),
      known: known.map((k) => `${k.key}=${k.issue}`),
      stale: stale.map((s) => s.key),
    };
    try {
      appendFileSync(LEDGER, `${JSON.stringify(line)}\n`);
      process.stdout.write(`  ledger: appended to ${path.relative(packageRoot, LEDGER)}\n\n`);
    } catch (err) {
      return die(`could not append to the ledger: ${err.message}`);
    }
  }

  if (blocked) process.exitCode = 1;
}

main().catch((err) => die(`fatal: ${err.stack ?? err}`));
