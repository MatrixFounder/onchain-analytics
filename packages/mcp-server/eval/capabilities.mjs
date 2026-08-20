// The CAPABILITY axis of the live eval, and the rule that keeps it honest (RF-5).
//
// The CHAIN axis is derived from the live registry, so a chain added later is exercised
// automatically. The capability axis used to be a literal array in THIS file, and that shape has a
// recorded failure: `dex.volume.history` shipped, the array did not grow, and the newest provider
// surface had no live coverage while the report showed nothing at all — not a failure, not a
// `no-probe` row, no trace. A green run read as "the free contour is verified".
//
// The axis is now DERIVED from `cases/`, one file per case (see `cases/index.mjs`). Adding coverage
// is adding a file; there is no list here to forget to edit. What this module still owns is the
// part that is genuinely knowledge and not data: which capabilities are deliberately NOT exercised
// (`CAPABILITY_EXCLUSIONS`), which are known holes (`CAPABILITY_KNOWN_GAPS`), and the comparison of
// the two axes at run time (`unwiredCapabilities`) plus offline in
// `eval-capability-coverage.test.ts` — the offline half matters more, because this eval is
// deliberately not part of CI and a capability can ship between two runs of it.
//
// This module is data + pure functions on purpose: importing it must never start a server, so the
// test suite can read it without touching the network.

import { readFileSync } from 'node:fs';
import { CAPABILITY_CASES } from './cases/index.mjs';

/**
 * Tool names come from the generated inventory, never from a case file (TASK-011, R-117).
 *
 * The artifact is read rather than imported because this module is plain ESM by design and must
 * not acquire a build step — and because reading a file cannot start a server, which is this
 * file's other standing contract. `capability -> tool` is the whole mapping the eval needs; the
 * `args` builders live in the case files, since how to construct a probe call is knowledge that
 * lives nowhere in the registry and should not.
 */
const INVENTORY = JSON.parse(
  readFileSync(new URL('../tool-inventory.json', import.meta.url), 'utf8'),
);

/**
 * The tool serving a capability, or a loud failure.
 *
 * Throwing at import time is deliberate: `test/eval-capability-coverage.test.ts` imports this
 * module offline, so a capability named by a case file that no tool serves — an orphan left behind
 * by a removed or renamed tool — fails `pnpm test` rather than surfacing during a live run that
 * nobody is watching (R-126).
 */
export function toolFor(capability) {
  // Both identity fields (T-013 task 013-8): a tool serving SEVERAL capabilities carries
  // `capability: null` and names them in `servedCapabilities`. Reading only the first field would
  // throw the "no MCP tool serves this" error below for a capability a tool demonstrably serves.
  const entry = INVENTORY.tools.find(
    (tool) =>
      tool.capability === capability || (tool.servedCapabilities ?? []).includes(capability),
  );
  if (!entry) {
    throw new Error(
      `eval/capabilities.mjs: no MCP tool serves '${capability}'. Either a case file names it by ` +
        'mistake, or the tool was renamed/removed and the case is an orphan. ' +
        'The inventory is generated from src/tools/tool-specs.ts.',
    );
  }
  return entry.name;
}

/**
 * capability → the tool that serves it, and how to build its arguments from a probe row.
 * `args` returning null means "no probe input curated for this chain" → reported as `no-probe`.
 *
 * Derived from `cases/`, never written here. The shape is unchanged from when it was a literal, so
 * `run.mjs` consumes it exactly as before.
 */
export const CAPABILITY_TOOLS = CAPABILITY_CASES.map((c) => ({
  capability: c.capability,
  tool: toolFor(c.capability),
  args: c.args,
}));

/**
 * Capabilities deliberately NOT exercised, each with the reason it is out of scope.
 *
 * **Two of these five are an INTERVAL, not a policy** (task 014-32b). `pool.info` and `token.pools`
 * have a registered `ToolSpec` and a stub handler that answers a typed refusal; there is no logic to
 * exercise yet, so an eval case would assert the refusal and nothing else. Each names the task that
 * removes both the stub and this line, in the same commit that adds its case file. The masked case
 * is stated rather than left implicit (memory M6): an entry here makes the capability `accounted`
 * WITHOUT a case, so it masks "a tool is registered and nothing checks it" — which is why
 * `docs/tasks/task-014-34-acceptance.md` verifies both entries are gone at stage acceptance.
 */
