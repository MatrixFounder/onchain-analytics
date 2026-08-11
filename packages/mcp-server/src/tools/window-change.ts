import { z } from 'zod';

/**
 * The `change` block shared by `onchain_chain_tvl_history` and `onchain_protocol_tvl_history`.
 *
 * ONE declaration on purpose. The two tools carried byte-identical inline copies of this schema
 * until L-13 had to extend both; the core side had the same duplication (`ChainTvlHistoryResult` /
 * `ProtocolTvlHistoryResult`) and was collapsed into `WindowChange` in the same change. A shape
 * written out twice is a shape that drifts on the third edit — and here the two copies are what a
 * caller compares across tools.
 */
const EndpointAlternativeShape = {
  valueUsd: z.number(),
  absUsd: z.number(),
  pct: z.number().nullable(),
};

export const WindowChangeSchema = z
  .object({
    fromTs: z.number().int(),
    toTs: z.number().int(),
    fromUsd: z.number().nonnegative(),
    toUsd: z.number().nonnegative(),
    absUsd: z.number(),
    pct: z.number().nullable(),
    endpointContext: z
      .object({
        prevPoint: z
          .object(EndpointAlternativeShape)
          .strict()
          .nullable()
          .describe(
            'The SAME window measured as if it ended one point earlier. null when the series is ' +
              'too short for that to be a different reading (fewer than 3 points).',
          ),
        recentLevel: z
          .object({ ...EndpointAlternativeShape, points: z.number().int().positive() })
          .strict()
          .nullable()
          .describe(
            'The same window measured to the MEDIAN of the trailing points, endpoint excluded ' +
              '(`points` says how many). null when fewer than 3 such points exist.',
          ),
      })
      .strict()
      .describe(
        'L-13 — the same question measured to two other endpoints, on the same base as `pct`, so ' +
          'they are directly comparable to it. This is CONTEXT, not a verdict: a one-day vendor ' +
          'artifact can be smaller than a chain’s ordinary daily noise, and at the last point of ' +
          'a window there is no later day that would reveal a snap-back — so the engine does not ' +
          'claim which reading is right. When `pct` and these two disagree sharply, the headline ' +
          'rests on a single point and the series is worth reading before quoting the number.',
      ),
  })
  .strict()
  .nullable()
  .describe(
    'Change across the window, already computed — answer "how much did TVL move" from this ' +
      'rather than by doing arithmetic on the series. null when there is nothing to compare; ' +
      'pct is null on a zero base, because "grew from nothing" has no percentage.',
  );
