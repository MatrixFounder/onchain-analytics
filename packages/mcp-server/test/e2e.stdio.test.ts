import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PingOutputSchema } from '../src/tools/ping.js';
import { toolSpecs } from '../src/tools/tool-specs.js';

/**
 * E2E test over REAL stdio (task 001-3, closes R-6, confirms R-9/R-10). Spawns `src/index.ts`
 * as a child process via `tsx` — never `dist/` (ARCHITECTURE.md §10.2: CI runs `test` before
 * `build`, so this suite must not depend on a build artifact that doesn't exist yet).
 *
 * A regression-guard by construction (ARCHITECTURE §7.3): if anything ever writes non-protocol
 * output to stdout, JSON-RPC framing breaks and this suite fails/hangs instead of passing —
 * bounded per-test timeouts turn a hang into an explicit failure rather than a stuck CI run.
 *
 * **`DATA_DIR` override (task 003-7):** since `index.ts`'s `main()` now unconditionally builds
 * the REAL `CapabilityRegistry` (all 9 real adapters + the real two-level cache, R-16..R-19)
 * before ever registering a tool — even though this suite only ever calls `onchain_ping` — every
 * spawned server here would otherwise eagerly create/open `~/.onchain-intel/cache.sqlite3` (the
 * `SqliteCacheStore` constructor touches disk immediately on construction, task 003-3). `connect()`
 * points the spawned child's `DATA_DIR` at a fresh `mkdtempSync` temp directory instead (never the
 * real `DATA_DIR`), removed in `afterEach` — offline/hygiene discipline, mirrors
 * `packages/core/test/cache.test.ts`'s own established convention.
 */

const packageRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
// Invoke tsx's CLI entry directly via `node` (not the `node_modules/.bin/tsx` shim) — avoids any
// dependence on shebang execution or PATH resolution, so the child spawns identically in CI.
const tsxCli = path.resolve(packageRoot, 'node_modules/tsx/dist/cli.mjs');
const serverEntry = path.resolve(packageRoot, 'src/index.ts');
const packageJson = JSON.parse(readFileSync(path.resolve(packageRoot, 'package.json'), 'utf8')) as {
  version: string;
};

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = CONNECT_TIMEOUT_MS + CALL_TIMEOUT_MS;
const INVALID_ENV_TIMEOUT_MS = 10_000;

/**
 * WI-10 — the half of the stale-`dist` trap that a Vite alias structurally cannot close.
 *
 * `vitest.config.ts` aliases `@onchain-intel/core` to its source for every IN-PROCESS test here,
 * but this suite spawns `src/index.ts` as a **child process** via `tsx`: the child resolves modules
 * through Node and the workspace symlink, which points at `packages/core/dist`. A child process
 * cannot receive a Vite alias, so it used to read the BUILT core — meaning a correct change in
 * `packages/core/src` surfaced here as an initialize timeout or a tool missing from `tools/list`,
 * symptoms naming everything except the cause.
 *
 * `tsx --tsconfig tsconfig.e2e.json` (a `paths` mapping to `../core/src/index.ts`) makes the child
 * resolve source too, which also restores the property this file's own header claims: it depends on
 * no build artifact. The built artifact keeps its end-to-end coverage in `scripts/smoke-dist.mjs`,
 * which runs `dist/index.js` for real.
 *
 * **Rejected first attempt, recorded so it is not re-tried:** an mtime freshness check ("is
 * dist/index.js newer than the newest file under core/src? if not, tell the developer to rebuild").
 * It is unsound. `tsc` does not rewrite an output whose content did not change, so any edit that
 * leaves `dist/index.js` byte-identical — or a plain `touch` — leaves the check permanently
 * tripped, and the suite red with a message telling you to run a build that cannot clear it.
 * Observed exactly that, after a build.
 *
 * The residual risk of the chosen fix is silent: were a future tsx to stop honouring `--tsconfig`,
 * resolution would fall back to `dist` and this suite would pass against a stale build again.
 * `test/fixtures/core-resolution-probe.ts` closes that — it is run below under the identical
 * invocation and asserts which copy was resolved.
 */
const E2E_TSCONFIG = path.resolve(packageRoot, 'tsconfig.e2e.json');
const CORE_RESOLUTION_PROBE = path.resolve(packageRoot, 'test/fixtures/core-resolution-probe.ts');
/** Exactly what every child in this file is launched with. One definition, no drift. */
const tsxArgs = (entry: string): string[] => [tsxCli, '--tsconfig', E2E_TSCONFIG, entry];

