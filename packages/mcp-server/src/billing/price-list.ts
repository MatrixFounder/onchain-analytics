/**
 * Task 015-05 — the price list: a compiled artifact, not a database table.
 *
 * Same class as the capability manifest (`packages/core/src/capability-manifest.ts`) and the chain
 * registry (`data-model.md` §4.2.1): a git-reviewed literal loaded into process memory, never a
 * runtime mutation nobody sees happen (`data-model.md` §4.6.2, R-4.1).
 *
 * This module is READ-ONLY by design. It exports a value (the price string) and a lookup function —
 * never a function that resolves an already-recorded `client_usage.price_raw` back through the
 * list. That absence is the mechanism behind AC-9 (`data-model.md` §4.6.2, "never re-read from the
 * list afterward"): once a price is copied into a ledger row at reserve time, there is nothing left
 * to re-read it with, so a later edit to `PRICE_LIST` cannot reach back and change history.
 */

/**
 * One credit per call, until a row in `PRICE_LIST` says otherwise (R-4.6, closes `ADR-003` OQ-1).
 * The fallback for any capability/tool absent from `PRICE_LIST` — including every key today, because
 * phase 0's list is intentionally empty (R-4.4).
 */
export const DEFAULT_PRICE_RAW = '1';

/**
 * capability-or-tool → price, as TEXT (`DB-SCHEMA-CONCEPT` §1.7, R-4.5): credits are exact integers
 * that can exceed the safe 2^53 of a JS `number`, the same reason `access_profiles.credits_balance_raw`
 * is TEXT. Never a `number` — a reserve compares two TEXT-encoded integers, not a TEXT and a number.
 *
 * Empty in phase 0 (R-4.4): every tool is priced through `DEFAULT_PRICE_RAW` uniformly. A future
 * entry overrides ONE key without touching `priceFor` or any of its callers — that flexibility, not
 * the number in this list, is what R-4.6/OQ-1 require.
 */
export const PRICE_LIST: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Resolves the price for one tool call. The lookup key is `capability ?? tool` (R-4.6,
 * `data-model.md` §4.6.2, "The lookup key is `capability ?? tool`"): `capability` is the tool's
 * STATIC declared capability — known before `resolve()` runs, unlike the dynamically resolved
 * `resolvedCapability` — or `null` for a tool that resolves no capability at all (`onchain_ping`,
 * `onchain_list_chains`), in which case the wire name of the tool is the only coordinate the price
 * can belong to.
 *
 * A key absent from `priceList` resolves to `DEFAULT_PRICE_RAW`.
 *
 * `priceList` defaults to the module's own `PRICE_LIST` and is a parameter only so a test can supply
 * a synthetic list — the same seam `CapabilityRegistry.manifests` already uses for the manifest map
 * (`data-model.md` §4.1, "M-6 correction"), not a configuration surface (R-13.3a: no `process.env`
 * read in this module or anywhere under `packages/core`).
 */
export function priceFor(
  capability: string | null,
  tool: string,
  priceList: Readonly<Record<string, string>> = PRICE_LIST,
): string {
  const key = capability ?? tool;
  return priceList[key] ?? DEFAULT_PRICE_RAW;
}
