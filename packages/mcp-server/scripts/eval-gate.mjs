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
//   unacknowledged — a failure no entry covers. BLOCKS. This is the signal.
//   known          — inside an entry's declared set, within its bound. Named in the report, does not block.
//   expired        — an entry past its `reviewBy`, over its bound, or naming a row the matrix lost. BLOCKS.
//
// The third one is what keeps the second honest. Without it the acknowledged list only ever grows,
// and each entry silently covers a row nobody checks again — a blindfold assembled one honest
// decision at a time.
//
// **RF-10 changed what the second and third words MEAN, and it is worth saying why (task 014-43).**
// An entry used to be keyed on one row and to assert a CONSTANT: this row is failing. Staleness was
// then "the row passes". Both halves reject an INTERMITTENT failure, which is the only kind this
// project has ever met: the run where it fails reports it as unfiled, and the run where it passes
// reports the acknowledgement as stale. Measured over the seven runs of 2026-08-20 and again live on
// 2026-08-21, when `base/chain.transactions` failed four consecutive runs, was acknowledged, and
// then passed.
//
// So an entry now names a SET of rows and a BOUND on how many of them may fail at once, and it
// carries an expiry date. The bound is what stops the acknowledgement from growing past the fact
// that was measured — it is set to the number of rows failing WHEN THE ENTRY WAS WRITTEN, so a
// fifth failing chain under a bound of four is a new fact and blocks. The date is what replaces
// "the row passes" as the trigger to look again, and it is deliberately not derived from run
// history: `token.holders`' own record shows why a green run means "the cache was warm", so K
// consecutive green runs in one afternoon are not K independent samples. A calendar is a weaker
// signal that never lies about itself, and this gate stays a function of ONE run plus ONE file.
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
import { renderLink } from '../eval/link-probe.mjs';
import { buildFreshnessRefusal } from '../eval/build-freshness.mjs';
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

/**
 * Every issue id the defect ledger actually carries.
 *
 * `acknowledged.json`'s own comment has always said `issue` MUST reference a record in
 * docs/KNOWN_ISSUES.md, and until task 014-43 nothing checked it — so a typo, or an id someone
 * meant to file and did not, silenced a failing row exactly as well as a real record would. Read
 * from the INDEX rather than from `docs/issues/*.md`: the index is the artefact a human reads, and
 * a record with no index line is a broken ledger the format contract already forbids.
 */
function filedIssues() {
  const indexPath = path.join(packageRoot, '..', '..', 'docs', 'KNOWN_ISSUES.md');
  const ids = new Set();
  try {
    for (const match of readFileSync(indexPath, 'utf8').matchAll(/^- \*\*([A-Z]+-\d+)\*\*/gm)) {
      ids.add(match[1]);
    }
  } catch {
    // Unreadable ledger: every `issue` then fails validation and the gate blocks naming the file,
    // which is the honest outcome. Silently accepting any id here would turn a missing ledger into
    // a green run.
    return ids;
  }
  return ids;
}

/** Short sha of the tree being gated, so a ledger line can be tied to what was actually running. */
function gitSha() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: packageRoot,
      encoding: 'utf8',
    }).trim();
    // A COMMIT IS NOT A TREE, and this field's whole purpose is to tie a run to what was actually
    // running. A gate run during development normally happens on a dirty tree — the fix is written,
    // the run proves it, the commit comes after — so a bare sha names code the run did NOT execute.
    // Measured on the T-015 acceptance of 2026-09-02: a passing line recorded `b28d73a` while the
    // eval case it exercised existed only in the working tree.
    //
    // `--porcelain` over the whole repository, not just this package: the eval loads
    // `@onchain-intel/core` from its build, so an uncommitted change two directories away is still
    // a change this run may have executed.
    const dirty =
      execFileSync('git', ['status', '--porcelain'], { cwd: packageRoot, encoding: 'utf8' }).trim()
        .length > 0;
    return dirty ? `${sha}-dirty` : sha;
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
 * The longest an acknowledgement may run before someone looks again.
 *
 * M6's rule applied to this file's own new vocabulary: a `reviewBy` is a legal answer that did not
 * exist before, so it needs a ceiling. Without one, `reviewBy: "2099-01-01"` is a permanent
 * exemption wearing the costume of a review, and it would pass every check below.
 */
const MAX_REVIEW_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

