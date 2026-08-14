import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  STUB_ACCESS_PROFILE,
  createAccessProfileStoreStub,
  createTokenStoreStub,
  createUserStoreStub,
  type AccessProfileRecord,
} from '../src/auth/index.js';
import {
  DIAGNOSTIC_EVENTS,
  DIAGNOSTIC_SEVERITIES,
  REQUEST_TRACE_OUTCOMES,
  REQUEST_TRACE_SERVED_FROM,
  createDiagnosticsStoreStub,
  createRequestTraceStoreStub,
  requestTraceDedupKey,
  type DiagnosticsRecord,
  type RequestTraceRecord,
} from '../src/engine/index.js';

/**
 * Task 014-02 — the five repository interfaces, checked as FORM.
 *
 * A `[STUB]` task ships a shape, so what is assertable is the shape: which fields exist, which
 * values a closed vocabulary admits, and which behaviour a stub must not omit. Nothing here reaches
 * a database — the stubs are the seam (R-21).
 *
 * **Why the vocabularies are asserted against literal lists.** Each one is a `CHECK` constraint in
 * both migration 002 and `CACHE_DDL`. A vocabulary that drifts from its constraint produces rows the
 * database refuses at insert time — in production, on the write path, with the request already
 * served.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('access profile — the settings a token works within', () => {
  it('declares the seven fields security.md §7.5.3a names, and no eighth', () => {
    expect(Object.keys(STUB_ACCESS_PROFILE).sort()).toEqual(
      [
        'creditsMode',
        'creditsBalanceRaw',
        'rateLimitMode',
        'rateLimitPerMin',
        'toolAllowlistMode',
        'toolAllowlist',
        'routeDisclosureMode',
      ].sort(),
    );
  });

  it('pairs every mode with its value, so unlimited is never a bare null', () => {
    const profile: AccessProfileRecord = STUB_ACCESS_PROFILE;
    expect(profile.creditsMode === 'metered').toBe(profile.creditsBalanceRaw !== null);
    expect(profile.rateLimitMode === 'metered').toBe(profile.rateLimitPerMin !== null);
    expect(profile.toolAllowlistMode === 'list').toBe(profile.toolAllowlist !== null);
  });

  it('carries the exact credit balance as a string, past the safe integer range', () => {
    const raw = STUB_ACCESS_PROFILE.creditsBalanceRaw ?? '';
    expect(typeof raw).toBe('string');
    expect(Number(raw)).not.toBe(BigInt(raw));
    expect(String(Number(raw))).not.toBe(raw);
  });

  it('answers null for an unknown profile without throwing — and null is a refusal, not a default', async () => {
    await expect(createAccessProfileStoreStub(null).read('01JX')).resolves.toBeNull();
    await expect(createAccessProfileStoreStub().read('01JX')).resolves.toEqual(STUB_ACCESS_PROFILE);
  });

  it('rejects a third value of a two-valued mode at compile time', () => {
    // @ts-expect-error — 'partial' is not one of 'full' | 'none'; removing this line must fail typecheck.
    const bad: AccessProfileRecord['routeDisclosureMode'] = 'partial';
    expect(bad).toBe('partial');
  });
});

describe('request trace — the per-request record T-015 charges from', () => {
  it('admits the four values of served_from, coalesced among them', () => {
    expect([...REQUEST_TRACE_SERVED_FROM].sort()).toEqual(
      ['cache', 'coalesced', 'none', 'vendor'].sort(),
    );
  });

  it('admits the three outcome classes data-model.md §4.5.7 declares', () => {
    expect([...REQUEST_TRACE_OUTCOMES].sort()).toEqual(
      ['answer', 'partial_deadline', 'refusal'].sort(),
    );
  });

  it('links vendor spend by COORDINATE, never by a row reference', () => {
    const record = traceRecord({});
    for (const coordinate of [
      'vendorProvider',
      'vendorCredits',
      'vendorCalls',
      'vendorDay',
      'vendorWindowStart',
    ]) {
      expect(Object.keys(record), `${coordinate} is one of the five coordinates`).toContain(
        coordinate,
      );
    }
    expect(
      Object.keys(record),
      'a usage row id would be a reference, not a coordinate',
    ).not.toContain('usageRef');
  });

  it('refuses a duplicate of the declared dedup key, and admits a row differing in any component', async () => {
    const store = createRequestTraceStoreStub();
    const base = traceRecord({});
    await expect(store.append(base)).resolves.toEqual({ written: true });
    await expect(store.append({ ...base, id: '01JR2' })).resolves.toEqual({ written: false });

    for (const differing of [
      { principalId: 'other' },
      { clientRequestId: 'req-2' },
      { receivedAt: base.receivedAt + 1 },
    ]) {
      await expect(
        store.append({ ...base, ...differing, id: `01JR-${Object.keys(differing)[0] ?? ''}` }),
      ).resolves.toEqual({ written: true });
    }
    expect(store.appended).toHaveLength(4);
  });

  it('builds the dedup key from exactly the three declared components', () => {
    const key = requestTraceDedupKey({
      principalId: 'local',
      clientRequestId: 'req-1',
      receivedAt: 10,
    });
    expect(key).toContain('local');
    expect(key).toContain('req-1');
    expect(key).toContain('10');
  });

  it('keeps every time field a number, so no string date reaches the ledger', () => {
    const record = traceRecord({});
    for (const field of ['receivedAt', 'completedAt', 'createdAt'] as const) {
      expect(typeof record[field], `${field} is epoch-ms as a number`).toBe('number');
    }
  });
});

describe('diagnostics — the stored channel', () => {
  it('declares the closed vocabulary of eight events', () => {
    expect([...DIAGNOSTIC_EVENTS].sort()).toEqual(
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
    expect([...DIAGNOSTIC_SEVERITIES].sort()).toEqual(['error', 'info', 'warn'].sort());
  });

  it('refuses an event outside the vocabulary at compile time', () => {
    // @ts-expect-error — an event invented at runtime makes AC-48's query impossible to write.
    const bad: DiagnosticsRecord['event'] = 'limiter.exploded';
    expect(bad).toBe('limiter.exploded');
  });

  it('stores what it was handed, so a computed signal has a reader', async () => {
    const store = createDiagnosticsStoreStub();
    const record = diagnosticsRecord();
    await store.append(record);
    expect(store.appended).toEqual([record]);
  });
});

describe('the stubs satisfy their interfaces without a database', () => {
  it('constructs all five, and each answers its declared method', async () => {
    expect(createUserStoreStub()).toBeDefined();
    expect(createTokenStoreStub()).toBeDefined();
    await expect(createAccessProfileStoreStub().read('01JX')).resolves.toBeDefined();
    await expect(createRequestTraceStoreStub().append(traceRecord({}))).resolves.toBeDefined();
    await expect(createDiagnosticsStoreStub().append(diagnosticsRecord())).resolves.toBeUndefined();
  });
});

describe('packages/core gains no knowledge of tokens, roles or headers', () => {
  /**
   * The boundary security.md §7.5.1 states, checked rather than trusted.
   *
   * The identity checks live beside the transport that needs them, and the SQL naming the identity
   * tables lives there too. A repository that drifted back into `core` would take the schema
   * qualification gate's input with it — that gate reads both packages precisely because these
   * statements are outside `core`.
   */
  const coreSources = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return coreSources(full);
      return full.endsWith('.ts') ? [full] : [];
    });

  /**
   * Two mentions of an identity table under `core` are legitimate, and the difference is the point.
   *
   * `cache/ddl.ts` DECLARES the tables: task 014-36 puts all eight of §4.5 in `CACHE_DDL`, because
   * one DDL string serves both dialects and that is what makes the revocation and audit tests
   * runnable offline. `pg/state-client.ts` lists them in a guard that refuses an unqualified
   * reference. Neither reads or writes a row.
   *
   * What §7.5.1 forbids is knowledge: a token type, a role type, a header parse, or a statement that
   * touches identity data. So the assertion is about DML, not about the string appearing at all — a
   * grep for the name alone would have to be suppressed for both files above, and a suppression list
   * is where this kind of gate goes to die.
   */
  it('issues no statement against an identity table under packages/core/src', () => {
    const offenders: string[] = [];
    for (const file of coreSources(path.join(repoRoot, 'packages/core/src'))) {
      const body = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .join('\n');
      const dml =
        /\b(SELECT[\s\S]{0,200}?FROM|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[\w.]*\b(api_tokens|access_audit|users)\b/i;
      if (dml.test(body)) offenders.push(path.relative(repoRoot, file));
    }
    expect(offenders, 'identity SQL belongs in mcp-server (security.md §7.5.1)').toEqual([]);
  });

  it('declares no token, role or header type under packages/core/src', () => {
    const offenders: string[] = [];
    for (const file of coreSources(path.join(repoRoot, 'packages/core/src'))) {
      const body = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .join('\n');
      if (/\b(interface|type)\s+(ApiToken|Principal|AccessProfile|UserRole)\b/.test(body)) {
        offenders.push(path.relative(repoRoot, file));
      }
      if (/\bAuthorization['"`]?\s*[:\]]/.test(body)) offenders.push(path.relative(repoRoot, file));
    }
    expect(offenders, 'the identity types live beside the transport that needs them').toEqual([]);
  });

  it('detects the drift it was written for — a statement moved back into core', () => {
    const drifted = `const q = 'SELECT id FROM onchain.api_tokens WHERE token_hash = $1';`;
    const dml =
      /\b(SELECT[\s\S]{0,200}?FROM|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[\w.]*\b(api_tokens|access_audit|users)\b/i;
    expect(dml.test(drifted)).toBe(true);
    expect(dml.test('CREATE TABLE IF NOT EXISTS api_tokens ('), 'DDL is not DML').toBe(false);
  });
});

function traceRecord(overrides: Partial<RequestTraceRecord>): RequestTraceRecord {
  return {
    id: '01JR1',
    receivedAt: 10,
    completedAt: 11,
    principalId: 'local',
    userId: null,
    accessProfileId: null,
    clientRequestId: 'req-1',
    sessionId: null,
    transport: 'stdio',
    tool: 'onchain_ping',
    capability: null,
    argsHash: null,
    outcome: 'answer',
    refusalClass: null,
    servedFrom: 'none',
    cacheAgeMs: null,
    vendorProvider: null,
    vendorCredits: null,
    vendorCalls: null,
    vendorDay: null,
    vendorWindowStart: null,
    escalatedToPaid: 0,
    triedJson: null,
    createdAt: 11,
    ...overrides,
  };
}

function diagnosticsRecord(): DiagnosticsRecord {
  return {
    id: '01JD1',
    ts: 10,
    severity: 'warn',
    event: 'limiter.degraded',
    principalId: null,
    sessionId: null,
    provider: 'defillama',
    capability: null,
    traceId: null,
    detailJson: '{"store":"unreachable"}',
    createdAt: 10,
  };
}
