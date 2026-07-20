# ADR-001 — Технологический стек системы ончейн-аналитики

- **Статус:** Accepted (sign-off 2026-07-20; см. §Open questions)
- **Дата:** 2026-06-30 (проект стека) · **Accepted:** 2026-07-20 (Sergey)
- **Контекст-документы:** [REPORT.md](REPORT.md), [research-digest.md](research-digest.md), [verification-corrections.md](verification-corrections.md)
- **Решает:** какой язык/рантайм, фреймворк MCP, хранилище/кеш, планировщик, нотификации, секреты, тесты, деплой и раскладку репозитория использовать для проекта-движка `onchain-intel` и сопутствующего скилла.

> ADR фиксирует **набор связанных решений (D1…D12)** одного стека. Каждое — с драйверами, вариантами и последствиями. Статусы решений независимо ревизуются по триггерам в §«Revisit when».

---

## Контекст

Из [REPORT.md](REPORT.md): строим **гибрид** — отдельный проект-движок (`onchain-intel`) + тонкий скилл (`onchain-analytics`) в Universal-skills. Движок — это:

1. **Read-слой** (основной объём работы): провайдер-адаптеры (Nansen/Dune/CoinGecko/DexScreener/Bitquery/…), слой нормализации в единую внутреннюю схему, кеш + бюджет кредитов, собственный **агрегирующий MCP-сервер**.
2. **Signal-слой**: watchlists, правила, планировщик опроса, алерты.
3. **Execution-слой (опц., Фаза 5)**: подача сигналов в готовые движки исполнения.

**Ключевые факты из исследования, влияющие на стек:**

- Дата-слой почти весь **MCP-ready**, и эталонные реализации — TypeScript: официальный `@modelcontextprotocol/sdk`, CoinGecko MCP (TS, Apache-2.0), action-слой `coinbase/agentkit` (TS), `goat-sdk/goat` (TS, 200+ tools).
- **Execution и quant/backtest — это Python/Rust-мир:** Hummingbot (Python, +офиц. MCP), NautilusTrader (Rust+Python), Freqtrade (Python, GPL-3.0). Их **не переписываем** — вызываем как внешние сервисы.
- **Лицензии:** Freqtrade/OctoBot — **GPL-3.0** (copyleft) → допустимо только как **отдельный процесс** (вызов по MCP/REST), без линковки/вендоринга. handi-cat / Insider-Monitor / whale-mirror — **без лицензии** → только как читаемые паттерны, не копировать код.
- **Хрупкость провайдеров:** Dune Sim умирает 01.08.2026; GoldRush/Moralis MCP в churn → адаптеры обязаны быть **горячо заменяемыми** за стабильным внутренним интерфейсом.

**Декомпозиция нагрузки:** ~80% работы MVP — это HTTP/GraphQL/SQL-интеграции, нормализация и MCP-обвязка (сильная сторона TS). Тяжёлый quant (pandas/ta-lib/бэктест) нужен только на Фазе 5+ и **делегируется** внешним Python-движкам.

---

## D1 — Язык и рантайм ядра: **TypeScript на Node.js 22 LTS** ✅

**Драйверы:** где живёт MCP/web3/agent-тулинг; единственность языка in-house; скорость интеграций; типобезопасность схем нормализации.

**Варианты:**

| Вариант | За | Против | Вердикт |
|---|---|---|---|
| **A. TypeScript (Node 22)** | Эталонный MCP SDK; офиц. CoinGecko MCP, AgentKit, GOAT на TS; viem/ethers, zod; один язык на ядро+скилл; отличный async-IO | Слабее quant-экосистема (нет pandas/ta-lib уровня) | **Выбран** |
| B. Python 3.12 | Нативные quant/backtest (pandas, ta-lib, web3.py); execution-движки тоже Python | Офиц. data-MCP и agent-kit'ы — TS-first; FastMCP моложе референса; пришлось бы тащить TS-зависимости отдельно | Запасной (если quant — ядро с дня 1) |
| C. Полиглот сразу (TS core + Python quant) | Лучшее из двух миров | Двойной ops/CI/деплой на MVP — преждевременная сложность (нарушает YAGNI) | Отложен до триггера |

