---
id: WI-62
type: work-item
status: open
opened_at: 2026-08-23
slug: wi-62-engine-tables-move-to-a-dedicated-postgres-container-on-the-separated-host
effort: M
value: 'restores the §10.4.2 postcondition that a managed Supabase cluster cannot satisfy, and closes SEC-2 by construction rather than by acceptance'
source: SEC-2 owner decision, 2026-08-23
---

# WI-62 — the engine's tables move to a dedicated Postgres container on the separated host

**What.** Stand up a plain Postgres container beside the existing services on the separated host, and
run the network profile's twelve tables there instead of inside the managed Supabase cluster. Same
architecture otherwise — schema `onchain`, the two roles, the same migration file, which is the whole
point of the portability rules DB-SCHEMA §1 already enforces.

**Why, and why it is not the same as the dev VM's arrangement.** [SEC-2](../issues/sec-2-a-stock-supabase-role-holds-pg-read-all-data-so-the-engine-tables-are-readable-by-it.md)
measured that a managed Supabase cluster ships three roles that read every table by construction —
`supabase_admin` (superuser), `postgres` (owner role, `rolbypassrls`, a member of `pg_read_all_data`)
and `supabase_read_only_user` (reserved by `supautils.conf`). Neither a revoke nor row-level security
is available against them. The owner accepted that on the dev VM, where the database administrator
and the engine owner are the same person, and stated the intent to avoid it on the separated host
rather than carry the acceptance forward. This item is that intent, written down.

**The postcondition it restores.** `deployment.md` §10.4.2 step 2a: `may_select` true for exactly the
three snapshotter tables for the read role and exactly the twelve engine tables for the state role,
and **false everywhere else** — with no platform-owned exception, because a cluster we run ships none
of those three roles.

**Scope notes, so the estimate is not read as larger than it is.**

- The migration is unchanged. `002_t014_network_profile.sql` takes both role names as `psql`
  parameters and uses only portable types, which is exactly the mechanical-move property DB-SCHEMA §1
  was written for.
- The snapshotter stays where it is. It writes `onchain.assets/metrics/snapshots` through the
  existing "Supabase DB" credential, and the engine reads them read-only. Splitting the hosts means
  the engine's read path and its state path address two different servers — that is the part to
  design, and `deployment.md` §10.1 already anticipates two DSNs.
- The n8n retention workflow follows the state role: its credential points at whichever server holds
  `retention_runs`.

**What must be measured rather than assumed.** Whether the engine's read of the snapshotter tables
stays a database connection at all once the hosts differ, or becomes something else. This item does
not decide that; it names it as the open question the design pass has to answer.

**Acceptance.** The network profile runs on the separated host against a Postgres the project
controls; the §10.4.2 step-2a query returns no `true` outside the two role/table pairs; SEC-2 moves to
`fixed` with that measurement quoted, and its dev-VM acceptance is retired rather than extended.