/** ISO date (`YYYY-MM-DD`) → epoch-ms UTC, or `null` when it is not one. */
function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Reads the acknowledgement file as a CONTRACT, before any verdict is computed.
 *
 * Every defect here BLOCKS, and none of them is a judgement about the vendor — a malformed
 * instrument has not measured anything, and reporting "pass" over one is the failure this whole
 * file exists to prevent. `issue` is checked against the ledger for the reason the file's own
 * comment already gives: an acknowledgement without a filed issue is silence with extra steps, and
 * until now that sentence was a request rather than a check.
 */
function validateAck(ack, filedIssues, runAtMs) {
  const defects = [];
  const seen = new Map();

  for (const [label, entry] of Object.entries(ack)) {
    const where = `acknowledged["${label}"]`;
    if (!Array.isArray(entry.rows) || entry.rows.length === 0) {
      defects.push(`${where}: no \`rows\` — an entry must name the rows it covers`);
      continue;
    }
    for (const row of entry.rows) {
      const owner = seen.get(row);
      if (owner !== undefined) {
        defects.push(`${where}: row ${row} is also covered by "${owner}" — ownership is ambiguous`);
      } else seen.set(row, label);
    }
    if (!Number.isInteger(entry.maxFailing) || entry.maxFailing < 1) {
      defects.push(`${where}: \`maxFailing\` must be an integer of at least 1`);
    } else if (entry.maxFailing >= entry.rows.length) {
      // `>=`, not `>`. A bound EQUAL to the set size can never be exceeded either — `failing` is a
      // subset of `rows`, so `failing.length > maxFailing` is unreachable — and the entry then
      // accepts a total outage of everything it names, which is precisely what RF-10 says a fix
      // must not do. An entry covering a single row therefore cannot be written with `maxFailing: 1`
      // and must name the rows it rotates across, which is the whole point of the shape.
      defects.push(
        `${where}: \`maxFailing\` is ${entry.maxFailing} over ${entry.rows.length} rows — a bound ` +
          'that cannot be exceeded accepts the total outage it exists to keep visible. Name the ' +
          'rows the capability is SERVED on, not only the failing one: one chain of five failing ' +
          'is `rows: [all five], maxFailing: 1`, and the second chain to fail then blocks',
      );
    }
    if (typeof entry.issue !== 'string' || !filedIssues.has(entry.issue)) {
      defects.push(
        `${where}: \`issue\` ${JSON.stringify(entry.issue)} names no record in ` +
          'docs/KNOWN_ISSUES.md — file it first',
      );
    }
    const reviewBy = parseDate(entry.reviewBy);
    if (reviewBy === null) {
      defects.push(`${where}: \`reviewBy\` must be a YYYY-MM-DD date`);
    } else if (reviewBy - runAtMs > MAX_REVIEW_WINDOW_DAYS * DAY_MS) {
      defects.push(
        `${where}: \`reviewBy\` is more than ${MAX_REVIEW_WINDOW_DAYS} days out — that is a ` +
          'permanent exemption, not a review',
      );
    }
    if (typeof entry.why !== 'string' || entry.why.trim().length < 20) {
      defects.push(`${where}: \`why\` carries no usable reason`);
    }
  }
  return defects;
}

/**
 * Splits the matrix against the acknowledged list.
 *
 * `expired` covers the three ways an entry stops describing reality, and none of them is "a row it
 * names passed" — under a bound, some rows passing IS the rotation the bound exists to absorb:
 *
 *   - MORE rows fail than the bound allows — the fact grew past what was filed and measured;
 *   - a row it names is gone from the matrix — coverage silently shrank, the RF-5 shape;
 *   - `reviewBy` has passed — nobody has looked at this since it was written.
 *
 * `notTested` is counted and reported SEPARATELY rather than folded into either side. A
 * `rate-limited` row is not failing and it did not pass; counting it as "not failing" would let an
 * entry whose whole set is being throttled report `0 of 3 failing` and read as recovered. That is
 * RF-9's residue — the old code rendered exactly this case as `now passes (rate-limited)`, three
 * words describing three different things, none of them true.
 */