**Решение:** **TypeScript / Node 22 LTS**. Тяжёлый quant и исполнение **не пишем сами** — переиспользуем внешние Python/Rust-движки (Hummingbot+MCP, NautilusTrader, Freqtrade) как чёрные ящики. Это держит in-house кодовую базу **одноязычной** на этапах 0–4.

**Последствия:** (+) максимальная скорость по основному, MCP-героическому объёму; (+) общий тип-слой с zod-схемами MCP-tools; (−) когда понадобится in-house бэктест/тяж. индикаторы — вводим отдельный Python-сервис (см. §Revisit, реверсивно).

---

## D2 — Менеджер пакетов и сборка: **pnpm + tsup (esbuild) + tsx** ✅

- **pnpm** (workspaces для монорепо), строгий `node-linker`, экономия диска.
- **tsup** для бандла MCP-сервера/CLI; **tsx** для dev-запуска; **TypeScript strict** (`"strict": true`, `noUncheckedIndexedAccess`).
- **Альтернативы:** Bun (быстрее, но экосистема MCP/инструментов гарантированно совместима с Node — Bun = доп. риск на проде; можно как dev-ускоритель позже).

---

## D3 — MCP-фреймворк и транспорты: **официальный `@modelcontextprotocol/sdk` (TS)** ✅

- Транспорты: **stdio** (локальная разработка + использование из Claude Code) **+ Streamable HTTP** (хостинг, как у Dune `api.dune.com/mcp/v1`).
- Tool-input-схемы генерируем из **zod** (один источник правды: валидация ↔ схема MCP).
- Дизайн tools по `mcp-builder`: **workflow-ориентированные**, специфичные имена (`onchain_smart_money_flows`, не `get_data`), не «1 эндпоинт = 1 tool».
- Стартовый набор tools: `onchain_get_token`, `onchain_wallet_balances`, `onchain_new_pairs`, `onchain_protocol_tvl`, `onchain_smart_money_flows`, `onchain_entity_label`, `onchain_token_risk`, `onchain_watch_add/list/remove`.

---

## D4 — Слой провайдер-адаптеров: **Adapter + Capability Registry** ✅

