import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDexscreenerAdapter, loadChainRegistry } from '@onchain-intel/core';
import { TokenPoolsInputSchema, tokenPoolsToolSpec } from '../src/tools/token-pools.js';

/**
 * `onchain_token_pools` — the logic, task 014-32d.
 *
 * **Driven at the ADAPTER, not through the registry.** The behaviour this task ships is the two
 * vendor routes and the normalizer over them; the handler's own share is argument shaping and the
 * routing anchor, and `tool-registration-stub.test.ts` already drives that. Going through a real
 * `CapabilityRegistry` here would add a cache, a limiter and a deadline to every case without
 * changing what any of them assert.
 *
 * **Fixtures are RECORDED, and the evidence beside them says what each one is for**
 * (`packages/core/test/fixtures/dexscreener/token-routes.evidence.md`). R-21 forbids network in CI,
 * so these are the vendor's real bytes from 2026-08-21 and not hand-written shapes — a hand-written
 * fixture would have agreed with whatever the normalizer happened to do.
 */

/** The committed `tools/list` capture — the published contract as a client receives it. */
const snapshot = JSON.parse(
  readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/tools-list.snapshot.json'),
    'utf8',
  ),
) as { name: string; inputSchema: { properties?: Record<string, unknown> } }[];

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../core/test/fixtures/dexscreener',
);
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

/** 30 rows, bare ARRAY, every row `chainId: "ethereum"` — the per-chain route at its cap. */
const PER_CHAIN_FULL = fixture('token-pairs-ethereum-weth') as unknown[];
/** 30 rows, `{pairs: [...]}`, 29 of them `pulsechain` — the fork case. */
const CROSS_CHAIN = fixture('token-pairs-crosschain-usdc');
/** 6 rows, well under the cap — nothing to truncate. */
const SHORT_PAGE = fixture('token-pairs-berachain-osbgt') as unknown[];

const chains = loadChainRegistry();
const adapter = createDexscreenerAdapter();

interface Page {
  pools: { chain: string; pairAddress: string; dexId: string }[];
  truncated: { pairs: boolean; reason: string };
}

/** Normalizes a recorded body as if the fetch step had just returned it. */
function normalize(
  raw: unknown,
  options: { chain: string | null; limit?: number; token?: string },
): Page {
  return adapter.normalize('token.pools', {
    kind: 'token-pools',
    chain: options.chain === null ? null : chains.resolve(options.chain),
    token: options.token ?? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    limit: options.limit ?? 50,
    raw,
  }) as Page;
}

describe('TC-E2E-01 — a token and a chain answer with that chain’s pools, across DEXes', () => {
  it('returns pools of more than one DEX, each with a pool address', () => {
    const page = normalize(PER_CHAIN_FULL, { chain: 'ethereum' });

    expect(page.pools.length).toBeGreaterThan(1);
    expect(new Set(page.pools.map((p) => p.dexId)).size).toBeGreaterThan(1);
    for (const pool of page.pools) {
      expect(pool.pairAddress, 'a pool with no address is not identifiable').toBeTruthy();
      expect(pool.chain).toBe('ethereum');
    }
  });

  it('reads the BARE ARRAY shape this route answers with', () => {
    // The per-chain route returns an array and the cross-chain route returns `{pairs: [...]}`.
    // Handling only the second would render this route's answer as "this token trades nowhere" —
    // an empty page that a caller cannot tell from a real one (class L-10).
    expect(Array.isArray(PER_CHAIN_FULL), 'the recorded fixture is not an array any more').toBe(
      true,
    );
    expect(normalize(PER_CHAIN_FULL, { chain: 'ethereum' }).pools.length).toBeGreaterThan(0);
  });
});

describe('TC-E2E-02 — the cross-chain form: rows from several chains, each stating its own', () => {
  it('every row carries its OWN chain, and none is attributed to the requested one', () => {
    const page = normalize(CROSS_CHAIN, { chain: null });
    const byChain = new Set(page.pools.map((p) => p.chain));

    // The measured composition: 29 `pulsechain` rows behind one `ethereum` USDC address. This is
    // the defect the whole cross-chain contract exists for — a fork reproduces the addresses of the
    // chain it forked, so presenting these as "this token's pools" attributes another chain's pools
    // to it.
    expect(byChain.size).toBeGreaterThan(1);
    expect(byChain).toContain('pulsechain');
    expect(byChain).toContain('ethereum');
    expect(page.pools.filter((p) => p.chain === 'pulsechain').length).toBeGreaterThan(
      page.pools.filter((p) => p.chain === 'ethereum').length,
    );
  });

  it('says in `reason` that this form is a SAMPLE', () => {
    expect(normalize(CROSS_CHAIN, { chain: null }).truncated.reason).toContain('CROSS-CHAIN');
  });
});

describe('TC-E2E-03 — a token with no pools is an empty page, not a truncated one', () => {
  it('answers `pools: []` and `truncated.pairs: false`', () => {
    // Measured against a well-formed address nothing deploys: both routes answer 0 rows. Reporting
    // that as truncated would tell a caller to retry for rows that do not exist — and reporting it
    // as an error would turn "this token trades nowhere" into a failure.
    const page = normalize([], { chain: 'ethereum', token: '0x' + '0'.repeat(36) + 'DeaDBeef' });
    expect(page.pools).toStrictEqual([]);
    expect(page.truncated.pairs).toBe(false);
    expect(page.truncated.reason).toBe('');
  });
});

