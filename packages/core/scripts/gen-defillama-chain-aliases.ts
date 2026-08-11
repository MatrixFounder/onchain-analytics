/**
 * `gen-defillama-chain-aliases` — emits DeFiLlama's LEGACY chain display names, mapped to the
 * current ones, from committed live evidence.
 *
 * A dev script, same contract as `gen-defillama-dex-chains.ts`: nothing under `src/` imports it, it
 * reads a committed raw artifact and writes a committed `.ts` module, and the review happens on the
 * git diff.
 *
 * **The defect this exists to close.** DeFiLlama serves the same chain catalogue under TWO naming
 * vocabularies, and the two endpoints this engine reads are on opposite sides of it:
 * `/v2/chains` — which `sync-chain-registry.ts` populates `vendors.defillama` from — says
 * `OP Mainnet`, `BSC`, `Gnosis`, `ZKsync Era`; `/protocols` — which `protocol.tvl` reads — says
 * `Optimism`, `Binance`, `xDai`, `zkSync Era`. Matching the registry's name against the catalog by
 * string therefore MISSES 43 of the 458 registry chains, and the miss is silent in the worst
 * possible way: `protocol.tvl` reports `deployed: false, tvlUsd: 0` for a chain the protocol is
 * plainly on. Measured 2026-08-11 against the live vendor — `aave` answered "not deployed" on
 * `optimism`, `bsc`, `gnosis` and `zksync-era`, and the catalog lists `Binance` for 1 115
 * protocols and `Optimism` for 385.
 *
 * **How the mapping is derived — from the vendor's own identity columns, never by guessing at
 * names.** Both listings carry `chainId`, `gecko_id` and `cmcId` for the same chains, so a rename is
 * two rows that agree on identity and differ on `name`. The join rule is narrow on purpose, because
 * two of the three columns are provably unsafe here:
 *
 * - `cmcId` is NEVER used. `Terra` and `Flare` both carry `4172`; `Electroneum` and `HeLa` both
 *   carry `2137`. Joining on it invents renames between unrelated chains.
 * - `gecko_id` is used ONLY when it identifies exactly one row on each side. `Bitcoincash` and
 *   `smartBCH` share `bitcoin-cash`; `IOTA` and `IOTA EVM` share `iota`. An L1 and a sidechain
 *   sharing a coin id is not a rename.
 * - `chainId` is preferred whenever both sides have one.
 *
 * With that rule the recorded evidence yields 42 aliases, resolves 456 of the 491 chain names the
 * catalog uses, and produces ZERO collisions — no two catalog names claim one registry chain. The
 * 35 that stay unresolved are chains the registry genuinely does not carry (Polkadot, Celestia,
 * Aleo…); they are counted as `unmappedDeployments`, which is what that field is for.
 *
 * **Why a build artifact and not a startup fetch** — the same three reasons `dex-chains.ts` is one
 * (data-model.md §4.2.1): the offline-run gate, CI determinism, and reviewability. Freshness is the
 * OPERATOR's job: a rename that happens at the vendor takes effect after this script is re-run and
 * the snapshot committed, never automatically.
 *
 * Usage: pnpm --filter @onchain-intel/core exec tsx scripts/gen-defillama-chain-aliases.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';

const EVIDENCE =
  '../../docs/onchain-analytics/raw/defillama-chain-name-vocabularies-2026-08-11.json';
const OUT = 'src/adapters/defillama/chain-aliases.ts';

/**
 * Floor on a plausible alias count. The recorded evidence yields 42. Anything under 10 means a
 * listing moved, a column was renamed, or the recording is truncated — and accepting that silently
 * restores exactly the defect this module exists to close, while looking like a successful run.
 */
const MIN_PLAUSIBLE_ALIASES = 10;

interface ChainRow {
  name?: unknown;
  chainId?: unknown;
  gecko_id?: unknown;
}

