// Live eval for the FREE provider surface of the MCP server.
//
// WHY THIS EXISTS. Every existing suite runs against fixtures — deliberately, because R-21 forbids
// network calls in CI, and `scripts/smoke-dist.mjs` says so in its own header: it stays ping-only
// and never calls a data tool. The consequence is that nothing in the repo ever asks a real
// provider a real question, so a vendor that changes its payload cannot be detected by the test
// suite at all. That is not hypothetical: platform-explorer silently dropped a field and the gap
// stood for four days. This closes that hole, and is therefore NOT part of `pnpm test`.
//
// WHAT IT DOES. Drives the REAL server over stdio exactly as a real MCP client does — spawned
// child, newline-delimited JSON-RPC, the production `buildRegistry()` wiring, real adapters, real
// network. No injected fetch, no fixture registry, no internal imports: if it passes here it works
// for a client, which is the only claim worth making.
//
// SCOPE. Free/keyless providers only: DeFiLlama, CoinGecko, DexScreener, rpc-evm, rpc-solana,
// Blockscout, blockchain-info.
// The three Nansen-backed tools are excluded because calling them spends credits — an eval that
// bills you every run will be turned off, and a monitor that is off is worse than no monitor.
//
// Usage:
//   pnpm --filter @onchain-intel/mcp-server eval          # ~12 curated chains
//   ONCHAIN_EVAL_CHAINS=ethereum,solana pnpm … eval       # narrow to a few
//   ONCHAIN_EVAL_JSON=report.json pnpm … eval             # machine-readable artifact too
// Exit code is 0 when nothing is `error`/`degraded`, 1 otherwise — so it can gate a release.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { crossChecks, grade } from './checks.mjs';
import { CAPABILITY_EXCLUSIONS, CAPABILITY_TOOLS, unwiredCapabilities } from './capabilities.mjs';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(evalDir, '..');
/**
 * The repo-root `.env`, loaded into THIS process so the spawned server inherits it.
 *
 * L-6 fallout, measured 2026-08-11. `loadEnv()` calls `process.loadEnvFile()` with no argument, so
 * the server reads `.env` relative to its own CWD — and this runner spawns it in `packageRoot`,
 * where no `.env` exists. The load threw ENOENT, which `loadEnv` ignores by design, so every secret
 * in the repo-root `.env` was invisible to the server under eval. It did not matter while no
 * capability required a key; the moment blockscout did, the gate reported `token.holders` broken
 * against a key the operator had correctly configured. A false red costs what a false green costs:
 * both teach you to stop reading the gate.
 *
 * Loaded HERE rather than fixed by spawning in the repo root, which was tried first and is worse:
 * `--import tsx` resolves from the CWD and `tsx` is installed only under `packages/mcp-server`, so
 * moving the CWD trades a missing secret for a server that will not start at all.
 *
 * Absent `.env` stays non-fatal, exactly as `loadEnv` treats it — a contributor with no secrets
 * still gets the free contour. Failures are reported by CLASS; the file's contents are never echoed.
 */
const repoRoot = path.resolve(packageRoot, '../..');
try {
  process.loadEnvFile(path.join(repoRoot, '.env'));
} catch (error) {
  if (error?.code !== 'ENOENT') {
    console.error(`eval: warning: could not load the repo-root .env (${error?.code ?? 'unknown'})`);
  }
}
const PROTOCOL_VERSION = '2025-11-25';
const CALL_TIMEOUT_MS = 30_000;
const THROTTLE_MS = Number(process.env.ONCHAIN_EVAL_THROTTLE_MS ?? 350);
// CoinGecko's keyless tier is by far the tightest of the free providers; pacing only the calls that
// hit it keeps the whole run fast instead of slowing every provider to the strictest one's limit.
const COINGECKO_THROTTLE_MS = Number(process.env.ONCHAIN_EVAL_CG_THROTTLE_MS ?? 6000);

const probes = JSON.parse(readFileSync(path.join(evalDir, 'probes.json'), 'utf8'));

