import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolves `DATA_DIR` (ARCHITECTURE.md §3.2): optional env override, otherwise
 * `path.join(os.homedir(), '.onchain-intel')` — deliberately NOT `process.cwd()`-relative, since
 * the MCP server is started by Claude Code with an arbitrary cwd; the home directory is stable and
 * predictable regardless of where the host process was launched from. Moving an installation =
 * moving this one directory (DB-SCHEMA-CONCEPT §1.10). `env` is injectable (defaults to
 * `process.env`) purely for deterministic tests, mirroring this package's existing DI conventions
 * (`safeFetch`'s `fetchImpl`, `createThrottle`'s `deps`).
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATA_DIR && env.DATA_DIR.length > 0 ? env.DATA_DIR : join(homedir(), '.onchain-intel');
}

/**
 * `${DATA_DIR}/cache.sqlite3` — the cache DB file path (ARCHITECTURE.md §3.2).
 */
export function cacheDbPath(dataDir: string = resolveDataDir()): string {
  return join(dataDir, 'cache.sqlite3');
}
