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
    // Q-7 — the h24/series alignment, checked LIVE, which is the only place it can be checked:
    // the offset is a property of the vendor's aggregate, so our fixtures can only prove we
    // reported it correctly on the day they were recorded.
    if (Array.isArray(r?.series) && points > 0) {
      const partials = r.series.filter((p) => p?.partial === true);
      // At most one day can be in progress. Two would mean the day bucketing broke.
      if (partials.length > 1) {
        problems.push(
          `${partials.length} points marked partial — at most one day can be in progress`,
        );
      }
      // A partial point that is not the last one means the series is not in ascending order, or a
      // stale document is being served as current.
      if (partials.length === 1 && r.series[r.series.length - 1]?.partial !== true) {
        problems.push(
          'a partial point that is not the newest — series order or freshness is wrong',
        );
      }
      const asOf = num(r?.totals?.asOfTs);
      if (asOf !== null) {
        // The claim `asOfTs` makes must hold in the payload that makes it: h24 must match the
        // point at that timestamp. This is what would catch the vendor changing what `total24h`
        // aggregates — the drift Q-7 refused to hardcode around.
        //
        // **The SAME relative tolerance the adapter used to set the field, and this check was
        // wrong before it had one.** Exact equality flagged `solana` on the first live run:
        // 1581973855.56 against 1581973852.06, a 2.2e-9 difference that is the vendor rounding two
        // aggregates of one day. The adapter deliberately allows it (Q-7 measured exactly this on
        // solana); a gate stricter than the contract it verifies reports a violation the contract
        // permits, which trains a reader to ignore the row.
        const at = r.series.find((p) => p?.ts === asOf);
        const point = at ? num(at.volumeUsd) : null;
        const h24 = num(totals.h24);
        if (!at) {
          problems.push(`totals.asOfTs ${asOf} names a day that is not in the series`);
        } else if (
          point === null ||
          h24 === null ||
          point <= 0 ||
          Math.abs(h24 - point) / point >= 1e-6
        ) {
          problems.push(
            `totals.h24 ${totals.h24} does not match the series point at asOfTs (${at.volumeUsd})`,
          );
        } else if (at.partial === true) {
          problems.push(
            'totals.asOfTs points at the PARTIAL day — h24 is a complete-day aggregate',
          );
        }
      }
    }
    return problems;
  },
};
