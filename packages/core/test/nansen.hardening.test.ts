import { describe, expect, it } from 'vitest';

import { DAILY_CAP_OFF, deriveDailyCap } from '../src/adapters/nansen/budget-gate.js';
import { ttlFor } from '../src/cache/ttl.js';
import {
  normalizeEntityLabels,
  normalizeSmartMoneyFlow,
  normalizeTokenRiskScore,
} from '../src/adapters/nansen/normalize.js';
import { adapterRegistrations } from '../src/providers.config.js';
import { EntityLabelSchema } from '../src/types/entity-label.js';
import { TokenRiskScoreSchema } from '../src/types/token-risk-score.js';
import { SmartMoneyFlowSchema } from '../src/types/smart-money-flow.js';

/**
 * Regression tests for adversarial review cycle 1 findings that were fixed at the config/schema
 * layer. Each `it` names the finding it pins so a future edit that silently reverts one fails
 * with an explanation rather than a bare assertion diff.
 */
describe('M2 hardening — adversarial review cycle 1', () => {
  describe('M-4 (perf + security, independently found): paid capabilities need EXPLICIT TTLs', () => {
    // They previously fell through to DEFAULT_TTL_SECONDS = 300 — a constant whose own docstring
    // says it "should not be hit", chosen as an M1 FREE-tier safety net. That let a fallback decide
    // the spend rate of the first paid provider.
    it('gives entity.labels a long TTL — its exhaustive tier costs 100cr (the whole free balance)', () => {
      // At the old 300s fallback, 4 revisits to one address in a 25-minute investigation cost
      // 400cr instead of 100cr.
      expect(ttlFor('entity.labels')).toBeGreaterThanOrEqual(3600);
    });

    it('gives token.risk a TTL well above the old fallback — indicators are not tick data', () => {
      expect(ttlFor('token.risk')).toBeGreaterThanOrEqual(1800);
    });

    it('keeps smart-money.flows short — netflow1hUsd is a genuinely moving 1h window', () => {
      // Deliberately equal to the old fallback value, but now by decision rather than omission.
      expect(ttlFor('smart-money.flows')).toBe(300);
    });

    it('none of the three M2 capabilities silently share the generic default', () => {
      const generic = ttlFor('some.capability.that.does.not.exist');
      const paid = ['token.risk', 'entity.labels'].map(ttlFor);
      expect(paid.every((t) => t !== generic)).toBe(true);
    });
  });

  describe('perf MINOR: the nansen throttle must not be self-harm', () => {
    it('is far below vendor limits but not 50-150x below them', () => {
      const nansen = adapterRegistrations.find((a) => a.id === 'nansen');
      expect(nansen).toBeDefined();
      // Vendor documents 150/s and 3000/min. Every M2 capability is composite (2-4 throttle tokens
      // per logical call), so at the old {capacity:5, refillPerSec:1} a 10-token agent turn slept
      // ~7.6s inside our own limiter. Still >=10x under the per-second vendor limit.
      expect(nansen!.rateLimit.refillPerSec).toBeGreaterThanOrEqual(5);
      expect(nansen!.rateLimit.refillPerSec).toBeLessThanOrEqual(15);
      expect(nansen!.rateLimit.capacity).toBeGreaterThanOrEqual(10);
    });
  });

  describe('M-5b (security F-2): vendor-authored free text is bounded', () => {
    const base = { premiumRequested: false, source: 'nansen', fetchedAt: 1 };

    it('rejects an unbounded entity name — anyone can deploy a token and name it', () => {
      // These strings reach the model, from a tool that also exposes a 100cr escalation.
      expect(() => EntityLabelSchema.parse({ ...base, name: 'x'.repeat(300) })).toThrow();
    });

    it('accepts a realistic label length', () => {
      expect(() => EntityLabelSchema.parse({ ...base, name: 'Wintermute' })).not.toThrow();
    });

    it('bounds tag/label array cardinality, not just element length', () => {
      const many = Array.from({ length: 100 }, (_, i) => `tag${i}`);
      expect(() => EntityLabelSchema.parse({ ...base, tags: many })).toThrow();
    });

    it('caps topHolders so vendor response size cannot dictate cache-row and context size', () => {
      const holder = { address: '0x0000000000000000000000000000000000000001' };
      const flow = {
        chain: 'ethereum' as const,
        tokenAddress: '0x0000000000000000000000000000000000000002',
        tokenSymbol: 'T',
        netflow1hUsd: 0,
        netflow24hUsd: 0,
        netflow7dUsd: 0,
        netflow30dUsd: 0,
        source: 'nansen',
        fetchedAt: 1,
        topHolders: Array.from({ length: 201 }, () => holder),
      };
      expect(() => SmartMoneyFlowSchema.parse(flow)).toThrow();
      expect(() =>
        SmartMoneyFlowSchema.parse({ ...flow, topHolders: flow.topHolders.slice(0, 200) }),
      ).not.toThrow();
    });
  });
  describe('cycle-2 R-3: the cap fix must cover ALL THREE canonical types, not two of three', () => {
    const base = {
      chain: 'ethereum' as const,
      address: '0x0000000000000000000000000000000000000001',
      source: 'nansen',
      fetchedAt: 1,
      rewardIndicators: [],
    };

    it('bounds token.risk indicator arrays — the path cycle-1 missed', () => {
      // token.risk has a 1800s TTL, so an oversized body would be mapped, parsed, stored AND
      // re-served from cache repeatedly.
      const many = Array.from({ length: 201 }, () => ({ indicatorType: 'x' }));
      expect(() => TokenRiskScoreSchema.parse({ ...base, riskIndicators: many })).toThrow();
      expect(() =>
        TokenRiskScoreSchema.parse({ ...base, riskIndicators: many.slice(0, 200) }),
      ).not.toThrow();
    });

    it('bounds token.risk vendor-authored strings', () => {
      expect(() =>
        TokenRiskScoreSchema.parse({
          ...base,
          riskIndicators: [{ indicatorType: 'x'.repeat(300) }],
        }),
      ).toThrow();
    });
  });
  describe('cycle-2 C-1: the netflow row must be MATCHED by address, never taken as data[0]', () => {
    const WANTED = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const OTHER = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const netflowRow = (addr: string, symbol: string, net24h: number) => ({
      token_address: addr.toLowerCase(),
      token_symbol: symbol,
      net_flow_1h_usd: 0,
      net_flow_24h_usd: net24h,
      net_flow_7d_usd: 0,
      net_flow_30d_usd: 0,
    });
    const call = (rows: unknown[]) =>
      normalizeSmartMoneyFlow(
        {
          chain: 'ethereum',
          tokenAddress: WANTED,
          netflow: { body: { data: rows }, creditsUsedHeader: '5' },
          holders: { body: { data: [] }, creditsUsedHeader: '5' },
        } as never,
        () => 1,
      );

    it('picks the row echoing the REQUESTED address even when it is not first', () => {
      // data[0] would have stamped ANOTHER token's netflow figures onto the requested address:
      // schema-valid, non-empty, no error — a silently wrong PAID financial signal, cached 300s.
      const flow = call([netflowRow(OTHER, 'WETH', -999), netflowRow(WANTED, 'USDC', -325939)]);
      expect(flow.tokenSymbol).toBe('USDC');
      expect(flow.netflow24hUsd).toBe(-325939);
    });

    it('matches case-insensitively (vendor echoes lowercase, canonical form is EIP-55)', () => {
      expect(call([netflowRow(WANTED, 'USDC', -1)]).tokenSymbol).toBe('USDC');
    });

    it('throws rather than guessing when no row echoes the requested address', () => {
      expect(() => call([netflowRow(OTHER, 'WETH', -999)])).toThrow(/no matching row/);
    });

    it('still accepts a single unambiguous row when the vendor omits token_address', () => {
      const legacy = { ...netflowRow(WANTED, 'USDC', -7) } as Record<string, unknown>;
      delete legacy['token_address'];
      expect(call([legacy]).tokenSymbol).toBe('USDC');
    });
  });

  describe('cycle-2 M-1: caps must TRUNCATE in the mapper, not throw at parse (post-payment drain)', () => {
    const WANTED = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    it('truncates an attacker-authored 300-char token symbol instead of failing the paid call', () => {
      // Enforcing the cap only via Schema.parse meant a throw AFTER the credits were spent, with
      // nothing cached — so the agent's retry paid again: a permanent 10cr-per-attempt tarpit for
      // any token whose symbol exceeds the cap.
      const flow = normalizeSmartMoneyFlow(
        {
          chain: 'ethereum',
          tokenAddress: WANTED,
          netflow: {
            body: {
              data: [
                {
                  token_address: WANTED.toLowerCase(),
                  token_symbol: 'S'.repeat(300),
                  net_flow_1h_usd: 0,
                  net_flow_24h_usd: 0,
                  net_flow_7d_usd: 0,
                  net_flow_30d_usd: 0,
                  token_sectors: Array.from({ length: 100 }, (_, i) => `sector${i}`),
                },
              ],
            },
            creditsUsedHeader: '5',
          },
          holders: { body: { data: [] }, creditsUsedHeader: '5' },
        } as never,
        () => 1,
      );
      expect(flow.tokenSymbol).toHaveLength(256);
      expect(flow.tokenSectors!.length).toBeLessThanOrEqual(64);
    });

    it('filters non-string sectors element-wise instead of failing the whole response', () => {
      const flow = normalizeSmartMoneyFlow(
        {
          chain: 'ethereum',
          tokenAddress: WANTED,
          netflow: {
            body: {
              data: [
                {
                  token_address: WANTED.toLowerCase(),
                  token_symbol: 'USDC',
                  net_flow_1h_usd: 0,
                  net_flow_24h_usd: 0,
                  net_flow_7d_usd: 0,
                  net_flow_30d_usd: 0,
                  token_sectors: [{ name: 'DeFi' }, 'Stablecoin', 42],
                },
              ],
            },
            creditsUsedHeader: '5',
          },
          holders: { body: { data: [] }, creditsUsedHeader: '5' },
        } as never,
        () => 1,
      );
      expect(flow.tokenSectors).toEqual(['Stablecoin']);
    });
  });
  describe('cycle-3 3.1/3.2: NO vendor payload may throw at parse AFTER the call is paid', () => {
    const WANTED = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

    it('3.2: a fractional token_age_days (12-hour-old token) degrades instead of tarpitting the token', () => {
      // `.int()` rejected 0.5 at parse — AFTER the 10cr pair was spent, nothing cached, so every
      // retry paid 10cr again. Newly-deployed tokens are exactly what smart-money tooling watches.
      const flow = normalizeSmartMoneyFlow(
        {
          chain: 'ethereum',
          tokenAddress: WANTED,
          netflow: {
            body: {
              data: [
                {
                  token_address: WANTED.toLowerCase(),
                  token_symbol: 'NEW',
                  net_flow_1h_usd: 0,
                  net_flow_24h_usd: 0,
                  net_flow_7d_usd: 0,
                  net_flow_30d_usd: 0,
                  token_age_days: 0.5,
                  trader_count: -1,
                },
              ],
            },
            creditsUsedHeader: '5',
          },
          holders: { body: { data: [] }, creditsUsedHeader: '5' },
        } as never,
        () => 1,
      );
      // The paid result survives; only the unusable optional enrichment fields are dropped.
      expect(flow.tokenSymbol).toBe('NEW');
      expect(flow.tokenAgeDays).toBeUndefined();
      expect(flow.traderCount).toBeUndefined();
    });

    it('3.1: an oversized token.risk indicator string truncates instead of failing the paid call', () => {
      const risk = normalizeTokenRiskScore(
        {
          chain: 'ethereum',
          address: WANTED,
          indicators: {
            body: {
              risk_indicators: [{ indicator_type: 'I'.repeat(300), score: 'S'.repeat(300) }],
              reward_indicators: [],
              token_info: { market_cap_group: 'G'.repeat(300), market_cap_usd: -1 },
            },
            creditsUsedHeader: '5',
          },
          tokenInformation: { body: {}, creditsUsedHeader: '1' },
        } as never,
        () => 1,
      );
      expect(risk.riskIndicators[0]!.indicatorType).toHaveLength(256);
      expect(risk.riskIndicators[0]!.score).toHaveLength(256);
      expect(risk.marketCapGroup).toHaveLength(256);
      // negative market cap fails `.nonnegative()` -> dropped, not thrown
      expect(risk.marketCapUsd).toBeUndefined();
    });
  });
  describe('cycle-4 L-5: a null ELEMENT must not destroy an already-paid response', () => {
    // Every row guard in normalize.ts is shaped `typeof row.field !== 'string'` — which is itself a
    // throw when `row` is null, because reading a property off null raises a raw TypeError BEFORE
    // the typeof can help. `null` is legal JSON and a routine serialisation artifact. Cycles 1-3
    // closed this class for oversized strings, wrong types and fractional numbers; it stayed open
    // one level up, at the element itself.
    const WANTED = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const netflowRow = {
      token_address: WANTED.toLowerCase(),
      token_symbol: 'USDC',
      net_flow_1h_usd: 0,
      net_flow_24h_usd: -325939,
      net_flow_7d_usd: 0,
      net_flow_30d_usd: 0,
    };

    it('skips a null netflow row and still finds the real one', () => {
      const flow = normalizeSmartMoneyFlow(
        {
          chain: 'ethereum',
          tokenAddress: WANTED,
          netflow: { body: { data: [null, netflowRow] }, creditsUsedHeader: '5' },
          holders: { body: { data: [] }, creditsUsedHeader: '5' },
        } as never,
        () => 1,
      );
      expect(flow.tokenSymbol).toBe('USDC');
    });

    it('drops a null holder row instead of losing the whole paid response', () => {
      const flow = normalizeSmartMoneyFlow(
        {
          chain: 'ethereum',
          tokenAddress: WANTED,
          netflow: { body: { data: [netflowRow] }, creditsUsedHeader: '5' },
          holders: {
            body: {
              data: [null, { address: '0x0000000000000000000000000000000000000001' }],
            },
            creditsUsedHeader: '5',
          },
        } as never,
        () => 1,
      );
      expect(flow.topHolders).toHaveLength(1);
    });

    it('raises a typed normalization error, not a TypeError, on a null token.risk indicator', () => {
      expect(() =>
        normalizeTokenRiskScore(
          {
            chain: 'ethereum',
            tokenAddress: WANTED,
            indicators: {
              body: { risk_indicators: [null], reward_indicators: [] },
              creditsUsedHeader: '5',
            },
            tokenInformation: { body: {}, creditsUsedHeader: '1' },
          } as never,
          () => 1,
        ),
      ).toThrow(/indicator entry is not an object/);
    });

    // The first cycle-4 sweep guarded `mapSearchGeneral`'s tokens[] loop and MISSED its entities[]
    // sibling twenty lines below. Three independent verifiers flagged the same omission, which is
    // why this case exists: a guard applied to one of two adjacent loops is not a closed defect.
    it('drops a null ENTITY row in search/general — the sibling loop the first sweep missed', () => {
      const entries = normalizeEntityLabels(
        {
          chain: 'ethereum',
          search: {
            body: {
              tokens: [],
              entities: [null, { name: 'Wintermute', tags: ['market maker'] }],
            },
            creditsUsedHeader: '0',
          },
        } as never,
        () => 1,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe('Wintermute');
    });

    it('survives a null row on the 100cr exhaustive entity.labels path', () => {
      const entries = normalizeEntityLabels(
        {
          chain: 'ethereum',
          tokenAddress: WANTED,
          profilerLabels: {
            body: { data: [null, { label: 'Binance: Hot Wallet' }] },
            creditsUsedHeader: '100',
          },
        } as never,
        () => 1,
      );
      expect(entries[0]?.labels).toEqual(['Binance: Hot Wallet']);
    });
  });

  describe('Q-4: /tgm/token-information is consumed, and never fatal', () => {
    // The sub-call was always PAID (1cr of token.risk's 6) and never read. It is now read — but it
    // contributes only optional enrichment, so a malformed body must degrade to "fields absent"
    // rather than throw away the already-paid 6cr response (the L-1 class).
    const indicators = {
      body: {
        token_info: { market_cap_usd: 1000, market_cap_group: 'largecap', is_stablecoin: true },
        risk_indicators: [{ indicator_type: 'btc-reflexivity', score: 'low' }],
        reward_indicators: [],
      },
      creditsUsedHeader: '5',
    };
    const call = (tokenInformationBody: unknown) =>
      normalizeTokenRiskScore(
        {
          chain: 'ethereum',
          address: '0x0000000000000000000000000000000000000001',
          indicators,
          tokenInformation: { body: tokenInformationBody, creditsUsedHeader: '1' },
        } as never,
        () => 1,
      );

    it('surfaces the metadata the capability already pays for', () => {
      const score = call({
        data: {
          name: 'USD Coin',
          symbol: 'USDC',
          token_details: {
            token_deployment_date: '2018-08-03 19:28:24',
            fdv_usd: 72_949_375_871,
            circulating_supply: 72_993_578_820.9766,
            total_supply: 72_995_577_672.29245,
          },
          spot_metrics: { liquidity_usd: 536_369_088.28, total_holders: 3_105_691 },
        },
      });
      expect(score.name).toBe('USD Coin');
      expect(score.deploymentDate).toBe('2018-08-03 19:28:24');
      expect(score.liquidityUsd).toBe(536_369_088.28);
      expect(score.totalHolders).toBe(3_105_691);
    });

    it('degrades to fields-absent on a null/garbage body instead of losing the paid response', () => {
      for (const body of [null, {}, { data: null }, { data: { token_details: 'nope' } }]) {
        const score = call(body);
        expect(score.riskIndicators).toHaveLength(1); // the paid substance survives
        expect(score.name).toBeUndefined();
        expect(score.liquidityUsd).toBeUndefined();
      }
    });

    it('drops out-of-domain numbers rather than throwing at schema parse', () => {
      // `.nonnegative()` / `.int()` in the canonical schema — a negative sentinel or a fractional
      // holder count would otherwise throw AFTER both sub-calls were paid.
      const score = call({
        data: {
          token_details: { fdv_usd: -1, circulating_supply: Number.NaN },
          spot_metrics: { liquidity_usd: -5, total_holders: 3_105_691.5 },
        },
      });
      expect(score.fdvUsd).toBeUndefined();
      expect(score.circulatingSupply).toBeUndefined();
      expect(score.liquidityUsd).toBeUndefined();
      expect(score.totalHolders).toBeUndefined();
    });
  });

  describe('Q-2: derived daily credit cap + the .env disable switch', () => {
    it('scales with the plan — the same code serves free and Pro (owner decision #1)', () => {
      expect(deriveDailyCap(59)).toBe(30); // this account
      expect(deriveDailyCap(100)).toBe(30); // fresh free plan
      expect(deriveDailyCap(10_000)).toBe(2500); // Pro — a quarter of the allocation
    });

    it('never derives 0 — a floor of 30 keeps the engine usable on a near-empty account', () => {
      // Without the floor the gate would refuse its OWN calls before the vendor would: the guard
      // bricking the product it protects.
      for (const balance of [0, 1, 5, 12, 59, 100]) {
        expect(deriveDailyCap(balance)).toBeGreaterThanOrEqual(30);
      }
    });

    it('crosses from floor to percentage at 124, NOT 120 (floor() truncation)', () => {
      // The obvious mental arithmetic (0.25 × 120 = 30) gives the wrong boundary — a test written
      // against 121 would assert the wrong regime.
      expect(deriveDailyCap(123)).toBe(30); // floor still wins
      expect(deriveDailyCap(124)).toBe(31); // percentage takes over
    });

    it('keeps the 100cr exhaustive tier unreachable until the balance is >= 400', () => {
      // Falls out of the formula — no hand-maintained threshold to drift.
      expect(deriveDailyCap(396)).toBeLessThan(100);
      expect(deriveDailyCap(400)).toBe(100);
    });

    it('exposes a WORD as the disable sentinel, never 0', () => {
      // `0` is one truncation/typo away from silently disabling a money guard, and semantically
      // ought to mean "spend nothing". EnvSchema keeps rejecting it as invalid.
      expect(DAILY_CAP_OFF).toBe('off');
      expect(typeof DAILY_CAP_OFF).toBe('string');
    });
  });
});
