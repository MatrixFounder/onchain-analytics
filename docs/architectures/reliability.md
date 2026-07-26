# 9. Надёжность и отказоустойчивость

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

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
  fallback + rate-limit достаточны на этом объёме).
- **M2 (TASK-005): `nansen`'s платные отказы — та же нить, не новый механизм.** Budget-gate отказ,
  `402 Payment Required` (UC-6) и `429 Too Many Requests` (UC-7, решение — без retry внутри
  адаптера, явная ошибка с `retry-after`) — все три суть `throw` из `nansen.fetch()`, ловятся
  **уже существующим** try/catch `CapabilityRegistry.resolve()` и всплывают как обычный R-24/R-40
  `isError: true` (нет fallback-адаптера для платных маршрутов — единственный источник исчерпан).
  Retry/circuit-breaker framework по-прежнему **не вводится** (YAGNI, буквальное ограничение
  TASK-005). Приближение к бюджетному потолку — одна stderr-строка (тот же канал, что M1
  cache-метрики, §9.3 ниже), не новый notification-канал — закрывает риск-гейт ROADMAP §M2
  «бюджет-алерт». Детали — [architectures/system-architecture.md §3.2](architectures/system-architecture.md).

### 9.2. Backup

Без изменений — `DATA_DIR` (кеш) не требует backup-стратегии (кеш восстанавливается пересчётом);
n8n/Supabase backup — вне скоупа движка (уже покрыт DB-SCHEMA-CONCEPT §8.6, отдельная система).

### 9.3. Мониторинг и алертинг

M1: stderr-строки (cache hit/miss, недоступность способности — reasons) + `_meta.cache` в ответах
tools (§3.2/§7.3) — без нового фреймворка (YAGNI на этом размере, как и в M0). **M2:** та же пара
каналов, расширенная budget-наблюдаемостью — stderr-предупреждение при приближении к потолку (§9.1
выше) + `_meta.budget` в ответах 3 новых tools (interfaces.md §5.1.2) — не новый канал, та же
архитектура видимости, что M1 уже установила для кеша. **FUTURE (M6):** pino + OpenTelemetry,
дашборд per-provider costs (ROADMAP) — не пересматривается здесь.
