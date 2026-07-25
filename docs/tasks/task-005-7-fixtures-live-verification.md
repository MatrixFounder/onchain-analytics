# Task 005-7 — [R-44] живая запись фикстур + live-verification ⚠️ ЕДИНСТВЕННАЯ ПЛАТНАЯ ЗАДАЧА (≈16 кредитов)

| Поле                    | Значение                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Родительская задача** | [TASK-005 `m2-alpha-paid`](../TASK.md)                                                                                                                                                       |
| **Тип**                 | Dev/Verify (однократная живая запись + замена provisional-фикстур)                                                                                                                           |
| **R-IDs**               | **R-44**                                                                                                                                                                                     |
| **Зависимости**         | 005-6 (весь путь собран — живой вызов идёт через продовый код)                                                                                                                               |
| **Разблокирует**        | 005-8 (финальная приёмка)                                                                                                                                                                    |
| **Источники**           | TASK.md §1 п.4 / UC-8 / §6 «Live-verification (M-6)», [system-architecture.md](../architectures/system-architecture.md) §3.2                                                                 |
| **Живые кредиты**       | **≈16 из потолка ≤30** — см. бюджет ниже                                                                                                                                                     |
| **GOLDEN_TEST_SHA**     | `c514c8ac129a568aa2e8330458d2a08928d5c75b4fd76c0999e2d1d6cd747cf8` (005-4 Phase 2 acceptance, `shasum -a 256 packages/core/test/nansen.contract.test.ts`, spec-derived fixtures, 2026-07-24) |

## ⚠️ Бюджетный контракт этой задачи

Баланс аккаунта — **100 кредитов** (`free`-план). Владелец ограничил всю сборку M2 потолком
**≤30 кредитов**. Ни одна другая задача M2 не имеет права на живой вызов; вся стоимость сборки
сосредоточена **здесь**.

Стоимость считается **per HTTP-под-вызов, сгруппированный в 3 платных логических `fetch()`-вызова**:
продовый `fetch()` — capability-гранулярный и композитный (`smart-money.flows` = netflow + holders
**всегда оба** = 10cr; `token.risk` = indicators + token-information **всегда оба** = 6cr). Recorder
**обязан быть capability-аргументным** и писать **все под-ответы одного логического `fetch()`** в их
per-endpoint фикстуры — вызывать его по одному эндпоинту через продовый путь означало бы **повторно
оплатить** под-вызовы (27cr для holders→entity.labels, **32cr** для holders→smart-money.flows —
пробитие потолка ≤30) и продублировать уже записанные платные вызовы.

| Логический `fetch()`                    | HTTP-под-вызовы → фикстуры                           | Кредитов |
| --------------------------------------- | ---------------------------------------------------- | -------- |
| `account` (resync, до)                  | `account.free.json` (замена spec)                    | **0**    |
| `entity.labels` (`query`-only)          | `search-general.json`                                | **0**    |
| `smart-money.flows`                     | `smart-money-netflow.json` + `tgm-holders.json`      | **10**   |
| `token.risk`                            | `tgm-indicators.json` + `tgm-token-information.json` | **6**    |
| `account` (resync, после)               | (сверка расхода, файл не перезаписывается)           | **0**    |
| **Итого — 3 платных логических вызова** |                                                      | **16**   |

**Никогда не вызывать живьём:** `POST /profiler/address/labels` (100cr — весь баланс) и
`POST /profiler/address/premium-labels` (500cr). Их пути покрыты **только** тестами отказа гейта
(005-3/005-6) — арифметикой, не сетью. Фикстур для них не существует и они не нужны.

