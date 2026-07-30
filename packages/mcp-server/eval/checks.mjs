// Graded checks for the live eval, one per free MCP tool.
//
// The bar is deliberately higher than "the call did not throw". The failure this project actually
// suffered was a vendor quietly dropping a FIELD while still returning HTTP 200 — a response that
// passes any is-it-an-error test and still destroys the data. So every check here asserts that the
// fields the tool promises are PRESENT and USABLE, and each one says what it would have caught.
//
// Verdicts:
//   ok         — the response carries everything the tool's contract promises
//   degraded   — the call succeeded but a promised field is missing/empty/implausible (the L-2 class)
//   error      — the call failed outright
// `degraded` is separate from `error` on purpose: an eval that collapses them cannot tell
// "the provider is down" (loud, obvious) from "the provider silently stopped sending a field"
// (quiet, and the one that cost us four days).

// The consensus arithmetic is IMPORTED, never re-implemented here (TASK-009). A second copy of the
// halving schedule would be two sources of one fact, and the copy is always the one that drifts —
// which would turn this cross-check into a check of our own duplicate rather than of the vendor.
import { bitcoinEmissionSat, bitcoinSubsidyAtHeightSat } from '@onchain-intel/core';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A finite, strictly positive number — used where zero is not a plausible real-world answer. */
function positive(value, field) {
  const n = num(value);
  if (n === null) return `${field} is not a finite number (${JSON.stringify(value)})`;
  if (n <= 0) return `${field} is ${n} — a live chain/token should never report this`;
  return null;
}

/** Present and non-empty after trimming. */
function nonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    return `${field} is missing or empty (${JSON.stringify(value)})`;
  }
  return null;
}

