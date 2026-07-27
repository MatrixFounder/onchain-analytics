---
id: L-2
type: known-issue
status: fixed
opened_at: 2026-07-27
category: logic
severity: SEV-3
slug: l-2-snapshotter-drops-a-metric-silently-dropped-array-never-leaves-the-node
component: onchain-snapshotter
evidence_paths:
  - n8n-workflows/exported/onchain-snapshotter.json
resolved_at: 2026-07-27
resolved_by: a Check dropped gate that runs after the writers and fails the execution by name
---

> **RESOLVED 2026-07-27.** `dropped` now has a reader: a **Check dropped** Code node, wired LAST in
> the chain, throws with the metric names when the array is non-empty — which reaches Telegram
> through the existing `errorWorkflow`. Details at the end of this file.

# L-2 — the snapshotter drops a metric silently: `dropped[]` is computed and then discarded

**Symptom.** `platform-explorer.pshenmic.dev/transactions/shielded/statistic` stopped returning the
`poolBalance` field after **2026-07-23 09:00 UTC**. The metric `shielded_pool_balance_credits` has
not been written since (60 rows, last `ts` 2026-07-23 09:00:40); the other seven `dash-platform`
metrics kept writing normally (129 rows each, last 2026-07-27 07:00:41). **Every hourly execution
in those four days succeeded.** Nobody noticed until the gap was found by hand on 2026-07-27 while
answering an unrelated question.

The current payload confirms the field is simply gone — not null, absent:

```json
{"totalShieldedIn":"9177409310440","totalShieldedOut":"2486234473095","transitionsCount":166,
 "types":[{"transactionType":"UNSHIELD", ...}]}
```

**Mechanism.** In the `Normalize` Code node, `mkRow()` guards against coercing `undefined` into the
string `'undefined'` for the NOT NULL `value_raw` — correct in itself — and records the casualty:

```js
if (valueRaw === undefined || valueRaw === null) { dropped.push(metric); return null; }
```

`dropped` is returned in the output item next to `count_append` / `count_upsert` /
`append_b64` / `upsert_b64`. The two Postgres writers read **only** `append_b64` and `upsert_b64`.
Nothing downstream ever reads `dropped`. The node throws only when append **and** upsert are both
empty — i.e. only when *every* source is dead. Losing 1 of 11 metrics is indistinguishable from a
clean run, from the outside and in the execution log.

