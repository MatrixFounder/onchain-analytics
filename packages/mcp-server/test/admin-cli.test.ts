import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCESS_PROFILE_ID, runAdminCommand, type AdminDeps } from '../src/admin/cli.js';
import { classifyToken } from '../src/auth/authenticate.js';
import { createTokenStore, mintToken, tokenDigest } from '../src/auth/token-store.js';
import { createUserStore } from '../src/auth/user-store.js';
import { ulid } from '../src/ulid.js';
import { createSqliteEngine, type SqliteEngine } from './helpers/sqlite-engine.js';

/**
 * Task 014-08 — the four admin operations, against a real engine.
 *
 * Every assertion here is about what an OPERATOR sees or what the journal records: the token value
 * appears once, the listing shows neither the value nor the digest, and each operation leaves a row
 * in `access_audit` (R-15.7).
 */

const PEPPER = 'test-pepper-08';
const NOW = 1_770_000_000_000;

let harness: SqliteEngine;
let deps: AdminDeps;
let adminId: string;

const ids = (): ((nowMs: number) => string) => {
  let n = 0;
  return (nowMs: number): string => {
    const seed = n++;
    return ulid(nowMs, () =>
      Uint8Array.from(
        Array.from({ length: 16 }, (_unused, index) =>
          index < 3 ? Math.floor(seed / 32 ** index) % 32 : 11,
        ),
      ),
    );
  };
};

beforeEach(async () => {
  harness = createSqliteEngine();
  const newId = ids();
  const users = createUserStore({ engine: harness.engine, now: () => NOW, newId });
  const tokens = createTokenStore({
    engine: harness.engine,
    pepper: PEPPER,
    now: () => NOW,
    newId,
  });
  deps = { users, tokens, engine: harness.engine, now: () => NOW, newId };
  // The seeded admin — the row `003_seed_engine_admin.sql` writes in production.
  adminId = (await users.createUser({ email: 'admin@example.com', role: 'admin' })).id;
});

afterEach(() => harness.close());

const auditRows = (): { action: string; target_id: string; actor_user_id: string | null }[] =>
  harness.db
    .prepare('SELECT action, target_id, actor_user_id FROM access_audit ORDER BY id')
    .all() as {
    action: string;
    target_id: string;
    actor_user_id: string | null;
  }[];

describe('TC-E2E-01: add a user, issue a token, revoke it', () => {
  it('writes three journal rows and leaves the token refusing', async () => {
    const added = await runAdminCommand(
      ['user:add', '--email', 'Analyst@Example.COM', '--role', 'user', '--actor', adminId],
      deps,
    );
    expect(added.code).toBe(0);
    expect(added.lines[0]).toContain('analyst@example.com'); // lowercased by the writer

    const issued = await runAdminCommand(
      ['token:issue', '--user', 'analyst@example.com', '--actor', adminId],
      deps,
    );
    expect(issued.code).toBe(0);
    const token = issued.lines[1] ?? '';
    const tokenId = /id=(\S+)/.exec(issued.lines[2] ?? '')?.[1] ?? '';
    expect(classifyToken(await deps.tokens.lookup(token), NOW).ok).toBe(true);

    const revoked = await runAdminCommand(
      ['token:revoke', '--token-id', tokenId, '--actor', adminId],
      deps,
    );
    expect(revoked.code).toBe(0);
    expect(classifyToken(await deps.tokens.lookup(token), NOW)).toStrictEqual({
      ok: false,
      refusalClass: 'auth.revoked',
    });

    // TC-UNIT-03: three operations, three rows, each naming the admin who performed it.
    const journal = auditRows();
    expect(journal.map((row) => row.action).sort()).toStrictEqual([
      'token.issue',
      'token.revoke',
      'user.create',
    ]);
    for (const row of journal) expect(row.actor_user_id).toBe(adminId);
  });
});

