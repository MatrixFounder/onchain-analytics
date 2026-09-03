> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md) → [data-model.md](data-model.md).
> Heading levels are the parent document's, unchanged: the section numbers are how
> every other document addresses this text.

### 4.5. T-014 — persistent state for the network deployment profile

T-014 introduces eight tables. Four carry identity (`users`, `access_profiles`, `api_tokens`,
`access_audit`), one carries shared limiter state (`provider_buckets`), and three carry operational
records (`request_trace`, `diagnostics`, `retention_runs`).

None of the eight is a canonical domain type in the D5 sense. They record who called, what the
engine did, and under which settings — not an observation obtained from a provider. They are
therefore absent from §4.1 and present in the logical model.

**Two meanings of "profile", kept apart by name.** A **deployment profile** is a named combination of
a transport and a storage engine, one per process (`deployment.md` §10.1.1). An **access profile** is
a settings entity a token references, many per process (`docs/tasks/task-014-t014-http-transport-auth-perimeter-profiles-shared-limiter.md:21-24`).

**The two axes are independent.** Transport is stdio or Streamable HTTP; storage is SQLite or
Postgres. Three combinations are named: `local`, `network` and `network-sqlite`.

**Why this section names both axes separately.** Which columns are populated follows the transport;
which dialect declares them follows the storage engine. A single word for both would make one of the
two tables below unwritable.

#### 4.5.1. Where each table lives

Every table is declared in both dialects from one canonical shape. The storage axis picks the
dialect: `DATA_DIR/cache.sqlite3` for SQLite, Postgres schema `onchain` for Postgres (§4.4).

| Table              | Written on stdio      | Written on HTTP | Requirement     |
| :----------------- | :-------------------- | :-------------- | :-------------- |
| `users`            | no — inert, see below | yes             | R-15.3, R-15.4  |
| `access_profiles`  | no — inert            | yes             | R-13.1          |
| `api_tokens`       | no — inert            | yes             | R-15.1a, R-15.5 |
| `access_audit`     | no — inert            | yes             | R-15.7          |
| `provider_buckets` | yes                   | yes             | R-7             |
| `request_trace`    | yes                   | yes             | R-27            |
| `diagnostics`      | yes                   | yes             | R-32.2          |
| `retention_runs`   | yes                   | yes             | R-32.3          |

**Why the identity tables are declared in SQLite and left empty on stdio.** One DDL string and one
store implementation serve both dialects. A test of revocation or of the append-only audit then runs
against SQLite, with no Postgres process in CI (R-21 forbids network there).

**The `network-sqlite` profile populates them.** It runs the HTTP transport, so it authenticates
every request against the SQLite tables. This is the profile that debugs the transport without a
Postgres server.

**A token issued into the store of a stdio process is inert.** The stdio transport requires no token
and does not check one (`docs/tasks/task-014-t014-http-transport-auth-perimeter-profiles-shared-limiter.md:518` `значение не требуется и не проверяется`). An operator
must not read such a row as protection of that transport.

**Type map for the Postgres dialect** (DB-SCHEMA-CONCEPT §5, applied unchanged): `TEXT` → `TEXT`,
`INTEGER` (epoch-ms and counters) → `BIGINT`, `REAL` → `DOUBLE PRECISION`. Keys and `CHECK`
constraints transfer as written.

**Every query names its schema** (R-30.1). `search_path` is not a correctness condition: WI-47
measured that Supavisor substitutes its own, and `packages/core/src/pg/read-client.ts:383`
(`options: '-c search_path=onchain'`) does not survive that pooler.

#### 4.5.2. Where this project's canon overrides the reference identity model

The reference is `/Users/sergey/dev-projects/n8n-lazy-loading-skills/sql/010_identity_tables.sql`
(`cvj.users` / `cvj.api_tokens` / `cvj.access_audit`). It is followed wherever the canon is silent.
Five columns disagree with DB-SCHEMA-CONCEPT §1, and the canon wins in all five.

| Reference                        | Here                         | Canon | Why the canon wins                                                  |
| :------------------------------- | :--------------------------- | :---- | :------------------------------------------------------------------ |
| `uuid DEFAULT gen_random_uuid()` | `TEXT` ULID, app-generated   | §1.3  | the shape ships to two engines, so no server default can own the id |
| `timestamptz DEFAULT now()`      | `INTEGER` epoch-ms UTC       | §1.2  | a DB time function in logic is forbidden; `BIGINT` in Postgres      |
| `token_hash bytea`               | `TEXT`, lowercase sha256 hex | §1.1  | `bytea` is Postgres-specific; the digest is fixed-width either way  |
| `scopes text[]`                  | not carried — see §4.5.4     | §1.1  | a Postgres array type is forbidden in v0/v1                         |
| `id bigserial` (audit)           | `TEXT` ULID                  | §1.3  | engine row-numbering is never relied on; a ULID also sorts by time  |

**Why the ULID amendment of DB-SCHEMA §1.3 does not apply here.** That amendment permits a
server-generated `uuid` in a **unified Postgres profile**. This engine ships two persistence
profiles, and the same writer emits rows into both, which is the condition the amendment excludes.

**What the reference contributes unchanged:** the `admin | user` role check, the `active | suspended`
status check, the visible `prefix` beside the hash, the minimum prefix length of 8, and the
append-only guard on the audit table.

#### 4.5.2a. Every ULID key is declared `PRIMARY KEY NOT NULL`, and the second word is load-bearing

SQLite admits NULL in a `TEXT PRIMARY KEY` column; Postgres does not. The identical DDL therefore
yields a different constraint on each storage axis, which is the class of divergence §1 exists to
prevent. Spelling `NOT NULL` costs nothing on Postgres, where `PRIMARY KEY` already implies it.

**Why it is worth naming rather than assuming.** A conformance test reading `PRAGMA table_info`
counts the declared `NOT NULL` columns. Without the explicit word it finds one fewer on SQLite than
on Postgres — a red test on one axis and a green one on the other, for the same table.

#### 4.5.3. `users` and `access_profiles`

**`users` — purpose:** the person a token belongs to, and the role that decides `_meta` visibility.

