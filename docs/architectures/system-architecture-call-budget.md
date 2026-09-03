> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md) → [system-architecture.md](system-architecture.md).
> Heading levels are the parent document's, unchanged: the section numbers are how
> every other document addresses this text.

#### Two second denominators (burst and zero-credit calls)

The daily ceiling limits spend **per day**. It is a damage bound, not a brake, and it is blind to
two things at once — which is what the two ledger entries below record:

| What the daily ceiling missed             | Why                                                                                                                                         | Denominator that sees it  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| A burst (**SEC-1**)                       | Throttling allows ~5 paid calls/s ≈ 50 credits/s — a 2500 ceiling is eaten in under a minute                                                | credits per 60s window    |
| A call costing **zero** credits (**Q-3**) | `used + 0 > ceiling` is false for the entire life of a bucket under any ceiling — that is what "denominated in credits" means, not a defect | CALLS per the same window |

Both live in one `usage_window(provider, window_start, credits_used, calls_made)` row and are checked
**inside the same transaction** as the daily reservation. That last part is not an implementation
detail. `cache.sqlite3` is shared per machine by default (several stdio sessions is a supported
topology), and two connections checking their own window outside a shared transaction would each
pass on a stale read. Either all limits fit and all counters are written, or nothing is touched.

`BudgetStore` stays provider-agnostic: it receives `velocity: {windowStartMs, ceiling, maxCalls?}`
and compares plain numbers. It knows nothing about minutes, credits or the vendor — exactly as it
knows nothing about `usageAtObserve`.

**The numbers, and why they are derived differently.** The credit limit is derived
(`max(100, ceiling/20)` per window): `free` and `Pro` balances differ by orders of magnitude, and
owner decision #1 requires both to work with no code change. A divisor of 20 leaves at least ~20
minutes before a day can be exhausted. The floor of 100 is the price of the most expensive single
call. A limit below the cost of one call makes a capability impossible rather than bounded. The call
limit, by contrast, is **fixed** (60/min): a call is a call on any plan. Neither the vendor's limits
nor the pressure on cache row growth scales with a balance, so there is nothing to derive from.

**Refunds are asymmetric.** Credits are refunded (reconciliation writes `actual − reserved`,
possibly negative) into **the** window the reservation was made in, not the current one — otherwise
a long call would credit a window that spent nothing. The call count is **never** refunded: the
vendor was contacted, and a "refund" would let a chain of cheap-and-refunded calls slip past the
very limit it exists for.

**The three refusals are distinguishable by their text**, because they demand opposite actions.
Those actions are: raise the ceiling, wait out the window, or — for the call limit — understand that
the credit knob does not help at all.

**Stated limitation:** the window is fixed (tumbling), not sliding, so a burst straddling the
boundary of two windows reaches 2× the limit. A sliding window would need a history of calls instead
of a single counter, and 2× does not defeat the goal of giving a human time to notice.

_**Atomic check + reserve (the R-37 concurrency requirement).**_ `BudgetStore.checkAndReserve(...)`
is implemented with `better-sqlite3`'s `db.transaction(fn).immediate()` — **`IMMEDIATE`, not the
default `DEFERRED`** — around a **synchronous** read-compare-write section. This is the same
concurrency technique already documented for `net/rate-limit.ts`'s `throttle()` ("refill + consume +
decide is one wholly synchronous step"). Here it is applied to "read usage + compare against the
ceiling + additively write the reservation". A real SQLite transaction sits on top, rather than only
the JS semantics of not awaiting.

