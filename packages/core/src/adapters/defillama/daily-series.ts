/**
 * The daily-series contract shared by every DeFiLlama capability that answers "how did X change" —
 * `dex.volume.history`, `chain.tvl.history`, `protocol.tvl.history`.
 *
 * **Extracted rather than re-written, and that is the point.** This arithmetic is where three
 * separate defects were found and fixed on `dex.volume.history` alone, none of them obvious and all
 * of them silent:
 *
 * - **L-1** — `gapDays` was counted against the span of the RETURNED points, which makes a gap at
 *   the leading edge arithmetically unreachable: move the hole to the window's first day and the
 *   answer claimed "no missing steps".
 * - **L-4** — two points landing in one day inflated the point count while leaving `gapDays` at 0,
 *   so a duplicate MASKED exactly one genuine missing day.
 * - **L-5** — a vendor that published nothing at all produced an empty series with `gapDays: 0`,
 *   which reads as "this thing has never existed" over a window where nothing was measured.
 *
 * A second capability re-deriving this by hand would re-earn all three. The invariant every caller
 * gets, and can state to ITS caller, is `points + gapDays === window.days` whenever a series was
 * requested — so a consumer can tell a gap from a zero without guessing.
 */

/** One day of a daily series. `ts` is epoch-ms UTC, floored to the day (DB-SCHEMA §1.2). */
export interface DailyPoint {
  ts: number;
  valueUsd: number;
}

export interface DailyWindow {
  /** The window ACTUALLY covered — `days` equals what was asked for whenever the subject has that
   * much history, and less when it does not. A caller comparing it with its request learns the
   * difference; one that does not still gets an internally consistent answer. */
  window: { fromMs: number; toMs: number; days: number };
  series: DailyPoint[];
  points: number;
  /** Daily steps MISSING inside the covered window. Counted, never stitched — an interpolated point
   * is a number nobody measured. */
  gapDays: number;
  /** Set when the returned series is not everything the vendor sent. NEVER set by ordinary
   * windowing, or the flag would decay into decoration that is always true. */
  truncated: { series: boolean; reason: string };
}

export const DAY_MS = 86_400_000;

/** Bitcoin's genesis-adjacent floor. A timestamp below it is a decoding error, not history. */
export const EARLIEST_PLAUSIBLE_TS_MS = Date.UTC(2009, 0, 3);

/**
 * Day-buckets, sorts and de-duplicates raw `(unixSeconds, value)` pairs.
 *
 * Bucketing is not merely a unit conversion: the window anchor below is floored to a day boundary,
 * so comparing raw timestamps against it made the newest point — the one that DEFINES the window —
 * fail `ts <= toMs` the moment the vendor published at anything other than exact midnight. At
 * `days: 1` that returned an empty series.
 *
 * `onInvalidValue` is called for a value that is not a finite non-negative number, so each caller
 * decides whether that is fatal (it is, for money) with its own message.
 */
export function bucketDailyPoints(
  entries: Iterable<{ tsSeconds: unknown; value: unknown }>,
  opts: { maxTsMs: number; onInvalidValue: (value: unknown, ts: number) => never },
): { points: DailyPoint[]; duplicateDays: number; seen: number } {
  const points: DailyPoint[] = [];
  let seen = 0;
  for (const entry of entries) {
    seen += 1;
    const { tsSeconds, value } = entry;
    if (typeof tsSeconds !== 'number' || !Number.isInteger(tsSeconds)) continue;
    const exactTs = tsSeconds * 1000;
    if (exactTs < EARLIEST_PLAUSIBLE_TS_MS || exactTs > opts.maxTsMs + DAY_MS) continue;
    const ts = Math.floor(exactTs / DAY_MS) * DAY_MS;
    // A malformed TIMESTAMP is a decoding question about one point and is dropped (it resurfaces as
    // a `gapDays` increment). A malformed VALUE means the document is not what we think it is, and
    // the caller is expected to throw — it must never be cached as a success.
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      opts.onInvalidValue(value, ts);
    }
    points.push({ ts, valueUsd: value });
  }
  points.sort((a, b) => a.ts - b.ts);

  let duplicateDays = 0;
  const deduped: DailyPoint[] = [];
  for (const point of points) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.ts === point.ts) {
      // Last value for a day wins; the collision COUNT is a drift signal, so it is surfaced rather
      // than swallowed (L-4).
      deduped[deduped.length - 1] = point;
      duplicateDays += 1;
      continue;
    }
    deduped.push(point);
  }
  return { points: deduped, duplicateDays, seen };
}

