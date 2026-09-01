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

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { crossChecks, grade } from './checks.mjs';
import { TRANSPORT_CASES } from './cases/index.mjs';
import { CAPABILITY_EXCLUSIONS, CAPABILITY_TOOLS, unwiredCapabilities } from './capabilities.mjs';
import { renderLink, startLinkProbe } from './link-probe.mjs';
import { stateTargetLabel, storageOf } from './profiles.mjs';

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
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        LOG_LEVEL: 'error',
        // DECLARED, not inherited (task 015-30). This phase speaks JSON-RPC over the pipes opened
        // above, and `local` is the only profile that raises a stdio transport (`src/profile.ts`).
        // The two other spawners here already name their profile; this one inherited the
        // OPERATOR's, and after the WI-62 move the repo-root `.env` carries
        // `ONCHAIN_PROFILE=network` — so the capability matrix would have spawned a process that
        // binds an HTTP port (the live server's own, from the same file) and answers nothing on
        // stdout. Every row of the matrix would then be a timeout, on a machine where the server
        // works. It also makes true what `cases/shared/ledger-reader.mjs` already asserts about
        // this phase: its store is SQLite under `DATA_DIR`, always.
        ONCHAIN_PROFILE: 'local',
      },
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
  // `dataDir` travels out because the HTTP phase reads the ledger rows THIS phase wrote, to
  // compare a local principal against an authenticated one (AC-28). The directory outlives the
  // HTTP phase by the existing order alone: `runHttpPhase` is called before the `finally` that
  // calls `server.stop()`, and the removal happens there. Nothing is held open on purpose.
  return { send, notify, stop, stderr, dataDir };
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

async function callToolOnce(server, name, args, context) {
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
    const g = grade(name, structured, { ...context, args });
    return { ...g, ms, structured };
  } catch (err) {
    return { verdict: 'error', ms: Date.now() - started, problems: [String(err.message ?? err)] };
  }
}

async function callTool(server, name, args, context) {
  let outcome = await callToolOnce(server, name, args, context);
  for (const backoff of RETRY_BACKOFF_MS) {
    if (outcome.verdict !== 'error' || !RETRIABLE.test(outcome.problems.join(' '))) break;
    await sleep(backoff);
    outcome = await callToolOnce(server, name, args, context);
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
  // Started FIRST and stopped LAST, so the window it measures is the window the vendors are called
  // in. `probes.json` owns the hosts; absent configuration it is a no-op that reports `not measured`
  // rather than a silently missing check.
  const linkProbe = startLinkProbe(probes.linkProbes);
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
        // The REQUEST reaches the case's check alongside the response (task 014-32c). A check that
        // sees only the answer can verify its shape and never that it answers the question asked.
        const outcome = await callTool(server, tool, built, { chain, capability, probe });

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

    // The HTTP set, after the capability matrix and on its own profile. It raises a second process
    // with its own temporary DATA_DIR, so nothing above is affected by it.
    await runHttpPhase(record, { stdioDataDir: server.dataDir });
  } finally {
    server.stop();
  }

  // Stopped only now, so the window it measured is the window the vendors were called in. A probe
  // that ended earlier would leave exactly the gap the hand-run one left on 2026-08-24.
  const link = await linkProbe.stop();
  report(results, server.stderr, references, link);
}

// ── the HTTP set (task 014-33, R-22) ──────────────────────────────────────────────────────────────
//
// WHY A SECOND PHASE AND NOT A SECOND TRANSPORT FOR THE MATRIX. The capability matrix does not
// depend on the transport and raises more cheaply over stdio. What HTTP adds — authentication, the
// perimeter, a session, a principal, a limiter under concurrency — is exactly what no fixture-backed
// test reaches, so that is what this phase exercises and nothing else.
//
// WHY A FAILED PHASE RECORDS `error` ROWS RATHER THAN SKIPPING. `no-probe` is not counted as a
// failure, so a skip would read as success. A gate that could not run has not passed.