```sql
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY NOT NULL,   -- ULID, app-generated (§1.3)
  email        TEXT NOT NULL,      -- the only human-facing identity
  display_name TEXT,
  role         TEXT NOT NULL,      -- 'admin' | 'user'   (R-15.3)
  status       TEXT NOT NULL,      -- 'active' | 'suspended'
  created_at   INTEGER NOT NULL,   -- epoch-ms UTC
  updated_at   INTEGER NOT NULL,   -- epoch-ms UTC
  UNIQUE (email),
  CHECK (role IN ('admin','user')),
  CHECK (status IN ('active','suspended'))
);
```

- **Primary key:** `id`. **Natural UNIQUE dedup key:** `email`.
- **Indexes:** none beyond the two the keys create. Every read is by `id` or by `email`.
- **Serves:** R-15.3, R-15.3a, R-15.4.

**`email` is lowercased by the writer before the insert.** Neither engine folds case in a UNIQUE
index by default, so `A@x` and `a@x` would both be admitted as separate people.

**Why the role sits on the user and not on the token.** R-6.1 makes `_meta.budget` visibility a
function of the principal's role. Two tokens of one person could otherwise disagree about that role.

**The first admin is created by a seed migration** (owner decision 2026-08-13, closing
`OQ-T014-DM-3`). Its audit row carries `actor_user_id = NULL` (§4.5.5).

**The migration takes the digest and the visible prefix as parameters**, as the reference project
does (`/Users/sergey/dev-projects/n8n-lazy-loading-skills/sql/019_seed_admin.sql:7`
`-v ADMIN_TOKEN_SHA256=abc123...64hexchars`). The plaintext token reaches neither disk nor the
repository.

**Why a migration and not a row the process writes at first start.** A first-start path that creates
an admin is reachable before any admin exists. The digest form it must produce is §7.5.2's.

**Rows are never deleted.** Withdrawal of access is `status = 'suspended'` plus token revocation.
Consequence: no `ON DELETE` clause is declared anywhere in §4.5, and the audit table needs no
exception for a cascade (§4.5.5).

**`access_profiles` — purpose:** the settings entity a token references (R-13.1).

```sql
CREATE TABLE IF NOT EXISTS access_profiles (
  id                  TEXT PRIMARY KEY NOT NULL,   -- ULID
  name                TEXT NOT NULL,      -- 'phase0-unlimited'
  status              TEXT NOT NULL,      -- 'active' | 'retired'
  credits_mode        TEXT NOT NULL,      -- 'unlimited' | 'metered'   (ADR-003 D5: creditsBalance)
  credits_balance_raw TEXT,               -- exact value as a string (§1.7)
  rate_limit_mode     TEXT NOT NULL,      -- 'unlimited' | 'metered'   (ADR-003 D5: rateLimit)
  rate_limit_per_min  INTEGER,
  tool_allowlist_mode TEXT NOT NULL,      -- 'all' | 'list'            (ADR-003 D5: toolAllowlist)
  tool_allowlist_json TEXT,               -- JSON array as TEXT (§1.4)
  route_disclosure_mode TEXT NOT NULL DEFAULT 'full',
                                          -- 'full' | 'none'           (R-20.3)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (name),
  CHECK (status IN ('active','retired')),
  CHECK (credits_mode IN ('unlimited','metered')),
  CHECK (rate_limit_mode IN ('unlimited','metered')),
  CHECK (tool_allowlist_mode IN ('all','list')),
  CHECK (route_disclosure_mode IN ('full','none')),
  CHECK ((credits_mode = 'metered') = (credits_balance_raw IS NOT NULL)),
  CHECK ((rate_limit_mode = 'metered') = (rate_limit_per_min IS NOT NULL)),
  CHECK ((tool_allowlist_mode = 'list') = (tool_allowlist_json IS NOT NULL))
);
```

- **Primary key:** `id`. **Natural UNIQUE dedup key:** `name`.
- **Indexes:** none beyond the two the keys create.
- **Serves:** R-13.1, R-13.7, R-14.4, R-20.3.
- **Phase-0 seed:** one row, `name = 'phase0-unlimited'`, all three limit modes at their unlimited
  value and `route_disclosure_mode = 'full'`.

**The seed row's `id` is a literal ULID written into both migrations, not generated per engine.**
The insert is `ON CONFLICT (name) DO NOTHING`, so re-running either migration adds nothing.

**Why a literal and not a generated value.** A migration is not the application, and two engines
seeding independently would produce two ids for one profile. A token's `access_profile_id` would
then resolve on one host and dangle on the other. This is the one place §1.3's "the app generates
ids" is served by a committed constant rather than by a call at write time.

**Why each limit carries a mode column.** "Unlimited" is declared, never inferred from a missing
value. A NULL that means unlimited cannot be told apart from a profile that was never provisioned.
In L-10, 43 of 458 chains answered a confident "not deployed" and both gates stayed green
(`docs/issues/l-10-two-defillama-chain-vocabularies-43-of-458-chains-answer-a-confident-not-deployed.md`).

**An empty `tool_allowlist_json` under `mode = 'list'` is a reachable state.** It means no tool is
permitted. It is not the same state as `mode = 'all'`, and the three `CHECK` pairs keep the two
apart at the engine level.

**`route_disclosure_mode` is the fourth setting on this entity** (owner decision 2026-08-13, closing
`OQ-T014-IF-1`). It governs whether a successful response may name the resolution route. The route
composition is the set of adapters walked and the order of the walk. The column is a setting of the
access profile, not of the transport and not of the role. Its reader is designed in
`interfaces.md`, not here.

**Scope of the column.** It does not govern `tier`, which `ADR-002` D8 forbids on the wire
unconditionally. It does not govern `_meta.budget`, which stays bound to role `admin` (R-6.1).

**Why it is a mode column with no paired value.** The other three settings pair a mode with a
magnitude. This setting has no magnitude, so the mode is the whole value. `NOT NULL` plus the
`CHECK` keeps disclosure declared rather than inferred. An unprovisioned profile cannot reach an
undeclared state that a reader would have to interpret.

