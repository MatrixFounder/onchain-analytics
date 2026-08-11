import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adapterRegistrations, routes } from '../src/providers.config.js';
import { ttlFor } from '../src/cache/ttl.js';
import { capabilityManifests, type CapabilityManifest } from '../src/capability-manifest.js';
import {
  CapabilityRegistry,
  InvalidCapabilityManifestError,
  MissingCapabilityManifestError,
} from '../src/adapters/registry.js';
import type { CapabilityRoute, ProviderAdapter } from '../src/adapters/types.js';

/**
 * Task 012-4 — the capability manifest (ADR-002 D3, R-136/R-137/R-148/R-149).
 *
 * Written in the task's own phase order: TC-UNIT-01 (enumerating) and TC-UNIT-04 (structural key
 * check) came FIRST, against a module that did not exist, then against an empty table; everything
 * else follows the data.
 *
 * Two of the checks below read the module's SOURCE rather than its exported value (TC-UNIT-07 and
 * TC-UNIT-08). The precedent is `ttl-coverage.test.ts`, which reads `cache/ttl.ts` for the same
 * reason: the property under test — "the declaration still has this shape", "the number still has
 * its derivation written next to it" — is a property of the text, and the runtime value cannot
 * express it. Both carry a declared recall limit, in the form `tier-single-source.test.ts` (task
 * 012-3) established: a reached/not-reached table, a positive control for every reached form, and
 * an executable assertion that the NOT-reached rows really are out of reach.
 */

const manifestSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/capability-manifest.ts'),
  'utf8',
);

const routedCapabilities = [...new Set(routes.map((route) => route.capability))].sort();

/** R-137: the manifest describes the CALL, never the routing or the price. */
const FORBIDDEN_KEYS = ['chains', 'providers', 'price', 'cost'] as const;

// =============================================================================================
// TC-UNIT-01 / TC-UNIT-02 — the table and the route list cover each other, both directions
// =============================================================================================

describe('TC-UNIT-01 — every routed capability has a manifest entry (R-136/R-138d)', () => {
  it('has more than 10 routes and more than 10 manifest entries — otherwise this is vacuous', () => {
    expect(routedCapabilities.length).toBeGreaterThan(10);
    expect(Object.keys(capabilityManifests).length).toBeGreaterThan(10);
  });

  it.each(routedCapabilities)('%s has a manifest entry', (capability) => {
    expect(Object.keys(capabilityManifests)).toContain(capability);
  });
});

describe('TC-UNIT-02 — no manifest entry for a capability nothing routes', () => {
  it('has no orphan rows', () => {
    // The opposite drift from TC-UNIT-01, and the one that reads as FEATURE rather than as a gap: a
    // capability dropped from `routes` leaves its row behind, and the next reader takes the dead row
    // for a served capability with a chosen deadline.
    const orphans = Object.keys(capabilityManifests).filter(
      (capability) => !routedCapabilities.includes(capability),
    );
    expect(orphans).toStrictEqual([]);
  });

  it('covers exactly the 25 routed capabilities, named', () => {
    // Named, not counted: two tables of the same SIZE that disagree on one key would pass a count.
    expect(Object.keys(capabilityManifests).sort()).toStrictEqual(routedCapabilities);
    expect(routedCapabilities).toHaveLength(25);
  });
});

// =============================================================================================
// TC-UNIT-03 / TC-UNIT-04 — every row's required fields; no row carries a forbidden one
// =============================================================================================

describe('TC-UNIT-03 — every entry carries `shape`, `ttlSeconds`, `deadlineMs`', () => {
  it.each(Object.entries(capabilityManifests))('%s is complete and positive', (_capability, m) => {
    expect(['point', 'set', 'series']).toContain(m.shape);
    expect(typeof m.ttlSeconds).toBe('number');
    expect(m.ttlSeconds).toBeGreaterThan(0);
    expect(typeof m.deadlineMs).toBe('number');
    expect(m.deadlineMs).toBeGreaterThan(0);
  });
});

