---
id: WI-64
type: work-item
status: open
opened_at: 2026-08-24
slug: wi-64-the-alert-channel-has-no-heartbeat-so-its-silence-is-indistinguishable-from-quiet
effort: S
value: 'makes an alert-channel outage visible on the day it starts instead of whenever somebody happens to look'
source: L-21, reclassified 2026-08-24
---

# WI-64 — the alert channel has no heartbeat, so its silence is indistinguishable from quiet

**What is missing.** Nothing tells anyone that `onchain-error-alert` has stopped delivering. It is
the terminal reader for every health signal this project produces — the snapshotter's
`Check dropped`, `onchain-verify`'s report, `onchain-retention`'s `Check outcomes` — and it is the
one workflow whose own failure it cannot report, because it IS the reporter.

**Why this is worth doing even though the outage that surfaced it was not a defect.**
[L-21](../issues/l-21-nine-consecutive-telegram-alerts-failed-over-five-days-and-nothing-reported-it.md)
recorded nine consecutive undelivered alerts across five days. The cause turned out to be the laptop
hosting the VM having no internet — no repair needed anywhere in the engine. That makes the gap
MORE worth closing, not less: a laptop going offline is a routine event, so the same five-day
silence will recur on a cause nobody will call a defect either. It was noticed by accident, during
an unrelated acceptance.

**The shape a fix has to have.** The checker cannot be the alert channel. `onchain-verify` runs
daily and sends Telegram through the same credential and the same egress, so it goes down with it —
a second silent channel rather than a check. The signal has to land somewhere the same failure does
not reach.

The cheapest candidate: `onchain-error-alert` writes one row to `onchain.diagnostics` on a
SUCCESSFUL send, and the daily freshness gate reads that row's age. The database is on the same VM
and needs no egress, so it stays reachable exactly when the outbound path does not. A missing row
then means "the last alert did not get out", which is the fact nobody has today.

**What must NOT be done.** Moving alerts to a second transport without keeping this one measured.
Two channels with no heartbeat is two silences instead of one.

**Acceptance.** An alert-channel outage lasting more than one daily cycle produces a visible signal
that does not itself depend on the alert channel.
