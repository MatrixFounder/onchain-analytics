import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CapabilityRegistry, routes, type BudgetStore } from '@onchain-intel/core';
import { defineTool, type ToolContext, type ToolSpec } from '../src/tools/registry.js';
import { toolSpecs } from '../src/tools/tool-specs.js';

/**
 * The registry's own contract (TASK-011, 011-2).
 *
 * These tests exist because two of `defineTool`'s guarantees are the kind that read as true and
 * quietly are not:
 *
 * 1. **Least privilege is a runtime fact, not a type-level promise.** Before the registry, each
 *    tool received a fresh literal from `server.ts`, so a free tool held no reference to the budget
 *    store at all. A loop passing one wide context to every tool would replace that with the
 *    author's self-restraint — weak, because `budgetStore` is optional everywhere, so any tool
 *    could declare it and read it while compiling in silence. `defineTool` projects the object, and
 *    that projection is asserted here rather than assumed.
 * 2. **The narrowing really is a compile error.** A `@ts-expect-error` proves it, and proves it in
 *    a self-correcting way: if the narrowing ever stopped working, the directive would become
 *    unused and *this file would fail to compile*. A comment claiming the same would just be a
 *    comment.
 */

const budgetStore = { read: () => 0 } as unknown as BudgetStore;

function fullContext(): ToolContext {
  return {
    version: '0.0.0-test',
    registry: new CapabilityRegistry(routes, new Map()),
    budgetStore,
  };
}

