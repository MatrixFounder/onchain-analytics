---
id: WI-63
type: work-item
status: open
opened_at: 2026-08-24
slug: wi-63-the-shared-limiter-rate-is-not-measurable-from-outside-with-todays-probe-set
effort: M
value: 'turns UC-2 from an assertion about session plumbing into a measurement of the vendor rate two sessions actually produce'
source: task 014-33, the http-shared-limiter case
---

# WI-63 — the shared-limiter RATE is not measurable from outside with today's probe set

**What is missing.** `eval/cases/http-shared-limiter.mjs` asserts that two HTTP sessions work
concurrently — distinct session ids, every call served, no cross-session interference. It does not
assert what UC-2 is finally about: that the AGGREGATE rate two sessions produce stays inside the
bucket the adapter declares.

**Why it was left out rather than approximated.** Two measurements, both taken 2026-08-24 while the
case was written.

1. **The bucket does not bite inside the reachable range.** `defillama` carries
   `{capacity: 10, refillPerSec: 5}` (`providers.config.ts`), so the first ten calls pass without
   waiting. Distinguishing a shared bucket from a per-session one needs each arm of a comparison to
   exceed ten calls, hence at least twenty-two distinct requests.
2. **A repeat is not a request.** The cache answers a repeated argument without reaching the limiter,
   so the calls have to be twenty-two DISTINCT ones. `eval/probes.json` curates twelve chains in
   total.

An earlier version of the case compared six calls on one session against six split across two, and
reported `9ms versus 312ms`. The second arm was reading the cache the first arm had filled. The case
would have reported a healthy limiter as broken, on evidence that measured the cache.

**What a fix needs.** An argument axis wider than the chain set, on a free capability, whose values
miss the cache by construction. Candidates worth measuring before choosing:

- a capability keyed on something with many valid values (a protocol slug rather than a chain);
- a deliberately cache-missing argument, if any capability has one that is not a lie to the vendor;
- a per-run cache bypass for the transport phase only — which has to be a real seam and not an
  environment key that could be set in production.

**What must NOT be done.** Duplicating `{capacity: 10, refillPerSec: 5}` into the case as a
threshold. It is a second source for a number `providers.config.ts` owns, it goes stale the day that
file is tuned, and the resulting assertion would be resolvable only within noise — a vendor call
costs about 300 ms and the forced wait for twelve calls is 400 ms.

**Acceptance.** The case measures an aggregate rate across two sessions, on enough distinct
arguments that a per-session bucket and a shared one give different answers, and the assertion is
derived rather than pinned.

**Related.** Task 014-33 shipped the case in its narrower form and states the limit in the file
itself, so a later reader finds the reason next to the assertion rather than only here.
