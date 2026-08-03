import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createNansenAdapter, routes, ttlFor } from '@onchain-intel/core';
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

const READMES = ['README.md', 'README.ru.md'] as const;

describe('the README tool table states the TTL the code applies (WI-28)', () => {
  it.each(READMES)('%s', (relative) => {
    const rows = toolRows(relative);
    // Not vacuous: if the table is reformatted the regex stops matching, and every check below
    // would pass over an empty list.
    expect(rows.length).toBe(toolSpecs.length);

    const wrong = rows.flatMap((row) => {
      const capability = CAPABILITY_OF.get(row.tool);
      if (capability === undefined) return []; // an unknown tool is tool-inventory-docs.test.ts's job
      const expected = capability === null ? null : ttlFor(capability);
      return row.ttl === expected
        ? []
        : [`${row.tool}: table says ${row.ttl ?? '—'}, cache/ttl.ts says ${expected ?? '—'}`];
    });
    expect(
      wrong,
      `${relative}'s Tool reference TTL column disagrees with packages/core/src/cache/ttl.ts.`,
    ).toStrictEqual([]);
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
    expect(rows.length).toBe(15); // the exact row count of §3.2's table, not a floor
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
