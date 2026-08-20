import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { routes } from '../src/providers.config.js';
import { ttlFor, NEGATIVE_TTL_SECONDS } from '../src/cache/ttl.js';
import { capabilityManifests } from '../src/capability-manifest.js';

/**
 * Every routed capability must have an EXPLICIT TTL row (TASK-009 doc pass; retargeted in task
 * 012-5).
 *
 * **Why this is a gate and not a review item.** A capability with no row silently falls through to
 * `DEFAULT_TTL_SECONDS` — and the failure is invisible, because the cache works perfectly, just at a
 * number nobody chose. It has happened twice: all three of M2's PAID capabilities shipped that way
 * (found by two independent adversarial critics, not by a test), and then `dex.volume.history` did
 * (found by review again). Both times the mechanism that caught it was a human reading the file.
 *
 * `ttlFor()` cannot express the difference — it returns a number either way — so the check has to
 * read the table's own source. That is the point: this asserts a property of the SOURCE, which is
 * where the omission lives.
 *
 * **Task 012-5 moved the source, and this file's own guard is what made the move safe.** The table
 * now lives in `src/capability-manifest.ts` (`'<id>': { … ttlSeconds: <n> … }`) instead of
 * `src/cache/ttl.ts` (`'<id>': <n>,`). Retargeting the regex FIRST would have passed on the first
 * run — the manifest was already complete — and proved nothing. Deleting `TTL_SECONDS` first made
 * the old regex match zero rows, and the vacuity guard below failed with
 * `expected 0 to be greater than 10`: recorded, because a guard that has never fired is a claim, not
 * a mechanism.
 *
 * **What the retarget also changed, and it is the point of the whole task.** A missing row here is
 * no longer merely *detected* by this file: `CapabilityRegistry`'s construction-time validation
 * (task 012-4) refuses to build a registry for a route with no manifest entry, so the omission stops
 * the process instead of silently choosing 300 seconds. This gate keeps guarding the SHAPE of the
 * source — that each row is written out with its own number, rather than derived — which the runtime
 * check cannot see.
 */

const manifestSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/capability-manifest.ts'),
  'utf8',
);

/** The `{…}` block opening at `braceIndex`, brace-matched. */
function enclosingObject(source: string, braceIndex: number): string {
  let depth = 0;
  for (let i = braceIndex; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(braceIndex, i + 1);
    }
  }
  return source.slice(braceIndex);
}

/**
 * Capability ids written out as a manifest RECORD that carries its own `ttlSeconds` number —
 * `'<id>': { … ttlSeconds: <n> … }`.
 *
 * **Reached** (a positive control for each, below):
 *
 * | Form                                                              | Result |
 * | ------------------------------------------------------------------- | ------ |
 * | A record spanning many lines with `ttlSeconds` among its fields    | found  |
 * | A record collapsed onto one line                                    | found  |
 * | A record with NO `ttlSeconds` of its own                            | not found → the per-capability case below fails |
 * | A record whose `ttlSeconds` is an identifier, not a literal         | not found → same failure |
 *
 * **NOT reached — measured, not hypothesised** (asserted in "the DECLARED LIMITS are real"):
 *
 * | Escape                                                                     | Why |
 * | ------------------------------------------------------------------------------ | --- |
 * | A record inside a BLOCK comment, on a line that itself begins with the quoted key, or in any other quoted-key object literal in the file | The scan reads text: it does not blank comments and cannot tell one object literal from another. **Measured, and it corrected this table:** a `// '<id>': { … }` line is NOT counted (the marker sits before the key, so `^\s+'` fails), which is the form a first draft of this row claimed as the escape. The runtime checks below (`ttlFor` per capability) are what make either harmless — a row that is only prose returns the default and fails them. |
 * | The VALUE being wrong (a TTL edit)                                          | Presence is checked here, never the number. TC-UNIT-01 below pins the values, against literals. |
 * | A row inherited from a spread — `'x': { ...BASE, deadlineMs: 1 }`            | It carries no `ttlSeconds` of its own, so it is reported as missing. Declared rather than fixed: nothing in the manifest spreads today, and a scan that followed spreads would have to resolve them. |
 */
