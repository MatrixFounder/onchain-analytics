import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyToken } from '../src/auth/authenticate.js';
import {
  MissingPepperError,
  TokenMintExhaustedError,
  TokenNotRevocableError,
  createTokenStore,
  mintToken,
  tokenDigest,
  type TokenStore,
} from '../src/auth/token-store.js';
import { createUserStore } from '../src/auth/user-store.js';
import type { UserStore } from '../src/auth/user-store.js';
import type { TokenLookupRow } from '../src/auth/identity-types.js';
import { ulid } from '../src/ulid.js';
import {
  PHASE_0_PROFILE_ID,
  createSqliteEngine,
  type SqliteEngine,
} from './helpers/sqlite-engine.js';

/**
 * Task 014-07 — issue, digest, revoke and the append-only journal, run against a real engine.
 *
 * The engine is SQLite (`helpers/sqlite-engine.ts`), because R-21 forbids a live Postgres in
 * `pnpm test` and because §4.2.4 makes the two dialects one statement with three substitutions. What
 * runs below is the shipped SQL.
 */

const PEPPER = 'test-pepper-2f7a';
const NOW = 1_770_000_000_000;

let harness: SqliteEngine;
let tokens: TokenStore;
let users: UserStore;
let clock = NOW;

/** A deterministic id source, so a failure names a row rather than a fresh random string. */
const ids = (): ((nowMs: number) => string) => {
  let n = 0;
  return (nowMs: number): string => ulid(nowMs, () => Uint8Array.from(Array(16).fill(n++ % 32)));
};

beforeEach(async () => {
  clock = NOW;
  harness = createSqliteEngine();
  users = createUserStore({ engine: harness.engine, now: () => clock, newId: ids() });
  tokens = createTokenStore({
    engine: harness.engine,
    pepper: PEPPER,
    now: () => clock,
    newId: ids(),
  });
  await users.createUser({ email: 'Ops@Example.COM', role: 'admin' });
});

afterEach(() => {
  harness.close();
  vi.restoreAllMocks();
});

const adminId = async (): Promise<string> => {
  const found = await users.findUser({ email: 'ops@example.com' });
  if (found === null) throw new Error('the seeded admin is missing');
  return found.id;
};

/** Every text value in the three identity tables — the input of the "never stored" assertions. */
const allTextValues = (harness_: SqliteEngine): string[] => {
  const out: string[] = [];
  for (const table of ['users', 'api_tokens', 'access_audit']) {
    for (const row of harness_.db.prepare(`SELECT * FROM ${table}`).all() as Record<
      string,
      unknown
    >[]) {
      for (const value of Object.values(row)) if (typeof value === 'string') out.push(value);
    }
  }
  return out;
};

describe('the token is minted, never stored, and never printed', () => {
  it('TC-UNIT-01: the issued value appears in no column of the three tables (AC-26)', async () => {
    const issued = await tokens.issue(await adminId(), PHASE_0_PROFILE_ID);
    await tokens.revoke(issued.id, await adminId());

    const stored = allTextValues(harness);
    expect(stored.length).toBeGreaterThan(0); // not vacuous: there are rows to search
    for (const value of stored) {
      expect(value, 'a stored value contains the token').not.toContain(issued.token);
      // The 43-character secret alone, in case a caller ever stored "the part after the prefix".
      expect(value).not.toContain(issued.token.slice(12));
    }
  });

  it('TC-UNIT-02: the shape is §7.5.2, character for character (AC-41)', async () => {
    // **The parts are read by POSITION, and the first version of this test was not.** Splitting on
    // `_` looked obvious and was flaky at roughly one run in two: base64url's alphabet INCLUDES `_`,
    // so a 43-character secret contains one about half the time, and `token.split('_')` then returns
    // four or five parts with a truncated "secret". The separator in §7.5.2 is a position, not a
    // delimiter — anything that parses one of these values by splitting is wrong for the same
    // reason, and this comment is here so the next reader does not reintroduce it.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const issued = await tokens.issue(await adminId(), PHASE_0_PROFILE_ID);
      expect(issued.token.slice(0, 3)).toBe('oi_');
      expect(issued.token.slice(3, 11)).toMatch(/^[A-Za-z0-9_-]{8}$/); // the 8-character label
      expect(issued.token.slice(11, 12)).toBe('_'); // the separator
      expect(issued.token.slice(12)).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url: no +, /, =
      expect(issued.token).toHaveLength(55);
      // The stored prefix is the leading 11 characters — `oi_` plus the label — and it is what
      // identifies the token to every reader that must not see it.
      expect(issued.prefix).toBe(issued.token.slice(0, 11));
      expect(issued.prefix).toHaveLength(11);
    }
  });

  it('TC-UNIT-05: two issues differ in both the value and the prefix', async () => {
    const user = await adminId();
    const first = await tokens.issue(user, PHASE_0_PROFILE_ID);
    const second = await tokens.issue(user, PHASE_0_PROFILE_ID);
    expect(first.token).not.toBe(second.token);
    expect(first.prefix).not.toBe(second.prefix);
    expect(first.id).not.toBe(second.id);
  });

  it('the value reaches no diagnostic channel at any level', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const issued = await tokens.issue(await adminId(), PHASE_0_PROFILE_ID);
    await tokens.lookup(issued.token);
    await tokens.revoke(issued.id, await adminId());
    await tokens.lookup(issued.token);

    const printed = spies.flatMap((spy) => spy.mock.calls.flat().map((arg) => String(arg)));
    for (const line of printed) expect(line).not.toContain(issued.token);
  });
});

