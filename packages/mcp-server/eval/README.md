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

The matrix is **derived from the live registry**, not hand-written: for each chain the eval asks
`onchain_list_chains` which capabilities that chain declares, and exercises exactly those. A chain or
capability added later is covered automatically, and a chain the registry _stops_ declaring stops
being tested rather than failing noisily.

**Free providers only** — DeFiLlama, CoinGecko, DexScreener, rpc-evm, rpc-solana. The three
Nansen-backed tools are excluded because calling them spends credits; an eval that bills you every
run gets turned off, and a monitor that is off is worse than no monitor.

## Verdicts

|                   | meaning                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| ✅ `ok`           | every field the tool promises is present and usable                             |
| ⚠️ `degraded`     | the call succeeded but a promised field is missing/empty/implausible            |
| ❌ `error`        | the call failed outright                                                        |
| ⏳ `rate-limited` | the provider throttled us — **not tested**, not broken                          |
| `·` `unsupported` | the registry does not declare this capability here — a pass, hidden from output |
| `?` `no-probe`    | no probe input curated — fix `probes.json`, not the code                        |

`degraded` exists separately from `error` on purpose: it is the class that cost us four days. A
provider that is _down_ is loud and obvious; a provider that quietly stops sending a field returns
200 and looks perfectly healthy. Likewise `rate-limited` and `no-probe` are kept out of the failure
count — an eval that scores its own missing test data as a provider defect is lying, and a report
that cries wolf stops being read.

Exit code is 0 unless something is `error` or `degraded`, so it can gate a release.

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
it: `new_pairs` returns `baseTokenSymbol` and never a contract address, so that chain does not exist
and claiming to test it would have been fiction.

## Maintaining `probes.json`

Probe inputs are **data**: adding a chain is a config edit, never a code change. Slugs and addresses
must be **verified against the live provider** before being committed — a wrong one reports as a
provider error and blames the server for a defect in the test data. (`babylon` vs `babylon-protocol`
on bitcoin was exactly that, caught on the first run.)

A chain with no curated input for a capability reports `no-probe`. That is the honest state and is
better than a guess.

## Known-good baseline

Full run, 2026-07-27: **0 error, 0 degraded** — 44–45 ok, 14 unsupported, 2 no-probe, and 0–2
rate-limited. The `ok`/`rate-limited` split moves between runs because CoinGecko's keyless tier
throttles unpredictably; that is why `rate-limited` is a verdict of its own and stays out of the
failure count. Exit code was 0.

The two `no-probe` rows are stable and worth knowing:

- `bitcoin/token.price` — the registry declares the capability, but the tool needs a contract
  address and Bitcoin has none. The probe is not missing; the registry's claim is questionable.
- `zcash/protocol.tvl` — no DeFiLlama protocol curated for it.
