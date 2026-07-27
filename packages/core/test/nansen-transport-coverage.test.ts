import { describe, expect, it } from 'vitest';
import { createNansenAdapter } from '../src/adapters/nansen/index.js';
import { NANSEN_EXHAUSTIVE_LABELS_CHAINS } from '../src/adapters/nansen/chain-coverage.js';
import { CapabilityRegistry, CapabilityUnavailableError } from '../src/adapters/registry.js';
import { CapabilityNotCoveredOnChainError } from '../src/chain/errors.js';
import { createThrottle } from '../src/net/rate-limit.js';
import { loadChainRegistry } from '../src/chain/registry.js';
import { routes } from '../src/index.js';

/**
 * vdd-multi cycle 5, H-1 — **what the coverage matrix advertises must be what the transport can
 * send.**
 *
 * Task 006-9 widened `chainSupport()` to the vendor's real per-capability coverage without
 * widening the request builders, so 23 chains passed every gate and then failed inside `fetch()`
 * as a RETRYABLE `CapabilityUnavailableError` — an agent looping forever, and on a paid route
 * looping against the budget gate. The invariant below is the test the review asked for: it is
 * derived from the same source as the claim, so it cannot go stale the way a hand-listed set of
 * chains would.
 *
 * Zero live credits: every call goes through an injected `fetchImpl` that records the request and
 * answers with an empty body, and none of the refusal tests reach the transport at all.
 */
const CHAINS = loadChainRegistry();
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
}

function adapterRecording(calls: RecordedCall[]) {
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    // Shape-agnostic: these tests assert on what was SENT, never on what came back.
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  return createNansenAdapter({
    env: { NANSEN_API_KEY: 'not-a-real-key' },
    fetchImpl,
    throttle: createThrottle(),
    __ungatedForTestsOnly: true,
  });
}

/**
 * Every slug the coverage matrix claims for `capability` — read from the ADAPTER's own
 * `chainSupport`, never re-derived from the raw spec list (vdd-multi cycle 6).
 *
 * Deriving it from `NANSEN_CHAIN_COVERAGE` alone made this test assert a DIFFERENT claim than the
 * one the engine makes: after C-1 the adapter also requires an address family with a real
 * validator, so the spec list is a superset of what is actually advertised. A test that computes
 * the advertisement itself cannot detect the advertisement being wrong.
 */
const coverageAdapter = createNansenAdapter({ env: {} });

function coveredSlugs(capability: string): string[] {
  return CHAINS.list()
    .filter((chain) => coverageAdapter.chainSupport!(chain, capability))
    .map((chain) => chain.slug);
}

describe('THE invariant: covered ⇒ the transport can build the request', () => {
  for (const capability of ['smart-money.flows', 'token.risk', 'entity.labels']) {
    const slugs = coveredSlugs(capability);

    it(`${capability}: all ${slugs.length} advertised chains are accepted by fetch()`, async () => {
      // A guard on the guard: if the derivation ever yields an empty set, the loop below would
      // pass vacuously and this whole file would stop testing anything.
      expect(slugs.length).toBeGreaterThan(10);

      for (const slug of slugs) {
        const calls: RecordedCall[] = [];
        const adapter = adapterRecording(calls);
        const chain = CHAINS.resolve(slug);
        const address = chain.family === 'svm' ? SOL_MINT : USDC;

        await adapter.fetch(capability, { chain: slug, tokenAddress: address });

        expect(calls.length, `${capability}/${slug} made no request`).toBeGreaterThan(0);
      }
    });

    it(`${capability}: sends NANSEN's chain token, never our slug`, async () => {
      // `bsc`→`bnb` and `op-mainnet`→`optimism` are the two that would look plausible and be
      // silently wrong; skip a capability that does not cover them rather than assert nothing.
      for (const slug of ['bsc', 'op-mainnet']) {
        if (!slugs.includes(slug)) continue;
        const calls: RecordedCall[] = [];
        const adapter = adapterRecording(calls);
        const expectedToken = CHAINS.resolve(slug).vendors['nansen'];

        await adapter.fetch(capability, { chain: slug, tokenAddress: USDC });

        // Only the sub-calls that carry a chain at all: `/search/entity-name` legitimately has no
        // `chain` field in the vendor's schema, and asserting on it would test the wrong thing.
        const sent = calls
          .map((call) => call.body['chain'] ?? call.body['chains'])
          .filter((value) => value !== undefined)
          .map((value) => (Array.isArray(value) ? (value as unknown[]) : [value]));
        expect(sent.length, `${capability}/${slug} sent no chain at all`).toBeGreaterThan(0);
        for (const asList of sent) {
          expect(asList, `${capability}/${slug}`).toContain(expectedToken);
          expect(asList).not.toContain(slug);
        }
      }
    });
  }
});

