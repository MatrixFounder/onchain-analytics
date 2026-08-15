import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDiagnostics } from '../src/engine/diagnostics.js';
import {
  DIAGNOSTIC_EVENTS,
  createDiagnosticsStore,
  type DiagnosticEvent,
  type DiagnosticsStore,
} from '../src/engine/diagnostics-store.js';
import { createSqliteEngine, type SqliteEngine } from './helpers/sqlite-engine.js';

/**
 * Task 014-27 — the diagnostics channel, and the stderr inventory that decides which sites use it.
 *
 * The stored half runs against a real engine (the SQLite axis, R-21). The stderr half is read
 * through the injected writer rather than by capturing the stream, so a failure names the line.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NOW = 1_770_000_000_000;

let harness: SqliteEngine;
let store: DiagnosticsStore;
let lines: string[];

beforeEach(() => {
  harness = createSqliteEngine();
  store = createDiagnosticsStore(harness.engine);
  lines = [];
});

afterEach(() => harness.close());

const channel = (override: Partial<Parameters<typeof createDiagnostics>[0]> = {}) =>
  createDiagnostics({
    store,
    now: () => NOW,
    writeStderr: (line) => lines.push(line),
    ...override,
  });

const rows = (): Record<string, unknown>[] =>
  harness.db.prepare('SELECT * FROM diagnostics ORDER BY id').all() as Record<string, unknown>[];

describe('AC-28 / AC-48: an event reaches both channels', () => {
  it('writes the row an administrator can find without shell access', async () => {
    const id = await channel().emit('auth.rejected', {
      severity: 'warn',
      principalId: null,
      detail: { refusalClass: 'auth.revoked' },
    });

    // AC-48's query shape: by `(event, ts)`, from the table — no stderr involved.
    const found = harness.db
      .prepare('SELECT * FROM diagnostics WHERE event = ? AND ts = ?')
      .get('auth.rejected', NOW) as { id: string; detail_json: string; severity: string };
    expect(found.id).toBe(id);
    expect(found.severity).toBe('warn');
    expect(JSON.parse(found.detail_json)).toStrictEqual({ refusalClass: 'auth.revoked' });
  });

  it('TC-UNIT-01: the stderr line carries the row id and NOT the principal', async () => {
    const id = await channel().emit('auth.rejected', {
      severity: 'warn',
      principalId: '01JPRINCIPAL0000000000000A',
      detail: { refusalClass: 'auth.expired' },
    });

    expect(lines).toHaveLength(1);
    // R-5.3 forbids a principal on stderr; R-19.3 requires the refusal to be observable. The row id
    // satisfies both — it is the join key §4.5.8 names, and on its own it identifies nobody.
    expect(lines[0]).toContain(`id=${id}`);
    expect(lines[0]).toContain('event=auth.rejected');
    expect(lines[0]).not.toContain('01JPRINCIPAL0000000000000A');
    // And the principal IS on the row, where an operator with database access can read it.
    expect(rows()[0]?.['principal_id']).toBe('01JPRINCIPAL0000000000000A');
  });

  it('TC-UNIT-05: a failed store leaves the event on stderr and raises nothing', async () => {
    const broken: DiagnosticsStore = {
      append: () => Promise.reject(new Error('state store unreachable')),
    };
    const id = await channel({ store: broken }).emit('limiter.degraded', {
      severity: 'error',
      detail: { store: 'unreachable' },
    });

    // Never rethrown: an emit is a side effect of some other decision, and letting a diagnostics
    // outage refuse a request would make the observability layer able to take the service down.
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('event=limiter.degraded');
    // The gap is NAMED rather than left to be inferred from a missing row.
    expect(lines[1]).toContain('store=unreachable');
    expect(lines[1]).toContain('state store unreachable');
  });

  it('writes the stderr line BEFORE the row, so a slow store does not delay the operator', async () => {
    let appended = false;
    const slow: DiagnosticsStore = {
      append: () =>
        new Promise((resolve) => {
          appended = true;
          resolve();
        }),
    };
    const emit = channel({ store: slow }).emit('session.evicted', {
      severity: 'info',
      detail: { cause: 'idle' },
    });
    expect(lines, 'the line was not written before the store was asked').toHaveLength(1);
    await emit;
    expect(appended).toBe(true);
  });

  it('the local profile has no stored channel, and that is not a degradation', async () => {
    // stdio, one operator, and that operator IS reading stderr.
    const id = await channel({ store: null }).emit('tool.refused', {
      severity: 'warn',
      detail: { tool: 'onchain_ping' },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`id=${id}`);
    expect(rows()).toStrictEqual([]);
  });
});

describe('TC-UNIT-02: the vocabulary is compiled, not invented', () => {
  it('carries the eight events of §4.5.8 and refuses a ninth at compile time', () => {
    expect([...DIAGNOSTIC_EVENTS].sort()).toStrictEqual(
      [
        'auth.rejected',
        'perimeter.rejected',
        'session.limit_reached',
        'session.evicted',
        'limiter.degraded',
        'source.escalated_to_paid',
        'tool.refused',
        'retention.cleanup',
      ].sort(),
    );
    // @ts-expect-error — an event invented at runtime makes AC-48's query impossible to write.
    const invented: DiagnosticEvent = 'auth.maybe';
    expect(invented).toBe('auth.maybe');
  });

  it('keeps `retention.cleanup` in the dictionary though this process never writes it', () => {
    // Its only writer is the `onchain-retention` workflow (task 014-41, `deployment.md` §10.6.1).
    // The dictionary is the TABLE's contract, not a list of one process's calls.
    expect(DIAGNOSTIC_EVENTS).toContain('retention.cleanup');
  });
});

/* ------------------------------------------------------------------------------------------------
 * The stderr inventory (§3.4.10).
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every file that writes to stderr, with the channel its writes use.
 *
 * **Why the inventory is keyed by FILE and not by line, and this is a deviation stated rather than
 * made quietly.** §3.4.10 records twenty-six sites by `file:line`, measured 2026-08-13. Re-measured
 * for this task: forty code sites across sixteen files — T-014 itself added fourteen. Line numbers
 * move on every edit above them, so a line-keyed inventory is stale before the commit that writes it
 * lands, and its staleness looks exactly like a site with no assigned channel. A file-keyed one goes
 * red when a NEW file starts writing, which is the event worth catching: an unassigned site is
 * unassigned wherever in the file it sits.
 *
 * **What each class means.**
 * - `stderr` — an operator diagnostic that stays on stderr alone (R-32.1). Twenty-five of the
 *   original twenty-six are this, and every site T-014 added to the startup path is too: they run
 *   before a stored channel exists, or they report why one could not be built.
 * - `level` — written only under `LOG_LEVEL=debug` (R-19.2). Exactly one site.
 * - `dual` — also writes a `diagnostics` row. Only `engine/diagnostics.ts` writes the stored
 *   channel; every other producer reaches it through that module rather than formatting its own.
 *
 * **`net/safe-fetch.ts` is deliberately absent.** Its only match is inside a comment — one of the
 * two §3.4.10 subtracts. The first draft of this table copied the file list straight out of the raw
 * grep and listed it; the gate refused, which is exactly the subtraction the task says must be made
 * by hand or the re-measurement reads 42 where it should read 40.
 */
