---
id: WI-62
type: work-item
status: done
opened_at: 2026-08-23
slug: wi-62-engine-tables-move-to-a-dedicated-postgres-container-on-the-separated-host
effort: M
value: 'restores the §10.4.2 postcondition that a managed Supabase cluster cannot satisfy, and closes SEC-2 by construction rather than by acceptance'
source: SEC-2 owner decision, 2026-08-23
resolved_at: 2026-09-01
resolved_by: TASK 015 (stage 6, UC-6 steps 1-11)
---

# WI-62 — the engine's tables move to a dedicated Postgres container on the separated host

> **DONE 2026-09-01, in the R-8.10 edition — the dev VM, not a separated host.** Read this line with
> the amendment below: the destination is a dedicated container beside the existing services, and
> the separated host stays the `OQ-T014-B` trajectory.
>
> **Three measurements close this record, not the one its `Acceptance` names.** That clause said the
> step-2a query returns no `true` outside "the two role/table pairs" — refuted during T-015's review
> and replaced, not amended:
>
> | # | Measurement | Result |
> | :- | :---------- | :----- |
> | 1 | the state role over the thirteen tables of the NEW container (R-8.5) | true for all thirteen; false outside schema `onchain` |
> | 2 | every other application role over those thirteen (R-8.6) | none — only the image's own superuser, named separately |
> | 3 | the OLD container re-measured after the move (R-8.8) | schema `onchain` holds only `assets`, `metrics`, `snapshots` |
>
> **What was actually moved, and what it cost.** Twenty-five rows across eleven tables, verified by a
> five-check gate that compared row counts, both time bounds, full-row content, orphans and the shape
> of `usage` — `PASS`, zero mismatches. `api_tokens` moved WITH the rest and an already-issued token
> authenticated against the new container without reissue (AC-44), which is the check that proves a
> working credential travelled rather than bytes. The alert channel was silent for 2 h 34 min against
> a declared bound of 24 h.
>
> **Two premises of the plan were refuted by measurement along the way**, both recorded where the
> next reader will meet them: `onchain-retention` was a live writer of three transferred tables
> (the plan said it was not installed), and `client_usage` DID exist on the old container (MAJOR-F
> said migration 004 was never applied there — it was).
>
> `SEC-2` moves to `fixed` in the same pass, with its dev-VM acceptance retired rather than extended.

> **Amendment — owner decision 2026-08-25, executed by T-015.** The host is the **dev VM**, not a
> separated host. A dedicated Postgres container is stood up beside the existing services on the dev
> VM, and the engine's tables move there out of the managed Supabase cluster. Everything else in this
> record is executed literally: `SEC-2` moves to `fixed` with the §10.4.2 measurement quoted, and its
> dev-VM acceptance is **retired rather than extended**. The separated host itself remains the
> `OQ-T014-B` trajectory and is explicitly out of T-015's scope.
>
> Read the words "separated host" below — in the title, in the `What`, and in `Acceptance` — against
> this amendment. They are left unedited on purpose, the way `ADR-002` D4 п.5 keeps its withdrawn
> literal text: a record rewritten in place loses the trace of what changed and when.
>
> One clause of `Acceptance` was refuted rather than amended, and T-015's review found it: "the
> §10.4.2 step-2a query returns no `true` outside the **two role/table pairs**" contradicts this
> record's own body, which names three snapshotter tables for the read role and twelve engine tables
> for the state role. T-015 replaced it with three measurements — the state role over thirteen tables
> on the new container, no other role over any of them, and the old container re-measured after the
> move (`docs/TASK.md` R-8.5, R-8.6, R-8.8).

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
