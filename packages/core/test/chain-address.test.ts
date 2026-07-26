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

describe('normalizeAddress / isValidAddress — families without a validator (TASK-006 R-55c)', () => {
  // CHANGED EXPECTATION (task 006-3). Before TASK-006 `dash` was hardcoded to reject: isValidAddress
  // returned false and normalizeAddress threw unconditionally. It is now `family: 'other'`, and a
  // family with no validator ACCEPTS without canonicalizing. Refusing would mean "unsupported until
  // someone writes a parser" — the chain-equals-code coupling this task removes. Safe in practice:
  // no MCP tool accepted `dash` (their enum was ethereum|solana) and dash-platform emits Snapshot,
  // not Wallet/Balance, so nothing on the live paths changes behaviour.
  it('accepts a non-empty address as-is instead of refusing service', () => {
    expect(isValidAddress('dash', 'anything')).toBe(true);
    expect(normalizeAddress('dash', 'anything')).toBe('anything');
  });

  it('still rejects an empty address', () => {
    expect(isValidAddress('dash', '')).toBe(false);
  });

  it('bounds the length of an unvalidated address before it can reach a cache key', () => {
    expect(isValidAddress('dash', 'x'.repeat(129))).toBe(false);
    expect(isValidAddress('dash', 'x'.repeat(128))).toBe(true);
  });

  it('does not canonicalize, so case is preserved verbatim', () => {
    expect(normalizeAddress({ family: 'move' }, 'AbCdEf')).toBe('AbCdEf');
    expect(normalizeAddress({ family: 'cosmos' }, 'cosmos1AbC')).toBe('cosmos1AbC');
    expect(isValidAddress({ family: 'utxo' }, 'bc1qxyz')).toBe(true);
  });
});

describe('normalizeAddress / isValidAddress — dispatch is by FAMILY, not chain name (R-55a/b)', () => {
  const VITALIK_LOWER = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';

  it('applies EIP-55 to every EVM chain, not only to Ethereum', () => {
    const viaLegacyName = normalizeAddress('ethereum', VITALIK_LOWER);
    const viaBerachain = normalizeAddress({ family: 'evm' }, VITALIK_LOWER);
    expect(viaBerachain).toBe(viaLegacyName);
    expect(viaBerachain).not.toBe(VITALIK_LOWER); // checksum casing actually applied
  });

  it('validates an EVM address identically whichever EVM chain it belongs to', () => {
    expect(isValidAddress({ family: 'evm' }, VITALIK_LOWER)).toBe(true);
    expect(isValidAddress({ family: 'evm' }, 'not-an-address')).toBe(false);
  });

  it('keeps svm case-sensitive (base58), unlike evm', () => {
    const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    // The property that matters is that `svm` does NOT canonicalize case: lowercasing a base58
    // string yields a DIFFERENT address (often still a decodable one — base58's alphabet contains
    // both cases), which is precisely why lowercasing would corrupt it. Contrast with `evm`,
    // where both cases collapse to the identical checksum form.
    expect(normalizeAddress({ family: 'svm' }, SPL)).toBe(SPL);
    expect(normalizeAddress({ family: 'svm' }, SPL.toLowerCase())).not.toBe(SPL);

    const EVM_LOWER = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
    expect(normalizeAddress({ family: 'evm' }, EVM_LOWER)).toBe(
      normalizeAddress({ family: 'evm' }, EVM_LOWER.toUpperCase().replace('0X', '0x')),
    );
  });
  // --- adversarial review cycle 1 (security F-3): base58 is O(n^2); bound before decoding ---
  it('rejects an over-long solana address without attempting an O(n^2) base58 decode', () => {
    // Reached with VENDOR-supplied strings via normalize.ts, where nothing else bounds the size.
    // A ~1MB base58-alphabet string would otherwise hang this single-threaded server.
    const huge = '1'.repeat(200_000);
    const started = Date.now();
    expect(isValidAddress('solana', huge)).toBe(false);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('still accepts a legitimate solana address (the guard is slack, not a tight fit)', () => {
    expect(isValidAddress('solana', 'Vote111111111111111111111111111111111111111')).toBe(true);
  });
});
