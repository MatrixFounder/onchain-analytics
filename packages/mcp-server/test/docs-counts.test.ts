import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { adapterRegistrations, routes } from '@onchain-intel/core';
import { toolSpecs } from '../src/tools/tool-specs.js';
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

/**
 * The same, but carrying the file each claim came from.
 *
 * **Why this exists.** These tests used to compare two arrays of numbers, so a failure read
 * `expected [13, 13, …] to deeply equal [14, 14, …]` — accurate, and useless: it named no file to
 * edit, which is the exact defect TASK-011 removes everywhere else. It was found by RUNNING the
 * AC-7 protocol (add a fourteenth tool and read what the suite says) rather than by reading this
 * file, which is the reason that protocol exists.
 */
function claimsWithSource(relative: string, pattern: RegExp): { file: string; value: number }[] {
  return claimedCounts(relative, pattern).map((value) => ({ file: relative, value }));
}

/** Names the files whose claims disagree with `actual`, so the failure says what to edit. */
function assertClaims(
  claims: { file: string; value: number }[],
  actual: number,
  what: string,
): void {
  const wrong = [...new Set(claims.filter((c) => c.value !== actual).map((c) => c.file))];
  expect(
    wrong,
    `${what}: these files state a number other than ${actual}. Update them: ${wrong.join(', ')}`,
  ).toStrictEqual([]);
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
      ...claimsWithSource(
        'docs/ARCHITECTURE.md',
        /\*\*What the engine is today\*\* — (\w+) provider/g,
      ),
      ...claimsWithSource(
        'docs/architectures/system-architecture.md',
        /Capability Registry, (\w+) provider adapters/g,
      ),
      ...claimsWithSource(
        'docs/architectures/system-architecture.md',
        /providers\.config\.ts \((\d+) adapters\)/g,
      ),
      ...claimsWithSource(
        'docs/architectures/functional-architecture.md',
        /(\d+) adapters registered/g,
      ),
      ...claimsWithSource(
        'docs/architectures/deployment.md',
        /network-independent\*\*: (\d+) adapters/g,
      ),
      ...claimsWithSource('docs/architectures/interfaces.md', /shared\s*\n?by all (\w+) adapters/g),
      ...claimsWithSource(
        'docs/architectures/technology-stack.md',
        /adapterRegistrations \((\d+) adapters\)/g,
      ),
    ];
    // If the sentences these patterns anchor on are ever reworded, the array empties and the test
    // would pass while checking nothing — so the count of CLAIMS is asserted too.
    expect(claims.length).toBeGreaterThanOrEqual(7);
    assertClaims(claims, actual, 'adapter count');
  });

  it('states the MCP tool count correctly wherever it states it in the present tense', async () => {
    const actual = (await registeredToolNames()).length;
    const claims = [
      ...claimsWithSource('docs/ARCHITECTURE.md', /and (\w+) workflow-oriented MCP tools/g),
      ...claimsWithSource('docs/ARCHITECTURE.md', /Contracts for all (\w+) MCP tools/g),
      ...claimsWithSource('docs/architectures/interfaces.md', /External API — (\d+) MCP tools/g),
      ...claimsWithSource('docs/architectures/interfaces.md', /of the (\w+) tools take a chain/g),
      ...claimsWithSource(
        'docs/architectures/interfaces.md',
        /compound `superRefine` of the (\w+) tools/g,
      ),
      ...claimsWithSource('docs/architectures/security.md', /holds for all (\d+) tools/g),
      ...claimsWithSource('docs/architectures/deployment.md', /Call any of the (\d+) tools/g),
      ...claimsWithSource(
        'docs/architectures/functional-architecture.md',
        /mcp-server — (\d+) tools/g,
      ),
      ...claimsWithSource('docs/architectures/technology-stack.md', /# (\d+) registered tools/g),
    ];
    // If a sentence is reworded, its pattern stops matching and the array shrinks — which would let
    // the test pass while checking less than it claims. The claim COUNT is therefore asserted too.
    expect(claims.length).toBeGreaterThanOrEqual(9);
    assertClaims(claims, actual, 'MCP tool count');
  });

  it('states the route count correctly, and does not re-copy the route table (WI-24)', () => {
    // WI-24: §3.2 carried a COPY of the `routes` literal. It drifted twice over — fourteen `chains:`
    // literals that TASK-006 had deleted from the code, and four routes it never grew. The copy is
    // gone; what replaced it is a count plus a shape, and the count is checked here.
    const claims = claimedCounts(
      'docs/architectures/system-architecture.md',
      /holds \*\*(\d+) routes\*\*\s+over\s+\d+\s+distinct\s+capabilities/g,
    );
    expect(claims.length).toBeGreaterThanOrEqual(1);
    expect(claims).toEqual(claims.map(() => routes.length));

    // The distinct-capability count is a DIFFERENT fact (two routes serve
    // `wallet.balances.native`), so it is derived rather than assumed equal to the route count.
    const distinct = new Set(routes.map((route) => route.capability)).size;
    const capabilityClaims = claimedCounts(
      'docs/architectures/system-architecture.md',
      /routes\*\*\s+over\s+(\d+)\s+distinct\s+capabilities/g,
    );
    expect(capabilityClaims.length).toBeGreaterThanOrEqual(1);
    expect(capabilityClaims).toEqual(capabilityClaims.map(() => distinct));

    // The reason the count is checkable at all is that the table is no longer duplicated. Guard the
    // property itself, not just today's numbers: a re-pasted literal would bring back `chains:`,
    // which no route has set since TASK-006 and which ADR-002 D2 deletes outright.
    expect(read('docs/architectures/system-architecture.md')).not.toContain("chains: ['");
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

  it('pairs each tool with its capability IN THE SAME BLOCK (R-119)', () => {
    // **A substring search over the whole file is not this check.** The first version asserted only
    // that the capability id appeared *somewhere* in the document, which every id does — so
    // swapping two tools' capabilities in code left it green while §5 described a pairing that no
    // longer existed. Caught by the adversarial cycle with exactly that mutation
    // (`chain.tvl` ↔ `chain.supply`), and it is not cosmetic: `eval/capabilities.mjs` derives WHICH
    // TOOL TO CALL from the capability, and those two take the same `{ chain }` argument, so the
    // probe would have gone quietly to the wrong tool.
    //
    // So the document's OWN pairing is extracted — each `// Capability: x` anchor is attributed to
    // the nearest `onchain_*` named above it — and compared against the registry.
    // **The id pattern must admit every id the route table can hold** (adversarial cycle 2). The
    // first version matched `[a-z][a-z.-]+`, which silently truncates at `_` or a digit:
    // `privacy.shielded_pool` — already routed in providers.config.ts — captured as
    // `privacy.shielded`. The gate would then accuse a correct document of a typo it does not
    // contain, and no edit to that document could clear it.
    const ANCHOR = /^\/\/ Capability: ([a-z][a-z0-9._-]*)/;
    // 25, not 12: two of the eleven blocks (`dex.volume.history`, `chain.supply`) sat at exactly 12,
    // so documenting one new output field above the anchor would have detached it.
    const ANCHOR_WINDOW = 25;

    const interfaces = read('docs/architectures/interfaces.md');
    const lines = interfaces.split('\n');
    const documented = new Map<string, string>();
    const orphanAnchors: string[] = [];
    lines.forEach((line, index) => {
      const anchor = ANCHOR.exec(line.trim());
      if (!anchor) return;
      for (let back = index; back >= 0 && index - back <= ANCHOR_WINDOW; back -= 1) {
        const tool = /(onchain_[a-z0-9_]+)/.exec(lines[back] ?? '');
        if (tool?.[1]) {
          documented.set(tool[1], anchor[1] as string);
          return;
        }
      }
      orphanAnchors.push(`line ${index + 1}: \`${line.trim()}\``);
    });

    // An anchor too far from its tool name used to surface only as `expected 10 to be 11` — a
    // failure naming no file and no tool, which is the exact defect this file legislates against
    // above. Report the unattributed anchor first, by line, with the cause.
    expect(
      orphanAnchors,
      `A \`// Capability:\` anchor in interfaces.md §5 has no ${'`onchain_*`'} tool name within ` +
        `${ANCHOR_WINDOW} lines above it. Either the tool name is missing from the block, or the ` +
        'block grew past the attribution window and the window needs raising.',
    ).toStrictEqual([]);

    // Not vacuous: if the anchor convention is ever reworded, this empties and everything below
    // would pass by comparing nothing.
    const withCapability = toolSpecs.filter((spec) => spec.capability !== null);
    const undocumented = withCapability
      .filter((spec) => !documented.has(spec.name))
      .map((spec) => spec.name);
    expect(
      undocumented,
      'These tools have no `// Capability:` anchor attributed to them in interfaces.md §5.',
    ).toStrictEqual([]);
    expect(documented.size).toBe(withCapability.length);

    const wrong = withCapability
      .filter((spec) => documented.get(spec.name) !== spec.capability)
      .map(
        (spec) =>
          `${spec.name}: §5 says ${documented.get(spec.name) ?? '(nothing)'}, code says ${spec.capability ?? ''}`,
      );
    expect(
      wrong,
      'A tool block in §5 names a capability the tool does not serve. The pairing is what a reader ' +
        'relies on to pick a tool, and the eval derives which tool to call from it.',
    ).toStrictEqual([]);

    // And no anchor may name a capability nothing serves — a leftover from a retargeted route.
    const served = new Set(toolSpecs.map((spec) => spec.capability).filter(Boolean));
    const stale = [...documented.values()].filter((capability) => !served.has(capability));
    expect(stale, 'interfaces.md names a capability no registered tool serves.').toStrictEqual([]);
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