**Машинный гейт потолка (не только TC-VERIFY-01 постфактум):** весь сеанс записи гоняется с
`NANSEN_DAILY_CREDIT_CAP=30` и **единым персистентным recording `DATA_DIR`, переиспользуемым на весь
сеанс** (НЕ новый каталог на каждый вызов — иначе `usage`-леджер обнуляется каждый раз, cap никогда не
накапливается и не срабатывает). На свежем леджере `effectiveCeiling = min(0+100, 30) = 30`: 16cr
проходят, один повтор 10cr проходит (26), **второй** повтор наш собственный gate отказывает — это
и есть желаемое поведение и заодно живое доказательство работы гейта.

**Порядок работы — строго (три платных логических вызова, не шесть per-endpoint):**

1. Сначала **сухой прогон**: `account` (0cr) — убедиться, что ключ валиден, host отвечает,
   `plan`/`credits_remaining` читаются, `X-Nansen-*`-заголовки присутствуют. Записать фактический
   `credits_remaining` **до** платных вызовов.
2. Затем `entity.labels` с `query`-only (0cr) — проверить форму POST-тела и парсинг ответа
   **бесплатно**.
3. Только после этого — **два** платных логических вызова, **по одному**, с проверкой обеих
   записанных фикстур после каждого: `smart-money.flows` (10cr) → `token.risk` (6cr). Упавший вызов
   **не повторять вслепую**: разобраться, потом повторить (запас 14cr + машинный cap=30 — ровно на
   один такой повтор).
4. Финально — `account` ещё раз (0cr): фактически потрачено = `remaining_before − remaining_after`.
   Это число записывается в сводный evidence и обязано быть **≈16 и ≤30**.

## Цель

Заменить provisional (spec-derived) фикстуры **реально записанными**, доказать, что нормализация
работает на настоящем ответе вендора, зафиксировать наблюдённые `X-Nansen-Credits-Used` как
sanity-check против статической cost-таблицы — и после этого навсегда сделать `pnpm test`
бесплатным и offline-совместимым.

## Контекст: файлы

**Правки:**

- `packages/core/scripts/record-fixture.mjs` — расширяется на `nansen` (**вне CI**, как и был).
- `packages/core/test/fixtures/nansen/*.json` + `*.evidence.md` — **перезаписываются реальными**
  (`provenance: spec-derived` → `recorded_at`/`endpoint`/`http_status`/`observed_fields`/
  `x_nansen_credits_used`).
- `packages/core/test/nansen.contract.test.ts` — **ассерты не переписываются под фикстуру**: если
  реальная форма разошлась со spec-derived, чинится **нормализация** (или фиксируется находка
  вендор-дрейфа), а не подгоняется тест.
- `docs/onchain-analytics/raw/` — сводный evidence-файл прогона (фактический расход, до/после).

## Reviewer-заметки (обязательно применить)

- **Запись идёт через ту же фабрику `createNansenAdapter`**, что и прод — не через самодельный
  `fetch`-пробник рядом. Иначе фикстура доказывает работу кода, которого в проде нет (прецедент
  M1: скрипт зовёт адаптер, не хендроллит запрос). **Recorder — capability-аргументный:** одна
  команда = один логический `fetch()` = все его под-ответы записаны за один платный проход (см.
  таблицу расхода выше — иначе повторная оплата под-вызовов и пробитие потолка).
- **Recorder обязан сериализовать JSON-тело POST-запроса**, не только query-string (R-29/R-44) — все
  эндпоинты, кроме `/account`, — POST.
- **Budget-guard при записи — машинный cap:** скрипт работает через продовый `fetch()` со всеми
  слоями, значит резервация и реконсиляция реально исполнятся и **запишутся в `usage`**. Задать
  `NANSEN_DAILY_CREDIT_CAP=30` и **единый персистентный recording `DATA_DIR` на весь сеанс** (напр.
  `$(mktemp -d)` один раз, экспортированный в переменную и переиспользуемый всеми командами) — НЕ
  новый каталог на каждый вызов: свежий-на-каждый-вызов леджер обнуляет `usage`, cap никогда не
  накапливается и не срабатывает, а `usageAtObserve` каждого resync'а стартует с непонятного
  состояния. Единый каталог на сеанс даёт корректный накопительный cap (`min(0+100,30)=30`) и чистый
  `usageAtObserve=0` на первом resync'е.
