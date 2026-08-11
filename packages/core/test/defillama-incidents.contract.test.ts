import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDefillamaAdapter, loadChainRegistry } from '../src/index.js';
import { isolatedThrottle } from './helpers/isolated-throttle.js';
import type { ProtocolIncidentsResult } from '../src/adapters/defillama/index.js';

/**
 * WI-52 — `protocol.incidents`.
 *
 * **What every case here is really testing: that an empty list can never be read as "safe".** The
 * feature is a handful of lines of joining; the risk is entirely in what the response says when it
 * finds nothing, because that is the answer a model will paraphrase as reassurance. So the four
 * meanings of "no incidents" get one case each:
 *
 * 1. the protocol is not in the catalog       → `resolved: false`, no claim made
 * 2. the feed could not be read               → THROWS, never an empty list
 * 3. the feed cannot attribute some incidents → `unattributedRecords` bounds the silence
 * 4. genuinely nothing recorded               → `resolved: true` + an empty list + a fresh feed
 *
 * Fixture rows are verbatim from both live documents — see `hacks-and-catalog.evidence.md` for the
 * capture and for the join rates measured on the full documents.
 */
const testDir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(path.join(testDir, 'fixtures', 'defillama', 'hacks-and-catalog.json'), 'utf8'),
) as { protocols: Record<string, unknown>[]; hacks: Record<string, unknown>[] };

const CHAINS = loadChainRegistry();
const FIXED_NOW = 1_786_000_000_000;

