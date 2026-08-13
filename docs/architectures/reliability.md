# 9. Reliability and fault tolerance

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

### 9.1. Error handling

- **Hot-swap fallback (R-11):** a `fetch()`/`normalize()` failure **or** `isAvailable() === false`
  on the current adapter of a route moves the Registry on to the next `adapterId` in
  `route.adapterIds` instead of failing the whole call. `registry.fallback.test.ts` proves this on
  the **real** M1 configuration — `dash-platform.isAvailable()` is deterministically `false`, so
  `platform-explorer` answers — not on simulated unavailability.
- **Explicit unavailability (R-24):** a missing key or DSN makes `isAvailable()` return a
  structured reason **before** any network attempt — not a silent `undefined`, not a crash. When
  **every** adapter on the route is unavailable or has failed, the result is
  `CapabilityUnavailableError` carrying the list of `(adapterId, reason)`, and the tool answers
  `isError: true` with readable text that contains no secret values.
- **An uncovered `(capability, chain)` pair raises its own error class (TASK-006, R-51b):**
  `CapabilityNotCoveredOnChainError`, deliberately **not** merged with `CapabilityUnavailableError`
  even though both end up as `isError: true`. The two demand opposite reactions from the caller —
  "not here, and it will not be, look for an alternative" versus "this could work: supply the key,
  or retry later". Collapsing them would send an agent into an endless retry where retrying is
  pointless, and make it give up where adding an API key was all that was needed. The message
  carries both lists — the chains this capability _is_ served on, and the capabilities that _are_
  served on this chain — computed from the same two sources as the coverage predicate itself
  (`routes × chainSupport`), so they cannot drift from real behaviour. Both lists are truncated: an
  error whose stated purpose is to save the caller a wasted call must not itself dump 458 slugs
  into the model's context.
- **SHIPPED (T-012, tasks 012-7/012-8).** **A call deadline expiring is a THIRD, equally distinct
  outcome (ADR-002 D4, R-145) — not merged with either error above.**
  `CapabilityDeadlineExceededError` fires when the manifest's (narrowed-only, never widened, R-144)
  `deadlineMs` runs out before any adapter on the route satisfied the request. **One qualification
  the original wording did not have** (OD-4 review, 2026-08-05): a walk in which every source was
  entered and every one ANSWERED returns that answer past the ceiling and marks the overrun in
  `_meta.timing.overrunMs` — the ceiling bounds SPENDING, not the moment of delivery
  (`open-questions.md` OQ-T012-6). It reuses the SAME `tried` list `CapabilityUnavailableError` already
  carries — a deadline-caused skip is recorded there exactly like any other reason an adapter was
  never asked — so a partial walk still names which sources were never reached, rather than
  collapsing into an opaque timeout.

  🔴 **A deadline never returns a partial result as if it were an answer** (owner decision
  2026-08-03). ADR-002 D4 п.5 reads «ответил хотя бы один → частичный результат», but a deadline is
  a fact about OUR availability, and the H-1 doctrine two bullets above forbids publishing that as a
  fact about the DATA. Expiry therefore sets `hadFailure` and throws, naming both groups — which
  sources answered and which were never asked. Returning the surviving answer instead would report
  "this address has no entity labels" for a mixer or sanctioned address whenever the paid source
  merely failed to fit the budget: a false negative delivered with full authority, which is the
  exact defect H-1 exists to prevent. ADR-002 is amended to record the deviation (R-156), not
  silently contradicted.

  The one thing that error can NEVER mean: a paid request already
  paid for was cut off before it finished. Credits are reserved **inside** `fetch()`, at
  `gate.ensureBudget()` → `checkAndReserve()` (`packages/core/src/adapters/nansen/index.ts:657`, `// exactly the money-leak OQ-2's "structurally non-bypassable"`) — which happens
  **once, before** the 2–3 sub-calls that one reservation covers, not at each HTTP dispatch. The
  deadline stops being honoured at that **commit point**, so neither a sub-call nor a throttle wait
  _between_ sub-calls ever receives it: cancelling between sub-call 1 and sub-call 2 would pay for
  work we then throw away, which is the same loss D4 п.2 forbids. The limiter (`throttle()`) and
  the transport (`safeFetch()`) both gain the SAME optional `deadlineAtMs`, computed once per
  `resolve()` call and threaded down unchanged, rather than re-deriving a fresh per-step timeout —
  the latter is what produced the historical ~410s envelope.

  **What this bounds, stated as arithmetic rather than as a promise.** Because credits commit inside
  `fetch()`, the deadline governs only the phase before that commitment. For `entity.labels` that
  head has a **measured envelope of ~140s** — blockscout `30 + 4×5` = **50s**, plus the `/account`
  resync `30 + 4×15` = **90s**. The paid-composite tier **caps** it at ~60s: that number is a
  deliberate cut, not a measurement, so a head that would have run longer now fails with
  `CapabilityDeadlineExceededError` instead of reaching the paid source. The tail is uncancellable
  and unchanged at ~270s (three nansen sub-calls under one reservation, `3 × (30 + 4×15)` = `3 × 90`).
  Worst case is therefore **cap + tail ≈ 330s**, not ~60s. Today's ~410s is not a bound at all,
  since nothing anywhere is cancelled. Each paid capability records `paidLegMs` beside `deadlineMs`
  with its derivation (R-149), because a bound with no arithmetic beside it is how the 410s number
  was born — and a bound with _wrong_ arithmetic beside it is worse, since R-149 makes this text the
  source a code comment gets copied from.

