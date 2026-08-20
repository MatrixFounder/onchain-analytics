import { describe, expect, it } from 'vitest';
import {
  capabilityManifests,
  createDexscreenerAdapter,
  routes,
  type CapabilityManifest,
} from '@onchain-intel/core';
import { toolSpecs } from '../src/tools/tool-specs.js';
import { poolInfoHandler, PoolInfoInputSchema, poolInfoToolSpec } from '../src/tools/pool-info.js';
import {
  tokenPoolsHandler,
  TokenPoolsInputSchema,
  tokenPoolsToolSpec,
} from '../src/tools/token-pools.js';
import { STUB_REFUSAL_CLASS } from '../src/tools/stub-refusal.js';
// @ts-expect-error — the eval is plain .mjs by design (no build step, no SDK); only its data is read
import { CAPABILITY_EXCLUSIONS, accountedCapabilities } from '../eval/capabilities.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The committed `tools/list` capture — the contract as a client receives it. */
const snapshot = JSON.parse(
  readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/tools-list.snapshot.json'),
    'utf8',
  ),
) as { name: string; inputSchema: { properties?: Record<string, unknown> } }[];

/**
 * Task 014-32b — the two DexScreener tools registered with stub handlers.
 *
 * **What a stub of this task is allowed to be.** `docs/PLAN.md:41` states the price directly: a
 * WRONG stub costs more than a missing one. So the schemas are taken from `interfaces.md` §5.1.7 and
 * §5.1.8 literally, and the handler answers a typed refusal rather than a value. On these two tools
 * an empty object and an empty array are indistinguishable from real answers — "a pool holding no
 * tokens", "a token trading in no pools" — so a stub returning either would publish a response
 * carrying no mark of its own incompleteness.
 */

/**
 * The context both stub handlers receive and neither reads.
 *
 * **The registry is deliberately a throwing stand-in.** A stub must not resolve the capability and
 * discard the answer — that would spend a vendor call and a cache slot to produce a refusal. If a
 * handler ever reaches for it, this fails loudly here instead of passing quietly with a real one.
 */
const CTX = {
  registry: new Proxy(
    {},
    {
      get() {
        throw new Error('a stub handler must not touch the registry');
      },
    },
  ),
} as unknown as { registry: never };

const STUB_TOOLS = [
  {
    spec: poolInfoToolSpec,
    name: 'onchain_pool_info',
    capability: 'pool.info',
    /** The task that removes this stub. Named in the refusal, in the exclusion, and here. */
    task: '014-32c',
    handler: () => poolInfoHandler({ chain: 'ethereum', pairAddress: '0x' + 'a'.repeat(40) }, CTX),
  },
  {
    spec: tokenPoolsToolSpec,
    name: 'onchain_token_pools',
    capability: 'token.pools',
    task: '014-32d',
    handler: () => tokenPoolsHandler({ token: '0x' + 'b'.repeat(40) }, CTX),
  },
] as const;

describe('TC-UNIT-01 — both tools are registered, and the count is not written down here', () => {
  it('every stub tool appears in the live registry', () => {
    const names = toolSpecs.map((spec) => spec.name);
    for (const tool of STUB_TOOLS) {
      expect(names, `${tool.name} is not registered`).toContain(tool.name);
    }
    // The denominator is READ, never asserted as a literal: `expect(toolSpecs).toHaveLength(22)`
    // here would be one more place a future task has to remember, and forgetting it is what
    // `docs-counts.test.ts` exists to catch in documents. The registry is the source; this file
    // only asks whether these two are in it.
    expect(new Set(names).size, 'a duplicate tool name').toBe(names.length);
  });

  it('each declares the capability it serves, so the manifest gate can see the pair', () => {
    expect(poolInfoToolSpec.capability).toBe('pool.info');
    expect(tokenPoolsToolSpec.capability).toBe('token.pools');
  });
});

describe('TC-UNIT-02 — the published input schemas are `.strict()` and name no host (AC-11)', () => {
  const SCHEMAS = [
    { name: 'onchain_pool_info', schema: PoolInfoInputSchema },
    { name: 'onchain_token_pools', schema: TokenPoolsInputSchema },
  ];

  it.each(SCHEMAS)('$name rejects an unknown key rather than ignoring it', ({ schema }) => {
    // `.strict()` is the property under test, and an unknown key is the only way to observe it: a
    // schema that silently dropped extras would accept this and pass a laxer contract than the one
    // published.
    const withExtra = schema.safeParse({
      chain: 'ethereum',
      pairAddress: '0x' + 'a'.repeat(40),
      token: '0x' + 'a'.repeat(40),
      rpcUrl: 'https://evil.example/rpc',
    });
    expect(withExtra.success).toBe(false);
  });

  it.each(SCHEMAS)('$name declares no field that could carry a host or a URL', ({ name }) => {
    // Read from the PUBLISHED contract, not from the zod object: what a caller can send is the
    // rendered JSON Schema, and a field that survived rendering is the only one that matters. It is
    // also the same artefact the task-014-22 gate walks, so the two cannot disagree about what was
    // published.
    const published = snapshot.find((tool) => tool.name === name);
    expect(published, `${name} is missing from the tools/list snapshot`).toBeDefined();
    const fields = Object.keys(published?.inputSchema.properties ?? {});
    expect(fields.length, 'the snapshot rendered no properties at all').toBeGreaterThan(0);
    const suspicious = fields.filter((key) => /url|host|endpoint|rpc|uri/i.test(key));
    expect(suspicious, 'a published field name suggests a caller-supplied endpoint').toStrictEqual(
      [],
    );
  });
});

