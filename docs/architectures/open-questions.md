# 11. Open questions

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

Two parts. **Open** — items that still need a decision or a live probe before the task that depends
on them; none of them blocks the interface contracts (canonical types, `ProviderAdapter`, registry,
cache DDL, tool schemas). **Resolved** — settled items, kept with the reason that settled them, so
that a closed question is not reopened from scratch.

## Open

### DAPI live gRPC transport — backlog

`dash-platform` is interface + fixture contract only (§3.2). The live transport (evonode host,
`@grpc/grpc-js` + `@grpc/proto-loader`, vendored `.proto`, channel-level `assertAllowedHost`) is a
separate, non-atomic backlog task. `platform-explorer` carries 100% of actual Dash traffic —
R-9/R-10/R-11 are satisfied through a real, not simulated, fallback path (§3.2).

### A second keyless Solana RPC endpoint

Not found. `rpc-solana` runs with a single confirmed host (`api.mainnet-beta.solana.com`) and
retries without hot-swap. A second candidate needs its own live probe before it enters
`hosts`/`adapterIds`.

### `dashpay/platform` license

The repository's `LICENSE` file must be checked before any `.proto` is copied, i.e. when the live
gRPC backlog task lands. The expectation is permissive; nobody has verified it.

### ERC-20 / SPL balances

Deliberately out of scope (§3.2) — a backlog work item. The `Balance` schema already accepts them
without a migration.

### Opportunistic hardening

Two known limits. Neither blocks anything; both are cheap to close next time the code is touched.

- `safeFetch`'s Content-Length cap does not cover chunked / no-Content-Length responses — that
  needs a streaming byte counter (§3.2, R-47).
- `rpc-solana` does not parse exact lamport balances above `Number.MAX_SAFE_INTEGER` (~9.007M SOL)
  — a vendor JSON-number limitation (§3.2, R-47).

### OQ-6 — who runs `sync-chain-registry.ts`, and how often

§4.2.1 deliberately makes registry freshness the **operator's** duty rather than the runtime's, for
the sake of the offline gate and control over the security surface. The flip side is stated
plainly: the registry goes stale exactly as fast as people forget about it, and the first symptom
is "no such chain" — a message that looks like missing support rather than stale data.

Options: (a) nothing, a manual run when needed; (b) a CI job that opens a PR with the registry
diff — keeps human review of `rpcHosts` and removes the remembering; (c) surface registry age
(`registrySyncedAt`, already returned by `onchain_list_chains`, §5.1.3) as a stderr warning at
startup once it crosses a threshold. (b) + (c) looks right, but this is a **process** decision, not
an architectural one — it changes nothing in the design.

### Backlog candidate — a wider Nansen chain scope

A broader Nansen-specific chain scope for one or more of the three paid capabilities. It requires a
separate live probe **per capability** (the vendor's per-endpoint enumerators do not agree with each
other) and an explicit product request, which the ROADMAP §M2 exit criteria do not state.

### T-012 — deferred capability-manifest specifics (owner confirmation needed in Development)

T-012's design deliberately left items open rather than guessing (`docs/TASK.md` §6 carries the full
text as `OQ-T012-1`…`OQ-T012-5`). **The arithmetic, stated so the two lists in this file stop
disagreeing** — there are **five**, and they resolve like this:

| Item                                           | State                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `OQ-T012-4`                                    | **inherited** — it is OQ-A above (config locus, T-014); untouched by T-012                       |
| `OQ-T012-2`, `OQ-T012-3`                       | **CLOSED 2026-08-03 by owner decision OD-5** (below)                                             |
| the deadline "partial result" reading (R-145b) | **CLOSED 2026-08-03 by owner decision OD-4** (below)                                             |
| `OQ-T012-5`                                    | **answered by the PLAN**, not by this document — see the closing note at the end of this section |
| `OQ-T012-1`                                    | **CLOSED 2026-08-04 by the 012-4 audit** — result in §Resolved, "T-012 (2026-08-04)"             |

- ~~**`shape` for 12 of 20 capabilities**~~ **CLOSED 2026-08-04 by the audit task 012-4 ran over each
  adapter's actual `normalize()` return** (`token.metadata`, `pairs.new`, `pool.info`,
  `protocol.tvl`, `dex.volume.history`, `privacy.shielded_pool`, `platform.identities`,
  `platform.contracts`, `platform.documents`, `platform.credits`, `smart-money.flows`,
  `token.risk`). The full 20-row classification, and the two rows where reading the code changed
  what an inspection of names would have concluded, are in §Resolved below.
- ~~**`trust` for `platform-explorer`.**~~ **CLOSED 2026-08-03 by owner decision (OD-5):
  `authoritative`.** D9's scale asks about the REDACTABILITY of content, not the operator's official
  status — the counters are machine-aggregated from the chain and outsiders cannot edit them, so
  `community` would misdescribe them. The cost of getting it wrong is not hypothetical: this is
  precisely the source D6 turns merging on for FIRST (`privacy.shielded_pool.history`,
  `platform.metrics.history`), so a mislabel would land in the first merge we ship.
