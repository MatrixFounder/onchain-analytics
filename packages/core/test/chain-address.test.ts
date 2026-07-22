import { describe, expect, it } from 'vitest';
import { isValidAddress, normalizeAddress } from '../src/chain/address.js';

// Official EIP-55 test vectors (https://eips.ethereum.org/EIPS/eip-55) — each string below is
// already the correct mixed-case checksum for its own lowercase form.
const EIP55_VECTORS = [
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
];

describe('normalizeAddress / isValidAddress — ethereum (EIP-55)', () => {
  it.each(EIP55_VECTORS)(
    'produces the canonical checksum for %s regardless of input case',
    (checksummed) => {
      expect(normalizeAddress('ethereum', checksummed)).toBe(checksummed);
      expect(normalizeAddress('ethereum', checksummed.toLowerCase())).toBe(checksummed);
      // Upper-casing the whole string (including the '0x' prefix) and then lower-casing just the
      // prefix back exercises a mixed input the checksum algorithm did not itself produce.
      const shouted = `0x${checksummed.slice(2).toUpperCase()}`;
      expect(normalizeAddress('ethereum', shouted)).toBe(checksummed);
    },
  );

  it('validates well-formed hex addresses regardless of case', () => {
    for (const v of EIP55_VECTORS) {
      expect(isValidAddress('ethereum', v)).toBe(true);
      expect(isValidAddress('ethereum', v.toLowerCase())).toBe(true);
      expect(isValidAddress('ethereum', v.toUpperCase())).toBe(true);
    }
  });

  it('accepts a missing 0x prefix (body-only hex)', () => {
    const [checksummed] = EIP55_VECTORS;
    expect(checksummed).toBeDefined();
    const body = (checksummed as string).slice(2);
    expect(normalizeAddress('ethereum', body)).toBe(checksummed);
    expect(isValidAddress('ethereum', body)).toBe(true);
  });

  it('rejects an address that is too short', () => {
    const short = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1Be'; // 38 hex chars
    expect(isValidAddress('ethereum', short)).toBe(false);
    expect(() => normalizeAddress('ethereum', short)).toThrow();
  });

  it('rejects an address that is too long', () => {
    const long = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAedFF'; // 42 hex chars
    expect(isValidAddress('ethereum', long)).toBe(false);
    expect(() => normalizeAddress('ethereum', long)).toThrow();
  });

  it('rejects non-hex characters', () => {
    const notHex = '0xZZZZb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    expect(isValidAddress('ethereum', notHex)).toBe(false);
    expect(() => normalizeAddress('ethereum', notHex)).toThrow();
  });
});

describe('normalizeAddress / isValidAddress — solana (base58, case-sensitive)', () => {
  const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111'; // 32 zero bytes
  const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'; // real 32-byte pubkey

  it('returns valid base58 addresses unchanged (no case normalization)', () => {
    expect(normalizeAddress('solana', SYSTEM_PROGRAM_ID)).toBe(SYSTEM_PROGRAM_ID);
    expect(normalizeAddress('solana', SPL_TOKEN_PROGRAM_ID)).toBe(SPL_TOKEN_PROGRAM_ID);
  });

  it('validates addresses that decode to exactly 32 bytes', () => {
    expect(isValidAddress('solana', SYSTEM_PROGRAM_ID)).toBe(true);
    expect(isValidAddress('solana', SPL_TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('rejects a decoded length other than 32 bytes', () => {
    const truncated = SPL_TOKEN_PROGRAM_ID.slice(0, -6);
    expect(isValidAddress('solana', truncated)).toBe(false);
    expect(() => normalizeAddress('solana', truncated)).toThrow();
  });

  it('rejects strings that are not valid base58 (0/O/I/l are excluded from the alphabet)', () => {
    expect(isValidAddress('solana', '0OIl-not-base58')).toBe(false);
    expect(() => normalizeAddress('solana', '0OIl-not-base58')).toThrow();
  });

  it('preserves the exact case of a mixed-case address (no lowercasing, unlike EVM)', () => {
    // SPL_TOKEN_PROGRAM_ID already mixes upper/lowercase letters — asserting an exact `toBe`
    // (not just "is valid") proves normalizeAddress never folds case for this chain.
    expect(normalizeAddress('solana', SPL_TOKEN_PROGRAM_ID)).toBe(SPL_TOKEN_PROGRAM_ID);
    expect(SPL_TOKEN_PROGRAM_ID.toLowerCase()).not.toBe(SPL_TOKEN_PROGRAM_ID);
  });
});

describe('normalizeAddress / isValidAddress — dash (not validated in M1, contract)', () => {
  it('isValidAddress always returns false', () => {
    expect(isValidAddress('dash', 'anything')).toBe(false);
    expect(isValidAddress('dash', '')).toBe(false);
  });

  it('normalizeAddress always throws', () => {
    expect(() => normalizeAddress('dash', 'anything')).toThrow();
  });
});
