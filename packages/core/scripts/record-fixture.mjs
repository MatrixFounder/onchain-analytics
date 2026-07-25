// Manual dev script (R-22, task 003-4; extended task 003-5 for rpc-evm/rpc-solana/platform-explorer)
// — NOT part of CI (nothing in .github/workflows/ci.yml invokes it, and no test imports it:
// enforced by this task's own acceptance grep).
//
// For coingecko/dexscreener/defillama/rpc-evm/rpc-solana: does exactly ONE real live HTTP call
// per invocation, through the adapter's own normal HTTP step (the same safeFetch-gated path
// `mcp-server` will use in production, via the SAME factory) — never a second, hand-rolled probe
// call. Writes the call's result as a committed fixture (`test/fixtures/<adapter>/<name>.json`)
// plus a human-readable evidence file (`<name>.evidence.md`: recorded_at, the exact endpoint
// touched, HTTP status, and the top-level field list actually observed) — vendor-drift
// discipline: recorded fact, never an assumption.
//
// For platform-explorer specifically (task 003-5): ONE invocation performs FOUR real live calls,
// one per distinct underlying REST endpoint this adapter's seven capabilities collapse onto
// (`/status` serves four of them — platform.identities/contracts/documents/credits — so it's
// called once, not four times) — matching the task's own single documented command line
// (`record-fixture.mjs platform-explorer dash # live + history эндпоинты`), which intentionally
// covers both current-state and history endpoints together rather than requiring four separate
// invocations. Each of the four writes its own `test/fixtures/platform-explorer/<name>.json` +
// `<name>.evidence.md` pair, using the exact same evidence format as the single-call path.
//
// Usage (no secrets required — all adapters here are keyless/free):
//   node packages/core/scripts/record-fixture.mjs coingecko <chain> <address>
//   node packages/core/scripts/record-fixture.mjs dexscreener <chain>
//   node packages/core/scripts/record-fixture.mjs defillama <chain> <protocolSlug>
//   node packages/core/scripts/record-fixture.mjs rpc-evm <chain> <address>
//   node packages/core/scripts/record-fixture.mjs rpc-solana <chain> <address>
//   node packages/core/scripts/record-fixture.mjs platform-explorer <chain>
//
// dash-platform/dune are NOT recorded by this script — dash-platform's fixture is hand-built
// (no live gRPC transport in M1, F-3) and dune has no fetch/normalize to record (config-stub, R-8).
//
// nansen (task 005-7, R-44) — added below, capability-argumented (NOT chain-argumented like every
// adapter above): one command = one logical `adapter.fetch(capability, args)` call = every
// HTTP-sub-call it makes is captured in ONE paid pass. This is the package's ONLY paid provider —
// every invocation below REQUIRES a live `NANSEN_API_KEY` (loaded from `.env` via
// `process.loadEnvFile()`, mirroring `packages/mcp-server/src/env.ts`'s own `loadEnv()`) and can
// spend real vendor credits. Recording goes through `createNansenAdapter`'s FULL production path
// (singleflight -> budget-gate -> sub-calls -> reconcile) against a REAL `BudgetStore` backed by
// `DATA_DIR` — never a hand-rolled fetch probe, never a second/bypassable call site (this
// directory's own hard rule + `adapters/nansen/index.ts`'s OQ-2 non-bypassability note). See
// `docs/tasks/task-005-7-fixtures-live-verification.md`'s own budget contract BEFORE running any
// of these — `DATA_DIR` MUST be the SAME directory across every invocation in one recording
// session (a fresh directory per call resets the `usage` ledger and defeats
// `NANSEN_DAILY_CREDIT_CAP`'s accumulation):
//   DATA_DIR=<dir> node packages/core/scripts/record-fixture.mjs nansen account
//   DATA_DIR=<dir> node packages/core/scripts/record-fixture.mjs nansen entity.labels <chain> <query>
//   DATA_DIR=<dir> node packages/core/scripts/record-fixture.mjs nansen smart-money.flows <chain> <tokenAddress>
//   DATA_DIR=<dir> node packages/core/scripts/record-fixture.mjs nansen token.risk <chain> <tokenAddress>
// The expensive `profiler/address/labels`/`premium-labels` endpoints are deliberately NOT
// reachable from this CLI at all (no `exhaustive`/`premium_labels` flag exposed) — their refusal
// paths are already proven by arithmetic tests (005-3/005-6), never by a live call.
//
// Requires a fresh build first (imports the compiled `dist/index.js` — mirrors
// `packages/mcp-server/scripts/smoke-dist.mjs`'s own dist-only precedent):
//   pnpm --filter @onchain-intel/core build

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..');
const distEntry = path.resolve(packageRoot, 'dist', 'index.js');

