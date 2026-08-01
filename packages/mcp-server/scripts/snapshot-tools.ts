/**
 * Captures `tools/list` exactly as a client receives it, and freezes it as a committed fixture.
 *
 * **Why this exists (TASK-011, R-125).** T-011 turns the tool inventory into data: every guard that
 * used to restate the list of tool names starts deriving it from one registry. That removes six
 * hand-written lists — and, if nothing replaces them, it also removes the only reason a *missing*
 * tool would ever be noticed. Today "there are exactly 13 tools" is asserted by two literals
 * external to `server.ts` (`test/e2e.stdio.test.ts`, `scripts/smoke-dist.mjs`); once every reader
 * derives from `toolSpecs`, a lost registry entry makes all of them agree on twelve and the suite
 * stays green. The documentation gate cannot help: it *iterates registered tools*, so a tool that
 * vanished is simply not iterated.
 *
 * This fixture is the replacement, and it is deliberately **not** regenerated from the registry:
 * it is the one expectation that lives outside it. Updating it is a human act, recorded in a commit.
 *
 * **Two properties that are easy to get wrong, both learned before writing this:**
 *
 * 1. **No sorting.** The SDK returns tools in registration order, and that order is visible to the
 *    model. Every existing observer sorts by name before comparing, so a reordering of the registry
 *    would change the published response without a single gate noticing. Freezing the order here is
 *    what makes it contractual.
 * 2. **In-process, not stdio.** The built-`dist/` channel is already covered by `smoke-dist`; a
 *    spawn would add process flakiness to a gate whose question is about content, not transport.
 *    The bytes are the same either way: `JSON.stringify` drops keys whose value is `undefined`,
 *    which is exactly what the SDK's unconditional `annotations`/`_meta` become when unset.
 *
 * Run: pnpm --filter @onchain-intel/mcp-server snapshot:tools
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadEnv } from '../src/env.js';
import { createServer } from '../src/server.js';

/**
 * Fixed, never the real package version: `tools/list` does not carry it, but pinning it keeps the
 * capture independent of whatever `package.json` says on the day someone regenerates.
 */
const SNAPSHOT_SERVER_VERSION = '0.0.0-snapshot';

/** The committed fixture this script writes and `tools-list-contract.test.ts` reads. */
export const SNAPSHOT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../test/fixtures/tools-list.snapshot.json',
);

/** The command a failing gate must print, so the reader never has to guess it. */
export const REGENERATE_COMMAND = 'pnpm --filter @onchain-intel/mcp-server snapshot:tools';

/** One tool as `tools/list` publishes it. Deliberately loose: whatever the SDK emits is the fact. */
export type ToolsListEntry = Record<string, unknown> & { name: string };

/**
 * Stands up the real server over an in-memory transport and returns `tools/list` verbatim, in
 * registration order.
 */
export async function captureToolsList(): Promise<ToolsListEntry[]> {
  const server = createServer({ env: loadEnv(), version: SNAPSHOT_SERVER_VERSION });
  const client = new Client({ name: 'tools-list-snapshot', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools as unknown as ToolsListEntry[];
  } finally {
    await client.close();
    await server.close();
  }
}

/** The exact bytes of the fixture. Two runs on one tree must produce the identical string. */
export function serializeToolsList(tools: readonly ToolsListEntry[]): string {
  return `${JSON.stringify(tools, null, 2)}\n`;
}

async function main(): Promise<void> {
  const tools = await captureToolsList();
  writeFileSync(SNAPSHOT_PATH, serializeToolsList(tools), 'utf8');
  console.log(`snapshot-tools: wrote ${tools.length} tools to ${SNAPSHOT_PATH}`);
}

// Run only when invoked directly; the test imports the functions above and must not write anything.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
