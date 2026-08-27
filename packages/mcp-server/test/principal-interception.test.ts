import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CapabilityRegistry,
  routes,
  type CacheStore,
  type ProviderAdapter,
} from '@onchain-intel/core';
import {
  PrincipalMissingError,
  STDIO_PRINCIPAL,
  createHttpPrincipalResolver,
  principalFromToken,
  toAuthInfo,
  type Principal,
} from '../src/auth/principal.js';
import { createBillingStoreStub } from '../src/engine/billing-store.js';
import { defineTool, type ToolContext, type ToolSpec } from '../src/tools/registry.js';
import {
  DEFAULT_MCP_PATH,
  startHttpTransport,
  type RunningHttpTransport,
} from '../src/transport/http.js';
import { TEST_PRINCIPAL, acceptsTestToken, bearerHeader } from './helpers/test-auth.js';

/**
 * Task 014-15 — the principal is resolved in `defineTool`'s wrapper, above the cache and out of the
 * key (R-4, R-5, AC-8, AC-19, AC-26).
 *
 * **Why the hook sits above the cache.** The owner's model is that both clients pay, even when the
 * second was served from cache (`docs/TASK.md:530`). A hook below the cache would miss exactly the
 * requests the margin is built on — cache HITS are billable, and `CapabilityRegistry.resolve()`
 * reads the cache as step 3 of its own gate order, above `isAvailable()` and above the budget gate.
 *
 * **Why this wrapper and not `resolve-capability.ts`.** Two handlers never enter that file:
 * `onchain_ping` and `onchain_list_chains` answer synchronously. This wrapper is the one place in
 * `src` that registers a tool spec, so the hook cannot be forgotten by a twenty-first tool.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

type ToolCallback = (input: unknown, extra: { authInfo?: AuthInfo }) => Promise<unknown>;

let running: RunningHttpTransport | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

function captureCallback(spec: ToolSpec, ctx: ToolContext): ToolCallback {
  let captured: ToolCallback | undefined;
  const fake = {
    registerTool: (_name: string, _config: unknown, callback: ToolCallback) => {
      captured = callback;
      return { remove: () => undefined, disable: () => undefined };
    },
  } as unknown as McpServer;
  spec.register(fake, ctx);
  if (captured === undefined) throw new Error(`${spec.name} registered no callback`);
  return captured;
}

const NETWORK_PRINCIPAL: Principal = principalFromToken(TEST_PRINCIPAL);
const OTHER_PRINCIPAL: Principal = {
  ...NETWORK_PRINCIPAL,
  principalId: '01JOTHERTOKEN00000000000AB',
  userId: '01JOTHERUSER000000000000AB',
  role: 'admin',
};

describe('TC-E2E-02 / AC-19: the wrapper resolves the principal from what the transport attached', () => {
  const seenBy = (spec: ToolSpec, authInfo: AuthInfo | undefined): Promise<Principal> => {
    let seen: Principal | undefined;
    const probe = defineTool({
      name: 'onchain_probe',
      title: 'Probe',
      description: 'reports the principal it was handed',
      inputSchema: z.object({}),
      outputSchema: z.object({ note: z.string() }),
      capability: null,
      needs: ['principal'],
      handler: (_input, ctx) => {
        seen = ctx.principal;
        return { ok: true, output: { note: 'ok' } };
      },
    });
    void spec;
    return captureCallback(probe, {
      version: '0.0.0-test',
      registry: new CapabilityRegistry(routes, new Map()),
      principal: STDIO_PRINCIPAL,
      principals: createHttpPrincipalResolver(),
      billing: createBillingStoreStub(),
    })({}, authInfo === undefined ? {} : { authInfo }).then(() => {
      if (seen === undefined) throw new Error('the handler never ran');
      return seen;
    });
  };

  it('unpacks what `toAuthInfo` packed, transport and role included', async () => {
    const seen = await seenBy({} as ToolSpec, toAuthInfo(NETWORK_PRINCIPAL));
    expect(seen).toStrictEqual(NETWORK_PRINCIPAL);
    expect(seen.transport).toBe('http');
  });

  it('REFUSES rather than falling back when the http path carries no principal', async () => {
    // The stdio constant is `role: 'admin'`. A fallback here would turn a plumbing bug into an
    // administrator — an escalation wearing the clothes of a default.
    await expect(seenBy({} as ToolSpec, undefined)).rejects.toBeInstanceOf(PrincipalMissingError);
    await expect(seenBy({} as ToolSpec, { token: '', clientId: 'x', scopes: [] })).rejects.toThrow(
      /absent or malformed/,
    );
  });

  it('with no resolver injected the constant answers — stdio is unchanged', async () => {
    let seen: Principal | undefined;
    const probe = defineTool({
      name: 'onchain_probe',
      title: 'Probe',
      description: 'reports the principal it was handed',
      inputSchema: z.object({}),
      outputSchema: z.object({ note: z.string() }),
      capability: null,
      needs: ['principal'],
      handler: (_input, ctx) => {
        seen = ctx.principal;
        return { ok: true, output: { note: 'ok' } };
      },
    });
    await captureCallback(probe, {
      version: '0.0.0-test',
      registry: new CapabilityRegistry(routes, new Map()),
      principal: STDIO_PRINCIPAL,
      billing: createBillingStoreStub(),
    })({}, {});
    expect(seen).toBe(STDIO_PRINCIPAL);
  });

  it('carries no secret: AuthInfo.token is empty and the token never leaves the transport', () => {
    const packed = toAuthInfo(NETWORK_PRINCIPAL);
    expect(packed.token).toBe('');
    expect(JSON.stringify(packed)).not.toContain('oi_');
    // `clientId` is the token ID, which discloses nothing `api_tokens.id` does not.
    expect(packed.clientId).toBe(TEST_PRINCIPAL.tokenId);
  });
});

describe('TC-UNIT-01 / TC-UNIT-04 / AC-8: the principal is not in the cache key', () => {
  /** Records every key the registry asked the cache about. */
  function spyCache(): { store: CacheStore; hashes: string[] } {
    const hashes: string[] = [];
    return {
      hashes,
      store: {
        get: (_provider: string, _capability: string, argsHash: string) => {
          hashes.push(argsHash);
          return Promise.resolve(undefined);
        },
        set: () => Promise.resolve(),
      },
    };
  }

  const fakeAdapter = (): ProviderAdapter =>
    ({
      id: 'blockchain-info',
      isAvailable: () => ({ ok: true }),
      chainSupport: () => true,
      capabilities: () => ['chain.supply'],
      costOf: () => 0,
      fetch: () => Promise.reject(new Error('no network in this test')),
      normalize: (value: unknown) => value,
    }) as unknown as ProviderAdapter;

  /** Forwards whatever it was given straight into the key, so the key's sensitivity is visible. */
  const argsPassingTool = (): ToolSpec =>
    defineTool({
      name: 'onchain_probe',
      title: 'Probe',
      description: 'passes its arguments through to the resolver',
      inputSchema: z.object({}).passthrough(),
      outputSchema: z.object({ note: z.string() }),
      capability: 'chain.supply',
      needs: ['registry', 'principal'],
      handler: async (input: Record<string, unknown>, ctx) => {
        await ctx.registry.resolve('chain.supply', 'bitcoin', input).catch(() => undefined);
        return { ok: true as const, output: { note: 'ok' } };
      },
    });

  const resolvingTool = (): ToolSpec =>
    defineTool({
      name: 'onchain_probe',
      title: 'Probe',
      description: 'resolves a capability so the cache is consulted',
      inputSchema: z.object({ chain: z.string() }),
      outputSchema: z.object({ note: z.string() }),
      capability: 'chain.supply',
      needs: ['registry', 'principal'],
      handler: async (input: { chain: string }, ctx) => {
        try {
          await ctx.registry.resolve('chain.supply', input.chain, { chain: input.chain });
        } catch {
          // Irrelevant: the cache was already consulted, which is what this measures.
        }
        return { ok: true, output: { note: 'ok' } };
      },
    });

  it('two different principals produce the SAME key for the same arguments', async () => {
    const { store, hashes } = spyCache();
    const registry = new CapabilityRegistry(
      routes,
      new Map([['blockchain-info', fakeAdapter()]]),
      store,
    );
    const call = (principal: Principal): Promise<unknown> =>
      captureCallback(resolvingTool(), {
        version: '0.0.0-test',
        registry,
        principal: STDIO_PRINCIPAL,
        principals: createHttpPrincipalResolver(),
        billing: createBillingStoreStub(),
      })({ chain: 'bitcoin' }, { authInfo: toAuthInfo(principal) });

    await call(NETWORK_PRINCIPAL);
    await call(OTHER_PRINCIPAL);

    // Not vacuous: the cache WAS consulted, twice.
    expect(hashes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(hashes).size, 'the key changed when only the principal changed').toBe(1);
  });

  it('and the exclusion is load-bearing: a principal field folded into the args DOES move it', async () => {
    // Without this control the test above would pass just as well on a key that ignored its
    // arguments entirely — which is the shape of a gate that has stopped asking (L-10, memory M6).
    // Measured through the same spy, so it is the SAME key construction under test, not a second
    // copy of it. (`deriveArgsHash` is not re-exported from the package index and lives in another
    // rootDir, so it cannot be called from here — the cache seam is the reachable measurement.)
    const { store, hashes } = spyCache();
    const registry = new CapabilityRegistry(
      routes,
      new Map([['blockchain-info', fakeAdapter()]]),
      store,
    );
    const call = (args: Record<string, unknown>): Promise<unknown> =>
      captureCallback(argsPassingTool(), {
        version: '0.0.0-test',
        registry,
        principal: STDIO_PRINCIPAL,
        principals: createHttpPrincipalResolver(),
        billing: createBillingStoreStub(),
      })(args, { authInfo: toAuthInfo(NETWORK_PRINCIPAL) });

    await call({ chain: 'bitcoin' });
    await call({ chain: 'bitcoin', principalId: NETWORK_PRINCIPAL.principalId });
    expect(hashes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(hashes).size, 'a principal field in the args left the key unmoved').toBe(2);
  });

  it('the key has exactly two inputs, read off the declaration', () => {
    const source = readFileSync(path.join(repoRoot, 'packages/core/src/net/args-hash.ts'), 'utf8');
    expect(source).toContain('deriveArgsHash(capability: string, args: Record<string, unknown>)');
    // And no principal vocabulary anywhere in the engine's own cache-key module.
    for (const field of ['principalId', 'accessProfileId', 'Principal']) {
      expect(source, `args-hash.ts names ${field}`).not.toContain(field);
    }
  });
});