**Why the default is `'full'`.** Phase 0 issues one self-issued token under `ADR-003` D5. That
decision gives it all tools and unlimited quota. The column exists from the start at its permissive
value, by `ADR-003` D5's own argument that an absent field cannot be set to unlimited.

**The column is movable to Postgres under R-29.4.** Its values only remove fields from a response.
A narrowing setting is what R-29.4 admits.

**`credits_balance_raw` is TEXT, unlike `usage.credits_used`.** It is a client-facing balance in our
own currency, and §1.7 names credits as the reason exact values are strings. `usage.credits_used` is
a small internal counter and stays `INTEGER` (§4.2).

**The three limit values are not read from this table in T-014.** R-13.3 puts their source in code
defaults for this milestone, behind an asynchronous reader (R-13.2, AC-38). The columns exist so the
second provider has a target and so R-29.4 can move them later without a schema change. One provider
is configured at a time, so no precedence rule between the two is defined.

#### 4.5.4. `api_tokens`

**Purpose:** the credential presented in `Authorization`, stored as a digest.

```sql
CREATE TABLE IF NOT EXISTS api_tokens (
  id                TEXT PRIMARY KEY NOT NULL,   -- ULID
  user_id           TEXT NOT NULL REFERENCES users(id),
  access_profile_id TEXT NOT NULL REFERENCES access_profiles(id),
  token_hash        TEXT NOT NULL,      -- sha256(pepper || presented), lowercase hex — §7.5.2
  prefix            TEXT NOT NULL,      -- the token's visible leading characters (R-15.2)
  name              TEXT,
  status            TEXT NOT NULL,      -- 'active' | 'revoked'
  expires_at        INTEGER,            -- epoch-ms UTC; NULL = no expiry
  revoked_at        INTEGER,            -- epoch-ms UTC
  created_at        INTEGER NOT NULL,
  UNIQUE (token_hash),
  UNIQUE (prefix),
  CHECK (length(token_hash) = 64),
  CHECK (length(prefix) >= 8),
  CHECK (status IN ('active','revoked')),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens (user_id);
```

- **Primary key:** `id`. **Natural UNIQUE dedup key:** `token_hash`.
- **Second UNIQUE:** `prefix` — identification must be unambiguous.
- **Index:** `(user_id)` — listing and revoking a person's tokens.
- **Serves:** R-15.1a, R-15.2, R-15.5, R-13.1.

**The secret is never stored.** The column holds `sha256(pepper || presented)` as 64 hex characters;
the `length` check is the TEXT equivalent of the reference's `octet_length(token_hash) = 32`.

**`pepper` is the token hashing salt R-29.1 keeps in `.env` permanently**, allocated as
`ONCHAIN_TOKEN_HASH_SALT` (`deployment.md` §10.3). The digest form is decided in
`security.md` §7.5.2; this column carries it.

**Why the pepper is named here and not left to the reader.** An earlier revision of this line said
`sha256` of the presented secret with no salt input, and that column definition was the weakest of
the three the architecture then carried. A stolen table without a pepper is a candidate list for an
offline dictionary attack.

**The pepper does not change the column's width or its dialect** (§4.5.2). It is an input to the
digest, not a stored value, so `CHECK (length(token_hash) = 64)` holds unchanged.

**Why `prefix` is UNIQUE here and not in the reference.** R-15.2 requires the prefix to identify a
token without disclosing it. A duplicate prefix would make that identification ambiguous. The issue
path retries on the constraint failure rather than writing an ambiguous row.

**Why `scopes` is absent.** The narrowing lives on the access profile (`tool_allowlist_json`), which
the token references. Carrying both would put the same fact in two places, and the two would
diverge on the first change — the rule §4.2.3 already applies to coverage.

**Why there is no `last_used_at`.** `request_trace` records every use with its principal (§4.5.7),
so the question is answered by a query. An `UPDATE` per request would put a write on the path R-3
requires to run before routing.

**The authentication read, stated so the transport designer can hold it:**

```sql
SELECT t.id, t.status, t.expires_at, t.access_profile_id,
       u.id AS user_id, u.role, u.status AS user_status
  FROM onchain.api_tokens t
  JOIN onchain.users u ON u.id = t.user_id
 WHERE t.token_hash = $1;
```

One indexed equality read, both objects schema-qualified (R-30.1). This store is not the
`CacheStore`: the unauthenticated path performs no cache read and no vendor call (R-3.3, R-3.4).

**Why the liveness predicate is applied in code and not in the `WHERE` clause.** A query returning
zero rows cannot distinguish an unknown token from a revoked one. R-26 needs the class, and R-31
renders it twice.

**Revocation takes effect on the next request** (R-15.6, AC-26). No verified-token cache is
introduced in T-014, so there is no interval during which a revoked token still answers.

#### 4.5.5. `access_audit`

**Purpose:** the append-only record of what an admin did to users, tokens and profiles.

```sql
CREATE TABLE IF NOT EXISTS access_audit (
  id            TEXT PRIMARY KEY NOT NULL,   -- ULID; time-sortable, so the log reads in order
  ts            INTEGER NOT NULL,   -- epoch-ms UTC
  actor_user_id TEXT REFERENCES users(id),
  action        TEXT NOT NULL,      -- 'user.create' | 'user.suspend' | 'token.issue' | 'token.revoke' | 'profile.update'
  target_type   TEXT NOT NULL,      -- 'user' | 'api_token' | 'access_profile'
  target_id     TEXT NOT NULL,
  before_json   TEXT,               -- JSON as TEXT (§1.4)
  after_json    TEXT,
  created_at    INTEGER NOT NULL,
  CHECK (target_type IN ('user','api_token','access_profile'))
);
CREATE INDEX IF NOT EXISTS idx_access_audit_actor  ON access_audit (actor_user_id);
CREATE INDEX IF NOT EXISTS idx_access_audit_target ON access_audit (target_id);
CREATE INDEX IF NOT EXISTS idx_access_audit_ts     ON access_audit (ts);
```

- **Primary key:** `id`. **Natural UNIQUE dedup key:** none — see the deviation in §4.5.9.
- **Indexes:** three, matching the reference's three query shapes: by actor, by target, by time.
- **Serves:** R-15.7, AC-41.

