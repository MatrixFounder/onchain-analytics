---
id: L-4
type: known-issue
status: fixed
opened_at: 2026-07-27
category: logic
severity: SEV-2
slug: l-4-telegram-entity-parsing-400s-on-snake-case-metric-names-no-alert-delivered
component: onchain-error-alert
evidence_paths:
  - n8n-workflows/exported/onchain-error-alert.json
  - n8n-workflows/exported/onchain-verify.json
resolved_at: 2026-07-27
resolved_by: explicit parse_mode HTML + escaping at the node that owns the message contract
---

> **RESOLVED 2026-07-27**, same day, found by the first scheduled run of the L-2/L-3 fixes. Both
> Telegram nodes now send `parse_mode: HTML` explicitly and escape `& < >` before interpolation.

# L-4 — Telegram entity parsing 400s on snake_case metric names, so the alert is never delivered

**Symptom.** Two consecutive scheduled runs produced the correct diagnosis and delivered **nothing**:

| exec | workflow | time (UTC) | outcome |
|---|---|---|---|
| 37561 | `onchain-snapshotter` | 08:00:37 | drop gate fired correctly, execution failed as designed |
| 37562 | `onchain-error-alert` | 08:00:40 | **HTTP 400** — no Telegram message |
| 37565 | `onchain-verify` | 08:07:16 | report rendered correctly, **HTTP 400** at the `Report` node |
| 37566 | `onchain-error-alert` | 08:07:16 | succeeded — but its payload was only *"Bad request - please check your parameters"* |

The operator's inbox therefore held exactly one message: a generic complaint that `onchain-verify`
failed. The actual finding — `shielded_pool_balance_credits` missing for 95h — reached Telegram in
neither run.

```
400 - {"ok":false,"error_code":400,
       "description":"Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 161"}
```

**Mechanism.** Neither Telegram node set `additionalFields.parse_mode`, so the node applied its own
default and Telegram parsed the body for entities. Metric ids are **snake_case**, and under
Telegram's Markdown modes `_` opens italic: `shielded_pool_balance_credits` contains three of them,
so the last one opens an entity that never closes. Byte offset 161 in the verify payload — and 119 in
the error-alert payload — both land exactly on that third underscore.

**Why it appeared only now, and why that is the uncomfortable part.** The pre-existing messages
carried *counts*, never identifiers, so no underscore ever reached Telegram. Naming the offenders is
precisely what [L-3](l-3-verify-staleness-detector-is-permanently-red-and-names-no-metric.md)
required and what [L-2](l-2-snapshotter-drops-a-metric-silently-dropped-array-never-leaves-the-node.md)
put into the error text — so **the fix for "the alert says nothing useful" turned it into "the alert
is not delivered at all."** A silent monitor was replaced by a louder one that could not speak.

`onchain-error-alert` was independently exposed the whole time: it interpolates arbitrary runtime
error text, so any failure whose message contained `_` or `<` was already undeliverable. Executions
37122 / 37123 (2026-07-25) show the same node erroring before any of this work started. The latent
defect is older than the change that guaranteed it.

**Fix.**

1. **`parse_mode: "HTML"` set explicitly** on both Telegram nodes. Chosen over "leave it unset"
   because the empirical default is what caused this, and over MarkdownV2 because that mode demands
   escaping ~18 characters against HTML's three.
2. **Escaping at the node that owns the message contract**, `&` first so it cannot double-escape the
   entities it produces:
   - `onchain-verify` → `Format report` escapes the assembled text in the Code node.
   - `onchain-error-alert` → `Normalize Input` escapes `workflow_name`, `last_node`, `error_message`
     — keeping the project's rule that this Set node owns the payload contract and the Telegram node
     stays dumb.
3. **`error_message` capped at 1500 chars**, so a long stack trace cannot push the message past
   Telegram's 4096-char limit — a second way to turn an alert into a 400.
4. **Truncation moved after escaping** in `Format report`, then a trailing partial entity is stripped
   (`/&[a-z]{0,5}$/i`). Cutting escaped text at a fixed offset can sever `&amp;` into `&am`, which is
   itself an unparseable entity — the same failure, reintroduced by the guard meant to prevent it.
5. **`split().join()` rather than `replaceAll()`** in the Set-node expressions. `replaceAll` is
   ES2021 and would almost certainly work; "almost certainly" is the wrong confidence level for the
   code path whose failure mode is silence.

**Verification.** The exact 400-producing payload was replayed through the escape+truncate logic and
asserted on seven invariants: no bare `<`, no bare `>`, underscores preserved literally, no
double-escaped `&`, single-pass ordering (`a & b < c > d_e_f` → `a &amp; b &lt; c &gt; d_e_f`), no
half-entity at the truncation boundary, and final length under 4096 for a 400-metric worst case.

**Confirmed end-to-end against the live Telegram API**, both paths, because they escape in different
runtimes (a Code node vs. a Set-node expression) and a proof of one is not a proof of the other:

1. **Report path** — `onchain-verify` executed 2026-07-27 09:00:34 (execution 37581). Telegram
   returned `ok: true, message_id: 11`, and its echo of the delivered text shows
   `shielded_pool_balance_credits` with **underscores intact**. This is the message shape that
   returned 400 an hour earlier.
2. **Set-node expression path** — a throwaway `onchain-l4-escape-probe` (created, run once, deleted)
   carried the identical `split().join()` chain over a deliberately hostile string. The Set node
   emitted `… shielded_pool_balance_credits &amp; &lt;b&gt;not_a_tag&lt;/b&gt; stale 95h &gt; 2h`
   — `&` escaped first, so `<` became `&lt;` and not `&amp;lt;` — and Telegram returned
   `ok: true, message_id: 12` rendering it back as
   `… shielded_pool_balance_credits & <b>not_a_tag</b> stale 95h > 2h`.

That second run also settles two things the report path could not. `>` survives the round trip (the
verify message happened to contain none, since nothing was stale). And **`<b>` arrived as literal
text rather than bold** — so escaping neutralises HTML injection from vendor-controlled strings, not
just the character that broke the parser. Vendor text reaching a formatted channel is attacker-
influenced input; this is the control that makes it inert.

**Lesson worth keeping.** Both L-2 and L-3 were verified against the data layer — SQL on the live DB,
Code-node logic against real payloads, wiring read back from the instance — and both were *correct*
at that layer. The defect sat in the **delivery** layer, which no amount of upstream verification
touches. A monitoring change is not proven by its query returning the right rows; it is proven by the
message arriving.

## Related

- [L-2](l-2-snapshotter-drops-a-metric-silently-dropped-array-never-leaves-the-node.md) and
  [L-3](l-3-verify-staleness-detector-is-permanently-red-and-names-no-metric.md) — both correct at
  the layer they were tested at, both undeliverable until this was fixed.
- `CLAUDE.n8n.md` → the Telegram/parse_mode rule added from this.