function fail(message) {
  console.error(`record-fixture: FAIL: ${message}`);
  process.exitCode = 1;
}

function writeEvidence(evidencePath, lines) {
  writeFileSync(evidencePath, `${lines.join('\n')}\n`);
}

// `raw` is this adapter's own {chain, [limit,] raw} envelope (see the adapter's own
// .AGENTS.md/docstring) — report BOTH the envelope's own keys AND the nested vendor response
// body's actual top-level fields (the latter is what's useful for vendor-drift monitoring).
function fieldsOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
}

function vendorFieldsOf(raw) {
  const vendorBody = raw && typeof raw === 'object' ? raw.raw : undefined;
  return Array.isArray(vendorBody)
    ? [`(array of ${vendorBody.length} items — see item keys below)`, ...fieldsOf(vendorBody[0])]
    : fieldsOf(vendorBody);
}

// Performs ONE fetch() call through `adapter`, writing a fixture + evidence pair under
// test/fixtures/<adapterId>/<fixtureName>.{json,evidence.md}. Returns true on success.
async function recordOneCall({ adapterId, adapter, capability, args, fixtureName, observedRef }) {
  const fixturesDir = path.resolve(packageRoot, 'test', 'fixtures', adapterId);
  mkdirSync(fixturesDir, { recursive: true });
  const fixturePath = path.join(fixturesDir, `${fixtureName}.json`);
  const evidencePath = path.join(fixturesDir, `${fixtureName}.evidence.md`);
  const recordedAt = new Date().toISOString();

  try {
    const raw = await adapter.fetch(capability, args);
    writeFileSync(fixturePath, `${JSON.stringify(raw, null, 2)}\n`);

    const envelopeFields = fieldsOf(raw);
    const vendorFields = vendorFieldsOf(raw);

    writeEvidence(evidencePath, [
      `# Fixture evidence: ${adapterId}/${fixtureName}`,
      '',
      `- recorded_at: ${recordedAt}`,
      `- endpoint: ${observedRef.value ? observedRef.value.url : '(not observed)'}`,
      `- http_status: ${observedRef.value ? observedRef.value.status : '(not observed)'}`,
      `- capability: ${capability}`,
      `- args: ${JSON.stringify(args)}`,
      `- envelope_fields: ${envelopeFields.length ? envelopeFields.join(', ') : '(none)'}`,
      `- vendor_response_fields: ${vendorFields.length ? vendorFields.join(', ') : '(none observed)'}`,
    ]);

    console.log(`record-fixture: OK: wrote ${fixturePath}`);
    console.log(`record-fixture: OK: wrote ${evidencePath}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeEvidence(evidencePath, [
      `# Fixture evidence: ${adapterId}/${fixtureName} — LIVE CALL FAILED`,
      '',
      `- recorded_at: ${recordedAt}`,
      `- endpoint: ${observedRef.value ? observedRef.value.url : '(not observed)'}`,
      `- http_status: ${observedRef.value ? observedRef.value.status : '(not observed)'}`,
      `- capability: ${capability}`,
      `- args: ${JSON.stringify(args)}`,
      `- error: ${message}`,
      '',
      'No fixture JSON was written for this call — a hand-authored minimal fixture MUST be',
      'created and clearly marked as such before the corresponding contract test can pass.',
    ]);
    fail(
      `live call failed for ${adapterId}/${fixtureName}: ${message} (evidence: ${evidencePath})`,
    );
    return false;
  }
}

