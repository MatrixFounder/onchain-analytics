/**
 * The deployment profile: one key resolved once at start into a transport and a storage axis.
 *
 * **Why a profile name and not two keys.** Transport and storage are independent — one decides who
 * reaches the process, the other where its state lives — so two keys would make all four
 * combinations settable, including stdio over Postgres, which this project does not design. A
 * combination no document named is a configuration covered by no gate and no live-gate case
 * (`docs/architectures/deployment.md` §10.1.1, `system-architecture.md` §3.4.8).
 *
 * **Why the default is `local`.** `EnvSchema.parse({})` has to keep passing (R-13.5), so an empty
 * environment must resolve to the profile that requires no setting at all.
 *
 * **What this module decides and what it does not.** It resolves the pair and runs the network
 * profile's pre-start checks. It constructs neither the transport (task 014-09) nor the Postgres
 * stores (task 014-39): those read `storage` and `transport` off the descriptor below. Keeping the
 * choice separate from the construction is what lets the checks run before a socket is bound.
 */

/** Who can reach the process. */
export type TransportKind = 'stdio' | 'http';

/** Where the process keeps its own state. */
export type StorageKind = 'sqlite' | 'postgres';

export type ProfileName = 'local' | 'network' | 'network-sqlite';

/**
 * The three names as a value, so ONE vocabulary serves both entry points.
 *
 * **Why this export exists** (task 014-40). `EnvSchema` has to refuse `ONCHAIN_PROFILE=remote` at
 * the process boundary, and `resolveProfile` below has to refuse the same value on an injected
 * record. Spelling the three names twice would give one key two sets of admissible values — the
 * failure the declaring task exists to prevent — and the disagreement would surface as a profile
 * that parses and then throws, or throws and would have parsed.
 *
 * A tuple rather than `Object.keys(PROFILES)`: `z.enum` needs a non-empty tuple TYPE, which
 * `string[]` is not. `PROFILES` is built from these names and a test compares the two, so the tuple
 * cannot fall behind the table.
 */
export const PROFILE_NAMES = ['local', 'network', 'network-sqlite'] as const satisfies readonly [
  ProfileName,
  ...ProfileName[],
];

export interface DeploymentProfile {
  readonly name: ProfileName;
  readonly transport: TransportKind;
  readonly storage: StorageKind;
}

/**
 * The three named combinations, and the only three.
 *
 * Declared as data rather than as a switch so a test can walk them: a fourth pair cannot be added
 * without appearing here, and `PROFILES` is what both the resolver and its gate read.
 */
export const PROFILES: Readonly<Record<ProfileName, DeploymentProfile>> = Object.freeze({
  local: { name: 'local', transport: 'stdio', storage: 'sqlite' },
  network: { name: 'network', transport: 'http', storage: 'postgres' },
  'network-sqlite': { name: 'network-sqlite', transport: 'http', storage: 'sqlite' },
});

export const DEFAULT_PROFILE: ProfileName = 'local';

/** Thrown for an unknown `ONCHAIN_PROFILE`; carries no value of any other key (D10). */
export class UnknownProfileError extends Error {
  constructor(readonly presented: string) {
    super(
      `ONCHAIN_PROFILE must be one of ${Object.keys(PROFILES).join(', ')} — got ${JSON.stringify(presented)}`,
    );
    this.name = 'UnknownProfileError';
  }
}

/**
 * Resolves the profile from an injected environment record.
 *
 * **Why the record is a parameter and not `process.env`.** R-13.3a forbids a consumer reading the
 * environment directly; injection is the sanctioned form, and it is also what makes every case
 * below testable without mutating the process.
 *
 * An unset or empty value resolves to `local` — the same treatment `EnvSchema` gives every optional
 * key, so a `.env` with `ONCHAIN_PROFILE=` behaves as if the line were absent rather than failing.
 */
export function resolveProfile(raw: NodeJS.ProcessEnv = {}): DeploymentProfile {
  const presented = raw['ONCHAIN_PROFILE']?.trim();
  if (presented === undefined || presented === '') return PROFILES[DEFAULT_PROFILE];
  if (presented in PROFILES) return PROFILES[presented as ProfileName];
  throw new UnknownProfileError(presented);
}

/**
 * One pre-start check of the network profile.
 *
 * `probe` may be `null` while the code it would call does not exist yet. That is a stated gap, not
 * a silent one: `owner` names the task that supplies it, and a gate asserts every unwired check
 * still names an owner. A check that quietly passed because nothing ran it would be the shape this
 * project keeps paying for (L-10) — an answer of "fine" from a question nobody asked.
 */
export type PreStartCheckId = 'state-dsn' | 'state-store' | 'active-token';

