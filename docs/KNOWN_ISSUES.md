# Known Issues & Tech Debt

**Purpose:** Track recurring bugs, architectural limitations, and sensitive areas to avoid
repeating mistakes.

This file is a **thin index**. Each issue lives in its own file under [`docs/issues/`](issues/);
the lines below are one-per-issue pointers grouped by category. Read the linked file for the full
symptom, workaround, and cross-links.

---

## Rules / Conventions

> The index below is **hand-maintained** — there is no generator. When you add, resolve, or
> re-categorize an issue you MUST edit **both** the per-issue file *and* the matching line here.
> These rules keep that hand-editing consistent.

<!-- contract:defects -->

**Per-issue file** — `docs/issues/<slug>.md`, YAML frontmatter then an H1 title and body:

```yaml
---
id: L-1                  # <PREFIX>-<n>, unique (see prefix→category table)
type: known-issue        # always this literal
status: open             # see status vocab below
opened_at: 2026-01-01    # ISO date first recorded (git-truthful)
category: logic          # see prefix→category table
severity: SEV-2          # OPTIONAL — omit when not meaningfully rankable
slug: l-1-short-kebab-title   # filename stem: a slugified, human-readable id+title (normalize symbols, e.g. ≠ → "not")
# component: transcript-fetcher   # OPTIONAL automation keys, appended AFTER slug —
# fingerprint: 614ee37f7fb28554   # see "Automation extension keys" below
# evidence_paths:
#   - path/to/artifact
# auto_fixable: true
# finding_ref: fnd-20260713-081500-614ee37f
# resolved_at: 2026-02-01   # add ONLY when status: fixed
# resolved_by: TASK 042     # add ONLY when status: fixed
---
```

**ID prefix → category.** Define prefixes as the project needs them; **add a row here** whenever you
introduce a new prefix. A common starter set (extend/replace freely):

| Prefix  | Category      | Scope |
|---------|---------------|-------|
| `L-N`   | `logic`       | Logic / correctness defects and edge cases. |
| `P-N`   | `performance` | Performance, algorithmic, or resource issues. |
| `SEC-N` | `security`    | Security / auth / injection / secrets. |
| `Q-N`   | `quality`     | Quality, UX, or robustness nits. |
| `DF-N`  | `dogfood`     | Found while dogfooding the product itself. |
| `RF-N`  | `workflow-docs` | Run-feedback filings: defects in workflow/task docs and pipeline tooling. |

**Status vocabulary:** `open` · `fixed` · `documented` (accepted; guidance written) ·
`by-design` (intended trade-off, not a defect) · `mitigated` · `wontfix`.

A `fixed` issue **keeps its file** and adds `resolved_at` / `resolved_by` + a resolution
blockquote; it is never deleted.

**Severity vocabulary (optional):** `SEV-2` (blocks a workflow / real impact) ·
`SEV-3` (degraded / annoying) · `SEV-4` (minor) · `LOW`. Omit for pure documented constraints.

**Index line format** (severity clause omitted when the file has no `severity`):

```
- **<ID>** [<title>](issues/<slug>.md) — severity `<SEV>`, status `<status>`, opened <YYYY-MM-DD>
```

**Automation extension keys (optional).** Automated tools append machine-oriented keys AFTER
`slug` — `component`, `fingerprint`, `evidence_paths`, `auto_fixable`, `finding_ref` (written by
the `run-feedback` skill's filing step; consumed by the `/heal-issues` harness, which selects
ONLY issues carrying an explicit `auto_fixable: true`). Automation STATE (attempt counters,
journals) lives outside the ledger under `.agent/feedback/`. Per-project ledgers may carry local
read-side extensions (e.g. `status: handled`, `severity: MED`); readers MUST tolerate them, while
new writes stick to the vocabularies above. Automated `resolved_by` values use the token
`heal-issues (verified-gone <ts>)` / `heal-issues run <ts>`.

**Adding a new issue:** ① pick the next `<PREFIX>-<n>`; ② create `docs/issues/<slug>.md` with the
frontmatter above (body preserved verbatim — never drop a clause); ③ add one line under the matching
`## <category>` heading below, in ID order. Add the category heading if it is the first of its kind.

---

## dogfood

- **DF-1** [Nansen `POST /api/v1/smart-money/netflow` silently returned zero rows for a real, well-known token — two request-construction defects, both fixed](issues/df-1-nansen-smart-money-netflow-empty-for-base-pair-tokens.md) — severity `SEV-3`, status `fixed`, opened 2026-07-24