- Каждый провайдер реализует общий интерфейс: `capabilities()`, `auth`, `fetch()`, `normalize()`, `cost()`.
- **Capability-routing:** запрос идёт по способности (`token.price`, `wallet.balances`, `smartmoney.flows`), реестр выбирает провайдера по приоритету free→paid и доступности ключа.
- Конфиг маршрутизации — декларативный (`providers.config.ts`), чтобы менять приоритеты без кода (критично из-за смерти Sim / churn MCP).
- **Anti-corruption layer:** провайдерные DTO → внутренние канонические типы; наружу провайдерные поля не протекают.
- *(Дополнение 2026-07-20)* Новая capability **`privacy.shielded_pool`** (баланс shielded-пула, shield/unshield-потоки, notes count). Ни один провайдер основной матрицы её не отдаёт; первые адаптеры: `dash-platform` (DAPI — primary; shielded-эндпоинты пока «not yet available on public nodes») и `platform-explorer` (community REST, работает уже сейчас, есть history). См. [raw/providers-addendum-2026-07-20.json](raw/providers-addendum-2026-07-20.json).
- *(Дополнение 2026-07-20)* **Режим snapshotter** для state-only способностей: если провайдер отдаёт только текущее состояние без истории (подтверждено для DAPI `getShieldedPoolState` — нет height-параметра, нет history-эндпоинтов; [верификация #5](../../reference/coin-analytics-dialog-verification.md)), адаптер объявляет `historyAvailable: false`, и планировщик периодически пишет текущее значение в таблицу `snapshots` (схема: [DB-SCHEMA-CONCEPT.md](DB-SCHEMA-CONCEPT.md)). Это дополнение к архитектуре API-consumer, не её пересмотр: свой полный чейн-индексер по-прежнему НЕ строим.

```ts
interface ProviderAdapter {
  id: string;
  capabilities(): Capability[];          // ['token.price','wallet.balances',...]
  costOf(cap: Capability, args: object): CreditCost;
  fetch(cap: Capability, args: object): Promise<RawResult>;
  normalize(cap: Capability, raw: RawResult): CanonicalResult; // → Token|Wallet|Flow|OHLCV|Pool
}
```

---

## D5 — Внутренняя каноническая схема: **zod-типы (Token / Wallet / Balance / Transfer/Flow / OHLCV / Pool / Signal)** ✅

- Один словарь домена, версионируемый. Всё, что отдают tools и хранит кеш, — в этих типах.
- Адреса нормализуются (checksum EVM / base58 Solana), сети — единый enum `chain`.
- *(Дополнение 2026-07-20)* + тип **`Snapshot`** (точка временного ряда state-only метрики: `metric`, `asset`, `ts`, `value_raw` — точное значение **строкой** (credits-величины превышают безопасные 2^53 для JS-number), `value_num?` — lossy-проекция для сравнений, `source`, `height?`) — канонический выход snapshotter-режима из D4; персистентная форма — в [DB-SCHEMA-CONCEPT.md](DB-SCHEMA-CONCEPT.md).

---

## D6 — Кеш + бюджет кредитов: **SQLite (`better-sqlite3`) + in-memory LRU** ✅ (Redis — на масштабе)

**Драйверы:** почти все платные провайдеры credit/CU-метрированы и жгут быстро (Nansen Agent Expert 750cr/вызов) → кеш и бюджет **не опциональны**.

- **Двухуровневый кеш:** `lru-cache` (горячий) → **SQLite** (персистентный). Ключ = `(provider, capability, normalizedArgs)`; TTL по типу данных (цена 15–60с, балансы 1–5мин, TVL 5–30мин, метки 24ч).
- **Credit-budget guard:** таблица `usage(provider, day, credits_used)`; перед платным вызовом — проверка дневного потолка; ответы парсятся на фактический `credits_used` где провайдер его отдаёт.
- **Почему SQLite, не Redis на старте:** zero-ops, embedded, переживает рестарт, идеально для single-instance инди-сборки. Интерфейс `CacheStore`/`BudgetStore` абстрактный → **Redis/Postgres подменяются на масштабе** без переписывания логики.
- *(Дополнение 2026-07-20 — профиль деплоя «выделенный сервер»)* В этом профиле персистентный слой — **Postgres с первого дня** (не SQLite): кеш/`usage`-таблицы живут в той же БД `onchain_intel`, схема `onchain`. Абстракции `CacheStore`/`BudgetStore` не меняются; SQLite-ветка остаётся в [DB-SCHEMA-CONCEPT](DB-SCHEMA-CONCEPT.md) как reference для embedded/локального профиля. Решение продиктовано операционным ограничением (always-on планировщик, см. D8-дополнение), а не объёмом данных.

---

## D7 — Состояние (watchlists, история алертов, job-log): **SQLite → Postgres на масштабе** ✅

- Те же `better-sqlite3` + миграции (`drizzle-orm` или сырой SQL + `node-pg-migrate`-аналог). Drizzle даёт типобезопасность и лёгкий переход на Postgres.
- *(Дополнение 2026-07-20)* Концепт-схема данных (snapshots / assets / metrics registry / events / aggregates) и пошаговый план миграции SQLite → Postgres вынесены в **[DB-SCHEMA-CONCEPT.md](DB-SCHEMA-CONCEPT.md)** — включая portable-конвенции (типы, epoch-ms UTC, TEXT-JSON, app-generated id), которые делают миграцию механической. Подтверждённые объёмы первой цели (Dash Platform: 17 537 documents, 3 038 identities, 133 shielded-tx за всё время, as-of 2026-07-19 — [верификация #4](../../reference/coin-analytics-dialog-verification.md)) — килобайты в день: SQLite-first остаётся верным по объёму.
- *(Дополнение 2026-07-20 — профиль деплоя «выделенный сервер»)* Для деплоя на выделенном сервере — **Postgres-first с первого дня** (n8n-снапшоттер пишет прямо в Postgres; см. D8-дополнение и [DB-SCHEMA-CONCEPT §8](DB-SCHEMA-CONCEPT.md)). Ветка «SQLite → Postgres на масштабе» остаётся валидной для embedded/локального профиля и как reference-план миграции ([DB-SCHEMA-CONCEPT §5](DB-SCHEMA-CONCEPT.md)). Аргумент «объёмы килобайты/день → SQLite-first» по данным **не отменён** — Postgres-first здесь выбран из-за операционного ограничения (надёжный always-on планировщик), не из-за объёма.

---

## D8 — Планировщик и очередь: **`croner` + durable job-log (SQLite)** → **BullMQ (Redis)** на масштабе ✅

- MVP-опрос сигналов: `croner` (cron-выражения в процессе) + журнал запусков/ретраев в SQLite.
- Когда понадобятся durable-ретраи, конкурентность и горизонтальное масштабирование — **BullMQ** поверх Redis. Интерфейс `JobScheduler` абстрактный.
- Realtime (Bitquery WS, мониторинг новых пар): клиент `ws`; на MVP — поллинг, стриминг — позже.
- *(Дополнение 2026-07-20 — deploy-profile revisit; пересматривает отказ от n8n в §Revisit)* Для **профиля деплоя «выделенный сервер»** планировщик/оркестратор — **n8n** (self-hosted), не in-process `croner`. **Драйвер:** cron-скрипт на ноутбуке нежизнеспособен (машина спит/выключена → пропуски часовых замеров, а истории в DAPI нет — дыру не восстановить); n8n уже эксплуатируется на выделенном сервере, есть экспертные скиллы (`n8n-skills`) + `n8n-mcp`. Прежние условия возврата (durable-ретраи, визуальный аудит потоков) закрываются самим n8n. `croner` остаётся референсом для одно-бинарного/embedded-профиля (локальный запуск без сервера). Профиль БД и dev→prod — [DB-SCHEMA-CONCEPT §8](DB-SCHEMA-CONCEPT.md).

---

## D9 — Нотификации: **Telegram (`grammY`) + generic webhook** ✅

- `grammY` (современный TS-фреймворк ботов). Абстракция `Notifier` → легко добавить Discord/Slack/email.

---

## D10 — Секреты и конфиг: **skill/проект-local `.env` (0600) + zod-валидация env** ✅

- Паттерн как у `transcript-fetcher`: skill-local `.env`, права `0600`, **секреты никогда не логируются и не попадают в кеш-ключи**.
- Валидация окружения через zod при старте (fail-fast, если ключ нужного провайдера отсутствует, но способность включена).
- Эскалация: SOPS/`.env.vault` или менеджер секретов — на проде/командной работе (отдельный future-ADR).

---

## D11 — Тесты и качество: **vitest + записанные HTTP-фикстуры (Polly.js / msw) + golden-нормализация** ✅

- **Не бить по живым платным API в CI:** записанные ответы (Polly.js record-replay) → детерминизм, ноль трат.
- Контрактные тесты адаптеров: «сырой ответ → канонический объект» (golden-файлы).
- E2E на MCP-tools (stdio): прогон tool-вызовов против фикстур.
- Линт/формат: ESLint + Prettier; CI-гейты (как требует `SKILL_EXECUTION_POLICY` для script-backed артефактов).

---

## D12 — Деплой, раскладка репо, лицензия ✅

- **Раскладка (pnpm monorepo):**
  ```
  onchain-intel/
  ├─ packages/
  │  ├─ core/         # канонические типы, кеш, budget, registry
  │  ├─ adapters/     # по адаптеру на провайдера
  │  ├─ mcp-server/   # @modelcontextprotocol/sdk, stdio + HTTP
  │  ├─ signals/      # правила, watchlists, scheduler, notifier
  │  └─ cli/          # локальные команды/отладка
  ├─ providers.config.ts
  └─ docker/
  ```
  Старт минимальный (можно начать одним пакетом и резать по швам по мере роста).
- **Деплой:** один Docker-образ. Локально — stdio для Claude Code. Хостинг (планировщик + Streamable HTTP) — Fly.io / Railway / небольшой VPS за reverse-proxy. SSRF-гейт на любой исходящий fetch (как в `html`-скилле).
- **Лицензия нашего кода:** **Apache-2.0** (патентный грант; совместима с большинством зависимостей). **GPL-движки (Freqtrade/OctoBot) — только как внешний процесс** (вызов по MCP/REST), без вендоринга/линковки; no-license репо — не копировать.
- **Скилл-слой:** `onchain-analytics` в Universal-skills — тонкий клиент к MCP-серверу + playbooks; следует Skill-anatomy (`SKILL.md` + `scripts/` + `references/`), оформляется через `skill-creator`, регистрируется в `marketplace.json`.

---

## Итоговая карта стека

| Слой | Выбор | Замена на масштабе |
|---|---|---|
| Язык/рантайм | TypeScript / Node 22 LTS | (+ Python quant-сервис по триггеру) |
| Пакеты/сборка | pnpm + tsup + tsx | — |
| MCP | `@modelcontextprotocol/sdk` (stdio + Streamable HTTP) | — |
| HTTP/устойчивость | fetch/undici + p-retry + bottleneck | — |
| Валидация/схемы | zod | — |
| Кеш | lru-cache + SQLite | Redis |
| Состояние/БД | SQLite + drizzle-orm | Postgres |
| Планировщик | croner + SQLite job-log | BullMQ + Redis |
| Realtime | ws (поллинг на MVP) | стриминг-консьюмеры |
| Нотификации | grammY (Telegram) | Discord/Slack/email |
| Секреты | `.env` 0600 + zod env | SOPS/secret-manager |
| Тесты | vitest + Polly.js | — |
| Деплой | Docker → Fly.io/Railway/VPS | k8s при нужде |
| Лицензия | Apache-2.0; GPL только как внешний процесс | — |
| Execution | внешние Hummingbot+MCP / NautilusTrader | — |

---

## Open questions (нужен ваш sign-off)

> **✅ Sign-off получен 2026-07-20 (Sergey) — ADR переведён в Accepted:**
> 1. **TS-core — ПОДТВЕРЖДЁН.** In-house ядро одноязычное (TypeScript / Node 22 LTS) на
>    этапах 0–4; тяжёлый quant/execution — только внешними Python/Rust-движками по MCP/REST.
>    (Совпадает со входом 2026-07-20: первые задачи — snapshotter + правила-пороги.)
> 2. **Язык команды — TypeScript / JS** → усиливает D1; вариант B (Python-core) не активируется.
> 3. **Хостинг — локальный stdio под Claude Code на старте.** Публичный Streamable-HTTP MCP
>    (мультиклиент) — позже, за абстракцией транспорта D3; конкретный хостинг-провайдер
>    (Fly.io/Railway/VPS) не выбран — на MVP не нужен. Триггеры HTTP/хостинга — §Revisit (D3/D12).
>
> Решения D1–D12 не пересматривались; ниже — исходные формулировки вопросов.

1. **TS-core подтверждаем?** Решение D1 предполагает, что in-house тяжёлый бэктест/quant **не нужен с дня 1** (делегируем Python-движкам). Если ваш кейс — quant/бэктест-центричный с первого релиза, склоняемся к **Python-core (вариант B)**. → нужен ваш ответ про роль quant.
   *(Вход 2026-07-20, не sign-off):* анализ coin-analytics-диалога подтверждает, что первые задачи — HTTP-поллинг (snapshotter) + правила-пороги, т.е. quant с дня 1 не нужен → аргумент за TS-core. Композитные скоры/предикция отклонены до накопления ≥90 дней снапшотов (см. [reference/coin-insights-build-plan.md](../../reference/coin-insights-build-plan.md) §4).
2. **Ваша языковая беглость / команды** — если основная экспертиза в Python, это перевешивает в сторону B даже при TS-сильном MCP-тулинге.
3. **Где хостить** и нужен ли публичный Streamable-HTTP MCP (мультиклиент) или достаточно локального stdio под Claude Code на старте.

---

## Revisit when (триггеры пересмотра)

- **D1 → ввести Python quant-сервис**, когда нужны: бэктест портфельных стратегий, ta-lib-уровень индикаторов, или ML-сигналы (то, что в TS делается с трудом). Реверсивно: добавляется новый пакет/сервис за тем же внутренним API.
- **D6/D7/D8 → Redis/Postgres/BullMQ**, когда: >1 инстанса, нужны durable-ретраи, или SQLite-конкуренция становится узким местом. *(Дополнение 2026-07-20:)* пошаговый план перехода SQLite→Postgres и портируемые конвенции схемы — [DB-SCHEMA-CONCEPT.md](DB-SCHEMA-CONCEPT.md).
- **D8 → n8n** *(рассмотрен и отклонён 2026-07-20)*: n8n как ETL-оркестрация предлагался в coin-analytics-диалоге; для single-instance снапшоттера с 3–5 эндпоинтами это лишний движущийся компонент (свой процесс, своя БД, свой UI) против zero-ops `croner`. Вернуться к вопросу вместе с BullMQ-триггером (нужны durable-ретраи / много разнородных пайплайнов / визуальный аудит потоков).
  **Апдейт 2026-07-20 (deploy-profile):** для профиля «выделенный сервер» n8n **принят** (D8-дополнение) — триггером стал не объём/разнородность, а невозможность always-on `croner` на ноутбуке (пропуски часовых замеров невосстановимы: истории в DAPI нет) + n8n уже развёрнут и есть скиллы/`n8n-mcp`. Zero-ops-аргумент `croner` сохраняется для локального/embedded-профиля.
- **D3 → пересмотреть набор/число tools**, при интеграции каждого провайдера — **пробовать live tool-list** (верификация уже поймала Dune 26≠29). Не хардкодить счётчики.
- **D12 → отдельный ADR по секретам**, при переходе к командной работе/проду.

---

## Changelog

- **2026-06-30** — первая версия (D1–D12), статус Proposed.
- **2026-07-20** — датированные дополнения по итогам верификации coin-analytics-диалога (run `wf_f294ed8b-f82`, [вердикты](../../reference/coin-analytics-dialog-verification.md)): D4 + capability `privacy.shielded_pool` и режим snapshotter; D5 + тип `Snapshot`; D7 → ссылка на [DB-SCHEMA-CONCEPT.md](DB-SCHEMA-CONCEPT.md); §Open questions Q1 — вход в пользу TS-core; §Revisit — n8n рассмотрен и отклонён + ссылка на DB-SCHEMA-CONCEPT.md в триггере D6/D7/D8. Решения D1–D12 не пересматривались.
- **2026-07-20 (sign-off)** — статус **Proposed → Accepted**: закрыты §Open questions — Q1 TS-core подтверждён, Q2 язык команды TS/JS, Q3 хостинг stdio-first (публичный HTTP — позже, §Revisit D3/D12). Решения D1–D12 не менялись.
- **2026-07-20 (deploy-profile)** — принят профиль деплоя **«выделенный сервер»**: **D8** — n8n **принят** как планировщик/оркестратор (пересмотр отказа того же дня: `croner` на ноутбуке always-on невозможен, n8n уже эксплуатируется, есть скиллы + `n8n-mcp`); **D6/D7** — **Postgres-first с первого дня** для этого профиля (SQLite-ветка — reference для embedded). Новая секция [DB-SCHEMA-CONCEPT §8](DB-SCHEMA-CONCEPT.md). Решения D1–D5, D9–D12 не менялись; D6/D7/D8 — профиль-специфичные дополнения, ядро-абстракции (`CacheStore`/`BudgetStore`/`JobScheduler`) сохранены.
