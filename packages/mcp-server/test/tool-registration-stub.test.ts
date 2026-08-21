import { describe, expect, it } from 'vitest';
import {
  capabilityManifests,
  createDexscreenerAdapter,
  routes,
  type CapabilityManifest,
} from '@onchain-intel/core';
import { toolSpecs } from '../src/tools/tool-specs.js';
import { PoolInfoInputSchema, poolInfoToolSpec } from '../src/tools/pool-info.js';
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
 * A context for a handler that reads the registry, answering only what the closed-interval case
 * needs: a coverage matrix that serves the capability nowhere.
 *
 * **It replaced a hostile Proxy that threw on any registry access**, which was right while a stub
 * existed — a stub resolving the capability and discarding the answer would spend a vendor call and
 * a cache slot to produce a refusal. Both stubs are gone, so the context that proved they touched
 * nothing went with them.
 *
 * This one is not an arbitrary stand-in either. It drives `token-pools.ts` down its
 * coverage-refusal branch, the one path that reaches a verdict without a network call — R-21
 * forbids one here — so it proves two things at once: the stub is gone, and the branch that
 * replaced it works.
 */
const NO_COVERAGE_CTX = {
  registry: {
    getCoverage: () => ({ chainsFor: () => [] }),
    getChainRegistry: () => {
      throw new Error('the coverage-refusal branch must decide before touching the chain registry');
    },
    resolve: () => {
      throw new Error('the coverage-refusal branch must not resolve anything');
    },
  },
} as unknown as { registry: never };

/**
 * The tools still on a stub handler.
 *
 * `onchain_pool_info` left this list in task 014-32c, which gave it the vendor route, the fee
 * derivation and an eval case — the interval closing as designed. Its registration facts are still
 * asserted below, alongside `onchain_token_pools`; only the refusal cases are scoped to what is
 * still stubbed.
 */
/**
 * Both stubs this task registered, and the task that replaced each.
 *
 * **The list is EMPTY of stubs now, and the cases below changed subject accordingly.** While a stub
 * existed, TC-UNIT-03/04 asserted that it refused with a typed class and returned no empty value.
 * Both intervals have closed — `pool.info` in task 014-32c and `token.pools` in 014-32d — so the
 * same cases now assert the OPPOSITE: neither handler answers the stub refusal any more. Deleting
 * them instead would have removed the only mechanical check that an interval ever ended, which is
 * the failure mode every interval entry in this repository is written to avoid.
 */
const FORMER_STUBS = [
  {
    name: 'onchain_token_pools',
    capability: 'token.pools',
    task: '014-32d',
    handler: (): Promise<{ ok: boolean; refusalClass?: string }> =>
      tokenPoolsHandler({ token: '0x' + 'b'.repeat(40) }, NO_COVERAGE_CTX),
  },
] as const;

/** Both tools this task registered — stubbed or not, they are registered and their schemas hold. */
const REGISTERED = [
  { spec: poolInfoToolSpec, name: 'onchain_pool_info', capability: 'pool.info' },
  { spec: tokenPoolsToolSpec, name: 'onchain_token_pools', capability: 'token.pools' },
] as const;

