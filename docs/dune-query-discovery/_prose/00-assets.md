Прогон **не** ищет замену тому, что уже построено в `onchain-intel`
(`/Users/sergey/dev-projects/onchain-analytics`, M0–M2 + TASK-006 закрыты, 796 тестов):

- **Машинерия провайдеров** — `ProviderAdapter` / `CapabilityRegistry` с горячей заменой и цепочкой
  фолбэка, декларативная таблица маршрутов, per-adapter SSRF-allowlist, token-bucket rate limit.
- **Кредитный бюджет** — `usage`-леджер, `checkAndReserve` в `BEGIN IMMEDIATE`, велосити-окно,
  сверка после вызова. Интерфейс `BudgetStore` **уже провайдер-агностичен**
  (`packages/core/src/cache/budget-store.ts:46-93`), а `dune` **уже** числится платным
  (`packages/core/src/cache/sqlite-store.ts:48`).
- **Двухуровневый кэш** (`lru-cache` + `better-sqlite3`), TTL-таблица, негативный кэш на 60 с,
  ключ кэша, доказуемо не содержащий секретов.
- **Реестр 458 сетей** (CAIP-2 канон + вендорские маппинги) и матрица покрытия, выводимая из
  `routes × adapter.chainSupport()`, а не хранимая вторым каталогом.
- **10 бесплатных и платных адаптеров** — CoinGecko, DexScreener, DeFiLlama, rpc-evm, rpc-solana,
  platform-explorer, dash-platform (fixture), pg-history, dune (стаб), nansen (платный).
- **10 MCP-тулов** поверх stdio, живой eval бесплатного контура (`packages/mcp-server/eval/`,
  пробы как данные), провенанс-манифест живых фикстур с pre-commit хуком.
- **Прошлое исследование провайдеров** (`docs/onchain-analytics/`) — матрица 20 провайдеров,
  ADR-001 с решениями D1–D12, ROADMAP M0–M6.

→ Поэтому в области прогона **нет**: повторного обзора провайдеров «вообще», проектирования кэша
или бюджета с нуля, пересмотра ADR-001, поиска замены Nansen. Полный аудит того, что из этого
переиспользуется под новый слой и что мешает — в [repo-audit.md](repo-audit.md).
