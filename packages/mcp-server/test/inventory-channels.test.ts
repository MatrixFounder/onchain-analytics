import { describe, expect, it } from 'vitest';
import { ADD_A_TOOL, INVENTORY_CHANNELS, missingChannelGates } from './inventory-channels.js';

/**
 * The repair checklist is itself an inventory, so it gets a gate like every other one
 * (TASK-011, adversarial cycle 4).
 *
 * Three separate failure messages used to state this list, and by the end of cycle 3 all three
 * disagreed — one said five channels, one said four, one said three, and the shortest of them sent
 * the reader to two files that no longer need editing. Nothing failed, because the thing that had
 * drifted was prose in a string. That is precisely the defect TASK-011 exists to remove, surviving
 * inside the message that tells developers how to avoid it.
 */
describe('the add-a-tool checklist is itself checked (adversarial cycle 4)', () => {
  it('names only gates that exist', () => {
    expect(
      missingChannelGates(),
      'A channel names a gate file that is not in the repository. Either the gate was renamed and ' +
        'this list did not follow — the exact drift this file was created to stop — or the channel ' +
        'is gone and its entry should be removed.',
    ).toStrictEqual([]);
  });

  it('renders one line per channel, so the count in the text cannot disagree with the list', () => {
    // The old message hardcoded "FIVE" while enumerating a different number of items. Here the
    // count is interpolated from the array, so the two cannot separate.
    expect(ADD_A_TOOL).toContain(`${INVENTORY_CHANNELS.length} independent channels`);
    for (const channel of INVENTORY_CHANNELS) {
      expect(ADD_A_TOOL).toContain(channel.gate);
    }
  });

  it('carries the regeneration commands in the form that runs from the repo root', () => {
    // Cycle 3 restated `pnpm snapshot:tools` and `pnpm gen:tools` by hand. Both are PACKAGE scripts:
    // the root package.json has neither, and CI runs from the root, so the printed command failed
    // with ERR_PNPM_NO_SCRIPT for the reader standing where the failure was printed. The scripts
    // already export the correct `--filter` form precisely so it is never restated.
    expect(ADD_A_TOOL).toContain('pnpm --filter @onchain-intel/mcp-server snapshot:tools');
    expect(ADD_A_TOOL).toContain('pnpm --filter @onchain-intel/mcp-server gen:tools');
  });

  it('is not vacuous', () => {
    expect(INVENTORY_CHANNELS.length).toBeGreaterThanOrEqual(8);
  });
});