const STDERR_INVENTORY: Readonly<Record<string, 'stderr' | 'level' | 'dual'>> = {
  'packages/core/src/adapters/registry.ts': 'stderr',
  'packages/core/src/adapters/blockscout/index.ts': 'stderr',
  'packages/core/src/adapters/dexscreener/index.ts': 'stderr',
  'packages/core/src/adapters/nansen/index.ts': 'stderr',
  'packages/core/src/adapters/nansen/budget-gate.ts': 'stderr',
  'packages/core/src/adapters/nansen/normalize.ts': 'stderr',
  'packages/core/src/adapters/nansen/reconcile.ts': 'stderr',
  'packages/core/src/cache/stats.ts': 'level',
  'packages/core/src/pg/cache-store.ts': 'stderr',
  'packages/core/src/pg/read-client.ts': 'stderr',
  'packages/core/src/pg/state-client.ts': 'stderr',
  'packages/mcp-server/src/admin/bin.ts': 'stderr',
  'packages/mcp-server/src/env.ts': 'stderr',
  'packages/mcp-server/src/index.ts': 'stderr',
  'packages/mcp-server/src/transport/http.ts': 'stderr',
  'packages/mcp-server/src/engine/diagnostics.ts': 'dual',
};

const WRITES_STDERR = /process\.stderr\.write\(|console\.error\(/;

/** Code lines only: a match inside a comment is prose about the rule, not a write. */
const codeLines = (body: string): string[] =>
  body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'));

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourcesUnder(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('TC-UNIT-04: every stderr site has an assigned channel', () => {
  const measured = (): Map<string, number> => {
    const found = new Map<string, number>();
    for (const root of ['packages/core/src', 'packages/mcp-server/src']) {
      for (const file of sourcesUnder(path.join(repoRoot, root))) {
        const hits = codeLines(readFileSync(file, 'utf8')).filter((line) =>
          WRITES_STDERR.test(line),
        ).length;
        if (hits > 0) found.set(path.relative(repoRoot, file), hits);
      }
    }
    return found;
  };

  it('names every file that writes, and no file that does not', () => {
    const found = measured();
    expect(found.size).toBeGreaterThan(0);

    const unassigned = [...found.keys()].filter((file) => !(file in STDERR_INVENTORY));
    expect(
      unassigned,
      'these files write to stderr and are in no channel. A site with no assigned channel is the ' +
        'defect §3.4.10 exists to prevent — decide whether it stays stderr-only (R-32.1), goes ' +
        'behind a level (R-19.2), or belongs in the stored channel.',
    ).toStrictEqual([]);

    const stale = Object.keys(STDERR_INVENTORY).filter((file) => !found.has(file));
    expect(
      stale,
      'these files are in the inventory and write nothing. An entry that describes no code is a ' +
        'claim nobody can check.',
    ).toStrictEqual([]);
  });

  it('routes the stored channel through ONE module', () => {
    // Every other producer emits through `createDiagnostics`, so the "what reaches stderr and what
    // reaches the table" decision is made in one place rather than at each call site.
    const dual = Object.entries(STDERR_INVENTORY)
      .filter(([, channel_]) => channel_ === 'dual')
      .map(([file]) => file);
    expect(dual).toStrictEqual(['packages/mcp-server/src/engine/diagnostics.ts']);

    const writers = sourcesUnder(path.join(repoRoot, 'packages/mcp-server/src'))
      .filter((file) => /INSERT INTO[\s\S]{0,60}diagnostics/i.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(repoRoot, file));
    expect(writers).toStrictEqual(['packages/mcp-server/src/engine/diagnostics-store.ts']);
  });

  it('exempts a match inside a comment, and says so with a real one', () => {
    // The re-measurement the task asks for gave 42 raw matches against 40 code sites; the two
    // extras are prose. Stripping comments is what makes the count a fact about writes rather than
    // about mentions.
    expect(codeLines('// console.error("prose")\nconst a = 1;')).toStrictEqual(['const a = 1;']);
    expect(
      codeLines('/**\n * process.stderr.write(x)\n */\nconst b = 2;').join('\n'),
    ).not.toContain('process.stderr.write');
  });

  it('the level-gated site is exactly one, and it is the per-access cache line', () => {
    const gated = Object.entries(STDERR_INVENTORY)
      .filter(([, channel_]) => channel_ === 'level')
      .map(([file]) => file);
    // §3.4.10: it is the only site that writes on EVERY access, in a process that may have no
    // reachable database — the state in which a storage failure is being diagnosed.
    expect(gated).toStrictEqual(['packages/core/src/cache/stats.ts']);
  });
});