/** Serves the catalog to `/protocols` and the incident feed to `/hacks`, by URL. */
function adapterServing(
  catalog: unknown = FIXTURE.protocols,
  hacks: unknown = FIXTURE.hacks,
): ReturnType<typeof createDefillamaAdapter> {
  return createDefillamaAdapter({
    now: () => FIXED_NOW,
    throttle: isolatedThrottle(FIXED_NOW),
    chains: CHAINS,
    fetchImpl: async (url) => {
      const body = String(url).includes('/hacks') ? hacks : catalog;
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
}

async function incidentsFor(
  slug: string,
  catalog?: unknown,
  hacks?: unknown,
): Promise<ProtocolIncidentsResult> {
  const adapter = adapterServing(catalog, hacks);
  const raw = await adapter.fetch('protocol.incidents', { protocolSlug: slug });
  return adapter.normalize('protocol.incidents', raw) as ProtocolIncidentsResult;
}

describe('WI-52 — protocol.incidents attaches the feed to a protocol', () => {
  it('finds the incidents recorded against the protocol itself', async () => {
    const result = await incidentsFor('venus-core-pool');

    expect(result.resolved).toBe(true);
    expect(result.incidents.length).toBeGreaterThan(0);
    expect(result.incidents.some((i) => i.matchedBy === 'protocol')).toBe(true);
    // Newest first: a risk question is about the recent past far more often than the distant one.
    const timestamps = result.incidents.map((i) => i.ts);
    expect([...timestamps].sort((a, b) => b - a)).toStrictEqual(timestamps);
  });

  it('reaches an incident recorded against a SIBLING through the parent, and labels it as such', async () => {
    // `venus-flux` shares `parent#venus-finance` with `venus-core-pool`. An exploit of the sibling
    // is a real signal about the family and a DIFFERENT claim from "this contract was drained" —
    // `matchedBy` is what keeps a consumer from conflating them.
    const result = await incidentsFor('venus-flux');

    expect(result.resolved).toBe(true);
    const viaParent = result.incidents.filter((i) => i.matchedBy === 'parent');
    expect(viaParent.length).toBeGreaterThan(0);
  });

  it('sums only the stated amounts, and reports null rather than zero when none were stated', async () => {
    const withAmounts = await incidentsFor('venus-core-pool');
    const stated = withAmounts.incidents
      .map((i) => i.amountUsd)
      .filter((a): a is number => a !== null);
    if (stated.length > 0) {
      expect(withAmounts.totalAmountUsd).toBeCloseTo(
        stated.reduce((sum, a) => sum + a, 0),
        6,
      );
    }

    // A zero here would assert that the exploits cost nothing — a claim no record made.
    const amountless = FIXTURE.hacks.map((h) => ({ ...h, amount: null }));
    const result = await incidentsFor('venus-core-pool', undefined, amountless);
    expect(result.incidents.length).toBeGreaterThan(0);
    expect(result.totalAmountUsd).toBeNull();
  });
});

describe('WI-52 — the four meanings of "no incidents" stay distinguishable', () => {
  it('1. an unknown protocol answers resolved:false — NOT "none found"', async () => {
    const result = await incidentsFor('a-protocol-that-does-not-exist');

    expect(result.resolved).toBe(false);
    expect(result.incidents).toStrictEqual([]);
    // The feed counters are still reported: they are what tells a caller the LOOKUP failed rather
    // than the feed. Reporting zeroes here would make the two indistinguishable again.
    expect(result.feedRecords).toBe(FIXTURE.hacks.length);
    expect(result.feedThroughTs).toBeGreaterThan(0);
  });

  it('2. an unreadable feed THROWS — it never degrades into an empty list', async () => {
    // The single most dangerous answer this capability could give: "no incidents" produced by a
    // failure to read. Same rule the holders normalizer applies one adapter over.
    await expect(incidentsFor('venus-core-pool', undefined, { error: 'nope' })).rejects.toThrow(
      /refusing to report an empty incident list/,
    );
  });

  it('3. incidents the feed cannot attribute are COUNTED, so silence has a known bound', async () => {
    const result = await incidentsFor('venus-core-pool');

    const unattributable = FIXTURE.hacks.filter(
      (h) => !h['defillamaId'] && !h['parentProtocolId'],
    ).length;
    expect(unattributable).toBeGreaterThan(0);
    expect(result.unattributedRecords).toBe(unattributable);
  });

  it('4. a KNOWN protocol with nothing recorded is a measurement, and says so', async () => {
    // `lido` is in the fixture catalog, is one of the largest protocols by TVL, and carries no
    // attributed incident in the live feed. Chosen over `binance-cex`, which also has none — and
    // would have been a dishonest example, because Binance HAS been exploited and the feed holds
    // that record among the unattributed rows the case below counts.
    const result = await incidentsFor('lido');

    expect(result.resolved).toBe(true);
    expect(result.incidents).toStrictEqual([]);
    expect(result.totalAmountUsd).toBeNull();
    // …and the caller can still see how current the claim is.
    expect(result.feedThroughTs).toBeGreaterThan(0);
  });
});

describe('WI-52 — the canonical shape', () => {
  it('converts the vendor unix SECONDS into epoch-ms, like every other timestamp here', async () => {
    const result = await incidentsFor('venus-core-pool');
    const first = result.incidents[0]!;
    const vendorRow = FIXTURE.hacks.find((h) => h['name'] === first.name)!;
    expect(first.ts).toBe((vendorRow['date'] as number) * 1000);
    // Sanity that the unit is right at all: a seconds value read as ms lands in 1970.
    expect(first.ts).toBeGreaterThan(1_400_000_000_000);
  });

  it('maps vendor chain names through the SAME alias map every other capability uses', async () => {
    const result = await incidentsFor('venus-core-pool');
    const withChains = result.incidents.filter((i) => i.chains.length > 0);
    expect(withChains.length).toBeGreaterThan(0);
    // L-10's lesson: the vendor speaks two chain vocabularies. An unmapped name is kept verbatim
    // rather than dropped — the incident is real either way, and losing the chain is the worse
    // answer — so this asserts that a KNOWN name is translated, not that every one is.
    const known = result.incidents.flatMap((i) => i.chains).filter((c) => CHAINS.tryResolve(c));
    expect(known.length).toBeGreaterThan(0);
  });
});
