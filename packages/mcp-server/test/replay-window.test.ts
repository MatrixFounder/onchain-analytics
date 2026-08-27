import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createCacheStore } from '@onchain-intel/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessProfileReader } from '../src/auth/access-profile.js';
import {
  REPLAY_AND_RECONCILE_CEILING_MS,
  createBillingStore,
  createSqliteBillingStore,
  replayWindowMs,
  type BillingReserveResult,
  type BillingStore,
} from '../src/engine/billing-store.js';
import { createSqliteEngine } from './helpers/sqlite-engine.js';

/**
 * Task 015-08 — the replay window: `replayWindowMs()`'s own derivation (TC-UNIT-06/07/08), the
 * conflict branch on BOTH storage axes (TC-UNIT-01–05, TC-UNIT-09), and the doc half of the
 * `errorClass` → `refusalClass` rename in `system-architecture.md` §3.5.2a (TC-DOC-01).
 *
 * **Time is injected, never awaited.** `gas.price`'s 30 s window and the 120 000 ms ceiling make a
 * real `setTimeout`-based wait unusable for this suite (task doc, "TC test-cases" preamble). Both
 * axes take an injectable clock; every test drives it explicitly.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), 'utf8');

/** One input shared across cases — mirrors `billing-store-sqlite.test.ts`/`billing-store-pg.test.ts`'s
 * own fixture, extended with `capability`/`tool` overrides since this suite's whole point is picking
 * capabilities with different TTLs. */
function reserveInput(
  overrides: Partial<{
    clientRequestId: string;
    tool: string;
    capability: string | null;
    priceRaw: string;
  }> = {},
) {
  return {
    principalId: 'local',
    accessProfileId: null,
    clientRequestId: overrides.clientRequestId ?? 'req-1',
    tool: overrides.tool ?? 'onchain_gas_price',
    capability: overrides.capability === undefined ? 'gas.price' : overrides.capability,
    priceRaw: overrides.priceRaw ?? '1',
  };
}

function unwrapOk(result: BillingReserveResult): { rowId: string; existing: boolean } {
  if (!result.ok) throw new Error(`unreachable — reserve() refused: ${JSON.stringify(result)}`);
  return result.reservation;
}

/** A reader that must never be called — every case here uses `accessProfileId: null`, which skips
 * `AccessProfileReader` entirely (R-6.2, `system-architecture.md:4098-4100`). */
const NO_PROFILE_READER: AccessProfileReader = {
  read(accessProfileId: string): Promise<never> {
    return Promise.reject(new Error(`unexpected profile read for ${accessProfileId}`));
  },
};

interface ClientUsageRow {
  readonly id: string;
  readonly state: 'reserved' | 'settled' | 'refunded';
  readonly reserved_at: number;
  readonly terminal_at: number | null;
  readonly updated_at: number;
}

/** One reserve/settle/refund/sumSettled surface, plus the two things this suite needs beyond it: a
 * mutable clock and a raw read of the ledger row — the same seam
 * `billing-store-sqlite.test.ts`'s `capturingCtor()` and `billing-store-pg.test.ts`'s
 * `BillingPgHarness` each build separately, unified here because this suite exercises both axes with
 * the identical test bodies (`describe.each`). */
interface AxisHarness {
  readonly store: BillingStore;
  setNow(ms: number): void;
  rows(): readonly ClientUsageRow[];
  close(): void;
}

function sqliteHarness(): AxisHarness {
  let opened: Database.Database | undefined;
  const DatabaseCtor = function (
    dbPath: string,
    options?: { readonly timeout?: number },
  ): Database.Database {
    opened = new Database(dbPath, options);
    return opened;
  } as unknown as new (
    dbPath: string,
    options?: { readonly timeout?: number },
  ) => Database.Database;

  let current = 0;
  const store = createSqliteBillingStore({
    path: ':memory:',
    DatabaseCtor,
    now: () => current,
  });

  return {
    store,
    setNow: (ms) => {
      current = ms;
    },
    rows: () => {
      if (opened === undefined) throw new Error('the database was never opened');
      return opened.prepare('SELECT * FROM client_usage').all() as ClientUsageRow[];
    },
    close: () => opened?.close(),
  };
}

function postgresHarness(): AxisHarness {
  const engine = createSqliteEngine();
  let current = 0;
  const store = createBillingStore(engine.engine, NO_PROFILE_READER, { now: () => current });

  return {
    store,
    setNow: (ms) => {
      current = ms;
    },
    rows: () => engine.db.prepare('SELECT * FROM client_usage').all() as ClientUsageRow[],
    close: () => engine.close(),
  };
}

