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
      args: [tsxCli, serverEntry],
      cwd: packageRoot,
      stderr: 'pipe',
      // Real `process.env` (not the SDK's curated safe-subset default) so tsx/module resolution
      // behaves exactly like a normal dev run — plus the `DATA_DIR` override above.
      env: { ...process.env, DATA_DIR: dataDir },
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
    // Extended task 003-7 (R-20/F-1): tools/list grows to 5 (ping + the 4 new M1 tools), but this
    // spawn suite still calls ONLY onchain_ping through the wire — the 4 new tools' fixture-backed
    // registry injection is in-process-only and unreachable across this spawned child process
    // boundary (ARCHITECTURE.md §3.2 F-1); calling them here would mean a REAL, network-capable
    // registry answering under spawn, which is exactly the live-network dependency R-21 forbids.
    // `test/e2e.inprocess.test.ts` (InMemoryTransport) is what actually exercises the 4 new tools.
    'tools/list contains exactly 5 tools: onchain_ping + the 4 new M1 tools (by name)',
    async () => {
      const c = await connect();
      const { tools } = await c.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
      expect(tools).toHaveLength(5);
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toStrictEqual(
        [
          'onchain_get_token',
          'onchain_new_pairs',
          'onchain_ping',
          'onchain_protocol_tvl',
          'onchain_wallet_balances',
        ].sort(),
      );
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
    'invalid LOG_LEVEL fails startup fast: exit 1, stderr names the key but never the value, stdout stays empty',
    async () => {
      // Plain child_process spawn (no MCP client/transport needed here — the server never gets
      // far enough to speak the protocol) so this test is self-contained: kill-on-timeout is the
      // only reaping mechanism, independent of the Client/StdioClientTransport machinery used by
      // the tests above.
      const child = spawn(process.execPath, [tsxCli, serverEntry], {
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