// ── minimal JSON-RPC-over-stdio client (no SDK dependency, matching scripts/ house style) ────────
function startServer() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'onchain-intel-eval-'));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(packageRoot, 'src/index.ts')],
    {
      // Stays `packageRoot` (`--import tsx` resolves from here); the secrets arrive through the
      // inherited `env` below, loaded by `repoRoot` above.
      cwd: packageRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DATA_DIR: dataDir, LOG_LEVEL: 'error' },
    },
  );

  let buffer = '';
  const pending = new Map();
  const stderr = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // A non-JSON line on stdout means something other than MCP touched the protocol stream
        // (ARCHITECTURE §7.3). Surface it rather than swallowing it.
        stderr.push(`NON-JSON ON STDOUT: ${line.slice(0, 200)}`);
        continue;
      }
      const resolver = pending.get(msg.id);
      if (resolver) {
        pending.delete(msg.id);
        resolver(msg);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => stderr.push(d));

  let nextId = 1;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout after ${CALL_TIMEOUT_MS}ms`));
      }, CALL_TIMEOUT_MS);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);

  const stop = () => {
    child.kill('SIGTERM');
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* temp dir cleanup is best-effort */
    }
  };
  return { send, notify, stop, stderr };
}

/**
 * A free-tier 429 means "not tested", NOT "broken" — and conflating the two is how a report earns
 * the right to be ignored. Retry with growing backoff; if the provider still refuses, say
 * `rate-limited` and keep it out of the failure count.
 */
// `aborted due to timeout` is the adapter's own deadline firing on a slow-but-healthy endpoint —
// retriable for the same reason a 429 is: it says nothing about whether the data is correct.
const RETRIABLE = /HTTP (429|5\d\d)|rate.?limit|ETIMEDOUT|ECONNRESET|abort|timed? ?out/i;

/**
 * RF-9 — the subset of `RETRIABLE` that actually means "the provider refused to serve us".
 *
 * These two conditions are worth RETRYING for the same reason and mean COMPLETELY different things
 * once the retries are spent, and the eval used to collapse them. A 429 is the provider declining:
 * nothing was measured, so `rate-limited` is honest and keeping it out of the failure count is
 * right. A transport timeout after three attempts is the endpoint failing to answer at all — a
 * measurement, and a bad one.
 *
 * Collapsing them cost three things on L-12, all at once. The row read `⏳ rate-limited` for a
 * Blockscout timeout; the report advised raising `ONCHAIN_EVAL_CG_THROTTLE_MS`, a CoinGecko knob
 * that cannot affect it; and — the one that mattered — because `rate-limited` is not in the gate's
 * `FAILING` set, the row could not be ACKNOWLEDGED. An open vendor failure was unnameable in the
 * file that exists to name open vendor failures.
 */
const THROTTLED = /HTTP (429|503)|rate.?limit/i;
const RETRY_BACKOFF_MS = [4000, 12000];

async function callToolOnce(server, name, args) {
  const started = Date.now();
  try {
    const res = await server.send('tools/call', { name, arguments: args });
    const ms = Date.now() - started;
    if (res.error)
      return { verdict: 'error', ms, problems: [`JSON-RPC error: ${res.error.message}`] };
    if (res.result?.isError) {
      const text = res.result?.content
        ?.map((c) => c.text)
        .join(' ')
        .slice(0, 200);
      return { verdict: 'error', ms, problems: [`tool reported error: ${text}`] };
    }
    const structured = res.result?.structuredContent;
    if (structured === undefined)
      return { verdict: 'degraded', ms, problems: ['no structuredContent'] };
    const g = grade(name, structured);
    return { ...g, ms, structured };
  } catch (err) {
    return { verdict: 'error', ms: Date.now() - started, problems: [String(err.message ?? err)] };
  }
}

async function callTool(server, name, args) {
  let outcome = await callToolOnce(server, name, args);
  for (const backoff of RETRY_BACKOFF_MS) {
    if (outcome.verdict !== 'error' || !RETRIABLE.test(outcome.problems.join(' '))) break;
    await sleep(backoff);
    outcome = await callToolOnce(server, name, args);
  }
  // RF-9: `THROTTLED`, not `RETRIABLE` — see that constant. A timeout that survived three
  // attempts stays an `error`, which is both the truth and what makes it acknowledgeable.
  if (outcome.verdict === 'error' && THROTTLED.test(outcome.problems.join(' '))) {
    return { ...outcome, verdict: 'rate-limited' };
  }
  return outcome;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── reference sources (TASK-009, R-88) ───────────────────────────────────────────────────────────
//
// A source the ENGINE does not use, fetched directly here so an answer can be checked against
// something with no shared cause. This is the ONE place that knows how to do it; every future
// source is a row in `probes.json`.
//
// Not routed through `safeFetch`: this file is a developer script, deliberately outside `pnpm test`
// and outside `dist/`, so nothing an agent or a client can reach ever executes it. What replaces the
// gate is that the URL is not computed — it comes from a reviewed data file and must be `https`.
const REFERENCE_TIMEOUT_MS = 10_000;
/** ~1 KB is three orders of magnitude above any plausible reference body (the BTC tip is 6 bytes). */
const REFERENCE_MAX_BYTES = 4096;

/** Reads one value out of a reference response per the `parse` mode declared in the data file. */
function parseReference(spec, text) {
  if (spec.parse === 'integer') {
    const body = text.trim();
    if (!/^\d{1,32}$/.test(body)) {
      // A text/plain surface returns an error PAGE with status 200 often enough that "it answered"
      // proves nothing. Describe the body, never quote it.
      throw new Error(`expected a plain integer, got string(length=${body.length})`);
    }
    return Number(body);
  }
  if (spec.parse === 'json') {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error(`expected JSON, got string(length=${text.length})`);
    }
    let cursor = doc;
    for (const key of spec.path ?? []) {
      cursor = cursor?.[key];
    }
    if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor)) {
      throw new Error(`${(spec.path ?? []).join('.')} is not a safe integer`);
    }
    return cursor;
  }
  throw new Error(`unknown parse mode '${spec.parse}'`);
}

/**
 * Fetches every declared reference source. A failure here is never a verdict about a provider —
 * it is our own apparatus being unavailable, so it is reported as such and the dependent
 * cross-check degrades to `no-probe`.
 */
async function loadReferenceSources(specs) {
  const loaded = {};
  for (const [name, spec] of Object.entries(specs ?? {})) {
    const started = Date.now();
    try {
      if (!String(spec.url).startsWith('https://')) {
        throw new Error('reference URLs must be https');
      }
      const response = await fetch(spec.url, {
        signal: AbortSignal.timeout(REFERENCE_TIMEOUT_MS),
        headers: { accept: 'text/plain, application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = (await response.text()).slice(0, REFERENCE_MAX_BYTES);
      loaded[name] = { ok: true, value: parseReference(spec, text), ms: Date.now() - started };
    } catch (err) {
      loaded[name] = { ok: false, error: String(err.message ?? err), ms: Date.now() - started };
    }
  }
  return loaded;
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const server = startServer();
  const results = [];
  // No initializer: `report`'s own default covers the path where the run throws before the sources
  // are loaded, so seeding `{}` here would be an assignment nothing ever reads.
  let references;
  const record = (chain, capability, tool, outcome) =>
    results.push({ chain, capability, tool, ...outcome });

  try {
    const init = await server.send('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'onchain-eval', version: '1.0.0' },
    });
    if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
    server.notify('notifications/initialized', {});

    // Server-level cases: these need no chain and must pass before anything else means anything.
    record('—', 'server', 'onchain_ping', await callTool(server, 'onchain_ping', {}));
    const chainsCall = await callTool(server, 'onchain_list_chains', { limit: 200 });
    record('—', 'registry', 'onchain_list_chains', chainsCall);

    const rows = chainsCall.structured?.chains ?? [];
    const registry = new Map(rows.map((c) => [c.slug, c.capabilities ?? []]));
    const nativeSymbols = new Map(rows.map((c) => [c.slug, c.nativeSymbol]));
    if (registry.size === 0) throw new Error('registry returned no chains — cannot build a matrix');

    const selected = process.env.ONCHAIN_EVAL_CHAINS
      ? process.env.ONCHAIN_EVAL_CHAINS.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : Object.keys(probes.chains);

    // Fetched once, before the matrix: every cross-check that needs an independent second opinion
    // reads from here rather than issuing its own call per chain.
    references = await loadReferenceSources(probes.referenceSources);
    // A reference that did not answer is OUR apparatus failing, not a provider defect — so it gets
    // a `no-probe` row of its own (out of the failure count) rather than degrading the tool it was
    // supposed to check. Recorded per reference so a silently missing second opinion is visible;
    // otherwise the cross-check simply stops running and the report looks exactly as green as a run
    // where it ran and passed.
    for (const [name, ref] of Object.entries(references)) {
      if (!ref.ok) {
        record('—', `reference:${name}`, '—', {
          verdict: 'no-probe',
          ms: ref.ms,
          problems: [
            `reference source unavailable (${ref.error}) — cross-checks using it did not run`,
          ],
        });
      }
    }

    for (const chain of selected) {
      const probe = probes.chains[chain];
      if (!probe) {
        record(chain, '—', '—', { verdict: 'no-probe', ms: 0, problems: ['not in probes.json'] });
        continue;
      }
      const declared = registry.get(chain);
      if (!declared) {
        record(chain, '—', '—', {
          verdict: 'error',
          ms: 0,
          problems: ['probes.json lists a chain the live registry does not know'],
        });
        continue;
      }

      const registrySymbol = nativeSymbols.get(chain);
      for (const { capability, tool, args } of CAPABILITY_TOOLS) {
        if (!declared.includes(capability)) {
          record(chain, capability, tool, {
            verdict: 'unsupported',
            ms: 0,
            problems: [`registry does not declare ${capability} for ${chain}`],
          });
          continue;
        }
        const built = args(chain, probe);
        if (!built) {
          record(chain, capability, tool, {
            verdict: 'no-probe',
            ms: 0,
            problems: [`no probe input curated for ${capability} on ${chain}`],
          });
          continue;
        }
        const outcome = await callTool(server, tool, built);

        // CROSS-SOURCE checks run on top of the per-tool grade: they compare the answer against a
        // second, independent source (the registry) rather than against itself.
        const cross = [
          ...crossChecks.registryVsProvider(chain, capability, outcome.verdict),
          ...crossChecks.chainEcho(chain, outcome.structured),
          ...(tool === 'onchain_wallet_balances'
            ? crossChecks.nativeSymbol(registrySymbol, outcome.structured)
            : []),
          // TASK-009: the only cross-check that consults a source outside the engine entirely.
          ...(tool === 'onchain_chain_supply'
            ? crossChecks.supplyVsConsensus(
                outcome.structured,
                references,
                probes.crossChecks?.supplyVsConsensus,
              )
            : []),
        ];
        const merged = cross.length
          ? {
              ...outcome,
              verdict: outcome.verdict === 'ok' ? 'degraded' : outcome.verdict,
              problems: [...outcome.problems, ...cross],
              cross: true,
            }
          : outcome;
        record(chain, capability, tool, merged);
        await sleep(tool === 'onchain_get_token' ? COINGECKO_THROTTLE_MS : THROTTLE_MS);
      }
    }

    // The two axes, compared. Everything above walks CAPABILITY_TOOLS; this walks what the chains
    // actually declare and names what nothing above touched.
    for (const row of unwiredCapabilities(selected, (c) => registry.get(c))) record(...row);
  } finally {
    server.stop();
  }

  report(results, server.stderr, references);
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
function report(results, stderrLines, references = {}) {
  const ICON = {
    ok: '✅',
    degraded: '⚠️ ',
    error: '❌',
    unsupported: '·',
    'no-probe': '?',
    'rate-limited': '⏳',
  };
  const counts = results.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a), {});

  console.log('\nonchain-intel — live eval, free providers only\n');
  const w = (s, n) => String(s).padEnd(n);
  console.log(`  ${w('chain', 12)} ${w('capability', 24)} ${w('', 3)} ${w('ms', 6)} detail`);
  console.log(
    `  ${'-'.repeat(12)} ${'-'.repeat(24)} ${'-'.repeat(3)} ${'-'.repeat(6)} ${'-'.repeat(40)}`,
  );
  for (const r of results) {
    // `unsupported` is expected and abundant — it is the registry correctly saying "not here".
    // Printing every one of them would bury the two verdicts that need a human.
    if (r.verdict === 'unsupported') continue;
    const detail = r.verdict === 'ok' ? '' : r.problems.join('; ').slice(0, 90);
    console.log(
      `  ${w(r.chain, 12)} ${w(r.capability, 24)} ${w(ICON[r.verdict], 3)} ${w(r.ms, 6)} ${detail}`,
    );
  }

  const unsupported = results.filter((r) => r.verdict === 'unsupported').length;
  console.log(
    '\n  ' +
      Object.entries(counts)
        .map(([k, v]) => `${ICON[k] ?? ''}${k}: ${v}`)
        .join('   '),
  );
  console.log(
    `  (${unsupported} unsupported rows hidden — the registry declining a capability is a pass, not a gap)`,
  );

  const failures = results.filter((r) => r.verdict === 'error' || r.verdict === 'degraded');
  if (failures.length) {
    console.log('\n  Needs attention:');
    for (const f of failures)
      console.log(`   ${ICON[f.verdict]} ${f.chain}/${f.capability}: ${f.problems.join('; ')}`);
  }
  const throttled = results.filter((r) => r.verdict === 'rate-limited');
  if (throttled.length) {
    console.log(
      '\n  Not tested — the provider declined to serve us (HTTP 429/503). Rerun, or slow this ' +
        'provider down; ONCHAIN_EVAL_CG_THROTTLE_MS is the CoinGecko knob and affects nothing else:',
    );
    for (const t of throttled) console.log(`   ⏳ ${t.chain}/${t.capability}`);
  }
  const noProbe = results.filter((r) => r.verdict === 'no-probe');
  if (noProbe.length) {
    console.log('\n  Untested — no probe input, or no eval case wired at all:');
    for (const n of noProbe)
      console.log(`   ? ${n.chain}/${n.capability}: ${n.problems.join('; ')}`);
  }
  // Printed every run, with the VALUE, not just "ok". A diagnostic nobody reads is not a
  // diagnostic: a cross-check that silently agreed and one that never ran look identical in a
  // pass/fail column, and only the number distinguishes them.
  if (Object.keys(references).length > 0) {
    console.log('\n  Independent reference sources (not used by the engine):');
    for (const [name, ref] of Object.entries(references)) {
      console.log(
        ref.ok
          ? `   · ${name} = ${ref.value} (${ref.ms}ms)`
          : `   ? ${name} unavailable: ${ref.error}`,
      );
    }
  }
  // Printed every run, unconditionally: an exclusion nobody is reminded of is indistinguishable
  // from an oversight, and this is the list that decides what the eval is allowed not to cover.
  console.log('\n  Excluded from the free contour by contract:');
  for (const [capability, reason] of CAPABILITY_EXCLUSIONS) {
    console.log(`   · ${capability}: ${reason}`);
  }
  const stderrText = stderrLines.join('');
  if (stderrText.includes('NON-JSON ON STDOUT')) {
    console.log('\n  ⚠️  something wrote non-JSON to stdout — that corrupts the MCP stream');
  }

  if (process.env.ONCHAIN_EVAL_JSON) {
    writeFileSync(
      process.env.ONCHAIN_EVAL_JSON,
      JSON.stringify({ ranAt: new Date().toISOString(), counts, results }, null, 2),
    );
    console.log(`\n  JSON artifact → ${process.env.ONCHAIN_EVAL_JSON}`);
  }
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((err) => {
  console.error(`eval: fatal: ${err.stack ?? err}`);
  process.exitCode = 1;
});