describe('onchain_ping — stdio E2E', () => {
  let client: Client | undefined;
  let dataDir: string | undefined;

  // Reliable teardown for every test, pass or fail — StdioClientTransport#close() ends the
  // child's stdin, then escalates to SIGTERM/SIGKILL if it doesn't exit on its own (verified by
  // reading the installed SDK's client/stdio.js). No zombie `tsx`/`node` processes should remain
  // after the suite (spot-checked manually with `ps` during development, see task report).
  afterEach(async () => {
    try {
      await client?.close();
    } catch {
      // already closed / never connected — nothing to do
    }
    client = undefined;
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  async function connect(): Promise<Client> {
    dataDir = mkdtempSync(path.join(tmpdir(), 'onchain-intel-e2e-stdio-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: tsxArgs(serverEntry),
      cwd: packageRoot,
      stderr: 'pipe',
      // Real `process.env` (not the SDK's curated safe-subset default) so tsx/module resolution
      // behaves exactly like a normal dev run — plus the `DATA_DIR` override above.
      //
      // `NANSEN_API_KEY: ''` is NOT redundant (code review 005-6, MINOR): without it the child
      // inherits the developer's ambient key AND its own `loadEnv()` calls `process.loadEnvFile()`,
      // which reads the repo `.env` — exactly where a real key lives per D10, and exactly what
      // task 005-7 puts there. Empty string is normalized to `undefined` by `emptyAsUndefined`,
      // so the child is provably key-less regardless of shell or `.env` state. This makes the
      // "no ambient key in any test" rule (PLAN §0.1 / M-1) structural rather than incidental.
      env: { ...process.env, DATA_DIR: dataDir, NANSEN_API_KEY: '' },
    });
    const c = new Client({ name: 'onchain-intel-e2e-test-client', version: '0.0.0-test' });
    // Capture the reference BEFORE awaiting connect(): if `c.connect()` rejects (e.g. the
    // initialize handshake times out), `afterEach` must still be able to close the
    // transport/client and reap the spawned child process. Don't rely on the SDK's own
    // cleanup-on-failed-connect (client/index.js's `connect()` does call `void this.close()` on
    // an initialize failure, but as a fire-and-forget call it isn't awaited before the error
    // propagates — and it isn't reached at all if `transport.start()` itself rejects).
    client = c;
    await c.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return c;
  }

  it(
    // Extended task 003-7 (R-20/F-1), then task 005-6 (R-41/R-42/R-43): tools/list grows to 8
    // (ping + the 4 M1 tools + the 3 M2 tools), but this spawn suite still calls ONLY onchain_ping
    // through the wire — every one of the 7 non-ping tools' fixture-backed registry injection is
    // in-process-only and unreachable across this spawned child process boundary (ARCHITECTURE.md
    // §3.2 F-1); calling them here would mean a REAL, network-capable registry answering under
    // spawn, which is exactly the live-network dependency R-21 forbids (no NANSEN_API_KEY is set
    // for this spawned child either — task 005-6's own "no ambient key in any test" rule).
    // `test/e2e.inprocess.test.ts` (InMemoryTransport) is what actually exercises all 7 tools.
    'tools/list contains exactly 13 tools: onchain_ping + 4 M1 + 3 M2 + 2 TASK-006 + 1 TASK-007 + 1 TASK-008 + 1 TASK-009 (by name)',
    async () => {
      const c = await connect();
      const { tools } = await c.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
      // WI-20: this is normally the FIRST of four independent guards to fail when a tool is added,
      // and the last one only fires after a full build. Naming all four here turns three discovery
      // cycles into one lookup — they stay independent on purpose (each protects a different
      // property), so the fix is a cross-reference, not a merge.
      const ADD_A_TOOL =
        'A tool was added or removed. FOUR independent inventories must agree, and each fails in ' +
        'its own gate:\n' +
        '  1. this list (pnpm test)\n' +
        '  2. eval/capabilities.mjs -> CAPABILITY_TOOLS, or CAPABILITY_EXCLUSIONS ' +
        '(test/eval-capability-coverage.test.ts)\n' +
        '  3. scripts/smoke-dist.mjs reads tool-inventory.json (pnpm smoke:dist — AFTER build)\n' +
        '  4. docs/architectures/interfaces.md §5 must NAME the tool (test/docs-counts.test.ts)';
      // Derived from the registry, never restated (TASK-011 R-116). The channel is unchanged —
      // this suite still spawns `src/index.ts` and reads the wire — only the EXPECTATION stopped
      // being a second hand-written list. What still cannot be derived, and is not, is "there are
      // at least 13": that hand-written bound lives in `tools-list-contract.test.ts`, because a
      // count taken from the same array the server registers from would agree with any loss.
      const expected = toolSpecs.map((spec) => spec.name).sort();
      expect(tools, ADD_A_TOOL).toHaveLength(expected.length);
      const names = tools.map((tool) => tool.name).sort();
      expect(names, ADD_A_TOOL).toStrictEqual(expected);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'tools/call onchain_ping returns structuredContent matching PingOutputSchema, version === package.json',
    async () => {
      const c = await connect();
      const result = await c.callTool({ name: 'onchain_ping', arguments: {} }, undefined, {
        timeout: CALL_TIMEOUT_MS,
      });

      expect(result.isError).not.toBe(true);
      const parsed = PingOutputSchema.parse(result.structuredContent);
      expect(parsed.ok).toBe(true);
      expect(parsed.service).toBe('onchain-intel-mcp-server');
      // Read from package.json in the test — no hardcoded version literal in this assertion.
      expect(parsed.version).toBe(packageJson.version);
      expect(Number.isInteger(parsed.ts)).toBe(true);

      // The `content` block (for clients that don't read `structuredContent`) must carry the
      // exact same payload, JSON-stringified — the two representations must never drift apart.
      // `callTool`'s inferred return type is a union with the (unused-here) task-based
      // `toolResult` shape; both union members carry a `[x: string]: unknown` index signature, so
      // a `'content' in result` guard can't narrow it away (index signatures defeat `in`
      // narrowing — TS still considers the other member capable of an unknown `content` key).
      // `onchain_ping` never uses task-based execution, so asserting to the SDK's own
      // `CallToolResult` type is a safe, documented narrowing rather than an unchecked escape.
      const { content } = result as CallToolResult;
      const firstContent = content[0];
      expect(firstContent?.type).toBe('text');
      if (firstContent?.type !== 'text') {
        throw new Error('expected onchain_ping to return a text content block');
      }
      expect(JSON.parse(firstContent.text)).toStrictEqual(result.structuredContent);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'tools/call with an unexpected argument yields an MCP error (isError), not a hang',
    async () => {
      const c = await connect();
      const result = await c.callTool(
        { name: 'onchain_ping', arguments: { unexpected: 'value' } },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      );
      expect(result.isError).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the spawned child resolves @onchain-intel/core from src, not from the built dist (WI-10)',
    async () => {
      // Runs the probe under the SAME `tsxArgs(...)` every server child above is launched with, so
      // this asserts the mechanism those four tests depend on rather than a copy of it. Without it,
      // a tsx that stopped honouring `--tsconfig` would silently return this suite to reading a
      // stale build while still passing.
      const child = spawn(process.execPath, tsxArgs(CORE_RESOLUTION_PROBE), {
        cwd: packageRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('the resolution probe did not exit within the bounded timeout'));
        }, INVALID_ENV_TIMEOUT_MS);
        child.on('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      expect(exitCode, `probe failed to run. stderr: ${stderr}`).toBe(0);
      expect(
        stdout.trim(),
        'the spawned child resolved @onchain-intel/core through the BUILT dist. tsx is no longer ' +
          'honouring `--tsconfig tsconfig.e2e.json`, so this suite is silently testing a stale ' +
          'build again (WI-10).',
      ).toBe('resolved:src');
    },
    INVALID_ENV_TIMEOUT_MS + 5_000,
  );

  it(
    'invalid LOG_LEVEL fails startup fast: exit 1, stderr names the key but never the value, stdout stays empty',
    async () => {
      // Plain child_process spawn (no MCP client/transport needed here — the server never gets
      // far enough to speak the protocol) so this test is self-contained: kill-on-timeout is the
      // only reaping mechanism, independent of the Client/StdioClientTransport machinery used by
      // the tests above.
      const child = spawn(process.execPath, tsxArgs(serverEntry), {
        cwd: packageRoot,
        env: { ...process.env, LOG_LEVEL: 'bogus' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('child process did not exit within the bounded timeout'));
        }, INVALID_ENV_TIMEOUT_MS);
        child.on('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      expect(exitCode).toBe(1);
      expect(stderr).toContain('LOG_LEVEL');
      expect(stderr).not.toContain('bogus');
      expect(stdout).toBe('');
    },
    INVALID_ENV_TIMEOUT_MS + 5_000,
  );
});
