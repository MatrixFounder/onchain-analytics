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
- **A corrupt or missing chain registry fails loudly at startup (TASK-006, R-60d):**
  `loadChainRegistry()` raises `ChainRegistryLoadError` when the registry data is missing,
  malformed, or violates an invariant (duplicate `caip2`/`slug`, colliding alias, bad CAIP-2
  shape) — it never degrades to an empty registry. An empty registry would answer "unknown chain"
  to every request while the process still looked healthy: a total outage wearing the costume of
  normal operation.
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
