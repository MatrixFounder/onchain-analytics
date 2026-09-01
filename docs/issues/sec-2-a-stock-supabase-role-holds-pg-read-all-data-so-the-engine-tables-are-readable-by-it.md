---
id: SEC-2
type: known-issue
status: fixed
opened_at: 2026-08-22
category: security
severity: SEV-2
resolved_at: 2026-09-01
resolved_by: TASK 015 (task 015-27, UC-6 step 10; recorded by task 015-28)
slug: sec-2-a-stock-supabase-role-holds-pg-read-all-data-so-the-engine-tables-are-readable-by-it
---

# SEC-2 — a stock Supabase role holds `pg_read_all_data`, so every engine table is readable by it

> **FIXED 2026-09-01 — by construction, not by a grant.** The engine's thirteen tables left the
> managed cluster. Direction 3 of the fix path was executed: a dedicated `postgres:16-alpine`
> container (`onchain-engine-db`) on the dev VM, described by
> [`deploy/onchain-engine-db/compose.yaml`](../../deploy/onchain-engine-db/compose.yaml). A stock
> image ships none of the three platform roles this record is about — the postcondition is a
> property of the IMAGE, not of grants somebody has to keep correct.
>
> **The measurement on the NEW container, taken after the rows moved and the writer started
> (UC-6 step 8, task 015-25), not on the empty tables of step 2.** Sixteen roles exist; fourteen are
> built-in `pg_*`. Exactly two can read any engine table:
>
> | Role | superuser | engine tables readable |
> | :--- | :-------- | ---------------------: |
> | `postgres` | yes — the image's own superuser, named separately | 13 |
> | `onchain_engine_state` | no | 13 |
>
> The "exactly thirteen" half is trivially true where the schema holds nothing else, so the negative
> half was measured too: outside schema `onchain` the state role can `SELECT` nothing; it holds
> `CREATE` on neither `public` nor `onchain`; it is not a member of `pg_read_all_data`.
>
> **The measurement on the OLD container, re-taken after the drop (task 015-27, 2026-09-01
> 10:00 UTC).** The three platform roles are still there and still all-seeing. What changed is that
> the engine has nothing left there to see:
>
> | Role | onchain tables readable, before | after |
> | :--- | ------------------------------: | ----: |
> | `supabase_admin` | 16 | **3** |
> | `postgres` | 16 | **3** |
> | `supabase_read_only_user` | 16 | **3** |
> | `onchain_engine_state` | 13 | **0** |
>
> The three that remain are the snapshotter's `assets`, `metrics`, `snapshots`, which never moved
> (R-8.3) and are not what this record is about.
>
> **The 2026-08-23 acceptance is RETIRED, not extended** (R-8.9). It carried a pinned re-measurement
> tied to leaving the managed cluster. The leaving is done and the re-measurement is spent.
>
> **This file stays.** The two withdrawn fix paths below remain a measured fact about a managed
> cluster, and the next host should read them BEFORE its own measurement, not after.

> Origin: the step-2a measurement of `deployment.md` §10.4.2, run before applying migration 002 to
> the dev VM on 2026-08-22 and re-run after. Filed because the measurement found what that step
> exists to find, and the correction it prescribes is an operation on a shared role.

> **ACCEPTED for the dev VM — owner decision, 2026-08-23.** Direction 4 of the fix path. The record
> stays open in substance and is closed in status only in the sense the ledger's `documented`
> vocabulary means: a constraint accepted with the guidance written down, not a defect repaired.
>
> **What was accepted, stated so a later reader cannot mistake its scope.** On THIS host, three
> platform roles — `supabase_admin`, `postgres`, `supabase_read_only_user` — read the twelve engine
> tables, and nothing available on a managed Supabase cluster prevents it. The exposure is the dev
> administrator's address and the administrative journal, to whoever already holds
> database-administrator access to this same cluster, which today is the person who owns the engine.
>
> **What was NOT accepted.** This decision does not travel. It is scoped to the dev VM, where the DBA
> and the engine owner are one person. The owner's stated intent for the separated host is a
> DEDICATED Postgres container rather than the managed cluster, which is direction 3 and restores the
> postcondition as written — filed as
> [WI-62](../backlog/wi-62-engine-tables-move-to-a-dedicated-postgres-container-on-the-separated-host.md)
> so the intent survives this conversation.
>
> **The re-check this acceptance is pinned to.** Before the network profile runs on any host where
> the database administrator and the engine owner are different people, or where the cluster carries
> another application's data, run the reproduction below again and re-decide. A green run of that
> query on the dev VM is not evidence about the next host, and this paragraph exists because an
> acceptance with no expiry is how a scoped decision becomes an unscoped one.

