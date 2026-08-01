// The CAPABILITY axis of the live eval, and the rule that keeps it honest (RF-5).
//
// The CHAIN axis is derived from the live registry, so a chain added later is exercised
// automatically. The capability axis cannot be derived: a capability needs a tool name and an
// argument shape that only a human knows. What CAN be automatic — and what did not exist — is
// noticing that the two axes disagree. `dex.volume.history` shipped, this list did not grow, and
// the newest provider surface had no live coverage while the report showed nothing at all: not a
// failure, not a `no-probe` row, no trace. A green run read as "the free contour is verified".
//
// So every capability the registry declares must appear in exactly one of three places here:
// exercised (`CAPABILITY_TOOLS`), excluded on the record (`CAPABILITY_EXCLUSIONS`), or named as a
// known hole (`CAPABILITY_KNOWN_GAPS`). Anything else is reported by `unwiredCapabilities()` at run
// time and fails `eval-capability-coverage.test.ts` offline — the offline half matters more,
// because this eval is deliberately not part of CI and a capability can ship between two runs of it.
//
// This module is data + pure functions on purpose: importing it must never start a server, so the
// test suite can read it without touching the network.

import { readFileSync } from 'node:fs';

/**
 * Tool names come from the generated inventory, never from this file (TASK-011, R-117).
 *
 * The artifact is read rather than imported because this module is plain ESM by design and must
 * not acquire a build step — and because reading a file cannot start a server, which is this
 * file's other standing contract. `capability -> tool` is the whole mapping the eval needs; the
 * `args` builders below stay hand-written, since how to construct a probe call is knowledge that
 * lives nowhere in the registry and should not.
 */
const INVENTORY = JSON.parse(
  readFileSync(new URL('../tool-inventory.json', import.meta.url), 'utf8'),
);

/**
 * The tool serving a capability, or a loud failure.
 *
 * Throwing at import time is deliberate: `test/eval-capability-coverage.test.ts` imports this
 * module offline, so a capability listed here that no tool serves — an orphan left behind by a
 * removed or renamed tool — fails `pnpm test` rather than surfacing during a live run that nobody
 * is watching (R-126).
 */
function toolFor(capability) {
  const entry = INVENTORY.tools.find((tool) => tool.capability === capability);
  if (!entry) {
    throw new Error(
      `eval/capabilities.mjs: no MCP tool serves '${capability}'. Either the capability is wired ` +
        'here by mistake, or the tool was renamed/removed and this entry is an orphan. ' +
        'The inventory is generated from src/tools/tool-specs.ts.',
    );
  }
  return entry.name;
}

/** capability → the tool that serves it, and how to build its arguments from a probe row.
 * `args` returning null means "no probe input curated for this chain" → reported as `no-probe`. */
export const CAPABILITY_TOOLS = [
  { capability: 'chain.tvl', tool: toolFor('chain.tvl'), args: (c) => ({ chain: c }) },
  {
    capability: 'protocol.tvl',
    tool: toolFor('protocol.tvl'),
    args: (c, p) => (p.protocolSlug ? { chain: c, protocolSlug: p.protocolSlug } : null),
  },
  { capability: 'pairs.new', tool: toolFor('pairs.new'), args: (c) => ({ chain: c, limit: 5 }) },
  {
    capability: 'token.price',
    tool: toolFor('token.price'),
    args: (c, p) => (p.token ? { chain: c, address: p.token } : null),
  },
  {
    capability: 'wallet.balances.native',
    tool: toolFor('wallet.balances.native'),
    args: (c, p) => (p.wallet ? { chain: c, address: p.wallet } : null),
  },
  {
    // Needs no curated probe data at all — the tool takes a chain and nothing else — so every chain
    // that declares it is exercised for free. 7 days keeps the payload small; the window is what
    // makes `gapDays` meaningful, so this is where a vendor that stops publishing shows up.
    capability: 'dex.volume.history',
    tool: toolFor('dex.volume.history'),
    args: (c) => ({ chain: c, days: 7 }),
  },
  {
    // TASK-008 — free (`['blockscout']`, `costOf: 0`), so unlike `entity.labels` one directory
    // down, an eval run of it bills nobody. Needs a curated `token` per chain: a holder list is
    // meaningless without a contract to ask about, and the probe row already carries one for
    // `token.price`. Chains with no curated token report `no-probe` rather than silently vanishing
    // — which is the whole point of this file.
    capability: 'token.holders',
    tool: toolFor('token.holders'),
    args: (c, p) => (p.token ? { chain: c, tokenAddress: p.token } : null),
  },
  {
    // TASK-009 — free and keyless. Needs no curated probe data: the tool takes a chain and nothing
    // else, so every chain declaring the capability is exercised automatically. Today that is
    // `bitcoin` alone, which is also the point of the coverage assertions around it.
    capability: 'chain.supply',
    tool: toolFor('chain.supply'),
    args: (c) => ({ chain: c }),
  },
];

/** Capabilities deliberately NOT exercised, each with the reason it is out of scope. */
export const CAPABILITY_EXCLUSIONS = new Map([
  ['entity.labels', 'paid — spends Nansen credits, and an eval that bills you gets turned off'],
  ['smart-money.flows', 'paid — spends Nansen credits'],
  ['token.risk', 'paid — spends Nansen credits'],
]);

/** Known gaps between what the registry declares and what any MCP tool serves. These are NOT
 * exclusions — they are real holes, kept named rather than hidden so the count stays honest and a
 * NEW hole (the RF-5 case) is distinguishable from these two at a glance. */
export const CAPABILITY_KNOWN_GAPS = new Map([
  [
    'token.metadata',
    'no tool calls it: onchain_get_token routes through token.price on purpose (a token.metadata ' +
      'cache entry would legally serve an hour-stale price), so the coingecko path is covered and ' +
      'this capability id is not',
  ],
  ['pool.info', 'declared by the registry, served by no MCP tool at all'],
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
 * The two axes, compared: every capability the SELECTED chains declare, minus the ones
 * `CAPABILITY_TOOLS` exercises, minus the ones excluded on the record. What is left is a capability
 * nothing asked a provider about — reported once per capability (not once per chain, which would
 * bury it under a dozen identical rows) together with the chains that declare it.
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
                `(${chains.join(', ')}) and never called. Add it to CAPABILITY_TOOLS, or to ` +
                `CAPABILITY_EXCLUSIONS with the reason.`,
          ],
        },
      ];
    });
}
