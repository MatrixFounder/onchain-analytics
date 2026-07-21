import { z } from 'zod';

/**
 * Process environment configuration for the MCP server.
 *
 * M0 (ADR-001 free-first phase, R-12): every key is OPTIONAL — there are no required secrets
 * yet. `LOG_LEVEL` is reserved for future diagnostic tuning; no provider API keys are declared
 * here (those arrive M2+ behind `.superRefine`, conditional on `providers.config.ts` — see
 * ARCHITECTURE.md §4.1 "Эволюция (FUTURE, M2+)").
 *
 * Deliberately NOT `.strict()`: the real input is `process.env`, which carries hundreds of
 * unrelated keys (PATH, HOME, ...). Zod's default `z.object()` behavior strips unknown keys
 * instead of rejecting them, so `EnvSchema.parse(process.env)` succeeds regardless of what else
 * is set in the shell.
 */
export const EnvSchema = z.object({
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
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