describe('the digest is peppered, and the pepper is the only thing that makes it verify', () => {
  it('TC-UNIT-03: the stored digest equals sha256(pepper || value), computed outside the code', async () => {
    const issued = await tokens.issue(await adminId(), PHASE_0_PROFILE_ID);
    const row = harness.db
      .prepare('SELECT token_hash FROM api_tokens WHERE id = ?')
      .get(issued.id) as { token_hash: string };

    // Computed here from the primitives, not by calling `tokenDigest` — a test that called the
    // function under test would agree with any expression it happened to contain.
    const expected = createHash('sha256').update(`${PEPPER}${issued.token}`, 'utf8').digest('hex');
    expect(row.token_hash).toBe(expected);
    expect(row.token_hash).toHaveLength(64);
    expect(row.token_hash).toBe(row.token_hash.toLowerCase());
    expect(tokenDigest(PEPPER, issued.token)).toBe(expected);
  });

  it('TC-UNIT-04: rotating the pepper invalidates every issued token at once', async () => {
    const issued = await tokens.issue(await adminId(), PHASE_0_PROFILE_ID);
    expect(await tokens.lookup(issued.token)).not.toBeNull();

    const rotated = createTokenStore({
      engine: harness.engine,
      pepper: 'a-different-pepper',
      now: () => clock,
    });
    // Not a bug being pinned — a consequence stated in advance (§7.5.2). There is no re-hash path,
    // because the presented secrets are not stored, so rotation is a decision with a known cost.
    expect(await rotated.lookup(issued.token)).toBeNull();
  });

  it('refuses to build a store with no pepper rather than digesting without one', () => {
    // An empty pepper would produce a plain sha256 of the token: a stolen table would then be a
    // candidate list for an offline dictionary attack, and nothing in the process would say so.
    expect(() =>
      createTokenStore({ engine: harness.engine, pepper: '', now: () => clock }),
    ).toThrow(MissingPepperError);
    expect(() =>
      createTokenStore({ engine: harness.engine, pepper: '   ', now: () => clock }),
    ).toThrow(MissingPepperError);
  });
});

