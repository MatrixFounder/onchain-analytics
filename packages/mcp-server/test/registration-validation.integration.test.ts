import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TC-INT-01 (task 012-2) — a registration that fails `assertValidAdapterRegistrations()` must take
 * down PROCESS START, and it must do so **before** any store is constructed.
 *
 * **Two independent failure modes, and this docstring names which assertion catches which — they
 * are NOT interchangeable.** An earlier version of this comment claimed the order assertion was
 * what caught "the call moved below `createBudgetStore()`". It is not, and the difference matters:
 *
 * - **Assertion 1/2 (`thrown` is an Error naming the id)** catches the validator being moved
 *   ANYWHERE INSIDE `main()`. Not because the check stops throwing — it still throws — but because
 *   `src/index.ts` invokes `main().catch(… process.exit(1))`, so a throw raised inside `main()` is
 *   swallowed by that handler and `await import(...)` RESOLVES. The module-scope call is what makes
 *   the failure observable to an importer (and, in production, what makes it a start-time crash
 *   rather than a caught-and-exited async rejection).
 * - **Assertion 3 (the spy log is empty)** catches the genuinely ordered mutation: a store
 *   constructed at MODULE SCOPE *before* the validator call. There the import still rejects and
 *   still names the id, so assertions 1 and 2 both pass — only the spy log tells you a SQLite
 *   handle was opened and the `providers` bootstrap rows for a half-declared adapter set were
 *   already written.
 *
 * Both mutants were run against this file and each kills only its own assertion; neither is
 * redundant, and neither covers for the other.
 *
 * **The corruption is injected, never written into `providers.config.ts`.** The real registration
 * table stays valid on disk (`packages/core/test/adapter-registrations.test.ts` TC-UNIT-04 is the
 * guard for that); here the module is mocked so this test can observe a broken input in isolation.
 *
 * `src/server.js` and the stdio transport are mocked as well. `src/index.ts` calls `main()` at
 * module scope, so an implementation that DOESN'T fail early would otherwise connect a real
 * `StdioServerTransport` inside the test worker and write to its stdout. Mocking them means the
 * red phase of this test fails with an assertion instead of hanging — and it keeps the negative
 * outcome observable rather than fatal.
 */

const spies = vi.hoisted(() => ({
  /** Every store construction, in order. Must stay EMPTY when validation fails. */
  constructed: [] as string[],
  serverConnected: [] as string[],
}));

const BROKEN_ID = 'platform-explorer';

vi.mock('@onchain-intel/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@onchain-intel/core')>();
  // Strip `trust` off exactly one real registration — the shape a hand-edited config, a JSON
  // source or a `filter()`ed array can produce, and the one the compiler cannot see.
  const corrupted = actual.adapterRegistrations.map((registration) => {
    if (registration.id !== BROKEN_ID) return registration;
    const stripped = { ...registration };
    delete (stripped as Partial<typeof registration>).trust;
    return stripped;
  });
  return {
    ...actual,
    adapterRegistrations: corrupted,
    createCacheStore: () => {
      spies.constructed.push('createCacheStore');
      return undefined as never;
    },
    createBudgetStore: () => {
      spies.constructed.push('createBudgetStore');
      return {
        checkAndReserve: async () => ({ ok: true }) as const,
        recordDelta: async () => undefined,
        getUsage: async () => 0,
      } as never;
    },
  };
});

vi.mock('../src/server.js', () => ({
  createServer: () => ({
    connect: async () => {
      spies.serverConnected.push('connect');
    },
  }),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

describe('TC-INT-01 — an undeclared trust rank fails process start, before any store exists', () => {
  beforeEach(() => {
    spies.constructed.length = 0;
    spies.serverConnected.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('importing src/index.ts rejects, and neither store factory ever ran', async () => {
    let thrown: unknown;
    try {
      await import('../src/index.js');
    } catch (error) {
      thrown = error;
    }

    // 1. Start fails OBSERVABLY — the import itself rejects. Dies if the call moves inside
    //    `main()`, where `main().catch(… process.exit(1))` would swallow the throw.
    expect(thrown).toBeInstanceOf(Error);
    // 2. ...naming the offending registration, so the operator knows which line to fix.
    expect((thrown as Error).message).toContain(BROKEN_ID);
    expect((thrown as Error).message).toContain("'trust'");
    // 3. ...and it failed BEFORE the stores. This is the ORDER assertion, and it is the only one
    //    that dies when a store is constructed at module scope ahead of the validator — that
    //    mutant still rejects and still names the id, so 1 and 2 stay green.
    expect(spies.constructed).toEqual([]);
    // 4. ...and long before a transport was attached.
    expect(spies.serverConnected).toEqual([]);
  });
});
