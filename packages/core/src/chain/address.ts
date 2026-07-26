import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import bs58 from 'bs58';
import type { Chain } from '../types/chain.js';
import type { ChainFamily, ChainInfo, ChainRegistry } from './registry-core.js';
import { loadChainRegistry } from './registry.js';

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

/**
 * Hard upper bound applied BEFORE any base58 decode (adversarial cycle 1, security). base58
 * decoding is O(n²) in the input length, and this function is reached with **vendor-supplied**
 * strings via `normalize.ts` — where, unlike the inbound MCP tool path (which length-guards before
 * `isValidAddress`), nothing bounds the size. `safeFetch`'s size cap is `Content-Length`-based and
 * its own docstring concedes chunked responses are uncapped mid-stream, so a single response row
 * carrying a ~1 MB base58-alphabet string would burn ~10^12 inner operations on this
 * single-threaded stdio server — a full hang, after the credits for that call were already spent.
 * A real Solana address is 32 bytes ≈ 44 base58 chars; 128 is generous slack, not a tight fit.
 */
const MAX_DECODABLE_ADDRESS_LENGTH = 128;

function isValidSolanaAddress(raw: string): boolean {
  if (raw.length > MAX_DECODABLE_ADDRESS_LENGTH) return false;
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
 * The legacy chain names this module accepted before TASK-006, mapped to their family.
 *
 * **A migration bridge, removed in task 006-6.** Until adapters and tool handlers resolve the
 * registry themselves (tasks 006-5/006-6), ~20 call sites still hand these functions a bare chain
 * string. Rather than break every one of them in this task — or, worse, keep branching on chain
 * NAME to avoid doing so — the string arm is translated to a family here and nowhere else.
 */
const LEGACY_CHAIN_FAMILY: Readonly<Record<string, ChainFamily>> = {
  ethereum: 'evm',
  solana: 'svm',
  dash: 'other',
};

/** Either a resolved chain (anything carrying `family`) or a chain slug/alias (see above). */
export type AddressChain = Pick<ChainInfo, 'family'> | Chain;

/** Memoized registry for the string arm. An immutable lookup table built from a build artifact —
 * not the stateful singleton ARCHITECTURE.md §8 forbids — and it disappears with the bridge. */
let legacyRegistry: ChainRegistry | null = null;

function familyOf(chain: AddressChain): ChainFamily {
  if (typeof chain !== 'string') return chain.family;
  const legacy = LEGACY_CHAIN_FAMILY[chain];
  if (legacy) return legacy;
  // A slug outside the three legacy names. Falling back to `'other'` here would SILENTLY skip
  // EIP-55 canonicalization for e.g. 'berachain' — a wrong answer that looks like a right one, and
  // the worst possible failure mode for something that feeds a cache key. Resolve it instead.
  legacyRegistry ??= loadChainRegistry();
  return legacyRegistry.tryResolve(chain)?.family ?? 'other';
}

/**
 * Normalizes `raw` into its canonical form for the chain's FAMILY (TASK-006 R-55,
 * ARCHITECTURE.md §3.2/§4.1). Branching on family rather than on chain name is the whole point:
 * one `evm` branch now serves all 288 EVM chains in the registry instead of one chain.
 *
 * - `evm`: EIP-55 checksum (keccak256-derived), NOT lowercase (ADR-001 D5 explicitly requires
 *   checksum). A pure function of the address bytes — any input case yields the same canonical
 *   output, so the cache key is deterministic without a separate lowercase form.
 * - `svm`: returned as-is after validation (base58 is case-sensitive; lowercasing would corrupt
 *   the address).
 * - `move` / `cosmos` / `utxo` / `other`: **no validator, therefore no canonicalization** — the
 *   input is returned unchanged. Refusing instead would mean "we do not support this chain until
 *   someone writes it a parser", i.e. exactly the chain-equals-code coupling TASK-006 removes.
 *
 *   Its stated price: the cache key is then built from the raw string, so the same address in a
 *   different case yields TWO cache entries. That is lost cache efficiency, never lost
 *   correctness — the answers are identical. The trigger for writing a real validator is a PAID
 *   provider appearing on such a family, because only then does the split start costing money
 *   (OQ-1, resolved by default).
 *
 * @throws if `raw` is not a valid address for a family that HAS a validator (`evm`/`svm`).
 */
export function normalizeAddress(chain: AddressChain, raw: string): string {
  switch (familyOf(chain)) {
    case 'evm':
      return normalizeEthereumAddress(raw);
    case 'svm':
      return normalizeSolanaAddress(raw);
    default:
      return raw;
  }
}

/**
 * Validates `raw` as an address for the chain's FAMILY, without throwing (TASK-006 R-55):
 * - `evm`: valid 40-hex-char address (with or without a `0x`/`0X` prefix) — the checksum casing
 *   of the input is not itself part of the validity check (see `normalizeAddress`).
 * - `svm`: base58-decodable AND decodes to exactly 32 bytes.
 * - families without a validator: any non-empty string within `MAX_DECODABLE_ADDRESS_LENGTH` is
 *   accepted. The vendor answering "no such address" is a normal result, not a bug on our side.
 *   The two bounds are not new machinery — they are the sanity floor and the SAME cap already
 *   applied before base58 decoding, and they matter here because this function is also reached
 *   with vendor-supplied strings (`nansen/normalize.ts`) whose length nothing else bounds; an
 *   unbounded one would otherwise flow straight into a cache key.
 */
export function isValidAddress(chain: AddressChain, raw: string): boolean {
  switch (familyOf(chain)) {
    case 'evm':
      return isValidEvmHexBody(raw);
    case 'svm':
      return isValidSolanaAddress(raw);
    default:
      return raw.length > 0 && raw.length <= MAX_DECODABLE_ADDRESS_LENGTH;
  }
}
