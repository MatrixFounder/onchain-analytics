# 11. Открытые вопросы

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

Блокирующих для старта Planning-фазы нет — интерфейсные контракты (типы, `ProviderAdapter`,
Registry, cache DDL, tool-схемы) решены и не зависят от пунктов ниже. Зафиксированы как
**неблокирующие**, требующие live-пробника/решения до соответствующей атомарной Dev-задачи
(vendor-drift дисциплина, ADR-001):

- **DAPI живой gRPC-транспорт — backlog, не блокирует M1 (F-3):** `dash-platform` — interface +
  fixture-контракт only (§3.2); живой транспорт (evonode host, `@grpc/grpc-js`+`@grpc/proto-loader`,
  вендоринг `.proto`, канал-level `assertAllowedHost`) — отдельная, не атомарная M1, задача бэклога.
  `platform-explorer` несёт 100% фактического Dash-трафика в M1 (R-9/R-10/R-11 удовлетворены через
  реальный, не симулированный fallback-путь, §3.2).
- **Второй keyless Solana RPC-эндпоинт (fallback):** не найден в M1 — `rpc-solana` стартует с
  единственным подтверждённым хостом (`api.mainnet-beta.solana.com`), retry без hot-swap; нужен
  отдельный живой пробник второго кандидата перед добавлением в `hosts`/`adapterIds`.
- **Dune `token.holders` — точный query id/SQL:** авторится в Development на M2, вместе с
  `onchain_token_risk` — первым реальным потребителем способности (см. также R-8 ниже).
- **Dune R-8 — сужение scope, не блокирует (F-2/minor):** M1 поставляет `dune` как
  interface/config-stub (без `fetch`/`normalize`/фикстуры/теста) — ýже буквальной acceptance R-8 в
  TASK.md («contract-тест на фикстуре»). Одобрено ревью архитектуры; Planner принимает как
  обновлённый scope или эскалирует к Analyst для формальной правки RTM.
- **DexScreener endpoint для `pairs.new`/`pool.info` — RESOLVED (task 003-4):**
  `GET /latest/dex/search?q=<NATIVE_QUERY>` (`ETH`/`SOL`), подтверждено живым пробником 2026-07-22 +
  фикстурами; ответ — объект `{schemaVersion, pairs}`, не top-level массив (shape-trap,
  зафиксирован регрессионным тестом).
- **Лицензия `dashpay/platform`** (для вендоринга `.proto`, когда backlog-задача живого gRPC
  landится) — проверить `LICENSE`-файл репозитория в Development перед копированием IDL (ожидание:
  permissive). Остаётся открытым — не проверялось.
- **`ONCHAIN_PG_URL` zod-валидация — RESOLVED (task 003-6):** `z.string().url()` эмпирически
  подтверждён на реалистичной Supabase-строке (percent-encoded спецсимвол в пароле + query-string);
  fallback не понадобился.
- **ERC-20/SPL-балансы** — явно вне M1 (§3.2); backlog work-item для M1.5/M2, схема `Balance` уже
  готова принять их без миграции.
- **`pnpm -r build`/`test`-топология — RESOLVED (task 003-5):** подтверждено порядком вывода
  живого `pnpm -r build` (core перед mcp-server), не только предположение о default-поведении pnpm.
- **M2-дефолты, зафиксированные как НЕ баги M1 (адверсариальные циклы, один компактный пункт, не
  блокирует M1):** singleflight/dedup конкурентных промахов на один и тот же `(provider,
capability, argsHash)` с учётом будущего budget-guard (M2, ADR-001 §Revisit — **реализовано ниже,
  R-39**); `safeFetch`'s Content-Length-кап не покрывает chunked/no-Content-Length ответы — нужен
  потоковый byte-counter (§3.2, R-47, остаётся оппортунистическим); `rpc-solana` не парсит точный
  lamport-баланс выше `Number.MAX_SAFE_INTEGER` (~9.007M SOL, вендорное ограничение JSON-числа,
  §3.2, R-47, остаётся оппортунистическим).

## M2 (TASK-005 `m2-alpha-paid`) — OQ-1…OQ-5, RESOLVED в этой архитектуре

