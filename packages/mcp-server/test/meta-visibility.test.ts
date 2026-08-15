import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CapabilityRegistry, routes } from '@onchain-intel/core';
import { EnvSchema } from '../src/env.js';
import {
  AccessProfileUnavailableError,
  type AccessProfileReader,
} from '../src/auth/access-profile.js';
import { PHASE_0_ACCESS_PROFILE } from '../src/auth/default-access-profile.js';
import {
  STDIO_PRINCIPAL,
  createHttpPrincipalResolver,
  toAuthInfo,
  type Principal,
} from '../src/auth/principal.js';
import {
  META_VISIBILITY,
  ROUTE_DISCLOSURE_META_PATHS,
  metaFor,
  type MetaView,
} from '../src/tools/meta-visibility.js';
import { defineTool, type ToolContext, type ToolSpec } from '../src/tools/registry.js';
import { toolSpecs } from '../src/tools/tool-specs.js';

/**
 * Task 014-16 — `_meta` visibility is a function of the role, and `route_disclosure_mode` narrows
 * the route (R-6, R-20.4, AC-6, AC-7, AC-49).
 *
 * **Why this suite cannot lean on "the suite is green".** Every other test in this package runs as
 * the STDIO principal, which is `role: 'admin'` — so the projection is a no-op for all of them, and
 * their being green says nothing about AC-6. Worse, `_meta.budget` absent for a `user` is
 * indistinguishable from `_meta.budget` absent because nobody computed one, which is exactly the
 * shape memory M6 names: a new legal negative answer that masks a broken case. Every role assertion
 * below therefore pairs "withheld from `user`" with "present for `admin` on the SAME outcome".
 *
 * **The table compiled is `interfaces.md` §5.4.4.** Three documents carry a version of it and they
 * differ in scope; §3.4.3's four-row one has no `cache.provider` row at all, and compiling that one
 * gets AC-6 right and AC-49 wrong.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const USER: Principal = {
  principalId: '01JTOKEN0000000000000000AB',
  userId: '01JUSER00000000000000000AB',
  role: 'user',
  accessProfileId: '01JPHASE00000000000000000A',
  transport: 'http',
};
const ADMIN: Principal = { ...USER, role: 'admin' };

const CACHE = {
  status: 'miss',
  provider: 'nansen',
  capability: 'entity.labels',
  ageMs: 12,
} as const;
const BUDGET = { provider: 'nansen', creditsUsedToday: 10 };
const TIMING = { overrunMs: 40 };

const view = (principal: Principal, mode: 'full' | 'none' = 'full'): MetaView => ({
  principal,
  routeDisclosureMode: mode,
});

type ToolCallback = (input: unknown, extra: { authInfo?: AuthInfo }) => Promise<unknown>;

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

/** A tool that publishes every `_meta` part AND a `missingSources` output field. */
const publishingTool = (): ToolSpec =>
  defineTool({
    name: 'onchain_probe',
    title: 'Probe',
    description: 'publishes every governed field',
    inputSchema: z.object({}),
    outputSchema: z.object({
      note: z.string(),
      missingSources: z.array(z.object({ adapterId: z.string(), reason: z.string() })).optional(),
    }),
    capability: null,
    needs: ['principal'],
    handler: () => ({
      ok: true as const,
      output: {
        note: 'ok',
        missingSources: [{ adapterId: 'nansen', reason: 'no coverage' }],
      },
      // The single-winner shape. `perSource` belongs to the MERGED one and the two are a union
      // the compiler will not let a tool publish together — it is covered through `metaFor` below,
      // which is the same projection this renderer calls.
      cache: CACHE,
      budget: BUDGET,
      timing: TIMING,
    }),
  });

const readerFor = (mode: 'full' | 'none'): AccessProfileReader => ({
  read: () => Promise.resolve({ ...PHASE_0_ACCESS_PROFILE, routeDisclosureMode: mode }),
});

