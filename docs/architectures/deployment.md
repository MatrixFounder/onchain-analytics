# 10. Deployment

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

> **T-014 is DESIGNED, not built, as of 2026-08-13.** The network deployment profile described in
> §10.1.1, §10.2.1, §10.3.1, §10.3.2, §10.4.2, §10.5, §10.6 and §10.6.1 has no code yet. The
> process attaches one transport today: `packages/mcp-server/src/index.ts:166`
> (`await server.connect(new StdioServerTransport());`).

### 10.1. Environments

One build ships two deployment profiles (R-13). The **local** profile is what M0–T-013 delivered:
a stdio process under Claude Code, with no staging and no prod. The **network** profile is new in
T-014: a long-lived HTTP server behind a token perimeter.

The local profile's Postgres story is unchanged. The read-only PG client **connects** to the dev-VM
Supabase installation that already exists (CLAUDE.n8n.md); it neither provisions nor migrates it.
Against the snapshotter's tables the engine stays a read-only consumer of someone else's database.

The network profile opens a second connection, under a second database role, into that same schema
`onchain` (§10.5). It runs on the dev VM now and on a VPS later, and that VPS Postgres is shared
with other applications.

**The engine and the snapshotter share schema `onchain`** (owner decision 2026-08-12, reversing
`OQ-T014-DEP-1`; §10.7). What separates them is a per-table privilege, not a second namespace.

**Why the host matters here.** The deployment target moves, so §10.5 makes schema qualification a
correctness condition rather than a connection setting.

#### 10.1.1. Deployment profiles (R-13)

A **deployment profile** is a named combination of two independent axes, one per process. An
**access profile** is a settings entity a token references, many per process (`docs/tasks/task-014-t014-http-transport-auth-perimeter-profiles-shared-limiter.md:21-24`).
Neither is abbreviated to "profile" in this section. `docs/tasks/task-014-t014-http-transport-auth-perimeter-profiles-shared-limiter.md:609` (`в серверном профиле`)
names the network profile in Russian; the two names denote the same mode.

**The two axes.**

| Axis      | Values                                            |
| :-------- | :------------------------------------------------ |
| Transport | stdio \| Streamable HTTP                          |
| Storage   | SQLite in `DATA_DIR` \| Postgres schema `onchain` |

**Why the axes are independent.** Transport decides who may reach the process; storage decides where
its state lives. Neither answer constrains the other.

**The named combinations.**

| Name             | Transport       | Storage  | Status                                         |
| :--------------- | :-------------- | :------- | :--------------------------------------------- |
| `local`          | stdio           | SQLite   | in code since M0; the M0–T-013 mode            |
| `network`        | Streamable HTTP | Postgres | designed by T-014, not built                   |
| `network-sqlite` | Streamable HTTP | SQLite   | designed by T-014, for debugging the transport |
| —                | stdio           | Postgres | not offered                                    |

**Why `network-sqlite` exists.** The owner debugs the HTTP transport on the development machine
before switching `.mcp.json` over. Standing up Postgres for that is a cost with no purpose.

**Why stdio over Postgres is not offered.** No scenario asks for it, and an unnamed combination
cannot be named by a gate.

**Properties that follow the transport axis.**

| Property           | stdio                            | Streamable HTTP                                                   |
| :----------------- | :------------------------------- | :---------------------------------------------------------------- |
| Token              | not required, not checked (UC-3) | bearer in `Authorization`, verified before routing (R-3)          |
| Incoming perimeter | none — no listener exists        | `allowedHosts`, `allowedOrigins`, DNS-rebinding protection (R-12) |
| Identity tables    | declared, empty, inert (§4.5.1)  | populated (R-15)                                                  |
| `_meta.budget`     | present                          | role `admin` only (R-6.1)                                         |
| Diagnostics sink   | process stderr                   | container log (R-32.1)                                            |

**Properties that follow the storage axis.**

| Property            | SQLite in `DATA_DIR`                           | Postgres schema `onchain`                |
| :------------------ | :--------------------------------------------- | :--------------------------------------- |
| Limiter state       | `provider_buckets` in `DATA_DIR/cache.sqlite3` | `onchain.provider_buckets` (R-7.1)       |
| Cache and `usage`   | SQLite in `DATA_DIR`                           | `onchain.cache_entries`, `.usage` (OQ-8) |
| Durable diagnostics | `DATA_DIR/cache.sqlite3`                       | `onchain.diagnostics` (R-32.2)           |
| Retention jobs      | not installed                                  | the n8n workflow of §10.6.1 (R-32.3)     |

The combination is selected by `ONCHAIN_PROFILE`, values `local | network | network-sqlite`, unset
resolving to `local`. `main()` reads it once, attaches the matching transport and constructs the
matching store. `createServer` keeps its signature (R-1.2), so the profile reaches no tool and no
adapter.

**Why one key and not one key per axis.** A combination this document has not named is a
configuration no gate and no live-gate case covers.

**Why the default is `local`.** `EnvSchema.parse({})` must keep succeeding (R-13.5). An empty
environment therefore has to resolve to the profile that requires no setting.

**Operating constraint — two deployment profiles never run concurrently against the same vendor
credentials.** The owner switches `.mcp.json` from stdio to HTTP; both are not run at once.
Recorded 2026-08-13, owner: Sergey.

**Why the constraint is recorded rather than enforced.** Nothing in the process can observe another
process holding the same vendor key, so this is an operating rule with no compiled check.

**AC-4 therefore scopes to two processes of the same profile over one store.** Two `network`
processes on one Postgres, or two `local` processes on one `DATA_DIR`, share one bucket
(`docs/tasks/task-014-t014-http-transport-auth-perimeter-profiles-shared-limiter.md:535` `Два процесса одного профиля над одним хранилищем`).

`OQ-T014-DM-1` is closed by this constraint (§4.5.11). The two profiles do not share a vendor spend
ledger, because they do not run together.

### 10.2. CI/CD pipeline

The CI step order (`.github/workflows/ci.yml`) covers both packages through repo-wide `pnpm -r`
scripts, plus one structural step: `pnpm --filter @onchain-intel/core build` runs **before**
`typecheck` and `test`. `@onchain-intel/core` is exposed to consumers only through `main`/`types` →
`dist/*`, and `dist/` is gitignored — on a clean checkout it does not exist, so `typecheck` fails
with TS2307 and most mcp-server suites cannot resolve the package. The step is idempotent (plain
`tsc`) and preserves the invariant that the **mcp-server build runs after test** (the stdio E2E
spawns `tsx` on `src/`, never on `dist/`).

```
checkout(SHA-pin) → corepack enable (pnpm) → setup-node@22 (pnpm store cache)
  → pnpm install --frozen-lockfile
  → pnpm lint            # repo-wide, covers packages/core too
  → pnpm format:check    # repo-wide
  → pnpm --filter @onchain-intel/core build   # prerequisite: core dist, so the package resolves
  → pnpm typecheck       # pnpm -r typecheck — core, then mcp-server (topological)
  → pnpm test            # pnpm -r test — core (contract + registry + coverage + cache + SSRF +
                          #                rate-limit + budget-gate, all on fixtures/mocks), then
                          #                mcp-server (env / ping / e2e.stdio [spawn, tools/list +
                          #                ping] / e2e.inprocess [InMemoryTransport, fixture registry])
  → pnpm build           # pnpm -r build — core (plain tsc) → mcp-server (tsup + tsc, as in M0)
  → smoke:dist           # ping-only (rationale in §3.2)
```

