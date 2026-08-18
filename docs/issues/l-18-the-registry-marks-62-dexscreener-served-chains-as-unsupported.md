---
id: L-18
type: known-issue
status: open
opened_at: 2026-08-18
category: logic
severity: SEV-2
slug: l-18-the-registry-marks-62-dexscreener-served-chains-as-unsupported
---

# L-18 — the registry marks 62 DexScreener-served chains as unsupported, and the live gate counts each refusal as a pass

> Origin: investigation of L-15's fix path, 2026-08-18. Not a `run-feedback` capture — filed by
> hand from the session transcript.

**Symptom.** `vendors.dexscreener` is non-null on 3 of 458 registry rows. A probe of the same day
resolves 65 registry rows to a DexScreener chain id. 62 rows carry `null` while the vendor serves
the chain.

`chainSupport` reads that column as the whole coverage answer
(`packages/core/src/adapters/dexscreener/index.ts:147-148`,
`chain.vendors['dexscreener'] != null && chain.nativeSymbol != null,`). Both capabilities routed to
this adapter are refused on those 62 chains.

**The column was never enumerated.** Its three values come from a literal inside the generator
(`packages/core/scripts/sync-chain-registry.ts:62`,
`const DEXSCREENER_OBSERVED: Readonly<Record<string, string>> = {`). `ethereum` and `solana` are
carried from the pre-registry hardcode. `berachain` is the single chain spot-checked on 2026-07-26
(`docs/onchain-analytics/raw/chain-registry-probe-2026-07-26.json`,
`"dexscreener_chainId": "berachain"`).

**Why the number stayed at 3.** TASK-006 set the bar at one chain. R-57 is a non-gating `Should`,
and its acceptance criterion reads «отрабатывает хотя бы на одной сети вне ethereum/solana». Commit
`939b303` records the outcome as `pairs.new 2 → 3`. The bar was met, and no obligation to measure
the vendor was left behind.

**Two clauses of one document define `null` differently.**

- `docs/architectures/data-model.md:141` — `` `null` = the vendor does not have the chain ``
- `docs/architectures/data-model.md:180` — `the absence of a probe means **`unverified`, not `unsupported`**`

The runtime follows the first clause. R-58d's distinction has an entity, `CoverageProbe`. The same
document scopes it to `exactly one consumer: nansen`.

DexScreener has no probe record and no evidence file. Every other vendor coverage set in this
repository has one under `docs/onchain-analytics/raw/`.

**Consequence, measured 2026-08-18.**

| Fact | Value |
| :--- | :--- |
| Registry rows resolving to a DexScreener chain id | 65 of 458 |
| Rows carrying `null` while the vendor serves them | 62 |
| Capabilities affected | `pairs.active`, `pool.info` |
| Adapters on those two routes | 1 — no fallback exists |
| Top-10 registry chains by TVL that are covered | 2 — `ethereum` and `solana` |

A call to `onchain_active_pairs` on `base` is refused before any HTTP request:

```
capability 'pairs.active' is not available on chain 'base'.
Available on: ethereum, berachain, solana.
```

The refusal states an absence at the vendor. The vendor answers on that chain.

**Why the gates stayed green.** The live eval derives its capability axis from
`onchain_list_chains`. A chain the registry does not declare is recorded as `unsupported`, hidden
from the report, and counted as a pass (`packages/mcp-server/eval/run.mjs:450`,
`(${unsupported} unsupported rows hidden — the registry declining a capability is a pass, not a gap)`).
`probes.json` already curates `base`, `arbitrum`, `polygon`, `bsc`, `avalanche` and `tron`. Six
chains the vendor serves were probed on every run and scored as passes.

No unit test pins the number 3. The only coverage assertion is a lower bound
(`packages/core/test/coverage.test.ts:348`,
`it('[R-57, Should] pairs.active reaches at least one chain outside ethereum/solana', () => {`),
and `berachain` alone satisfies it.

**Reproduction.**

```sh
# 1. the column
node -e "const d=require('./packages/core/src/chain/registry.data.json');
  console.log(d.chains.filter(c=>c.vendors.dexscreener).map(c=>c.slug))"   # 3 slugs

# 2. the vendor, per chain — HTTP 200 means the chain segment is known, 400 means it is not
curl -so /dev/null -w '%{http_code}\n' \
  https://api.dexscreener.com/latest/dex/pairs/base/0x0000000000000000000000000000000000000001   # 200
curl -so /dev/null -w '%{http_code}\n' \
  https://api.dexscreener.com/latest/dex/pairs/zcash/0x0000000000000000000000000000000000000001   # 400
```

**Reproduction of the alias half.** `sei` answers 400 and `seiv2` answers 200. Three vendor chain
ids observed in a 40-query sweep resolve to a registry row only through a missing alias —
`seiv2` → `sei`, `flowevm` → `flow`, `stepnetwork` → `step`. A fourth, `polkadot`, has no registry
row at all.

**Workaround.** None inside the engine. A hand-edit of `registry.data.json` survives the next sync
through the carry-forward term at `packages/core/scripts/sync-chain-registry.ts:472`
(`dexscreener: DEXSCREENER_OBSERVED[caip2] ?? prev?.vendors.dexscreener ?? null,`), and nothing then
reports that the data and the generator disagree.

**Fix path.** The rule that produced the literal stays. The instrument changes.

1. Replace the literal with a generator. The oracle is per-chain and deterministic: the pair route
   answers HTTP 200 for a known chain segment and HTTP 400 for an unknown one. This witnesses
   coverage instead of deriving it, so R-58d is satisfied literally.
2. Commit the evidence file under `docs/onchain-analytics/raw/`, as every other vendor coverage set
   does.
3. Add the three missing aliases and decide on `polkadot`.
4. State in `docs/architectures/data-model.md` which of the two `null` readings binds, and make the
   coverage matrix carry `unverified` where no probe has run.

**What widening costs, measured before it is done.** Of the 12 curated eval chains, 3 declare
`pairs.active` today and 9 declare it after widening. Six chains begin issuing live vendor calls on
every gate run. `packages/mcp-server/eval/cases/pairs-active.mjs` grades `truncated.pairs !== true`
as `degraded`, and `pnpm gate` blocks on a degraded row that carries no acknowledgement.

**Acceptance.** `vendors.dexscreener` is produced by a committed generator with a committed evidence
file. A chain the vendor serves is not refused with a statement that the vendor does not serve it. A
chain no probe has reached is distinguishable from a chain a probe has excluded.

**Related.** [L-10](l-10-two-defillama-chain-vocabularies-43-of-458-chains-answer-a-confident-not-deployed.md)
— the same class at 43 of 458 chains, through a name-vocabulary mismatch rather than an unmeasured
column; its post-mortem records the same green-gate mechanism.
[L-15](l-15-pool-info-is-advertised-by-the-capability-manifest-and-no-tool-serves-it.md) — the tool
this column would otherwise ship at three chains.
[WI-56](../backlog/wi-56-token-level-measurement-symbol-address-size-history.md) — blocked on both.
