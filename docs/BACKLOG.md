# Backlog — onchain-intel

Тонкий бэклог для work-item'ов из retro/run-feedback (см. `.agent/skills/run-feedback`).
Крупные фазы живут в [ROADMAP](onchain-analytics/ROADMAP.md); сюда попадают
инженерные улучшения и полировка, не тянущие на roadmap-строку.

Дефекты идут **не сюда**, а в [KNOWN_ISSUES.md](KNOWN_ISSUES.md) + `docs/issues/`. Разница та же,
что в `run-feedback`: **defect** — воспроизводимое неверное поведение; **work-item** — улучшение или
сигнал без сломанного контракта.

---

## Правила / Conventions

> Этот файл — **индекс**, как и `KNOWN_ISSUES.md`. Тело каждой записи лежит в
> [`docs/backlog/`](backlog/), здесь только строка-указатель. Правило появилось после того, как одна
> запись выросла до **7 849 символов** в одном буллете списка — её нельзя было ни прочитать, ни
> отдиффать, ни закрыть по частям.

**Файл записи** — `docs/backlog/wi-N-краткий-слаг.md`, YAML-frontmatter, затем H1 и тело:

```yaml
---
id: WI-11 # WI-<n>, сквозная нумерация, следующий = max+1
type: work-item # всегда этот литерал
status: open # open · done · dropped
opened_at: 2026-07-28 # ISO-дата первой записи
slug: wi-11-hot-lru-bounded-by-entry-count # = имя файла без .md
effort: S # S · M · L (опционально)
value: 'одной строкой, что это даёт' # опционально
source: TASK-007 adversarial cycle 3 # опционально: откуда пришло
# resolved_at / resolved_by — только при status: done
---
```

**Строка индекса** (новые сверху; ID по возрастанию даты заведения):

```
- **WI-N** [заголовок](backlog/slug.md) — effort `S`, opened YYYY-MM-DD
```

Закрытая запись **сохраняет файл** и переезжает в раздел «Закрытые» с `resolved_at`/`resolved_by`.
Ничего не удаляется: закрытая запись — это ответ на вопрос, который кто-то ещё задаст.

> ### ⚠️ Про `run_feedback.py file --as work-item`
>
> Скрипт дописывает **весь текст тела одним буллетом** сразу после якоря
> `<!-- feedback:discovered-issues -->`. Для work-item'а в три предложения это нормально; для отчёта
> — нет, и именно так появилась запись на 7 849 символов. **Поэтому:** после filing'а разнеси тело в
> `docs/backlog/<slug>.md` и оставь здесь строку-указатель. Якорь трогать нельзя — на него завязаны
> `file` и `doctor`.

---

## Discovered issues / work-items

<!-- feedback:discovered-issues -->

- **WI-10** [mcp-server тесты резолвят `@onchain-intel/core` в `dist`, поэтому правки в `src` невидимы до `pnpm build`](backlog/wi-10-mcp-server-tests-resolve-core-to-dist.md) — effort `S`, opened 2026-07-27
- **WI-9** [«Один коммит на задачу» не оговаривает задачи с пересекающимися файлами](backlog/wi-9-one-commit-per-task-vs-overlapping-files.md) — effort `S`, opened 2026-07-26
- **WI-8** [R-47 carry-over: `rpc-solana` теряет точность на балансе выше 2^53](backlog/wi-8-r47-carryover-rpc-solana-exact-lamports.md) — opened 2026-07-24
- **WI-7** [Устойчивость субагентов к обрыву: инкрементальная запись и resume](backlog/wi-7-subagent-stall-resilience.md) — opened 2026-07-24
- **WI-6** [Правки, применённые оркестратором, нуждаются в собственном ревью](backlog/wi-6-orchestrator-applied-fixes-need-their-own-review-pass.md) — opened 2026-07-24
- **WI-5** [Проверять зависимости тестов, прежде чем удалять «мёртвый код»](backlog/wi-5-check-test-deps-before-removing-dead-code.md) — opened 2026-07-24
- **WI-4** [Развести две причины `markUnreconciled`, чтобы cooldown не ломал UC-6](backlog/wi-4-split-markunreconciled-two-causes.md) — opened 2026-07-24
- **WI-3** [Триаж непроверенных кандидатов цикла 3 M1 (10 MINOR + 4 bikeshed)](backlog/wi-3-triage-m1-cycle3-unverified-candidates.md) — opened 2026-07-23
- **WI-2** [Пересмотреть пин typescript ^6.0.3, когда tsup научится TS7 dts](backlog/wi-2-typescript-pin-revisit-when-tsup-supports-ts7-dts.md) — opened 2026-07-22
- **WI-1** [Расширение гейта форматтера требует проверки блэст-радиуса](backlog/wi-1-formatter-gate-blast-radius-guard.md) — opened 2026-07-22

## Закрытые

- **WI-15** [Цена `MAX_DAYS` в контексте модели](backlog/wi-15-max-days-context-cost-and-includeseries-key.md) — opened 2026-07-28, **by-design 2026-07-28**: владелец оставил 1825; второй ключ кэша исправлен
- **WI-17** [Тест-долг: четыре теста зелены по неверной причине](backlog/wi-17-test-quality-debt-green-for-the-wrong-reason.md) — opened 2026-07-28, **done 2026-07-28**: T-1 переписан, T-2 переименован, T-4 усилен, D-2 закрыт записью фикстуры
- **WI-14** [Переразбор на каждое окно и zod на попаданиях в кэш](backlog/wi-14-per-window-reparse-and-zod-on-cache-hits.md) — opened 2026-07-28, **dropped 2026-07-28**: замерено — 112 мкс и 232 мкс против оценок 0.4–0.8 мс и 1–3 мс; правка не окупается
- **WI-13** [В кэш кладётся 74% документа, которые мы контрактно не читаем](backlog/wi-13-project-document-before-caching.md) — opened 2026-07-28, **done 2026-07-28**: документ проецируется на семь читаемых полей до кэширования
- **WI-12** [Вытеснение незавершённых записей ломает singleflight на широких прогонах](backlog/wi-12-in-flight-eviction-breaks-singleflight.md) — opened 2026-07-28, **done 2026-07-28**: флаг `settled`, вытесняются только завершённые записи
- **WI-11** [Горячий LRU ограничен числом записей, а записи выросли ~в 475 раз](backlog/wi-11-hot-lru-bounded-by-entry-count.md) — opened 2026-07-28, **done 2026-07-28**: второй бюджет в 16 МБ сериализованных байт + `ttlAutopurge`
- **WI-16** [Сверить эхо-поле `chain` у вендора по всем покрытым сетям](backlog/wi-16-defillama-chain-echo-probe.md) — opened 2026-07-28, **done 2026-07-28**: зонд по 274 сетям, 0 расхождений, evidence запиннена в provenance
