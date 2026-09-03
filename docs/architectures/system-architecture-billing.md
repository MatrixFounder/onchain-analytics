> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md) → [system-architecture.md](system-architecture.md).
> Heading levels are the parent document's, unchanged: the section numbers are how
> every other document addresses this text.

### 3.5. T-015 — the client billing ledger and the provider call gate

Two independent mechanisms, sharing one requirement each. Neither adds a second gate where an
existing one generalizes. Neither puts a client-facing fact where a vendor-facing one already lives.

`data-model.md` §4.6 owns the tables. This section owns where each mechanism runs and why. It is
grounded in the tool wrapper §3.4.3 already names — its interception-point comment stands at
`packages/mcp-server/src/tools/registry.ts:466` today — and in the `BudgetStore` Postgres axis §3.4.8
already designs.

#### 3.5.1. `BillingStore` (R-1, R-2, R-5, R-7)

```ts
// PLANNED — packages/mcp-server/src/engine/billing-store.ts
export interface BillingReservation {
  readonly rowId: string;
  readonly state: 'reserved' | 'settled' | 'refunded';
  /** Present only when `state` was already terminal on arrival — the retry case (R-5.2, UC-2). */
  readonly existing: boolean;
}

/** The three values `reserve()`'s failure arm carries as `refusalClass` (task 015-04). A closed
 * union, not `string`: the wrapper (§3.5.2) is obligated to READ this value, never to supply a
 * literal of its own, and a fourth value becomes a compile error here rather than an unclassified
 * string in `request_trace.refusal_class`. `ReplayWindowExpiredError` is §3.5.2a's own third value
 * of the same field, not a separate carrier. */
export type BillingRefusalClass =
  'ClientCreditsExhaustedError' | 'BillingStoreUnavailableError' | 'ReplayWindowExpiredError';

export interface BillingStore {
  /**
   * Idempotent by (principalId, clientRequestId) — an existing row of ANY state short-circuits a
   * new write (§4.6.1). Under `credits_mode='metered'` this ALSO debits `access_profiles
   * .credits_balance_raw` atomically (`data-model.md` §4.6.1's "Balance arithmetic"), refusing with
   * NOTHING written to either table when the balance cannot cover `priceRaw` (mirrors
   * `checkAndReserve`'s "on ok:false nothing is written" contract) — see §3.5.3 for why this reads
   * R-3.3 at the taxonomy level rather than as "a row is written then reversed".
   *
   * **The failure arm carries `refusalClass` — REQUIRED, not optional** (task 015-04, closes
   * architecture review round 2 MAJOR-D). The precedent is `ResolveFailure.refusalClass`
   * (`packages/mcp-server/src/tools/resolve-capability.ts:200`), required there because
   * `request_trace.refusal_class` is `NOT NULL` behind a `CHECK` constraint on a refusal row.
   * `ClientCreditsExhaustedError` and `BillingStoreUnavailableError` are both returned as this
   * VALUE, never thrown (§3.5.2 step 4) — a throw would skip both the `request_trace` row and the
   * `tool.refused` diagnostics event the wrapper writes from `outcome`, the silence closing
   * architecture review round 1 BLOCKING-3 removed.
   */
  reserve(input: {
    principalId: string;
    accessProfileId: string | null;
    clientRequestId: string;
    tool: string;
    capability: string | null;
    priceRaw: string;
  }): Promise<
    | { ok: true; reservation: BillingReservation }
    | { ok: false; reason: string; refusalClass: BillingRefusalClass }
  >;
  /** Conditional `UPDATE … WHERE state = 'reserved'` (§4.6.1) — a no-op, not an error, when the row
   * already left `'reserved'`. First completer wins (§3.5.3). No balance effect (debited at reserve). */
  settle(rowId: string): Promise<BillingCompletionResult>;
  /** Conditional `UPDATE … WHERE state = 'reserved'`, PLUS crediting `priceRaw` back onto the
   * profile's balance under `metered`, in the same transaction as the state transition — **and only
   * when THIS call's own conditional `UPDATE` actually returned a row** (task 015-10, closes
   * architecture review round 2 MAJOR-C; the same "only when" `reserve()`'s own step 2 above uses:
   * "Only when step 1 inserted a NEW row"). An already-terminal row's `UPDATE` returns zero rows, and
   * a zero-row `UPDATE` credits nothing — a second `refund()` on one row (UC-2's retry reaching
   * completion twice) is therefore a no-op on the balance, not a second credit of `priceRaw`. */
  refund(rowId: string, reason: string): Promise<BillingCompletionResult>;
  /** `data-model.md` §4.6.1's AC-4 aggregate — Postgres axis only (R-7.3). MANDATORY, not optional
   * (§3.5.2's own note on why `ToolContext.billing` carries no `?`). */
  sumSettled(periodFromMs: number, periodToMs: number): Promise<string>;
}

/** `settle`/`refund`'s own return shape (task 015-10) — `written: true` when THIS call's own
 * conditional `UPDATE` actually transitioned the row; `false` when it found the row already
 * terminal (MAJOR-9's late-outcome case: something else — a concurrent completer, or `data-model.md`
 * §4.6.5's background reconciliation scan — closed it first). `false` is not an error; it is the
 * signal the wrapper (§3.5.3) reads to name a late outcome on stderr without reopening the row. */
export interface BillingCompletionResult {
  readonly written: boolean;
}
```

