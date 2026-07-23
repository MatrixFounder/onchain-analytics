# ARCHITECTURE — `onchain-intel`

| Поле                 | Значение                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Статус документа** | Living document — обновляется **на месте**, никогда не архивируется по задачам                                                                                                                      |
| **Текущая задача**   | M1 ([TASK-003 `m1-read-layer`](TASK.md)) — предыдущая M0 ✅ ([task-001](tasks/task-001-m0-discovery-skeleton.md))                                                                                   |
| **ADR**              | [ADR-001-tech-stack.md](onchain-analytics/ADR-001-tech-stack.md) — **Accepted**, sign-off 2026-07-20 (Sergey), решения D1–D12                                                                       |
| **Схема данных**     | [DB-SCHEMA-CONCEPT.md](onchain-analytics/DB-SCHEMA-CONCEPT.md) §1 — portable-конвенции, применены здесь к кеш-БД (M1)                                                                               |
| **Roadmap**          | [ROADMAP.md](onchain-analytics/ROADMAP.md) — фазы M0–M6                                                                                                                                             |
| **Обновлено**        | 2026-07-23, **v2.2.1** (CoinGecko Pro-контур: `COINGECKO_PRO_API_KEY`) — тест-сьют **287**; полный чейнджлог версий: [architectures/version-history.md](architectures/version-history.md)           |
| **Формат**           | **Index-Mode** (skill `architecture-format-core`, 2026-07-23): тела разделов 2–7 и 10–11 — в [docs/architectures/](architectures/); здесь — оглавление, однострочные резюме и малые разделы целиком |

---

> This is a living INDEX. Section bodies live in `docs/architectures/`. Правки вносятся в
> файл соответствующего раздела; однострочное резюме здесь поддерживается в синхроне
> (architecture-format-core §After the Split). Нумерация разделов сохранена — текстовые
> ссылки вида «§3.2» по-прежнему указывают на раздел 3 (system-architecture.md).

## Содержание

