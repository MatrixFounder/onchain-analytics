# Отчёт: система ончейн-аналитики для агентов

_Дата: 2026-06-30. Основа: локальный анализ конвенций Universal-skills + исследовательский воркфлоу (32 агента, 20 провайдеров, 71 репозиторий, 15 адверсариально-проверенных утверждений, 5 скорректировано)._

---

## 1. Главный вопрос: скилл в Universal-skills или отдельный проект?

**Ответ — гибрид, и это принципиально:**

| Слой | Где живёт | Почему |
|---|---|---|
| **Движок**: провайдер-адаптеры, нормализация, кеш+бюджет кредитов, signal/alert-движок, планировщик, **свой агрегирующий MCP-сервер** | **Отдельный проект** (напр. `onchain-intel`) | Stateful-сервис, держит платные API-ключи, тратит деньги на каждый вызов, имеет персистентное состояние (watchlists, история алертов). Это **доменный продукт**, не meta-skill. |
| **Скилл-слой**: как агенту *водить* движок + аналитические playbook-и | **Universal-skills**, 1 скилл сейчас → 2 позже | Тонкий, stateless, plug-and-play. Лёгкий free-путь может ходить в API напрямую с BYO-ключами в skill-local `.env` — как `transcript-fetcher`. |

### Почему не «просто скилл (или 2) в Universal-skills»

Проверено локально (README, `marketplace.json`, `SKILL_EXECUTION_POLICY.md`, `skill-creator`):

- Universal-skills декларирует себя как **«agent-agnostic, architecture-agnostic, plug-and-play meta-skills»**. Все 23 скилла (docx, pdf, mcp-builder, transcript-fetcher…) — **stateless, без платных ключей, без постоянного бэкенда**. Даже самый «интеграционный» `transcript-fetcher` — stateless-экстрактор с *опциональным* skill-local `.env`.
- `SKILL_EXECUTION_POLICY` требует **детерминированных, идемпотентных, CI-тестируемых скриптов** — не долгоживущих сервисов с секретами и состоянием.
- Skill-anatomy: `SKILL.md` + `scripts/` + `references/`, Script-First. Это **капсула знания/возможности**, а не дата-платформа.

Ончейн-движку нужно ровно противоположное: множество платных провайдеров с разной аутентификацией, **слой нормализации** разнородных схем, кеш, биллинг кредитов, планировщик и алертинг. Поместить это в Universal-skills — нарушить его тезис и сломать «plug-and-play».

### Про «1 или 2 скилла»

Рекомендация: **начать с одного** скилла `onchain-analytics`, спроектированного под раскол на два (YAGNI). Раскалывать, когда playbook-контент разрастётся:

- **`onchain-data-access`** — *read-слой*: как достать нормализованные данные (token / wallet / flow / OHLCV). Триггеры: «дай балансы кошелька», «новые пары на DEX», «TVL протокола».
- **`onchain-signals`** — *reasoning-слой*: как превратить данные в инсайты и алерты (smart-money накопление, ротация ликвидности, режим рынка по SOPR/MVRV). Триггеры: «отслеживай этот кошелёк», «найди альфу», «оцени риск токена».

---

## 2. Ландшафт провайдеров (с проверенными правками)

Порядок — по полезности для **инди-агентной** сборки (официальный MCP + низкий порог + ценность сигнала).