- **Провенанс golden-теста (M-2 review):** 005-4 записал SHA `nansen.contract.test.ts` в свой
  acceptance. Эта задача **не правит ассерты** под живую фикстуру — легальны только правки
  `normalize.ts` (или задокументированный вендор-дрейф с явным override). SHA сверяется в acceptance
  ниже; расхождение без записанного override — «тихая подгонка теста», нарушение R-44.
- **Evidence — реально наблюдённое, не предположение:** `recorded_at`, точный endpoint, HTTP-статус,
  фактический список top-level полей ответа, **фактический `X-Nansen-Credits-Used`**.
- **Наблюдённая цена — sanity-check, НЕ источник цены.** Цена уже известна статически из спеки
  (`credit_cost_table`, R-37). Расхождение = **сигнал вендорского дрейфа** → фиксируется как issue в
  `docs/KNOWN_ISSUES.md`/`docs/BACKLOG.md` и упоминается в evidence, **не принимается молча** и **не
  правит** cost-таблицу задним числом без отдельного решения.
- **Никогда не коммитить ключ.** `.env` не трогается скриптом; в evidence не попадает ни значение
  ключа, ни заголовки запроса.
- **После записи — обязательный offline-прогон:** отключить сеть (или прогнать с
  `fetchImpl`, бросающим на любой вызов) и убедиться, что весь сьют зелёный. Это и есть доказательство
  «дальше 0 кредитов».
- **Live-verification (M-6) не добавляет расхода:** пара `/smart-money/netflow` + `/tgm/holders`
  (≈10cr) — **те же самые** вызовы, что дают фикстуры. Проверять через подключённый в Claude Code
  stdio-сервер имеет смысл **только** если после записи фикстур результат нужно увидеть в реальном
  клиенте; в этом случае повторный вызов попадёт в **кеш** (TTL) и будет стоить 0 — это и надо
  продемонстрировать (`_meta.cache.status === 'hit'`, `_meta.budget` отсутствует).

## Steps

1. **Phase 1 (0cr):** расширить `record-fixture.mjs` на `nansen` (**capability**-аргументный —
   пишет все под-ответы одного логического `fetch()`); задать `NANSEN_DAILY_CREDIT_CAP=30` и единый
   `RECDIR=$(mktemp -d)` на весь сеанс; прогнать **только** `account` и `entity.labels` `query`-only
   (обе 0cr); убедиться, что evidence-формат корректен, а POST-тело сериализуется.
2. **Phase 2 (16cr):** **два** платных логических вызова по одному — `smart-money.flows` (10cr) →
   `token.risk` (6cr) — с проверкой **обеих** записанных фикстур после каждого.
3. Заменить provisional-фикстуры; прогнать `nansen.contract.test.ts` **без правки ассертов** (SHA
   сверяется с baseline из 005-4); расхождения формы чинить в `normalize.ts`.
4. Финальный `account` (0cr); записать сводный evidence (`credits_remaining` до/после, фактический
   расход, соответствие плану ≤30).
5. Offline-прогон всего сьюта.

## Test Cases

1. **TC-VERIFY-01 (R-44, бюджет):** `remaining_before − remaining_after === 16` (±допустимое
   отклонение задокументировано); значение ≤30 — жёсткий гейт.
2. **TC-VERIFY-02 (R-44, sanity-check цены):** каждый наблюдённый `X-Nansen-Credits-Used` совпадает
   с `NANSEN_COST_TABLE[method+path].free`; расхождение → зафиксированная находка.
3. **TC-CONTRACT-03…07:** golden-тесты 005-4 зелёные на **реальных** фикстурах без изменения
   ассертов.
