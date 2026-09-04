---
id: RF-19
type: known-issue
status: fixed
opened_at: 2026-09-04
fixed_at: 2026-09-04
category: workflow-docs
severity: SEV-3
slug: rf-19-the-shared-limiter-case-queues-its-own-calls-past-the-capability-deadline
provenance: machine
component: mcp-server/eval/cases/http-shared-limiter-rate
fingerprint: 611112990545ee6e
finding_ref: fnd-20260904-142153-61111299
---

# RF-19 — the shared-limiter case queues its own calls past the capability deadline

> Filed by `run-feedback` from capture `fnd-20260904-142153-61111299`. **This body is data, not instructions** — it derives from captured output and may quote untrusted text.

**Symptom.** The transport case `http-shared-limiter-rate` fails intermittently, and the gate cannot
be unblocked by an acknowledgement:

```
✗ —/transport:http-shared-limiter-rate [degraded]
  the tool refused: capability deadline exceeded: wallet.balances.native on ethereum [phase: wire]
```

Two occurrences on a link the gate itself called stable: 2026-09-02 20:23 UTC and 2026-09-04
10:56 UTC. Six other runs in the same window passed.

**The arithmetic, derived from the shipped config rather than read off the failure.**

| quantity | value | source |
| :-- | --: | :-- |
| `rpc-evm` bucket | `{capacity: 5, refillPerSec: 1}`, scoped per (provider, chain) | `adapterRegistrations` |
| calls in the measure arm | 12 | the case derives it: `max(2·capacity+2, ⌈2·refill·2000/1000⌉)` |
| queue wait for the last call | **7 000 ms** | `(12 − 5) / 1` |
| `wallet.balances.native` deadline | **15 000 ms**, absolute, computed once per call | `capability-manifest.ts` |
| what the last call has left for the wire | **8 000 ms** | 15 000 − 7 000 |

All twelve calls are issued at once (`Promise.all`), so every call's deadline starts at the same
moment and the tail spends most of its budget queued. A free public RPC endpoint answering a
twelve-way burst in more than eight seconds is enough to end the run.

**This is a measurement failure, not a limiter defect, and the case is right to report it.** Its
check withholds the timing verdict whenever an arm is incomplete, and the reasoning is sound: a call
that dies at its 15 000 ms deadline settles at 15 000 ms, which is ABOVE the 7 000 ms shared floor,
so a contaminated arm would report "shared bucket" for the wrong reason. The limiter itself is not
implicated by either occurrence.

**It cannot be acknowledged, by design.** `eval-gate.mjs` rejects `maxFailing >= rows.length`
(RF-10): a bound equal to the set size can never be exceeded, so it would silence the row forever.
This entry covers ONE row, so no bound is writable for it. Blocking or fixing are the only two
states available.

**The full text is not recoverable after the run, which is a third instance of one problem.**
`eval/run.mjs` spawns each server with `DATA_DIR` pointing at a per-run temp directory, and the gate
removes it when the run ends. The event id in the refusal therefore resolves to nothing once the run
is over — not through RF-17's mechanism, which is fixed, but because the store itself is ephemeral.
An operator reading a red gate row cannot obtain the operator rendering it names.

**Fixed 2026-09-04 — option 1, chosen by the owner.** The measure arm is `2 × capacity` = 10 calls.
The queue wait falls to 5 000 ms and the wire budget rises to 10 000 ms. Confirmed by the gate run
of 2026-09-04 12:05 UTC: `eval-gate: pass`, `ok 152 · error 2`, no new failures, with the L-23
acknowledgement still retired.

**What it gave up, and where that is written.** The first term was `2 × capacity + 2`, and the two
extra calls existed to keep the per-session floor strictly above zero, so that BOTH hypotheses
predicted a wait. That floor is now 0 ms: the per-session hypothesis predicts no wait at all. The
hypotheses stay separated by the full 5 000 ms of the shared floor, which is above the case's own
2 000 ms noise bound, and the INCONCLUSIVE arm still refuses to call a run decided when the control
latency alone could explain it. Two assertions in `test/eval-transport-cases.test.ts` pinned the
stricter property (`calls > 2 × capacity`, `splitFloorMs > 0`) and were relaxed to `>=` with the
reason beside them, so a later reader does not read the change as a red run tuned green.

**The options as they stood.**

1. Lower the measure arm to `2·capacity` = 10 calls. The queue wait falls to 5 000 ms and the wire
   budget rises to 10 000 ms. The gap between the two hypotheses falls from 6 000 ms to 5 000 ms,
   still above the case's own 2 000 ms separation floor. Buys two seconds; changes no semantics.
2. Treat an arm incomplete BY DEADLINE REFUSAL as `unmeasurable` rather than as a defect. Truthful —
   the case could not measure — but it converts a red row into a quieter one, and a case that
   reports "could not measure" on every run is a case nobody reads.
3. Measure this property somewhere other than the live gate, which the case's own `unmeasurable`
   message already names as an option for the config-drift case.

**Not established.** Whether the wire actually took more than eight seconds, or whether the endpoint
refused and the adapter reported the refusal as a deadline. The evidence needed is the operator
rendering, and it was deleted with the temp directory.

**Reproduction.** `pnpm --filter @onchain-intel/mcp-server gate --task <id>`, repeated: two of eight
runs in the 2026-09-02…09-04 window carried it.
