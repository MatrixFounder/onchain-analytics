import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PingOutputSchema } from '../src/tools/ping.js';

/**
 * E2E test over REAL stdio (task 001-3, closes R-6, confirms R-9/R-10). Spawns `src/index.ts`
 * as a child process via `tsx` — never `dist/` (ARCHITECTURE.md §10.2: CI runs `test` before
 * `build`, so this suite must not depend on a build artifact that doesn't exist yet).
 *
 * A regression-guard by construction (ARCHITECTURE §7.3): if anything ever writes non-protocol
 * output to stdout, JSON-RPC framing breaks and this suite fails/hangs instead of passing —
 * bounded per-test timeouts turn a hang into an explicit failure rather than a stuck CI run.
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

describe('onchain_ping — stdio E2E', () => {
  let client: Client | undefined;

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
  });

  async function connect(): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, serverEntry],
      cwd: packageRoot,
      stderr: 'pipe',
    });
    const c = new Client({ name: 'onchain-intel-e2e-test-client', version: '0.0.0-test' });
    await c.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    client = c;
    return c;
  }

  it(
    'tools/list contains exactly one tool: onchain_ping',
    async () => {
      const c = await connect();
      const { tools } = await c.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('onchain_ping');
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
});
