import { mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncChainRegistry } from '../scripts/sync-chain-registry.js';
import { loadChainRegistry } from '../src/chain/registry.js';

/**
 * Task 006-2 — generator tests (R-49). Everything runs `--offline` against the committed fixtures:
 * a generator test that depended on what a vendor served today would not be a test.
 */

const FIXTURES = 'test/fixtures/chain-registry';
let work: string;
let out: string;
let report: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'chain-registry-'));
  out = join(work, 'registry.data.json');
  report = join(work, 'report.md');
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function run(extra: string[] = [], now = 1_000): Promise<void> {
  await syncChainRegistry([
    '--offline',
    '--fixtures',
    FIXTURES,
    '--out',
    out,
    '--report',
    report,
    '--now',
    String(now),
    ...extra,
  ]);
}

function snapshot(): { syncedAt: number; chains: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(out, 'utf8')) as {
    syncedAt: number;
    chains: Array<Record<string, unknown>>;
  };
}

describe('sync-chain-registry — determinism (R-49c)', () => {
  // Test Case 1
  it('produces a byte-identical file when run twice over the same output', async () => {
    await run();
    const first = readFileSync(out, 'utf8');
    await run([], 999_999); // different --now on purpose
    expect(readFileSync(out, 'utf8')).toBe(first);
  });

  it('moves syncedAt only when the data actually changed', async () => {
    await run([], 1_000);
    expect(snapshot().syncedAt).toBe(1_000);

    await run([], 2_000); // same inputs → timestamp must NOT drift
    expect(snapshot().syncedAt).toBe(1_000);
  });

  it('sorts chains by caip2 regardless of catalog order', async () => {
    await run();
    const ids = snapshot().chains.map((c) => c['caip2'] as string);
    expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual(ids);
  });
});

describe('sync-chain-registry — failure handling (R-49e)', () => {
  // Test Case 2
  it('aborts without writing when a catalog is unavailable', async () => {
    const brokenDir = join(work, 'fixtures');
    mkdirSync(brokenDir, { recursive: true });
    cpSync(FIXTURES, brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, 'defillama-chains.json'), '[]', 'utf8');

    await run(); // seed a good snapshot first
    const good = readFileSync(out, 'utf8');

    await expect(
      syncChainRegistry(['--offline', '--fixtures', brokenDir, '--out', out, '--report', report]),
    ).rejects.toThrow(/empty or not an array/);

    // The pre-existing snapshot must survive untouched: a partially written registry would pass
    // load validation and silently shrink the known world.
    expect(readFileSync(out, 'utf8')).toBe(good);
  });
});

describe('sync-chain-registry — join quality (R-49b)', () => {
  // Test Case 3
  it('lists name-only (fuzzy) joins in their own report section', async () => {
    await run();
    const text = readFileSync(report, 'utf8');
    expect(text).toContain('FUZZY name-joined');
    expect(text).toContain('nameless-fuzzy-chain');
    expect(text).toContain('matched by NAME only');
  });

  it('joins on the explicit gecko_id key without flagging it as fuzzy', async () => {
    await run();
    const text = readFileSync(report, 'utf8');
    const fuzzySection = text.slice(text.indexOf('## FUZZY'), text.indexOf('## Slug conflicts'));
    expect(fuzzySection).not.toContain('berachain');
    expect(fuzzySection).not.toContain('ethereum');
  });

  it('derives caip2 from the EVM chain id and falls back for non-EVM chains', async () => {
    await run();
    const bySlug = new Map(snapshot().chains.map((c) => [c['slug'] as string, c]));
    expect(bySlug.get('ethereum')?.['caip2']).toBe('eip155:1');
    expect(bySlug.get('berachain')?.['caip2']).toBe('eip155:80094');
    expect(bySlug.get('ethereum')?.['family']).toBe('evm');
    expect(bySlug.get('solana')?.['family']).toBe('svm');
    expect(String(bySlug.get('solana')?.['caip2'])).toMatch(/^solana:/);
  });
});

describe('sync-chain-registry — deprecation instead of deletion (R-49f)', () => {
  // Test Case 5
  it('keeps a vanished chain and flags it deprecated', async () => {
    await run();
    expect(snapshot().chains.some((c) => c['slug'] === 'berachain')).toBe(true);

    const shrunk = join(work, 'fixtures-shrunk');
    mkdirSync(shrunk, { recursive: true });
    cpSync(FIXTURES, shrunk, { recursive: true });
    const dl = JSON.parse(readFileSync(join(shrunk, 'defillama-chains.json'), 'utf8')) as Array<{
      name: string;
    }>;
    writeFileSync(
      join(shrunk, 'defillama-chains.json'),
      JSON.stringify(dl.filter((c) => c.name !== 'Berachain')),
      'utf8',
    );

    await syncChainRegistry([
      '--offline',
      '--fixtures',
      shrunk,
      '--out',
      out,
      '--report',
      report,
      '--now',
      '5000',
    ]);

    const bera = snapshot().chains.find((c) => c['slug'] === 'berachain');
    expect(bera, 'the row must be kept, not deleted').toBeDefined();
    expect(bera?.['deprecated']).toBe(true);
    expect(readFileSync(report, 'utf8')).toContain('Deprecated');
  });
});

