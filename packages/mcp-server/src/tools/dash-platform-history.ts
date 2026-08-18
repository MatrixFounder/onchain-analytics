import { canonicalizeChain, ChainInputSchema } from '@onchain-intel/core';
import { z } from 'zod';
import type { CapabilityResolver } from '@onchain-intel/core';
import {
  DeadlineMsInputSchema,
  resolveCapability,
  type MergedCacheMeta,
  type TimingMeta,
} from './resolve-capability.js';
import { defineTool } from './registry.js';
import { contractViolation } from './contract-violation.js';

/**
 * `onchain_dash_platform_history` — the 14th tool (T-013, OD-T013-1, R-170/R-171).
 *
 * **This module ships WITHOUT its tool-definition call, on purpose** (task 013-7, PLAN §0.8).
 * `tool-spec.test.ts` counts the modules that make that call and requires the count to equal
 * `toolSpecs.length`; a module carrying its own spec but no registry entry makes that 14 against
 * 13 and fails the suite at this task's own boundary. The spec constant, the definition call and
 * the `toolSpecs` entry land together in 013-8. Everything else — schemas, handler, types — is
 * here and is already gated by `contract-violation.test.ts`, which reads the directory rather than
 * the registry.
 *
 * **That gate matches on RAW SOURCE, comments included** — it greps each file for the call's
 * opening text with no comment stripping, and its own docstring records the assumption that no
 * file in `src/` contains that text in prose. An earlier draft of THIS comment quoted the literal
 * to explain itself and pushed the count to 14 while the module still had no call in it. So the
 * text is described here and never reproduced; 013-8, which edits that gate, inherits the same
 * constraint.
 *
 * **Constants and helpers live ABOVE where the call will go**, because the same gate slices the
 * source from that point to end-of-file and collects every two-space-indented `capability:` line
 * it finds. A second such line below the call would fail it for a reason unrelated to this tool.
 */

/**
 * Both capabilities this tool serves, as ONE constant (PLAN §0.11).
 *
 * The rule it satisfies: `tool-spec.test.ts`'s "names its capability once" gate knows two shapes —
 * `capability: CAPABILITY` beside a single `const CAPABILITY = '…'`, or `capability: null` with no
 * `resolveCapability(` in the module at all. This tool is neither, so the plan fixes the third
 * shape: one constant, the spec field referencing it BY NAME, and **no capability string literal
 * anywhere else in the module** — the handler indexes this array rather than writing either name
 * again. 013-8 teaches the gate that shape.
 *
 * Order is load-bearing only in that `SERIES_CAPABILITY` below maps onto it; it is not a rank.
 */
const SERVED_CAPABILITIES = ['privacy.shielded_pool.history', 'platform.metrics.history'] as const;

/** The selector a caller sends → the capability it resolves. One call resolves exactly ONE of them:
 * the two carry different `ttlSeconds`/`deadlineMs` in the manifest, and collapsing them into a
 * single request would have to pick one budget for two questions. */
const SERIES_CAPABILITY = {
  shielded_pool: SERVED_CAPABILITIES[0],
  platform_metrics: SERVED_CAPABILITIES[1],
} as const;

/** `pg-history`'s own `DEFAULT_HISTORY_LIMIT`. Mirrored, not imported, because it is that adapter's
 * private constant; the number matters here only as the threshold past which this tool must warn
 * that the ceiling is the SOURCE's and not the caller's. */
const PG_HISTORY_ROW_CEILING = 100;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** The adapter id whose row ceiling `truncated` reports on. */
const PG_HISTORY_ADAPTER_ID = 'pg-history';

export const DashPlatformHistoryInputSchema = z
  .object({
    /** Not hardcoded to `'dash'` even though both capabilities are Dash-only today: the tool NAME
     * fixes the domain, the input stays general, and a future non-Dash adapter for these
     * capabilities does not force a rename. The precedent is every other chain-scoped tool. */
    chain: ChainInputSchema,
    /** Which of the two series to read. Required — there is no sensible default between two
     * different quantities. */
    series: z.enum(['shielded_pool', 'platform_metrics']),
    /** Caps the points returned PER GROUP. Cuts this tool's output, never `pg-history`'s SELECT,
     * which this task is forbidden to rewrite. */
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  })
  .extend({ deadlineMs: DeadlineMsInputSchema })
  .strict();
