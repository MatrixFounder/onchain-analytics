import { z } from 'zod';
import { DAILY_CAP_OFF, MAX_CALLS_OFF, VELOCITY_OFF } from '@onchain-intel/core';
import { PROFILE_NAMES } from './profile.js';

/**
 * Wraps an optional zod schema so an empty string is treated identically to the key being unset
 * (task 001-4's `LOG_LEVEL` fix, generalized here — task 003-6, R-23 — since all 4 new M1 keys
 * need the identical idiom: a shell exporting `KEY=` with no value, or a blank `.env` line, should
 * behave the same as the var being absent entirely, not fail validation / silently become `""`).
 */
function emptyAsUndefined<T extends z.ZodType>(schema: T): z.ZodPreprocess<T> {
  return z.preprocess((v) => (v === '' ? undefined : v), schema);
}

/**
 * A comma-separated list of non-empty items — the shape of the two perimeter keys (task 014-40).
 *
 * **Why the list is parsed here and not by its consumer.** `ONCHAIN_ALLOWED_HOSTS` and
 * `ONCHAIN_ALLOWED_ORIGINS` become the `allowedHosts` / `allowedOrigins` ARRAYS the SDK transport
 * takes (`security.md` §7.5.4), and our own check in front of the SDK's reads the same two settings.
 * Two consumers splitting one string is two chances to split it differently, on a perimeter where
 * the disagreement is an admitted caller.
 *
 * **Why empty items are dropped and an empty result is refused.** A trailing comma cannot delete an
 * entry the operator wrote, so forgiving it costs nothing. A value that yields NO entries is the
 * opposite: `ONCHAIN_ALLOWED_HOSTS=", ,"` would configure a perimeter that admits nothing while
 * reading, to the operator, as configured. That is refused by the key's own name (D10: the message
 * carries the key, never the value).
 *
 * What this deliberately does NOT decide: how a `Host` or an `Origin` is MATCHED — lowercasing, the
 * implied port, the exact-comparison rule. That is `security.md` §7.5.4 and task 014-11.
 */
const commaSeparatedList = z
  .string()
  .transform((raw) =>
    raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== ''),
  )
  .pipe(z.array(z.string()).min(1));

/**
 * The floor under `ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS`, derived from the capability manifest.
 *
 * `deadlineMs` bounds the cancellable part of a call and `paidLegMs` is uncut, so the worst case a
 * single response may legitimately occupy is the largest `deadlineMs + paidLegMs` over the manifest:
 * 60 000 + 270 000 on `entity.labels` (`deployment.md` §10.3, `interfaces.md` §5.4.5, measured over
 * all 26 rows 2026-08-13).
 *
 * **Why a constant with a test behind it rather than a computation.** Deriving it at module load
 * would make the floor follow the manifest silently, and a manifest row that raised the worst case
 * would quietly raise the floor under a value an operator had already set — turning their working
 * configuration invalid at the next release with no statement anywhere. The number is written down,
 * and `env.test.ts` recomputes it from the manifest, so the day a row exceeds it the suite says so.
 */
export const HTTP_RESPONSE_TIMEOUT_FLOOR_MS = 330_000;

/**
 * The four defaults `deployment.md` §10.3 declares for T-014's keys.
 *
 * **Why they are not `.default()` inside the schema.** `EnvSchema.parse({})` returns `{}` today, and
 * a test asserts exactly that (`env.test.ts`, `strips unknown env keys`); a zod default would make
 * an unset key indistinguishable from a set one at the type level, which is the L-10 shape — a value
 * arriving with no way to tell whether anybody chose it.
 *
 * `ONCHAIN_PROFILE` is absent from this record on purpose: its default is `local` and `profile.ts`
 * already owns it (`DEFAULT_PROFILE`), because the profile is resolved from a raw environment record
 * before `loadEnv` runs in some call paths. `ONCHAIN_HTTP_PORT` is absent because §10.3 declares no
 * default for it, and inventing one here would be this file deciding a deployment fact.
 */
export const DEFAULT_HTTP_BIND = '127.0.0.1';
export const DEFAULT_HTTP_RESPONSE_TIMEOUT_MS = 360_000;
export const DEFAULT_SESSION_MAX = 64;
export const DEFAULT_SESSION_IDLE_MS = 900_000;