interface Evidence {
  legacy?: unknown;
  current?: unknown;
}

/**
 * Guards a VENDOR-supplied string before it is interpolated into a TypeScript source literal —
 * copied in doctrine from `gen-defillama-dex-chains.ts`'s `safeName`, including its reasoning:
 * escaping would make an unexpected name safe and SILENT, refusing makes it safe and VISIBLE.
 *
 * The class is deliberately the same one that file uses, and it already admits every name in the
 * recorded evidence — `OP Mainnet` (space), `WEMIX3.0` (dot), `Op_Bnb` (underscore), `X Layer`.
 */
function safeName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(value)) {
    throw new Error(
      `gen-defillama-chain-aliases: refusing to emit an unexpected vendor chain name ${JSON.stringify(value)} — ` +
        'expected /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/. Inspect the evidence before widening this guard.',
    );
  }
  return value;
}

const rowsOf = (value: unknown, which: string): ChainRow[] => {
  if (!Array.isArray(value)) {
    throw new Error(`gen-defillama-chain-aliases: evidence.${which} is not an array`);
  }
  return value as ChainRow[];
};

const nameOf = (r: ChainRow): string | null =>
  typeof r.name === 'string' && r.name ? r.name : null;
const geckoOf = (r: ChainRow): string | null =>
  typeof r.gecko_id === 'string' && r.gecko_id ? r.gecko_id : null;
const chainIdOf = (r: ChainRow): string | null =>
  r.chainId === null || r.chainId === undefined ? null : String(r.chainId);