function partition(results, ack) {
  const byKey = new Map(results.map((row) => [key(row), row]));
  const covered = new Map();
  for (const [label, entry] of Object.entries(ack)) {
    for (const row of entry.rows ?? []) covered.set(row, label);
  }

  const unacknowledged = [];
  for (const row of results) {
    if (!FAILING.has(row.verdict)) continue;
    const k = key(row);
    if (covered.has(k)) continue;
    unacknowledged.push({
      key: k,
      verdict: row.verdict,
      problem: (row.problems ?? [])[0] ?? 'no detail reported',
    });
  }

  const known = [];
  const expired = [];
  for (const [label, entry] of Object.entries(ack)) {
    const rows = entry.rows ?? [];
    const missing = rows.filter((r) => !byKey.has(r));
    const failing = rows.filter((r) => byKey.has(r) && FAILING.has(byKey.get(r).verdict));
    const notTested = rows.filter(
      (r) => byKey.has(r) && !FAILING.has(byKey.get(r).verdict) && byKey.get(r).verdict !== 'ok',
    );
    const observed = {
      label,
      issue: entry.issue,
      since: entry.since,
      reviewBy: entry.reviewBy,
      bound: entry.maxFailing,
      total: rows.length,
      failing,
      notTested,
    };

    if (missing.length > 0) {
      expired.push({
        ...observed,
        reason: `names ${missing.join(', ')}, which the eval matrix no longer contains`,
      });
      continue;
    }
    if (failing.length > entry.maxFailing) {
      expired.push({
        ...observed,
        reason:
          `${failing.length} of ${rows.length} failing, over the bound of ${entry.maxFailing} — ` +
          `${failing.join(', ')}`,
      });
      continue;
    }
    known.push(observed);
  }

  return { unacknowledged, known, expired };
}

/** Entries whose review date has passed — separated from `expired` only so the report can say why. */
function overdue(known, runAtMs) {
  return known
    .filter((entry) => {
      const by = parseDate(entry.reviewBy);
      return by !== null && by < runAtMs;
    })
    .map((entry) => ({
      ...entry,
      reason: `review was due ${entry.reviewBy} — re-measure and decide`,
    }));
}

/** `2 of 5 failing (bound 3)`, plus the untested count only when there is one. */
function tally(entry) {
  const base = `${entry.failing.length} of ${entry.total} failing (bound ${entry.bound})`;
  return entry.notTested.length === 0
    ? base
    : `${base}, ${entry.notTested.length} NOT TESTED (${entry.notTested.join(', ')})`;
}

function report({ counts, unacknowledged, known, expired, defects, blocked, link = null }) {
  const out = [];
  out.push('');
  out.push(`  eval-gate: ${blocked ? 'BLOCKED' : 'pass'}`);
  out.push(
    `  ok ${counts.ok ?? 0} · error ${counts.error ?? 0} · unsupported ${counts.unsupported ?? 0} ` +
      `· no-probe ${counts['no-probe'] ?? 0}`,
  );
  // WI-65 — above the failures, because it decides how to read them. A run whose own egress stalled
  // produces vendor rows that are an observation and not a measurement, and the owner's rule of
  // 2026-08-24 forbids setting a bound from one. It never removes a row: a gate that decided on its
  // own when to stop believing itself would be a gate nobody can audit.
  out.push(`  ${renderLink(link)}`);
  if (link && link.verdict !== 'stable') {
    out.push(
      '  → A BOUND MAY NOT BE SET OR RAISED FROM THIS RUN. Re-run when the link is stable; a bound ' +
        'is the maximum over TWO consecutive stable runs (owner decision, 2026-08-24).',
    );
  }
  if (defects.length) {
    out.push('');
    out.push(`  eval/acknowledged.json is MALFORMED (${defects.length}) — fix the file:`);
    for (const d of defects) out.push(`   ✗ ${d}`);
    out.push('');
    out.push('  A gate that cannot read its own configuration has not passed.');
  }
  if (unacknowledged.length) {
    out.push('');
    out.push(
      `  NEW failures (${unacknowledged.length}) — no entry covers them, so the gate blocks:`,
    );
    for (const u of unacknowledged) out.push(`   ✗ ${u.key} [${u.verdict}] ${u.problem}`);
    out.push('');
    out.push(
      '  File it (docs/KNOWN_ISSUES.md), then add it to an eval/acknowledged.json entry — either ' +
        'inside an existing set (raising its bound is a NEW measurement, say so in `why`) or as a ' +
        'new entry with `rows`, `maxFailing`, `reviewBy` and the issue id.',
    );
  }
  if (expired.length) {
    out.push('');
    out.push(`  ACKNOWLEDGEMENTS that stopped describing reality (${expired.length}):`);
    for (const e of expired) out.push(`   ✗ ${e.label} (${e.issue}): ${e.reason}`);
  }
  // Named on every run on purpose: acknowledged is not hidden (L-2). Closing the report does not
  // close the obligation to chase the vendor or retire the capability.
  //
  // The TALLY is named too, and that is the M6 half of RF-10's fix: a bound is a wider legal answer
  // than a boolean, so the count it is measured against has to be visible on every run. An entry
  // sliding from 1 failing row to its bound of 3 never blocks — and must never be invisible.
  if (known.length) {
    out.push('');
    out.push(`  Known, filed, still open (${known.length}) — does not block:`);
    for (const k of known) {
      const names = k.failing.length > 0 ? ` — ${k.failing.join(', ')}` : '';
      out.push(`   · ${k.label} → ${k.issue}, ${tally(k)}, review by ${k.reviewBy}${names}`);
    }
  }
  if (!unacknowledged.length && !expired.length && !known.length && !defects.length) {
    out.push('');
    out.push('  No failures and no acknowledgements — registry and providers agree.');
  }
  out.push('');
  process.stdout.write(out.join('\n'));
}