- ~~**`trust` DEFAULT for `pg-history`.**~~ **CLOSED 2026-08-03 by owner decision (OD-5):
  `community`** — deliberately the LOWEST rank, as a conservative PLACEHOLDER, so nothing is
  over-trusted before the real per-row mechanism (rank taken from the row's own `source`) arrives in
  T-016. **Recorded as a placeholder with a scheduled replacement, not as a judgement about our
  own ledger** — the code comment must say so, or a future reader will "correct" it.
- ~~**The deadline-exceeded "partial result" reading (R-145b).**~~ **CLOSED 2026-08-03 by owner
  decision (OD-4)** — it was escalated rather than left for Development, because a plan cannot be
  written against "returns a value" _or_ "throws". Decision: a deadline **always throws**
  `CapabilityDeadlineExceededError`, naming both which sources answered and which were never asked;
  it never returns the surviving partial. Rationale is the H-1 doctrine
  (`adapters/registry.ts:443-455`): a deadline is a fact about OUR availability, and publishing it
  as a fact about the DATA reports "no entity labels" for a sanctioned address whenever the paid
  source merely failed to fit the budget. This is a deliberate deviation from the literal text of
  ADR-002 D4 п.5, and R-156 obliges T-012 to amend the ADR rather than silently contradict it.

**Two mechanical obligations of the same commit** (recorded here so they are not lost between
phases — both are cases where the code's own comments will otherwise outlive their truth):

- `packages/core/src/providers.config.ts:125` says "**10 entries**" for what is already **12**, and
  T-012 edits every one of those 12 to add `tier`/`trust` — so the stale count is touched by this
  task regardless. Fix it in the same commit.
- `packages/core/src/adapters/blockscout/index.ts:125-146` documents the missing deadline and ends
  "this docstring must be rewritten in the SAME commit, not after it" (ADR-002 D4). The historical
  `≈410s` derivation stays as history — it is the justification for the mechanism — but the
  "decided but not built" framing must go, replaced by the two-phase arithmetic
  (`deadlineMs` head + `paidLegMs` tail). This is R-157.

### T-012 — three seam problems the design assumes away (found by architecture review 3, 2026-08-03)

Each was **measured against current source**, not inferred. None changes a T-012 decision; each
changes what Development must build to make a stated check real, so Planning has to allocate for
them rather than discover them at the test.

- **The H3 paid-adapter contract test is not writable through today's seams.** The design says a
  test parameterised over `tier === 'paid'` asserts that no call issued after a successful
  `checkAndReserve()` carried a `deadlineAtMs`. But `safeFetch` is a **static module import**
  (`packages/core/src/adapters/nansen/endpoints.ts:4`, called at `:136`) — there is no `safeFetch:`
  deps key anywhere in `packages/core/src`. The injectable deps are `fetchImpl` and `throttle` only,
  and `fetchImpl` receives a `RequestInit`, which carries no `deadlineAtMs` to assert on. So only
  the `throttle` half is observable today.

  **RESOLVED 2026-08-03 by owner decision (OD-6): build the seam — add a `safeFetchImpl` deps key
  alongside `fetchImpl`, mirroring the seam the rest of the adapter already uses**, so the contract
  test asserts the invariant DIRECTLY on the transport. Rationale: D4 п.2 is a correctness
  condition, not an optimisation, and H3 exists to make it mechanically enforceable for EVERY future
  paid adapter, not just today's `nansen`. **The reduced option — "state plainly that the guarantee
  is enforced on the limiter path only" — is WITHDRAWN**, because a limiter-only test would look
  like it checks the invariant while checking half of it, which is the failure mode AC-8 was amended
  to forbid. If the seam turns out costlier than expected, that is an escalation, not a silent scope
  cut. Planned as deliverable work (type change + call-site update + the contract test) in
  `docs/PLAN.md` task 012-9.

- **The proposed `BudgetMeta.provider` runtime assertion would be tautological.**
  `packages/mcp-server/src/tools/budget-meta.ts:34-37` — `budgetMeta(budgetStore, now)` takes **no
  provider argument** and hardcodes `getUsage('nansen')` / `provider: 'nansen'`. Asserting that a
  compile-time constant belongs to a set containing it can never fail. Either thread the answering
  provider id in from the three M2 handlers, or exempt this site by name from AC-14's grep gate and
  say why.
- **The singleflight follower cannot raise the registry-layer error.** The design has a follower
  with a tighter deadline abandon its wait and raise `CapabilityDeadlineExceededError` — but that
  class is constructed with `capability`/`chain`/`tried`, none of which exist inside
  `singleflight()` (`adapters/nansen/index.ts:596`). The follower must raise the **net-layer**
  `DeadlineExceededError` and let the registry's existing catch translate it, exactly as the C-1
  bridge already does for every other net-layer deadline. Filed independently by two review lenses.

**`OQ-T012-5` — answered at Planning, 2026-08-03 (recorded here so this file's two lists agree).**
The question was whether T-012 ships a working failing type-test for "merge cannot be declared on a
`point` capability". **It does not, and the reason is a rule this project already applies
everywhere: a test that cannot fail proves nothing.** The merge field does not exist yet, so there
is literally nothing for such a test to catch. What T-012 ships instead: (a) the discriminated
union, (b) the design intent in the manifest type's docstring, and (c) an executable **declaration
guard** — a test that reads `capability-manifest.ts` and requires `CapabilityManifest` to stay a
two-arm union, so it cannot be flattened back to an interface before T-013 arrives. The negative
type-test is T-013's obligation, recorded in that docstring.

**Scope of what the union buys today, stated precisely** (an earlier draft of this paragraph
overstated it): both arms currently differ in **nothing but the `shape` literal**, so a merge field
added to the shared base would still be legal on `point`. The union does not make the constraint
**hold** — it makes it **expressible**: T-013 adds the field to one arm and the constraint becomes a
compile error at that moment, with no retyping. Adding `mergeKey?: never` to the `point` arm now was
considered and rejected: it pre-commits to a field NAME T-013 has not chosen, and a guard keyed on
the wrong name is a guard that can never fire. See `docs/PLAN.md` task 012-4.

## Resolved

### OQ-T012-6 — a walk where nobody failed returns its answer past the ceiling. RESOLVED 2026-08-05.

**Status: RESOLVED by the owner, 2026-08-05 — Reading A, with two conditions.** The record is kept
whole rather than summarised: the two readings below are why the resolution says what it says, and a
closed question stripped to its answer is one that gets reopened from scratch.

Found by executing the mutation protocol at task 012-10 and reproduced independently at review.
Two accepted decisions disagree about one branch, and both are defensible, so the resolution is not
a developer's call.

**What was measured.** A route of two adapters, both answering unsatisfyingly, `deadlineMs: 20`, the
second one spending 120 ms: `resolve()` **returned** at elapsed 139 ms. Neither the pre-check nor the
translating catch fires, because every adapter was **entered** before the clock ran out — only the
last one overran. `hadFailure` therefore stays false, and `if (unsatisfying && !hadFailure) return
unsatisfying;` (`adapters/registry.ts:901`) is reached **before** the terminal deadline branch
(`:938`). Both anchors were re-measured on 2026-08-05: adversarial cycle 2 grew the file, and the
`:740`/`:764` recorded here originally now point at unrelated lines. A record whose purpose is the
owner's own re-check is worth nothing if its coordinates rot — re-measure them, or quote the
predicate text, whenever this file is touched.

This is not an exotic path. It is what a slow final source does.

**Reading A — H-1 governs, and the return is correct.** `!hadFailure` means every adapter was asked
and every one of them answered. That is a fact about the DATA, and reporting it as an error would
tell the caller to retry something that cannot change. Under this reading the deadline caused
nothing: the answer is complete, not partial, and the ceiling is irrelevant to its content. Source:
the H-1 doctrine, `adapters/registry.ts:886-901`, bought with an iteration of adversarial review at
TASK-008.

**Reading B — the pre-check's own rationale governs, and the return is a violation.** Task 012-8 put
the deadline pre-check **above** the cache read on the stated grounds that a deadline means "after
this moment we do not answer", not "after this moment we do not go to the network", because a caller
cannot predict the second. Answering at 139 ms against a 20 ms deadline contradicts exactly that.
Source: the pre-check placement decision, recorded in `system-architecture.md` and in
`registry.ts`'s own comment.

**What each resolution costs.**

| Resolution                            | Cost                                                                                                                                                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep today's behaviour (A wins)       | ADR-002's D4 changelog entry stays narrowed to "expiry throws when it prevented or aborted a source"; the deadline is documented as a bound on **asking**, not on **answering**; a future network client (ADR-003 / T-014) inherits a ceiling it cannot rely on for latency |
| Make expiry throw here too (B wins)   | The H-1 return becomes conditional on the clock, so "everyone was asked and nobody has data" stops being reportable once a walk runs long; the TASK-008 regression that H-1 closed needs re-checking against the new ordering                                               |
| Return the answer AND signal lateness | A third outcome shape; no consumer exists for it in T-012, and ADR-003 D5 has not been written against it                                                                                                                                                                   |

**Do not resolve it by swapping the two branches.** Subordinating H-1 to the clock is Reading B
applied silently, and H-1 cost a full adversarial iteration to establish.

**THE RESOLUTION (owner, 2026-08-05) — Reading A, with two conditions.**

The answer is RETURNED. In this branch the deadline prevented nothing and aborted nothing: the time —
and on a paid route the credit — is already spent, and discarding the result does not give either
back. It only converts complete data into "retry later", and the retry that follows walks the same
route again to reach the same answer. Whether a late-but-complete answer is still worth anything is a
judgement only the caller can make, because the caller is the one that set the deadline. The choice
is also the reversible one: throwing can be introduced later, whereas subordinating H-1 to the clock
destroys a property that cost a full adversarial iteration.

**Condition 1 — the pre-check's own justification was rewritten, not left standing.** "A deadline
means: after this moment we do not answer" is FALSE of this method, and the resolution would
otherwise close the question in one direction while the document kept arguing the other. The ceiling
now reads as a bound on SPENDING (time, and credits on a paid route), never as a promise about the
moment of delivery. Changed in `adapters/registry.ts` (the pre-check comment) and in ADR-002's D4
passage.

**Condition 2 — the overrun is reported, never silent.** `CapabilityResolution.deadlineOverrunMs` is
stamped in one place (`withDiagnostics`, beside `attempted`), present only when positive, and
`mcp-server` publishes it as `_meta.timing.overrunMs`. Returning late data silently is the shape this
project has already ruled against twice — a healed metric that hides the vendor's gap, and a
diagnostic nothing reads.

**The branch is now covered**, as this record required ("the test is written together with the
decision, not before it"): `TC-OQ6-a…d` in `test/registry.deadline.test.ts` pin the return, the mark,
the absence of the mark inside budget, and the untouched `hadFailure` path. Both directions were
mutation-checked — removing the stamp fails TC-OQ6-b, implementing Reading B fails TC-OQ6-a and -b.

**What this does NOT license.** Reading B's cost is still real and is now the accepted one: a caller
cannot use `deadlineMs` as a latency contract. When ADR-003 makes the engine network-facing, its
client needs its own timeout — the engine's ceiling bounds what the engine spends, not when the
response lands. The trigger to revisit is a consumer that acts on data automatically with no timeout
of its own; there is none today.

ADR-002's §Changelog entry of 2026-08-03 on D4 п.5 carries the original measurement; the entry of
2026-08-05 carries this resolution.

### T-012 (2026-08-04, Development) — what the ten tasks actually closed

Written at task 012-10, from the tree the ten tasks produced. Every number below was read out of the
working tree on 2026-08-04, not carried from the plan.

**OQ-T012-1 — `shape` for all 20 capabilities. CLOSED.** The audit (task 012-4) read each adapter's
actual `normalize()` return rather than its capability name; the per-row evidence lives beside each
row in `packages/core/src/capability-manifest.ts` as an `AUDIT:` comment. Result:

| `shape`  | Capabilities                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `point`  | `token.price`, `token.metadata`, `protocol.tvl`, `chain.tvl`, `chain.supply`, `privacy.shielded_pool`, `platform.identities`, `platform.contracts`, `platform.documents`, `platform.credits`, `smart-money.flows`, `token.risk` |
| `set`    | `pairs.new`, `pool.info`, `wallet.balances.native`, `token.holders`, `entity.labels`                                                                                                                                            |
| `series` | `dex.volume.history`, `privacy.shielded_pool.history`, `platform.metrics.history`                                                                                                                                               |

**Where the plan's hypotheses met the fact.** All ten hypotheses the plan stated were CONFIRMED, and
two of them only because the audit read code instead of names — which is the part worth keeping:

- `pool.info` → `set`, and the NAME says otherwise. `dexscreener/index.ts:125` ignores its `_cap`
  argument entirely, so both of that adapter's capabilities run the same `normalize(): Pool[]`: the
  singular-sounding capability returns a collection.
- `dex.volume.history` → `series` **by substance, not by container**. `defillama/index.ts:338`
  returns ONE `DexVolumeResult` object, so a mechanical "is the return an array?" rule would have
  said `point`; its content is a `ts`-sorted, day-bucketed, de-duplicated run. This is why the
  classification rule recorded in the manifest is about ordering by `ts`, not about arrays.
- The two the plan deliberately left "to be confirmed" — `smart-money.flows` and `token.risk` —
  both resolved to `point`: one record about one token, whose embedded arrays (`topHolders[]`, the
  two indicator arrays) are enrichment of the subject rather than peer subjects.

**OQ-T012-2 / OQ-T012-3 — verified, not reopened.** Both were closed at Planning by owner decision
OD-5 (2026-08-03). Checked against the tree: `platform-explorer` → `trust: 'authoritative'`
(`providers.config.ts:314`) and `pg-history` → `trust: 'community'` (`:332`), each carrying the
decision's own reasoning in place, and the `pg-history` comment opens with "**PLACEHOLDER with an
assigned replacement — do NOT 'correct' this to `authoritative`**", which is the wording OD-5
required. The document and the code agree.

**OQ-T012-5 — the decision, and what shipped.** There is **no** executable failing type-test for
"merge cannot be declared on a `point` capability" in T-012, and its absence is the decision, not an
omission: the merge field does not exist, so such a test has no input on which it can fail. What
shipped instead is the discriminated union, the intent in the manifest type's docstring, and an
executable **declaration guard** (`test/capability-manifest.test.ts`) that reads
`capability-manifest.ts` and fails if `CapabilityManifest` stops being a two-arm union. The negative
type-test is **T-013's obligation**, recorded in that docstring.

**The three seam problems (§0.3 of the plan) — how each was actually closed.**

1. **`safeFetchImpl` — BUILT, in full, per owner decision OD-6.** The seam exists on all three deps
   types the paid path passes through: `NansenAdapterDeps` (`nansen/index.ts:105`),
   `NansenEndpointDeps` (`endpoints.ts:98`) and `NansenBudgetGateDeps` (`budget-gate.ts:257`), each
   defaulting to the real `safeFetch`. The reduced variant ("declare the guarantee bounded by the
   limiter path only") was **withdrawn at Planning and does not appear in the delivered work as a
   chosen option** — it is recorded here only as a rejected alternative. The H3 contract test
   (`test/nansen-deadline-boundary.test.ts`, TC-CONTRACT-01/02) now asserts on BOTH seams: the
   transport, where the money is spent, and the limiter.
2. **`budgetMeta()` — the provider id is threaded, so the check became real.** The function takes a
   `providerId` parameter (`mcp-server/src/tools/budget-meta.ts`), passed by all three M2 handlers
   from `outcome.cache.provider`. The exemption option was not used. This matters beyond tidiness:
   `entity.labels` routes the FREE `blockscout` first, so the "the reported provider is a paid one"
   branch has a live falsifier instead of being a claim about a constant.
3. **The singleflight follower raises the NET-layer class, and the registry translates.** As
   predicted: `CapabilityDeadlineExceededError` needs `{capability, chain, tried}`, none of which
   exist inside `singleflight()`, so the follower throws `DeadlineExceededError` and the registry's
   C-1 catch converts it. Both halves are pinned (TC-INT-03 and TC-INT-04 in
   `test/nansen-deadline-boundary.test.ts`).

**A DECISION, not a document alignment: `~30_000 → ~15_000` for `privacy.shielded_pool` and the four
`platform.*` capabilities.** `system-architecture.md`'s "`deadlineMs`/`paidLegMs` by capability"
table put these five in the "≤2 free adapters in sequence" tier at ~30 000 ms. The delivered
manifest assigns **15 000 ms**. Derivation: the second adapter of those routes is `dash-platform`,
whose `isAvailable()` is unconditionally false, so it makes **zero** network attempts and adds zero
to the envelope — the route is single-live-adapter in fact, which is the ~15 000 tier. **Condition
for reverting: a live gRPC transport for `dash-platform`** (the backlog item at the top of this
file). On the day it lands, these five rows return to the two-adapter tier and each needs a fresh
derivation record beside it (R-149). Recorded as an override rather than folded into an "align the
docs" diff, deliberately: an alignment and an override must not look the same in a diff, or the
approved number is rewritten with no record and the next gate accepts the rewrite as agreement.

**A counterexample to `data-model.md` §M-6's ARGUMENT — and the exact boundary of what it refutes.**
M-6 argues that only the manifest map needs to be injectable because "there is no scenario where a
test needs a DIFFERENT policy dictionary — only a route referencing a `kind` that does not exist in
the real one". The scenario exists: the M-1 fail-open guard (now `test/policy-fail-open.test.ts`)
needs a predicate that **throws**, and no such `kind` is in the real dictionary — nor should one
ever be, since a policy class whose whole behaviour is to throw is not a policy anybody would
route. **What is refuted is the ARGUMENT, not the DECISION.** M-6's decision — the class dictionary
stays a module, not a sixth constructor parameter — **stands**: `vi.mock('../src/adapters/policy.js')`
in that one file covers the need, the production surface is untouched, and **no architecture
amendment is required**. This distinction is the whole reason the entry exists: read as a refuted
decision, it invites a sixth constructor parameter nobody decided to add.

**Found while proving AC-8, and recorded because it changes how a published envelope should be
read: the 140 s cancellable envelope for `entity.labels` is a sum of two INDEPENDENT worst cases and
is not jointly realisable under the 60 s ceiling.** PLAN §0.2 derives it as 50 000 (the free
`blockscout` attempt: `MAX_WAIT_MS` + 4 × 5 000) plus 90 000 (the `/account` resync: `MAX_WAIT_MS` +
4 × 15 000). For both limiter halves to be served, 60 000 ms of limiter waiting must fit inside a
60 000 ms ceiling with all eight transport hops still to come — and the limiter does not partially
wait: with 10 000 ms left and a 30 000 ms backlog it refuses UP FRONT with `DeadlineWouldExceedError`
(`net/rate-limit.ts`, the `MIN_POST_WAIT_REMAINDER_MS` branch), which by design is not a deadline
hit, so such a walk ends as `CapabilityUnavailableError`. The AC-8 case therefore scripts 110 000 ms of cancellable want
(`test/entity-labels-deadline-arithmetic.test.ts`) and observes the ceiling cutting 45 000 ms of it.
Nothing in the code is wrong; the published envelope is an upper bound over independent legs, and
reading it as "a single run that spends 140 s cancellably" is what does not hold.

### T-012 (2026-08-03) — OQ-C, and a self-contradiction found in ADR-002's own D9 staging

**OQ-C — the fate of `CapabilityRoute.chains` (ADR-002 D2). Resolved: deleted.** The field was read
by the router (`adapters/registry.ts:191-195`, narrowing `matching` routes) but set by ZERO of the
21 entries in `providers.config.ts` — re-measured 2026-08-03, the identical result TASK-006 and
ADR-002 itself already recorded. T-012 removes the field from `CapabilityRoute` together with the
`registry.ts` filter that read it, per the escape hatch ADR-002 D2 itself specifies: **if
Development's construction-time audit of all 21 routes finds one that genuinely needs to narrow
chains BELOW what `chainSupport()` already expresses, the field returns with that route named as
the consumer** — its absence is not assumed, it is checked (a compile-time type-removal test,
TASK.md R-139d), and it does not return "just in case".

**ADR-002's own "Влияние на этапы" table contradicts its own OQ-B closure about where D9 lands.**
Two passages of the SAME document disagree on `trust`'s (D9) implementation stage:

- The impact table (dated 2026-07-31): `D9 → T-016`.
- The OQ-B closure (dated 2026-08-01, LATER and MORE SPECIFIC): "Реализация — T-012 (поле в
  манифесте) и T-016 (включение)" — the FIELD lands in T-012; only its CONSUMPTION (merge
  segmentation, community-marking, `source → trust` autofill) waits for T-016.

**Resolution (owner, 2026-08-03): the later, more specific formulation governs.** `trust` is a
declare-only field in T-012 with zero consumer logic (system-architecture.md, "Source trust —
declare-only"); full inclusion stays T-016. This document does not silently pick a reading: ADR-002
§Changelog needed its own entry naming BOTH formulations and the reason the second wins, and the
"Влияние на этапы" table needed a footnote pointing D9 at T-012+T-016 rather than T-016 alone —
both Development-time obligations of T-012 (TASK.md epic E-6, R-156), not something this
architecture document edits on ADR-002's behalf. It was recorded here so the discrepancy had a home
even before that ADR edit landed.

**DISCHARGED 2026-08-04 (task 012-10).** ADR-002 now carries the §Changelog entry dated 2026-08-03
("место крепления `trust`"), naming both formulations and the two checkable reasons the later one
wins, and the `D9` row of "Влияние на этапы" carries footnote `[^t012-d9]` — the only edit made to
that table, its "T-016" cell left as written. The entry also records a second, smaller divergence
found while discharging this one: OQ-B's closure says "поле в манифесте", while what T-012 actually
built is a field on `AdapterRegistration` (`adapters/types.ts:139`), because `trust` is a property of
the SOURCE and the capability manifest describes the CAPABILITY — a distinction D9 itself makes.

### T-010 (2026-07-31) — OQ-M3-1 and OQ-4

Both were closed by owner decisions on 2026-07-31 and written up as ADRs. The **options as they
stood** are preserved below on purpose: a closed question must not be reopened from scratch, and the
rejected alternatives are the cheapest part of the record to lose.

**OQ-M3-1 — the interface n8n uses to call engine capabilities: Streamable HTTP.**
See [ADR-003](../onchain-analytics/ADR-003-network-transport-and-billing.md) D1.

The snapshotter stays on n8n + Postgres permanently (owner decision 2026-07-25, ADR-001 D8/D9
addenda). That settled ownership and opened a consequence: if the schedule lives in n8n and the
canonical capabilities live in the engine, something has to carry calls between them — and there was
no transport, the MCP server being **stdio-only** (D3), which is not callable over a network. M3
cannot bypass the engine the way the snapshotter does for DAPI: rules must be computed on
**canonical** data, with the budget gate and the cache, or n8n becomes a second provider client with
its own normalization and no credit accounting, throwing away all of M2.

The three options were: (1) **bring the Streamable HTTP transport forward** from M6 — a public
surface plus auth/CORS/port questions; (2) **one-shot CLI mode** — no network surface, but a process
start per call and n8n must live on the same machine; (3) **n8n writes a job into Postgres and the
engine polls it** — inverts the dependency but brings back an always-on engine process, contradicting
the 2026-07-25 decision itself. The entry's own verdict, quoted so the reversal below has something
to reverse: _"Option 2 is the least invasive for M3 and spends none of the decisions reserved for M6;
option 1 is the correct one if the engine is meant to be a network service at all."_

**Chosen: option 1**, on a ground that did not exist when the options were written. That verdict
judged option 2 "least invasive for M3" while assuming the only consumer was our own n8n. The owner's
2026-07-31 decision to **sell access** to the MCP for client credits makes that assumption false: a
paying client cannot invoke a one-shot CLI on our machine. The choice stopped being a trade-off about
invasiveness. stdio is **not** removed — local development under Claude Code must not require a
running server, and `createServer` is already transport-agnostic (`mcp-server/src/server.ts:52-55`),
so the seam costs nothing to keep.

**OQ-4 — where cross-provider routing policy lives: a serialisable descriptor plus a registry of
policy classes in core.** See [ADR-002](../onchain-analytics/ADR-002-configurable-routing.md), which
closes it in full (D1…D9).

OQ-4 was inherited from TASK-008 and never had a home in this file — it lived in the §7 of whichever
`docs/TASK.md` was current, which is why it now reads as three different questions across the repo.
The routing-policy one is this one. (The **M2** OQ-4 — `entity.labels` escalation default on Pro —
and the **TASK-006** OQ-4 — historical `chain.tvl` series — are separate, both below, and neither is
affected.)

The question was: `CapabilityRoute.isSatisfying` is a literal predicate in `providers.config.ts`, its
own docstring calls it provisional, and the owner's 2026-07-28 decision said the real router must
call a **combination** of adapters and aggregate, with policy configured partly in the DB "as
classes". Resolution: the predicate becomes a serialisable descriptor `{ kind, ...params }` resolved
against a registry of classes in code (**ADR-002 D2**) — adding a class is a code change plus a test,
choosing one is a config line, and a descriptor naming an unregistered class fails at registry
construction rather than on first traffic. Aggregation becomes a property of the capability's
`shape` (**D3**/**D5**), is off by default, and is enabled first on `series`, not on `entity.labels`
(**D6**), because a series has a legitimate identity key (`metric`/`asset`/`ts`) and labels do not.

### M1 (TASK-003)

| ID                              | Question                                  | Resolution and reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DexScreener endpoint            | which call serves `pairs.new`/`pool.info` | `GET /latest/dex/search?q=<NATIVE_QUERY>` (`ETH`/`SOL`), confirmed by a live probe 2026-07-22 plus fixtures. The response is an object `{schemaVersion, pairs}`, not a top-level array — a shape trap, pinned by a regression test.                                                                                                                                                                                                                                                                                                                                                           |
| `ONCHAIN_PG_URL` validation     | is `z.string().url()` enough              | Yes. Verified empirically on a realistic Supabase string (percent-encoded special character in the password plus a query string); the planned fallback was not needed.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm -r build`/`test` topology | does `core` build before `mcp-server`     | Yes — confirmed by the output order of a live `pnpm -r build`, not assumed from pnpm's documented default (§6.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Dune R-8 scope                  | how much of R-8 ships                     | `dune` ships as an interface/config stub — no `fetch`/`normalize`, no fixture, no contract test — narrower than R-8's literal acceptance wording. `token.risk` has been served by Nansen since M2 and `token.holders` by the free `blockscout` since TASK-008, so the exact query id / SQL has no consumer left to be authored for at all. The stub's three remaining defects (a docstring promising a reason the coverage gate pre-empts, `costOf: () => 0` on a credit-metered vendor, and the ROADMAP still listing Dune among M1 adapters) are tracked as track-A item **A-4**, not here. |

### M2 (TASK-005 `m2-alpha-paid`) — OQ-1…OQ-5

**OQ-1 — the bucket ceiling formula: two separate conditions, not one `min()`.** The vendor limit is
**anchor-relative**: `snapshot.usageAtObserve` (the spend already accounted for in
`creditsRemainingAtObserve` at the moment of the resync, read in the same logical step as
`/account`) is subtracted from the bucket-total `usage.credits_used(bucket)`, and only that
difference (`spentSinceAnchor`) is compared against `creditsRemainingAtObserve`. The self-imposed
`NANSEN_DAILY_CREDIT_CAP` stays **bucket-relative** — compared against the full bucket usage
directly, with no anchor, because it is a daily ceiling on our own pacing, not a vendor remainder.

Both conditions apply simultaneously, and they must not be collapsed into a **raw** `min()`. Exactly
one correct collapse exists, and it rebases the vendor term first:
`effectiveCeiling = min(usageAtObserve + creditsRemainingAtObserve, CAP)` (§3.2). A raw `min()`
subtracts already-counted spend again on every mid-bucket resync (the `unreconciled` trigger, R-38)
and produces a phantom lockout instead of protection against one. Full formula and a worked numeric
example: system-architecture.md §3.2.

Resync is triggered by cold start (no snapshot, or a snapshot from a previous day bucket) and by the
`unreconciled` flag (R-38/UC-6) — not on every call (§3.2 "Account state"). The day bucket is the
engine's **own** pacing instrument (R-36), not an assumption about the vendor's reset cadence, which
no probe confirms.

**OQ-2 — where the budget gate lives: inside the `nansen` adapter's `fetch()`.** Not
`CapabilityRegistry.resolve()` (that would put Nansen-specific code inside a universal component)
and not the MCP tool handler (that breaks the mandatory "cache miss before gate" order, R-37/UC-5).
The gate is a private implementation layer of `adapters/nansen/index.ts`, sitting on the seam where
`CapabilityRegistry.resolve()` already calls `adapter.fetch()`. Non-bypassability is structural: the
package's only publicly exported nansen factory is `createNansenAdapter()`.

One ungated path does exist, behind an **explicit** opt-in — `__ungatedForTestsOnly: true` with
`budgetStore` omitted, an escape hatch for isolated HTTP contract tests. One flag is enough:
`fetchImpl` falls back to the real global `fetch`. Production never sets it (`mcp-server` always
passes a `budgetStore`), but the guarantee is phrased as "one explicit flag", not "no ungated
variant exists" — a money guard must never be described as stronger than its code makes it. Details:
system-architecture.md §3.2.

**OQ-3 — chain scope: `ethereum` + `solana`, the same subset as M1.** Live evidence showed that the
three relevant Nansen per-endpoint enumerators (`SmartMoneyChain` — 17, `TGMHoldersChain`/`TGMChain`
— 24 each) are **not identical to one another**, and that the "~32 chains" seen during probing is a
different, out-of-scope surface (the official Nansen MCP server). Widening is the backlog candidate
above.

**OQ-4 — the `onchain_entity_label` escalation default on Pro: not raised automatically.**
`exhaustive` stays an explicit opt-in regardless of plan. Both prices
(`/profiler/address/labels` = 100 cr, `/profiler/address/premium-labels` = 500 cr) are statically
known, but raising the default on Pro would make the tool's behaviour depend on non-deterministic
external state (the current account plan) without the calling agent's intent — the same principle
already applied to rate limits and TTLs: configuration, not a hidden heuristic. Raising the default
later is a one-flag edit, not an architectural decision.

**OQ-5 — a self-imposed env ceiling: yes, `NANSEN_DAILY_CREDIT_CAP`.** It narrows, never widens, the
live-derived ceiling, so the owner's decision in TASK.md §1 item 1 stands. The `EnvSchema` pattern
(`emptyAsUndefined`, D10) is the same as for the other six keys. The key has **three** states: unset
→ the engine derives the ceiling (`max(30, 25% of the balance at the START of the day bucket)`,
fixed for that bucket); a positive integer → an explicit operator ceiling; `off` → self-limiting
disabled. Protection therefore works out of the box, and `0` remains invalid on purpose. The
derivation is computed from the `usageAtObserve + credits_remaining` anchor rather than from the
live remainder — otherwise a mid-day server restart recomputes the ceiling from a POST-spend balance
and locks the paid layer out for the rest of the UTC day.

### TASK-006 (`universal-chain-registry`) — OQ-1…OQ-5

Two forks that define the tool contract were closed by the owner **before** this architecture
(TASK §1.3), and it does not revisit them: (1) `chain` is an open string plus `onchain_list_chains`,
not a `z.enum`; (2) uncovered pairs get the coverage matrix plus soft degradation.

**OQ-1 — which non-EVM address families get validators: still only `evm` and `svm`, and paid
capabilities now REFUSE on a family without a validator** (`hasAddressValidator`,
`chain/address.ts`). The original decision — accept without canonicalization, price paid in cache
splitting — was correct right up to the moment it had itself named as the trigger. TASK-006 brought paid
Nansen to 7 chains of the `other` family, where three things hold at once: (a) `isValidAddress`
accepts any string up to 128 characters, so a garbage `tokenAddress` reserves credits; (b) two case
variants of one address are two paid cache entries; (c) the DF-1 case rule for those chains is
unknown. The price is named in the code and in the report: `entity.labels` 25→18, `token.risk`
24→18, `smart-money.flows` 17→16 chains. A chain comes back when someone writes its family's
validator, not when the rule is relaxed.

**OQ-2 — the criterion for putting a chain into `rpcHosts`:** top-N by TVL plus a manual liveness
check; auto-fill is forbidden (§7.2.1). The threshold rationale: the top 50 chains hold 99.1% of TVL.

**OQ-3 — is a one-off cold cache invalidation acceptable: yes, and it never happened.** Dual-read was
dropped as YAGNI. The canonical value became the slug, and before TASK-006 the tools accepted exactly
`ethereum`/`solana`, which **are** their own slugs — so `args_hash` of existing entries never
changed. The cold session budgeted in the plan was not needed.

**OQ-4 — historical `chain.tvl` series:** current value only (TASK §4 item 5). Series are a separate
task.

**OQ-5 — ordering relative to M3:** TASK-006 entirely **before** M3. M3's signals build on top of the
chain layer, and building them before universalization means building them twice.