**`before_json` and `after_json` never carry the secret or its digest.** A token event records the
token's `id` and `prefix`. The audit is read by more readers than the authentication path, and a
digest is a verifier.

**Append-only is enforced by the engine, in both dialects.** Postgres takes the reference's pair — a
`DO INSTEAD NOTHING` rule on `DELETE` and a `BEFORE UPDATE` trigger that raises. SQLite takes two
`BEFORE` triggers with `RAISE(ABORT)`. The guard is not part of the portable shape: dropping it
changes no column, so an engine move stays mechanical.

**Our trigger is stricter than the reference's.** The reference permits one `UPDATE` shape, the
`ON DELETE SET NULL` cascade of `actor_user_id`. No row here is ever deleted (§4.5.3), so that
cascade cannot fire and no exception is written.

#### 4.5.6. `provider_buckets` — the shared vendor limiter (R-7)

**Purpose:** the token-bucket state that today lives in a process-local `Map`
(`packages/core/src/net/rate-limit.ts:255` `const buckets = new Map<string, BucketState>();`).

```sql
CREATE TABLE IF NOT EXISTS provider_buckets (
  provider       TEXT NOT NULL REFERENCES providers(id),
  scope_key      TEXT NOT NULL DEFAULT '',  -- '' = one bucket per provider (R-7.4)
  tokens         REAL NOT NULL,             -- may be negative — the backlog
  last_refill_ms INTEGER NOT NULL,          -- epoch-ms UTC
  updated_at     INTEGER NOT NULL,          -- epoch-ms UTC
  PRIMARY KEY (provider, scope_key)
);
```

- **Primary key and natural UNIQUE dedup key:** `(provider, scope_key)` — R-7.3.
- **Indexes:** none beyond the primary key. Every access is an exact-key upsert.
- **Serves:** R-7.1, R-7.2, R-7.3, R-7.4, R-7.4a, AC-4, AC-5, AC-40, AC-42.

**This is the only cross-group foreign key among the eight tables of §4.5**, and it depends on §4.4
carrying `providers` into the Postgres migration. The other seven reference only tables of their own
group or nothing at all.

**The dependency stated as a condition:** the Postgres migration creates `onchain.providers`
before `onchain.provider_buckets`, and the startup bootstrap upserts every adapter row
(§4.2) before the limiter takes its first token. Removing `providers` from that migration turns
every limiter write into a foreign-key failure, and R-7.7 would degrade the process to its
in-process bucket permanently.

**AC-4 measures two processes of one deployment profile against one store.** Two `network`
processes share one Postgres; two `local` processes share one `DATA_DIR`.

**Why the profiles are not measured against each other.** The owner switches `.mcp.json` from stdio
to HTTP and does not run both (owner decision 2026-08-13, §4.5.11). Two processes on two engines
would hold two independent buckets, and no row in this table would reconcile them.

**`scope_key` is `NOT NULL DEFAULT ''`, never nullable.** SQLite accepts NULL in a primary-key
column and Postgres rejects it. A nullable scope would make one dialect dedup and the other refuse
the row.

**`scope_key` values.** `rpc-evm` declares the chain slug (R-7.4a). Every other provider declares
nothing and gets `''`, which is one bucket for all its calls (AC-40, tested on `defillama`).

**`tokens` is `REAL` and may go negative.** The in-process bucket it replaces already holds a float
and already goes negative (`packages/core/src/net/rate-limit.ts:307`
`const waitMs = (-bucket.tokens / config.refillPerSec) * 1000;`).

**Why the stored value is not clamped at zero.** The next caller computes its wait from that
negative remainder. A clamped row would hand every waiting caller the same zero wait.

**Why `REAL` does not contradict §1.7.** That rule governs credits and wei-like integers. A bucket
balance is a computed float, not an exact value we received from anyone.

**Atomicity mirrors `usage_window`** (R-7.2). Refill, consume and read happen in one statement:

```sql
INSERT INTO onchain.provider_buckets (provider, scope_key, tokens, last_refill_ms, updated_at)
VALUES ($1, $2,
        CAST($3 AS DOUBLE PRECISION) - CAST($4 AS DOUBLE PRECISION),
        CAST($5 AS BIGINT), CAST($5 AS BIGINT))
ON CONFLICT (provider, scope_key) DO UPDATE SET
  tokens = LEAST(CAST($3 AS DOUBLE PRECISION),
                 onchain.provider_buckets.tokens
                 + GREATEST(0, CAST($5 AS BIGINT) - onchain.provider_buckets.last_refill_ms)
                   / 1000.0 * CAST($6 AS DOUBLE PRECISION))
           - CAST($4 AS DOUBLE PRECISION),
  last_refill_ms = CAST($5 AS BIGINT),
  updated_at = CAST($5 AS BIGINT)
RETURNING tokens;
```

`$3` is capacity, `$4` is weight, `$5` is now, `$6` is `refillPerSec`.

- **Dialect difference:** scalar minimum is `LEAST` in Postgres and `MIN` in SQLite. The statement
  text is per dialect; the key, the columns and the arithmetic are identical.

**Two details were added by task 014-18, which wrote the statement.** Each closes a hole the first
rendering left open, and neither changes what the statement is for.

1. **`GREATEST(0, …)` on the elapsed interval** (`MAX(0, …)` in SQLite). `$5` is `Date.now()`, a
   wall clock, and an NTP correction steps it backwards. Unclamped, the refill term goes negative
   and the statement CHARGES the caller for time that did not pass. That over-restricts rather than
   over-admits, so it was never a money defect. It would still be a difference between the shared
   limiter and the bucket R-7.7 degrades to, which has always clamped
   (`Math.max(0, nowMs - bucket.lastRefillMs)`) — and that is the one place a difference must not
   be.
2. **Every parameter is cast, in `CAST(x AS t)` form rather than `x::t`.** Postgres infers a
   parameter's type from context and `$3 - $4` has none — it refuses the statement with "could not
   determine data type of parameter". The standard form was chosen over `::` because SQLite parses
   it too, which is what lets `packages/core/test/pg-store-parity.test.ts` execute this exact text
   against an in-memory engine rather than a paraphrase of it (R-21 forbids a database in CI).

