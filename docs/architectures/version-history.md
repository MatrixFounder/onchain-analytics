# История версий (changelog)

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

Перенесено дословно из ячейки «Обновлено» шапки-таблицы (2026-07-23): ячейка в ~3100 символов заставляла prettier добивать всю таблицу индекса паддингом до её ширины.

- 2026-07-23, **v2.2** — синхронизация с фактическим кодом после адверсариальных циклов 1–3 (14+8+1 находок, коммиты 8d3ea79/066cce6/8a602cc) + polish-раунда (61f3ab2, 6 fixes + RF-1): `CapabilityRegistry.resolve()` — кеш-сбой теперь **best-effort** (никогда не даёт `CapabilityUnavailableError`); `safeFetch` — таймаут (`AbortSignal.timeout`, 15с), Content-Length-кап 10MB, https-проверка исходного URL **и** редиректов, срез `Authorization`/api-key-заголовков на cross-host редиректе; rate-limiter — конкурентно-безопасный синхронный token-bucket (негативный backlog, без promise-цепочек) + типизированный reject при `refillPerSec<=0` и 30с fairness-кап (с рефандом токена); `pg-history`-клиент — `pool.on('error')`, `connectionTimeoutMillis=10000`/`max=3`, санитизация **всех** путей отказа включая конструктор `Pool`; `onchain_get_token` — capability `token.metadata`→`token.price` (TTL 60с, не 3600с); `address`/`protocolSlug` — явные `.max()`-границы; `onchain_new_pairs` материализует дефолтный `limit` до кеш-ключа; адаптеры ужесточены (rpc-evm hex-regex, rpc-solana safe-integer lamports, dexscreener skip-and-log, defillama finite/non-negative tvl, общий `stringify-truncated.ts`); кеш-БД — prepared statements, sweep каждые 50 записей, leak-safe конструктор, честный `ageMs` при LRU-промоушене; исправлена устаревшая `isError`-формулировка (SDK 1.29 перехватывает любой throw хендлера, не только zod-валидацию). Тест-сьют — **284** (209 core + 75 mcp-server).

- 2026-07-22, **v2.1** — адверсариальный ревью-цикл 1 (CHANGES_REQUESTED → исправлено): F-1 разделён spawn-vs-in-process E2E, F-2 зарегистрирован `pg-history`-адаптер (+ history-маршрутизация через `platform-explorer`), F-3 `dash-platform` сужен до interface+fixture-контракта в M1 (живой gRPC-транспорт — отдельная backlog-задача, `@grpc/*` убраны из M1-зависимостей); + majors (dexscreener `pool.info`, `onchain_wallet_balances` chain-enum сужен) и minors (канонический key-order в `deriveArgsHash`, явное решение по Dune R-8, `Snapshot` camelCase↔snake_case примечание, диаграмма §2.2 исправлена).

- v2 — M1 read-слой (TASK-003): канонические типы, Adapter/Capability Registry, девять адаптеров, двухуровневый кеш, 4 MCP-tools.

- v1.1 (M0 sync) сохранена как история ниже, где не пересмотрена.