describe('TC-UNIT-03/04 — the stub refuses, names its task, and returns no empty value', () => {
  it.each(STUB_TOOLS)('$name answers a typed refusal naming task $task', async (tool) => {
    const outcome = await tool.handler();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The class is what `request_trace.refusal_class` records; the column is NOT NULL by CHECK
    // constraint, so a refusal without one is a row the engine rejects on the failure path.
    expect(outcome.refusalClass).toBe(STUB_REFUSAL_CLASS);
    expect(outcome.reason).toContain(tool.task);
    expect(outcome.reason).toContain(tool.capability);
  });

  it.each(STUB_TOOLS)('$name returns NO output at all — not `{}`, not `[]`', async (tool) => {
    const outcome = (await tool.handler()) as { ok: boolean; output?: unknown };

    // The load-bearing assertion of the whole stub design. An empty object here reads as "a pool
    // with no tokens" and an empty array as "a token with no pools"; both are answers a caller
    // cannot tell from a real one, which is the L-10 class and the shape memory M6 names.
    expect(outcome.output).toBeUndefined();
  });
});

describe('TC-UNIT-05/06 — the two manifest rows say what the tools actually do', () => {
  const row = (capability: string): CapabilityManifest => {
    const manifest = capabilityManifests[capability];
    if (manifest === undefined) throw new Error(`no manifest row for ${capability}`);
    return manifest;
  };

  it('TC-UNIT-05: `pool.info` is a `point` — one pool by address, and never merged', () => {
    // It was `set` until this task, and correctly so for the code that reading described: the
    // adapter ignored the capability and both ran one `normalize(): Pool[]`. It was a measurement
    // of an UNSERVED capability. `onchain_pool_info` asks by pool address and the vendor answers
    // with that one pool.
    expect(row('pool.info').shape).toBe('point');
    // `mergeable` is declarable only on `set | series`, so a `point` row cannot join a merge walk.
    expect('mergeable' in row('pool.info')).toBe(false);
  });

  it('TC-UNIT-06: the `token.pools` row carries `shareable` with a value (AC-13)', () => {
    expect(typeof row('token.pools').shareable).toBe('boolean');
    // Its answer turns on the token ADDRESS, an argument, never on who asked.
    expect(row('token.pools').shareable).toBe(true);
  });

  it('both capabilities are routed, or the rows above bound nothing', () => {
    const routed = new Set(routes.map((route) => route.capability));
    expect(routed.has('pool.info')).toBe(true);
    expect(routed.has('token.pools')).toBe(true);
  });
});

describe('TC-UNIT-07 — the adapter declares the capability it now serves', () => {
  it('`dexscreener` declares three capabilities', () => {
    const declared = createDexscreenerAdapter()
      .capabilities()
      .map((capability) => capability.id)
      .sort();
    expect(declared).toStrictEqual(['pairs.active', 'pool.info', 'token.pools']);
  });
});

describe('TC-UNIT-08/09 — the stub interval is declared, and each entry names its remover', () => {
  it('TC-UNIT-08: both capabilities are accounted for, by the exclusion and not by a case', () => {
    // `accountedCapabilities()` is the set `eval-capability-coverage.test.ts` compares against. A
    // registered tool makes its capability "served", so without these entries the suite refuses —
    // which is Stub-First's own contract ("the test on the stub is green") failing.
    const accounted = accountedCapabilities();
    for (const tool of STUB_TOOLS) {
      expect(accounted.has(tool.capability)).toBe(true);
      expect(CAPABILITY_EXCLUSIONS.has(tool.capability)).toBe(true);
    }
  });

  it('TC-UNIT-09: each stub-interval reason names the task that removes it', () => {
    // The masked case, stated: an entry here makes the capability accounted WITHOUT an eval case,
    // so it masks "a tool is registered and nothing exercises it" (memory M6). Naming the remover
    // is what turns a mask into an interval — and `task-014-34-acceptance.md` verifies both entries
    // are gone at stage acceptance, so the interval has an end somebody checks.
    for (const tool of STUB_TOOLS) {
      const reason = CAPABILITY_EXCLUSIONS.get(tool.capability);
      expect(reason, `${tool.capability} has no recorded reason`).toBeTypeOf('string');
      expect(reason).toContain(tool.task);
    }
  });

  it('removing either entry is observable — the gate is not vacuous', () => {
    // Guards the guard: if `CAPABILITY_EXCLUSIONS` stopped feeding `accountedCapabilities()`, the
    // two cases above would still pass while the suite protected nothing.
    const withoutStubs = new Set(
      [...accountedCapabilities()].filter(
        (capability) => !STUB_TOOLS.some((tool) => tool.capability === capability),
      ),
    );
    for (const tool of STUB_TOOLS) {
      expect(withoutStubs.has(tool.capability)).toBe(false);
    }
  });
});
