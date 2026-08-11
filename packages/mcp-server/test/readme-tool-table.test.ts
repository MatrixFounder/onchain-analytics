import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createNansenAdapter, routes, ttlFor } from '@onchain-intel/core';
// Task 012-5, in a SEPARATE statement so the import above stays byte-identical: AC-5 is "the gate's
// own `ttlFor` code is not edited", and a diff that leaves line 5 untouched is how that is checked
// mechanically rather than by reading.
import { capabilityManifests, type CapabilityManifest } from '@onchain-intel/core';
import { toolSpecs } from '../src/tools/tool-specs.js';

/**
 * The READMEs restate TTLs and credit prices; those restatements are checked against the code
 * (WI-28).
 *
 * **Why this exists.** `tool-inventory-docs.test.ts` demands that every gated document NAME every
 * tool — and nothing more. But each README row carries two further facts: the cache TTL and the
 * price in Nansen credits. Those were retold in two files, in two languages, four tables in all,
 * with nothing comparing them to `cache/ttl.ts` or to `costOf()` — and this is precisely the class
 * that survived four shipped tasks in these same two files (eight tool names of thirteen, stale
 * since TASK-006). No drift existed on the day WI-28 was written; an unguarded restatement is a
 * defect waiting rather than a defect present, and the mechanism to guard it already existed next
 * door in `docs-counts.test.ts`.
 *
 * **Four tables, not one** — the record named the "Tool reference" table; the "Caching" table is a
 * second copy of the same fact keyed by capability instead of by tool, and its rationale column
 * quotes credit prices too ("6 cr per miss", "up to 100 cr/miss"). Fixing only the table that was
 * pointed at is how a fix removes the alarm without removing the cause.
 *
 * **The two languages are also compared to each other**, because a translated copy can drift
 * against its original while both agree with the code on the rows they happen to state.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), 'utf8');

/**
 * `60s` / `60с` (Cyrillic es) / `—` → 60 | null. The unit letter differs per language; the digits do
 * not. No `\b` after the unit: JavaScript's `\w` is ASCII-only, so a Cyrillic `с` is already a
 * non-word character and a word boundary can never follow it — the first version of this regex
 * silently matched nothing in `README.ru.md` and reported every RU row as `—`.
 */
function seconds(cell: string): number | null {
  const digits = /(\d+)\s*[sс]/u.exec(cell.trim());
  return digits ? Number(digits[1]) : null;
}

/** Every integer stated in a cost cell: `**0/5/100 cr**` → [0,5,100]; `free` / `бесплатно` → []. */
function credits(cell: string): number[] {
  return [...cell.matchAll(/\d+/g)].map((m) => Number(m[0]));
}

/**
 * Prices quoted in prose: `6 cr per miss`, `до 100 кр за промах`.
 *
 * **The unit is followed by a negative lookahead, not `\b`** — and the first version of this line
 * got it wrong in exactly the way the `seconds()` docstring above describes, three functions after
 * writing that docstring. `\b` after a Cyrillic `р` can never match (JS `\w` is ASCII-only), so the
 * Russian rationale column matched **nothing** and its half of the check passed by inspecting an
 * empty list while the English half worked. Found by the adversarial cycle, not by the suite; hence
 * the per-language vacuity floor in the test below, which is what would have caught it.
 */
function quotedCredits(cell: string): number[] {
  return [...cell.matchAll(/(\d+)\s*(?:cr|кр)(?![\p{L}\p{N}])/gu)].map((m) => Number(m[1]));
}

interface ToolRow {
  tool: string;
  cost: number[];
  ttl: number | null;
}

/** The `| \`onchain_x\` | cost | TTL | key |` rows of the Tool reference table. */
function toolRows(relative: string): ToolRow[] {
  return read(relative)
    .split('\n')
    .flatMap((line) => {
      const cells = /^\|\s*`(onchain_[a-z0-9_]+)`\s*\|([^|]*)\|([^|]*)\|/.exec(line);
      if (!cells) return [];
      return [
        {
          tool: cells[1] as string,
          cost: credits(cells[2] as string),
          ttl: seconds(cells[3] as string),
        },
      ];
    });
}

