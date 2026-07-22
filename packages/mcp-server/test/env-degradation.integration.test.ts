import { describe, expect, it } from 'vitest';
import { CapabilityRegistry, createPgHistoryAdapter } from '@onchain-intel/core';
import type { ProviderAdapter, CapabilityRoute } from '@onchain-intel/core';
import { loadEnv } from '../src/env.js';

/**
 * Integration test for task 003-6 (R-23/R-24) — the composition seam between `mcp-server`'s
 * validated `Env` (task 003-6's 4 new optional keys, `src/env.ts`) and `@onchain-intel/core`'s
 * already-built graceful-degradation contract (`isAvailable()` reasons, task 003-5;
 * `CapabilityUnavailableError`, task 003-2). Proves end-to-end that an env produced by `loadEnv()`
 * with `ONCHAIN_PG_URL` absent degrades a history capability EXPLICITLY (a structured reason
 * naming the missing key) rather than crashing or silently returning `undefined` — never a live
 * network/PG call in this file (R-21): when `ONCHAIN_PG_URL` is absent, `CapabilityRegistry` never
 * reaches `fetch()`/constructs a `pg.Pool` at all (proven by `pg-history`'s own contract test,
 * `packages/core/test/pg-history.contract.test.ts`); this file only exercises that already-proven
 * behavior through `mcp-server`'s own `loadEnv()` entry point, which is the part 003-6 actually
 * adds. Full tool-handler wiring (`createServer({registry})`, the `isError: true` MCP response
 * shape) is task 003-7's scope, not this one (ARCHITECTURE.md §3.2 reviewer note).
 *
 * This is also the FIRST import of `@onchain-intel/core` anywhere in `mcp-server`'s source —
 * exclusively through the package's public re-export surface (`@onchain-intel/core`'s own
 * `src/index.ts`), per that package's documented consumer convention (see its `.AGENTS.md`) —
 * never an internal path like `@onchain-intel/core/dist/pg/read-client.js`.
 */

const HISTORY_ROUTE: CapabilityRoute = {
  capability: 'platform.metrics.history',
  chains: ['dash'],
  adapterIds: ['pg-history'],
};

function registryWithPgHistoryOnly(env: NodeJS.ProcessEnv): CapabilityRegistry {
  const adapters = new Map<string, ProviderAdapter>([
    ['pg-history', createPgHistoryAdapter({ env })],
  ]);
  return new CapabilityRegistry([HISTORY_ROUTE], adapters);
}

describe('env -> adapter graceful degradation (task 003-6, R-23/R-24)', () => {
  it('loadEnv({}) (no ONCHAIN_PG_URL) makes pg-history report a structured, actionable reason', () => {
    const env = loadEnv({});
    const adapter = createPgHistoryAdapter({ env });
    expect(adapter.isAvailable?.()).toEqual({ ok: false, reason: 'needs ONCHAIN_PG_URL' });
  });

  it('a validated env with ONCHAIN_PG_URL set flips pg-history to available (same wiring, no network)', () => {
    const env = loadEnv({
      ONCHAIN_PG_URL: 'postgres://user:p%40ss@db.internal:5432/postgres',
    } as NodeJS.ProcessEnv);
    const adapter = createPgHistoryAdapter({ env });
    expect(adapter.isAvailable?.()).toEqual({ ok: true });
  });

  it('resolve() for a history capability without ONCHAIN_PG_URL rejects with a structured reason — not a crash, not undefined', async () => {
    const env = loadEnv({});
    const registry = registryWithPgHistoryOnly(env);

    let rejection: unknown;
    let resolved: unknown;
    try {
      resolved = await registry.resolve('platform.metrics.history', 'dash', { chain: 'dash' });
    } catch (error) {
      rejection = error;
    }

    expect(resolved).toBeUndefined();
    expect(rejection).toBeInstanceOf(Error);
    const message = (rejection as Error).message;
    expect(message).toContain('needs ONCHAIN_PG_URL');
    expect(message).toContain('platform.metrics.history');
  });

  it('the degradation reason never leaks a secret value, even when other env secrets are set alongside the missing DSN (D10)', async () => {
    const secretCoingeckoKey = 'cg-secret-773f2a';
    const secretDuneKey = 'dune-secret-9c1b4e';
    const env = loadEnv({
      COINGECKO_API_KEY: secretCoingeckoKey,
      DUNE_API_KEY: secretDuneKey,
      // ONCHAIN_PG_URL deliberately absent.
    } as NodeJS.ProcessEnv);
    const registry = registryWithPgHistoryOnly(env);

    let rejection: unknown;
    try {
      await registry.resolve('platform.metrics.history', 'dash', { chain: 'dash' });
    } catch (error) {
      rejection = error;
    }

    const message = (rejection as Error).message;
    expect(message).not.toContain(secretCoingeckoKey);
    expect(message).not.toContain(secretDuneKey);
    expect(message).not.toContain('ONCHAIN_PG_URL=');
  });
});
