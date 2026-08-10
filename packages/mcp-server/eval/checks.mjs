// Grading for the live eval: the per-tool verdict, plus the cross-source checks that no
// single-provider test can reach.
//
// The bar is deliberately higher than "the call did not throw". The failure this project actually
// suffered was a vendor quietly dropping a FIELD while still returning HTTP 200 — a response that
// passes any is-it-an-error test and still destroys the data. So every case asserts that the
// fields the tool promises are PRESENT and USABLE, and each one says what it would have caught.
//
// Verdicts:
//   ok         — the response carries everything the tool's contract promises
//   degraded   — the call succeeded but a promised field is missing/empty/implausible (the L-2 class)
//   error      — the call failed outright
// `degraded` is separate from `error` on purpose: an eval that collapses them cannot tell
// "the provider is down" (loud, obvious) from "the provider silently stopped sending a field"
// (quiet, and the one that cost us four days).
//
// The per-tool assertions themselves live in `cases/`, one file per case, beside the request that
// produces the response they judge. This module keeps what is genuinely shared: the tool→case
// index, the cross-source checks, and `grade()`.

// The consensus arithmetic is IMPORTED, never re-implemented here (TASK-009). A second copy of the
// halving schedule would be two sources of one fact, and the copy is always the one that drifts —
// which would turn this cross-check into a check of our own duplicate rather than of the vendor.
import { bitcoinEmissionSat, bitcoinSubsidyAtHeightSat } from '@onchain-intel/core';
import { CASES } from './cases/index.mjs';
import { toolFor } from './capabilities.mjs';

/**
 * tool name → the case that grades its responses.
 *
 * ONE tool can serve SEVERAL capabilities, and therefore be named by several case files:
 * `onchain_dash_platform_history` answers both `privacy.shielded_pool.history` and
 * `platform.metrics.history`, chosen by a selector. Those cases share one expectation and import it
 * rather than copying it — so the collision is legitimate, and the guard below only rejects the
 * illegitimate form: two cases claiming one tool with DIFFERENT assertions, where whichever loaded
 * last would silently win and the other case would be graded by a check it never declared.
 */
function indexByTool() {
  const byTool = new Map();
  for (const c of CASES) {
    const tool = c.kind === 'bootstrap' ? c.tool : toolFor(c.capability);
    const existing = byTool.get(tool);
    if (existing && existing.check !== c.check) {
      throw new Error(
        `eval/cases: ${existing.file} and ${c.file} both grade '${tool}' with different check ` +
          'functions. One would silently win. Share the assertion (see cases/shared/) or split ' +
          'the tool.',
      );
    }
    byTool.set(tool, c);
  }
  return byTool;
}

const CASES_BY_TOOL = indexByTool();

/**
 * The per-tool checks, keyed by tool name — the shape `grade()` and the coverage test consume.
 * Derived from `cases/`, never written here.
 */
export const checks = Object.fromEntries(
  [...CASES_BY_TOOL].map(([tool, c]) => [tool, { catches: c.catches, run: c.check }]),
);

/**
 * CROSS-SOURCE checks — the combination cases, and the only ones a single-provider test cannot
 * reach. Each compares two INDEPENDENT sources for the same fact, so agreement is evidence and
 * disagreement names which pair disagreed.
 *
 * These stay here rather than in `cases/`: a case file owns ONE request and its response, and every
 * check below spans two sources or two axes, so it belongs to no single case.
 *
 * (An earlier design chained dexscreener's token address into coingecko; the live payload settled
 * it — `new_pairs` returns baseTokenSymbol, never a contract address, so that chain does not exist
 * and claiming to test it would have been fiction. These are the combinations the data supports.)
 */
