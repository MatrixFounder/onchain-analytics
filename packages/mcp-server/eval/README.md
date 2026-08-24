# `eval/` — live eval of the free provider surface

```bash
pnpm eval                                        # all curated chains
ONCHAIN_EVAL_CHAINS=ethereum,solana pnpm eval    # narrow
ONCHAIN_EVAL_JSON=report.json pnpm eval          # + machine-readable artifact
```

## Why this exists

Every other suite in this repo runs against **fixtures**, deliberately: R-21 forbids network calls in
CI, and `scripts/smoke-dist.mjs` states in its own header that it stays ping-only and never calls a
data tool. The consequence is that **nothing ever asks a real provider a real question** — so a
vendor that changes its payload cannot be detected by the test suite at all.

That is not hypothetical. platform-explorer silently dropped the `poolBalance` field while still
returning HTTP 200; every fixture test stayed green and the gap stood for four days. Fixtures verify
our code against yesterday's snapshot of the vendor. This verifies it against the vendor.

It is therefore **not part of `pnpm test`** — it touches the network, it can be rate-limited, and a
flaky gate is a gate people disable.

## What it does

Spawns the **real** server and drives it over stdio as a real MCP client does: newline-delimited
JSON-RPC, the production `buildRegistry()` wiring, real adapters, real network. No injected
`fetchImpl`, no fixture registry, no importing internals. If it passes here, it works for a client —
which is the only claim worth making.

**Two phases, on two transports** (task 014-33). The **capability matrix** runs over stdio, which is
where it belongs: it does not depend on the transport and raises more cheaply. The **HTTP set** runs
after it, against a second process raised on its own profile, and covers exactly what stdio cannot
reach — a token refused, a perimeter refused, one end-to-end call, two concurrent sessions, and the
aggregate vendor RATE those two sessions produce.

That last one (`http-shared-limiter-rate.mjs`, WI-63) is the one case that deliberately spends wall
clock: about 19 s of full-refill waits and throttle wait at today's `rpc-evm` bucket, on 18 keyless
RPC calls and no credits. It measures whether two sessions share ONE token bucket, by comparing the
observed throttle wait against the two hypotheses the declared bucket implies — both derived from
`adapterRegistrations`, so nothing in the case restates a number `providers.config.ts` owns.

The HTTP set resolves its profile from `ONCHAIN_EVAL_HTTP_PROFILE`, defaulting to `network-sqlite`
because the `network` pair needs a running Postgres and this gate runs on a development machine. The
profile NAME is written into the JSON artifact and into the ledger line: `onchain.provider_buckets`
is covered only under `ONCHAIN_EVAL_HTTP_PROFILE=network`, so a run that does not say which pair it
used cannot be told apart from one that did.

Its process gets a temporary `DATA_DIR`, its own bootstrapped administrator and a token issued
before the process starts — the network profile refuses to start with zero active tokens. All three
are removed in a `finally`. A phase that could not be raised records one `error` row per case rather
than skipping: `no-probe` is not counted as a failure, so a skip would read as success.

The **chain** axis is derived from the live registry: for each chain the eval asks
`onchain_list_chains` which capabilities that chain declares, and exercises exactly those. A chain
added later is covered automatically, and a chain the registry _stops_ declaring stops being tested
rather than failing noisily.

The **capability** axis cannot be derived — a capability needs a tool name and an argument shape that
only a human knows — so it lives in `capabilities.mjs` as `CAPABILITY_TOOLS`. This README used to
claim it was automatic too, and it was not: `dex.volume.history` shipped, the list did not grow, and
the newest provider surface had no live coverage while the report showed nothing at all — not a
failure, not a `no-probe` row, no trace (RF-5). What is automatic now is noticing the two axes
disagree:

- at **run time**, every capability the selected chains declare and no case exercises is printed as
  its own `no-probe` row, with the chains that declare it;
- at **CI time**, `test/eval-capability-coverage.test.ts` fails when a tool serves a capability that
  is neither wired into `CAPABILITY_TOOLS` nor recorded in `CAPABILITY_EXCLUSIONS`. That half matters
  more, because this eval is deliberately not part of CI and a tool can ship between two runs of it.