const HTTP_PROFILE = process.env.ONCHAIN_EVAL_HTTP_PROFILE ?? 'network-sqlite';
/** The pepper this phase runs with. Local to the run: it never leaves the temporary DATA_DIR. */
const HTTP_PEPPER = 'onchain-eval-transport-pepper';
const HTTP_ADMIN_EMAIL = 'eval-transport@onchain.invalid';
/**
 * An administrator that ALREADY EXISTS in the store, named by the operator.
 *
 * Needed only on the Postgres axis, and needed there because the escape `issueToken` relies on is
 * deliberately narrow: `user:add` may omit `--actor` for the first user of an EMPTY store
 * (`src/admin/cli.ts`), and the engine's own store is not empty — migration 003 seeds its first
 * administrator. So the acceptance run cannot bootstrap; it has to be authorised by someone.
 *
 * Never printed: the value is a real person's address, and the phase's refusal below names the KEY.
 */
const HTTP_ADMIN_ACTOR = process.env.ONCHAIN_EVAL_ADMIN_ACTOR ?? null;
const LISTEN_TIMEOUT_MS = 30_000;

/** The storage axis the raised profile actually uses — see `eval/profiles.mjs`. */
const HTTP_STORAGE = storageOf(HTTP_PROFILE);

/**
 * The namespace the phase accepts a client-supplied request id under.
 *
 * Without it the server takes no client id at all and mints a server-side one per call
 * (`src/server.ts`), so a retry case would be measuring two independent requests rather than a
 * repeat.
 */
// Reverse-DNS form, which `EnvSchema` requires and `onchain-eval` is not: the namespace exists
// for UNIQUENESS, so a bare label would be a name we do not own. `.invalid` is reserved
// (RFC 2606), like the phase's admin address above.
const HTTP_META_NAMESPACE = 'eval.onchain-intel.invalid';

/**
 * A SYNTHETIC daily ceiling for blockscout, in single calls.
 *
 * The productive figure is an estimate (`ADR-003` D6, ~625/day) and stays labelled as one; a live
 * case must not walk toward it, and must not starve the shared limiter on the way. Task 015-16
 * introduced this key for exactly this run.
 */
const HTTP_DAILY_CALL_CAP = Number(process.env.ONCHAIN_EVAL_BLOCKSCOUT_CAP ?? 3);

/**
 * Where the `network` profile's state goes, NAMED rather than inherited.
 *
 * **Why one constant read by every process of the phase.** `admin()` and `startHttpServer` both
 * spread `process.env`, and the runner has already loaded the repo-root `.env` into its own
 * environment. Setting this for the server alone would split them: the server would write to the
 * named database while `admin()` issued the phase token into whatever the operator's environment
 * happened to point at. Every transport case would then answer "authentication refused", and the
 * pre-start check for active tokens would pass against the MIGRATED rows of the real container —
 * a run that looks like broken cases rather than a misdirected store.
 *
 * **Why named at all.** A run whose state target is not stated is indistinguishable from a run
 * against somebody else's database, and the run artifact would not say which it was.
 */
const HTTP_STATE_PG_URL =
  process.env.ONCHAIN_EVAL_STATE_PG_URL ?? process.env.ONCHAIN_STATE_PG_URL ?? null;

/**
 * What the phase adds to EVERY child process it starts — the server and both `admin()` calls.
 *
 * Built once so the three cannot drift apart. `ONCHAIN_STATE_PG_URL` is omitted entirely when it is
 * not set, so the SQLite axis is unaffected by its presence in this table.
 */
const PHASE_ENV = Object.freeze({
  ONCHAIN_META_NAMESPACE: HTTP_META_NAMESPACE,
  BLOCKSCOUT_DAILY_CALL_CAP: String(HTTP_DAILY_CALL_CAP),
  ...(HTTP_STATE_PG_URL === null ? {} : { ONCHAIN_STATE_PG_URL: HTTP_STATE_PG_URL }),
});

