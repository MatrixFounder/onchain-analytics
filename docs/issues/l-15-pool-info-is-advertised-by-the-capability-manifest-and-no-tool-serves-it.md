---
id: L-15
type: known-issue
status: fixed
opened_at: 2026-08-11
category: logic
severity: SEV-3
slug: l-15-pool-info-is-advertised-by-the-capability-manifest-and-no-tool-serves-it
resolved_at: 2026-08-21
resolved_by: TASK 014-32c
---

# L-15 — `pool.info` is advertised by the capability manifest and no tool serves it

> **FIXED 2026-08-21 by task 014-32c.** `onchain_pool_info` is registered (task 014-32b shipped the
> `ToolSpec`) and serves `pool.info` from the vendor's per-chain single-pool route,
> `GET /latest/dex/pairs/{chainId}/{pairAddress}`. It answers with both token CONTRACT ADDRESSES —
> the link WI-56 needed and which `onchain_active_pairs` never carried — the per-side reserves, and
> the fee tier where an `eth_call` of `fee()` answers.
>
> **What keeps it from recurring is a gate, not the tool.** `packages/mcp-server/test/manifest-tool-coverage.test.ts`
> (AC-29) compares the manifest keys against the capabilities the registered tools resolve, and
> fails on any key that is neither served nor named in `CAPABILITY_KNOWN_GAPS` with a reason. This
> defect existed because the two inventories were each internally consistent and nothing compared
> them; six keys are named there today, each with its own reason.


> Origin: live analysis of `berachain` over the MCP server, 2026-08-11. Not a `run-feedback`
> capture — filed by hand from the session transcript.

**Symptom.** `onchain_list_chains({query: "bera"})` reports `pool.info` among the capabilities
served on `berachain`:

```
"capabilities": ["chain.tvl","chain.tvl.history","dex.volume.history","pairs.active",
                 "pool.info","protocol.incidents","protocol.list","protocol.tvl",
                 "protocol.tvl.history","token.metadata","token.price"]
```

No tool exposed by the server reaches it. The tool surface in this session was 20 tools — `ping`,
`list_chains`, `chain_tvl`, `chain_tvl_history`, `chain_supply`, `chain_transactions`, `dex_volume`,
`gas_price`, `list_protocols`, `protocol_tvl`, `protocol_tvl_history`, `protocol_incidents`,
`active_pairs`, `get_token`, `token_holders`, `token_risk`, `entity_label`, `wallet_balances`,
`smart_money_flows`, `dash_platform_history` — and none of them takes a pool or pair address.

`onchain_list_chains` is documented as the route for *"check where a capability is available"*, so
a capability listed there is a statement to the caller that the capability can be requested. For
`pool.info` that statement has no referent.

**Consequence, measured.** The session needed the token addresses behind the `osBGT/sWBERA` pool
(`0x2608B7c8Eb17e22CB95b7cD6f872993cf33a4CA1`) in order to resolve a symbol to a contract address
and price it with `onchain_get_token`. `onchain_active_pairs` returns `pairAddress` and token
*symbols*, never token addresses. With `pool.info` unreachable there is no route from a symbol to
an address anywhere in the engine, so the question was left unanswered rather than answered
approximately — the alternative would have been guessing a contract address, which returns a valid
looking price for the wrong token.

**Reproduction.**

```sh
onchain_list_chains({query: "bera"})     # capabilities include "pool.info"
onchain_list_chains({capability: "pool.info"})  # non-empty: the capability is registered
#   -> then look for a tool accepting a pool/pair address: none exists
```

**Workaround.** None inside the engine.

**Fix path (proposed).** Two directions, and the manifest must stop over-claiming either way:

1. Surface the capability — a tool taking a pool/pair address and returning its tokens (addresses,
   not only symbols), reserves and fee tier. This is the cheaper direction if the adapter behind
   `pool.info` is already implemented, and it unlocks symbol → address resolution, which is the
   precondition for [WI-56](../backlog/wi-56-token-level-measurement-symbol-address-size-history.md).
2. Remove `pool.info` from the manifest if nothing implements it.

Beyond this instance: the manifest and the tool surface are two independent inventories, and nothing
compares them. A check that every advertised capability is reachable from at least one tool would
have caught this without a live session — and would catch the next one, since the count is not
stable enough to audit by eye (WI-20 already records three independent tool inventories).

**Acceptance.** Every capability returned by `onchain_list_chains` resolves to at least one tool
that can request it, enforced by a test that walks the manifest against the registered tool list.

**Related.** [L-6](l-6-token-holders-advertised-everywhere-blockscout-403-everywhere.md) — the same
gap between what the manifest advertises and what can actually be obtained, there through a vendor
failure rather than a missing tool.
[WI-56](../backlog/wi-56-token-level-measurement-symbol-address-size-history.md) — blocked on this.
