import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATE_COMMAND } from '../scripts/gen-tool-inventory.js';
import { REGENERATE_COMMAND } from '../scripts/snapshot-tools.js';

/**
 * What must be edited when a tool is added or removed — declared once, read by every gate that
 * tells a developer about it (TASK-011, adversarial cycle 4).
 *
 * **Why this file exists.** The repair checklist was itself a restated inventory, which is the
 * defect TASK-011 removes, and it drifted exactly as the task predicts. At the end of cycle 3 the
 * same fact was stated in three places and all three disagreed: `e2e.stdio.test.ts` said FIVE
 * channels, `eval-checks-coverage.test.ts` said the checklist "names four places",
 * `eval-capability-coverage.test.ts` said "three sibling inventories" — and sent the reader to two
 * targets (`e2e.stdio.test.ts`, `smoke-dist.mjs -> expectedNames`) that are now derived and need no
 * edit at all, while omitting the snapshot, the freshness test and the documentation gate.
 *
 * **The list below was MEASURED, not recalled.** A fourteenth spec was added to `tool-specs.ts` and
 * the suite run; these are the assertions that actually failed, plus the two that fail only under
 * conditions the probe did not meet (a capability-bearing tool, and a full build). Enumerating from
 * memory is what produced three disagreeing lists.
 */

export interface InventoryChannel {
  /** The gate that fails, as a repo-relative path — asserted to exist by `inventory-channels.test.ts`. */
  readonly gate: string;
  /** What the developer must do. Regeneration commands come from the scripts' own constants. */
  readonly action: string;
  /** `true` when a human must decide something rather than run a command. */
  readonly needsJudgement?: boolean;
  /** Set when the gate does not fail on a plain `pnpm test` of an added tool. */
  readonly firesOnlyWhen?: string;
}

export const INVENTORY_CHANNELS: readonly InventoryChannel[] = [
  {
    gate: 'packages/mcp-server/test/tools-list-contract.test.ts',
    action: `the frozen tools/list snapshot, byte for byte. Run \`${REGENERATE_COMMAND}\` and READ the diff — this is the one expectation not derived from the registry, and the hand-written lower bound in that file is the only thing a silent deletion cannot regenerate away`,
    needsJudgement: true,
  },
  {
    gate: 'packages/mcp-server/test/tool-inventory-in-sync.test.ts',
    action: `the generated artifact. Run \`${GENERATE_COMMAND}\` and commit the result`,
  },
  {
    gate: 'packages/mcp-server/test/tool-inventory-docs.test.ts',
    action:
      "the seven GATED_DOCUMENTS must each NAME the tool — both READMEs, ARCHITECTURE.md, interfaces.md, functional-architecture.md, ROADMAP.md and this package's .AGENTS.md. Seven separate failures, one per document",
    needsJudgement: true,
  },
  {
    gate: 'packages/mcp-server/test/docs-counts.test.ts',
    action:
      'interfaces.md §5 must name the tool AND carry a `// Capability:` anchor within 25 lines of that name; every present-tense tool COUNT in the docs must be updated',
    needsJudgement: true,
  },
  {
    gate: 'packages/mcp-server/test/eval-checks-coverage.test.ts',
    action:
      'if the live eval invokes the tool, `eval/checks.mjs` needs an entry — without one a wrong answer grades `degraded`, and an entry left behind by a removed tool is reached by nothing at all',
    needsJudgement: true,
  },
  {
    gate: 'packages/mcp-server/test/tool-spec.test.ts',
    action:
      'a tool serving no capability must say `capability: null` explicitly, and is named in that test — "serves no capability" is a statement, not an omission',
  },
  {
    gate: 'packages/mcp-server/test/eval-capability-coverage.test.ts',
    action:
      'wire the capability into `eval/capabilities.mjs` — CAPABILITY_TOOLS, or CAPABILITY_EXCLUSIONS with the reason. Hand-maintained on purpose: only the tool NAME is derived from the artifact',
    needsJudgement: true,
    firesOnlyWhen: 'the tool serves a capability',
  },
  {
    gate: 'packages/mcp-server/scripts/smoke-dist.mjs',
    action: 'reads tool-inventory.json; regenerating it (channel 2) is the whole fix',
    // No root `smoke:dist` script exists; the bare form answers `Command "smoke:dist" not found`
    // (corrected in T-012, PLAN §0.5).
    firesOnlyWhen:
      'run after a build — `pnpm --filter @onchain-intel/mcp-server smoke:dist`, not `pnpm test`',
  },
];

/** The message every gate prints. One text, so the three that used to disagree cannot again. */
export const ADD_A_TOOL: string = [
  `A tool was added or removed. ${INVENTORY_CHANNELS.length} independent channels must agree.`,
  'This list is declared once in test/inventory-channels.ts and was measured by adding a real',
  'fourteenth spec and recording what failed — not written from memory, which is how its three',
  'predecessors came to disagree.',
  '',
  ...INVENTORY_CHANNELS.map((channel, index) => {
    const marks = [
      channel.needsJudgement ? 'NEEDS A DECISION' : undefined,
      channel.firesOnlyWhen ? `fires only when ${channel.firesOnlyWhen}` : undefined,
    ].filter(Boolean);
    const suffix = marks.length > 0 ? ` [${marks.join('; ')}]` : '';
    return `  ${index + 1}. ${channel.gate}${suffix}\n     ${channel.action}`;
  }),
].join('\n');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Channels naming a file that does not exist — the checklist's own freshness check. */
export function missingChannelGates(): string[] {
  return INVENTORY_CHANNELS.map((channel) => channel.gate).filter(
    (gate) => !existsSync(path.join(repoRoot, gate)),
  );
}