| Провайдер | Категория | API / auth | MCP | Free-tier / цена | Лучшее для |
|---|---|---|---|---|---|
| **CoinGecko** | Market+DEX, OHLC | REST; demo/Pro | **Офиц.** keyless `mcp.api.coingecko.com/mcp` | Demo $0 (10k/мес); Basic $35; Analyst $129 | Дефолтный keyless backbone цен |
| **DexScreener** | Raw DEX (новые пары, цена, ликвидность) | REST; **keyless** | community | Free ~300/мин. ⚠️ **REFUTED:** платный API-тариф **есть** | memecoin-launch discovery, realtime DEX без трения |
| **GeckoTerminal** | On-chain DEX (пулы, OHLCV) | REST; keyless beta | **Офиц. через CoinGecko MCP** | Free ~30/мин | Momentum по новым пулам, 200+ сетей |
| **Dune (Query API)** | Custom SQL по multi-chain | REST; `X-Dune-API-Key` | **Офиц.** `api.dune.com/mcp/v1`. ⚠️ **26 tools, не 29** | Free 2,500 cr/мес; overage $5/100cr | Произвольный SQL + community-запросы |
| **The Graph** | Subgraphs + Token API | GraphQL/REST; key/JWT | **Офиц. ×2** + community | 100k/мес free → **$2/100k** | Кастомные индексированные схемы, прозрачная цена |
| **Bitquery** | Indexed + realtime DEX streaming | GraphQL/WS; key/OAuth | **Офиц.** `mcp.bitquery.io` | Free 1,000 pts (eval); Commercial — sales | Realtime DEX-трейды/OHLCV, mempool |
| **Nansen** | Smart-money intel / entity labels | REST; `apikey` | **Офиц.** `mcp.nansen.ai/ra/mcp` (**24 tools**) | Free $0 eval; **Pro $49/мес год / $69 мес** | **Лучший** smart-money + проприетарные метки = alpha |
| **Surf (AskSurf)** | Агрегатор + analyst-LLM | REST+SQL; Bearer | **Офиц.** `@surf-ai/surf-mcp` (ранний) | 30 free/день без ключа; PAYG. ⚠️ **цены публичны:** Pro $49, Max $100–$1,000 | Один ключ на CEX+DEX+SQL+соц+prediction-markets |
| **Glassnode** | Macro on-chain (SOPR/MVRV/NUPL) | REST; `X-Api-Key` | **Офиц.** `mcp.glassnode.com` beta | Advanced $49 = урезанный API Light; реальный = Professional | Сигналы вершин/днищ цикла |
| **Covalent / GoldRush** | Unified multi-chain raw+DeFi | REST+WS; Bearer/x402 | ⚠️ **Офиц., но ARCHIVED 2026-02-24** | Trial 25k cr/14дн; Vibe $10; Pro $250 | Архив genesis→now, 100+ сетей вкл. Solana/BTC |
| **Moralis** | Unified Web3 Data (EVM+Solana) | REST; `X-API-Key` | **Офиц.** `@moralisweb3/api-mcp-server` | Free 40k CU/день; Starter $49; Pro $199 | DeFi/price/NFT/PnL. ⚠️ Cortex retired 2026-06-04 |
| **Arkham** | De-anonymization / attribution | REST+WS; apply | **community only** | Не публично | Деанонимизация в named entities, трейс фондов |
| **Allium** | Enterprise data warehouse | REST+SQL; key/x402 | **Офиц.** `mcp.allium.so` | Enterprise (~$5K+/мес) | Decoded-таблицы в ваш Snowflake/BigQuery |
| **Dune Sim** | Realtime EVM/SVM wallet/tx | REST; `X-Sim-Api-Key` | нет | ⚠️ **REFUTED: SUNSET 1 авг 2026, регистрации закрыты** | ❌ Не строить → Allium/Alchemy/Zerion |
| **DeFiLlama** | DeFi-агрегаты (TVL, yields, fees) | REST; free/Pro | community | Free public; Pro **$300/мес**. ⚠️ дашборд $49 ≠ API | Free TVL/yield/stablecoin/fees |

**Тиринг:** (a) Premium intel — Nansen, Arkham · (b) Query/warehouse — Dune, The Graph, Allium · (c) Raw multi-chain — Covalent/GoldRush, Moralis, Bitquery (Sim — избегать) · (d) Free DeFi/market — CoinGecko, DexScreener, GeckoTerminal, DeFiLlama · (e) Analyst-LLM — Surf, Glassnode.

---

## 3. Open-source ландшафт

**Ключевой факт: turnkey «ончейн-аналитик-агент» в опенсорсе отсутствует.** Берём по слоям:

