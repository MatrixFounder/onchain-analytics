---
id: L-25
type: known-issue
status: open
opened_at: 2026-08-24
category: logic
severity: SEV-2
slug: l-25-a-wide-sweep-makes-defillama-rows-fail-that-answer-fine-alone
---

# L-25 — a wide sweep makes DeFiLlama rows fail that answer fine on their own

> Origin: two consecutive gate runs of 2026-08-24 whose link the gate itself measured stable. Filed
> because the failures could NOT be attributed to the vendor, which is the only reason they are ours.

**Symptom.** During a full matrix walk, `dex.volume.history` and `chain.tvl.history` report
`capability deadline exceeded` on most chains. Run 1: `dex.volume.history` 5 of 11,
`chain.tvl.history` 3. Run 2: `dex.volume.history` **9 of 11**, `chain.tvl.history` 0. Which chains
fail rotates between runs.

**Why this is not the vendor, measured three ways within minutes of run 2 finishing.**

1. **Raw HTTP takes every chain, well inside our deadline.** All eleven `/overview/dexs/{chain}`
   documents answered: 0.58 s, 0.58 s, 0.59 s, 0.61 s, 0.98 s, 1.08 s, 2.44 s, 2.61 s, 3.13 s,
   3.37 s, 8.81 s. The capability's `deadlineMs` is 15 000.
2. **The full engine path takes the exact chain that had just failed.** `onchain_dex_volume` on
   `bsc` — red in run 2 with `capability deadline exceeded` — returned a complete 7-point series
   through the real adapter, the real limiter and the real deadline.
3. **The gate had measured its own egress throughout both runs** (WI-65): three unrelated hosts,
   54 probes each run, 0 failures, median TCP connect 13–18 ms and 16–22 ms. The link was not the
   cause, and this is the first time that could be said from the run's own record rather than from a
   hand probe hours later.

**What IS the vendor, and is filed separately.**
[L-24](l-24-defillamas-two-per-call-history-routes-answer-erratically.md)'s `protocol.tvl.history`
is genuinely broken at the origin right now — probed at the same time, `aave` took 39.9 s,
`raydium` and `quickswap` returned nothing in 60 s, and `aerodrome-slipstream` was still streaming
at 926 KB when the 60 s ceiling cut it. That is a real outage on that route. **The point of this
record is that it does not explain the other two**, and until now they were being written up as
though it did.

**The hypothesis this record exists to test, stated as a hypothesis.** All DeFiLlama capabilities
share ONE token bucket (`{capacity: 10, refillPerSec: 5}`, per PROVIDER not per capability), and
`providers.config.ts` already says in writing what that can do: *"a wide sweep can now park a backlog
deep enough to make a concurrent `protocol.tvl` call wait tens of seconds or be refused."* A matrix
walk issues the whole free defillama surface across twelve chains, and it does so while
`protocol.tvl.history` calls are hanging for 40–60 s each. That is the shape to check first.

It is NOT yet established, and this record must not be cited as though it were. What is established
is the three measurements above: the rows fail in the sweep and pass outside it, on a link measured
healthy, against a vendor measured willing.

**Why SEV-2 rather than a work item.** Two reasons, and neither is the gate's inconvenience. A
capability that fails under load and passes alone is a capability that fails for a caller running a
screening question across chains — the exact use these history routes exist for. And the
misattribution is itself the damage: for most of 2026-08-24 these rows were being counted toward a
vendor outage and were about to be written into an acknowledgement bound, which would have recorded
a fact about DeFiLlama that is not true and hidden one about us that is.

**Fix path.**

1. **Reproduce deliberately** — the sweep is already the reproduction; narrow it by running the
   matrix with `ONCHAIN_EVAL_CHAINS` limited, with and without `protocol.tvl.history` in flight, and
   compare. That separates "shared bucket" from "vendor rotation" without guessing.
2. **If it is the bucket**, the question is scope, not size: `rpc-evm` already declares
   `scopeKey: 'chain'` for exactly this reason — one saturated chain must not delay another — and
   the same argument may apply per capability here. Raising `capacity` instead would be the
   L-22 mistake in reverse: a bigger budget for a queue whose problem is that it is shared.
3. **Do NOT raise `deadlineMs`.** Measurement 1 above says the vendor answers in under 9 s; a
   capability that needs more than 15 s to deliver a 9 s document has a queueing problem, and a
   longer deadline would hide it rather than fix it.
4. **Do NOT bound these rows in `eval/acknowledged.json`.** An acknowledgement says "we know why,
   it is filed, and it must not block unrelated work". Bounding a defect of ours behind an entry
   whose `issue` points at a vendor record is the mechanism being used to look away.

**Reproduction.**

```sh
# fails inside the sweep
pnpm --filter @onchain-intel/mcp-server gate --task l-25-repro
# answers alone, same chain, same code path
curl -sS -o /dev/null -m 60 --compressed -w "%{http_code} %{time_total}s\n" \
  https://api.llama.fi/overview/dexs/bsc
```

**Related.** [L-24](l-24-defillamas-two-per-call-history-routes-answer-erratically.md) — the vendor
half, measured separately and deliberately kept separate.
[L-22](l-22-pairs-active-loses-two-chains-under-gate-load-while-the-vendor-still-serves-them.md) —
the same sentence one level down, and its title is the summary of this one too: rows lost under gate
load while the vendor still serves them.
[WI-65](../backlog/wi-65-the-gate-cannot-tell-a-vendor-outage-from-a-stall-on-our-own-link.md) — the
measurement that made this attribution possible instead of arguable.
