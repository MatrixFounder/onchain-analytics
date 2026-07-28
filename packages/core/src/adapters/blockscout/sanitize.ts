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
];

const DROPPED = new Set(DROPPED_KEYS);

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

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (DROPPED.has(key)) continue;
    out[key] = strip(item, depth + 1);
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
    tags.push({
      name: truncateVendorText(name, MAX_VENDOR_NAME_LENGTH),
      tagType: truncateVendorText(readString(row, 'tagType') ?? 'unknown', MAX_VENDOR_NAME_LENGTH),
    });
  }
  return tags;
}