/** A free localhost port, taken by binding one and releasing it. */
async function freePort() {
  const { createServer } = await import('node:net');
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Runs one admin command in the temporary store, and returns its stdout lines. */
function admin(dataDir, argv) {
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/admin/bin.ts', ...argv], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      ONCHAIN_PROFILE: HTTP_PROFILE,
      ONCHAIN_TOKEN_HASH_SALT: HTTP_PEPPER,
      // The same table the server gets. Under `network` this is what decides which database the
      // token is issued INTO — see `PHASE_ENV`.
      ...PHASE_ENV,
    },
  });
  if (child.status !== 0) {
    throw new Error(
      `admin ${argv[0]} failed (exit ${String(child.status)}): ${(child.stderr || child.stdout).trim().slice(0, 300)}`,
    );
  }
  return child.stdout.split('\n').filter(Boolean);
}

/**
 * Issues the phase's token, BEFORE the process starts.
 *
 * The network profile's pre-start checks refuse a start with zero active rows in `api_tokens`
 * (task 014-38), so a process raised first would not come up.
 *
 * **The phase gets its OWN identity, on both axes.** On the SQLite axis that is free: the store is
 * a fresh temporary file every run and `user:add` bootstraps it. On the Postgres axis the store is
 * the engine's own, and the choice is deliberate rather than incidental — reusing the operator's
 * administrator would attribute every `client_usage` and `request_trace` row this run writes to a
 * real principal, leaving verification traffic indistinguishable from productive traffic IN THE
 * STORE, where the billing claims live. R-12.3 asks for the opposite, and the ledger line's `task`
 * field cannot supply it: nothing in the database reads that file.
 *
 * **Why it is created by trying rather than by asking.** The admin CLI has no `user:list`, so there
 * is no way to ask whether this identity already exists — and after the first acceptance run
 * against an engine it does. Issuing first and creating only on failure keeps the store at exactly
 * one extra identity however many times the gate runs; a `user:add` that ran unconditionally would
 * fail on the second run, and one that never ran would fail on the first.
 *
 * **The pepper is the phase's own** (`HTTP_PEPPER`), not the deployment's, so the digest this run
 * leaves behind cannot be matched by any token the production server would accept. The row is
 * revoked in `runHttpPhase`'s `finally` regardless.
 */
function issueToken(dataDir) {
  if (HTTP_STORAGE === 'postgres' && HTTP_ADMIN_ACTOR === null) {
    throw new Error(
      'the Postgres axis needs ONCHAIN_EVAL_ADMIN_ACTOR — the address of an administrator that ' +
        'already exists in the engine store. `user:add` may omit an actor only for the first user ' +
        'of an EMPTY store, and the engine store is seeded (migration 003), so this run has to be ' +
        'authorised by someone rather than bootstrap itself',
    );
  }
  const issue = () =>
    admin(dataDir, [
      'token:issue',
      '--user',
      HTTP_ADMIN_EMAIL,
      '--actor',
      HTTP_ADMIN_ACTOR ?? HTTP_ADMIN_EMAIL,
      '--name',
      'eval-transport',
    ]);
  let lines;
  try {
    lines = issue();
  } catch {
    // The identity is not there yet. `--actor` is omitted on the SQLite axis so the empty-store
    // bootstrap applies, and supplied on Postgres where it is required.
    admin(dataDir, [
      'user:add',
      '--email',
      HTTP_ADMIN_EMAIL,
      '--role',
      'admin',
      ...(HTTP_ADMIN_ACTOR === null ? [] : ['--actor', HTTP_ADMIN_ACTOR]),
    ]);
    lines = issue();
  }
  const value = lines.find((l) => l.startsWith('oi_'));
  const idLine = lines.find((l) => l.startsWith('id='));
  const tokenId = idLine?.match(/^id=(\S+)/)?.[1];
  if (!value || !tokenId) throw new Error('token:issue printed neither a value nor an id');
  return { token: value.trim(), tokenId };
}