/**
 * Windows a de-duplicated daily series and computes the gap/truncation contract.
 *
 * `subject` names what the window is about, and appears only in `truncated.reason`.
 */
export function windowDailySeries(
  deduped: DailyPoint[],
  opts: {
    days: number;
    includeSeries: boolean;
    duplicateDays: number;
    /** Fallback anchor when the vendor published nothing — normally the document's own fetch time. */
    fallbackNowMs: number;
  },
): DailyWindow {
  // WINDOW. Anchored on the NEWEST POINT the vendor actually has, never on "now": the series is
  // daily and the current day is not published until it closes, so anchoring on the clock would
  // report a phantom gap at the end of every window.
  const lastTs = deduped.length > 0 ? deduped[deduped.length - 1]!.ts : opts.fallbackNowMs;
  const toMs = Math.floor(lastTs / DAY_MS) * DAY_MS;
  const requestedFromMs = toMs - (opts.days - 1) * DAY_MS;
  const windowed = deduped.filter((point) => point.ts >= requestedFromMs && point.ts <= toMs);

  // TRUNCATION — a granularity-drift guard. Day-bucketing makes "more distinct days than the window
  // holds" impossible, so this is defence in depth rather than a live branch; `truncated` keeps its
  // meaning of "you did not get what you asked for", never ordinary windowing.
  const cappedByWindow = windowed.length > opts.days;
  const series = cappedByWindow ? windowed.slice(-opts.days) : windowed;
  const returnedSeries = opts.includeSeries ? series : [];
  const foldedDuplicates = opts.includeSeries && opts.duplicateDays > 0;

  // GAPS, counted against the WINDOW ACTUALLY COVERED, not against the span of the returned points
  // (L-1). `fromMs` is clamped to the first point we actually have, and the clamp is REPORTED, so a
  // short history becomes visible in `window` instead of hiding in a field nobody cross-checks.
  //
  // The clamp is conditioned on WHERE THE HISTORY STARTS, not on the first returned point — that
  // distinction is the whole difficulty. "The window's first day is missing" and "this subject has
  // no history that far back" return an identical series; what separates them is whether the vendor
  // has ANY point before the window.
  //
  // A series that was REQUESTED and came back EMPTY is the case neither rule covers (L-5): the whole
  // requested window is the honest count, because the vendor claims to cover this subject and
  // published no day of it.
  const earliestKnown = deduped[0];
  const historyStartsInsideWindow =
    earliestKnown !== undefined && earliestKnown.ts > requestedFromMs;
  const fromMs =
    returnedSeries.length > 0 && historyStartsInsideWindow ? earliestKnown.ts : requestedFromMs;
  const coveredDays =
    returnedSeries.length > 0
      ? Math.round((toMs - fromMs) / DAY_MS) + 1
      : opts.includeSeries
        ? opts.days
        : 0;

  return {
    window: { fromMs, toMs, days: returnedSeries.length > 0 ? coveredDays : opts.days },
    series: returnedSeries,
    points: returnedSeries.length,
    gapDays: Math.max(0, coveredDays - returnedSeries.length),
    truncated: {
      series: cappedByWindow || foldedDuplicates,
      reason: cappedByWindow
        ? `vendor returned ${windowed.length} distinct days inside a ${opts.days}-day window — ` +
          `series capped at ${opts.days} (the source is documented as daily; check for granularity drift)`
        : foldedDuplicates
          ? `vendor sent ${opts.duplicateDays} extra point(s) for days already present — folded to one ` +
            `per day, last value wins (the source is documented as daily; check for granularity drift)`
          : '',
    },
  };
}

