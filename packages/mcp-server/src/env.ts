import { z } from 'zod';

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
  ONCHAIN_PG_URL: emptyAsUndefined(z.string().url().optional()),
  DATA_DIR: emptyAsUndefined(z.string().optional()),
});

export type Env = z.infer<typeof EnvSchema>;

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
    const keys = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(root)'))];
    const message = `invalid environment configuration for: ${keys.join(', ')}`;
    console.error(`onchain-intel-mcp-server: ${message}`);
    throw new Error(message);
  }

  return result.data;
}
