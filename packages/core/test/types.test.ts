import { describe, expect, it } from 'vitest';
import {
  BalanceSchema,
  ChainSchema,
  OhlcvSchema,
  PoolSchema,
  SnapshotSchema,
  TokenSchema,
  WalletSchema,
} from '../src/index.js';

describe('ChainSchema', () => {
  it('accepts ethereum, solana, and dash', () => {
    expect(ChainSchema.parse('ethereum')).toBe('ethereum');
    expect(ChainSchema.parse('solana')).toBe('solana');
    expect(ChainSchema.parse('dash')).toBe('dash');
  });

  it('rejects an unknown chain', () => {
    expect(() => ChainSchema.parse('bitcoin')).toThrow();
  });
});

describe('TokenSchema (R-1)', () => {
  const sample = {
    chain: 'ethereum',
    address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    priceUsd: 1.0,
    marketCapUsd: 32_000_000_000,
    source: 'coingecko',
    fetchedAt: Date.now(),
  };

  it('validates a well-formed Token', () => {
    expect(TokenSchema.parse(sample)).toEqual(sample);
  });

  it('accepts a Token with all optional fields omitted', () => {
    const required = {
      chain: sample.chain,
      address: sample.address,
      symbol: sample.symbol,
      name: sample.name,
      source: sample.source,
      fetchedAt: sample.fetchedAt,
    };
    expect(() => TokenSchema.parse(required)).not.toThrow();
  });

  it('rejects an unknown field (.strict())', () => {
    expect(() => TokenSchema.parse({ ...sample, extra: 'nope' })).toThrow();
  });
});

describe('BalanceSchema / WalletSchema (R-1)', () => {
  const balance = {
    assetType: 'native',
    symbol: 'ETH',
    decimals: 18,
    amountRaw: '1000000000000000000',
    amountNum: 1,
  };
  const wallet = {
    chain: 'ethereum',
    address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    balances: [balance],
    source: 'rpc-evm',
    fetchedAt: Date.now(),
  };

  it('validates a well-formed Balance', () => {
    expect(BalanceSchema.parse(balance)).toEqual(balance);
  });

  it('rejects a Balance with an unknown field (.strict())', () => {
    expect(() => BalanceSchema.parse({ ...balance, extra: 'nope' })).toThrow();
  });

  it('validates a well-formed Wallet, including its embedded balances array', () => {
    expect(WalletSchema.parse(wallet)).toEqual(wallet);
  });

  it('rejects a Wallet with an unknown field (.strict())', () => {
    expect(() => WalletSchema.parse({ ...wallet, extra: 'nope' })).toThrow();
  });

  it('rejects a Wallet whose amountRaw would lose precision if parsed as a number', () => {
    // amountRaw carries the exact integer as a string (DB-SCHEMA-CONCEPT §1.7) — it must survive
    // validation unchanged, never coerced to a lossy JS number.
    const bigAmount = '123456789012345678901234567890';
    const parsed = BalanceSchema.parse({ ...balance, amountRaw: bigAmount });
    expect(parsed.amountRaw).toBe(bigAmount);
    expect(typeof parsed.amountRaw).toBe('string');
  });
});

describe('PoolSchema (R-1)', () => {
  const pool = {
    id: 'ethereum:0xPAIR',
    chain: 'ethereum',
    dexId: 'uniswap-v3',
    baseTokenSymbol: 'WETH',
    quoteTokenSymbol: 'USDC',
    pairAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    createdAt: Date.now(),
    liquidityUsd: 1_000_000,
    volume24hUsd: 250_000,
    source: 'dexscreener',
    fetchedAt: Date.now(),
  };

  it('validates a well-formed Pool', () => {
    expect(PoolSchema.parse(pool)).toEqual(pool);
  });

  it('rejects an unknown field (.strict())', () => {
    expect(() => PoolSchema.parse({ ...pool, extra: 'nope' })).toThrow();
  });
});

describe('OhlcvSchema (R-1, reserved type)', () => {
  const candle = {
    chain: 'ethereum',
    pairAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    ts: Date.now(),
    open: 1.0,
    high: 1.1,
    low: 0.9,
    close: 1.05,
    volumeUsd: 100_000,
    source: 'dexscreener',
  };

  it('validates a well-formed OHLCV candle', () => {
    expect(OhlcvSchema.parse(candle)).toEqual(candle);
  });

  it('rejects an unknown field (.strict())', () => {
    expect(() => OhlcvSchema.parse({ ...candle, extra: 'nope' })).toThrow();
  });
});

describe('SnapshotSchema (R-2)', () => {
  const snapshot = {
    metric: 'zec_shielded_supply',
    asset: 'zec',
    ts: Date.now(),
    valueRaw: '1234567890123456789',
    valueNum: 1234567890.12, // lossy display projection — deliberately not the exact valueRaw
    source: 'platform-explorer',
    height: 2_500_000,
  };

  it('validates a well-formed Snapshot (metric, asset, ts, valueRaw, valueNum?, source, height?)', () => {
    expect(SnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('accepts a Snapshot with valueNum and height omitted', () => {
    const { valueNum: _valueNum, height: _height, ...required } = snapshot;
    void _valueNum;
    void _height;
    expect(() => SnapshotSchema.parse(required)).not.toThrow();
  });

  it('round-trips through JSON serialization without losing valueRaw precision', () => {
    const parsed = SnapshotSchema.parse(snapshot);
    const roundTripped = SnapshotSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(snapshot);
  });

  it('keeps valueRaw a string for integers beyond Number.MAX_SAFE_INTEGER (DB-SCHEMA §1.7)', () => {
    const bigValue = '123456789012345678901234567890';
    const parsed = SnapshotSchema.parse({ ...snapshot, valueRaw: bigValue });
    expect(parsed.valueRaw).toBe(bigValue);
    expect(typeof parsed.valueRaw).toBe('string');
  });

  it('rejects an unknown field (.strict())', () => {
    expect(() => SnapshotSchema.parse({ ...snapshot, extra: 'nope' })).toThrow();
  });
});
