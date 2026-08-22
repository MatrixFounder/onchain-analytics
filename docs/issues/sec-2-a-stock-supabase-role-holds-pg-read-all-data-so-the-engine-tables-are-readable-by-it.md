---
id: SEC-2
type: known-issue
status: open
opened_at: 2026-08-22
category: security
severity: SEV-2
slug: sec-2-a-stock-supabase-role-holds-pg-read-all-data-so-the-engine-tables-are-readable-by-it
---

# SEC-2 — a stock Supabase role holds `pg_read_all_data`, so every engine table is readable by it

> Origin: the step-2a measurement of `deployment.md` §10.4.2, run before applying migration 002 to
> the dev VM on 2026-08-22 and re-run after. Filed because the measurement found what that step
> exists to find, and the correction it prescribes is an operation on a shared role.

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

**Fix path — three directions, and the third is not a deferral.**

1. **Revoke the membership.** `REVOKE pg_read_all_data FROM supabase_read_only_user;` restores the
   postcondition exactly. Risk: unmeasured impact on Supabase's own tooling on this instance. Measure
   what still authenticates as that role before revoking.
2. **Move the engine's tables off this cluster.** The network profile targets a VPS later
   (§10.1), where the cluster is ours and no such role exists. This closes it by relocation rather
   than by revocation, and it is the direction §10.7 already anticipates.
3. **Accept and record, for the dev VM only.** Defensible while the tables hold a single dev admin
   and no production trace — but it must be an explicit decision with a re-check pinned to the move
   to a shared VPS, because the same measurement on a host with real traffic reads differently.

**Do not** treat "the digests are peppered" as closing this. It bounds the damage; it does not
restore the postcondition, and `users` plus `access_audit` are unpeppered by nature.

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