## tooling

- **RF-6** [validate.py читает только первую таблицу RTM под якорем, поэтому многоэпиковый TASK гейтится частично и рапортует успех](issues/rf-6-validate-py-reads-only-the-first-rtm-table-under-the-anchor.md) — severity `SEV-2`, status `fixed`, opened 2026-08-05, **fixed 2026-08-06**: `resolved_by: framework edit (agentic-development, рабочее дерево, не закоммичено)` — **предложенный в записи fix path взят НЕ был**: «разбирать все таблицы блока» изобретает требования из подсекции `### N.N Details by ID` (так устроены `task-096`, `task-085`, `task-101`), а «отказывать при N таблицах» роняет те же три сданные задачи — оба варианта дают гейт, не проходящий на своём корпусе. Взято правило по ряду заголовков: первая таблица задаёт форму, следующие с тем же заголовком — та же RTM, чужие пропускаются и **называются** в выводе. **Область дефекта оказалась шире замера записи**: не одна T-013, а **24 артефакта из 1127 в 5 проектах**, все — вверх (локально `task-012` 3 → 26, `task-011` 7 → 23). Штатный `compat_diff.py` этого не видит — он сравнивает вердикты (`0 of 1127 changed verdict`), поэтому рядом дописан свод по счёту. Гейты: набор скилла 47 → 57, мутация роняет 6 кейсов, `run_tests.py` 319 OK, `pytest` 572 passed. Смежное и НЕ исправленное: `Found N` считает строки, а не идентификаторы (пустой ID в строках-продолжениях) — поведение дособственное, покрытия не затрагивает


## workflow-docs

