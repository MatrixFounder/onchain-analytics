# 7. Безопасность

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

### 7.1. Аутентификация и авторизация

Без изменений от v1.1 (N/A — локальный stdio-процесс, доверие через хост-процесс). PG read-only
клиент (M1) не добавляет auth-периметр движку — авторизация происходит на стороне Postgres-роли
(рекомендация ниже), движок лишь потребляет DSN.

### 7.2. Защита данных

- Секреты — по-прежнему только `.env` (0600) + zod (D10); **4 новых опциональных ключа** (§3.2)
  подчиняются тому же правилу: никогда не логируются, никогда не попадают в кеш-ключ.
- **Кеш-ключ явно исключает env-значения** (обязательное требование задачи) — `args_hash` в
  `cache_entries` — это `sha256(hex)` от **нормализованных входных аргументов tool-вызова**
  (`chain`, адрес, `protocolSlug`, `limit`, …), полученных **после** валидации zod-схемой и
  `normalizeAddress`. Ни `COINGECKO_API_KEY`, ни `DUNE_API_KEY`, ни `ONCHAIN_PG_URL` никогда не
  входят в объект, который хешируется — они read-only читаются адаптером внутри `fetch()`, после
  того как ключ уже вычислен из args:

  ```ts
  function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce(
          (acc, k) => {
            acc[k] = canonicalize((value as Record<string, unknown>)[k]);
            return acc;
          },
          {} as Record<string, unknown>,
        );
    }
    return value;
  }

  function deriveArgsHash(capability: string, args: Record<string, unknown>): string {
    // args — ТОЛЬКО нормализованный tool-input (chain/address/limit/...), НИКОГДА process.env.
    // canonicalize(): рекурсивно сортирует ключи ДО JSON.stringify (minor, ревью цикл 1) —
    // иначе {chain,address} и {address,chain} (семантически один и тот же вход, разный порядок
    // построения объекта) дают разные JSON-строки → разные хеши → ложный (spurious) cache miss.
    return sha256Hex(JSON.stringify({ capability, args: canonicalize(args) }));
  }
  ```

### 7.3. Защита от атак / поверхность

- **stdout-дисциплина** (M0-инвариант, не меняется) — по-прежнему в силе для всех 5 tools; `_meta`
  и любой лог по-прежнему только через MCP-протокольный ответ/stderr, не сырой stdout-вывод.
- **SSRF-гейт (новое, R-25):** `safeFetch()` — единственная точка исходящего HTTP; allowlist —
  **per-adapter** (не глобальный), редирект проверяется на каждом хопе (макс. 3), никогда не
  доверяет `Location`-заголовку вслепую (§3.2/§5.3). `assertAllowedHost()` — тот же примитив,
  transport-агностичный (задуман и для будущих неHTTP-транспортов вроде gRPC), но в M1 фактически
  не задействован ни одним живым адаптером (`dash-platform`'s gRPC-канал не создаётся в M1, F-3) —
  остаётся готовым для backlog-задачи живого DAPI-транспорта (§11), когда канал-level проверка
  снова понадобится.
- **Rate-limit (R-26):** token-bucket per-provider — защищает и провайдера (good citizen), и нас
  (не сжигаем платный `DUNE_API_KEY`-кредит быстрее, чем нужно, до появления полноценного
  budget-guard в M2).
- **PG read-only (R-12):** движок пишет только `SELECT`-запросы (код-ревью гейт); **рекомендация
  для оператора БД** — сама Postgres-роль, под которой подключается движок, должна быть
  server-side SELECT-only (`GRANT SELECT ON SCHEMA onchain TO <role>`, без `INSERT/UPDATE/
DELETE`), т.к. код-дисциплина — не защита от компрометации ключа/DSN; это defense-in-depth,
  которую не может обеспечить сам движок.
- **Supply chain / лицензии:** новые зависимости M1 — `@noble/hashes` (MIT), `bs58` (MIT), `pg`
  (MIT), `better-sqlite3` (MIT), `lru-cache` (ISC), `ulid` (MIT) — все permissive, совместимы с
  Apache-2.0 движка (D12). `@grpc/grpc-js`+`@grpc/proto-loader` (Apache-2.0) и вендоренный
  `platform-v0.proto` (IDL-файл, не код; лицензия `dashpay/platform` — подлежит проверке перед
  вендорингом, ожидание permissive) **не входят в M1** (F-3, ревью цикл 1) — приходят вместе с
  отложенной backlog-задачей живого DAPI-транспорта (§11), не раньше.
- `pnpm install --frozen-lockfile` в CI — без изменений.