- **SQLite requires `RETURNING`, available since 3.35.** Measured 2026-08-12: `better-sqlite3` in
  this repo reports `sqlite_version() = 3.49.2`.
- **The SQLite path wraps the statement in `db.transaction(fn).immediate()`,** the same discipline
  `checkAndReserve` uses (`packages/core/src/cache/budget-store.ts:420` `return attempt.immediate();`).

**The refund is a second statement.** A refusal adds `weight` back
(`tokens = tokens + $4`). Between the two statements another process can observe a more negative
bucket. That over-restricts and never over-admits, which is the direction a vendor ceiling tolerates.

```sql
UPDATE onchain.provider_buckets
   SET tokens = tokens + CAST($3 AS DOUBLE PRECISION), updated_at = CAST($4 AS BIGINT)
 WHERE provider = $1 AND scope_key = $2;
```

- **`UPDATE`, never an upsert.** A refund with no row is a refund for a slot nobody took, and this
  call carries no capacity to seed a row with.
- **`last_refill_ms` is not in the `SET` list, deliberately.** It marks the instant the bucket was
  last brought forward. Moving it here would discard the interval since that instant, so the next
  caller's refill would start from the wrong place — a limiter that quietly tightens on every
  refusal. `updated_at` moves, because it is an audit column and this is a write.
- **It is not `take` with a negative weight.** A refund must neither refill nor clamp: routed
  through the upsert it would re-apply `LEAST(capacity, …)` and could hand back a token the elapsed
  time had not earned.

**The `throttle` signature is unchanged** (R-7.5): `packages/core/src/net/rate-limit.ts:52`
(`export type Throttle = (`) keeps `(providerId, config, weight?, deadlineAtMs?) => Promise<void>`.
This section proposed carrying the scope in `TokenBucketConfig`. Task 014-17 composed it into the
FIRST argument instead (`scopedProviderId` / `limiterKeyOf`, separator `#`), so no per-provider rate
declaration had to be edited to express a fact concerning one provider. The field's name was always
the interface designer's choice; the storage key is `(provider, scope_key)` either way.

**Degradation on storage failure writes no row here** (R-7.7). The process falls back to the
in-process bucket and writes a `limiter.degraded` diagnostics row (§4.5.8, AC-45).

**No cleanup job.** The row count is bounded by providers times declared scopes: twelve adapters
plus at most one row per registry chain for `rpc-evm`, so under 500 rows permanently.

#### 4.5.7. `request_trace` — the per-request record T-015 charges from (R-27)

**Purpose:** one row per served request, recording the principal, the capability, the time, the
outcome class, whether the answer came from cache or from a vendor, and the vendor spend it caused.

```sql
CREATE TABLE IF NOT EXISTS request_trace (
  id                  TEXT PRIMARY KEY NOT NULL,   -- ULID
  received_at         INTEGER NOT NULL,   -- epoch-ms UTC, pinned at admission (R-27.5)
  completed_at        INTEGER NOT NULL,   -- epoch-ms UTC
  principal_id        TEXT NOT NULL,      -- api_tokens.id, or 'local' in the local profile
  user_id             TEXT,               -- users.id; NULL in the local profile
  access_profile_id   TEXT,
  client_request_id   TEXT NOT NULL,      -- client-supplied, else server-minted ULID
  session_id          TEXT,               -- transport session label
  transport           TEXT NOT NULL,      -- 'stdio' | 'http'
  tool                TEXT NOT NULL,
  capability          TEXT,               -- NULL when no capability was resolved — see §4.5.7a
  args_hash           TEXT,               -- the same value cache_entries carries
  outcome             TEXT NOT NULL,      -- 'answer' | 'refusal' | 'partial_deadline'
  refusal_class       TEXT,               -- error class name, only when outcome='refusal'
  served_from         TEXT NOT NULL,      -- 'cache' | 'coalesced' | 'vendor' | 'none'
  cache_age_ms        INTEGER,
  vendor_provider     TEXT REFERENCES providers(id),
  vendor_credits      INTEGER,            -- credits this request added to usage; NULL when served_from='coalesced'
  vendor_calls        INTEGER,            -- calls this request added to usage_window.calls_made; NULL when served_from='coalesced'
  vendor_day          INTEGER,            -- usage(provider, day) coordinate
  vendor_window_start INTEGER,            -- usage_window(provider, window_start) coordinate
  escalated_to_paid   INTEGER NOT NULL DEFAULT 0,  -- 0 | 1 (R-28.2)
  tried_json          TEXT,               -- the ordered walk, JSON as TEXT
  created_at          INTEGER NOT NULL,
  UNIQUE (principal_id, client_request_id, received_at),
  CHECK (outcome IN ('answer','refusal','partial_deadline')),
  CHECK (served_from IN ('cache','coalesced','vendor','none')),
  CHECK ((outcome = 'refusal') = (refusal_class IS NOT NULL)),
  CHECK (escalated_to_paid IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_request_trace_principal ON request_trace (principal_id, received_at);
CREATE INDEX IF NOT EXISTS idx_request_trace_received  ON request_trace (received_at);
CREATE INDEX IF NOT EXISTS idx_request_trace_spend     ON request_trace (vendor_provider, vendor_day);
```

- **Primary key:** `id`. **Natural UNIQUE dedup key:**
  `(principal_id, client_request_id, received_at)`.
- **Indexes:** `(principal_id, received_at)` for T-015's per-principal period query;
  `(received_at)` for retention; `(vendor_provider, vendor_day)` for reconciling against `usage`.
- **Serves:** R-27.1 through R-27.7, R-28.2, AC-39, AC-43.

**`outcome` uses ADR-003 D4's three classes** and nothing else: an answer, a refusal, and a partial
answer delivered under the deadline. The third settles at full price in T-015, so it must not be
folded into either neighbour.

**`served_from` has four values, and `coalesced` is the fourth** (owner decision 2026-08-13, closing
`OQ-T014-SA-1`). A request that waited on another request's outstanding vendor call records
`coalesced`; the leader records `vendor`.

