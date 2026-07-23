/**
 * Shared helper (post-M1 polish, cheap-fix backlog item 5) — `JSON.stringify`s an arbitrary value
 * for inclusion in an `Error` message, but never lets that string grow unbounded. `rpc-evm`'s and
 * `rpc-solana`'s own error paths used to embed the ENTIRE raw JSON-RPC response envelope
 * (`JSON.stringify(raw)`) directly into a thrown error's message — up to `safeFetch`'s own
 * `DEFAULT_MAX_RESPONSE_BYTES` (10MB, `net/safe-fetch.ts`) if a misbehaving or malicious endpoint
 * sent a huge body, since neither adapter bounded the stringified payload before embedding it.
 *
 * Bounds the stringified payload to `maxLen` characters (default 500), appending the
 * `…[truncated]` marker ONLY when actual truncation happened (never appended to an
 * already-short string, so a normal, small payload's error message is unchanged).
 */
const DEFAULT_MAX_LEN = 500;
const TRUNCATION_MARKER = '…[truncated]';

export function stringifyTruncated(value: unknown, maxLen: number = DEFAULT_MAX_LEN): string {
  const full = JSON.stringify(value);
  if (full.length <= maxLen) return full;
  return `${full.slice(0, maxLen)}${TRUNCATION_MARKER}`;
}
