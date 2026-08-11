import { num } from '../../case-lib.mjs';

/**
 * L-13 — `change.endpointContext`, shared by the two `*.tvl.history` capabilities.
 *
 * WHY THIS IS AN EVAL CASE AND NOT ONLY A UNIT TEST. The defect L-13 records shipped past a green
 * gate for one reason: no case looked at `change` beyond "does it carry a finite toUsd". The fix
 * then broke every chain live — a required field the built adapter did not yet produce — while all
 * 1380 unit tests stayed green, because the suite imports core from source and the server resolves
 * it from `dist`. Only a live call crosses that seam. So the field that exists to keep a caller from
 * trusting one point is itself checked only here.
 *
 * WHAT IS ASSERTED, AND WHY EACH ONE IS LOAD-BEARING:
 *
 *  1. `endpointContext` exists whenever `change` does. This is the exact shape of the outage above.
 *  2. Both alternatives are measured from the SAME `fromUsd` as the headline. This is the property
 *     the whole record rests on: re-base either one and the three numbers stop being comparable, the
 *     field turns into decoration, and nothing else in the repo would notice.
 *  3. `pct` agrees with `absUsd / fromUsd`. Catches a unit slip (ratio vs percent) that no type
 *     check can see.
 *  4. On a window long enough to supply them, neither alternative is null. Catches the detection
 *     going quiet — the failure mode where a field is present, well-formed, and always empty.
 *
 * A tolerance is used on every arithmetic comparison: these are float dollars off the wire, and an
 * exact-equality assertion here would fail on rounding rather than on a defect.
 */

const TOLERANCE_USD = 0.01;
const TOLERANCE_PCT = 1e-6;

/** Below this many points the implementation withholds one or both alternatives by design. */
const POINTS_THAT_MUST_SUPPLY_BOTH = 10;

function checkAlternative(alt, name, fromUsd, label, problems) {
  if (num(alt?.valueUsd) === null) {
    problems.push(`${label}: change.endpointContext.${name}.valueUsd is not a finite number`);
    return;
  }
  if (num(alt?.absUsd) === null) {
    problems.push(`${label}: change.endpointContext.${name}.absUsd is not a finite number`);
    return;
  }
  // (2) — measured from the headline's own base, which is what makes it comparable to `pct`.
  const expectedAbs = alt.valueUsd - fromUsd;
  if (Math.abs(alt.absUsd - expectedAbs) > TOLERANCE_USD) {
    problems.push(
      `${label}: change.endpointContext.${name}.absUsd=${alt.absUsd} but valueUsd-fromUsd=${expectedAbs} — ` +
        'the alternative is no longer measured from the same base as `change`, so comparing it to `pct` is meaningless',
    );
  }
  // (3) — percent, not ratio, and null only on a zero base.
  if (fromUsd === 0) {
    if (alt.pct !== null) {
      problems.push(`${label}: change.endpointContext.${name}.pct is not null on a zero base`);
    }
    return;
  }
  if (num(alt?.pct) === null) {
    problems.push(
      `${label}: change.endpointContext.${name}.pct is not a finite number on a non-zero base`,
    );
    return;
  }
  const expectedPct = (alt.absUsd / fromUsd) * 100;
  if (Math.abs(alt.pct - expectedPct) > Math.max(TOLERANCE_PCT, Math.abs(expectedPct) * 1e-9)) {
    problems.push(
      `${label}: change.endpointContext.${name}.pct=${alt.pct} but absUsd/fromUsd*100=${expectedPct}`,
    );
  }
}

export function endpointContextIntegrity(change, label, seriesLength) {
  // `change: null` is a legal answer (fewer than two points, or a protocol not deployed here) and
  // carries no context by definition.
  if (change === null || change === undefined) return [];

  const problems = [];
  const ctx = change.endpointContext;

  // (1)
  if (ctx === null || typeof ctx !== 'object') {
    return [
      `${label}: change is present but change.endpointContext is missing — the single-point ` +
        'guard L-13 added is gone from the live response',
    ];
  }
  if (!('prevPoint' in ctx) || !('recentLevel' in ctx)) {
    problems.push(`${label}: change.endpointContext is missing prevPoint or recentLevel`);
    return problems;
  }

  const fromUsd = num(change.fromUsd);
  if (fromUsd === null) {
    problems.push(`${label}: change.fromUsd is not a finite number — nothing can be based on it`);
    return problems;
  }

  if (ctx.prevPoint !== null)
    checkAlternative(ctx.prevPoint, 'prevPoint', fromUsd, label, problems);
  if (ctx.recentLevel !== null) {
    checkAlternative(ctx.recentLevel, 'recentLevel', fromUsd, label, problems);
    const points = num(ctx.recentLevel.points);
    if (points === null || points < 3) {
      problems.push(
        `${label}: change.endpointContext.recentLevel.points=${ctx.recentLevel.points} — a median ` +
          'over fewer than 3 points is not the robust level this field claims to be',
      );
    }
  }

  // (4) — the detection going quiet on a window that can clearly supply both.
  if (typeof seriesLength === 'number' && seriesLength >= POINTS_THAT_MUST_SUPPLY_BOTH) {
    if (ctx.prevPoint === null) {
      problems.push(
        `${label}: ${seriesLength} points in the window and prevPoint is still null — the ` +
          'alternative reading is being withheld where it is available',
      );
    }
    if (ctx.recentLevel === null) {
      problems.push(
        `${label}: ${seriesLength} points in the window and recentLevel is still null — the ` +
          'robust level is being withheld where it is available',
      );
    }
  }

  return problems;
}
