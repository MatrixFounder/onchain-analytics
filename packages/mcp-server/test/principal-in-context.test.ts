import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CapabilityRegistry, routes } from '@onchain-intel/core';
import { STDIO_PRINCIPAL, principalFor, type Principal } from '../src/auth/principal.js';
import { defineTool, type ToolContext, type ToolSpec } from '../src/tools/registry.js';
import { toolSpecs } from '../src/tools/tool-specs.js';

/**
 * Task 014-14 — `ctx.principal`, present everywhere and deciding nothing yet (R-4, AC-19 in part).
 *
 * **Why the form lands before the interception.** Task 014-15 resolves the principal in
 * `defineTool`'s wrapper and 014-30 writes the trace row from the same place; both read these fields,
 * so a field added after them is a field neither considered.
 *
 * **What this suite can and cannot see, said rather than implied.** The principal influences no
 * output at this stage, so there is nothing to observe through a client. What IS observable is the
 * seam: which keys each tool declared, and what `project()` hands a handler for a given declaration.
 * The registry-wide walk below reads the context through a getter, so "every tool receives it" is
 * measured on every registered tool rather than inferred from the list.
 */

const inertRegistry = (): CapabilityRegistry => new CapabilityRegistry(routes, new Map());

/**
 * Captures the callback `register` hands to `server.registerTool`, without an SDK server.
 *
 * **Why bypass the SDK here.** With a real server the SDK validates arguments against each tool's
 * `inputSchema` and answers an error BEFORE the handler runs — so a walk over twenty tools with no
 * per-tool argument fixtures would measure the validator, not the context. The wrapper builds the
 * context before it calls the handler, so invoking the captured callback is enough, whatever the
 * handler then does with the arguments.
 */
function captureCallback(spec: ToolSpec, ctx: ToolContext): (input: unknown) => Promise<unknown> {
  let captured: ((input: unknown) => Promise<unknown>) | undefined;
  const fake = {
    registerTool: (
      _name: string,
      _config: unknown,
      callback: (input: unknown) => Promise<unknown>,
    ) => {
      captured = callback;
      return { remove: () => undefined, disable: () => undefined };
    },
  } as unknown as McpServer;
  spec.register(fake, ctx);
  if (captured === undefined) throw new Error(`${spec.name} registered no callback`);
  return captured;
}

describe('TC-UNIT-01: the stdio principal carries the five declared values', () => {
  it('matches the constant `system-architecture.md` §3.4.3 declares', () => {
    expect(STDIO_PRINCIPAL).toStrictEqual({
      principalId: 'local',
      userId: null,
      // DERIVED, not chosen: UC-3 step 3 requires `_meta.budget` locally and R-6.1 gives that field
      // to `admin`. Any other role here would silently withdraw a specified field.
      role: 'admin',
      accessProfileId: null,
      transport: 'stdio',
    });
  });

  it('is frozen — one shared object reaches every local tool call', () => {
    expect(Object.isFrozen(STDIO_PRINCIPAL)).toBe(true);
  });

  it('cannot hold the secret, and that is the mechanism rather than a habit', () => {
    // The SDK's `AuthInfo` carries `token: string`. R-5.3 keeps a principal off stderr and R-5.4 out
    // of `_meta`; a type with no such field makes both halves impossible to get wrong by accident.
    expect(Object.keys(STDIO_PRINCIPAL).sort()).toStrictEqual([
      'accessProfileId',
      'principalId',
      'role',
      'transport',
      'userId',
    ]);
  });
});

