import { z } from 'zod';

/**
 * Canonical `Snapshot` entity (D5 addendum, persistent form — DB-SCHEMA-CONCEPT.md §2). The M1
 * engine never writes this itself — n8n writes snapshots independently (CLAUDE.n8n.md,
 * ARCHITECTURE.md §1/§2.1) — this type exists for a future M3 snapshotter absorption (R-2).
 *
 * **camelCase↔snake_case mapping note (ARCHITECTURE.md §4.1, minor, review cycle 1):** this
 * schema is camelCase (`valueRaw`, `valueNum`); the persisted DB-SCHEMA-CONCEPT §2 columns are
 * snake_case (`value_raw`, `value_num`). `metric`/`asset`/`ts`/`source`/`height` are identical and
 * are NOT renamed. M1 does not write `snapshots`, so no (de)serializer is implemented here — when
 * M3 absorbs the snapshotter it needs an explicit `valueRaw↔value_raw` / `valueNum↔value_num`
 * mapper, not a generic camelCase→snake_case transform applied to every field. Documented ahead of
 * time so M3 doesn't have to re-derive this decision.
 */
export const SnapshotSchema = z
  .object({
    metric: z.string(),
    asset: z.string(),
    ts: z.number().int(),
    valueRaw: z.string(),
    valueNum: z.number().optional(),
    source: z.string(),
    height: z.number().int().optional(),
  })
  .strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;