- **A corrupt or missing chain registry fails loudly at startup (TASK-006, R-60d):**
  `loadChainRegistry()` raises `ChainRegistryLoadError` when the registry data is missing,
  malformed, or violates an invariant (duplicate `caip2`/`slug`, colliding alias, bad CAIP-2
  shape) — it never degrades to an empty registry. An empty registry would answer "unknown chain"
  to every request while the process still looked healthy: a total outage wearing the costume of
  normal operation.
- **SHIPPED (T-012, tasks 012-4/012-6). An unregistered policy `kind` or a capability with no
  manifest entry fails loudly at `CapabilityRegistry` CONSTRUCTION, the same discipline as the chain
  registry above (ADR-002 D2/D3, R-135/R-138).** `mcp-server/src/index.ts:104` builds the one real registry at process
  startup, so a bad `providers.config.ts` edit is a startup failure naming the offending capability
  and `kind`, never a surprise on the first matching `tools/call`.

  🔴 **The manifest table is INJECTED, not imported** — a defaulted constructor parameter, exactly as
  the chain registry already is (`packages/core/src/adapters/registry.ts:109-111`, `this.name = 'MissingCapabilityManifestError';`). This is not symmetry for its own
  sake: `CapabilityRegistry` is a factory, not a singleton, and the parameter defaults to the real
  table, so any test that constructs a registry over a capability with no manifest row would go red.
  The blast radius was **measured, not assumed** — it is **two `new CapabilityRegistry(...)` calls,
  both in one file**: `packages/core/test/coverage.test.ts:86`, `now validates at CONSTRUCTION that` (inside the `registryWith` helper)
  and `:171` (a direct call). Both are built over the same `ROUTES` literal containing the synthetic
  `legacy.thing` (`:79-84`), and each needs its own one-line edit to pass a synthetic manifest map
  as the 5th argument — the helper does not cover `:171`.

  Two capabilities that look like the same problem are **not**: `ghost` (`coverage.test.ts:255`) is
  an argument to `createCoverage({routes})` and `x` (`:127`, `:139`) is a string handed to a
  `CapabilityNotCoveredOnChainError` constructor — neither passes through registry validation.
  Naming them here would have inflated the justification with cases that do not hold, which is the
  same defect as an unmeasured count.

  Validation order is fixed and stated: **manifest presence first, then policy `kind`** — so
  R-135(b)'s bad-`kind` fixture (which supplies its own manifest map) can construct exactly one
  broken thing. R-154's missing-`trust` check is **not** part of this ordering at all: it lives in
  `assertValidAdapterRegistrations(array)`, which never touches the registry constructor.

