import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  captureToolsList,
  REGENERATE_COMMAND,
  serializeToolsList,
  SNAPSHOT_PATH,
  type ToolsListEntry,
} from '../scripts/snapshot-tools.js';

/**
 * The frozen `tools/list` contract (TASK-011, R-125 / R-129).
 *
 * **What this file is for.** T-011 makes the tool inventory data: guards stop restating the list of
 * names and start deriving it from one registry. That is the point — and it has a cost that has to
 * be paid somewhere. Every derived guard agrees with the registry by construction, so if a registry
 * entry is ever *lost* (a bad merge, a dropped line), all of them agree on the smaller list and the
 * suite stays green. The documentation gate is blind to it too: it iterates registered tools, so a
 * tool that vanished is never iterated.
 *
 * The committed fixture is the answer. It is the one expectation that does **not** come from
 * `toolSpecs`, which is precisely why it is the one that reddens when a tool disappears.
 * `snapshot-tools.ts` regenerates it; nothing regenerates it automatically.
 *
 * **Two gates, on purpose, and they age differently.**
 *
 * - The **narrow** one compares identity: names in order, titles, and a hash of each description.
 *   It ignores the JSON Schema bytes, so a bump of the SDK or zod — which changes how schemas are
 *   rendered without changing what any tool *is* — leaves it green.
 * - The **byte-exact** one compares the whole file. It is the proof that the T-011 refactor moved
 *   the inventory behind a registry without touching the published contract. It will legitimately
 *   redden on an SDK/zod bump, and the cure is to regenerate.
 *
 * Splitting them matters more than it looks. A single byte-exact gate would redden routinely (on
 * every dependency bump) and be healed by one command — and a habit of "red → regenerate → green"
 * eventually blesses a disappearance with the same keystroke. The narrow gate is the one that must
 * never be regenerated casually, and it is cheap enough to stay honest.
 */

const snapshotText = readFileSync(SNAPSHOT_PATH, 'utf8');
const snapshot = JSON.parse(snapshotText) as ToolsListEntry[];

/** Stable, short fingerprint of a description — enough to catch an edit, cheap to read in a diff. */
const digest = (value: unknown): string =>
  createHash('sha256').update(String(value)).digest('hex').slice(0, 12);

/** The identity of one tool, ignoring how its schemas happen to be rendered today. */
function identity(tool: ToolsListEntry): Record<string, string> {
  return {
    name: tool.name,
    title: typeof tool['title'] === 'string' ? tool['title'] : '(none)',
    description: digest(tool['description']),
  };
}

const HOW_TO_FIX =
  `If this change is intended, review the diff FIRST and only then run \`${REGENERATE_COMMAND}\`, ` +
  'in a commit that says why. Regenerating before reading the diff destroys the only evidence ' +
  'that the published contract did not move.';

describe('tools/list contract is frozen against a committed snapshot (R-125)', () => {
  it('publishes the same tools, in the same order, with the same titles and descriptions', async () => {
    const live = await captureToolsList();
    expect(live.map(identity), `Tool identity changed. ${HOW_TO_FIX}`).toStrictEqual(
      snapshot.map(identity),
    );
  });

  it('publishes byte-identical `tools/list` output, schemas included', async () => {
    const live = await captureToolsList();
    // Compared as one string rather than field by field: the question this gate answers is "did the
    // bytes a client receives change", and any structural comparison would answer a smaller one.
    expect(
      serializeToolsList(live),
      `The published tools/list bytes changed (schemas included). ${HOW_TO_FIX}`,
    ).toBe(snapshotText);
  });

  it('never publishes fewer than the 13 tools this project has shipped', async () => {
    // The hand-written number, and the only guard here that NO command can regenerate. Lowering it
    // is a deliberate edit in a commit that explains which tool was retired and why — which is
    // exactly the friction a disappearing tool should meet. Raising it is free and expected.
    const live = await captureToolsList();
    expect(
      live.length,
      'Fewer tools are registered than this project has shipped. If a tool was retired on ' +
        'purpose, lower this bound in the same commit and say which one and why; otherwise a ' +
        'registry entry has been lost.',
    ).toBeGreaterThanOrEqual(13);
  });
});
