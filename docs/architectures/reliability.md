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
- **PLANNED (T-012, DECIDED but not in code as of 2026-08-03).** **A call deadline expiring is a
  THIRD, equally distinct outcome (ADR-002 D4, R-145) — not
  merged with either error above.** `CapabilityDeadlineExceededError` will fire when the manifest's
  (narrowed-only, never widened, R-144) `deadlineMs` runs out before any adapter on the route
  satisfied the request. It reuses the SAME `tried` list `CapabilityUnavailableError` already
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
  `gate.ensureBudget()` → `checkAndReserve()` (`adapters/nansen/index.ts:657`) — which happens
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
- **PLANNED (T-012, DECIDED but not in code as of 2026-08-03). An unregistered policy `kind` or a
  capability with no manifest entry will fail loudly at
  `CapabilityRegistry` CONSTRUCTION, the same discipline as the chain registry above (ADR-002
  D2/D3, R-135/R-138).** `mcp-server/src/index.ts:104` builds the one real registry at process
  startup, so a bad `providers.config.ts` edit is a startup failure naming the offending capability
  and `kind`, never a surprise on the first matching `tools/call`.

  🔴 **The manifest table is INJECTED, not imported** — a defaulted constructor parameter, exactly as
  the chain registry already is (`adapters/registry.ts:109-111`). This is not symmetry for its own
  sake: `CapabilityRegistry` is a factory, not a singleton, and the parameter defaults to the real
  table, so any test that constructs a registry over a capability with no manifest row would go red.
  The blast radius was **measured, not assumed** — it is **two `new CapabilityRegistry(...)` calls,
  both in one file**: `packages/core/test/coverage.test.ts:86` (inside the `registryWith` helper)
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