describe('replayWindowMs() — the derivation itself (no store involved)', () => {
  it('TC-UNIT-06: windowMs is the min of the capability TTL and the ceiling', () => {
    // gas.price: ttlSeconds 30 (packages/core/src/capability-manifest.ts:497/:515) -> 30_000 ms,
    // well under the ceiling.
    expect(replayWindowMs({ capability: 'gas.price', tool: 'onchain_gas_price' })).toBe(30_000);
    // protocol.tvl: ttlSeconds 300 (packages/core/src/capability-manifest.ts:357/:361) -> 300_000 ms,
    // clamped down to the 120_000 ms ceiling.
    expect(replayWindowMs({ capability: 'protocol.tvl', tool: 'onchain_protocol_tvl' })).toBe(
      120_000,
    );
  });

  it("TC-UNIT-07: a tool with no declared capability lands on the ceiling through ttlFor()'s own miss path", () => {
    // onchain_ping/onchain_list_chains carry capability = null (registry.ts:473). `ttlFor(null ??
    // 'onchain_ping')` finds no manifest row and falls through to DEFAULT_TTL_SECONDS (300 s,
    // cache/ttl.ts:21) -> 300_000 ms, clamped to the ceiling by the SAME `Math.min` every other
    // capability goes through — no branch exists for this case in `replayWindowMs()`.
    expect(replayWindowMs({ capability: null, tool: 'onchain_ping' })).toBe(
      REPLAY_AND_RECONCILE_CEILING_MS,
    );
  });

  it('TC-UNIT-08: the ceiling constant is declared exactly once under packages/mcp-server/src/engine/', () => {
    expect(REPLAY_AND_RECONCILE_CEILING_MS).toBe(120_000);

    const engineDir = path.join(repoRoot, 'packages/mcp-server/src/engine');
    const files = readdirSync(engineDir).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    let totalOccurrences = 0;
    for (const file of files) {
      const text = readFileSync(path.join(engineDir, file), 'utf8');
      totalOccurrences += (text.match(/\b120_?000\b/g) ?? []).length;
    }
    // Exactly one occurrence anywhere under engine/ — the constant's own declaration
    // (`export const REPLAY_AND_RECONCILE_CEILING_MS = 120_000;`). A second literal (a hand-typed
    // `120000`/`120_000` inside the window branch itself) would drift from this one silently on the
    // next edit — the task's own "one constant, two consumers, not two literals" — and this count
    // would move to 2 the moment it did.
    expect(totalOccurrences).toBe(1);
  });
});

describe.each([
  ['sqlite', sqliteHarness],
  ['postgres', postgresHarness],
] as const)("reserve()'s conflict branch — %s axis", (_axisName, makeHarness) => {
  let harness: AxisHarness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it('TC-UNIT-01 (AC-48): a repeat inside the window is served as a retry, one row only', async () => {
    const capability = 'token.price'; // ttlSeconds 60 -> windowMs 60_000
    const windowMs = replayWindowMs({ capability, tool: 'onchain_token_price' });
    expect(windowMs).toBe(60_000);
    const input = reserveInput({ capability, tool: 'onchain_token_price' });

    harness.setNow(1_000_000);
    const first = unwrapOk(await harness.store.reserve(input));

    harness.setNow(1_000_000 + windowMs / 2); // squarely inside the window
    const second = await harness.store.reserve(input);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable — asserted above');
    expect(second.reservation.existing).toBe(true);
    expect(second.reservation.rowId).toBe(first.rowId);
    expect(harness.rows()).toHaveLength(1);
  });

  it('TC-UNIT-02 (AC-48): the boundary is inclusive — exactly reserved_at + windowMs is still a retry', async () => {
    const capability = 'gas.price'; // ttlSeconds 30 -> windowMs 30_000
    const windowMs = replayWindowMs({ capability, tool: 'onchain_gas_price' });
    expect(windowMs).toBe(30_000);
    const input = reserveInput({ capability, tool: 'onchain_gas_price' });

    harness.setNow(1_000_000);
    const first = unwrapOk(await harness.store.reserve(input));

    // `<=`, not `<`: this is exactly the point a `<` mutant flips to the refused branch.
    harness.setNow(1_000_000 + windowMs);
    const second = await harness.store.reserve(input);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable — asserted above');
    expect(second.reservation.existing).toBe(true);
    expect(second.reservation.rowId).toBe(first.rowId);
  });

  it('TC-UNIT-03 (AC-49): a repeat past the window on a 30 s-TTL capability is refused by name', async () => {
    const capability = 'gas.price';
    const windowMs = replayWindowMs({ capability, tool: 'onchain_gas_price' });
    expect(windowMs).toBe(30_000);
    const input = reserveInput({ capability, tool: 'onchain_gas_price' });

    harness.setNow(1_000_000);
    unwrapOk(await harness.store.reserve(input));

    harness.setNow(1_000_000 + windowMs + 1); // 30_001 ms later — one ms past the window
    const second = await harness.store.reserve(input);

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable — asserted above');
    expect(second.refusalClass).toBe('ReplayWindowExpiredError');
  });

  it('TC-UNIT-04: a refusal by expired window does not touch the existing ledger row, and writes no new one', async () => {
    const capability = 'gas.price';
    const windowMs = replayWindowMs({ capability, tool: 'onchain_gas_price' });
    const input = reserveInput({ capability, tool: 'onchain_gas_price' });

    harness.setNow(1_000_000);
    unwrapOk(await harness.store.reserve(input));
    const before = harness.rows()[0];
    if (before === undefined) throw new Error('unreachable — reserved above');

    harness.setNow(1_000_000 + windowMs + 1);
    const refused = await harness.store.reserve(input);
    expect(refused.ok).toBe(false);

    const rowsAfter = harness.rows();
    expect(rowsAfter).toHaveLength(1);
    const after = rowsAfter[0];
    if (after === undefined) throw new Error('unreachable');
    expect(after.state).toBe(before.state);
    expect(after.terminal_at).toBe(before.terminal_at);
    expect(after.updated_at).toBe(before.updated_at);
  });
});

