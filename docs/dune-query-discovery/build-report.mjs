#!/usr/bin/env node
/**
 * build-report.mjs — детерминированная сборка report.md из ИСТОЧНИКА ИСТИНЫ (table.json) и прозы (_prose/*.md).
 *
 * Правило дома (CLAUDE.md §2): мастер-таблицу и приложение собирает КОД из JSON-массива строк;
 * агент пишет ТОЛЬКО прозу. Числа в MD обязаны быть байт-в-байт равны JSON — здесь это гарантировано
 * тем, что они из JSON и берутся.
 *
 * Запуск:  node docs/dune-query-discovery/build-report.mjs
 * Вход:    docs/dune-query-discovery/table.json      { meta, rows[] }
 *          docs/dune-query-discovery/_prose/*.md     проза синтез-агентов
 *          docs/dune-query-discovery/raw/*.json      критик, добивки, инвентарь MCP, аудит репо
 * Выход:   docs/dune-query-discovery/report.md
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const J = (p) => JSON.parse(readFileSync(join(DIR, p), 'utf8'))
// Проза синтез-агентов приходит со своей нумерацией заголовков (`# 1. BLUF`), которая столкнулась бы
// с нумерацией секций отчёта. Понижаем уровень на `shift` ступеней при вставке.
const P = (p, shift = 2) => {
  if (!existsSync(join(DIR, p))) return ''
  const raw = readFileSync(join(DIR, p), 'utf8').trim()
  if (!shift) return raw
  return raw.replace(/^(#{1,4}) /gm, (m, h) => '#'.repeat(Math.min(6, h.length + shift)) + ' ')
}

const { meta, rows } = J('table.json')
const critic = existsSync(join(DIR, 'raw/critic.json')) ? J('raw/critic.json') : {}
const followups = existsSync(join(DIR, 'raw/followups.json')) ? J('raw/followups.json') : []
const mcpInv = existsSync(join(DIR, 'raw/mcp-inventory.json')) ? J('raw/mcp-inventory.json') : {}

// ── утилиты ячеек ────────────────────────────────────────────────────────────
const cell = (v) => {
  if (v === null || v === undefined || v === '') return '—'
  const s = Array.isArray(v) ? v.join('; ') : String(v)
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim() || '—'
}
const CLIP = 150
const clipped = []
const cellClip = (v, id, field) => {
  const s = cell(v)
  if (s.length <= CLIP) return s
  clipped.push(`${id} · ${field}: ${s.length} → ${CLIP} символов`)
  return s.slice(0, CLIP - 1) + '…'
}

// Adversarial-агенты возвращают развёрнутые эссе (kill-shot на 4-6 тыс. символов). В отчёт идёт
// выдержка; полный текст — в table.json (источник истины) и в verification-corrections.md.
const ESSAY = 700
function essay(v, id, field, cap = ESSAY) {
  const s = cell(v)
  if (s.length <= cap) return s
  clipped.push(`${id} · ${field}: ${s.length} → ${cap} символов (полностью — table.json)`)
  return s.slice(0, cap - 1) + '… _[полный текст — `table.json`]_'
}

// ── глифы легенды ────────────────────────────────────────────────────────────
function glyphs(r) {
  const g = []
  if (r.verdict === 'reject') g.push('💀')
  if (r.refuted) g.push('⚠')
  if (r.dead_row) g.push('†')
  if ((r.unverified || []).length) g.push('*')
  if (r.status === 'UNVERIFIED') g.push('‼')
  if (r.plan_gate === 'free' && r.sub_access === 3) g.push('✓')
  return g.join('')
}
// Скептики возвращали `corrected_plan_gate` целыми абзацами. В таблицу идёт нормализованный enum,
// полный текст — в Приложение A (§2 источник истины не меняется: обрезается только ПРОЕКЦИЯ).
const PLAN_ENUM = ['free-tier-limited', 'free-tier-partial', 'paid-only', 'free', 'unknown', 'keyless', 'none']
function planCell(r) {
  const raw = String(r.plan_gate || '').trim()
  if (!raw) return 'unknown'
  const lower = raw.toLowerCase()
  const hit = PLAN_ENUM.find((e) => lower.startsWith(e))
  const norm = hit || lower.split(/[\s(,—.:;]/)[0] || 'unknown'
  const truncated = raw.length > norm.length + 2
  return `\`${norm}\`${truncated ? '<sup>+</sup>' : ''}`
}
const fitCell = (r) => {
  const b = r.fit_breakdown || {}
  return `**${r.fit ?? '—'}**/12 (${b.access ?? '?'}/${b.free_fit ?? '?'}/${b.coverage ?? '?'}/${b.verifiability ?? '?'}/${b.integration ?? '?'})`
}

const sorted = rows.slice().sort((a, b) => (b.fit || 0) - (a.fit || 0) || String(a.name).localeCompare(String(b.name)))

// ── мастер-таблица ───────────────────────────────────────────────────────────
function masterTable() {
  const head = '| # | Способ доступа | Вендор | Семейство | Как вызывается агентом | План | Цена / free-квота | Lifecycle | fit (a/f/c/v/i) | Вердикт | Статус |\n|--:|---|---|---|---|---|---|---|---|---|---|'
  const body = sorted.map((r, i) => {
    const id = `#${i + 1}`
    return `| ${i + 1} | ${glyphs(r)} ${cellClip(r.name, id, 'name')} | ${cell(r.vendor)} | \`${cell(r.family)}\` | ${cellClip(r.how_agent_calls_it, id, 'how_agent_calls_it')} | ${planCell(r)} | ${cellClip((cell(r.cost_model) === '—' ? '' : cell(r.cost_model) + ' · ') + (cell(r.free_quota)), id, 'cost/quota')} | ${cellClip(r.lifecycle, id, 'lifecycle')} | ${fitCell(r)} | **${cell(r.verdict)}** | ${cell(r.status)} / ${cell(r.confidence)} |`
  }).join('\n')
  return head + '\n' + body
}

