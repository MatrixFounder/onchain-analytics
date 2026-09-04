import { nonEmpty } from '../case-lib.mjs';

export default {
  capability: 'pairs.active',
  // `limit: 1` is what makes the `truncated` assertion below sound rather than incidental: any
  // chain whose filtered answer holds two rows or more must report truncation, and the cut is ours,
  // so the expectation rests on this engine rather than on how much the vendor happens to publish.
  //
  // It was `limit: 5`, on the reasoning that a page capped at 30 always exceeds 5. That reasoning
  // reads the CROSS-CHAIN page and the assertion reads the FILTERED one. Measured 2026-09-04:
  // `q=berachain` returns 13 rows of which 5 carry `chainId: berachain`, three probes in a row. At
  // `limit: 5` nothing is cut, the page is not full either, so `truncated.pairs: false` was correct
  // and the gate reported it as a defect. `q=ethereum` returns the full 30 with ONE ethereum row,
  // which is why that chain kept passing: a full page truncates by L-14's third reason.
  args: (chain) => ({ chain, limit: 1 }),
  catches:
    'DexScreener returning an empty page for a chain that demonstrably has DEX activity, and ' +
    "`truncated` going quiet — the field is the caller's only signal that a short page is not an " +
    'inventory, and until L-14 nothing here read it at all',
  check: (r) => {
    const pairs = Array.isArray(r?.pairs) ? r.pairs : null;
    if (!pairs) return ['pairs is not an array — shape changed'];
    if (pairs.length === 0)
      return ['pairs is empty — no new pairs at all is implausible for a live DEX chain'];
    const problems = [
      nonEmpty(first(pairs)?.pairAddress ?? first(pairs)?.address, 'pairs[0].pairAddress'),
    ].filter(Boolean);

    // L-14. Two ways this can rot, and they fail in opposite directions, so both are checked:
    //
    //   1. `truncated` stops being reported at all (shape change / regression) — the caller loses
    //      the only field that distinguishes "this chain is thin" from "we could not see further".
    //   2. `truncated.pairs` comes back FALSE on a call that asked for ONE row. A chain whose
    //      filtered answer holds two rows or more is then cut by this engine, so `false` means the
    //      detection went quiet — the state this route shipped in for months while every gate run
    //      was green.
    //
    //      One residue, named rather than assumed away: a chain with exactly one filtered row on a
    //      page the vendor did not fill truncates nothing, and `false` is correct there. The
    //      assertion cannot tell that apart from a regression, because the response carries the
    //      rows this engine returned and never the count the vendor held.
    if (typeof r?.truncated?.pairs !== 'boolean' || typeof r?.truncated?.reason !== 'string') {
      problems.push('truncated is missing or reshaped — the completeness signal is gone');
    } else if (r.truncated.pairs !== true) {
      problems.push(
        'truncated.pairs is false for limit=1 — this engine returned one row of an answer that ' +
          'held more, so it is claiming a completeness it did not check',
      );
    } else if (r.truncated.reason.trim() === '') {
      problems.push('truncated.pairs is true with an empty reason — a flag nobody can act on');
    }
    return problems;
  },
};

/** Local helper: keep the shape read in one place so the two reads above cannot drift apart. */
function first(pairs) {
  return pairs[0];
}
