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
capability, argsHash)` с учётом будущего budget-guard (M2, ADR-001 §Revisit); `safeFetch`'s
  Content-Length-кап не покрывает chunked/no-Content-Length ответы — нужен потоковый byte-counter
  (§3.2); `rpc-solana` не парсит точный lamport-баланс выше `Number.MAX_SAFE_INTEGER` (~9.007M SOL,
  вендорное ограничение JSON-числа, §3.2).