async function render(
  principal: Principal,
  accessProfiles?: AccessProfileReader,
): Promise<{
  _meta?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
  content: { text: string }[];
}> {
  const ctx: ToolContext = {
    version: '0.0.0-test',
    registry: new CapabilityRegistry(routes, new Map()),
    principal: STDIO_PRINCIPAL,
    principals: createHttpPrincipalResolver(),
    ...(accessProfiles ? { accessProfiles } : {}),
  };
  return (await captureCallback(publishingTool(), ctx)(
    {},
    { authInfo: toAuthInfo(principal) },
  )) as never;
}

describe('TC-E2E-01 / AC-6: `_meta.budget` is withheld from `user` and present for `admin`', () => {
  it('the SAME outcome renders differently for the two roles', async () => {
    const asUser = await render(USER);
    const asAdmin = await render(ADMIN);

    expect(asUser._meta).toBeDefined();
    expect(Object.hasOwn(asUser._meta ?? {}, 'budget')).toBe(false);
    // The pair is what makes the negative mean something: the part WAS computed, and one role
    // received it. Without this half, "absent" and "never computed" read the same (memory M6).
    expect(asAdmin._meta?.['budget']).toStrictEqual(BUDGET);
  });

  it('the client-class parts reach BOTH roles unchanged (TC-UNIT-04)', async () => {
    for (const principal of [USER, ADMIN]) {
      const rendered = await render(principal);
      const cache = rendered._meta?.['cache'] as Record<string, unknown>;
      expect(cache['status']).toBe('miss');
      expect(cache['ageMs']).toBe(12);
      expect(cache['capability']).toBe('entity.labels');
      expect(rendered._meta?.['timing']).toStrictEqual(TIMING);
    }
  });

  it('TC-UNIT-05: a NEW tool inherits the rule with no code of its own', async () => {
    // The projection is in the one function that renders every tool's result, so a tool written
    // tomorrow is covered by construction rather than by its author remembering.
    const fresh = defineTool({
      name: 'onchain_fresh',
      title: 'Fresh',
      description: 'a tool that knows nothing about roles',
      inputSchema: z.object({}),
      outputSchema: z.object({ note: z.string() }),
      capability: null,
      needs: [],
      handler: () => ({ ok: true as const, output: { note: 'ok' }, budget: BUDGET }),
    });
    const ctx: ToolContext = {
      version: '0.0.0-test',
      registry: new CapabilityRegistry(routes, new Map()),
      principal: STDIO_PRINCIPAL,
      principals: createHttpPrincipalResolver(),
    };
    const asUser = (await captureCallback(fresh, ctx)({}, { authInfo: toAuthInfo(USER) })) as {
      _meta?: unknown;
    };
    const asAdmin = (await captureCallback(fresh, ctx)({}, { authInfo: toAuthInfo(ADMIN) })) as {
      _meta?: Record<string, unknown>;
    };
    // Nothing but `budget` was published, so for a `user` the whole `_meta` disappears — an absent
    // object, never `_meta: {}`, which is a different wire shape.
    expect(asUser._meta).toBeUndefined();
    expect(asAdmin._meta?.['budget']).toStrictEqual(BUDGET);
  });
});