// ── таблица «мёртвое / гаснущее» ─────────────────────────────────────────────
// ВНИМАНИЕ (залогировано в KNOWN LOSSES): скептики вернули `lifecycle` ПРОЗОЙ, а не enum'ом схемы,
// поэтому классификация здесь — эвристика по тексту. Наивная проверка на слова sunset|archived|
// deprecated давала 29 «мёртвых» строк из 35, потому что ловила фразы вида «sunset НЕТ» и
// «archived=false». Ниже — ключевое слово ПЛЮС отсутствие маркера отрицания в том же тексте.
const DEAD_RE = /\b(sunset|deprecat\w*|archived|discontinued|shut ?down|end.of.life|EOL)\b/i
const ALIVE_RE = /(не объявлен|нет\b|НЕТ\b|не архив|archived\s*=\s*false|not archived|no sunset|жив\b|ЖИВ\b|active|активен|развивается)/i
function isDead(r) {
  if (r.dead_row) return true
  const lc = String(r.lifecycle || '')
  const head = lc.slice(0, 240)
  return DEAD_RE.test(head) && !ALIVE_RE.test(head)
}
function deadTable() {
  const dead = sorted.filter(isDead)
  if (!dead.length) return '_Подтверждённых sunset/archived среди профилированных строк нет._'
  return '| Способ доступа | Вендор | Статус жизненного цикла | Источник | Понижение вердикта | Чем заменяем |\n|---|---|---|---|---|---|\n' +
    dead.map((r) => `| ${cell(r.name)} | ${cell(r.vendor)} | **${essay(r.lifecycle, r.name, 'dead.lifecycle', 300)}** | ${cell(r.lifecycle_source)} | ${cell((r.code_overrides || []).filter((o) => /lifecycle/.test(o)).join('; '))} | ${essay(r.verdict_reason, r.name, 'dead.verdict_reason', 400)} |`).join('\n')
}

