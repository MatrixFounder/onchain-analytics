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

*A single slow response from the keyless tier* — consistent with every observation above and
unproven. CoinGecko's free tier throttles by slowing as well as by 429, and a lone response past
15 s would produce exactly this row and leave no other trace.

**What would actually settle it, and this is the L-25 lesson applied.** The report says the deadline
was exceeded; it does not say WHERE the time went — waiting in our limiter, or on the wire. Those are
different defects with different fixes, and today they are indistinguishable after the fact. The
diagnostic event the call emitted (`01M0TGTJ5JAGM6AC1Y31XE3B6P`) is the natural place to carry that
split. Until it does, an occurrence has to be caught while it is happening, which L-25 established
the hard way: an experiment about a transient must run DURING the transient.

**Fix path.**

1. **Split the deadline diagnostic by phase** — limiter wait versus wire time — so the next
   occurrence answers its own question instead of starting an investigation.
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
