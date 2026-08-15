import { describe, expect, it } from 'vitest';
import { ULID_LENGTH, UlidTimeOutOfRangeError, ulid } from '../src/ulid.js';

/**
 * Task 014-07 — the identifier every row this engine writes carries (DB-SCHEMA §1.3).
 *
 * Twenty lines of code deciding the primary key of `users`, `api_tokens`, `access_audit`,
 * `request_trace` and `diagnostics`, so the properties are measured rather than assumed.
 */

const fixedEntropy = (byte: number) => (): Uint8Array => Uint8Array.from(Array(16).fill(byte));

describe('ULID', () => {
  it('is 26 characters over Crockford base32', () => {
    const value = ulid(1_770_000_000_000, fixedEntropy(0));
    expect(value).toHaveLength(ULID_LENGTH);
    expect(value).toHaveLength(26);
    expect(value).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // The excluded letters are the point: an operator reads these out of a log and types them into
    // a WHERE clause, and I/1 and O/0 are the pairs that get transcribed wrong.
    expect(value).not.toMatch(/[ILOU]/);
  });

  it('sorts by creation time as text — the property `ORDER BY id` relies on', () => {
    const earlier = ulid(1_770_000_000_000, fixedEntropy(31));
    const later = ulid(1_770_000_000_001, fixedEntropy(0));
    // Note the entropy is REVERSED between the two: if the time prefix did not dominate, the
    // higher-entropy earlier value would sort last and `listUsers`' ordering would be random.
    expect(earlier < later).toBe(true);
    expect([later, earlier].sort()).toStrictEqual([earlier, later]);
  });

  it('encodes the timestamp reversibly in the first ten characters', () => {
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const decode = (value: string): number =>
      [...value.slice(0, 10)].reduce((acc, char) => acc * 32 + ALPHABET.indexOf(char), 0);
    for (const ms of [0, 1, 1_770_000_000_000, 281_474_976_710_655]) {
      expect(decode(ulid(ms, fixedEntropy(0)))).toBe(ms);
    }
  });

  it('refuses a timestamp 48 bits cannot carry, rather than truncating it', () => {
    // A silent truncation would produce a valid-looking id that sorts before every id minted since
    // the epoch — the failure would surface as a mis-ordered journal, years later.
    expect(() => ulid(281_474_976_710_656, fixedEntropy(0))).toThrow(UlidTimeOutOfRangeError);
    expect(() => ulid(-1, fixedEntropy(0))).toThrow(UlidTimeOutOfRangeError);
    expect(() => ulid(1.5, fixedEntropy(0))).toThrow(UlidTimeOutOfRangeError);
  });

  it('maps every byte value to a symbol without bias', () => {
    // 256 is exactly eight times 32, so each symbol is reachable from exactly eight byte values.
    // Over the whole byte range each symbol must therefore appear the same number of times; an
    // alphabet size that did not divide 256 would favour its first symbols invisibly.
    const counts = new Map<string, number>();
    for (let byte = 0; byte < 256; byte += 1) {
      const symbol = ulid(0, () => Uint8Array.from(Array(16).fill(byte))).slice(10, 11);
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
    expect(counts.size).toBe(32);
    expect([...new Set(counts.values())]).toStrictEqual([8]);
  });

  it('differs between two calls at the same instant', () => {
    const values = new Set(Array.from({ length: 200 }, () => ulid(1_770_000_000_000)));
    // 80 bits of randomness; a collision in 200 draws would mean the entropy source is not one.
    expect(values.size).toBe(200);
  });
});