describe('TC-UNIT-09: both storage axes reach the same decision on the same (reserved_at, now) pair', () => {
  it('agrees at three points — inside the window, on the boundary, past it', async () => {
    const capability = 'gas.price';
    const tool = 'onchain_gas_price';
    const windowMs = replayWindowMs({ capability, tool });
    const input = reserveInput({ capability, tool });
    const points: readonly {
      readonly label: string;
      readonly delta: number;
      readonly ok: boolean;
    }[] = [
      { label: 'inside the window', delta: windowMs / 2, ok: true },
      { label: 'exactly on the boundary', delta: windowMs, ok: true },
      { label: 'past the window', delta: windowMs + 1, ok: false },
    ];

    for (const point of points) {
      const sqlite = sqliteHarness();
      const postgres = postgresHarness();
      try {
        sqlite.setNow(1_000_000);
        postgres.setNow(1_000_000);
        unwrapOk(await sqlite.store.reserve(input));
        unwrapOk(await postgres.store.reserve(input));

        sqlite.setNow(1_000_000 + point.delta);
        postgres.setNow(1_000_000 + point.delta);
        const sqliteResult = await sqlite.store.reserve(input);
        const postgresResult = await postgres.store.reserve(input);

        expect(sqliteResult.ok, point.label).toBe(point.ok);
        expect(postgresResult.ok, point.label).toBe(point.ok);
        if (!point.ok) {
          if (sqliteResult.ok || postgresResult.ok) throw new Error('unreachable — asserted above');
          expect(sqliteResult.refusalClass, point.label).toBe('ReplayWindowExpiredError');
          expect(postgresResult.refusalClass, point.label).toBe('ReplayWindowExpiredError');
        }
      } finally {
        sqlite.close();
        postgres.close();
      }
    }
  });
});

describe('TC-UNIT-05 (AC-50): _meta.cache.ageMs on a replay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a second read inside the replay window reports a growing age, never one reset to ~0', async () => {
    // The window itself is billing-store.ts's concern; this proves the mechanism `system-
    // architecture.md` §3.5.2a leans on for R-5.8 — `TwoLevelStore.get()` re-entered a second time —
    // reports the value's true age rather than the time since the SECOND call
    // (`packages/core/src/cache/two-level-store.ts:57-71`). No new code in billing-store.ts backs
    // this: "Отдельной проверки для R-5.8 не добавляется" (task doc).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);

    const cache = createCacheStore({ dbPath: ':memory:' });
    await cache.set('coingecko', 'token.price', 'replay-window-h', { priceUsd: 1 });

    const first = await cache.get('coingecko', 'token.price', 'replay-window-h');
    expect(first).toBeDefined();

    vi.setSystemTime(1_000_000 + 5_000); // 5 s later — still inside token.price's 60 s window
    const second = await cache.get('coingecko', 'token.price', 'replay-window-h');
    expect(second).toBeDefined();

    expect(second?.ageMs).toBeGreaterThan(first?.ageMs ?? Number.POSITIVE_INFINITY);
  });
});

describe('TC-DOC-01: system-architecture.md §3.5.2a names the field refusalClass, not errorClass', () => {
  it('the section between §3.5.2a and §3.5.3 carries no errorClass substring', () => {
    const doc = read('docs/architectures/system-architecture.md');
    const start = doc.indexOf('#### 3.5.2a.');
    const end = doc.indexOf('#### 3.5.3.');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const section = doc.slice(start, end);
    expect(section).not.toContain('errorClass');
    // The two spots the task names explicitly: the conflict branch's own pseudocode, and the
    // paragraph beneath it quoting §3.5.2's pseudocode.
    expect(section).toContain("refusalClass: 'ReplayWindowExpiredError'");
    expect(section).toContain('reserved.refusalClass');
  });

  it("task 015-09 renamed §3.5.2's own line too — zero errorClass occurrences left in the corpus", () => {
    // §3.5.2 is OUTSIDE the §3.5.2a/§3.5.3 window checked above. Task 015-08 (this suite) left this
    // exact line for task 015-09 to touch — its own prior docstring said so — and 015-09 is the
    // reader of `reserved.refusalClass` (`registry.ts`'s interception point), so it is the one that
    // renamed the pseudocode to match what it actually reads.
    const doc = read('docs/architectures/system-architecture.md');
    const start = doc.indexOf('#### 3.5.2.');
    const end = doc.indexOf('#### 3.5.2a.');
    const section = doc.slice(start, end);
    expect(section).not.toContain('errorClass');
    expect(section).toContain('refusalClass: reserved.refusalClass');
  });
});