describe('TC-UNIT-02 / TC-UNIT-03: every registered tool declares and receives the principal', () => {
  it('declares it in `needs`, over the whole registry, with the count not hardcoded', () => {
    // A hardcoded number is green on a registry a tool fell out of, and red on every tool added.
    expect(toolSpecs.length).toBeGreaterThan(0);
    const missing = toolSpecs.filter((spec) => !spec.needs.includes('principal'));
    expect(missing.map((spec) => spec.name)).toStrictEqual([]);
  });

  it('receives it in the context, measured per tool through a getter', async () => {
    const reads: string[] = [];
    for (const spec of toolSpecs) {
      const ctx = {
        version: '0.0.0-test',
        registry: inertRegistry(),
        get principal(): Principal {
          reads.push(spec.name);
          return STDIO_PRINCIPAL;
        },
      } as ToolContext;
      // The handler runs on an inert registry, so most of them refuse or throw — irrelevant here,
      // because the context is built before the handler is entered.
      await captureCallback(spec, ctx)({}).catch(() => undefined);
    }
    expect([...new Set(reads)]).toHaveLength(toolSpecs.length);
  });

  it('reaches the two tools that resolve no capability at all', async () => {
    // `onchain_ping` and `onchain_list_chains` answer synchronously and never enter
    // `resolve-capability.ts` — which is precisely why 014-15 puts the hook in `defineTool`'s
    // wrapper and not there.
    const synchronous = ['onchain_ping', 'onchain_list_chains'];
    for (const name of synchronous) {
      const spec = toolSpecs.find((entry) => entry.name === name);
      expect(spec, `${name} is not in the registry`).toBeDefined();
      expect(spec?.needs).toContain('principal');
    }
  });
});

describe('TC-UNIT-04: a tool that does not declare it does not get it', () => {
  it('the projection rations `principal` like every other key', async () => {
    let seen: Record<string, unknown> | undefined;
    const spec = defineTool({
      name: 'onchain_probe',
      title: 'Probe',
      description: 'reports the context it was handed',
      inputSchema: z.object({}),
      outputSchema: z.object({ note: z.string() }),
      capability: null,
      needs: [],
      handler: (_input, ctx) => {
        seen = ctx as Record<string, unknown>;
        return { ok: true, output: { note: 'ok' } };
      },
    });
    await captureCallback(spec, {
      version: '0.0.0-test',
      registry: inertRegistry(),
      principal: STDIO_PRINCIPAL,
    })({});
    expect(seen).toBeDefined();
    // `Object.hasOwn`, not `in`: `in` walks the prototype chain, and a polluted
    // `Object.prototype.principal` would satisfy a weaker check on a context that never carried one.
    expect(Object.hasOwn(seen ?? {}, 'principal')).toBe(false);
  });

  it('and hands it over when the tool does declare it', async () => {
    let seen: Principal | undefined;
    const spec = defineTool({
      name: 'onchain_probe',
      title: 'Probe',
      description: 'reads the principal it declared',
      inputSchema: z.object({}),
      outputSchema: z.object({ note: z.string() }),
      capability: null,
      needs: ['principal'],
      handler: (_input, ctx) => {
        seen = ctx.principal;
        return { ok: true, output: { note: 'ok' } };
      },
    });
    await captureCallback(spec, {
      version: '0.0.0-test',
      registry: inertRegistry(),
      principal: STDIO_PRINCIPAL,
    })({});
    expect(seen).toBe(STDIO_PRINCIPAL);
  });
});

describe('TC-UNIT-05: with no resolver injected, the principal is the stdio one', () => {
  it('defaults through one named function, so two call sites cannot disagree', () => {
    expect(principalFor(undefined, undefined)).toBe(STDIO_PRINCIPAL);
    expect(principalFor(undefined, undefined).transport).toBe('stdio');
    expect(principalFor(undefined, undefined).role).toBe('admin');
  });

  it('uses the injected resolver when there is one, and hands it the authInfo verbatim', () => {
    const handed: unknown[] = [];
    const network: Principal = {
      principalId: '01JTOKEN0000000000000000AB',
      userId: '01JUSER00000000000000000AB',
      role: 'user',
      accessProfileId: '01JPHASE00000000000000000A',
      transport: 'http',
    };
    const authInfo = { token: 'oi_secret', clientId: 'c', scopes: [] };
    expect(
      principalFor((info) => {
        handed.push(info);
        return network;
      }, authInfo),
    ).toBe(network);
    expect(handed).toStrictEqual([authInfo]);
  });
});

describe('TC-UNIT-06: a principal missing a field does not compile', () => {
  it('rejects the four-field literal, and the directive proves the check still works', () => {
    // If the requirement ever stopped being enforced, the directive below would become unused and
    // THIS FILE would fail to compile — the same self-correcting shape `tool-spec.test.ts` uses.
    // @ts-expect-error `transport` is required: `request_trace.transport` is declared NOT NULL.
    const incomplete: Principal = {
      principalId: 'local',
      userId: null,
      role: 'admin',
      accessProfileId: null,
    };
    expect(incomplete.principalId).toBe('local');
  });
});