Fixtures and mocks (D11) keep the entire test volume **network-independent**: 12 adapters, the
chain registry and coverage matrix, the cache, the SSRF gate, rate limiting, the budget gate, and
the tools exercised through **two** E2E suites. No secret is needed in CI (R-21:
`DUNE_API_KEY` / `COINGECKO_API_KEY` / `ONCHAIN_PG_URL` / `NANSEN_API_KEY` are read only by the
development script `record-fixture.mjs`, which runs **outside** CI). No network call may happen
during `pnpm test` — the same R-15/R-21 invariant M0 established, now enforced over many times more
code.

#### 10.2.1. What T-014 adds to the pipeline

Three additions, none of them reaching a vendor and none of them needing a secret.

1. Schema-qualification gate (R-30.3). Input: `sql/migrations/*.sql` plus the SQL string literals
   under `packages/core/src` and `packages/mcp-server/src`. Postcondition: every table reference
   carries a schema, every created object is `onchain.<name>`, and nothing is created in `public`.

   **Why the input names both packages.** The token checks live in `mcp-server`
   (`security.md` §7.5.1, `beside the transport that needs them`). SQL over
   `onchain.api_tokens`, `onchain.users`, `onchain.request_trace` and `onchain.diagnostics` is
   therefore written outside `packages/core/src`.

   **The precedent is the gate of `security.md` §7.5.3a.** Its static check already takes both
   directories as input.

2. Settings-classification gate (AC-44). Input: the properties of `EnvSchema` and the table of
   §10.3. Postcondition: every key carries exactly one class, and a key absent from the table
   fails the step.
   The gate reads `EnvSchema` properties only. A classified setting that is not an environment key
   names its carrier in §10.3.1.
3. The HTTP contract suite binds an ephemeral loopback port, so the transport, the perimeter and
   the token check are exercised offline.

**The R-21 invariant is restated, not widened.** It forbids a call that leaves the machine during
`pnpm test`. A loopback listener reaches no vendor, spends no credit and reads no secret, so it
stays inside the invariant. Live vendor coverage remains the separate gate of §10.4.2 step 8.

### 10.3. Configuration

`EnvSchema` (`mcp-server/src/env.ts`) is the single source of process configuration. Every key is
**optional** (R-23): `EnvSchema.parse({})` succeeds, so an empty env — or no `.env` at all — is a
valid configuration (UC-1), and an empty value (`KEY=`) behaves exactly like an unset key. The
schema declares **twelve** keys today (`packages/mcp-server/src/env.ts:46-96`, measured
2026-08-13); T-014 adds ten.

**Re-measured 2026-08-24, at T-014 acceptance: `EnvSchema` declares 23 keys.** The line above is kept as the record of the tree it described — task 014-40 added the ten T-014 keys, and R-23.6 asks for the current number BESIDE the historical one rather than for the past to be rewritten. The word "today" in the sentence above now means 2026-08-13.

`BLOCKSCOUT_PRO_API_KEY` was missing from this table until 2026-08-12. The schema has declared it
since TASK-008 (`packages/mcp-server/src/env.ts:64`), and `.env.example` documents it.