describe('lookup is by digest and by nothing else', () => {
  it('finds the row by digest, and the statement carries no liveness predicate', async () => {
    const issued = await tokens.issue(await adminId(), PHASE_0_PROFILE_ID);
    harness.statements.length = 0;
    const found = await tokens.lookup(issued.token);
    expect(found?.tokenId).toBe(issued.id);

    const [statement] = harness.statements;
    expect(statement?.text).toContain('token_hash = $1');
    // The four refusing states are decided in code over the row. A predicate here would answer zero
    // rows for all four, and R-26 needs the class.
    expect(statement?.text).not.toMatch(/status\s*=\s*'active'/);
    expect(statement?.text).not.toMatch(/expires_at/i.source + String.raw`\s*[<>]`);
    // And the digest is what travels, never the presented value.
    expect(statement?.values).toStrictEqual([tokenDigest(PEPPER, issued.token)]);
  });

  it('never looks a token up by its prefix', async () => {
    const issued = await tokens.issue(await adminId(), PHASE_0_PROFILE_ID);
    await tokens.lookup(issued.token);
    await tokens.revoke(issued.id, await adminId());
    // A second lookup path over a shorter, non-secret value would be a weaker credential in the same
    // table. `prefix` legitimately appears in an INSERT column list, in the `ON CONFLICT` target
    // that makes it unambiguous, and in a `RETURNING` — none of which selects a row. What must never
    // appear is a COMPARISON against it, so that is what is checked rather than the bare word.
    const selectsOnPrefix = /\bprefix\s*(=|<>|!=|\bIN\b|\bLIKE\b)/i;
    for (const statement of harness.statements) {
      expect(selectsOnPrefix.test(statement.text), statement.text).toBe(false);
      expect(statement.text).not.toMatch(/token_hash\s*=\s*\$\d+[\s\S]*\bprefix\s*=/i);
    }
    // Not vacuous: the same pattern does catch the statement it forbids.
    expect(selectsOnPrefix.test('SELECT id FROM onchain.api_tokens WHERE prefix = $1')).toBe(true);
  });

  it('TC-UNIT-06: a prefix collision is re-minted, and no ambiguous row is written', async () => {
    const user = await adminId();
    const taken = await tokens.issue(user, PHASE_0_PROFILE_ID);

    // A mint whose FIRST value repeats a prefix already in the table. `UNIQUE (prefix)` is what makes
    // identification unambiguous (R-15.2), so the issue path must produce a different one rather
    // than write a second row nobody can tell apart.
    let call = 0;
    const colliding = createTokenStore({
      engine: harness.engine,
      pepper: PEPPER,
      now: () => clock,
      newId: ids(),
      mint: () => {
        call += 1;
        return call === 1 ? `${taken.prefix}_${'A'.repeat(43)}` : mintToken();
      },
    });
    const second = await colliding.issue(user, PHASE_0_PROFILE_ID);
    expect(call).toBe(2);
    expect(second.prefix).not.toBe(taken.prefix);

    const count = harness.db
      .prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE prefix = ?')
      .get(taken.prefix) as { n: number };
    expect(count.n).toBe(1);
  });

  it('gives up after a bounded number of collisions instead of spinning', async () => {
    const user = await adminId();
    const taken = await tokens.issue(user, PHASE_0_PROFILE_ID);
    const stuck = createTokenStore({
      engine: harness.engine,
      pepper: PEPPER,
      now: () => clock,
      newId: ids(),
      mint: () => `${taken.prefix}_${'B'.repeat(43)}`,
    });
    // An unbounded retry turns a database that refuses every insert into a process that spins
    // instead of reporting.
    await expect(stuck.issue(user, PHASE_0_PROFILE_ID)).rejects.toBeInstanceOf(
      TokenMintExhaustedError,
    );
  });
});

describe('TC-UNIT-07: the four refusing states are distinguishable', () => {
  const row = (overrides: Partial<TokenLookupRow>): TokenLookupRow => ({
    tokenId: '01JT',
    tokenStatus: 'active',
    expiresAt: null,
    accessProfileId: PHASE_0_PROFILE_ID,
    userId: '01JU',
    role: 'user',
    userStatus: 'active',
    ...overrides,
  });

  it('names a different class for each, while the wire answer stays one status', () => {
    expect(classifyToken(null, NOW)).toStrictEqual({
      ok: false,
      refusalClass: 'auth.unknown_token',
    });
    expect(classifyToken(row({ tokenStatus: 'revoked' }), NOW).ok).toBe(false);
    expect(classifyToken(row({ expiresAt: NOW }), NOW)).toStrictEqual({
      ok: false,
      refusalClass: 'auth.expired',
    });
    expect(classifyToken(row({ userStatus: 'suspended' }), NOW)).toStrictEqual({
      ok: false,
      refusalClass: 'auth.user_suspended',
    });

    const classes = [
      classifyToken(null, NOW),
      classifyToken(row({ tokenStatus: 'revoked' }), NOW),
      classifyToken(row({ expiresAt: NOW }), NOW),
      classifyToken(row({ userStatus: 'suspended' }), NOW),
    ].map((outcome) => (outcome.ok ? 'ok' : outcome.refusalClass));
    // Four states, four classes. One class for all four is what a `WHERE` predicate would have
    // produced, and an operator could not then tell a token that never existed from one they revoked.
    expect(new Set(classes).size).toBe(4);
  });

  it('admits a live token, and treats the expiry instant as already past', () => {
    expect(classifyToken(row({}), NOW).ok).toBe(true);
    expect(classifyToken(row({ expiresAt: NOW + 1 }), NOW).ok).toBe(true);
    // `expires_at > created_at` is the column's own CHECK, so the named instant is the first one at
    // which the token is no longer valid — not the last one at which it is.
    expect(classifyToken(row({ expiresAt: NOW }), NOW).ok).toBe(false);
  });

  it('reports revocation ahead of expiry when a token is both', () => {
    // Arbitrary in outcome — the caller sees 401 either way — and deliberate in the record: an act
    // somebody performed is more informative to an operator than a date passing.
    expect(classifyToken(row({ tokenStatus: 'revoked', expiresAt: NOW - 1 }), NOW)).toStrictEqual({
      ok: false,
      refusalClass: 'auth.revoked',
    });
  });
});