export type DashPlatformHistoryInput = z.infer<typeof DashPlatformHistoryInputSchema>;

/** One observation, projected straight from the canonical `Snapshot` (DB-SCHEMA §1.7).
 * `valueRaw` stays a STRING and is never parsed into a `Number` — credits exceed 2^53. */
const HistoryPointSchema = z
  .object({
    ts: z.number().int(),
    asset: z.string(),
    valueRaw: z.string(),
    valueNum: z.number().optional(),
    source: z.string(),
  })
  .strict();

export const DashPlatformHistoryOutputSchema = z
  .object({
    chain: ChainInputSchema,
    /** Echo of the selector, so a response is self-describing when it is read apart from its
     * request. */
    series: z.enum(['shielded_pool', 'platform_metrics']),
    /**
     * Points GROUPED BY `metric`, never a flat array (owner decision `OQ-T013-1`, 2026-08-05).
     *
     * The grouping is what makes the `shielded_pool` answer honest: its two participants write
     * genuinely different quantities (`shielded_pool_shield_amount` — inflow per transaction;
     * `shielded_pool_balance_credits` — the balance), and a flat array would invite a reader to
     * plot two different things as one line. `platform_metrics` gets the same shape for the same
     * money, plus it genuinely has up to four metrics.
     */
    groups: z.array(z.object({ metric: z.string(), points: z.array(HistoryPointSchema) }).strict()),
    /** Participants that contributed nothing, forwarded from `CapabilityResolution.missingSources`
     * UNDER THE SAME NAME (R-171(e)). The single carrier of "a source did not contribute" — it is
     * deliberately NOT folded into `window`, where a reader looking for coverage would not find it. */
    missingSources: z
      .array(z.object({ adapterId: z.string(), reason: z.string() }).strict())
      .optional(),
    /** Best-effort span of what came back. Two participants have different effective windows, and
     * reconciling them exactly is explicitly not required for acceptance (R-171(f)); it carries no
     * diagnostics about missing participants. */
    window: z.object({ fromMs: z.number().int(), toMs: z.number().int() }).strict().optional(),
    truncated: z.object({ series: z.boolean(), reason: z.string() }).strict(),
    /**
     * Q-9 — the DATA provenance of this response, and the reason it is a set and not a scalar.
     *
     * The scalar `source` this replaces held `outcome.cache.provider` — WHICH CACHE ENTRY served
     * the call. On every other tool in this server that coincides with the data provenance, because
     * one adapter answers. This is the one tool where a single answer cannot be right: a
     * `shielded_pool` response carries `platform-explorer` points beside `derived` ones, and the
     * root said `platform-explorer` — confidently, and about half the payload.
     *
     * Derived from `groups[].points[].source`, which Q-9's own `Do-not` names as the correct field
     * and the one a consumer should be steered toward. Deriving it there rather than forwarding
     * `CapabilityResolution.sources` is deliberate: the registry tracks ADAPTER IDS
     * (`platform-explorer`, `pg-history`) while the points carry PROVENANCE LABELS
     * (`platform-explorer`, `derived`), and `derived` is a distinct registered provenance that
     * hides a healed metric if it is collapsed into the vendor's name (DB-SCHEMA §1.6/§1.8, L-2).
     * Forwarding the adapter ids would have replaced one contradiction with another.
     *
     * By construction this can never disagree with the points beneath it.
     *
     * The cache provenance did not disappear — it was already published, correctly named, in
     * `_meta.cache` (`provider` / `perSourceCache`). The scalar was a second copy of it wearing a
     * name that means something else on every sibling tool.
     */
    sources: z
      .array(z.string())
      .describe(
        'Every distinct provenance present in this response, sorted — e.g. ["derived", ' +
          '"platform-explorer"]. `derived` means the engine computed the value exactly from other ' +
          'measured fields and is not the vendor asserting it. For which SOURCE served each point, ' +
          'read points[].source; for which CACHE answered, read _meta.cache.',
      ),
    fetchedAt: z.number().int(),
  })
  .strict();
export type DashPlatformHistoryOutput = z.infer<typeof DashPlatformHistoryOutputSchema>;

