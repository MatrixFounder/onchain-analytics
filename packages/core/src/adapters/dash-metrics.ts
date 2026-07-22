/**
 * Shared Dash Platform metric/asset vocabulary (D5 `Snapshot` type; DB-SCHEMA-CONCEPT §1 "one
 * metrics vocabulary — not free-form strings chosen ad hoc" convention). These exact ids are
 * reused **verbatim** from the pre-M0 `onchain-snapshotter` n8n workflow's own `Normalize` Code
 * node (`n8n-workflows/exported/onchain-snapshotter.json`), not invented here — so the M1 engine
 * (`platform-explorer`/`dash-platform` adapters) and the already-running n8n snapshotter agree on
 * the same metric ids for the same underlying `platform-explorer` fields, and `pg-history` reads
 * back exactly these ids from `onchain.snapshots` (DB-SCHEMA-CONCEPT §2).
 */
export const DASH_PLATFORM_ASSET = 'dash-platform';

export const DASH_METRIC = {
  identitiesTotal: 'identities_total',
  documentsTotal: 'documents_total',
  dataContractsTotal: 'data_contracts_total',
  platformTotalCredits: 'platform_total_credits',
  shieldedPoolBalanceCredits: 'shielded_pool_balance_credits',
  // History-only proxy metric (documented implementation choice, developer-guidelines §1.6):
  // platform-explorer has no "pool balance over time" endpoint as of 2026-07 (confirmed by a
  // live route-list probe of packages/api/src/routes.js in the pshenmic/platform-explorer repo,
  // 2026-07-22) — only per-transition shield/unshield AMOUNT history series exist
  // (`/transactions/shield/history`). `privacy.shielded_pool.history` uses that shield-inflow
  // series as its representative time series; it is NOT the same quantity as
  // `shieldedPoolBalanceCredits` (a running balance) and is named distinctly to avoid implying
  // otherwise.
  shieldedPoolShieldAmount: 'shielded_pool_shield_amount',
} as const;