Within one process, two concurrent logical calls whose combined cost exceeds the remainder
deterministically produce **exactly one** `{ok:true}` and one `{ok:false}`; the second never reaches
the network (R-37(c) acceptance). A refusal **writes no reservation at all** — not a rollback, simply
no write — so `usage` is left untouched (R-37 acceptance a/b). The `{ok:false, reason}` names
**which** of the limits fired ("vendor: need X, remaining (as of last resync) Y" vs "self-imposed
cap: need X, NANSEN_DAILY_CREDIT_CAP allows Y"). Without that, the operator cannot tell a genuinely
exhausted vendor account from their own latch (OQ-5).

**`dayBucketMs` is fixed once on entry to the gate and never recomputed at reconciliation.** The
local `const bucket = dayBucketMs(Date.now())`, computed **before** `checkAndReserve`, is passed
through the whole chain of one logical call (reservation → HTTP → reconciliation) as a parameter.
Without that, a call reserved at 23:59:59.8 whose response arrives at 00:00:00.2 would write a
negative delta into the **new** day bucket — another day's problem. The same write is a negative
`credits_used`, which breaks the documented additive/never-overwritten invariant of `usage` (§4.2).
A call's reservation and its reconciliation always hit the **same** `usage` row, whatever
`Date.now()` managed to show in between.

**Cross-process contract.** `DATA_DIR` defaults to a per-machine location (`~/.onchain-intel`), so
several concurrent stdio sessions of Claude Code mean several writer connections to one
`cache.sqlite3`. Atomicity of `checkAndReserve` within one process does not imply atomicity between
processes — but `BEGIN IMMEDIATE` (not `DEFERRED`) takes the write lock immediately, so the normal
busy handler/timeout actually applies. With `DEFERRED`, a competing write between the read and the
upgrade-to-write returns `SQLITE_BUSY_SNAPSHOT` **instantly**, bypassing the busy handler entirely —
a WAL specific, not a hypothetical. `SqliteBudgetStore` therefore opens its connection with an
explicit `new Database(path, { timeout: 5000 })` (not the default 0ms): under contention
`checkAndReserve` waits up to 5s for a busy database instead of throwing at once.

The budget itself is **never corrupted**: the transaction either commits entirely or aborts
entirely, and the anchor formula above is cross-process-correct by construction — it does not depend
on who incremented `usage` between resyncs. The only observable effect of contention is a rare
`CapabilityUnavailableError` instead of an instant success if the timeout does expire. That is
practically unreachable with one stdio process per user; in a multi-process scenario it is an extra
retry, not data corruption.

**Singleflight (R-39) is deliberately per-process**, not per-machine. Two _different_ processes
making an identical request at the same time are two genuine requests, each legitimately paying its
own price. Coalescing is neither needed nor applied there.

**The justification above stops holding in the network deployment profile, and the mechanism does
not change (T-014, R-27 / ADR-003 D4).** "Two processes = two clients" was true while a process
served one local operator. A network server puts two paying clients inside **one** process, so the
map now coalesces requests from **different principals**.

- **The coalescing itself stays correct.** The key is `deriveArgsHash(capability, args)` and the
  principal is not in it (R-5.1). Two principals asking the same question are asking one question of
  the vendor.
- **What changes is the accounting.** The vendor is called once and both principals are charged
  (owner decision, `docs/tasks/task-014-t014-http-transport-auth-perimeter-profiles-shared-limiter.md:601`, OQ-6). Client price and vendor spend were already different
  numbers on a cache hit; a coalesced follower is the second case where they differ.
- **The condition under which coalescing would be wrong is declared but unvalued.** A capability
  whose answer depends on who asked carries `shareable: false` (ADR-003 D5, seam 5), and that flag
  governs the shared cache and this map alike. Measured 2026-08-12: the field is declared
  (`packages/core/src/capability-manifest.ts:149`, `shareable?: boolean;`) and **no** manifest row
  assigns it, so all 26 rows run on ADR-002 D3's `true` default. R-18 gives it a value on every row
  and a reader; until then this map has no way to exclude a row. **Done, 2026-08-20** (tasks 014-31
  and 014-32b): the field is required, all 27 rows carry `true`, and the reader excludes a
  non-shareable row from BOTH the cache and this coalescing map.
- **A coalesced follower records `served_from = 'coalesced'`**, its own value (owner decision
  2026-08-13, §3.4.6). Neither `cache` nor `vendor` is true of it.

_**Singleflight — exactly where.**_ The outermost layer of `fetch()`'s implementation, **before**
check-and-reserve (otherwise two simultaneous **identical** calls would both reserve credits — a
double count for what is logically one request). An in-memory `Map<string, Promise<unknown>>` keyed
by `deriveArgsHash(capability, args)` (reusing the existing `net/args-hash.js` export, not a new
primitive); the entry is deleted in `finally` when the promise settles. A second simultaneous
identical call awaits the **same** promise — no second reservation, no second HTTP request, no
second `usage` write. A call arriving **after** the first has resolved starts fresh, which is
correct: it is a new request in time and needs its own budget check.

_**Post-call reconciliation + transport-failure/402 resync (R-38, UC-6).**_ The mandatory invariant:
**reconciliation happens EXACTLY ONCE per logical `fetch()`, after ALL of that `fetch()`'s
sub-calls have finished.** Read per-response instead, a two-sub-call capability would write
`usage += (5-10) + (5-10) = 0` instead of the 10 credits actually spent — the counter zeroing itself
on every paid `smart-money.flows`/`token.risk` call.

- `actualTotal = Σ(X-Nansen-Credits-Used)` over **all** sub-responses of this `fetch()`. That is one
  number for `smart-money.flows`/`token.risk`. It is identical to the single sub-response for
  `entity.labels`, which always makes exactly one paid HTTP call on its escalation paths. Then
  `delta = actualTotal - reservedTotal`, where `reservedTotal` is the same value passed to
  `checkAndReserve` — the sum of **both** prices from the `costOf()` table, not one at a time. It is
  written with a single `budgetStore.recordDelta('nansen', bucket, delta)` using the same additive
  upsert as the reservation, not a separate replacing write (R-34/R-38).
- **A missing or unparseable `X-Nansen-Credits-Used` header on even ONE sub-response degrades the
  whole reconciliation of that `fetch()` to `delta = 0`** (a `Number()` + `Number.isFinite` guard per
  sub-response) — **never** a partial sum over the sub-responses whose header did parse. A partial
  sum systematically under-counts the fact (the same −5/+0 arithmetic, applied one-sidedly), which is
  worse than a conservative zero. The reservation remains the only known fact — never silently
  zeroed — plus `accountState.markUnreconciled()`.
- A transport error/timeout on ANY sub-call (no response at all) triggers the same
  `markUnreconciled()`, and reconciliation for that `fetch()` does not run at all (there is nothing
  to sum).
- **`402 Payment Required`** (UC-6; openapi `PaymentRequiredError`, headers `Payment-Required` /
  `WWW-Authenticate: Payment .../Payment-Receipt`) on any sub-call is treated as an authoritative
  "there is no budget right now". `fetch()` throws in full (see partial failure below), and the
  reservation stands as a conservative estimate of the fact. `markUnreconciled()` forces the next
  entry into the gate to resolve `/account` instead of trusting a stale local counter. One mechanism
  covers both "the network dropped" and "Nansen itself said no" — not two paths.
- The `bucket` passed to `recordDelta(...)` is the same `dayBucketMs` fixed **before**
  `checkAndReserve` for **this same** logical call — never recomputed from `Date.now()` when the
  response arrives.

**Partial failure of composite capabilities** (`smart-money.flows`/`token.risk`, two HTTP calls
each): if the second sub-call fails after the first has returned, the adapter's whole `fetch()`
throws. There are no partial canonical results — YAGNI, the same fail-fast principle as every other
adapter. By the invariant above, **reconciliation for that call does not run at all**. Not "a
partial sum over the one sub-call that answered" — that is precisely the under-count the
once-per-`fetch()` rule avoids. The reservation (made for the **sum** of both sub-calls) stays
unreconciled, `markUnreconciled()` fires as in the general case, and the next resync pulls in the
actual remainder. No separate mechanism for "partial" reconciliation exists; it reuses the path
already described.

**429 Too Many Requests (UC-7): no retry inside the adapter.** The task's YAGNI constraint ("no
retry/circuit-breaker framework") and UC-7's explicit alternative ("either an explicit error… or one
bounded retry") resolve in favour of an **explicit, immediate error**. That error carries
`retry-after` in its text. It is the simplest option: zero new retry machinery, and no special case
interacting with the budget reservation already made before the HTTP call. A single unit test covers
this path (R-29 acceptance).

**The paid layer touches existing M1 code additively only** — no item below rewrites existing logic:

- `cache/sqlite-store.ts`'s `PAID_PROVIDER_IDS` — `'nansen'` sits next to `'dune'` (a purely
  informational `providers.kind` classification; no logic reads that column, per its own docstring —
  but omitting the line would silently diverge from the documented "paid providers listed here"
  invariant).
