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
    const known = new Set(['version', 'registry', 'budgetStore']);
    for (const spec of toolSpecs) {
      for (const key of spec.needs) {
        expect(known.has(key), `${spec.name} needs unknown context key ${key}`).toBe(true);
      }
    }
  });

  it('keeps `budgetStore` to the three tools that actually report a credit spend', () => {
    // Least privilege, asserted as data rather than trusted to review: any other tool acquiring the
    // budget store would show up here, and that is the seam where a paid-provider detail could leak
    // into a free tool's response.
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