/**
 * This tool's `_meta.cache` — the shared `MergedCacheMeta`, deliberately not `CacheMeta` (R-174(e)).
 *
 * **Declared in `resolve-capability.ts` beside `CacheMeta`, not here** (013-8): `ToolOutcome.cache`
 * has to accept it, so `registry.ts` needs to name the type, and a mechanism file importing a
 * concrete tool would invert the dependency the tool registry is built to avoid. The alias is kept
 * so this module's own exports still read in its vocabulary.
 */
export type DashPlatformHistoryCacheMeta = MergedCacheMeta;

export interface DashPlatformHistoryContext {
  registry: CapabilityResolver;
}

export type DashPlatformHistoryOutcome =
  | {
      ok: true;
      value: DashPlatformHistoryOutput;
      cache: DashPlatformHistoryCacheMeta;
      timing?: TimingMeta;
      capability: string;
    }
  | { ok: false; reason: string; refusalClass?: string; capability: string };

/**
 * `capability` is REQUIRED on both arms here, and optional on `ToolOutcome` (task 014-30,
 * `OD-014-30-12`).
 *
 * This tool's spec declares `capability: null` because it serves two, so the wrapper has no static
 * value to record and `servedCapabilities` cannot supply one — that array is not ordered by
 * meaning. The choice is made from `input.series` before anything else happens, so every path out
 * of this handler knows it, and requiring the field is what keeps a future path from forgetting.

/** One point as this tool PUBLISHES it — the canonical `Snapshot` minus `metric`, which the
 * enclosing group already names. Derived from the schema so the two cannot drift. */
type HistoryPoint = z.infer<typeof HistoryPointSchema>;
type HistoryGroup = { metric: string; points: HistoryPoint[] };

/** One canonical point as it arrives from the merge walk, before this tool projects it. */
interface RawSnapshot {
  metric: string;
  asset: string;
  ts: number;
  valueRaw: string;
  valueNum?: number;
  source: string;
}

/**
 * Groups points by `metric`, preserving first-seen order for the groups and walk order within each.
 *
 * First-seen order rather than alphabetical: the merge walk emits rank order, so the
 * highest-ranked participant's metrics lead, which is the order a reader most likely wants. No
 * group is ever synthesized — a metric absent from the answer is absent from `groups`, never
 * present with an empty `points` array, because "we have no rows for this" and "this metric does
 * not exist here" are different statements and only the data can tell them apart.
 */
function groupByMetric(points: RawSnapshot[]): HistoryGroup[] {
  const groups = new Map<string, HistoryPoint[]>();
  for (const point of points) {
    // PROJECTED, not passed through: `metric` identifies the GROUP, so repeating it on every point
    // inside that group would be the same string restated once per row. The output schema is
    // `.strict()`, which turns that redundancy into a contract violation rather than mere noise —
    // and it caught exactly this on the phase-1 run. `valueNum` is spread conditionally because it
    // is genuinely optional on `Snapshot` and `{valueNum: undefined}` is not the same as absent.
    const projected: HistoryPoint = {
      ts: point.ts,
      asset: point.asset,
      valueRaw: point.valueRaw,
      ...(point.valueNum !== undefined ? { valueNum: point.valueNum } : {}),
      source: point.source,
    };
    const existing = groups.get(point.metric);
    if (existing) existing.push(projected);
    else groups.set(point.metric, [projected]);
  }
  return [...groups].map(([metric, groupPoints]) => ({ metric, points: groupPoints }));
}