/**
 * The change across a window, computed from its own endpoints — the question WI-50 was filed for
 * ("на сколько процентов изменился TVL за 30 дней"), answered without making a caller do arithmetic
 * on a 90-point array.
 *
 * `null` when there is nothing to compare (fewer than two points), and `pct` is `null` on a zero
 * base rather than `Infinity`: "grew from nothing" has no percentage, and rendering one would be a
 * number nobody can act on. `fromTs`/`toTs` are the points ACTUALLY used, which are the first and
 * last present days — not necessarily the window's edges, because gaps are not stitched.
 */
/** One alternative endpoint for the same window — L-13's `endpointContext` entries. */
export interface EndpointAlternative {
  valueUsd: number;
  absUsd: number;
  pct: number | null;
}

/** How many trailing points the robust level is taken over, endpoint excluded. */
const RECENT_LEVEL_POINTS = 7;
/** Below this the median is not robust enough to be worth publishing. */
const MIN_RECENT_LEVEL_POINTS = 3;

/** `pct` on the SAME base as `change.pct`, with the same zero-base idiom (null, never Infinity). */
function pctFrom(fromUsd: number, absUsd: number): number | null {
  return fromUsd === 0 ? null : (absUsd / fromUsd) * 100;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // Length is guaranteed >= 1 by every caller, so both branches are defined.
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/**
 * The change across a window. ONE declaration, referenced by both history contracts on the
 * defillama adapter — they carried byte-identical inline copies until L-13 had to extend both, and
 * a shape duplicated in two places is a shape that drifts on the third edit.
 */
export interface WindowChange {
  fromTs: number;
  toTs: number;
  fromUsd: number;
  toUsd: number;
  absUsd: number;
  pct: number | null;
  /**
   * L-13 — the same window measured to two other endpoints, so a headline resting on a single
   * point is visible as such. Both are `null` when the series is too short to supply them.
   */
  endpointContext: {
    prevPoint: EndpointAlternative | null;
    recentLevel: (EndpointAlternative & { points: number }) | null;
  };
}

export function changeAcross(series: readonly DailyPoint[]): WindowChange | null {
  const first = series[0];
  const last = series[series.length - 1];
  if (first === undefined || last === undefined || first.ts === last.ts) return null;
  const absUsd = last.valueUsd - first.valueUsd;

  // L-13 — the SAME question measured against two other endpoints, so a caller can see whether the
  // headline rests on one point. Nothing here is a verdict: measured across five chains, a one-day
  // vendor artifact is SMALLER than the ordinary daily noise of the chain it appeared on
  // (berachain p90 = 17.5% against an artifact of ≈13%), so no magnitude test separates the two,
  // and at the last point of a window there is no next day to see a snap-back with. What can be
  // published honestly is the comparison itself; the reading stays with the caller.
  //
  // Both alternatives are measured from the SAME `first` as `absUsd`/`pct`, which is what makes
  // them directly comparable to the headline rather than a second, differently-based number.
  const prev = series[series.length - 2];
  const prevPoint: EndpointAlternative | null =
    // `series.length >= 3` — at two points `prev` IS `first`, and "the window ending at its own
    // start" is not an alternative reading, it is zero by construction.
    prev !== undefined && series.length >= 3
      ? {
          valueUsd: prev.valueUsd,
          absUsd: prev.valueUsd - first.valueUsd,
          pct: pctFrom(first.valueUsd, prev.valueUsd - first.valueUsd),
        }
      : null;

  // Endpoint EXCLUDED: a level the endpoint helped compute could not disagree with it.
  const trailing = series.slice(Math.max(1, series.length - 1 - RECENT_LEVEL_POINTS), -1);
  const recentLevel =
    trailing.length >= MIN_RECENT_LEVEL_POINTS
      ? (() => {
          const medianUsd = median(trailing.map((p) => p.valueUsd));
          return {
            valueUsd: medianUsd,
            absUsd: medianUsd - first.valueUsd,
            pct: pctFrom(first.valueUsd, medianUsd - first.valueUsd),
            points: trailing.length,
          };
        })()
      : null;

  return {
    fromTs: first.ts,
    toTs: last.ts,
    fromUsd: first.valueUsd,
    toUsd: last.valueUsd,
    absUsd,
    pct: first.valueUsd === 0 ? null : (absUsd / first.valueUsd) * 100,
    endpointContext: { prevPoint, recentLevel },
  };
}
