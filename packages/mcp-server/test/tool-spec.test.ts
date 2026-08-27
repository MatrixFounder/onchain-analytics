import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CapabilityRegistry, routes, type BudgetStore } from '@onchain-intel/core';
import { STDIO_PRINCIPAL } from '../src/auth/principal.js';
import { createBillingStoreStub } from '../src/engine/billing-store.js';
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
    // Required since task 014-14: there is a principal on every transport, so the key is not
    // optional and this fixture supplies the local one.
    principal: STDIO_PRINCIPAL,
    // Required since task 015-09 (R-3.7) — a fresh stub per fixture, same as `budgetStore` above;
    // this suite is about `defineTool`'s projection, not billing, so admission is unconditional.
    billing: createBillingStoreStub(),
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

  /**
   * OQ-T012-6, condition 2 — the overrun has to REACH the wire, not merely exist on the resolution.
   *
   * The owner's decision has two halves, and the second one ("late is never silent") is only kept by
   * the renderer. `core` proves the registry stamps `deadlineOverrunMs` (TC-OQ6-b) and the plumbing
   * typechecks — neither of which would notice a renderer that quietly dropped the key, leaving a
   * field that exists everywhere except where a client can read it. That is this project's own
   * "a diagnostic nobody reads is not a diagnostic", arrived at from the far end.
   */
  it('publishes `_meta.timing` when the answer crossed its ceiling (OQ-T012-6)', async () => {
    const cache = { status: 'hit' as const, ageMs: 12, provider: 'probe', capability: 'probe.cap' };
    const timing = { overrunMs: 119 };
    const spec = defineTool({
      ...base,
      name: 'probe_timing_meta',
      handler: (input) => ({ ok: true as const, output: { seen: input.value }, cache, timing }),
    });
    const result = await call(spec, { value: 'x' });
    expect(result['_meta']).toStrictEqual({ cache, timing });
  });

  it('omits `_meta.timing` on an ordinary call — absent, never `{overrunMs: 0}`', async () => {
    // The other direction: if the key appeared on every response the mark would stop meaning
    // anything, and `_meta` would grow for every client on every call to say "nothing happened".
    const cache = { status: 'miss' as const, provider: 'probe', capability: 'probe.cap' };
    const spec = defineTool({
      ...base,
      name: 'probe_no_timing_meta',
      handler: (input) => ({ ok: true as const, output: { seen: input.value }, cache }),
    });
    const result = await call(spec, { value: 'x' });
    expect(result['_meta']).toStrictEqual({ cache });
    expect(Object.hasOwn(result['_meta'] as object, 'timing')).toBe(false);
  });

  // "the outcome's `reason`", not "the chosen reason": this probe's handler does choose its string,
  // but the retired phrasing implied `reason` is always curated, which is false on the capability
  // path (see `ToolOutcome`'s docstring). Renamed in cycle 4 so the wording is not reintroduced by
  // someone copying this title.
  it("turns a refusal into `isError` carrying the outcome's `reason`, not a thrown message", async () => {
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
    //
    // **`capability: null` alone no longer means "serves none" (T-013 task 013-8).** A tool serving
    // SEVERAL capabilities also carries `null` there and names them in `servedCapabilities`, so the
    // distinguishing fact is the PAIR: serves-none is `null` AND no `servedCapabilities`. Filtering
    // on `capability === null` by itself would report the fourteenth tool as serving nothing —
    // which is exactly the misreading `eval-checks-coverage.test.ts` makes one gate over, fixed in
    // the same commit.
    const withoutCapability = toolSpecs
      .filter((spec) => spec.capability === null && spec.servedCapabilities === undefined)
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
    // Every capability a spec DECLARES, from either field — `servedCapabilities` when it serves
    // several, `capability` when it serves one. Reading only `capability` would leave the
    // fourteenth tool's two capabilities unchecked entirely: it declares `null` there, so the old
    // filter skipped it and the gate would pass while advertising two possibly-unroutable names.
    const declared = toolSpecs.flatMap((spec) =>
      (spec.servedCapabilities ?? (spec.capability === null ? [] : [spec.capability])).map(
        (capability) => ({ name: spec.name, capability }),
      ),
    );
    const unroutable = declared
      .filter((entry) => !routed.has(entry.capability))
      .map((entry) => `${entry.name} -> ${entry.capability}`);
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
 * `true` when `source` **acquires** `symbol` — imports it, or calls/constructs it.
 *
 * **This replaced a `stripComments()` helper, which was a regex pretending to be a parser and could
 * delete live code** (cycle 4). Its block-comment pattern ran over raw source, so an unbalanced
 * comment-opening sequence inside an ordinary string literal — a glob pattern, a message quoting a
 * comment token — began a phantom comment that the next genuine block-comment terminator anywhere
 * below closed, silently removing everything between. An `import { createBudgetStore }` in that span
 * would have vanished and the gate would have reported no offenders on code that violates it.
 *
 * Matching the *shape* of an acquisition removes the whole class. It also solves the problem
 * stripping was invented for: prose writes the name in backticks — `` `createBudgetStore` `` — which
 * is neither an import nor a call, so a docstring explaining the rule no longer trips the rule.
 */
function acquires(source: string, symbol: string): boolean {
  // The import form is anchored to a real statement — `import {…} from` at the start of a line.
  // A looser `import[^;]*<symbol>[^;]*from` still read prose: `registry.ts`'s own docstring says
  // "`needs` cannot ration imports — `createBudgetStore` is a public export of `@onchain-intel/core`",
  // and the English word "imports" plus a later "from" matched it. Third time this gate has fired on
  // a sentence about itself; the anchor is what finally distinguishes code from writing about code.
  const imported = new RegExp(
    `^\\s*import\\s+(?:type\\s+)?\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from`,
    'm',
  );
  const called = new RegExp(`(?:new\\s+)?\\b${symbol}\\s*\\(`);
  return imported.test(source) || called.test(source);
}

/** `true` when `source` imports anything at all from `moduleSpecifier`. */
function importsModule(source: string, moduleSpecifier: string): boolean {
  return new RegExp(`from\\s*['"]${moduleSpecifier}['"]`).test(source);
}

describe('each tool module declares its privileges once (adversarial cycle 2)', () => {
  const toolsDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/tools');
  /**
   * A tool module is one that *calls* `defineTool({` — derived, not listed. An exclusion list of the
   * helper modules (`registry.ts`, `budget-meta.ts`, …) would be one more hand-written inventory,
   * and it would go stale the first time a helper is added.
   *
   * Matching `= defineTool({` rather than the bare `defineTool(` keeps prose out of the selection.
   *
   * (Cycle 3 justified this with a specific scenario — that `budget-meta.ts` mentions `defineTool`
   * in a sentence and dropping its backticks would add a fourteenth "module". That is **not true**:
   * the text reads ``which holds `defineTool`):``, and without backticks it is `defineTool)`, which
   * the old matcher would not have matched either. No file in `src/` contains the literal
   * `defineTool(` in prose. The change is still right — it narrows the predicate to the thing it
   * means, and stops depending on that staying true — but the story told for it was invented, which
   * is the failure this whole task is about. Corrected in cycle 4.)
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
        // `capability: null` now covers TWO different tools (T-013 task 013-8, PLAN §0.11), and
        // collapsing them is what this branch used to do:
        //
        //  - a SERVER-LEVEL tool (`ping`, `list_chains`) — computes its own answer, resolves
        //    nothing, and carries no `servedCapabilities`;
        //  - a MULTI-CAPABILITY tool — resolves one of SEVERAL capabilities chosen at call time, so
        //    no single `const CAPABILITY` can name it, and the names live in one `as const` array.
        //
        // The second one calls `resolveCapability(` legitimately, so the old rule ("null means you
        // may not resolve") reported it as an offender permanently. The rule is EXTENDED, not
        // waived: the multi-capability shape has to prove the same property the single-capability
        // shape does — the module names its capabilities in exactly one place, so retargeting the
        // tool is one edit and cannot half-apply.
        const servedField = /^ {2}servedCapabilities: (.+),$/m.exec(specBody)?.[1];
        if (servedField === undefined) {
          // Server-level: unchanged from before this task.
          if (declarations.length > 0) offenders.push(`${file}: capability null but declares one`);
          if (source.includes('resolveCapability(')) {
            offenders.push(`${file}: capability null but calls resolveCapability`);
          }
          continue;
        }

        // Multi-capability. Exactly one `as const` array of names, the spec field must reference it
        // BY NAME, and no capability string literal may reach `resolveCapability(` — the same three
        // obligations the single-capability branch imposes, expressed for a list.
        const servedDeclarations = [
          ...source.matchAll(/^const SERVED_CAPABILITIES = \[[\s\S]*?\] as const;$/gm),
        ];
        if (servedDeclarations.length !== 1) {
          offenders.push(
            `${file}: expected exactly one \`const SERVED_CAPABILITIES = [...] as const\`, found ${servedDeclarations.length}`,
          );
          continue;
        }
        if (servedField !== 'SERVED_CAPABILITIES') {
          offenders.push(
            `${file}: spec says \`servedCapabilities: ${servedField}\`, not the SERVED_CAPABILITIES constant`,
          );
        }
        for (const call of source.matchAll(/resolveCapability\(\s*[^,]+,\s*([^,]+),/g)) {
          const argument = call[1]?.trim() ?? '?';
          if (/^['"`]/.test(argument)) {
            offenders.push(
              `${file}: resolves the string literal ${argument}; a multi-capability tool must pass an element of SERVED_CAPABILITIES`,
            );
          }
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
    // **Scanned over all of `src/`, recursively, with ONE named exemption** (cycle 4). Cycle 3
    // widened this from the tool modules to their directory, which still left two escapes needing
    // no concealment at all: `src/tools/helpers/budget.ts` (a subfolder — routine housekeeping) and
    // `src/budget-fallback.ts` (one level up, beside `server.ts`). Either can import the factory and
    // be called from `budget-meta.ts`, which is the very drift path this gate names. Bounding the
    // gate by a directory listing rather than by the dependency graph made its coverage an accident
    // of where files happen to sit.
    //
    // `src/runtime.ts` is the exemption: composing the stores is exactly its job. One exemption with
    // a stated reason is cheaper than a class of holes — and unlike a per-file exclusion list it
    // cannot silently grow, because every addition is a visible edit to this line.
    //
    // It was `index.ts` until task 014-10 moved the assembly into `runtime.ts` — so that "assembled
    // once per process" could be measured by a test, which cannot import a bin whose module body
    // ends in `await main()`. The exemption follows the composition; it does not accumulate.
    //
    // The class names are here too, not only the factories: `SqliteBudgetStore` and
    // `SqliteCacheStore` are exported from their modules and `@onchain-intel/core` declares no
    // `exports` map, so a deep import resolves and would name neither factory. `better-sqlite3`
    // itself is listed for the same reason — it is not a dependency of this package, so any
    // reference is a new door rather than a use of an existing one.
    const FORBIDDEN_SYMBOLS = [
      'createBudgetStore',
      'createCacheStore',
      'SqliteBudgetStore',
      'SqliteCacheStore',
    ];
    const EXEMPT = 'runtime.ts'; // composes the stores — the one file architecturally allowed to
    const srcDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');
    const offenders: string[] = [];
    for (const file of readdirSync(srcDirectory, { recursive: true, encoding: 'utf8' })) {
      if (!file.endsWith('.ts') || file === EXEMPT) continue;
      const source = readFileSync(path.join(srcDirectory, file), 'utf8');
      for (const symbol of FORBIDDEN_SYMBOLS) {
        if (acquires(source, symbol)) offenders.push(`${file}: acquires ${symbol}`);
      }
      if (importsModule(source, 'better-sqlite3')) {
        offenders.push(`${file}: imports better-sqlite3 directly`);
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
