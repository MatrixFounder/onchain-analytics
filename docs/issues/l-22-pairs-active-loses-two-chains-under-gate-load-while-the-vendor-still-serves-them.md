---
id: L-22
type: known-issue
status: open
opened_at: 2026-08-24
category: logic
severity: SEV-3
slug: l-22-pairs-active-loses-two-chains-under-gate-load-while-the-vendor-still-serves-them
---

# L-22 — `pairs.active` loses `berachain` and `tron` under gate load, while the vendor still serves both

> Origin: the live gate of task 014-33, 2026-08-24. Measured against the vendor immediately
> afterwards, which is what turned "two chains failed" into the finding below.

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
