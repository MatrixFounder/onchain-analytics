import { randomBytes } from 'node:crypto';

/**
 * ULID as `TEXT` — the identifier form DB-SCHEMA §1.3 requires of every row this engine writes.
 *
 * **Why the application generates ids and not the engine.** The schema ships on two engines, and a
 * server-side default cannot own an identifier that has to survive a move between them: `bigserial`
 * restarts, `gen_random_uuid()` exists in one dialect, and either would make "copy the rows across"
 * a project rather than an operation. An id minted here is globally unique before any statement runs
 * and means the same thing on either side.
 *
 * **Why ULID and not UUIDv4.** The first 48 bits are the timestamp, so the value sorts by creation
 * time as text. `access_audit` is read in order (§4.5.5) and `request_trace` is read by time window;
 * with a random id both would need the index the sort order gives for free.
 *
 * **Why it is written here rather than taken from npm.** It is twenty lines over `node:crypto`, and
 * the alternative is a dependency on the identifier of every row the engine will ever store —
 * ADR-001 D12's supply-chain caution applied to the smallest possible surface.
 */

/**
 * Crockford's base32: no `I`, `L`, `O` or `U`.
 *
 * The exclusions are the point — an operator reads these ids out of a log and types them into a
 * `WHERE` clause, and `I`/`1` and `O`/`0` are the pairs that get transcribed wrong.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const TIME_CHARS = 10; // 48 bits
const RANDOM_CHARS = 16; // 80 bits
export const ULID_LENGTH = TIME_CHARS + RANDOM_CHARS;

/** The largest epoch-ms 48 bits can carry — year 10889. A value past it would silently truncate. */
const MAX_TIME_MS = 281_474_976_710_655;

export class UlidTimeOutOfRangeError extends RangeError {
  constructor(readonly presented: number) {
    super(`ULID timestamp must be an integer in [0, ${MAX_TIME_MS}] — got ${presented}`);
    this.name = 'UlidTimeOutOfRangeError';
  }
}

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME_MS) throw new UlidTimeOutOfRangeError(ms);
  let out = '';
  let value = ms;
  for (let index = 0; index < TIME_CHARS; index += 1) {
    out = `${ALPHABET[value % 32] ?? ''}${out}`;
    value = Math.floor(value / 32);
  }
  return out;
}

/**
 * Sixteen characters over 80 bits of randomness.
 *
 * **`byte % 32` is unbiased here, and that is arithmetic rather than luck:** 256 is exactly eight
 * times 32, so every symbol is reachable from exactly eight byte values. The same expression over an
 * alphabet whose size did not divide 256 would quietly favour its first symbols — the modulo-bias
 * defect, which is invisible in output and fatal in an identifier.
 */
function encodeRandom(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < RANDOM_CHARS; index += 1) {
    out += ALPHABET[(bytes[index] ?? 0) % 32] ?? '';
  }
  return out;
}

/**
 * One ULID for the given instant.
 *
 * Both the clock and the entropy source are parameters: a test needs a value it can predict, and a
 * caller that already has the row's `created_at` should not read the clock a second time and get a
 * different millisecond into the id than into the column.
 */
export function ulid(nowMs: number, entropy: (size: number) => Uint8Array = randomBytes): string {
  return `${encodeTime(nowMs)}${encodeRandom(entropy(RANDOM_CHARS))}`;
}