describe('sync-chain-registry — curated columns are never invented (R-56a)', () => {
  // Test Case 7
  it('leaves rpcHosts null and only PROPOSES candidates in the report', async () => {
    await run();
    for (const chain of snapshot().chains) expect(chain['rpcHosts']).toBeNull();

    const text = readFileSync(report, 'utf8');
    expect(text).toContain('RPC candidates');
    expect(text).toContain('https://rpc.berachain.com');
  });

  it('never proposes a non-https endpoint (it could not be admitted anyway)', async () => {
    await run();
    const candidates = readFileSync(report, 'utf8');
    expect(candidates).not.toContain('http://insecure.example');
  });

  it('carries curated columns forward instead of erasing them on the next sync', async () => {
    await run();
    const doc = snapshot();
    const eth = doc.chains.find((c) => c['slug'] === 'ethereum')!;
    eth['rpcHosts'] = ['https://curated.example'];
    (eth['vendors'] as Record<string, unknown>)['nansen'] = 'ethereum';
    writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

    await run([], 7_000);

    const after = snapshot().chains.find((c) => c['slug'] === 'ethereum')!;
    expect(after['rpcHosts']).toEqual(['https://curated.example']);
    expect((after['vendors'] as Record<string, unknown>)['nansen']).toBe('ethereum');
  });
});

describe('sync-chain-registry — output is loadable (R-48 contract)', () => {
  // Test Case 6
  it('produces a snapshot the runtime loader accepts', async () => {
    await run();
    const data = JSON.parse(readFileSync(out, 'utf8')) as unknown;
    const registry = loadChainRegistry({ data });

    expect(registry.size()).toBeGreaterThanOrEqual(4);
    expect(registry.resolve('ethereum').caip2).toBe('eip155:1');
    expect(registry.resolve('berachain').caip2).toBe('eip155:80094');
    // alias derived from the coingecko id / gecko_id must resolve too
    expect(registry.resolve('berachain-bera').caip2).toBe('eip155:80094');
  });

  it('emits no alias that would make the loader fail', async () => {
    await run();
    const data = JSON.parse(readFileSync(out, 'utf8')) as unknown;
    expect(() => loadChainRegistry({ data })).not.toThrow();
  });
});

/**
 * Regression cover for the join defects found while generating the first production snapshot
 * (task 006-2). Both were silent data corruption, not crashes — which is exactly why they get
 * their own fixtures.
 */
describe('sync-chain-registry — join correctness (regressions)', () => {
  const AMBIG = 'test/fixtures/chain-registry-ambiguous';

  async function runAmbiguous(): Promise<void> {
    await syncChainRegistry([
      '--offline',
      '--fixtures',
      AMBIG,
      '--out',
      out,
      '--report',
      report,
      '--now',
      '1000',
    ]);
  }

  it('prefers the EIP-155 chain id over a shared native_coin_id', async () => {
    // `native_coin_id: "ethereum"` is shared by every L2 that pays gas in ETH — 49 CoinGecko
    // platforms in the live catalog. Taking the first hit mapped Ethereum→alienx, BSC→opbnb and
    // Solana→sonic-svm, sending token lookups to a different chain's platform.
    await runAmbiguous();
    const eth = snapshot().chains.find((c) => c['slug'] === 'ethereum')!;
    expect((eth['vendors'] as Record<string, unknown>)['coingecko']).toBe('ethereum');
    expect((eth['vendors'] as Record<string, unknown>)['coingecko']).not.toBe('wrong-l2');
  });

  it('leaves vendors.coingecko null when a shared native_coin_id cannot be disambiguated', async () => {
    await runAmbiguous();
    const shared = snapshot().chains.find((c) => c['slug'] === 'shared-one')!;
    expect((shared['vendors'] as Record<string, unknown>)['coingecko']).toBeNull();
    expect(readFileSync(report, 'utf8')).toContain('shared by 2 platforms');
  });

  it('rejects a match whose chain_identifier contradicts DeFiLlama', async () => {
    await runAmbiguous();
    const mismatch = snapshot().chains.find((c) => c['slug'] === 'mismatch-chain')!;
    expect((mismatch['vendors'] as Record<string, unknown>)['coingecko']).toBeNull();
    expect(readFileSync(report, 'utf8')).toMatch(/chain_identifier 4061 ≠ 5551/);
  });

  it('never lets an alias claim a slug belonging to a chain processed later', async () => {
    // 'Alpha' is processed first and its CoinGecko id is literally 'beta', which is the SLUG of a
    // chain that appears afterwards. A single-pass, order-dependent check emitted that alias and
    // produced a snapshot the loader rejects outright.
    await runAmbiguous();
    const alpha = snapshot().chains.find((c) => c['slug'] === 'alpha')!;
    expect(alpha['aliases']).not.toContain('beta');
    expect(readFileSync(report, 'utf8')).toContain("alias 'beta' is the slug of");
  });

  it('refuses to write anything the runtime loader would reject', async () => {
    await runAmbiguous();
    // The generator validates with the SAME validator the runtime uses, so a written file is
    // loadable by construction.
    expect(() =>
      loadChainRegistry({ data: JSON.parse(readFileSync(out, 'utf8')) as unknown }),
    ).not.toThrow();
  });
});