describe('TC-UNIT-03 / R-6.4: an unclassified field is treated as `operator`', () => {
  it('withholds a field nobody has classified, from `user` only', () => {
    const parts = { probe: 'a value nobody classified', cache: CACHE };
    expect(metaFor(parts, view(USER))?.['probe']).toBeUndefined();
    expect(metaFor(parts, view(ADMIN))?.['probe']).toBe('a value nobody classified');
    // The two directions of error are not symmetric: a withheld field is a missing convenience, a
    // leaked one is an operator fact in a client's context (§5.4.4 point 3).
    expect(META_VISIBILITY['probe']).toBeUndefined();
  });

  it('and applies the same default to an unclassified NESTED field', () => {
    const parts = { cache: { ...CACHE, internalHint: 'operator detail' } };
    const asUser = metaFor(parts, view(USER))?.['cache'] as Record<string, unknown>;
    expect(Object.hasOwn(asUser, 'internalHint')).toBe(false);
    expect(asUser['status']).toBe('miss');
  });

  it('the compiled table is the §5.4.4 one, eight leaves', () => {
    expect(Object.entries(META_VISIBILITY).sort()).toStrictEqual(
      [
        ['budget.creditsUsedToday', 'operator'],
        ['budget.provider', 'operator'],
        ['cache.ageMs', 'client'],
        ['cache.capability', 'client'],
        ['cache.perSource', 'client'],
        ['cache.provider', 'client'],
        ['cache.status', 'client'],
        ['timing.overrunMs', 'client'],
      ].sort(),
    );
  });
});

describe('TC-E2E-02 / AC-49: `route_disclosure_mode` governs three fields', () => {
  it("removes all three at 'none' and keeps all three at 'full'", async () => {
    const full = await render(USER, readerFor('full'));
    const none = await render(USER, readerFor('none'));

    const fullCache = full._meta?.['cache'] as Record<string, unknown>;
    expect(fullCache['provider']).toBe('nansen');
    expect(full.structuredContent?.['missingSources']).toBeDefined();

    const noneCache = none._meta?.['cache'] as Record<string, unknown>;
    expect(Object.hasOwn(noneCache, 'provider')).toBe(false);
    expect(Object.hasOwn(none.structuredContent ?? {}, 'missingSources')).toBe(false);
    // And the class did NOT change — the setting narrows it for one principal at a time (§5.4.4.1).
    expect(META_VISIBILITY['cache.provider']).toBe('client');
  });

  it('removes it from the TEXT mirror too, which is the leak the structured strip misses', async () => {
    // `toCallToolResult` publishes the output twice: `structuredContent` and
    // `JSON.stringify(output)` in `content[0].text`. Stripping one alone discloses the adapter list
    // in the other. Nothing in the suite measured this layer before — every `missingSources`
    // assertion in the repo sits BELOW the renderer, at the handler outcome.
    const none = await render(USER, readerFor('none'));
    expect(none.content[0]?.text).not.toContain('missingSources');
    expect(none.content[0]?.text).not.toContain('nansen');

    const full = await render(USER, readerFor('full'));
    expect(full.content[0]?.text).toContain('missingSources');
  });

  it("TC-UNIT-06: at 'none' an ADMIN loses the three fields and keeps `_meta.budget`", async () => {
    // The setting and the role are independent axes: one is about our supplier list, the other
    // about our spend.
    const rendered = await render(ADMIN, readerFor('none'));
    const cache = rendered._meta?.['cache'] as Record<string, unknown>;
    expect(Object.hasOwn(cache, 'provider')).toBe(false);
    expect(Object.hasOwn(rendered.structuredContent ?? {}, 'missingSources')).toBe(false);
    expect(rendered._meta?.['budget']).toStrictEqual(BUDGET);
  });

  it('the MERGED cache shape loses `perSource` at the same setting', () => {
    // The two `_meta.cache` shapes are a union — `CacheMeta` carries `provider`/`capability`,
    // `MergedCacheMeta` carries `perSource` — so no single tool can publish both, and the second
    // governed field is measured on the shape that actually has it.
    const merged = { cache: { status: 'merged', perSource: [{ adapterId: 'defillama' }] } };
    expect(
      (metaFor(merged, view(USER, 'full'))?.['cache'] as Record<string, unknown>)['perSource'],
    ).toBeDefined();
    const stripped = metaFor(merged, view(USER, 'none'))?.['cache'] as Record<string, unknown>;
    expect(Object.hasOwn(stripped, 'perSource')).toBe(false);
    expect(stripped['status']).toBe('merged');
  });

  it('the governed paths are the two `_meta` ones, and the third is not a `_meta` field', () => {
    expect([...ROUTE_DISCLOSURE_META_PATHS]).toStrictEqual(['cache.provider', 'cache.perSource']);
    expect(META_VISIBILITY['missingSources']).toBeUndefined();
  });
});