| Key                                | Class     | Purpose                                                                                                         |
| ---------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`                        | narrowing | `debug`/`info`/`warn`/`error`; reserved since M0 for stderr diagnostics                                         |
| `COINGECKO_API_KEY`                | secret    | CoinGecko Demo contour (`api.coingecko.com`, `x-cg-demo-api-key`)                                               |
| `COINGECKO_PRO_API_KEY`            | secret    | CoinGecko Pro contour (`pro-api.coingecko.com`, `x-cg-pro-api-key`); wins when both are set                     |
| `DUNE_API_KEY`                     | secret    | the `dune` adapter — an interface stub, so the key is unused even when set                                      |
| `BLOCKSCOUT_PRO_API_KEY`           | secret    | the `blockscout` facade; the only secret sent as a query parameter (TASK-008 R-79(a))                           |
| `NANSEN_API_KEY`                   | secret    | the only paid adapter                                                                                           |
| `ONCHAIN_PG_URL`                   | bootstrap | read-only Postgres DSN for `pg-history`, validated as a URL                                                     |
| `DATA_DIR`                         | bootstrap | cache directory override (default `~/.onchain-intel`, never cwd-relative)                                       |
| `NANSEN_DAILY_CREDIT_CAP`          | narrowing | self-imposed daily ceiling: unset → derived, a positive integer, or `off`                                       |
| `NANSEN_VELOCITY_CREDITS_PER_MIN`  | narrowing | SEC-1 velocity brake, credits per 60 s window: unset → derived, a positive integer, or `off`                    |
| `NANSEN_MAX_CALLS_PER_MIN`         | narrowing | Q-3 call brake, calls per 60 s window: unset → 60 (fixed, not derived), an integer, or `off`                    |
| `NANSEN_BUDGET_WARN_RATIO`         | narrowing | stderr warn threshold as a fraction of the effective ceiling (default 0.8)                                      |
| `ONCHAIN_PROFILE`                  | bootstrap | deployment profile: `local` \| `network` \| `network-sqlite`; unset → `local` (R-13)                            |
| `ONCHAIN_STATE_PG_URL`             | bootstrap | read-write DSN for the engine's own state in schema `onchain` (§10.5)                                           |
| `ONCHAIN_HTTP_BIND`                | bootstrap | listen address; unset → `127.0.0.1` (R-12.4, AC-34)                                                             |
| `ONCHAIN_HTTP_PORT`                | bootstrap | listen port                                                                                                     |
| `ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS` | bootstrap | how long one HTTP response may stay open; unset → 360 000 (R-16.3, see below)                                   |
| `ONCHAIN_ALLOWED_HOSTS`            | bootstrap | accepted `Host` values on the incoming request (R-12.1)                                                         |
| `ONCHAIN_ALLOWED_ORIGINS`          | bootstrap | accepted `Origin` values; unset → CORS refused (R-12.2, R-12.5, R-29.3)                                         |
| `ONCHAIN_TOKEN_HASH_SALT`          | secret    | the pepper R-29.1 names, mixed into the stored token digest (`security.md` §7.5.2)                              |
| `ONCHAIN_SESSION_MAX`              | bootstrap | ceiling on concurrent sessions (R-24.1)                                                                         |
| `ONCHAIN_SESSION_IDLE_MS`          | bootstrap | idle timeout after which a session is evicted (R-24.2)                                                          |
| `ONCHAIN_META_NAMESPACE`           | bootstrap | namespace of the incoming `_meta` key carrying a client request id; unset → every id is minted (`OD-014-30-14`) |
| `BLOCKSCOUT_DAILY_CALL_CAP`        | narrowing | T-015 — overrides `dailyCallCeiling` for R-12.1's verification run; unset → the ≈625 estimate                   |

**T-015 adds this one key, closing architecture review round 1 MAJOR-4** (`system-architecture.md`
§3.5.4, `data-model.md` §4.6.3). It overrides `blockscout.dailyCallCeiling` for R-12.1's synthetic
verification run; a positive integer only, no `off` sentinel (R-9.6). It is validated by `EnvSchema`
as a positive integer, the same discipline the three Nansen keys already get. `.env.example`
documents it in the same commit that adds it here — the rule this section already states for every
new key.

**The response timeout is bounded from below by the capability manifest** (R-16.3,
[interfaces.md](interfaces.md) §5.4.5).

- Derivation: `deadlineMs` bounds the cancellable part of a call, and `paidLegMs` is uncut.
- Worst case: 60 000 ms + 270 000 ms = 330 000 ms on `entity.labels`
  (`packages/core/src/capability-manifest.ts:661` `deadlineMs: 60_000,`, and
  `packages/core/src/capability-manifest.ts:668` `paidLegMs: 270_000,`).
- Measured 330 000 ms over all 26 manifest rows, 2026-08-13; 330 000 is a floor, not a ceiling. The
  table holds 27 rows since task 014-32b, and the floor is unchanged — the added row applies 15_000.
- Applied: 360 000 ms as the unset default, the first whole minute above the floor.
- `EnvSchema` refuses a value at or below 330 000 ms.

**Why the schema refuses rather than clamps.** A timeout under the floor cuts a call that was
completing lawfully.

**Why the key is bootstrap and not narrowing.** It is a transport construction parameter, read
before the first request. Raising it also holds a connection open longer than the compiled default.

**`ONCHAIN_TOKEN_HASH_SALT` is a pepper, and the digest that consumes it is defined in
`security.md` §7.5.2.** `api_tokens.token_hash` holds `sha256(pepper || presented)` as lowercase
hex. `OQ-T014-DEP-3` is closed by that section (§10.7).

`0` is invalid on all three Nansen limits. On a money guard it is one typo away from silently
removing the protection, and it ought to mean "spend nothing" rather than "spend without bound" —
so the disabling value is the word `off`.

`ONCHAIN_ALLOWED_HOSTS` governs the **incoming** request and has no relation to the outgoing SSRF
allowlist. `providers.config.ts` (`packages/core`) remains the single source of routing, SSRF
allowlist and rate limits: changing a provider's priority or adding a host to the allowlist edits
one file, not code (R-4). No environment key adds an outgoing host.

`.env.example` is the only description of the environment surface in the repository, so each of the
ten new keys is added there in the same commit that adds it to `EnvSchema`.

#### 10.3.1. Settings classification (R-29)

Three classes, and two different reasons for staying in `.env`.

- **secret** — a credential, or a value that authorises a call. Stays in `.env` permanently.
  **Why.** Canon D10 and the ADR-002 D1 invariant: keys and authorisation styles never enter a
  store that is editable without a release.
- **bootstrap** — a value the process needs before the settings store is reachable. Stays in `.env`
  permanently. **Why.** The Postgres connection setting cannot be read from Postgres.
- **narrowing** — a value whose every admissible setting restricts what the engine does. May move
  to Postgres later (R-29.4). **Why.** A value that only narrows cannot widen access when it is
  edited, which is the test of ADR-002 §8.5.

The obligations of editing without a release — validation on publish, a change log, rollback —
apply to the narrowing class only (R-29.5).

**Perimeter keys are bootstrap, not narrowing** (R-29.3). Adding an `Origin` or a `Host` admits a
caller who was refused before, so the class test rejects them.

**Session keys are bootstrap, not narrowing.** They are transport construction parameters, read
before the first session exists, and raising either one widens what the process accepts.

**T-014 adds no narrowing environment key.** Every narrowing value it introduces is carried outside
`EnvSchema`, and the table names the carrier of each.

| Setting                                                | Class     | Carrier in T-014                                                                               |
| :----------------------------------------------------- | :-------- | :--------------------------------------------------------------------------------------------- |
| `credits_balance`, `rate_limit`, `tool_allowlist_json` | narrowing | access-profile code defaults, read through one asynchronous interface (R-13.2, R-13.3, §4.5.3) |
| the three retention windows below                      | narrowing | the parameter node of the `onchain-retention` workflow (§10.6.1)                               |
| route disclosure on a successful response              | narrowing | the same access-profile interface (R-13.2, R-13.3, §4.5.3)                                     |

**The route-disclosure setting controls three fields of a successful response** (owner decision
2026-08-13, closing `OQ-T014-IF-1`): `_meta.cache.provider`, `_meta.cache.perSource[]` and
`structuredContent.missingSources`.

**Why the narrowing class fits.** Every admissible value removes response fields and adds none, so
an edit cannot widen what a principal reads.

**The setting does not reach `tier` or `_meta.budget`.** `tier` is refused on the wire
unconditionally (`ADR-002` D8), and `_meta.budget` stays bound to role `admin` (R-6.1).

**A retention window is a movable setting with a compiled upper bound** (R-29.4; owner decision
2026-08-13, closing `OQ-T014-DM-2`). Every admissible value lies between a floor and a maximum that
the job carries, and the job refuses a value outside that range.

**Why the narrowing class fits.** The maximum lives in the job rather than in the setting, so an
edited setting cannot produce unbounded retention.

**Why the windows are not environment keys.** The jobs run in n8n (§10.6.1), and n8n reads no `.env`
of the server process. `$env` is blocked on this instance (CLAUDE.n8n.md).

**Why a refusal and not a clamp.** A clamped window deletes rows the operator asked to keep, and
`retention_runs` would record the clamped period as the requested one.

| Window                   | Floor                            | Maximum               | Default  |
| :----------------------- | :------------------------------- | :-------------------- | :------- |
| `diagnostics.purge`      | 90 days — RAW tier, DB-SCHEMA §4 | the NORMALIZED window | 90 days  |
| `request_trace.raw_null` | 90 days — RAW tier, DB-SCHEMA §4 | the NORMALIZED window | 90 days  |
| `request_trace.purge`    | 365 days — NORMALIZED tier       | 730 days, applied     | 365 days |

**Why the two RAW maxima are the NORMALIZED window.** `tried_json` is a column of `request_trace`,
so its payload is deleted with its row. A diagnostics row kept longer than the trace it explains has
nothing left to join to (§4.5.8).

**The 730-day maximum is applied, not measured.** No HTTP request volume exists yet. §4.5.8 already
commits to measuring the first month's row count, and that measurement re-derives this number.

#### 10.3.2. `EnvSchema.parse({})` passes and the network profile refuses to start without a token

Both hold because the token requirement is not an environment key (R-13.5, R-13.6, AC-24).

Startup order in `main()`:

1. `loadEnv()` parses the environment. Postcondition: every key is optional, so `{}` validates.
2. The deployment profile is resolved from `ONCHAIN_PROFILE`. Postcondition: an unset value yields
   `local`, and the local path continues exactly as it does today.
3. In the `network` profile only, the startup preconditions run. Postcondition: a failed
   precondition writes its name to stderr and exits non-zero.
4. The transport is attached and, in the `network` profile, the listener binds. Postcondition: no
   socket is bound before step 3 succeeded.

Network preconditions, in order: `ONCHAIN_STATE_PG_URL` is set; the state store answers; at least
one `api_tokens` row is `active` and unexpired (§4.5.4).

**Why the token check is a precondition and not a schema rule.** A required key in `EnvSchema`
would make `EnvSchema.parse({})` throw, which R-13.5 forbids and which would also stop the local
profile from starting.

**Why the check precedes the bind.** A listener that exists before the token check is an
unauthenticated surface, for as long as the check takes.

AC-24 — network profile, zero active token rows → the process exits non-zero and binds no port;
fails when the precondition is moved after step 4.

#### 10.3.3. What configuration deliberately cannot express

- **A TLS certificate path.** The schema declares no such key, and adding one fails AC-36. TLS
  terminates at the reverse proxy (R-12.6).
- **An outgoing host, URL or RPC endpoint.** Neither the environment nor a tool argument produces
  one (R-11); `providers.config.ts` is the only source.
- **A tool description or title.** An access profile narrows the tool inventory and never supplies
  its texts (R-14.3).

### 10.4. Deployment instructions

#### 10.4.1. Local profile (dev)

1. `git clone` → `pnpm install` at the repo root (workspaces bring up both packages).
2. `pnpm build` (`pnpm -r build`: `core` — plain `tsc`, `mcp-server` — tsup + tsc, topological
   order).
3. `pnpm lint && pnpm typecheck && pnpm test` — all green with no network and no secrets (UC-1,
   R-21).
4. Optionally, a `.env` with any of the keys in §10.3 — none is required; capabilities without a
   key degrade explicitly (UC-1 alt, R-24).
5. Attach to Claude Code as a local stdio MCP server, unchanged since M0
   (`node packages/mcp-server/dist/index.js` or `tsx packages/mcp-server/src/index.ts`).
6. Call any of the 22 tools → a canonical response; a repeat call with the same normalized
   arguments within the TTL → `_meta.cache.status === 'hit'` (UC-3, ROADMAP exit criterion).

#### 10.4.2. Network profile

1. **Create the engine's state role.** The migration of step 2 carries the grants of §10.5.1, and a
   `GRANT` names its grantee: a role that does not exist yet aborts the whole file under
   `ON_ERROR_STOP=1`.

   **Why the role precedes the migration rather than following it.** An earlier revision of this
   section applied the migration first. That order cannot succeed on a first install, and it fails
   at the grant — after the tables are created — leaving a half-applied schema to clean up by hand.

2. Apply the server migration (§4.4) by piping it over stdin, per the `vm-deploy` skill:
   `ssh vm 'docker exec -i supabase-db psql -qU supabase_admin -d postgres -v ON_ERROR_STOP=1 -v STATE_ROLE=<role> -v READ_ROLE=<role>' < sql/migrations/<n>_t014_network_profile.sql`.
   Postcondition: schema `onchain` holds its three snapshotter tables plus the twelve tables of
   §4.4, and nothing was created in `public`.

   **Why the two role names arrive as parameters.** They are local to an installation (§10.5.1), and
   a file that hard-codes them is not the same file on the next host. The seed migration of step 4
   already takes its digest this way.

   Postcondition: `SELECT * FROM onchain.snapshots` by the state role is refused, measured with
   `has_table_privilege` for each of `assets`, `metrics` and `snapshots` — not with
   `information_schema.role_table_grants`, for the three reasons step 2a gives below.

2a. **Measure the READ role before granting anything to it, and correct it if it over-reaches.**
The read role predates T-014, and this migration grants without revoking, so its existing
privileges decide the outcome. Ask the question that admits no third path:

```sql
SELECT t.table_name,
       has_table_privilege('<read-role>', 'onchain.' || t.table_name, 'SELECT') AS may_select
  FROM information_schema.tables t
 WHERE t.table_schema = 'onchain'
 ORDER BY 2 DESC, 1;