/** Registers one spec on a real server and returns what `tools/list` publishes for it. */
async function publish(spec: ToolSpec): Promise<Record<string, unknown>> {
  const server = new McpServer({ name: 'tool-spec-test', version: '0.0.0' });
  spec.register(server, fullContext());
  const client = new Client({ name: 'tool-spec-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools[0] as unknown as Record<string, unknown>;
  } finally {
    await client.close();
    await server.close();
  }
}

/** Calls one spec's tool and returns the raw result, `_meta` included. */
async function call(
  spec: ToolSpec,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const server = new McpServer({ name: 'tool-spec-test', version: '0.0.0' });
  spec.register(server, fullContext());
  const client = new Client({ name: 'tool-spec-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.callTool({ name: spec.name, arguments: args })) as unknown as Record<
      string,
      unknown
    >;
  } finally {
    await client.close();
    await server.close();
  }
}

const EchoInput = z.object({ value: z.string() }).strict();
const EchoOutput = z.object({ seen: z.string() }).strict();

describe('defineTool narrows the context a tool receives (R-111)', () => {
  it('hands a handler only the keys it declared in `needs`', async () => {
    let seenKeys: string[] = [];
    const spec = defineTool({
      name: 'probe_needs_registry',
      title: 'Probe',
      description: 'Records which context keys reached the handler.',
      capability: null,
      needs: ['registry'],
      inputSchema: EchoInput,
      outputSchema: EchoOutput,
      handler: (input, ctx) => {
        seenKeys = Object.keys(ctx).sort();
        // Reading a declared key must work; this is the other half of the contract.
        void ctx.registry;
        return { ok: true, output: { seen: input.value } };
      },
    });

    await call(spec, { value: 'x' });

    // The whole point: `budgetStore` and `version` are present in the context `createServer` holds,
    // and absent from the object this tool was handed. Not "present but unused" — absent.
    expect(seenKeys).toStrictEqual(['registry']);
  });

  it('cannot even be written to read an undeclared key', () => {
    defineTool({
      name: 'probe_cannot_read_budget',
      title: 'Probe',
      description: 'Must not compile if it reaches for a key it did not declare.',
      capability: null,
      needs: ['version'],
      inputSchema: EchoInput,
      outputSchema: EchoOutput,
      handler: (input, ctx) => {
        // @ts-expect-error — `budgetStore` was not declared in `needs`, so it is not on this type.
        void ctx.budgetStore;
        return { ok: true, output: { seen: input.value } };
      },
    });
    // The assertion is the compile step above. Kept as a runtime expectation so the test reports
    // as a test rather than as an empty body.
    expect(true).toBe(true);
  });

  it('passes every declared key through, including an optional one that is set', async () => {
    let hadBudgetStore = false;
    const spec = defineTool({
      name: 'probe_needs_budget',
      title: 'Probe',
      description: 'Declares the optional key and expects to receive it.',
      capability: null,
      needs: ['registry', 'budgetStore'],
      inputSchema: EchoInput,
      outputSchema: EchoOutput,
      handler: (input, ctx) => {
        hadBudgetStore = ctx.budgetStore !== undefined;
        return { ok: true, output: { seen: input.value } };
      },
    });

    await call(spec, { value: 'x' });
    expect(hadBudgetStore).toBe(true);
  });
});

describe('defineTool reproduces all three response shapes (R-128)', () => {
  const base = {
    title: 'Probe',
    description: 'Response-shape probe.',
    capability: null,
    needs: [] as const,
    inputSchema: EchoInput,
    outputSchema: EchoOutput,
  };

  it('publishes no `_meta` at all when the outcome carries neither cache nor budget', async () => {
    // `onchain_ping` and `onchain_list_chains` answer exactly like this today. An empty `_meta: {}`
    // would be a wire-visible change, which is why the renderer omits the key rather than emptying it.
    const spec = defineTool({
      ...base,
      name: 'probe_no_meta',
      handler: (input) => ({ ok: true as const, output: { seen: input.value } }),
    });
    const result = await call(spec, { value: 'x' });
    expect(result['_meta']).toBeUndefined();
    expect(result['structuredContent']).toStrictEqual({ seen: 'x' });
  });

  it('publishes `_meta.cache` alone when only cache is present', async () => {
    const cache = { status: 'miss' as const, provider: 'probe', capability: 'probe.cap' };
    const spec = defineTool({
      ...base,
      name: 'probe_cache_meta',
      handler: (input) => ({ ok: true as const, output: { seen: input.value }, cache }),
    });
    const result = await call(spec, { value: 'x' });
    expect(result['_meta']).toStrictEqual({ cache });
  });

  it('publishes `_meta.cache` and `_meta.budget` together when both are present', async () => {
    const cache = { status: 'miss' as const, provider: 'probe', capability: 'probe.cap' };
    const budget = { provider: 'nansen' as const, creditsUsedToday: 10 };
    const spec = defineTool({
      ...base,
      name: 'probe_both_meta',
      handler: (input) => ({ ok: true as const, output: { seen: input.value }, cache, budget }),
    });
    const result = await call(spec, { value: 'x' });
    expect(result['_meta']).toStrictEqual({ cache, budget });
  });

  it('turns a refusal into `isError` with the chosen reason, not a thrown message', async () => {
    const spec = defineTool({
      ...base,
      name: 'probe_refusal',
      handler: () => ({ ok: false as const, reason: 'a reason chosen by the handler' }),
    });
    const result = await call(spec, { value: 'x' });
    expect(result['isError']).toBe(true);
    expect(result['content']).toStrictEqual([
      { type: 'text', text: 'a reason chosen by the handler' },
    ]);
  });
});

describe('defineTool publishes identity faithfully (R-110)', () => {
  it('carries name, title and description through to `tools/list`', async () => {
    const spec = defineTool({
      name: 'probe_identity',
      title: 'Probe identity',
      description: 'Exactly this description.',
      capability: 'probe.cap',
      needs: [],
      inputSchema: EchoInput,
      outputSchema: EchoOutput,
      handler: (input) => ({ ok: true as const, output: { seen: input.value } }),
    });
    const published = await publish(spec);
    expect(published['name']).toBe('probe_identity');
    expect(published['title']).toBe('Probe identity');
    expect(published['description']).toBe('Exactly this description.');
  });

  it('honours a full zod schema, so `.strict()` reaches the published JSON Schema', async () => {
    // The reason `.shape` is rejected by the type: the SDK wraps a raw shape in a NON-strict
    // object, so four tools declared `.strict()` and did not get it. Here the strictness survives.
    const spec = defineTool({
      name: 'probe_strict',
      title: 'Probe strict',
      description: 'Strictness must survive registration.',
      capability: null,
      needs: [],
      inputSchema: EchoInput,
      outputSchema: EchoOutput,
      handler: (input) => ({ ok: true as const, output: { seen: input.value } }),
    });
    const published = await publish(spec);
    const inputSchema = published['inputSchema'] as { additionalProperties?: unknown };
    expect(inputSchema.additionalProperties).toBe(false);
  });
});

describe('the registry is the inventory (R-110, R-112)', () => {
  it('declares every tool exactly once, with no duplicate names', () => {
    const names = toolSpecs.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every tool a non-empty title and description', () => {
    // `title` is required by the type, so this guards the *value*: an empty string satisfies
    // `string` and would publish a blank label.
    for (const spec of toolSpecs) {
      expect(spec.title.trim(), `${spec.name} has no title`).not.toBe('');
      expect(spec.description.trim(), `${spec.name} has no description`).not.toBe('');
    }
  });

  it('states `capability` as an explicit null where a tool serves none', () => {
    // The two that compute their own answer: `onchain_ping` and `onchain_list_chains`. Written as
    // `null` rather than left off, so "serves no capability" is a statement and not an omission.
    const withoutCapability = toolSpecs
      .filter((spec) => spec.capability === null)
      .map((s) => s.name);
    expect(withoutCapability.sort()).toStrictEqual(['onchain_list_chains', 'onchain_ping']);
    for (const spec of toolSpecs) {
      expect(spec.capability === null || spec.capability.length > 0).toBe(true);
    }
  });

  it('routes every declared capability, so no tool advertises something unreachable', () => {
    // TASK-008's actual defect: a capability advertised by a tool that no route could serve. Here
    // it becomes unrepresentable rather than reviewable.
    const routed = new Set(routes.map((route) => route.capability));
    const unroutable = toolSpecs
      .filter((spec) => spec.capability !== null && !routed.has(spec.capability))
      .map((spec) => `${spec.name} -> ${spec.capability ?? ''}`);
    expect(unroutable).toStrictEqual([]);
  });

  it('asks only for context keys that exist', () => {
    // Derived from the same shape `createServer` builds, not restated: a hand-written key list is
    // the exact thing TASK-011 removes, and it would fail this test for an unrelated reason the
    // day `ToolContext` gains a fourth key (adversarial cycle 2).
    const known = new Set(Object.keys(fullContext()));
    for (const spec of toolSpecs) {
      for (const key of spec.needs) {
        expect(known.has(key), `${spec.name} needs unknown context key ${key}`).toBe(true);
      }
    }
  });

  it('keeps `budgetStore` to the three tools that actually report a credit spend', () => {
    // Least privilege, asserted as data rather than trusted to review. **This assertion covers the
    // CONTEXT channel only** — it reads `spec.needs`, i.e. what a tool declares. Acquiring the store
    // some other way would not appear here; the import channel is closed separately, by
    // `no tool module builds its own store` below. The earlier wording claimed this one assertion
    // caught "any other tool acquiring the budget store", which was false (adversarial cycle 2).
    const withBudget = toolSpecs
      .filter((spec) => spec.needs.includes('budgetStore'))
      .map((spec) => spec.name)
      .sort();
    expect(withBudget).toStrictEqual([
      'onchain_entity_label',
      'onchain_smart_money_flows',
      'onchain_token_risk',
    ]);
  });
});

/**
 * Two invariants that hold *by construction* inside every tool module today, gated here so they
 * keep holding for the fourteenth tool (adversarial cycle 2).
 *
 * Both are source-level checks, deliberately. They are statements about **how a fact is declared**,
 * which is a property of the text, not of any single execution: a runtime probe could only cover
 * the tools whose inputs the test can synthesize, whereas these cover every module the day it is
 * added — including one whose handler is never successfully invoked in the offline suite.
 */
/**
 * Source text with block and line comments removed, so a gate below can assert about CODE rather
 * than about prose. Good enough for these checks and deliberately not a parser: it does not
 * understand `//` inside a string literal, which no module under `src/tools` contains.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('each tool module declares its privileges once (adversarial cycle 2)', () => {
  const toolsDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/tools');
  /**
   * A tool module is one that *calls* `defineTool({` — derived, not listed. An exclusion list of the
   * helper modules (`registry.ts`, `budget-meta.ts`, …) would be one more hand-written inventory,
   * and it would go stale the first time a helper is added.
   *
   * Matching `= defineTool({` rather than the bare `defineTool(` keeps prose out: `budget-meta.ts`
   * already mentions `defineTool` in a sentence, and one edit dropping the backticks would have
   * added a fourteenth "module" and reddened the count with a message naming no file (cycle 3).
   */
  const MODULES = readdirSync(toolsDirectory)
    .filter((file) => file.endsWith('.ts'))
    .filter((file) =>
      readFileSync(path.join(toolsDirectory, file), 'utf8').includes('= defineTool({'),
    );

  it('finds one module per registered tool, so the assertions below are not vacuous', () => {
    expect(MODULES, `Modules found: ${MODULES.join(', ')}`).toHaveLength(toolSpecs.length);
  });

  it('names its capability once — the spec field and the resolve call read one constant', () => {
    // Cycle 1 collapsed `capability: '<literal>'` into `capability: CAPABILITY` because a module
    // holding both a literal and a constant declares one fact twice. It reported eleven modules
    // collapsed; it had collapsed nine, and the two it missed — chain-tvl and chain-supply — were
    // the very pair whose capabilities the reviewer had swapped to demonstrate the defect. Nothing
    // failed, because no gate looked. This is that gate.
    const offenders: string[] = [];
    for (const file of MODULES) {
      const source = readFileSync(path.join(toolsDirectory, file), 'utf8');
      const declarations = [...source.matchAll(/^const CAPABILITY = '([a-z][\w.-]*)';$/gm)];

      // **Scoped to the `defineTool({…})` call, and every occurrence inside it, not the first one
      // in the file** (cycle 3). The previous version ran a non-global regex over the whole module,
      // which failed in both directions. It could be defeated: add any earlier two-space
      // `capability: CAPABILITY` — a `CacheMeta` constant is the natural shape — and the spec field
      // below it may go back to a bare literal with the gate still green, restoring the exact split
      // this test exists to forbid. And it could fire falsely: `list-chains.ts` declares an INPUT
      // field named `capability`, which escapes today only because prettier happened to indent that
      // object by four spaces.
      const specStart = source.indexOf('= defineTool({');
      const specBody = specStart === -1 ? '' : source.slice(specStart);
      const specFields = [...specBody.matchAll(/^ {2}capability: (.+),$/gm)].map((m) => m[1]);
      if (specFields.length !== 1) {
        offenders.push(
          `${file}: expected exactly one \`capability:\` field in the defineTool call, found ${specFields.length}`,
        );
        continue;
      }
      const specField = specFields[0];

      if (specField === 'null') {
        // A server-level tool (`ping`, `list_chains`): no capability, and none may be resolved.
        if (declarations.length > 0) offenders.push(`${file}: capability null but declares one`);
        if (source.includes('resolveCapability(')) {
          offenders.push(`${file}: capability null but calls resolveCapability`);
        }
        continue;
      }

      if (declarations.length !== 1) {
        offenders.push(
          `${file}: expected exactly one \`const CAPABILITY\`, found ${declarations.length}`,
        );
        continue;
      }
      if (specField !== 'CAPABILITY') {
        offenders.push(
          `${file}: spec says \`capability: ${specField ?? '(absent)'}\`, not the CAPABILITY constant`,
        );
      }
      // First argument matched as "anything up to the first comma" rather than a dotted identifier:
      // `resolveCapability(registryOf(ctx), …)` would otherwise not be scanned at all (cycle 3).
      for (const call of source.matchAll(/resolveCapability\(\s*[^,]+,\s*([^,]+),/g)) {
        if (call[1]?.trim() !== 'CAPABILITY') {
          offenders.push(
            `${file}: resolves \`${call[1]?.trim() ?? '?'}\`, not the CAPABILITY constant`,
          );
        }
      }
    }
    expect(
      offenders.sort(),
      'A tool declares its capability in more than one place. The spec field and every ' +
        "`resolveCapability` argument must both read the module's single `const CAPABILITY`, so " +
        'that retargeting a tool is one edit and cannot half-apply.',
    ).toStrictEqual([]);
  });

  it('builds no store of its own — privilege arrives through the context or not at all', () => {
    // `needs` rations the CONTEXT. It cannot ration imports: `createBudgetStore` and
    // `createCacheStore` are public exports of @onchain-intel/core, so a tool declaring
    // `needs: ['version']` could construct the budget store itself, open the SQLite file in
    // DATA_DIR, and leave every existing assertion green (verified by mutation, adversarial
    // cycle 2). Least privilege is only a runtime fact while both channels are closed.
    //
    // **Scanned over the whole directory, not just the tool modules** (cycle 3). Scanning only
    // files containing `defineTool({` left the helpers beside them unguarded, and `budget-meta.ts`
    // is the natural place for the drift: it is imported by exactly the three budget-privileged
    // tools, so a fourth tool wanting `_meta.budget` without declaring `needs: ['budgetStore']`
    // gets it by adding one fallback there. That is a plausible developer mistake, not a
    // contrivance, and no lint rule covers the import channel.
    // Comments are stripped before matching. A bare substring search over the raw text made this
    // gate fire on `registry.ts`'s own docstring the moment that docstring started EXPLAINING the
    // rule — a gate that forbids naming the thing it forbids. The alternative, exempting
    // `registry.ts` by name, would be a hand-written exclusion of exactly the kind this task
    // deletes. Code is what matters here: an import or a call, not a sentence.
    const offenders: string[] = [];
    for (const file of readdirSync(toolsDirectory).filter((f) => f.endsWith('.ts'))) {
      const code = stripComments(readFileSync(path.join(toolsDirectory, file), 'utf8'));
      for (const factory of ['createBudgetStore', 'createCacheStore']) {
        if (code.includes(factory)) offenders.push(`${file}: references ${factory}`);
      }
    }
    expect(
      offenders.sort(),
      'A module under src/tools builds its own store. For `createBudgetStore` that bypasses `needs` ' +
        'entirely — the projection in registry.ts can only withhold what it owns, and the budget ' +
        'store is genuinely unreachable any other way (the Nansen adapter closes over it). For ' +
        '`createCacheStore` the point is narrower and worth stating honestly: the cache store is ' +
        'not a `ToolContext` key at all, and `CapabilityRegistry.cache` is `private` only in the ' +
        'type system, so any tool holding `registry` can already reach one. What this forbids ' +
        'there is a SECOND better-sqlite3 connection to DATA_DIR, which is its own defect.',
    ).toStrictEqual([]);
  });
});