describe('TC-UNIT-02 / TC-UNIT-03: the principal reaches neither stderr nor `_meta`', () => {
  it('a full tool call writes no principal id to stderr', async () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const probe = defineTool({
        name: 'onchain_probe',
        title: 'Probe',
        description: 'refuses, so the diagnostics path runs too',
        inputSchema: z.object({}),
        outputSchema: z.object({ note: z.string() }),
        capability: null,
        needs: ['principal'],
        handler: () => ({ ok: false, reason: 'capability unavailable: probe on nowhere' }),
      });
      await captureCallback(probe, {
        version: '0.0.0-test',
        registry: new CapabilityRegistry(routes, new Map()),
        principal: STDIO_PRINCIPAL,
        principals: createHttpPrincipalResolver(),
        billing: createBillingStoreStub(),
      })({}, { authInfo: toAuthInfo(NETWORK_PRINCIPAL) });
    } finally {
      process.stderr.write = original;
    }
    // R-5.3: a principal id on stderr ties a log line to the payer with no access control on the
    // log. The event line carries the `diagnostics.id`; the principal is read from the table.
    expect(written.join('')).not.toContain(NETWORK_PRINCIPAL.principalId);
    expect(written.join('')).not.toContain(NETWORK_PRINCIPAL.userId ?? 'never');
  });

  it('no `_meta` object carries the principal, at either role', async () => {
    const rendered: string[] = [];
    for (const principal of [NETWORK_PRINCIPAL, OTHER_PRINCIPAL]) {
      const probe = defineTool({
        name: 'onchain_probe',
        title: 'Probe',
        description: 'publishes every _meta part it can',
        inputSchema: z.object({}),
        outputSchema: z.object({ note: z.string() }),
        capability: null,
        needs: ['principal'],
        handler: () => ({
          ok: true as const,
          output: { note: 'ok' },
          cache: { status: 'miss', provider: 'probe', capability: 'chain.supply' },
          budget: { provider: 'nansen', creditsUsedToday: 10 },
        }),
      });
      const result = await captureCallback(probe, {
        version: '0.0.0-test',
        registry: new CapabilityRegistry(routes, new Map()),
        principal: STDIO_PRINCIPAL,
        principals: createHttpPrincipalResolver(),
        billing: createBillingStoreStub(),
      })({}, { authInfo: toAuthInfo(principal) });
      rendered.push(JSON.stringify(result));
    }
    expect(rendered).toHaveLength(2);
    for (const payload of rendered) {
      // Not vacuous: `_meta` really was published.
      expect(payload).toContain('_meta');
      expect(payload).not.toContain('principalId');
      expect(payload).not.toContain(NETWORK_PRINCIPAL.principalId);
      expect(payload).not.toContain(OTHER_PRINCIPAL.principalId);
    }
  });
});

