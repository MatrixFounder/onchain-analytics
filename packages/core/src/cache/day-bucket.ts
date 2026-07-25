/**
 * `usage.day` bucketing (task 005-2, R-34, data-model.md §4.2): the epoch-ms UTC start of the
 * day `ts` falls in — `Math.floor(ts / 86_400_000) * 86_400_000`. A single shared export so the
 * budget gate (a later 005-x task) and any tool handler that surfaces `_meta.budget` compute the
 * SAME bucket boundary for the SAME instant, never two independently-hand-rolled copies of this
 * one-line formula. Pure UTC arithmetic — no local-timezone/DST logic, no `Date` object, matching
 * DB-SCHEMA-CONCEPT §1.2's "no string local dates, no DB time functions in application logic"
 * canon and mirroring the n8n snapshotter's own `ts_bucket = floor(ts/3600000)*3600000` pattern
 * (CLAUDE.n8n.md), just with an 86_400_000ms (day, not hour) bucket width.
 */
export function dayBucketMs(ts: number): number {
  return Math.floor(ts / 86_400_000) * 86_400_000;
}
