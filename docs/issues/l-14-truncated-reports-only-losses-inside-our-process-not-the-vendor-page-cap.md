---
id: L-14
type: known-issue
status: fixed
opened_at: 2026-08-11
category: logic
severity: SEV-2
slug: l-14-truncated-reports-only-losses-inside-our-process-not-the-vendor-page-cap
resolved_at: 2026-08-12
resolved_by: 'the vendor cap reported as a THIRD, separate truncation cause, with the page size measured and pinned as evidence'
---

# L-14 — `truncated` reports only the losses that happen inside our process, so a vendor-capped page is marked complete

> Origin: live analysis of `berachain` over the MCP server, 2026-08-11. Not a `run-feedback`
> capture — filed by hand from the session transcript.
>
> **Root cause corrected the same day, before any fix was written.** This record first claimed
> `onchain_active_pairs` *ignores* `limit`. It does not: `normalize()` slices to `limit` and counts
> `cutByLimit` **before** the slice. The observation that produced the wrong claim is retained
> below as evidence — it is real, it just has a different cause.

> ## Closed 2026-08-12 — the vendor's cap is now a cause of its own
>
> A full vendor page is reported as truncation, separately from the two causes that were already
> named, with the count of slots that went to other chains. It is deliberately NOT folded into
> `cutByLimit`: that would tell the caller to retry with a bigger `limit`, which is advice that
> cannot work against a cap no argument of this route can widen.
>
> `VENDOR_PAGE_SIZE = 30` is **measured, not assumed** — seven queries returned exactly 30 rows and
> `q=zzzqqxunlikely9` returned 0, which is what proves 30 is a cap rather than a padded response
> size. Without that second probe `pairs.length === 30` would carry no information at all. Evidence
> pinned at `test/fixtures/dexscreener/page-size.evidence.md`.
>
> ### What the repository's own fixtures were saying
>
> Both recorded fixtures are full 30-row pages. `ethereum.json` holds **2** ethereum rows out of 30,
> and the contract test asserted `truncated: {pairs: false, reason: ''}` over it, with a comment
> reading "the page IS the whole answer". So on the busiest EVM chain the engine returned two pairs
> and claimed nothing was lost — and had been doing so since M1, with the evidence committed. That
> assertion is now inverted and explains itself.
>
> ### The guard that matters
>
> A check that fires on every page is worth what one that never fires is worth. `29 rows → complete`
> and `30 rows → capped` bracket the pinned constant from both sides, so loosening the condition to
> always-true, or editing the constant without re-probing the vendor, fails a test.
>
> ### Coverage and review
>
> `eval/cases/pairs-active.mjs` now asserts `truncated.pairs === true` for a `limit: 5` request
> against a 30-row cap — a combination that cannot legitimately be `false` on any chain with DEX
> activity — and it passes live on every chain where the capability is served. Four adversarial
> lenses raised nothing against this change that survived refutation.

**Symptom.** `truncated.pairs` accounts for the rows this adapter loses **after** the vendor's bytes
arrive — its own `limit` slice and rows dropped by validation
(`adapters/dexscreener/index.ts:240-253`). Rows that never arrived are outside its arithmetic
entirely, and the field reports `false`: an affirmative claim of completeness covering only the half
of the pipeline we own.

Two upstream losses are invisible to it:

1. **The vendor page is capped.** The route is `GET /latest/dex/search?q=<nativeSymbol>`
   (`index.ts:150`) — a relevance page of fixed size. Whatever falls past that cap never reaches us.
2. **Cross-chain rows consume slots in that same page.** The search index is not chain-scoped
   server-side (`index.ts:48-53`), so the response mixes chains and we filter to the requested one
   in `normalize()` (`index.ts:165-167`). The more chains share a query string, the fewer slots the
   requested chain gets — and that narrowing happens before any of our counters run.

**The observation.** Two calls on `berachain`, three minutes apart:

| call | requested `limit` | pairs returned | `truncated.pairs` |
|---|---|---|---|
| 1 | 20 | 20 | `false` |
| 2 | 100 | **20** | `false` |

Under the corrected cause both responses are internally consistent: 20 `berachain` rows survived the
cross-chain relevance page, so `slice(0, 20)` and `slice(0, 100)` return the same 20 and
`cutByLimit` is genuinely 0 in both. The engine did not cut anything. It also had no idea how much
the vendor had already cut, and said `false`.