describe('TC-UNIT-05: `server.registerTool` is reached from one place, with one named exception', () => {
  it('names every call site, and the second one registers no tool spec', () => {
    const srcDirectory = path.join(repoRoot, 'packages/mcp-server/src');
    const sites: string[] = [];
    for (const file of readdirSync(srcDirectory, { recursive: true, encoding: 'utf8' })) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(path.join(srcDirectory, file), 'utf8');
      // The call, not the word: a docstring naming it is not a call site.
      for (const found of source.matchAll(/\bserver\s*\n?\s*\.registerTool\(/g)) {
        void found;
        sites.push(file);
      }
    }
    // **Two, and the acceptance criterion says one.** The criterion is about TOOL SPECS, and it
    // holds: `tools/registry.ts` is the only place a spec is registered. `server.ts`'s second call
    // is `keepToolListAnswerable` (task 014-04), which registers a placeholder and REMOVES it in the
    // same expression so `tools/list` answers `[]` for a profile that permits no tool — it registers
    // nothing that survives, and no principal ever reaches it. Recorded here rather than excluded
    // silently: the criterion as written is false against the tree, and pretending otherwise is how
    // a gate becomes a suppression nobody re-reads.
    expect(sites.sort()).toStrictEqual(['server.ts', 'tools/registry.ts']);
    const serverSource = readFileSync(path.join(srcDirectory, 'server.ts'), 'utf8');
    expect(serverSource).toContain('function keepToolListAnswerable');
    expect(serverSource).toContain('.remove();');
    // And the exempted site registers a name that is not in the inventory.
    expect(serverSource).toContain("'onchain_none'");
  });
});

