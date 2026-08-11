import { num, nonEmpty } from '../case-lib.mjs';
import { endpointContextIntegrity } from './shared/endpoint-context.mjs';

/** The invariant this capability exists to make checkable: a consumer must be able to tell a GAP
 * from a real zero without guessing. If it ever stops holding, every "how did X change" answer
 * built on it is quietly unfounded. */
const seriesIntegrity = (r, label) => {
  const problems = [];
  if (!Array.isArray(r?.series)) return [`${label}: series is not an array`];
  if (num(r?.points) === null || num(r?.gapDays) === null || num(r?.window?.days) === null) {
    return [`${label}: points/gapDays/window.days are not all numbers`];
  }
  if (r.points !== r.series.length)
    problems.push(`${label}: points=${r.points} but series has ${r.series.length}`);
  if (r.points + r.gapDays !== r.window.days) {
    problems.push(
      `${label}: points+gapDays=${r.points + r.gapDays} but window.days=${r.window.days}`,
    );
  }
  // Day-bucketed, strictly increasing, never stitched — a duplicate day used to mask exactly one
  // genuine missing day (L-4), and that is invisible from the counts alone.
  for (let i = 1; i < r.series.length; i += 1) {
    if (r.series[i].ts <= r.series[i - 1].ts) {
      problems.push(`${label}: series is not strictly increasing at index ${i}`);
      break;
    }
  }
  return problems;
};

export default {
  capability: 'chain.tvl.history',
  args: (chain) => ({ chain, days: 30 }),
  catches:
    'the historical endpoint moving or changing units, and the gap/window arithmetic drifting so a ' +
    'missing day stops being distinguishable from a zero',
  check: (r) => {
    const problems = [nonEmpty(r?.name, 'name')].filter(Boolean);
    problems.push(...seriesIntegrity(r, 'chain.tvl.history'));
    if (r?.change !== null && num(r?.change?.toUsd) === null) {
      problems.push('change is present but carries no finite toUsd');
    }
    problems.push(...endpointContextIntegrity(r?.change, 'chain.tvl.history', r?.series?.length));
    // A 30-day window on a live chain that answers at all should not be empty: an empty series with
    // a clean gap count is exactly the shape a unit change produces (L-5).
    if (Array.isArray(r?.series) && r.series.length === 0) {
      problems.push(
        '30-day window came back empty — the vendor publishes nothing, or units changed',
      );
    }
    return problems;
  },
};