describe('TC-UNIT-01 — both tools are registered, and the count is not written down here', () => {
  it('every tool this task registered appears in the live registry', () => {
    const names = toolSpecs.map((spec) => spec.name);
    for (const tool of REGISTERED) {
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

describe('TC-UNIT-03/04 — the stub interval CLOSED: no handler answers the stub refusal', () => {
  it.each(FORMER_STUBS)(
    '$name no longer refuses with the stub class (task $task)',
    async (tool) => {
      // The handler is driven with a well-formed address nothing deploys, so the outcome may
      // legitimately be a failure — the network is not reachable in CI, and R-21 forbids it being so.
      // What must NOT appear is `ToolLogicNotShipped`: that class means the stub is still in place,
      // and it is the one outcome that would be indistinguishable from "the logic shipped" in every
      // other test here, all of which drive the SPEC rather than the handler.
      const outcome = await tool.handler();
      expect(
        outcome.refusalClass,
        `${tool.name} still answers the stub refusal — task ${tool.task} was supposed to remove it`,
      ).not.toBe(STUB_REFUSAL_CLASS);
      // Positively, not only negatively: the handler took the coverage branch and produced the class
      // the registry itself would have produced for the same fact.
      expect(outcome.refusalClass).toBe('CapabilityUnavailableError');
    },
  );

  it('the eval exclusion that covered the stub is gone', () => {
    // The interval's other half. An exclusion outliving its stub makes the capability `accounted`
    // with no case behind it — a mask, and the exact thing `docs/tasks/task-014-34-acceptance.md`
    // re-checks at stage acceptance. Asserted here as well because this is the file that owns the
    // interval, and a check that lives only in a later task is a check nobody runs today.
    for (const tool of FORMER_STUBS) {
      expect(
        CAPABILITY_EXCLUSIONS.has(tool.capability),
        `${tool.capability} is still excluded from the eval although its logic shipped`,
      ).toBe(false);
    }
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

describe('TC-UNIT-08/09 — both stub intervals closed, and closing is what is now asserted', () => {
  /**
   * The two capabilities that were ever stubbed, and the task that shipped each.
   *
   * These cases used to assert the OPEN state: the capability is accounted for by an EXCLUSION, and
   * that exclusion names its remover. Both intervals have now ended, so asserting the open state
   * would be asserting a lie. They assert the closed state instead — the same obligation seen from
   * the other end, and the reason they were not simply deleted: a deleted case cannot notice an
   * exclusion coming back.
   */
  const SHIPPED = [
    { capability: 'pool.info', task: '014-32c' },
    { capability: 'token.pools', task: '014-32d' },
  ] as const;

  it('TC-UNIT-08: each is accounted for by a CASE, never by an exclusion', () => {
    // `accountedCapabilities()` is the set `eval-capability-coverage.test.ts` compares against. An
    // exclusion outliving its stub would keep the capability accounted while nothing exercises it —
    // the mask memory M6 names, surviving the very task meant to close it.
    const accounted = accountedCapabilities();
    for (const shipped of SHIPPED) {
      expect(
        CAPABILITY_EXCLUSIONS.has(shipped.capability),
        `${shipped.capability} is still excluded although task ${shipped.task} shipped its logic`,
      ).toBe(false);
      expect(
        accounted.has(shipped.capability),
        `${shipped.capability} is accounted for by nothing — its eval case is missing`,
      ).toBe(true);
    }
  });

  it('TC-UNIT-09: no exclusion left in the file is an interval', () => {
    // The remaining entries must all be POLICY, not intervals. An interval always named the task
    // that removes it, so a reason mentioning a task id is one that outlived its own end date.
    const intervals = [...CAPABILITY_EXCLUSIONS.entries()].filter(([, reason]: [string, string]) =>
      /\b014-\d/.test(reason),
    );
    expect(
      intervals.map(([capability]: [string, string]) => capability),
      'an exclusion names a task, so it is an interval — either its task has not shipped, or the ' +
        'entry outlived it',
    ).toStrictEqual([]);
  });

  it('removing an entry is observable — the gate is not vacuous', () => {
    // Guards the guard: if `CAPABILITY_EXCLUSIONS` stopped feeding `accountedCapabilities()`, or
    // `accountedCapabilities()` returned everything, the cases above would pass while protecting
    // nothing.
    expect(CAPABILITY_EXCLUSIONS.size).toBeGreaterThan(0);
    const accounted = accountedCapabilities();
    for (const capability of CAPABILITY_EXCLUSIONS.keys()) {
      expect(accounted.has(capability)).toBe(true);
    }
    expect(accounted.has('a.capability.that.does.not.exist')).toBe(false);
  });

  it('a capability whose stub has SHIPPED is accounted for by a CASE, not by an exclusion', () => {
    // The interval's other end, asserted rather than assumed. Without this, removing the stub and
    // forgetting the exclusion would leave `pool.info` accounted for by the very entry that says
    // "nothing exercises this" — the mask M6 warns about, surviving the task that was meant to
    // close it.
    expect(CAPABILITY_EXCLUSIONS.has('pool.info')).toBe(false);
    expect(accountedCapabilities().has('pool.info')).toBe(true);
  });
});