**Symptom.** `onchain.api_tokens`, `onchain.users` and `onchain.access_audit` — three of the twelve
tables the network profile relies on being private to its own role — are readable by
`supabase_read_only_user`, a role this project neither created nor controls.

**Measured, after migration 002 (15 tables in schema `onchain`):**

```
   table_name    engine_read engine_state supabase_ro
---------------- ----------- ------------ -----------
access_audit     f           t            t
api_tokens       f           t            t
users            f           t            t
assets           t           f            t
…                                         t   (all 15)
```

Our two roles are exactly right: `onchain_engine_read` reaches the three snapshotter tables and none
of the twelve engine tables; `onchain_engine_state` reaches the twelve and none of the three. The
third column is the finding.

**Cause — membership, not a grant.** The privilege appears in no table ACL:

```
grants on onchain.snapshots: {supabase_admin=arwdDxt/supabase_admin,postgres=arwd/supabase_admin}
supabase_read_only_user is a member of: pg_read_all_data
```

`pg_read_all_data` is a Postgres predefined role carrying SELECT on every table in the cluster, so
the reach is automatic and applies to tables created after the membership was granted. That is why
it was already true of `onchain.snapshots` before migration 002, and became true of the twelve
engine tables the moment they existed.

**This is the exact path `deployment.md` §10.4.2 step 2a says the catalogue view cannot see** — "a
privilege inherited through membership in a group role" — and the reason it mandates
`has_table_privilege` instead. The document predicted the mechanism; this record is the measurement
that found an instance of it.

**Blast radius, stated precisely because the obvious reading overstates it.**

- `api_tokens` stores `sha256(pepper ‖ token)` and the pepper lives in the server's `.env`
  (`security.md` §7.5.2). Reading the table yields **no usable credential** — a digest is not a token,
  and without the pepper it cannot be turned into one offline for a token of the shape §7.5.2 defines.
- `users` carries the operator's email address, and `access_audit` the administrative trail. Both are
  readable as written.
- `request_trace` and `diagnostics` carry no secret by construction (D10) but do carry who called
  what and when.

So the exposure is disclosure of operational history and identity, not credential compromise.

