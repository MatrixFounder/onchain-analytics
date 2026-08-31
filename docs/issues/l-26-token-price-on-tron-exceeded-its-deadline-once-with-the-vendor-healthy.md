---
id: L-26
type: known-issue
status: open
opened_at: 2026-08-24
category: logic
severity: SEV-4
slug: l-26-token-price-on-tron-exceeded-its-deadline-once-with-the-vendor-healthy
---

# L-26 — `token.price` on tron exceeded its deadline once, with the vendor measured healthy

> Filed because it BLOCKED a gate run, not because it is understood. Without a record the next
> occurrence arrives cold and someone re-derives all of this from scratch — which is the whole
> reason RF-10 keeps entries alive over green rows.

**Symptom.** One row, one run: `tron/token.price` → `capability deadline exceeded` (15 000 ms,
`capability-manifest.ts`). The run's link was measured stable by the gate itself (WI-65). No other
CoinGecko row failed in that run.

**It did not reproduce, and the vendor was healthy either side of it.**

- The exact vendor route, probed three times within minutes:
  `GET /api/v3/coins/tron/contract/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` → 0.91 s, 0.46 s, 0.48 s,
  20 659 B each. Control on the same host, `ethereum/WETH`: 0.69 s.
- The next gate run, link stable: **all ten probed `token.price` rows green**, 594–2463 ms, tron
  among them at 693 ms.

**The cause is NOT established, and one candidate was measured away rather than left hanging.**

*Our own limiter queue* — the shape L-22 was, and the first thing to suspect on a tight bucket.
`coingecko` carries `{capacity: 10, refillPerSec: 0.5}`, by far the tightest we run: one token every
two seconds. **The arithmetic refuses it.** The eval paces every CoinGecko-backed call at
`COINGECKO_THROTTLE_MS = 6000` — one call per six seconds against a refill of one per two — so no
deficit accumulates across the sweep. And this adapter already bounds its limiter wait by the
caller's ceiling (`throttle('coingecko', RATE_LIMIT, 1, deadlineAtMs)`, and the same `deadlineAtMs`
into `safeFetch`), so even a queue overrun here would be the deadline being HONOURED, not a defect.

**The pacing claim above was re-checked 2026-08-28 and holds.** It rests on `COINGECKO_THROTTLE_MS`
applying to every CoinGecko-backed call, and the eval applies it to `onchain_get_token` alone
(`eval/run.mjs`, the ternary on the pacing line). CoinGecko serves exactly two capabilities —
`token.price` and `token.metadata` — and `token.metadata` is called by NO tool
(`eval/capabilities.mjs`, `eval/README.md`: «`onchain_get_token` routes through `token.price` on
purpose»). So `onchain_get_token` is the only CoinGecko path in the gate, and the six-second pacing
covers all of it. The elimination stands.

*A single slow response from the keyless tier* — consistent with every observation above and
unproven. CoinGecko's free tier throttles by slowing as well as by 429, and a lone response past
15 s would produce exactly this row and leave no other trace.

**What would settle it — and half of that is now built.** The report used to say only that the
deadline was exceeded, never WHERE the time went: waiting in our limiter, or on the wire. Those are
different defects with different fixes, and on 2026-08-24 they were indistinguishable after the
fact — which is why fix-path item 1 was done the same day and why this record stays open rather than
being closed by it. The NEXT occurrence will name its phase in the refusal itself.

What that does not do is make the occurrence reproducible on demand. L-25 established the rest the
hard way: an experiment about a transient must run DURING the transient, and a probe taken after the
window closed answers a question nobody asked.

**Fix path.**

1. ~~**Split the deadline diagnostic by phase** — limiter wait versus wire time — so the next
   occurrence answers its own question instead of starting an investigation.~~ **DONE 2026-08-24.**
   `DeadlineExceededError` now carries an explicit `phase` from a closed set — `limiter`, `wire`,
   `shared-document`, `coalesced`, `pg-query` — and names it in its message. All nine producers in
   `packages/core` are labelled, and `TC-UNIT-20` asserts that by reading the source, because the
   failure it guards is a NEW call site added without one, which no behavioural coverage of the old
   ones would catch (it also asserts the scan found producers at all, so a drifted pattern cannot
   report a clean sweep).

   **The phase reaches the CALLER, and nothing else does.** `toClientText` cuts the traversal —
   that tail names adapters — but lifts the phase out of it, so a refusal now reads
   `capability deadline exceeded: token.price on tron [phase: limiter] (event …)`. It is rendered
   only from the closed set: a word outside it produces no phase at all rather than a passthrough,
   which is the same fail-closed rule step 3 of that function already applies to everything else.

   The two failure classes in `transport/failure-classes.ts` kept their broad marker deliberately —
   it is the safety net asserting a refusal carries `isError`, and narrowing it would stop it
   catching what it exists for. What changed is that the prose recording "these two are
   indistinguishable on the wire" is no longer true, and was rewritten rather than left standing.
1a. **The phase has no default any more (2026-08-28).** Item 1 shipped `phase` with a default of
   `'wire'`, documented as letting a producer that forgets the argument "still say something
   true-ish". That is a guess in the one position this record cannot afford one. A forgotten phase
   reported `wire`, sending the next investigation to the VENDOR when the truth may be our own
   queue — the exact distinction item 1 exists to preserve.

   The field is now required. A producer that omits it is a compile error, not a confident wrong
   answer. Measured before the change: all nine producers in `packages/core` already passed it
   explicitly, and none in `packages/mcp-server` construct the class. Removing the default therefore
   broke only five test call sites, each of which now names the phase it simulates.

   `TC-UNIT-19` asserts the SOURCE carries no default. A default silently restored would bring the
   defect back while every behavioural test stayed green; the assertion is proven by mutation.

   The rule applied is the project's own: L-2 — refuse rather than guess, because a fallback that
   always yields something is a fabrication engine.

2. **Do NOT raise `deadlineMs`.** Measured: this route answers in 0.46–0.91 s. A capability that
   needs more than 15 s for a 0.5 s document does not have a deadline problem.
3. **Do NOT loosen the bucket.** `{capacity: 10, refillPerSec: 0.5}` is set to the keyless tier this
   provider actually gives us; widening it to make one row green would trade a visible refusal for a
   429 nobody is watching for.
4. **A green run is not a closure** — the row was green on the very next run and this record stays
   open, which is RF-10's own rule and L-20's precedent.

**Acknowledged** as `L-26/token.price`, bound 1 over the ten chains the capability is PROBED on.
`bitcoin` is excluded from the set deliberately: it reports `no-probe`, so it cannot fail and would
only dilute the denominator — the same reason `zcash` is absent from L-24's set.

**Reproduction.** None known. If it recurs, capture it live:

```sh
for i in 1 2 3; do
  curl -sS -o /dev/null -m 30 --compressed -w "%{http_code} %{time_total}s\n" \
    https://api.coingecko.com/api/v3/coins/tron/contract/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
  sleep 8
done
```

**Related.** [L-22](l-22-pairs-active-loses-two-chains-under-gate-load-while-the-vendor-still-serves-them.md)
— the deadline defect this one is NOT, and the reason the limiter was suspected first.
[L-25](l-25-a-wide-sweep-makes-defillama-rows-fail-that-answer-fine-alone.md) — the record that was
refuted for asserting a mechanism on measurements taken at different times; this one names its
candidates as candidates for that reason.