**Why the follower is not recorded as `vendor` or as `cache`.** Both clients are charged (OQ-6), and
one vendor call served two charges. Folding the follower into either neighbour loses the count
T-015 must trace: how many charges one vendor call produced.

**A `coalesced` row carries no vendor spend of its own.** `vendor_credits` and `vendor_calls` are
both NULL on that row, and the leader's row holds the whole amount.

**Why NULL and not `0`.** Zero asserts that the spend was measured here and came to nothing, which
is false — the spend sits on the leader's row. NULL states that no amount is attributable here.

**Summing over a period reconciles against `usage` without double-counting** (R-27.3). `SUM` skips
NULL inputs in both engines, so a follower's row adds nothing to either total. A period that
contains only followers sums to NULL, which the reader reports as no attributable spend.

**The two bucket coordinates are still written on a `coalesced` row.** They name which `usage` and
`usage_window` buckets the leader's call landed in, which is how T-015 joins a follower's charge to
the spend that served it.

**One exception, measured during task 014-30 and decided as `OD-014-30-4` (2026-08-16).** A follower
whose own deadline expires before the leader committed its reservation has no coordinate to name:
the leader may still be inside its `/account` resync, and R-27.7 forbids revising the row later.
That row carries `vendor_provider` and two NULL coordinates. `vendor_provider` is what keeps it
distinguishable from a request that involved no vendor at all — the latter has no vendor column
filled. Rejected: delaying the row until the leader settles — it would stop being one write at
completion. Also rejected: writing a coordinate derived from the follower's own clock. A velocity
window is 60 000 ms wide and the nansen capabilities declare `deadlineMs: 60_000`, so the derived
bucket would routinely hold none of the spend.

**Every component of the dedup key is `NOT NULL`.** In both engines a NULL never equals a NULL in a
unique index, so one nullable component would disable dedup entirely. The server mints
`client_request_id` when the client omits it.

**Why `received_at` is part of the key.** A client retry is a new server-side request: it is
admitted again, reads the cache again, and may call a vendor again. Its own row must exist. Charge
idempotency by `client_request_id` is T-015's, one layer up.

**One write, at completion — no reserve-then-update.** R-27.7 makes this an append-only ledger, and
a two-phase row would not be one. Consequence, stated rather than hidden: a process that dies
mid-request leaves no trace row. This is the opposite choice from `usage`, which is an additive
counter and therefore can reserve and reconcile (§4.2).

**What is left of such a request, stated exactly.** Whatever `diagnostics` rows it wrote before
dying, whose `trace_id` then resolves to nothing (§4.5.8). A request that dies without emitting one
of the eight events is **not observable at all**. The dictionary carries no event for an interrupted
request, and a dead process writes nothing on its way out.

**Why that gap is accepted rather than closed.** Closing it needs a reserve-then-update row, which
R-27.7 forbids, or a second ledger with its own crash window. The billing consequence is bounded:
a request that never completed also never reached the vendor spend it would have been charged for.

**A paid call finished after the client disconnected does write its row** (R-17). The process is
alive; only the delivery failed. Its outcome is `answer` and its `served_from` is `vendor`, with the
vendor coordinate columns filled — the spend happened and T-015 must see it.

**The link to the vendor spend is a coordinate, not a row reference.** `usage` is keyed
`(provider, day)` and `usage_window` is keyed `(provider, window_start)`; both are bucketed
counters, so no per-call row exists to point at. The trace records the two bucket coordinates plus
this request's own contribution (`vendor_credits`, `vendor_calls`), which is what T-015 needs to
reconcile a charge against a bucket (R-27.3).

**`args_hash` is stored, and it is the same value `cache_entries` carries** — `deriveArgsHash(capability, args)`
(`packages/core/src/net/args-hash.ts:44` `export function deriveArgsHash(capability: string, args: Record<string, unknown>): string {`).
Two traces of different principals over equal arguments therefore hold equal hashes, which is what
AC-8 observes. T-014 adds no principal to that input (R-5.1).

**`principal_id` is a label, not a foreign key.** The local profile's principal has no token row, so
a foreign key would refuse the write on the transport that needs no token at all.

**`tried_json` is operator-side data.** It names adapters and their order. R-20.3 and R-31.4 forbid
that in the client rendering; the ledger is not the client rendering.

**Retention, mapped onto DB-SCHEMA §4's three layers:** `tried_json` is the RAW layer and is set to
NULL after 90 days, the row itself is the NORMALIZED layer and is kept at least one year. Both
passes are jobs that write to `retention_runs` (§4.5.9).

#### 4.5.7a. `capability` is NULL in two cases, not one

An earlier revision of the column comment named only the failure case. There is a second, and it is
on the success path.

| Case                                   | `outcome` | Example                                              |
| :------------------------------------- | :-------- | :--------------------------------------------------- |
| the request failed before resolution   | `refusal` | a saturated limiter refuses before a route is chosen |
| the tool resolves no capability at all | `answer`  | `onchain_ping`, `onchain_list_chains`                |

**`outcome = 'partial_deadline'` does not mean a partial result.** `reliability.md` §9.1 (owner
decision 2026-08-03, R-156) withdrew returning one: an expired deadline throws, and that row is a
`refusal`. The surviving branch is a **complete** answer delivered past the declared ceiling —
`deadlineOverrunMs`, surfaced as `_meta.timing.overrunMs` (OQ-T012-6). The value keeps the name
`ADR-002` D4 gave it.

**Why the name is kept rather than corrected.** It is already a `CHECK` constraint value in a
schema two milestones old. Renaming it buys accuracy in one comment and costs a migration plus every
reader's memory of the old value.

**Why the second case exists.** `tool` is `NOT NULL` and `capability` is not, because the trace is
written in `defineTool`'s wrapper (`system-architecture.md` §3.4.3) — above the capability layer.
Two tools of the registry — `onchain_ping` and `onchain_list_chains` — answer without calling
`resolveCapability`, so a schema that required a
capability on every successful row could not record them.

**Why this matters to T-015.** A row with `outcome = 'answer'` and a NULL `capability` is a billable
request that consumed no vendor call. Reading NULL as "something went wrong" would drop it from the
count.

