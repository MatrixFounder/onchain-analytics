import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createDefaultAccessProfileReader,
  createTokenStoreStub,
  createUserStoreStub,
  type AccessAuditEntry,
  type AccessProfile,
  type AccessProfileReader,
  type ApiToken,
  type Role,
  type TokenLookupRow,
  type User,
} from '../src/auth/index.js';

/**
 * Task 014-06 — the identity types and the two stores, checked as FORM.
 *
 * A `[STUB]` task ships a shape, so what is assertable is the shape: which fields exist, which
 * values a closed vocabulary admits, and — for several cases here — which assignments the COMPILER
 * must refuse. A `@ts-expect-error` that stops erroring fails the build, so those cases are gates in
 * the same sense the runtime ones are.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('the identity vocabularies are closed at compile time', () => {
  it('TC-UNIT-02: the role admits two values and refuses a third', () => {
    const admin: Role = 'admin';
    const user: Role = 'user';
    expect([admin, user]).toStrictEqual(['admin', 'user']);
    // @ts-expect-error — 'owner' is not a role; ADR-002 D8 declares two principals, not three.
    const invented: Role = 'owner';
    expect(invented).toBe('owner');
  });

  it('TC-UNIT-07: the journal admits the five actions of §4.5.5 and refuses a sixth', () => {
    const entry = auditEntry();
    expect(entry.action).toBe('token.issue');
    // @ts-expect-error — 'token.rotate' is outside the CHECK both migrations carry, so a row with it
    // would be refused by the engine at insert time, on the write path, in production.
    const invented: AccessAuditEntry['action'] = 'token.rotate';
    expect(invented).toBe('token.rotate');
  });

  it('TC-UNIT-05: ApiToken declares no field carrying the token value', () => {
    const row = apiToken();
    // @ts-expect-error — the secret exists once, in `issue`'s return, and is never read back.
    expect(row.token).toBeUndefined();
    // @ts-expect-error — nor the digest: nothing reads it, and a field for it would exist only to be
    // copied into a listing or an audit row, where §4.5.5 forbids it.
    expect(row.tokenHash).toBeUndefined();
    expect(row.prefix).toBe('oi_abcdefghi');
  });

  it('TC-UNIT-06: time fields are epoch-ms numbers, never strings', () => {
    const row = apiToken();
    for (const field of ['createdAt'] as const) {
      expect(typeof row[field]).toBe('number');
    }
    // @ts-expect-error — an ISO string in a time column is the defect DB-SCHEMA §1.2 forbids: it
    // sorts lexically, carries a local offset, and survives neither engine move.
    const wrong: ApiToken['createdAt'] = '2026-08-15T00:00:00Z';
    expect(wrong).toBe('2026-08-15T00:00:00Z');
  });

  it('TC-UNIT-09: the user carries no limit number (R-15.3b)', () => {
    const row = user();
    // @ts-expect-error — a limit on the user would be a second mechanism beside the access profile.
    expect(row.rateLimitPerMin).toBeUndefined();
    // @ts-expect-error — same: the balance is a column of `access_profiles`, reached by the token.
    expect(row.creditsBalanceRaw).toBeUndefined();
    expect(row.role).toBe('admin');
  });
});

describe('the two stores answer their declared methods', () => {
  it('TC-UNIT-01: every method of both stubs returns its declared shape', async () => {
    const users = createUserStoreStub();
    const created = await users.createUser({ email: 'Ops@Example.COM', role: 'admin' });
    expect(created.status).toBe('active');
    expect(created.role).toBe('admin');
    expect(await users.listUsers()).toHaveLength(1);

    const tokens = createTokenStoreStub();
    expect(await tokens.lookup('anything')).toBeNull();
    await expect(tokens.revoke('01JT', '01JU')).resolves.toBeUndefined();
    await expect(tokens.appendAudit(auditEntry())).resolves.toBeUndefined();
    expect(tokens.audited).toHaveLength(1);
  });

  it('lowercases the address on the way in, so one person cannot become two', () => {
    // Neither engine folds case in a UNIQUE index by default (§4.5.3), so the writer is the only
    // place this can be enforced. The stub enforces it too — a stub that did not would let the
    // repository's tests be written against a rule the stub had already broken.
    const users = createUserStoreStub();
    return users.createUser({ email: 'Ops@Example.COM', role: 'user' }).then(async (created) => {
      expect(created.email).toBe('ops@example.com');
      expect(await users.findUser({ email: 'OPS@EXAMPLE.COM' })).not.toBeNull();
      expect(await users.findUser({ id: created.id })).toStrictEqual(created);
      expect(await users.findUser({ id: 'absent' })).toBeNull();
    });
  });

  it('TC-UNIT-03: issue returns the value and the prefix separately', async () => {
    const issued = await createTokenStoreStub().issue('01JUSER', '01JPROFILE');
    expect(typeof issued.token).toBe('string');
    expect(typeof issued.prefix).toBe('string');
    // The prefix is the leading 11 characters (§7.5.2) — asserted on the stub too, so the rule is
    // stated where the shape is declared and not only where it is implemented.
    expect(issued.prefix).toBe(issued.token.slice(0, 11));
    expect(issued.prefix.length).toBeGreaterThanOrEqual(8); // the CHECK in both migrations
  });

  it('TC-UNIT-04: lookup returns the seven values of §4.5.4, token and user status apart', async () => {
    const row = lookupRow({});
    const store = createTokenStoreStub(row);
    const found = await store.lookup('presented');
    expect(Object.keys(found ?? {}).sort()).toStrictEqual(
      [
        'tokenId',
        'tokenStatus',
        'expiresAt',
        'accessProfileId',
        'userId',
        'role',
        'userStatus',
      ].sort(),
    );
    // Two of the four refusing states are these two fields, so folding them into one would make two
    // states one and leave R-26 without its class.
    expect(found?.tokenStatus).toBe('active');
    expect(found?.userStatus).toBe('active');
  });

  it('the liveness predicate is not in the query — a revoked token still returns a row', async () => {
    const revoked = await createTokenStoreStub(lookupRow({ tokenStatus: 'revoked' })).lookup('x');
    expect(revoked).not.toBeNull();
    expect(revoked?.tokenStatus).toBe('revoked');
    // `null` is one of the four states — the unknown token — and only that one.
    expect(await createTokenStoreStub(null).lookup('x')).toBeNull();
  });
});

describe('TC-UNIT-08: two tokens of one person differ by profile, never by role (R-15.3b)', () => {
  it('reads two different limits under one unchanged role', async () => {
    const rows = [
      lookupRow({ tokenId: '01JT1', accessProfileId: 'P1' }),
      lookupRow({ tokenId: '01JT2', accessProfileId: 'P2' }),
    ];
    const limits = new Map([
      ['P1', 10],
      ['P2', 100],
    ]);
    const reader: AccessProfileReader = {
      read: (id) =>
        createDefaultAccessProfileReader()
          .read(id)
          .then((profile): AccessProfile => ({
            ...profile,
            rateLimitMode: 'metered',
            rateLimitPerMin: limits.get(id) ?? null,
          })),
    };

    const read = await Promise.all(rows.map((row) => reader.read(row.accessProfileId)));
    expect(read.map((profile) => profile.rateLimitPerMin)).toStrictEqual([10, 100]);
    // One person, one role — the limits differ and the role does not. That is the whole of R-15.3b:
    // a limit that varied by role would be a second mechanism, and two tokens of one person could
    // then disagree about what that person sees.
    expect(new Set(rows.map((row) => row.role)).size).toBe(1);
    expect(new Set(rows.map((row) => row.userId)).size).toBe(1);
  });
});

describe('packages/core still receives no identity type (§7.5.1)', () => {
  /**
   * The boundary re-measured with the vocabulary task 014-06 introduces.
   *
   * `engine-store-contracts.test.ts` already scans for `ApiToken` and friends; this adds the names
   * this task declares, because a gate only ever reads what it was given — and the failure mode is
   * silent agreement, not a false alarm.
   */
  const coreSources = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return coreSources(full);
      return full.endsWith('.ts') ? [full] : [];
    });

  it('declares no Role, User, TokenLookupRow or AccessAuditEntry under packages/core/src', () => {
    const offenders: string[] = [];
    for (const file of coreSources(path.join(repoRoot, 'packages/core/src'))) {
      const body = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .join('\n');
      if (
        /\b(interface|type)\s+(Role|UserStatus|TokenStatus|TokenLookupRow|AccessAuditEntry|IssuedToken|AuditAction)\b/.test(
          body,
        )
      ) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders, 'identity types live beside the transport that needs them').toStrictEqual([]);
  });

  it('detects the drift it was written for', () => {
    const drifted = 'export type Role = "admin" | "user";';
    expect(
      /\b(interface|type)\s+(Role|UserStatus|TokenStatus|TokenLookupRow|AccessAuditEntry|IssuedToken|AuditAction)\b/.test(
        drifted,
      ),
    ).toBe(true);
  });
});