- `cache/ddl.ts` — the `usage` table is appended to the same `CACHE_DDL` template (§4.2; the
  forward-compat comment has been in place since M1).

  > **Superseded by D8 (T-012).** `PAID_PROVIDER_IDS` above is exactly one of the four places D8
  > replaces with a single `AdapterRegistration.tier` read — see "Provider tier" in the adapters
  > module above for the other three and the full assignment table.

- `providers.config.ts` — a tenth `adapterRegistrations` entry plus three new `routes` (the same
  pattern as the existing nine, not a structural change).
- `mcp-server/src/env.ts` — `NANSEN_API_KEY` and `NANSEN_DAILY_CREDIT_CAP` in `EnvSchema` (the same
  `emptyAsUndefined` pattern as the six existing keys).
- `.env.example` — `NANSEN_API_KEY` moves from "reserved for M2+" to "the code reads this now"
  (R-46).
- `scripts/record-fixture.mjs` — extended for `nansen` (serializing the POST JSON body, not only the
  query string, R-44); the script itself stays outside CI.

Neither `registry.ts`, nor `resolve-capability.ts`, nor any of the four M1 tool files, nor any of the
nine existing adapters is edited — a claim that is literally verifiable by diff.

**Module: `src/cache/*`** (D6, R-13/R-14/R-15)

Two levels: `lru-cache` (hot, in-process, TTL built into `set()`) in front of `better-sqlite3`
(persistent, under `DATA_DIR`). The DDL follows the DB-SCHEMA-CONCEPT §1 conventions applied to a
**new** context (a cache, not an analytical snapshot):

```sql
CREATE TABLE IF NOT EXISTS providers (
  id    TEXT PRIMARY KEY,   -- adapter.id, e.g. 'coingecko' | 'rpc-evm' | ...
  kind  TEXT NOT NULL,      -- 'free' | 'paid' — informational, reflects the D4 priority
  notes TEXT
);

CREATE TABLE IF NOT EXISTS cache_entries (
  id          TEXT PRIMARY KEY,              -- ULID, generated by the app (DB-SCHEMA §1.3)
  provider    TEXT NOT NULL REFERENCES providers(id),
  capability  TEXT NOT NULL,
  args_hash   TEXT NOT NULL,                 -- sha256(hex) of normalized args — NEVER secrets (§7)
  value_json  TEXT NOT NULL,                 -- canonical result, JSON as TEXT (DB-SCHEMA §1.4)
  created_at  INTEGER NOT NULL,              -- epoch-ms UTC
  expires_at  INTEGER NOT NULL,              -- epoch-ms UTC = created_at + TTL(capability)
  UNIQUE (provider, capability, args_hash)
);
CREATE INDEX IF NOT EXISTS idx_cache_entries_expiry ON cache_entries (expires_at);
```

- **Writes are upserts, not append-only:** a cache entry is a recomputable projection, not an
  observation (in DB-SCHEMA §1.5 terms this is the `aggregates` branch, not `snapshots`):
  `INSERT ... ON CONFLICT (provider, capability, args_hash) DO UPDATE SET value_json=excluded.value_json,
created_at=excluded.created_at, expires_at=excluded.expires_at`. A plain insert-only write would
  silently keep serving the stale value — the same warning DB-SCHEMA §1.5 gives for `aggregates`.
- **`providers` is upserted BEFORE the first `cache_entries` write** (registry bootstrap from all
  twelve `adapterRegistrations`, including `pg-history` and `nansen`, at startup), with the FK
  **explicitly on**: `PRAGMA foreign_keys=ON` when the connection is opened (DB-SCHEMA §1.6). That
  is also what let `usage(provider, day, credits_used)` reference the same `providers` registry with
  no migration (R-14 acceptance). Since T-012 (D8), this column's TWO bootstrap writers (this store
  and `SqliteBudgetStore`, below) derive `kind` from the SAME `registration.tier` instead of
  disagreeing — one hardcoded a `PAID_PROVIDER_IDS` set, the other wrote a hardcoded `'unknown'`.
- `PRAGMA journal_mode=WAL` — concurrent hot-path/debug reads are not blocked by a write.
- **`DATA_DIR`:** optional env, defaulting to `path.join(os.homedir(), '.onchain-intel')` — not a
  `process.cwd()`-relative path. The MCP server is launched by Claude Code with an arbitrary cwd,
  whereas a stable home directory is predictable regardless of where the host started. The cache
  file is `${DATA_DIR}/cache.sqlite3`. Moving an installation is moving one directory
  (DB-SCHEMA §1.10).