// ── reject-лог ───────────────────────────────────────────────────────────────
function rejectTable() {
  const rej = sorted.filter((r) => r.verdict === 'reject')
  const share = rows.length ? Math.round((rej.length / rows.length) * 100) : 0
  if (!rej.length) return `_Строк с вердиктом \`reject\` нет (0 из ${rows.length})._`
  return `Доля reject: **${rej.length} из ${rows.length}** (${share}%).\n\n` +
    '| Способ доступа | Машиночитаемая причина | Доказательство | kill-shot |\n|---|---|---|---|\n' +
    rej.map((r) => `| ${cell(r.name)} | ${essay(r.verdict_reason, r.name, 'reject.reason', 400)} | ${essay(r.evidence_disqualifier, r.name, 'reject.disq', 400)} | ${essay(r.kill_shot, r.name, 'reject.kill_shot', 300)} |`).join('\n')
}

// ── приложение: полные строки без обрезки ────────────────────────────────────
function appendix() {
  return sorted.map((r, i) => {
    const b = r.fit_breakdown || {}
    const id = `A${i + 1}`
    const lines = [
      `### A${i + 1}. ${r.name} ${glyphs(r)}`,
      '',
      `- **Вендор / семейство:** ${cell(r.vendor)} · \`${cell(r.family)}\``,
      `- **Что это:** ${essay(r.what_it_is, id, 'what_it_is', 900)}`,
      `- **Как вызывается:** ${essay(r.how_agent_calls_it, id, 'how_agent_calls_it', 900)}`,
      `- **Первоисточник:** ${cell(r.primary_url)}`,
      `- **Авторизация / план:** ${cell(r.auth)} · ${essay(r.plan_gate, id, 'plan_gate', 700)}`,
      `- **Модель цены:** ${essay(r.cost_model, id, 'cost_model', 700)}`,
      `- **Free-квота:** ${essay(r.free_quota, id, 'free_quota', 400)} · **Rate limit:** ${essay(r.rate_limit, id, 'rate_limit', 400)}`,
      `- **Классы вопросов:** ${essay(r.answers_class, id, 'answers_class', 500)}`,
      `- **Сети:** ${essay(r.chains, id, 'chains', 400)}`,
      `- **Как проверяется корректность:** ${essay(r.verifiability, id, 'verifiability', 900)}`,
      `- **Доказательство (позитивное):** ${essay(r.evidence_positive, id, 'evidence_positive', 900)}`,
      `- **Доказательство (дисквалификатор):** ${essay(r.evidence_disqualifier, id, 'evidence_disqualifier', 900)}`,
      `- **Lifecycle:** ${essay(r.lifecycle, id, 'lifecycle', 300)} · источник: ${cell(r.lifecycle_source)}`,
      `- **fit = ${r.fit}/12** — access ${b.access}/3 + free_fit ${b.free_fit}/3 + coverage ${b.coverage}/2 + verifiability ${b.verifiability}/2 + integration ${b.integration}/2`,
      `- **Вердикт:** **${cell(r.verdict)}** — ${essay(r.verdict_reason, id, 'verdict_reason', 700)}`,
      `- **Куда встраиваем:** ${essay(r.integration_target, id, 'integration_target', 700)}`,
      `- **Риски:** ${essay(r.risks, id, 'risks', 700)}`,
      `- **Adversarial:** попытка опровержения ${r.refutation_attempted ? 'да' : 'НЕТ'} · refuted=${r.refuted} · статус ${cell(r.status)}`,
      `- **kill-shot:** ${essay(r.kill_shot, id, 'kill_shot')}`,
      (r.subclaims || []).length ? `- **Под-утверждения (${(r.subclaims || []).length}):**\n${(r.subclaims || []).slice(0, 8).map((s) => `  - ${essay(s, id, 'subclaim', 400)}`).join('\n')}${(r.subclaims || []).length > 8 ? `\n  - _…ещё ${(r.subclaims || []).length - 8} — в table.json_` : ''}` : '',
      r.verify_corrections ? `- **Правки верификации:** ${essay(r.verify_corrections, id, 'verify_corrections')}` : '',
      (r.code_overrides || []).length ? `- **Оверрайды кода:** ${essay((r.code_overrides || []).join(' · '), id, 'code_overrides', 400)}` : '',
      `- **unverified[]:** ${essay((r.unverified || []).join('; '), id, 'unverified', 500)}`,
      `- **Confidence:** ${cell(r.confidence)}${r.confidence_reason ? ` — ${essay(r.confidence_reason, id, 'confidence_reason', 400)}` : ''}`,
      `- **Найдено:** раунд ${cell(r.found_round)}, ось «${cell(r.found_axis)}»`,
    ].filter(Boolean)
    const block = lines.join('\n')
    const ROW_CAP = 6500
    if (block.length <= ROW_CAP) return block
    clipped.push(`${id} · блок приложения целиком: ${block.length} → ${ROW_CAP} символов (полностью — table.json)`)
    return block.slice(0, ROW_CAP) + `\n\n> _Блок обрезан на ${ROW_CAP} символах. Полная строка без обрезки — в [table.json](table.json)._`
  }).join('\n\n')
}

