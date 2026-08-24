---
id: L-21
type: known-issue
status: open
opened_at: 2026-08-24
category: logic
severity: SEV-2
slug: l-21-nine-consecutive-telegram-alerts-failed-over-five-days-and-nothing-reported-it
---

# L-21 — nine consecutive Telegram alerts failed over five days, and nothing reported it

> Origin: the TC-WF-07 acceptance run of task 014-41, 2026-08-24. Found because that case insists on
> proving DELIVERY rather than wiring — which is exactly what L-4 already told this project to do.

**Symptom.** `onchain-error-alert` fires correctly and its message does not arrive. Every execution
of it between 2026-08-19 and 2026-08-23 ended in `status: error` at the `Telegram alert` node:

| date (UTC) | executions | outcome |
| :-- | :-- | :-- |
| 2026-08-16 22:59, 23:00 | 2 | success |
| 2026-08-19 14:53, 16:55, 18:35 | 3 | **error** |
| 2026-08-21 13:27, 13:28 | 2 | **error** |
| 2026-08-22 19:11, 22:13 | 2 | **error** |
| 2026-08-23 08:07, 12:15 | 2 | **error** |
| 2026-08-24 09:00, 09:03 | 2 | success (this acceptance run) |

Nine consecutive failures across five days. The channel then recovered on its own.

**Cause — the transport, not the message.** Execution 45221, at the `Telegram alert` node:

```
NodeApiError: The connection to the server was closed unexpectedly …
httpCode: ECONNRESET
messages: ["Client network socket disconnected before secure TLS connection was established"]
```

The two nodes before it succeeded: `On workflow error` produced the payload and `Normalize Input`
populated every field including the chat id. So the workflow, the credential and the message were all
correct, and the TLS connection to `api.telegram.org` was reset before it was established.

Measured 2026-08-24 from inside the `n8n-main` container: three of three HTTPS requests to
`api.telegram.org` succeeded, and DNS resolves it to `198.18.0.128` — an address in the
benchmark-test range, so egress to Telegram passes through an intermediary rather than going direct.
That intermediary is the component whose availability the alert channel actually depends on, and
nothing in this project measures it.

**Why this is SEV-2 and not a networking nuisance.** The alert workflow is the terminal reader for
every health signal this project produces — the snapshotter's `Check dropped`, `onchain-verify`'s
report, and now `onchain-retention`'s `Check outcomes`. While it was failing, all three were writing
correct diagnostics into a channel that discarded them. **A failing error-handler cannot report its
own failure**, so the outage is silent by construction; it was found five days in, by accident,
during an unrelated acceptance.

The nine failures were real alerts. At least one of them, execution 45219, was
`onchain-snapshotter` failing at its `PE status` node — a genuine incident nobody was told about.

**This is L-4's lesson recurring on the layer L-4 was written about.** That record established that
a monitoring change is proven by the message ARRIVING and never by the query returning the right
rows. It fixed the message CONTRACT — `parse_mode`, escaping, truncation — and the transport beneath
it was never given a check of its own.

**Fix path.**

1. **Give the alert channel a heartbeat that is verified elsewhere.** A daily send whose absence is
   noticed by something that is not itself the alert channel. `onchain-verify` already runs daily and
   already sends Telegram; the two share the transport, so it cannot be the checker — the check has to
   land somewhere the same intermediary does not sit in front of, e.g. a row in `onchain.diagnostics`
   written by the alert workflow on success, with the freshness gate reading that row.
2. **Retry the send.** `retryOnFail` on the `Telegram alert` node would have converted several of
   these into deliveries: the failure is a connection reset, not a rejection. Budget it against the
   `maxTries × timeout` rule — a retry that blocks the error handler for minutes is its own problem.
3. **Measure the intermediary.** The `198.18.0.128` route is the dependency nobody declared. Find out
   what terminates it and whether its availability is something this project can observe.

**Do not** treat the recovery on 2026-08-24 as a fix. Two green executions after nine red ones is the
shape RF-10 exists to describe, and this record was filed after the pattern was measured rather than
after the first surprise.

**Do not** move the alert to a second channel without keeping this one measured. A second transport
with no heartbeat is two silent channels instead of one.

**Reproduction.** The failure is not reproducible on demand — it is the intermediary's state. What is
reproducible is the DIAGNOSIS:

```sh
# from the n8n container, the same egress the Telegram node uses
docker exec n8n-main sh -c 'wget -q -T 10 -O /dev/null https://api.telegram.org/ && echo ok || echo FAILED'
docker exec n8n-main node -e 'require("dns").lookup("api.telegram.org",(e,a)=>console.log(e||a))'
```

**Related.** [L-4](l-4-telegram-entity-parsing-400s-on-snake-case-metric-names-no-alert-delivered.md)
— the message contract on this same node, and the record that named the delivery rule this defect
found the other half of.
