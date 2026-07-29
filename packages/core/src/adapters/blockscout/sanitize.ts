import { MAX_VENDOR_NAME_LENGTH, truncateVendorText } from '../truncate-vendor-text.js';

/**
 * TASK-008 task 008-3 (R-76) — the mandatory sanitizing entry point for every Blockscout response.
 *
 * **Why this vendor gets a dedicated module when the others do not.** Elsewhere in this codebase the
 * prompt-injection risk is incidental: DeFiLlama returns protocol names that *happen* to be
 * third-party-editable and *happen* to reach a model. Blockscout ships a field called
 * `instructions` whose contents are imperative English addressed to a language model — measured
 * 2026-07-28 on `get_address_info`, seven entries of the form "This is only the native coin
 * balance. **You MUST also call** `get_tokens_by_address` to get the full portfolio", with the
 * caller's own address interpolated into them verbatim. The vendor is not leaking text at a model;
 * it is deliberately speaking to one. That is a channel, and a channel is closed, not shortened.
 *
 * **Dropped, never truncated.** A truncated instruction is still an instruction — "IGNORE PREVIOUS
 * INSTRUCTIONS AND…" survives a 500-character cap intact. Truncation is the right tool for a
 * vendor-authored *name* we intend to show; it is the wrong tool for a field whose entire purpose
 * is to direct behaviour.
 *
 * **The rule is enforced by the type system, not by discipline.** `normalize()` accepts only
 * `SanitizedBlockscoutBody`, which nothing but `sanitizeBlockscoutBody()` can produce. A future
 * refactor cannot route a raw response around this module without the compiler objecting — which is
 * the difference between a rule and a convention. Conventions end at the third refactor.
 */

declare const sanitizedBrand: unique symbol;

/**
 * A response body that has passed through `sanitizeBlockscoutBody()`. Structurally it is still
 * `unknown` — the brand carries no runtime cost and exists purely so the compiler can tell
 * "checked" from "raw".
 */
export type SanitizedBlockscoutBody = { readonly [sanitizedBrand]: true };

/**
 * Keys removed wherever they appear, at any depth.
 *
 * Two groups, for two different reasons:
 *
 * - **Model-directed text** (`instructions`, `notes`, `data_description`) — the channel above.
 * - **URL-valued label decoration** (`tooltipUrl`, `tagIcon`, `tooltipAttribution`) — a URL placed
 *   in a model's context is a suggestion to go fetch it, and these are vendor-supplied, so the
 *   destination is chosen by whoever authored the label. We render labels, not link farms.
 *
 * Removal is RECURSIVE rather than top-level-only on purpose. Today `instructions` sits at the root
 * of `get_address_info`; nothing in the vendor's contract promises it stays there, and a
 * top-level-only filter would silently stop working the day it moves one level down — failing open,
 * in the direction that puts vendor imperatives in front of a model.
 */
export const DROPPED_KEYS: readonly string[] = [
  'instructions',
  'notes',
  'data_description',
  'tooltipUrl',
  'tagIcon',
  'tooltipAttribution',
  // vdd-multi TASK-008, M-1: all three below are present in the COMMITTED fixtures and were not
  // being dropped. `tool_name` is the `pagination.next_call` directive — a machine-readable "call
  // this tool next", which is the same channel as `instructions` wearing a schema.
  'tooltipAttributionIcon',
  'tooltipDescription',
  'tool_name',
];

/**
 * Key patterns dropped in addition to the literal list.
 *
 * vdd-multi TASK-008, M-1. The literal list was matched with an exact, case- and
 * whitespace-sensitive `Set.has`, and the vendor's own recorded payload defeats it: every one of
 * the four committed fixtures ships **`"tagIcon "` with a trailing space**. The list's test could
 * not catch that, because it iterates `DROPPED_KEYS` and asserts each is absent — by construction
 * it can only ever prove the list matches itself.
 *
 * So keys are normalized (`trim().toLowerCase()`) before matching, and the classes are expressed as
 * patterns rather than as an enumeration the vendor is free to grow past. **A denylist in front of
 * a model fails open**; patterns narrow how far open. The classes:
 *
 * - `tooltip*` / `*description` / `notes` — prose addressed to a reader, i.e. the channel.
 * - `*url` / `*icon` — a URL in a model's context is a suggestion to go fetch it, and the
 *   destination is chosen by whoever authored the label.
 *
 * None of these can collide with a field we read: the normalizers touch `hash`, `value`,
 * `value_truncated`, `token_id`, `is_contract`, `is_scam`, `items`, `next_page_params`,
 * `pagination`, `metadata`, `tags`, `name`, `tagType` and `ordinal` — checked against this list,
 * and asserted by the round-trip tests on the real fixtures.
 */
const DROPPED_PATTERNS: readonly RegExp[] = [/^tooltip/, /description$/, /url$/, /icon$/];

const DROPPED = new Set(DROPPED_KEYS.map((key) => key.toLowerCase()));