/**
 * Process environment configuration for the MCP server.
 *
 * M0 (ADR-001 free-first phase, R-12): every key is OPTIONAL — there are no required secrets
 * yet. `LOG_LEVEL` is reserved for future diagnostic tuning.
 *
 * M1 (ARCHITECTURE.md §3.2/§10.3, R-23) adds 4 more optional keys — still no REQUIRED key
 * (`EnvSchema.parse({})` keeps succeeding, UC-1/R-27): `COINGECKO_API_KEY`/`DUNE_API_KEY` (read by
 * `@onchain-intel/core`'s `coingecko`/`dune` adapters), `ONCHAIN_PG_URL` (the `pg-history` read-only
 * Postgres DSN — `z.string().url()`; confirmed empirically that zod 4.4.3's WHATWG URL parsing
 * accepts a realistic `postgres://user:pass@host:5432/db` DSN, including a percent-encoded special
 * character in the password and a query string, ARCHITECTURE.md §11 dev-time check — no fallback
 * regex needed), `DATA_DIR` (the cache directory override `@onchain-intel/core`'s
 * `resolveDataDir()` already reads, task 003-3). Every one of these 4 is read ONLY by
 * `@onchain-intel/core` adapters/cache — never logged, never folded into a cache key (D10/§7.2).
 *
 * Deliberately NOT `.strict()`: the real input is `process.env`, which carries hundreds of
 * unrelated keys (PATH, HOME, ...). Zod's default `z.object()` behavior strips unknown keys
 * instead of rejecting them, so `EnvSchema.parse(process.env)` succeeds regardless of what else
 * is set in the shell.
 *
 * Every key here is wrapped in `emptyAsUndefined` so a blank value behaves as absent (see its own
 * docstring above).
 *
 * M2 (TASK-005, task 005-6, R-46) adds 3 more optional keys — same "`EnvSchema.parse({})` keeps
 * succeeding" invariant, still no REQUIRED key: `NANSEN_API_KEY` (read by `@onchain-intel/core`'s
 * `nansen` adapter — the first PAID one, budget-gated D6), `NANSEN_DAILY_CREDIT_CAP` (an optional
 * self-imposed ceiling — `z.coerce.number()` since env vars always arrive as strings; can only
 * NARROW the live vendor ceiling, never widen it, `budget-gate.ts`'s `effectiveCeilingFor()`),
 * `NANSEN_BUDGET_WARN_RATIO` (the stderr warn-threshold fraction, default 0.8 inside
 * `budget-gate.ts` itself when this key is unset — `.min(0).max(1)`, a ratio, not a credit count).
 */
