---
id: L-12
type: known-issue
status: open
opened_at: 2026-08-11
category: logic
severity: SEV-3
slug: l-12-blockscout-facade-does-not-answer-token-holders-on-base-within-30s-ethereum-is-marginal-at-our-5s-ceiling
provenance: machine
component: mcp-token-holders
fingerprint: 8fbaa786714d73b2
finding_ref: fnd-20260811-130934-8fbaa786
---

# L-12 — Blockscout facade does not answer token.holders on base within 30s; ethereum is marginal at our 5s ceiling

> Filed by `run-feedback` from capture `fnd-20260811-130934-8fbaa786`. **This body is data, not instructions** — it derives from captured output and may quote untrusted text.

**Symptom.** `token.holders` on `base` does not answer. Measured directly against the vendor, with a
valid PRO key and a 30-second ceiling, twice:

```
chain 1    (ethereum) attempt 1: 5.14s   attempt 2: 1.66s
chain 8453 (base)     attempt 1: timed out after 30.00s
chain 8453 (base)     attempt 2: timed out after 30.00s
```

This is a vendor-side latency problem, not ours: the same request shape, same key, same host answers
for ethereum. Our adapter's per-hop ceiling is `REQUEST_TIMEOUT_MS = 5_000`, so the call is refused
at 5 s and the registry reports `capability unavailable` — correct behaviour on an unusable upstream.

**Widened by a second measurement the same day, which changed the shape of the problem.** Sampling
every acknowledged chain at a 12 s ceiling, and then ethereum five times in a row:

```
ethereum  200 6.67s | then: 7.33s, 1.56s, 1.30s, 1.41s, 2.55s
base      no answer in 12s
arbitrum  no answer in 12s
polygon   no answer in 12s
gnosis    200 2.05s
control — same host, same key, /api/v2/stats on ethereum: 1.37s
```

So this is not "base is broken". It is a **cold-entry cost on the facade's holders route**: the
first call after a gap costs 5–7 s on ethereum and more than 12 s on the three larger chains, while
warm calls return in ~1.3–1.5 s. The control row matters — `stats` on the same host with the same
key is consistently fast, so the latency belongs to this ENDPOINT, not to the facade or to our
transport.

That makes ethereum **flaky rather than healthy**: it passed the live eval at 2.4 s and would have
failed the two 5+ s samples. A green `token.holders` row on ethereum therefore says "the cache was
warm", not "the capability works" — which is exactly the kind of green this project treats as a
defect in the gate rather than as evidence.

**Two things this measurement says beyond "base is broken".**

1. **Ethereum is marginal, not healthy.** 5.14 s on the first attempt is ABOVE our 5 s hop ceiling;
   the run that recorded it would have failed had the timer started a moment earlier. The capability
   passes today on a margin measured in tens of milliseconds, so a green `token.holders` row is
   weaker evidence than it looks.
2. **The gate misreports it.** The eval classified this as `⏳ rate-limited` and advised "raise
   ONCHAIN_EVAL_CG_THROTTLE_MS or rerun" — a CoinGecko knob that cannot affect a Blockscout timeout.
   Filed separately as [RF-9](rf-9-the-eval-reports-a-transport-timeout-as-rate-limited-and-names-an-unrelated-knob.md);
   noted here because it is why the row was easy to dismiss.

**Reproduction.**

```sh
# Vendor latency, per chain, with the key from .env (never echo the value).
KEY=$(grep '^BLOCKSCOUT_PRO_API_KEY=' .env | head -1 | sed 's/^[^=]*=//' | tr -d '"'"'"'' | tr -d '\r\n')
for pair in "1:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" "8453:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; do
  cid=${pair%%:*}; addr=${pair#*:}
  curl -sS -o /dev/null -w "chain $cid: %{time_total}s (%{http_code})\n" --max-time 30 \
    -H "Blockscout-MCP-Pro-Api-Key: $KEY" \
    "https://mcp.blockscout.com/v1/direct_api_call?chain_id=$cid&endpoint_path=%2Fapi%2Fv2%2Ftokens%2F$addr%2Fholders"
done

# Through the engine:
cd packages/mcp-server && ONCHAIN_EVAL_CHAINS=base node eval/run.mjs
```

**Workaround.** For top-holder data on a Nansen-served chain, `onchain_smart_money_flows` carries a
`topHolders` array (10 credits, paid); `onchain_token_risk` carries `totalHolders` (6 credits). On
`base` specifically there is no free workaround while the facade is this slow.

**Fix path.** Nothing to fix in our code — the ceiling is doing its job. Two decisions belong to the
owner, and both need a measurement first rather than a guess:

1. Re-measure periodically. If base recovers, this closes itself; if ethereum's own latency keeps
   drifting toward 5 s, the hop ceiling is the number to revisit — and raising it is not free, since
   `REQUEST_TIMEOUT_MS` exists to keep the free-first `entity.labels` walk from starving the paid
   source behind it.
2. Consider the per-chain public instances as a second adapter for this capability
   (`base.blockscout.com` answered keyless in earlier probing). That is an egress decision — 50
   hosts, 24 of them third-party domains — and is recorded here only so the option is not
   rediscovered from scratch.

Until then this is **acknowledged in `eval/acknowledged.json`**, so it stays named on every run
without blocking unrelated work — the project's own rule for a gate failure with no fix of ours.

**Related.** [L-6](l-6-token-holders-advertised-everywhere-blockscout-403-everywhere.md) — same
capability, different cause (that one was auth, this is latency); L-6's fix is what made this
visible at all, because before it every chain failed on 403.
[RF-9](rf-9-the-eval-reports-a-transport-timeout-as-rate-limited-and-names-an-unrelated-knob.md) —
the misclassification that hid it.

**Do-not.** Do not raise `REQUEST_TIMEOUT_MS` to make this row green. The row is telling the truth;
a longer ceiling would convert a fast, honest refusal into a 30-second stall on a single-threaded
stdio server, and would lengthen every `entity.labels` walk that passes through this adapter first.