// ── инвентарь официального Dune MCP ──────────────────────────────────────────
function mcpTable() {
  const inv = mcpInv.inventory || mcpInv
  const tools = (inv && inv.tools) || []
  if (!tools.length) return '_Поимённый инвентарь тулов не подтверждён первоисточником — см. `raw/mcp-inventory.json`._'
  return '| Тул | Категория | Вход | Возвращает | План | Кредиты | Зачем агенту |\n|---|---|---|---|---|---|---|\n' +
    tools.map((t) => `| \`${cell(t.name)}\` | ${cell(t.category)} | ${cell(t.input)} | ${cell(t.returns)} | \`${cell(t.plan_gate)}\` | ${cell(t.credit_cost)} | ${cell(t.agent_use)} |`).join('\n')
}

// ── источники, сгруппированные по кандидату ──────────────────────────────────
function sources() {
  const byVendor = new Map()
  sorted.forEach((r) => {
    const k = r.vendor || '—'
    if (!byVendor.has(k)) byVendor.set(k, new Set())
    ;[r.primary_url, r.lifecycle_source].forEach((u) => { if (u && /^https?:/.test(String(u))) byVendor.get(k).add(String(u).trim()) })
    ;[r.evidence_positive, r.evidence_disqualifier].forEach((t) => {
      String(t || '').split(/\s+/).forEach((w) => { if (/^https?:\/\/[^\s)]+$/.test(w)) byVendor.get(k).add(w.replace(/[.,;]$/, '')) })
    })
  })
  const fu = new Set()
  followups.forEach((f) => String(f.evidence || '').split(/\s+/).forEach((w) => { if (/^https?:\/\//.test(w)) fu.add(w.replace(/[.,;]$/, '')) }))
  const invSrc = ((mcpInv.inventory || {}).sources) || []
  let out = Array.from(byVendor.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([v, set]) => `**${v}**\n${Array.from(set).sort().map((u) => `- ${u}`).join('\n') || '- (первичных URL в строках нет)'}`).join('\n\n')
  if (invSrc.length) out += `\n\n**Официальный Dune MCP (инвентарь)**\n${invSrc.map((u) => `- ${u}`).join('\n')}`
  if (fu.size) out += `\n\n**Добивки (follow-up)**\n${Array.from(fu).sort().map((u) => `- ${u}`).join('\n')}`
  return out
}

// ── known losses ─────────────────────────────────────────────────────────────
function losses() {
  const parts = []
  const below = meta.below_line || []
  parts.push(`**1. Не профилировано (ниже линии top-${meta.args.maxCandidates}):** ${below.length ? below.map((c) => `${c.vendor}: ${c.name}`).join(' · ') : '(нет — профилированы все прошедшие гейт)'}`)
  parts.push(`**2. Отброшено доменным гейтом (омонимы):** ${(meta.dropped_by_domain_gate || []).length ? meta.dropped_by_domain_gate.join(' · ') : '(нет)'}`)
  const unv = sorted.filter((r) => r.status === 'UNVERIFIED')
  parts.push(`**3. Строки UNVERIFIED (пустой kill-shot ⇒ в рекомендации не идут):** ${unv.length ? unv.map((r) => r.name).join(' · ') : '(нет — все строки прошли попытку опровержения)'}`)
  const ref = sorted.filter((r) => r.refuted)
  parts.push(`**4. Опровергнутые скептиком (⚠):** ${ref.length ? ref.map((r) => `**${r.name}** — ${essay(r.kill_shot, r.name, 'losses.kill_shot', 300)}`).join(' · ') : '(нет)'}`)
  const corr = sorted.filter((r) => r.verify_corrections && String(r.verify_corrections).trim())
  parts.push(`**5. Исправления субагентов (профиль → верификация):**\n${corr.length ? corr.map((r) => `- **${r.name}:** ${essay(r.verify_corrections, r.name, 'losses.verify_corrections', 400)}`).join('\n') : '- (нет)'}`)
  const ovr = sorted.filter((r) => (r.code_overrides || []).length)
  parts.push(`**6. Оверрайды кода (жёсткие правила поверх скора):**\n${ovr.length ? ovr.map((r) => `- **${r.name}:** ${essay((r.code_overrides || []).join(' · '), r.name, 'losses.overrides', 400)}`).join('\n') : '- (нет)'}`)
  const unvFields = sorted.filter((r) => (r.unverified || []).length)
  parts.push(`**7. Непроверенные ячейки (\`unverified\`):**\n${unvFields.length ? unvFields.map((r) => `- **${r.name}:** ${essay((r.unverified || []).join(', '), r.name, 'losses.unverified', 500)}`).join('\n') : '- (нет)'}`)
  const byField = new Map()
  clipped.forEach((c) => { const f = (c.split(' · ')[1] || c).split(':')[0]; byField.set(f, (byField.get(f) || 0) + 1) })
  const agg = Array.from(byField.entries()).sort((a, b) => b[1] - a[1]).map(([f, n]) => `\`${f}\` ×${n}`).join(' · ')
  parts.push(`**8. Обрезка при ПРОЕКЦИИ в MD — ${clipped.length} обрезок.** Источник истины (\`table.json\`) не обрезан: режется только markdown-проекция, потому что adversarial-агенты возвращают поля-эссе (kill-shot до 6 тыс. символов). Пороги: ячейка таблицы ${CLIP}, поле-эссе ${ESSAY} (часть полей — жёстче), блок приложения 6500 символов.\n\nПо полям: ${agg || '(нет)'}\n\nПервые 25 обрезок поимённо:\n${clipped.slice(0, 25).map((c) => `- ${c}`).join('\n')}${clipped.length > 25 ? `\n- _…ещё ${clipped.length - 25}; полный список воспроизводится запуском \`node docs/dune-query-discovery/build-report.mjs\`_` : ''}`)
  parts.push(`**9. Потеряно строк в пайплайне:** ${meta.counts.lost} из ${meta.counts.curated} курированных.`)
  const deadN = sorted.filter(isDead).length
  parts.push(`**9б. Поле \`lifecycle\` пришло ПРОЗОЙ, а не enum'ом схемы.** Скептики писали в него абзацы («sunset не объявлен», «archived=false», «DEPRECATED, дата просрочена»). Наивная классификация по ключевым словам дала бы **29 «мёртвых» строк из ${rows.length}** — она ловила отрицания. Раздел «Мёртвое/гаснущее» строится эвристикой «ключевое слово И отсутствие маркера отрицания в первых 240 символах» и даёт **${deadN}** строк. Эвристика воспроизводима (см. \`isDead()\` в build-report.mjs), но это ПРОЕКЦИЯ, а не машиночитаемое поле: при перепроверке смотреть \`lifecycle\` в table.json целиком.`)
  const fuAll = ((critic || {}).followups || []).length
  parts.push(`**10. Добивки:** выполнено ${followups.length} из ${fuAll} предложенных критиком (потолок \`maxFollowups=${meta.args.maxFollowups}\`).${fuAll > followups.length ? ` Не выполнены: ${((critic || {}).followups || []).slice(followups.length).join(' · ')}` : ''}`)
  return parts.join('\n\n')
}

// ── оглавление ───────────────────────────────────────────────────────────────
// Строится ИЗ СОБРАННОГО документа, а не из отдельного списка: заголовки приходят и из секций
// сборщика, и из прозы синтез-агентов (её уровни понижены на 2 в P()), поэтому вручную такой
// список моментально разошёлся бы с реальностью. Якоря — по правилу GitHub: убрать пунктуацию,
// нижний регистр, каждый пробел → дефис; дубликаты получают суффикс -1, -2, …
function anchor(text, seen) {
  const base = text
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-')
  const n = seen.get(base) ?? 0
  seen.set(base, n + 1)
  return n === 0 ? base : `${base}-${n}`
}
function buildToc(body) {
  const seen = new Map()
  const lines = []
  let appendixEntries = 0
  for (const m of body.matchAll(/^(#{2,3}) (.+)$/gm)) {
    const level = m[1].length
    const title = m[2].trim()
    const a = anchor(title, seen)              // якорь считаем ВСЕГДА — иначе собьётся нумерация дублей
    if (title === 'Оглавление') continue                          // самоссылка не нужна
    if (/^A\d+\./.test(title)) { appendixEntries++; continue }   // 46 профилей приложения не разворачиваем
    const label = title.replace(/`/g, '')
    lines.push(`${level === 2 ? '' : '  '}- [${label}](#${a})`)
  }
  return { toc: lines.join('\n'), appendixEntries }
}

// ── сборка ───────────────────────────────────────────────────────────────────
const master = masterTable()          // считаем ДО losses(), чтобы clipped[] был заполнен
const app = appendix()

const doc = `<!--
Auto-generated by ${meta.workflow} (run ${meta.run_id}, verified ${meta.date})
Workflow: .claude/workflows/${meta.workflow}.js
args: ${JSON.stringify(meta.args)}
Воронка: ${meta.funnel}
Ключ дедупа: ${meta.dedupe_key}
Метрики стоимости прогона: см. run-stats.md (канонический источник)
Собрано детерминированно: node docs/dune-query-discovery/build-report.mjs (таблицы — из table.json, проза — из _prose/)
-->

# Dune: как доставать готовые сложные запросы — отчёт

> **Провенанс.** Прогон \`${meta.run_id}\` воркфлоу [\`${meta.workflow}\`](../../.claude/workflows/${meta.workflow}.js), дата верификации **${meta.date}**.
> \`args: ${JSON.stringify(meta.args)}\`
> **Воронка:** \`${meta.funnel}\` · ключ дедупа \`${meta.dedupe_key}\`.
> **Метрики стоимости прогона:** [run-stats.md](run-stats.md) — канонический источник, здесь числа не дублируются.
> Постановка (контракт полноты): [research-brief.md](research-brief.md) · методология: [methodology.md](methodology.md) · источник истины по ячейкам: [table.json](table.json).

## Оглавление

<!--TOC-->

## §0. Область: что уже есть, что сознательно не покрыто

### 0.1. Что у нас УЖЕ есть — и это НЕ заменяется

${P('_prose/00-assets.md') || '_(см. research-brief.md §2)_'}

### 0.2. Анти-цели (сознательно вне области)

${P('_prose/01-antigoals.md') || '_(см. research-brief.md §11)_'}

> **Отсутствие темы в этом отчёте — решение об области, а не пропуск.** Всё отрезанное перечислено выше и в постановке §11.

## §1. Решение (BLUF)

${P('_prose/00-bluf.md')}

## §2. Мастер-таблица способов доступа

Отсортировано по \`fit\` (0–12). Формула и мэппинг под-скоров — [methodology.md](methodology.md);
разбивка в колонке fit: **(access/free_fit/coverage/verifiability/integration)**.
Полные необрезанные ячейки — в [Приложении A](#приложение-a-полные-профили) и в [table.json](table.json).

**Легенда:** \`✓\` официальный API/MCP, доступный на free · \`*\` есть непроверенные поля (\`unverified[]\`) ·
\`⚠\` скептик опроверг основное утверждение · \`💀\` вердикт reject · \`†\` подтверждённый sunset/archived ·
\`‼\` строка UNVERIFIED (пустой kill-shot, в рекомендации не идёт).

${master}

## §3. Официальный Dune MCP — поверхность целиком

Подключение (команда владельца): \`claude mcp add --scope user --transport http dune https://api.dune.com/mcp/v1\`

${mcpTable()}

${(mcpInv.verification && mcpInv.verification.kill_shot) ? `> **Adversarial-проверка инвентаря.** kill-shot: ${mcpInv.verification.kill_shot}\n> ${(mcpInv.verification.bad_citations || []).length ? `Не подтвердилось поимённо: ${(mcpInv.verification.bad_citations || []).join(' · ')}` : 'Поимённых расхождений не найдено.'}\n> ${mcpInv.verification.corrections || ''}` : ''}

## §4. Мёртвое / гаснущее

${deadTable()}

## §5. Плейбук: найти → проверить → исполнить

${P('_prose/10-playbook.md')}

## §6. Дизайн врезки в onchain-intel

${P('_prose/20-integration.md')}

## §7. Ответы на предъявленные вопросы

### Q1–Q5

${P('_prose/30-answers-q1-q5.md')}

### Q6–Q11

${P('_prose/31-answers-q6-q11.md')}

## §7б. Добивка: закрытые дыры (прогон \`${(meta.gapclose_run || {}).workflow || 'gapclose'}\`)

> Основной прогон сам назвал три дефекта покрытия (мост «URL дашборда → query_id» не профилирован;
> из сидов бесплатных альтернатив не профилирован ни один; дневной объём DEX «не закрывает никто»).
> Добивочный прогон в режиме INJECT профилировал ${(meta.gapclose_run || {}).candidates ?? '?'} кандидатов
> по той же схеме и с той же adversarial-проверкой. **Его выводы имеют приоритет над §1 там, где противоречат.**

${P('_prose/50-gapclose.md')}

## §8. Reject-лог

${rejectTable()}

## §9. Источники (первичные URL, сгруппированы по вендору)

${sources()}

## §10. KNOWN LOSSES / CORRECTIONS (залогировано, не молча)

${losses()}

## §11. Смещения, ограничения и дата актуальности

${P('_prose/40-biases.md') || ((critic.biases || []).map((b) => `- ${b}`).join('\n') || '_(критик не вернул раздел)_')}

**Дата актуальности чисел: ${meta.date}.** Тарифы, кредитные лимиты и состав тулов вендора дрейфуют.
Все числа — модель-собранные из документов, **не** подтверждённые живым вызовом API: в окружении этого
прогона отсутствовал \`DUNE_API_KEY\`. **Перепроверяйте любое число до того, как потратите деньги.**

## §12. Как повторить

\`\`\`
Workflow ${meta.workflow} ${JSON.stringify(meta.args)}
\`\`\`

Пересборка этого файла из источника истины: \`node docs/dune-query-discovery/build-report.mjs\`

---

## Приложение A. Полные профили

${app}
`

// Оглавление считается по УЖЕ СОБРАННОМУ телу и подставляется на место плейсхолдера,
// поэтому оно не может разойтись с фактическим набором заголовков.
const { toc, appendixEntries } = buildToc(doc)
const finalDoc = doc.replace(
  '<!--TOC-->',
  `${toc}\n  - _…и ${appendixEntries} полных профилей в Приложении A (по одному на строку мастер-таблицы)_`,
)

writeFileSync(join(DIR, 'report.md'), finalDoc)
console.log(`report.md собран: ${rows.length} строк, ${finalDoc.length} символов, обрезок ячеек ${clipped.length}`)
console.log(`оглавление: ${toc.split('\n').length} пунктов (+ ${appendixEntries} профилей приложения свёрнуты в одну строку)`)
