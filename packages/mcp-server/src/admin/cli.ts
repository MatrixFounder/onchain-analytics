import type { TokenStore } from '../auth/token-store.js';
import type { UserStore } from '../auth/user-store.js';
import type { EngineStore } from '../engine/pg-engine-store.js';
import { ulid } from '../ulid.js';
import type { Role } from '../auth/identity-types.js';

/**
 * The four admin operations (task 014-08, R-15.4, R-15.7): `user:add`, `token:issue`,
 * `token:revoke`, `token:list`.
 *
 * **Why a CLI and not MCP tools.** These are operator actions, not request-path code
 * (`security.md` §7.5.2). A tool that issued tokens would put credential minting behind the same
 * transport it protects, reachable by anything holding a token — including one it just issued.
 *
 * **Why the command function returns its output instead of printing.** Every assertion this task
 * owes is about what an operator SEES: that `token:issue` shows the value once, and that
 * `token:list` shows neither the value nor the digest. Returning the lines makes those measurable
 * without capturing a stream, and `bin` below is the one place that prints.
 *
 * **The token value is shown once and stored nowhere.** It is not written to a file, not logged, and
 * not recoverable: the store keeps `sha256(pepper || token)` and the server compares digests
 * (§7.5.2). An operator who does not copy it repeats the issue.
 */

export interface AdminDeps {
  readonly users: UserStore;
  readonly tokens: TokenStore;
  readonly engine: EngineStore;
  readonly now: () => number;
  readonly newId?: (nowMs: number) => string;
}

export interface AdminResult {
  readonly code: number;
  readonly lines: readonly string[];
}

export class AdminUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminUsageError';
  }
}

/** The phase-0 access profile both migrations seed (`data-model.md` §4.5.3). */
export const DEFAULT_ACCESS_PROFILE_ID = '01JPHASE00000000000000000A';

const USAGE = [
  'usage:',
  '  user:add     --email <address> --role <admin|user> --actor <user-id> [--name <display name>]',
  '  token:issue  --user <address|user-id> --actor <user-id> [--profile <id>] [--name <label>]',
  '               [--expires-at <epoch-ms>] [--token <value minted elsewhere>]',
  '  token:revoke --token-id <id> --actor <user-id>',
  '  token:list   [--user <address|user-id>]',
];

/** `--flag value` pairs. Deliberately tiny: a dependency for four commands is a dependency. */
function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new AdminUsageError(`${token} needs a value`);
    }
    flags.set(token.slice(2), value);
    index += 1;
  }
  return flags;
}

const required = (flags: Map<string, string>, name: string): string => {
  const value = flags.get(name);
  if (value === undefined || value.trim() === '') {
    throw new AdminUsageError(`--${name} is required`);
  }
  return value;
};

/** Resolves an address or an id to a user id, so every command takes whichever the operator has. */
async function resolveUserId(users: UserStore, presented: string): Promise<string> {
  const found = presented.includes('@')
    ? await users.findUser({ email: presented })
    : await users.findUser({ id: presented });
  if (found === null) throw new AdminUsageError(`no user matches ${JSON.stringify(presented)}`);
  return found.id;
}

/**
 * Runs one admin command.
 *
 * Errors of the operator's own making (`AdminUsageError`) come back as a non-zero code with their
 * message; anything else propagates, because a failure inside the store is not a usage problem and
 * hiding it behind an exit code would make a broken database look like a typo.
 */
