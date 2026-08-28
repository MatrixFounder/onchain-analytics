import { dayBucketMs } from '../../cache/day-bucket.js';
import { DAILY_CALL_EXHAUSTED_DETAIL, type BudgetStore } from '../../cache/budget-store.js';
import { adapterRegistrations } from '../../providers.config.js';

/**
 * The daily call gate at the `blockscout` adapter boundary (task 015-13/015-14, ADR-003 D6,
 * R-9/R-11, `system-architecture.md` §3.5.4). `blockscout` gains an injected `BudgetStore`
 * dependency, the same seam `nansen` already has (`../nansen/budget-gate.ts:232`,
 * `NansenBudgetGateDeps`).
 *
 * **`ensureCallBudget` (task 015-14/015-16).** Takes the SMALLER of `deps.dailyCallCeilingOverride`
 * (when supplied) and the declared ceiling read at construction — never the override alone — and
 * calls `deps.budgetStore.checkAndReserve(deps.provider, dayBucketMs(now()), 0, Infinity, undefined,
 * { ceiling: ceilingInForce })` — cost `0` and an unlimited credit ceiling, because `blockscout`
 * has no credit dimension; only the `dailyCalls` branch of that SAME statement can refuse there.
 *
 * **Why the smaller of the two, not the override outright (task 015-16, R-12.1).** The injection
 * point is the `narrowing` settings class (`deployment.md` §10.3.1), which means every admissible
 * value may only RESTRICT what the engine does. `deps.dailyCallCeilingOverride ?? declaredCeiling`
 * alone would fail that test the day an operator supplied a value ABOVE the declared ceiling: the
 * override would win outright and WIDEN the effective ceiling past the vendor-side estimate it is
 * meant to narrow. `Math.min(declaredCeiling, deps.dailyCallCeilingOverride)` mirrors
 * `effectiveCeilingFor()`'s own `Math.min(vendorCeiling, dailyCreditCap)`
 * (`../nansen/budget-gate.ts:307`) — the same rule already applied to the three Nansen brakes.
 *
 * **Counted on ADMISSION to a network attempt, never on a confirmed vendor answer (MINOR-6, task
 * 015-15).** `adapters/blockscout/index.ts`'s `request()` calls `ensureCallBudget(now)`
 * immediately before `throttle()` (`system-architecture.md` §3.5.4, "Called once per network
 * attempt"), and `checkAndReserve` commits its `usage.calls_made` increment the instant it answers
 * `{ok: true}` — before the limiter has run and long before a byte has left the process. **The
 * consequence, stated so a reader of `usage.calls_made` knows which quantity it is looking at:** an
 * attempt that `throttle()` goes on to reject, or that the network aborts mid-flight, is counted
 * anyway. `usage.calls_made` measures attempts ADMITTED past this gate, not calls the vendor
 * confirmed answering — the two coincide only when nothing downstream ever fails, and AC-26's own
 * live SQL measurement is the one place the difference is observable. Counting the CONFIRMED
 * response instead is not a fix available to this module: confirmation arrives strictly AFTER the
 * network attempt this gate exists to refuse BEFORE, so a gate keyed on it would admit every
 * attempt once, unconditionally, and refuse nothing.
 *
 * **Two defects, found on the shipped text 2026-08-28, both fixed here.** (1) Every refusal used
 * to re-throw as `ProviderCallCeilingExceededError(result.reason)` unconditionally, and that
 * class's own constructor already prefixes `daily call ceiling reached: ` — the store's OWN
 * exceeded-branch text used to start with the identical phrase, so the marker appeared twice in
 * one thrown message. (2) The SAME unconditional wrap also caught the store's fail-closed
 * refusals (a corrupted `credits_used` or `calls_made` value — a supported topology, several
 * writers can share `cache.sqlite3`), asserting "the ceiling is reached" about a refusal that
 * never established that. Fixed together: `checkAndReserve`'s exceeded-branch text now starts
 * with `DAILY_CALL_EXHAUSTED_DETAIL` (`cache/budget-store.ts`, carrying no marker of its own), and
 * `ensureCallBudget` below branches on THAT substring — only an exceeded refusal wraps as
 * `ProviderCallCeilingExceededError` (marker supplied exactly once, by the class); every other
 * refusal becomes `ProviderCallGateUnavailableError`, whose text never claims the ceiling was
 * reached (AC-25 — distinguished by text, not by which class was thrown).
 *
 * **Why `provider` arrives in the constructor, not the call.** The ceiling is read ONCE at
 * construction, and refusing on a declared `'none'` is therefore a refusal of CONSTRUCTION. A
 * per-call `provider` parameter would force the constructor to refuse on behalf of a provider it
 * has not seen yet.
 *
 * **Why this does not make the gate provider-specific** (AC-20). No branch in this module reads
 * `deps.provider`'s VALUE to change behaviour — it is only the lookup key into
 * `adapterRegistrations` and the argument forwarded to `checkAndReserve`. The same code path
 * serves `blockscout` today and any future call-gated free provider tomorrow.
 *
 * **This module is a NAMED exemption from `vendor-spend-gates.test.ts`'s TC-GATE-01** ("every
 * ledger write reports what it wrote"), because `cost` above is the literal `0` — this call can
 * never move `usage.credits_used`, the quantity that gate's reconciliation concern (R-27.3) is
 * about. It does move `usage.calls_made` (this task's own daily counter), and NOTHING reports that
 * write yet — `VendorChargeRecord` has no field for it and `onVendorSpend` is a per-REQUEST
 * parameter this module's documented signature does not carry. See the exemption's own comment in
 * `vendor-spend-gates.test.ts` for the full reasoning and the known-issue this gap is filed under
 * (`docs/issues/rf-16-daily-call-gates-usage-calls-made-write-has-no-vendor-spend-reporter.md`).
 */
