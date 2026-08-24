---
id: L-22
type: known-issue
status: fixed
opened_at: 2026-08-24
category: logic
severity: SEV-3
slug: l-22-pairs-active-loses-two-chains-under-gate-load-while-the-vendor-still-serves-them
resolved_at: 2026-08-24
resolved_by: TASK 014-33
---

# L-22 — `pairs.active` loses `berachain` and `tron` under gate load, while the vendor still serves both

> Origin: the live gate of task 014-33, 2026-08-24. Measured against the vendor immediately
> afterwards, which is what turned "two chains failed" into the finding below.

> **FIXED 2026-08-24 (task 014-33). The cause was arithmetic, and the record's first reading — "the
> gate's load" — was wrong.**
>
> `pairs.active` carried a capability deadline of `15_000`, and `safeFetch`'s default hop bound is
> also `15_000`. Task 014-32c gave the route a SECOND search to close L-19. **So the budget for the
> whole call equalled the budget for ONE of its two hops:** whenever the first query took more than
> a moment, the second could not start. That holds on a healthy vendor and under no load at all —
> nothing about a full matrix was needed to produce it, and blaming the gate's concurrency was
> looking at the wrong variable.
>
> Reproduced narrowly on two chains, with no matrix around it: both failed at **15010 ms and
> 15005 ms** — the deadline to the millisecond, not a page and not a vendor error.
>
> **Two numbers changed, both derived from the route's SHAPE.**
>
> - `pairs.active` moves to the ~30 s tier (OD-2). The tier's heading now names both readings of it —
>   two adapters in sequence, or ONE adapter queried twice — because before this a capability whose
>   single adapter makes two hops had nowhere to sit.
> - The search hop gets `SEARCH_TIMEOUT_MS = 12_000`, explicit and for that route alone. Two hops at
>   12 s plus the bucket's waits (`{capacity: 5, refillPerSec: 1}`) is ~26 s, inside the ceiling with
>   room; a single hanging leg now fails at 12 s instead of consuming the whole budget and taking the
>   other leg with it.
>
> **The failure mode changed, which is the observable proof.** Same two chains, after: `capability
> unavailable` at **12004 ms** instead of `capability deadline exceeded` at 15010 ms. The call now
> reports "this vendor did not answer" rather than "we ran out of our own time" — two different facts
> that the old numbers could not tell apart.
>
> **What was NOT fixed, and must not be read as fixed.** DexScreener's search endpoint was badly
> degraded while this landed: of eighteen direct probes, most gave no answer in 40 s and the ones
> that answered took 6.8–7.2 s, against 1.3–2.5 s a few hours earlier. So the two chains still fail —
> on the vendor, now correctly attributed. **No number here was fitted to that state**, deliberately:
> a ceiling tuned against an outage is a ceiling that has to be retuned when the outage ends. The
> acknowledgement in `eval/acknowledged.json` covers the vendor's condition and expires on its own
> review date.
>
> **The `tron` "empty page" of the original report is explained by the same cause.** A walk whose
> deadline expires between the two queries keeps only the first query's rows — and the first query
> returns zero rows of that chain, which is exactly what L-19 established. It was never a second
> failure mode.

**Symptom.** Two rows failed the gate, in two DIFFERENT ways:

```
berachain/pairs.active  [error]     capability deadline exceeded: pairs.active on berachain
tron/pairs.active       [degraded]  pairs is empty — no new pairs at all is implausible for a live DEX chain
```

**The vendor serves both. Measured minutes later, keyless:**

| chain | `q=<vendorId>` — the FIRST strategy | `q=W<nativeSymbol>` — the SECOND |
| :-- | :-- | :-- |
| berachain | HTTP 200, 10 rows, **0 on this chain** | HTTP 200, 30 rows, **30 on this chain** |
| tron | HTTP 200, 30 rows, **0 on this chain** | HTTP 200, 30 rows, **30 on this chain** |

So the shipped two-query strategy (task 014-32c, closing L-19) is right about both chains: the first
query finds nothing of theirs and the second finds a full page. The eval case asks for `limit: 5`, so
after a first query yielding zero the adapter's `found < limit` condition holds and the second query
is issued. The capability is reachable and the gate did not reach it.

**What separates the two failures, and why the record covers both.**

- `berachain` ran out of the capability's **15 s deadline** (`capability-manifest.ts`). Two search
  queries plus two waits on the `dexscreener` bucket, under a gate that is walking twelve chains
  through the same bucket at the same time.
- `tron` answered an EMPTY page rather than an error, which means the walk completed and kept no
  rows. Direct measurement contradicts that, so either the second query did not run on that pass or
  its rows were dropped after arriving.

The first is a budget under load. The second is not yet explained, and this record does not pretend
it is.

**Why this is not L-19 reopened.** L-19 was the adapter querying by a string that ranks for no chain
in particular, and the fix measured all 49 covered chains and shipped a two-query strategy that
answers on 49 of 49. That measurement still holds — this record's own table reproduces it. What is
new is that the SECOND query costs a second round trip and a second bucket token, and the gate is
the first workload that runs twelve chains through that bucket concurrently. A strategy measured
one chain at a time is not the same strategy under a full matrix.

**Blast radius.** `pairs.active` on the chains whose first query yields nothing of their own — which
the 014-32c probe measured as 19 of 49 at the default limit, and which is where the second query is
mandatory rather than opportunistic.

**Fix path.**

1. **Explain `tron` before changing anything.** An empty page from a walk that completed is either a
   query that did not run or rows that were dropped, and those need different fixes. The gate's own
   artifact now carries per-row problem text in the ledger (task 014-43), so the next occurrence is
   diagnosable after the fact — it was not, this time.
2. **Reconsider the deadline for a two-query capability.** `pairs.active` carries the 15 s tier that
   was derived when the route was one query. The tier is a property of the CALL, and the call grew a
   second leg in 014-32c without the tier being re-derived.
3. **Or make the second query cheaper.** It is issued only when the first came up short, which is
   already the narrow path; what it is not is free of the bucket.

**Do not** widen the eval's `limit` to make the first query satisfy it. That would hide the second
query rather than pay for it, and the capability would go quiet on exactly the 19 chains L-19 was
filed about.

**Reproduction.**

```sh
for q in berachain WBERA tron WTRX; do
  curl -sS "https://api.dexscreener.com/latest/dex/search?q=$q" |
    python3 -c "import sys,json; d=json.load(sys.stdin); p=d.get('pairs') or []; print('$q', len(p))"
done
# then, under load:
pnpm --filter @onchain-intel/mcp-server gate --task L-22
```

**Related.** [L-19](l-19-pairs-active-answers-an-empty-page-wherever-the-native-symbol-search-does-not-return-that-chain.md)
— the defect whose fix introduced the second query this one is about.