#### 4.5.8. `diagnostics` — the stored channel (R-32)

**Purpose:** the events an administrator must be able to read without access to the process stderr.

```sql
CREATE TABLE IF NOT EXISTS diagnostics (
  id           TEXT PRIMARY KEY NOT NULL,   -- ULID
  ts           INTEGER NOT NULL,   -- epoch-ms UTC
  severity     TEXT NOT NULL,      -- 'info' | 'warn' | 'error'
  event        TEXT NOT NULL,      -- closed vocabulary, table below
  principal_id TEXT,               -- NULL when the request was refused before a principal existed
  session_id   TEXT,
  provider     TEXT,
  capability   TEXT,
  trace_id     TEXT,               -- request_trace.id, when the event belongs to a served request
  detail_json  TEXT NOT NULL,      -- JSON as TEXT (§1.4) — the FULL operator rendering (R-31.1)
  created_at   INTEGER NOT NULL,
  CHECK (severity IN ('info','warn','error'))
);
CREATE INDEX IF NOT EXISTS idx_diagnostics_ts       ON diagnostics (ts);
CREATE INDEX IF NOT EXISTS idx_diagnostics_event_ts ON diagnostics (event, ts);
```

- **Primary key:** `id`. **Natural UNIQUE dedup key:** none — see §4.5.9.
- **Indexes:** `(ts)` for retention and for the daily read; `(event, ts)` for one class over a period.
- **Serves:** R-19.3, R-19.4, R-28.1, R-31.1, R-32.2, AC-28, AC-43, AC-45, AC-48.

**`trace_id` carries no `REFERENCES` clause, deliberately.** A diagnostics row is written when the
event happens; the trace row is written once, at completion (§4.5.7).

**Why a foreign key here would refuse the write.** `limiter.degraded` fires mid-request, before the
trace row exists. With `PRAGMA foreign_keys=ON` (DB-SCHEMA §1.6) that insert would fail, and the
process would lose the diagnostic that says the limiter degraded. The reader joins on the column;
a row whose `trace_id` matches nothing is a request that did not reach completion.

**The event vocabulary is closed and compiled**, like the capability manifest (§4.1) — a committed
TypeScript literal, not a table.

| `event`                    | Written when                                                       | Requirement |
| :------------------------- | :----------------------------------------------------------------- | :---------- |
| `auth.rejected`            | a request presents no valid token                                  | R-19.3      |
| `perimeter.rejected`       | `Host` or `Origin` fails the transport check                       | R-19.4      |
| `session.limit_reached`    | the session ceiling refuses a new session                          | R-24.3      |
| `session.evicted`          | an idle session is dropped                                         | R-24.2      |
| `limiter.degraded`         | the shared limiter store failed and the process fell back          | R-7.7       |
| `source.escalated_to_paid` | a free source in a route yielded nothing and a paid one was called | R-28.1      |
| `tool.refused`             | a tool execution failed; `detail_json` holds the full text         | R-31.1      |
| `retention.cleanup`        | a retention job finished                                           | R-32.3      |

**This condition won, and R-28.1's own wording did not** (`OQ-014-28-A`, owner decision 2026-08-20).
R-28.1 says "the free source was EXHAUSTED", which this engine cannot observe: `blockscout`'s PRO key
meters credits at the VENDOR, no counter for it exists here, and `ADR-003` assigns that counter to
T-015. Under that reading the mechanism would ship and never fire, leaving AC-43 green over a dead
feature. The condition above — entered, then a paid source entered — is what both carriers use:
`request_trace.escalated_to_paid` and this event. `docs/TASK.md` R-28.1 keeps its wording; this is
the reading it is implemented under.

**A paid source entered and then FAILED still counts.** The rule is "entered", the same one
`paidProviderToReport` applies: an entered source can have committed a reservation. Whether it
answered is a different column.

**Why the vocabulary is compiled rather than free text.** An event name invented at runtime makes
AC-48's query impossible to write, and the same three reasons §4.2.1 gives for the chain registry
apply: the offline gate, CI determinism, and a reviewable diff.

**The stderr rendering of an event omits `principal_id` and carries the row `id` instead.** R-5.3
forbids the principal on stderr; R-19.3 requires authentication failures to be observable. The row
id satisfies both, and the principal is read from the table.

**`id` is the join key between a refusal shown to a client and its full text** (owner decision
2026-08-13, closing `OQ-T014-SEC-2`). No second identifier is added to this table.

**Why the existing column is used.** It is already the handle the stderr rendering carries
(paragraph above). A second identifier would carry its own uniqueness rule and its own retention.

**A refusal that shows an identifier to a client writes its row before the response is sent.** The
tool-level class writes `event = 'tool.refused'`, with the full operator text in `detail_json`
(R-31.1, R-32.2).

**Why the write precedes the response.** An identifier that resolves to nothing is worse than no
identifier.

**The identifier is safe to hand to an untrusted client.** Two properties of ULID-as-`TEXT`
(DB-SCHEMA-CONCEPT §1.3) give that: 80 random bits per value, and a payload of timestamp and
randomness only.

**Why those two properties are the required ones.** The random half leaves another principal's row
non-derivable from a held id. The absent payload keeps the refusal reason in `event` and
`detail_json`, under the visibility rules that already bind those columns.

**Retention consequence.** The row falls under §4.5.9's window, which is a movable setting. An
identifier older than the current window resolves to no row.

**A lookup separates an expired identifier from an unknown one.** The first ten characters of a ULID
are its epoch-ms timestamp (§1.3, time-sortable id). An id older than the oldest retained row is
reported as expired.

**The client rendering carries no expiry hint. Recorded as a limit, not as a design.** The client
reads neither the configured window nor the oldest retained row.

**Retention window = 90 days = the RAW-tier floor of DB-SCHEMA §4; measured: none, no diagnostics
volume exists yet; applied 90 days as a floor.** The first month's row count is measured and
recorded in this section before the number is treated as settled. The setting's class is R-29.4
(§4.5.9).

#### 4.5.9. `retention_runs`, the cleanup job, and one recorded deviation