SELECT defaclobjtype, defaclacl FROM pg_default_acl d
  JOIN pg_namespace n ON n.oid = d.defaclnamespace WHERE n.nspname = 'onchain';
```

Postcondition: `may_select` is true for `assets`, `metrics` and `snapshots`, and false for every
other table in the schema. Any true elsewhere is revoked before the profile starts, and
`pg_default_acl` carries no entry that would grant the read role a future engine table.

**On a MANAGED cluster this postcondition is unreachable, and the exception is named rather than
quietly tolerated** (measured on the dev VM 2026-08-23,
[SEC-2](../issues/sec-2-a-stock-supabase-role-holds-pg-read-all-data-so-the-engine-tables-are-readable-by-it.md)).
Supabase ships three roles that read every table by construction: `supabase_admin` (superuser),
`postgres` (the project-owner role, `rolbypassrls` and a member of `pg_read_all_data`), and
`supabase_read_only_user` (reserved by `supautils.conf` in both `reserved_roles` and
`reserved_memberships`). Revoking is not available for the third and not desirable for the second,
and row-level security binds neither, because both `pg_read_all_data` members carry `rolbypassrls`.

So on such a host the check above is run against the roles the INSTALLATION controls, and the three
platform roles are recorded as an accepted exception with a re-check pinned to the move off the
managed cluster. **On the dev VM that acceptance was taken by the owner on 2026-08-23**, scoped to a
host where the database administrator and the engine owner are the same person; the separated host is
to get a dedicated Postgres container instead
([WI-62](../backlog/wi-62-engine-tables-move-to-a-dedicated-postgres-container-on-the-separated-host.md)),
which restores this postcondition as written rather than excepting it again. **The load-bearing postcondition does not move**: `authenticator` — the role
PostgREST authenticates as, and the only role reachable from outside the machine — must read none of
the twelve engine tables. Measured true on the dev VM the same day.

**Why the exception is written here rather than left to each operator.** An unreachable
postcondition is a check that gets skipped, and a skipped check is indistinguishable from a passed
one six months later. Naming what cannot hold, and what must hold instead, is what keeps the rest of
the step worth running.
Postcondition: `SELECT * FROM onchain.api_tokens` over `ONCHAIN_PG_URL` is refused. **This last
one is the load-bearing check**; the two queries above are how an operator finds what to fix.

**Why `has_table_privilege` and not `information_schema.role_table_grants`.** The catalogue view
is blind to three paths:

- a grant to `PUBLIC`
- a privilege inherited through membership in a group role
- by the view's own definition, any grant whose roles are not enabled in the current session

An empty result from it therefore means "nothing found", not "nothing granted", and this project
has already paid for treating a confident empty answer as a safe one (L-10).
`has_table_privilege` answers the question that was actually asked.

**Why a measurement and not only a grant.** Before T-014 the engine's tables were in another
namespace, so a schema-wide `SELECT` on `onchain` could not reach them. Sharing one schema
removed that separation, and what replaces it is the grant list — which this step is the only
place that verifies. `security.md` §7.3 carries the same rule for the operator. 3. Write `.env` and `chmod 600` it: `ONCHAIN_PROFILE=network`, `ONCHAIN_STATE_PG_URL`,
`ONCHAIN_HTTP_BIND`, `ONCHAIN_HTTP_PORT`, `ONCHAIN_ALLOWED_HOSTS`, `ONCHAIN_ALLOWED_ORIGINS`,
`ONCHAIN_TOKEN_HASH_SALT`, plus the vendor keys the installation uses. 4. Apply the admin seed migration, passing the token digest and the visible prefix as parameters
(§4.4 item 5, `security.md` §7.5.2). Postcondition: one `active` row in `onchain.api_tokens`, and
the plaintext token on no disk of this installation.

**The prefix is a parameter of its own.** `api_tokens.prefix` is `NOT NULL` and `UNIQUE`
(`data-model.md` §4.5.4), and it cannot be derived from the digest. 5. Start the process. Postcondition: it binds `ONCHAIN_HTTP_BIND` only, and with zero active tokens
it exits non-zero having bound nothing (§10.3.2). 6. Put the reverse proxy in front of it for TLS and for any public address
(`ROADMAP.md:220` `обратный прокси перед MCP`). Postcondition: the engine holds no certificate. 7. Install the `onchain-retention` workflow on the n8n instance, after the owner has approved that
installation explicitly (§10.6.1). Postcondition: one `onchain.retention_runs` row per job
per pass. 8. Run the live gate: `pnpm --filter @onchain-intel/mcp-server gate --task T-014` (AC-15). It
covers the capability matrix over stdio plus the HTTP set — a rejected token, a rejected
perimeter, one end-to-end call, and one shared-limiter case across two sessions (R-22).

**Step 4 replaces an interactive first-token step, and `OQ-T014-DM-3` is closed by it** (owner
decision, `security.md` §7.5.2). The operator mints the token, computes the digest, and passes only
the digest to `psql`.

### 10.5. Schema discipline on a shared Postgres (R-30)

The network profile runs on the dev VM now and on a VPS with a shared Postgres later. Every
statement it sends names its schema explicitly — DDL, migrations, reads and writes (R-30.1). Both
roles name the one schema `onchain`. Nothing is created in `public` (R-30.2). The gate of §10.2.1
checks both offline (R-30.3).

**The engine uses the snapshotter's schema `onchain`** (owner decision 2026-08-12, reversing
`OQ-T014-DEP-1`; §10.7). The migration of §4.4 adds its twelve tables to that schema.

**Isolation is by role and grant, inside one schema.** ARCHITECTURE §1.2 item 5 is carried by the
table privileges of §10.5.1, which the server checks on every statement.

#### 10.5.1. The exact grants

Two roles connect to schema `onchain`. The read role already exists and is unchanged; the state
role is new in T-014.

**This document fixes neither role's name; the SQL below spells `onchain_engine_state` only as the
suggested value.** The read role's name is installation-local (`.env.example:118` shows
`readonly_user` in the example DSN), and the state role's is chosen per host. Both arrive at the
migration as `psql` parameters — `:'STATE_ROLE'` and `:'READ_ROLE'` (§10.4.2 step 2).

**Why parameters rather than a fixed name for the state role.** The engine now shares one schema
with the snapshotter, and the next host may already hold a role of that name owned by someone else.
A file that hard-codes the grantee is not the same file on the next host.

```sql
-- state role: the twelve engine tables of §4.4, enumerated one by one
GRANT USAGE ON SCHEMA onchain TO onchain_engine_state;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  onchain.users, onchain.access_profiles, onchain.api_tokens, onchain.access_audit,
  onchain.provider_buckets, onchain.request_trace, onchain.diagnostics, onchain.retention_runs,
  onchain.providers, onchain.cache_entries, onchain.usage, onchain.usage_window
  TO onchain_engine_state;