export const crossChecks = {
  /**
   * The registry says chain X serves capability C. The provider is the one that must actually do
   * it. A mismatch here is the registry lying — the failure mode where a tool is advertised,
   * an agent calls it, and gets an error the catalogue promised could not happen.
   */
  registryVsProvider: (chain, capability, verdict) =>
    verdict === 'error'
      ? [
          `registry declares ${capability} for ${chain}, but the provider call failed — ` +
            'the catalogue and reality disagree',
        ]
      : [],

  /**
   * Every tool echoes the chain it answered for. If the echo differs from what was asked, the
   * adapter's slug→vendor-id mapping is wrong and the answer belongs to a DIFFERENT chain — data
   * that looks perfectly valid and is about something else. Cheap, and it covers every tool at once.
   */
  chainEcho: (requested, structured) => {
    const echoed = structured?.chain;
    return typeof echoed === 'string' && echoed !== requested
      ? [`answered for chain "${echoed}" but "${requested}" was requested — slug mapping is wrong`]
      : [];
  },

  /**
   * The registry's nativeSymbol (synced from DeFiLlama) versus what the RPC adapter reports for the
   * native asset. Two unrelated sources for one fact; POL-vs-MATIC style drift shows up here first.
   */
  nativeSymbol: (registrySymbol, structured) => {
    const reported = structured?.balances?.find((b) => b?.assetType === 'native')?.symbol;
    if (!registrySymbol || !reported) return [];
    return registrySymbol.toUpperCase() !== reported.toUpperCase()
      ? [`native symbol disagrees: registry says "${registrySymbol}", rpc says "${reported}"`]
      : [];
  },

  /**
   * BTC supply against an independent vendor (TASK-009, R-89) — the only check here that leaves the
   * engine entirely.
   *
   * **It compares HEIGHTS, and that is the whole design.** Re-deriving `emissionRaw` from the
   * halving schedule cannot contradict `blockchain-info`, because `blockchain-info` derives it the
   * same way — measured bit-exact at both probed heights on 2026-07-29. A check that cannot fail is
   * not a check. What a second source CAN contradict is the block count, so that is what is
   * compared; the deterministic schedule then carries the disagreement into supply, which is
   * reported alongside so the consequence of the drift is visible in the unit a caller cares about.
   *
   * **The delta is in blocks of subsidy, never in percent.** One block is 0.000016% of supply and a
   * full day of vendor staleness is 0.0023%; on a percentage scale both read as zero. The threshold
   * lives in `probes.json` as data (`maxDeltaBlocks`) so it can be retuned without a release, and it
   * is DEFENSIVE, not a measured vendor ceiling.
   *
   * A missing or unreadable reference yields NO complaint: `run.mjs` has already recorded it as its
   * own `no-probe` row. Scoring our own unavailable apparatus as a provider defect is the exact
   * dishonesty the verdict table exists to prevent.
   */
  supplyVsConsensus: (structured, references, config) => {
    if (!config) return [];
    const ref = references?.[config.reference];
    if (!ref?.ok) return [];

    const tipHeight = ref.value;
    const blockCount = structured?.blockCount;
    if (!Number.isSafeInteger(blockCount) || !Number.isSafeInteger(tipHeight)) return [];

    // Genesis is height 0, so a chain whose tip is at height h has h+1 blocks. The two vendors
    // report DIFFERENT quantities that coincide numerically most of the time, which is exactly how
    // an off-by-one hides: `blockchain.info`'s n_blocks_total is a COUNT, mempool.space's
    // tip/height is a HEIGHT.
    const expectedCount = tipHeight + 1;
    const deltaBlocks = blockCount - expectedCount;
    const maxDelta = config.maxDeltaBlocks ?? 6;
    if (Math.abs(deltaBlocks) <= maxDelta) return [];

    // Name the number. A counter without the offending value can be neither acted on nor
    // distinguished from its own background noise (the L-3 lesson from the snapshotter).
    const emission = BigInt(structured?.emissionRaw ?? '0');
    const expectedEmission = bitcoinEmissionSat(expectedCount);
    const subsidy = bitcoinSubsidyAtHeightSat(tipHeight);
    const btcOff = subsidy === 0n ? 'n/a' : `${Number(emission - expectedEmission) / 1e8} BTC`;
    return [
      `block height disagrees with ${config.reference}: we report a count of ${blockCount} ` +
        `(tip ${blockCount - 1}), the reference reports tip ${tipHeight} — ` +
        `${deltaBlocks > 0 ? '+' : ''}${deltaBlocks} blocks, beyond the ${maxDelta}-block bound, ` +
        `which is ${btcOff} of supply`,
    ];
  },
};

/**
 * Grade one tool response. Returns {verdict, problems[]}.
 *
 * **A tool with no check is NOT `ok`** (TASK-011, R-118). This function used to return `ok` for an
 * unknown tool, and that was the L-2 defect living inside the very file written to prevent it:
 * `onchain_token_holders` was wired into the capability axis, so the live eval called it on every
 * run — and graded whatever came back, including nothing at all, as a success. Four days were once
 * lost to a vendor quietly dropping a field; a harness that cannot tell "verified" from "never
 * looked" reintroduces exactly that.
 *
 * The predicate is deliberately "the eval calls this tool", not "the tool is free". Free-ness is a
 * property of the provider tier (ADR-002 D8, stage T-012) and does not exist here yet; every tool
 * reaching this function is one the eval decided to invoke, which is reason enough to require a
 * check. `degraded` rather than `error`: the call itself succeeded, we simply cannot say the answer
 * is good — and `degraded` already means precisely that, and already fails the run.
 */
export function grade(tool, structured) {
  const check = checks[tool];
  if (!check) {
    return {
      verdict: 'degraded',
      problems: [
        `NO CHECK WIRED for ${tool} — the eval called it and cannot tell a good answer from an ` +
          'empty one. Add a case file under eval/cases/, or stop calling the tool.',
      ],
    };
  }
  const problems = check.run(structured) ?? [];
  return { verdict: problems.length ? 'degraded' : 'ok', problems };
}