describe('an uncovered chain is refused PERMANENTLY, and before any request', () => {
  it('throws CapabilityNotCoveredOnChainError, not a generic Error', async () => {
    const calls: RecordedCall[] = [];
    const adapter = adapterRecording(calls);
    // `polygon` is covered; a chain with no `vendors.nansen` at all is the clean negative case.
    const unmapped = CHAINS.list().find((chain) => chain.vendors['nansen'] == null)!;

    await expect(
      adapter.fetch('token.risk', { chain: unmapped.slug, tokenAddress: USDC }),
    ).rejects.toBeInstanceOf(CapabilityNotCoveredOnChainError);
    expect(calls).toHaveLength(0);
  });

  it('CapabilityRegistry rethrows it instead of folding it into CapabilityUnavailableError', async () => {
    // The distinction IS the fix: `CapabilityUnavailableError` tells the caller to retry, which
    // for a permanent condition is an infinite loop against a paid route.
    const adapter = adapterRecording([]);
    const unmapped = CHAINS.list().find((chain) => chain.vendors['nansen'] == null)!;
    const registry = new CapabilityRegistry(routes, new Map([['nansen', adapter]]));

    const thrown = await registry
      .resolve('token.risk', unmapped.slug, { chain: unmapped.slug, tokenAddress: USDC })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(thrown).toBeInstanceOf(CapabilityNotCoveredOnChainError);
    expect(thrown).not.toBeInstanceOf(CapabilityUnavailableError);
  });
});

describe('M-7 — the exhaustive labels tier enforces its own, narrower chain list', () => {
  /** In the default `entity.labels` list but NOT in the 100cr exhaustive one. */
  const defaultOnly = coveredSlugs('entity.labels').filter((slug) => {
    const token = CHAINS.resolve(slug).vendors['nansen'];
    return token != null && !NANSEN_EXHAUSTIVE_LABELS_CHAINS.includes(token);
  });

  it('there is something to test (the two lists genuinely differ)', () => {
    expect(defaultOnly.length).toBeGreaterThan(0);
  });

  it.each(defaultOnly)('%s: default tier works, exhaustive tier is refused', async (slug) => {
    const calls: RecordedCall[] = [];
    const adapter = adapterRecording(calls);
    const address = CHAINS.resolve(slug).family === 'svm' ? SOL_MINT : USDC;

    await adapter.fetch('entity.labels', { chain: slug, tokenAddress: address });
    expect(calls.length).toBeGreaterThan(0);

    const exhaustiveCalls: RecordedCall[] = [];
    const exhaustiveAdapter = adapterRecording(exhaustiveCalls);
    await expect(
      exhaustiveAdapter.fetch('entity.labels', {
        chain: slug,
        tokenAddress: address,
        exhaustive: true,
      }),
    ).rejects.toBeInstanceOf(CapabilityNotCoveredOnChainError);
    // The point of refusing here rather than at the vendor: 100 credits not spent.
    expect(exhaustiveCalls).toHaveLength(0);
  });
});

describe('the DF-1 casing rule survives the widening', () => {
  it('lowercases token_address on EVM chains (the live-proven rule) — on every EVM chain', async () => {
    for (const slug of ['ethereum', 'bsc', 'arbitrum']) {
      const calls: RecordedCall[] = [];
      const adapter = adapterRecording(calls);
      await adapter.fetch('smart-money.flows', { chain: slug, tokenAddress: USDC });

      const netflow = calls.find((call) => call.url.includes('/smart-money/netflow'))!;
      const filters = netflow.body['filters'] as Record<string, unknown>;
      expect(filters['token_address'], slug).toBe(USDC.toLowerCase());
    }
  });

  it('leaves a base58 mint verbatim on solana (folding it would corrupt the address)', async () => {
    const calls: RecordedCall[] = [];
    const adapter = adapterRecording(calls);
    await adapter.fetch('smart-money.flows', { chain: 'solana', tokenAddress: SOL_MINT });

    const netflow = calls.find((call) => call.url.includes('/smart-money/netflow'))!;
    const filters = netflow.body['filters'] as Record<string, unknown>;
    expect(filters['token_address']).toBe(SOL_MINT);
  });
});