-- read role: the three snapshotter tables, read only
GRANT USAGE ON SCHEMA onchain TO <read role>;
GRANT SELECT ON onchain.assets, onchain.metrics, onchain.snapshots TO <read role>;
```

`assets`, `metrics` and `snapshots` appear in no grant to `onchain_engine_state`. The twelve engine
tables appear in no grant to the read role.

Three statement forms are prohibited on this installation, and the migration of §4.4 contains none
of them.

- `GRANT … ON ALL TABLES IN SCHEMA onchain TO onchain_engine_state`
- `ALTER DEFAULT PRIVILEGES IN SCHEMA onchain GRANT … TO onchain_engine_state`
- `GRANT CREATE ON SCHEMA onchain` to either role

**Why the twelve tables are enumerated.** `ALL TABLES IN SCHEMA onchain` covers the three
snapshotter tables, which is the boundary these grants exist to hold.

**Why neither role receives `CREATE`.** Migrations run as `supabase_admin` (§10.4.2 step 2), so a
running process adds no table to a schema it shares.

**No sequence grant appears.** The application generates every identifier, and no table of §4.4 has
a serial default (DB-SCHEMA §1).

#### 10.5.2. What the grants enforce, and what they do not

**Both refusals are enforced by the server.** Postgres refuses `SELECT`, and refuses
`INSERT`/`UPDATE`/`DELETE`, on a table for which the role holds no privilege.

**The refusal holds under three conditions.** The role owns no such table, is no superuser, and
inherits from no role that holds the privilege.

`assets`, `metrics` and `snapshots` are therefore unreadable and unwritable to
`onchain_engine_state`.

**Observable:** as the state role, `SELECT * FROM onchain.snapshots` fails with
`permission denied for table snapshots`, and `INSERT INTO onchain.request_trace …` succeeds.

**The boundary binds the role, not the process.** The engine still reads `snapshots` lawfully over
`ONCHAIN_PG_URL` with the read role (§7).

Four things these grants do not give.

- Table names stay visible. The state role reads `pg_catalog`, so it sees that `onchain.snapshots`
  exists and which columns it has.
- Row estimates stay visible. `pg_class.reltuples` is readable for a table whose rows are not.
- The migration role stays unconstrained. `supabase_admin` applies the DDL of §4.4 holding every
  privilege in the schema.
- The boundary is one statement wide. A later `GRANT … ON ALL TABLES IN SCHEMA onchain` removes it
  without an error.

**Why the last item is recorded rather than mitigated.** Nothing in the process observes a privilege
granted after startup, so §10.4.2 steps 2 and 2a assert the grant set at install time instead.

**The read role now shares a schema with `api_tokens`.** What keeps the stored token digests outside
a `SELECT` issued over `ONCHAIN_PG_URL` is a grant list naming three tables — not a namespace, and
not the absence of one grant. Two forms are forbidden by name in §10.5.1 because either one
reinstates the reach: `GRANT … ON ALL TABLES IN SCHEMA onchain`, and
`ALTER DEFAULT PRIVILEGES IN SCHEMA onchain`. Step 2a is where the existing role is measured against
that list, since the migration grants without revoking.

**Why that is named here.** Under a separate engine schema the read role reached no engine table at
all; after the reversal it is refused per table.

#### 10.5.3. One schema makes R-30 load-bearing

**`search_path` is not a correctness condition.** WI-47 measured a pooler substituting its own:
`packages/core/src/pg/read-client.ts:383` (`options: '-c search_path=onchain'`) sets it as a
connection startup parameter, Supavisor answers with `cvj, public, extensions`, and `pg-history`
read zero rows while 3039 rows were present (`docs/tasks/task-014-t014-http-transport-auth-perimeter-profiles-shared-limiter.md:337-339`). A connection setting does not
survive the pooler; an explicit qualification does.

**One schema removes the second detector for a missing qualifier.** Under two schemas an unqualified
name resolving into the other namespace met a role with no privilege there. Under one schema the
state role already holds privileges inside `onchain`.

**The offline gate of §10.2.1 is therefore the only detector left** (R-30.3, AC-46). Its input is
every migration file plus every SQL literal under `packages/core/src` and `packages/mcp-server/src`.

**Why the second package is inside the input.** The identity, trace and diagnostics SQL is written
in `mcp-server` (`security.md` §7.5.1). A gate over one package would leave that SQL unchecked.

**A table-name collision is now possible, and is checked before the migration runs.** Schema
`onchain` holds three tables today — `assets`, `metrics`, `snapshots` — and none of the twelve names
of §4.4 is among them. Measured 2026-08-13 with
`select table_schema||'.'||table_name from information_schema.tables where table_schema like 'onchain%'`.

**Why the check is repeated at install time.** DB-SCHEMA §3 reserves two further names in this
schema, `events` and `aggregates`, and the snapshotter contour adds them without asking the engine.

#### 10.5.4. Two DSNs, two roles

| Setting                | Role                   | Role rights                                    | Reader                       |
| :--------------------- | :--------------------- | :--------------------------------------------- | :--------------------------- |
| `ONCHAIN_PG_URL`       | the read role          | `SELECT` on the three snapshotter tables       | `pg-history` (§7, unchanged) |
| `ONCHAIN_STATE_PG_URL` | `onchain_engine_state` | read-write on the twelve engine tables of §4.4 | the state store of §4.5      |

**Why two roles and not one.** The standing constraint that the engine never writes the
snapshotter's data is enforced server-side by the role, not by the calling code
(ARCHITECTURE §1.2 item 5, §7). One read-write DSN for both purposes would remove that enforcement.

**Why two roles survive the reversal.** Sharing a schema changes which grants are written, not who
is allowed to write what.

**The n8n retention workflow uses the state role, not the snapshotter's credential** (§10.6.1). The
existing "Supabase DB" credential authenticates as the snapshotter's role, which holds no grant on
the twelve engine tables, so the installation adds a second Postgres credential.

### 10.6. Diagnostics and retention in the network profile (R-32)

The network profile runs as a container, so its stderr is the container log (R-32.1). An operator
reads it with `docker logs`. stdout carries the MCP protocol and never a diagnostic (§7.3).

Events that must outlive the container's log window are written to `onchain.diagnostics`, whose
event vocabulary is closed and compiled (§4.5.8, R-32.2). The stderr line and the row carry the
same event name; the line carries the row id instead of the principal (R-5.3).

**R-32.2 is met literally, and the deviation this section carried before is withdrawn.** The
requirement names schema `onchain`, and the owner's reversal of `OQ-T014-DEP-1` puts the table
there (§10.5).

**Why the table is not a duplicate of the log.** On HTTP neither the client nor its operator reads
the process stderr, and AC-48 requires an administrator to reach the event without it.

Cleanup is three named jobs, each writing one row to `onchain.retention_runs` — how many rows, for
which period, and with what outcome (§4.5.9, R-32.3).

| Job                      | Target                  | Action                                        |
| :----------------------- | :---------------------- | :-------------------------------------------- |
| `diagnostics.purge`      | `onchain.diagnostics`   | deletes rows older than the window            |
| `request_trace.raw_null` | `onchain.request_trace` | sets `tried_json` to NULL past the RAW window |
| `request_trace.purge`    | `onchain.request_trace` | deletes rows past the NORMALIZED window       |

A pass that deleted zero rows still writes its row, because "nothing to delete" and "the job did not
run" are different facts (DB-SCHEMA §4).

#### 10.6.1. The three jobs run as an n8n workflow (R-32.3)

**`OQ-T014-DEP-2` is closed: the executor is one n8n workflow, `onchain-retention`** (owner
decision 2026-08-13). It is scheduled beside the snapshotter, and the server process gains no
scheduler.

**Why n8n and not the server process.** Standing constraint 1 keeps the autonomous loop on n8n
permanently (ARCHITECTURE §1.2 item 1). The network profile could carry a scheduler, and the owner
chose not to add one.

**Installation requires the owner's explicit approval.** This architecture proposes the workflow;
it does not create or activate it. The instance is shared, and only `onchain-*` workflows of this
project may be created on it (CLAUDE.n8n.md).

Its shape, in the conventions CLAUDE.n8n.md fixes:

| Element         | Value                                                                   |
| :-------------- | :---------------------------------------------------------------------- |
| Trigger         | Schedule, daily                                                         |
| Parameter node  | a Set node holding the three windows of §10.3.1                         |
| Credential      | a Postgres credential for the state role of §10.5, not "Supabase DB"    |
| Writers         | one Postgres node per job, each followed by its `retention_runs` insert |
| `errorWorkflow` | `onchain-error-alert`                                                   |

**Why the windows sit in the parameter node.** One node owns the configuration contract, so
changing a window never edits a query node (CLAUDE.n8n.md).

**Why each job writes its own row inside the same pass.** A row written by a later, separate pass
could not name the period the delete actually covered.

**Each pass also writes one `retention.cleanup` row to `onchain.diagnostics`.** §4.5.8
declares that event, and this workflow is its only writer.

**A window outside the range of §10.3.1 is refused.** The job deletes nothing and writes a
`retention_runs` row with `outcome = 'failed'`, its `detail_json` naming the refused setting
(§4.5.9). The alert reaches Telegram through `errorWorkflow`.

**Why the refusal is loud rather than corrected.** A corrected window would delete rows for a period
nobody chose.

### 10.7. Open questions raised by this section

**No question raised by this section is still open.** The owner answered all three, and each answer
is recorded where the design uses it.

**OQ-T014-DEP-1 — CLOSED: the engine uses the snapshotter's schema `onchain`.** Recorded in §10.5;
the migration that adds the twelve tables is §4.4. The state role holds grants on those twelve
tables only, so ARCHITECTURE §1.2 item 5 is enforced by a `GRANT`.

**This answer reverses the one this section carried before** (owner decision 2026-08-12, applied
2026-08-13). The superseded answer gave the engine a schema `onchain_engine` of its own. Isolation
moved from a namespace boundary to a per-table privilege, and §10.5.2 states what that costs.

**OQ-T014-DEP-2 — CLOSED: the three retention jobs run as the `onchain-retention` n8n workflow.**
Recorded in §10.6.1, with installation conditional on the owner's explicit approval. R-32.3 and
AC-48 now have a named executor.

**OQ-T014-DEP-3 — CLOSED: the stored digest is `sha256(pepper || presented)`, with one
process-wide pepper.** Decided in `security.md` §7.5.2, carried by `ONCHAIN_TOKEN_HASH_SALT` in
§10.3. `data-model.md` §4.5.4 states the same form in its `token_hash` column comment, read
2026-08-13.

**Two questions of other sections are closed by this one.** §10.1.1's operating constraint closes
`OQ-T014-DM-1`, and §10.3.1's range closes `OQ-T014-DM-2`.

**T-014 status, corrected 2026-08-25.** The banner at the top of this file reads "DESIGNED, not
built, as of 2026-08-13." T-014 shipped 2026-08-24 (`ARCHITECTURE.md` §"Delivered"); migration
`sql/migrations/002_t014_network_profile.sql` is live on the dev VM, and §10.9 below builds on it as
an EXISTING artifact, not a planned one. The banner is left as the record of the tree it described,
the same `R-23.6` convention §10.3 already applies to its own stale "today" — the two sections below
are current, not retrospective.

### 10.8. T-015 — the billing ledger's background reconciliation job (R-14)

**`OQ-T014-DEP-2`'s answer extends to this job: it runs outside the server process** (§10.6.1). The
network profile gains no scheduler for it, the same standing constraint that already routes
retention there.

**Why a SEPARATE workflow from `onchain-retention`, not a fourth job inside it.** `onchain-retention`
runs once a day; a `reserved` row can go stuck within `data-model.md` §4.6.5's 120 000 ms threshold,
and a client charged from a request that never settles should not wait a day to be seen. One n8n
Schedule trigger carries one cadence, so a job needing a materially shorter one needs its own
workflow.

| Element         | Value                                                                                        |
| :-------------- | :------------------------------------------------------------------------------------------- |
| Name            | `onchain-billing-reconcile`                                                                  |
| Trigger         | Schedule — applied every 15 minutes, measured: none                                          |
| Query           | `data-model.md` §4.6.5's scan, batched                                                       |
| Credential      | the state role's Postgres credential of §10.5 — the same one §10.6.1 uses, not "Supabase DB" |
| Writer          | one Postgres node transitioning each matched row, followed by its `retention_runs` insert    |
| `errorWorkflow` | `onchain-error-alert`                                                                        |

**Why 15 minutes, stated as a bound rather than a guess.** A row can be visibly stuck for at most
threshold-plus-cadence, ≤135 000 ms, before this job closes it. That is an order of magnitude
tighter than daily retention, without polling per second against a shared connection pool. This is
`applied`, per the project's own convention for a default with no traffic yet to size it against —
`data-model.md` §4.5.8's `applied 90 days as a floor` is the precedent for this form.

**Installation requires the owner's explicit approval, exactly as `onchain-retention` does**
(§10.6.1). This architecture proposes the workflow; it does not create or activate it.

**Why the row lands in `retention_runs`, not a new table.** `job` carries no database-level `CHECK`
(`data-model.md` §4.5.9) — only a compiled TypeScript vocabulary, the same class of closed-but-
extensible list `diagnostics.event` already is. Adding `'client_usage.reconcile_expired'` is
therefore additive. The reader that already understands "one run, one row, zero is a fact" inherits
this job for free.

### 10.9. WI-62 / T-015 — the engine tables move to a dedicated Postgres container on the dev VM

**Scope, restated from `docs/TASK.md` R-8.9/R-8.10.** WI-62's literal text names a SEPARATE HOST.
The owner's 2026-08-25 decision replaces the host with a dedicated CONTAINER on the SAME dev VM —
`OQ-T014-B`'s separated-host trajectory is unaffected and stays a later step. This section designs
the container edition; the separated-host edition remains `OQ-T014-B`'s open trajectory, not this
one's.

**What moves and what does not.** Thirteen engine tables — the twelve of §4.4 plus `client_usage`
(`data-model.md` §4.6.1) — move to the new container. The snapshotter's `assets`, `metrics`,
`snapshots` and the `onchain-snapshotter`/`onchain-verify`/`onchain-error-alert` workflows stay on
the existing Supabase container, addressed by the SAME "Supabase DB" credential, unchanged (R-8.3,
AC-18).

#### 10.9.1. Provisioning the container (R-8.1, AC-16)

An additive operation under skill `vm-deploy`: a second Postgres container on the dev VM, on a
port distinct from the existing one. `.env.example` names both DSNs on
`ubuntu-linux-2404.local:5432` today; the new container listens on a second port on the same host.
`docker ps` names both containers; `pg_isready` answers on both ports.

**Why a plain Postgres image, not another Supabase stack.** SEC-2's exception exists BECAUSE Supabase
ships three roles with a platform-wide `SELECT` (`supabase_admin`, `postgres`,
`supabase_read_only_user`, §10.4.2). A plain `postgres:16` container carries none of them.

The postcondition R-8.9 asks for (`SEC-2` → `fixed`) is a property of the IMAGE, not of the grants
applied to it. The grants are the SAME on both kinds of image. Only the image's built-in roles
differ.

#### 10.9.2. The migration, applied to an empty container (R-8.2)

**Same file-pattern, same role/grant pattern as `sql/migrations/002_t014_network_profile.sql`,
applied to the NEW container — thirteen tables, not twelve.** The twelve of §4.4 plus one new
`CREATE TABLE onchain.client_usage` (`data-model.md` §4.6.1's DDL). No snapshotter table is created
here. This container never holds `assets`/`metrics`/`snapshots`, so there is no read role to grant
at all (R-8.6, R-8.7). The state role is the only application role this container's schema ever
names.

```
ssh vm 'docker exec -i <new-container> psql -qU postgres -d postgres -v ON_ERROR_STOP=1 \
  -v STATE_ROLE=onchain_engine_state' < sql/migrations/<n>_wi62_dedicated_container.sql