export interface PreStartCheck {
  readonly id: PreStartCheckId;
  readonly name: string;
  readonly owner: string;
  readonly probe: ((raw: NodeJS.ProcessEnv) => Promise<boolean>) | null;
}

export class PreStartCheckFailed extends Error {
  constructor(readonly check: string) {
    super(`network profile pre-start check failed: ${check}`);
    this.name = 'PreStartCheckFailed';
  }
}

/**
 * The network profile's pre-start checks, in the order `deployment.md` §10.3.2 fixes.
 *
 * **Why this order.** The DSN is checked first because the two after it cannot run without it, and
 * the token check is last because it is the only one that needs a schema to already exist.
 */
export function networkPreStartChecks(
  /**
   * Probes supplied by the caller, keyed by check id.
   *
   * **Why they arrive from outside.** The last two need a database connection, and this module
   * resolves the profile BEFORE anything is constructed — that separation is what lets the checks
   * run before a socket is bound. `index.ts` opens the client and hands its probes in.
   */
  probes: Partial<Record<PreStartCheckId, (raw: NodeJS.ProcessEnv) => Promise<boolean>>> = {},
): readonly PreStartCheck[] {
  return [
    {
      id: 'state-dsn',
      name: 'ONCHAIN_STATE_PG_URL is set',
      owner: 'this task',
      probe: (raw) => Promise.resolve((raw['ONCHAIN_STATE_PG_URL']?.trim() ?? '') !== ''),
    },
    {
      id: 'state-store',
      name: 'the state store answers',
      // Owner corrected from 014-39 to 014-12: 014-39 built the client, and this check is one
      // statement over the connection 014-12 opens anyway for the token check below. An owner named
      // for a task that does not do the work is the silence this field exists to prevent.
      owner: 'task 014-12',
      probe: probes['state-store'] ?? null,
    },
    {
      id: 'active-token',
      name: 'api_tokens holds a live active row',
      // Owner corrected from 014-07 while 014-07 landed: that task supplies the store and the
      // refusal classes; the STARTUP refusal is 014-12's own section.
      owner: 'task 014-12',
      probe: probes['active-token'] ?? null,
    },
  ];
}

/**
 * Runs the pre-start checks of the network profile, in order, and throws on the first failure.
 *
 * **Why only the network profile.** `local` needs no token and `network-sqlite` exists precisely to
 * raise the transport without Postgres; running a DSN check for either would make the debugging
 * profile useless and the local one impossible.
 *
 * **Why this refuses instead of falling back to SQLite.** A downgrade with no refusal would put the
 * server's tokens, traces and spend ledger in a local file while every gate reported success — the
 * L-10 defect exactly. A missing or misspelled DSN must not select the SQLite axis.
 *
 * The caller binds no socket until this resolves. A listener that exists before the checks is an
 * unauthenticated surface for the duration of the checks.
 */
export class TransportNotShippedError extends Error {
  constructor(
    readonly profile: ProfileName,
    readonly transport: TransportKind,
  ) {
    super(
      `profile ${profile} needs the ${transport} transport, which this build does not carry; refusing to start on another transport instead`,
    );
    this.name = 'TransportNotShippedError';
  }
}

/**
 * Refuses a profile whose transport this build does not carry.
 *
 * **Why a refusal and not a fallback to stdio.** A fallback hands the operator a process that
 * answers — on a transport they did not configure, with no token check in front of it — while the
 * configuration says otherwise. That is the same shape as downgrading Postgres to SQLite: the
 * process works, every gate is green, and the thing that was asked for is not what is running.
 *
 * `available` is a parameter so this stays true as transports arrive: task 014-09 added `'http'` to
 * the set, and the test below fails the day the set and the profile table disagree.
 */
export function assertTransportAvailable(
  profile: DeploymentProfile,
  available: readonly TransportKind[],
): void {
  if (!available.includes(profile.transport)) {
    throw new TransportNotShippedError(profile.name, profile.transport);
  }
}

/**
 * The transports this build can attach.
 *
 * `'http'` joined the set with task 014-09, which is what makes the refusal above a live check
 * rather than a permanent no: a profile naming a transport this build does not carry still refuses,
 * and the set is the one thing to edit when that changes.
 */
export const SHIPPED_TRANSPORTS: readonly TransportKind[] = ['stdio', 'http'];

export async function assertNetworkPreconditions(
  profile: DeploymentProfile,
  raw: NodeJS.ProcessEnv,
  checks: readonly PreStartCheck[] = networkPreStartChecks(),
): Promise<void> {
  if (profile.name !== 'network') return;
  for (const check of checks) {
    if (check.probe === null) continue;
    if (!(await check.probe(raw))) throw new PreStartCheckFailed(check.name);
  }
}
