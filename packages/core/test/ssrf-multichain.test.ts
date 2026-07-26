import { describe, expect, it, vi } from 'vitest';
import {
  CapabilityRegistry,
  createRpcEvmAdapter,
  routes,
  loadChainRegistry,
} from '../src/index.js';
import type { ProviderAdapter } from '../src/adapters/types.js';
import { CapabilityNotCoveredOnChainError } from '../src/chain/errors.js';

/**
 * Task 006-8 (R-56) — the SSRF perimeter under a 458-chain registry. `chainid.network` publishes
 * RPC endpoints for 2660 chains; the entire point of this task is that NONE of them reach the
 * allowlist without a human commit.
 */
const CHAINS = loadChainRegistry();

function registryWith(fetchImpl: typeof fetch) {
  const adapters = new Map<string, ProviderAdapter>([
    ['rpc-evm', createRpcEvmAdapter({ fetchImpl })],
  ]);
  return new CapabilityRegistry([...routes], adapters);
}

const ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

describe('rpcHosts is a curated column, never derived (R-56a)', () => {
  it('every shipped rpcHosts entry is https', () => {
    for (const chain of CHAINS.list({ includeDeprecated: true })) {
      for (const host of chain.rpcHosts ?? []) {
        expect(host.startsWith('https://'), `${chain.slug}: ${host}`).toBe(true);
      }
    }
  });

  it('the overwhelming majority of chains carry NO rpcHosts — curation is opt-in, not opt-out', () => {
    const all = CHAINS.list();
    const curated = all.filter((c) => c.rpcHosts !== null);
    expect(curated.length).toBeGreaterThan(0);
    // If this ever inverts, someone wired the generator's candidate list straight into the column.
    expect(curated.length).toBeLessThan(all.length / 10);
  });
});

describe('a chain without a curated host is UNCOVERED, not broken (R-56b)', () => {
  it('refuses before any network attempt instead of timing out against an unapproved host', async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error('network attempt for a chain with no curated RPC host');
    }) as unknown as typeof fetch;

    const uncovered = CHAINS.list().find((c) => c.family === 'evm' && c.rpcHosts === null)!;
    expect(uncovered, 'the registry must still contain uncurated EVM chains').toBeDefined();

    await expect(
      registryWith(fetchImpl).resolve('wallet.balances.native', uncovered.slug, {
        chain: uncovered.slug,
        address: ADDRESS,
      }),
    ).rejects.toBeInstanceOf(CapabilityNotCoveredOnChainError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the allowlist is static and per-chain (R-56c)', () => {
  it('uses only THIS chain’s hosts — another chain’s endpoint is not reachable', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0' }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await registryWith(fetchImpl).resolve('wallet.balances.native', 'base', {
      chain: 'base',
      address: ADDRESS,
    });

    const baseHosts = CHAINS.resolve('base').rpcHosts!;
    const ethHosts = CHAINS.resolve('ethereum').rpcHosts!;
    expect(seen.length).toBeGreaterThan(0);
    for (const url of seen) {
      expect(
        baseHosts.some((host) => url.startsWith(host)),
        url,
      ).toBe(true);
      expect(
        ethHosts.some((host) => url.startsWith(host)),
        url,
      ).toBe(false);
    }
  });

  it('a host named in the VENDOR RESPONSE never becomes reachable', async () => {
    // The property, stated broadly: no data arriving over the network may widen the allowlist.
    // A redirect is the concrete vector — `safeFetch` re-checks every hop against the same
    // per-chain list, so the vendor cannot nominate its own successor.
    const attacker = 'https://attacker.example/rpc';
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(null, { status: 302, headers: { location: attacker } });
    }) as unknown as typeof fetch;

    await expect(
      registryWith(fetchImpl).resolve('wallet.balances.native', 'base', {
        chain: 'base',
        address: ADDRESS,
      }),
    ).rejects.toThrow();
    expect(seen.some((url) => url.includes('attacker.example'))).toBe(false);
  });
});

describe('what task 006-8 must NOT change', () => {
  it('ethereum keeps the exact hosts it had before TASK-006', () => {
    expect(CHAINS.resolve('ethereum').rpcHosts).toEqual([
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
    ]);
  });

  it('wallet.balances.native now covers more chains than before, but far from all', () => {
    const covered = registryWith(fetch as typeof fetch)
      .getCoverage()
      .chainsFor('wallet.balances.native');
    expect(covered.length).toBeGreaterThan(2);
    expect(covered.length).toBeLessThan(CHAINS.size() / 10);
    expect(covered.map((c) => c.slug)).toContain('base');
  });
});
