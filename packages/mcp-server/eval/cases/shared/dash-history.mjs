// Shared assertion for the two Dash Platform history cases.
//
// `privacy.shielded_pool.history` and `platform.metrics.history` are TWO capabilities served by ONE
// tool, chosen by the `series` selector — so they are two cases (two requests, two coverage rows)
// with one expectation. The assertion lives here rather than being copied into both files: a copy
// is two sources of one rule, and the copy is the one that drifts.
//
// This directory is not scanned by the case loader (it filters to `*.mjs` entries at the top level,
// and `shared` is a directory), so nothing here is mistaken for a case.

import { nonEmpty } from '../../case-lib.mjs';

export const dashHistoryCatches =
  'a merged series published flat instead of grouped, an exact credit value arriving as a ' +
  'lossy number, a group that names no metric, and a silent loss of the missing-source signal';

export function checkDashHistory(r) {
  const problems = [
    nonEmpty(r?.chain, 'chain'),
    nonEmpty(r?.series, 'series'),
    nonEmpty(r?.source, 'source'),
  ].filter(Boolean);
  if (!Array.isArray(r?.groups)) return [...problems, 'groups is not an array'];
  if (problems.length) return problems;

  // Grouping is the contract (OQ-T013-1): a flat list of points is the shape the owner
  // rejected, and the tool must never emit one on either selector.
  for (const group of r.groups) {
    if (!group?.metric) problems.push('a group names no metric');
    if (!Array.isArray(group?.points)) {
      problems.push(`group ${group?.metric ?? '?'} carries no points array`);
      continue;
    }
    for (const point of group.points) {
      // Exactness, same rule as onchain_chain_supply: credits are integers in the smallest
      // unit and must arrive as strings. A JSON number means exactness was spent in transport.
      if (typeof point?.valueRaw !== 'string' || !/^\d+$/.test(point.valueRaw)) {
        problems.push(
          `${group.metric}: valueRaw is not an integer string — exactness lost in transport`,
        );
        break;
      }
    }
  }

  // A degraded answer is legitimate (UC-12: pg-history unconfigured), but it must SAY so.
  // Empty groups with no missingSources means the tool reported "no history" for a window
  // nobody actually failed to read — the exact defect branch (c) of R-164 exists to prevent.
  if (r.groups.length === 0 && !Array.isArray(r.missingSources)) {
    problems.push('no groups and no missingSources — silence where a reason belongs');
  }
  return problems;
}
