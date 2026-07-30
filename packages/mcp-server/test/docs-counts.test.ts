import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { adapterRegistrations } from '@onchain-intel/core';
import { loadEnv } from '../src/env.js';
import { createServer } from '../src/server.js';

/**
 * The architecture documents state COUNTS in prose, and nothing used to check them (WI-21).
 *
 * **Why this exists.** `docs/ARCHITECTURE.md` is an index over `docs/architectures/*.md`, and the
 * counts scattered through both — how many adapters, how many MCP tools — are the part of a living
 * document most likely to rot and least likely to be noticed, because nothing imports them.
 * TASK-008 added an adapter and a tool and updated one section file; the index went on claiming ten
 * adapters and eleven tools for a whole task, and `interfaces.md` had no entry at all for the tool
 * that task shipped. It was found only because the next task happened to edit the same tables.
 *
 * So the numbers stop being prose: they are extracted from the docs and compared against the code
 * that defines them. A doc that says "twelve" when the config has thirteen entries now fails a gate.
 *
 * **What this deliberately does NOT do.** It does not police historical statements. `M1 shipped nine
 * adapters` stays true forever, and `version-history.md` is a log of what past versions said — both
 * are excluded by only ever reading the specific present-tense sentences listed below. A test that
 * rewrote history to match today's counts would be worse than no test.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), 'utf8');

/** English number words the docs use for these counts, so both spellings are comparable. */
const WORDS: Record<string, number> = {
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
};

/** `"twelve"` / `"12"` → 12. */
function toNumber(token: string): number {
  const word = WORDS[token.toLowerCase()];
  return word ?? Number(token);
}

/** Every count the given pattern captures in `file`, as numbers. */
function claimedCounts(relative: string, pattern: RegExp): number[] {
  return [...read(relative).matchAll(pattern)].map((match) => toNumber(match[1] as string));
}

async function registeredToolNames(): Promise<string[]> {
  // The real server, over the real protocol — the same seam `e2e.inprocess` uses. Counting
  // `registerXTool(` in the source would be a text heuristic about a text file; this is the list a
  // client actually receives, which is the thing the docs describe.
  const server = createServer({ env: loadEnv(), version: '0.0.0-test' });
  const client = new Client({ name: 'docs-counts', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

describe('documentation counts match the code they describe (WI-21)', () => {
  it('states the adapter count correctly wherever it states it in the present tense', () => {
    const actual = adapterRegistrations.length;
    const claims = [
      ...claimedCounts(
        'docs/ARCHITECTURE.md',
        /\*\*What the engine is today\*\* — (\w+) provider/g,
      ),
      ...claimedCounts(
        'docs/architectures/system-architecture.md',
        /Capability Registry, (\w+) provider adapters/g,
      ),
      ...claimedCounts(
        'docs/architectures/system-architecture.md',
        /providers\.config\.ts \((\d+) adapters\)/g,
      ),
      ...claimedCounts(
        'docs/architectures/functional-architecture.md',
        /(\d+) adapters registered/g,
      ),
      ...claimedCounts(
        'docs/architectures/deployment.md',
        /network-independent\*\*: (\d+) adapters/g,
      ),
      ...claimedCounts('docs/architectures/interfaces.md', /shared\s*\n?by all (\w+) adapters/g),
      ...claimedCounts(
        'docs/architectures/technology-stack.md',
        /adapterRegistrations \((\d+) adapters\)/g,
      ),
    ];
    // If the sentences these patterns anchor on are ever reworded, the array empties and the test
    // would pass while checking nothing — so the count of CLAIMS is asserted too.
    expect(claims.length).toBeGreaterThanOrEqual(7);
    expect(claims).toEqual(claims.map(() => actual));
  });

  it('states the MCP tool count correctly wherever it states it in the present tense', async () => {
    const actual = (await registeredToolNames()).length;
    const claims = [
      ...claimedCounts('docs/ARCHITECTURE.md', /and (\w+) workflow-oriented MCP tools/g),
      ...claimedCounts('docs/ARCHITECTURE.md', /Contracts for all (\w+) MCP tools/g),
      ...claimedCounts('docs/architectures/interfaces.md', /External API — (\d+) MCP tools/g),
      ...claimedCounts('docs/architectures/interfaces.md', /of the (\w+) tools take a chain/g),
      ...claimedCounts(
        'docs/architectures/interfaces.md',
        /compound `superRefine` of the (\w+) tools/g,
      ),
      ...claimedCounts('docs/architectures/security.md', /holds for all (\d+) tools/g),
      ...claimedCounts('docs/architectures/deployment.md', /Call any of the (\d+) tools/g),
      ...claimedCounts(
        'docs/architectures/functional-architecture.md',
        /mcp-server — (\d+) tools/g,
      ),
      ...claimedCounts('docs/architectures/technology-stack.md', /# (\d+) registered tools/g),
    ];
    // If a sentence is reworded, its pattern stops matching and the array shrinks — which would let
    // the test pass while checking less than it claims. The claim COUNT is therefore asserted too.
    expect(claims.length).toBeGreaterThanOrEqual(9);
    expect(claims).toEqual(claims.map(() => actual));
  });

  it('states how many tools take a chain, counted from the real input schemas', async () => {
    // The sentence is "<N> of the <total> tools take a chain". The total is covered above; N is a
    // different fact and is checked against the schemas themselves rather than against a number
    // someone remembered — `onchain_ping` and `onchain_list_chains` are the two that do not.
    const server = createServer({ env: loadEnv(), version: '0.0.0-test' });
    const client = new Client({ name: 'docs-counts-chain', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    let chainTaking: number;
    try {
      const { tools } = await client.listTools();
      chainTaking = tools.filter(
        (tool) => (tool.inputSchema as { properties?: Record<string, unknown> }).properties?.chain,
      ).length;
    } finally {
      await client.close();
      await server.close();
    }
    expect(chainTaking).toBeGreaterThan(0);
    const claimed = claimedCounts(
      'docs/architectures/interfaces.md',
      /\*\*The `chain` parameter, stated once\.\*\* (\w+) of the/g,
    );
    expect(claimed).toEqual([chainTaking]);
  });

  it('names every registered tool in the interfaces section', async () => {
    // A count alone would pass if one tool were swapped for another. TASK-008's real failure was
    // not a wrong number — it was a tool with no entry anywhere in §5.
    const interfaces = read('docs/architectures/interfaces.md');
    for (const name of await registeredToolNames()) {
      expect(interfaces, `${name} is registered but absent from interfaces.md`).toContain(name);
    }
  });

  it('names every registered adapter id in the system-architecture adapter table', () => {
    const systemArchitecture = read('docs/architectures/system-architecture.md');
    for (const { id } of adapterRegistrations) {
      expect(systemArchitecture, `adapter '${id}' is registered but absent from §3.2`).toContain(
        id,
      );
    }
  });
});
