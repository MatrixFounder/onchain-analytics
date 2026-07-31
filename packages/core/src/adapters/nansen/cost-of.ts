import type { NansenAccountState } from './account-state.js';
import { NANSEN_COST_TABLE, NANSEN_PREMIUM_LABELS_COST } from './cost-table.js';

const SMART_MONEY_NETFLOW = 'POST /api/v1/smart-money/netflow';
const TGM_HOLDERS = 'POST /api/v1/tgm/holders';
const SEARCH_GENERAL = 'POST /api/v1/search/general';
const SEARCH_ENTITY_NAME = 'POST /api/v1/search/entity-name';
const PROFILER_ADDRESS_LABELS = 'POST /api/v1/profiler/address/labels';
const TGM_INDICATORS = 'POST /api/v1/tgm/indicators';
const TGM_TOKEN_INFORMATION = 'POST /api/v1/tgm/token-information';

// Nansen's premium-labels tier replaces a SINGLE `/tgm/holders` call's normal per-plan price with
// a flat surcharge when the caller passes `premium_labels: true` — task 005-3's own real,
// non-simulated refusal case (`docs/tasks/task-005-m2-alpha-paid.md` UC-3, §1 п.5: 150cr against a
// 100cr free-plan balance).
// `NANSEN_PREMIUM_LABELS_COST` is now GENERATED (code review round 2 fix — it used to be a
// hand-maintained `150` literal here, which could drift silently against the spec with zero
// diff), sourced from the SAME committed spec's `x-credit-cost-variants['premium_labels=true']`
// extension on that operation (`cost-table.ts`'s own docstring on that export explains why it
// isn't folded into the uniform `NANSEN_COST_TABLE` shape: the spec states ONLY a `pro` price for
// this variant, no `free`). Applied to BOTH plans here — conservative (never under-estimates),
// matching the same "free >= pro, safe direction" invariant the base 8-entry table already relies
// on (system-architecture.md §3.2 "Account-state").

/**
 * Fixed capability -> (method,path) list mapping (system-architecture.md §3.2 "Cost-table
 * generation", task 005-3's own capability table) — `undefined` means an unrecognized capability
 * id, handled as fail-closed `Infinity` by the caller below (R-37 MIN-3), the same as an endpoint
 * missing from `NANSEN_COST_TABLE`.
 */
function endpointsFor(cap: string, args: Record<string, unknown>): string[] | undefined {
  switch (cap) {
    case 'smart-money.flows':
      // Always BOTH calls, regardless of args (R-41 — never conditional on tokenAddress/chain).
      return [SMART_MONEY_NETFLOW, TGM_HOLDERS];
    case 'entity.labels':
      if (args['exhaustive'] === true) {
        // The expensive escalation path does NOT also duplicate the cheap search/tgm-holders
        // calls (system-architecture.md §3.2 capability table: "только /profiler/address/labels").
        return [PROFILER_ADDRESS_LABELS];
      }
      return typeof args['tokenAddress'] === 'string'
        ? [SEARCH_GENERAL, SEARCH_ENTITY_NAME, TGM_HOLDERS]
        : [SEARCH_GENERAL, SEARCH_ENTITY_NAME];
    case 'token.risk':
      // Always BOTH calls, regardless of args (R-43 — never conditional).
      return [TGM_INDICATORS, TGM_TOKEN_INFORMATION];
    default:
      return undefined;
  }
}

/**
 * Exact credit price of one `(cap, args)` request, summed from `NANSEN_COST_TABLE` under the
 * LIVE plan (`accountState.get()?.plan ?? 'free'` — R-36 "consistent default", conservative
 * before the first `/account` resync ever populates a snapshot). Never an estimate — this is the
 * exact number that will be reserved via `BudgetStore.checkAndReserve` (budget-gate.ts).
 *
 * Fail-closed (R-37 MIN-3): an unrecognized capability id OR an endpoint absent from
 * `NANSEN_COST_TABLE` (future capability/spec drift) resolves to `Number.POSITIVE_INFINITY`,
 * NEVER `0` — the caller (budget-gate.ts's `ensureBudget()`) checks `Number.isFinite(cost)`
 * BEFORE touching `BudgetStore`/the network, so an `Infinity` here never reaches a SQLite bind
 * parameter.
 */
export function costOf(
  accountState: NansenAccountState,
  cap: string,
  args: Record<string, unknown>,
): number {
  const endpoints = endpointsFor(cap, args);
  if (!endpoints) {
    return Number.POSITIVE_INFINITY;
  }

  const plan = accountState.get()?.plan ?? 'free';
  const premiumLabels = args['premium_labels'] === true;

  // PRICE AND REQUEST NOW AGREE (cycle-2 review L-2). This branch used to price a flag that
  // `postTgmHolders` never sent — a loaded gun: the day anyone added a passthrough arg,
  // `ensureBudget` would reserve 150 (155 for `smart-money.flows`) for a call the transport
  // actually prices at 5, and on a 100cr free plan that is a HARD REFUSAL of a call that would
  // have succeeded. The critic offered "delete the branch OR make the transport send the flag";
  // deleting it is NOT available here, because R-37 mandates the 150-vs-100 refusal test that
  // closes ROADMAP §M2 exit criterion #2 ("budget-guard реально режет… (тест)") — removing the
  // pricing would delete the acceptance criterion along with the dead code. So the transport was
  // fixed instead: `postTgmHolders` now forwards `premiumLabels` (`endpoints.ts`). The path stays
  // unreachable in production (no tool schema exposes the flag and all three are `.strict()`), but
  // price and request can no longer drift apart.
  let total = 0;
  for (const endpoint of endpoints) {
    if (endpoint === TGM_HOLDERS && premiumLabels) {
      total += NANSEN_PREMIUM_LABELS_COST;
      continue;
    }
    const price = NANSEN_COST_TABLE[endpoint];
    if (!price) {
      // Unknown (method,path) — R-37 MIN-3, fail-closed, NEVER 0. Not expected to trigger for
      // any of the hand-picked endpoints above; guards against future spec/table drift.
      return Number.POSITIVE_INFINITY;
    }
    total += price[plan];
  }
  return total;
}
