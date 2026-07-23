# 7. Безопасность

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

### 7.1. Аутентификация и авторизация

Без изменений от v1.1 (N/A — локальный stdio-процесс, доверие через хост-процесс). PG read-only
клиент (M1) не добавляет auth-периметр движку — авторизация происходит на стороне Postgres-роли
(рекомендация ниже), движок лишь потребляет DSN.

### 7.2. Защита данных

- Секреты — по-прежнему только `.env` (0600) + zod (D10); **4 новых опциональных ключа** (§3.2)
  подчиняются тому же правилу: никогда не логируются, никогда не попадают в кеш-ключ.
- **M2 (TASK-005, R-45): `NANSEN_API_KEY` — тот же контракт, шестой опциональный ключ.**
  Заголовок `apiKey: <NANSEN_API_KEY>` уже покрыт существующим `SENSITIVE_HEADER_RE =
/authorization|api-?key/i` в `net/safe-fetch.ts:83` (**без правок regex**, верифицировано чтением
  кода при разведке этой архитектуры): `Headers`-API лишает имя заголовка регистра ДО сравнения
  (`"apiKey"` → `"apikey"`), а `api-?key` матчит `"apikey"` (дефис — опционален) буквально — cross-
  host редирект уже срезал бы этот заголовок так же, как `Authorization`/`x-cg-*-api-key`.
  Development-фаза добавляет **regression-тест**, доказывающий это конкретно для `nansen`, не
  правку самого regex (R-45 acceptance). Ключ читается адаптером внутри `fetch()` **после**
  вычисления `args_hash` — тот же M1-инвариант, что и остальные 5 ключей (§7.2 продолжение ниже).
  `NANSEN_DAILY_CREDIT_CAP` (OQ-5, §3.2/§11) — **не секрет**, обычное числовое конфиг-значение
  (как `providers.config.ts`'s rate-limit числа), может безопасно попадать в stderr/`_meta` при
  необходимости — контраст с самим API-ключом.
- **Кеш-ключ явно исключает env-значения** (обязательное требование задачи) — `args_hash` в
  `cache_entries` — это `sha256(hex)` от **нормализованных входных аргументов tool-вызова**
  (`chain`, адрес, `protocolSlug`, `limit`, `tokenAddress`, `query`, `exhaustive`, …), полученных
  **после** валидации zod-схемой и `normalizeAddress`. Ни `COINGECKO_API_KEY`/
  `COINGECKO_PRO_API_KEY`, ни `DUNE_API_KEY`, ни `ONCHAIN_PG_URL`, ни (M2) `NANSEN_API_KEY` никогда
  не входят в объект, который хешируется — они read-only читаются адаптером внутри `fetch()`, после
  того как ключ уже вычислен из args (R-45 acceptance: два вызова с разными `NANSEN_API_KEY`, но
  одинаковыми args → идентичный `args_hash`):

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

- **stdout-дисциплина** (M0-инвариант, не меняется) — по-прежнему в силе для всех 8 tools (5 M1 +
  3 M2); `_meta` (включая новый `_meta.budget`, §5.1.2) и любой лог по-прежнему только через
  MCP-протокольный ответ/stderr, не сырой stdout-вывод.
- **SSRF-гейт (новое, R-25):** `safeFetch()` — единственная точка исходящего HTTP; allowlist —
  **per-adapter** (не глобальный), редирект проверяется на каждом хопе (макс. 3), никогда не
  доверяет `Location`-заголовку вслепую (§3.2/§5.3). `assertAllowedHost()` — тот же примитив,
  transport-агностичный (задуман и для будущих неHTTP-транспортов вроде gRPC), но в M1 фактически
  не задействован ни одним живым адаптером (`dash-platform`'s gRPC-канал не создаётся в M1, F-3) —
  остаётся готовым для backlog-задачи живого DAPI-транспорта (§11), когда канал-level проверка
  снова понадобится.
- **Rate-limit (R-26):** token-bucket per-provider — защищает и провайдера (good citizen), и нас
  (не сжигаем платный кредит быстрее, чем нужно). **M2 добавляет полноценный budget-guard** поверх
  rate-limit'а — оба независимы и оба обязательны: rate-limit защищает от 429 вне зависимости от
  цены запроса, budget-guard (§3.2/§4.2) защищает бюджет вне зависимости от скорости запросов
  (429-`retry-after` и `X-Nansen-Credits-*` — два разных заголовка, два разных механизма).
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