- **TTL by data type** (ADR-001 D6 ranges, made concrete for the M1 capabilities):

  **M1 — re-pointed (T-012, LANDED in task 012-5).** This table was, and remains, the
  human-authored source the code is checked against. But WHICH module in the code holds the checked
  rows has moved: it was `packages/core/src/cache/ttl.ts`'s `TTL_SECONDS`, and it is now
  `packages/core/src/capability-manifest.ts`'s `capabilityManifests[capability].ttlSeconds`.
  (`ttl.ts` is a thin reader, "Capability manifest" above; `TTL_SECONDS` no longer exists.) No TTL
  changed in the move. WI-28's gate, `mcp-server/test/readme-tool-table.test.ts`, was extended in
  the SAME task to also assert every routed capability's `deadlineMs` (and, where a paid adapter is
  on the route, `paidLegMs`) matches the table below. That is what converts AC-13 ("every
  `deadlineMs` carries a derivation record") from a code-review promise into a RED TEST, the same
  discipline that already applies to TTL. That discipline was incomplete for six capabilities when
  the WI-28 gate was written — `chain.tvl`, `pool.info`, the two `*.history` rows and all three paid
  ones. The document the implementation names as its authority had been silently behind it since M1
  (`pool.info` and `privacy.shielded_pool.history` are M1 routes, not M2).

  | Capability                                                  | TTL   | Rationale                                                                                                               |
  | ----------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
  | `token.price`                                               | 60s   | D6: price 15–60s                                                                                                        |
  | `token.metadata`                                            | 3600s | name/symbol/decimals barely change                                                                                      |
  | `wallet.balances.native`                                    | 60s   | D6: balances 1–5 min, lower bound — a balance changes with every tx                                                     |
  | `pairs.active`                                              | 30s   | freshness is the point of "new"                                                                                         |
  | `protocol.tvl`                                              | 300s  | D6: TVL 5–30 min, lower bound                                                                                           |
  | `chain.tvl`                                                 | 300s  | the same bucket as `protocol.tvl` (R-53d)                                                                               |
  | `pool.info`                                                 | 300s  | shares its adapter and its liquidity/volume-style volatility with `protocol.tvl`, not with `pairs.active`               |
  | `token.pools`                                               | 300s  | follows the `pool.info` row (T-014, task 014-32b)                                                                       |
  | `dex.volume.history`                                        | 3600s | the vendor's own step is **one day** — a shorter TTL cannot buy a newer number, only a second identical download (R-64) |
  | `chain.tvl.history`                                         | 3600s | same vendor, same one-day step as the DEX series above — the rationale is identical (WI-50)                             |
  | `protocol.tvl.history`                                      | 3600s | same one-day step, and here a shorter TTL would buy a second multi-megabyte download                                    |
  | `protocol.list`                                             | 300s  | inherits `protocol.tvl`'s bucket (WI-49)                                                                                |
  | `gas.price`                                                 | 30s   | the shortest row in the table (WI-51)                                                                                   |
  | `chain.transactions`                                        | 600s  | same document as `gas.price`, twenty times the bucket (WI-51)                                                           |
  | `protocol.incidents`                                        | 3600s | editorial, not on-chain (WI-52)                                                                                         |
  | `privacy.shielded_pool`, `platform.*`                       | 3600s | no point polling faster than the existing snapshotter's hourly cadence                                                  |
  | `privacy.shielded_pool.history`, `platform.metrics.history` | 3600s | historical views of an already-hourly capability — the row above's rationale applies unchanged                          |
  | `token.holders`                                             | 3600s | low volatility (was credit-metered under `dune`; free under `blockscout` since TASK-008)                                |
  | `chain.supply`                                              | 600s  | the value changes **only** when a block is found (R-82c)                                                                |
  | `smart-money.flows`                                         | 300s  | PAID (10 cr/miss): `netflow1hUsd` is a 1-hour rolling window, so a short TTL is genuinely earned here                   |
  | `token.risk`                                                | 1800s | PAID (6 cr/miss): Nansen Score indicators are daily-ish quantitative scores, not tick data                              |
  | `entity.labels`                                             | 3600s | PAID (0/5/100 cr): ENS/CEX/fund attributions change over DAYS, and the `exhaustive` tier is the whole free-plan balance |

  **Rationale detail, keyed by the capability above.** Each entry below carries the text its
  Rationale cell no longer holds.

  - **`chain.tvl`** — an aggregate DeFiLlama recomputes on its own cadence — no faster-moving than a
    protocol's TVL, so the same bucket (R-53d).
  - **`token.pools`** — the same vendor at the same freshness as the `pool.info` row, and pool
    MEMBERSHIP does not move faster than reserves do (T-014, task 014-32b).
  - **`protocol.list`** — read out of the same `/protocols` document as `protocol.tvl`, so it
    inherits that bucket rather than inventing one (WI-49).
  - **`gas.price`** — gas is the most perishable number served, and the indexer re-stamps it about
    every minute (WI-51).
  - **`chain.transactions`** — measured, the daily aggregate does not advance between block updates
    (WI-51).
  - **`protocol.incidents`** — the newest record was 2.5 days old when measured, so a shorter window
    buys a second download and no fresher answer (WI-52).
  - **`chain.supply`** — blocks are found at the Bitcoin target interval, so a shorter TTL cannot
    buy a newer number (R-82c).

  **`deadlineMs`/`paidLegMs` by capability (D4, E-4/R-148/R-149) — LANDED (T-012, task 012-4; this
  table aligned to the manifest and put under the extended WI-28 gate in 012-5), the tier-based
  STARTING assignment.** Assigned from the three budget tiers ("Deadline budget tiers" above) by
  each capability's known route composition (route/adapter data is already in `providers.config.ts`
  today; this does not wait on the `shape` classification, which is a separate axis). The two
  `paidLegMs` cells that read `TBD (R-149)` — "only the TIER is known, the measured envelope is
  Development's job" — were measured and filled in task **012-5**. No `TBD` is left. The same
  "a number without a derivation record is a defect" rule TTL above lives by now applies to every
  cell here.

  **One row below is an OVERRIDE of this document's own tier assignment, and is marked as one.**
  `privacy.shielded_pool` + the four `platform.*` moved ~30_000 → **~15_000** because their second
  adapter `dash-platform` performs zero network attempts today, so the route is single-LIVE-adapter.
  The reason and the revert condition are in that row's own Derivation entry below the table, and
  the code carries the same record (`capability-manifest.ts`'s override banner). **The distinction
  is not one the gate can make:** `readme-tool-table.test.ts` compares NUMBERS and never reads this
  prose. Once a cell is rewritten it reports "matching" whether the change was an alignment or an
  unexplained redefinition. That is why the marking is a task requirement rather than a courtesy
  (defect form WI-24). The row directly beneath it is visually identical at ~30_000 and is
  **correct** (`platform-explorer` + `pg-history`, two live adapters in sequence): these rows are
  addressed by their capability list, never by line number.

  | Capability                                                                                                                                                                                                                                            | `deadlineMs` | `paidLegMs`                                       | Derivation                                                                                                                                  |
  | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
  | `token.price`, `token.metadata`, `protocol.tvl`, `chain.tvl`, `pool.info`, `token.pools`, `dex.volume.history`, `chain.tvl.history`, `protocol.list`, `protocol.tvl.history`, `chain.supply`, `gas.price`, `chain.transactions`, `protocol.incidents` | ~15_000      | — (free-only route)                               | single-free-adapter tier: one adapter, one attempt, no composite sub-calls, and every hop bounded by its adapter's own `REQUEST_TIMEOUT_MS` |
  | `pairs.active`                                                                                                                                                                                                                                        | ~30_000      | — (free-only route)                               | **Two sequential round trips through ONE adapter — the tier is about the call's shape.**                                                    |
  | `wallet.balances.native`                                                                                                                                                                                                                              | ~15_000      | — (free-only route)                               | single-free-adapter tier: each of its two routes (`rpc-evm` XOR `rpc-solana`) is a single free adapter                                      |
  | `token.holders`                                                                                                                                                                                                                                       | ~60_000      | — (free-only route)                               | **Single free adapter, MEASURED slow route — a tier of its own, not the paid one it shares a number with.**                                 |
  | `privacy.shielded_pool`, `platform.identities/contracts/documents/credits`                                                                                                                                                                            | ~15_000      | — (free-only route)                               | **OVERRIDE, not an alignment:** single-LIVE-adapter route (`platform-explorer` alone)                                                       |
  | `privacy.shielded_pool.history`, `platform.metrics.history`                                                                                                                                                                                           | ~30_000      | — (free-only route)                               | ≤2-free-adapters tier: `platform-explorer` + `pg-history` in sequence                                                                       |
  | `smart-money.flows`                                                                                                                                                                                                                                   | ~60_000      | **~180_000** (measured: 2 × E-HTTP15)             | paid-composite tier, cancellable head (nansen-only route, free `/account` resync before reservation)                                        |
  | `token.risk`                                                                                                                                                                                                                                          | ~60_000      | **~180_000** (measured: 2 × E-HTTP15)             | same shape as `smart-money.flows`                                                                                                           |
  | `entity.labels`                                                                                                                                                                                                                                       | ~60_000      | **~270_000** (derived, OD-3 worked example above) | blockscout free call stage + nansen free resync = cancellable head                                                                          |

  **Derivation detail, keyed by the capability that opens the row.** Each entry below carries the
  text its Derivation cell no longer holds.

  - **`pairs.active`** — the tier is about the call's shape, not about how many adapters it takes.
    Task 014-32c gave this route a second `dexscreener` search, issued when the first returns fewer
    on-chain rows than `limit` (19 of 49 chains at the default limit, L-19). It kept the ~15_000
    tier, which equals `safeFetch`'s default hop bound. So the budget for the whole call equalled
    the budget for one of its two hops and the second could not start — arithmetic, not latency
    (L-22, task 014-33). The hop is now bounded at `SEARCH_TIMEOUT_MS = 12_000` for this route ⇒
    envelope **2 × E-HTTP12 = 156_000**, applied 30_000, cuts 126_000.
  - **`wallet.balances.native`** — also `shape: 'set'`, same M-5 note.
  - **`token.holders`** — `blockscout`'s holders aggregate answered in 1.1–45.8 s across its five
    chains while `/api/v2/stats` on the same chain answered in 0.4–1.0 s (task 014-42, 2026-08-21,
    `raw/blockscout-holders-latency-2026-08-21.json`). The hop bound is
    `HOLDERS_TIMEOUT_MS = 60_000` for this route alone ⇒ envelope **E-HTTP60 = 270_000**, applied
    60_000, cuts 210_000. Back to the ~15_000 tier when a probe shows the index fast again.
  - **`privacy.shielded_pool`, `platform.identities/contracts/documents/credits`** —
    `dash-platform.isAvailable()` is unconditionally false ⇒ zero attempts ⇒ single-LIVE-adapter
    route (`platform-explorer` alone). Back to ~30_000 when live gRPC lands.
  - **`privacy.shielded_pool.history`, `platform.metrics.history`** — the two adapters are **not**
    two HTTP call stages. The second speaks the Postgres wire protocol, so its envelope is
    **E-PG = 50_000** (30_000 limiter + the 20_000 in-process query bound), not the HTTP template.
    Measured envelope 140_000, applied 30_000, cuts 110_000 (WI-34/WI-35).
  - **`smart-money.flows`** — 2 paid sub-calls (netflow+holders) under one reservation, measured at
    2 × 90_000.
  - **`token.risk`** — 2 paid sub-calls (indicators+token-information) under one reservation,
    measured at 2 × 90_000.
  - **`entity.labels`** — 3 nansen sub-calls at `30+4×15`s each = the uncancellable call stage,
    reusing `blockscout/index.ts`'s own historical derivation rather than re-measuring.

- **Hot layer bounded by BYTES, not only by entry count (WI-11).** `LruHotLayer`'s `max: 500` was
  sized when the largest cached value was a ~200 B `ProtocolTvlResult`, so the implied ceiling was
  ~100 KB. TASK-007's `dex.volume.history` result at `days: 1825` is ~95 KB, which moved that ceiling
  to ~47.5 MB **without one line changing in `lru.ts`** — a bound that holds only while nobody caches
  anything large. The layer now carries a second, independent `maxSize` budget of **16 MB of
  SERIALIZED bytes**. Retained heap for object-heavy JSON runs ~1.6–2.2× that, so ~26–35 MB — the
  ratio is named rather than folded into one misleading number. The layer also sets `ttlAutopurge`,
  so an expired entry does not sit resident until something happens to touch it. A value larger than
  the whole budget is simply not hot-cached: the persistent layer still has it, and the write path —
  which the Registry treats as best-effort — never throws.

- **Hit/miss counters** (`src/cache/stats.ts`) — a `Map<capability, { hit: number; miss: number }>`
  in process, incremented inside `TwoLevelStore.get()` (not by editing `registry.ts` — the same
  `CacheStore` seam, zero changes in the Registry) on every capability resolution. Exposed through
  `getCacheStats()` and used in two places, deliberately. (a) One stderr line per call
  (`cache=hit|miss provider=<id> capability=<cap> ageMs=<n>` — never arg values or secrets). That
  line is greppable for dev/CI assertions without changing the protocol (the §7.3 M0 invariant
  holds — this is not stdout). (b) `_meta.cache` in the tool response, giving the calling agent
  direct visibility without log parsing and testable in E2E through `result._meta.cache`, without
  growing `structuredContent` or the output schema. R-15's "verifiable in a test or debug output" is closed
  by both paths.
- **`SqliteCacheStore` implementation hardening.** The four repeated SQL statements (`get()` SELECT,
  `get()` stale DELETE, `set()` upsert, sweep DELETE) are `prepare()`d **once** in the constructor
  rather than on every call. An **opportunistic sweep of expired rows** runs on every
  `sweepEveryNWrites`-th `set()` (default 50), deleting rows with `expires_at <= now` through the
  existing index — a documented default. This is **not** retention or a size cap (there is no bound
  on row count or disk size). It removes only already-expired keys that will never be read again.
  The constructor is **leak-safe**. Every step after the connection is opened (PRAGMA / DDL /
  bootstrap / prepare) is wrapped in try/catch. A throw therefore best-effort closes the already-open
  `better-sqlite3` handle before re-throwing, instead of leaking a file descriptor. The
  `postOpenTestHook` seam (never used in production) lets `test/cache.test.ts` simulate an arbitrary
  post-open failure. Finally, `ageMs` stays honest across LRU promotion. When `TwoLevelStore`
  promotes a cold hit into the hot layer it passes `createdAt = Date.now() - coldHit.ageMs`, not the
  moment of promotion. Without that, every subsequent hot hit would report `_meta.cache.ageMs` reset
  to ~0 and under-state the real age of the value.

**`BudgetStore` — the interface** (the same `CacheStore` pattern, R-35):

```ts
// packages/core/src/cache/budget-store.ts

/** The SECOND, rate-denominated limit `checkAndReserve` may enforce (SEC-1) — a bucket start and a
 * ceiling, exactly like the daily pair, just with a much shorter bucket width. `BudgetStore` stays
 * provider-agnostic and policy-free: it does not know the window width, how the ceiling was
 * derived, or that any of this is about credits per minute. */
export interface VelocityLimit {
  /** Epoch-ms UTC start of the window this cost falls in. */
  readonly windowStartMs: number;
  /** Credits this window may hold in total. */
  readonly ceiling: number;
  /** Calls this window may hold in total (Q-3) — a SECOND denominator, not a variant of the first.
   * A credit-denominated limit cannot refuse a call that costs zero credits. Omitted ⇒ calls are
   * not bounded. */
  readonly maxCalls?: number;
}

export interface BudgetStore {
  /** Atomically (see "Atomic check + reserve" above — db.transaction(fn).immediate()) compares
   * `usage.credits_used(provider, dayBucketMs) + cost` against `ceiling` and, only if it fits,
   * additively reserves `cost`. On `ok:false` NOTHING is written — `usage` is left exactly as it
   * was (not a rollback of a partial write; there never was one).
   *
   * `ceiling` is ALWAYS the caller's already-computed `effectiveCeiling` ("The bucket ceiling
   * formula" above: `usageAtObserve + creditsRemainingAtObserve`, then `min()` with
   * `NANSEN_DAILY_CREDIT_CAP`) — never the raw `creditsRemainingAtObserve`. `BudgetStore` itself
   * knows nothing about anchors / `usageAtObserve` / `NansenAccountSnapshot`; it compares two plain
   * bucket-relative numbers, with no anchor arithmetic inside.
   *
   * `velocity`, when supplied, is checked and reserved IN THE SAME TRANSACTION (SEC-1): either both
   * limits fit and both counters are written, or nothing is touched. */
  checkAndReserve(
    provider: string,
    dayBucketMs: number,
    cost: number,
    ceiling: number,
    velocity?: VelocityLimit,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;

  /** Unconditional additive write of a SIGNED delta (a reservation uses a positive `cost`;
   * post-call reconciliation uses `actual - reserved`, which may be negative). Never gates.
   * `windowStartMs` mirrors the delta into the velocity counter and must be the window the
   * RESERVATION was made in, never the one that happens to be current at reconcile time. */
  recordDelta(
    provider: string,
    dayBucketMs: number,
    signedDelta: number,
    windowStartMs?: number,
  ): Promise<void>;

  /** Read-only — accumulated `credits_used` for `(provider, dayBucketMs)`. Used inside
   * `checkAndReserve` and by tool handlers for `_meta.budget` (interfaces.md §5.1.2). */
  getUsage(provider: string, dayBucketMs: number): Promise<number>;
  /** Read-only — accumulated `credits_used` for `(provider, windowStartMs)`. Observability and
   * tests; the gate never needs it (the check lives inside the reservation transaction). */
  getWindowUsage(provider: string, windowStartMs: number): Promise<number>;
  /** Read-only — accumulated `calls_made` for `(provider, windowStartMs)` (Q-3). */
  getWindowCalls(provider: string, windowStartMs: number): Promise<number>;
}
```

**The `Promise<...>` signatures are for interface consistency** with `CacheStore` (which
`registry.ts` already awaits) and for a future Postgres backend (D7) — but the atomicity of
`checkAndReserve` rests on the transaction **body** being synchronous. `SqliteBudgetStore` wraps
`db.transaction(fn)` where `fn` contains no `await` at all: it reads `usage`, compares, and writes
through the synchronous `better-sqlite3` API, the same technique as `throttle()`. **Explicit warning
for a future Postgres implementation (D7).** The guarantee that synchronicity provides here is lost
if its `checkAndReserve` performs genuinely asynchronous work (a network round-trip to the database)
**between** reading `usage` and writing the reservation inside one "transaction". The
correct Postgres equivalent must use a real SQL transaction with an isolation level equivalent to
`SELECT ... FOR UPDATE` inside a single `BEGIN`/`COMMIT`, not two separate awaited queries.

**A deliberate deviation from the literal text of R-35: `BudgetStore` has no "read the current
derived ceiling" method.** R-35 lists three methods as a minimum, including that one; here the third
lives in `NansenAccountState` (`creditsRemainingAtObserve`/`usageAtObserve`) instead. The reason: a
"ceiling" is not a universal provider concept. D7 engine-swap safety concerns the STORAGE of the
usage ledger, which really is the same interface for any future paid provider, whereas the ceiling
is a Nansen-specific live quantity (`credits_remaining` from `/account`, `plan`). Making
`BudgetStore` know it would drag Nansen specifics into a supposedly provider-generic interface — the
same anti-pattern that OQ-2's decision (gate inside the adapter, not in the Registry) avoids.
`BudgetStore` stays a pure ledger (read/reserve/record), injectable and engine-swap-safe
(SQLite→Postgres, D7) no matter how many paid providers appear; each provider carries its own
live-ceiling source next to itself, not in a shared table.

**`SqliteBudgetStore` bootstraps itself.** With `PRAGMA foreign_keys=ON`, the first
`INSERT INTO usage` with `provider='nansen'` fails with `SQLITE_CONSTRAINT_FOREIGNKEY` unless the
`providers` row for `'nansen'` already exists on **that** connection — and the only place M1 code
upserts it is `SqliteCacheStore.bootstrapProviders()` (a different class, a different connection).
Relying on construction order ("`SqliteCacheStore` first, then `SqliteBudgetStore`") is temporal
coupling that no test would catch. The first stub-first development task constructing
`SqliteBudgetStore({dbPath: ':memory:'})` in isolation would meet it as a baffling FK error that
looks like a budget bug. So `SqliteBudgetStore` upserts `providers` itself:

```ts
export interface SqliteBudgetStoreOptions {
  dbPath?: string; // defaults to the same cacheDbPath() — the same file as SqliteCacheStore
  providers?: AdapterRegistration[]; // defaults to adapterRegistrations (all twelve, incl. nansen)
}
```

The constructor runs `db.exec(CACHE_DDL)` (the same idempotent string, now including `usage`) and
the same upsert-into-`providers` pattern as `SqliteCacheStore.bootstrapProviders()` (one reusable
prepared statement) **before** any write to `usage`. Both stores now idempotently upsert the same
`providers` rows over their own connections to the same file — not a conflict (upsert, not
insert-only) but independence: neither has to be constructed first.

**The budget-warning threshold is named config, not a hardcoded number** (R-37, "the threshold is
config"). `NANSEN_BUDGET_WARN_RATIO` (optional env, `z.coerce.number().min(0).max(1).optional()`,
default `0.8`) is a fraction of `ceiling` rather than an absolute credit count. The ceiling itself
is live and may change between resyncs. When
`spentSinceAnchor/creditsRemainingAtObserve >= NANSEN_BUDGET_WARN_RATIO` (or the analogous ratio for
`NANSEN_DAILY_CREDIT_CAP`, when set), one stderr line is emitted — the same channel as the M1 cache
metrics (§9.3 of the index). The line is emitted at most once per threshold crossing per bucket (a
simple boolean flag in `NansenAccountState`, reset on the next resync).

**Where `clearUnreconciled()` is called, and what happens when a cold-start resync fails.** The flag
is cleared **only** by a successful `refreshAccount()` resync (the one that reads `/account` +
`usageAtObserve`), never by a successful paid call. A successful reconciliation leaves the flag as
it is. The flag means "between this moment and the next resync the live counter cannot be
trusted", not "this particular call failed". If the resync itself fails (the network is unavailable
for `/account`) — on either the cold-start or the unreconciled trigger — `fetch()` throws in full
**before** `checkAndReserve`. There is no valid ceiling, so there is nothing to compute. That throw
is the same R-24/R-40 `isError` path as "the key is not set". Fail-closed, never fail-open on a
stale or zero ceiling.

