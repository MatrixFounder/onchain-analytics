---
id: L-3
type: known-issue
status: fixed
opened_at: 2026-07-27
category: logic
severity: SEV-2
slug: l-3-verify-staleness-detector-is-permanently-red-and-names-no-metric
component: onchain-verify
evidence_paths:
  - n8n-workflows/exported/onchain-verify.json
  - sql/migrations/001_init.sql
resolved_at: 2026-07-27
resolved_by: migration 003 (per-metric max_staleness_ms) + a registry-driven, metric-naming verify query
---

> **RESOLVED 2026-07-27.** Staleness moved out of the workflow's SQL and into the metrics registry,
> where it is a property of each metric on its own clock. The report now names its offenders, and the
> ✅ branch is reachable for the first time. Details at the end of this file.

# L-3 — `onchain-verify`'s staleness detector is permanently red by construction, and names no metric

**Symptom.** The daily verify report has been ⚠️ on **every** run since the two-clock model shipped,
for a reason that is not a defect — and a genuine four-day data gap ([L-2](l-2-snapshotter-drops-a-metric-silently-dropped-array-never-leaves-the-node.md))
passed through it invisibly.

**Mechanism 1 — one threshold for two clocks.** `Verify query` applies a single 2-hour bound to
`max(ts)` per metric:

```sql
(SELECT count(*) FROM latest WHERE max_ts < (extract(epoch from now())*1000)::bigint - 7200000)
  AS stale_metrics
```

But `zec_shielded_supply` / `zec_total_supply` are **daily aggregates keyed on the ZecHub close date
at UTC midnight** — by design, per the two-clock model (DB-SCHEMA §1/§8, and the snapshotter's own
Overview sticker). Their `ts` is a date, not a fetch time, so it is *always* more than two hours old.
They can never satisfy this threshold. `stale_metrics ≥ 2` is therefore a permanent floor, `ok` is
permanently false, and the ✅ branch of `Format report` is **unreachable**.

Measured 2026-07-27 (`stale_metrics = 3`):

| metric | last seen (UTC) | stale? |
|---|---|---|
| `shielded_pool_balance_credits` | 2026-07-23 09:00:40 | **real gap** |
| `zec_shielded_supply` | 2026-07-26 00:00:00 | by design |
| `zec_total_supply` | 2026-07-26 00:00:00 | by design |

The real gap moved a scalar from 2 to 3 inside an already-⚠️ message. Nothing about the report on
2026-07-23 looked different from the report on 2026-07-22.

**Mechanism 2 — the report counts, it does not name.** `Format report` emits
`'stale (>2h): ' + r.stale_metrics` — a number. Even a reader who noticed 2→3 has nothing in the
message identifying *which* metric, and no reason to suspect the count is not just the usual two.

**Mechanism 3 — `metrics_seen` can never fall.** The other gate,
`metrics_seen === metrics_registered` (11/11 today), is built from
`SELECT metric, max(ts) FROM onchain.snapshots GROUP BY metric` — all of history. A metric that has
ever been written stays counted forever, so this check **cannot** detect a metric that *stops*. It
only catches one that was never written at all.

All three together: the workflow whose entire purpose is to notice data problems could not have
noticed this one, and its alarm was already sounding for an unrelated reason.

**Fix direction.** Staleness is per-metric cadence, so the threshold belongs with the metric, not as
a literal in the query — that is what the registry is for (*"One metrics vocabulary"*, DB-SCHEMA §1).
`onchain.metrics` currently has no cadence column (`id, unit, kind, description, gameability,
source_priority`; `kind` is `state` for all 11), so this needs an additive migration — e.g.
`max_staleness_ms INTEGER` — and the query joins it instead of hardcoding `7200000`. Daily
aggregates get a bound on their own clock (a close-date metric is late when the close date is two
days behind, not two hours). The report must then **name** the offending metrics, not count them;
`metrics_seen/metrics_registered` should stay, but as the "never seen" check it actually is.

**Found by:** manual query against `onchain.snapshots` while investigating L-2, 2026-07-27.

## Related

