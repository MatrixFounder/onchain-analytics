---
id: L-27
type: known-issue
status: open
opened_at: 2026-08-24
category: logic
severity: SEV-3
slug: l-27-the-first-caller-of-a-shared-document-pays-a-deadline-the-document-does-not-cost
---

# L-27 — the FIRST caller of a shared document pays a deadline the document does not cost

> Filed because it blocked a gate run on a link the gate measured stable, and because the numbers
> rule out the vendor before any hypothesis is offered.

**Symptom.** `ethereum/protocol.incidents` → `capability deadline exceeded` at **15 008 ms**, i.e.
the whole 15 s budget. The eleven chains behind it in the same walk answered from the in-process
shared cache: `solana` 98 ms, `base` 1 ms, `arbitrum` 2 ms, and so on down to `zcash`.

**The vendor is not the cause, measured three times minutes later.** `GET https://api.llama.fi/hacks`
— the document this capability reads — answered `200` in **0.46 s, 0.49 s, 0.49 s**, 37 072 bytes
each. Thirty-seven kilobytes. The run's own link probe reported stable throughout: three unrelated
hosts, 36 probes, zero failures, median TCP connect 16–21 ms (WI-65).

So fifteen seconds were spent somewhere that is neither the wire nor our egress, on a route whose
document takes half a second, and only the FIRST caller paid it.

**What this record can already say about where, and what it deliberately cannot.**

It is not `awaitSharedDocument`: both of that route's paths are wrapped in it, and since L-26 that
producer names its phase — the refusal would have read `[phase: shared-document]`. It did not name
any phase at all, and THAT is the informative part: the refusal came from a producer L-26's first
pass had not labelled. The limiter refuses under two classes — `DeadlineExceededError` (the wait ran
out) and `DeadlineWouldExceedError` (the wait was never begun, because it would not leave enough of
the deadline to be worth issuing) — and only the first was labelled. The second is now labelled too,
so **the next occurrence answers this record's central question by itself**.

Which leaves the candidate, stated as a candidate: all DeFiLlama capabilities share ONE bucket
(`{capacity: 10, refillPerSec: 5}`, per provider), and by the time the walk reaches
`protocol.incidents` on its first chain it has already issued `chain.tvl`, `chain.tvl.history`,
`dex.volume.history`, `protocol.tvl`, `protocol.tvl.history` and `protocol.list` on that same bucket.
That is the queue to measure. It is NOT established: the arithmetic of a ten-token bucket refilling
at five per second does not obviously reach fifteen seconds, and L-25 is the record of what happens
when a plausible mechanism is written down as a finding.

**Why it matters beyond the gate.** The first caller of every shared document is a real caller, and
this is the shape a client meets on a cold process: the answer that costs 0.46 s for everyone after
them costs them their entire budget. It is also the second time in one day that a deadline refusal
could not say where its time went, which is why the fix for L-26's item 1 was widened rather than
declared done.

**Fix path.**

1. **Wait for the next occurrence and read the phase.** It now says `[phase: limiter]` if it is our
   queue. This is the cheapest discriminator that exists and it costs nothing to wait for.
2. **If it is the bucket**, the question is scope rather than size — `rpc-evm` already declares
   `scopeKey: 'chain'` so one saturated chain cannot delay another, and a per-capability scope is the
   same argument. Raising `capacity` would buy a bigger queue for a problem that is the queue.
3. **Do NOT raise `deadlineMs`.** Measured: the document is 37 KB and arrives in under half a second.
4. **Do not acknowledge this away permanently.** The entry exists so an occurrence does not block
   unrelated work; the bound is 1, and a second failing chain is a different fact.

**Reproduction.** Not on demand. The document is cached for its TTL after the first success, so a
second gate run in the same window cannot reproduce it — which is itself the reason the phase had to
be built rather than the occurrence chased.

**Related.** [L-26](l-26-token-price-on-tron-exceeded-its-deadline-once-with-the-vendor-healthy.md)
— the same shape on a different provider, and the record whose fix-path item 1 this one immediately
tested. [L-25](l-25-a-wide-sweep-makes-defillama-rows-fail-that-answer-fine-alone.md) — the record
that was refuted for writing a plausible mechanism down as a finding; this one names its candidate
as a candidate for that reason.
[WI-65](../backlog/wi-65-the-gate-cannot-tell-a-vendor-outage-from-a-stall-on-our-own-link.md) — why
"the link was stable" is a measurement here rather than an assumption.