function makeInstrumentedFetch(observedRef) {
  return async (url, opts) => {
    const response = await fetch(url, opts);
    observedRef.value = { url: String(url), status: response.status };
    return response;
  };
}

// ---------------------------------------------------------------------------------------------
// nansen (task 005-7, R-44) — see this file's own header comment for the full usage/scope note.
// ---------------------------------------------------------------------------------------------

/** `capability -> {"METHOD /path": fixtureName}` — exactly the sub-responses each capability's
 * OWN golden contract test (`test/nansen.contract.test.ts`) actually consumes as a fixture; e.g.
 * `entity.labels`' `search/entity-name` sub-call is real (cost/call parity, endpoints.ts) but has
 * no fixture file of its own — the golden test hardcodes `{data: []}` for it instead — so it is
 * deliberately NOT written here (no speculative, unconsumed fixture files). */
const NANSEN_CAPABILITY_FIXTURES = {
  'entity.labels': { 'POST /api/v1/search/general': 'search-general' },
  'smart-money.flows': {
    'POST /api/v1/smart-money/netflow': 'smart-money-netflow',
    'POST /api/v1/tgm/holders': 'tgm-holders',
  },
  'token.risk': {
    'POST /api/v1/tgm/indicators': 'tgm-indicators',
    'POST /api/v1/tgm/token-information': 'tgm-token-information',
  },
};

/** Wraps the REAL global `fetch` (never a second/hand-rolled transport — this is the SAME
 * `fetchImpl` seam `createNansenAdapter`'s own `endpointDeps`/budget-gate use) so every real HTTP
 * round trip this recording session makes is captured, in call order, as `{method, pathname,
 * status, creditsUsedHeader, body}` — `body` via `response.clone().json()` so the ORIGINAL
 * response (unconsumed) still reaches the adapter's own internal `response.json()` call
 * untouched. This is the ONLY place this script inspects a nansen response body directly — every
 * fixture file written below is this exact captured `body`, never a second, re-derived copy. */
function makeNansenCapturingFetch(observedCalls) {
  return async (url, opts) => {
    const response = await fetch(url, opts);
    const pathname = new URL(String(url)).pathname;
    let body;
    try {
      body = await response.clone().json();
    } catch {
      body = undefined;
    }
    observedCalls.push({
      method: opts?.method ?? 'GET',
      pathname,
      status: response.status,
      creditsUsedHeader: response.headers.get('x-nansen-credits-used'),
      body,
    });
    return response;
  };
}

/** Writes `test/fixtures/nansen/<fixtureName>.{json,evidence.md}` from one CAPTURED live call
 * (never the key, never request headers — D10/this task's own hard rule). `x_nansen_credits_used`
 * is compared against the SAME committed `NANSEN_COST_TABLE` `costOf()` prices against — a
 * mismatch is a vendor-drift SIGNAL (recorded here, never silently retrofit into the cost table;
 * task 005-7's own reviewer note), not a script failure. */