describe('revocation, and the journal that records it', () => {
  it('TC-UNIT-10: the row stays, with a status and a timestamp', async () => {
    const issued = await tokens.issue(await adminId(), PHASE_0_PROFILE_ID);
    clock = NOW + 60_000;
    await tokens.revoke(issued.id, await adminId());

    const row = harness.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(issued.id) as {
      status: string;
      revoked_at: number;
    };
    expect(row.status).toBe('revoked');
    expect(row.revoked_at).toBe(NOW + 60_000);
    expect(
      (harness.db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get() as { n: number }).n,
    ).toBe(1);
  });

  it('the revoked token then refuses, with the class its state names', async () => {
    // The store-level half of AC-26. The other half — the request path and the dropped session —
    // belongs to task 014-15 (TC-E2E-03, the next request is refused) and task 014-13 (the
    // `session.evicted` row), because neither the transport nor the session manager exists yet.
    const issued = await tokens.issue(await adminId(), PHASE_0_PROFILE_ID);
    expect(classifyToken(await tokens.lookup(issued.token), NOW).ok).toBe(true);
    await tokens.revoke(issued.id, await adminId());
    expect(classifyToken(await tokens.lookup(issued.token), NOW)).toStrictEqual({
      ok: false,
      refusalClass: 'auth.revoked',
    });
  });

  it('refuses an unknown or already-revoked id rather than reporting success', async () => {
    const issued = await tokens.issue(await adminId(), PHASE_0_PROFILE_ID);
    const actor = await adminId();
    await tokens.revoke(issued.id, actor);
    await expect(tokens.revoke(issued.id, actor)).rejects.toBeInstanceOf(TokenNotRevocableError);
    await expect(tokens.revoke('01JNOSUCHTOKEN', actor)).rejects.toBeInstanceOf(
      TokenNotRevocableError,
    );
    // And the refused attempts wrote no journal row: a record of something that did not happen is
    // read as a record of something that did.
    expect(
      (harness.db.prepare('SELECT COUNT(*) AS n FROM access_audit').get() as { n: number }).n,
    ).toBe(1);
  });

  it('rolls the revocation back when its journal row cannot be written', async () => {
    const issued = await tokens.issue(await adminId(), PHASE_0_PROFILE_ID);
    // An actor that does not exist violates `access_audit.actor_user_id REFERENCES users(id)`, which
    // SQLite enforces only because the harness sets the pragma (§1.6). The point is the pairing: the
    // token must not be left revoked with nothing in the journal saying who did it.
    await expect(tokens.revoke(issued.id, '01JNOSUCHUSER')).rejects.toThrow();
    const row = harness.db.prepare('SELECT status FROM api_tokens WHERE id = ?').get(issued.id) as {
      status: string;
    };
    expect(row.status).toBe('active');
  });

  it('TC-UNIT-09: the journal row carries the id and the prefix, and neither secret', async () => {
    const issued = await tokens.issue(await adminId(), PHASE_0_PROFILE_ID);
    await tokens.revoke(issued.id, await adminId());
    const entry = harness.db
      .prepare("SELECT * FROM access_audit WHERE action = 'token.revoke'")
      .get() as {
      target_id: string;
      before_json: string;
      after_json: string;
      actor_user_id: string;
    };

    expect(entry.target_id).toBe(issued.id);
    expect(entry.before_json).toContain(issued.prefix);
    expect(entry.after_json).toContain(issued.prefix);
    expect(entry.actor_user_id).toBe(await adminId());
    for (const json of [entry.before_json, entry.after_json]) {
      expect(json).not.toContain(issued.token);
      // The digest is a verifier, and this journal has more readers than the authentication path.
      expect(json).not.toContain(tokenDigest(PEPPER, issued.token));
      // And no digest-SHAPED value at all. Naming the one expected digest was the first version of
      // this assertion, and a mutation showed what it misses: any other 64-hex value — a digest
      // under a rotated pepper, a hash of something adjacent — passed it while being exactly the
      // kind of verifier §4.5.5 keeps out of this table.
      expect(json, 'a 64-hex value in an audit row is a digest, whatever it digests').not.toMatch(
        /\b[0-9a-f]{64}\b/,
      );
    }
  });

  it('TC-UNIT-08: the journal cannot be rewritten or emptied (AC-41)', async () => {
    const issued = await tokens.issue(await adminId(), PHASE_0_PROFILE_ID);
    await tokens.revoke(issued.id, await adminId());
    const before = harness.db.prepare('SELECT COUNT(*) AS n FROM access_audit').get() as {
      n: number;
    };
    expect(before.n).toBe(1);

    // The guard is the ENGINE's, declared by task 014-36 for this axis and by 014-35 for the other.
    // Testing it here is testing the declaration those tasks shipped, on the statements this one
    // writes: an append-only journal that a later UPDATE can reword records whatever the last writer
    // preferred.
    expect(() => harness.db.exec("UPDATE access_audit SET action = 'user.create'")).toThrow(
      /append-only|immutable|read-only/i,
    );
    expect(() => harness.db.exec('DELETE FROM access_audit')).toThrow(
      /append-only|immutable|read-only/i,
    );
    const after = harness.db.prepare('SELECT COUNT(*) AS n FROM access_audit').get() as {
      n: number;
    };
    expect(after.n).toBe(1);
  });
});

