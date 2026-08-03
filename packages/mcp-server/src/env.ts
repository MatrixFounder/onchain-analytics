import { z } from 'zod';
import { DAILY_CAP_OFF, MAX_CALLS_OFF, VELOCITY_OFF } from '@onchain-intel/core';

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
 * two fields no `NodeJS.ProcessEnv`-typed consumer ever needed from `env` in the first place; every
 * remaining field's runtime VALUE is untouched.
 */
export function toProcessEnv(env: Env): NodeJS.ProcessEnv {
  const {
    NANSEN_DAILY_CREDIT_CAP,
    NANSEN_VELOCITY_CREDITS_PER_MIN,
    NANSEN_MAX_CALLS_PER_MIN,
    NANSEN_BUDGET_WARN_RATIO,
    ...rest
  } = env;
  void NANSEN_DAILY_CREDIT_CAP;
  void NANSEN_VELOCITY_CREDITS_PER_MIN;
  void NANSEN_MAX_CALLS_PER_MIN;
  void NANSEN_BUDGET_WARN_RATIO;
  return rest;
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
