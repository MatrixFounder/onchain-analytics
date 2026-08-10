import { nonEmpty, num } from '../case-lib.mjs';

export default {
  capability: 'dex.volume.history',
  // Needs no curated probe data at all — the tool takes a chain and nothing else — so every chain
  // that declares it is exercised for free. 7 days keeps the payload small; the window is what
  // makes `gapDays` meaningful, so this is where a vendor that stops publishing shows up.
  args: (chain) => ({ chain, days: 7 }),
  catches:
    'DeFiLlama dropping a chain from its DEX dataset while still answering 200, a day going ' +
    'missing from the series, and the L-5 class: an empty window reported as a complete one',
  check: (r) => {
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
};
