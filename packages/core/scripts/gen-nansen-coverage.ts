/**
 * `gen-nansen-coverage` — derives Nansen's per-capability chain coverage from the COMMITTED
 * OpenAPI spec (TASK-006 task 006-9, R-58).
 *
 * A dev script, same contract as `sync-chain-registry.ts`: nothing under `src/` imports it, and it
 * writes a committed `.ts` module. Same technique M2 already uses for the `costOf()` cost table —
 * read the spec we already paid to obtain, emit code, review the diff.
 *
 * **Why the spec instead of live probing (recorded deviation from R-58a).** R-58a's wording is
 * "a run with the key". The spec enumerates supported chains PER ENDPOINT — 20 distinct chain
 * enums — so the fact is already in hand at zero credits. Probing 25 chains live would spend money
 * to reach the same conclusion. The requirement's intent ("evidence, not a guess") is met more
 * strictly than its letter; a small live spot-check confirms the spec has not drifted.
 *
 * **The rule that makes this correct — a composite capability is covered by the INTERSECTION of
 * its sub-calls.** `smart-money.flows` is ONE `fetch()` issuing TWO requests (`/smart-money/netflow`
 * and `/tgm/holders`). Their enums differ: 17 vs 25 chains. The union would add 8 chains where the
 * first sub-call succeeds, the second is rejected by the vendor, and the credits for the first are
 * already gone — the DF-1 failure class, which cost 35 real credits to discover once.
 *
 * Usage: pnpm --filter @onchain-intel/core exec tsx scripts/gen-nansen-coverage.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SPEC = '../../docs/onchain-analytics/raw/nansen-openapi-2026-07-23.json';
const OUT = 'src/adapters/nansen/chain-coverage.ts';

/**
 * capability → the spec schemas whose enums must ALL admit a chain for it to be covered.
 * Traced to the endpoints each capability actually calls (data-model.md §4.1, M2).
 */
const CAPABILITY_SCHEMAS: Readonly<Record<string, readonly string[]>> = {
  // POST /smart-money/netflow  +  POST /tgm/holders
  'smart-money.flows': ['SmartMoneyChain', 'TGMHoldersChain'],
  // POST /tgm/indicators  +  POST /tgm/token-information (both TGMChain)
  'token.risk': ['TGMChain'],
  // token-scoped tier goes through /tgm/holders; the default tier's /search/general takes a
  // free-form chain string with no enum, so the holders enum is the honest bound.
  'entity.labels': ['TGMHoldersChain'],
};

/** The opt-in exhaustive tier of `entity.labels` (`/profiler/address/labels`) — narrower still. */
const EXHAUSTIVE_LABELS_SCHEMA = 'ProfilerLabelsChain';

interface Spec {
  components: { schemas: Record<string, { enum?: unknown }> };
}

function enumOf(spec: Spec, name: string): string[] {
  const schema = spec.components.schemas[name];
  const values = schema?.enum;
  if (!Array.isArray(values)) throw new Error(`spec: schema '${name}' has no enum`);
  // `'all'` is a query modifier ("every chain"), not a chain. Letting it through would create a
  // phantom chain in the coverage set.
  return values.filter((v): v is string => typeof v === 'string' && v !== 'all').sort();
}

function intersect(sets: readonly string[][]): string[] {
  const [first, ...rest] = sets;
  if (!first) return [];
  return first.filter((value) => rest.every((set) => set.includes(value)));
}

export function generateNansenCoverage(specPath = SPEC, outPath = OUT): void {
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Spec;

  const perCapability = Object.entries(CAPABILITY_SCHEMAS).map(([capability, schemas]) => {
    const sets = schemas.map((name) => enumOf(spec, name));
    return [capability, intersect(sets), schemas, sets.map((s) => s.length)] as const;
  });
  const exhaustive = enumOf(spec, EXHAUSTIVE_LABELS_SCHEMA);

  /**
   * Guards a VENDOR-supplied string before it is interpolated into a TypeScript source literal
   * (vdd-multi cycle 6, L).
   *
   * The inputs are enum members read out of a downloaded OpenAPI document, and the emit below builds
   * `'<value>'` by hand — so a value containing a quote, a backslash or a newline would close the
   * literal early and inject arbitrary source into a COMMITTED `src/` module. Escaping would make
   * that safe and silent; refusing makes it safe and visible. A chain token that is not
   * `[a-z0-9._-]` is a vendor-drift signal worth a human's attention, not something to quietly
   * encode — the same "vendor counters drift, verify rather than assume" discipline this generator
   * exists to serve.
   */
  function safeToken(value: string): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) {
      throw new Error(
        `gen-nansen-coverage: refusing to emit an unexpected vendor token ${JSON.stringify(value)} — ` +
          'expected /^[a-z0-9][a-z0-9._-]*$/i. Inspect the spec before widening this guard.',
      );
    }
    return value;
  }

  const rows = perCapability
    .map(
      ([capability, chains, schemas, sizes]) =>
        `  // ${schemas.join(' ∩ ')} — ${sizes.join(' ∩ ')} = ${chains.length}\n` +
        `  '${safeToken(capability)}': [\n${chains.map((c) => `    '${safeToken(c)}',`).join('\n')}\n  ],`,
    )
    .join('\n');

  const body = `// GENERATED by scripts/gen-nansen-coverage.ts from the committed
// docs/onchain-analytics/raw/nansen-openapi-2026-07-23.json — do not edit by hand.
//
// Nansen's chain coverage differs PER CAPABILITY, and a COMPOSITE capability is covered only where
// EVERY sub-call it makes is covered — an intersection, never a union. The union would add chains
// on which the call half-succeeds after its credits are already spent (TASK-006 task 006-9, R-58).
//
// Values are NANSEN's own chain tokens, not our slugs; \`registry.data.json\`'s \`vendors.nansen\`
// column maps between them.

/** capability → the Nansen chain tokens on which it is covered. */
export const NANSEN_CHAIN_COVERAGE: Readonly<Record<string, readonly string[]>> = {
${rows}
};

/** The opt-in exhaustive \`entity.labels\` tier (\`/profiler/address/labels\`), narrower than the
 * default tier — listed separately so a caller can be refused BEFORE the 100cr escalation. */
export const NANSEN_EXHAUSTIVE_LABELS_CHAINS: readonly string[] = [
${exhaustive.map((c) => `  '${safeToken(c)}',`).join('\n')}
];
`;

  writeFileSync(outPath, body, 'utf8');
  for (const [capability, chains, schemas, sizes] of perCapability) {
    process.stdout.write(
      `${capability.padEnd(20)} ${schemas.join(' ∩ ')} = ${sizes.join(' ∩ ')} -> ${chains.length}\n`,
    );
  }
  process.stdout.write(`${'entity.labels(exhaustive)'.padEnd(20)} -> ${exhaustive.length}\n`);
}

const invokedDirectly = process.argv[1]?.endsWith('gen-nansen-coverage.ts') ?? false;
if (invokedDirectly) generateNansenCoverage();