- **OQ-1 — формула потолка бакета: RESOLVED — ДВА раздельных условия, не один `min()`.**
  Вендорский лимит — **anchor-relative**: `snapshot.usageAtObserve` (расход, уже учтённый в
  `creditsRemainingAtObserve` на момент resync'а, читается тем же логическим шагом, что и
  `/account`) вычитается из бакет-суммарного `usage.credits_used(bucket)`, и только эта разница
  (`spentSinceAnchor`) сравнивается с `creditsRemainingAtObserve`. Self-imposed
  `NANSEN_DAILY_CREDIT_CAP` — по-прежнему **bucket-relative** (сравнивается с полным `usage`
  бакета напрямую, без якоря — это дневной потолок собственного pacing'а, а не вендорский остаток).
  **Оба условия обязательны одновременно; схлопывать их в один `min()` в СЫРОМ виде НЕЛЬЗЯ**
  (корректное схлопывание существует ровно одно — сначала перебазировать вендорский член:
  `effectiveCeiling = min(usageAtObserve + creditsRemainingAtObserve, CAP)`, см. §3.2) — первая версия
  этой резолюции делала именно это и повторно вычитала уже учтённый расход на каждом mid-bucket
  resync'е (unreconciled-триггер, R-38), давая phantom lockout вместо защиты от него — найдено на
  ревью и исправлено; полная формула + числовой пример — system-architecture.md §3.2. Resync
  триггерится cold-start'ом (нет снимка/снимок из прошлого day-бакета) и `unreconciled`-флагом
  (R-38/UC-6), не на каждый вызов (§3.2 «Account-state»). День-бакет — **собственный
  pacing-инструмент** движка (R-36), не
  предположение о вендорском cadence сброса, которое пробник не подтверждает.
- **OQ-2 — размещение budget-gate: RESOLVED.** Ни `CapabilityRegistry.resolve()` (был бы Nansen-
  специфичный код внутри универсального компонента), ни MCP tool-хендлер (ломает обязательный
  порядок «cache-miss до gate», R-37/UC-5). Гейт — внутренний приватный слой реализации `fetch()`
  самого `nansen`-адаптера (`adapters/nansen/index.ts`), на уже существующем шве, которым
  `CapabilityRegistry.resolve()` вызывает `adapter.fetch()`. Небайпассируемость — структурная:
  единственная публично экспортируемая фабрика пакета для nansen — `createNansenAdapter()`, «сырого»
  негейтуемого варианта нет в публичном API. Детали и обоснование — system-architecture.md §3.2.
- **OQ-3 — chain-scope: RESOLVED — `ethereum`+`solana`, то же подмножество, что M1.** Живая
  эвиденция показала, что три релевантных Nansen per-endpoint энумератора (`SmartMoneyChain` — 17,
  `TGMHoldersChain`/`TGMChain` — по 24) **не идентичны друг другу**, и что «~32 сети» пробника —
  другая, вне-скоупа поверхность (официальный MCP-сервер). Расширение до более широкого
  Nansen-специфичного списка сетей — задокументированный backlog-кандидат ниже, не в M2.
- **OQ-4 — дефолт эскалации `onchain_entity_label` на Pro: RESOLVED — НЕ поднимается
  автоматически, `exhaustive` остаётся explicit opt-in независимо от плана.** Обе цены
  (`/profiler/address/labels`=100cr, `/profiler/address/premium-labels`=500cr) теперь статически
  известны, но автоматическое повышение дефолта на Pro сделало бы поведение tool'а зависящим от
  недетерминированного внешнего состояния (текущий план аккаунта) без явного намерения вызывающего
  агента — тот же принцип, что уже применён к rate-limit/TTL (конфиг, не скрытая эвристика).
  Поднять дефолт в будущем — тривиальная правка (один флаг), не архитектурное решение сейчас.
- **OQ-5 — самостоятельный env-потолок: RESOLVED — ДА, `NANSEN_DAILY_CREDIT_CAP` (опциональный).**
  Сужает (никогда не расширяет) live-derived потолок — решение владельца TASK.md §1 п.1 не
  нарушается. `EnvSchema`-паттерн (`emptyAsUndefined`, D10) — тот же, что 6 остальных ключей.

**Backlog-кандидат, НЕ блокирующий M2 (OQ-3 продолжение):** более широкий Nansen-специфичный
chain-scope для одной или нескольких из трёх M2-способностей — требует отдельного живого пробника
**на каждую способность** (энумераторы не совпадают) и явного продуктового запроса, которого exit-
критерии ROADMAP §M2 не формулируют.