describe('TC-UNIT-01/02 — the vendor cap is reported, and a short page is not', () => {
  it('TC-UNIT-01: a full 30-row page reports the cap as its own cause', () => {
    // `limit` is above the page, so the ONLY cause is the vendor cap. A caller told to raise
    // `limit` for rows the vendor never sent would retry forever, which is why L-14 keeps the
    // causes apart.
    const page = normalize(PER_CHAIN_FULL, { chain: 'ethereum', limit: 100 });

    expect(PER_CHAIN_FULL).toHaveLength(30);
    expect(page.truncated.pairs).toBe(true);
    expect(page.truncated.reason).toContain('FULL page of 30');
    expect(page.truncated.reason).not.toContain('cut by limit');
  });

  it('TC-UNIT-02: 29 rows under a wider limit are not truncated at all', () => {
    // DERIVED from the recorded 30-row fixture rather than recorded separately, and deliberately
    // so: the boundary between "the vendor stopped" and "the vendor finished" is exactly one row,
    // and a separately recorded page could differ in a dozen other ways at the same time.
    const twentyNine = PER_CHAIN_FULL.slice(0, 29);
    const page = normalize(twentyNine, { chain: 'ethereum', limit: 100 });

    expect(page.pools).toHaveLength(29);
    expect(page.truncated.pairs).toBe(false);
    expect(page.truncated.reason).toBe('');
  });

  it('a short REAL page is not truncated either', () => {
    const page = normalize(SHORT_PAGE, { chain: 'berachain', limit: 100 });
    expect(page.pools).toHaveLength(6);
    expect(page.truncated.pairs).toBe(false);
  });
});

describe('TC-UNIT-03 — a `limit` cut says it is arbitrary, because the order is not a ranking', () => {
  it('names the cut AND warns it is not the largest pools', () => {
    // Measured 2026-08-21 (two samples 300 s apart): the order is stable and is NOT sorted by
    // liquidity — the second row of the USDC sample held $9.9M behind a first row of $89k. So a
    // caller reading a `limit`-cut page as "the top N pools" is reading it wrong, and the reason
    // line is the only place that can tell them.
    const page = normalize(PER_CHAIN_FULL, { chain: 'ethereum', limit: 5 });

    expect(page.pools).toHaveLength(5);
    expect(page.truncated.pairs).toBe(true);
    expect(page.truncated.reason).toContain('cut by limit=5');
    expect(page.truncated.reason).toContain('not a size ranking');
    // Both causes present and SEPARATE: the page was capped by the vendor as well.
    expect(page.truncated.reason).toContain('FULL page of 30');
  });
});

describe('TC-UNIT-04/05 — the published input schema', () => {
  it('TC-UNIT-04: accepts no host, URL or endpoint (AC-11)', () => {
    for (const key of ['url', 'host', 'endpoint', 'rpcUrl', 'baseUrl']) {
      const parsed = TokenPoolsInputSchema.safeParse({
        token: '0x' + 'a'.repeat(40),
        [key]: 'https://evil.example',
      });
      expect(parsed.success, `${key} was accepted by the published schema`).toBe(false);
    }
    // The PUBLISHED surface, read from the committed `tools/list` capture rather than from the zod
    // object. Two reasons, and the second is the one that matters: zod v4 keeps `_def.shape`
    // private, so reaching into it breaks on a dependency bump; and the snapshot is the artefact a
    // CLIENT actually receives, which is what AC-11 is a claim about.
    const entry = snapshot.find((tool) => tool.name === tokenPoolsToolSpec.name);
    expect(entry, 'onchain_token_pools is not in the tools/list snapshot').toBeDefined();
    const published = Object.keys(entry?.inputSchema.properties ?? {});
    expect(published.length, 'the snapshot rendered no properties at all').toBeGreaterThan(0);
    expect(published.filter((k) => /url|host|endpoint|rpc|uri/i.test(k))).toStrictEqual([]);
  });

  it('TC-UNIT-05: a malformed token is refused before any outgoing call', () => {
    expect(TokenPoolsInputSchema.safeParse({ token: '' }).success).toBe(false);
    expect(TokenPoolsInputSchema.safeParse({ token: 'x'.repeat(129) }).success).toBe(false);
    // The chain is OPTIONAL — that is the cross-chain form — but a chain that is PRESENT and
    // unknown must still be refused, or a typo would silently widen the question to every chain.
    expect(
      TokenPoolsInputSchema.safeParse({ token: '0x' + 'a'.repeat(40), chain: 'nosuchchain' })
        .success,
    ).toBe(false);
  });
});

describe('the adapter refuses a route/capability mismatch loudly', () => {
  it('a token.pools result handed to another capability throws', () => {
    expect(() =>
      adapter.normalize('pairs.active', {
        kind: 'token-pools',
        chain: chains.resolve('ethereum'),
        token: '0x' + 'a'.repeat(40),
        limit: 10,
        raw: PER_CHAIN_FULL,
      }),
    ).toThrow(/token\.pools fetch result/);
  });
});
