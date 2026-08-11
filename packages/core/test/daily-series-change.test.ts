import { describe, expect, it } from 'vitest';
import { changeAcross, DAY_MS } from '../src/adapters/defillama/daily-series.js';

/**
 * L-13 — `change.endpointContext`.
 *
 * The record this covers was filed because a one-day vendor artifact became the reported 30-day
 * trend, and its first proposed fix (flag an endpoint that deviates from a robust level) was
 * MEASURED AND REFUSED: across five chains the artifact was smaller than the ordinary daily noise
 * of the chain it appeared on. So these tests assert the engine publishes CONTEXT and no verdict —
 * there is deliberately no threshold here to test, and any future test asserting "this point is an
 * artifact" would be asserting something the data cannot support.
 *
 * The other half of what they pin is that the six original fields did not move. `change` is read by
 * two tools on every chain, and L-13's fix was required to be additive.
 */

const at = (i: number): number => 1_700_000_000_000 + i * DAY_MS;
const series = (...values: number[]) => values.map((valueUsd, i) => ({ ts: at(i), valueUsd }));

describe('changeAcross endpointContext (L-13)', () => {
  // The window that produced the record, with its real values: the last point is a dip, the one
  // before it is not, and the two readings disagree by 5.4×.
  const BERACHAIN_30D = series(
    51_352_059, // first — 2026-07-13
    48_890_578,
    49_140_774,
    49_530_937,
    49_340_856,
    48_786_324,
    42_850_084, // dip
    49_793_489, // recovery
    42_913_792, // last — the dip the headline was computed from
  );

  it('keeps the six original fields exactly as they were — the fix is additive', () => {
    const change = changeAcross(BERACHAIN_30D);

    expect(change).not.toBeNull();
    expect(change?.fromTs).toBe(at(0));
    expect(change?.toTs).toBe(at(8));
    expect(change?.fromUsd).toBe(51_352_059);
    expect(change?.toUsd).toBe(42_913_792);
    expect(change?.absUsd).toBe(42_913_792 - 51_352_059);
    expect(change?.pct).toBeCloseTo(-16.43, 2);
  });

  it('publishes the same window measured to the previous point and to the trailing median', () => {
    const change = changeAcross(BERACHAIN_30D);

    // Measured to the point before the endpoint: -3.04%, against the headline's -16.43%.
    expect(change?.endpointContext.prevPoint?.valueUsd).toBe(49_793_489);
    expect(change?.endpointContext.prevPoint?.pct).toBeCloseTo(-3.04, 2);

    // Median of the seven trailing points, endpoint excluded.
    expect(change?.endpointContext.recentLevel?.points).toBe(7);
    expect(change?.endpointContext.recentLevel?.valueUsd).toBe(49_140_774);
    expect(change?.endpointContext.recentLevel?.pct).toBeCloseTo(-4.31, 2);

    // The whole purpose: a caller can see the headline rests on one point.
    expect(Math.abs(change!.pct!)).toBeGreaterThan(
      Math.abs(change!.endpointContext.prevPoint!.pct!) * 4,
    );
  });

  it('measures both alternatives from the SAME base as pct, so they are comparable to it', () => {
    const change = changeAcross(BERACHAIN_30D);
    const from = change!.fromUsd;

    expect(change?.endpointContext.prevPoint?.absUsd).toBe(49_793_489 - from);
    expect(change?.endpointContext.recentLevel?.absUsd).toBe(49_140_774 - from);
  });

  it('EXCLUDES the endpoint from the trailing median — a level it helped compute cannot disagree with it', () => {
    // Same nine points, but the endpoint replaced by an extreme value. The median must not move.
    const skewed = [...BERACHAIN_30D.slice(0, 8), { ts: at(8), valueUsd: 1 }];
    const change = changeAcross(skewed);

    expect(change?.endpointContext.recentLevel?.valueUsd).toBe(49_140_774);
    expect(change?.endpointContext.recentLevel?.points).toBe(7);
  });

  // The two cases below close gaps found by adversarial review: the shipped `median()` was correct
  // in both, but nothing in either package could tell if it stopped being. Each names the mutation
  // it kills, because a test that no mutation kills is a test of nothing.
  describe('median() over the trailing window', () => {
    it('AVERAGES the two middle values on an even-length window', () => {
      // Trailing length is even at series lengths 6 and 8 — ordinary inputs, since `days` may be
      // as low as 1 and gaps are never stitched, so a 30-day request can return 8 present points.
      // Every other case in this file has an ODD trailing window (7 or 3) or a flat one where the
      // two middles are equal, so this branch was reachable in production and asserted nowhere.
      //
      // KILLS: `(sorted[mid - 1] + sorted[mid]) / 2` -> `sorted[mid]`, which returns 40 here.
      const change = changeAcross(series(100, 10, 20, 30, 40, 50, 60, 999));

      expect(change?.endpointContext.recentLevel?.points).toBe(6);
      expect(change?.endpointContext.recentLevel?.valueUsd).toBe(35);
    });

    it('sorts NUMERICALLY, not lexicographically', () => {
      // Every other trailing window in this file happens to hold values of equal digit count, for
      // which a default `.sort()` gives the same order as a numeric one — so the comparator was
      // free to disappear. It stops being free the moment a window straddles a power of ten, which
      // for TVL means any series hovering near $10M, $100M or $1B: an everyday shape, not an
      // extreme. Here a ~2% swing around $10M is enough.
      //
      // KILLS: `.sort((a, b) => a - b)` -> `.sort()`, which orders
      // ['10100000', '9900000', '9950000'] and returns 9_900_000.
      const change = changeAcross(series(100, 9_900_000, 10_100_000, 9_950_000, 999));

      expect(change?.endpointContext.recentLevel?.points).toBe(3);
      expect(change?.endpointContext.recentLevel?.valueUsd).toBe(9_950_000);
    });
  });

  describe('short and degenerate series (the shapes every other chain also produces)', () => {
    it('two points: prevPoint is null, NOT a zero — the window ending at its own start is not a reading', () => {
      const change = changeAcross(series(100, 130));

      expect(change?.pct).toBeCloseTo(30, 6);
      expect(change?.endpointContext.prevPoint).toBeNull();
      expect(change?.endpointContext.recentLevel).toBeNull();
    });

    it('three points: prevPoint appears, recentLevel still withheld as not robust', () => {
      const change = changeAcross(series(100, 110, 130));

      expect(change?.endpointContext.prevPoint?.valueUsd).toBe(110);
      expect(change?.endpointContext.prevPoint?.pct).toBeCloseTo(10, 6);
      expect(change?.endpointContext.recentLevel).toBeNull();
    });

    it('five points: recentLevel appears over the three trailing points it actually has', () => {
      const change = changeAcross(series(100, 110, 120, 130, 140));

      expect(change?.endpointContext.recentLevel?.points).toBe(3);
      expect(change?.endpointContext.recentLevel?.valueUsd).toBe(120);
    });

    it('a zero base yields null percentages everywhere, never Infinity', () => {
      const change = changeAcross(series(0, 10, 20, 30, 40));

      expect(change?.pct).toBeNull();
      expect(change?.endpointContext.prevPoint?.pct).toBeNull();
      expect(change?.endpointContext.recentLevel?.pct).toBeNull();
      // The absolute figures are still real numbers — only the ratio is undefined.
      expect(change?.endpointContext.prevPoint?.absUsd).toBe(30);
    });

    it('fewer than two points is still null overall, unchanged by this record', () => {
      expect(changeAcross(series(100))).toBeNull();
      expect(changeAcross([])).toBeNull();
    });

    it('a flat series reports zero movement on all three readings', () => {
      const change = changeAcross(series(100, 100, 100, 100, 100, 100));

      expect(change?.pct).toBe(0);
      expect(change?.endpointContext.prevPoint?.pct).toBe(0);
      expect(change?.endpointContext.recentLevel?.pct).toBe(0);
    });
  });
});
