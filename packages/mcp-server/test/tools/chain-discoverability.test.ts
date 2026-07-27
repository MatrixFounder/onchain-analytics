import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CapabilityRegistry,
  createDefillamaAdapter,
  createNansenAdapter,
  loadChainRegistry,
  routes,
  type ProviderAdapter,
} from '@onchain-intel/core';
import { loadEnv } from '../../src/env.js';
import { createServer } from '../../src/server.js';
import { listChainsHandler } from '../../src/tools/list-chains.js';

/**
 * vdd-multi cycle 5, M-2 + M-8 — the chain set has to be VISIBLE to the model, and cheap to ask
 * about.
 *
 * Dropping the 458-value `z.enum` saved ~8.7k tokens of schema per request; it also removed the
 * only place the model could see which chains exist. That made each tool's `description` the sole
 * routing signal — and seven of them still described the pre-TASK-006 world ("on ethereum or
 * solana"), i.e. the task's headline capability was invisible to its only consumer.
 */
function ctx() {
  const adapters = new Map<string, ProviderAdapter>([
    ['defillama', createDefillamaAdapter()],
    ['nansen', createNansenAdapter()],
  ]);
  return { registry: new CapabilityRegistry([...routes], adapters) };
}

describe('M-2 — tool descriptions describe the post-TASK-006 world', () => {
  // Read through a real `tools/list`, not from the source modules: what matters is what the model
  // is actually shown, after the SDK has rendered every schema.
  let tools: { name: string; description?: string; inputSchema: unknown }[] = [];
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: 'chain-discoverability-test', version: '0.0.0' });
    const server = createServer({
      env: loadEnv({}),
      version: '0.0.0-test',
      registry: ctx().registry,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    tools = (await client.listTools()).tools;
  });

  afterAll(async () => {
    await client.close();
  });

  it('registers the full tool set (the sweep below is only as good as its input)', () => {
    expect(tools.length).toBeGreaterThanOrEqual(10);
  });

  it('no description still claims the engine is limited to ethereum or solana', () => {
    const stale = tools.filter((tool) => /on ethereum or solana/i.test(tool.description ?? ''));
    expect(stale.map((tool) => tool.name)).toEqual([]);
  });

  it('every chain-taking tool points at the discovery tool', () => {
    // Naming `onchain_list_chains` is what replaces the enum: the model can find the valid values
    // when it needs them instead of carrying all 458 in every request.
    const chainTools = tools.filter((tool) => {
      const schema = tool.inputSchema as { properties?: Record<string, unknown> };
      return (
        schema.properties !== undefined &&
        'chain' in schema.properties &&
        tool.name !== 'onchain_list_chains'
      );
    });
    expect(chainTools.length).toBeGreaterThanOrEqual(7);
    for (const tool of chainTools) {
      expect(tool.description ?? '', tool.name).toContain('onchain_list_chains');
    }
  });

  it('`chain` is still an open string, not a re-introduced 458-value enum', () => {
    // The owner decision this whole discovery story exists to serve: a closed enum measured
    // ~8.7k tokens of schema in EVERY request.
    for (const tool of tools) {
      const schema = tool.inputSchema as {
        properties?: Record<string, { enum?: unknown[] }>;
      };
      const chain = schema.properties?.['chain'];
      if (!chain) continue;
      expect(chain.enum, tool.name).toBeUndefined();
    }
  });
});

describe('M-8 — onchain_list_chains does not recompute a constant answer', () => {
  it('a repeat call is cheap and identical', () => {
    const shared = ctx();
    const first = listChainsHandler({ limit: 200 }, shared);

    const started = performance.now();
    const second = listChainsHandler({ limit: 200 }, shared);
    const elapsed = performance.now() - started;

    expect(second).toEqual(first);
    expect(elapsed).toBeLessThan(25);
  });

  it('the memo is per CapabilityRegistry, so a different wiring gets a different answer', () => {
    // Keyed on the registry instance rather than living in module scope — otherwise a second
    // server (or a test with its own adapters) would be served the first one's coverage.
    const full = listChainsHandler({ query: 'ethereum' }, ctx());
    const empty = listChainsHandler(
      { query: 'ethereum' },
      { registry: new CapabilityRegistry([...routes], new Map()) },
    );
    expect(full.chains[0]!.capabilities.length).toBeGreaterThan(0);
    expect(empty.chains[0]!.capabilities).toEqual([]);
  });
});

describe('the discovery answer agrees with the gate', () => {
  it('lists a capability for a chain only where the engine would actually serve it', () => {
    const shared = ctx();
    const coverage = shared.registry.getCoverage();
    const chains = loadChainRegistry();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network call from a discovery assertion');
    });
    try {
      for (const row of listChainsHandler({ limit: 200 }, shared).chains) {
        const chain = chains.resolve(row.slug);
        for (const capability of row.capabilities) {
          expect(coverage.isCovered(capability, chain), `${row.slug}/${capability}`).toBe(true);
        }
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
