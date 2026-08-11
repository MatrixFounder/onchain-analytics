import { nonEmpty } from '../case-lib.mjs';

export default {
  capability: 'pairs.active',
  // `limit: 5` against a vendor page capped at 30 means this call is ALWAYS a truncated one, which
  // is what makes the `truncated` assertion below meaningful rather than incidental.
  args: (chain) => ({ chain, limit: 5 }),
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
    //   2. `truncated.pairs` comes back FALSE on a call that asked for 5 rows out of a vendor page
    //      that caps at 30. That combination is not a live possibility on any chain with DEX
    //      activity, so a `false` here means the detection went quiet — which is exactly the state
    //      this route shipped in for months while every gate run was green.
    if (typeof r?.truncated?.pairs !== 'boolean' || typeof r?.truncated?.reason !== 'string') {
      problems.push('truncated is missing or reshaped — the completeness signal is gone');
    } else if (r.truncated.pairs !== true) {
      problems.push(
        'truncated.pairs is false for limit=5 against a page the vendor caps at 30 — the page is ' +
          'demonstrably not the whole answer, so the engine is claiming a completeness it did not check',
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
