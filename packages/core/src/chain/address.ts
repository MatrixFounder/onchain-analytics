import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import bs58 from 'bs58';
import type { Chain } from '../types/chain.js';

/** 40 hex chars, case-insensitive — an EVM address without its optional `0x`/`0X` prefix. */
const EVM_HEX_BODY_RE = /^[0-9a-fA-F]{40}$/;

/** Solana addresses decode to a raw ed25519 pubkey — exactly 32 bytes, no version/checksum byte
 * (unlike Bitcoin-style base58check). */
const SOLANA_ADDRESS_BYTE_LENGTH = 32;

function stripHexPrefix(raw: string): string {
  return raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
}

function isValidEvmHexBody(raw: string): boolean {
  return EVM_HEX_BODY_RE.test(stripHexPrefix(raw));
}

/**
 * EIP-55 checksum (ARCHITECTURE.md §4.1): `keccak256` of the lowercase hex address (without
 * `0x`, hashed as its ASCII bytes) decides, nibble-by-nibble, whether the corresponding hex
 * digit of the address is upper- or lower-cased in the output — digits (`0-9`) are never
 * case-shifted (only `a-f` carry case). This is a pure function of the address bytes: any input
 * case produces the identical result, which is exactly what makes the canonical form (and any
 * cache key derived from it) deterministic.
 */
function toEip55Checksum(lowerHexBody: string): string {
  const hashHex = bytesToHex(keccak_256(lowerHexBody));
  return Array.from(lowerHexBody)
    .map((char, i) => {
      if (char < 'a' || char > 'f') return char; // '0'-'9' pass through unchanged
      const nibble = Number.parseInt(hashHex.charAt(i), 16);
      return nibble >= 8 ? char.toUpperCase() : char;
    })
    .join('');
}

function normalizeEthereumAddress(raw: string): string {
  const body = stripHexPrefix(raw);
  if (!EVM_HEX_BODY_RE.test(body)) {
    throw new Error(`invalid ethereum address: ${raw}`);
  }
  return `0x${toEip55Checksum(body.toLowerCase())}`;
}

function isValidSolanaAddress(raw: string): boolean {
  try {
    return bs58.decode(raw).length === SOLANA_ADDRESS_BYTE_LENGTH;
  } catch {
    // bs58.decode throws on any character outside its alphabet (e.g. '0', 'O', 'I', 'l') —
    // that's an invalid address, not a validation-code bug.
    return false;
  }
}

function normalizeSolanaAddress(raw: string): string {
  if (!isValidSolanaAddress(raw)) {
    throw new Error(`invalid solana address: ${raw}`);
  }
  // base58 is case-sensitive (unlike hex) — the canonical form is the input itself, unchanged.
  return raw;
}

/**
 * Normalizes `raw` into its canonical form for `chain` (ARCHITECTURE.md §3.2/§4.1):
 * - `ethereum`: EIP-55 checksum (keccak256-derived), NOT lowercase (ADR-001 D5 explicitly
 *   requires checksum). A pure function of the address bytes — any input case yields the same
 *   canonical output, so the cache key is deterministic without a separate lowercase form.
 * - `solana`: returned as-is after validation (base58 is case-sensitive; lowercasing would
 *   corrupt the address).
 * - `dash`: not implemented in M1 (ARCHITECTURE.md §4.1) — always throws.
 *
 * @throws if `raw` is not a valid address for `chain` (same check as `isValidAddress`), or for
 * `chain === 'dash'` unconditionally.
 */
export function normalizeAddress(chain: Chain, raw: string): string {
  switch (chain) {
    case 'ethereum':
      return normalizeEthereumAddress(raw);
    case 'solana':
      return normalizeSolanaAddress(raw);
    case 'dash':
      throw new Error(
        'dash address normalization is not implemented in M1 (ARCHITECTURE.md §4.1) — dash-platform emits Snapshot, not Wallet/Balance',
      );
  }
}

/**
 * Validates `raw` as an address for `chain`, without throwing (ARCHITECTURE.md §3.2/§4.1):
 * - `ethereum`: valid 40-hex-char address (with or without a `0x`/`0X` prefix) — the checksum
 *   casing of the input is not itself part of the validity check (see `normalizeAddress`).
 * - `solana`: base58-decodable AND decodes to exactly 32 bytes.
 * - `dash`: always returns `false` in M1 — address validation is not implemented for it yet.
 */
export function isValidAddress(chain: Chain, raw: string): boolean {
  switch (chain) {
    case 'ethereum':
      return isValidEvmHexBody(raw);
    case 'solana':
      return isValidSolanaAddress(raw);
    case 'dash':
      return false;
  }
}
