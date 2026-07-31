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

## Resolved

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