```

**Postcondition:** thirteen tables exist, empty, owned by the state role's grants alone. R-8.2's own
wording, "эта миграция сама по себе создаёт пустые таблицы", holds literally here. The row transfer
of §10.9.4 is a separate, later step.

**Which roles exist on this container, named explicitly (R-8.6).** The container's superuser
(`postgres`, created by the image, holding every privilege by construction — unavoidable and not the
postcondition under test) and the one application role this migration creates,
`onchain_engine_state`. No third role exists to measure — R-8.7's contrast with Supabase's three
platform roles is total, not partial, on a freshly provisioned plain container.

#### 10.9.3. Grants (R-8.5, R-8.6, AC-17, AC-17b)

```sql
GRANT USAGE ON SCHEMA onchain TO onchain_engine_state;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  onchain.users, onchain.access_profiles, onchain.api_tokens, onchain.access_audit,
  onchain.provider_buckets, onchain.request_trace, onchain.diagnostics, onchain.retention_runs,
  onchain.providers, onchain.cache_entries, onchain.usage, onchain.usage_window,
  onchain.client_usage
  TO onchain_engine_state;
```

The same three prohibited forms `deployment.md` §10.5.1 already names stay prohibited here
(`GRANT … ON ALL TABLES`, `ALTER DEFAULT PRIVILEGES`, `GRANT CREATE ON SCHEMA` to the state role).

**Postcondition, measured as `may_select` per role/table pair** (R-8.5, AC-17) — the SAME query
`deployment.md` §10.4.2 step 2a already uses, re-pointed at the new container and at all thirteen
table names. It is true for the state role on all thirteen. It is false for the state role on
nothing else, because there is nothing else. It is false for `postgres` too: the superuser bypasses
`may_select`'s intent by holding every privilege regardless. The postcondition is therefore stated
over the APPLICATION roles, not over the superuser — the same qualification `deployment.md` §10.4.2's
own load-bearing check makes for `authenticator`.

**AC-17b, stated exactly.** No role but the state role and the container's own superuser reads any of
the thirteen. On this container that enumeration is short by construction (§10.9.2): there is no
third role for a future default ACL to widen silently, the exact class of risk RISK-5 names.

#### 10.9.4. Row transfer and the four-part verify gate (R-8.11, R-8.12, R-8.13, AC-36)

**MAJOR-F precondition (architecture review round 2), stated once here and repeated verbatim at
§10.9.7.** The client billing ledger, `client_usage` (`data-model.md` §4.6.1), lives ONLY on the NEW
container this section moves rows into. It is never written on the OLD container (`supabase-db`,
`deployment.md`:706) — migration `004_t015_billing.sql` is not applied there, by that file's own
header — because the old container's twelve T-014 tables are dropped WHOLESALE in one irreversible
step at §10.9.7, and a `client_usage` row written before that step would vanish with them. The old
container therefore never carries a thirteenth engine table, only the twelve of migration 002.

**Order — `DB-SCHEMA-CONCEPT` §6, applied literally (R-8.14).** The network profile is stopped
BEFORE any row moves (`UC-6` step 3) — a window with no write reaching the old container, not a
reconciliation performed after the fact. Rows transfer while stopped (step 4). The profile starts
against the NEW container (step 6) only after this section's verify gate (below) has run against it
(step 5). R-8.13's four checks stand between "rows copied" and "profile serving traffic", not after.

**Which twelve tables carry rows, and why the count differs from the migration's thirteen.**
`client_usage` is created empty in §10.9.2 and STAYS empty until the new container starts serving —
there is no source to copy it from (it exists nowhere before this task). `provider_buckets` is
excluded by R-8.11 (§10.9.5 states what that concedes). The remaining eleven T-014 tables plus
`client_usage`'s empty presence account for all thirteen; **twelve tables carry a row-transfer step**,
and eleven of those twelve carry rows to copy.

**Mechanism — per-table data copy, piped over stdin, per the `vm-deploy` skill's own rule** (never
`-f /tmp/…`, which would read a container filesystem rather than the live data):

```
ssh vm 'docker exec -i <old-container> pg_dump -U postgres -d postgres \
  --schema=onchain --table=onchain.<name> --data-only --format=plain' \
  | ssh vm 'docker exec -i <new-container> psql -qU postgres -d postgres -v ON_ERROR_STOP=1'
