-- migrations/003_seed_engine_admin.sql — the first admin of the network profile.
-- Source of truth: data-model.md §4.4 item 5 (the fifth migration obligation), §4.5.3 (`users`),
-- §4.5.4 (`api_tokens`), §4.5.5 (`access_audit`), security.md §7.5.2, PROD-RUNBOOK steps 1–5.
--
-- LIKE 002 AND UNLIKE 001_init.sql, this file uses psql meta-commands and does not paste into a GUI
-- SQL editor. Every installation-local value arrives as a parameter:
--
--   ssh vm 'docker exec -i supabase-db psql -qU supabase_admin -d postgres -v ON_ERROR_STOP=1 \
--     -v ADMIN_EMAIL=you@example.com \
--     -v ADMIN_TOKEN_SHA256=<64 lowercase hex> \
--     -v ADMIN_TOKEN_PREFIX=<the token, first 11 characters> \
--     -v ADMIN_USER_ID=<ULID> -v ADMIN_TOKEN_ID=<ULID>' \
--     < sql/migrations/003_seed_engine_admin.sql
--
-- WHY A MIGRATION AND NOT A FIRST-RUN PATH. A path that creates an admin is reachable before any
-- admin exists, which is the one unauthenticated write the network profile must not have
-- (security.md §7.5.2, owner decision closing OQ-T014-DM-3).
--
-- WHY THE DIGEST AND NOT THE TOKEN. A token in a migration file is a token in git history. The owner
-- mints the token, computes sha256(pepper || token) outside this file, and passes only the hex. The
-- plaintext reaches neither this repository nor the installation's disk: the server compares digests
-- and never needs the secret back.
--
-- WHY THE PEPPER IS NOT A PARAMETER. `ONCHAIN_TOKEN_HASH_SALT` is a permanent secret of class R-29.1
-- living in the server's `.env`; it enters the digest BEFORE this file runs. Rotating it invalidates
-- every issued token at once and there is no re-hash path, because presented secrets are not stored.
--
-- WHY THE TWO ROW IDS ARE PARAMETERS TOO. Canon §1.3 forbids relying on the engine's numbering, and
-- SQL has no ULID generator. A literal here would make seeding a SECOND admin a primary-key
-- conflict — and PROD-RUNBOOK names exactly that as the normal path when a token is lost.
--
-- WHY `now()` IS USED FOR THE TIMESTAMPS. Canon §1.2 bars engine time functions from APPLICATION
-- logic, where two hosts' clocks would disagree about one value. This is a migration applied once by
-- hand; the alternative is a sixth parameter whose only content is "when the operator ran this".
-- `now()` is transaction time, so every row below carries the same instant.
--
-- PRECONDITION: 002_t014_network_profile.sql has been applied, so the three tables and the
-- `phase0-unlimited` access profile exist. Idempotent on every insert — see each one.

-- ── L-28: how these guards report their refusal ──────────────────────────────
-- `\quit 1` does NOT return 1. The exit-status argument to `\quit` arrived in PostgreSQL 17;
-- measured 2026-08-28 on both targets — psql 15.8 (`supabase-db`) and 16.13 (`onchain-engine-db`)
-- — it prints `\quit: extra argument "1" ignored` and the process exits 0. A caller reading `$?`
-- therefore saw SUCCESS on a refusal and went on believing the file had applied.
--
-- Each guard below now raises instead. `RAISE EXCEPTION` exits 3, and the `\set` on the next line
-- makes that independent of whether the caller passed `-v ON_ERROR_STOP=1` — the guard must not
-- rely on the operator remembering a flag in order to be observable. `\quit` is kept after the
-- raise as the belt to that brace; under ON_ERROR_STOP the script never reaches it.
--
-- The `\echo` above each raise is kept deliberately: it prints without a server round trip, so the
-- reason survives even a connection that cannot execute `DO`.
\set ON_ERROR_STOP on

-- ── Pre-check 1: every parameter, before the first write ─────────────────────
-- An unset psql variable leaves its reference unresolved and fails at the statement that uses it —
-- which, without this block, would be after the `users` row was already written. This is why the
-- file either applies fully or writes nothing.
\if :{?ADMIN_EMAIL}
\else
  \echo 'FATAL: -v ADMIN_EMAIL=<address> is required (PROD-RUNBOOK step 3)'
  DO $guard$ BEGIN
    RAISE EXCEPTION 'FATAL: -v ADMIN_EMAIL=<address> is required (PROD-RUNBOOK step 3)';
  END $guard$;
  \quit