**Atomicity — the same pattern `checkAndReserve` already gives, restated per storage axis**
(R-1.2, mirroring §3.4.8's own restatement for the money gate). On SQLite, `reserve()` runs inside
`db.transaction(fn).immediate()`. On Postgres each statement is its own round trip. The sequence
below is therefore stated explicitly: it is the multi-table case §3.4.8's own single-statement
`usage` pattern does not have to solve, because `usage` never coordinates two tables.

**Under `credits_mode = 'unlimited'`** (phase 0's only profile, R-6.2), `reserve()` is the ORIGINAL
single statement:

```sql
INSERT INTO onchain.client_usage
  (id, principal_id, access_profile_id, client_request_id, tool, capability,
   price_raw, state, reserved_at, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8, $8, $8)
ON CONFLICT (principal_id, client_request_id) DO NOTHING
RETURNING id, state;
```

**Under `credits_mode = 'metered'`, one transaction, two statements, an idempotency-first order:**

1. The SAME conditional `INSERT` above, inside `BEGIN`. Zero rows ⇒ an existing row already answers
   this `client_request_id` (any state) — the balance is NOT touched, and the transaction commits as
   a no-op read. This order is what keeps a RETRY from double-debiting a balance that a prior attempt
   already charged.
2. Only when step 1 inserted a NEW row: the debit `UPDATE` of `data-model.md` §4.6.1. Zero rows
   (balance insufficient) ⇒ `ROLLBACK` — undoing step 1's insert too, so a refused reserve leaves
   NEITHER table written, on either resource.
3. `COMMIT`.

Both branches resolve UC-2 A1's race the same way. Two concurrent admissions of one id serialize on
`client_usage`'s unique index at step 1. Two concurrent admissions of DIFFERENT ids against the SAME
metered profile serialize on the `access_profiles` row lock step 2 takes.

**Why `BillingStore` lives beside `RequestTraceStore`/`DiagnosticsStore`, not beside `BudgetStore`.**
`data-model.md` §4.6's package-boundary note applies here too: `client_usage` carries `principalId`
and `accessProfileId`, so its store is designed and implemented in `packages/mcp-server`
(`security.md` §7.5.1). `packages/core` gains no new export for this task.

#### 3.5.2. The interception point — before `resolve()`, before the cache (R-2)

**The SAME wrapper §3.4.3 already names** (`packages/mcp-server/src/tools/registry.ts:466`, "The
interception point"). Today it resolves `principal`, pins `receivedAt`, mints `traceId`, and — after
the abort check — calls `definition.handler(...)`. R-2's reserve happens in that same span, after the
abort check and before the handler call.

The reason is plain: an aborted-before-start call already writes no `request_trace` row ("nothing is
billed for work nobody did", `packages/mcp-server/src/tools/registry.ts:531-533`). Reserving before
that check would bill a call that leaves no trace of having been admitted at all.

**`ToolContext.billing: BillingStore` is MANDATORY — no `?`, unlike its neighbor
`ctx.requestTrace?: RequestTraceStore`** (closes architecture review round 1 MAJOR-8). The two look
alike and are not. An absent `ctx.requestTrace` skips its write and serves the call anyway
(`OD-014-30-6`, `if (ctx.requestTrace === undefined) return result;`) — observability may degrade
without stopping traffic. R-3.7 requires the opposite of `BillingStore`: fail-closed.

An optional `ctx.billing` would let an unconfigured deployment serve every call for free, silently.
That is exactly the failure R-3.7 exists to forbid. `createServer`/`index.ts` therefore constructs a
`BillingStore` unconditionally, on every deployment profile: `local`, `network`, `network-sqlite` —
R-2.4 already requires the write on all three.

**Reading the client request id twice, deliberately, rather than moving the read.** Today
`readClientRequestId` runs inside `withTrace`, after the handler returns
(`packages/mcp-server/src/tools/registry.ts:624`). The reserve needs the SAME value earlier, so the
read runs a second time at the reserve point.

It is a pure function of `extra._meta` and `ctx.metaNamespace`. A second call therefore costs nothing
and cannot disagree with the first.

**The server-minted fallback, when the client supplies no id, is the SAME `traceId` already minted at
admission — not a second, independent ULID** (closes architecture review round 1 MINOR-3). This is
the identical rule `buildRequestTraceRow` applies (`clientRequestId ?? input.id`, §4.5.7's own
comment: "minted as this row's own id"). Minting a fresh id for the reserve instead would let
`client_usage.client_request_id` and `request_trace.client_request_id` disagree on one server-minted
request, breaking the join between the two ledgers UC-2's postcondition assumes.

**Pricing — resolved from `definition.capability ?? definition.name`, both already in the closure
before the handler runs** (`data-model.md` §4.6.2). No new dependency on the handler's own outcome.

**Order inside the reserve call, stated so `R-3.3`'s `ClientCreditsExhaustedError` and `R-3.7`'s
fail-closed both have one place to live:**

1. Read `access_profiles.credits_mode` through the existing `AccessProfileReader` (R-6.1) — the
   stdio principal's `accessProfileId` is `null`, so this step is skipped for it and the reserve
   proceeds as `unlimited` (R-6.2, no code path reads a profile that does not exist).
2. Under `credits_mode = 'metered'`, run `BillingStore.reserve()`'s own two-statement transaction
   (`data-model.md` §4.6.1's "Balance arithmetic", §3.5.1's atomicity note) — an atomic debit of
   `access_profiles.credits_balance_raw`, exact `numeric`/`BigInt` arithmetic, never `Number`.
   Insufficient balance refuses with `ClientCreditsExhaustedError`, and NEITHER table is written (the
   transaction rolls back) — see §3.5.3 for why this reads R-3.3 at the taxonomy level.
3. Under `credits_mode = 'unlimited'`, run the single idempotent `INSERT … ON CONFLICT DO NOTHING`
   of §3.5.1.
4. A `BillingStore` failure at either step — the reader unreachable, the transaction's connection
   lost — refuses with a new class, `BillingStoreUnavailableError` (R-3.7, fail-closed, closes
   `OQ-9`). No call is served for free because the ledger could not be reached.

```ts
// PLANNED — packages/mcp-server/src/engine/billing-errors.ts
export class ClientCreditsExhaustedError extends Error {
  /* R-3.3, closes OQ-2 */
}
export class BillingStoreUnavailableError extends Error {
  /* R-3.7, closes OQ-9 */
}
```

**Both refusals feed the SAME post-handler pipeline every other refusal already uses — they do NOT
take the abort-branch shortcut** (closes architecture review round 1 BLOCKING-3). That branch was the
round-1 draft's cited precedent, `packages/mcp-server/src/tools/registry.ts:541-557`, and the review
found it wrong: it `return`s before `withTrace` runs at all. Its own comment at `:531-533` says so —
"so nothing is billed for work nobody did" — the exact silence BLOCKING-3 named.

The wrapper's `outcome` variable is declared before the reserve step, not assigned solely from
`definition.handler(...)`:

```ts
// PLANNED — packages/mcp-server/src/tools/registry.ts, inside the wrapper
let outcome: ToolOutcome<TOutput>;
const reserved = await ctx.billing.reserve({/* … */});
if (!reserved.ok) {
  outcome = { ok: false, reason: reserved.reason, refusalClass: reserved.refusalClass };
  // definition.handler(...) is NEVER called — the call is refused before resolve()/the cache.
} else {
  outcome = await definition.handler(input, project({ ...ctx, principal, registry }, needs));
}
```

Everything downstream is UNCHANGED and therefore needs no new code. `resolvedCapability`
computation, the escalation check, `ctx.diagnostics?.emit('tool.refused', …)`
(`packages/mcp-server/src/tools/registry.ts:703-711`), and `withTrace` all read `outcome` exactly as
they do for a handler-produced refusal.

A `ClientCreditsExhaustedError`/`BillingStoreUnavailableError` refusal therefore writes a
`request_trace` row (`outcome='refusal'`, `refusal_class` set, `served_from='none'` —
`servedFromOf`'s existing `if (!ok) return 'none';`, no change needed) AND a `tool.refused`
diagnostics event. This satisfies R-3.3, R-3.4, AC-5 and AC-38: the operator reads these two classes
in the SAME place every other refusal already lands, not "nowhere but the client's own text."

#### 3.5.2a. The replay window — closes `ADR-003` OQ-G (R-5.6–R-5.9, closes architecture review round 1 MAJOR-11)

**What `OQ-G` left open, and the answer.** `ADR-003` `OQ-G` named two mechanisms for a replay inside
the window and left the choice to this phase. (i) re-run `resolve()`, relying on the cache still
holding the value. (ii) serve a recorded outcome addressed by the ledger row's own key, without
touching `resolve()` again. **This design chooses (i).** `data-model.md` §4.6.1's own closing
paragraph states the schema consequence: no captured response is added anywhere.

**Why (i) needs no new mechanism — it is what §3.5.1–§3.5.3 already build.** §3.5.1's `reserve()`
already returns `existing: true` on a conflicting `client_request_id`, as `ok: true`. The wrapper of
§3.5.2 already calls `definition.handler(...)` whenever `reserve()` returns `ok: true` — an
existing-row conflict included, not excluded. §3.5.3 already states the outcome in words: "Two
requests sharing one `client_request_id`… each run the full handler." Choosing (ii) instead would
have undone that already-reviewed design, not extended it.

**The window gates what a conflict means, not whether the lookup happens.** `reserve()`'s conflict
branch reads the SAME row §3.5.1 already reads for `existing: true`, and compares one value before
deciding what to return:

```ts
// PLANNED — packages/mcp-server/src/engine/billing-store.ts, reserve()'s conflict branch
const windowMs = Math.min(
  ttlFor(existingRow.capability ?? existingRow.tool) * 1000,
  REPLAY_AND_RECONCILE_CEILING_MS, // 120_000 — shared with `data-model.md` §4.6.5's own threshold
);
if (now() - existingRow.reservedAt <= windowMs) {
  return { ok: true, reservation: { ...existingRow, existing: true } }; // §3.5.1's ORIGINAL contract
}
return { ok: false, reason: 'replay window expired', refusalClass: 'ReplayWindowExpiredError' };
```

```ts
// PLANNED — packages/mcp-server/src/engine/billing-errors.ts, a third class in the same file
export class ReplayWindowExpiredError extends Error {
  /* R-5.7, closes ADR-003 OQ-G */
}
```

`reserve()`'s `ok: false` branch already needs a `refusalClass` field for `ClientCreditsExhaustedError`
and `BillingStoreUnavailableError` to reach `refusalClass` — §3.5.2's own pseudocode reads
`reserved.refusalClass`, one field the declared `BillingReservation`/`reserve()` shapes of §3.5.1 do not
yet carry. `ReplayWindowExpiredError` is a THIRD value of that already-implied field, not a new one.
The field itself was declared by task 015-04 as a REQUIRED, closed union on the failure arm
(`packages/mcp-server/src/engine/billing-store.ts`, `BillingRefusalClass`), so a fourth value is a
compile error rather than an unclassified string.

**Beyond the window, the refusal precedes every EFFECT of the reserve, exactly as R-3.5 states it
(closes R-5.7).** The class is RETURNED BY VALUE from the conflict branch above, never thrown —
the same rule architecture review round 1 BLOCKING-3 set for the other two money refusals. It
precedes any balance movement and any `resolve()` call, and no `client_usage` row is touched: the
existing row is someone else's already-terminal history and stays exactly as it was.

**It does NOT precede the `credits_mode` read, and an earlier edition of this paragraph said it
did (corrected 2026-08-27, task 015-08).** The conflict branch is reached from three call sites, and
two of them have already consulted the profile: `reserve()` reads `profiles.read(accessProfileId)`
to choose the branch, so only the `accessProfileId === null` path refuses without touching the
reader at all. Reading the mode is not an effect — it moves nothing and writes nothing — which is
why the invariants above hold regardless. The ordering claim was simply false, and a reader
building on "the replay refusal happens before the profile is consulted" would have built on it.

**Observed the SAME way `ClientCreditsExhaustedError`/`BillingStoreUnavailableError` already are —
reuses the fix for architecture review round 1 BLOCKING-3, not a new channel.** The refusal takes the
SAME `outcome = { ok: false, reason, refusalClass }` path §3.5.2 already builds, so it reaches
`withTrace` and writes a `request_trace` row (`outcome='refusal'`,
`refusal_class='ReplayWindowExpiredError'`, `served_from='none'`) plus the `tool.refused` diagnostics
event. It is observable without a new pipeline, even though it creates no billing resource — R-3.4's
channel and R-3.5's "no resource" rule both hold at once, rather than one being traded for the other.

**`_meta.cache.ageMs` is honest by construction, not by an added check (closes R-5.8).** A replay
inside the window re-enters `resolve()` a second time. `TwoLevelStore.get()`
(`packages/core/src/cache/two-level-store.ts:46-78`) computes `ageMs` fresh on every call it serves,
from whichever layer answers — a promoted hot entry is already back-dated to the value's ORIGINAL
write time (`two-level-store.ts:60-71`), never to the promotion moment. Choosing (ii) would have had
to build this honesty by hand, carrying the first response's own `ageMs` forward and adding the
elapsed time since. Choosing (i) gets it from a mechanism this codebase already has, for a reason
unrelated to replay.

**The price of (i), read from how eviction actually works rather than assumed** (per this brief's own
instruction to read `packages/core/src/cache/` first). The two layers `TwoLevelStore` composes evict
on different rules. The in-process hot layer (`LruHotLayer`) bounds itself by both count
(`DEFAULT_MAX_ENTRIES`, 500, `cache/lru.ts:8`) and serialized bytes (`DEFAULT_MAX_BYTES`, 16 MB,
`cache/lru.ts:27`), and evicts a LIVE entry under either pressure. The persistent layer does not.
`SqliteCacheStore` and `PgCacheStore` each delete a row only past its OWN `expires_at`. Each says so
explicitly — `cache/sqlite-store.ts:214`, "NOT a retention/size cap"; `pg/cache-store.ts:207`,
"NOT a retention or size cap" — independently worded, the same rule on both axes. `TwoLevelStore.get()`
falls through hot to cold on a hot miss (`two-level-store.ts:46-78`), so a hot-layer eviction ALONE
does not, on today's code, force a vendor call — the cold layer still answers.

**What actually forces the vendor call this design accepts paying for, unbilled, inside the window.**
Two triggers, neither a capacity effect. First: the ORIGINAL request's own cache write never reached
the persistent layer. `cache.set()` is already best-effort, and its failure already reaches stderr,
unchanged by this design (`packages/core/src/adapters/registry.ts:1328-1333`) — a transient write
failure on request #1 leaves nothing for request #2 to find, even though billing already settled.
Second: the four capabilities whose `windowMs` equals their OWN `ttlSeconds`, not the 120 000 ms
ceiling (`gas.price`, `pairs.active` at 30 s; `token.price`, `wallet.balances.native` at 60 s,
`data-model.md` §4.6.1). A replay landing in the last moments of that TTL can find the persistent row
already expired — a boundary race, not an eviction.

**The leak this accepts is bounded, and the bound is stated rather than left implicit.** At most ONE
vendor call per replayed `client_request_id` goes unbilled by this mechanism, never a compounding
number. The ledger's own idempotent completion (§3.5.3, "first completer wins") already guarantees the
CLIENT is charged exactly once, regardless of how many times `resolve()` reaches the vendor. A
successful re-fetch also repopulates the persistent cache with a fresh TTL. A THIRD replay of the
SAME id — the window's anchor is `reserved_at` (`data-model.md` §4.6.1), not a clock that resets per
replay — finds a cache hit again. R-5.6's own ceiling additionally bounds how long any id stays
replay-eligible at all before R-5.7 retires it.

**Why this is accepted rather than closed by choosing (ii) instead.** (ii) removes the leak above, at
the cost of a NEW obligation this design would then have to build and keep correct:

- store a captured response, or a pointer to one, surviving independently of the cache's own
  lifecycle;
- decide what happens when that stored artifact is gone while the ledger row is not — a failure mode
  (ii) creates and (i) cannot have, because (i) keeps nothing that can go missing;
- reconstruct `ageMs` honesty by hand, instead of getting it free from `resolve()` running again.

(i)'s price is a rare, bounded, already-partly-observed vendor cost. (ii)'s price is a second storage
lifecycle with its own failure mode, to close a leak this subsection has just bounded to "at most one
call, never compounding." The smaller, better-understood cost is the one this design accepts.

#### 3.5.3. Settle and refund at completion (R-3)

**In the wrapper's own body, after `outcome` is computed — NOT folded into `withTrace`** (task
015-10, closes architecture review round 2 MAJOR-B; corrects an earlier edition of this section that
placed the call inside `withTrace`). `withTrace`'s own first line
(`packages/mcp-server/src/tools/registry.ts:760`, `if (ctx.requestTrace === undefined) return
result;`) returns early whenever `ctx.requestTrace` is absent — the `local` profile's own shape
(`packages/mcp-server/src/index.ts:248`, `...(identity === null ? {} : { requestTrace: … })`, which
is exactly `transport !== 'http'`, §3.4.1). `ctx.billing`
carries no such `?` (§3.5.2's own note on why it is mandatory). A reservation opened on EVERY profile
must close on every profile too, so its completion cannot sit downstream of a check only one of them
satisfies. Placed inside `withTrace`, `local` would never close a single `client_usage` row. R-2.4
and R-3 would then hold on `network`/`network-sqlite` and silently not hold on the axis the ledger is
declared to write on at all.

Both branches of `outcome` reach the completion step identically. The refused-reserve arm
(`!reserved.ok`) has no reservation to close and skips it; every other arm makes one call after
`reserved.ok` is known true, before `withTrace` is even defined
(`packages/mcp-server/src/tools/registry.ts:709-741`):
`outcome.ok ? billing.settle(rowId) : billing.refund(rowId, refusalClass)`. A ledger failure here —
`settle`/`refund` throwing — never fails the request already computed. That is the same precedent
`withTrace`'s own catch states below for a lost trace row. The failure is named on stderr with the
row id, never silently absorbed, and never turned into a refusal the client did not otherwise earn.

**A late outcome — the row closes once, the SECOND completer's own `written: false` is not
silence.** `settle`/`refund` now report whether THIS call's own conditional `UPDATE` actually
transitioned the row (`BillingCompletionResult.written`, §3.5.1). When it did not, the row was
already terminal — closed either by a concurrent completer or by `data-model.md` §4.6.5's own
background reconciliation scan. The wrapper then names the row id on stderr rather than treating the
no-op as though nothing happened (closes architecture review round 1 MAJOR-9). The row's own
terminal state is left exactly as the first completer set it: a late `settle()` arriving after
reconciliation already refunded a row as `'expired'` does not resurrect a charge for it.

**The mapping is R-3, restated as one rule with one exception.** `outcome.ok === true` — whether
`request_trace.outcome` is `'answer'` or `'partial_deadline'` — settles at the full reserved price
(R-3.1, R-3.2; UC-1 main scenario and A3). `outcome.ok === false` refunds, for EVERY refusal class,
named or not (R-3.3, R-3.4). The rule does not branch on `refusalClass`'s value. A class that does
not exist today refunds by construction rather than by an added case (AC-35).

**A coalesced follower settles at full price too, with no special case (R-3, AC-7).** Billing runs
per REQUEST, at the wrapper, one layer above the singleflight coalescing `system-architecture.md`
§3.4.5 describes inside `resolve()`. Both the leader and the follower reach the wrapper as separate
calls, each reserves its own row, and both receive `outcome.ok === true` — coalescing is invisible
above `resolve()` by construction. One vendor call therefore produces two settled charges, which is
exactly what UC-1 A4 states, without a follower-specific branch anywhere in this section.

**Why `refusalClass` does not gate this decision.** The WRAPPING itself — folding every per-adapter
failure of a route into one `CapabilityUnavailableError` — happens inside `registry.resolve()`
(`packages/core`), not in `resolve-capability.ts`. `resolve-capability.ts`'s own `catch` block
(`packages/mcp-server/src/tools/resolve-capability.ts:320-328`) does something narrower. It RECORDS
whatever class name the thrown error already carries into `refusalClass`, verbatim
(`error instanceof Error ? error.name : 'NonErrorThrow'`). So for a route where every adapter fails,
`refusal_class` ends up `CapabilityUnavailableError`, regardless of which per-adapter cause produced
it. `refusal_class` cannot distinguish "budget exceeded" from "rate limit saturated" from the new
call-gate refusal of §3.5.4 at that layer. Only `outcome.reason`'s text can (§3.5.4 states where that
text is checked BY VALUE, R-11.4/AC-25). Billing needs none of that distinction: every refusal
refunds identically, so gating
on `outcome.ok` alone is not a simplification that loses information — it is the rule R-3 actually
states, applied literally.

**Idempotent completion — first completer wins.** `settle`/`refund` are the conditional
`UPDATE client_usage SET state = …, terminal_at = … WHERE id = $1 AND state = 'reserved'` of
`data-model.md` §4.6.1. Two requests sharing one `client_request_id` (UC-2 main scenario: a client
retry) each run the full handler and each reach this step. Whichever completes FIRST performs the
transition; the second's `UPDATE` matches zero rows. This is what makes UC-2's postcondition
literal — "ровно одна ненулевая строка `settled`/`refunded` на X" — rather than a race the last
writer happens to win. The FIRST writer wins, by the `WHERE state = 'reserved'` guard, regardless of
arrival order at this line.

**Why `ClientCreditsExhaustedError` writes no row, even though R-3.3 lists it beside classes that
DO have one.** R-3.3's list is read here as a taxonomy of refusal CAUSES that must not escape the
`refunded` rule, not as a claim that each cause writes-then-reverses a row. Credit exhaustion is
detected INSIDE `reserve()` (§3.5.2 step 2), before any row exists to reverse — structurally the same
position `R-3.5` already names for a pre-principal refusal ("не создаёт резерва").

Writing a row and refunding it in the same transaction would record a reservation-and-reversal pair
for a call that never had a resource committed to it. The precedent this design applies rather than
reinvents is `checkAndReserve`'s own established contract: "on `ok:false` NOTHING is written… not a
rollback of a partial write — there never was one" (`packages/core/src/cache/budget-store.ts:50-51`).
This reading is stated explicitly here, rather than left implicit, because it is the one
place this section resolves an ambiguity the requirement's wording leaves open.

#### 3.5.4. The daily call gate at the adapter boundary (R-9, R-11)

**`blockscout` gains an injected `BudgetStore` dependency, the same seam `nansen` already has**
(`packages/core/src/adapters/nansen/budget-gate.ts:232`, `NansenBudgetGateDeps`). A new sibling
module, `packages/core/src/adapters/blockscout/call-gate.ts`, exposes one function:

```ts
// PLANNED — packages/core/src/adapters/blockscout/call-gate.ts
export function createCallGate(deps: {
  provider: string; // the ceiling looked up is THIS id's, read once at construction
  budgetStore: BudgetStore;
  /** Injected, never read from `process.env` inside `core` (R-13.3a). `undefined` ⇒ the
   * `providers.config.ts` value in force. Mirrors `NansenBudgetGateDeps.dailyCreditCap`'s own
   * injection shape (`budget-gate.ts:232`). */
  dailyCallCeilingOverride?: number;
}): {
  ensureCallBudget(now: () => number): Promise<void>; // throws on refusal
} {
  /* looks up `dailyCallCeiling` from adapterRegistrations by `deps.provider` (refusing to
     construct if it reads 'none' for THIS provider — a call-gated provider must declare a real
     ceiling), takes the SMALLER of that ceiling and `deps.dailyCallCeilingOverride` when one is
     supplied — never the override outright, because the key is the `narrowing` class and may only
     restrict (`deployment.md` §10.3.1); the same `Math.min` `effectiveCeilingFor` already applies
     to `NANSEN_DAILY_CREDIT_CAP` — then calls
     budgetStore.checkAndReserve(deps.provider, dayBucketMs(now()), 0, Infinity, undefined,
       { ceiling: ceilingInForce }) — cost 0 and an unlimited credit ceiling, because blockscout
     has no credit dimension; only the dailyCalls branch of the SAME statement can refuse here. */
}
```

**Called once per network attempt, on all four gated routes, beside the existing `throttle()` call**
(R-9.7) — `packages/core/src/adapters/blockscout/index.ts:458`, immediately before
`await throttle('blockscout', rateLimit, weight, deadlineAtMs)`. Both guards run; either may refuse
first.

**On refusal, a new class distinct from the existing token-bucket saturation** (R-11.2, R-11.4):

```ts
// PLANNED — packages/core/src/adapters/blockscout/call-gate.ts
export class ProviderCallCeilingExceededError extends Error {
  constructor(public readonly reason: string) {
    super(`daily call ceiling reached: ${reason}`);
    this.name = 'ProviderCallCeilingExceededError';
  }
}
```

**How it reaches the caller.** §3.5.3 already establishes that `refusal_class` does not carry it
on a single-adapter route.

The same holds for `RateLimitRejectedError`, the EXISTING saturation refusal R-11.2 must be
distinguished from. It is not preserved as `refusal_class` either, for the identical reason —
`resolve-capability.ts`'s catch-all (§3.5.3).

What R-11.2/AC-24/AC-25 actually require is a message DISTINCT BY VALUE, inside `tried[].reason` and
`outcome.reason`. Today's `RateLimitRejectedError` already delivers exactly that: `error.message`,
which `CapabilityUnavailableError` concatenates verbatim from every adapter's own failure text
(`registry.ts`'s per-adapter catch). `ProviderCallCeilingExceededError`'s message
("daily call ceiling reached: …") shares no substring with `RateLimitRejectedError`'s
("rate limit"/"bucket"). A test asserting on that text — AC-25's "по значению, не по факту падения
любого исключения" — therefore passes on the new class and fails on the old one, and vice versa.

**Route-specific behaviour, unchanged from how a throw already propagates today (R-11.1, R-11.3,
UC-3, UC-4):**

- `entity.labels` (`['blockscout', 'nansen']`) — a throw from `blockscout.fetch()` is caught by the
  existing per-adapter loop and the walk falls through to `nansen`, exactly as any other blockscout
  failure does today. The escalation is recorded through the SAME channel R-28.1 already built
  (`request_trace.escalated_to_paid`, `diagnostics` event `source.escalated_to_paid`) — no new
  observability path (R-11.1, AC-23).
- `token.holders`, `chain.transactions` (`['blockscout']`, no fallback) — the route exhausts and
  the call ends in `CapabilityUnavailableError`, carrying the distinct message in its `tried` list
  (R-11.2, AC-24).
- `gas.price` (`['rpc-evm', 'blockscout']`) — reached only on chains with no curated RPC (`rpc-evm`
  first). A refusal here removes the free fallback for exactly those chains. There is no paid
  escalation on this route by construction (R-11.3): the route names no third adapter.

**Verification threshold — a narrowing operator setting, not a compiled constant** (R-10.1, R-10.2,
R-12.1). `providers.config.ts` declares `blockscout.dailyCallCeiling` at ≈625, tagged
`"estimate ADR-003 D6, not measured"` (`data-model.md` §4.6.3/§4.6.4). An optional env key,
`BLOCKSCOUT_DAILY_CALL_CAP`, overrides it with a positive integer for the synthetic low-threshold run
R-12.1 requires (UC-7 step 1) and is unset in production. No `off` sentinel is offered here — R-9.6
makes a declared ceiling mandatory for this provider, so disabling it is not an admissible
configuration.

**The key is EnvSchema's, narrowing class, and reaches `core` only by injection** (closes
architecture review round 1 MAJOR-4; `deployment.md` §10.3 carries the row, §10.3.1 the
classification). `mcp-server`'s `index.ts` parses it — validated as a positive integer by `EnvSchema`,
the same discipline `NANSEN_DAILY_CREDIT_CAP` already gets — and passes it as
`createCallGate`'s `dailyCallCeilingOverride`. No code in `packages/core` reads `process.env` for
this value; R-13.3a's static gate over direct `process.env` reads covers it the same way it already
covers the three Nansen keys.

**AC-42's own boundary, restated so the two additions do not collide.** `refillPerSec`
(`providers.config.ts:342`) and its "not a measured ceiling" comment are UNCHANGED by this section.
The daily call gate is a second, independent guard on the SAME provider, not a replacement for the
token bucket that already exists.