```

Run once per table, in an order that respects the foreign keys `data-model.md` §4.5 declares within
each group. `users`/`access_profiles` come before `api_tokens`. `providers` comes before
`provider_buckets` — excluded — and before `cache_entries`/`usage`/`usage_window`. Every table
transfers before the ones that reference it.

**`api_tokens` transfers with the rest — the prior premise that it could not was wrong, and the
correction is recorded rather than silently applied (R-8.11).** The digest column,
`token_hash = sha256(pepper || presented)`, is an ordinary `TEXT` value, copied and spot-checked
byte-for-byte like any other exact column (§10.9's third check, below). The pepper itself,
`ONCHAIN_TOKEN_HASH_SALT`, is never a column (`security.md` §7.5.2; `003_seed_engine_admin.sql:24-26`,
"the pepper is not a parameter… living in the server's `.env`"). It lives in the SERVER's `.env`,
which the container move does not touch. `access_profiles` and `users` — the two tables `api_tokens`
references — transfer in the same pass, ahead of it.

**`access_audit`'s copy is a ONE-TIME operation, not an idempotent re-run** (R-8.12, closes review
round 3 MAJOR-2). The table carries no natural `UNIQUE` dedup key by design
(`003_seed_engine_admin.sql:157-159`). Its identity is the ULID primary key alone (`data-model.md`
§4.5.9's own recorded deviation).

**Citation fix (closes architecture review round 1 MINOR-1).** An earlier draft pinned the quote
"Two identical events one millisecond apart are two facts" to the SQL address above. It actually
lives at `data-model.md:1651`, and is corrected here rather than left standing.

An `ON CONFLICT DO NOTHING` has no column to key on, so re-running the copy above duplicates every
row.
**If the copy must be repeated** (a failed run, an operator error), the new container's
`access_audit` is emptied first, inside one transaction, and the copy re-run whole:

```sql
BEGIN;
TRUNCATE onchain.access_audit;
-- re-run the data-only copy for this one table
COMMIT;
```

This is a deliberate, named exception to the "copy once" rule above. It is recorded here because
`data-model.md` §1's append-only/idempotent canon otherwise applies to every table in this migration.
`access_audit` is the one table where a literal `ON CONFLICT DO NOTHING` reading of that canon does
not hold.

**The four verify checks, named individually, one marked not applicable (R-8.13, AC-36):**

1. **Row counts** per table, old container vs new, for the eleven tables that carried rows.
   `client_usage` is NOT APPLICABLE here — it has no old-container source (§10.9.2's own note).
2. **`min`/`max`** on each table's own time column — `created_at`, `received_at`, `ts`, `started_at`,
   whichever the table declares (`data-model.md` §4.5) — old vs new, equal on both bounds.
3. **Spot-check** N random rows byte-for-byte on their exact `TEXT` columns — `token_hash` on
   `api_tokens`, `credits_balance_raw` on `access_profiles`, and the equivalent exact column of every
   other transferred table.
4. **Zero orphans**, checked by an explicit `SELECT`, because neither reference carries a foreign
   key. `data-model.md`: `principal_id` is "a label, not a foreign key"; `access_audit.target_id` is
   the same, by construction. `access_audit` needs to record an event whose subject may already be
   gone:

   ```sql
   SELECT 'request_trace' AS source, count(*) AS orphans
     FROM onchain.request_trace rt
    WHERE rt.principal_id <> 'local'
      AND NOT EXISTS (SELECT 1 FROM onchain.api_tokens t WHERE t.id = rt.principal_id)
   UNION ALL
   SELECT 'access_audit', count(*)
     FROM onchain.access_audit a
    WHERE a.target_type = 'api_token'
      AND NOT EXISTS (SELECT 1 FROM onchain.api_tokens t WHERE t.id = a.target_id);
   ```

   Run against the NEW container, after the copy. Zero on both rows is the postcondition; a positive
   count on EITHER names which of the two FK-less references lost its target in the move.

**"More than expected" and "less than expected" are different causes, and the check distinguishes
them rather than collapsing into one "counts disagree" (R-8.13, closes review round 3 the second half
of MAJOR-2).** A row count HIGHER on the new container than the old one is `access_audit`'s
duplication hazard above, materialized; a row count LOWER names an incomplete copy. The verify report
states which of the two occurred, per table, rather than a single pass/fail bit.

**A2 (`UC-6`) — a discrepancy blocks step 10 (deletion in the old container), by construction of the
step order above.** The verify gate stands between "profile starts on the new container" and "old
container loses its tables". Step 10 reads this report before running.

#### 10.9.5. What excluding `provider_buckets` concedes (R-8.11)

**The ephemeral argument is correct as far as it goes, and incomplete on its own — named here rather
than left implicit** (closes review round 3 MINOR-4). `provider_buckets.tokens` may be NEGATIVE — an
accumulated backlog against the vendor ceiling, not a plain spendable balance
(`data-model.md` §4.5.6, "`tokens` is `REAL` and may go negative… the stored value is not clamped at
zero"). Losing the row on migration is not an inert cache reset: it FORGIVES that backlog, starting
the bucket at a fresh, full state rather than at its true pre-migration position.

The boundary is small. The backlog self-corrects within one refill cycle, seconds to low minutes at
`blockscout`'s `refillPerSec: 2`. It is still a real, one-time relaxation of the limiter on the
migration boundary, not a lossless no-op — recorded as such rather than asserted as harmless without
qualification.

#### 10.9.6. Rollback artifact, before any deletion (R-8.15, AC-47)

```
ssh vm 'docker exec -i <old-container> pg_dump -U postgres -d postgres \
  --schema=onchain --format=custom' > wi62-rollback-<date>.dump