export async function runAdminCommand(
  argv: readonly string[],
  deps: AdminDeps,
): Promise<AdminResult> {
  const [command, ...rest] = argv;
  const newId = deps.newId ?? ((nowMs: number): string => ulid(nowMs));

  try {
    const flags = parseFlags(rest);
    switch (command) {
      case 'user:add': {
        const role = required(flags, 'role');
        if (role !== 'admin' && role !== 'user') {
          // The engine's CHECK would refuse it too; refusing here names the two admissible values
          // instead of surfacing a constraint name.
          throw new AdminUsageError(`--role must be admin or user, got ${JSON.stringify(role)}`);
        }
        // BOOTSTRAP — the first user of an EMPTY store, and the only case where `--actor` may be
        // omitted (task 014-33).
        //
        // **Why it has to exist.** A user needs an actor and an actor is a user, so an empty store
        // is a deadlock. The Postgres axis escapes it through migration 003, which seeds the first
        // administrator and writes its two journal rows with a NULL actor. The SQLite axis has no
        // migration, so before this there was NO WAY to create a first administrator on it at all —
        // and `network-sqlite` exists precisely to raise the transport without Postgres. The
        // profile starts (its pre-start checks are `network`-only), binds a port, and refuses every
        // request, because no token can be issued to reach it.
        //
        // **Why it cannot be abused later.** The escape is gated on the store being EMPTY, not on a
        // flag. Once one user exists, `--actor` is required again and resolved as before, so this
        // widens nothing for an installation that has an administrator.
        //
        // **Why the first user must be an admin.** Seeding a non-admin would leave the store with a
        // user nobody can act as, and the deadlock intact one row further in.
        const bootstrap = !flags.has('actor') && (await deps.users.listUsers()).length === 0;
        if (bootstrap && role !== 'admin') {
          throw new AdminUsageError(
            'the first user of an empty store is created without --actor and must be --role admin; ' +
              'a first non-admin leaves nobody who can act',
          );
        }
        const actorId = bootstrap
          ? null
          : await resolveUserId(deps.users, required(flags, 'actor'));
        const created = await deps.users.createUser({
          email: required(flags, 'email'),
          role: role as Role,
          ...(flags.has('name') ? { displayName: flags.get('name') ?? null } : {}),
        });
        // R-15.7: every admin operation writes a journal row. `createUser` does not write one
        // itself — unlike `issue` and `revoke`, whose rows must be atomic with a credential change —
        // so this composes it, and the test asserts the row exists rather than trusting the call.
        const ts = deps.now();
        await deps.tokens.appendAudit({
          id: newId(ts),
          ts,
          actorUserId: actorId,
          action: 'user.create',
          targetType: 'user',
          targetId: created.id,
          beforeJson: null,
          afterJson: JSON.stringify({ role: created.role, status: created.status }),
          createdAt: ts,
        });
        return {
          code: 0,
          lines: [`user ${created.id} ${created.email} role=${created.role}`],
        };
      }

      case 'token:issue': {
        const userId = await resolveUserId(deps.users, required(flags, 'user'));
        const actorId = await resolveUserId(deps.users, required(flags, 'actor'));
        const profileId = flags.get('profile') ?? DEFAULT_ACCESS_PROFILE_ID;
        const expiresAt = flags.get('expires-at');
        const issued = await deps.tokens.issue(userId, profileId, actorId, {
          ...(flags.has('name') ? { name: flags.get('name') ?? null } : {}),
          ...(expiresAt === undefined ? {} : { expiresAt: Number(expiresAt) }),
          // The owner mints the first token themselves (§7.5.2, PROD-RUNBOOK step 1), so the tool
          // must be able to store a value it did not create. The store checks its shape.
          ...(flags.has('token') ? { token: flags.get('token') ?? '' } : {}),
        });
        return {
          code: 0,
          lines: [
            // Shown once. The owner asked to be able to mint the value themselves, so `--token`
            // exists; either way the value leaves this process only here.
            'the token, shown once — copy it now, it is not stored and cannot be recovered:',
            issued.token,
            `id=${issued.id} prefix=${issued.prefix} profile=${profileId}`,
          ],
        };
      }

      case 'token:revoke': {
        const actorId = await resolveUserId(deps.users, required(flags, 'actor'));
        const tokenId = required(flags, 'token-id');
        await deps.tokens.revoke(tokenId, actorId);
        return { code: 0, lines: [`revoked ${tokenId}`] };
      }

      case 'token:list': {
        const presented = flags.get('user');
        const userId = presented === undefined ? null : await resolveUserId(deps.users, presented);
        // The SELECT names its columns rather than `*`: a `SELECT *` here would put `token_hash`
        // into a listing the moment somebody printed the row, which is the one thing this command
        // must never do.
        const rows = await deps.engine.query<{
          prefix: string;
          email: string;
          status: string;
          created_at: number | string;
          expires_at: number | string | null;
          id: string;
        }>(
          `SELECT t.id, t.prefix, u.email, t.status, t.created_at, t.expires_at
             FROM ${deps.engine.qualify('api_tokens')} t
             JOIN ${deps.engine.qualify('users')} u ON u.id = t.user_id
            ${userId === null ? '' : 'WHERE t.user_id = $1'}
            ORDER BY t.id`,
          userId === null ? [] : [userId],
        );
        return {
          code: 0,
          lines: rows.map(
            (row) =>
              `${row.prefix}  ${row.email}  ${row.status}  created=${row.created_at}  expires=${row.expires_at ?? '-'}  id=${row.id}`,
          ),
        };
      }

      default:
        return { code: 2, lines: [`unknown command ${JSON.stringify(command ?? '')}`, ...USAGE] };
    }
  } catch (error) {
    if (error instanceof AdminUsageError) return { code: 2, lines: [error.message, ...USAGE] };
    throw error;
  }
}