function tally(rows: ChainRow[], pick: (r: ChainRow) => string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = pick(r);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function deriveAliases(legacy: ChainRow[], current: ChainRow[]): Map<string, string> {
  const geckoInLegacy = tally(legacy, geckoOf);
  const geckoInCurrent = tally(current, geckoOf);

  const currentByChainId = new Map<string, string>();
  const currentByGecko = new Map<string, string>();
  for (const r of current) {
    const name = nameOf(r);
    if (name === null) continue;
    const chainId = chainIdOf(r);
    // FIRST row wins per key, and that is not arbitrary: `/v2/chains` carries the legacy name as a
    // second row with `tvl: 0` beside the canonical one (measured on `Optimism` beside `OP Mainnet`
    // and `Binance` beside `BSC`). Either row is a correct identity, and a legacy→legacy alias is
    // dropped below as a no-op, so the tie cannot produce a wrong mapping.
    if (chainId !== null && !currentByChainId.has(chainId)) currentByChainId.set(chainId, name);
    const gecko = geckoOf(r);
    if (gecko !== null && geckoInCurrent.get(gecko) === 1 && geckoInLegacy.get(gecko) === 1) {
      currentByGecko.set(gecko, name);
    }
  }

  const aliases = new Map<string, string>();
  for (const r of legacy) {
    const name = nameOf(r);
    if (name === null) continue;
    const chainId = chainIdOf(r);
    const gecko = geckoOf(r);
    const target =
      (chainId !== null ? currentByChainId.get(chainId) : undefined) ??
      (gecko !== null ? currentByGecko.get(gecko) : undefined);
    if (target === undefined || target === name) continue;
    const existing = aliases.get(name);
    if (existing !== undefined && existing !== target) {
      throw new Error(
        `gen-defillama-chain-aliases: ${JSON.stringify(name)} joins to both ${JSON.stringify(existing)} and ` +
          `${JSON.stringify(target)} — refusing to pick one. Inspect the evidence.`,
      );
    }
    aliases.set(name, target);
  }

  // A rename must be a BIJECTION on the recorded evidence: two legacy names collapsing onto one
  // current name would silently merge two chains' protocol lists into one answer.
  const claimed = new Map<string, string>();
  for (const [from, to] of aliases) {
    const prior = claimed.get(to);
    if (prior !== undefined) {
      throw new Error(
        `gen-defillama-chain-aliases: ${JSON.stringify(prior)} and ${JSON.stringify(from)} both alias to ` +
          `${JSON.stringify(to)} — refusing to emit a many-to-one rename.`,
      );
    }
    claimed.set(to, from);
  }
  return aliases;
}

export function renderModule(aliases: Map<string, string>): string {
  const entries = [...aliases]
    .map(([from, to]) => [safeName(from), safeName(to)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const lines = entries.map(([from, to]) => `  ['${from}', '${to}'],`).join('\n');
  return `// GENERATED by scripts/gen-defillama-chain-aliases.ts from the committed
// ${EVIDENCE.replace('../../', '')} — do not edit by hand.
//
// DeFiLlama's LEGACY chain display name -> the CURRENT one. \`/protocols\` speaks the legacy
// vocabulary; \`/v2/chains\` — and therefore \`registry.data.json\`'s \`vendors.defillama\` column —
// speaks the current one. Without this map, matching by string misses 43 of 458 registry chains and
// \`protocol.tvl\` answers a confident \`deployed: false, tvlUsd: 0\` for chains a protocol is plainly
// on (measured: \`aave\` on \`optimism\`/\`bsc\`/\`gnosis\`/\`zksync-era\`, 2026-08-11).
//
// Derived from the vendor's own \`chainId\`/\`gecko_id\` identity columns, never from name similarity —
// see the generator for why \`cmcId\` is unusable and why \`gecko_id\` is only trusted when unique.

export const DEFILLAMA_CHAIN_ALIASES: ReadonlyMap<string, string> = new Map([
${lines}
]);
`;
}

/** Reads `evidencePath`, writes `outPath`, returns the emitted aliases. Both paths are parameters so
 * the generator tests can drive it against synthetic evidence in a temp directory — the same seam
 * `gen-defillama-dex-chains.ts` exposes, for the same reason: a generator test that depended on what
 * the vendor served today would not be a test. */
export function generateDefillamaChainAliases(
  evidencePath: string = EVIDENCE,
  outPath: string = OUT,
): Map<string, string> {
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as Evidence;
  const aliases = deriveAliases(
    rowsOf(evidence.legacy, 'legacy'),
    rowsOf(evidence.current, 'current'),
  );
  if (aliases.size < MIN_PLAUSIBLE_ALIASES) {
    throw new Error(
      `gen-defillama-chain-aliases: refusing to emit only ${aliases.size} aliases (< ${MIN_PLAUSIBLE_ALIASES}) — ` +
        'the evidence or the vendor shape changed, and an empty map silently restores the defect ' +
        'this module closes while looking like a successful run.',
    );
  }
  writeFileSync(outPath, renderModule(aliases), 'utf8');
  return aliases;
}

const invokedDirectly = process.argv[1]?.endsWith('gen-defillama-chain-aliases.ts') ?? false;
if (invokedDirectly) {
  const emitted = generateDefillamaChainAliases();
  process.stdout.write(`DEFILLAMA_CHAIN_ALIASES -> ${emitted.size} renames\n`);

  // Report what the map actually buys, rather than leaving it implicit: how many registry chains
  // were unreachable in the catalog's vocabulary before it, and are reachable after.
  const registry = JSON.parse(readFileSync('src/chain/registry.data.json', 'utf8')) as {
    chains: { slug: string; vendors: Record<string, string | null> }[];
  };
  const toLegacy = new Map([...emitted].map(([from, to]) => [to, from]));
  const recovered = registry.chains
    .map((chain) => chain.vendors['defillama'])
    .filter((name): name is string => name != null)
    .filter((name) => toLegacy.has(name));
  process.stdout.write(
    `registry chains reachable ONLY through an alias: ${recovered.length}\n` +
      `  e.g. ${recovered
        .slice(0, 6)
        .map((n) => `${toLegacy.get(n)!} -> ${n}`)
        .join(', ')}\n`,
  );
}