**Module: `src/net/*`** (SSRF, R-25 + rate limiting, R-26)

```ts
export function assertAllowedHost(hostname: string, allowlist: string[]): void; // throws SsrfBlockedError
export function safeFetch(
  url: string,
  opts: RequestInit,
  allowlist: string[],
  fetchImpl?: typeof fetch,
  // D4/R-140/R-142: `deadlineAtMs` is NEW — an absolute epoch-ms moment for the WHOLE call (all
  // redirect hops), not a fresh per-hop budget. Optional and additive; `timeoutMs` stays the
  // per-hop ceiling, now clamped by whatever of `deadlineAtMs` remains at the start of each hop.
  options?: { timeoutMs?: number; maxResponseBytes?: number; deadlineAtMs?: number },
): Promise<Response>;
// safeFetch: redirect: 'manual' + a manual check of the Location host on every hop (max 3); https
// is checked on the ORIGINAL url AND on every redirect hop — UNCHANGED by D4, which touches only
// the timeout composed into each hop, never this allowlist check.
//
// C-1 (architecture review round 2, 2026-08-03) — TWO signals per hop, not one shared clock (an
// earlier draft of this comment read "each hop races `Math.min(timeoutMs, deadlineAtMs -
// Date.now())`" — that phrasing only covered expiry AT a hop boundary, see "Call deadline" above
// for the full defect and fix):
//   const effectiveHopMs = timeoutMs;    // UNCLAMPED by the deadline — see "Call deadline" above:
//                                        // clamping makes both signals expire on the same ms and
//                                        // `SafeFetchTimeoutError` always wins the tie
//   const hopSignal      = AbortSignal.timeout(effectiveHopMs);           // was: a fresh
//                                                                         // AbortSignal.timeout
//                                                                         // every hop — the root
//                                                                         // cause of the ~410s
//                                                                         // envelope
//   const deadlineSignal = deadlineAtMs !== undefined
//     ? AbortSignal.timeout(Math.max(0, deadlineAtMs - Date.now())) : undefined;
//   // on abort: deadlineSignal?.aborted → DeadlineExceededError
//   //           callerSignal?.aborted   → rethrow the caller's own reason (H1)
//   //           else                    → SafeFetchTimeoutError(url, effectiveHopMs)
// A hop whose remaining time is already `≤ 0` at the start is still refused before any network
// attempt (no signal race needed); the two-signal split is what makes a deadline that runs out
// MID-HOP — the ordinary case, since every route ends on a last hop with no next
// iteration (and 13 of the 21 routes are single-adapter) — throw the SAME
// `DeadlineExceededError` a boundary check throws, instead of the generic `SafeFetchTimeoutError` a
// single shared clock cannot tell apart from an everyday vendor timeout. Content-Length is compared
// against maxResponseBytes (10MB default) BEFORE the body is read → SafeFetchResponseTooLargeError
// (documented default: chunked/no-Content-Length is not covered — that needs a streaming byte
// counter). A cross-host redirect strips Authorization and *-api-key headers
// (SENSITIVE_HEADER_RE); a same-host redirect keeps them.

export interface TokenBucketConfig {
  capacity: number;
  refillPerSec: number;
  // T-014/R-7.3: the scope this provider splits its bucket by. Absent means one bucket for every
  // call of the provider (R-7.4). Only `rpc-evm` declares one — the chain slug (R-7.4a). See §3.4.4.
  scopeKey?: string;
}
// D4/R-146: `deadlineAtMs` is NEW, optional, and additive — see "Call deadline" in the adapters
// module above for the full narrowing/refund semantics.
// T-014/R-7.5: this signature is UNCHANGED when the bucket state moves to shared storage. What
// changes is where the state lives and where the atomicity comes from — §3.4.4.
export function throttle(
  providerId: string,
  config: TokenBucketConfig,
  weight?: number,
  deadlineAtMs?: number,
): Promise<void>;
// Concurrency-safe: refill + consume + decide is one wholly SYNCHRONOUS step (no await before the
// state is committed); tokens may go into a negative backlog and are never reset after a wait —
// otherwise concurrent callers read the same pre-wait state and fail to spread out in time.
// refillPerSec <= 0 → a typed RateLimitRejectedError immediately (not an Infinity wait or a
// setTimeout clamp, which would silently swallow the rate limit). A 30s fairness cap: waitMs >
// 30000 rejects instead of waiting, refunding the reservation (tokens += weight — L2, corrected;
// `rate-limit.ts:176` refunds the call's own `weight`, not a flat 1) before the throw — the SAME
// refund shape a deadline-caused rejection uses (`DeadlineExceededError` OR `DeadlineWouldExceedError`,
// D4/H-A above — both refund before throwing, never leave a reservation stuck on a rejected call).
```

**The "wholly SYNCHRONOUS step" above is a property of the in-process `Map`, and T-014 replaces the
`Map`.** The comment is accurate for the code as it stands
(`packages/core/src/net/rate-limit.ts:255`, `const buckets = new Map<string, BucketState>();`).
Once the state lives in shared storage the decision includes a round trip, so the guarantee is
restated rather than kept. Atomicity moves from the event loop into one
`INSERT … ON CONFLICT DO UPDATE … RETURNING` statement (data-model.md §4.5.6). The full design and
the two consequences that follow for the deadline arithmetic are in §3.4.4.

**Module: `src/pg/read-client.ts`** (R-12, used **only** by `adapters/pg-history/index.ts` — not a
separate side channel)

A lazy `pg.Pool`, created **only** on the first call of a history capability **and** only when
`ONCHAIN_PG_URL` is present; otherwise `pg-history.isAvailable()` returns
`{ ok: false, reason: 'needs ONCHAIN_PG_URL' }` (R-24). `search_path=onchain` is set through a
connection option (`options: '-c search_path=onchain'`). Every query the engine issues is
**`SELECT` only** (a code-review gate plus a runtime regex guard, R-27); the recommendation to the
database operator is that the server-side role be SELECT-only as well (defense in depth, §7).
`pg-history` wraps this client in a standard `ProviderAdapter` (`id: 'pg-history'`, `capabilities()`
→ `privacy.shielded_pool.history`/`platform.metrics.history`, `normalize()` → `Snapshot[]`) and is
registered in `providers` alongside the others (§4.2).

**Bounded in time — TWO numbers, because they stop different things (WI-35, 2026-08-05).** Until
this landed, `connectionTimeoutMillis` bounded ACQUIRING a connection and nothing bounded USING one,
which made this the only I/O path in the package with no upper bound at all while every HTTP hop
carried an `AbortSignal.timeout`.

- **`statement_timeout: 5_000`** — a `pg` config field, sent as a startup parameter. **Server-side**:
  Postgres cancels the statement and the pooled connection is returned. Derived rather than chosen.
  `EXPLAIN (ANALYZE, BUFFERS)` over the dev VM's `onchain.snapshots` (2 390 rows, 2026-08-05)
  measured 0.87 ms for the four-metric query and 0.23 ms for the one-metric one. The bound is
  therefore ~5 700× the worst measurement. The margin covers a cold buffer cache, a much larger
  table and an unlucky plan (the four-metric query is already on a Seq Scan).
- **`DEFAULT_QUERY_TOTAL_TIMEOUT_MS = 20_000`** — an in-process race owned by this module.
  **Client-side**: it stops the ENGINE waiting, which is the only bound that survives a server that
  goes silent after the connection was established. That is the failure `statement_timeout` cannot
  reach, and the one that hangs a single-threaded stdio server whole rather than one capability.
  The number is a **sum constraint**: it must exceed `connectionTimeoutMillis` +
  `statement_timeout` (10 000 + 5 000) or the two inner bounds become unreachable and three
  diagnosable failures collapse into one.
  `pg`'s own `query_timeout` is deliberately NOT also set — a second client-side timer with the same
  job and no discriminator between them.

It raises **`PgQueryTimeoutError`**, kept distinct from the sanitized failure message below: "the
database answered with an error" and "the database did not answer at all" are different facts about
an installation. `ReadQueryOptions.deadlineAtMs` (WI-37) narrows the in-process bound to whatever the
caller has left, never widens it, and an already-spent deadline refuses before the pool is
constructed. Which of the two bounds is binding also decides the class — `DeadlineExceededError`
(ours, ends the walk) versus `PgQueryTimeoutError` (this source's, the walk continues). Both are
rethrown UNFLATTENED past the sanitizer, for the reason WI-36 gives one transport over: sanitize what
came from outside, never what this module constructed.

Together these make **E-PG = 50_000** (30_000 limiter + 20_000 query bound) — the envelope the two
`*.history` capabilities' `deadlineMs` is derived from, recorded row-by-row in
`packages/core/src/capability-manifest.ts`.

**Pool hardening.** `pool.on('error', ...)` is attached immediately after `new Pool(...)`. An idle
connection can drop independently of `query()`, and an unhandled `'error'` on an `EventEmitter`
would otherwise take down the whole process (logged to stderr, then ignored).
Each of `connectionTimeoutMillis: 10000`, `max: 3` and `statement_timeout: 5000` is **always**
passed explicitly, never left to `pg`'s defaults. **All** failure paths — `pool.query(...)` and the
**construction** of `new Pool(...)`
itself (a constructor throw on an invalid DSN used to bypass the query try/catch and could leak
host/port/user to the caller) — are sanitized, with `{cause: error}` attached. The raw detail goes to
stderr only; the DSN and any fragment of it never reach the caller or the MCP client.

**Two sanitized outcomes, not one (WI-47 item 4).** The paragraph above claims "the database answered
with an error" and "the database did not answer at all" are different facts — and until WI-47 that
was true only of the timeout. A query failure now raises **`PgServerRejectedError`** when the far end
answered with a Postgres ErrorResponse, carrying its **validated** SQLSTATE and severity
(`pg-history: database reachable, request rejected (SQLSTATE 42P01, ERROR)`), and
`'pg-history: database unavailable'` (`SANITIZED_QUERY_FAILURE_MESSAGE`) only when nothing answered.
The discriminator is `severity` together with a SQLSTATE-shaped `code`, chosen from a live probe of
five real failures rather than from the docs. `code` alone would classify Node's `EPIPE` — a socket
dying, the opposite fact — as an answer. It is deliberately NOT a claim that the query was wrong;
`28P01` and Supavisor's `XX000` are the server rejecting the CALLER, and both are equally "someone
was home". The server's own message stays unsurfaced: it quotes the DSN's username back.