**Free providers only** — DeFiLlama, CoinGecko, DexScreener, rpc-evm, rpc-solana, Blockscout,
blockchain-info. The three Nansen-backed capabilities are excluded because calling them spends
credits: an eval that bills you every run gets turned off, and a monitor that is off is worse than no
monitor. The exclusion is **data** (`CAPABILITY_EXCLUSIONS`, printed at the end of every run) rather
than an omission, because an exclusion nobody is reminded of is indistinguishable from an oversight.

(This paragraph appeared twice, in two slightly different wordings, until TASK-009 merged them — and
both copies still listed the five M1 providers after two free adapters had been added. A fact stated
twice is a fact that will be updated once.)

## Verdicts

|                   | meaning                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| ✅ `ok`           | every field the tool promises is present and usable                             |
| ⚠️ `degraded`     | the call succeeded but a promised field is missing/empty/implausible            |
| ❌ `error`        | the call failed outright                                                        |
| ⏳ `rate-limited` | the provider throttled us — **not tested**, not broken                          |
| `·` `unsupported` | the registry does not declare this capability here — a pass, hidden from output |
| `?` `no-probe`    | untested: no probe input curated, or no eval case wired for the capability      |

`degraded` exists separately from `error` on purpose: it is the class that cost us four days. A
provider that is _down_ is loud and obvious; a provider that quietly stops sending a field returns
200 and looks perfectly healthy. Likewise `rate-limited` and `no-probe` are kept out of the failure
count — an eval that scores its own missing test data as a provider defect is lying, and a report
that cries wolf stops being read.

Exit code is 0 unless something is `error` or `degraded`, so it can gate a release.

### Before you believe a run that blames several vendors at once

Check our own egress first, in the same minute, against hosts the engine does not use. Measured
2026-08-24: a run reported four `capability deadline exceeded` rows across two defillama routes and
pushed both blockscout acknowledgements over their bounds — three vendors, presented as three
independent facts. Five unrelated hosts were all answering at a uniform ~1.6 s with slow CONNECT
times, and ninety seconds later the same hosts answered in 0.39–0.53 s with 0.012 s connects. The
gate had measured our link.

```sh
for u in https://api.llama.fi/v2/chains https://api.coingecko.com/api/v3/ping \
         https://mcp.blockscout.com https://mempool.space/api/blocks/tip/height; do
  curl -sS -o /dev/null -m 25 -w "%{http_code} %{time_total}s %{time_connect}s conn  $u\n" "$u"
done
```

A uniform floor across unrelated companies and CDNs is one condition, not many. This matters beyond
reading one report: raising an acknowledgement bound is an act of MEASUREMENT (RF-10), and a bound
raised on a run taken during a local stall bakes weather into the record permanently. The reverse
error is just as available — dismissing a real vendor outage as "the link was probably bad" — which
is why the answer is to measure rather than to guess either way. Filed as WI-65 so the gate
eventually states this itself instead of relying on whoever remembers this paragraph.

## Cross-source checks (the combinations)

Single-provider cases cannot catch disagreement between sources. Three checks compare two
independent sources for the same fact:

- **registry vs provider** — the registry declares capability C for chain X; the provider must
  actually serve it. A mismatch means the catalogue promises a tool that then errors for an agent.
- **chain echo** — every response echoes the chain it answered for. If the echo differs from what
  was asked, the adapter's slug→vendor-id mapping is wrong and the answer is valid data _about a
  different chain_.
- **native symbol** — the registry's `nativeSymbol` (DeFiLlama-synced) versus what the RPC adapter
  reports. POL-vs-MATIC style drift surfaces here first.

An earlier design also chained DexScreener's token address into CoinGecko. The live payload settled
it: `active_pairs` returns `baseTokenSymbol` and never a contract address, so that chain does not exist
and claiming to test it would have been fiction.

## Reference sources — the second opinion (TASK-009)

The cross-checks above all compare two things the **engine** produced. That cannot catch a vendor
that is simply wrong, because both sides share a cause. A `referenceSources` entry in
`probes.json` names a source the engine does **not** use, which `run.mjs` fetches directly:

