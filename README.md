# onchain-intel

An on-chain analytics engine exposed as an **MCP server**: provider adapters (CoinGecko,
DexScreener, DeFiLlama, EVM/Solana RPC, Nansen, …) → normalization into one canonical schema →
two-level cache + credit budget guard → 22 workflow-oriented tools your agent can call.

**Русская версия:** [README.ru.md](README.ru.md)

> Every example in this file was executed against the built server. Outputs are real, trimmed only
> for length. The three paid tools are shown from recorded fixtures — they were not called live
> while writing this.

---

## Table of contents

- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Install and build](#install-and-build)
- [Configuration](#configuration)
- [Connect to Claude Code](#connect-to-claude-code)
- [Verify it works](#verify-it-works)
- [Tool reference](#tool-reference)
  - [onchain_ping](#onchain_ping)
  - [onchain_get_token](#onchain_get_token)
  - [onchain_wallet_balances](#onchain_wallet_balances)
  - [onchain_active_pairs](#onchain_active_pairs)
  - [onchain_protocol_tvl](#onchain_protocol_tvl)
  - [onchain_list_chains](#onchain_list_chains)
  - [onchain_chain_tvl](#onchain_chain_tvl)
  - [onchain_dex_volume](#onchain_dex_volume)
  - [onchain_token_holders](#onchain_token_holders)
  - [onchain_chain_supply](#onchain_chain_supply)
  - [onchain_smart_money_flows](#onchain_smart_money_flows-paid)
  - [onchain_entity_label](#onchain_entity_label-paid)
  - [onchain_token_risk](#onchain_token_risk-paid)
  - [onchain_dash_platform_history](#onchain_dash_platform_history)
  - [onchain_pool_info](#onchain_pool_info)
  - [onchain_token_pools](#onchain_token_pools)
- [Response envelope](#response-envelope)
- [Credit budget guard](#credit-budget-guard)
- [Behaviour without API keys](#behaviour-without-api-keys)
- [Caching](#caching)
- [Development and testing](#development-and-testing)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)

---

## What you get

**22 MCP tools.** One liveness check, one chain-registry tool, eight free/keyless data tools,
and three paid Nansen-backed alpha tools.

**Two chains:** `ethereum` and `solana`. Every tool takes an explicit `chain`.

**Canonical output.** Provider DTOs never leak — each tool returns a versioned zod-validated
domain object, so swapping a provider does not change your agent's contract.

**Money safety.** Nansen is the only paid provider. Every paid call is priced from a static cost
table and atomically reserved against a daily ledger **before** the network request. No call can
exceed the vendor balance or your own ceiling.

**Works with no keys at all.** An empty `.env` is a valid configuration: keyless tools work, paid
tools return an explicit error instead of silently returning nothing.

---

## Requirements

| Requirement | Version | Note                                            |
| ----------- | ------- | ----------------------------------------------- |
| Node.js     | ≥ 22    | uses `process.loadEnvFile()`, no `dotenv`       |
| pnpm        | 11.15.1 | `corepack enable pnpm` picks it up              |
| OS          | any     | native module `better-sqlite3` needs a prebuild |

No Docker, no database server. State is a single SQLite file.

---

## Install and build

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm build
```

The build produces `packages/mcp-server/dist/index.js` — that file is the server.

Confirm the artifact runs before wiring anything into an agent:

```bash
pnpm --filter @onchain-intel/mcp-server run smoke:dist
# smoke-dist: PASS: onchain_ping OK over dist/index.js (version 0.1.0)
```

---

## Configuration

Create `.env` in the project root and lock it down:

```bash
cp .env.example .env && chmod 600 .env
```

**Every key is optional.** An empty `.env` starts a working server. Keys are read inside the call
that needs them, never at module load, never logged, and never part of a cache key.

| Key                               | Needed for                           | Default                              |
| --------------------------------- | ------------------------------------ | ------------------------------------ |
| `NANSEN_API_KEY`                  | the 3 paid tools                     | unset → those tools return `isError` |
| `NANSEN_DAILY_CREDIT_CAP`         | self-imposed spend ceiling           | derived, see below                   |
| `NANSEN_VELOCITY_CREDITS_PER_MIN` | spend-rate brake                     | derived, see below                   |
| `NANSEN_BUDGET_WARN_RATIO`        | stderr warning threshold             | `0.8`                                |
| `COINGECKO_API_KEY`               | higher CoinGecko limits (demo tier)  | keyless works                        |
| `COINGECKO_PRO_API_KEY`           | CoinGecko Pro host                   | —                                    |
| `ONCHAIN_PG_URL`                  | historical snapshots (read-only DSN) | history falls back to a free source  |
| `DATA_DIR`                        | cache + budget ledger location       | `~/.onchain-intel`                   |
| `LOG_LEVEL`                       | reserved, no effect yet              | —                                    |

`DUNE_API_KEY` is reserved: the adapter is a stub and reports unavailable even when the key is set.

**Endpoints, hosts, rate limits and TTLs are deliberately NOT env-configurable.** They are declared
in `packages/core/src/providers.config.ts`, because an env-overridable URL would be a hole in the
SSRF allowlist.

---

## Connect to Claude Code

Add a `.mcp.json` in the project root (it is gitignored — it may hold other servers' secrets):

```json
{
  "mcpServers": {
    "onchain-intel": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"]
    }
  }
}
```

No `env` block is needed: the server loads `.env` from its working directory itself.

Restart Claude Code, then confirm the tools appear:

```
/mcp
```

You should see **22 tools** under `onchain-intel`.

---

## Verify it works

Cheapest possible check — no network, no keys:

```
Call onchain_ping
```

```json
{ "ok": true, "service": "onchain-intel-mcp-server", "version": "0.1.0", "ts": 1785013396663 }
```

Then a real keyless lookup:

```
What is Uniswap's TVL on ethereum?
```

The agent calls `onchain_protocol_tvl` and gets back real data plus cache metadata.

---

## Tool reference

Cost is in Nansen credits. Free tools cost nothing and need no key.

| Tool                            | Cost           | TTL   | Key required     |
| ------------------------------- | -------------- | ----- | ---------------- |
| `onchain_ping`                  | —              | —     | no               |
| `onchain_get_token`             | free           | 60s   | no               |
| `onchain_wallet_balances`       | free           | 60s   | no               |
| `onchain_active_pairs`          | free           | 30s   | no               |
| `onchain_protocol_tvl`          | free           | 300s  | no               |
| `onchain_list_chains`           | free           | —     | no               |
| `onchain_chain_tvl`             | free           | 300s  | no               |
| `onchain_dex_volume`            | free           | 3600s | no               |
| `onchain_chain_tvl_history`     | free           | 3600s | no               |
| `onchain_list_protocols`        | free           | 300s  | no               |
| `onchain_protocol_tvl_history`  | free           | 3600s | no               |
| `onchain_gas_price`             | free           | 30s   | no*              |
| `onchain_chain_transactions`    | free           | 600s  | no*              |
| `onchain_protocol_incidents`    | free           | 3600s | no               |
| `onchain_token_holders`         | free           | 3600s | no               |
| `onchain_chain_supply`          | free           | 600s  | no               |
| `onchain_smart_money_flows`     | **10 cr**      | 300s  | `NANSEN_API_KEY` |
| `onchain_entity_label`          | **0/5/100 cr** | 3600s | `NANSEN_API_KEY` |
| `onchain_token_risk`            | **6 cr**       | 1800s | `NANSEN_API_KEY` |
| `onchain_dash_platform_history` | free           | 3600s | no               |
| `onchain_pool_info`             | free           | 300s  | no               |
| `onchain_token_pools`           | free           | 300s  | no               |

### onchain_ping

Deterministic liveness check. No arguments, no network.

Input:

```json
{}
```

### onchain_get_token

Token metadata and USD price for a contract address (CoinGecko-backed).

Input:

```json
{ "chain": "ethereum", "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }
```

`structuredContent` — real output:

```json
{
  "chain": "ethereum",
  "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "symbol": "USDC",
  "name": "USDC",
  "decimals": 6,
  "priceUsd": 0.999812,
  "marketCapUsd": 72541470656,
  "source": "coingecko",
  "fetchedAt": 1785013418631
}
```

### onchain_wallet_balances

Native asset balance (ETH or SOL) for a wallet, via keyless JSON-RPC.

Input:

```json
{ "chain": "ethereum", "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }
```

### onchain_active_pairs

Recently active DEX trading pairs (DexScreener-backed). `limit` is optional.

Input:

```json
{ "chain": "ethereum", "limit": 2 }
```

`structuredContent` — real output, trimmed:

```json
{
  "chain": "ethereum",
  "pairs": [
    {
      "id": "ethereum:0x2287a9620adcbf6250dc71be9ee9b2d3a1ec85a464fc6f5c06669e8d07b61bba",
      "chain": "ethereum",
      "dexId": "uniswap",
      "baseTokenSymbol": "ETH",
      "quoteTokenSymbol": "USDT",
      "pairAddress": "0x2287a9620adcbf6250dc71be9ee9b2d3a1ec85a464fc6f5c06669e8d07b61bba"
    }
  ],
  "source": "dexscreener",
  "fetchedAt": 1785013418631
}
```

### onchain_protocol_tvl

Protocol TVL, chain-scoped and total, for a DeFiLlama slug.

Input:

```json
{ "chain": "ethereum", "protocolSlug": "uniswap" }
```

`structuredContent` — real output:

```json
{
  "protocol": "uniswap",
  "chain": "ethereum",
  "tvlUsd": 2115652448.748167,
  "totalTvlUsd": 3010303811.127217,
  "deployed": true,
  "deployments": [
    { "chain": "ethereum", "tvlUsd": 2115652448.748167 },
    { "chain": "base", "tvlUsd": 364101280.4103535 }
  ],
  "unmappedDeployments": 10,
  "aggregatedFrom": ["uniswap-v3", "uniswap-v4", "uniswap-v2", "uniswap-v1", "uniswap-auctions"],
  "source": "defillama",
  "fetchedAt": 1785013396663
}
```

`deployments` is shown truncated — the real answer lists all 42 chains this engine can name,
TVL-descending, and `unmappedDeployments: 10` says how many more the vendor listed under names the
chain registry does not carry, so the list can be read as complete or not. A protocol that is **not**
on the requested chain answers `deployed: false` with `tvlUsd: 0`, which is the answer rather than an
error; `tvlUsd: null` with `deployed: true` means the vendor publishes only staking/borrowed buckets
there and no plain figure. `aggregatedFrom` is non-empty when the slug names a family
(`uniswap`) rather than one protocol (`uniswap-v3`), and lists exactly what was summed.

### onchain_list_chains

Which chains this server knows, and which capabilities are actually served on each. Answers from a
local registry of 458 networks — no network call, no key. Use it to find the right `chain` value
before calling anything else, or to check whether a capability reaches the chain you care about.

Input — everything is optional; `capability` narrows the answer to chains where that capability is
really covered:

```json
{ "capability": "token.price", "limit": 20 }
```

### onchain_chain_tvl

Total value locked of a whole **chain**, from DeFiLlama. For a single protocol use
`onchain_protocol_tvl` instead — the two answer different questions and are easy to confuse.

Input:

```json
{ "chain": "ethereum" }
```

### onchain_dex_volume

Daily DEX trading volume for a chain, plus the aggregates DeFiLlama publishes alongside it (24h,
7d, 30d, all-time). The window matters: `gapDays` reports how many days inside it carry no data,
which is how a vendor that quietly stopped publishing becomes visible instead of looking like a
quiet market.

Input — `days` is the window, `includeSeries` controls whether the daily points come back or only
the aggregates:

```json
{ "chain": "ethereum", "days": 30, "includeSeries": true }
```

### onchain_token_holders

The largest holders of a token and their exact balances, from Blockscout's public explorer API.

Two fields decide whether the answer means what it looks like. `truncated` says the list is not the
complete tail — either more holders exist beyond the page, or rows were dropped. `droppedRows`
counts rows the server refused to publish because the vendor sent something it would not stand
behind. **Check both before reading the list as a concentration measure.**

Balances arrive as exact base-unit strings with no decimals applied — a token balance routinely
exceeds what a JSON number can hold without losing digits. Get `decimals` from
`onchain_get_token`.

Input:

```json
{ "chain": "ethereum", "tokenAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }
```

### onchain_chain_supply

How much of a chain's native asset exists. Bitcoin only today.

The answer carries **two figures that are not interchangeable**: `emissionRaw` is what the issuance
schedule has released, `circulatingRaw` is what was actually claimed. They differ by unclaimed
block subsidy — miners who never spent their reward — and using one where the other belongs
misstates supply. Both are exact integer strings in the smallest unit; the `*Btc` fields beside
them are lossy conveniences for display.

Input:

```json
{ "chain": "bitcoin" }
```

### onchain_dash_platform_history

Historical series for Dash Platform, **merged from two free sources**: `platform-explorer` (the
vendor's own history) and `pg-history` (your own Postgres ledger, used when `ONCHAIN_PG_URL` is
configured). It is the only tool that serves more than one capability, and the only one whose answer
is assembled from several sources rather than the first that replies.

Pick the series with `series`:

- `platform_metrics` — `identities_total` plus `documents_total`, `data_contracts_total` and
  `platform_total_credits`. **The last three exist only in your own ledger**, which is the point of
  merging: the vendor publishes none of them.
- `shielded_pool` — **two different quantities**, grouped separately and never combined:
  `shielded_pool_shield_amount` (inflow into the private pool, per transaction, from the vendor) and
  `shielded_pool_balance_credits` (the pool BALANCE, from your ledger). They are not two views of one
  number, and plotting them as one line would be wrong.

Points are always grouped by `metric` — never a flat list — and `valueRaw` is an exact integer
string that must not be parsed as a float. When a source could not contribute, `missingSources`
names it and the reason, and the answer still returns what the other source had.

Input:

```json
{ "chain": "dash", "series": "platform_metrics", "limit": 50 }
```

### onchain_smart_money_flows (paid)

Smart-money net flow over four windows plus top holders. **10 credits per cache miss.**

Input:

```json
{ "chain": "ethereum", "tokenAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }
```

`structuredContent` — shape and values from the recorded live fixture:

```json
{
  "chain": "ethereum",
  "tokenAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "tokenSymbol": "USDC",
  "netflow1hUsd": 0,
  "netflow24hUsd": -325939.1223102985,
  "netflow7dUsd": -4545283.010605299,
  "netflow30dUsd": -10796443.662655927,
  "traderCount": 142,
  "tokenAgeDays": 2912,
  "tokenSectors": ["Stablecoin"],
  "topHolders": [{ "address": "0x…", "addressLabel": "…", "ownershipPercentage": 1.23 }],
  "source": "nansen",
  "fetchedAt": 1785013396663
}
```

### onchain_entity_label (paid)

Entity and address labels. **Three price tiers**, chosen by the arguments you pass:

| Arguments                  | Cost       | What it does                        |
| -------------------------- | ---------- | ----------------------------------- |
| `query` only               | **0 cr**   | entity/token search                 |
| `tokenAddress` (± `query`) | **5 cr**   | adds holder-derived labels          |
| `exhaustive: true`         | **100 cr** | full profiler labels for an address |

At least one of `query` or `tokenAddress` is required. `exhaustive: true` additionally requires
`tokenAddress`, and is **never** enabled automatically — it costs an entire free-plan balance.

Input — free tier:

```json
{ "chain": "ethereum", "query": "wintermute" }
```

Input — the 100 cr escalation, opt-in only:

```json
{ "chain": "ethereum", "tokenAddress": "0xA0b8…eB48", "exhaustive": true }
```

### onchain_token_risk (paid)

Risk and reward indicators for a token, plus token metadata. **6 credits per cache miss.**

Input:

```json
{ "chain": "ethereum", "tokenAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }
```

`structuredContent` — shape and values from the recorded live fixture:

```json
{
  "chain": "ethereum",
  "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "marketCapUsd": 72947689222,
  "marketCapGroup": "largecap",
  "isStablecoin": true,
  "name": "USD Coin",
  "symbol": "USDC",
  "deploymentDate": "2018-08-03 19:28:24",
  "fdvUsd": 72949375871,
  "circulatingSupply": 72993578820.9766,
  "totalSupply": 72995577672.29245,
  "liquidityUsd": 536369088.28717536,
  "totalHolders": 3105691,
  "riskIndicators": [{ "indicatorType": "btc-reflexivity", "score": "low", "signal": 0.01 }],
  "rewardIndicators": [{ "indicatorType": "funding-rate", "score": "bullish", "signal": 1 }],
  "source": "nansen",
  "fetchedAt": 1785013396663
}
```

`riskIndicators` and `rewardIndicators` stay **two separate arrays** — never flattened, because a
risk signal and a reward signal are not interchangeable.

---

### onchain_pool_info

One DEX pool, looked up by its pair address on a chain. It answers with the **contract addresses**
of both tokens — which `onchain_active_pairs` never returns, it gives symbols only — plus the
per-side reserves and, where it can be derived, the fee tier.

`resolved: false` means this vendor knows no pool at that address on that chain. It is not an empty
pool: `pool` is `null` exactly then.

Reserves are the vendor's own rounded numbers, not exact base units. `feeTierBps` is absent wherever
the derivation does not answer, and is never inferred from the version label.

> **Registered, logic not shipped yet.** Calling it today returns a refusal naming the task that
> completes it. The schemas below are the final contract.

Input:

```json
{ "chain": "berachain", "pairAddress": "0x2608B7c8Eb17e22CB95b7cD6f872993cf33a4CA1" }
```

### onchain_token_pools

The DEX pools one token trades in, by token **address**.

With `chain`, the answer covers every DEX on that chain. Without it, the answer is a **sample across
chains** and each row states its own chain — a token address is not unique across chains, and a fork
reproduces the addresses of the chain it forked, so the cross-chain form must never be read as
complete.

Read `truncated` before concluding a token is thinly traded: the vendor caps its page, and that cap
is not widened by `limit`.

> **Registered, logic not shipped yet.** Calling it today returns a refusal naming the task that
> completes it. The schemas below are the final contract.

Input:

```json
{ "token": "0xD2C41BF4033A83C0FC3A7F58a392Bf37d6dCDb58", "chain": "berachain", "limit": 20 }
```

## Response envelope

Every tool returns MCP's standard `content` + `structuredContent`, plus a `_meta` sibling that
never changes the output schema.

```jsonc
"_meta": {
  "cache": { "status": "miss", "provider": "defillama", "capability": "protocol.tvl" }
}
```

On a cache hit you also get the age:

```jsonc
"_meta": {
  "cache": { "status": "hit", "ageMs": 2, "provider": "defillama", "capability": "protocol.tvl" }
}
```

Paid tools add `budget` — **only on a cache miss**, because a cache hit spends nothing:

```jsonc
"_meta": {
  "cache": { "status": "miss", "provider": "nansen", "capability": "smart-money.flows" },
  "budget": { "provider": "nansen", "creditsUsedToday": 16 }
}
```

The absence of `budget` on a hit is deliberate, not an omission: it is how you can tell a free
answer from a paid one.

---

## Credit budget guard

Nansen calls spend real money, so the engine will not let them run unchecked.

**Before every paid call:**

1. the exact price is looked up in a static cost table — never an estimate, and an unknown price
   fails closed at infinity rather than defaulting to zero;
2. a live `/account` check (0 credits) supplies the vendor's real remaining balance;
3. the cost is **atomically reserved** in a SQLite ledger inside a single transaction;
4. only then does the HTTP request go out.

After the call, the vendor's reported charge is reconciled against the reservation, so the ledger
converges on what was actually billed.

### `NANSEN_DAILY_CREDIT_CAP` — three states

| Value              | Behaviour                                                          |
| ------------------ | ------------------------------------------------------------------ |
| unset (default)    | derived: `max(30, 25% of the balance at the start of the UTC day)` |
| a positive integer | your explicit ceiling                                              |
| `off`              | no self-imposed ceiling — only the vendor balance binds            |

The derived default means the guard is **on out of the box**. It scales with your plan: a balance
of 100 gives a cap of 30, a balance of 10 000 gives 2500. `0` is deliberately rejected — it is one
typo away from silently disabling a money guard, and semantically ought to mean "spend nothing".

A refusal is loud and names which bound stopped it:

```
nansen budget gate refused: self-imposed cap (derived): need 10, allows 30 …
```

### `NANSEN_VELOCITY_CREDITS_PER_MIN` — the rate brake

The daily cap bounds spend **per day**, which is a damage ceiling, not a brake: the throttle
permits roughly 50 credits/second, so a large cap could be consumed in under a minute by a runaway
loop — the ceiling held, but nobody got a chance to notice. A second limit bounds the **rate**
([SEC-1](docs/issues/sec-1-nansen-daily-cap-does-not-bound-a-burst-no-velocity-guard.md), fixed).

| Value              | Behaviour                                                          |
| ------------------ | ------------------------------------------------------------------ |
| unset (default)    | derived: `max(100, ceiling-in-force / 20)` credits per 60s window  |
| a positive integer | your explicit per-minute allowance                                 |
| `off`              | no rate brake — only the daily ceiling and the vendor balance bind |

The divisor of 20 means a full day's budget takes at least ~20 minutes of sustained spending to
exhaust. The floor of 100 is the price of the dearest single call (`entity.labels` at its
`exhaustive` tier) — a limit below one call's cost would make that capability impossible rather
than rate-limited. Where the floor exceeds what the daily cap allows, the daily cap binds first:
the two guards compose, and the tighter one wins.

Checked and reserved **inside the same transaction** as the daily reservation, against a
`usage_window` table in `DATA_DIR` — so two Claude Code sessions sharing one machine cannot each
pass their own window check, and a process restart does not reset it.

The refusal says which limit stopped you, because the two call for opposite responses:

```
nansen budget gate refused: velocity limit (derived): 125 credits per 60s, need 10 —
the DAILY budget is not exhausted; retry after the window rolls over, or set
NANSEN_VELOCITY_CREDITS_PER_MIN to raise it, or off to disable it.
```

**Known limitation:** the window is tumbling, not sliding, so a burst straddling a boundary can
reach 2× the allowance. That does not undermine the goal of buying a human time to notice.

### `NANSEN_MAX_CALLS_PER_MIN` — the limit that can see a free call

Both limits above count **credits**, and `entity.labels`' query tier costs **zero** of them. For a
0-credit call, `used + 0 > ceiling` is false for the entire life of any bucket, under any cap — so
no credit-denominated guard can ever refuse it, however low you set it. That is not a bug in the
ceiling; it is what "denominated in credits" means. The fix is a different unit
([Q-3](docs/issues/q-3-nansen-zero-credit-entity-labels-tier-is-unrefusable-by-the-gate.md), fixed).

| Value              | Behaviour                                          |
| ------------------ | -------------------------------------------------- |
| unset (default)    | 60 calls per 60s window                            |
| a positive integer | your explicit allowance                            |
| `off`              | calls are unbounded — only the credit limits apply |

**A fixed default, not a derived one** — the asymmetry from the two credit limits is deliberate.
Credit limits are derived because a `free` balance and a `Pro` balance differ by orders of
magnitude. A call is a call on either plan: neither the vendor's rate limits nor cache-row pressure
scales with your balance, so there is nothing to derive from. 60/minute is one sustained call per
second — well above any interactive session, ~5× below what the throttle alone would permit.

It also bounds cache growth as a side effect: at 60 calls/min against a 3600s TTL, rows for that
capability settle at ~3600 instead of growing without limit.

**A call is never refunded.** Reconciliation adjusts credits; the call count only goes up. The
vendor round trip happened, and refunding it would let cheap-then-refunded calls walk past the
limit that exists to bound exactly that traffic.

The refusal says so explicitly, because the credit knob will not help here:

```
nansen budget gate refused: call rate limit (default): 60 calls per 60s — this bound counts
CALLS, not credits, so it applies to zero-credit tiers too and raising a credit ceiling will
not move it.
```

### Provenance gate

`docs/provenance.json` pins the sha256 of the golden test and every live-recorded vendor fixture.
`pnpm test` checks the working tree; `.githooks/pre-commit` checks what is actually **staged**.
Editing a pinned file without re-baselining in the same commit turns both red
([RF-2](docs/issues/rf-2-m2-evidence-records-drifted-from-the-shipped-commit.md), fixed).

Re-baseline deliberately, in the same commit as the change, so a reviewer sees both halves:

```sh
node scripts/verify-provenance.mjs --update
```

### Format gate

`prettier --check .` is CI step two of eight, and for thirteen days it was the only place the
formatter ran: seven CI failures on six different files, each of them stopping the run before
typecheck, test, build and smoke:dist ever started
([RF-11](docs/issues/rf-11-the-format-gate-lived-only-in-ci-so-it-turned-main-red-six-times-in-thirteen-days.md),
fixed). `.githooks/pre-commit` now runs the same check over the **staged** blobs first:

```sh
pnpm format:check:staged      # what the hook runs; `pnpm format:check` is the repo-wide CI one
```

Its scope is the CI step's scope — same `.prettierignore`, same config — so it cannot refuse a
commit CI would have passed. It reports and never rewrites; fix with `pnpm format` and restage.

### Enabling the hooks

Both gates above live in one hook. Enable it once per clone — git hooks are local and cannot ship
enabled:

```sh
git config core.hooksPath .githooks
```

`--no-verify`, or a clone that never ran that line, bypasses both. CI still checks; the hook only
moves the answer to before the push.

---

## Behaviour without API keys

Missing keys degrade **explicitly**. The three paid tools return an MCP error naming the missing
key; nothing else in the engine is affected:

```json
{
  "content": [
    {
      "type": "text",
      "text": "capability unavailable: smart-money.flows on ethereum — tried: nansen (needs NANSEN_API_KEY)"
    }
  ],
  "isError": true
}
```

The key's **value** never appears in any error, log or cache key.

This is a deliberate design choice over silently falling back to a free provider: there is no free
equivalent that means the same thing, and a quiet substitution would be worse than a loud error.

---

## Caching

Two layers, one policy: an in-memory LRU in front of SQLite in `DATA_DIR`. The cache key is
`(provider, capability, normalized args)` — **API keys are never part of it**, so rotating a key
does not invalidate your cache.

| Capability          | TTL   | Why                                        |
| ------------------- | ----- | ------------------------------------------ |
| `pairs.active`      | 30s   | freshness is the whole point               |
| `token.price`       | 60s   | moves continuously                         |
| `wallet.balances.*` | 60s   | moves continuously                         |
| `protocol.tvl`      | 300s  | slow-moving aggregate                      |
| `smart-money.flows` | 300s  | contains a rolling 1-hour window           |
| `token.risk`        | 1800s | daily-ish scores, 6 cr per miss            |
| `token.metadata`    | 3600s | rarely changes                             |
| `entity.labels`     | 3600s | labels change over days; up to 100 cr/miss |

**Negative caching.** If a vendor answers successfully but the response cannot be normalized, that
verdict is remembered for 60 seconds — so a retry fails the same way without paying again. Only
deterministic failures are cached; transport errors, 429s and 5xx are not, because those can
legitimately succeed on the next attempt.

---

## Development and testing

```bash
pnpm lint          # eslint
pnpm format:check  # prettier
pnpm typecheck     # tsc --noEmit, strict + noUncheckedIndexedAccess
pnpm test          # vitest (run it for the count — a frozen number here only rots)
pnpm build         # tsup + declarations
```

Run the server from source without building:

```bash
pnpm --filter @onchain-intel/mcp-server dev
```

**The whole suite runs offline and costs zero credits.** Every provider response in the tests comes
from a recorded fixture. You can prove it by blocking the network — the suite stays green with zero
outgoing calls.

---

## Troubleshooting

**Tools do not appear in Claude Code.** Run `pnpm build` first — `.mcp.json` points at
`dist/index.js`, which does not exist until you build. Restart Claude Code after editing
`.mcp.json`.

**A paid tool returns `needs NANSEN_API_KEY`.** The server reads `.env` from **its working
directory**. Under Claude Code that is the project root, so `.env` must live there.

**A paid tool is refused with a budget message.** Expected — it means the guard is working. Check
`_meta.budget.creditsUsedToday`, then either wait for the UTC day to roll over or raise
`NANSEN_DAILY_CREDIT_CAP`.

**Two machines, one Nansen account.** Each installation keeps its own ledger in its own `DATA_DIR`,
so a self-imposed cap is counted per installation. The vendor balance still binds both.

**Everything looks stale.** `DATA_DIR` defaults to `~/.onchain-intel`. Deleting that directory
resets the cache — and also the usage ledger, so the daily cap starts from zero.

---

## Project layout

```
packages/core/          engine: adapters, canonical types, cache, budget guard
packages/mcp-server/    MCP server: 22 tools, env validation, stdio transport
docs/                   architecture, ADR, roadmap, issue ledger
n8n-workflows/          exported snapshotter workflows (separate always-on system)
```

Where to read more:

- [docs/onchain-analytics/ADR-001-tech-stack.md](docs/onchain-analytics/ADR-001-tech-stack.md) —
  the 12 accepted stack decisions and why.
- [docs/onchain-analytics/ROADMAP.md](docs/onchain-analytics/ROADMAP.md) — milestones, current
  state, cost ladder.
- [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) — the issue ledger, including what is deliberately
  not fixed.
- [.env.example](.env.example) — every environment key, annotated.

**License:** Apache-2.0.
