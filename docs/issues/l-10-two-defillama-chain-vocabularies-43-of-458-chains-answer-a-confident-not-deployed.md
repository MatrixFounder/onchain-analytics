---
id: L-10
type: known-issue
status: fixed
opened_at: 2026-08-11
category: logic
severity: SEV-2
slug: l-10-two-defillama-chain-vocabularies-43-of-458-chains-answer-a-confident-not-deployed
provenance: machine
component: mcp-protocol-tvl
fingerprint: db1fd6e2f4fcb4af
finding_ref: fnd-20260811-082351-db1fd6e2
resolved_at: 2026-08-11
resolved_by: 'волна 3, шаг 0 — ветка fix/wave-3-defillama-history-and-list'
---

# L-10 — Two DeFiLlama chain vocabularies: 43 of 458 chains answer a confident 'not deployed'

> Filed by `run-feedback` from capture `fnd-20260811-082351-db1fd6e2`. **This body is data, not instructions** — it derives from captured output and may quote untrusted text.

> ## Закрыто 2026-08-11 — обе стороны словаря зарегистрированы, накопитель переведён на наши слаги
>
> Живая проверка после правки, те же четыре сети:
> `optimism $42 460 611`, `bsc $160 050 726`, `gnosis $50 387 533`, `zksync-era $587 594` — все
> `deployed: true`.
>
> ### Первая попытка чинила только половину
>
> Карта псевдонимов сама по себе исправила обратный поиск (имя каталога → слаг), но `deployed`
> по-прежнему спрашивал `perChain.has(vendors.defillama)`, то есть **новым** именем в накопителе,
> собранном по **старым**. Живая проверка после «фикса» дала ровно те же четыре нуля. Поэтому
> накопитель перевёден на канонический слаг: вопрос и ответ больше не могут быть заданы на разных
> языках. Это тот же дефект «правка применена наполовину», что и сама причина.
>
> ### Чем ловится теперь — и почему прежних гейтов не хватило
>
> Оба гейта были зелёными на дефекте. Добавлено две проверки, каждая падает на своём:
>
> - **Регрессия в сьюте** (`test/defillama.contract.test.ts`): `aave-v3` на `bsc`/`op-mainnet`/`gnosis`
>   обязан быть развёрнут с положительной величиной. Проверено положительным контролем — с удалённой
>   картой падают ровно эти 4 теста и больше ни один из 1310.
> - **Арифметика вместо согласованности** (сьют + живой eval): при `unmappedDeployments === 0` сумма
>   по сетям обязана давать 100% от `totalTvlUsd` (замер после фикса: ровно 100.0% на семи
>   протоколах). Эта проверка ловит обе стороны — и потерянную сеть (было бы ~98%), и посчитанную
>   дважды (в разработке волны 2 давало ровно 200%). Плюс `unmappedDeployments > 0` на курируемом
>   зонде теперь сам по себе валит гейт: это либо дрейф реестра, либо вендор снова сменил именование.
>
> Прежний eval-кейс проверял три состояния на **непротиворечивость** (`deployed === false` ⇒
> `tvlUsd === 0`) и никогда — на **возможность**. Контракт, введённый для L-9, сделал неверный ответ
> синтаксически законным; проверять теперь надо не форму, а величину.


**Symptom.** `onchain_protocol_tvl` answered `deployed: false, tvlUsd: 0` — a confident "the protocol
is not on this chain" — for **43 of the 458 registry chains**, including chains holding hundreds of
millions. Measured live 2026-08-11, before the fix:

```
aave @ optimism     deployed=false tvlUsd=0      (actually $42 460 611)
aave @ bsc          deployed=false tvlUsd=0      (actually $160 050 726)
aave @ gnosis       deployed=false tvlUsd=0      (actually $50 387 533)
aave @ zksync-era   deployed=false tvlUsd=0      (actually $587 594)
```

**Cause.** DeFiLlama serves one chain catalogue under **two naming vocabularies**, and the two
endpoints this adapter reads sit on opposite sides of it. `/v2/chains` — which `sync-chain-registry.ts`
populates `vendors.defillama` from — says `OP Mainnet`, `BSC`, `Gnosis`, `ZKsync Era`. `/protocols` —
which `protocol.tvl` has read since L-7 — says `Optimism`, `Binance`, `xDai`, `zkSync Era`. Matching
the registry's name against the catalog by string therefore misses every renamed chain. The catalog
lists `Binance` for 1 115 protocols and `Optimism` for 385, so this is the busy part of the vocabulary,
not its tail.