/** Keys that must never be assigned during reconstruction, whatever the vendor sends (L-3). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isDropped(key: string): boolean {
  // Iteration 2 (security M-1): `trim().toLowerCase()` alone left visually identical bypasses of
  // every entry and every pattern — `"instructions\u200B"` (U+200B is NOT ECMAScript WhiteSpace, so
  // `trim()` keeps it, unlike U+FEFF which it strips), `"in\u00ADstructions"` (soft hyphen),
  // fullwidth `"ｉｎｓｔｒｕｃｔｉｏｎｓ"` (`toLowerCase` is not NFKC), `"İnstructions"` (U+0130 lowercases to
  // `i` + U+0307). Each renders the same to a reader and carries the same imperative payload.
  // NFKC folds the width/compatibility forms; stripping format and space characters folds the
  // invisible ones — the same generalization that `"tagIcon "` should have prompted one level up.
  const normalized = key
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Zs}\s]/gu, '')
    .toLowerCase();
  if (DROPPED.has(normalized)) return true;
  return DROPPED_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Depth bound. A pathological or hostile body cannot turn sanitization into a stack overflow; past
 * this depth the subtree is dropped entirely rather than passed through unchecked — refusing to
 * emit is the safe direction, since anything we cannot inspect is exactly what must not reach a
 * model. Real Blockscout bodies nest ~5 deep (`data.metadata.tags[].meta.*`).
 */
const MAX_DEPTH = 24;

function strip(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((item) => strip(item, depth + 1));
  if (value === null || typeof value !== 'object') return value;

  // L-3: `Object.create(null)`, not `{}`. `JSON.parse` produces `__proto__` as an OWN property, so
  // `Object.keys` enumerates it and `out[key] = …` on a plain object fires the INHERITED setter —
  // the vendor would be choosing the reconstructed object's prototype instead of storing data
  // there, and every read downstream is inherited-aware bracket access (`row['value']`). The repo
  // already fixed this exact class in `net/args-hash.ts`; the reasoning transfers unchanged.
  //
  // M-11: `Object.keys` + indexed read rather than `Object.entries`, which allocates a 2-element
  // array per key on top of the outer array. `strip()` rebuilds every node even when nothing is
  // dropped, so at the response-size ceiling that is the difference between one and three
  // allocations per node, all of it immediate garbage on a single-threaded stdio server.
  const source = value as Record<string, unknown>;
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_KEYS.has(key) || isDropped(key)) continue;
    out[key] = strip(source[key], depth + 1);
  }
  return out;
}

/**
 * The only way to obtain a `SanitizedBlockscoutBody`. Call it once, on the raw parsed body, before
 * anything else reads it.
 */
export function sanitizeBlockscoutBody(raw: unknown): SanitizedBlockscoutBody {
  return strip(raw, 0) as SanitizedBlockscoutBody;
}

/** Reads a sanitized body back as plain data. Deliberately the only widening cast in this module. */
export function asPlain(body: SanitizedBlockscoutBody): unknown {
  return body as unknown;
}

/**
 * One entry of Blockscout's `metadata.tags[]`, reduced to what a canonical `EntityLabel` needs.
 * `tagType` is the vendor's own discriminator, observed as `name` (a display label such as
 * "Binance: Hot Wallet") and `protocol` (an ecosystem tag such as "Sky").
 */
export interface BlockscoutTag {
  name: string;
  tagType: string;
  /**
   * The vendor's own display rank, higher first — observed `10` on curated display labels and `0`
   * on secondary OLI-sourced ones. Absent on rows that do not carry it (L-1).
   */
  ordinal: number;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Extracts label text from a sanitized body, bounded.
 *
 * Content bounding lives here rather than in `strip()` because the two jobs differ: `strip()`
 * removes CHANNELS and must not touch anything else (blanket string truncation would corrupt
 * addresses and transaction hashes, which are long by nature and exact by requirement), while this
 * bounds the specific vendor-authored strings we intend to surface. `MAX_VENDOR_NAME_LENGTH` is the
 * same cap the Nansen path already applies to the same class of text, so a label reaching a model
 * is bounded identically regardless of which provider answered — the point of a canonical type.
 *
 * `tagsAt` is the path to the array, given explicitly because the two Blockscout hosts disagree
 * about it: the facade nests labels under `data.metadata.tags`, the direct API under
 * `metadata.tags` (where, measured, it is usually `null`).
 */
export function extractTags(
  body: SanitizedBlockscoutBody,
  tagsAt: readonly string[],
): BlockscoutTag[] {
  let cursor: unknown = asPlain(body);
  for (const step of tagsAt) {
    if (cursor === null || typeof cursor !== 'object') return [];
    cursor = (cursor as Record<string, unknown>)[step];
  }
  if (!Array.isArray(cursor)) return [];

  const tags: BlockscoutTag[] = [];
  for (const entry of cursor) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const name = readString(row, 'name');
    if (name === undefined) continue;
    const ordinal = row['ordinal'];
    tags.push({
      name: truncateVendorText(name, MAX_VENDOR_NAME_LENGTH),
      tagType: truncateVendorText(readString(row, 'tagType') ?? 'unknown', MAX_VENDOR_NAME_LENGTH),
      // L-1: the vendor ranks its own tags and we were ignoring it, picking by array position while
      // the docstring argued their order "is its business, not ours". It is — which is exactly why
      // the rank it publishes is the thing to read. Rows without one sort last, never first, so a
      // missing rank cannot outrank a stated one.
      ordinal: typeof ordinal === 'number' && Number.isFinite(ordinal) ? ordinal : -1,
    });
  }
  return tags;
}