**MCP-серверы данных (adopt):** `coingecko/coingecko-typescript` (офиц., Apache-2.0) · `mcpdotdirect/evm-mcp-server` (~377★, MIT, 60+ сетей) · `helius-labs/core-ai` (офиц. Solana, MIT) · `coinpaprika/dexpaprika-mcp` (офиц., keyless) · `kukapay/kukapay-mcp-servers` (~70 узких крипто-MCP — **steal-pattern**, вычерпывать поштучно).

**Agent / execution:** `coinbase/agentkit` (1.3k★, Apache-2.0) — **adopt** для действий · `goat-sdk/goat` (1.0k★, MIT, 200+ tools) — execution · `hummingbot/hummingbot` (19k★) + `hummingbot/mcp` (офиц.) — **adopt** как execution-движок по NL · `nautechsystems/nautilus_trader` (24k★, LGPL) — backtest→live · `elizaOS/eliza` (18.7k★) — **reference-only** (v2 вынес крипто-плагины из ядра).

**Паттерны для signal-движка (⚠️ часто без лицензии):** `DracoR22/handi-cat_wallet-tracker` (205★) — лучший swap-decode (Raydium/Jupiter/Pump.fun) · `AccursedGalaxy/Insider-Monitor` (Go) — RPC wallet-delta → алерты.

**Списки:** `badkk/awesome-crypto-mcp-servers`, `royyannick/awesome-blockchain-mcps`.

> Полная таблица из 71 репозитория — в `research-digest.md` (§3) и `raw/oss-repos.json`.

---

## 4. Целевая архитектура движка (отдельный проект)

```
                         ┌─────────────────────────────────────────┐
   Агент / Claude Code ──▶│   onchain-intel MCP server (свой)        │  ← единый NL/tool-интерфейс
                         │   tools: get_wallet, smart_money_flows,   │
                         │          new_pairs, token_risk, watch...  │
                         └───────────────┬─────────────────────────┘
                                         │
              ┌──────────────────────────┼───────────────────────────────┐
              ▼                          ▼                                ▼
   ┌───────────────────┐   ┌──────────────────────────┐    ┌──────────────────────┐
   │ Signal/Alert engine│   │ Normalization layer       │    │ Cache + Credit-budget │
   │ (правила,watchlist,│   │ (1 внутр. схема:          │    │ (TTL по provider/args,│
   │  scheduler, алерты) │   │  token/wallet/flow/OHLCV) │    │  лимит кредитов/день) │
   └───────────────────┘   └─────────────┬─────────────┘    └──────────────────────┘
                                          │ Provider Adapters (pluggable)
        ┌──────────┬──────────┬───────────┼───────────┬──────────┬──────────┐
        ▼          ▼          ▼            ▼           ▼          ▼          ▼
     Nansen   Dune(Query)  CoinGecko  DexScreener  Bitquery  DeFiLlama   Glassnode ...
```

**8 инсайтов архитектуры (из верифицированного исследования):**
1. **Нормализация обязательна** — у всех разный auth (`apikey`/`X-Dune-API-Key`/`NANSEN-API-KEY`/Bearer/JWT/x402) и форма (REST/GraphQL/SQL/WS). Один внутренний словарь → провайдеры взаимозаменяемы (критично из-за смерти Sim и churn у GoldRush/Moralis).
2. **MCP-first для чтения, SDK-first для действий.** Дата-слой почти весь MCP-ready; execution держит ключи/подписывает tx → за explicit approval gate.
3. **Free-vs-paid слоями.** Дефолт — free keyless (CoinGecko MCP, DexScreener, GeckoTerminal, DeFiLlama, The Graph 100k/мес); платные кредиты (Nansen $49, Bitquery, Glassnode) — только на cache-miss/высокоценные запросы.
4. **Кеш + бюджет кредитов не опциональны.** Премиум жжёт быстро (Nansen Agent Expert 750cr/вызов). Кеш по `(provider, endpoint, args, TTL)` + трекинг `credits_used` с потолком.
5. **Signal-движок строите вы**, но паттерны готовы (handi-cat, Insider-Monitor, узкие MCP из kukapay).
6. **Smart-money/labels — moat и он проприетарный.** Nansen/Arkham не воспроизвести дёшево → платный премиум-сигнал.
7. **Realtime vs аналитика — жёсткий раздел.** Стриминг (Bitquery, DexScreener) для new-pair/mempool; SQL/warehouse (Dune, Glassnode, DeFiLlama) для backtest/режимов.
8. **Execution решён OSS** — Hummingbot+MCP / NautilusTrader / Freqtrade. Кормить готовый сигналами, не строить.

