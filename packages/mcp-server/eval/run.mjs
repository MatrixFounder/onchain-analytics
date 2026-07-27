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
// SCOPE. Free/keyless providers only: DeFiLlama, CoinGecko, DexScreener, rpc-evm, rpc-solana.
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

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(evalDir, '..');
const PROTOCOL_VERSION = '2025-11-25';
const CALL_TIMEOUT_MS = 30_000;
const THROTTLE_MS = Number(process.env.ONCHAIN_EVAL_THROTTLE_MS ?? 350);
// CoinGecko's keyless tier is by far the tightest of the free providers; pacing only the calls that
// hit it keeps the whole run fast instead of slowing every provider to the strictest one's limit.
const COINGECKO_THROTTLE_MS = Number(process.env.ONCHAIN_EVAL_CG_THROTTLE_MS ?? 6000);

const probes = JSON.parse(readFileSync(path.join(evalDir, 'probes.json'), 'utf8'));

// capability → the tool that serves it, and how to build its arguments from a probe.
// Deriving cases from the LIVE registry rather than a hand-written list is the point: a chain or
// capability added later is exercised automatically, the same way onchain-verify treats a metric
// with no declared cadence as a defect rather than as absent.
const CAPABILITY_TOOLS = [
  { capability: 'chain.tvl', tool: 'onchain_chain_tvl', args: (c) => ({ chain: c }) },
  {
    capability: 'protocol.tvl',
    tool: 'onchain_protocol_tvl',
    args: (c, p) => (p.protocolSlug ? { chain: c, protocolSlug: p.protocolSlug } : null),
  },
  { capability: 'pairs.new', tool: 'onchain_new_pairs', args: (c) => ({ chain: c, limit: 5 }) },
  {
    capability: 'token.price',
    tool: 'onchain_get_token',
    args: (c, p) => (p.token ? { chain: c, address: p.token } : null),
  },
  {
    capability: 'wallet.balances.native',
    tool: 'onchain_wallet_balances',
    args: (c, p) => (p.wallet ? { chain: c, address: p.wallet } : null),
  },
];

// ── minimal JSON-RPC-over-stdio client (no SDK dependency, matching scripts/ house style) ────────
function startServer() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'onchain-intel-eval-'));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(packageRoot, 'src/index.ts')],
    {
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
  if (outcome.verdict === 'error' && RETRIABLE.test(outcome.problems.join(' '))) {
    return { ...outcome, verdict: 'rate-limited' };
  }
  return outcome;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── run ──────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const server = startServer();
  const results = [];
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
  } finally {
    server.stop();
  }

  report(results, server.stderr);
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
function report(results, stderrLines) {
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
      '\n  Not tested — provider rate-limited us (raise ONCHAIN_EVAL_CG_THROTTLE_MS or rerun):',
    );
    for (const t of throttled) console.log(`   ⏳ ${t.chain}/${t.capability}`);
  }
  const noProbe = results.filter((r) => r.verdict === 'no-probe');
  if (noProbe.length) {
    console.log('\n  Untested for lack of probe data (fix probes.json, not the code):');
    for (const n of noProbe) console.log(`   ? ${n.chain}/${n.capability}`);
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