describe('TC-E2E-01 / AC-19: an unauthenticated call reaches neither the cache nor `resolve()`', () => {
  it('refuses at the transport, with both counters at zero', async () => {
    let cacheReads = 0;
    let fetches = 0;
    const cache: CacheStore = {
      get: () => {
        cacheReads += 1;
        return Promise.resolve(undefined);
      },
      set: () => Promise.resolve(),
    };
    const registry = new CapabilityRegistry(routes, new Map(), cache);
    const authenticate = acceptsTestToken();
    running = await startHttpTransport({
      createSessionServer: () => {
        const server = new McpServer({ name: 'interception', version: '0.0.0-test' });
        const spec = defineTool({
          name: 'onchain_probe',
          title: 'Probe',
          description: 'would consult the cache if it ever ran',
          inputSchema: z.object({}),
          outputSchema: z.object({ note: z.string() }),
          capability: 'chain.supply',
          needs: ['registry', 'principal'],
          handler: async (_input, ctx) => {
            fetches += 1;
            await ctx.registry.resolve('chain.supply', 'bitcoin', {}).catch(() => undefined);
            return { ok: true as const, output: { note: 'ok' } };
          },
        });
        spec.register(server, {
          version: '0.0.0-test',
          registry,
          principal: STDIO_PRINCIPAL,
          principals: createHttpPrincipalResolver(),
          billing: createBillingStoreStub(),
        });
        return server;
      },
      authenticate,
      bind: '127.0.0.1',
      port: 0,
    });

    const endpoint = new URL(`http://127.0.0.1:${String(running.address.port)}${DEFAULT_MCP_PATH}`);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'onchain_probe', arguments: {} },
      }),
    });
    await response.text();

    expect(response.status).toBe(401);
    expect(cacheReads, 'an unauthenticated request read the cache').toBe(0);
    expect(fetches, 'an unauthenticated request entered a handler').toBe(0);
  });

  it('and the SAME call with a valid token does reach both — the control', async () => {
    let cacheReads = 0;
    let handlerRuns = 0;
    const cache: CacheStore = {
      get: () => {
        cacheReads += 1;
        return Promise.resolve(undefined);
      },
      set: () => Promise.resolve(),
    };
    const adapter = {
      id: 'blockchain-info',
      isAvailable: () => ({ ok: true }),
      chainSupport: () => true,
      capabilities: () => ['chain.supply'],
      costOf: () => 0,
      fetch: () => Promise.reject(new Error('no network in this test')),
      normalize: (value: unknown) => value,
    } as unknown as ProviderAdapter;
    const registry = new CapabilityRegistry(routes, new Map([['blockchain-info', adapter]]), cache);
    running = await startHttpTransport({
      createSessionServer: () => {
        const server = new McpServer({ name: 'interception', version: '0.0.0-test' });
        defineTool({
          name: 'onchain_probe',
          title: 'Probe',
          description: 'consults the cache',
          inputSchema: z.object({}),
          outputSchema: z.object({ note: z.string() }),
          capability: 'chain.supply',
          needs: ['registry', 'principal'],
          handler: async (_input, ctx) => {
            handlerRuns += 1;
            await ctx.registry
              .resolve('chain.supply', 'bitcoin', { chain: 'bitcoin' })
              .catch(() => undefined);
            return { ok: true as const, output: { note: ctx.principal.transport } };
          },
        }).register(server, {
          version: '0.0.0-test',
          registry,
          principal: STDIO_PRINCIPAL,
          principals: createHttpPrincipalResolver(),
          billing: createBillingStoreStub(),
        });
        return server;
      },
      authenticate: acceptsTestToken(),
      bind: '127.0.0.1',
      port: 0,
    });

    const client = new Client({ name: 'interception', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${String(running.address.port)}${DEFAULT_MCP_PATH}`),
      { requestInit: { headers: bearerHeader() } },
    );
    await client.connect(transport);
    const result = (await client.callTool({ name: 'onchain_probe', arguments: {} })) as {
      structuredContent?: { note?: string };
    };
    await client.close();

    expect(handlerRuns).toBe(1);
    expect(cacheReads).toBeGreaterThan(0);
    // TC-E2E-02: the principal that reached the handler came from the wire, not from the constant.
    expect(result.structuredContent?.note).toBe('http');
  });
});