export const EnvSchema = z.object({
  LOG_LEVEL: emptyAsUndefined(z.enum(['debug', 'info', 'warn', 'error']).optional()),
  COINGECKO_API_KEY: emptyAsUndefined(z.string().optional()),
  // Post-M1 fix (2026-07-23): CoinGecko's Pro subscription is a SEPARATE auth contour (host
  // pro-api.coingecko.com + `x-cg-pro-api-key` header) — a pro key sent through the demo path
  // simply fails, so it gets its own explicit key. Which var is set declares the contour (key
  // format is identical across tiers — cannot be sniffed); pro wins when both are set.
  COINGECKO_PRO_API_KEY: emptyAsUndefined(z.string().optional()),
  DUNE_API_KEY: emptyAsUndefined(z.string().optional()),
  // TASK-008 R-79(a) — optional, like every key here, and validated for the reason the others are
  // not: this is the only secret the engine sends as a QUERY PARAMETER (the vendor's choice), so a
  // malformed value does not fail loudly at the auth layer — it ships as `apikey=%20` and the
  // facade answers 200 anyway during the grace period. `.trim().min(1)` rather than a bare
  // `z.string()`: `echo key >> .env` leaves a trailing newline and a shell `KEY=" "` leaves a
  // space, both of which pass `apiKey.length > 0` inside the adapter and become a silent total auth
  // failure the day enforcement lands. Trimming here means the adapter never sees a value that
  // looks present and is not. Found by vdd-multi iteration 2 (sec M-4): this key was outside the
  // validated surface entirely, and `.env.example` told the operator otherwise.
  BLOCKSCOUT_PRO_API_KEY: emptyAsUndefined(
    z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1))
      .optional(),
  ),
  ONCHAIN_PG_URL: emptyAsUndefined(z.string().url().optional()),
  DATA_DIR: emptyAsUndefined(z.string().optional()),
  // M2 (task 005-6, R-46) — see this schema's own docstring above for the 3-key rationale.
  NANSEN_API_KEY: emptyAsUndefined(z.string().optional()),
  // Three states (Q-2): UNSET → the engine derives a conservative default from the live balance
  // (max(30, 25% of remaining), pinned per day-bucket); a POSITIVE INTEGER → that explicit ceiling;
  // the literal `off` → no self-imposed ceiling at all, leaving only the vendor remainder.
  // `off` is a word, not `0`, on purpose: `0` is one typo/truncation away from silently disabling a
  // money guard, and semantically ought to mean "spend nothing". `0` therefore stays INVALID.
  NANSEN_DAILY_CREDIT_CAP: emptyAsUndefined(
    z.union([z.literal(DAILY_CAP_OFF), z.coerce.number().int().positive()]).optional(),
  ),
  // SEC-1 — the rate brake in front of the daily ceiling. Same shape as the daily cap for the same
  // reasons: `'off'` as a WORD (never `0`, which on a money guard should mean "spend nothing"), and
  // a positive integer otherwise. Unset ⇒ derived from the ceiling in force (`deriveVelocityCap`).
  NANSEN_VELOCITY_CREDITS_PER_MIN: emptyAsUndefined(
    z.union([z.literal(VELOCITY_OFF), z.coerce.number().int().positive()]).optional(),
  ),
  // Q-3 — the CALL limit. A different DENOMINATOR from the two above, not a tighter number: it is
  // the only bound that can see a tier priced at zero credits. Fixed default (60), not derived —
  // see `DEFAULT_MAX_CALLS_PER_WINDOW` for why a call does not scale with the plan.
  NANSEN_MAX_CALLS_PER_MIN: emptyAsUndefined(
    z.union([z.literal(MAX_CALLS_OFF), z.coerce.number().int().positive()]).optional(),
  ),
  NANSEN_BUDGET_WARN_RATIO: emptyAsUndefined(z.coerce.number().min(0).max(1).optional()),

  // -----------------------------------------------------------------------------------------------
  // T-014 (task 014-40, `deployment.md` §10.3) — ten keys: nine bootstrap, one secret.
  //
  // Every one of them is optional, like the twelve above, and for a requirement rather than a habit:
  // `EnvSchema.parse({})` must keep succeeding (R-13.5), and the network profile's "no token, no
  // start" rule is a PRE-START CHECK rather than a schema rule precisely so that stays true
  // (§10.3.2, `profile.ts`'s `networkPreStartChecks`). A required key here would stop the LOCAL
  // profile from starting too.
  //
  // T-014 adds no key of the NARROWING class (§10.3.1). Every narrowing value it introduces is
  // carried outside `EnvSchema` — the access-profile reader for the three limits and route
  // disclosure, the `onchain-retention` workflow's parameter node for the three windows — and the
  // classification registry of task 014-05 is where that claim is checked rather than asserted.
  // -----------------------------------------------------------------------------------------------

  // The vocabulary comes from `profile.ts`, not from a second literal here — see `PROFILE_NAMES`.
  // Unset resolves to `local` in `resolveProfile`, which is why this field carries no default.
  ONCHAIN_PROFILE: emptyAsUndefined(z.enum(PROFILE_NAMES).optional()),
  // The engine's OWN state, read-write, in schema `onchain` (§10.5) — a different DSN and a
  // different role from the read-only `ONCHAIN_PG_URL` above, which serves the `pg-history` adapter.
  // Reusing one DSN for both would give a read path write privileges; the two keys exist so the
  // grants can differ (`sql/migrations/002_t014_network_profile.sql`).
  ONCHAIN_STATE_PG_URL: emptyAsUndefined(z.string().url().optional()),
  // Unset means loopback (R-12.4, AC-34) — see `DEFAULT_HTTP_BIND`. A non-loopback bind is always an
  // explicit act.
  ONCHAIN_HTTP_BIND: emptyAsUndefined(z.string().optional()),
  // §10.3 declares no default port, so an unset value is not a port — it is a decision the operator
  // has not made, and task 014-11 refuses rather than guessing. The range is validated here so a
  // typo is reported against the KEY, in the one place that reports keys without their values,
  // instead of surfacing as an ERR_SOCKET_BAD_PORT from inside the listener.
  ONCHAIN_HTTP_PORT: emptyAsUndefined(z.coerce.number().int().min(1).max(65_535).optional()),
  // Bounded from BELOW by the capability manifest (R-16.3) — see `HTTP_RESPONSE_TIMEOUT_FLOOR_MS`.
  // `gt`, not `gte`: 330 000 is the worst case a lawful call may occupy, so a response window equal
  // to it cuts that call at the instant it would have answered.
  //
  // **Why the schema refuses instead of clamping.** A clamp would silently convert an operator's
  // stated intent into a different number and cut calls that were completing lawfully, with nothing
  // in the process able to report which value was in force.
  ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS: emptyAsUndefined(
    z.coerce.number().int().gt(HTTP_RESPONSE_TIMEOUT_FLOOR_MS).optional(),
  ),
  // The two perimeter keys (R-12.1, R-12.2, R-12.5). BOOTSTRAP, not narrowing (R-29.3): adding a
  // `Host` or an `Origin` ADMITS a caller who was refused before, and the narrowing class is defined
  // by every admissible value only ever restricting. This is also why neither may move to Postgres.
  ONCHAIN_ALLOWED_HOSTS: emptyAsUndefined(commaSeparatedList.optional()),
  ONCHAIN_ALLOWED_ORIGINS: emptyAsUndefined(commaSeparatedList.optional()),
  // The pepper mixed into `api_tokens.token_hash` = `sha256(pepper || presented)` (R-29.1,
  // `security.md` §7.5.2). Trimmed and required non-empty for the reason BLOCKSCOUT_PRO_API_KEY is:
  // `echo salt >> .env` leaves a newline and a shell `KEY=" "` leaves a space. Here the cost is
  // worse than a failed call — a pepper differing by one invisible character produces digests that
  // verify against nothing, so every issued token stops working at once and the value that broke it
  // cannot be printed to find out why.
  ONCHAIN_TOKEN_HASH_SALT: emptyAsUndefined(
    z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1))
      .optional(),
  ),
  // The two session settings (R-24.1, R-24.2). Both are transport CONSTRUCTION parameters, read
  // before the first session exists, and raising either widens what the process accepts — so both
  // are bootstrap, not narrowing, even though `system-architecture.md` §3.4.2 calls the session
  // ceiling a limit. Defaults 64 and 900 000 ms; the ceiling is APPLIED, not measured (§3.4.2), and
  // task 014-13 carries that statement to the place it is enforced.
  ONCHAIN_SESSION_MAX: emptyAsUndefined(z.coerce.number().int().positive().optional()),
  ONCHAIN_SESSION_IDLE_MS: emptyAsUndefined(z.coerce.number().int().positive().optional()),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Narrows the validated `Env` down to a plain, string-only `NodeJS.ProcessEnv`-shaped view (task
 * 005-6, R-46 collateral fix): `@onchain-intel/core`'s adapters (`createCoingeckoAdapter`/
 * `createPgHistoryAdapter`/`createNansenAdapter`) all declare `Deps.env?: NodeJS.ProcessEnv` — a
 * contract that predates R-46's two `z.coerce.number()` keys (`NANSEN_DAILY_CREDIT_CAP`/
 * `NANSEN_BUDGET_WARN_RATIO`), which are genuinely numbers at the type level (mandated by this
 * task's own reviewer note — `z.coerce.number()`, not a string) and therefore make the WHOLE `Env`
 * object structurally incompatible with a `{[key: string]: string | undefined}` index signature.
 * Those two keys are never read via `env` by any adapter anyway — they reach `nansen` as SEPARATE,
 * already-numeric `dailyCreditCap`/`budgetWarnRatio` params (`index.ts`'s own
 * `createProductionNansenAdapter`) — so this is a pure type-level projection, dropping exactly the
 * fields no `NodeJS.ProcessEnv`-typed consumer ever needed from `env` in the first place; every
 * remaining field's runtime VALUE is untouched.
 *
 * **Why the projection is a value filter and not a list of names** (changed by task 014-40). It used
 * to destructure the four non-string keys out by name. That form was compiler-enforced — a new
 * numeric key made `rest` structurally incompatible and `typecheck` said so — but T-014 takes the
 * count from four to ten, and a hand-maintained list of ten is the shape this repository keeps
 * paying for: a fact living in two places, updated in one. The predicate cannot fall behind, because
 * it states the rule the destructuring was an instance of: `NodeJS.ProcessEnv` holds strings, so a
 * field that is not one is not part of this view. `env.test.ts` names the dropped keys, so a key
 * that silently changes type still surfaces as a red test rather than as an adapter reading
 * `undefined`.
 */
export function toProcessEnv(env: Env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/**
 * The four settings §10.3 gives a default, resolved (task 014-40).
 *
 * **Why a function rather than four `??` at four call sites.** The consumers are four different
 * tasks — 014-11 binds the listener, 014-13 builds the session manager, 014-23 sets the response
 * window — and a default restated per consumer is the defect this repository keeps re-diagnosing:
 * one fact in several places, corrected in one of them. Here the `??` is written once and every
 * consumer reads the same answer.
 *
 * **Why the other six T-014 keys are not here.** `ONCHAIN_PROFILE` is defaulted by `resolveProfile`
 * (a raw environment record reaches it before `loadEnv` in some paths). `ONCHAIN_HTTP_PORT`,
 * `ONCHAIN_STATE_PG_URL` and `ONCHAIN_TOKEN_HASH_SALT` have no default at all — an unset value there
 * is a missing decision, and the network profile's pre-start checks refuse rather than invent one.
 * The two perimeter lists default to values only the bound listener knows (`security.md` §7.5.4:
 * "the bound address and port"), so 014-11 computes them where that is known.
 */
export interface DefaultedSettings {
  readonly httpBind: string;
  readonly httpResponseTimeoutMs: number;
  readonly sessionMax: number;
  readonly sessionIdleMs: number;
}

export function withDeclaredDefaults(env: Env): DefaultedSettings {
  return {
    httpBind: env.ONCHAIN_HTTP_BIND ?? DEFAULT_HTTP_BIND,
    httpResponseTimeoutMs: env.ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS ?? DEFAULT_HTTP_RESPONSE_TIMEOUT_MS,
    sessionMax: env.ONCHAIN_SESSION_MAX ?? DEFAULT_SESSION_MAX,
    sessionIdleMs: env.ONCHAIN_SESSION_IDLE_MS ?? DEFAULT_SESSION_IDLE_MS,
  };
}

/** True if `error` is a Node `ENOENT` (file not found) error. */
function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Parses and validates process environment configuration.
 *
 * @param raw - Explicit environment source. Tests pass a plain object here to avoid touching
 *   the real `process.env` / filesystem. When omitted (the real `index.ts` call site), this
 *   also attempts to load a `.env` file into `process.env` via Node's built-in
 *   `process.loadEnvFile()` (stable on Node >=20.12, well within our Node 22 LTS floor — no
 *   `dotenv` dependency needed). A missing `.env` is expected in M0 (no required secrets, R-12)
 *   and is silently ignored; any other load error is reported to stderr but does not abort
 *   startup, since `.env` loading is a convenience, not a hard requirement.
 *
 * Fail-fast contract (ARCHITECTURE.md §7.2, D10): on an invalid value, writes a message to
 * stderr naming ONLY the offending key(s) — never the value — then throws. `loadEnv` itself
 * never calls `process.exit`, so it stays a plain, unit-testable function; `index.ts` decides
 * how to turn the throw into a clean process exit.
 */
export function loadEnv(raw?: NodeJS.ProcessEnv): Env {
  if (raw === undefined) {
    try {
      process.loadEnvFile();
    } catch (error) {
      if (!isEnoent(error)) {
        console.error(
          `onchain-intel-mcp-server: warning: could not load .env: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const result = EnvSchema.safeParse(raw ?? process.env);
  if (!result.success) {
    // `map(String)` before `join`: `issue.path` is `PropertyKey[]` and `join` throws on a symbol
    // element. Second of the two sites — `tools/contract-violation.ts` is the other, and fixing
    // only that one is the half-application this repo keeps diagnosing.
    const keys = [
      ...new Set(result.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)')),
    ];
    const message = `invalid environment configuration for: ${keys.join(', ')}`;
    console.error(`onchain-intel-mcp-server: ${message}`);
    throw new Error(message);
  }

  return result.data;
}
