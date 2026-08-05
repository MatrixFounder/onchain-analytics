# Version history (changelog)

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

- 2026-08-05, **v4.10** — T-013 `series-merge-and-history-tool`: **design phase, ahead of code.**
  Recorded here so the index's version pointer resolves; every claim below is DECIDED, not built, and
  no source file has moved as of this entry.

  - **The merge mechanism (ADR-002 D5/D6) gets its activation model, its conflict rank, and its
    policy-evaluation point** — the three questions `docs/TASK.md` §6 left open
    (`OQ-T013-2`/`3`/`4`), closed in [open-questions.md](open-questions.md) and reasoned in full in
    [system-architecture.md](system-architecture.md) "Merge mechanism": (1) activation needs TWO
    gates, not one — manifest `mergeable` eligibility (R-159, already decided) PLUS a new,
    independent `CapabilityRoute.merge?: boolean`, because D5's text names the route's own descriptor
    and UC-20 names an act the route performs, which manifest-only activation cannot construct (a
    capability with more than one route is explicitly OUT OF SCOPE, not silently solved); (2) the
    compiled conflict rank reuses the route's existing `adapterIds` order rather than a new table or
    `.trust`/Postgres, narrowly and provisionally, pending T-016's real per-row trust axis — and is
    now ENFORCED, not merely documented: a new construction-time assertion requires every `merge:
true` participant to be `tier: 'free'`, closing the hazard of a paid, more-authoritative
    participant silently losing every conflict by sitting last in spend order; (3) `policy` is
    evaluated per-participant, the same predicate the non-merge path already applies to cache hits,
    preserving H-1 rather than replacing it with a whole-array reading — with one stated divergence:
    a merge route where everyone answers and nobody satisfies never falls back to a single
    participant's raw answer the way the non-merge path does, since that would silently un-merge the
    response.
  - **R-164's four-branch outcome contract layers on top of the three existing failure types, not
    into them** (reliability.md §9.1) — a merge walk collects every participant's state (answered /
    not-asked / asked-did-not-answer) across the WHOLE route before deciding, instead of returning on
    the first satisfying answer; the deadline (OD-4, all THREE sites that already throw
    `CapabilityDeadlineExceededError` — the per-participant pre-check, an in-flight `fetch()` cut off
    by the ceiling, and the caller's own already-expired deadline at entry) stays a PRECONDITION that
    pre-empts all four branches, unchanged from the non-merge contract, and the terminal wall-clock
    disjunct (`registry.ts:944`) is preserved for the same reason WI-36 argued: it covers all twelve
    adapters, not the two whose typed class unwrapping fixed.
  - **`CapabilityResolution` gains three optional fields** (`sources`, `missingSources`,
    `perSourceCache`) populated ONLY on a merge walk; the 18 non-merge capabilities and their 13
    shipped tools see zero shape change (R-174/R-175) — `resolveCapability()` is extended the same
    additive way, and the 14th tool reuses it rather than re-implementing error translation.
    🔴 **`sources` means CONTRIBUTORS** (participants whose points are present in `result`), corrected
    after review from an earlier "everyone who answered" reading that would have attributed a merged
    payload to a participant that returned nothing of its own.
  - **The 14th tool, `onchain_dash_platform_history`** (interfaces.md §5.1.6), publishes both
    merge-eligible capabilities behind a `series` selector, grouping its answer by `metric` (owner
    decision `OQ-T013-1`, 2026-08-05). 🔴 **`ToolSpec.capability` does NOT widen** — an earlier draft
    said it should and called that "the one change" and "backward-compatible"; measured against the
    tree it was neither (three type declarations, one of them the committed `tool-inventory.json`
    artifact's schema, and a hard offline failure in `eval/capabilities.mjs`'s strict-equality
    lookup). Corrected: `capability` stays `string | null`, unchanged; a new additive field,
    `servedCapabilities?: readonly string[]`, carries both, and three readers
    (`eval/capabilities.mjs`, `docs-counts.test.ts`, `tool-spec.test.ts`) need a real, named, small
    behaviour change — enumerated in system-architecture.md, not left as "the rest is Development's
    problem".
  - 🔴 Dedup by `(metric, asset, ts)` never compares `value_raw` numerically: walking contributors in
    RANK order and inserting into a map only when the key is absent picks the winner by construction
    — no value comparison exists to route through `Number(...)` in the first place (R-167).
  - The merged result is never cached as a unit (D5's 🔴 invariant) — nothing about the merge walk
    is a new `cache.set()` call; every per-adapter cache read/write is the SAME code the non-merge
    path already runs.
  - 🔴 **Baseline corrected after review — 1538** (1206 core + 332 mcp-server), not 1473. "No source
    file moved" is still true of T-013 itself, but 1473 is v4.9.3's figure, and WI-34…WI-37 landed
    on top of it with **no version-history entry recording the delta** — carrying 1473 forward here
    would let a 65-test regression pass R-178(a)'s gate unseen. The missing interval (v4.9.3 → this
    entry) is a gap in this file, not in the suite; it is named here rather than silently patched.
  - 🔴 **Round 2 (BLOCKING) — the interfaces.md anchor fix from round 1 made the suite RED.** Two
    bare `// Capability:` anchors for a tool that is not yet registered inflated
    `docs-counts.test.ts`'s pairing count (12 against 11) — `pnpm --filter @onchain-intel/mcp-server
test docs-counts` failed. §5.1.6 now carries NO anchor; the anchors land in the same commit that
    registers the `ToolSpec`. Verified green (7/7) after the fix.
  - Round 2 also: named TWO more `servedCapabilities` readers that fail SILENTLY
    (`eval-capability-coverage.test.ts`'s RF-5 guard, `eval-checks-coverage.test.ts`'s server-level
    classifier) plus the artifact-mapper site (`gen-tool-inventory.ts`) that defeats the JSON-side
    reader if left unchanged; corrected `data-model.md`'s `source` rule, which stated only the
    all-zero-contributor fallback and not the primary "highest-ranked contributor" rule; extended
    the `limit`-truncation disclosure to `series:'shielded_pool'` (`pg-history`'s 100-row cap applies
    to BOTH capabilities, not only `platform_metrics`); and scoped
    `assertMergeParticipantsAreFree()` to a capability's flattened participant set rather than one
    route's literal `adapterIds`.

- 2026-08-05, **v4.9.3** — **OQ-T012-6 resolved by the owner: Reading A, with two conditions.** The
  one branch T-012 shipped knowing it was contested — every source entered, every one answered, the
  last one running past the ceiling — now has a decision instead of a note.

  **The answer is returned, not thrown.** In that branch the deadline prevented nothing and aborted
  nothing; the time, and on a paid route the credit, are already spent, so discarding the result does
  not recover them — it converts complete data into "retry later", and the retry walks the same route
  to the same answer. Whether a late-but-complete answer is worth anything is the caller's judgement,
  because the caller set the deadline. It is also the reversible choice: throwing can be added later,
  while subordinating H-1 to the clock destroys a property that cost a full adversarial iteration.

  - **Condition 1 — the pre-check's justification was rewritten.** "A deadline means: after this
    moment we do not answer" was false of the very method it annotated. The ceiling now reads as a
    bound on SPENDING (time, and credits on a paid route), never as a promise about delivery.
    Changed in `adapters/registry.ts` and in ADR-002's D4 passage — a justification the code
    contradicts is worse than none, because the next reader designs against it.
  - **Condition 2 — the overrun is reported.** `CapabilityResolution.deadlineOverrunMs` is stamped
    in one place (`withDiagnostics`, beside `attempted`) and published as `_meta.timing.overrunMs`;
    absent, never `0`, on every call that finished inside its budget. A silent late answer is the
    shape this project has ruled against twice already.
  - **The eleven handlers stopped hand-copying `_meta`.** Fifteen sites each wrote
    `cache: outcome.cache`, so a second resolution-derived field meant fifteen chances to miss one —
    which is exactly how cycle 3's F-A happened one layer up. They spread `metaFrom(outcome)` now,
    and the next field is free.

  `TC-OQ6-a…d` pin the return, the mark, the absence of the mark inside budget, and the untouched
  `hadFailure` path; both directions were mutation-checked. Test suite — **1473** (1141 core + 332
  mcp-server), green.

- 2026-08-05, **v4.9.2** — T-012 adversarial cycle 3 and the fix pass that followed it. The cycle
  ended at the review cap **without convergence** (all three critics still reporting), so this entry
  records what was repaired afterwards on the owner's instruction, not a clean verdict.

  - **Cycle 2's `_meta.budget` fix was incomplete on the branch it was written for**, and two
    critics found it independently. The handlers still called `budgetMeta()` only on
    `cache.status === 'miss'`, while the registry's H-1 return can hand back an EARLIER adapter's
    **cache hit** after the walk entered and paid `nansen` — so the response said `'hit'`, carried no
    budget, and the credit was invisible. Cache status is gone from the rule entirely: budget is
    reported exactly when the traversal ENTERED a paid adapter, one condition in one place
    (`budget-meta.ts`), and the load-bearing invariant behind that simplification ("the answering
    adapter of a `'miss'` is itself among the entered") is asserted against the real registry
    (TC-F-A-INV) rather than assumed.
  - **The limiter's post-wait floor was a prediction nothing measured.** `remainingMs - waitMs >=
floor` is arithmetic done BEFORE the sleep, and a timer is only guaranteed not to fire early —
    so the attribution guarantee the floor exists for held under an assumption about the scheduler.
    A second check now re-measures the budget on waking and refuses (`phase: 'observed'`) if the wait
    overran; it deliberately does NOT refund, since that wait was paid in real time. The constant's
    derivation also stopped citing `blockchain-info`, which configures the same 5 000 ms hop timeout
    and passes **no** deadline at all — naming it made the evidence look twice as wide as it was.
  - **`attempted` is now on the wire gate.** It was introduced in cycle 2 with a docstring promising
    it never crosses the wire, and nothing checked that; the ordinary `return { ...outcome, … }`
    refactor would have published our route composition with every test green.
  - **A key-in-path RPC endpoint is refused where it is admitted, not where it is printed.**
    `safeFetch` publishes `origin + pathname` and justified keeping the path with "the path is ours,
    never a secret" — an assumption that the Alchemy/Infura convention breaks. `isApprovableRpcUrl`
    now rejects an `rpcHosts` entry with a credential-shaped path segment at LOAD (security.md
    §7.2.1), and `rpc-evm`'s comment claiming `safeFetch` "names only the hostname" — which it never
    did — is corrected.
  - **The vendor-text surface is measured instead of assumed bounded** (security.md §7.2.2): per-field
    and per-row caps existed, and nobody had multiplied them out. < 17.5 KB per entity, 400 entries
    per nansen response (the two vendor arrays are sliced independently), 512 KiB per blockscout call
    by transport — produced by feeding oversized input through `normalize()` and weighing the output.

  Test suite — **1467** (1137 core + 330 mcp-server), green. Zero credits spent, as for every
  earlier T-012 entry.

- 2026-08-05, **v4.9.1** — T-012 adversarial cycle 2: nine findings, two of them live defects, the
  rest claims the code did not hold. **`raceWithTimeout` attaches its handlers before the
  already-aborted check** — a caller that cancelled before the call left the in-flight fetch
  rejection unhandled, which on Node's default ends a long-lived stdio server. **The limiter's
  deadline refusal tests what a wait LEAVES**, not whether it fits: sleeping the budget down to a
  sliver produced the TERMINAL deadline class one layer down and cancelled every adapter behind the
  saturated one — H-1 from the branch written to prevent it. **`_meta.budget` follows the traversal,
  not the winner:** `resolve()` returns `attempted` (adapters whose `fetch()` was entered) so a call
  that pays `nansen` and returns `blockscout`'s answer still reports the spend. **The two
  `providers` writers' conflict clauses agree** (the cache store no longer clobbers `notes`).
  **Prototype-named capabilities and policy kinds are rejected** (`Object.hasOwn`, plus a
  `Number.isSafeInteger` guard on `manifest.deadlineMs`) — such a route used to build a registry with
  a `NaN` deadline and a fail-open policy. And the **deadline's enforcement is now stated by
  measurement**: two adapters read `deadlineAtMs`, so four capabilities of twenty are actually
  bounded and the rest carry a declared ceiling — sanctioned by R-140e, tracked as WI-37, and no
  longer described as if it cut anything. That last record is **gated rather than written**: every
  manifest row carries its own ENFORCED/DECLARED marker, and `capability-manifest.test.ts`'s
  TC-F5-GATE checks each marker against the adapter sources plus both ratios in the prose, so
  WI-37 cannot land leaving the document behind. Test suite — **1452** (1126 core + 326
  mcp-server), green.

- 2026-08-04, **v4.9** — T-012 `capability-manifest-and-call-deadline` **built**. Written on
  2026-08-05, when the two cycle entries above were found filed as `v4.8.x` — below the version
  `ARCHITECTURE.md`'s own index had been pointing at since the build — and the entry for the build
  itself was found missing entirely. The index row is the authority on what landed; this is the
  changelog line that should have accompanied it.

  Ten tasks, seven accepted on the first round. The policy is a serialisable descriptor resolved
  against a class registry and validated at construction (D2); 20 manifest rows, each deadline number
  recorded with its measured envelope and the applied ceiling (D3); an absolute call deadline threads
  `resolve→fetch→throttle→safeFetch` with real cancellation and stops at the credit reservation (D4);
  `tier` collapsed four disagreeing classifications of paidness into one (D8); `trust` is
  declare-only with the validator as its sole reader (D9 slice); `CapabilityRoute.chains` is deleted
  (OQ-C). Enforcement is stated by measurement, not by intent: 4 capabilities of 20 are actually
  bounded (WI-37). Suite 1195 → 1417, zero credits spent. **One claim is narrower than v4.8 stated**
  — expiry does not throw in every branch, which is OQ-T012-6, open and unresolved.

- 2026-08-03, **v4.8** — T-012 `capability-manifest-and-call-deadline`: **design phase, ahead of
  code.** Recorded here so the index's version pointer resolves; every claim below is DECIDED, not
  built, and no source file has moved as of this entry.

  - **Four ADR-002 decisions land as one stage** (they touch the same files): the answer-sufficiency
    policy becomes a serialisable descriptor resolved against a class registry (D2, two classes:
    `any`, `someElementHasAny{fields}`); capabilities gain a manifest — `shape`/`ttlSeconds`/
    `deadlineMs`/`shareable` (D3); an absolute `deadlineAtMs` threads
    `resolve→fetch→throttle→safeFetch` (D4); provider `tier` collapses four disagreeing paid/free
    classifications into one (D8). `trust` lands **declare-only** (D9 slice), and
    `CapabilityRoute.chains` is deleted (OQ-C).
  - **The deadline is a two-phase budget, and the architecture review is why.** The first draft
    claimed the deadline turns the measured ~410s envelope into ~60s. It cannot: `nansen` makes ONE
    `gate.ensureBudget()` and runs all 2–3 sub-calls under that single reservation
    (`nansen/index.ts:656-657`), so ~270s sits **after** the credit commitment, where D4 п.2 forbids
    cancellation. `deadlineMs` therefore bounds only the cancellable head; each paid capability
    separately records a derived `paidLegMs`, and the stated worst case is their sum (~330s for
    `entity.labels`). Owner decision 2026-08-03; retuning nansen's own timeouts was rejected.
  - **A deadline never publishes a partial as fact.** ADR-002 D4 п.5 reads "ответил хотя бы один →
    частичный результат", but a deadline is a fact about OUR availability, and the H-1 doctrine
    (`adapters/registry.ts:443-455`) forbids dressing that as a fact about the data — returning the
    partial would report "no entity labels" for a sanctioned address merely because the paid source
    did not fit the budget. Expiry throws `CapabilityDeadlineExceededError` naming both which
    sources answered and which were never asked. Owner decision 2026-08-03; ADR-002 is amended
    rather than silently contradicted.
  - **One ADR-002 self-contradiction and one deliberate deviation from it — both recorded rather
    than resolved in silence.** The _self-contradiction_ is D9's stage: the impact table says T-016
    while the later OQ-B closure says T-012 field + T-016 enabling — two passages of the same
    document disagreeing, resolved in favour of the later and more specific one. The _deviation_ is
    D4 п.5 above: the ADR is internally consistent there and we are departing from it on the
    strength of our own H-1 doctrine. Conflating the two would misreport where the authority lies.
  - Baseline at design time — **1195** (889 core + 306 mcp-server), green.
  - **Amended the same day, during Planning — OD-5 and OD-6 close what the design had left to
    Development.** Both were escalated rather than guessed, because a plan written against "or"
    cannot be verified. **OD-5:** the two contested `trust` values are fixed —
    `platform-explorer` = `authoritative` (D9's scale asks about the REDACTABILITY of content, not
    the operator's official status; and this is the source D6 turns merging on FIRST, so a mislabel
    would ship inside the first merge), `pg-history` = `community` as a **declared placeholder**
    replaced by the per-ROW rank in T-016 — recorded as a placeholder precisely so a later reader
    does not "correct" it. Closes OQ-T012-2 and OQ-T012-3; the T-012 open list drops from three
    items to one (`shape` for 12 of 20 capabilities). **OD-6:** the `safeFetchImpl` deps key IS
    built, rather than narrowing H3 to the limiter path — D4 п.2 is a correctness condition, and a
    limiter-only test would look like it checks the invariant while checking half of it, the exact
    failure mode AC-8 was amended to forbid. The reduced option is withdrawn, not left as a live
    alternative; a cost overrun there is an escalation, not a silent scope cut.

- 2026-08-02, **v4.7** — TASK-011 `single-tool-registry`: **the tool inventory became data.**

  - **One registry, many readers.** `src/tools/registry.ts` holds the mechanism (`ToolSpec`,
    `defineTool`, `ToolContext`), `src/tools/tool-specs.ts` the data, and `server.ts` became a loop.
    Registration, the stdio suite, `smoke-dist`, the eval's capability axis and the documentation
    gates all became readers of that one list. `needs` + a runtime projection make least privilege a
    **fact** rather than a convention — a free tool physically cannot reach the budget store.
  - **What deriving everything costs, and where that cost is paid.** Derived guards agree with the
    registry by construction, so a _lost_ entry would leave all of them green. Three guards are
    therefore deliberately NOT derived: the frozen byte-for-byte `tools/list` snapshot, a
    hand-written lower bound asserted on the **live** list, and the documentation gate. Proven by
    mutation: removing a tool fails three of them plus `smoke:dist`.
  - **Four adversarial cycles, 0 CRITICAL / 0 HIGH, verdict WARNING.** The recurring defect was not
    a wrong fix but a _partially applied_ one — the same fact corrected in one place while it lived
    in three or four. It caught, among others: both READMEs still stating "8 MCP tools" after their
    names were fixed (the task's own headline defect, half of it surviving all four cycles); a gate
    written against a class that let that class through; and a repair checklist that had drifted
    into three disagreeing copies. Numbers, mutations and the un-reviewed surface:
    [reviews/task-011-adversarial.md](../reviews/task-011-adversarial.md).
  - Test suite — **1161** (876 core + 285 mcp-server); the `tools/list` snapshot did not move once
    across all four cycles, i.e. nothing in the review was wire-visible.

- 2026-07-29, **v4.6** — documentation pass (`/update-docs` after TASK-009). No design decision
  changed; what changed is that the documents' own claims became checkable.

  - **Stale counts corrected in eight places across five files** — adapters (10 → 12), MCP tools
    (10/11 → 13) and test totals (796 → 1106) in `functional-architecture.md`, `deployment.md`,
    `interfaces.md`, `technology-stack.md`, `system-architecture.md` and the index. All of it had
    accumulated because TASK-007 and TASK-008 updated the section they were editing and no more.
  - **Two mechanical gates so it cannot rot again** (WI-21): `mcp-server/test/docs-counts.test.ts`
    compares the counts these documents state against `adapterRegistrations` and the real
    `tools/list`, and requires every registered tool to be NAMED in §5 — a count alone would pass if
    one tool were swapped for another, and TASK-008's actual failure was a tool with no entry at all.
    `core/test/ttl-coverage.test.ts` requires an EXPLICIT TTL row for every routed capability; the
    silent fall-through to `DEFAULT_TTL_SECONDS` has happened twice and was caught by review both
    times. Both were mutation-checked rather than assumed to work.
  - **Historical statements are deliberately out of scope.** The gates read only present-tense
    sentences: "M1 shipped nine adapters" is true forever, and `version-history.md` is a log of what
    past versions said. A gate that rewrote history to match today's counts would be worse than none.
  - `eval/README.md`'s "Free providers only" paragraph existed **twice**, in two wordings, and both
    copies still listed the five M1 providers after two free adapters had been added. Merged into one.
    A fact stated twice is a fact that gets updated once.

- 2026-07-29, **v4.5** — TASK-009 `btc-supply-independent-verification` (research track A-3): the
  twelfth adapter `blockchain-info`, capability `chain.supply` on `bitcoin`, the tool
  `onchain_chain_supply`, and a reference-source axis in the eval. Three findings from the live
  keyless probe of 2026-07-29, each of which changed the design:

  - **The vendor's two supply surfaces are two different quantities, both correct** (§3.2/§4.1).
    `/stats.totalbc` sits at an INTEGER number of block subsidies past the halving boundary — it is
    the formula; `/q/totalbc` sits at a FRACTIONAL one, so it cannot be a stale copy of the formula
    and is instead the actually-claimed supply. The gap is unclaimed coinbase subsidy (~29–32 BTC,
    0.00016%). The task text prescribed `/q/*` "for emission"; that would have served one quantity
    under the other's name, at an error no reader could see.
  - **🔴 Checking supply against the halving formula is a tautology** (§3.2). It matched bit-exactly
    at both probed heights and will keep matching while the vendor computes it the same way. The
    only independently refutable value is the block **height**, so the cross-check compares heights
    against a second unrelated vendor and lets the deterministic formula carry that into supply.
  - **The delta is counted in blocks of subsidy, never in percent** (§5.1.5). One block is
    0.000016%; a full day of vendor staleness is 0.0023%. On any percentage scale a human would
    choose, a real failure and a rounding error look identical.

  Also: `mempool.space` was deliberately NOT adopted as an adapter — a source the engine answers
  from cannot be the independent check on that answer, and its wider surface has no consumer. The
  index's own counts were corrected in the same pass (ten adapters → twelve, eleven tools →
  thirteen): TASK-008 had updated §3.2 but not the index or §5.

- 2026-07-27, **v4.4** — TASK-007 `defillama-dex-volumes`: the free DEX-volume tier (research track
  A-1). Three design decisions, each forced by a live keyless probe run the same day rather than by
  the research write-up:

  - **Coverage for `dex.volume.history` is a generated vendor list, not `vendors.defillama`**
    (§4.2.3). That column came from the vendor's TVL catalog and is non-null for all 458 registry
    chains; the DEX-volume dataset covers 287, of which 274 are ours. The naive predicate would have
    advertised the capability on 184 chains that have no such data — TASK-006's H-1 defect class,
    repeated verbatim. `DEFILLAMA_DEX_CHAINS` is generated from recorded raw evidence and committed,
    on the same doctrine as `gen-nansen-coverage.ts`.
  - **`normalize()` verifies the response's `chain` echo** (§3.2). The endpoint is name-tolerant, an
    unknown chain answers HTTP **500** rather than 404, and a chain outside the vendor's active set
    answers HTTP **200 with zeros and a narrower key set**. Without the echo check, "served a
    different chain" and "this chain has no volume" are indistinguishable.
  - **The response-size cap became real** (§7.3). `api.llama.fi` sends **no `Content-Length`**, and
    the old cap returned early in exactly that case — inert on the host the engine was about to send
    more traffic to. `safeFetch` now counts bytes off the stream and cancels the reader on overflow,
    closing item (1) of the R-47 carry-over. This is a deliberate scope extension beyond the A-1
    task text, recorded as such: without it the DoD's "large document is truncated" test would have
    asserted nothing.

  Also: `defillama`'s `rateLimit` was raised from the M1 placeholder (`capacity 5 / refillPerSec 1`)
  — our own brake, not the vendor's, and measured at 40/40 concurrent origin requests with zero 429s.

- 2026-07-27, **v4.3** — editorial pass over the whole document: index plus all ten section files
  translated to English and finalized. No design decision was changed; what changed is that the
  document now states the system rather than narrating how it got there.

  - **Removed:** review-cycle bookkeeping (`F-1`…`F-3`, cycle/finding numbers, "review found and
    fixed"), draft archaeology ("was … became", "the first version of this section"), prediction
    bookkeeping, and instructions addressed to pipeline roles. Every rule those notes produced
    survives as a rule, stated with the failure it prevents.
  - **Statuses finalized:** TASK-006 is delivered, not "the current task"; nothing is pending the
    Planning phase. `open-questions.md` was split into **Open** (DAPI gRPC transport, a second
    Solana RPC, the `dashpay/platform` licence, ERC-20/SPL balances, opportunistic hardening, OQ-6,
    OQ-M3-1, the wider-Nansen-scope candidate) and **Resolved** (M1, M2 OQ-1…OQ-5, TASK-006
    OQ-1…OQ-5), each kept with the reason that closed it.
  - **Facts corrected against the code:** our registry is **458** chains, not the vendors' 461;
    ten adapters and ten tools where the text still said nine and four/five; `tools/list` returns
    10; the optional env surface is 11 keys, not 4; the monorepo tree now matches the repository.
  - **`ChainSchema` documented as implemented:** the canonical value is the **slug**, not CAIP-2
    (R-59d forbids changing response shapes), and `ChainInputSchema` validates without transforming
    because a zod transform has no JSON Schema representation and breaks `tools/list`.
    Canonicalization happens in the handler, still before `deriveArgsHash`.
  - **Structure:** the mis-numbered `#### 4.1` inside chapter 3 became **§3.2.1**; §7.2.1's "three
    hard rules" now matches its five items; §7.4 gained a number; the broken
    `architectures/system-architecture.md` link inside `reliability.md` was fixed. The M0 appendix
    was dropped — it carried only pointers, which this changelog and `git log` already provide.

- 2026-07-27, **v4.2** — two adversarial review cycles over TASK-006, plus closure of the
  known-issues register. Test suite **687 → 796** (core 617 + mcp-server 179), offline run green,
  zero live credits spent. Review found and fixed 1 Critical, 6 High and ~30 others — reports
  [cycle 5](../reviews/task-006-vdd-multi.md),
  [cycle 6](../reviews/task-006-vdd-multi-cycle6.md). The through-line of both cycles: the task
  widened what the engine PROMISES without widening, in several places, what it can DO.

  - **Critical (C-1).** Nansen's paid routes opened on 7 chains of the `other` family, where
    `isValidAddress` accepts any string: a junk `tokenAddress` reserved credits (every string is
    its own `argsHash`, so the cache is no defence), and two case variants of one address were two
    paid records. The trigger had been named in `address.ts` in advance (OQ-1) and fired exactly
    there. **OQ-1 revised:** paid capabilities now refuse on a family with no validator. The price
    is named — `entity.labels` 25→18, `token.risk` 24→18, `smart-money.flows` 17→16.
  - **High.**
    - Nansen coverage over-promised what the transport could do (17/25/25 against two hardcoded
      chains); the transport was widened to the registry and refusal became a permanent error
      class.
    - `rpc-solana` never received the fix its twin `rpc-evm` got: it declared coverage from the
      registry, sent every request to one hardcoded endpoint, and labelled everything `SOL`/9.
    - `entity.labels` compared the vendor's echo against our slug and, on ~20 chains, silently
      dropped every token row from an already-paid response (a cycle-5 regression).
    - `rpc-evm` signed every EVM balance as `ETH`/18.
    - `.max(64)` does not short-circuit `superRefine` in zod 4 (measured: 416 ms on 20,000
      characters).
    - The 458-row registry was rebuilt on every tool call (×5500 overhead).
  - **Data.** `nativeSymbol` is the gas token, not the listing token (63 rows corrected); new
    `nativeDecimals` column; EIP-155 testnet rows excluded from the join — `hyperliquid-l1` had
    been taking its symbol, the alias `twan` and an RPC candidate from Wanchain Testnet.
  - **Closed** — every remaining register entry, each with a mechanism. **SEC-1:** a velocity
    brake (credits per 60 s window, checked in the same transaction as the daily reservation, state
    in `usage_window` next to the ledger). **Q-3:** a second denominator that counts CALLS — the
    only bound able to see a call priced at 0 credits (column `calls_made`, the repository's first
    additive column migration, via `PRAGMA table_info` + `ALTER TABLE`). **RF-2:** a provenance
    manifest `docs/provenance.json` plus a verifier and a pre-commit hook, replacing a handwritten
    `shasum` that broke structurally — you cannot test that a human remembered.
  - **Declared limits.** The window is fixed, not sliding (2× at the boundary); git hooks are
    local, so a bypass makes the skip loud rather than impossible; price drift is still caught only
    after the fact, in `reconcile()`.
  - **Deviations.** Both cycles' fixes landed as ONE commit: they touched the same lines across 17
    files, and `registry.data.json` was regenerated twice and exists in a single state. Splitting
    them afterwards would have meant reconstructing from memory a tree that never existed.

- 2026-07-26, **v4.1** — TASK-006 IMPLEMENTED (tasks 006-1…006-10). Test suite **687** (core 515 +
  mcp-server 172); the offline run with `fetch`/`http(s)` blocked is green.

  - **Coverage after the task.** Registry **458** chains; `chain.tvl`/`protocol.tvl` — 458;
    `token.price`/`token.metadata` — 316; `wallet.balances.native` — 19 (curated `rpcHosts`);
    `smart-money.flows` — 17; `entity.labels` — 25; `token.risk` — 24; `pairs.new` — 3 (observed
    DexScreener chainIds). Paid spend for the whole task — **5 Nansen credits** (budget ≤6).
  - **Deviations from plan and architecture, and why.**
    1. **Cold cache invalidation (OQ-3) did not happen.** The canonical value became the slug, and
       before TASK-006 the tools accepted exactly `ethereum`/`solana`, which are their own slugs —
       so `args_hash` never changed. §4.2.2 and the OQ table updated to match.
    2. **`ChainSchema` carries the slug, not CAIP-2** as §3.2 prescribed: R-59d forbids changing
       the shape of tool responses, and `onchain_get_token` always answered `chain:"ethereum"`.
       CAIP-2 remains the registry's primary key; the "an alias never reaches the cache key"
       requirement is met by canonicalizing in the handler (proven by test: `chain:'eth'` after
       `chain:'ethereum'` is a cache HIT).
    3. **R-58a was satisfied by the spec plus a spot check, not a live sweep.** Nansen's coverage is
       already enumerated per endpoint in the committed OpenAPI; sweeping 25 chains would have
       spent credits for the same conclusion.
    4. **There are 7 "half" chains, not 8.** Eight counts vendor tokens, where `hyperevm` and
       `hyperliquid` are one chain of ours.
  - **Defects found during implementation and fixed.**
    - (a) `deps.data ?? registryData` — `null ?? x` returns `x`, so an explicit `{data:null}` was
      silently replaced by the production registry: a test that believed it ran on synthetic data
      would have gone green on production data.
    - (b) The join key `gecko_id → native_coin_id` is **not unique** — 28 coins share 109 CoinGecko
      platforms (`ethereum` alone has 49 L2s on ETH gas). First-match gave `ethereum→alienx`,
      `bsc→opbnb`, `solana→sonic-svm`, i.e. token requests would have gone to another chain's
      platform. Fixed with a join ladder that puts the exact EVM chainId first; fuzzy merges 73→20.
    - (c) Alias assignment depended on processing order (`iota-evm` claimed `iota` before it became
      a slug) — the loader rejected the snapshot; fixed with a second pass.
    - (d) zod `.transform()` is **not representable in JSON Schema** — the MCP SDK renders schemas
      for `tools/list` and answered `-32603`, so tool DISCOVERY, and with it the whole server,
      broke. The schema now only validates; canonicalization happens in the handler.
    - (e) After `Chain` widened to `string`, the string `'berachain'` missed the legacy map in
      `address.ts` and silently lost EIP-55.
    - (f) While curating `rpcHosts`, `hyperliquid-l1` was rejected: its only live endpoint belongs
      to **Wanchain**, and both chains claim chainId 999 — `eth_chainId` returns the expected value
      and the automatic check passes, but Wanchain would have been serving Hyperliquid balances. An
      illustration of why the column is curated by hand.
  - **Schema saving, measured.** A tool's JSON Schema is 4729 characters (~1182 tokens) with a
    closed enum, against 261 characters (~65 tokens) without — ≈**7819 tokens per model request**
    across seven tools.

- 2026-07-26, **v4.0** — TASK-006 architecture phase (`universal-chain-registry`, R-48…R-60): a
  chain stops being code and becomes data.

  - **Chain Registry** (`src/chain/registry.ts` plus a separate `registry.data.json`, so a data
    diff never mixes with a logic diff): canonical id is CAIP-2, vendor ids are mapping columns,
    and `aliases` include the permanent `ethereum`/`solana` (R-59).
  - The registry is a **build artifact — not a DB table and not a network call at startup**. Three
    hard reasons: the "0 network calls" offline gate (M1/M2), CI determinism, and a security
    surface reviewable through a git diff. The consequence is named directly: registry freshness
    becomes the operator's duty, not the runtime's (this produced OQ-6).
  - The old `z.enum(['ethereum','solana','dash'])` splits into **two** schemas: `ChainSchema`
    (canonical caip2, inside domain types) and `ChainInputSchema` (tool input, resolves aliases).
    One schema cannot serve both ends — an alias would leak into the canonical object and from
    there into the cache key, producing two entries for one request, which on paid routes is a
    money defect.
  - The coverage matrix (`src/chain/coverage.ts`) is **derived** from `routes × adapter.chainSupport()`,
    where `chainSupport` is a predicate over `ChainInfo` rather than a list: a list would have to be
    kept in sync with the registry, a predicate cannot drift from it.
  - A separate `CapabilityNotCoveredOnChainError` is introduced, deliberately NOT merged with the
    existing `CapabilityUnavailableError` (R-24): merging would send an agent into an endless retry
    where repeating is pointless.
  - Gate order is fixed so the coverage check sits **above** credit reservation — otherwise growing
    the chain count from 2 to 461 would itself become a way to spend money (this removes part of the
    SEC-1 surface without replacing the velocity guard).
  - Address validation branches on `family`, not on chain name: the contents of the `evm`/`svm`
    branches do not change by a single line, their reach does (one branch for 270+ EVM chains). A
    family with no validator means acceptance without canonicalization, not refusal of service —
    with the price stated: cache splitting by address case, not loss of correctness.
  - Two new free tools: `onchain_list_chains` (discovery, zero network calls, mandatory `limit` +
    `total` — otherwise a tool built to save 8.7k schema tokens would spend more on its first call)
    and `onchain_chain_tvl` (separate from `onchain_protocol_tvl`: a chain is not a protocol, a
    different source and a different contract).
  - **The only non-trivial security risk of the task — §7.2.1:** multichain RPC needs a host per
    chain, and `chainid.network` serves `rpc[]` for 2660 chains. Any path in which network data
    influences the SSRF allowlist is forbidden; `rpcHosts` stays a curated column — the one registry
    field where autofill is banned — and a chain without `rpcHosts` is honestly uncovered rather
    than failing at runtime.
  - Live probing on 2026-07-26
    ([evidence](../onchain-analytics/raw/chain-registry-probe-2026-07-26.json)) established the fact
    that determined the whole design: **there is no shared chain vocabulary between vendors**
    (DeFiLlama 461 ≠ CoinGecko 461; the intersection on the explicit key `gecko_id`→`native_coin_id`
    is 235, on normalized names 255) — which is why fuzzy merges must land in a separate section of
    the diff report and be confirmed by a human.
  - No providers added, no DDL changed; the only migration event is a one-off cold cache
    invalidation from the change of `args_hash` contents (OQ-3). Implementation is the
    Planning/Development phases; test suite still **492** (unchanged).

- 2026-07-23, **v3.0** — TASK-005 architecture phase (`m2-alpha-paid`, R-29…R-47): the first paid
  slice.

  - A tenth adapter, `nansen` — the first paid one (`apiKey` header, POST JSON bodies, host
    `api.nansen.ai`); three new capabilities (`smart-money.flows`/`entity.labels`/`token.risk`, no
    free fallback); three new MCP tools (`onchain_smart_money_flows`/`onchain_entity_label`/
    `onchain_token_risk`); three new canonical zod types
    (`SmartMoneyFlow`/`EntityLabel`/`TokenRiskScore`, a D5 extension).
  - A `usage` table (portable types, epoch-ms day bucket, FK to `providers`, additive upsert) plus a
    `BudgetStore` repository — the same pattern as `CacheStore`.
  - The pre-call budget gate is implemented as a private layer of the `nansen` adapter's own
    `fetch()` — not an edit to `CapabilityRegistry.resolve()` and not a separate wrapper object, so
    it is structurally unbypassable. Atomic check+reserve through `db.transaction()` (the same
    device as `throttle()`), post-call signed-delta reconciliation, an `/account` resync on cold
    start or when unreconciled (transport failure OR 402), and singleflight coalescing at the
    outermost layer of `fetch()`.
  - The `costOf()` table is generated by a dev script from `x-credit-cost` in the committed
    `nansen-openapi-2026-07-23.json` into a committed `.ts` module; an unknown `(method, path)`
    yields `Infinity` — fail-closed, never `0`.
  - **OQ-1…OQ-5 resolutions:** the ceiling is the `credits_remaining` pinned at resync (never
    re-read live — double counting is forbidden) plus an optional `NANSEN_DAILY_CREDIT_CAP`; the
    gate lives inside the adapter, not in the Registry or the handler; chain scope is
    `ethereum` + `solana`, the same subset as M1; `entity.labels` escalation stays explicit opt-in
    on any plan; the self-imposed cap is introduced (optional).
  - M1 (4 tools, 9 adapters, 287 tests) is untouched — not one edit in
    `registry.ts`/`resolve-capability.ts`, the tool files, or the adapters. Existing code is touched
    only additively, in 6 files (`cache/sqlite-store.ts` `PAID_PROVIDER_IDS`, `cache/ddl.ts` usage
    table, `providers.config.ts`, `mcp-server/src/env.ts`, `.env.example`,
    `scripts/record-fixture.mjs` — the full list and the justification for each are in
    system-architecture.md §3.2).
  - Review found, and the architecture fixed, 2 critical defects in the first draft. **C-1:**
    reconciliation of composite capabilities (`smart-money.flows`/`token.risk`, 2 sub-calls each)
    was written per response and zeroed itself out (`(5-10)+(5-10)=0` instead of the 10 actually
    spent) — corrected to "exactly one reconciliation per `fetch()`, summed over all sub-responses;
    any unparseable header ⇒ delta=0 entirely, never partially". **C-2:** the bucket was recomputed
    from `Date.now()` at reconciliation instead of being pinned at reservation, so a cross-midnight
    response wrote a negative delta into someone else's day bucket — corrected to "`dayBucketMs` is
    pinned once on entry to the gate and passed down the whole call chain". Plus M-1 (the
    `BudgetStore` interface is now explicit, with the ceiling deliberately NOT in it — a documented
    deviation from the literal R-35, see §3.2), M-2 (`SqliteBudgetStore` upserts `providers` itself
    rather than relying on `SqliteCacheStore`'s bootstrap), and M-3 (the cross-process contract:
    `BEGIN IMMEDIATE` plus an explicit `timeout`, not the `DEFERRED` default).
  - Implementation is the Planning/Development phases; test suite still **287** (unchanged).

- 2026-07-23, **v2.2.1** — CoinGecko Pro contour fix: any key was previously sent as the
  `x-cg-demo-api-key` header to `api.coingecko.com`, so a Pro key effectively did not work (the pro
  host ignores the demo header — confirmed by a live probe of both hosts). An explicit
  `COINGECKO_PRO_API_KEY` is introduced (→ `pro-api.coingecko.com` + `x-cg-pro-api-key`; Pro wins
  when both keys are set; key formats are identical across tiers, so the contour is declared by a
  variable rather than sniffed) — adapter `coingecko`, `EnvSchema`, `.env.example`, +3 contour
  tests. Test suite — **287** (212 core + 75 mcp-server). Same date: the document's Index-Mode split
  (skill `architecture-format-core`) — sections 2–7 and 10–11 moved to `docs/architectures/`, the
  changelog into this file.

- 2026-07-23, **v2.2** — synchronization with the actual code after adversarial cycles 1–3 (14+8+1
  findings, commits 8d3ea79/066cce6/8a602cc) and a polish round (61f3ab2, 6 fixes + RF-1):
  `CapabilityRegistry.resolve()` — a cache failure is now **best-effort** and never produces
  `CapabilityUnavailableError`; `safeFetch` — timeout (`AbortSignal.timeout`, 15 s), Content-Length
  cap 10 MB, https check on the original URL **and** on redirects, `Authorization`/api-key headers
  stripped on a cross-host redirect; rate limiter — a concurrency-safe synchronous token bucket
  (negative backlog, no promise chains) plus a typed reject on `refillPerSec<=0` and a 30 s fairness
  cap (with a token refund); `pg-history` client — `pool.on('error')`,
  `connectionTimeoutMillis=10000`/`max=3`, sanitization of **all** failure paths including the
  `Pool` constructor; `onchain_get_token` — capability `token.metadata` → `token.price` (TTL 60 s,
  not 3600 s); `address`/`protocolSlug` — explicit `.max()` bounds; `onchain_new_pairs`
  materializes the default `limit` before the cache key; adapters hardened (rpc-evm hex regex,
  rpc-solana safe-integer lamports, dexscreener skip-and-log, defillama finite/non-negative tvl, a
  shared `stringify-truncated.ts`); cache DB — prepared statements, sweep every 50 writes,
  leak-safe constructor, honest `ageMs` on LRU promotion; the stale `isError` wording corrected (SDK
  1.29 intercepts any throw from a handler, not only zod validation). Test suite — **284** (209 core
  - 75 mcp-server).

- 2026-07-22, **v2.1** — adversarial review cycle 1 (CHANGES_REQUESTED → fixed): F-1 split the E2E
  suite into spawn and in-process; F-2 registered the `pg-history` adapter (plus history routing
  through `platform-explorer`); F-3 narrowed `dash-platform` to an interface + fixture contract in
  M1 (live gRPC transport is a separate backlog task, `@grpc/*` removed from M1 dependencies). Plus
  majors (dexscreener `pool.info`, `onchain_wallet_balances` chain enum narrowed) and minors
  (canonical key order in `deriveArgsHash`, an explicit decision on Dune R-8, the
  `Snapshot` camelCase↔snake_case note, the §2.2 diagram corrected).

- v2 — M1 read layer (TASK-003): canonical types, Adapter/Capability Registry, nine adapters, the
  two-level cache, 4 MCP tools.

- v1.1 (M0 sync) is kept as history below wherever it has not been revised.