/** The `| \`capability\` | TTL | why |` rows of the Caching section. */
function cachingRows(relative: string): { capability: string; ttl: number | null; why: string }[] {
  const caching = read(relative)
    .split(/^## /m)
    .find((s) => /^(Caching|Кеширование)/.test(s));
  expect(
    caching,
    `${relative} has no Caching section — the pattern that finds it went stale`,
  ).toBeDefined();
  return (caching as string).split('\n').flatMap((line) => {
    const cells = /^\|\s*`([a-z0-9._*-]+)`\s*\|([^|]*)\|([^|]*)\|/.exec(line);
    if (!cells) return [];
    return [
      { capability: cells[1] as string, ttl: seconds(cells[2] as string), why: cells[3] as string },
    ];
  });
}

/**
 * Every credit price this capability can cost, derived through the adapter's own `costOf()` — never
 * a number read off the cost table by hand. `entity.labels` genuinely has three tiers (no address,
 * an address, the `exhaustive` escalation), which is what the README's `0/5/100` states.
 */
const nansen = createNansenAdapter({ env: {} });
const ARG_VARIANTS: Record<string, unknown>[] = [
  {},
  { tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
  { exhaustive: true },
];
function derivedCredits(capability: string): number[] {
  const priced = ARG_VARIANTS.map((args) => nansen.costOf(capability, args).credits).filter((c) =>
    Number.isFinite(c),
  );
  return [...new Set(priced)].sort((a, b) => a - b);
}

/** Capabilities `nansen` is routed for — the only ones whose README cell may carry a number. */
const PAID_CAPABILITIES = new Set(
  routes.filter((route) => route.adapterIds.includes('nansen')).map((route) => route.capability),
);

const CAPABILITY_OF = new Map(
  toolSpecs.map((spec) => [spec.name, spec.capability] as [string, string | null]),
);

/**
 * The TTL the table must state for a tool, or a REASON it cannot be stated (T-013 task 013-8).
 *
 * A tool serving several capabilities carries `capability: null`, and the pre-013-8 gate read that
 * as "no cache" and demanded a `—` in the cell. That would publish a false claim in the product's
 * own front page: both merged capabilities carry `ttlSeconds: 3600`. Owner decision 2026-08-06 —
 * teach the gate to unfold `servedCapabilities` rather than print the dash.
 *
 * **The unfolding must be UNAMBIGUOUS.** If the listed capabilities disagree on TTL there is no
 * single honest number for one cell, so this returns an error naming the tool and every value
 * rather than silently picking one. A future multi-capability tool spanning two TTLs will hit that
 * branch and be told to split the row, not quietly mislead.
 */
function expectedTtl(spec: {
  name: string;
  capability: string | null;
  servedCapabilities?: readonly string[];
}): { ttl: number | null } | { error: string } {
  if (spec.servedCapabilities === undefined) {
    return { ttl: spec.capability === null ? null : ttlFor(spec.capability) };
  }
  const ttls = [...new Set(spec.servedCapabilities.map((capability) => ttlFor(capability)))];
  if (ttls.length !== 1) {
    return {
      error:
        `${spec.name}: serves capabilities with DIFFERENT TTLs (` +
        spec.servedCapabilities
          .map((capability) => `${capability}=${String(ttlFor(capability))}s`)
          .join(', ') +
        ') — one table cell cannot state them; split the row or state the range explicitly',
    };
  }
  return { ttl: ttls[0] as number };
}

const READMES = ['README.md', 'README.ru.md'] as const;

describe('the README tool table states the TTL the code applies (WI-28)', () => {
  it.each(READMES)('%s', (relative) => {
    const rows = toolRows(relative);
    // Not vacuous: if the table is reformatted the regex stops matching, and every check below
    // would pass over an empty list.
    expect(rows.length).toBe(toolSpecs.length);

    const wrong = rows.flatMap((row) => {
      const spec = toolSpecs.find((candidate) => candidate.name === row.tool);
      if (spec === undefined) return []; // an unknown tool is tool-inventory-docs.test.ts's job
      const resolved = expectedTtl(spec);
      if ('error' in resolved) return [resolved.error];
      return row.ttl === resolved.ttl
        ? []
        : [`${row.tool}: table says ${row.ttl ?? '—'}, cache/ttl.ts says ${resolved.ttl ?? '—'}`];
    });
    expect(
      wrong,
      `${relative}'s Tool reference TTL column disagrees with packages/core/src/cache/ttl.ts.`,
    ).toStrictEqual([]);
  });
});

/**
 * TC-GATE-09's other direction (T-013 task 013-8). The extension above is only trustworthy if it
 * REFUSES the case it cannot state, so the refusal is exercised rather than asserted in prose — the
 * same discipline every mutation protocol in this repository follows.
 */
describe('the TTL unfolding refuses a tool whose capabilities disagree (T-013 task 013-8)', () => {
  it('names the tool and BOTH values instead of silently picking one', () => {
    // 3600s and 1800s — real capabilities with genuinely different TTLs, so the disagreement is a
    // fact about `cache/ttl.ts` and not a number invented for the test.
    const synthetic = {
      name: 'onchain_two_ttl_probe',
      capability: null,
      servedCapabilities: ['platform.metrics.history', 'token.risk'] as const,
    };

    const resolved = expectedTtl(synthetic);

    expect('error' in resolved).toBe(true);
    if (!('error' in resolved)) return;
    expect(resolved.error).toContain('onchain_two_ttl_probe');
    // Both values, because a message naming one of them reads as a verdict rather than a conflict.
    expect(resolved.error).toContain('3600');
    expect(resolved.error).toContain('1800');
  });

  it('accepts the shipped multi-capability tool, whose two capabilities agree at 3600s', () => {
    const spec = toolSpecs.find((candidate) => candidate.servedCapabilities !== undefined);
    expect(
      spec,
      'no multi-capability tool is registered — this gate would be vacuous',
    ).toBeDefined();
    if (!spec) return;

    const resolved = expectedTtl(spec);

    expect('error' in resolved).toBe(false);
    if ('error' in resolved) return;
    expect(resolved.ttl).toBe(3600);
  });
});

describe('the README tool table states the credits costOf() charges (WI-28)', () => {
  it.each(READMES)('%s', (relative) => {
    const wrong = toolRows(relative).flatMap((row) => {
      const capability = CAPABILITY_OF.get(row.tool);
      if (capability === undefined || capability === null) return [];
      if (!PAID_CAPABILITIES.has(capability)) {
        return row.cost.length === 0
          ? []
          : [`${row.tool}: free capability, but the table states ${row.cost.join('/')} credits`];
      }
      const expected = derivedCredits(capability);
      return row.cost.join('/') === expected.join('/')
        ? []
        : [`${row.tool}: table says ${row.cost.join('/')}, costOf() says ${expected.join('/')}`];
    });
    expect(
      wrong,
      `${relative}'s Cost column disagrees with the price the Nansen adapter would reserve.`,
    ).toStrictEqual([]);
  });
});

describe('the README caching table states the same TTLs (WI-28)', () => {
  it.each(READMES)('%s', (relative) => {
    const rows = cachingRows(relative);
    expect(rows.length).toBe(8); // the exact row count of the Caching table, not a floor

    const routed = new Set(routes.map((route) => route.capability));
    const wrong = rows.flatMap((row) => {
      // `wallet.balances.*` stands for every routed capability under that prefix; the row is only
      // truthful if they all share one TTL, so that is asserted rather than assumed.
      const covered = row.capability.endsWith('.*')
        ? [...routed].filter((c) => c.startsWith(row.capability.slice(0, -1)))
        : [row.capability];
      if (covered.length === 0) {
        return [`${row.capability}: named in the caching table but routed nowhere`];
      }
      const ttls = [...new Set(covered.map(ttlFor))];
      if (ttls.length > 1) {
        return [`${row.capability}: covers capabilities with differing TTLs (${ttls.join(', ')})`];
      }
      return row.ttl === ttls[0]
        ? []
        : [`${row.capability}: table says ${row.ttl ?? '—'}, cache/ttl.ts says ${ttls[0] ?? '—'}`];
    });
    expect(
      wrong,
      `${relative}'s Caching table disagrees with packages/core/src/cache/ttl.ts.`,
    ).toStrictEqual([]);
  });

  it.each(READMES)('%s quotes only credit prices costOf() would charge', (relative) => {
    // The rationale column carries prices too ("6 cr per miss", "up to 100 cr/miss") — the same
    // restatement class, one column over.
    const rows = cachingRows(relative);
    // **Per-language vacuity floor.** Without it, a regex that stops matching in ONE language
    // reports that language clean forever. That is not hypothetical: it is what the first version
    // of `quotedCredits` did to `README.ru.md`.
    expect(
      rows.reduce((n, row) => n + quotedCredits(row.why).length, 0),
      `${relative}'s Caching rationale quotes no price at all — either the column stopped naming ` +
        'them, or the extraction went blind in this language.',
    ).toBeGreaterThanOrEqual(2);

    const wrong = rows.flatMap((row) => {
      const quoted = quotedCredits(row.why);
      if (quoted.length === 0) return [];
      if (!PAID_CAPABILITIES.has(row.capability)) {
        return [
          `${row.capability}: free capability, but its rationale quotes ${quoted.join('/')} credits`,
        ];
      }
      const expected = derivedCredits(row.capability);
      const stray = quoted.filter((price) => !expected.includes(price));
      return stray.length === 0
        ? []
        : [
            `${row.capability}: quotes ${stray.join('/')} cr; costOf() charges ${expected.join('/')}`,
          ];
    });
    expect(
      wrong,
      `${relative}'s Caching rationale quotes a price the code does not charge.`,
    ).toStrictEqual([]);
  });
});

describe('the two language editions state the same numbers (WI-28)', () => {
  it('the Tool reference tables agree row for row', () => {
    const [en, ru] = READMES.map(toolRows);
    expect((ru as ToolRow[]).map((row) => row.tool)).toStrictEqual(
      (en as ToolRow[]).map((row) => row.tool),
    );
    const disagreeing = (en as ToolRow[]).flatMap((row, index) => {
      const other = (ru as ToolRow[])[index] as ToolRow;
      const same = row.ttl === other.ttl && row.cost.join('/') === other.cost.join('/');
      return same
        ? []
        : [
            `${row.tool}: README.md says ${row.cost.join('/') || 'free'}/${row.ttl ?? '—'}, ` +
              `README.ru.md says ${other.cost.join('/') || 'free'}/${other.ttl ?? '—'}`,
          ];
    });
    expect(
      disagreeing,
      'The two editions disagree. Both are checked against the code above, so this can only fire ' +
        'on a row one of them omits or renders differently — which is how a translation drifts.',
    ).toStrictEqual([]);
  });

  it('the Caching tables agree row for row — TTLs AND the prices in the rationale', () => {
    const [en, ru] = READMES.map(cachingRows);
    // The rationale column is compared too. The first version compared only `capability=ttl`, so a
    // price drifting in one language was invisible to BOTH this check and (because of the regex
    // bug) the per-language one.
    const shape = (rows: ReturnType<typeof cachingRows>): string[] =>
      rows.map((row) => `${row.capability}=${row.ttl ?? '—'}/${quotedCredits(row.why).join(',')}`);
    expect(shape(ru as ReturnType<typeof cachingRows>)).toStrictEqual(
      shape(en as ReturnType<typeof cachingRows>),
    );
  });
});

/**
 * The FIFTH table — and the one the implementation names as its authority.
 *
 * `packages/core/src/cache/ttl.ts`'s own docstring says its rows are "copied literally from that
 * table", meaning `docs/architectures/system-architecture.md` §3.2. WI-28 was filed about the
 * READMEs and closed the first time over four tables; the adversarial cycle found this one, and it
 * was **already drifted** — six routed capabilities had no row at all (`chain.tvl`, `pool.info`,
 * both `*.history`, and all three paid ones), so the document the code cites as its source had been
 * behind it since M1.
 *
 * Completeness is asserted here and NOT in the README tables, deliberately: a README is a curated
 * selection for a reader, an authority is not allowed to be selective.
 */
describe('the architecture TTL table is complete and matches the code (WI-28)', () => {
  const ARCHITECTURE = 'docs/architectures/system-architecture.md';

  /** `| \`a\`, \`b.*\` | 3600s | … |` → the capability ids it covers, expanded. */
  function architectureRows(): { stated: string; covered: string[]; ttl: number | null }[] {
    const routed = [...new Set(routes.map((route) => route.capability))];
    // **Anchored on the section, not scanned across 2000 lines** (adversarial cycle 2). The document
    // holds four other tables whose first cell is a backticked id — including one keyed on
    // `smart-money.flows` — and they were excluded only by their second cell happening to contain no
    // `<digits>s`. One "5 s timeout" in the wrong row would have silently reassigned a capability's
    // documented TTL.
    const section = read(ARCHITECTURE).split(/^- \*\*TTL by data type\*\*/m)[1];
    expect(
      section,
      `${ARCHITECTURE} has no "TTL by data type" block — the anchor this gate reads went stale.`,
    ).toBeDefined();
    return (
      (section as string)
        // …up to the next sibling bullet, so the block is exactly this table and its prose.
        .split(/^- \*\*/m)[0]!
        .split('\n')
        .flatMap((line) => {
          const cells = /^\s*\|\s*(`[a-z0-9._*-]+`(?:\s*,\s*`[a-z0-9._*-]+`)*)\s*\|([^|]*)\|/.exec(
            line,
          );
          if (!cells) return [];
          const ids = [...(cells[1] as string).matchAll(/`([a-z0-9._*-]+)`/g)].map(
            (m) => m[1] as string,
          );
          const covered = ids.flatMap((id) =>
            id.endsWith('.*') ? routed.filter((c) => c.startsWith(id.slice(0, -1))) : [id],
          );
          return [{ stated: ids.join(', '), covered, ttl: seconds(cells[2] as string) }];
        })
        .filter((row) => row.ttl !== null && row.covered.length > 0)
    );
  }

  it('states a TTL for EVERY routed capability', () => {
    const rows = architectureRows();
    expect(rows.length).toBe(18); // the exact row count of §3.2's table, not a floor
    const documented = new Set(rows.flatMap((row) => row.covered));
    const missing = [...new Set(routes.map((r) => r.capability))].filter(
      (capability) => !documented.has(capability),
    );
    expect(
      missing.sort(),
      `${ARCHITECTURE} §3.2 is the table \`cache/ttl.ts\` says it copies. These routed ` +
        'capabilities have no row in it, so the code has a TTL its stated source never gave it.',
    ).toStrictEqual([]);
  });

  it('states the TTL the code actually applies', () => {
    const wrong = architectureRows().flatMap((row) => {
      const ttls = [...new Set(row.covered.map(ttlFor))];
      if (ttls.length > 1) {
        return [`${row.stated}: groups capabilities with differing TTLs (${ttls.join(', ')})`];
      }
      return row.ttl === ttls[0]
        ? []
        : [`${row.stated}: table says ${row.ttl ?? '—'}, cache/ttl.ts says ${ttls[0] ?? '—'}`];
    });
    expect(wrong, `${ARCHITECTURE} §3.2 disagrees with cache/ttl.ts.`).toStrictEqual([]);
  });
});

// =============================================================================================
// The SIXTH table — `deadlineMs`/`paidLegMs` by capability (task 012-5, extending WI-28)
// =============================================================================================

/**
 * **This is the mechanism of AC-13.** A manifest row carrying a `deadlineMs` with no matching
 * documented derivation now fails the SAME gate that already catches an undocumented TTL, instead of
 * depending on a reviewer noticing. `capability-manifest.test.ts`'s TC-UNIT-08 is the other half and
 * a deliberately weaker one: it checks that a two-number record EXISTS beside each field, never that
 * the number is the one the architecture approved. That comparison is here.
 *
 * The table read is "`deadlineMs`/`paidLegMs` by capability" in
 * `docs/architectures/system-architecture.md`, anchored on its own bold heading — never scanned
 * across the document, for the reason the TTL gate above records: several other tables in this file
 * open with a backticked id in the first cell.
 *
 * **Reached** (one positive control below per row — a detector with no control can be added dead):
 *
 * | Form                                                                        |
 * | ----------------------------------------------------------------------------- |
 * | A documented `deadlineMs` differing from the manifest's                      |
 * | A `deadlineMs` cell stating no number at all (`TBD`) while the manifest has one |
 * | A `paidLegMs` documented for a capability whose manifest carries none         |
 * | A manifest `paidLegMs` the table records as `—`                               |
 * | A routed capability with no row in the table                                  |
 * | A row naming a capability nothing routes                                      |
 * | One row grouping capabilities whose manifest deadlines differ                 |
 * | The anchor going stale — the gate fails loudly rather than passing vacuously   |
 * | The `a/b/c` capability shorthand expanding to the wrong ids                    |
 *
 * **NOT reached — measured, not hypothesised** (each asserted in "the DECLARED LIMITS are real"):
 *
 * | Escape                                                                | Why |
 * | ----------------------------------------------------------------------- | --- |
 * | **The Derivation column's prose.** A row with the right number and an absent, wrong or self-contradicting derivation passes. **So this gate cannot tell an OVERRIDE from an ALIGNMENT** — it accepts whatever number the manifest holds once the cell is updated. That is why 012-5's own override (`privacy.shielded_pool` + four `platform.*`, ~30_000 → ~15_000) had to be marked as an override in the manifest FIRST (012-4) and carry its reason and revert condition in the document: this gate would have accepted the rewritten row silently either way. | Numbers are compared; prose is not read. Reading it would mean judging an argument, which no regex does. |
 * | Anything outside the anchored section — a contradicting copy of a row before or after it | The section is bounded by its heading and the next sibling bullet, deliberately (see the TTL gate's note on the four other tables in this file). |
 * | A row DUPLICATED inside the section with the same numbers               | Every row is checked against the manifest independently; two consistent rows are two passes. Nothing here counts how many times a capability is stated. |
 * | Every manifest field except `deadlineMs`/`paidLegMs` — `shape`, `ttlSeconds`, `shareable` | Out of scope by design: TTL has its own half of this gate above, `shape` has TC-UNIT-07 next door. |
 *
 * **A limit of the DIAGNOSTIC rather than of detection**, stated because the message misleads: a
 * correct number written **without the `~`** is read as "no number stated" and reported as
 * `documents no deadlineMs`. It fails closed — which is the important half — but it cannot tell a
 * formatting change from a deleted row.
 */

interface DeadlineRow {
  stated: string;
  covered: string[];
  deadlineMs: number | null;
  paidLegMs: number | null;
}

/**
 * `~15_000` → 15000; `**~270_000** (derived, OD-3 worked example above)` → 270000;
 * `— (free-only route)` and `TBD (R-149)` → null.
 *
 * **The `~` is required, not decoration.** Without it the `OD-3` in `entity.labels`' own cell reads
 * as the number 3. Requiring the tilde is what keeps a document reference out of the value column.
 */
function millis(cell: string): number | null {
  const digits = /~\s*(\d[\d_]*)/.exec(cell);
  return digits ? Number((digits[1] as string).replace(/_/g, '')) : null;
}

/**
 * `platform.identities/contracts/documents/credits` → the four ids it abbreviates;
 * `platform.*` → every routed id under the prefix; anything else → itself.
 *
 * The slash form is the document's, not this gate's invention, and it is the CAPABILITY LIST that
 * addresses the overridden row — never its line number, because the row directly beneath it is
 * visually identical and correct (`capability-manifest.ts`'s override banner).
 */
function expandCapabilityId(id: string, routed: string[]): string[] {
  if (id.endsWith('.*')) return routed.filter((c) => c.startsWith(id.slice(0, -1)));
  const [first, ...rest] = id.split('/');
  if (first === undefined) return [];
  const namespace = first.slice(0, first.lastIndexOf('.') + 1);
  return [first, ...rest.map((tail) => `${namespace}${tail}`)];
}

/** The rows of the anchored deadline table; `[]` when the anchor itself has gone stale. */
function deadlineRows(markdown: string, routed: string[]): DeadlineRow[] {
  const after = markdown.split(/^\s*\*\*`deadlineMs`\/`paidLegMs` by capability/m)[1];
  if (after === undefined) return [];
  return (after.split(/^- \*\*/m)[0] as string).split('\n').flatMap((line) => {
    // A first cell that OPENS with a backtick — the header (`| Capability |`) and the separator
    // row do not, so neither is mistaken for data.
    const cells = /^\s*\|\s*(`[^|]*`)\s*\|([^|]*)\|([^|]*)\|/.exec(line);
    if (!cells) return [];
    const ids = [...(cells[1] as string).matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
    return [
      {
        stated: ids.join(', '),
        covered: ids.flatMap((id) => expandCapabilityId(id, routed)),
        deadlineMs: millis(cells[2] as string),
        paidLegMs: millis(cells[3] as string),
      },
    ];
  });
}

const show = (value: number | null): string => (value === null ? '—' : String(value));

/** Every disagreement between the documented table and the manifest, NAMED by capability. */
function deadlineDefects(
  markdown: string,
  routed: string[],
  manifests: Readonly<Record<string, CapabilityManifest>>,
): string[] {
  const defects: string[] = [];
  const documented = new Set<string>();

  for (const row of deadlineRows(markdown, routed)) {
    const unrouted = row.covered.filter((capability) => !routed.includes(capability));
    if (unrouted.length > 0) {
      defects.push(`${row.stated}: names ${unrouted.join(', ')}, which nothing routes`);
      continue;
    }
    if (row.covered.length === 0) {
      defects.push(`${row.stated}: expands to no capability at all`);
      continue;
    }
    for (const capability of row.covered) documented.add(capability);

    const deadlines = [...new Set(row.covered.map((c) => manifests[c]?.deadlineMs ?? null))];
    const paidLegs = [...new Set(row.covered.map((c) => manifests[c]?.paidLegMs ?? null))];
    // Named per capability, not counted and not summarised as "the group disagrees": a row here
    // can cover nine capabilities, and a failure that does not say WHICH one moved is a failure the
    // reader has to re-derive by hand (the "name the offenders" rule this project already applies
    // to its alerting).
    const perCapability = (field: 'deadlineMs' | 'paidLegMs'): string =>
      row.covered.map((c) => `${c}=${show(manifests[c]?.[field] ?? null)}`).join(', ');
    if (deadlines.length > 1) {
      defects.push(
        `${row.stated}: one row, but the manifest gives them different deadlineMs ` +
          `(${perCapability('deadlineMs')})`,
      );
      continue;
    }
    if (paidLegs.length > 1) {
      defects.push(
        `${row.stated}: one row, but the manifest gives them different paidLegMs ` +
          `(${perCapability('paidLegMs')})`,
      );
      continue;
    }
    const expectedDeadline = deadlines[0] ?? null;
    const expectedPaidLeg = paidLegs[0] ?? null;
    if (row.deadlineMs !== expectedDeadline) {
      defects.push(
        `${row.stated}: table says deadlineMs ${show(row.deadlineMs)}, ` +
          `the manifest applies ${show(expectedDeadline)}`,
      );
    }
    if (row.paidLegMs !== expectedPaidLeg) {
      defects.push(
        `${row.stated}: table says paidLegMs ${show(row.paidLegMs)}, ` +
          `the manifest applies ${show(expectedPaidLeg)}`,
      );
    }
  }

  for (const capability of routed) {
    if (!documented.has(capability)) {
      defects.push(`${capability}: the manifest gives it a deadlineMs the table never documents`);
    }
  }
  return defects;
}

describe('the architecture deadline table states the numbers the manifest applies (WI-28, AC-13)', () => {
  const ARCHITECTURE = 'docs/architectures/system-architecture.md';
  const routed = [...new Set(routes.map((route) => route.capability))];

  it('documents every routed capability, at the deadline the manifest applies', () => {
    const markdown = read(ARCHITECTURE);
    // Sign of work FIRST — and exactly what it buys, no more. A row the regex stops matching would
    // already fail the completeness check below (its capabilities go undocumented), so this is not
    // what keeps the gate from passing vacuously. What the exact count buys is the OTHER direction:
    // an eighth row, or a non-data line the parser starts treating as one, becomes visible here
    // instead of being quietly checked or quietly ignored.
    expect(deadlineRows(markdown, routed).length).toBe(7); // the exact row count, not a floor
    expect(routed).toHaveLength(23);

    expect(
      deadlineDefects(markdown, routed, capabilityManifests),
      `${ARCHITECTURE}'s "\`deadlineMs\`/\`paidLegMs\` by capability" table disagrees with ` +
        '`capability-manifest.ts`. AC-13: a deadline number is allowed to exist only where its ' +
        'derivation is written down — this is the test that makes that a failure, not a review note.',
    ).toStrictEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // Controls. Everything below runs the gate against a SYNTHETIC document and a synthetic
  // manifest, so a control says something about the detector rather than about today's numbers.
  // -------------------------------------------------------------------------------------------

  const CONTROL_ROUTED = ['token.price', 'entity.labels'];
  const CONTROL_MANIFESTS: Readonly<Record<string, CapabilityManifest>> = {
    'token.price': { shape: 'point', ttlSeconds: 60, deadlineMs: 15_000 },
    'entity.labels': { shape: 'set', ttlSeconds: 3600, deadlineMs: 60_000, paidLegMs: 270_000 },
  };
  const FREE_ROW = '  | `token.price` | ~15_000 | — (free-only route) | one free adapter |';
  const PAID_ROW = '  | `entity.labels` | ~60_000 | **~270_000** (derived) | paid composite |';

  /** The anchor, a header, the given rows, and one row PAST the section boundary. */
  function synthetic(...rows: string[]): string {
    return [
      '  **`deadlineMs`/`paidLegMs` by capability (synthetic)** — prose the gate does not read.',
      '',
      '  | Capability | `deadlineMs` | `paidLegMs` | Derivation |',
      '  | ---------- | ------------ | ----------- | ---------- |',
      ...rows,
      '',
      '- **the next sibling bullet ends the section**',
      '  | `token.price` | ~1 | ~2 | beyond the boundary; never read |',
    ].join('\n');
  }

  const defectsOf = (...rows: string[]): string[] =>
    deadlineDefects(synthetic(...rows), CONTROL_ROUTED, CONTROL_MANIFESTS);

  it('is not simply always red: the correct pair of rows passes', () => {
    expect(deadlineRows(synthetic(FREE_ROW, PAID_ROW), CONTROL_ROUTED)).toHaveLength(2);
    expect(defectsOf(FREE_ROW, PAID_ROW)).toStrictEqual([]);
  });

  it('the gate DETECTS each reached form', () => {
    expect(
      defectsOf('  | `token.price` | ~30_000 | — | a number nobody applied |', PAID_ROW),
      'a documented deadline differing from the manifest',
    ).toStrictEqual(['token.price: table says deadlineMs 30000, the manifest applies 15000']);

    expect(
      defectsOf('  | `token.price` | TBD (R-149) | — | no number at all |', PAID_ROW),
      'a cell stating no number while the manifest has one',
    ).toStrictEqual(['token.price: table says deadlineMs —, the manifest applies 15000']);

    expect(
      defectsOf(
        '  | `token.price` | ~15_000 | ~9_000 | a paid leg that does not exist |',
        PAID_ROW,
      ),
      'a paidLegMs documented for a free capability',
    ).toStrictEqual(['token.price: table says paidLegMs 9000, the manifest applies —']);

    expect(
      defectsOf(FREE_ROW, '  | `entity.labels` | ~60_000 | — | the paid leg dropped |'),
      'a manifest paidLegMs the table records as absent',
    ).toStrictEqual(['entity.labels: table says paidLegMs —, the manifest applies 270000']);

    expect(defectsOf(PAID_ROW), 'a routed capability with no row').toStrictEqual([
      'token.price: the manifest gives it a deadlineMs the table never documents',
    ]);

    expect(
      defectsOf(FREE_ROW, PAID_ROW, '  | `token.retired` | ~15_000 | — | routed nowhere |'),
      'a row naming a capability nothing routes',
    ).toStrictEqual(['token.retired: names token.retired, which nothing routes']);

    expect(
      defectsOf('  | `token.price`, `entity.labels` | ~15_000 | — | one row, two tiers |'),
      'one row grouping capabilities whose manifest deadlines differ — and the message names ' +
        'which of them holds which number',
    ).toStrictEqual([
      'token.price, entity.labels: one row, but the manifest gives them different deadlineMs ' +
        '(token.price=15000, entity.labels=60000)',
    ]);

    // The anchor going stale is the failure this whole file exists to avoid passing quietly.
    const noAnchor = synthetic(FREE_ROW, PAID_ROW).replace('`deadlineMs`/`paidLegMs`', '`removed`');
    expect(deadlineRows(noAnchor, CONTROL_ROUTED)).toStrictEqual([]);
    expect(
      deadlineDefects(noAnchor, CONTROL_ROUTED, CONTROL_MANIFESTS),
      'a stale anchor must fail loudly, never pass over an empty list',
    ).toHaveLength(2);

    // The `a/b` shorthand: an expansion that produced the wrong ids would report them as unrouted.
    expect(expandCapabilityId('platform.identities/contracts/documents/credits', [])).toStrictEqual(
      ['platform.identities', 'platform.contracts', 'platform.documents', 'platform.credits'],
    );
  });

  it('the DECLARED LIMITS are real: these forms are NOT reached, and that is written down', () => {
    // Executable form of the "NOT reached" table above. Asserting the limits keeps that table from
    // drifting away from the code and turns any future widening into a visible edit HERE.
    expect(
      defectsOf('  | `token.price` | ~15_000 | — |  |', PAID_ROW),
      'LIMIT: the Derivation column is not read — an empty, wrong or self-contradicting ' +
        'derivation passes, so this gate cannot tell an OVERRIDE from an ALIGNMENT',
    ).toStrictEqual([]);

    expect(
      defectsOf(
        FREE_ROW,
        PAID_ROW,
        // Same capability, same numbers, stated twice — nothing counts occurrences.
        FREE_ROW,
      ),
      'LIMIT: a row duplicated inside the section is two independent passes',
    ).toStrictEqual([]);

    const contradictedOutside = [
      '  | `token.price` | ~99_000 | ~99_000 | a copy BEFORE the anchor |',
      synthetic(FREE_ROW, PAID_ROW),
    ].join('\n');
    expect(
      deadlineDefects(contradictedOutside, CONTROL_ROUTED, CONTROL_MANIFESTS),
      'LIMIT: anything outside the anchored section is invisible, in both directions',
    ).toStrictEqual([]);

    const otherShape: Readonly<Record<string, CapabilityManifest>> = {
      'token.price': { shape: 'series', ttlSeconds: 999, deadlineMs: 15_000 },
      'entity.labels': { shape: 'point', ttlSeconds: 1, deadlineMs: 60_000, paidLegMs: 270_000 },
    };
    expect(
      deadlineDefects(synthetic(FREE_ROW, PAID_ROW), CONTROL_ROUTED, otherShape),
      'LIMIT: only `deadlineMs`/`paidLegMs` are compared — `shape` and `ttlSeconds` are other ' +
        "gates' jobs (the TTL half above, TC-UNIT-07 next door)",
    ).toStrictEqual([]);

    expect(
      defectsOf('  | `token.price` | 15_000 | — | the tilde dropped |', PAID_ROW),
      'LIMIT of the DIAGNOSTIC: a correct number written without `~` fails CLOSED, but is ' +
        'reported as if the row stated nothing',
    ).toStrictEqual(['token.price: table says deadlineMs —, the manifest applies 15000']);
  });
});
