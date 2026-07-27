# Task 007-1: Capability `dex.volume.history` — обвязка и стабы

## Use Case Connection

- UC-1: агент спрашивает дневной объём DEX по сети (обвязка, по которой вызов доходит до адаптера)

## RTM

**R-61** (capability + маршрут) · **R-64** (строка TTL) · **R-66** (пересмотр `rateLimit`)

## Task Goal

Объявить capability целиком — маршрут, TTL, стоимость, доступность, — и оставить `fetch`/`normalize`
**демонстративно нереализованными**. После задачи вызов доходит до адаптера и получает внятный отказ;
матрица покрытия показывает **ноль** сетей; сети не касается ничего.

## Changes Description

### Изменения в существующих файлах

#### `packages/core/src/providers.config.ts`

- В `routes`, рядом со строкой `chain.tvl`:
  `{ capability: 'dex.volume.history', adapterIds: ['defillama'] }`.
- В `adapterRegistrations`, запись `defillama`: `rateLimit` → `{ capacity: 10, refillPerSec: 5 }`
  с комментарием-обоснованием (замер 40/40 конкурентных origin-запросов без 429; при `5/1`
  десятисетевой прогон спит ~5 с, широкий — упирается в `MAX_WAIT_MS = 30_000` и **бросает**).
  Прежнее значение — плейсхолдер M1, а не вендорский лимит: вендор числовой лимит не публикует вовсе.

#### `packages/core/src/cache/ttl.ts`

- Строка `'dex.volume.history': 3600` с обоснованием: шаг данных у вендора — **сутки**, поэтому TTL
  короче суток не может дать более свежее число, только вторую идентичную загрузку.
- Строка **обязательна**: без неё capability молча проваливается в `DEFAULT_TTL_SECONDS = 300`
  (`ttl.ts:61`) — авария, которую проект уже переживал на трёх платных capability M2.

#### `packages/core/src/adapters/defillama/index.ts`

- `capabilities()` → `[{ id: 'protocol.tvl' }, { id: 'chain.tvl' }, { id: 'dex.volume.history' }]`.
- `chainSupport(chain, capability)`: принять **второй параметр**; для `dex.volume.history` вернуть
  `false` (стаб — реальный предикат приходит в 007-2), для остальных — прежнее
  `chain.vendors['defillama'] != null`.
- `costOf`: остаётся `{ credits: 0 }` — keyless-вендор, кредитов нет ни у одной из трёх capability.
  (Это НЕ та ловушка, что у `dune`: там ноль стоит у **кредитно-метрируемого** вендора.)
- `fetch`/`normalize`: ветка `cap === 'dex.volume.history'` бросает
  `new NotImplementedInM1Error('defillama.dex.volume.history')` — использовать существующий
  `adapters/not-implemented-error.ts`, не изобретать второй класс.

## Test Cases

### Unit-тесты (`packages/core/test/defillama.contract.test.ts`)

1. **TC-UNIT-01** — `capabilities()` содержит ровно три id, включая `dex.volume.history`.
2. **TC-UNIT-02** — `costOf('dex.volume.history', {})` = `{ credits: 0 }`.
3. **TC-UNIT-03** — `fetch('dex.volume.history', {chain:'ethereum'})` отвергается
   `NotImplementedInM1Error` (стаб-поведение; в 007-4 ожидание меняется).
4. **TC-UNIT-04** — `chainSupport(ethereum, 'chain.tvl') === true` **и**
   `chainSupport(ethereum, 'dex.volume.history') === false` — одна сеть, два разных ответа: это и
   есть доказательство, что предикат стал зависеть от capability.

### Unit-тесты (`packages/core/test/cache.test.ts` или соседний)

5. **TC-UNIT-05** — `ttlFor('dex.volume.history') === 3600` и **не равен** `DEFAULT_TTL_SECONDS`.
   Второе утверждение самостоятельно: оно ловит удаление строки, а не только её значение.

### Регрессия

- Полный `pnpm test`. Особое внимание — тестам лимитера и `providers.config`: поднятый `rateLimit`
  не должен ломать существующие ожидания (значение **растёт**, пути могут только ускориться).

## Acceptance Criteria

- [ ] Маршрут, TTL, `rateLimit`, `capabilities()`, `costOf` на месте
- [ ] `chainSupport` принимает `capability` и различает две группы
- [ ] `fetch`/`normalize` для новой capability бросают типизированную ошибку, а не молчат
- [ ] `pnpm test` зелёный целиком
- [ ] Ни одного сетевого вызова добавлено не было

## Notes

Задача сознательно **не** трогает покрытие: `chainSupport` возвращает `false` и матрица показывает
ноль сетей. Это правильное промежуточное состояние — «capability объявлена, но никому не обещана».
Обратный порядок (сначала покрытие, потом отказ) на любом промежуточном коммите означал бы
переобещание.