function writeNansenFixtureFiles({ fixturesDir, fixtureName, call, capability, args, costTable }) {
  const fixturePath = path.join(fixturesDir, `${fixtureName}.json`);
  const evidencePath = path.join(fixturesDir, `${fixtureName}.evidence.md`);
  const recordedAt = new Date().toISOString();
  writeFileSync(fixturePath, `${JSON.stringify(call.body, null, 2)}\n`);

  const methodPathKey = `${call.method} ${call.pathname}`;
  const priced = costTable[methodPathKey];
  const observedNum = call.creditsUsedHeader === null ? Number.NaN : Number(call.creditsUsedHeader);
  const sanity =
    priced === undefined
      ? 'UNKNOWN (endpoint absent from NANSEN_COST_TABLE)'
      : !Number.isFinite(observedNum)
        ? 'UNKNOWN (X-Nansen-Credits-Used header absent/unparseable)'
        : observedNum === priced.free
          ? 'MATCH'
          : `MISMATCH (observed ${observedNum} vs cost-table free=${priced.free}) — vendor-drift signal, see docs/KNOWN_ISSUES.md`;

  const responseFields =
    call.body && typeof call.body === 'object' && !Array.isArray(call.body)
      ? Object.keys(call.body).sort()
      : [];

  writeEvidence(evidencePath, [
    `# Fixture evidence: nansen/${fixtureName} — LIVE (task 005-7, R-44)`,
    '',
    '- provenance: live, recorded via `scripts/record-fixture.mjs` through `createNansenAdapter` ' +
      '(task 005-7) — replaces the earlier spec-derived provisional fixture (005-3/005-4).',
    `- recorded_at: ${recordedAt}`,
    `- endpoint: ${methodPathKey}`,
    `- http_status: ${call.status}`,
    `- capability: ${capability}`,
    `- args: ${JSON.stringify(args)}`,
    `- response_fields: ${responseFields.length ? responseFields.join(', ') : '(none)'}`,
    `- x_nansen_credits_used: ${call.creditsUsedHeader ?? '(absent)'}`,
    `- cost_table_expected_free: ${priced ? priced.free : '(unknown endpoint)'}`,
    `- sanity_check: ${sanity}`,
  ]);

  console.log(`record-fixture: OK: wrote ${fixturePath}`);
  console.log(`record-fixture: OK: wrote ${evidencePath}`);
}

/** Mirrors `cache/data-dir.ts`'s own `resolveDataDir()` fallback exactly (dev-script-local
 * duplication, deliberate — this script never imports production internals that aren't already
 * re-exported from the package's public `dist/index.js`) — used ONLY to place this SESSION's
 * idempotency sentinel (see `recordNansenAccount`'s own docstring), never for anything that
 * touches real adapter behavior. */
function nansenSessionDataDir() {
  const envDir = process.env.DATA_DIR;
  return envDir && envDir.length > 0 ? envDir : path.join(homedir(), '.onchain-intel');
}

/**
 * `nansen account` (0cr) — deliberately NOT a real `ProviderAdapter` capability (`costOf()`'s own
 * `endpointsFor()` has no `'account'` case, cost-of.ts), so `gate.ensureBudget('account', {})`
 * fail-closes with a `NansenBudgetExceededError` EVERY time — but only AFTER the real `GET
 * /api/v1/account` resync it triggers (`needsResync()` is true on this fresh process's cold
 * `accountState`) has already run as a side effect. That expected refusal is this function's own
 * success path: the real resync already happened, `observedCalls` already captured its body — this
 * is "recording through the full production factory", not a second hand-rolled probe, exactly as
 * task 005-7's own reviewer note requires.
 *
 * Idempotent-write-once, PER RECORDING SESSION (tracked via a sentinel file inside `DATA_DIR`
 * itself, NEVER via the committed fixture's own existence — an earlier task's already-committed
 * provisional/live fixture must not be mistaken for "already recorded in THIS session"): the
 * FIRST call in a given `DATA_DIR` writes `account.free.{json,evidence.md}` AND the sentinel;
 * every SUBSEQUENT call in the SAME `DATA_DIR` (e.g. the task's own "resync, после" step, run
 * with the identical command line) only OBSERVES/reports `plan`/`credits_remaining` for the
 * before/after spend computation, never re-writing the committed "before" baseline (task 005-7's
 * own budget table: "account (resync, после) | файл не перезаписывается").
 */