describe('TC-UNIT-01: the listing discloses neither the value nor the digest', () => {
  it('prints prefixes, owners and dates, and nothing that verifies', async () => {
    const issued = await runAdminCommand(
      ['token:issue', '--user', 'admin@example.com', '--actor', adminId],
      deps,
    );
    const token = issued.lines[1] ?? '';

    const listed = await runAdminCommand(['token:list'], deps);
    expect(listed.code).toBe(0);
    expect(listed.lines).toHaveLength(1);
    const line = listed.lines[0] ?? '';
    expect(line).toContain(token.slice(0, 11)); // the prefix identifies the row
    expect(line).toContain('admin@example.com');
    expect(line).toContain('active');
    expect(line, 'the value must never be listed').not.toContain(token);
    expect(line, 'the digest is a verifier').not.toContain(tokenDigest(PEPPER, token));
    // And no digest-shaped value at all — the assertion a mutation showed the narrower one misses.
    expect(line).not.toMatch(/\b[0-9a-f]{64}\b/);
  });

  it('shows a revoked token as revoked rather than hiding it', async () => {
    const issued = await runAdminCommand(
      ['token:issue', '--user', 'admin@example.com', '--actor', adminId],
      deps,
    );
    const tokenId = /id=(\S+)/.exec(issued.lines[2] ?? '')?.[1] ?? '';
    await runAdminCommand(['token:revoke', '--token-id', tokenId, '--actor', adminId], deps);
    // A listing that dropped revoked rows would make an operator's "is it gone?" unanswerable
    // without SQL — and the row is deliberately kept rather than deleted (§4.5.3).
    expect((await runAdminCommand(['token:list'], deps)).lines[0]).toContain('revoked');
  });

  it('filters by user, taking either an address or an id', async () => {
    await runAdminCommand(
      ['user:add', '--email', 'other@example.com', '--role', 'user', '--actor', adminId],
      deps,
    );
    await runAdminCommand(['token:issue', '--user', 'admin@example.com', '--actor', adminId], deps);
    await runAdminCommand(['token:issue', '--user', 'other@example.com', '--actor', adminId], deps);

    expect((await runAdminCommand(['token:list'], deps)).lines).toHaveLength(2);
    const mine = await runAdminCommand(['token:list', '--user', 'admin@example.com'], deps);
    expect(mine.lines).toHaveLength(1);
    expect(mine.lines[0]).toContain('admin@example.com');
    expect((await runAdminCommand(['token:list', '--user', adminId], deps)).lines).toStrictEqual(
      mine.lines,
    );
  });
});

describe('TC-UNIT-02: a value minted elsewhere is accepted', () => {
  it('stores the supplied token, and the server then finds it', async () => {
    // The owner mints the first token on their own machine (PROD-RUNBOOK step 1). A tool that could
    // only mint its own would leave that path to hand-written SQL.
    const supplied = mintToken();
    const issued = await runAdminCommand(
      ['token:issue', '--user', 'admin@example.com', '--actor', adminId, '--token', supplied],
      deps,
    );
    expect(issued.code).toBe(0);
    expect(issued.lines[1]).toBe(supplied);
    expect(classifyToken(await deps.tokens.lookup(supplied), NOW).ok).toBe(true);

    // Stored as a digest, like any other: the supplied value is nowhere in the table.
    const row = harness.db.prepare('SELECT token_hash, prefix FROM api_tokens').get() as {
      token_hash: string;
      prefix: string;
    };
    expect(row.token_hash).toBe(tokenDigest(PEPPER, supplied));
    expect(row.prefix).toBe(supplied.slice(0, 11));
  });

  it('refuses a value that is not in the §7.5.2 form, without printing it', async () => {
    // `openssl rand -base64 32` — the command PROD-RUNBOOK's first draft used. Its leading 11
    // characters are not the prefix the server computes, so the row would be identified by something
    // no reader could reproduce.
    const wrongShape = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=';
    await expect(
      runAdminCommand(
        ['token:issue', '--user', 'admin@example.com', '--actor', adminId, '--token', wrongShape],
        deps,
      ),
    ).rejects.toThrow(/security.md/);
    expect(
      (harness.db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get() as { n: number }).n,
    ).toBe(0);
  });

  it('never names the offending value in the refusal (D10)', async () => {
    const wrongShape = 'this-is-a-live-credential-someone-typed';
    const message = await runAdminCommand(
      ['token:issue', '--user', 'admin@example.com', '--actor', adminId, '--token', wrongShape],
      deps,
    )
      .then(() => '')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(message).not.toContain(wrongShape);
  });
});

describe('the operations refuse rather than guessing', () => {
  it('names the missing flag and exits non-zero', async () => {
    for (const argv of [
      ['user:add', '--email', 'x@example.com', '--role', 'user'],
      ['token:issue', '--actor', adminId],
      ['token:revoke', '--actor', adminId],
    ]) {
      const result = await runAdminCommand(argv, deps);
      expect(result.code).toBe(2);
      expect(result.lines[0]).toMatch(/is required/);
      expect(result.lines.join('\n')).toContain('usage:');
    }
  });

  it('refuses a role outside the two, naming both', async () => {
    const result = await runAdminCommand(
      ['user:add', '--email', 'x@example.com', '--role', 'owner', '--actor', adminId],
      deps,
    );
    expect(result.code).toBe(2);
    expect(result.lines[0]).toContain('admin or user');
    expect((await runAdminCommand(['token:list'], deps)).lines).toStrictEqual([]);
  });

  it('refuses an unknown actor or user instead of writing a row nobody owns', async () => {
    const result = await runAdminCommand(
      ['token:issue', '--user', 'absent@example.com', '--actor', adminId],
      deps,
    );
    expect(result.code).toBe(2);
    expect(result.lines[0]).toContain('absent@example.com');
    expect(auditRows()).toStrictEqual([]);
  });

  it('reports an unknown command with the usage, not with a stack', async () => {
    const result = await runAdminCommand(['token:rotate'], deps);
    expect(result.code).toBe(2);
    expect(result.lines[0]).toContain('token:rotate');
    expect(result.lines.join('\n')).toContain('token:revoke');
  });
});