function explicitTtlRows(source: string): string[] {
  const rows: string[] = [];
  for (const match of source.matchAll(/^\s+'([a-z0-9._-]+)':\s*\{/gm)) {
    const id = match[1];
    if (id === undefined) continue;
    const body = enclosingObject(source, match.index + match[0].length - 1);
    if (/\bttlSeconds:\s*\d+/.test(body)) rows.push(id);
  }
  return rows;
}

const explicitRows = new Set(explicitTtlRows(manifestSource));

const routedCapabilities = [...new Set(routes.map((route) => route.capability))].sort();

describe('TTL table covers every routed capability explicitly', () => {
  it('has at least one row and one route — otherwise the checks below are vacuous', () => {
    // Guards against the scan silently matching nothing. Stated exactly: with an empty set the
    // per-capability cases below fail too — what goes vacuous is the ORPHAN check, and what this
    // buys on top is a first failure that names the CAUSE ("0 rows") instead of twenty
    // indistinguishable ones. It DID fire, on purpose, in task 012-5: `TTL_SECONDS` was deleted
    // before this file was retargeted, and the run reported `expected 0 to be greater than 10`
    // here, followed by exactly those twenty.
    expect(explicitRows.size).toBeGreaterThan(10);
    expect(routedCapabilities.length).toBeGreaterThan(10);
  });

  it.each(routedCapabilities)('%s has an explicit row, not the fallback', (capability) => {
    expect(explicitRows.has(capability)).toBe(true);
  });

  it('has no TTL row for a capability nothing routes', () => {
    // The opposite drift: a capability removed from `routes` leaves its row behind, and the next
    // reader takes the dead row for a served capability.
    const orphans = [...explicitRows].filter((row) => !routedCapabilities.includes(row));
    expect(orphans).toEqual([]);
  });

  it('returns a positive TTL for every routed capability', () => {
    for (const capability of routedCapabilities) {
      expect(ttlFor(capability)).toBeGreaterThan(0);
    }
  });

  it('the row scan DETECTS each reached form', () => {
    // A detector with no control can be added dead — and this one was rewritten wholesale in 012-5,
    // which is exactly when a scan starts matching something other than what its name says.
    expect(explicitTtlRows(`  'a.b': {\n    shape: 'point',\n    ttlSeconds: 60,\n  },`)).toEqual([
      'a.b',
    ]);
    expect(
      explicitTtlRows(
        `  'a.b': { shape: 'point', ttlSeconds: 60, deadlineMs: 1, shareable: true },`,
      ),
    ).toEqual(['a.b']);
    expect(
      explicitTtlRows(`  'a.b': {\n    shape: 'point',\n    deadlineMs: 15_000,\n  },`),
      'a record with no `ttlSeconds` of its own is NOT a row',
    ).toEqual([]);
    expect(
      explicitTtlRows(`  'a.b': {\n    ttlSeconds: HOURLY,\n  },`),
      'a named constant is not a written-out number',
    ).toEqual([]);
  });

  it('the DECLARED LIMITS are real: these forms are NOT reached, and that is written down', () => {
    // Executable form of the "NOT reached" table above: asserting the limits keeps the table honest
    // and turns any future widening into a visible edit HERE.
    expect(
      explicitTtlRows(`/*\n  'a.b': { shape: 'point', ttlSeconds: 60, shareable: true },\n*/`),
      'LIMIT: a row inside a block comment whose line begins with the quoted key counts as ' +
        'present — the runtime checks are what catch it',
    ).toEqual(['a.b']);

    expect(
      explicitTtlRows(`  // 'a.b': { shape: 'point', ttlSeconds: 60, shareable: true },`),
      'and the neighbouring form is NOT the same escape: `//` before the key defeats the anchor. ' +
        'Measured — the first draft of the limits table above claimed this one and was wrong.',
    ).toEqual([]);

    expect(
      explicitTtlRows(`  'a.b': { shape: 'point', ttlSeconds: 999_999, shareable: true },`),
      'LIMIT: presence is checked, never the value (TC-UNIT-01 pins the values)',
    ).toEqual(['a.b']);

    expect(
      explicitTtlRows(`  'a.b': { ...BASE, deadlineMs: 1 },`),
      'LIMIT: a spread is not followed — an inherited `ttlSeconds` reads as missing',
    ).toEqual([]);
  });
});

// =============================================================================================
// TC-UNIT-01/02/03 — `ttlFor()` after the move (task 012-5)
// =============================================================================================

/**
 * What `ttlFor()` answered BEFORE it became a reader of the manifest — transcribed, never derived.
 *
 * **A literal on purpose.** Computing these from `capabilityManifests` would make the test say
 * "`ttlFor` returns what the manifest holds", which is the implementation restated: it would pass
 * under any table, including one this task edited. Written out, the list can only move in a diff
 * that says so.
 *
 * It is a SECOND copy of `capability-manifest.test.ts`'s `TTL_SECONDS_BEFORE_THE_MOVE`, and
 * deliberately so: that one pins the manifest TABLE against the pre-move source, this one pins the
 * FUNCTION's answers across the rewiring. A shared constant would let one edit satisfy both.
 */
const TTL_FOR_BEFORE_THE_MOVE: Readonly<Record<string, number>> = {
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
  // WI-51 — the two network-activity rows. 30 s is the shortest TTL in the table and 600 s is
  // twenty times it, off ONE document: the fields have different clocks (gas re-stamps about every
  // minute; the daily transaction aggregate did not move across 45 s of new blocks).
  'gas.price': 30,
  'chain.transactions': 600,
  // WI-52 — the incident feed, on the slowest clock of the protocol capabilities.
  'protocol.incidents': 3600,
};

/**
 * Capabilities introduced AFTER the TTL move — the second reader of the same historical snapshot,
 * carrying the same named exception (task 014-32b).
 *
 * See `capability-manifest.test.ts`'s `INTRODUCED_AFTER_THE_MOVE` for the whole argument: a
 * capability that did not exist before the move has no before-value, and writing one would
 * fabricate a measurement. Declared twice rather than exported, because the two files pin two
 * DIFFERENT frozen tables and a shared constant would tie them together for the first time here.
 */
const INTRODUCED_AFTER_THE_MOVE = new Set(['token.pools']);

/** The routed capabilities this file's frozen table is entitled to describe. */
const routedBeforeTheMove = routedCapabilities.filter(
  (capability) => !INTRODUCED_AFTER_THE_MOVE.has(capability),
);

describe('TC-UNIT-01 — the move changed no TTL: `ttlFor()` answers exactly as before', () => {
  it('covers every routed capability that reached the move, so no row escaped the comparison', () => {
    expect(Object.keys(TTL_FOR_BEFORE_THE_MOVE).sort()).toStrictEqual(routedBeforeTheMove);
  });

  it('every named exception is a capability that really routes', () => {
    // The exception list must not be able to excuse a capability that does not exist — a typo here
    // would be indistinguishable from a correct entry.
    const unknown = [...INTRODUCED_AFTER_THE_MOVE].filter(
      (capability) => !routedCapabilities.includes(capability),
    );
    expect(unknown, 'a named exception names no routed capability').toStrictEqual([]);
  });

  it.each(Object.entries(TTL_FOR_BEFORE_THE_MOVE))('%s -> %i seconds', (capability, seconds) => {
    expect(ttlFor(capability)).toBe(seconds);
  });
});

describe('TC-UNIT-02 — `DEFAULT_TTL_SECONDS` survives, for the input it is actually for', () => {
  /**
   * The constant is not exported (and is not being exported for a test — `index.ts` records the one
   * justification that was accepted for widening this module's surface, and "a test wants it" is not
   * it), so the expected value is written out. 300 is the number, and TC-UNIT-01 above proves it is
   * no longer the answer for anything routed: only `protocol.tvl`, `chain.tvl` and `pool.info` are
   * 300, and each by its own manifest row.
   */
  it('an unrouted capability string still gets the documented default', () => {
    expect(ttlFor('capability.which.nothing.routes')).toBe(300);
  });

  it('is unreachable for every routed capability — enumerated, not asserted in general', () => {
    // R-138d wants this stated by enumeration. What makes it a property rather than a coincidence is
    // `CapabilityRegistry`'s construction-time manifest check (012-4), which this cannot observe;
    // `capability-manifest.test.ts`'s TC-INT-02 is where that half is tested.
    //
    // The frozen table cannot answer for a capability added after the move, so the enumeration runs
    // over the rows it is entitled to describe. `explicitRows` below still runs over ALL of them —
    // that half reads the live manifest, and a new capability falling through to the default is
    // exactly what it exists to catch.
    const fallingThrough = routedBeforeTheMove.filter(
      (capability) => !Object.keys(TTL_FOR_BEFORE_THE_MOVE).includes(capability),
    );
    expect(fallingThrough).toStrictEqual([]);
    for (const capability of routedCapabilities) {
      expect(explicitRows.has(capability), capability).toBe(true);
    }
  });
});

describe('TC-UNIT-03 — `NEGATIVE_TTL_SECONDS` is untouched and still not per-capability', () => {
  it('is the same plain number it was', () => {
    expect(NEGATIVE_TTL_SECONDS).toBe(60);
    expect(typeof NEGATIVE_TTL_SECONDS).toBe('number');
  });

  it('did not travel into the manifest', () => {
    // It is a property of the FAILURE path, not of a capability, which is why the positive TTLs
    // moved and it did not. Two narrow checks: no manifest ROW carries a negative-TTL key, and the
    // module names no such field. **Not** `/negative/i` over the source — measured, that matches the
    // prose "the negative type-test that T-012 cannot write" in the type's own docstring, so the
    // first draft of this test failed on a sentence. It cannot prove that no future field means the
    // same thing under an unrelated name.
    const keys = Object.values(capabilityManifests).flatMap((manifest) => Object.keys(manifest));
    expect(keys.length).toBeGreaterThan(20); // sign of work: the rows really were walked
    expect(keys.filter((key) => /negative/i.test(key))).toStrictEqual([]);
    expect(/negativeTtl/i.test(manifestSource)).toBe(false);
  });
});
