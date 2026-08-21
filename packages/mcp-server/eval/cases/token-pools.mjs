import { nonEmpty } from '../case-lib.mjs';

export default {
  capability: 'token.pools',
  // The curated `token` each probe row already carries for `token.price` and `token.holders` — the
  // wrapped native of its chain. No new curated input: a token that trades nowhere would make this
  // case assert an empty page, which is the one answer it must be able to tell from a failure.
  args: (chain, probe) => (probe.token ? { chain, token: probe.token } : null),
  catches:
    'the per-chain route silently answering with rows from OTHER chains (a fork reproduces the ' +
    'addresses of the chain it forked, so a mis-scoped row looks exactly like a real one), the ' +
    'vendor page cap going unreported so a capped page reads as the complete set of pools a token ' +
    'trades in, and `truncated.reason` collapsing its causes into one — a caller told to raise ' +
    '`limit` for rows the vendor never sent retries forever',
  // **What this case does NOT reach**, stated so a green row is read correctly. The eval's axis is
  // one chain per row, so it exercises the PER-CHAIN form only; the cross-chain form (`token` with
  // no `chain`) has no chain to be listed under and is covered by unit tests against committed
  // fixtures. That form is also the riskier one — its rows come from chains the caller never named
  // — so the gap is named here rather than left for a reader to infer from the absence of a row.
  limitNotMeasuredHere:
    'the cross-chain form: this axis is per chain, so `/latest/dex/tokens/{token}` is exercised by ' +
    'the fixture tests and not by the live gate',
  check: (r, { chain, probe } = {}) => {
    const problems = [nonEmpty(r?.chain, 'chain'), nonEmpty(r?.source, 'source')].filter(Boolean);

    if (!Array.isArray(r?.pools)) {
      return [...problems, 'pools is not an array'];
    }
    // The per-chain form names a chain, so the answer must too. `null` here is the CROSS-CHAIN
    // contract leaking into a call that named a chain — the two forms would then be
    // indistinguishable in the output, which is the whole reason they are one capability with two
    // routes rather than one route with a flag.
    if (r.chain !== chain) {
      problems.push(`chain is ${String(r.chain)} on a ${chain} request`);
    }

    if (typeof r?.truncated?.pairs !== 'boolean') {
      problems.push(
        'truncated.pairs is missing or not a boolean — a capped page reads as complete',
      );
    }
    if (typeof r?.truncated?.reason !== 'string') {
      problems.push('truncated.reason is missing — the causes cannot be told apart');
    }
    // L-14's contract, checked rather than assumed: `pairs: true` with an empty reason tells a
    // caller something was lost and refuses to say what, which is worse than either alternative.
    if (r?.truncated?.pairs === true && !String(r?.truncated?.reason ?? '').trim()) {
      problems.push('truncated.pairs is true with an empty reason');
    }
    if (r?.truncated?.pairs === false && String(r?.truncated?.reason ?? '').trim()) {
      problems.push('truncated.pairs is false and a reason was given — the two disagree');
    }

    // A curated probe token is the chain's wrapped native. It trades SOMEWHERE, on every chain that
    // has a DEX at all, so an empty page here is the vendor having lost it — not a quiet truth
    // about the token. The distinction is the L-10 class this file exists to keep visible.
    if (r.pools.length === 0) {
      problems.push(
        `no pools for ${String(probe?.token)} on ${chain}, a token curated because it is the ` +
          "chain's wrapped native — an empty page here is a vendor failure, not a fact",
      );
      return problems;
    }

    for (const [i, pool] of r.pools.entries()) {
      problems.push(
        ...[
          nonEmpty(pool?.pairAddress, `pools[${i}].pairAddress`),
          nonEmpty(pool?.dexId, `pools[${i}].dexId`),
          nonEmpty(pool?.baseTokenSymbol, `pools[${i}].baseTokenSymbol`),
          nonEmpty(pool?.quoteTokenSymbol, `pools[${i}].quoteTokenSymbol`),
        ].filter(Boolean),
      );
      // EVERY row carries its own chain, and on this form every one of them must be the requested
      // chain. A row from elsewhere is the failure this capability was designed around: the vendor
      // route is chain-scoped server-side, and "the vendor scoped it" is an assumption until
      // something checks it.
      if (pool?.chain !== chain) {
        problems.push(`pools[${i}].chain is ${String(pool?.chain)} on a ${chain} request`);
      }
      if (problems.length > 8) break;
    }

    return problems;
  },
};