describe('the four commands the usage advertises are the four that exist', () => {
  it('answers each of them, and the usage names no fifth', async () => {
    // A usage line for a command that does not exist is an instruction that fails when followed.
    const usage = (await runAdminCommand(['nope'], deps)).lines.join('\n');
    const advertised = [...usage.matchAll(/^ {2}(\S+)/gm)].map((match) => match[1]);
    expect(advertised.sort()).toStrictEqual([
      'token:issue',
      'token:list',
      'token:revoke',
      'user:add',
    ]);
    for (const command of advertised) {
      // Each one is reachable: it answers, or it says which flag is missing — never "unknown
      // command". `token:list` with no flags answers with an empty list, which is why this reads the
      // joined output rather than the first line.
      const result = await runAdminCommand([command ?? ''], deps);
      expect(result.lines.join('\n'), command).not.toContain('unknown command');
    }
  });

  it('defaults an issued token to the phase-0 profile both migrations seed', async () => {
    const issued = await runAdminCommand(
      ['token:issue', '--user', 'admin@example.com', '--actor', adminId],
      deps,
    );
    expect(issued.lines[2]).toContain(DEFAULT_ACCESS_PROFILE_ID);
    const row = harness.db.prepare('SELECT access_profile_id FROM api_tokens').get() as {
      access_profile_id: string;
    };
    expect(row.access_profile_id).toBe(DEFAULT_ACCESS_PROFILE_ID);
  });
});

describe('the runbook documents the CLI that exists', () => {
  /**
   * The acceptance criterion "the runbook section is reconciled with the implemented CLI", made
   * mechanical.
   *
   * **Why a gate and not a reading.** An operator procedure is followed under pressure by someone
   * who did not write it, and a command that no longer exists fails at the moment it is needed. This
   * repository has already paid for the same shape twice in this section alone: a mint command whose
   * output the server could not parse, and a `psql` invocation missing two of its five parameters.
   */
  const runbook = readFileSync(
    path.join(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
      'docs/onchain-analytics/PROD-RUNBOOK.md',
    ),
    'utf8',
  );

  it('names every command the CLI answers, and no command it does not', async () => {
    const usage = (await runAdminCommand(['nope'], deps)).lines.join('\n');
    const implemented = [...usage.matchAll(/^ {2}(\S+)/gm)].map((match) => match[1] as string);
    expect(implemented.length).toBeGreaterThan(0);

    const documented = [...runbook.matchAll(/\b(user:add|token:issue|token:list|token:revoke)\b/g)]
      .map((match) => match[1] as string)
      .filter((value, index, all) => all.indexOf(value) === index);
    expect(documented.sort(), 'the runbook names the four commands').toStrictEqual(
      [...implemented].sort(),
    );
  });

  it('names the seed migration by the file that exists', () => {
    expect(runbook).toContain('sql/migrations/003_seed_engine_admin.sql');
    // `0NN` was the placeholder while the number was undecided. An operator copying it gets "No such
    // file or directory" at the one step that has no alternative.
    expect(runbook).not.toContain('0NN_seed_engine_admin.sql');
  });

  it('passes every parameter the seed migration pre-checks', () => {
    const seed = readFileSync(
      path.join(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
        'sql/migrations/003_seed_engine_admin.sql',
      ),
      'utf8',
    );
    const required = [...seed.matchAll(/\\if :\{\?(\w+)\}/g)].map((match) => match[1] as string);
    expect(required.length).toBe(5);
    for (const parameter of required) {
      expect(runbook, `the runbook passes -v ${parameter}`).toContain(`-v ${parameter}=`);
    }
  });

  it('points at the minting script rather than at a shell recipe that mints the wrong shape', () => {
    expect(runbook).toContain('scripts/mint-admin-token.ts');
    // The command the first draft used. Its output carries `+`, `/` and `=`, is 44 characters, and
    // has no `oi_` label — the leading 11 characters are not the prefix the server computes, so the
    // seeded row is one the running server can never match.
    expect(runbook).not.toMatch(/TOKEN="?\$\(openssl rand -base64 32\)/);
  });
});