- **DESIGNED, not built (T-013, R-164) — a merge-enabled walk refines H-1's two-way split into
  THREE participant states, layered ON TOP of the three outcome types above, introducing no new
  exception class.** Applies only to the two routes that carry `CapabilityRoute.merge: true`
  (`privacy.shielded_pool.history`, `platform.metrics.history` — system-architecture.md "Merge
  mechanism"); the 18 other capabilities are unaffected.

  A participant is **"answered"** (cache hit or a fresh `fetch()`/`normalize()` success — R-164's
  reading is intentionally silent on whether its content satisfied `policy`, since that question is
  decided per-participant, separately — OQ-T013-4), **"not asked"** (skipped before `fetch()` for a
  reason that is not the deadline: no adapter registered, `chainSupport()` false, `isAvailable()`
  false, or a live negative-cache entry), or **"asked, did not answer"** (`fetch()`/`normalize()`
  threw — EXCEPT the net-layer `DeadlineExceededError`, which belongs to the deadline precondition
  below, not to this state). The walk collects every participant's outcome across the WHOLE route
  before deciding, rather than returning on the first satisfying answer (the non-merge behaviour,
  unchanged):

  - **(a) every participant answered** → the merged, deduped result returns successfully, even if
    empty — a fact about the DATA (H-1's `!hadFailure` branch, extended, not replaced).
  - **(b) at least one participant answered with ≥1 point, and at least one is not-asked or
    asked-did-not-answer** → the merged result from those who DID answer returns successfully,
    carrying `missingSources: {adapterId, reason}[]` naming who did not contribute and why.
  - **(c) no answering participant contributed a point, and at least one is not-asked or
    asked-did-not-answer** → `CapabilityUnavailableError` with the full `tried` list — never a
    silent empty success. This is the branch that makes the merge mechanism's whole reason for
    existing enforceable: today, on both real T-013 routes, the route carries no `policy`
    (`{kind:'any'}`), which is satisfied by `platform-explorer`'s first answer — so this pair of
    sources is NEVER jointly evaluated, and an unreachable `pg-history` behind an empty
    `platform-explorer` answer today publishes as an ordinary empty success. Branch (c) is what
    stops that: "the source holding our own ledger was never asked" and "there is no history" are
    different statements, and only branch (c) tells them apart.
  - **(d) literally nobody answered** — a named special case of (c), for UC-13.

  **The deadline is a PRECONDITION on this whole contract, not a fifth branch (R-164e) — OD-4
  (2026-08-03) applies to a merge walk exactly as it applies to a non-merge one, through the SAME
  THREE sites that already throw `CapabilityDeadlineExceededError`, not merely two.** A participant
  can be defeated by the deadline two ways DURING the walk — skipped by the per-adapter pre-check
  (`packages/core/src/adapters/registry.ts:1074`, `deadlineHit = true;` — the MERGE walk's own door 1,
  which task 013-5 added; the single-winner twin is `:1437`) OR its in-flight
  `fetch()` cut off by the ceiling (the caught
  `DeadlineExceededError`, `packages/core/src/adapters/registry.ts:1176`, `if (error instanceof DeadlineExceededError) deadlineHit = true;` — door 2, also added by 013-5;
  it did not exist on the merge path when this paragraph was written) — and `deadlineHit` is set either way, so NONE of branches (a)-(d)
  apply: the whole call ends in `CapabilityDeadlineExceededError`, regardless of how many
  participants had already answered. The THIRD site is not a per-participant door at all: a caller
  whose OWN `requestedDeadlineAtMs` has already passed at entry (`packages/core/src/adapters/registry.ts:644`, `CapabilityDeadlineExceededError`, docstring
  "immediate `CapabilityDeadlineExceededError` with an empty `tried`") throws the
  same class immediately, with `tried: []`, before the walk — and before any merge/non-merge branch
  — even begins; a merge-enabled route reaches this exactly like any other. A
  saturated rate-limiter bucket (`DeadlineWouldExceedError`) is different and deliberately does NOT
  set `deadlineHit`: that participant is "asked, did not answer" and is distributed into branch (b)
  or (c) by the ordinary rule above, exactly like any other non-deadline failure — a limiter's
  per-provider backlog is not a fact about the route's global clock (`packages/core/src/adapters/registry.ts:1704-1718`, `— but it CAN still reach this branch`). The
  terminal wall-clock disjunct (`deadlineHit || Date.now() >= effectiveDeadlineAtMs`,
  `packages/core/src/adapters/registry.ts:1719`, `if (deadlineHit || Date.now() >= effectiveDeadlineAtMs) {`) is preserved unmodified for the merge path: it is not redundant with the
  per-participant pre-check — it covers every adapter's transport, not only the two that unwrap a
  typed deadline class today (adversarial cycle 2's F-7; the disjunct's coverage argument is TWELVE
  adapters, WI-36's unwrapping fixed two) — and a merge implementation has no license to remove it.

  This is why the two "real" merge routes make OD-4's two doors OBSERVABLE for the first time on
  this pair: today, with no `policy`, H-1 never evaluates `pg-history` at all once
  `platform-explorer` answers, so a deadline defeating `pg-history` was never distinguishable from
  `pg-history` simply not being asked. UC-22 is the test of this precondition — both doors, same
  outcome, never branch (b) with a partial answer.

- An input validation failure (zod, including the `superRefine` address check) stays an MCP
  tool-error, not a process crash (inherited from M0).
- Retry / circuit-breaker on top of an individual provider call is **not introduced** — YAGNI at
  this volume, where hot-swap fallback plus rate limiting are enough. TASK-005 restates the
  constraint literally for the paid layer.
- **Paid failures travel the same thread, not a new mechanism (M2, TASK-005).** A budget-gate
  refusal, `402 Payment Required` (UC-6) and `429 Too Many Requests` (UC-7 — no retry inside the
  adapter, an explicit error carrying `retry-after`) are all a `throw` out of `nansen.fetch()`.
  They are caught by the **already existing** try/catch in `CapabilityRegistry.resolve()` and
  surface as an ordinary R-24/R-40 `isError: true`. There is no fallback adapter on a paid route —
  the single source is exhausted. Approaching the credit ceiling emits one stderr line, on the same
  channel as the M1 cache metrics (§9.3), not a new notification channel; that closes the ROADMAP
  §M2 "budget alert" risk gate. Details — [system-architecture.md §3.2](system-architecture.md).
- **T-014 adds a second LEVEL of refusal, one that never reaches a tool (R-26).** A protocol-level
  refusal is expressed by a transport status or by a JSON-RPC error. Its classes are authentication,
  perimeter, the session ceiling, and an unknown or expired `Mcp-Session-Id`. The wire form of each
  class is tabulated once, in [interfaces.md §5.4.3](interfaces.md), and is not restated here.

  Tool-execution refusal is the other level, and T-014 leaves its shape unchanged:
  `{ isError: true, content: [...] }`. That shape is what MCP prescribes, and
  `packages/mcp-server/src/tools/registry.ts:205`
  (`return { isError: true, content: [{ type: 'text', text: outcome.reason }] };`) renders it for
  every registered tool.

  A protocol-level refusal leaves no `request_trace` row. It is observable in the `diagnostics`
  stored channel instead ([data-model.md §4.5.8](data-model.md)).

  **Why.** This section is where a reader looks up the failure taxonomy. A class documented only in
  `interfaces.md` is not found here.

### 9.2. Backup

`DATA_DIR` (the cache) needs no backup strategy — the cache is restored by recomputation. n8n /
Supabase backup is outside the engine's scope: a separate system, already covered by
DB-SCHEMA-CONCEPT §8.6.

### 9.3. Monitoring and alerting

M1 ships two observability channels and no framework: stderr lines (cache hit/miss, capability
unavailability with reasons) plus `_meta.cache` on tool responses (§3.2/§7.3). **M2** extends the
same pair with budget observability — a stderr warning when spend approaches the ceiling (§9.1
above) plus `_meta.budget` on the responses of the three paid tools (interfaces.md §5.1.2). That is
the visibility architecture M1 already established for the cache, not a new channel. **FUTURE
(M6):** pino + OpenTelemetry and a per-provider cost dashboard (ROADMAP) — not revisited here.