---

## 5. Верхнеуровневый план работ

**Фаза 0 — Discovery & каркас (≈1 нед).** ADR «движок-проект + скилл», выбор стека (рекомендую **TS**: офиц. MCP SDK + CoinGecko/AgentKit на TS), скелет MCP-сервера, секрет-менеджмент (`.env`, 0600). _Артефакты: `ARCHITECTURE.md`, провайдер-матрица как config._

**Фаза 1 — MVP read-слой, только free (≈1–2 нед).** Адаптеры: CoinGecko + DexScreener + DeFiLlama + Dune (free 2,500cr). Нормализация (token/wallet/OHLCV), кеш+TTL. MCP-tools: `get_token`, `get_wallet_balances`, `new_pairs`, `protocol_tvl`. _Выход: агент отвечает на ончейн-вопросы без платных ключей._

**Фаза 2 — Alpha-слой, платный (≈1–2 нед).** Nansen Pro ($49) — smart-money flows + метки; опц. Bitquery streaming; **credit-budget guard**. MCP-tools: `smart_money_flows`, `entity_label`, `token_risk`. _Выход: видим, «куда идут умные деньги»._

**Фаза 3 — Signal/Alert-движок (≈2 нед).** Watchlists, правила (накопление smart-money, скачок ликвидности, режим SOPR/MVRV), планировщик, нотификации (Telegram). swap-decode из handi-cat, wallet-delta из Insider-Monitor как паттерны. _Выход: проактивные алерты._

**Фаза 4 — Скилл(ы) в Universal-skills (≈1 нед).** Через `skill-creator`: `onchain-analytics` (SKILL.md + playbooks + тонкий клиент к MCP), evals, плагин в `marketplace.json`. Раскол на `data-access`/`signals` — если контент перерос. _Выход: агент-агностичный фронт к движку._

**Фаза 5 (опц.) — Execution (≈2 нед).** Hummingbot + `hummingbot/mcp` за explicit-approval gate (paper по умолчанию). _Выход: сигнал → (одобрение) → сделка._

**Сквозное:** на каждой границе фаз — `code-reviewer` + `security-auditor` (ключи, SSRF, approval-gate для write-tools).

---

## 6. Риски и подводные камни (из верификации)

- ❌ **Dune Sim умирает 1 авг 2026, регистрации закрыты** — не строить, мигрировать на Allium/Alchemy/Zerion.
- ⚠️ **Архивные/мёртвые MCP:** Covalent/GoldRush MCP (archived 2026-02-24), `bankless/onchain-mcp` (no longer maintained), `chainstacklabs/rpc-nodes-mcp` (archived 2026-04-09).
- ⚠️ **Лицензионные ловушки:** Heurist framework — **BSL 1.1** (не OSI); Freqtrade/OctoBot — **GPL-3.0** (copyleft); handi-cat / Insider-Monitor / whale-mirror — **без лицензии** → только как паттерны.
- ⚠️ **Скрейперы под видом API** на Apify («Arkham API», «DexScreener API») — ToS-риск, только first-party.
- ⚠️ **Marketing-числа врут** — верификация поправила Dune (26 ≠ 29), счётчики Surf/Allium/Bitquery противоречивы → пробовать live tool-list, не хардкодить.
- 💰 **Платные ключи для серьёзной сборки:** Nansen, Bitquery Commercial, Glassnode Professional, Allium (~$5K+/мес). Free-tier-ы — eval-only.

> Полные формулировки всех 5 правок с источниками — в `verification-corrections.md`.