```jsonc
"referenceSources": {
  "btcTipHeight": { "url": "https://mempool.space/api/blocks/tip/height", "parse": "integer", … }
}
```

Adding one is a **config edit** — `parse: "integer"` reads a plain-text integer, `parse: "json"`
with a `path` reads a field out of a JSON document. Three rules keep the axis honest:

- **https only, and the host lives in this file.** The URL is never computed at run time. This
  script is outside `pnpm test` and outside `dist/`, so nothing an agent or a client can reach ever
  runs it — that, plus a reviewed data file, is what stands in for the server's SSRF gate here.
- **An unreachable reference is `no-probe`, never a provider failure.** It is our apparatus, not the
  vendor under test.
- **The value is printed every run**, not just its status. A cross-check that silently agreed and
  one that never ran look identical in a pass/fail column.

`supplyVsConsensus` is the first consumer, and it is worth knowing why it is shaped the way it is.
Re-deriving BTC emission from the halving schedule **cannot** contradict `blockchain-info` — the
vendor computes that field the same way, and it matched bit-exactly at both probed heights. So the
check compares the **block height** against `mempool.space` and lets the deterministic schedule
carry the disagreement into supply. The bound is in **blocks of subsidy** (`maxDeltaBlocks`, data,
default 6 ≈ an hour), never in percent: one block is 0.000016% and a day of staleness is 0.0023%, so
a percentage scale reports every real failure as rounding.

`mempool.space` is deliberately not an adapter. A source the engine answers from cannot be the
independent check on that answer.

## Maintaining `probes.json`

Probe inputs are **data**: adding a chain is a config edit, never a code change. Slugs and addresses
must be **verified against the live provider** before being committed — a wrong one reports as a
provider error and blames the server for a defect in the test data. (`babylon` vs `babylon-protocol`
on bitcoin was exactly that, caught on the first run.)

A chain with no curated input for a capability reports `no-probe`. That is the honest state and is
better than a guess. `dex.volume.history` needs no curated input at all — the tool takes a chain and
nothing else — so every chain in the file is exercised for it automatically.

## Known-good baseline

Full run, 2026-07-29 (after TASK-009 added `chain.supply` and the reference axis): **0 error, 0
degraded** — 61 ok, 33 unsupported, 4 no-probe, 2 rate-limited, exit code 0. The reference source
answered (`btcTipHeight = 960107`) and `bitcoin/chain.supply` agreed with it to **0 blocks**.

The two `rate-limited` rows were `base/token.holders` and `polygon/token.holders` — our OWN
defensive limiter on `blockscout` (`refillPerSec: 2`, TASK-008), not a vendor refusal. That is
working as designed and stays out of the failure count, but it is worth knowing which side threw:
the `ok`/`rate-limited` split moves between runs for two independent reasons now, CoinGecko's
unpredictable keyless tier and our own deliberately conservative Blockscout bucket.

(Previous baselines: 2026-07-28 read 55–57 ok / 15 unsupported / 4 no-probe — the unsupported count
grew because two capabilities were added, and a capability the registry declines on a chain is a
pass. 2026-07-27 read 44–45 ok / 14 unsupported / 2 no-probe, taken while the DEX-volume capability
existed and was never called, which is the defect, not a change in the providers.)

The four `no-probe` rows are stable and worth knowing. The first two are missing probe DATA; the last
two are capabilities with no eval case at all, and they are printed precisely so that a THIRD one
appearing is visible immediately:

- `bitcoin/token.price` — the registry declares the capability, but the tool needs a contract
  address and Bitcoin has none. The probe is not missing; the registry's claim is questionable.
- `zcash/protocol.tvl` — no DeFiLlama protocol curated for it.
- `—/token.metadata` — no tool calls it: `onchain_get_token` routes through `token.price` on purpose
  (a `token.metadata` cache entry would legally serve an hour-stale price), so the CoinGecko path is
  covered and this capability id is not.
- `—/pool.info` — declared by the registry and served by no MCP tool at all.