export async function dashPlatformHistoryHandler(
  input: DashPlatformHistoryInput,
  ctx: DashPlatformHistoryContext,
): Promise<DashPlatformHistoryOutcome> {
  const chain = canonicalizeChain(input.chain, ctx.registry.getChainRegistry());
  const limit = input.limit ?? DEFAULT_LIMIT;
  const capability = SERIES_CAPABILITY[input.series];

  const outcome = await resolveCapability(
    ctx.registry,
    capability,
    chain,
    { chain, limit },
    input.deadlineMs,
  );
  if (!outcome.ok) return { ...outcome, capability };

  const points = (Array.isArray(outcome.output) ? outcome.output : []) as RawSnapshot[];
  const grouped = groupByMetric(points);

  // `limit` is applied PER GROUP, so a four-metric answer is not rationed by whichever metric the
  // walk happened to emit first.
  let slicedAny = false;
  const groups = grouped.map((group) => {
    if (group.points.length <= limit) return group;
    slicedAny = true;
    return { metric: group.metric, points: group.points.slice(0, limit) };
  });

  // Two independent reasons, and the caller needs to be able to tell them apart — a caller that
  // asked for 10 and got 10 must not conclude the SOURCE ran out, and a caller that asked for 300
  // must learn the 100-row ceiling was the source's, not its own request. When both apply the
  // sentence says both, because dropping either one is what makes the other misleading.
  const pgContributed = (outcome.sources ?? []).includes(PG_HISTORY_ADAPTER_ID);
  const pgCeilingApplies = pgContributed && limit > PG_HISTORY_ROW_CEILING;
  const reasons: string[] = [];
  if (slicedAny) reasons.push(`this tool cut each group to the requested limit of ${limit}`);
  if (pgCeilingApplies) {
    reasons.push(
      `pg-history contributed and reads at most ${PG_HISTORY_ROW_CEILING} rows per call, ` +
        `which is fewer than the ${limit} requested`,
    );
  }
  const truncated = {
    series: slicedAny || pgCeilingApplies,
    reason: reasons.length > 0 ? reasons.join('; and ') : 'nothing was cut',
  };

  const allTs = groups.flatMap((group) => group.points.map((point) => point.ts));
  const window =
    allTs.length > 0 ? { fromMs: Math.min(...allTs), toMs: Math.max(...allTs) } : undefined;

  const candidate = {
    chain,
    series: input.series,
    groups,
    ...(outcome.missingSources !== undefined ? { missingSources: outcome.missingSources } : {}),
    ...(window !== undefined ? { window } : {}),
    truncated,
    // Q-9: derived from the points, so it cannot contradict them. Sorted for a stable contract —
    // the order adapters happen to be walked in is not information a consumer should depend on.
    sources: [
      ...new Set(groups.flatMap((group) => group.points.map((point) => point.source))),
    ].sort(),
    fetchedAt: Date.now(),
  };

  // `safeParse`, never `parse` — a provider result that fails the contract is reported, never
  // thrown out of the handler.
  const parsed = DashPlatformHistoryOutputSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ...contractViolation(capability, parsed.error), capability };
  }

  const cache: DashPlatformHistoryCacheMeta = {
    status: outcome.cache.status,
    ...(outcome.perSourceCache !== undefined ? { perSource: outcome.perSourceCache } : {}),
  };
  return {
    ok: true,
    value: parsed.data,
    cache,
    ...(outcome.timing ? { timing: outcome.timing } : {}),
    capability,
  };
}

export const dashPlatformHistoryToolSpec = defineTool({
  name: 'onchain_dash_platform_history',
  title: 'Dash Platform history (merged)',
  description:
    'Historical series for Dash Platform, MERGED from two free sources: platform-explorer ' +
    "(the vendor's own history) and pg-history (our own Postgres ledger, when ONCHAIN_PG_URL is " +
    'configured). Pick the series with "series": "platform_metrics" returns identities_total plus ' +
    'documents_total, data_contracts_total and platform_total_credits — the last three exist only ' +
    'in our ledger. "shielded_pool" returns TWO DIFFERENT quantities, grouped separately and ' +
    'never combined: shielded_pool_shield_amount (inflow into the private pool, per transaction, ' +
    'from platform-explorer) and shielded_pool_balance_credits (the pool BALANCE, from our ' +
    'ledger). Points are always grouped by metric, never a flat list. valueRaw is an exact ' +
    'integer string — do not parse it as a float. When a source could not contribute, ' +
    'missingSources names it and why, and the answer still returns what the other source had. ' +
    'Both series are served on Dash only today — call onchain_list_chains with capability ' +
    '"platform.metrics.history" to see where each is available.',
  capability: null,
  servedCapabilities: SERVED_CAPABILITIES,
  needs: ['registry', 'principal'],
  inputSchema: DashPlatformHistoryInputSchema,
  outputSchema: DashPlatformHistoryOutputSchema,
  handler: async (input, ctx) => {
    const outcome = await dashPlatformHistoryHandler(input, ctx);
    // `capability` is forwarded on BOTH arms: it is what the trace row and the `tool.refused`
    // diagnostics event record for a tool whose spec declares none.
    return outcome.ok
      ? {
          ok: true,
          output: outcome.value,
          cache: outcome.cache,
          ...(outcome.timing ? { timing: outcome.timing } : {}),
          capability: outcome.capability,
        }
      : outcome;
  },
});