- **RF-1** [task-001-3 acceptance snippets not runnable (pnpm 11 '--' forwarding; macOS lacks timeout)](issues/rf-1-task-001-3-acceptance-snippets-not-runnable-pnpm-11-forwarding-macos-lacks-timeout.md) — severity `SEV-4`, status `fixed`, opened 2026-07-22
- **RF-2** [M2's own evidence records describe an earlier tree than the one that shipped](issues/rf-2-m2-evidence-records-drifted-from-the-shipped-commit.md) — severity `SEV-3`, status `fixed`, opened 2026-07-25
- **RF-3** [pnpm lint and format:check were left red on main by two merged commits, blocking the next task's regression exit](issues/rf-3-pnpm-lint-and-format-check-were-left-red-on-main-by-two-merged-commits-blocking-the-next-task-s-regression-exit.md) — severity `SEV-3`, status `fixed`, opened 2026-07-27
- **RF-4** [the smoke:dist CI gate still asserts 8 tools, so it has been red on main since TASK-006](issues/rf-4-smoke-dist-ci-gate-still-asserts-8-tools-so-it-has-been-red-on-main-since-task-006.md) — severity `SEV-2`, status `fixed`, opened 2026-07-28
- **RF-5** [the live eval derives chains from the registry but capabilities from a hand-written list, so dex.volume.history ships untested](issues/rf-5-live-eval-capability-axis-is-hand-written-so-dex-volume-history-ships-untested.md) — severity `SEV-3`, status `fixed`, opened 2026-07-28
- **RF-7** [мутационный протокол и read-only роаст идут по одному дереву одновременно, и ревьюер меряет состояние, которого не было](issues/rf-7-mutation-protocol-and-read-only-roast-run-concurrently-so-the-reviewer-measures-a-tree-that-never-shipped.md) — severity `SEV-3`, status `open`, opened 2026-08-06: `code-reviewer` 013-3 поймал прогон `1 failed | 336 passed` и `35 ++++` вместо `38 +` — это была мутация оркестратора, а не флейк; §2.4 обязывает спавнера настреливать `NOT RUN (no Bash)`-команды критика и тем порождает конфликт, не говоря о сериализации

## logic

- **L-1** [a paid Nansen call whose result `normalize()` rejects is never cached, so every retry pays again](issues/l-1-nansen-no-negative-caching-paid-call-discarded-on-empty-result.md) — severity `SEV-2`, status `fixed`, opened 2026-07-25
- **L-2** [the snapshotter drops a metric silently: `dropped[]` is computed and then discarded](issues/l-2-snapshotter-drops-a-metric-silently-dropped-array-never-leaves-the-node.md) — severity `SEV-3`, status `fixed`, opened 2026-07-27
- **L-3** [`onchain-verify`'s staleness detector is permanently red by construction, and names no metric](issues/l-3-verify-staleness-detector-is-permanently-red-and-names-no-metric.md) — severity `SEV-2`, status `fixed`, opened 2026-07-27
- **L-4** [Telegram entity parsing 400s on snake_case metric names, so the alert is never delivered](issues/l-4-telegram-entity-parsing-400s-on-snake-case-metric-names-no-alert-delivered.md) — severity `SEV-2`, status `fixed`, opened 2026-07-27
- **L-5** [onchain_dex_volume reports gapDays: 0 for a window with no data at all — the empty-chart case breaks its own invariant](issues/l-5-dex-volume-empty-chart-reports-zero-gapdays-breaking-its-own-invariant.md) — severity `SEV-3`, status `fixed`, opened 2026-07-28
- **L-6** [token.holders is advertised on ~30 chains and fails on all of them (blockscout HTTP 403); the live eval was already red](issues/l-6-token-holders-advertised-everywhere-blockscout-403-everywhere.md) — severity `SEV-2`, status `open`, opened 2026-08-10
- **L-7** [The 10 MiB safeFetch cap refuses exactly the largest multichain protocols, by as little as 2 KB](issues/l-7-safefetch-10mib-cap-refuses-the-largest-protocols.md) — severity `SEV-2`, status `fixed`, opened 2026-08-10, **fixed 2026-08-11**: `protocol.tvl` читает общий каталог `GET /protocols` (8.14 МиБ на все 8 009 протоколов, раз в окно TTL) вместо документа на каждый вызов — в живом гейте первый вызов 479 мс, следующие десять сетей по 16–24 мс. **Таблица в записи меряла не ту величину:** её 2–16 КБ превышения сняты с `Content-Length` HEAD, то есть со СЖАТОГО размера, а лимит применяется к РАСПАКОВАННЫМ байтам — живой замер через наш же `safeFetch` дал 28 914 177 байт (27.57 МиБ) для `/protocol/aave-v3`, превышение ~18 МиБ, растущее с каждым днём истории; вариант «поднять константу» закрыт замером, а обходной путь `aave` вместо `aave-v3` был на 98 % лимита. Правило разрешения слага снято с вендора, а не выведено: прямая строка выигрывает у одноимённого родителя (`/protocol/beanstalk` → `0` своей строки, не 3.2 M суммы), родитель адресуется `parentProtocolSlug` (`/protocol/ether.fi` → 200, `/protocol/ether-fi` → 400). **Названный остаток:** 38 родителей из 802 объявляют `tokensExcludedFromParent` (сумма детей завышает на +9.5 % на `ether.fi`) и отвечаются агрегатом самого вендора; девять из десяти крупнейших таких документов < 1.7 МиБ, а `curve-finance` (27.77 МиБ) по-прежнему отказывается по лимиту — теперь это узкий случай с внятным сообщением, а не поведение по умолчанию
- **L-8** [Nansen ownershipPercentage 0 reaches the client as a real share for a 185.8M USDC holder](issues/l-8-ownership-percentage-zero-passes-through-as-a-real-share.md) — severity `SEV-3`, status `fixed`, opened 2026-08-10, **fixed 2026-08-11**: поле опускается на ПРОТИВОРЕЧИИ (нулевая доля при положительном балансе), а не на нуле — пылевой держатель законно округляется в ноль; остальная строка сохраняется, потому что отказ правилен для целого ответа (DF-1, L-1), но не для одного поля. **Дефект оказался старше и шире записи:** правка покраснила золотой `TC-CONTRACT-01`, и замер живой фикстуры 2026-07-24 по Ethereum USDC дал **10 строк из 10** с нулевой долей при положительных балансах, крупнейший 4 534 414 876 USDC ($4.53B) — значит неверное значение ехало с M2, а не появилось на Base. Сьют молчал по построению: эталон **копировал `row.ownership_percentage` из той же фикстуры**, то есть утверждал «мы воспроизводим вендора» — ровно то, чего анти-коррупционный слой обещать не должен. Эталон переписан на правило, добавлен контроль в обе стороны, счётчик опущенных пишется в stderr (L-2)
- **L-9** [A protocol that is not deployed on a chain is indistinguishable from a provider outage](issues/l-9-not-deployed-on-chain-indistinguishable-from-provider-outage.md) — severity `SEV-3`, status `fixed`, opened 2026-08-10, **fixed 2026-08-11**: «протокола здесь нет» стало успешным ответом `deployed: false` / `tvlUsd: 0` (живая проверка: `aave @ bitcoin` вместо `capability unavailable`). **Состояний оказалось три, а не два:** 41 строка каталога из 6 917 объявляет сеть, для которой публикуются только корзины `-staking`/`-borrowed`/`-pool2` — там `tvlUsd: null` при `deployed: true`, потому что ноль заявил бы измерение, которого никто не делал (L-2). Второй слой закрыт вместе с первым: ответ несёт `deployments` (весь набор сетей нашими слагами, по убыванию TVL) и `unmappedDeployments` — 19 названных сетей и 4 неопознанных вместо 6.8 % TVL на неразрешимом остатке. Список сетей берётся из общего каталога, а не из документа протокола: собственный документ родителя отвечает `chains: []` (измерено на `uniswap`/`aave`/`raydium`)

## security

- **SEC-1** [the daily credit cap bounds damage per day, not per minute: there is no velocity guard](issues/sec-1-nansen-daily-cap-does-not-bound-a-burst-no-velocity-guard.md) — severity `SEV-2`, status `fixed`, opened 2026-07-25

## quality

- **Q-1** [under a persistent reconcile degrade, the nansen stderr line repeats per call](issues/q-1-nansen-degrade-stderr-repeats-per-call.md) — severity `SEV-4`, status `by-design`, opened 2026-07-24
- **Q-2** [`NANSEN_DAILY_CREDIT_CAP` is optional with no default, so a stock install has no self-imposed ceiling](issues/q-2-nansen-daily-credit-cap-has-no-default.md) — severity `SEV-3`, status `fixed`, opened 2026-07-24
- **Q-3** [the 0-credit `entity.labels` query tier is structurally unrefusable by a credit-denominated gate](issues/q-3-nansen-zero-credit-entity-labels-tier-is-unrefusable-by-the-gate.md) — severity `SEV-3`, status `fixed`, opened 2026-07-25
- **Q-4** [`token.risk` pays 1cr per call for `/tgm/token-information`, whose body is never read](issues/q-4-nansen-token-information-subcall-paid-but-never-consumed.md) — severity `SEV-3`, status `fixed`, opened 2026-07-25
- **Q-5** [a literal NUL byte in registry-core.ts makes every repo-wide grep gate skip the SSRF-allowlist module silently](issues/q-5-a-literal-nul-byte-in-registry-core-ts-makes-every-repo-wide-grep-gate-skip-the-ssrf-allowlist-module-silently.md) — severity `SEV-2`, status `fixed`, opened 2026-07-27
- **Q-6** [The self-imposed budget refusal names the ceiling where its own vendor branch names the remainder](issues/q-6-self-imposed-budget-refusal-names-the-ceiling-not-the-remainder.md) — severity `SEV-3`, status `fixed`, opened 2026-08-10, **fixed 2026-08-11**: самоналоженная ветка печатает `need <cost>, remaining <n> of <ceiling>` — обе половины одного отказа отвечают на один вопрос и стали сравнимы. Взят `effectiveCeiling`, а не `capNow`: в этой ветке они равны по построению, но `capNow` типизирован `number | undefined`, и заменённая строка интерполировала его сырым — то есть исходный код отрендерил бы `allows undefined`, что вскрыл typecheck, когда потребовалась арифметика. `getUsage()` best-effort и не может заменить собой отказ (SQLITE_BUSY превратил бы бюджетный отказ в ошибку хранилища); запасной текст строго не хуже прежнего. Оба теста теперь ТРЕБУЮТ остатка, а `of <ceiling>` держит потолок на виду — падают и на откате к «только потолок», и на потере потолка
- **Q-7** [totals.h24 is the previous whole day, not the last series point, and the last point is partial](issues/q-7-dex-volume-h24-is-the-previous-whole-day-not-the-last-series-point.md) — severity `SEV-4`, status `open`, opened 2026-08-10
- **Q-8** [onchain_new_pairs returns long-established pools, and its name is what a client selects on](issues/q-8-new-pairs-returns-established-pools.md) — severity `SEV-3`, status `open`, opened 2026-08-10
- **Q-9** [On a merged response the top-level source names one provider while its own points name another](issues/q-9-dash-history-top-level-source-contradicts-its-own-points.md) — severity `SEV-4`, status `open`, opened 2026-08-10
- **Q-10** [onchain_new_pairs silently drops vendor rows that fail validation; the count goes only to stderr](issues/q-10-new-pairs-silently-drops-vendor-rows-that-fail-validation.md) — severity `SEV-3`, status `open`, opened 2026-08-10