**Not a cached repeat** — the two responses carry different live values, so the identical row count
is structural rather than one response served twice:

| field | call 1 | call 2 |
|---|---|---|
| `IR/WBERA` `volume24hUsd` | 159.55 | 157.99 |
| `YEET/WBERA` `volume24hUsd` | 67.03 | 61.80 |
| `NAV/WBERA` `volume24hUsd` | 267.10 | 163.19 |
| `LOCKS/WBERA` `liquidityUsd` | 6 420.40 | 6 463.05 |

**Consequence.** A 20-row page marked complete reads as an inventory. In the session that found
this, the 20 rows sum to $1.11M of liquidity and $24.9k of 24h volume, against a chain-wide DEX
volume of $476k for the same day from `onchain_dex_volume` — a 19× gap between what the "complete"
page shows and what the chain did.

Severity is SEV-2 rather than SEV-3 because `truncated: false` is an affirmative claim, and the
tool's own description instructs the caller to rely on it: *"Read `truncated` before concluding a
chain is thin: a short page can mean rows were dropped."* The field is the documented instrument for
exactly this question, and on the dominant cause of a short page it answers wrong.

**Why the design reads correct in review.** Q-10 introduced `truncated` to give the caller a reader
for a signal that previously reached only stderr, and it did that faithfully for the two losses it
knew about. Both are ours. Nothing in the change was wrong; its scope was simply the half of the
pipeline visible from inside `normalize()`, and the field name makes a claim about the whole.

**Reproduction.**

```sh
onchain_active_pairs({chain: "berachain", limit: 20})   # 20 rows, truncated.pairs = false
onchain_active_pairs({chain: "berachain", limit: 100})  # 20 rows, truncated.pairs = false
#   -> compare volume24hUsd between the two responses: values differ, so both are live
#   -> the vendor body before filtering carries rows for OTHER chains; those consumed page slots
```

**Workaround.** Treat any `onchain_active_pairs` page as a sample of unknown coverage and never as
an enumeration, regardless of `truncated`. Cross-check chain-level totals against
`onchain_dex_volume`.

**Fix path (proposed).** The detection is cheap and needs no extra request — the evidence is already
in the response body we parse:

1. **A full vendor page implies upstream truncation.** Compare `body.pairs.length` against the
   observed page size; when the page is full, rows beyond it exist and were never sent →
   `truncated.pairs: true`, with `reason` naming the vendor cap rather than one of our counters.
2. **Report the cross-chain narrowing.** `body.pairs.length - onThisChain.length` is how many slots
   of a capped page went to other chains. It is computed today only implicitly, and it is the number
   that explains why a busy chain returns a short page.
3. **Do not fold the vendor's loss into `cutByLimit`.** The existing `reason` already separates its
   two causes deliberately, because a page cut by `limit` can be widened by asking for more while
   dropped rows cannot. The vendor cap is a third kind — it cannot be widened by any argument this
   route accepts — and collapsing it into either of the other two would tell the caller to retry
   with a bigger `limit`, which cannot work.

The observed page size must be **measured and pinned as evidence**, not assumed: the vendor
publishes no page-size contract, and a hardcoded constant guessed from one sample is the same defect
class as [L-11](l-11-the-blockscout-degrade-set-enumerated-401-402-429-the-vendor-answers-403-so-the-anticipated-branch-never-ran.md).

**Acceptance.** A response whose vendor page came back full carries `truncated.pairs: true` naming
the cap, and the count of rows lost to other chains is reported. A regression fixture built from a
full `q=BERA` page covers it, and the mutation that removes the check kills a test.

**Related.** [L-13](l-13-change-is-computed-on-an-unvalidated-endpoint-so-a-one-day-vendor-artifact-becomes-the-reported-trend.md)
— found in the same session; both are unverified assertions shipped in a schema-valid response.
[L-5](l-5-dex-volume-empty-chart-reports-zero-gapdays-breaking-its-own-invariant.md) — the same
shape on a different route: a completeness field reporting clean on a case it does not cover.
[Q-10](q-10-new-pairs-silently-drops-vendor-rows-that-fail-validation.md) — introduced this field; its scope
is the reason the gap exists, not a defect in it.
