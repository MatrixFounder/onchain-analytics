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
      [nonEmpty(r?.chain, 'chain'), nonEmpty(r?.name, 'name'), positive(r?.tvlUsd, 'tvlUsd'),
       nonEmpty(r?.source, 'source')].filter(Boolean),
  },

  onchain_protocol_tvl: {
    catches: 'a protocol slug going away, or chain-scoped TVL silently collapsing to the total',
    run: (r) => {
      const problems = [nonEmpty(r?.protocol, 'protocol'), positive(r?.totalTvlUsd, 'totalTvlUsd')]
        .filter(Boolean);
      // chain-scoped TVL may legitimately be 0 (protocol not deployed there) but must be a number:
      // a missing field and a real zero mean opposite things and must not look alike.
      if (num(r?.tvlUsd) === null) problems.push('tvlUsd is not a finite number — chain scope lost');
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
      if (r?.decimals !== undefined && num(r.decimals) === null) problems.push('decimals present but not numeric');
      return problems;
    },
  },

  onchain_new_pairs: {
    catches: 'DexScreener returning an empty page for a chain that demonstrably has DEX activity',
    run: (r) => {
      const pairs = Array.isArray(r?.pairs) ? r.pairs : null;
      if (!pairs) return ['pairs is not an array — shape changed'];
      if (pairs.length === 0) return ['pairs is empty — no new pairs at all is implausible for a live DEX chain'];
      const first = pairs[0];
      return [nonEmpty(first?.pairAddress ?? first?.address, 'pairs[0].pairAddress')].filter(Boolean);
    },
  },

  onchain_wallet_balances: {
    catches: 'an RPC endpoint answering without a balance entry, or returning it as a lossy number',
    run: (r) => {
      // Zero is a CORRECT answer for the probe address — assert shape, never magnitude.
      const balances = Array.isArray(r?.balances) ? r.balances : null;
      if (!balances) return ['balances is not an array — shape changed'];
      const native = balances.find((b) => b?.assetType === 'native');
      if (!native) return ['no assetType="native" entry — the one thing this tool exists to return'];
      const problems = [];
      if (typeof native.amountRaw !== 'string' || !/^\d+$/.test(native.amountRaw)) {
        problems.push(`amountRaw is not an integer string (${JSON.stringify(native.amountRaw)}) — ` +
                      'native balances exceed 2^53 and must stay strings (§1.7)');
      }
      if (num(native.decimals) === null) problems.push('decimals missing or not numeric');
      const sym = nonEmpty(native.symbol, 'balances[native].symbol');
      if (sym) problems.push(sym);
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
      return bad ? [`a chain row lacks slug/capabilities: ${JSON.stringify(bad).slice(0, 120)}`] : [];
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
      ? [`registry declares ${capability} for ${chain}, but the provider call failed — ` +
         'the catalogue and reality disagree']
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
};

/** Grade one tool response. Returns {verdict, problems[]}. */
export function grade(tool, structured) {
  const check = checks[tool];
  if (!check) return { verdict: 'ok', problems: [] };
  const problems = check.run(structured) ?? [];
  return { verdict: problems.length ? 'degraded' : 'ok', problems };
}