| §   | Раздел                                                                            | Где            |
| --- | --------------------------------------------------------------------------------- | -------------- |
| 1   | [Задача (Task Description)](#1-задача-task-description)                           | ниже, целиком  |
| 2   | [Функциональная архитектура](architectures/functional-architecture.md)            | отдельный файл |
| 3   | [Системная архитектура](architectures/system-architecture.md)                     | отдельный файл |
| 4   | [Data Model (Conceptual)](architectures/data-model.md)                            | отдельный файл |
| 5   | [Интерфейсы](architectures/interfaces.md)                                         | отдельный файл |
| 6   | [Технологический стек](architectures/technology-stack.md)                         | отдельный файл |
| 7   | [Безопасность](architectures/security.md)                                         | отдельный файл |
| 8   | [Масштабируемость и производительность](#8-масштабируемость-и-производительность) | ниже, целиком  |
| 9   | [Надёжность и отказоустойчивость](#9-надёжность-и-отказоустойчивость)             | ниже, целиком  |
| 10  | [Деплой](architectures/deployment.md)                                             | отдельный файл |
| 11  | [Открытые вопросы](architectures/open-questions.md)                               | отдельный файл |
| —   | [Приложение: M0-детали](#приложение-m0-детали-сохранённые-без-пересмотра)         | ниже, целиком  |
| —   | [История версий (changelog)](architectures/version-history.md)                    | отдельный файл |

## 1. Задача (Task Description)

`onchain-intel` — движок ончейн-аналитики: провайдер-адаптеры (Nansen/Dune/CoinGecko/DexScreener/
Bitquery/DAPI/…) → нормализация в канонический zod-типаж → кеш + credit-budget → snapshotter/
signals → собственный агрегирующий MCP-сервер. Стек и 12 решений (D1–D12) зафиксированы и
**Accepted** в ADR-001 — эта архитектура их не пересматривает, а конкретизирует **M1**
([TASK-003](TASK.md), R-1…R-28): канонические zod-типы, Adapter + Capability Registry, девять
адаптеров (CoinGecko/DexScreener/DeFiLlama/RPC-EVM/RPC-Solana — live; `dash-platform` — interface

- fixture-контракт, живой gRPC-транспорт отложен в backlog; `platform-explorer` — единственный
  live Dash-источник M1; `dune` — interface/config-stub, живой запрос отложен на M2; `pg-history` —
  опциональный read-only PG-адаптер истории), двухуровневый кеш (D6), четыре MCP-tools
  (`onchain_get_token`, `onchain_wallet_balances`, `onchain_new_pairs`, `onchain_protocol_tvl`),
  SSRF-гейт, per-provider rate-limit.

M0 (предыдущий срез — pnpm-монорепо, TS strict, `onchain_ping` на stdio, CI-гейт) **не
пересматривается**; §3.2/§6.4/§10.2 этого документа сохраняют M0-детали там, где они остаются
верны, и расширяют их под M1. Полная RTM M1 — в [TASK.md](TASK.md) §5 (R-1…R-28); трассировка
exit-критериев ROADMAP §M1 — TASK.md §6.

**Что уже существует и не является предметом этой архитектуры:** снапшоттер Dash Platform/ZEC —
**n8n workflows + Supabase Postgres** в dev VM (`onchain-snapshotter`, `onchain-verify`,
`onchain-error-alert`; см. `CLAUDE.n8n.md`). Он продолжает писать снапшоты **независимо** от
движка до M3 (кикофф-решение пользователя, TASK.md §1, п.1) — движок в M1 **только читает** живые
данные DAPI/platform-explorer напрямую (свой собственный, независимый вызов тех же источников, не
через n8n) и **опционально** читает уже накопленную n8n-историю из Supabase read-only (R-12). Два
пути не пересекаются в коде.

**Кикофф-решения пользователя (2026-07-22), зафиксированные в TASK.md §1 и обязательные для этого
дизайна:**

1. Снапшоттер/история остаются за n8n до M3; `dash-platform` в M1 — строго READ-ONLY.
2. Кеш (D6) — **двухуровневый, engine-local**: `lru-cache` (hot) + `better-sqlite3` (persistent) в
   `DATA_DIR`, схема по DB-SCHEMA-CONCEPT §1. Кеш **не** живёт в Postgres.
   > **Аннотация к ADR-001 D6 (не правка ADR):** дополнение D6 от 2026-07-20 («профиль деплоя
   > выделенный сервер» → Postgres день-1 для кеша) описывает **другой** профиль деплоя
   > (always-on планировщик на выделенном сервере). Движок `onchain-intel` в M1 — локальный stdio
   > MCP-процесс под Claude Code, не тот профиль; поэтому для него в силе базовая ветка D6
   > (SQLite+LRU). ADR не редактируется этой задачей — расхождение профилей документируется здесь.
3. Весь блок M1 — один пайплайн-прогон; атомарную нарезку делает Planner.

## 2. Функциональная архитектура

Функциональные компоненты M1 — chain/address-нормализация, Provider Adapters + Capability
Registry (9 адаптеров), канонизация в zod-типы (D5), двухуровневый кеш (D6), SSRF-гейт +
rate-limiter, `pg-history`, MCP-сервер (5 tools) — с mermaid-диаграммой и Use Cases UC-1…UC-5.
→ [architectures/functional-architecture.md](architectures/functional-architecture.md)

## 3. Системная архитектура

Архитектурный стиль (два пакета: `core` + `mcp-server`, решение OQ-3); детальные контракты
`@onchain-intel/core` — zod-типы, `ProviderAdapter`/`CapabilityRegistry` (cache best-effort),
`providers.config.ts` (маршруты, allowlist, rate-limits), сводка девяти адаптеров и их hardening,
кеш-DDL + TTL-таблица, `safeFetch`/`throttle`, `pg/read-client`; расширение `mcp-server`
(injectable registry), тест-сьют M1 (287) и диаграмма компонентов.
→ [architectures/system-architecture.md](architectures/system-architecture.md)

## 4. Data Model (Conceptual)

Канонические сущности (`Token`/`Wallet`/`Balance`/`Pool`/`OHLCV`/`Snapshot` + camelCase↔snake_case
примечание), логическая модель кеш-БД (`providers` ← `cache_entries`), ER-диаграмма, миграции
(M2: `usage` FK на тот же реестр). → [architectures/data-model.md](architectures/data-model.md)

## 5. Интерфейсы

Контракты 5 MCP-tools (input/output, `.max()`-границы, `_meta.cache`, `token.price`-TTL решение),
публичный API `packages/core`, таблица интеграций провайдеров — источник SSRF-allowlist.
→ [architectures/interfaces.md](architectures/interfaces.md)

## 6. Технологический стек

Зависимости M1 с обоснованием (без `@grpc/*` — F-3), раскладка монорепо (полное дерево
`packages/core`), ключевые поля `package.json`, pnpm-топология сборки.
→ [architectures/technology-stack.md](architectures/technology-stack.md)

## 7. Безопасность

Секреты (D10), кеш-ключ без env-значений (`canonicalize` + sha256), stdout-дисциплина, SSRF-гейт,
rate-limit, PG SELECT-only + рекомендация server-side роли, supply chain / лицензии.
→ [architectures/security.md](architectures/security.md)

## 8. Масштабируемость и производительность

Без изменений в стратегии от v1.1: M1 остаётся однопроцессным (`lru-cache`+SQLite, in-memory
rate-limiter/registry) — абстракции (`CacheStore`, `ProviderAdapter`, `CapabilityRegistry`)
спроектированы так, чтобы Redis/BullMQ/Postgres (M6, ADR-001 §Revisit) подменялись без
переписывания вызывающего кода (тот же принцип, что D6/D7/D8). Ничего в M1 не вводит
синглтон-состояние, которое пришлось бы откатывать при масштабировании — `CapabilityRegistry` и
`SqliteCacheStore` — фабрики, не глобальные singletons модуля (тестируемость + будущая
многоинстансность).

## 9. Надёжность и отказоустойчивость

### 9.1. Обработка ошибок

- **Hot-swap fallback (R-11):** ошибка `fetch()`/`normalize()` **или** `isAvailable() === false`
  текущего адаптера в маршруте → Registry переходит к следующему `adapterId` в
  `route.adapterIds`, не падает целиком — доказано `registry.fallback.test.ts` на **реальной**
  M1-конфигурации (`dash-platform.isAvailable()` детерминированно `false` → `platform-explorer`
  отвечает; F-3, не симулированная недоступность).
- **Явная недоступность (R-24):** отсутствующий ключ/DSN → `isAvailable()` возвращает
  структурированную причину **до** попытки сети — не молчаливый `undefined`, не краш. Если **все**
  адаптеры маршрута недоступны/упали — `CapabilityUnavailableError` со списком `(adapterId,
reason)`, tool возвращает `isError: true` с понятным текстом (без значений секретов).
- Ошибка валидации input (zod, включая `superRefine`-адрес-проверку) — по-прежнему MCP tool-error,
  не падение процесса (унаследовано от M0).
- Retry/circuit-breaker поверх отдельного provider-вызова — **не вводится в M1** (YAGNI; hot-swap
  fallback + rate-limit достаточны на этом объёме; retry-слой — кандидат M2/M6, если понадобится).

### 9.2. Backup

Без изменений — `DATA_DIR` (кеш) не требует backup-стратегии (кеш восстанавливается пересчётом);
n8n/Supabase backup — вне скоупа движка (уже покрыт DB-SCHEMA-CONCEPT §8.6, отдельная система).

### 9.3. Мониторинг и алертинг

M1: stderr-строки (cache hit/miss, недоступность способности — reasons) + `_meta.cache` в ответах
tools (§3.2/§7.3) — без нового фреймворка (YAGNI на этом размере, как и в M0). **FUTURE (M6):**
pino + OpenTelemetry, дашборд per-provider costs (ROADMAP) — не пересматривается здесь.

## 10. Деплой

Окружения (dev, Claude Code), порядок CI-шагов (core build **до** typecheck — верификация 003-8),
конфигурация (`EnvSchema`, `providers.config.ts`), инструкция dev-развёртывания.
→ [architectures/deployment.md](architectures/deployment.md)

## 11. Открытые вопросы

Неблокирующие открытые пункты (DAPI gRPC — backlog; второй keyless Solana RPC; Dune query id;
лицензия `dashpay/platform`), RESOLVED-отметки задач 003-4/5/6 и зафиксированные M2-дефолты
адверсариальных циклов. → [architectures/open-questions.md](architectures/open-questions.md)

## Приложение: M0-детали, сохранённые без пересмотра

Полный текст M0-специфичных разделов (тест-сьют `packages/mcp-server/test/`, CI-hardening
детали адверсариальных циклов 1–2, инструкция по `onchain_ping`) — не дублируется здесь построчно,
т.к. §3.2/§10.2 этого документа уже включают актуальные ссылки на них там, где M1 их расширяет.
Полная история M0-версии документа — `git log docs/ARCHITECTURE.md` (v1.1, коммит перед этим
обновлением) и архивные task-файлы `docs/tasks/task-001-m0-discovery-skeleton.md` /
`docs/tasks/task-002-m0-docs-sync.md`.