**Why it is filed rather than fixed in passing.** §10.4.2 step 2a says "any true elsewhere is revoked
before the profile starts". Carrying that out means `REVOKE pg_read_all_data FROM
supabase_read_only_user` — a change to a role Supabase ships and its own tooling may rely on, on an
instance shared with other work. That is an operation on someone else's environment and it needs the
owner's decision, not an author's judgement.

**The state that makes it urgent ARRIVED on 2026-08-22.** This paragraph previously said the three
tables were empty and the decision could wait for step 4. Migration 003 has now run: `users` holds the
administrator's address, `api_tokens` one active row, and `access_audit` the two bootstrap entries.
All three are readable by `supabase_read_only_user` today. The digest remains useless without the
pepper, so what is exposed is identity and administrative history — but it is exposed now, not
prospectively, and the decision below is no longer one that can be deferred by inaction.

## The remeasurement of 2026-08-23, which removed two of the three fix paths

The owner asked for this to be fixed before other work continued. The measurement taken to carry that
out found the fix does not exist in the form this record first proposed, and the record is corrected
rather than left proposing it.

**Every login role, measured against `onchain.api_tokens` and `onchain.users`:**

| role | reads them | what it is |
| :-- | :-- | :-- |
| `onchain_engine_state` | yes | ours, by design |
| `supabase_admin` | yes | superuser |
| `postgres` | yes | the project-owner role — `rolbypassrls`, and the SECOND member of `pg_read_all_data` |
| `supabase_read_only_user` | yes | this record's subject |
| `authenticator` (PostgREST) | **no** | the internet-facing path |
| `onchain_engine_read`, `pgbouncer`, `supabase_auth_admin`, `supabase_functions_admin`, `supabase_storage_admin`, `supabase_replication_admin` | no | |

**Revoking is not available, on two independent counts.**

1. `pg_read_all_data` has **two** members, not one. The other is `postgres`, the role Supabase gives
   the project owner. Revoking from `supabase_read_only_user` alone leaves the tables readable and
   the postcondition still false, so it would buy the appearance of a fix.
2. `supabase_read_only_user` is named in `/etc/postgresql-custom/supautils.conf` in **both**
   `reserved_roles` and `reserved_memberships`. It is a role the platform manages, and its
   memberships are reserved. A revoke here fights Supabase's own privilege manager rather than
   configuring our own database.

**Row-level security is not available either.** It was the obvious narrower fix — RLS applies to
`pg_read_all_data` members, so a policy on the three tables would have restored the boundary without
touching a platform role. Measured: both members carry `rolbypassrls = t`, so no policy binds them.

**So the postcondition of §10.4.2 step 2a cannot hold on a managed Supabase cluster.** Not because
this installation is misconfigured, but because the platform ships a superuser, an owner role and a
reserved read-only role, all three of which read every table by construction. A document that
requires "false for every other table in the schema" on such a host requires something the host does
not offer.

**The boundary that DOES hold, and it is the one that carries the risk.** `authenticator` — the role
PostgREST authenticates as, and therefore the only role reachable from outside the machine — reads
none of the twelve engine tables. Nor does any other non-platform role. The exposure is to whoever
already has database-administrator access to this cluster, which is a different threat model from
the one the perimeter is built against.

## Fix path, as it stands after that measurement

1. ~~Revoke the membership~~ — **withdrawn**, for the two reasons measured above.
2. ~~Row-level security on the three tables~~ — **withdrawn**: both members bypass RLS.
3. **Move the engine's tables off the managed cluster.** The only direction that restores the
   postcondition as written. The network profile targets a VPS later (§10.1), where the cluster is
   ours and ships none of these three roles; a separate Postgres instance on this VM would do the
   same today. This is the direction §10.7 anticipates, and it is now the only one that works.
4. **Accept, explicitly, for the dev VM.** ← **TAKEN 2026-08-23.** Defensible while the exposure is
   one dev administrator's address and two bootstrap audit rows, and while everyone with
   `supabase_admin` or `postgres` on this cluster is the same person who owns the engine. It is a
   decision with a re-check pinned to the move to a shared host, because the same measurement where
   the DBA and the engine owner are different people reads differently. The pin is stated at the top
   of this record; direction 3 is the owner's stated intent for that host and is filed as WI-62.

**Do not** treat "the digests are peppered" as closing this. It bounds the damage; it does not
restore the postcondition, and `users` plus `access_audit` are unpeppered by nature.

**Do not** revoke `pg_read_all_data` from `postgres` to make the table above look clean. That role is
how the owner administers the project; removing its read is not a security improvement, it is a
locked door with the key inside.

**Reproduction.**

```sh
ssh vm 'docker exec -i supabase-db psql -qtA -U supabase_admin -d postgres' <<'SQL'
SELECT t.table_name,
       has_table_privilege('supabase_read_only_user','onchain.'||t.table_name,'SELECT')
  FROM information_schema.tables t WHERE t.table_schema='onchain' ORDER BY 1;
SELECT string_agg(r.rolname,', ')
  FROM pg_auth_members am JOIN pg_roles r ON r.oid=am.roleid JOIN pg_roles m ON m.oid=am.member
 WHERE m.rolname='supabase_read_only_user';
SQL
```

**Related.** [SEC-1](sec-1-nansen-daily-cap-does-not-bound-a-burst-no-velocity-guard.md) — the other
record where a bound stated in the architecture turned out not to bound what it named.