```

Stored OUTSIDE both containers (the operator's own machine, or a location neither container's
filesystem is), retained N days. Only after this artifact exists does step 10 (`UC-6`) proceed to
drop the thirteen engine tables in the old container. Freezing them in place instead is explicitly
rejected by R-8.15: the rollback path is a file, not tables left standing.

#### 10.9.7. Decommissioning the old container's engine tables (R-8.8, AC-29)

**MAJOR-F precondition (architecture review round 2), repeated verbatim from §10.9.4.** The client
billing ledger, `client_usage`, lives ONLY on the new container — it was never written on this OLD
container (`supabase-db`), because migration `004_t015_billing.sql` is not applied there. This
section therefore drops the TWELVE engine tables of migration 002, not a thirteenth this container
never carried.

After §10.9.6's artifact exists, the twelve engine tables are dropped from the OLD container.
Step 2a's postcondition (`deployment.md` §10.4.2, translated to this topology by `docs/TASK.md`
R-8.13's own instruction) is re-measured there. `may_select` for the snapshotter's read role now
covers `assets`, `metrics`, `snapshots` and NOTHING else, because there is nothing else. The twelve
tables that motivated SEC-2's exception are gone from this container, and the exception has nothing
left to except.

#### 10.9.8. `api_tokens` on the new writer, without reissue (R-8.16, AC-44)

After the profile switches (`UC-6` step 6), a request bearing an ALREADY-ISSUED token authenticates
against the new container without a new token being minted. This is the direct, checkable proof that
the copy of §10.9.4 moved not just rows but the WORKING credential — `api_tokens.token_hash` resolves
on the new container's `SELECT` (`data-model.md` §4.5.4's authentication read, unchanged), against
the SAME server `.env` pepper.

#### 10.9.9. Installation log and record closure (R-8.17, AC-31, AC-46)

The move is recorded in the installation log: date, both container names/ports, and the verify
report's outcome — the SAME "date, hosts, verify result" form `CLAUDE.md` §Working discipline already
names for a host move. `SEC-2` moves to `fixed`, citing this section's §10.9.3 measurement; the
2026-08-23 dev-VM acceptance is retired, not extended (R-8.9). `WI-62` closes in the edition R-8.10
records — a container on the dev VM, not the separated host its literal text names. These three
record updates are operational steps taken when the migration actually runs; this section designs
the procedure they close, and does not itself perform them.
