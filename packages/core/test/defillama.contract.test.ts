import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CapabilityNotCoveredOnChainError } from '../src/chain/errors.js';
import { createDefillamaAdapter, loadChainRegistry } from '../src/index.js';

// Golden fixture-based normalization tests (R-7, D11) — no network: fixtures were recorded ONCE
// via the manual fixture-recording dev script under packages/core/scripts/ (out of CI, R-22) and
// are committed under test/fixtures/defillama/. `normalize()` is exercised directly against
// them; `fetch()` is only exercised here with an injected fake `fetchImpl` (no real HTTP), never
// the real network.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = 1_700_000_000_000;

const CHAINS = loadChainRegistry();

/** One `/protocols` row, in the shape the tests below read it. Every value is real — see
 * `fixtures/defillama/protocols-catalog.evidence.md`. */
interface CatalogRow {
  slug: string;
  name?: string;
  tvl: number | null;
  chains?: string[];
  chainTvls?: Record<string, number>;
  parentProtocolSlug?: string;
  tokensExcludedFromParent?: Record<string, string[]>;
}

const CATALOG: CatalogRow[] = JSON.parse(
  readFileSync(path.join(testDir, 'fixtures', 'defillama', 'protocols-catalog.json'), 'utf8'),
) as CatalogRow[];

const catalogRow = (slug: string): CatalogRow => {
  const row = CATALOG.find((r) => r.slug === slug);
  if (!row) throw new Error(`fixture has no row for ${slug}`);
  return row;
};

/** The private fetch-result shape `normalize()` consumes, assembled the way `fetch()` assembles it:
 * the untouched catalog as `raw`, plus the slug the caller asked for. */
const fetchResultFor = (chain: string, slug: string, raw: unknown = CATALOG): unknown => ({
  chain: CHAINS.resolve(chain),
  raw,
  fetchedAt: FIXED_NOW,
  protocol: { slug },
});

