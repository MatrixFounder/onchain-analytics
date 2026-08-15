import { STDIO_PRINCIPAL, type Principal } from '../auth/principal.js';

/**
 * Who sees which `_meta` field (task 014-16, R-6, AC-6, AC-7, AC-49).
 *
 * **The table, verbatim from `interfaces.md` §5.4.4.** That document is the one this task quotes and
 * the only one of the three that expresses the profile narrowing: `security.md` §7.5.3 carries a
 * coarser role-keyed table (three rows) and `system-architecture.md` §3.4.3 a four-row one with no
 * `cache.provider` row at all. An implementer compiling the §3.4.3 table gets AC-6 right and AC-49
 * wrong, so the widest of the three is the one compiled here.
 *
 * **Why the table lives in its own module rather than beside the `_meta` declarations.** §5.4.4
 * property 1 asks for the class to be declared once, in a compiled table beside the type
 * declarations — but the three `_meta` types live in TWO modules (`resolve-capability.ts` holds
 * `CacheMeta`/`MergedCacheMeta`/`TimingMeta`, `budget-meta.ts` holds `BudgetMeta`), so "beside them"
 * would be two tables. One table in one file is the property; the address is the compromise.
 *
 * **An unlisted field is `operator`** (§5.4.4 point 3, R-6.4). The two directions of error are not
 * symmetric: a withheld field is a missing convenience, a leaked one is an operator fact in a
 * client's context, and R-20 forbids that permanently. So a field added later is withheld until
 * somebody classifies it — which is the whole reason the projection reads a table instead of a list
 * of deletions.
 */

export type VisibilityClass = 'client' | 'operator';

/**
 * Dotted paths, one per leaf. `cache.perSource` is an ARRAY, and it is classified as one leaf: the
 * entries are the disclosure, not any field inside them.
 */
export const META_VISIBILITY: Readonly<Record<string, VisibilityClass>> = Object.freeze({
  'cache.status': 'client',
  'cache.ageMs': 'client',
  'cache.capability': 'client',
  // client, and narrowed by the profile — see `routeDisclosureMode` below. The class does not
  // change; the setting removes the field for one principal at a time (§5.4.4.1).
  'cache.provider': 'client',
  'cache.perSource': 'client',
  'timing.overrunMs': 'client',
  'budget.provider': 'operator',
  'budget.creditsUsedToday': 'operator',
});

/** The three fields `route_disclosure_mode` governs (§5.4.4.1, R-20.4, AC-49). */
export const ROUTE_DISCLOSURE_META_PATHS = Object.freeze(['cache.provider', 'cache.perSource']);
export const ROUTE_DISCLOSURE_OUTPUT_FIELD = 'missingSources';

export interface MetaView {
  readonly principal: Principal;
  /**
   * `'full'` discloses the route, `'none'` removes the three fields. The setting only ever REMOVES
   * (§5.4.4.1): it never adds a field and never widens a class.
   */
  readonly routeDisclosureMode: 'full' | 'none';
}

/**
 * The view a caller that supplies none gets: the local operator, disclosure permitted.
 *
 * **Why a default exists at all.** `toCallToolResult` is called by the wrapper, which always has a
 * principal — but it is also the gate's one direct caller (task 014-25) and a `[STUB]`-era seam. The
 * default is the STDIO one, which is the only principal that can exist without a transport; making
 * it `user` instead would silently withhold `_meta.budget` from the local profile that UC-3 step 3
 * specifies it for.
 */
export const DEFAULT_META_VIEW: MetaView = Object.freeze({
  principal: STDIO_PRINCIPAL,
  routeDisclosureMode: 'full',
});

function visible(path: string, view: MetaView): boolean {
  if (view.routeDisclosureMode === 'none' && ROUTE_DISCLOSURE_META_PATHS.includes(path)) {
    return false;
  }
  // The default is `operator`, which is what makes R-6.4 hold by construction.
  return (META_VISIBILITY[path] ?? 'operator') === 'client' || view.principal.role === 'admin';
}

/**
 * Assembles every `_meta` object this server publishes (`system-architecture.md` §3.4.3 names this
 * function; it declares no signature, so `parts` is an OPEN record by design).
 *
 * **Why open and not the three known groups.** R-6.4 is a claim about fields nobody has added yet,
 * and a signature that admitted only `cache | timing | budget` would make that claim untestable —
 * there would be no way to hand it an unclassified field. Open, the rule has an input.
 *
 * Returns `undefined` when nothing survives, because `_meta: {}` is a different wire shape from an
 * absent `_meta` and three existing assertions distinguish them.
 */
export function metaFor(
  parts: Record<string, unknown>,
  view: MetaView,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [group, value] of Object.entries(parts)) {
    if (value === undefined) continue;
    // A scalar at the top level is its own leaf: `_meta.probe` is the path, and an unclassified one
    // is withheld from a client exactly like an unclassified nested field.
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      if (visible(group, view)) out[group] = value;
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const [field, leaf] of Object.entries(value as Record<string, unknown>)) {
      if (leaf === undefined) continue;
      if (visible(`${group}.${field}`, view)) kept[field] = leaf;
    }
    // A group emptied by the projection is dropped, not published as `{}` — the client learns
    // nothing from the shape of what it was not shown.
    if (Object.keys(kept).length > 0) out[group] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Removes `structuredContent.missingSources` when the profile forbids route disclosure.
 *
 * **It is the third governed field and it is NOT a `_meta` field**, which is why the setting is
 * applied beside `metaFor` rather than inside it: no `_meta` classification carries it
 * (`interfaces.md` §5.4.4).
 *
 * **The text mirror is removed with it.** `toCallToolResult` publishes the output twice — once as
 * `structuredContent` and once as `JSON.stringify(outcome.output)` in `content[0].text` — so
 * stripping the structured copy alone would disclose the adapter list in the text one. Measured, not
 * assumed: that mirroring is two lines apart in the same return statement.
 */
export function applyRouteDisclosure<T extends Record<string, unknown>>(
  output: T,
  view: MetaView,
): T {
  if (view.routeDisclosureMode === 'full') return output;
  if (!Object.hasOwn(output, ROUTE_DISCLOSURE_OUTPUT_FIELD)) return output;
  // A copy, never a mutation: the outcome object belongs to the handler, and a tool that read its
  // own output back after returning would see a field the renderer removed.
  const rest: Record<string, unknown> = { ...output };
  delete rest[ROUTE_DISCLOSURE_OUTPUT_FIELD];
  return rest as T;
}