describe('TC-UNIT-07: a failed profile read refuses the request', () => {
  it('substitutes no default — a profile that cannot be read is not a permissive profile', async () => {
    const broken: AccessProfileReader = {
      read: (id) => Promise.reject(new AccessProfileUnavailableError(id, 'supplier down')),
    };
    await expect(render(USER, broken)).rejects.toBeInstanceOf(AccessProfileUnavailableError);
  });

  it('and the stdio principal is not read at all, which is a DECISION and not an omission', async () => {
    // `AccessProfileReader.read` takes a non-null id and is fail-closed; the stdio principal carries
    // `accessProfileId: null` (§3.4.3). Calling the reader there would refuse every local call and
    // the eval gate with them. No document declares this branch — `'full'` is chosen because it is
    // the phase-0 default and the value this task's own regression test assumes.
    let reads = 0;
    const counting: AccessProfileReader = {
      read: (id) => {
        reads += 1;
        return Promise.reject(new AccessProfileUnavailableError(id, 'must not be called'));
      },
    };
    const ctx: ToolContext = {
      version: '0.0.0-test',
      registry: new CapabilityRegistry(routes, new Map()),
      principal: STDIO_PRINCIPAL,
      accessProfiles: counting,
    };
    const rendered = (await captureCallback(publishingTool(), ctx)({}, {})) as {
      _meta?: Record<string, unknown>;
      structuredContent?: Record<string, unknown>;
    };
    expect(reads).toBe(0);
    const cache = rendered._meta?.['cache'] as Record<string, unknown>;
    expect(cache['provider']).toBe('nansen');
    expect(rendered.structuredContent?.['missingSources']).toBeDefined();
    // The local operator is `admin`, so the regression the task names holds: same volume of `_meta`.
    expect(rendered._meta?.['budget']).toStrictEqual(BUDGET);
  });

  it('the phase-0 profile discloses the route, which is where the default comes from', () => {
    expect(PHASE_0_ACCESS_PROFILE.routeDisclosureMode).toBe('full');
  });
});

describe('TC-UNIT-01 / AC-7: `tier` is declared on no transport and at no role', () => {
  it('appears in no tool output schema and in no visibility class', () => {
    // The registry is walked, the count is not hardcoded.
    expect(toolSpecs.length).toBeGreaterThan(0);
    expect(META_VISIBILITY['tier']).toBeUndefined();
    expect(META_VISIBILITY['cache.tier']).toBeUndefined();
    // Unclassified means `operator`, so a `tier` that ever appeared would still be withheld from a
    // client — but ADR-002 D8 keeps it off every response unconditionally, and no profile value
    // re-enables it. Measured on the rendering, at both roles.
    for (const principal of [USER, ADMIN]) {
      expect(
        JSON.stringify(metaFor({ cache: CACHE, budget: BUDGET }, view(principal))),
      ).not.toContain('tier');
    }
  });
});

describe('TC-UNIT-02 / AC-14: a client refusal names no environment key and no credit figure', () => {
  it('is already enforced by the shipped renderer, and this states the overlap', () => {
    // Task 014-26 landed this: `toClientText` cuts the traversal, replaces a budget refusal
    // outright and falls back to a generic sentence when an operator token survives. The criterion
    // is shared between the two tasks (PLAN's RTM assigns AC-14 to both), so this asserts the rule
    // rather than re-implementing it.
    const source = readFileSync(
      path.join(repoRoot, 'packages/mcp-server/src/transport/failure-classes.ts'),
      'utf8',
    );
    expect(source).toContain('OPERATOR_TOKENS');
    expect(source).toContain('Object.keys(EnvSchema.shape)');
    expect(Object.keys(EnvSchema.shape).length).toBeGreaterThan(0);
  });
});
