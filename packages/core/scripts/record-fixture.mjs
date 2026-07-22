// Manual dev script (R-22, task 003-4) — NOT part of CI (nothing in .github/workflows/ci.yml
// invokes it, and no test imports it: enforced by this task's own acceptance grep).
//
// Does exactly ONE real live HTTP call per invocation, through the adapter's own normal HTTP
// step (the same safeFetch-gated path `mcp-server` will use in production, via the SAME
// factory) — never a second, hand-rolled probe call. Writes the call's result as a committed
// fixture (`test/fixtures/<adapter>/<name>.json`) plus a human-readable evidence file
// (`<name>.evidence.md`: recorded_at, the exact endpoint touched, HTTP status, and the top-level
// field list actually observed) — vendor-drift discipline: recorded fact, never an assumption.
//
// Usage (no secrets required — all three adapters are keyless/free):
//   node packages/core/scripts/record-fixture.mjs coingecko <chain> <address>
//   node packages/core/scripts/record-fixture.mjs dexscreener <chain>
//   node packages/core/scripts/record-fixture.mjs defillama <chain> <protocolSlug>
//
// Requires a fresh build first (imports the compiled `dist/index.js` — mirrors
// `packages/mcp-server/scripts/smoke-dist.mjs`'s own dist-only precedent):
//   pnpm --filter @onchain-intel/core build

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
      'usage: record-fixture.mjs <coingecko|dexscreener|defillama> <chain> [address|protocolSlug]',
    );
    return;
  }

  const mod = await import(distEntry);

  // Captures the endpoint URL + HTTP status the adapter's own safeFetch step actually touched —
  // by wrapping the global HTTP client, not by making a second, separate call.
  let observed;
  const instrumentedFetchImpl = async (url, opts) => {
    const response = await fetch(url, opts);
    observed = { url: String(url), status: response.status };
    return response;
  };

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
  } else {
    fail(`unknown adapter: ${adapterId} (expected coingecko|dexscreener|defillama)`);
    return;
  }

  const fixturesDir = path.resolve(packageRoot, 'test', 'fixtures', adapterId);
  mkdirSync(fixturesDir, { recursive: true });
  const fixturePath = path.join(fixturesDir, `${fixtureName}.json`);
  const evidencePath = path.join(fixturesDir, `${fixtureName}.evidence.md`);
  const recordedAt = new Date().toISOString();

  try {
    const raw = await adapter.fetch(capability, args);
    writeFileSync(fixturePath, `${JSON.stringify(raw, null, 2)}\n`);

    // `raw` is this adapter's own {chain, [limit,] raw} envelope (see the adapter's own
    // .AGENTS.md/docstring) — report BOTH the envelope's own keys AND the nested vendor
    // response body's actual top-level fields (the latter is what's useful for vendor-drift
    // monitoring; the former would trivially always read "chain, raw").
    const fieldsOf = (value) =>
      value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
    const envelopeFields = fieldsOf(raw);
    const vendorBody = raw && typeof raw === 'object' ? raw.raw : undefined;
    const vendorFields = Array.isArray(vendorBody)
      ? [`(array of ${vendorBody.length} items — see item keys below)`, ...fieldsOf(vendorBody[0])]
      : fieldsOf(vendorBody);

    writeEvidence(evidencePath, [
      `# Fixture evidence: ${adapterId}/${fixtureName}`,
      '',
      `- recorded_at: ${recordedAt}`,
      `- endpoint: ${observed ? observed.url : '(not observed)'}`,
      `- http_status: ${observed ? observed.status : '(not observed)'}`,
      `- capability: ${capability}`,
      `- args: ${JSON.stringify(args)}`,
      `- envelope_fields: ${envelopeFields.length ? envelopeFields.join(', ') : '(none)'}`,
      `- vendor_response_fields: ${vendorFields.length ? vendorFields.join(', ') : '(none observed)'}`,
    ]);

    console.log(`record-fixture: OK: wrote ${fixturePath}`);
    console.log(`record-fixture: OK: wrote ${evidencePath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeEvidence(evidencePath, [
      `# Fixture evidence: ${adapterId}/${fixtureName} — LIVE CALL FAILED`,
      '',
      `- recorded_at: ${recordedAt}`,
      `- endpoint: ${observed ? observed.url : '(not observed)'}`,
      `- http_status: ${observed ? observed.status : '(not observed)'}`,
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
  }
}

await main();
