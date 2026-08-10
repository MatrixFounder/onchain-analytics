import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildToolInventory,
  GENERATE_COMMAND,
  generateToolInventory,
  INVENTORY_PATH,
} from '../scripts/gen-tool-inventory.js';
import { toolSpecs } from '../src/tools/tool-specs.js';

/**
 * The committed artifact must still be what the generator produces (TASK-011, R-114).
 *
 * **Why this test is not optional.** `tool-inventory.json` exists so that readers which cannot
 * import TypeScript — the dependency-free `smoke-dist` script, the plain-ESM eval modules — can
 * still derive the inventory from one place instead of restating it. That solves one duplication
 * and creates a new risk: a committed generated file is a copy, and a copy can go stale. Without
 * this test the artifact would merely LOOK generated, and a hand-edit would leave every other test
 * green while the readers that trust it drifted.
 *
 * The shape is the one `packages/core` already uses for exactly this problem
 * (`blockscout-chains-in-sync.test.ts`): regenerate into a temp directory and compare byte for
 * byte. It is deliberately NOT modelled on `registry.data.json`, whose generator calls three live
 * vendor catalogues and carries hand-curated columns forward — that file has no freshness gate at
 * all, and could not have one, because regenerating it is neither offline nor deterministic. This
 * generator reads only code in this repository, so determinism is free.
 *
 * **The failure must be loud in `pnpm test`, not at build time.** A stale artifact caught only
 * after `build` is the RF-4 class of defect: `smoke-dist`'s tool count was wrong on `main` for
 * **two** tasks — three tools across TASK-006 and TASK-007 — because nothing local ran it. The
 * number is the ledger's (`docs/issues/rf-4-*.md`), not a recollection: an earlier draft of this
 * comment said "three tasks" and disagreed with the card it cites, which is how a number acquires
 * two sources.
 */

const HOW_TO_FIX = `Run \`${GENERATE_COMMAND}\` and commit the result.`;

describe('tool-inventory.json is in sync with the registry (R-114)', () => {
  let temporaryDirectory: string | undefined;

  afterEach(() => {
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
  });

  it('regenerating from the registry reproduces the committed file byte for byte', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tool-inventory-sync-'));
    temporaryDirectory = directory;
    const regeneratedPath = path.join(directory, 'tool-inventory.json');

    generateToolInventory(regeneratedPath);

    expect(
      readFileSync(regeneratedPath, 'utf8'),
      `The committed artifact is stale. ${HOW_TO_FIX}`,
    ).toBe(readFileSync(INVENTORY_PATH, 'utf8'));
  });

  it('carries every tool the registry declares, in the same order', () => {
    // A byte comparison alone would pass if BOTH the artifact and the generator were wrong in the
    // same way — which is exactly what happens when someone "fixes" a failure by regenerating
    // without reading the diff. This asserts the generator's output against the registry itself.
    const committed = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8')) as {
      tools: { name: string; title: string; capability: string | null }[];
    };
    expect(committed.tools.map((tool) => tool.name)).toStrictEqual(
      toolSpecs.map((spec) => spec.name),
    );
    expect(committed.tools.map((tool) => tool.capability)).toStrictEqual(
      toolSpecs.map((spec) => spec.capability),
    );
    expect(committed.tools.map((tool) => tool.title)).toStrictEqual(
      toolSpecs.map((spec) => spec.title),
    );
  });

  it('publishes identity only — no schemas, and no second copy of the descriptions', () => {
    // The snapshot already freezes descriptions and schemas. A second copy here would be the same
    // duplication this task removes, one file over.
    const committed = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8')) as {
      tools: Record<string, unknown>[];
    };
    for (const tool of committed.tools) {
      const keys = Object.keys(tool).sort();
      // Three keys are mandatory on EVERY entry. `servedCapabilities` is the one permitted fourth,
      // and only on a tool that serves several capabilities — never as a general escape hatch
      // (T-013 task 013-8).
      //
      // **Why it belongs in the artifact at all, given "identity only".** `servedCapabilities` IS
      // identity, exactly as `capability` is — it carries no schema and no description, which is
      // what this assertion exists to keep out. And it has to be here specifically because
      // `eval/capabilities.mjs` is `.mjs` and reads nothing but this file: a field that stopped at
      // `ToolSpec` would leave that reader mapping the tool to no capability at all, silently.
      const permitted =
        tool['capability'] === null && Array.isArray(tool['servedCapabilities'])
          ? ['capability', 'name', 'servedCapabilities', 'title']
          : ['capability', 'name', 'title'];
      expect(keys, `${String(tool['name'])} has unexpected keys`).toStrictEqual(permitted);
    }
  });

  it('refuses to write an empty inventory rather than producing a green, empty artifact', () => {
    // If the registry import ever broke, an obliging generator would write `tools: []`, and every
    // downstream reader would then agree that this server publishes nothing. The refusal is
    // exercised for real — the inventory is injectable precisely so this test can reach it.
    const directory = mkdtempSync(path.join(tmpdir(), 'tool-inventory-empty-'));
    temporaryDirectory = directory;
    const target = path.join(directory, 'tool-inventory.json');

    expect(() => generateToolInventory(target, { ...buildToolInventory(), tools: [] })).toThrow(
      /registry is empty/,
    );
    // And nothing was written: the refusal happens before the file is touched.
    expect(existsSync(target)).toBe(false);
  });
});