\endif
\if :{?ADMIN_TOKEN_SHA256}
\else
  \echo 'FATAL: -v ADMIN_TOKEN_SHA256=<64 lowercase hex> is required (PROD-RUNBOOK step 2)'
  DO $guard$ BEGIN
    RAISE EXCEPTION 'FATAL: -v ADMIN_TOKEN_SHA256=<64 lowercase hex> is required (PROD-RUNBOOK step 2)';
  END $guard$;
  \quit
\endif
\if :{?ADMIN_TOKEN_PREFIX}
\else
  \echo 'FATAL: -v ADMIN_TOKEN_PREFIX=<first 11 characters of the token> is required (security.md 7.5.2)'
  DO $guard$ BEGIN
    RAISE EXCEPTION 'FATAL: -v ADMIN_TOKEN_PREFIX=<first 11 characters of the token> is required (security.md 7.5.2)';
  END $guard$;
  \quit
\endif
\if :{?ADMIN_USER_ID}
\else
  \echo 'FATAL: -v ADMIN_USER_ID=<ULID> is required (data-model.md 1.3 — the app owns the id)'
  DO $guard$ BEGIN
    RAISE EXCEPTION 'FATAL: -v ADMIN_USER_ID=<ULID> is required (data-model.md 1.3 — the app owns the id)';
  END $guard$;
  \quit
\endif
\if :{?ADMIN_TOKEN_ID}
\else
  \echo 'FATAL: -v ADMIN_TOKEN_ID=<ULID> is required (data-model.md 1.3 — the app owns the id)'
  DO $guard$ BEGIN
    RAISE EXCEPTION 'FATAL: -v ADMIN_TOKEN_ID=<ULID> is required (data-model.md 1.3 — the app owns the id)';
  END $guard$;
  \quit
\endif

-- ── Pre-check 2: the address is free, or already belongs to an admin ─────────
-- WHY THIS REFUSES INSTEAD OF PROMOTING. `ON CONFLICT (email) DO UPDATE SET role = 'admin'` would
-- hand administrator rights to whoever took the address before the seed ran. Promotion is an admin
-- operation (R-15.4), performed by someone who already holds the role — never a side effect of
-- applying a file.
--
-- WHY `\gset` AND NOT A `DO` BLOCK RAISING AN EXCEPTION. psql does not interpolate its variables
-- inside a dollar-quoted string, so `:'ADMIN_EMAIL'` inside `DO $$ … $$` would reach the server
-- verbatim and fail as an undefined parameter — after looking correct in review. The check therefore
-- runs as a plain query whose answer psql itself reads.
--
-- 'on' / 'off' rather than a boolean: `\if` accepts those words, and a Postgres boolean arrives as
-- `t` / `f`.
SELECT CASE
         WHEN EXISTS (
           SELECT 1 FROM onchain.users
            WHERE email = lower(:'ADMIN_EMAIL') AND role <> 'admin'
         ) THEN 'on' ELSE 'off'
       END AS address_taken \gset
\if :address_taken
  \echo 'FATAL: that address already belongs to a non-admin user. Promotion is an admin operation'
  \echo '       (R-15.4), not a seed. Choose another address or promote the user deliberately.'
  DO $guard$ BEGIN
    RAISE EXCEPTION 'FATAL: that address already belongs to a non-admin user. Promotion is an admin operation (R-15.4), not a seed. Choose another address or promote the user deliberately.';
  END $guard$;
  \quit
\endif

BEGIN;

