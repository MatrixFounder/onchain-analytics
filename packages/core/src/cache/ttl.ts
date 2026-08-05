import { capabilityManifests } from '../capability-manifest.js';

/**
 * Safety net for a capability string that has no manifest row — kept explicit (a conservative
 * mid-range default, the `protocol.tvl` bucket) rather than throwing, so an unanticipated capability
 * degrades gracefully instead of crashing the cache path.
 *
 * **Unreachable for the 20 ROUTED capabilities since task 012-5 — by a mechanism, not by
 * discipline.** This constant's previous docstring said it "should not be hit for M1's known
 * capability set". That was a hope, and it was disappointed three times: all three of M2's PAID
 * capabilities shipped falling through to it (found by two adversarial critics, not by a test), then
 * `dex.volume.history` did. What closes it now is `CapabilityRegistry`'s construction-time
 * validation step 1 (`adapters/registry.ts`, task 012-4): a route whose capability has no
 * `capabilityManifests` entry throws `MissingCapabilityManifestError` before the process serves
 * anything, so a routed capability cannot reach this line at all — the omission that used to produce
 * a silently-wrong TTL now produces a refusal to start.
 *
 * What can still reach it, and what it is therefore FOR: a capability string nothing routes — an
 * internal caller's typo, a probe, a capability retired from `routes` but still called somewhere.
 */
const DEFAULT_TTL_SECONDS = 300;

/**
 * Returns the TTL, in seconds, for `capability`.
 *
 * **A READER of the capability manifest since task 012-5 (R-138) — same name, same signature, same
 * export path.** The seconds and every one of their rationales live in `capability-manifest.ts`'s
 * `capabilityManifests`; the `TTL_SECONDS` table that used to sit in this file is gone, carried
 * there byte-for-byte by task 012-4 (its TC-UNIT-05 pins all 20 against a list transcribed BEFORE
 * the move, so a TTL edit disguised as a migration fails). Preserving this contract is what the
 * migration was measured by: `mcp-server/test/readme-tool-table.test.ts` imports exactly this symbol
 * from `@onchain-intel/core` and was not edited for it.
 *
 * The number is restated in five tables across three documents (both READMEs and
 * `docs/architectures/system-architecture.md` §3.2). Those restatements are not trusted to stay
 * true: WI-28's gate in `readme-tool-table.test.ts` checks each of them against this function, and
 * §3.2 must additionally carry a row for EVERY routed capability. `platform.*` there stands for the
 * five routed capabilities under that prefix, and the gate expands it that way.
 */
export function ttlFor(capability: string): number {
  return capabilityManifests[capability]?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
}

/**
 * TTL for a NEGATIVE cache entry — a deterministic `normalize()` failure recorded so the next
 * identical call does not pay for the same rejected response again (issue L-1).
 *
 * Deliberately short, and deliberately NOT per-capability — which is why it did **not** move into
 * the manifest with the positive TTLs above (task 012-5): the manifest is a per-capability table,
 * and this number is a property of the failure path, not of any capability. The two forces pull
 * opposite ways:
 *
 * - Longer is cheaper. `smart-money.flows` is 10cr per attempt and `entity.labels`' exhaustive tier
 *   is 100cr — the whole free-plan balance — so every second of negative TTL is money saved on a
 *   token the vendor genuinely has no row for.
 * - Shorter is safer. A negative entry is a cached *error*, and DF-1 proved an empty vendor
 *   response can also mean **our own request was malformed**. A long negative TTL would make a
 *   developer's fix appear not to work until it expired — the cache lying about a bug we just
 *   fixed. Sixty seconds is short enough that nobody debugs against a stale negative for long, and
 *   long enough to collapse an agent's retry storm from "per attempt" to "once a minute".
 */
export const NEGATIVE_TTL_SECONDS = 60;