export const CAPABILITY_EXCLUSIONS = new Map([
  ['entity.labels', 'paid — spends Nansen credits, and an eval that bills you gets turned off'],
  ['smart-money.flows', 'paid — spends Nansen credits'],
  ['token.risk', 'paid — spends Nansen credits'],
  ['pool.info', 'stub registered by task 014-32b; its logic and eval case ship in task 014-32c'],
  ['token.pools', 'stub registered by task 014-32b; its logic and eval case ship in task 014-32d'],
]);

/** Known gaps between what the registry declares and what any MCP tool serves. These are NOT
 * exclusions — they are real holes, kept named rather than hidden so the count stays honest and a
 * NEW hole (the RF-5 case) is distinguishable from these at a glance.
 *
 * The `pool.info` row left this map in the commit that registered `onchain_pool_info` (task
 * 014-32b) — `interfaces.md:829` states that rule, and its reason (`served by no MCP tool at all`)
 * is falsified by a registered tool. It was DELETED rather than reworded: `unwiredCapabilities`
 * short-circuits on an exclusion before it ever looks for a reason here, so a rewritten reason would
 * be text no run ever prints. */
export const CAPABILITY_KNOWN_GAPS = new Map([
  [
    'token.metadata',
    'no tool calls it: onchain_get_token routes through token.price on purpose (a token.metadata ' +
      'cache entry would legally serve an hour-stale price), so the coingecko path is covered and ' +
      'this capability id is not',
  ],
]);

/** Every capability with an eval case or a recorded reason not to have one. */
export function accountedCapabilities() {
  return new Set([
    ...CAPABILITY_TOOLS.map((c) => c.capability),
    ...CAPABILITY_EXCLUSIONS.keys(),
    ...CAPABILITY_KNOWN_GAPS.keys(),
  ]);
}

/**
 * The two axes, compared: every capability the SELECTED chains declare, minus the ones the case
 * files exercise, minus the ones excluded on the record. What is left is a capability nothing asked
 * a provider about — reported once per capability (not once per chain, which would bury it under a
 * dozen identical rows) together with the chains that declare it.
 *
 * `no-probe`, not `error`: a missing eval case is our gap, not a provider defect, and the verdict
 * that means "untested" already exists. It stays out of the failure count for the same reason the
 * other `no-probe` rows do — but a new capability can no longer be invisible, which is the property
 * that failed when `dex.volume.history` shipped.
 *
 * @param selected chain slugs being evaluated
 * @param declaredFor (chain) => capability list, as the live registry reports it
 * @returns rows shaped `[chain, capability, tool, outcome]` for the caller's `record()`
 */
export function unwiredCapabilities(selected, declaredFor) {
  const wired = new Set(CAPABILITY_TOOLS.map((c) => c.capability));
  const byCapability = new Map();
  for (const chain of selected) {
    for (const capability of declaredFor(chain) ?? []) {
      if (wired.has(capability) || CAPABILITY_EXCLUSIONS.has(capability)) continue;
      byCapability.set(capability, [...(byCapability.get(capability) ?? []), chain]);
    }
  }
  return [...byCapability]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([capability, chains]) => {
      const known = CAPABILITY_KNOWN_GAPS.get(capability);
      return [
        '—',
        capability,
        '—',
        {
          verdict: 'no-probe',
          ms: 0,
          problems: [
            known
              ? `no eval case wired — ${known} (declared by ${chains.length}: ${chains.join(', ')})`
              : `NO EVAL CASE WIRED and no recorded reason — declared by ${chains.length} chain(s) ` +
                `(${chains.join(', ')}) and never called. Add a file to eval/cases/, or an entry ` +
                `to CAPABILITY_EXCLUSIONS with the reason.`,
          ],
        },
      ];
    });
}
