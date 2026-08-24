---
id: WI-65
type: work-item
status: open
opened_at: 2026-08-24
slug: wi-65-the-gate-cannot-tell-a-vendor-outage-from-a-stall-on-our-own-link
effort: S
value: 'stops a stall on our own uplink from being filed as several simultaneous vendor incidents, and stops a real one from being dismissed as weather'
source: measured while closing WI-63/WI-64, 2026-08-24
---

# WI-65 — the gate cannot tell a vendor outage from a stall on our own link

**What is missing.** A blocked gate names the vendors whose rows failed. It says nothing about the
one condition that makes several unrelated vendors fail at once: our own egress.

**Measured 2026-08-24, and it changed a verdict.** A gate run reported four `capability deadline
exceeded` rows across `protocol.tvl.history` and `chain.tvl.history`, and pushed both blockscout
acknowledgements over their bounds — three vendors at once, which the report presented as three
independent facts. Probing five unrelated hosts in the same minute:

```
200 1.64s (conn 0.42s)  api.llama.fi
200 1.57s (conn 0.35s)  api.dexscreener.com
200 1.74s (conn 0.50s)  api.coingecko.com
200 1.64s (conn 0.22s)  mcp.blockscout.com
200 1.83s (conn 0.25s)  mempool.space
```

A uniform ~1.6 s floor with slow CONNECT times across five companies and five CDNs is not five
incidents. Ninety seconds later the same hosts answered in 0.39–0.53 s with 0.012 s connects, from
the same machine, unchanged code — so the stall was ours and transient. The gate had measured our
link and reported it as vendor drift.

**Why this matters more than it sounds.** The acknowledgement mechanism's whole discipline is that
raising a bound is an act of MEASUREMENT (RF-10). A bound raised on a run taken during a local stall
bakes weather into the record permanently, and the next real widening then arrives inside the slack
that stall bought. The error runs the other way too: a genuine vendor outage gets dismissed as "the
link was probably bad" by whoever remembers this note.

**The shape a fix has to have.** The gate already fetches an independent reference source
(`probes.json` → `referenceSources.btcTipHeight`) that is deliberately not an engine adapter. The
same idea, applied to latency: probe a small set of unrelated hosts at the START and END of a run,
record the floor and the spread in the artifact and the ledger line, and print one line above the
failures. A run whose own floor moved by an order of magnitude is a run whose vendor verdicts are
not evidence.

**What must NOT be done.** Auto-suppressing failures when the link looks slow. The number belongs
next to the verdict so a human reads both; a gate that decides on its own when to stop believing
itself is a gate nobody can audit. And the probe set has to stay outside the adapters, for the same
reason `btcTipHeight` does — a source we answer from cannot be the check on that answer.

**Acceptance.** A blocked gate run states what our own egress was doing while it ran, in the report
and in the ledger line, so a reader can tell a vendor incident from a local one without re-measuring
by hand hours later.
