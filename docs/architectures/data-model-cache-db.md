> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md) → [data-model.md](data-model.md).
> Heading levels are the parent document's, unchanged: the section numbers are how
> every other document addresses this text.

### 4.2. Logical model — the cache DB (`DATA_DIR/cache.sqlite3`)

The full DDL is in §3.2, module `src/cache/*`. In brief: `providers(id PK)` ← `cache_entries(provider
FK, capability, args_hash, value_json, created_at, expires_at, UNIQUE(provider,capability,
args_hash))`. Portable types (`TEXT`/`INTEGER`), epoch-ms `INTEGER`, app-generated `TEXT` ULID ids,
`PRAGMA foreign_keys=ON` — DB-SCHEMA-CONCEPT §1 applied literally to a new context (a cache, not an
analytical snapshot: the upsert semantics in §3.2 differ from the append-only `snapshots`). **All
twelve `adapterRegistrations` (including `pg-history`) are upserted into `providers` at startup** —
no cache hit or miss can reference a nonexistent `provider`, and the FK holds for every adapter
registered in `providers.config.ts`. `providers.kind` (`'free' | 'paid'`, informational — no logic
reads it) is populated from `AdapterRegistration.tier` (T-012 task 012-3, ADR-002 D8). Both writers
of this column (`SqliteCacheStore.bootstrapProviders()` and `SqliteBudgetStore.bootstrapProviders()`)
read that ONE field on the same registration; before 012-3 they disagreed — one derived `kind` from a
private `PAID_PROVIDER_IDS` set, the other hardcoded `'unknown'` (system-architecture.md, "Provider
tier"). **Their conflict clauses are also identical now (adversarial cycle 2, F-3):**
`ON CONFLICT (id) DO UPDATE SET kind = excluded.kind`, updating the column both writers OWN and
leaving `notes` alone. The cache store used to add `notes = excluded.notes` with a literal `NULL`.
Construction alone was enough to erase an operator's note, while constructing the budget store
preserved it — the same file's content depending on which store opened it last.

**M2 addition (TASK-005, R-34): `usage(provider FK, day, credits_used)`** — the same cache DB, the
same `providers` registry as the FK target, and **no migration** of `providers`/`cache_entries` (the
forward-compatibility comment in `cache/ddl.ts` was already in place in M1). Portable types, taken
literally (DB-SCHEMA-CONCEPT §1):

```sql
CREATE TABLE IF NOT EXISTS usage (
  provider     TEXT NOT NULL REFERENCES providers(id),
  day          INTEGER NOT NULL,           -- epoch-ms UTC bucket start: floor(ts/86400000)*86400000
  credits_used INTEGER NOT NULL DEFAULT 0, -- ADDITIVE counter — see the upsert semantics below
  updated_at   INTEGER NOT NULL,           -- epoch-ms UTC of the last write (observability only)
  PRIMARY KEY (provider, day)
);
```

**SEC-1 (2026-07-27): `usage_window(provider FK, window_start, credits_used)`** — the same additive
counter with a 60-second bucket instead of a day. A separate table rather than a `bucket_width`
column on `usage`: the daily counter must keep summing whole days, and carrying two widths in one
column would make every existing SELECT ambiguous and force a migration. It ships as an ordinary
`CREATE TABLE IF NOT EXISTS` against the same `providers` registry — it migrates nothing.

```sql
CREATE TABLE IF NOT EXISTS usage_window (
  provider     TEXT NOT NULL REFERENCES providers(id),
  window_start INTEGER NOT NULL,           -- epoch-ms UTC: floor(ts/60000)*60000
  credits_used INTEGER NOT NULL DEFAULT 0, -- same signed additive upsert, same MAX(0, …)
  calls_made   INTEGER NOT NULL DEFAULT 0, -- Q-3: additive and MONOTONIC — never given back
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (provider, window_start),
  CHECK (credits_used >= 0),
  CHECK (calls_made >= 0)
);
```

`calls_made` is the **second denominator** (Q-3). A gate that counts credits cannot refuse a call
that costs 0 credits: `used + 0 > ceiling` is false for the whole life of the bucket at any ceiling.
That is not a defect of the ceiling, it is what its unit of measure means — so it is cured with a
different unit, not with a stricter number. The column sits on the same row rather than in a second
table: same provider, same window, same transaction, and one read instead of two. The counter is
**monotonic** — reconciliation corrects credits and never the number of calls. The vendor was
called, and "giving one back" would let a run of cheap-and-refunded calls slip past the very limit
it exists to enforce.

The column was added **after** the table had already shipped, so `CREATE TABLE IF NOT EXISTS` does
not create it on an existing file. `SqliteBudgetStore` checks `PRAGMA table_info` and runs
`ALTER TABLE … ADD COLUMN` when needed (`USAGE_WINDOW_COLUMNS` in `cache/ddl.ts`) — idempotent on
every open, additive, with no backfill (`DEFAULT 0` is correct by construction: a window row that
predates the column contains, by definition, no counted calls). This is exactly the "mechanical, not
a project" kind of migration DB-SCHEMA-CONCEPT §1 demands.

It is read and written **inside the same transaction** as the daily reservation (`checkAndReserve`).
Otherwise two processes sharing one `cache.sqlite3` — a supported topology, several stdio sessions
on one machine — would each pass its own window check against a stale read. Rows older than an hour
are deleted opportunistically in that same transaction. Only the CURRENT window is ever read, the
rest is retention for post-mortem analysis, and one row per minute per provider forever is a slow
leak into `DATA_DIR`.

- `day` is an **`INTEGER` epoch-ms** day-bucket start, not a string date — DB-SCHEMA §1.2 /
  CLAUDE.md canon taken literally. ADR-001 D6 calls the column "day", but a literal date string
  would contradict the canon; it is bucketed with the same pattern as the n8n snapshotter's
  `ts_bucket`.
- `credits_used` is an `INTEGER`, not the `value_raw TEXT` pattern: it is a small internal counter of
  the engine's own credits, well inside a safe JS `number`, not a canonical observation of arbitrary
  precision. It is not a `Snapshot`, so `INTEGER` does not contradict the canon (R-34).
- **`PRIMARY KEY (provider, day)` is the natural dedup key, and TWO write phases go through ONE and
  the same additive upsert** (not the overwrite-upsert with which `cache_entries.set()` writes its
  row):

  ```sql
  INSERT INTO usage (provider, day, credits_used, updated_at)
  VALUES (@provider, @day, @delta, @now)
  ON CONFLICT (provider, day) DO UPDATE SET
    -- MAX(0, …) is belt-and-braces: @delta is SIGNED (post-call reconciliation, §3.2, writes
    -- actual-reserved and may be negative) — but credits_used must remain a non-negative counter
    -- by construction. Without this clamp any edge or defective path (e.g. a bucket mistakenly NOT
    -- pinned at reservation time, §3.2 "dayBucketMs is pinned once") could push a negative number
    -- into a fresh day bucket and break this column's documented "never overwritten, only grows or
    -- stays" invariant.
    credits_used = MAX(0, credits_used + excluded.credits_used),
    updated_at = excluded.updated_at;
  ```

  (a) the pre-call **reservation** — `@delta = costOf()` (the exact price, R-37); (b) the post-call
  **reconciliation** — `@delta = actual − reserved` (a signed delta, possibly negative, R-38). The
  same SQL pattern serves both phases; a replacing write would double-count or lose spend instead
  (§3.2 works this through in detail). **`day` in both phases of one call is literally the same
  value** (`dayBucketMs`, pinned at reservation, §3.2 "atomic check+reserve"). Reconciliation never
  recomputes the bucket from the response's arrival time. A response that arrives after midnight for
  a call reserved before it still lands in the ORIGINAL day bucket, not a new one.

- `SqliteBudgetStore` (`cache/budget-store.ts`, implementing the `BudgetStore` interface — the same
  injection pattern as `CacheStore`/`SqliteCacheStore`, §3.2/§5.2) opens its **own** `better-sqlite3`
  connection to the same file (`cacheDbPath()`, reusing the existing `cache/data-dir.ts`). It runs
  `db.exec(CACHE_DDL)` idempotently (the same string, which now also carries `usage`). It
  **necessarily** reissues `PRAGMA foreign_keys=ON` on THAT connection — the pragma is
  connection-scoped and is not persisted in the file (DB-SCHEMA §1.6; R-34 explicitly requires
  "every" connection, not a global). A `pragma_foreign_keys`/`sqlite_master` query test confirms it
  (R-34/R-35 acceptance).

#### 4.2.1. The chain registry is a build artifact, not a DB table (TASK-006, R-48/R-60)

The registry lands in neither the cache DB, nor Postgres, nor a network call at startup. It lives in
the repository as one deterministic file, is vendored into the build, and is loaded into memory at
startup. Three reasons, each a hard requirement rather than a taste:

1. **The offline gate (R-60a).** M1/M2 established the gate "an offline run makes 0 network calls".
   A registry pulled over the network at startup breaks it the same day.
2. **CI determinism.** A test whose result depends on what a vendor served today is not a test.
3. **Reviewability.** Changing the set of chains is a git diff with a human reviewing it (TASK-006
   UC-4), not a silent shift in production behavior. This matters most for `rpcHosts`: that is a
   security surface (§7.2), and it must change through a commit.

The consequence, stated explicitly: **registry freshness is the operator's duty, not the runtime's.**
A new chain that appeared at a vendor becomes available after the generator runs and the result is
committed (TASK-006 UC-4), not automatically. That is a deliberate trade: determinism and control
over the security surface, against automatic freshness.

**Loading (R-60c/d):** schema validation plus the §4.1 invariants run **at startup**, not on the
first request. A missing or invalid registry is a loud process failure. Degrading to an empty
registry is **forbidden**: an empty registry would turn every request into "unknown chain" — quietly
breaking the entire engine while looking like correct operation.

#### 4.2.2. Effect on the cache key (OQ-3)

The cache key is `(provider, capability, sha256(normalizedArgs))` (M1, §3.2), and `normalizedArgs`
contains `chain`. What goes in there is the canonical **slug**, never the spelling the agent wrote.

- **Correctness requirement:** an alias is canonicalized (`eth` → `ethereum`) **before** hashing.
  Without that, one and the same request written two ways produces two paid calls and two cache
  entries — on a paid route that is a direct monetary defect. Canonicalization happens in the
  handler, ahead of `deriveArgsHash`, and an end-to-end test proves it: `chain:'eth'` after
  `chain:'ethereum'` is a cache HIT with no second upstream request.
- **No cold invalidation happened.** The canonical value is the slug (the rationale, and the
  rejection of CAIP-2 in this position, is recorded in `types/chain.ts` under R-59d), and before
  TASK-006 the tools accepted exactly `ethereum`/`solana` — which are their own slugs. The
  `args_hash` of existing rows therefore did not change and the cache survived the rollout intact.

#### 4.2.3. The coverage matrix is derived, not a second registry (R-51a)

Coverage of a (capability, chain) pair is **stored nowhere as a list.** It is computed as a
composition of two things that already exist:

```
covered(capability, chain) :=
    ∃ adapterId ∈ route(capability).adapterIds :
        adapter(adapterId).chainSupport(chainInfo, capability) === true
```

**The capability is an ARGUMENT of the predicate**, and the formula said so only after task 014-32c
brought it into line with `adapters/types.ts`. It is not decoration: `nansen` covers
`smart-money.flows` on 17 chains and `token.risk` on 25, because a composite capability is covered
only where every sub-call is. A formula blind to the capability could state a union (over-claiming,
and the extra chains half-succeed AFTER credits are spent) or an intersection (under-claiming), and
neither is what the code computes.

Every adapter answers the question about a chain itself, with a predicate over `ChainInfo` rather
than a list:

| Adapter                                              | `chainSupport(c, capability)`                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `defillama`                                          | per capability — see below                                                   |
| `coingecko`                                          | `c.vendors.coingecko !== null`                                               |
| `dexscreener`                                        | `c.vendors.dexscreener !== null` — one condition for all three capabilities  |
| `rpc-evm`                                            | `c.family === 'evm' && c.rpcHosts !== null`                                  |
| `rpc-solana`                                         | `c.caip2 === <solana mainnet caip2>`                                         |
| `nansen`                                             | per capability — see below                                                   |
| `dash-platform` / `platform-explorer` / `pg-history` | `c.caip2 === <dash caip2>`                                                   |
| `blockchain-info`                                    | `c.caip2 === 'other:bitcoin'` — one chain, and the vendor serves exactly one |
| `dune`                                               | unchanged — `isAvailable()` is still unconditionally `false`                 |

A deprecated chain is covered by nothing: `covered()` refuses it before consulting any adapter.

**The `dexscreener` row was accurate about the intent and not about the code, until 2026-08-21.** The
adapter also required `c.nativeSymbol !== null`, because its only query was the native symbol. Task
014-32c planned to relax that for the two address-addressed capabilities and found it did not need
to. Fixing L-19 replaced the query with the vendor's own chain id, so no capability requires a
native symbol and the predicate is uniform. Measured the same day: all 49 covered chains carry a
`nativeSymbol`, so the code and this row described the same 49 chains throughout. The drift changed
no coverage, which is exactly why nothing caught it.

**Why a predicate and not a list column:** a column would mean maintaining coverage in two places
(the registry plus the adapter's `capabilities()`) and the two would diverge on the first change. The
predicate leaves the registry as the single source of **facts about a chain** and the adapter as the
single source of **facts about itself**. This is the same principle by which §3.2 keeps
`providers.config.ts` declarative while `isAvailable()` owns the availability decision.

**`defillama` coverage is per capability too, and for a measured reason (TASK-007, R-63).** The
`vendors.defillama` column was populated from the vendor's **TVL** catalog (`/v2/chains`), so it is
non-null for **all 458** registry chains. The vendor's **DEX-volume** dataset is a different and much
smaller set: `allChains` in a live `/overview/dexs/{chain}` response lists **287** chains, of which
**274** exist in our registry. Reusing the TVL predicate for `dex.volume.history` would therefore
advertise the capability on **184 chains that have no such data** — the exact defect class TASK-006's
review recorded as H-1 (coverage widened, transport not). So:

| capability                  | predicate                                                            | chains |
| --------------------------- | -------------------------------------------------------------------- | ------ |
| `protocol.tvl`, `chain.tvl` | `c.vendors.defillama !== null`                                       | 458    |
| `dex.volume.history`        | `c.vendors.defillama ∈ DEFILLAMA_DEX_CHAINS` (generated vendor list) | 274    |

`DEFILLAMA_DEX_CHAINS` is a **generated, committed build artifact**, produced by
`scripts/gen-defillama-dex-chains.ts` from a recorded raw response under
`docs/onchain-analytics/raw/`. It follows the same doctrine, and carries the same emit-time token
guard, as `gen-nansen-coverage.ts`: read the evidence we already hold, emit code, review the diff.
It is not fetched at startup, for the three reasons the chain registry itself is a build artifact
(§4.2.1): the offline-run gate, CI determinism, and reviewability. The 13 chains the vendor serves
that our registry does not know are recorded in the raw evidence and covered by nothing — an honest
gap beats a phantom row.

**`nansen` coverage is per capability, and a composite capability is an intersection.** The recorded
coverage comes from the committed vendor spec (`raw/nansen-openapi-2026-07-23.json`), which
enumerates the chains per endpoint, plus a small live spot-check confirming the spec has not
drifted. That is evidence at zero credits, which meets R-58a's intent more strictly than probing 25
chains live would. `smart-money.flows` issues two sub-calls (`/smart-money/netflow`, 17 chains, and
`/tgm/holders`, 25), so its coverage is the **intersection**. A union would admit 8 chains where the
first sub-call succeeds, the second is refused, and the credits for the first are already spent. On
top of that the adapter requires the chain's family to have a real address validator. Without one we
cannot tell a valid `tokenAddress` from arbitrary text, canonicalize it into a stable cache key, or
know how the vendor cases its address column, on a route that charges for every attempt. The cost of
that condition is stated rather than absorbed silently: after it the covered counts are
`smart-money.flows` 16, `entity.labels` 18 and `token.risk` 18 chains, dropping `bitcoin`, `near`,
`sei`, `starknet`, `sui`, `ton` and `tron`. Each returns the moment its family gets a validator.
One predicate serves all three readers of that answer — what the matrix advertises, what the
transport will build a request for, and what the refusal message lists as available. The reason is
that an adapter that answers the same question in two places eventually answers it two different
ways.

**Three different refusals that must not be merged (R-51b, and D4/R-145 since T-012):**

| Situation                                                                 | Error type                             | What it means to the agent                                        |
| ------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| The (capability, chain) pair is not covered                               | `CapabilityNotCoveredOnChainError`     | "It is not here and will not be — look at alternatives"           |
| The pair is covered but the provider is unavailable (no key, vendor down) | `CapabilityUnavailableError` (R-24)    | "This could work — fix the config or retry later"                 |
| The manifest's call deadline expired before a satisfying answer arrived   | `CapabilityDeadlineExceededError` (D4) | "We ran out of our own time budget — this is not a vendor outage" |

Merging any of the three would send the agent into an endless retry where retrying is pointless, or
conversely make it give up where adding a key (or simply retrying later) is enough.
`CapabilityNotCoveredOnChainError` is raised from `validateArgs()`, i.e. **before** `ensureBudget()`
— no credits are reserved to discover it. `CapabilityDeadlineExceededError` reuses the SAME `tried`
list the other two carry (system-architecture.md, "Call deadline"), naming which sources the walk
never reached because time ran out first.

#### 4.2.4. The same four counters in the Postgres dialect (T-014)

Storage and transport are independent axes (`deployment.md` §10.1.1). Storage decides the engine
for these four tables; the transport does not.

| Named profile    | Where `providers`, `cache_entries`, `usage`, `usage_window` live |
| :--------------- | :--------------------------------------------------------------- |
| `local`          | `DATA_DIR/cache.sqlite3`                                         |
| `network`        | Postgres schema `onchain`                                        |
| `network-sqlite` | `DATA_DIR/cache.sqlite3`                                         |

The four are declared from one canonical shape under the type map of §4.5.1. No column is added,
dropped or renamed. The store components that read and write them are designed in
[system-architecture.md](system-architecture.md); this subsection states what their SQL must
guarantee in each dialect.

**The concurrency guarantee is restated per dialect, not carried over.** SQLite takes it from
`BEGIN IMMEDIATE` (`packages/core/src/cache/budget-store.ts:420` `return attempt.immediate();`).
Postgres has no such statement. The existing code already names this hazard
(`packages/core/src/cache/budget-store.ts:295-297`
`a future Postgres` … `forfeits this guarantee entirely`).

**Dialect substitutions that apply to all four.** `MAX(x, y)` becomes `GREATEST(x, y)`;
`INTEGER` becomes `BIGINT`; every object name is schema-qualified (R-30.1). The keys, the columns
and the arithmetic are identical.

**1. `providers` — bootstrap upsert.**

- Statement: `INSERT … ON CONFLICT (id) DO UPDATE SET kind = excluded.kind`, unchanged from §4.2.
- Requirement: single-statement atomicity, which both engines give without a transaction.
- Both writers still leave `notes` alone (§4.2), and the clause text stays identical between them.

**2. `cache_entries` — one indexed read, one upsert.**

- `get` is one equality read on `(provider, capability, args_hash)`; `set` is one upsert on the
  same key.
- Requirement: single-statement atomicity. No cross-statement guarantee is claimed.
- **Why a lost update is admissible here.** Two concurrent writers of one key fetched the same
  capability with the same arguments, so the later row is a copy of the same vendor answer.

**3. `usage` and `usage_window` — the money gate.**

`checkAndReserve` reads both counters and writes both, and refuses a reservation that would cross a
ceiling (`packages/core/src/cache/budget-store.ts:308`
`const attempt = this.db.transaction((): { ok: true } | { ok: false; reason: string } => {`).

- **SQLite requirement:** the whole body runs inside `db.transaction(fn).immediate()`, as today.
- **Postgres requirement:** the ceiling test is expressed inside the writing statement, and a
  refusal is an empty `RETURNING`.

**Why a `SELECT` followed by an `INSERT` is not permitted in the Postgres dialect.** Under
`READ COMMITTED` two connections read the same `credits_used` and both pass the test. The conflict
action's row lock is the only serialization point on `(provider, day)`.

**The canonical Postgres statement is written once, in
[system-architecture.md](system-architecture.md) §3.4.8.** This subsection quotes no SQL of its own
and lists what that statement must guarantee.

**Why the text lives in one section only.** Two copies of one statement drift apart, and a reader
cannot then tell which copy the implementation follows.

- **Zero rows returned is a refusal**, not a failure. The reason string is built in code, from the
  values the caller already holds.
- **Both branches carry the ceiling test, the insert branch included.** A fresh day bucket holds no
  row, so an unguarded insert branch admits a cost larger than the whole ceiling.
- **An unlimited ceiling is bound as `NULL`, and the guard tests for `NULL` explicitly.** A ceiling
  of `off` is a supported configuration, and `… <= NULL` yields `NULL` — zero rows, every
  reservation refused.
- **Reconciliation is a second statement and carries no ceiling bound.** Its `@delta` is signed
  (§4.2), and a refund refused by a `WHERE` would strand credits nobody spent.
- **The velocity counter takes the same shape on `(provider, window_start)`**, with two bounds in
  its `WHERE`: credits per window and `calls_made` per window (Q-3, §4.2).
- **Both counters move inside one `BEGIN` on one connection.** A reservation that reached only the
  daily ledger would leave the window disagreeing with it, and a reconciliation would compound the
  drift.
- **The opportunistic prune of old window rows stays inside that transaction**, as in SQLite, so it
  inherits the same lock instead of racing it (§4.2).
- **`calls_made` stays monotonic** in this dialect too: reconciliation adjusts credits and never the
  call count (§4.2).

**A refusal writes no counter row.** The gate runs before the vendor call, so a refused reservation
has spent nothing to record.