/** Starts the server on the chosen profile and resolves once it announces its listener. */
async function startHttpServer(dataDir, port) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      ONCHAIN_PROFILE: HTTP_PROFILE,
      ONCHAIN_TOKEN_HASH_SALT: HTTP_PEPPER,
      ONCHAIN_HTTP_BIND: '127.0.0.1',
      ONCHAIN_HTTP_PORT: String(port),
      // The same table both `admin()` calls get — see `PHASE_ENV`.
      ...PHASE_ENV,
    },
  });
  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', () => {});

  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `the server did not announce a listener in ${String(LISTEN_TIMEOUT_MS)}ms: ${stderr.join('').slice(-400)}`,
          ),
        ),
      LISTEN_TIMEOUT_MS,
    );
    timer.unref?.();
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
      if (/listening on /.test(chunk)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `the server exited (${String(code)}) before listening: ${stderr.join('').slice(-400)}`,
        ),
      );
    });
  });
  await listening;
  return { child, stderr };
}

/** The context every transport case receives. */
function transportContext(baseUrl, token, { dataDir, stdioDataDir }) {
  const request = async ({ method = 'POST', body = '', headers = {} } = {}) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body }),
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    };
  };

  /** One MCP session over Streamable HTTP: `initialize`, then tool calls, then `DELETE`. */
  const openSession = async () => {
    let id = null;
    let nextId = 0;
    const send = async (payload, extraHeaders = {}) => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          ...(id === null ? {} : { 'mcp-session-id': id }),
          ...extraHeaders,
        },
        body: JSON.stringify(payload),
      });
      const header = response.headers.get('mcp-session-id');
      if (header) id = header;
      const text = await response.text();
      // Streamable HTTP may answer either a bare JSON body or an SSE frame; the eval reads both
      // rather than assuming one, because assuming is how a transport change reads as a tool fault.
      //
      // The frame is detected by CONTAINING a `data:` line, not by starting with one: this server
      // emits `event: message` first, and a check anchored to the body's first characters read that
      // as JSON and reported a transport fault as an unparseable tool answer.
      const dataLines = text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
      const jsonText = dataLines.length > 0 ? dataLines.join('') : text;
      try {
        return JSON.parse(jsonText);
      } catch {
        return {
          error: {
            message: `unparseable body (HTTP ${String(response.status)}): ${text.slice(0, 200)}`,
          },
        };
      }
    };

    const init = await send({
      jsonrpc: '2.0',
      id: (nextId += 1),
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'onchain-eval-http', version: '1.0.0' },
      },
    });
    if (init.error) throw new Error(`initialize over HTTP failed: ${init.error.message}`);
    await send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

    return {
      get id() {
        return id;
      },
      initialized: !init.error,
      // `meta` lands at `params._meta`, NOT inside `arguments`: that is where the SDK surfaces it
      // as `extra._meta`, which is what `readClientRequestId` reads
      // (`src/tools/registry.ts`). Passed inside `arguments` it would be validated as a tool
      // parameter — rejected by a `.strict()` schema, or silently ignored — and a retry case built
      // on it would measure two independent requests while reporting on a repeat.
      callTool: (name, args, meta) =>
        send({
          jsonrpc: '2.0',
          id: (nextId += 1),
          method: 'tools/call',
          params: { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) },
        }),
      close: async () => {
        if (id === null) return;
        await fetch(`${baseUrl}/mcp`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}`, 'mcp-session-id': id },
        }).catch(() => {});
      },
    };
  };

  // Three fields beyond the four a transport case has always had (task 015-29):
  //   `dataDir`      — this phase's temporary DATA_DIR (the SQLite axis reads its cache file)
  //   `stdioDataDir` — the capability phase's, so a case can compare a LOCAL principal's ledger
  //                    rows against an authenticated one (AC-28)
  //   `storage`      — the raised profile's axis, so a ledger reader follows the store rather
  //                    than a filename that would read empty on `network` and assert the zero
  return {
    baseUrl,
    token,
    request,
    openSession,
    dataDir,
    stdioDataDir,
    storage: HTTP_STORAGE,
    // The same constant the server and both `admin()` calls were given. A case must not reach for
    // `process.env` here: it could then read a different database than the run wrote to.
    stateDsn: HTTP_STATE_PG_URL,
  };
}

/**
 * Runs the HTTP set and records one row per case.
 *
 * Every failure mode records rows rather than throwing past the caller: a phase that could not run
 * must be VISIBLE in the matrix, and `record` is the only channel the report reads.
 */
async function runHttpPhase(record, { stdioDataDir } = {}) {
  const label = (c) => c.label;
  if (TRANSPORT_CASES.length === 0) return;

  let dataDir = null;
  let server = null;
  let issued = null;
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'onchain-eval-http-'));
    issued = issueToken(dataDir);
    const port = await freePort();
    server = await startHttpServer(dataDir, port);
    const ctx = transportContext(`http://127.0.0.1:${String(port)}`, issued.token, {
      dataDir,
      stdioDataDir,
    });

    for (const c of TRANSPORT_CASES) {
      const started = Date.now();
      try {
        const observation = await c.exercise(ctx);
        const problems = c.check(observation) ?? [];
        record('—', label(c), null, {
          verdict: problems.length === 0 ? 'ok' : 'degraded',
          ms: Date.now() - started,
          problems,
        });
      } catch (error) {
        record('—', label(c), null, {
          verdict: 'error',
          ms: Date.now() - started,
          problems: [String(error?.message ?? error)],
        });
      }
    }
  } catch (error) {
    // The phase itself could not be raised. Every case records `error`, so the count of failures
    // reflects what was not verified rather than shrinking to zero.
    for (const c of TRANSPORT_CASES) {
      record('—', label(c), null, {
        verdict: 'error',
        ms: 0,
        problems: [`the HTTP phase could not be raised: ${String(error?.message ?? error)}`],
      });
    }
  } finally {
    if (server) {
      server.child.kill('SIGTERM');
    }
    // The token is revoked before the directory goes, so the revocation is recorded in the journal
    // this run wrote rather than disappearing with the file.
    if (dataDir && issued) {
      try {
        admin(dataDir, ['token:revoke', '--token-id', issued.tokenId, '--actor', HTTP_ADMIN_EMAIL]);
      } catch {
        // A revoke that fails is not worth failing the run for: the store is about to be deleted.
      }
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  }
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
function report(results, stderrLines, references = {}, link = null) {
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
  // WI-65 — printed every run, stable or not. A run whose own egress stalled reads exactly like one
  // where several vendors broke at once, and on 2026-08-24 it did: four `capability deadline
  // exceeded` rows plus two acknowledgements over their bounds, all of it our own link. The line
  // goes NEXT TO the failures rather than filtering them; nothing here suppresses a row.
  console.log(`\n  ${renderLink(link)}`);

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
      // `httpProfile` is the pair the HTTP set ran under. Without it a run on `network-sqlite`
      // is indistinguishable from a run on `network` in the one record that survives (task 014-33).
      JSON.stringify(
        // `link` (WI-65) is what makes a run's numbers admissible as a MEASUREMENT rather than an
        // observation: the owner's rule of 2026-08-24 sets a bound from two consecutive runs whose
        // link was stable, and without this field neither the gate nor a later reader can tell.
        {
          ranAt: new Date().toISOString(),
          httpProfile: HTTP_PROFILE,
          // The axis the HTTP set ran on and WHERE its state went — address only, never the DSN
          // (D10). Without these two a run against the engine's own container is indistinguishable
          // in the record from a run against a throwaway SQLite file, and the billing claims of
          // AC-28b mean different things in the two cases.
          httpStorage: HTTP_STORAGE,
          stateTarget: stateTargetLabel(HTTP_STORAGE, HTTP_STATE_PG_URL),
          link,
          counts,
          results,
        },
        null,
        2,
      ),
    );
    console.log(`\n  JSON artifact → ${process.env.ONCHAIN_EVAL_JSON}`);
  }
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((err) => {
  console.error(`eval: fatal: ${err.stack ?? err}`);
  process.exitCode = 1;
});
