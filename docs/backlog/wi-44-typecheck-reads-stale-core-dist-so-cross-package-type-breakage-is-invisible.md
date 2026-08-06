---
id: WI-44
type: work-item
status: open
opened_at: 2026-08-06
slug: wi-44-typecheck-reads-stale-core-dist-so-cross-package-type-breakage-is-invisible
effort: S
value: '`pnpm typecheck` — самый быстрый гейт и первый, который читают, — даёт зелёный на межпакетной поломке типов; ловит её только `pnpm build`, пятый из шести'
source: 'vdd-03-develop Roast, задача 013-3'
provenance: machine
component: 'packages/mcp-server/tsconfig.json, packages/core/package.json'
---

# WI-44 — `pnpm typecheck` резолвит core в собранный `dist`, поэтому межпакетная поломка типов ему не видна

> Origin: роаст задачи 013-3 (T-013), 2026-08-06. Замер сделан оркестратором при проверке
> `NOT RUN (no Bash)`-команд критика. **Это не дефект контракта**: набор гейтов §0.2 в целом
> поломку ловит. Предмет записи — что ловит её **не тот** гейт, и не тот, чей зелёный читают.

**Signal.** `packages/mcp-server` резолвит `@onchain-intel/core` через workspace-симлинк на
`packages/core/package.json`, где `types: './dist/index.d.ts'`. Значит `tsc --noEmit` для
`mcp-server` сверяется с **последними собранными** декларациями, а не с исходником core. Правка
типа в `packages/core/src` невидима `typecheck`, пока `pnpm build` не перегенерирует `dist`.

Измерено на рабочем дереве 013-3 (мутация, откачена):

| Мутация в `packages/core/src/adapters/registry.ts` | `pnpm typecheck` | `pnpm build` |
| --- | --- | --- |
| `perSourceCache[].adapterId`: `string` → `number` | **EXIT 0** | EXIT 2, `TS2322` |
| `perSourceCache[].cache`: `'hit' \| 'miss'` → `+ \| 'stale'` | **EXIT 0** | EXIT 2 |

После `pnpm build` (он пересобирает `dist` первым) повторный `pnpm typecheck` даёт EXIT 2 и
называет и `src/tools/resolve-capability.ts:128`, и четыре строки тестовой фикстуры. То есть
механизм связи типов **есть и работает** — он просто отстаёт на одну сборку.

**Why it matters.** Порядок гейтов §0.2 — `lint` → `format:check` → `typecheck` → `test` → `build`
→ `smoke:dist`. `typecheck` третий, `build` пятый. Между ними `test`, который межпакетную поломку
тоже не покажет: `vitest.config.ts` алиасит core на `src` (WI-10), но vitest типы не проверяет.
Разработчик или агент, правящий типы в core, получает **два зелёных гейта подряд** на сломанном
дереве и узнаёт правду только на пятом. В быстром внутреннем цикле (`typecheck` в одиночку —
секунды, `build` — заметно дольше) это ровно тот гейт, который гоняют чаще всего.

Отдельно: «`typecheck` зелёный» — утверждение, которое в этом репозитории **не значит** «типы
сходятся». В роасте 013-3 я сам сослался на `typecheck` как на авторитет по межпакетному контракту,
и критик построил на этом же допущении вывод (MED-2: «правило двух литералов держится случайным
дублированием типа между пакетами») — допущение оказалось неверным в обе стороны.

**Не дубликат [WI-10](wi-10-mcp-server-tests-resolve-core-to-dist.md).** Та запись про **тесты**,
и её область объявлена явно: «Scope — deliberately tests only. Production resolution still goes
through `dist` (that is what `pnpm build` and `smoke:dist` exist to verify)». Это верно и остаётся
верным; `typecheck` в той области не был и её рассуждением не покрыт.

**Options.**

| # | Option | Cost | Trade-off |
| --- | --- | --- | --- |
| 1 | `paths` в `packages/mcp-server/tsconfig.json` → `@onchain-intel/core: ../core/src/index.ts` (образец уже есть — `tsconfig.e2e.json`) | S | `typecheck` начинает мерить исходник; расходится с продовым резолвом, который проверяют `build` + `smoke:dist` — то же разделение, что WI-10 принял для тестов |
| 2 | TS project references (`composite: true` в core, `references` в mcp-server) | M | Канонический ответ TS; `tsc -b` сам пересобирает зависимость — снимает отставание, а не прячет его. Трогает оба tsconfig и порядок сборки |
| 3 | Переставить §0.2: `build` перед `typecheck` | S | Дёшево и честно, но ломает смысл быстрого гейта — `typecheck` перестаёт быть быстрым |
| 4 | Ничего не делать, но записать в `developer-guidelines`, что `typecheck` не авторитетен по межпакетным типам без свежего `build` | XS | Минимально приемлемо: снимает ложную уверенность, не снимает отставание |

**Recommendation.** Вариант 1 — он симметричен уже принятому решению WI-10 (тесты читают
исходник, прод-резолв проверяют `build`/`smoke:dist`), стоит одной секции в tsconfig и не меняет
порядок гейтов. Вариант 2 лучше по существу и его стоит рассмотреть, если `dist`-отставание
всплывёт ещё раз. В любом случае — приписка из варианта 4, потому что она единственная закрывает
**ложную уверенность**, а не только сам разрыв.

**Acceptance.** Правка типа в `packages/core/src`, ломающая `packages/mcp-server/src`, роняет
`pnpm typecheck` **без** предварительного `pnpm build`. Проверяется внесением одной такой правки
(годится любая из таблицы выше) и прогоном одного `typecheck` на дереве со заведомо устаревшим
`dist`.

**Related.** [WI-10](wi-10-mcp-server-tests-resolve-core-to-dist.md) — тот же корень
(`main`/`types` указывают в `dist`), закрытая область: тесты.
[WI-43](wi-43-line-anchored-citations-in-docs-decay-silently.md) — тоже утверждение о состоянии,
которое ни один гейт не проверяет, но там предмет — координаты в документах.