describe('defillama adapter (contract, R-7)', () => {
  const adapter = createDefillamaAdapter({ now: () => FIXED_NOW });

  /**
   * `protocol.tvl` reads the shared `/protocols` catalog since L-7 — the per-protocol document it
   * used to fetch is 27.57 MiB for `aave-v3` against a 10 MiB cap, and grows daily. The expectations
   * below are computed FROM the fixture row rather than transcribed, with one exception each side:
   * where a live vendor answer was recorded for the same slug (evidence file), the literal is
   * asserted too, so a fixture edited to match a changed normalizer still fails.
   */
  describe('protocol.tvl out of the shared catalog (L-7)', () => {
    it('a direct row answers with its own figures and no aggregation', () => {
      const row = catalogRow('lido');

      const result = adapter.normalize('protocol.tvl', fetchResultFor('ethereum', 'lido'));

      expect(result).toMatchObject({
        protocol: 'Lido',
        chain: 'ethereum',
        tvlUsd: row.chainTvls!['Ethereum'],
        totalTvlUsd: row.tvl,
        deployed: true,
        aggregatedFrom: [],
        source: 'defillama',
        fetchedAt: FIXED_NOW,
      });
      // The live `/protocol/lido` document answered these exact numbers on the recording day
      // (evidence file): the catalog is not an approximation of the route it replaced.
      expect(result).toMatchObject({
        tvlUsd: 17_756_637_169.095158,
        totalTvlUsd: 17_760_598_548.192703,
      });
    });

    it('a parent with no row of its own sums its children and SAYS it did', () => {
      const children = CATALOG.filter((r) => r.parentProtocolSlug === 'raydium');
      expect(children.length).toBeGreaterThan(1);

      const result = adapter.normalize('protocol.tvl', fetchResultFor('solana', 'raydium'));

      expect(result).toMatchObject({
        // No display name exists for a parent in this document, so the caller's own slug is used
        // rather than one guessed from the children's names.
        protocol: 'raydium',
        chain: 'solana',
        deployed: true,
        aggregatedFrom: children.map((r) => r.slug),
      });
      // The vendor's own `/protocol/raydium` answered 841 761 617.263464 — to the cent (evidence
      // file). A single-chain protocol is where a summing error has nowhere to hide.
      expect(result).toMatchObject({ tvlUsd: 841_761_617.263464, totalTvlUsd: 841_761_617.263464 });
    });

    it('a slug that is BOTH a row and a parent resolves to the row, as the vendor does', () => {
      // `/protocol/beanstalk` answers 0 — the row — not the 3.2M its parent's children total.
      const result = adapter.normalize('protocol.tvl', fetchResultFor('ethereum', 'beanstalk'));

      expect(result).toMatchObject({ protocol: 'Beanstalk', totalTvlUsd: 0, aggregatedFrom: [] });
    });

    it('a chain the protocol is not on is an ANSWER, not a failure (L-9)', () => {
      const result = adapter.normalize('protocol.tvl', fetchResultFor('bitcoin', 'aave-v3'));

      // The defect this replaces: `capability unavailable: protocol.tvl on bitcoin` — a fact about
      // the world rendered as a fault in the engine, indistinguishable from a provider outage.
      expect(result).toMatchObject({ chain: 'bitcoin', deployed: false, tvlUsd: 0 });
      expect((result as { totalTvlUsd: number }).totalTvlUsd).toBeGreaterThan(0);
    });

    it('deployed with no plain-TVL bucket is null, never zero', () => {
      const row = catalogRow('ether.fi-stake');
      // The vendor lists Base as a deployment and publishes only `Base-staking` for it.
      expect(row.chains).toContain('Base');
      expect(row.chainTvls!['Base']).toBeUndefined();

      const result = adapter.normalize('protocol.tvl', fetchResultFor('base', 'ether.fi-stake'));

      // Zero here would claim a measurement nobody made; `deployed` carries the other half.
      expect(result).toMatchObject({ chain: 'base', deployed: true, tvlUsd: null });
    });

    it('reports the whole deployment set in our slugs, TVL-descending, counting what it cannot name', () => {
      const result = adapter.normalize('protocol.tvl', fetchResultFor('ethereum', 'aave-v3')) as {
        deployments: { chain: string; tvlUsd: number | null }[];
        unmappedDeployments: number;
      };

      // The point of the field: "where is this protocol" stops being a chain-by-chain sweep whose
      // misses are indistinguishable from failures (L-9).
      expect(result.deployments.map((d) => d.chain)).toContain('base');
      expect(result.deployments.map((d) => d.chain)).not.toContain('bitcoin');
      // Vendor display names only — never a raw echo. Every emitted chain resolves in OUR registry.
      for (const d of result.deployments) expect(CHAINS.tryResolve(d.chain)?.slug).toBe(d.chain);
      const values = result.deployments.map((d) => d.tvlUsd ?? -1);
      expect([...values].sort((a, b) => b - a)).toEqual(values);
      expect(result.unmappedDeployments).toBeGreaterThanOrEqual(0);
    });

    /**
     * The regression for the two-vocabulary defect, and it is stated as a REGRESSION on purpose:
     * every one of the 1298 tests stayed green while `protocol.tvl` answered `deployed: false,
     * tvlUsd: 0` for 43 of 458 chains, because nothing asserted a chain whose name differs between
     * the two vendor listings. `/protocols` says `Binance`/`Optimism`/`xDai`; `vendors.defillama`
     * (from `/v2/chains`) says `BSC`/`OP Mainnet`/`Gnosis`. Delete `chain-aliases.ts` from the
     * adapter and these three cases fail; nothing else in the suite does.
     */
    it.each([
      ['bsc', 'Binance'],
      ['op-mainnet', 'Optimism'],
      ['gnosis', 'xDai'],
    ])(
      'resolves %s, which the catalog names %s, as deployed with a real figure',
      (slug, legacy) => {
        const row = catalogRow('aave-v3');
        // The premise, asserted rather than assumed: the fixture really does use the legacy name, and
        // really does not use the one our registry carries.
        expect(row.chains).toContain(legacy);
        expect(CHAINS.resolve(slug).vendors['defillama']).not.toBe(legacy);

        const result = adapter.normalize('protocol.tvl', fetchResultFor(slug, 'aave-v3')) as {
          deployed: boolean;
          tvlUsd: number | null;
        };

        expect(result.deployed).toBe(true);
        expect(result.tvlUsd).toBe(row.chainTvls![legacy]);
        expect(result.tvlUsd).toBeGreaterThan(0);
      },
    );

    it('accounts for the WHOLE protocol total across chains when none is unnameable', () => {
      // Catches both halves of what went wrong in this area: a DROPPED chain (the vocabulary defect,
      // which pushed the ratio under 100 %) and a DOUBLE-COUNTED one (the accumulator bug found
      // during wave 2, which pushed it to exactly 200 %). Conditioned on `unmappedDeployments === 0`,
      // so it is an exact invariant rather than an approximate one.
      const result = adapter.normalize('protocol.tvl', fetchResultFor('ethereum', 'aave-v3')) as {
        deployments: { tvlUsd: number | null }[];
        unmappedDeployments: number;
        totalTvlUsd: number;
      };

      expect(result.unmappedDeployments).toBe(0);
      const summed = result.deployments.reduce((acc, d) => acc + (d.tvlUsd ?? 0), 0);
      expect(summed / result.totalTvlUsd).toBeCloseTo(1, 2);
    });

    it('refuses a slug the catalog does not carry, rather than inventing a zero', () => {
      expect(() =>
        adapter.normalize('protocol.tvl', fetchResultFor('ethereum', 'no-such')),
      ).toThrow(/unknown protocol slug "no-such"/);
    });

    it('refuses a row that publishes no TVL at all', () => {
      expect(catalogRow('fantom').tvl).toBeNull();

      expect(() => adapter.normalize('protocol.tvl', fetchResultFor('ethereum', 'fantom'))).toThrow(
        /publishes no TVL total/,
      );
    });

    it('refuses a catalog that is not an array', () => {
      expect(() =>
        adapter.normalize('protocol.tvl', fetchResultFor('ethereum', 'lido', { protocols: [] })),
      ).toThrow(/did not return an array/);
    });
  });

  // CHANGED EXPECTATION (task 006-5, R-54): `capabilities()` no longer carries a `chains` literal.
  // The chain dimension is the coverage matrix's job (§4.2.3) — a second list here could only
  // drift from it. What the adapter answers about chains now goes through `chainSupport()`.
  // CHANGED EXPECTATION (TASK-007 task 007-1, R-61): a third capability on the same adapter.
  it('capabilities() declares all three capabilities without a hardcoded chain list', () => {
    const caps = adapter.capabilities();
    expect(caps.map((c) => c.id)).toEqual(['protocol.tvl', 'chain.tvl', 'dex.volume.history']);
    for (const cap of caps) expect(cap.chains).toBeUndefined();
  });

  // TASK-006 task 006-7 (R-53): chain TVL is a SEPARATE capability — different endpoint, different
  // contract. A chain has no `totalTvlUsd`, so folding it into `protocol.tvl` would need a
  // parameter that changes the meaning of the other fields.
  describe('chain.tvl (task 006-7)', () => {
    const CHAINS_FIXTURE = [
      { gecko_id: 'ethereum', tvl: 6.0e10, tokenSymbol: 'ETH', name: 'Ethereum', chainId: 1 },
      {
        gecko_id: 'berachain-bera',
        tvl: 50_579_539.42,
        tokenSymbol: 'BERA',
        name: 'Berachain',
        chainId: 80094,
      },
    ];

    it('normalizes the /v2/chains row for the requested chain', () => {
      const result = adapter.normalize('chain.tvl', {
        chain: CHAINS.resolve('berachain'),
        raw: CHAINS_FIXTURE,
      });
      expect(result).toEqual({
        chain: 'berachain',
        name: CHAINS.resolve('berachain').name,
        tvlUsd: 50_579_539.42,
        source: 'defillama',
        fetchedAt: FIXED_NOW,
      });
    });

    // CHANGED EXPECTATION (vdd-multi cycle 6, L-9): still loud, but with the PERMANENT error
    // class. The registry is deliberately stale (it is a build artifact), so a row the vendor no
    // longer lists is a normal consequence of that design — not an outage. Reported as
    // `CapabilityUnavailableError` it told the agent to retry a call that fails identically until
    // the next sync, and negative-cached that verdict on the way.
    it('reports a chain the vendor no longer lists as PERMANENTLY uncovered, not retryable', () => {
      expect(() =>
        adapter.normalize('chain.tvl', { chain: CHAINS.resolve('ethereum'), raw: [] }),
      ).toThrow(CapabilityNotCoveredOnChainError);
      expect(() =>
        adapter.normalize('chain.tvl', { chain: CHAINS.resolve('ethereum'), raw: [] }),
      ).toThrow(/no longer lists/);
    });

    it.each([[-1], [Number.NaN], [Number.POSITIVE_INFINITY], ['nope']])(
      'rejects a bad tvl value (%s) BEFORE it can be cached',
      (bad) => {
        expect(() =>
          adapter.normalize('chain.tvl', {
            chain: CHAINS.resolve('ethereum'),
            raw: [{ name: 'Ethereum', tvl: bad }],
          }),
        ).toThrow(/invalid tvl/);
      },
    );

    it('fetch() hits /v2/chains, not the protocol endpoint', async () => {
      const calls: string[] = [];
      const testAdapter = createDefillamaAdapter({
        now: () => FIXED_NOW,
        fetchImpl: async (url) => {
          calls.push(String(url));
          return new Response(JSON.stringify(CHAINS_FIXTURE), { status: 200 });
        },
      });
      const result = await testAdapter.fetch('chain.tvl', { chain: 'berachain' });
      expect(calls).toEqual(['https://api.llama.fi/v2/chains']);
      // `fetchedAt` rides along from the shared catalog memo (vdd-multi cycle 6, M-1) so
      // `normalize()` reports the DATA's age rather than its own — see the adapter for why two
      // TTL windows in series do not compose into one.
      expect(result).toEqual({
        chain: CHAINS.resolve('berachain'),
        raw: CHAINS_FIXTURE,
        fetchedAt: FIXED_NOW,
      });
    });
  });

  it('chainSupport() follows the registry rather than a private map (R-54)', () => {
    expect(adapter.chainSupport?.(CHAINS.resolve('ethereum'), 'protocol.tvl')).toBe(true);
    expect(adapter.chainSupport?.(CHAINS.resolve('solana'), 'protocol.tvl')).toBe(true);
    // A chain DeFiLlama does cover, that the pre-TASK-006 map could never have served:
    expect(adapter.chainSupport?.(CHAINS.resolve('berachain'), 'protocol.tvl')).toBe(true);
    // A chain the registry knows but DeFiLlama does not name:
    const uncovered = CHAINS.list().find((c) => c.vendors['defillama'] == null);
    if (uncovered) expect(adapter.chainSupport?.(uncovered, 'protocol.tvl')).toBe(false);
  });

  it('costOf() is free (0 credits) and isAvailable() is always ok (keyless)', () => {
    expect(adapter.costOf('protocol.tvl', {})).toEqual({ credits: 0 });
    expect(adapter.costOf('dex.volume.history', {})).toEqual({ credits: 0 });
    expect(adapter.isAvailable?.()).toEqual({ ok: true });
  });

  // TASK-007 task 007-1 (R-61) — the capability is declared and routed. Two CHANGED EXPECTATIONS
  // since: task 007-2 (R-63) replaced the flat `false` with the real vendor list, and tasks
  // 007-4/007-5 replaced the `NotImplemented` throws with the transport and normalizer. What
  // belongs HERE is only the adapter-level surface; coverage lives in
  // `defillama-dex-coverage.test.ts` and behaviour in `defillama-dex-volume.test.ts`.
  describe('dex.volume.history — adapter surface (task 007-1)', () => {
    it('chainSupport() is capability-aware, not one answer for the whole adapter', () => {
      const ethereum = CHAINS.resolve('ethereum');
      expect(adapter.chainSupport?.(ethereum, 'chain.tvl')).toBe(true);
      expect(adapter.chainSupport?.(ethereum, 'dex.volume.history')).toBe(true);
      // A chain the vendor names for TVL but not for DEX volume answers differently per capability.
      const tvlOnly = CHAINS.list().find(
        (c) =>
          adapter.chainSupport?.(c, 'chain.tvl') === true &&
          adapter.chainSupport?.(c, 'dex.volume.history') === false,
      );
      expect(tvlOnly, 'the registry must contain at least one TVL-only chain').toBeDefined();
    });

    it('normalize() refuses a fetch result that carries no validated args', () => {
      // Reachable only by calling the adapter out of band — `fetch()` always attaches them. Loud
      // rather than silent, because the alternative is normalizing against an invented window.
      expect(() => adapter.normalize('dex.volume.history', {})).toThrow(/no validated args/);
    });
  });

  describe('fetch() — one shared catalog, and the one route that still fetches per call', () => {
    /** An adapter whose transport records every URL and answers the catalog fixture. */
    const recordingAdapter = (
      docFor: (url: string) => unknown = () => CATALOG,
    ): { adapter: ReturnType<typeof createDefillamaAdapter>; calls: string[] } => {
      const calls: string[] = [];
      const fetchImpl: typeof fetch = async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify(docFor(String(url))), { status: 200 });
      };
      return { adapter: createDefillamaAdapter({ fetchImpl, now: () => FIXED_NOW }), calls };
    };

    it('hits the catalog, not the per-protocol document (no real network)', async () => {
      const { adapter: testAdapter, calls } = recordingAdapter();

      const result = await testAdapter.fetch('protocol.tvl', {
        chain: 'ethereum',
        protocolSlug: 'lido',
      });

      expect(calls).toEqual(['https://api.llama.fi/protocols']);
      expect(result).toMatchObject({
        chain: CHAINS.resolve('ethereum'),
        fetchedAt: FIXED_NOW,
        protocol: { slug: 'lido' },
      });
    });

    it('serves a second slug inside the TTL window with no further transfer', async () => {
      const { adapter: testAdapter, calls } = recordingAdapter();

      await testAdapter.fetch('protocol.tvl', { chain: 'ethereum', protocolSlug: 'lido' });
      await testAdapter.fetch('protocol.tvl', { chain: 'solana', protocolSlug: 'raydium' });

      // The whole point of the move: the old route paid a multi-megabyte download PER CALL.
      expect(calls).toEqual(['https://api.llama.fi/protocols']);
    });

    it('asks the vendor for its own aggregate when summing would double-count', async () => {
      // `ether.fi`'s children declare `tokensExcludedFromParent`; summing them overstates the
      // vendor's own total by 9.5 % (evidence file), so this parent is answered by the vendor.
      const vendorDoc = { name: 'ether.fi', tvl: [{ date: 1, totalLiquidityUSD: 3_491_186_951 }] };
      const { adapter: testAdapter, calls } = recordingAdapter((url) =>
        url.endsWith('/protocols') ? CATALOG : vendorDoc,
      );

      const raw = await testAdapter.fetch('protocol.tvl', {
        chain: 'ethereum',
        protocolSlug: 'ether.fi',
      });
      const result = testAdapter.normalize('protocol.tvl', raw);

      expect(calls).toEqual([
        'https://api.llama.fi/protocols',
        'https://api.llama.fi/protocol/ether.fi',
      ]);
      // The vendor's number, not our sum — and the deployment set still comes from the catalog,
      // because a parent's own document answers `chains: []`.
      expect(result).toMatchObject({ protocol: 'ether.fi', totalTvlUsd: 3_491_186_951 });
      expect((result as { deployments: unknown[] }).deployments.length).toBeGreaterThan(0);
    });

    it('refuses an unknown slug from the catalog, before spending a request on it', async () => {
      const { adapter: testAdapter, calls } = recordingAdapter();

      await expect(
        testAdapter.fetch('protocol.tvl', { chain: 'ethereum', protocolSlug: 'no-such' }),
      ).rejects.toThrow(/unknown protocol slug "no-such"/);
      expect(calls).toEqual(['https://api.llama.fi/protocols']);
    });
  });

  describe('tvl value validation (adversarial cycle 2, finding 1b)', () => {
    /** The catalog with one row's numbers corrupted — `structuredClone` so the shared fixture is
     * never mutated for the tests that run after. */
    const corruptedCatalog = (slug: string, mutate: (row: CatalogRow) => void): CatalogRow[] => {
      const copy = structuredClone(CATALOG);
      const row = copy.find((r) => r.slug === slug);
      if (!row) throw new Error(`fixture has no row for ${slug}`);
      mutate(row);
      return copy;
    };

    it('throws a clear error when the chain-scoped value is negative', () => {
      const raw = corruptedCatalog('lido', (row) => {
        row.chainTvls!['Ethereum'] = -1;
      });

      expect(() =>
        adapter.normalize('protocol.tvl', fetchResultFor('ethereum', 'lido', raw)),
      ).toThrow(/invalid tvl value\(s\)/);
    });

    it('throws a clear error when the protocol-wide total is negative', () => {
      const raw = corruptedCatalog('lido', (row) => {
        row.tvl = -1;
      });

      expect(() =>
        adapter.normalize('protocol.tvl', fetchResultFor('ethereum', 'lido', raw)),
      ).toThrow(/invalid tvl value\(s\)/);
    });

    it('throws when a value on ANOTHER chain is garbage — new surface, same rule', () => {
      // `deployments` publishes every chain, so a bad number no caller asked for still reaches one.
      const raw = corruptedCatalog('lido', (row) => {
        row.chainTvls!['Solana'] = Number.NEGATIVE_INFINITY;
      });

      expect(() =>
        adapter.normalize('protocol.tvl', fetchResultFor('ethereum', 'lido', raw)),
      ).toThrow(/invalid tvl value\(s\)/);
    });
  });
});