function user(): User {
  return {
    id: '01JUSER0000000000000000000',
    email: 'ops@example.com',
    displayName: null,
    role: 'admin',
    status: 'active',
    createdAt: 1_770_000_000_000,
    updatedAt: 1_770_000_000_000,
  };
}

function apiToken(): ApiToken {
  return {
    id: '01JTOKEN000000000000000000',
    userId: '01JUSER0000000000000000000',
    accessProfileId: '01JPHASE00000000000000000A',
    prefix: 'oi_abcdefghi',
    name: null,
    status: 'active',
    expiresAt: null,
    revokedAt: null,
    createdAt: 1_770_000_000_000,
  };
}

function lookupRow(overrides: Partial<TokenLookupRow>): TokenLookupRow {
  return {
    tokenId: '01JTOKEN000000000000000000',
    tokenStatus: 'active',
    expiresAt: null,
    accessProfileId: '01JPHASE00000000000000000A',
    userId: '01JUSER0000000000000000000',
    role: 'user',
    userStatus: 'active',
    ...overrides,
  };
}

function auditEntry(): AccessAuditEntry {
  return {
    id: '01JAUDIT000000000000000000',
    ts: 1_770_000_000_000,
    actorUserId: '01JUSER0000000000000000000',
    action: 'token.issue',
    targetType: 'api_token',
    targetId: '01JTOKEN000000000000000000',
    beforeJson: null,
    afterJson: '{"prefix":"oi_abcdefghi"}',
    createdAt: 1_770_000_000_000,
  };
}