describe('the user repository writes what §4.5.3 declares', () => {
  it('lowercases the address, so one person cannot be created twice', async () => {
    const found = await users.findUser({ email: 'OPS@EXAMPLE.COM' });
    expect(found?.email).toBe('ops@example.com');
    // The UNIQUE index is what refuses the second one — and it only refuses because the writer
    // folded the case first. Neither engine folds it by default.
    await expect(users.createUser({ email: 'ops@EXAMPLE.com', role: 'user' })).rejects.toThrow();
  });

  it('stamps both timestamps from one clock reading', async () => {
    const created = await users.createUser({ email: 'second@example.com', role: 'user' });
    expect(created.createdAt).toBe(NOW);
    expect(created.updatedAt).toBe(NOW);
    expect(created.status).toBe('active');
    expect(created.displayName).toBeNull();
  });

  it('lists in creation order and finds by either key', async () => {
    await users.createUser({ email: 'second@example.com', role: 'user' });
    const listed = await users.listUsers();
    expect(listed.map((user) => user.email)).toStrictEqual([
      'ops@example.com',
      'second@example.com',
    ]);
    expect(await users.findUser({ id: listed[0]?.id ?? '' })).toStrictEqual(listed[0]);
    expect(await users.findUser({ id: '01JABSENT' })).toBeNull();
  });

  it('refuses a role outside the two the CHECK admits', async () => {
    await expect(
      // @ts-expect-error — the type refuses it too; this measures that the ENGINE does as well, so
      // a value arriving from outside TypeScript cannot reach the table.
      users.createUser({ email: 'third@example.com', role: 'owner' }),
    ).rejects.toThrow();
  });
});

describe('every statement this task issues is schema-qualified', () => {
  it('names onchain.<table> in each one', async () => {
    const issued = await tokens.issue(await adminId(), PHASE_0_PROFILE_ID);
    await tokens.lookup(issued.token);
    await tokens.revoke(issued.id, await adminId());
    await users.listUsers();

    expect(harness.statements.length).toBeGreaterThan(4);
    for (const statement of harness.statements) {
      // `search_path` is not a correctness condition on the shipped deployment (WI-47), so an
      // unqualified name answers with no rows rather than with an error. The static gate of task
      // 014-03 reads the source; this reads what actually ran.
      for (const table of ['api_tokens', 'users', 'access_audit']) {
        const bare = new RegExp(String.raw`(?<!onchain\.)\b${table}\b`);
        const stripped = statement.text.replace(/onchain\.\w+/g, '');
        expect(bare.test(stripped) && stripped.includes(table), statement.text).toBe(false);
      }
    }
  });
});