async function main() {
  // A gate that could not run has not passed, and a gate that ran against last week's build has not
  // run. Checked here as well as in `run.mjs` so the message names the gate rather than surfacing as
  // "the eval left no readable artifact" (task 015-30).
  const staleBuild = buildFreshnessRefusal(path.resolve(packageRoot, '../..'));
  if (staleBuild !== null) return die(staleBuild);

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

  // Judged at the moment the EVAL ran, not at the moment this script did. `--from` replays a saved
  // artifact, and a replay must reach the verdict that run reached — otherwise re-reading last
  // week's evidence would manufacture expiries that nobody observed.
  const runAtMs = Date.parse(artifact.ranAt ?? '') || Date.now();

  const defects = validateAck(ack, filedIssues(), runAtMs);
  const { unacknowledged, known, expired } = partition(artifact.results ?? [], ack);
  const past = overdue(known, runAtMs);
  const stillKnown = known.filter((entry) => !past.some((p) => p.label === entry.label));
  const allExpired = [...expired, ...past];
  const blocked = unacknowledged.length > 0 || allExpired.length > 0 || defects.length > 0;
  const counts = artifact.counts ?? {};

  report({
    counts,
    unacknowledged,
    known: stillKnown,
    expired: allExpired,
    defects,
    blocked,
    link: artifact.link ?? null,
  });

  if (!DRY_RUN) {
    // Append-only, one line per gate run. This is the evidence that the gate actually ran at a
    // task's completion — the question "was this checked against live providers, and when?" has an
    // answer in the repo instead of in someone's memory.
    const line = {
      ranAt: artifact.ranAt,
      task: TASK,
      // Which storage/transport pair the HTTP set ran under (task 014-33). The ledger line is the
      // only surviving evidence of a run, and without this a `network-sqlite` run and a `network`
      // one read identically — while `onchain.provider_buckets` is covered by only one of them.
      httpProfile: artifact.httpProfile ?? null,
      // WI-65 — what OUR OWN egress was doing while the run happened. Without it the ledger cannot
      // tell a vendor incident from a local one after the fact, and the owner's rule of 2026-08-24
      // (a bound is the maximum over two consecutive runs on a measured-stable link) has nothing to
      // read. Summary only: the per-probe samples are noise in a committed file.
      link: artifact.link
        ? {
            verdict: artifact.link.verdict,
            thresholdMs: artifact.link.thresholdMs,
            reasons: artifact.link.reasons ?? [],
            perHost: (artifact.link.perHost ?? []).map((h) => ({
              host: h.host,
              samples: h.samples,
              failures: h.failures,
              medianConnectMs: h.medianConnectMs,
              maxConnectMs: h.maxConnectMs,
            })),
          }
        : null,
      gitSha: gitSha(),
      counts,
      // The eval's own exit code, kept beside our verdict: they answer different questions, and a
      // ledger that recorded only ours could not later show that `pnpm eval` was red at the time.
      evalExitCode,
      verdict: blocked ? 'blocked' : 'pass',
      // The KEY and the REASON, not the key alone. A rotating failure could not be diagnosed after
      // the fact: the artifact lives in a temp dir and is deleted, so a row that failed on Tuesday
      // and passed on Wednesday left nothing behind but its name. Four DefiLlama rows blocked the
      // gate on 2026-08-21 and what they said was already unrecoverable an hour later. Truncated
      // because the text is third-party and this file is committed.
      unacknowledged: unacknowledged.map((u) => ({
        key: u.key,
        verdict: u.verdict,
        problem: String(u.problem).slice(0, 200),
      })),
      // The tally, so the drift a bound legally absorbs is still readable in the ledger's history.
      known: known.map((k) => ({
        label: k.label,
        issue: k.issue,
        failing: k.failing,
        bound: k.bound,
        of: k.total,
        notTested: k.notTested,
      })),
      expired: allExpired.map((e) => ({ label: e.label, issue: e.issue, reason: e.reason })),
      ackDefects: defects.length,
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