4. **TC-VERIFY-08 (R-44, offline):** `pnpm test` при отключённой сети — зелёный, 0 исходящих вызовов.
5. **TC-VERIFY-09 (evidence):** ни один `*.evidence.md` не содержит строки `provenance: spec-derived`
   и не содержит значения ключа.
6. **TC-VERIFY-10 (M-6, exit-критерий #1):** живой ответ `smart-money.flows` содержит **и** потоки
   (`netflow*Usd`), **и** метки холдеров (`topHolders[].addressLabel` хотя бы у одного) — прямое,
   не фикстурное доказательство «smart-money-запрос отдаёт метки+потоки».

## Acceptance (команды — RF-1-safe)

```bash
# Единый recording-каталог + машинный cap на ВЕСЬ сеанс (не новый каталог на вызов!):
export RECDIR="$(mktemp -d)"
export NANSEN_DAILY_CREDIT_CAP=30
pnpm --filter @onchain-intel/core build
# Phase 1 — бесплатные логические вызовы (capability-аргументный recorder):
DATA_DIR="$RECDIR" node packages/core/scripts/record-fixture.mjs nansen account
DATA_DIR="$RECDIR" node packages/core/scripts/record-fixture.mjs nansen entity.labels ethereum "wintermute"
# Phase 2 — ДВА платных логических вызова, ПО ОДНОМУ; каждый пишет ВСЕ свои под-фикстуры:
DATA_DIR="$RECDIR" node packages/core/scripts/record-fixture.mjs nansen smart-money.flows ethereum <tokenAddress>  # 10cr → netflow + holders
DATA_DIR="$RECDIR" node packages/core/scripts/record-fixture.mjs nansen token.risk ethereum <tokenAddress>         # 6cr  → indicators + token-information
DATA_DIR="$RECDIR" node packages/core/scripts/record-fixture.mjs nansen account                                    # 0cr — сверка расхода
# Проверки:
pnpm --filter @onchain-intel/core exec vitest run test/nansen.contract.test.ts
pnpm test                                                          # весь сьют
# M-2: golden-тест не переписан под живую фикстуру (SHA против baseline из 005-4):
shasum -a 256 packages/core/test/nansen.contract.test.ts          # сверить с baseline, записанным в 005-4 acceptance
grep -l "provenance: spec-derived" packages/core/test/fixtures/nansen/*.evidence.md && echo "REVIEW: provisional fixture left" || echo "all-fixtures-live-ok"
grep -c "x_nansen_credits_used" packages/core/test/fixtures/nansen/*.evidence.md
grep -rn "record-fixture" .github/workflows/ && echo "REVIEW: recorder in CI" || echo "recorder-not-in-ci-ok"
# запрет дорогих эндпоинтов среди записанных:
grep -rn "profiler/address" packages/core/test/fixtures/nansen/ && echo "REVIEW: expensive endpoint recorded" || echo "no-expensive-fixtures-ok"
```

- **[R-44]** `record-fixture.mjs` расширен на `nansen` (capability-аргументный, POST-тело
  сериализуется, вне CI); **3 платных логических вызова** = 16cr ≤30cr (машинный cap=30 на едином
  recording `DATA_DIR`); provisional-фикстуры заменены реальными; те же golden-тесты зелёные без
  правки ассертов (SHA сверен с 005-4); evidence несёт реальные поля и `X-Nansen-Credits-Used` как
  sanity-check против cost-таблицы; `pnpm test` offline — зелёный и бесплатный; фактический расход
  задокументирован.

## Notes

> Если по любой причине живой ключ недоступен — задача **останавливается и эскалируется владельцу**,
> а не обходится «примерно похожими» фикстурами: провенанс фикстур — часть acceptance R-44.
> Provisional-фикстуры 005-4 в этом случае остаются, и это **явно** фиксируется как незакрытый
> R-44 в 005-8, а не выдаётся за выполненное.