**Why the blast radius was small this time — luck, not design.** This particular field is
recoverable by derivation: `poolBalance == totalShieldedIn − totalShieldedOut`, and the identity
holds exactly on the last snapshot carrying all three
(`5 745 740 261 400 = 6 280 849 228 400 − 535 108 967 000`). The registry even anticipates it —
`shielded_pool_balance_credits.gameability` already says *"hedge with net=(in-out)"*. A dropped field
with no such identity would be **gone for good**: the shielded-statistic endpoint serves current
state only, with no history to backfill from (`provider-matrix.md`: *"истории НЕТ — только current
state"*).

**Why this is a defect and not a nit.** It contradicts the project's own canon, twice over:
*"Nothing silently"* (`CLAUDE.md` → Working discipline; DB-SCHEMA §4), and the deliberate-error-mode
rule in `CLAUDE.n8n.md` — *"`continueRegularOutput` … bad when you want a loud alert"*. Here the
swallowing is not even a configured `onError` choice; it is a `push()` into an array with no reader.

**Fix direction.** `dropped` must leave the node. Either fail the execution when it is non-empty
(the `onchain-error-alert` Error Trigger already exists and is wired as `errorWorkflow`), or fan out
a non-empty `dropped` to the same Telegram channel. A partial-source outage is exactly the "partial
results, keep the workflow alive **and** say so" case — the rows that did arrive should still be
written, so a hard throw before the writers would be the wrong shape; the alert belongs on a sibling
branch.

**Found by:** manual query against `onchain.snapshots`, 2026-07-27.

## Related

- [L-3](l-3-verify-staleness-detector-is-permanently-red-and-names-no-metric.md) — the monitor that
  *should* have caught this. It technically did count the metric as stale for four days, but inside a
  report that had been permanently ⚠️ since the two-clock model shipped and that names no metric.
  L-2 is why the signal was never emitted at the source; L-3 is why the one downstream check that saw
  it could not say so. **Fixing either alone leaves the hole open.**
- `n8n-workflows/exported/onchain-snapshotter.json` → node `Normalize` (`mkRow` / `dropped`).


## Resolution (2026-07-27)

**A reader for `dropped`, placed where it cannot cost data.** A new Code node **Check dropped**
reads `$('Normalize').first().json.dropped` and throws when it is non-empty, naming every metric and
stating what *was* written:

```
onchain-snapshotter: 1 metric(s) missing from their source, NOT written:
shielded_pool_balance_credits — rows that did arrive WERE written (7 append + 2 upsert).
Inspect the vendor payload shape, then either fix the mapping or retire the metric from onchain.metrics.
```

A thrown Code node fails the execution, which the existing `errorWorkflow`
(`onchain-error-alert`) turns into a Telegram message carrying that text. **No new Telegram node and
no second copy of the chat id** — one place still owns the alert contract.

**Why the writers were serialized.** The gate must run *after* both writes, or a partial vendor
outage would lose the rows that did arrive. The two writers used to be a fan-out from `Normalize`,
and with `executionOrder: v1` the relative order of parallel branches is decided by canvas geometry —
so "after both writes" would have been a hope, not a guarantee. The chain is now
`Normalize → Write snapshots → Upsert zec supply → Check dropped`, which makes the ordering
structural. This costs nothing in resilience: under a fan-out, a throw in either writer already
aborted the run before the sibling branch executed, so the branches were never independent.

Both writers carry `alwaysOutputData: true` so that a query returning no items cannot skip the gate —
a silent skip is the exact failure class this issue is about.

**Also fixed in passing:** `Write snapshots` bound its parameter with a bare `{{ $json.append_b64 }}`.
The project's own rule is insert-safe references (`CLAUDE.n8n.md`: *"never bare `$json.field` — breaks
when a node is inserted upstream"*), and this change inserts nodes into that very chain. It is now
`{{ $('Normalize').first().json.append_b64 }}`, matching what `Upsert zec supply` already did.

**Verification.** The gate's logic was exercised against five input shapes — the real current payload
(one drop → throws, names `shielded_pool_balance_credits`), a healthy run (passes through), multiple
drops, and two malformed-`dropped` shapes that must NOT throw (absent, and not-an-array). Wiring was
read back from the live instance: 9 connections, 0 invalid, the chain in the intended order.

**Confirmed on the scheduled run** (execution 37561, 2026-07-27 08:00:37 UTC) — the node-by-node path
is exactly the designed one:

```
Normalize ✓ → Write snapshots ✓ (28ms) → Upsert zec supply ✓ (2ms) → Check dropped ✗
Error: onchain-snapshotter: 1 metric(s) missing from their source, NOT written:
       shielded_pool_balance_credits — rows that did arrive WERE written (8 append + 2 upsert).
```

Both writers reported success before the gate threw, and the 08:00 bucket holds its rows in the DB —
so the "partial data is still committed, then fail loudly" contract holds in production, not just in
the harness.

> **Delivery was NOT confirmed by that run.** The thrown message reached `onchain-error-alert`, which
> then failed with HTTP 400 — Telegram could not parse `shielded_pool_balance_credits` as entities.
> The gate worked; the alert did not arrive. Filed and fixed as
> [L-4](l-4-telegram-entity-parsing-400s-on-snake-case-metric-names-no-alert-delivered.md). This
> issue is `fixed` for the mechanism it describes; end-to-end delivery is L-4's to prove.

## Second pass (2026-07-27) — self-healing, so the hole never opens again

The gate above makes a vanished field *loud*. It does not make the data *whole*: the 70 hours
already lost stayed lost, the series kept growing a gap for as long as the vendor stayed silent, and
the alert repeated every hour with nothing an operator could do about it but wait. Both were fixed in
a second pass.

**Forward — derive it, exactly, and say so.** `Normalize` now prefers `poolBalance` and falls back to
`totalShieldedIn − totalShieldedOut` when the vendor omits it. The identity is not an approximation:
it held **byte-exact on 130 of 130 buckets** ever observed, including all 60 the vendor itself
reported. Three properties make the fallback safe rather than convenient:

- **BigInt, never Number.** Credits are exact integers and `value_raw` is the canonical form
  (DB-SCHEMA §1.7). `Number` already loses precision at 2^53 — `Number('9007199254740993') - 1`
  returns `9007199254740991` — so a JS-number path would silently corrupt values the moment Dash
  Platform's credit supply grew past that. It is ~2.8 quadrillion today; the guard is cheap and
  permanent.
- **It refuses rather than guesses.** Non-integer input, a sign, garbage, or a result below zero all
  return `null`, which routes the metric to `dropped` and fails the run. A fallback that always
  produces *something* is a fabrication engine.
- **`source='derived'`, registered first.** Written under its own source — added to
  `metrics.source_priority` as the lowest-priority entry, because §1.8 requires source names to come
  from the registry, not from an agent's imagination — with the formula and both inputs in
  `raw_json`. The dedup key is `(source, asset, metric, ts_bucket)`, so a real vendor observation can
  land beside a derived one and stay distinguishable forever.

**Backwards — [`sql/maintenance/backfill_shielded_pool_balance_derived.sql`](../../sql/maintenance/backfill_shielded_pool_balance_derived.sql).** The same formula and
the same label, applied to the 70 lost hours (2026-07-23 10:00 → 2026-07-27 08:00). Its verify gate
(§5.3) recomputes every stored value from its inputs rather than trusting the INSERT: **130 checked,
130 exact, 0 mismatches, 0 duplicate buckets, 0 orphans**, and `balance` coverage now equals its
siblings' at 130 buckets. Rollback is one line:
`DELETE … WHERE metric='shielded_pool_balance_credits' AND source='derived'`.

**Healed is not the same as healthy — and must not become the same as hidden.** Self-healing removes
the data gap, so the hourly failure (and the alert-fatigue trade-off this section originally
accepted) is gone. What replaces it is a *daily, named* signal: `onchain-verify` reports
`🧮 derived — vendor field missing, value computed: shielded_pool_balance_credits (N rows/24h)` and
counts it against `ok`. Unlike L-3's permanent floor this is a real, closable condition — it clears
when the vendor restores the field or the metric is retired. `Check dropped` still fails outright for
anything with no exact fallback, which is every other metric in the registry.

## Related

- [L-3](l-3-verify-staleness-detector-is-permanently-red-and-names-no-metric.md) — fixed in the same
  pass. Together they close the hole from both ends: the producer now emits a signal, and the monitor
  can now express one.