**Purpose:** the record DB-SCHEMA §4 demands of every retention pass — how many rows, and for which
period.

```sql
CREATE TABLE IF NOT EXISTS retention_runs (
  id            TEXT PRIMARY KEY NOT NULL,   -- ULID
  job           TEXT NOT NULL,      -- 'diagnostics.purge' | 'request_trace.raw_null' | 'request_trace.purge'
  target_table  TEXT NOT NULL,
  period_from   INTEGER NOT NULL,   -- epoch-ms UTC, inclusive
  period_to     INTEGER NOT NULL,   -- epoch-ms UTC, exclusive
  rows_affected INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,   -- epoch-ms UTC
  finished_at   INTEGER NOT NULL,   -- epoch-ms UTC
  outcome       TEXT NOT NULL,      -- 'ok' | 'failed'
  detail_json   TEXT,
  UNIQUE (job, period_from, period_to, started_at),
  CHECK (outcome IN ('ok','failed')),
  CHECK (period_to > period_from),
  CHECK (rows_affected >= 0)
);
CREATE INDEX IF NOT EXISTS idx_retention_runs_job ON retention_runs (job, started_at);
```

- **Primary key:** `id`. **Natural UNIQUE dedup key:**
  `(job, period_from, period_to, started_at)`.
- **Index:** `(job, started_at)` — the last run of one job.
- **Serves:** R-32.3, DB-SCHEMA §4.

**A pass that deleted zero rows still writes a row.** "Nothing to delete" and "the job did not run"
are different facts, and only a written row tells them apart.

**The retention window is a movable setting of class R-29.4** (owner decision 2026-08-13, closing
`OQ-T014-DM-2`). Its carrier is the parameter node of the `onchain-retention` workflow
([deployment.md](deployment.md) §10.3.1), and no environment key holds it.

**Each window is bounded by a compiled floor and a compiled maximum**
([deployment.md](deployment.md) §10.3.1 carries the three ranges). A configured value outside its
range is refused, never clamped.

**A refused window writes a row and deletes nothing.** The pass records `outcome = 'failed'` and
names the refused setting in `detail_json` ([deployment.md](deployment.md) §10.6.1).

**Why a refusal and not a clamp.** A clamped window deletes rows the operator asked to keep, and
this table would record the clamped period as the requested one.

**Why the class is R-29.4 and not R-29.2.** A bootstrap setting changes only through a release, and
shortening a retention window is the operation R-29.4 exists to allow without one.

**The passes run outside the server process** (R-32.3, owner decision 2026-08-13, closing
`OQ-T014-DEP-2`). Their executor is designed in [deployment.md](deployment.md) §10.6; this section
owns only the row each pass writes.

**`retention_runs` is never cleaned.** It grows by a few rows per day, and the job that would clean
it would have to write into it.

**Deviation.** DB-SCHEMA-CONCEPT §1.5 requires a natural UNIQUE dedup key on every append-only
table; `access_audit` and `diagnostics` carry none. Two identical events one millisecond apart are
two facts, and a key that collapsed them would under-count exactly the burst a security log exists
to show. Both tables are written once per event, with no re-run path, and the ULID primary key
carries identity. Recorded here rather than resolved silently.

#### 4.5.10. What T-014 does not persist

- **Sessions.** The `sessionId` → `McpServer` mapping is process memory (R-2.3). `request_trace.session_id`
  and `diagnostics.session_id` are labels with no foreign key.
- **The bearer secret.** Only the peppered digest `sha256(pepper || presented)` is stored
  (R-15.1a, §4.5.4). The pepper itself stays in `.env` and is never a column (R-29.1).
- **The principal in the cache key.** `deriveArgsHash` keeps its two inputs, and
  `UNIQUE (provider, capability, args_hash)` (`packages/core/src/cache/ddl.ts:63`
  `UNIQUE (provider, capability, args_hash)`) is unchanged (R-5.1, ADR-003 D4).
- **`tier`.** It stays an adapter registration field. `providers.kind` already mirrors it internally
  and is not published (R-6.2).
- **The client rendering of a refusal.** The ledger holds the operator rendering; the client one is
  produced per response and never stored (R-31).

#### 4.5.11. Questions this section raised, and the decisions that closed them

All three are closed. No question of this section blocks the planning phase.

**`OQ-T014-DM-1`, 2026-08-13, owner Sergey: the two deployment profiles are never run concurrently
against one vendor account.** The owner switches `.mcp.json` from stdio to HTTP rather than running
both. Rejected: one spend ledger shared across the two storage engines — SQLite and Postgres hold
two independent daily ceilings, and no row of `usage` reconciles them.

**Consequence for AC-4.** It measures two processes of ONE deployment profile against one store: two
`network` processes on one Postgres, or two `local` processes on one `DATA_DIR` (§4.5.6).

**Consequence for UC-3 A1** (`docs/tasks/task-014-t014-http-transport-auth-perimeter-profiles-shared-limiter.md:514-515` `сетевой сервер запущен над тем же` `DATA_DIR`).
That pair is a `local` process beside a `network-sqlite` one, and the constraint says the owner does
not run it. It stays out of AC-4's scope.

**Nothing in the schema enforces the constraint.** It bounds how the owner starts processes, not what
a row admits. A second process of the same profile remains a supported topology, and it is the one
AC-4 measures.

**`OQ-T014-DM-2`, 2026-08-13, owner Sergey: a retention window is a movable setting of class R-29.4,
bounded by a compiled range** (§4.5.9). Rejected: the bootstrap class R-29.2 — shortening a window
would then require a release.

**Consequence for AC-44.** The gate refuses a secret or a bootstrap key read from Postgres, and the
retention window is neither. The compiled range keeps the movable value narrowing.

**`OQ-T014-DM-3`, 2026-08-13, owner Sergey: the first admin is created by a seed migration taking
the token digest as a parameter** (§4.5.3). Rejected: a first-start path inside the process — it is
reachable on every start, and it creates an admin without an admin.

**Consequence for the data model: none.** `access_audit.actor_user_id` was already nullable so the
bootstrap row is recordable (§4.5.5), and the seed writes exactly that row.