-- ── 1/3: the person ──────────────────────────────────────────────────────────
-- `email` is stored lowercased. Neither engine folds case in a UNIQUE index by default (§4.5.3), so
-- `lower()` here is what makes `A@x` and `a@x` one person rather than two — the same rule the
-- repository applies on its own writes.
--
-- Idempotent on the natural key: a re-run after fixing a neighbouring step adds nothing.
INSERT INTO onchain.users (id, email, display_name, role, status, created_at, updated_at)
VALUES (
  :'ADMIN_USER_ID',
  lower(:'ADMIN_EMAIL'),
  NULL,
  'admin',
  'active',
  (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT,
  (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
)
ON CONFLICT (email) DO NOTHING;

-- ── 2/3: the token row ───────────────────────────────────────────────────────
-- `access_profile_id` is the literal ULID of the `phase0-unlimited` row that 002 seeds. A literal,
-- not a lookup by name, for the reason §4.5.3 gives: two engines seeding independently would produce
-- two ids for one profile, and a token would then resolve on one host and dangle on the other.
--
-- `user_id` is read back from `users` rather than taken from :ADMIN_USER_ID, so a re-run against an
-- already-seeded admin attaches to the row that EXISTS instead of to the id this invocation was
-- given.
--
-- The engine checks four things about this row, and none is repeated here: the digest is 64
-- characters, the prefix is at least 8, the prefix is unique, and an active row carries no
-- revocation date (§4.5.4). A constraint copied into the file that inserts under it is a second
-- place to keep in step.
INSERT INTO onchain.api_tokens (
  id, user_id, access_profile_id, token_hash, prefix, name, status, expires_at, revoked_at, created_at
)
SELECT
  :'ADMIN_TOKEN_ID',
  u.id,
  '01JPHASE00000000000000000A',
  :'ADMIN_TOKEN_SHA256',
  :'ADMIN_TOKEN_PREFIX',
  'seeded first admin',
  'active',
  NULL,
  NULL,
  (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
  FROM onchain.users u
 WHERE u.email = lower(:'ADMIN_EMAIL')
ON CONFLICT (token_hash) DO NOTHING;

-- ── 3/3: the journal ─────────────────────────────────────────────────────────
-- Two rows, because the seed performs two operations and R-15.7 gives each its own row.
--
-- `actor_user_id` is NULL, and that null has exactly one meaning: the bootstrap write, performed
-- when no administrator exists to name (§4.5.3, §4.5.5). Every other row of this table names one.
--
-- Neither side carries the token or its digest — the prefix is what identifies a token to the
-- readers of this journal, and there are more of them than of the authentication path (§4.5.5). The
-- prefix is read from the row rather than from the parameter, so the journal describes what was
-- actually written.
--
-- **Idempotency is SEMANTIC here, not a key.** `access_audit` has no natural UNIQUE key by design
-- (§4.5.9), so `ON CONFLICT` has nothing to name. The guard is "this operation is already recorded
-- against this target", which stays right even when a re-run supplies different ids — the ids below
-- are derived from the row's own so that a second run cannot mint a second identifier for the same
-- event.
INSERT INTO onchain.access_audit (
  id, ts, actor_user_id, action, target_type, target_id, before_json, after_json, created_at
)
SELECT
  left(u.id, 22) || 'USER',
  (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT,
  NULL,
  'user.create',
  'user',
  u.id,
  NULL,
  '{"role":"admin","status":"active"}',
  (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
  FROM onchain.users u
 WHERE u.email = lower(:'ADMIN_EMAIL')
   AND NOT EXISTS (
     SELECT 1 FROM onchain.access_audit a
      WHERE a.action = 'user.create' AND a.target_id = u.id
   );

INSERT INTO onchain.access_audit (
  id, ts, actor_user_id, action, target_type, target_id, before_json, after_json, created_at
)
SELECT
  left(t.id, 22) || 'TOKN',
  (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT,
  NULL,
  'token.issue',
  'api_token',
  t.id,
  NULL,
  '{"prefix":"' || t.prefix || '","status":"active"}',
  (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
  FROM onchain.api_tokens t
 WHERE t.token_hash = :'ADMIN_TOKEN_SHA256'
   AND NOT EXISTS (
     SELECT 1 FROM onchain.access_audit a
      WHERE a.action = 'token.issue' AND a.target_id = t.id
   );

COMMIT;

-- ── verify: what an operator reads back, and what they must not ──────────────
-- The prefix identifies the row; the digest is a verifier and never reaches an operator's report
-- (§4.5.4, security.md §7.5.2).
\echo '── verify 1/2: one active admin token, named by its prefix ──'
SELECT t.prefix, u.email, u.role, t.status
  FROM onchain.api_tokens t
  JOIN onchain.users u ON u.id = t.user_id
 WHERE t.status = 'active'
 ORDER BY t.created_at;

\echo '── verify 2/2: two bootstrap journal rows, both with no actor ──'
SELECT action, target_type, actor_user_id IS NULL AS bootstrap_row
  FROM onchain.access_audit
 WHERE action IN ('user.create', 'token.issue')
 ORDER BY action;