/**
 * The object `createCallGate()` returns — the shape `BlockscoutAdapterDeps.callGate`
 * (`../blockscout/index.ts`, task 015-15) accepts. Named so the adapter's own deps interface can
 * reference the CONTRACT without re-declaring it inline, and so a future change to what the
 * constructor returns cannot drift the two apart silently.
 */
export type CallGate = { ensureCallBudget(now: () => number): Promise<void> };

export function createCallGate(deps: {
  /** Provider whose `dailyCallCeiling` the constructor reads. The provider is data the
   * CONSTRUCTOR carries, never the call. */
  provider: string;
  budgetStore: BudgetStore;
  /**
   * Injected; `process.env` inside `core` is never read (R-13.3a). `undefined` ⇒ the
   * `providers.config.ts` value in force. Mirrors `NansenBudgetGateDeps.dailyCreditCap`'s own
   * injection shape (`../nansen/budget-gate.ts:232-235`).
   */
  dailyCallCeilingOverride?: number;
}): CallGate {
  // Refusal of CONSTRUCTION, not of the first call — the provider is already known here, so an
  // undeclared/none ceiling names it in the thrown text rather than waiting for the first
  // `ensureCallBudget()` to discover it (`data-model.md` §4.6.3).
  const registration = adapterRegistrations.find((r) => r.id === deps.provider);
  const declaredCeiling = registration?.dailyCallCeiling;
  if (declaredCeiling === undefined || declaredCeiling === 'none') {
    throw new Error(
      `createCallGate: provider "${deps.provider}" does not declare a real dailyCallCeiling ` +
        `(reads ${JSON.stringify(declaredCeiling ?? null)}) — a call-gated provider must declare ` +
        `a positive integer ceiling`,
    );
  }

  // `Math.min`, not `??` — see this module's own docstring, "Why the smaller of the two, not the
  // override outright" (task 015-16, R-12.1). An override above `declaredCeiling` clamps down to
  // it rather than winning outright.
  const ceilingInForce =
    deps.dailyCallCeilingOverride === undefined
      ? declaredCeiling
      : Math.min(declaredCeiling, deps.dailyCallCeilingOverride);

  return {
    // Task 015-14: reads-and-increments `usage.calls_made` for `(deps.provider,
    // dayBucketMs(now()))` inside `checkAndReserve`'s own transaction, by delegating the
    // comparison to it rather than re-implementing it here — the same discipline
    // `docs/tasks/task-015-14-daily-call-counter.md`'s "one code gate on two providers" names
    // (AC-20): no branch below reads `deps.provider`'s VALUE, only forwards it.
    async ensureCallBudget(now: () => number): Promise<void> {
      const result = await deps.budgetStore.checkAndReserve(
        deps.provider,
        dayBucketMs(now()),
        0,
        Infinity,
        undefined,
        { ceiling: ceilingInForce },
      );
      if (result.ok) return;
      // Defect 2's fix: branch on the DETAIL substring, not on "any refusal from this call site".
      // `startsWith`, not `includes` — `DAILY_CALL_EXHAUSTED_DETAIL` is always the HEAD of the
      // exceeded-branch text on both axes (`cache/budget-store.ts`, `pg/budget-store.ts`), never
      // an embedded substring, so a stricter match cannot misfire on a coincidental occurrence.
      if (result.reason.startsWith(DAILY_CALL_EXHAUSTED_DETAIL)) {
        throw new ProviderCallCeilingExceededError(result.reason);
      }
      throw new ProviderCallGateUnavailableError(result.reason);
    },
  };
}

