# On-Chain Analytics — материалы для ознакомления

Исследование и проектирование системы ончейн-аналитики для агентов (провайдеры Nansen / AskSurf / Dune / др. + open-source ландшафт) и ответ на вопрос «скилл в Universal-skills или отдельный проект».

**Дата:** 2026-06-30 · **Метод:** локальный анализ конвенций Universal-skills + исследовательский воркфлоу (32 агента, 20 провайдеров, 71 GitHub-репозиторий, 15 адверсариально-проверенных утверждений, 5 скорректировано).

> **Обновление 2026-07-20** (по итогам верификации coin-analytics-диалога, run `wf_f294ed8b-f82` — [вердикты](../../reference/coin-analytics-dialog-verification.md)): +3 провайдера в addendum (Dash Platform DAPI, Platform Explorer, ZecHub — privacy-метрики не покрывал никто из 20); дополнены [ADR-001](ADR-001-tech-stack.md) (capability `privacy.shielded_pool`, режим snapshotter, n8n отклонён) и [ROADMAP](ROADMAP.md) (pre-M0 снапшоттер — время-критично: истории в DAPI нет, Orchard в mainnet с 2026-07-17); добавлен [DB-SCHEMA-CONCEPT.md](DB-SCHEMA-CONCEPT.md). Решения исходного рана не пересматривались.

## TL;DR

- **Архитектура решения — гибрид:** **отдельный проект-движок** (`onchain-intel`: провайдер-адаптеры + нормализация + кеш/бюджет + signal/alert-движок + свой MCP-сервер) **+ тонкий скилл** в Universal-skills (`onchain-analytics`, 1 → 2 позже).
- **Почему не «всё в Universal-skills»:** там живут только *agent-agnostic, stateless, plug-and-play* meta-skills без платных ключей и бэкенда. Платный stateful крипто-движок — доменный продукт, ему там не место.
- **OSS:** готового end-to-end агента нет; собираем оркестратор + нормализацию + signal-движок, остальное переиспользуем (CoinGecko/Dune/Nansen MCP, Hummingbot+MCP, паттерны swap-decode).

## Файлы

| Файл | Что внутри |
|---|---|
| [REPORT.md](REPORT.md) | **Главный отчёт**: вердикт skill-vs-project, матрица провайдеров, OSS-ландшафт, целевая архитектура, план на 6 фаз, риски. **Начать отсюда.** |
| [ADR-001-tech-stack.md](ADR-001-tech-stack.md) | **ADR по стеку**: 12 связанных решений (TS/Node, MCP SDK, SQLite-кеш+budget, адаптеры, планировщик, секреты, тесты, деплой, лицензия) с вариантами, последствиями и триггерами пересмотра. Содержит Open questions под ваш sign-off. |
| [ROADMAP.md](ROADMAP.md) | **Дорожная карта** M0–M6: цели, задачи, exit-критерии, зависимости, лестница затрат, граф зависимостей (mermaid), сквозные риски. |
| [research-digest.md](research-digest.md) | Полный синтез-дайджест от агентов: матрица 14 провайдеров + таблица 71 репозитория + 10 инсайтов архитектуры + раздел рисков. |
| [provider-matrix.md](provider-matrix.md) | Плоский скан 20 провайдер-записей основного рана + addendum-секция 2026-07-20 (+3 privacy/Dash Platform). |
| [verification-corrections.md](verification-corrections.md) | 5 «несущих» утверждений, скорректированных адверсариальной проверкой, с источниками (Dune Sim sunset, 26≠29 tools, цены Surf, DexScreener paid-API, DeFiLlama API). |
| [DB-SCHEMA-CONCEPT.md](DB-SCHEMA-CONCEPT.md) | *(2026-07-20)* **Концепт-схема данных** (snapshots/assets/metrics → events/aggregates) + миграция SQLite→Postgres по этапам + переезд сервер→сервер (Litestream, zero-gap двойная запись, runbook). |
| [raw/providers.json](raw/providers.json) | Сырые структурированные данные по 20 провайдерам (API, MCP, цены, покрытие, сильные стороны, источники). |
| [raw/providers-addendum-2026-07-20.json](raw/providers-addendum-2026-07-20.json) | *(2026-07-20)* Addendum: +3 провайдера privacy/Dash Platform (DAPI, platform-explorer, ZecHub) — сырые данные, отдельно от исходного рана. |
| [raw/oss-repos.json](raw/oss-repos.json) | Сырые данные по 71 репозиторию (звёзды, активность, лицензия, рекомендация adopt/steal/reference/reject). |
| [raw/verification-corrections.json](raw/verification-corrections.json) | Машиночитаемые вердикты верификации. |

## Дисклеймер по достоверности

Данные собраны веб-исследованием на 2026-06-30 и частично проверены адверсариально. Маркетинговые счётчики (кол-во tools/сетей/эндпоинтов) у вендоров дрейфуют и противоречивы — **перед интеграцией пробуйте live tool-list, не хардкодьте числа**. Записи с пометкой *unverified* в дайджесте требуют отдельной проверки.

## Следующий шаг (обновлено 2026-07-20)

1. **Мини-снапшоттер Dash Platform** (pre-M0, вне гейта sign-off — время-критично): схема [DB-SCHEMA-CONCEPT.md](DB-SCHEMA-CONCEPT.md) §2, источники [raw/providers-addendum-2026-07-20.json](raw/providers-addendum-2026-07-20.json), обоснование [ROADMAP](ROADMAP.md) §M0. Milestone: до конца июля 2026 (истории в DAPI нет, а единственный сторонний источник истории — community-сервис без SLA, [верификация #4–#5](../../reference/coin-analytics-dialog-verification.md)). Владелец: Sergey.
2. Закрыть Open questions в [ADR-001](ADR-001-tech-stack.md) (TS vs Python — вход 2026-07-20 в пользу TS уже вписан; хостинг) — разблокирует M0. Milestone: перед стартом M0. Владелец: Sergey (sign-off).
3. Оформить `docs/ARCHITECTURE.md` + `docs/TASK.md` для нового проекта `onchain-intel` ([ROADMAP](ROADMAP.md) §M0). Milestone: старт M0 (сразу после sign-off п.2). Владелец: Sergey + agentic-пайплайн.
4. Инициализировать скелет скилла `onchain-analytics` через `skill-creator` в Universal-skills ([ROADMAP](ROADMAP.md) §M4). Milestone: M4. Владелец: Sergey.