async function recordNansenAccount({ adapter, fixturesDir, observedCalls, costTable }) {
  const fixtureName = 'account.free';
  const sentinelPath = path.join(nansenSessionDataDir(), '.record-fixture-nansen-account-done');
  const alreadyRecorded = existsSync(sentinelPath);

  try {
    await adapter.fetch('account', {});
    fail(
      'nansen account: adapter.fetch("account", {}) unexpectedly resolved — expected a ' +
        'fail-closed budget-gate refusal AFTER the real resync (cost-of.ts has no "account" ' +
        "price entry by design); this script's own assumption about that contract no longer holds.",
    );
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isExpectedRefusal =
      error?.name === 'NansenBudgetExceededError' && message.includes('capability=account');
    if (!isExpectedRefusal) {
      fail(`nansen account: live resync failed: ${message}`);
      return;
    }
  }

  const call = observedCalls.find((c) => c.method === 'GET' && c.pathname === '/api/v1/account');
  if (!call) {
    fail('nansen account: no observed GET /api/v1/account call — the resync did not run.');
    return;
  }

  const plan = call.body && typeof call.body === 'object' ? call.body.plan : undefined;
  const creditsRemaining =
    call.body && typeof call.body === 'object' ? call.body.credits_remaining : undefined;
  console.log(
    `record-fixture: nansen account observed: plan=${JSON.stringify(plan)} ` +
      `credits_remaining=${JSON.stringify(creditsRemaining)} http_status=${call.status}`,
  );

  if (alreadyRecorded) {
    console.log(
      `record-fixture: nansen account: sentinel ${sentinelPath} already exists — NOT ` +
        're-writing account.free.{json,evidence.md} (this is a subsequent resync-only ' +
        "observation, see this function's own docstring).",
    );
    return;
  }

  writeNansenFixtureFiles({
    fixturesDir,
    fixtureName,
    call,
    capability: 'account',
    args: {},
    costTable,
  });
  writeFileSync(sentinelPath, `${new Date().toISOString()}\n`);
}

/** Top-level nansen dispatcher — `args` is `process.argv.slice(3)` (everything AFTER the literal
 * `nansen` adapterId token): `[capability, chain, queryOrTokenAddress]`. */