describe('TC-UNIT-04 — no manifest entry carries a routing or pricing key (R-137)', () => {
  it('no entry carries `chains`/`providers`/`price`/`cost`', () => {
    const offenders: string[] = [];
    for (const [capability, manifest] of Object.entries(capabilityManifests)) {
      for (const key of Object.keys(manifest)) {
        if ((FORBIDDEN_KEYS as readonly string[]).includes(key)) {
          offenders.push(`${capability}.${key}`);
        }
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it('a manifest literal carrying one of them does not compile', () => {
    // Four separate literals, one forbidden key each — TypeScript reports the FIRST excess property
    // of a literal and stops, so four directives on one object would leave three "unused" and fail
    // the build for the wrong reason. Each directive is load-bearing in both directions: if the type
    // ever accepts the key, `tsc` reports TS2578 for an unused directive here.
    const base = { shape: 'point', ttlSeconds: 60, deadlineMs: 15_000 } as const;

    const withChains: CapabilityManifest = {
      ...base,
      // @ts-expect-error TC-UNIT-04: `chains` is ROUTING (R-137) — `chainSupport()` owns it.
      chains: ['ethereum'],
    };
    const withProviders: CapabilityManifest = {
      ...base,
      // @ts-expect-error TC-UNIT-04: `providers` is ROUTING — `providers.config.ts` owns it.
      providers: ['coingecko'],
    };
    const withPrice: CapabilityManifest = {
      ...base,
      // @ts-expect-error TC-UNIT-04: `price` is COST — `costOf()` and the budget ledger own it.
      price: 10,
    };
    const withCost: CapabilityManifest = {
      ...base,
      // @ts-expect-error TC-UNIT-04: `cost` is COST — same owner, other spelling.
      cost: 10,
    };

    expect([withChains, withProviders, withPrice, withCost].map((m) => m.shape)).toStrictEqual([
      'point',
      'point',
      'point',
      'point',
    ]);
  });
});

// =============================================================================================
// TC-UNIT-05 — the TTLs are a MOVE, not an edit
// =============================================================================================

/**
 * `cache/ttl.ts`'s `TTL_SECONDS` as it stood BEFORE task 012-4 touched anything — transcribed here,
 * not imported, which is the whole mechanism. An assertion against the live table would be satisfied
 * by any pair of tables that agree, including a pair where both were changed in the same commit;
 * this list cannot move unless somebody edits THIS file, in a diff that says so.
 */
const TTL_SECONDS_BEFORE_THE_MOVE: Readonly<Record<string, number>> = {
  'token.price': 60,
  'token.metadata': 3600,
  'wallet.balances.native': 60,
  'pairs.active': 30,
  'protocol.tvl': 300,
  'chain.tvl': 300,
  'dex.volume.history': 3600,
  'chain.tvl.history': 3600,
  'protocol.list': 300,
  'protocol.tvl.history': 3600,
  'privacy.shielded_pool': 3600,
  'platform.identities': 3600,
  'platform.contracts': 3600,
  'platform.documents': 3600,
  'platform.credits': 3600,
  'token.holders': 3600,
  'chain.supply': 600,
  'pool.info': 300,
  'privacy.shielded_pool.history': 3600,
  'platform.metrics.history': 3600,
  'smart-money.flows': 300,
  'token.risk': 1800,
  'entity.labels': 3600,
  // WI-51. Two capabilities off ONE `/api/v2/stats` document with clocks 20x apart, which is the
  // point of a per-capability TTL: `gas_price_updated_at` re-stamps about every minute, while
  // `transactions_today` did not move across 45 s in which `total_blocks` advanced by 10.
  'gas.price': 30,
  'chain.transactions': 600,
};

describe('TC-UNIT-05 — every `ttlSeconds` is byte-identical to the pre-move table', () => {
  it('pins all 25, so a TTL edit disguised as a migration fails here', () => {
    expect(Object.keys(TTL_SECONDS_BEFORE_THE_MOVE)).toHaveLength(25);
    expect(
      Object.fromEntries(
        Object.entries(capabilityManifests).map(([capability, m]) => [capability, m.ttlSeconds]),
      ),
    ).toStrictEqual(TTL_SECONDS_BEFORE_THE_MOVE);
  });

  it('agrees with the live `ttlFor()` — which task 012-5 makes a reader of this table', () => {
    // A SECOND check, not the first one restated: today it proves the copy is faithful to the code
    // still serving the cache; after 012-5 rewires `ttlFor()` it proves the rewiring preserved the
    // numbers. It cannot replace the frozen list above, because both sides of it can move together.
    for (const [capability, manifest] of Object.entries(capabilityManifests)) {
      expect(ttlFor(capability), capability).toBe(manifest.ttlSeconds);
    }
  });
});

// =============================================================================================
// TC-UNIT-06 — `paidLegMs` exactly where a paid adapter is reachable, and nowhere else
// =============================================================================================

const PAID_ADAPTER_IDS = new Set(
  adapterRegistrations.filter((r) => r.tier === 'paid').map((r) => r.id),
);

/** Capabilities whose route list reaches a `tier: 'paid'` adapter — derived, never hand-listed. */
const capabilitiesWithAPaidLeg = [
  ...new Set(
    routes
      .filter((route) => route.adapterIds.some((id) => PAID_ADAPTER_IDS.has(id)))
      .map((route) => route.capability),
  ),
].sort();

describe('TC-UNIT-06 — `paidLegMs` is carried by exactly the paid-reaching capabilities', () => {
  it('the derivation itself is not vacuous', () => {
    expect(PAID_ADAPTER_IDS.size).toBeGreaterThan(0);
    // Named rather than counted, and derived from `tier` (the one classification, task 012-3) rather
    // than from an id list of this file's own.
    expect([...PAID_ADAPTER_IDS].sort()).toStrictEqual(['dune', 'nansen']);
    expect(capabilitiesWithAPaidLeg).toStrictEqual([
      'entity.labels',
      'smart-money.flows',
      'token.risk',
    ]);
  });

  it('every entry with `paidLegMs` lies on a route reaching a paid adapter', () => {
    const carriers = Object.entries(capabilityManifests)
      .filter(([, m]) => m.paidLegMs !== undefined)
      .map(([capability]) => capability)
      .sort();
    expect(carriers).toStrictEqual(capabilitiesWithAPaidLeg);
  });

  it('no free capability carries a defensive `paidLegMs`', () => {
    // The other direction, stated separately because it fails differently: a "just in case"
    // `paidLegMs` on a free capability publishes a paid leg that does not exist.
    const offenders = Object.entries(capabilityManifests)
      .filter(([capability, m]) => !capabilitiesWithAPaidLeg.includes(capability) && m.paidLegMs)
      .map(([capability]) => capability);
    expect(offenders).toStrictEqual([]);
  });

  it('each `paidLegMs` is a positive number', () => {
    for (const capability of capabilitiesWithAPaidLeg) {
      expect(capabilityManifests[capability]?.paidLegMs, capability).toBeGreaterThan(0);
    }
  });
});

// =============================================================================================
// TC-UNIT-07 — the DECLARATION guard (OQ-T012-5)
// =============================================================================================

/**
 * The top-level `|` branches of `export type CapabilityManifest = …`, as TEXT.
 *
 * **What this guard is for.** It keeps `CapabilityManifest` a TWO-BRANCH discriminated union — the
 * precondition T-013 needed to add its merge field to ONE branch and get "merging declared on a
 * `point`" as a compile error for free. **T-013 (task 013-1) has now done exactly that:**
 * `mergeable?: boolean` lives on the `set | series` branch alone, and `capability-manifest.ts`'s
 * TC-UNIT-09/10/11 below prove the placement, not this guard. TC-UNIT-07 stays in force going
 * forward as the STANDING precondition — collapsing the union into a flat interface, or adding a
 * third branch, is what this guard still fails on.
 *
 * **What it does NOT prove, said plainly so the gate is not read as stronger than it is:**
 *
 * - It does not guard the merge RULE — only the merge FIELD's branch. `mergeable` (013-1) is
 *   declared on `set | series` alone and TC-UNIT-09 proves declaring it on `point` does not
 *   compile, but there is still no merge RULE: activation (`CapabilityRoute.merge`, 013-2) and any
 *   walk/dedup/rank code (013-4) have not landed, so "merging is disallowed on `point`" is true of
 *   the FIELD's placement and not yet a statement about running behaviour. Nor does this guard
 *   protect any FUTURE field the same way — a field added straight to `CapabilityManifestBase`
 *   would still be legal on `point`, because this guard reads the union's branch STRUCTURE, not
 *   which fields live on which branch — except that TC-UNIT-07's own sign-of-work assertion below
 *   (`branches[1]` must contain `mergeable?: boolean`) incidentally pins `mergeable` TEXTUALLY to
 *   the second branch, so moving it to the base fails THAT assertion too, for a reason unrelated to
 *   any leak check: it is a fact about this one field's presence in a fixed string, not a general
 *   capability of the guard.
 * - It does not read types. It reads the declaration's text.
 *
 * **Reached** (each with a positive control below):
 *
 * | Form                                                              | Caught by |
 * | ------------------------------------------------------------------- | --------- |
 * | The union collapsed to a flat `interface`/single type              | branch count ≠ 2 |
 * | A third branch added                                                | branch count ≠ 2 |
 * | A branch that no longer extends `CapabilityManifestBase`            | per-branch base check |
 * | `shape: 'set' \| 'series'` merged into the `point` branch           | discriminator check |
 *
 * **NOT reached — measured, not hypothesised** (asserted in "the DECLARED LIMITS are real"):
 *
 * | Escape                                                                              | Why |
 * | ------------------------------------------------------------------------------------- | --- |
 * | A merge field added to `CapabilityManifestBase` (hence legal on `point`)             | The guard reads the union declaration only. STRUCTURAL, not time-bound: 013-1 closed this for `mergeable` by branch placement, but a field added to the BASE — `mergeKey` or anything next — is still invisible here. |
 * | `capabilityManifests` re-typed to some OTHER type while this declaration stands       | The guard checks the declaration, not who uses it. |
 * | `CapabilityManifestBase` itself redeclared as something unrelated                     | Names are compared, types are not resolved. |
 */
/**
 * Strips `//` line comments and `/* … *&#47;` block comments. Needed before scanning for the
 * union's terminating `;` — a JSDoc `/** … *&#47;` inside a branch never contains one in this file,
 * but the scan must not depend on that staying true, and comment text is not code the terminator
 * search should react to either way.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * `+1` for an opening bracket, `-1` for a closing one, `0` otherwise — the ONE place both depth
 * scans below get their bracket set from, so a future fix to one cannot land on only one loop (the
 * two copies were byte-identical and free to diverge; review round 2, L-3).
 *
 * **Residual limit, named rather than silently carried:** this is bracket-counting only, and it is
 * not literal-aware. A branch property typed as an arrow (`(x: string) => number`) contributes an
 * unmatched `>` — the `>` of `=>` closes nothing — and desyncs the count. A BALANCED generic
 * (`Record<string, X>`) is the case including `<`/`>` in the set handles correctly: `+1` then `-1`,
 * net zero. **Unreachable on
 * this file today** (no such property exists in `CapabilityManifest`'s branches), and — unlike
 * MUT-C1 — **LOUD, not silent, if it ever fires**: depth going negative means the real `;`/`|` is
 * skipped, so the scan either never finds a depth-0 terminator (`unionBranches` returns `[]`) or
 * the branch count comes out wrong and `declarationDefects` reports it. Neither outcome is a test
 * that passes while proving nothing, which is the failure mode this project actually guards against.
 */
function bracketDelta(char: string): -1 | 0 | 1 {
  if ('([{<'.includes(char)) return 1;
  if (')]}>'.includes(char)) return -1;
  return 0;
}

function unionBranches(source: string): string[] {
  const clean = stripComments(source);
  const start = clean.indexOf('export type CapabilityManifest =');
  if (start === -1) return [];
  const afterEquals = start + 'export type CapabilityManifest ='.length;

  // The terminating `;` is the first one at DEPTH 0, not the first one in the text. MUT-C1
  // (adversarial round 1, T-013) caught the naive `indexOf(';', start)` version: once a branch
  // grew a multi-line object type of its own (`{ shape: 'set' | 'series'; mergeable?: boolean }`),
  // its OWN property-separating `;` sat at depth > 0 and was mistaken for the union terminator —
  // truncating everything after it (the field, the branch's closing `})`) while still reporting
  // branch count 2 by luck, because the truncated tail happened to be non-empty.
  let depth = 0;
  let end = -1;
  for (let i = afterEquals; i < clean.length; i += 1) {
    const char = clean[i];
    if (char === undefined) break;
    depth += bracketDelta(char);
    if (char === ';' && depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) return [];
  const body = clean.slice(afterEquals, end);

  const branches: string[] = [];
  let branchDepth = 0;
  let current = '';
  for (const char of body) {
    branchDepth += bracketDelta(char);
    if (char === '|' && branchDepth === 0) {
      if (current.trim()) branches.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) branches.push(current.trim());
  return branches;
}

/** The declaration defects `unionBranches` can see — named, so a failure says which one happened. */
function declarationDefects(source: string): string[] {
  const branches = unionBranches(source);
  const defects: string[] = [];
  if (branches.length !== 2) {
    defects.push(`expected a two-branch union, found ${branches.length}`);
    return defects;
  }
  for (const branch of branches) {
    if (!branch.includes('CapabilityManifestBase')) {
      defects.push(`branch does not extend CapabilityManifestBase: ${branch}`);
    }
  }
  const pointBranches = branches.filter((b) => /shape:\s*'point'/.test(b));
  const collectionBranches = branches.filter(
    (b) => /'set'/.test(b) && /'series'/.test(b) && !/shape:\s*'point'/.test(b),
  );
  if (pointBranches.length !== 1) defects.push("no single branch discriminated by shape: 'point'");
  if (collectionBranches.length !== 1) {
    defects.push("no single branch discriminated by shape: 'set' | 'series'");
  }
  return defects;
}

describe('TC-UNIT-07 — `CapabilityManifest` stays a two-branch union (OQ-T012-5)', () => {
  it('the real declaration is a two-branch union over the shared base', () => {
    // Sign of work first: a regex that found no declaration would report "no defects" identically.
    expect(manifestSource).toContain('export type CapabilityManifest =');
    const branches = unionBranches(manifestSource);
    expect(branches).toHaveLength(2);
    // Sign of work, MUT-C1 (adversarial round 1, T-013): the scan must reach the ACTUAL union
    // terminator, not the second branch's OWN `shape: 'set' | 'series';` property separator. A
    // parser that truncated there would still report length 2 by luck (the truncated tail is
    // non-empty) while silently dropping everything after it — including `mergeable` itself and
    // the branch's closing `})`. Asserting the full text is what tells "reached the terminator"
    // apart from "stopped early and got lucky".
    expect(branches[1]).toMatch(/mergeable\?:\s*boolean/);
    expect(branches[1]?.trim().endsWith('})')).toBe(true);
    expect(
      declarationDefects(manifestSource),
      'T-013 (013-1) added the merge field to the `set | series` branch alone; a flat type would ' +
        'silently make it legal on `point` too. This guard covers the DECLARATION, never the merge rule.',
    ).toStrictEqual([]);
  });

  it('the guard DETECTS each reached form', () => {
    const flat = `export type CapabilityManifest = CapabilityManifestBase & { shape: 'point' | 'set' | 'series' };`;
    expect(declarationDefects(flat), 'collapsed to a flat type').not.toStrictEqual([]);

    const three = `export type CapabilityManifest =\n | (CapabilityManifestBase & { shape: 'point' })\n | (CapabilityManifestBase & { shape: 'set' })\n | (CapabilityManifestBase & { shape: 'series' });`;
    expect(declarationDefects(three), 'a third branch').not.toStrictEqual([]);

    const noBase = `export type CapabilityManifest =\n | ({ ttlSeconds: number; deadlineMs: number; shape: 'point' })\n | (CapabilityManifestBase & { shape: 'set' | 'series' });`;
    expect(declarationDefects(noBase), 'a branch off the shared base').not.toStrictEqual([]);

    const merged = `export type CapabilityManifest =\n | (CapabilityManifestBase & { shape: 'point' | 'set' | 'series' })\n | (CapabilityManifestBase & { shape: 'point' });`;
    expect(declarationDefects(merged), 'discriminator merged into `point`').not.toStrictEqual([]);

    // MUT-C1 regression (adversarial round 1, T-013): a third branch behind a multi-line SECOND
    // branch that carries its own embedded `;` — the exact shape of the real `set | series` branch
    // once `mergeable?: boolean;` landed in it. Before the parser fix this fixture was invisible:
    // the naive `indexOf(';', start)` terminator search stopped at the embedded `;` and never saw
    // the third branch at all.
    const thirdBranchBehindMultilineSecond = `export type CapabilityManifest =\n | (CapabilityManifestBase & { shape: 'point' })\n | (CapabilityManifestBase & {\n      shape: 'set' | 'series';\n      mergeable?: boolean;\n    })\n | (CapabilityManifestBase & { shape: 'blob' });`;
    expect(
      declarationDefects(thirdBranchBehindMultilineSecond),
      'a third branch hidden behind a multi-line second branch with its own `;`',
    ).not.toStrictEqual([]);
  });

  it('the DECLARED LIMITS are real: these are NOT reached, and that is written down', () => {
    // Executable form of the "NOT reached" table above. Asserting the limits keeps the table honest
    // and turns any future widening into a visible edit HERE.
    const mergeKeyOnTheBase = `interface CapabilityManifestBase { ttlSeconds: number; deadlineMs: number; mergeKey?: string }\nexport type CapabilityManifest =\n | (CapabilityManifestBase & { shape: 'point' })\n | (CapabilityManifestBase & { shape: 'set' | 'series' });`;
    expect(
      declarationDefects(mergeKeyOnTheBase),
      'LIMIT, and STRUCTURAL rather than time-bound: `mergeKey` here is a hypothetical field ' +
        'DIFFERENT from the real `mergeable` — T-013 (013-1) closed the obligation for `mergeable` ' +
        'specifically by putting it on the correct branch, but this guard still cannot see a field ' +
        'on the BASE (legal on `point` there), for `mergeKey` or for anything else added there next.',
    ).toStrictEqual([]);

    const otherTypeInUse = `export type CapabilityManifest =\n | (CapabilityManifestBase & { shape: 'point' })\n | (CapabilityManifestBase & { shape: 'set' | 'series' });\nexport const capabilityManifests: Readonly<Record<string, FlatManifest>> = {};`;
    expect(
      declarationDefects(otherTypeInUse),
      'LIMIT: the guard checks the declaration, not which type the TABLE is annotated with',
    ).toStrictEqual([]);

    const redeclaredBase = `interface CapabilityManifestBase { anything?: unknown }\nexport type CapabilityManifest =\n | (CapabilityManifestBase & { shape: 'point' })\n | (CapabilityManifestBase & { shape: 'set' | 'series' });`;
    expect(
      declarationDefects(redeclaredBase),
      'LIMIT: names are compared, types are not resolved',
    ).toStrictEqual([]);
  });
});

// =============================================================================================
// TC-UNIT-09/10/11 — merge eligibility lives on `set | series` alone (T-013, task 013-1, R-159/
// R-160, AC-21)
// =============================================================================================

/**
 * `mergeable?: boolean` (013-1) declares only the KEY-IDENTITY fact that a capability is eligible
 * for cross-adapter merging; it does not activate merging (`CapabilityRoute.merge`, 013-2) and it
 * does not appear in `providers.config.ts` (013-6). TC-UNIT-07 above keeps `CapabilityManifest` a
 * two-branch union; these three tests are what that union was FOR — a merge field declared on the
 * `set | series` branch alone, so declaring it on `point` is a compile error.
 */
describe('TC-UNIT-09/10/11 — `mergeable` lives on `set | series` only (T-013 obligation closed)', () => {
  it('TC-UNIT-09: `mergeable: true` on a `point` manifest does not compile', () => {
    // `mergeable` is not a field of the `point` branch — declaring it there must be a compile
    // error (excess property on a literal assigned to a union member). If the directive below
    // ever reports "unused", the field has leaked onto `point` (e.g. by moving to
    // `CapabilityManifestBase`) and the guarantee this task exists to add is gone. The directive
    // sits directly above the offending property, not above the statement: TS reports an excess
    // property on ITS OWN line, and `@ts-expect-error` only suppresses the line right below it.
    const pointWithMergeable: CapabilityManifest = {
      shape: 'point',
      ttlSeconds: 60,
      deadlineMs: 15_000,
      // @ts-expect-error TC-UNIT-09: excess property on the `point` branch — see comment above.
      mergeable: true,
    };
    expect(pointWithMergeable.shape).toBe('point');
  });

  it('TC-UNIT-10: `mergeable: true` on a `series` manifest compiles (positive control)', () => {
    // No `@ts-expect-error` here on purpose: without this control, TC-UNIT-09 failing to compile
    // could equally mean the field was declared on the WRONG branch (e.g. misspelt) rather than
    // correctly restricted to `set | series` — this is what tells the two cases apart.
    const seriesWithMergeable: CapabilityManifest = {
      shape: 'series',
      ttlSeconds: 3600,
      deadlineMs: 30_000,
      mergeable: true,
    };
    expect(seriesWithMergeable.shape).toBe('series');
    expect(seriesWithMergeable.mergeable).toBe(true);
  });

  it('TC-UNIT-11: only the two `.history` merge capabilities carry `mergeable: true`', () => {
    // `mergeable` only exists on the `set | series` branch, so reading it off the union needs an
    // `in` narrow to satisfy the type checker. Said plainly, not overclaimed: the narrow buys type
    // hygiene here, ZERO `point`-leak detection — if `mergeable` moved back to the shared base,
    // `'mergeable' in manifest` would narrow to every branch and this test would keep passing
    // identically. Catching that leak is TC-UNIT-09's job (the `@ts-expect-error`), not this one's.
    // Filtered on PRESENCE, not on `=== true`: the task file (`:31`) says the other 18 rows do not
    // carry the field AT ALL, not merely that it isn't `true` on them. `=== true` alone would pass
    // silently on a stray `mergeable: false` anywhere else in the table — asymmetric strictness
    // caught in review round 2 (L-2).
    const capabilitiesCarryingTheField = Object.entries(capabilityManifests)
      .filter(([, manifest]) => 'mergeable' in manifest)
      .map(([capability]) => capability)
      .sort();
    expect(capabilitiesCarryingTheField).toStrictEqual([
      'platform.metrics.history',
      'privacy.shielded_pool.history',
    ]);
    // Presence alone would also pass a `mergeable: false` on either — assert the values separately.
    // `in` narrows again, same reason as above: `mergeable` is not on the `point` branch.
    const platformMetricsHistory = capabilityManifests['platform.metrics.history'];
    const privacyShieldedPoolHistory = capabilityManifests['privacy.shielded_pool.history'];
    expect(
      platformMetricsHistory && 'mergeable' in platformMetricsHistory
        ? platformMetricsHistory.mergeable
        : undefined,
    ).toBe(true);
    expect(
      privacyShieldedPoolHistory && 'mergeable' in privacyShieldedPoolHistory
        ? privacyShieldedPoolHistory.mergeable
        : undefined,
    ).toBe(true);
    // Named separately, not folded into the list above: this is the row a reader would most
    // plausibly expect to be mergeable by mistake (it is `set`-shaped and the most expensive call
    // in the system), and getting it right by luck is not the same guarantee as testing it.
    const entityLabels = capabilityManifests['entity.labels'];
    // Sign of work: if the key were renamed or typo'd, `entityLabels` would be `undefined` and the
    // ternary below would yield `undefined` too — passing the assertion after it while proving
    // nothing about `entity.labels` at all. Fail loudly on that case first.
    expect(entityLabels).toBeDefined();
    expect(
      entityLabels && 'mergeable' in entityLabels ? entityLabels.mergeable : undefined,
    ).toBeUndefined();
  });
});

// =============================================================================================
// TC-UNIT-08 — the DERIVATION-RECORD guard (R-149)
// =============================================================================================

/**
 * Every `deadlineMs`/`paidLegMs` NUMBER in the manifest source must have a record beside it naming
 * BOTH numbers: the measured envelope and the applied value.
 *
 * **What this guard is for.** R-149 makes these comments the place the next edit COPIES its
 * reasoning from. A comment holding one number reads as a derivation while being a slice — which is
 * literally how the "410 s" figure got into a docstring: repeated, never derived. So the check is
 * mechanical: an adjacent `//` block, a `measured envelope:` marker with a number, an `applied:`
 * marker whose number EQUALS the literal on the field line.
 *
 * **What it does NOT prove** (also in the acceptance criteria, so it cannot be read as more): it
 * does not check that the arithmetic is right, or that the measured number belongs to THIS
 * capability. Verifying a number against its documented derivation is the extended WI-28 gate in
 * task 012-5. Here the claim is narrower: a slice was not passed off as a derivation by omission.
 *
 * **Reached** (positive control for each):
 *
 * | Form                                                                  |
 * | ----------------------------------------------------------------------- |
 * | A field with no adjacent comment at all                                |
 * | A record with one number and no markers                                |
 * | `measured envelope:` present, `applied:` missing                       |
 * | `applied:` present but disagreeing with the literal on the field line  |
 * | An entry collapsed onto ONE line with no record above it               |
 * | `paidLegMs` riding on the `deadlineMs` record above it                 |
 *
 * **NOT reached — measured, not hypothesised** (asserted below):
 *
 * | Escape                                                                    | Why |
 * | --------------------------------------------------------------------------- | --- |
 * | A measured envelope that is arithmetically WRONG (`measured envelope: 1`)  | Presence is checked, not value. 012-5's extended WI-28 gate checks numbers against the documented derivation. |
 * | A measured envelope copied from a DIFFERENT capability's row               | Same shape as a correct one; nothing here knows which capability a number was measured for. |
 * | `measured envelope:` equal to `applied:` — a slice presented as its own measurement | Two numbers are required, not two DIFFERENT ones: `paidLegMs` legitimately has them equal (nothing is cut after `checkAndReserve()`), so requiring inequality would forbid the honest case. |
 * | A field whose value is an identifier — `deadlineMs: TIER_POINT_MS`        | The scan matches numeric literals only; a table of named constants would need its own gate. |
 *
 * **A false-positive direction, stated rather than hidden:** this scan does NOT blank comments (it
 * is reading comments), so `// deadlineMs: 15_000` written as prose inside another comment would be
 * asked for a record of its own. `tier-single-source.test.ts` blanks comments for the opposite
 * reason — it reads code.
 */
function derivationRecordDefects(source: string): string[] {
  const defects: string[] = [];
  const lines = source.split('\n');

  const numbersAfter = (text: string, marker: string): number[] => {
    const at = text.indexOf(marker);
    if (at === -1) return [];
    return [...text.slice(at + marker.length).matchAll(/\d[\d_]*/g)].map((m) =>
      Number(m[0].replace(/_/g, '')),
    );
  };

  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\b(deadlineMs|paidLegMs):\s*(\d[\d_]*)/g)) {
      const field = match[1] ?? '';
      const applied = Number((match[2] ?? '').replace(/_/g, ''));
      const where = `${field}: ${match[2]} (line ${index + 1})`;

      // The adjacent record: the contiguous run of `//` lines directly above, plus a trailing `//`
      // on the field's own line. Any code line — including the field above it — ends the run, which
      // is what stops one record from covering two numbers.
      const block: string[] = [];
      for (let above = index - 1; above >= 0; above -= 1) {
        const text = (lines[above] ?? '').trim();
        if (!text.startsWith('//')) break;
        block.unshift(text);
      }
      const trailing = line.slice((match.index ?? 0) + match[0].length);
      if (trailing.includes('//')) block.push(trailing.slice(trailing.indexOf('//')));
      const record = block.join(' ');

      const measured = numbersAfter(record, 'measured envelope:');
      const appliedInRecord = numbersAfter(record, 'applied:');
      if (measured.length === 0) {
        defects.push(`${where}: no \`measured envelope:\` number in the adjacent record`);
      }
      if (appliedInRecord.length === 0) {
        defects.push(`${where}: no \`applied:\` number in the adjacent record`);
      } else if (appliedInRecord[0] !== applied) {
        defects.push(
          `${where}: the record says applied: ${String(appliedInRecord[0])}, the code says ${String(applied)}`,
        );
      }
    }
  });
  return defects;
}

/** How many numeric `deadlineMs`/`paidLegMs` fields the scan actually found — the sign of work. */
function scannedFieldCount(source: string): number {
  return [...source.matchAll(/\b(?:deadlineMs|paidLegMs):\s*\d/g)].length;
}

describe('TC-UNIT-08 — every deadline number carries a two-number derivation record (R-149)', () => {
  it('the real table: 25 numbers scanned, every one with both numbers beside it', () => {
    // Sign of work FIRST: a scan that matched nothing would report "no defects" identically.
    expect(scannedFieldCount(manifestSource)).toBe(28); // 25 deadlineMs + 3 paidLegMs
    expect(
      derivationRecordDefects(manifestSource),
      'R-149: the comment beside a deadline is where the NEXT edit copies its reasoning from. It ' +
        'must name the measured envelope AND the applied value — a single number reads as a ' +
        'derivation while being a ceiling.',
    ).toStrictEqual([]);
  });

  it('the guard DETECTS each reached form', () => {
    const noComment = `  deadlineMs: 15_000,`;
    expect(derivationRecordDefects(noComment), 'no record at all').not.toStrictEqual([]);

    const oneNumber = `  // one free adapter, one attempt\n  deadlineMs: 15_000,`;
    expect(derivationRecordDefects(oneNumber), 'prose without markers').not.toStrictEqual([]);

    const measuredOnly = `  // measured envelope: 90_000 (E-HTTP15).\n  deadlineMs: 15_000,`;
    expect(derivationRecordDefects(measuredOnly), 'no applied:').not.toStrictEqual([]);

    const disagreeing = `  // measured envelope: 90_000; applied: 30_000 — owner ceiling.\n  deadlineMs: 15_000,`;
    expect(derivationRecordDefects(disagreeing), 'applied: disagrees with the code').toStrictEqual([
      'deadlineMs: 15_000 (line 2): the record says applied: 30000, the code says 15000',
    ]);

    const oneLiner = `  'x': { shape: 'point', ttlSeconds: 60, deadlineMs: 15_000 },`;
    expect(derivationRecordDefects(oneLiner), 'a collapsed entry').not.toStrictEqual([]);

    const ridingOnTheRecordAbove = `  // measured envelope: 140_000; applied: 60_000 — owner ceiling (OD-2), cuts 80_000.\n  deadlineMs: 60_000,\n  paidLegMs: 270_000,`;
    expect(
      derivationRecordDefects(ridingOnTheRecordAbove),
      '`paidLegMs` needs its OWN record; the code line above ends the block',
    ).not.toStrictEqual([]);
  });

  it('the DECLARED LIMITS are real: these forms are NOT reached, and that is written down', () => {
    const wrongArithmetic = `  // measured envelope: 1 (invented); applied: 15_000 — owner ceiling.\n  deadlineMs: 15_000,`;
    expect(
      derivationRecordDefects(wrongArithmetic),
      'LIMIT: presence of a measured number is checked, never its value (012-5 checks the value)',
    ).toStrictEqual([]);

    const copiedFromAnotherRow = `  // measured envelope: 50_000 (E-HTTP5 — another capability's row); applied: 15_000 — ceiling.\n  deadlineMs: 15_000,`;
    expect(
      derivationRecordDefects(copiedFromAnotherRow),
      'LIMIT: nothing here knows which capability a measured number belongs to',
    ).toStrictEqual([]);

    const sliceAsItsOwnMeasurement = `  // measured envelope: 15_000; applied: 15_000 — owner ceiling.\n  deadlineMs: 15_000,`;
    expect(
      derivationRecordDefects(sliceAsItsOwnMeasurement),
      'LIMIT: two numbers are required, not two DIFFERENT ones — `paidLegMs` has them equal by ' +
        'design, so requiring inequality would forbid the honest case',
    ).toStrictEqual([]);

    const namedConstant = `  deadlineMs: TIER_POINT_MS,`;
    expect(
      derivationRecordDefects(namedConstant),
      'LIMIT: numeric literals only — a table of named constants is invisible to this scan',
    ).toStrictEqual([]);
    expect(scannedFieldCount(namedConstant)).toBe(0);
  });

  it('a correct record passes, so the gate is not simply always red', () => {
    const good = `  // measured envelope: 90_000 (E-HTTP15). applied: 15_000 — owner ceiling (OD-2), cuts 75_000.\n  deadlineMs: 15_000,`;
    expect(derivationRecordDefects(good)).toStrictEqual([]);
  });
});

// =============================================================================================
// TC-INT-01/02/03 — the manifest is validated when the registry is CONSTRUCTED
// =============================================================================================

function stubAdapter(id: string): ProviderAdapter {
  return {
    id,
    capabilities: () => [{ id: 'legacy.thing' }],
    costOf: () => ({ credits: 0 }),
    fetch: async () => Promise.resolve({ ok: true }),
    normalize: (_cap: string, raw: unknown): unknown => raw,
    isAvailable: () => ({ ok: true }),
  };
}

describe('TC-INT-01 — the real configuration constructs without throwing', () => {
  it('all 23 routed capabilities are covered by the default manifest table', () => {
    expect(() => new CapabilityRegistry(routes, new Map())).not.toThrow();
    // Sign of work: the routes really did go through the loop.
    expect(routes.length).toBeGreaterThan(20);
  });
});

describe('TC-INT-02 — a route with no manifest row fails at CONSTRUCTION', () => {
  const ROUTES: CapabilityRoute[] = [{ capability: 'legacy.thing', adapterIds: ['stub'] }];

  it('throws MissingCapabilityManifestError before any resolve(), naming the capability', () => {
    let thrown: unknown;
    try {
      new CapabilityRegistry(ROUTES, new Map([['stub', stubAdapter('stub')]]), undefined, null, {});
      expect.unreachable('a route with no manifest row must not build a registry');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MissingCapabilityManifestError);
    expect((thrown as MissingCapabilityManifestError).capability).toBe('legacy.thing');
    expect((thrown as Error).message).toContain('legacy.thing');
  });

  it('the failure is the CONSTRUCTOR, not a lazy check inside resolve()', () => {
    // The distinction is the requirement (task 012-4: "на конструировании, не лениво в resolve()").
    // A lazy implementation would let this expression produce an instance, and only the call below
    // would throw — so asserting on the CONSTRUCTOR expression is what tells the two apart.
    expect(
      () =>
        new CapabilityRegistry(ROUTES, new Map([['stub', stubAdapter('stub')]]), undefined, null, {
          'something.else': { shape: 'point', ttlSeconds: 60, deadlineMs: 15_000 },
        }),
    ).toThrow(MissingCapabilityManifestError);
  });
});

describe('TC-INT-03 — the fifth parameter is a live injection seam', () => {
  it('a caller-supplied manifest map builds a working registry', async () => {
    const registry = new CapabilityRegistry(
      [{ capability: 'legacy.thing', adapterIds: ['stub'] }],
      new Map([['stub', stubAdapter('stub')]]),
      undefined,
      null,
      { 'legacy.thing': { shape: 'set', ttlSeconds: 42, deadlineMs: 1_000 } },
    );
    const answer = await registry.resolve('legacy.thing', 'ethereum', {});
    expect(answer.source).toBe('stub');
    expect(answer.result).toStrictEqual({ ok: true });
  });
});

// =============================================================================================
// TC-F8 — adversarial cycle 2, F-8: a prototype key is not a manifest row, and a number that is
// not a number is not a deadline
// =============================================================================================

/**
 * The two inputs the constructor used to accept silently, and what they cost.
 *
 * **A capability named after an `Object.prototype` member.** `this.manifests[route.capability]` on a
 * plain object literal answers `Object` for `'constructor'` and the corresponding function for
 * `'toString'`/`'valueOf'`/`'hasOwnProperty'`, so `=== undefined` was false and the route validated.
 * The damage is downstream and silent: `nowMs + (row).deadlineMs` is `NaN`, and `Date.now() >= NaN`
 * is `false` at BOTH readers — the per-adapter pre-check and the terminal branch — so the deadline
 * for that capability is switched off while every comment in the tree says it is enforced.
 *
 * **A row whose `deadlineMs` is not a usable number.** `resolve()` already guards the CALLER's
 * `requestedDeadlineAtMs` with `Number.isSafeInteger`, and its comment states the harm precisely
 * ("not a wrong deadline but an inert one"). The manifest value enters the same `Math.min` and had
 * no guard at all — the identical defect one argument to the left, reachable with no caller.
 *
 * Neither input is exotic for a table that ADR-002 D1 expects to become configuration: a
 * JSON-shaped manifest, a hand-edited row, or a generated one can produce both.
 */
describe('TC-F8-UNIT — a prototype-named capability is a MISSING row, not a found one', () => {
  const PROTOTYPE_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'] as const;

  it.each(PROTOTYPE_KEYS)('%s does not resolve to a manifest row', (key) => {
    let thrown: unknown;
    try {
      new CapabilityRegistry(
        [{ capability: key, adapterIds: ['stub'] }],
        new Map([['stub', stubAdapter('stub')]]),
        undefined,
        null,
        { 'something.else': { shape: 'point', ttlSeconds: 60, deadlineMs: 15_000 } },
      );
      expect.unreachable(`a route named '${key}' must not build a registry`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MissingCapabilityManifestError);
    expect((thrown as MissingCapabilityManifestError).capability).toBe(key);
  });

  it('the shipped table is unaffected — the guard rejects the KEY, not the lookup', () => {
    // Sign of work in the other direction: a `hasOwn` guard applied to the wrong operand would fail
    // every real route, and 20 of them would say so here.
    expect(() => new CapabilityRegistry(routes, new Map())).not.toThrow();
  });
});

describe('TC-F8-UNIT — `deadlineMs` is validated, like the caller-supplied deadline already was', () => {
  /** Every shape that survives the type system through a cast, plus the two in-type ones (0, -1). */
  const UNUSABLE: [label: string, value: unknown][] = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a string', '15000'],
    ['undefined', undefined],
    ['a non-integer', 1.5],
    ['zero', 0],
    ['negative', -1],
    ['past 2^53', Number.MAX_SAFE_INTEGER + 2],
  ];

  it.each(UNUSABLE)(
    'rejects %s at CONSTRUCTION, naming the capability and the field',
    (_l, value) => {
      let thrown: unknown;
      try {
        new CapabilityRegistry(
          [{ capability: 'legacy.thing', adapterIds: ['stub'] }],
          new Map([['stub', stubAdapter('stub')]]),
          undefined,
          null,
          {
            'legacy.thing': {
              shape: 'point',
              ttlSeconds: 60,
              deadlineMs: value,
            } as unknown as CapabilityManifest,
          },
        );
        expect.unreachable('an unusable deadlineMs must not build a registry');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InvalidCapabilityManifestError);
      expect((thrown as InvalidCapabilityManifestError).capability).toBe('legacy.thing');
      expect((thrown as InvalidCapabilityManifestError).field).toBe('deadlineMs');
      // The value is rendered, so the diagnostic names what was actually there.
      expect((thrown as Error).message).toContain(String(value));
    },
  );

  it('a positive safe integer still builds — the guard has a passing input', () => {
    expect(
      () =>
        new CapabilityRegistry(
          [{ capability: 'legacy.thing', adapterIds: ['stub'] }],
          new Map([['stub', stubAdapter('stub')]]),
          undefined,
          null,
          { 'legacy.thing': { shape: 'point', ttlSeconds: 60, deadlineMs: 1 } },
        ),
    ).not.toThrow();
  });
});

// =============================================================================================
// TC-F5-GATE — the ENFORCEMENT record is COUNTED, not transcribed
// =============================================================================================

/**
 * Cycle 2's F-5 replaced fourteen false "cuts N" claims with per-row ENFORCED / DECLARED markers,
 * and the review of that fix found the same defect one level down: eleven of the twenty rows had no
 * marker a reader could find (the phrase was wrapped across two comment lines, or written in a
 * one-off variant), while the report said all twenty were marked. A claim true in one place and
 * absent in the others, reported as complete — which is the class the finding itself was about.
 *
 * So the count stops being a claim. This gate:
 *
 * 1. requires EXACTLY ONE canonical marker in every routed capability's row;
 * 2. derives what each marker SHOULD say from the adapter sources — a capability is enforced only
 *    when every adapter its routes name reads `deadlineAtMs` — and compares;
 * 3. checks the two ratios written in the module's ENFORCEMENT prose (`N of 12 adapters`,
 *    `N of 20 capabilities`) against those same measurements, so the sentence a reader trusts is
 *    the sentence the run verified.
 *
 * The consequence that matters is WI-37: threading the deadline into the remaining adapters flips
 * rows from DECLARED to ENFORCED, and this gate goes red until the markers and the two ratios move
 * with the code. That is the point — the previous version of the record could drift silently.
 */

/** The two markers, verbatim. A row carrying neither, both, or a variant is a defect. */
const ENFORCED_MARKER = '**ENFORCED TODAY**';
const DECLARED_MARKER = '**DECLARED, not enforced today**';

/**
 * Comments and string CONTENTS blanked, offsets preserved — a local copy of the scanner three other
 * test files carry, deliberately not shared (the file-ownership rule in `tier-single-source.test.ts`
 * applies here too), and carrying the same-line quote rule from the start: cycle 2's F-9 is exactly
 * the story of that rule existing in one copy of this function and not the others.
 */
function codeOnly(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      const quote = source[i];
      const lineEnd = source.indexOf('\n', i + 1);
      const sameLine = quote === '`' ? source.length : lineEnd === -1 ? source.length : lineEnd;
      let j = i + 1;
      let closed = false;
      while (j < sameLine) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) {
        i += 1;
        continue;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/** `'<cap>': { … }` blocks of the shipped table, capability → the block's text. */
function manifestRowBlocks(source: string): Map<string, string> {
  const starts = [...source.matchAll(/^ {2}'([a-z0-9._-]+)': \{$/gm)];
  const blocks = new Map<string, string>();
  starts.forEach((match, index) => {
    const from = match.index;
    const to = index + 1 < starts.length ? starts[index + 1]!.index : source.length;
    blocks.set(match[1] as string, source.slice(from, to));
  });
  return blocks;
}

/**
 * An IMPORT STATEMENT for one of the three modules through which an adapter can spend time on I/O —
 * used by `spendsTimeAdapters` below to decide which adapters a call ceiling could possibly
 * constrain.
 *
 * Matched against the RAW source and anchored to a line-initial `import`, deliberately: `codeOnly`
 * blanks string CONTENTS, which is exactly where a module specifier lives, so running this over
 * blanked source would report that no adapter imports anything. The anchor is what replaces the
 * blanking — a comment line starts with `//` or ` *`, never with `import`, so prose about
 * `net/safe-fetch.js` cannot put an adapter in the population.
 */
const TRANSPORT_IMPORTS =
  /^import\s[^;]*from\s*'[^']*(?:net\/safe-fetch|net\/rate-limit|pg\/read-client)\.js'/m;

function adapterSource(id: string): string {
  const adaptersDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/adapters');
  return readFileSync(path.join(adaptersDir, id, 'index.ts'), 'utf8');
}

function adapterCode(id: string): string {
  return codeOnly(adapterSource(id));
}

/**
 * Adapter ids whose implementation READS the deadline — measured from
 * `src/adapters/<id>/index.ts`, comments and string contents blanked.
 *
 * **Reached** (controls below): an adapter naming `deadlineAtMs` anywhere in code; an adapter that
 * only mentions it in a comment (NOT counted); an adapter that only has it inside a string literal
 * (NOT counted).
 *
 * **NOT reached — measured, not hypothesised** (asserted in the limits case):
 *
 * | Escape                                                            | Why |
 * | -------------------------------------------------------------------- | --- |
 * | An adapter that RECEIVES the deadline under another parameter name (`fetch(cap, args, until)`) | The scan keys on the identifier `ProviderAdapter.fetch` declares. A rename would read as "does not take it" — fails CLOSED (the row would be required to say DECLARED while the code enforced), which is the safe direction. |
 * | An adapter that names `deadlineAtMs` and then ignores the binding | Presence in code is checked, never use. Measured 2026-08-05: no adapter is in that shape, and the behavioural proof is `registry.deadline.test.ts` TC-INT-08a/08b, which WI-37 extended to one case per adapter. |
 * | A read that lives in a sibling module and not in `index.ts`       | Single-file scan per adapter. `nansen` names it in `index.ts` as well as in `endpoints.ts`, so today nothing hides there; a future adapter that forwards from a helper only would read as unaware — again fails closed. |
 */
function deadlineAwareAdapters(): Set<string> {
  const aware = new Set<string>();
  for (const registration of adapterRegistrations) {
    if (/\bdeadlineAtMs\b/.test(adapterCode(registration.id))) aware.add(registration.id);
  }
  return aware;
}

/**
 * Adapter ids that can SPEND TIME — i.e. reach a transport at all (WI-37).
 *
 * **Why the enforcement question needs this set.** A ceiling constrains waiting, so an adapter that
 * never waits cannot weaken one. Two of the twelve are M1 stubs: `isAvailable()` is unconditionally
 * false, so the registry skips them before anything is issued, and `fetch()` throws
 * `NotImplementedInM1Error`. The manifest already carries the consequence as a number — **E-DASH =
 * 0**, `dash-platform` contributing nothing to the five routes it shares with `platform-explorer`.
 *
 * **Derived, not listed, and that is the difference from the option WI-37 priced.** The record's
 * option 2 ("only the live routes") was costed as "instead of a gate, an exception list remains".
 * An id list would have to be maintained by whoever changes a stub. Membership by transport import
 * cannot drift: the day `dash-platform` grows the live gRPC transport ARCHITECTURE.md §11 describes,
 * it starts importing one of these modules, enters the population, and every row it routes goes red
 * until it takes the deadline — which is exactly the condition the manifest's own banner names for
 * revisiting those five rows.
 *
 * The alternative shape — giving the two stubs a `deadlineAtMs` parameter they ignore — was rejected
 * for the reason this repo rejects every decorative seam: it would make the scan say "aware" about
 * an adapter that does nothing with it, i.e. buy the count by writing the answer into the source.
 */
function spendsTimeAdapters(): Set<string> {
  const spending = new Set<string>();
  for (const registration of adapterRegistrations) {
    // The RAW source, not `codeOnly`'s output — see `TRANSPORT_IMPORTS` for why blanking string
    // contents would erase every module specifier this scan is looking for.
    if (TRANSPORT_IMPORTS.test(adapterSource(registration.id))) spending.add(registration.id);
  }
  return spending;
}

/**
 * Capability → whether its ceiling is actually enforced: every adapter its routes name either reads
 * the deadline, or cannot spend time in the first place.
 */
function enforcedCapabilities(aware: Set<string>, spendsTime: Set<string>): Map<string, boolean> {
  const byCapability = new Map<string, string[]>();
  for (const route of routes) {
    byCapability.set(route.capability, [
      ...(byCapability.get(route.capability) ?? []),
      ...route.adapterIds,
    ]);
  }
  return new Map(
    [...byCapability].map(([capability, ids]) => [
      capability,
      [...new Set(ids)].every((id) => aware.has(id) || !spendsTime.has(id)),
    ]),
  );
}

describe('TC-F5-GATE — every manifest row states its own enforcement, and the count is measured', () => {
  const blocks = manifestRowBlocks(manifestSource);
  const aware = deadlineAwareAdapters();
  const spendsTime = spendsTimeAdapters();
  const enforced = enforcedCapabilities(aware, spendsTime);

  it('the scan found the real table and the real adapters — otherwise everything below is vacuous', () => {
    expect(blocks.size).toBe(25);
    expect([...blocks.keys()].sort()).toStrictEqual(
      [...new Set(routes.map((r) => r.capability))].sort(),
    );
    expect(adapterRegistrations).toHaveLength(12);
    // Both sides of the split are non-empty, or the comparison could not fail in one direction.
    expect(aware.size).toBeGreaterThan(0);
    expect(aware.size).toBeLessThan(adapterRegistrations.length);
  });

  it('the exemption is DERIVED and lands on exactly the two adapters that cannot spend time', () => {
    // WI-37. The two sets must partition the twelve: an adapter either reaches a transport (and then
    // owes the deadline a read) or does not (and then cannot weaken a ceiling). Nothing may be in
    // neither category, because that would be an adapter doing I/O through a route this scan cannot
    // see — the shape that would let the ENFORCEMENT count be wrong in the unsafe direction.
    const exempt = adapterRegistrations
      .map((r) => r.id)
      .filter((id) => !spendsTime.has(id))
      .sort();
    expect(
      exempt,
      'An adapter is excused from reading the call deadline only by never waiting on anything. ' +
        'If this list grew, an adapter stopped importing the transport it uses; if it shrank, a ' +
        'stub grew one and now owes the deadline a read.',
    ).toStrictEqual(['dash-platform', 'dune']);
    // The exemption rests on unreachability, so the unreachability is asserted rather than
    // described: `isAvailable()` unconditionally false is what makes E-DASH = 0 true.
    for (const id of exempt) {
      expect(/isAvailable:\s*\(\)\s*=>\s*\(\{\s*ok:\s*false/.test(adapterCode(id)), id).toBe(true);
    }
    // …and every exempt adapter is also unaware, or the two sets would overlap and the count of
    // "adapters that read it" would silently include one that does nothing with it.
    expect(exempt.filter((id) => aware.has(id))).toStrictEqual([]);
  });

  it('every routed capability carries EXACTLY ONE canonical marker', () => {
    const defects: string[] = [];
    for (const [capability, block] of blocks) {
      const hasEnforced = block.includes(ENFORCED_MARKER);
      const hasDeclared = block.includes(DECLARED_MARKER);
      if (hasEnforced && hasDeclared) defects.push(`${capability}: both markers`);
      if (!hasEnforced && !hasDeclared) defects.push(`${capability}: no marker in its own row`);
    }
    expect(
      defects,
      'A banner over a block is not the row’s record: a reader greps ONE capability, or reads ' +
        'one row in a diff. Eleven rows were in this state after F-5’s first pass.',
    ).toStrictEqual([]);
  });

  it('each marker says what the ADAPTER SOURCES say', () => {
    const wrong: string[] = [];
    for (const [capability, block] of blocks) {
      const expectEnforced = enforced.get(capability) === true;
      const marked = block.includes(ENFORCED_MARKER) ? 'ENFORCED' : 'DECLARED';
      const should = expectEnforced ? 'ENFORCED' : 'DECLARED';
      if (marked !== should)
        wrong.push(`${capability}: row says ${marked}, the adapters say ${should}`);
    }
    expect(
      wrong,
      'The marker is a claim about running code. When WI-37 threads the deadline into the ' +
        'remaining adapters, these rows must move with it.',
    ).toStrictEqual([]);
  });

  it('the two ratios in the ENFORCEMENT prose are the ones this run measured', () => {
    const adapterClaim = /\*\*(\d+) of (\d+) adapters read the third/.exec(manifestSource);
    const capabilityClaim = /\*\*(\d+) of (\d+) capabilities are therefore actually bounded/.exec(
      manifestSource,
    );
    // Anchors go stale silently; say so loudly instead (the WI-28 gates' own rule).
    expect(adapterClaim, 'the ENFORCEMENT "N of 12 adapters" sentence was reworded').not.toBeNull();
    expect(
      capabilityClaim,
      'the ENFORCEMENT "N of 20 capabilities" sentence was reworded',
    ).not.toBeNull();

    const measuredEnforced = [...enforced.values()].filter(Boolean).length;
    expect([Number(adapterClaim![1]), Number(adapterClaim![2])]).toStrictEqual([
      aware.size,
      adapterRegistrations.length,
    ]);
    expect([Number(capabilityClaim![1]), Number(capabilityClaim![2])]).toStrictEqual([
      measuredEnforced,
      blocks.size,
    ]);
    // The measurement itself, written out once so a reader of this file sees the names too.
    // WI-37 moved this from two adapters to ten; the two absentees are the stubs, and their absence
    // is what the exemption case above justifies rather than assumes.
    expect([...aware].sort()).toStrictEqual([
      'blockchain-info',
      'blockscout',
      'coingecko',
      'defillama',
      'dexscreener',
      'nansen',
      'pg-history',
      'platform-explorer',
      'rpc-evm',
      'rpc-solana',
    ]);
    // Named, not counted: twenty of twenty, so a count alone could not tell this apart from a table
    // that had lost a row and gained another.
    expect(
      [...enforced]
        .filter(([, isEnforced]) => isEnforced)
        .map(([capability]) => capability)
        .sort(),
    ).toStrictEqual([...new Set(routes.map((route) => route.capability))].sort());
  });

  it('the detectors DETECT and the DECLARED LIMITS are real', () => {
    // Positive controls for `codeOnly` — a mention in a comment or in a string is not a read.
    expect(/\bdeadlineAtMs\b/.test(codeOnly('const x = deadlineAtMs;'))).toBe(true);
    expect(/\bdeadlineAtMs\b/.test(codeOnly('// forwards deadlineAtMs one day'))).toBe(false);
    expect(/\bdeadlineAtMs\b/.test(codeOnly("const s = 'deadlineAtMs';"))).toBe(false);
    // F-9's rule, in this copy too: a lone quote must not blank the rest of the file.
    expect(
      /\bdeadlineAtMs\b/.test(codeOnly('const RE = /case\\s*(?:\'|")/;\nawait f(deadlineAtMs);')),
      'LIMIT/CONTROL: a quote that opens no string must not swallow the following code',
    ).toBe(true);
    // LIMIT: a renamed parameter reads as "unaware" — fails CLOSED, the safe direction.
    expect(
      /\bdeadlineAtMs\b/.test(codeOnly('async function fetch(cap, args, until) { use(until); }')),
    ).toBe(false);
    // LIMIT: presence in code is checked, never USE.
    expect(/\bdeadlineAtMs\b/.test(codeOnly('function f(deadlineAtMs) { return 1; }'))).toBe(true);

    // Controls for the WI-37 exemption scan, same shape: an import of a transport module puts an
    // adapter in the population, a mention of one in a comment or a string does not.
    expect(TRANSPORT_IMPORTS.test("import { safeFetch } from '../../net/safe-fetch.js';")).toBe(
      true,
    );
    expect(
      TRANSPORT_IMPORTS.test("import { createReadClient } from '../../pg/read-client.js';"),
    ).toBe(true);
    // A multi-line import must still count — `blockchain-info`'s first import spans five lines, and
    // a regex that stopped at the first newline would read the whole adapter as doing no I/O.
    expect(
      TRANSPORT_IMPORTS.test(
        "import {\n  isPassThroughTransportError,\n  safeFetch,\n} from '../../net/safe-fetch.js';",
      ),
    ).toBe(true);
    // …and prose about a transport module must not.
    expect(TRANSPORT_IMPORTS.test('// one day this will use net/safe-fetch.js')).toBe(false);
    expect(TRANSPORT_IMPORTS.test(" * imports from '../../net/safe-fetch.js' eventually")).toBe(
      false,
    );
  });
});