/**
 * The daily-call-ceiling refusal (R-11.4) — distinct from the existing token-bucket saturation
 * class, `RateLimitRejectedError` (`../../net/rate-limit.ts`). Precedent L-27: an unnamed limiter
 * refusal class cost a separate investigation specifically because it had no name.
 *
 * **Distinguished by VALUE, not by which class was thrown** (AC-25) — `resolve-capability.ts`'s
 * catch-all folds every per-adapter failure of a single-adapter route into one
 * `CapabilityUnavailableError`, so only the TEXT that reaches `tried[].reason`/`outcome.reason`
 * tells the two apart (`system-architecture.md` §3.5.3). The two texts share the provider's name
 * (full non-overlap is not achievable), so distinguishability is checked on the substrings that
 * DO differ: `daily call ceiling reached` and `throttle: rejected` each appear in exactly one of
 * the two texts; `rate limit` and `bucket` appear in neither of THIS class's own texts.
 */
export class ProviderCallCeilingExceededError extends Error {
  constructor(public readonly reason: string) {
    super(`daily call ceiling reached: ${reason}`);
    this.name = 'ProviderCallCeilingExceededError';
  }
}

/**
 * The daily call gate could not DECIDE whether the ceiling was reached (task 015-14, defect found
 * on the shipped text 2026-08-28) — every refusal `checkAndReserve` can return from THIS call site
 * other than the exceeded one: a corrupted `credits_used` or `calls_made` value read as neither a
 * number nor a numeric string (`cache/budget-store.ts`'s two `ledger value is not a finite number`
 * branches, `pg/budget-store.ts`'s upfront `undecidable comparison` check).
 *
 * **A SEPARATE class from `ProviderCallCeilingExceededError`, not a shared one with a different
 * `reason`.** The two assert DIFFERENT things to an operator reading `tried[].reason`: the ceiling
 * class asserts "this call was refused because the declared ceiling is reached today"; this class
 * asserts nothing about the ceiling — the ledger value itself was unreadable, and the ceiling may
 * not have been approached at all. Folding both into one class under one text would report a
 * corrupted ledger as exhaustion, sending an operator to raise a ceiling that was never the
 * problem (the topology this fail-closed branch defends against: `cache.sqlite3` is shared
 * per-machine, several stdio sessions can hold independent writer connections).
 *
 * **Its text must never contain `daily call ceiling reached`.** Task 015-15 registers a tenth
 * failure class keyed on exactly that substring
 * (`packages/mcp-server/src/transport/failure-classes.ts`, `/daily call ceiling reached: /i`) to
 * carry the refusal past `resolve-capability.ts`'s traversal marker to the caller. A refusal of
 * THIS class that happened to contain the phrase would be mis-filed as ceiling exhaustion by that
 * marker — a substring test cannot tell "asserted once, on purpose" from "present by accident".
 */
export class ProviderCallGateUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super(`daily call gate unavailable: ${reason}`);
    this.name = 'ProviderCallGateUnavailableError';
  }
}