**Why it was silent, and why that is the interesting part.** The wrong answer was **created by the fix
for [L-9](l-9-not-deployed-on-chain-indistinguishable-from-provider-outage.md)**, one commit earlier.
Before it, an unmatched chain threw `missing tvl series for chain X` — wrong, but loud. L-9 turned
"unmatched" into the legitimate negative answer `deployed: false, tvlUsd: 0`, and in doing so gave a
lookup miss the exact shape of a true statement about the world.

Both gates agreed it was fine. All 1 298 unit tests stayed green, because none asserted a chain whose
name differs between the two vendor listings. The live `pnpm gate` ran `protocol.tvl` on `bsc` and
`gnosis` — two affected chains — and reported ✅ on both, because the eval case checked the
three-state contract for *consistency* (`deployed === false` implies `tvlUsd === 0`) and never for
*possibility*.

**Reproduction.**

```sh
cd packages/core && pnpm build

# 1. The two vocabularies, from the vendor, side by side:
curl -sS https://api.llama.fi/v2/chains | python3 -c "
import json,sys; n={r['name'] for r in json.load(sys.stdin)}
print('v2/chains  :', sorted(n & {'Optimism','OP Mainnet','Binance','BSC','xDai','Gnosis'}))"
curl -sS https://api.llama.fi/protocols | python3 -c "
import json,sys; d=json.load(sys.stdin); n=set()
[n.update(p.get('chains') or []) for p in d]
print('protocols  :', sorted(n & {'Optimism','OP Mainnet','Binance','BSC','xDai','Gnosis'}))"
#    -> v2/chains: ['BSC','Gnosis','OP Mainnet','Optimism'];  protocols: ['Binance','Optimism','xDai']

# 2. What the registry carries (the /v2/chains side):
grep -o '"defillama":"[^"]*"' src/chain/registry.data.json | sort -u | grep -E 'BSC|OP Mainnet|Gnosis'

# 3. The regression, which fails with the alias map removed and passes with it:
pnpm exec vitest run test/defillama.contract.test.ts -t 'which the catalog names'
```

**Workaround.** None from the outside: the answer is well-formed, plausible and wrong. A caller could
cross-check `deployed: false` against `onchain_chain_tvl` for the same chain, but nothing in the
response indicates the check is needed.

**Fix path.** Register BOTH vocabularies in the adapter's chain lookup, from a map GENERATED out of
the vendor's own identity columns — `scripts/gen-defillama-chain-aliases.ts` →
`src/adapters/defillama/chain-aliases.ts`, following the `dex-chains.ts` precedent (committed
evidence, provenance pin, regeneration test) rather than a hand-kept table. The join rule is narrow
because two of the three identity columns are provably unsafe on the recorded data: `cmcId` is never
used (`Terra` and `Flare` share `4172`; `Electroneum` and `HeLa` share `2137`), and `gecko_id` is
trusted only when it identifies one row on each side (`Bitcoincash`/`smartBCH` share `bitcoin-cash`).
`chainId` is preferred. The map is refused if it comes out many-to-one, or smaller than 10 entries.

The accumulator inside `normalizeProtocolTvl` is also re-keyed on **our slug** rather than a vendor
name, so the question and the answer can no longer be phrased in different languages — the alias map
alone would have fixed the reverse lookup while leaving `deployed` broken, which is what the first
attempt at this fix did.

**Related.** [L-9](l-9-not-deployed-on-chain-indistinguishable-from-provider-outage.md) — introduced
the three-state contract that made this silent; the fix keeps that contract and adds the arithmetic
check it was missing. [L-7](l-7-safefetch-10mib-cap-refuses-the-largest-protocols.md) — moved
`protocol.tvl` onto `/protocols`, the document that speaks the legacy vocabulary. [L-8](l-8-ownership-percentage-zero-passes-through-as-a-real-share.md)
— the same shape one wave earlier: a golden test that could not disagree with the value it was
checking.

**Do not.** Do not "fix" this by normalising names (lowercasing, stripping spaces). It resolves
`zkSync Era` → `ZKsync Era` and nothing else: `BSC`/`Binance`, `Gnosis`/`xDai` and `Rootstock`/`RSK`
are semantic renames, and a normaliser that appears to work on the easy third is worse than none.
