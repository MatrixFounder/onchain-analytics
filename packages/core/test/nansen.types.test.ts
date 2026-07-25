import { describe, expect, it } from 'vitest';
import { EntityLabelSchema, SmartMoneyFlowSchema, TokenRiskScoreSchema } from '../src/index.js';

describe('SmartMoneyFlowSchema (R-31)', () => {
  const sample = {
    chain: 'ethereum',
    tokenAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    tokenSymbol: 'PEPE',
    netflow1hUsd: 1234.5,
    netflow24hUsd: -50_000.25,
    netflow7dUsd: 200_000,
    netflow30dUsd: -1_000_000,
    traderCount: 42,
    tokenAgeDays: 365,
    tokenSectors: ['meme'],
    topHolders: [
      {
        address: '0x1234567890123456789012345678901234567890',
        addressLabel: 'Smart Money',
        tokenAmount: 1_000_000,
        valueUsd: 50_000,
        ownershipPercentage: 2.5,
      },
    ],
    source: 'nansen',
    fetchedAt: Date.now(),
  };

  it('validates a well-formed SmartMoneyFlow with all four netflow windows + topHolders', () => {
    expect(SmartMoneyFlowSchema.parse(sample)).toEqual(sample);
  });

  it('accepts an empty topHolders array and all optional fields omitted', () => {
    const minimal = {
      chain: sample.chain,
      tokenAddress: sample.tokenAddress,
      tokenSymbol: sample.tokenSymbol,
      netflow1hUsd: sample.netflow1hUsd,
      netflow24hUsd: sample.netflow24hUsd,
      netflow7dUsd: sample.netflow7dUsd,
      netflow30dUsd: sample.netflow30dUsd,
      topHolders: [],
      source: sample.source,
      fetchedAt: sample.fetchedAt,
    };
    expect(() => SmartMoneyFlowSchema.parse(minimal)).not.toThrow();
  });

  it('rejects a missing netflow24hUsd window (the R-31 minimum bar)', () => {
    const { netflow24hUsd: _drop, ...invalid } = sample;
    void _drop;
    expect(() => SmartMoneyFlowSchema.parse(invalid)).toThrow();
  });

  it('rejects an unknown field (.strict())', () => {
    expect(() => SmartMoneyFlowSchema.parse({ ...sample, extra: 'nope' })).toThrow();
  });
});

describe('EntityLabelSchema (R-32)', () => {
  it('validates an entity with 0 labels — an empty array is a valid result, not an error', () => {
    const noLabels = {
      name: 'Unknown Wallet',
      premiumRequested: false,
      source: 'nansen',
      fetchedAt: Date.now(),
    };
    const parsed = EntityLabelSchema.parse(noLabels);
    expect(parsed.labels).toEqual([]);
    expect(parsed.tags).toEqual([]);
    expect(parsed.chain).toBeUndefined();
    expect(parsed.address).toBeUndefined();
  });

  it('validates a cross-chain entity with >=1 label, chain and address both omitted', () => {
    const withLabels = {
      name: 'Binance',
      tags: ['exchange'],
      labels: ['Smart Money'],
      premiumRequested: true,
      source: 'nansen',
      fetchedAt: Date.now(),
    };
    const parsed = EntityLabelSchema.parse(withLabels);
    expect(parsed.chain).toBeUndefined();
    expect(parsed.address).toBeUndefined();
    expect(parsed.labels).toEqual(['Smart Money']);
  });

  it('validates a token-scoped result carrying both chain and address', () => {
    const scoped = {
      chain: 'ethereum',
      address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      labels: ['Smart Money'],
      premiumRequested: false,
      source: 'nansen',
      fetchedAt: Date.now(),
    };
    expect(() => EntityLabelSchema.parse(scoped)).not.toThrow();
  });

  it('rejects a missing premiumRequested flag', () => {
    expect(() => EntityLabelSchema.parse({ source: 'nansen', fetchedAt: Date.now() })).toThrow();
  });

  it('rejects an unknown field (.strict())', () => {
    expect(() =>
      EntityLabelSchema.parse({
        premiumRequested: false,
        source: 'nansen',
        fetchedAt: Date.now(),
        extra: 'nope',
      }),
    ).toThrow();
  });
});

describe('TokenRiskScoreSchema (R-33)', () => {
  const sample = {
    chain: 'ethereum',
    address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    marketCapUsd: 1_500_000_000,
    marketCapGroup: 'largecap',
    isStablecoin: false,
    riskIndicators: [
      {
        indicatorType: 'liquidity-risk',
        score: 'high',
        signal: 0.75,
        signalPercentile: 85.5,
        lastTriggerOn: '2025-01-15',
      },
    ],
    rewardIndicators: [{ indicatorType: 'price-momentum', score: 'bullish', signal: -0.25 }],
    source: 'nansen',
    fetchedAt: Date.now(),
  };

  it('validates a well-formed TokenRiskScore with SEPARATE risk/reward indicator groups', () => {
    const parsed = TokenRiskScoreSchema.parse(sample);
    expect(parsed.riskIndicators).toHaveLength(1);
    expect(parsed.rewardIndicators).toHaveLength(1);
    expect(parsed.riskIndicators[0]?.indicatorType).toBe('liquidity-risk');
    expect(parsed.rewardIndicators[0]?.indicatorType).toBe('price-momentum');
  });

  it('keeps signal/signalPercentile as JS numbers, not strings', () => {
    const parsed = TokenRiskScoreSchema.parse(sample);
    expect(typeof parsed.riskIndicators[0]?.signal).toBe('number');
    expect(typeof parsed.riskIndicators[0]?.signalPercentile).toBe('number');
  });

  it('accepts empty riskIndicators/rewardIndicators arrays and omitted optional token-info fields', () => {
    const minimal = {
      chain: sample.chain,
      address: sample.address,
      riskIndicators: [],
      rewardIndicators: [],
      source: sample.source,
      fetchedAt: sample.fetchedAt,
    };
    expect(() => TokenRiskScoreSchema.parse(minimal)).not.toThrow();
  });

  it('rejects an indicator entry whose signal is a string (would break the number contract)', () => {
    const invalid = {
      ...sample,
      riskIndicators: [{ indicatorType: 'liquidity-risk', signal: '0.75' }],
    };
    expect(() => TokenRiskScoreSchema.parse(invalid)).toThrow();
  });

  it('rejects an unknown field (.strict())', () => {
    expect(() => TokenRiskScoreSchema.parse({ ...sample, extra: 'nope' })).toThrow();
  });
});
