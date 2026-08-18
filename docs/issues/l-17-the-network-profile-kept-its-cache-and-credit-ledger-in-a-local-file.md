---
id: L-17
type: known-issue
status: fixed
opened_at: 2026-08-18
category: logic
severity: SEV-2
slug: l-17-the-network-profile-kept-its-cache-and-credit-ledger-in-a-local-file
resolved_at: 2026-08-18
resolved_by: TASK-014 задача 014-19 (commit fce3216)
---

# L-17 — the `network` profile kept its cache and its credit ledger in a local file

> **Fixed 2026-08-18** (commit `fce3216`). `index.ts` resolves the storage axis once, through
> `createStateStores({storage})`, and hands the runtime that axis's cache, budget and limiter. The
> `local` profile is unaffected: its axis is SQLite, which is what it was already getting.
>
> Held by `test/limiter-wiring.test.ts`, which requires the entry point to build the runtime from
> `stores.cache` and `stores.budget` rather than from a hardcoded factory.

> Origin: found while wiring the shared limiter for task 014-19. Not a `run-feedback` capture — the
> limiter could not be wired at all without resolving the axis first, and resolving it is what made
> the other two stores' engine visible.

**Symptom.** A process started on the `network` profile connects to Postgres, passes its pre-start
checks, answers requests — and writes `cache_entries` and `usage` to `DATA_DIR/cache.sqlite3`.
Migration 002 created both tables in schema `onchain`; both stay empty forever. Nothing reports
anything: every gate is green, because every gate measures the stores and not which engine the entry
point picked.

**Cause.** `createSharedRuntime` resolves its stores as

```ts
const budgetStore = (deps.budgetStoreFactory ?? createBudgetStore)();
const registry = buildRegistry(deps.env, budgetStore, deps.cacheStoreFactory ?? createCacheStore);
```

and `index.ts` passed neither factory. Both defaults are the SQLite implementations, and
`profile.storage` decided exactly one thing: which `StateClient` the identity repositories opened.

`createStateStores` — the factory task 014-39 wrote for precisely this — had no production caller.
Its own docstring deferred the wiring to "task 014-09, and until it ships the `network` profile
refuses to start". 014-09 shipped, and no later task inherited the sentence.

**Blast radius, and why it is SEV-2 rather than a tidiness defect.** `usage` is the credit ledger
`checkAndReserve` compares against the daily Nansen ceiling. Two `network` processes against one
Postgres were meant to share it; each instead held its own file and therefore **the full daily cap**.
The limit that exists to bound spend was multiplied by the number of processes — the same shape as
R-7's limiter defect, one floor down, and denominated in money rather than in request rate.

`cache_entries` is the cheaper half: two processes each keep their own cache, so a paid answer is
fetched once per process instead of once. That costs credits too, at a smaller multiple.

**Why no test caught it.** Every store test constructs a store directly, and both axes are measured
against each other by `pg-store-parity.test.ts` — thoroughly, and entirely below this line. The one
suite that builds the real runtime, `per-session-server.test.ts`, injects its own factories on
purpose — a test calling the real ones would write to the developer's `DATA_DIR`. So the branch that
picks a factory in production is the one branch no suite executes. The pre-start check
(`assertNetworkPreconditions`) proves the DSN answers and an active token exists; it says nothing
about who later writes through it.

**Do not** read `profile.storage` at the store call sites to fix a case like this. The axis is
resolved once, at the entry point, and handed down — a second decision site is a second place for
the two halves of one process to disagree about where their state lives.

**Do not** treat "the migration created the table" as evidence that anything writes to it. Migration
002 has created `cache_entries`, `usage`, `usage_window` and `provider_buckets` in `onchain` since
task 014-35, and all four stayed empty through five subsequent tasks without a single gate noticing.
The verify block in that migration counts objects created, which is a different claim.

**What this says about the gate set, beyond the fix.** A deferral written into a docstring —
"not wired by this task, the blocker is 014-09" — is not a tracked obligation. It is prose in a file
the next task has no reason to open, and it survived the blocker being removed. The project's own
instrument for this is a named residual in the task file or a `docs/BACKLOG.md` entry; a sentence in
the code that a future reader might find is neither.