export const checks = {
  onchain_chain_tvl: {
    catches: 'DeFiLlama renaming a chain, or returning a chain row without its tvl field',
    run: (r) =>
      [
        nonEmpty(r?.chain, 'chain'),
        nonEmpty(r?.name, 'name'),
        positive(r?.tvlUsd, 'tvlUsd'),
        nonEmpty(r?.source, 'source'),
      ].filter(Boolean),
  },

  onchain_protocol_tvl: {
    catches: 'a protocol slug going away, or chain-scoped TVL silently collapsing to the total',
    run: (r) => {
      const problems = [
        nonEmpty(r?.protocol, 'protocol'),
        positive(r?.totalTvlUsd, 'totalTvlUsd'),
      ].filter(Boolean);
      // chain-scoped TVL may legitimately be 0 (protocol not deployed there) but must be a number:
      // a missing field and a real zero mean opposite things and must not look alike.
      if (num(r?.tvlUsd) === null)
        problems.push('tvlUsd is not a finite number — chain scope lost');
      return problems;
    },
  },

  onchain_get_token: {
    catches: 'CoinGecko dropping price for a listed contract, or losing symbol/decimals',
    run: (r) => {
      const problems = [nonEmpty(r?.symbol, 'symbol')].filter(Boolean);
      // priceUsd is the whole point of the call; absent is a defect, zero is implausible for a
      // token the provider claims to know.
      const price = positive(r?.priceUsd, 'priceUsd');
      if (price) problems.push(price);
      if (r?.decimals !== undefined && num(r.decimals) === null)
        problems.push('decimals present but not numeric');
      return problems;
    },
  },

  onchain_new_pairs: {
    catches: 'DexScreener returning an empty page for a chain that demonstrably has DEX activity',
    run: (r) => {
      const pairs = Array.isArray(r?.pairs) ? r.pairs : null;
      if (!pairs) return ['pairs is not an array — shape changed'];
      if (pairs.length === 0)
        return ['pairs is empty — no new pairs at all is implausible for a live DEX chain'];
      const first = pairs[0];
      return [nonEmpty(first?.pairAddress ?? first?.address, 'pairs[0].pairAddress')].filter(
        Boolean,
      );
    },
  },

  onchain_wallet_balances: {
    catches: 'an RPC endpoint answering without a balance entry, or returning it as a lossy number',
    run: (r) => {
      // Zero is a CORRECT answer for the probe address — assert shape, never magnitude.
      const balances = Array.isArray(r?.balances) ? r.balances : null;
      if (!balances) return ['balances is not an array — shape changed'];
      const native = balances.find((b) => b?.assetType === 'native');
      if (!native)
        return ['no assetType="native" entry — the one thing this tool exists to return'];
      const problems = [];
      if (typeof native.amountRaw !== 'string' || !/^\d+$/.test(native.amountRaw)) {
        problems.push(
          `amountRaw is not an integer string (${JSON.stringify(native.amountRaw)}) — ` +
            'native balances exceed 2^53 and must stay strings (§1.7)',
        );
      }
      if (num(native.decimals) === null) problems.push('decimals missing or not numeric');
      const sym = nonEmpty(native.symbol, 'balances[native].symbol');
      if (sym) problems.push(sym);
      return problems;
    },
  },

  onchain_dex_volume: {
    catches:
      'DeFiLlama dropping a chain from its DEX dataset while still answering 200, a day going ' +
      'missing from the series, and the L-5 class: an empty window reported as a complete one',
    run: (r) => {
      const problems = [nonEmpty(r?.chain, 'chain'), nonEmpty(r?.source, 'source')].filter(Boolean);
      const days = num(r?.window?.days);
      const points = num(r?.points);
      const gapDays = num(r?.gapDays);
      if (days === null || points === null || gapDays === null) {
        problems.push('window.days / points / gapDays missing or not numeric — shape changed');
        return problems;
      }
      // The tool's OWN published invariant, checked against a live answer rather than a fixture.
      // It is what makes the three fields mutually verifiable; L-5 was exactly its violation, and a
      // check of this kind here would have caught it on the first run instead of a manual sweep.
      if (points + gapDays !== days) {
        problems.push(
          `points + gapDays !== window.days (${points} + ${gapDays} !== ${days}) — the tool's own ` +
            'invariant is broken, so one of the three fields is describing a different window',
        );
      }
      if (!Array.isArray(r?.series)) problems.push('series is not an array — shape changed');
      else if (r.series.length !== points) problems.push('points disagrees with series.length');
      // Every curated chain is a major one that trades daily. Zero points, or a hole in a 7-day
      // window, means the vendor stopped publishing — the quiet failure this eval exists for. (A
      // chain that legitimately has no history — the five `echoMatchedButNoVolume` ones — is not in
      // probes.json; if one is ever added, this is the line to revisit, deliberately.)
      if (points === 0) {
        problems.push(
          'no daily points at all in the window for a chain that declares the capability',
        );
      } else if (gapDays > 0) {
        problems.push(`${gapDays} day(s) missing inside a ${days}-day window`);
      }
      // The newest point is the one a caller reads first; a non-numeric volume there is the whole
      // answer being wrong, not a rounding question.
      const newest = Array.isArray(r?.series) ? r.series[r.series.length - 1] : null;
      if (newest && num(newest.volumeUsd) === null) {
        problems.push(`newest point volumeUsd is not a finite number (${JSON.stringify(newest)})`);
      }
      // Aggregates are nullable BY CONTRACT (a covered chain can answer total24h: null), so their
      // absence is not graded — but all five null while the series has points means the document
      // lost its aggregate block, which no legitimate answer does.
      const totals = r?.totals ?? {};
      const anyTotal = ['h24', 'd7', 'd30', 'd1y', 'allTime'].some((k) => num(totals[k]) !== null);
      if (points > 0 && !anyTotal) {
        problems.push('every aggregate is null though the series has points — totals block lost');
      }
      // Documented drift signal: set only when the returned series is not everything the vendor
      // sent (a cap, or duplicate days folded). Never set by ordinary windowing, so it always means
      // something changed upstream.
      if (r?.truncated?.series === true) {
        problems.push(`truncated: ${r.truncated.reason || 'no reason given'}`);
      }
      return problems;
    },
  },

  onchain_chain_supply: {
    catches:
      'the two supply figures collapsing into one, an exact value arriving as a lossy number, ' +
      'and a response that violates the consensus invariant it cannot violate',
    run: (r) => {
      const problems = [
        nonEmpty(r?.chain, 'chain'),
        nonEmpty(r?.symbol, 'symbol'),
        nonEmpty(r?.source, 'source'),
        nonEmpty(r?.emissionRaw, 'emissionRaw'),
        nonEmpty(r?.circulatingRaw, 'circulatingRaw'),
      ].filter(Boolean);
      if (problems.length) return problems;

      // Exactness is the contract: these are integers in the smallest unit and must arrive as
      // strings. A JSON number here would mean the exact value was spent before it reached us.
      for (const field of ['emissionRaw', 'circulatingRaw']) {
        if (!/^\d+$/.test(r[field])) {
          problems.push(`${field} is not an integer string — exactness lost in transport`);
        }
      }
      if (problems.length) return problems;

      const emission = BigInt(r.emissionRaw);
      const circulating = BigInt(r.circulatingRaw);
      // Consensus forbids claiming more than the subsidy. If this ever trips, one of the two
      // numbers is wrong and the answer cannot be attributed to either.
      if (circulating > emission) {
        problems.push('circulating exceeds emission — consensus forbids it, so a figure is wrong');
      }
      // The two ARE distinct quantities (unclaimed coinbase subsidy). Equal values mean the vendor
      // started serving one under both names, which is a 0.00016% error and invisible by eye.
      if (circulating === emission) {
        problems.push(
          'circulating equals emission exactly — the ~29-32 BTC of unclaimed subsidy vanished, ' +
            'so one figure is now being served under both names',
        );
      }
      if (num(r?.blockCount) === null || r.blockCount <= 0) {
        problems.push('blockCount missing or implausible — the field the cross-check depends on');
      }
      if (r?.decimals !== 8) problems.push(`decimals is ${r?.decimals}, expected 8 for BTC`);
      return problems;
    },
  },

  onchain_list_chains: {
    catches: 'the chain registry failing to load, or shrinking unexpectedly',
    run: (r) => {
      const chains = Array.isArray(r?.chains) ? r.chains : null;
      if (!chains) return ['chains is not an array'];
      if (chains.length === 0) return ['registry is empty'];
      const bad = chains.find((c) => !c?.slug || !Array.isArray(c?.capabilities));
      return bad
        ? [`a chain row lacks slug/capabilities: ${JSON.stringify(bad).slice(0, 120)}`]
        : [];
    },
  },

  onchain_ping: {
    catches: 'the server failing to start or answer at all',
    run: (r) => [nonEmpty(r?.version, 'version')].filter(Boolean),
  },
};

/**
 * CROSS-SOURCE checks — the combination cases, and the only ones a single-provider test cannot
 * reach. Each compares two INDEPENDENT sources for the same fact, so agreement is evidence and
 * disagreement names which pair disagreed.
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

/** Grade one tool response. Returns {verdict, problems[]}. */
export function grade(tool, structured) {
  const check = checks[tool];
  if (!check) return { verdict: 'ok', problems: [] };
  const problems = check.run(structured) ?? [];
  return { verdict: problems.length ? 'degraded' : 'ok', problems };
}