async function runNansenCommand(mod, args) {
  const [capability, chain, thirdArg] = args;
  const VALID_CAPABILITIES = ['account', 'entity.labels', 'smart-money.flows', 'token.risk'];
  if (!capability || !VALID_CAPABILITIES.includes(capability)) {
    fail(
      `nansen: unknown/missing capability "${capability ?? ''}" (expected one of ` +
        `${VALID_CAPABILITIES.join(', ')}) — the expensive profiler/address/labels|premium-labels ` +
        'endpoints are deliberately not reachable from this script (task 005-7 budget contract).',
    );
    return;
  }

  // `.env` is NOT auto-loaded by plain `node` — mirrors `packages/mcp-server/src/env.ts`'s own
  // `loadEnv()` (`process.loadEnvFile()`, stable Node >=20.12) so `NANSEN_API_KEY` reaches this
  // script the same way it reaches the real server. Unlike that function's own M0 default (a
  // missing `.env` is fine, no required secrets), a missing `.env`/key here is fatal — this
  // script's nansen path has exactly one purpose (recording paid live fixtures) and cannot proceed
  // without a real key.
  try {
    process.loadEnvFile();
  } catch (error) {
    if (!(error && error.code === 'ENOENT')) {
      fail(`could not load .env: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
  const apiKey = process.env.NANSEN_API_KEY;
  if (!apiKey) {
    fail('NANSEN_API_KEY not found in .env/process.env — cannot record live nansen fixtures.');
    return;
  }

  const fixturesDir = path.resolve(packageRoot, 'test', 'fixtures', 'nansen');
  mkdirSync(fixturesDir, { recursive: true });

  // Sourced from the SAME generated, committed module `costOf()`/`budget-gate.ts` themselves use
  // (`dist/adapters/nansen/cost-table.js`, tsc's per-file output) — never a hand-duplicated
  // literal in this script, which would silently drift against the real cost table.
  const { NANSEN_COST_TABLE: costTable } = await import(
    path.resolve(packageRoot, 'dist', 'adapters', 'nansen', 'cost-table.js')
  );

  const dailyCreditCapRaw = process.env.NANSEN_DAILY_CREDIT_CAP;
  const dailyCreditCap =
    dailyCreditCapRaw !== undefined && dailyCreditCapRaw.length > 0
      ? Number(dailyCreditCapRaw)
      : undefined;

  // Reads DATA_DIR from process.env itself (cache/data-dir.ts's own resolveDataDir()) — the SAME
  // single, persistent recording directory every command in this session MUST share (this file's
  // own header comment).
  const budgetStore = mod.createBudgetStore();
  const observedCalls = [];
  const adapter = mod.createNansenAdapter({
    env: process.env,
    budgetStore,
    ...(dailyCreditCap !== undefined && Number.isFinite(dailyCreditCap) ? { dailyCreditCap } : {}),
    fetchImpl: makeNansenCapturingFetch(observedCalls),
  });

  if (capability === 'account') {
    await recordNansenAccount({ adapter, fixturesDir, observedCalls, costTable });
    return;
  }

  if (!chain) {
    fail(`nansen ${capability}: requires <chain> [query|tokenAddress]`);
    return;
  }

  let capArgs;
  if (capability === 'entity.labels') {
    if (!thirdArg) {
      fail('nansen entity.labels requires <chain> <query>');
      return;
    }
    capArgs = { chain, query: thirdArg };
  } else {
    if (!thirdArg) {
      fail(`nansen ${capability} requires <chain> <tokenAddress>`);
      return;
    }
    capArgs = { chain, tokenAddress: thirdArg };
  }

  let result;
  try {
    result = await adapter.fetch(capability, capArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`nansen ${capability}: live call failed: ${message}`);
    return;
  }

  const fixtureMap = NANSEN_CAPABILITY_FIXTURES[capability];
  let allOk = true;
  for (const [methodPathKey, fixtureName] of Object.entries(fixtureMap)) {
    const [method, pathname] = methodPathKey.split(' ');
    const call = observedCalls.find((c) => c.method === method && c.pathname === pathname);
    if (!call) {
      fail(`nansen ${capability}: no observed HTTP call for ${methodPathKey}`);
      allOk = false;
      continue;
    }
    writeNansenFixtureFiles({
      fixturesDir,
      fixtureName,
      call,
      capability,
      args: capArgs,
      costTable,
    });
  }

  // TC-VERIFY-10 (M-6 exit criterion #1) — direct, non-fixture proof that a live
  // `smart-money.flows` response carries BOTH netflow AND holder labels. Reported, never
  // hard-failed here: a `false` here is this script's signal to consider the documented USDC
  // fallback BEFORE spending another 10cr, a judgment call for whoever is running this session,
  // not something this script should decide unattended.
  if (capability === 'smart-money.flows') {
    try {
      const normalized = adapter.normalize('smart-money.flows', result);
      const hasNetflow = ['netflow1hUsd', 'netflow24hUsd', 'netflow7dUsd', 'netflow30dUsd'].some(
        (key) => typeof normalized[key] === 'number',
      );
      const hasLabel = Array.isArray(normalized.topHolders)
        ? normalized.topHolders.some((holder) => typeof holder.addressLabel === 'string')
        : false;
      console.log(
        `record-fixture: TC-VERIFY-10 check — netflow fields present: ${hasNetflow}, ` +
          `>=1 topHolders[].addressLabel: ${hasLabel}`,
      );
      if (!hasNetflow || !hasLabel) {
        console.error(
          "record-fixture: WARNING: TC-VERIFY-10 not satisfied by this token's live response " +
            "(see the task's own USDC fallback note before re-spending).",
        );
      }
    } catch (error) {
      console.error(
        'record-fixture: WARNING: could not normalize smart-money.flows result for the ' +
          `TC-VERIFY-10 check: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (!allOk) process.exitCode = 1;
}

async function main() {
  if (!existsSync(distEntry)) {
    fail(
      `dist entry not found at ${distEntry} — run \`pnpm --filter @onchain-intel/core build\` first.`,
    );
    return;
  }

  const [adapterId, chain, third] = process.argv.slice(2);
  if (!adapterId || !chain) {
    fail(
      'usage: record-fixture.mjs <coingecko|dexscreener|defillama|rpc-evm|rpc-solana|platform-explorer> <chain> [address|protocolSlug]\n' +
        '       record-fixture.mjs nansen <account|entity.labels|smart-money.flows|token.risk> [chain] [query|tokenAddress]',
    );
    return;
  }

  const mod = await import(distEntry);

  if (adapterId === 'nansen') {
    // Capability-argumented, NOT chain-argumented (see this file's own header comment) — args
    // AFTER the literal 'nansen' token, so re-read from argv rather than reusing `chain`/`third`
    // above (which, for this adapter, hold different positions: `chain` is really the capability).
    await runNansenCommand(mod, process.argv.slice(3));
    return;
  }

  if (adapterId === 'platform-explorer') {
    // ONE invocation, FOUR distinct underlying live calls (see this file's own header comment).
    const observedRef = { value: undefined };
    const adapter = mod.createPlatformExplorerAdapter({
      fetchImpl: makeInstrumentedFetch(observedRef),
    });
    const calls = [
      { capability: 'platform.identities', fixtureName: 'state' },
      { capability: 'privacy.shielded_pool', fixtureName: 'shielded-statistic' },
      { capability: 'privacy.shielded_pool.history', fixtureName: 'shield-history' },
      { capability: 'platform.metrics.history', fixtureName: 'identities-history' },
    ];
    let allOk = true;
    for (const call of calls) {
      observedRef.value = undefined;
      // Sequential on purpose: each call must complete (and its own evidence be written) before
      // the next one starts; these are manual, one-off dev calls, not a hot path.
      const ok = await recordOneCall({
        adapterId,
        adapter,
        capability: call.capability,
        args: { chain },
        fixtureName: call.fixtureName,
        observedRef,
      });
      allOk = allOk && ok;
    }
    if (!allOk) process.exitCode = 1;
    return;
  }

  // Single-call adapters (coingecko/dexscreener/defillama/rpc-evm/rpc-solana): each invocation
  // performs exactly ONE live call, through an instrumented fetchImpl that records {url, status}
  // as a side effect of that SAME call.
  const observedRef = { value: undefined };
  const instrumentedFetchImpl = makeInstrumentedFetch(observedRef);

  let capability;
  let args;
  let adapter;
  let fixtureName;

  if (adapterId === 'coingecko') {
    if (!third) {
      fail('coingecko requires <chain> <address>');
      return;
    }
    capability = 'token.price';
    args = { chain, address: third };
    adapter = mod.createCoingeckoAdapter({ fetchImpl: instrumentedFetchImpl });
    fixtureName = chain;
  } else if (adapterId === 'dexscreener') {
    capability = 'pairs.new';
    args = { chain };
    adapter = mod.createDexscreenerAdapter({ fetchImpl: instrumentedFetchImpl });
    fixtureName = chain;
  } else if (adapterId === 'defillama') {
    if (!third) {
      fail('defillama requires <chain> <protocolSlug>');
      return;
    }
    capability = 'protocol.tvl';
    args = { chain, protocolSlug: third };
    adapter = mod.createDefillamaAdapter({ fetchImpl: instrumentedFetchImpl });
    fixtureName = third;
  } else if (adapterId === 'rpc-evm') {
    if (!third) {
      fail('rpc-evm requires <chain> <address>');
      return;
    }
    capability = 'wallet.balances.native';
    args = { chain, address: third };
    adapter = mod.createRpcEvmAdapter({ fetchImpl: instrumentedFetchImpl });
    fixtureName = chain;
  } else if (adapterId === 'rpc-solana') {
    if (!third) {
      fail('rpc-solana requires <chain> <address>');
      return;
    }
    capability = 'wallet.balances.native';
    args = { chain, address: third };
    adapter = mod.createRpcSolanaAdapter({ fetchImpl: instrumentedFetchImpl });
    fixtureName = chain;
  } else {
    fail(
      `unknown adapter: ${adapterId} (expected coingecko|dexscreener|defillama|rpc-evm|rpc-solana|platform-explorer|nansen)`,
    );
    return;
  }

  await recordOneCall({ adapterId, adapter, capability, args, fixtureName, observedRef });
}

await main();