- [L-2](l-2-snapshotter-drops-a-metric-silently-dropped-array-never-leaves-the-node.md) — the gap this
  failed to surface. The two are one hole seen from both ends: the producer emits no signal, the
  monitor cannot express one. **Fixing either alone leaves the hole open.**
- `n8n-workflows/exported/onchain-verify.json` → nodes `Verify query`, `Format report`.
- DB-SCHEMA §1 (metrics registry as the single vocabulary), §8 (two-clock model).


## Resolution (2026-07-27)

**The threshold moved to where the metric is defined.** A migration added
`onchain.metrics.max_staleness_ms BIGINT` — additive, idempotent, no type change. (It has since been
folded into [`sql/migrations/001_init.sql`](../../sql/migrations/001_init.sql), which now seeds every
metric with its bound.) Bounds are set
per clock: **2h** for the hourly observations (8 dash-platform metrics + `zec_block_height`), **72h**
for the two ZecHub close-date aggregates.

**Why 72h and not 48h.** A day-D datum is published during D+1, so at any check the freshest is ~32h
old in steady state and ~56h after a one-day publication lag — and ZecHub's cadence is a community
wiki's, explicitly unaudited in its own registry `gameability` note. 48h would have re-created a
sometimes-red alarm, which is the failure this issue is about; 72h still catches a genuine multi-day
stall. The bound is deliberately generous because a false alarm here is not a cheap mistake — it is
the whole defect.

**The query is registry-driven and names its offenders.** It now iterates `onchain.metrics` (not the
`snapshots` history), compares each metric against its own bound, and returns names alongside counts:
`stale_names` reads `shielded_pool_balance_credits (94h > 2h)` — the age and the bound it broke.

**A third check that did not exist: `unbounded`.** A registry row with NULL `max_staleness_ms` is
reported as a defect rather than treated as healthy. This is what stops the issue from silently
recurring: metric #12 cannot be added without a cadence, because the absence is itself the alarm.

**`metrics_seen` was kept, but as the check it actually is.** Built from the registry with a
LEFT-JOIN-shaped subquery, it now means *registered but never written* (`never_seen`) — the only
thing it was ever able to detect. Staleness of a metric that *stops* is covered by the per-metric
bound, which finally works.

**Verification, on real data.** Run against the live DB before deployment, and the counter fell from
**3 → 1**: the two ZecHub daily metrics dropped out as false positives, and the one genuine gap
remained and was named. `metrics_seen 11/11`, `never_seen 0`, `unbounded 0`, `orphans 0`. The
`Format report` node was then exercised on that real row plus three synthetic states — all-clear
(**the ✅ branch, previously unreachable, now renders**), registry drift (unbounded + never-written +
orphans, each named), and a 400-metric pathological list to confirm the 3500-char guard fires before
Telegram's 4096 limit. Workflow validation: 0 errors, 0 warnings.

**Also fixed in passing:** the Telegram `Report` node read `{{ $json.text }}`; it now uses the
insert-safe `{{ $('Format report').first().json.text }}` per `CLAUDE.n8n.md`.

**Confirmed on the scheduled run** (execution 37565, 2026-07-27 08:07:16 UTC). `Verify query` and
`Format report` both succeeded and produced exactly the intended message against live data:

```
⚠️ onchain-verify (daily)
rows: 1091 · buckets: 132
metrics: 11/11 seen
latest: 2026-07-27 08:00 UTC
⏳ stale (age > registry bound): shielded_pool_balance_credits (95h > 2h)
```

One stale metric, named, with its age and the bound it broke — where the old detector would have
reported the bare count `3` with two of the three being by-design daily aggregates.

> **That message was never delivered.** The `Report` node then failed with HTTP 400: metric ids are
> snake_case and Telegram could not parse the underscores as entities. Naming the offenders — this
> issue's core requirement — is what triggered it. Filed and fixed as
> [L-4](l-4-telegram-entity-parsing-400s-on-snake-case-metric-names-no-alert-delivered.md). The
> detector described here is `fixed`; the delivery path is L-4's to prove.

## Related

- [L-2](l-2-snapshotter-drops-a-metric-silently-dropped-array-never-leaves-the-node.md) — fixed in the
  same pass; the gap this detector failed to surface now also announces itself at the source.
