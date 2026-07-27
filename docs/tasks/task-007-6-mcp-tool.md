# Task 007-6: MCP-тул `onchain_dex_volume`

## Use Case Connection

- UC-1: агент вызывает тул и получает ряд + агрегаты

## RTM

**R-69**

## Task Goal

Отдать capability наружу одиннадцатым тулом, по образцу `chain-tvl.ts`, без единого нового приёма.

## Changes Description

### Новые файлы

- `packages/mcp-server/src/tools/dex-volume.ts`

```ts
export const DexVolumeInputSchema = z
  .object({
    chain: ChainInputSchema,
    days: z.number().int().min(1).max(1825).optional(),
    includeSeries: z.boolean().optional(),
  })
  .strict();

export const DexVolumeOutputSchema = z
  .object({
    chain: ChainInputSchema,
    name: z.string(),
    window: z
      .object({ fromMs: z.number().int(), toMs: z.number().int(), days: z.number().int() })
      .strict(),
    series: z.array(
      z.object({ ts: z.number().int(), volumeUsd: z.number().nonnegative() }).strict(),
    ),
    points: z.number().int().nonnegative(),
    gapDays: z.number().int().nonnegative(),
    totals: z
      .object({
        h24: z.number().nullable(),
        d7: z.number().nullable(),
        d30: z.number().nullable(),
        d1y: z.number().nullable(),
        allTime: z.number().nullable(),
      })
      .strict(),
    truncated: z.object({ series: z.boolean(), reason: z.string() }).strict(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
```

- `dexVolumeHandler(input, ctx)` — точная калька с `chainTvlHandler`:
  1. `canonicalizeChain(input.chain, ctx.registry.getChainRegistry())` — против **того же** реестра,
     на котором гейтится `CapabilityRegistry` (урок vdd-multi cycle 5, H-4), и **до** `args`.
  2. **Дефолты материализуются здесь**, до построения `args`: `days ?? 90`, `includeSeries ?? true`.
     Опущенный `days` и явный `days: 90` обязаны дать один `argsHash` — иначе один логический запрос
     заводит две записи кэша и две загрузки. Это уже зафиксированный прецедент `onchain_new_pairs`.
  3. `resolveCapability(ctx.registry, 'dex.volume.history', chain, { chain, days, includeSeries })`.
  4. `DexVolumeOutputSchema.safeParse` — **`safeParse`, не `parse`**: провайдерский результат,
     не прошедший контракт, возвращается как `{ok:false, reason}` и никогда не выбрасывается из
     хендлера.
- `registerDexVolumeTool(server, ctx)` — `inputSchema: …InputSchema.shape`,
  `outputSchema: …OutputSchema.shape`, `_meta: { cache: outcome.cache }`.
  Описание: что это объём **сети**, что источник DeFiLlama и он бесплатный, и что список сетей —
  через `onchain_list_chains` (описание тула — единственный сигнал модели о наборе сетей после
  отказа от енума, урок TASK-006 M-2).

### Изменения в существующих файлах

#### `packages/mcp-server/src/server.ts`

- Импорт + `registerDexVolumeTool(server, { registry })` рядом с `registerChainTvlTool`.
- Комментарий над блоком: **10 тулов → 11**.

## Test Cases

### Unit-тесты (`packages/mcp-server/test/tools/dex-volume.test.ts`, новый)

1. **TC-UNIT-01** — успешный путь на инжектированном фейковом `CapabilityRegistry`:
   `structuredContent` соответствует схеме, `_meta.cache.status === 'miss'`.
2. **TC-UNIT-02** — результат, не проходящий выходную схему (например `volumeUsd: -1`), даёт
   `isError: true` с внятной причиной, а **не** исключение.
3. **TC-UNIT-03** — `days: 0` и `days: 1826` отвергаются входной схемой; регистри не вызывается вовсе.
4. **TC-UNIT-04** — неизвестная сеть даёт ошибку тула с «did you mean» и **нулём** обращений к регистри.
5. **TC-UNIT-05** — опущенный `days` и явный `days: 90` строят **одинаковые** `args`
   (проверяется по аргументам, с которыми был вызван фейковый регистри).
6. **TC-UNIT-06** — лишнее поле во входе отвергается (`.strict()`).

### E2E (`packages/mcp-server/test/e2e.inprocess.test.ts` — расширить)

7. **TC-E2E-01** — `tools/list` возвращает **11** тулов, включая `onchain_dex_volume`, и его
   `inputSchema` рендерится в JSON Schema без ошибки (`.shape` пригоден для `registerTool`).

### Регрессия

- `pnpm test` целиком; отдельно `e2e.stdio.test.ts` и `chain-discoverability.test.ts` — они считают тулы.

## Acceptance Criteria

- [ ] Схемы входа и выхода `.strict()`, без `z.record`/`passthrough`/`z.any`
- [ ] Дефолты материализуются до `args`
- [ ] `safeParse`, а не `parse`
- [ ] `_meta.cache` присутствует
- [ ] `tools/list` показывает 11 тулов
- [ ] `pnpm test` зелёный целиком
