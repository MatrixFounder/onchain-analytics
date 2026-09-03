> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md) → [system-architecture.md](system-architecture.md).
> Heading levels are the parent document's, unchanged: the section numbers are how
> every other document addresses this text.

#### 3.2.1. Address/chain normalization (`src/chain/address.ts`)

- **EVM:** the canonical form is the **EIP-55 checksum**, not lowercase (ADR-001 D5 requires the
  checksum). Algorithm: `keccak256` of the lowercase hex address (without `0x`, as ASCII bytes);
  for each hex character of the source lowercase address, upper-case it if the corresponding nibble
  of the hash is ≥ 8, lower-case it otherwise. This is a **pure function of the address bytes**: any
  input casing yields the **same** checksum result, so cache keys and storage are deterministic
  automatically and no separate "lowercase for keys" form is needed.
- **Solana:** the canonical form is **as-is** (base58 is case-sensitive: lowercasing would corrupt
  the address, unlike hex). Validation: base58 decoding succeeds **and** the decoded length is
  **exactly 32** bytes (a Solana address is a raw ed25519 pubkey, with no version/checksum bytes,
  unlike Bitcoin base58check).
- **Dash:** present in the registry vocabulary for consistency with `assets.chain_family` from
  DB-SCHEMA, but the `Wallet`/`Balance` types are not used for it — dash-platform returns
  `Snapshot`, not `Balance` (§2.1).
- **One point of use:** both the MCP tool input schemas (`superRefine` calls
  `isValidAddress(chain, address)`) and the adapters (`normalizeAddress` before `fetch` / before
  building the cache key) go through this single module; nothing is duplicated.

**Branching is by `family`, not by chain name (R-55).** `switch (chainInfo.family)` replaced
`switch (chain)` over the `'ethereum' | 'solana' | 'dash'` literals. The bodies of the `evm`/`svm`
branches did not change by a single line — the same EIP-55 and base58+32 bytes, the same tests
(R-55d). Only the reach changed: one `evm` branch now serves all 270+ EVM chains instead of one.

| `family`                             | Validation                            | Canonicalization        |
| ------------------------------------ | ------------------------------------- | ----------------------- |
| `evm`                                | 40 hex characters (with/without `0x`) | EIP-55 checksum         |
| `svm`                                | base58 decodes to exactly 32 bytes    | as-is                   |
| `move` / `cosmos` / `utxo` / `other` | **no validator** — accepted as-is     | **no canonicalization** |

**A missing validator is not a refusal of service on free routes (R-55c).** For a family with no
validator the address is accepted and passed to the vendor as-is; "address not found" from the
vendor is a normal answer, not a bug of ours. The opposite behaviour would mean we do not support a
chain until we write an address parser for it — exactly the "chain = code" coupling the registry
removes.

**On paid routes it is a refusal (OQ-1, revised 2026-07-27).** A paid call on a family with no
validator spends credits on a string we never checked, and a vendor's "not found" is then
indistinguishable from our own garbage input. Paid capabilities therefore refuse on any family
other than `evm`/`svm`; writing a validator for a family is the prerequisite for paid coverage
there, not an optimization.

**The price of no canonicalization, stated explicitly:** the cache key is built from the source
string, so the same address written in different casing produces **two** cache entries. That is a
loss of cache efficiency, **not** of correctness (the answers are identical).

**Module: `src/adapters/*`** (D2/D3/D4/D8/D9, R-3, R-5…R-11)

**SHIPPED (T-012, commit `6af4b19`, 2026-08-05).** Everything from here through "Architectural
obligation" at the end of this subsection describes the design **as it is in code**, not a target.
`packages/core/src/adapters/types.ts` carries the post-T-012 shapes: a serialisable
`policy?: PolicyDescriptor` in place of a literal `isSatisfying` (`packages/core/src/adapters/types.ts:333-416`, `tier === undefined ? 'no adapter registration found for this`, class
dictionary in `adapters/policy.ts`), mandatory `tier`/`trust` on every registration
(`types.ts:93,106,137,148`), and the optional `deadlineAtMs` parameter on `fetch()` (`packages/core/src/adapters/types.ts:52`, `fetch(cap: string, args: Record<string, unknown>,`).
Two owner decisions dated 2026-08-03 (OD-3, OD-4) are folded in below, replacing an earlier draft
of this section that an architecture review (same date) found to misdescribe both.

> **Superseded banner, kept rather than deleted.** Until 2026-08-05 this paragraph read "**PLANNED
> (T-012, not in code as of 2026-08-03)** … `types.ts` still has the pre-T-012 shapes … as of this
> writing". It was not updated when T-012 landed, so a PLANNED banner sat over sub-sections already
> marked LANDED (`ttlFor()`) and SHIPPED (adapter uptake) **inside its own declared scope**. That is
> the documentation-drift class WI-24/WI-28 exist to catch, in the one place no gate reads. Nine
> further `PLANNED (T-012)` status markers inside this subsection's declared scope were corrected in
> the same pass (lines 393/439/492/641/665/805 of the pre-edit file), together with a seventh on the
> `deadlineMs`/`paidLegMs` table, which lives in `Module: src/cache/*` rather than here. One further
> `PLANNED` remains below by design — the word inside the H1 narrative, which is prose about the
> state before the fix and is now introduced as such. A status marker is a claim about running code,
> so each now names the task that landed it.
>
> **Scope of the commit named above.** `6af4b19` is T-012 itself. The WI-34/WI-35/WI-36/WI-37
> follow-up described further down (the applied `pg-history` limiter, the query bounds, 10-of-12
> adapters reading the deadline) landed later on 2026-08-05 and is NOT in that commit. A reader who
> checks `6af4b19` alone finds 2 of 12 adapters and 4 of 20 capabilities.

```ts
export interface CapabilityDescriptor {
  id: string; // 'token.price' | 'wallet.balances.native' | 'pairs.active' | ...
  chains?: Chain[]; // absent = the capability is not bound to a specific chain
}

export interface ProviderAdapter {
  id: string; // D4: an explicit id field
  capabilities(): CapabilityDescriptor[];
  costOf(cap: string, args: Record<string, unknown>): { credits: number };
  // D4/R-140: `deadlineAtMs` is OPTIONAL and ADDITIVE — an absolute epoch-ms moment, never a
  // duration (D4 п.3). An adapter that never reads it degrades exactly to today's per-hop-timeout
  // behaviour, not a compile error or a runtime throw. OD-3/OD-4 (2026-08-03): it bounds ONLY the
  // phase before a paid reservation commits — see "Call deadline" below for the exact boundary and
  // why nothing after that point, in ANY paid adapter's own implementation, ever receives it.
  fetch(cap: string, args: Record<string, unknown>, deadlineAtMs?: number): Promise<unknown>;
  normalize(cap: string, raw: unknown): unknown; // narrowed by the adapter internally
  isAvailable?(): { ok: true } | { ok: false; reason: string }; // env/key readiness, R-24

  // "Can I serve this chain FOR THIS CAPABILITY" — a PREDICATE over ChainInfo, not a list
  // (R-51a/R-54c). A list would have to be kept in sync with the registry; a predicate cannot drift
  // from it. The second parameter is load-bearing: coverage is a property of the PAIR, not of the
  // adapter — `nansen` serves different chain sets per capability (17/25/25), and `defillama`
  // covers `dex.volume.history` on a narrower set than `chain.tvl`.
  // Absent ⇒ the adapter is not chain-bound (see CapabilityDescriptor.chains).
  chainSupport?(chain: ChainInfo, capability: string): boolean;
}

/**
 * D8/D9 — two classifications ADDED to the registration, both MANDATORY in the literal
 * `providers.config.ts` array (a missing value is a compiler error there — the same "obligatory
 * field" discipline D3 already applies to the manifest below).
 */
export interface AdapterRegistration {
  id: string;
  hosts: string[];
  rateLimit: TokenBucketConfig;
  requiresEnv: string[];
  tier: 'free' | 'paid'; // D8
  trust: 'authoritative' | 'derived' | 'community'; // D9, DECLARE-ONLY in T-012 — see below
}
```

**Provider tier — one classification, four readers (D8, R-150/R-151/R-152). LANDED (T-012, tasks
012-2/012-3).** The "Old classification / Where" column below is the **historical** pre-T-012 map.
Those line references describe the tree before commit `6af4b19` and no longer resolve
(the `PAID_PROVIDER_IDS` identifier is gone from `src/`; historical notes remain in
`cache/sqlite-store.ts`, `cache/budget-store.ts` and `adapters/types.ts`).
The "Becomes" column is what the tree does today — `types.ts:93,137`, `cache/budget-store.ts` writing
`kind: registration.tier`, and `mcp-server/src/tools/budget-meta.ts` reading `r.tier === 'paid'`.
`tier` replaced four places that used to classify "is this provider paid" independently, none of
which could detect the others disagreeing:

| Old classification                                           | Where                                                                                                              | Becomes                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `PAID_PROVIDER_IDS = new Set(['dune','nansen'])`             | `packages/core/src/cache/sqlite-store.ts:48`, `* the connection opens (PRAGMA/DDL exec, providers bootstrap,`      | reads `registration.tier`                                                             |
| bootstrap writes `kind: 'unknown'` to every provider row     | `packages/core/src/cache/budget-store.ts:263-272`, `if (!existing.has(column.name)) this.db.exec(column.ddl);`     | writes `registration.tier`                                                            |
| `BudgetMeta.provider: 'nansen'` — a hand-picked literal type | `packages/mcp-server/src/tools/budget-meta.ts:9`, `* is the complete set of sources that can have spent anything.` | widens to plain `string`, checked at runtime (M6 below) — the WIRE SHAPE is unchanged |
| `costOf() === 0 \| Infinity` read as a de-facto tier signal  | every adapter's `costOf()`                                                                                         | stays the PRICE mechanism only; nothing reads it as a tier any more                   |

Assignment (`providers.config.ts`'s 12 registrations, measured): **`paid`** — `dune`, `nansen`.
**`free`** — the other ten (`coingecko`, `dexscreener`, `defillama`, `blockscout`, `rpc-evm`,
`rpc-solana`, `dash-platform`, `platform-explorer`, `pg-history`, `blockchain-info`). `tier` is a
property of the VENDOR RELATIONSHIP — static — and is deliberately never derived from `costOf()`.
`costOf()` varies with arguments and the live account plan (`nansen`'s real price table vs.
`blockchain-info`'s `0`/`Infinity` toggle, ADR-002 D8). **It never reaches a tool response**: the
client pays our price (ADR-003 D4), and our own spend at a vendor is our unit economics, not the
client's contract. `_meta.budget`'s `{provider, creditsUsedToday}` shape (interfaces.md §5.1.2) is
UNCHANGED by this — `tier` is not added to it.

**L5 — obligation for Development. DISCHARGED (T-012, task 012-2).** `providers.config.ts`'s own
docstring used to read "**10 entries** … every one now backed by a real adapter". That wording was
stale since TASK-008/TASK-009 raised the count to twelve, and untouched by the architecture pass
that recorded this (docs-only; that line is source code). It was corrected in the same commit that
added `tier`/`trust` to all twelve registrations, exactly as this note asked. Kept rather than
deleted: the obligation is the reason the correction happened, and a discharged obligation with no
record reads as one that was never raised.

**M6 — `BudgetMeta.provider` widens to `string` with a runtime check, not a `tier`-derived
literal union; picked and justified, not left ambiguous.** `adapterRegistrations` is exported as a
plain mutable `AdapterRegistration[]` (`providers.config.ts`). TypeScript widens an array
literal's element type to the ANNOTATED interface — `id` is `string`, not a literal union of the
twelve ids. No mapped type reading `.tier` off that array can therefore narrow `BudgetMeta.provider`
without ALSO re-typing the array itself (`as const satisfies readonly AdapterRegistration[]`, or
similar). That re-typing has a blast radius this task does not take on.
`SqliteBudgetStoreOptions.providers?: AdapterRegistration[]` and its sibling on `SqliteCacheStore`
both expect a plain mutable array. Every consumer that iterates or mutates it generically would
need its own accommodation. So: `BudgetMeta.provider: string` (documented as "the paid-tier adapter
id that actually answered"), with a runtime assertion at the one place it is constructed
(`budgetMeta()`, `mcp-server/src/tools/budget-meta.ts`) that the value is a member of
`adapterRegistrations.filter((r) => r.tier === 'paid').map((r) => r.id)`. This is not a lesser fix.
ADR-002 D8's own text names the CURRENT literal type itself as the defect ("classification leaked
into the type system"), and a derived-but-still-precise literal union would relocate that leak, not
remove it. The wire shape is unaffected: `{provider: string, creditsUsedToday}` serializes
identically to today's `{provider: 'nansen', ...}` for the one value either type can hold right now.

**Source trust — declare-only (D9 slice, R-153/R-154/R-155). LANDED (T-012, task 012-2).** The
field is declared on all twelve registrations and validated at construction
(`assertValidAdapterRegistrations`, `packages/core/src/adapters/types.ts:179-201`, `export function assertValidAdapterRegistrations(registrations:`); "declare-only" still describes its
CONSUMPTION, which is T-016. Assignment, from
ADR-002 D9's own table plus a reasoned analogy (objective vendor/consensus data vs.
third-party-edited content):

| `trust`                         | Adapters                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `authoritative`                 | `nansen`, `coingecko`, `defillama` (named in ADR-002 D9) + others listed below                          |
| `community`                     | `blockscout` (ADR-002 D9) + `pg-history` (OD-5) — see below                                             |
| assigned to no ADAPTER in T-012 | `derived` — applies to individual `pg-history` ROWS (`source='derived'`), never to a whole registration |

**`authoritative` — the full adapter list.** `nansen`, `coingecko`, `defillama` (named in ADR-002
D9) + `dexscreener`, `dune`, `rpc-evm`, `rpc-solana`, `blockchain-info`, `dash-platform` (reasoned
analogy — objective/consensus data nobody edits) + **`platform-explorer`** (owner decision **OD-5**,
2026-08-03). D9's scale asks about the REDACTABILITY of content, not the operator's official status;
machine-aggregated chain counters nobody edits. That closes OQ-T012-2, and the stake is real: this
is the source D6 turns merging on for FIRST.

**`community` — the full adapter list.** `blockscout` (ADR-002 D9, verbatim: "everything it returns
is edited by outsiders") + **`pg-history`** (owner decision **OD-5**, 2026-08-03). `pg-history` is
deliberately the LOWEST rank as a conservative PLACEHOLDER until the real per-ROW rank from `source`
arrives in T-016. That closes OQ-T012-3. The code comment must say "placeholder with a scheduled
replacement", not leave it readable as a judgement about our own ledger.

**Zero consumer logic (R-155).** No `set`-merge segmentation by rank, no community-marking in
model context, no `source → trust` autofill script exist yet — all three are ADR-002 D9's "full
inclusion", scheduled for T-016 alongside the `entity.labels` merge itself (D6). The ONLY reader in
the whole codebase is a construction-time check that every registration set `trust` (R-154) — see
"where this check actually runs" under Capability Registry below, since `AdapterRegistration` never
reaches `CapabilityRegistry` itself.

**L1 — the complete YAGNI ledger for T-012, not a sample of it (M-1 correction, architecture
review round 2, 2026-08-03: FIVE fields, not four).** Five fields this task introduces have NO
RUNTIME consumer inside T-012. Each is justified ONLY by a dated, accepted future decision that will
consume it, not by "just in case":

- `trust` (T-016, ADR-002 D9, owner 2026-08-01);
- `shareable` (T-014, ADR-003 D5);
- `shape` (T-013, D5 — no merge rule exists yet to key on it);
- `requestedDeadlineAtMs` (`resolve()`'s fourth parameter, below). T-012 has exactly one caller, the
  engine itself, and passes nothing; T-014's networked client is the first real caller.
- `paidLegMs` (OD-3, owner 2026-08-03). Nothing at runtime reads it. Its ONLY reader is the extended
  WI-28 doc gate, "`ttlFor()` becomes a READER" above, which checks the manifest's `paidLegMs`
  against the documented per-capability derivation table. That is the identical test-time-only
  status `shape` already holds in this same list, not a weaker one.

This is the full list; a sixth unconsumed field found later is a defect, not an omission from this
sentence.

**Adapters hold no private vendor chain maps (R-54).** Each of these was a private copy of chain
knowledge, with its own `SupportedChain` type duplicating the `chains:` literals of
`providers.config.ts`:

| Adapter       | Removed                                                                         | Replaced by                                                                           |
| ------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `defillama`   | `type SupportedChain`, `CHAIN_TVL_KEY = {ethereum:'Ethereum', solana:'Solana'}` | `chain.vendors.defillama`                                                             |
| `dexscreener` | `type SupportedChain`, `NATIVE_QUERY = {ethereum:'ETH', solana:'SOL'}`          | `chain.nativeSymbol` (R-57a) + `chain.vendors.dexscreener` for the client-side filter |
| `nansen`      | `type NansenChain = 'ethereum' \| 'solana'`                                     | `chain.vendors.nansen` + `CoverageProbe` (§4.2.3)                                     |
| `coingecko`   | inline check `chain !== 'ethereum' && chain !== 'solana'`                       | `chain.vendors.coingecko` (platform id straight into the URL)                         |
| `rpc-evm`     | check `chain !== 'ethereum'` + hosts from `adapterRegistrations`                | `chain.family === 'evm'` + `chain.rpcHosts` (§7.2)                                    |

**The anti-corruption layer (D4) is not weakened by this.** The registry hands the adapter a vendor
**key** — a short identifier string — and nothing else. Vendor DTOs still never leak outward,
`normalize()` remains the single narrowing point (R-54d), and the dependency direction does not
invert: the adapter reads the registry, the registry knows nothing about adapters.

**Nor was it weakened by D2/D3/D4/D8/D9 (T-012, shipped).** `fetch()` still returns
`unknown`, and only `normalize()`'s output ever escapes an adapter. A policy descriptor, a
manifest, a deadline, a `tier`, a `trust` are all metadata ABOUT routing and accounting, never a
shape the vendor's DTO is allowed to influence. ADR-002 explicitly rejects the nearest miss
(configurable field-mapping instead of `normalize()`, §Что отклонено п.7) on exactly this ground.

**Capability Registry** (`src/adapters/registry.ts`) routes on `(capability, chain)`. LANDED
(T-012, tasks 012-1/012-4/012-6/012-8):

```ts
export interface CapabilityRoute {
  capability: string;
  adapterIds: string[]; // order = priority + fallback chain (R-11), unchanged

  // D2 — was `isSatisfying?: (result: unknown) => boolean`. Same cross-provider "is this answer
  // enough, or should the walk continue" question (TASK-008, H-1), now a SERIALISABLE value
  // resolved against a class registry in core (below) instead of a literal function. Omitted ⇒
  // `{ kind: 'any' }`. Applied to cache hits too, unchanged (H-1 — otherwise shadowing returns
  // through the cache).
  policy?: PolicyDescriptor;

  // DESIGNED (T-013, OQ-T013-2) — a SECOND, route-level activation gate, on top of the manifest's
  // `mergeable` eligibility (R-159). Name is illustrative (Development's call, same discretion
  // R-159(a) gives the manifest field); the TYPE-LEVEL requirement is fixed here: a boolean (or
  // boolean-shaped descriptor), checked at construction against `capabilityManifests[capability]`
  // (see "Merge mechanism" below for the full reasoning and the constructor validation it adds).
  merge?: boolean;
}

export class CapabilityRegistry {
  constructor(
    routes: CapabilityRoute[],
    adapters: Map<string, ProviderAdapter>,
    cache?: CacheStore,
    chains?: ChainRegistry | null,
    // C2 (architecture review 2026-08-03): INJECTED and DEFAULTED to the real committed table —
    // the identical seam `chains` already uses one parameter to the left (`this.chains ??
    // loadChainRegistry()`). A test route table with a synthetic capability — measured: only
    // `coverage.test.ts`'s `legacy.thing`, at the TWO `new CapabilityRegistry(...)` calls `:86` and
    // `:171` — supplies its OWN small manifest map here instead of inheriting the real 20-row one,
    // so adding a manifest-completeness check does NOT turn every pre-existing fixture route red,
    // which a bare module-level import would have. (`ghost` at `coverage.test.ts:255` and `x` at
    // `:127`/`:139` are NOT affected and must not be cited here: the first is an argument to
    // `createCoverage({routes})`, the second a string handed to a `CapabilityNotCoveredOnChainError`
    // constructor — neither passes through registry validation. See `reliability.md`.)
    manifests: Readonly<Record<string, CapabilityManifest>> = capabilityManifests,
  );
  // R-135/R-138: at CONSTRUCTION (this constructor body, not lazily inside `resolve()`), for EACH
  // route, in a FIXED, STATED order:
  //   1. `manifests[route.capability]` must exist → else `MissingCapabilityManifestError(capability)`.
  //   2. ONLY once (1) passes: if `route.policy` is set, its `kind` must resolve in the policy
  //      class dictionary → else `UnregisteredPolicyClassError(capability, kind)`.
  //   3. DESIGNED (T-013, R-183) — ONLY once (1) passes: if `route.merge` is `true`, the manifest
  //      row found in step 1 must carry `mergeable: true` on its `set | series` arm → else a new
  //      construction-time error naming the capability and the missing eligibility (UC-20). Placed
  //      after step 1 (it reads the SAME manifest row) and independent of step 2 (merge and policy
  //      are orthogonal route properties) — a route wrong on BOTH reports step 2's finding first,
  //      an arbitrary but deterministic tie-break, not a claim that one defect matters more.
  // The order is what makes each requirement's negative test isolate exactly one bad thing (C2): a
  // test exercising ONLY R-135's bad-`kind` path supplies a `manifests` map covering its own
  // synthetic capability (so step 1 passes silently) and sets an invalid `policy.kind` (so step 2
  // is what fires); a test exercising ONLY R-138's missing-manifest path needs no `policy` at all
  // (step 2 never runs for a route that carries none). `mcp-server/src/index.ts` builds the one
  // real registry at process startup, so a bad `kind` or a missing manifest entry there is a
  // startup failure, never a first-request surprise (the same guarantee `loadChainRegistry()`
  // already gives, §4.2.1).
  //
  // `trust`'s OWN construction-time check (R-154) does NOT live here — `AdapterRegistration` never
  // reaches `CapabilityRegistry` (it flows to `SqliteCacheStore`/`SqliteBudgetStore`'s own
  // `bootstrapProviders()` and nowhere else). The check is a small exported function,
  // `assertValidAdapterRegistrations(registrations)` (home: `src/adapters/types.ts`, beside the
  // interface it validates), taking the array as an explicit PARAMETER — never a module-level
  // import it validates unconditionally — called once by `mcp-server/src/index.ts` right after
  // importing `adapterRegistrations`, before either store or `CapabilityRegistry` is constructed.
  // A test passes its own small, deliberately-incomplete array and observes the throw in
  // isolation, the same seam discipline as steps 1/2 above.

  resolve(
    capability: string,
    chain: Chain,
    args: Record<string, unknown>,
    // D4/R-144: the CALLER's ask. It can only NARROW the manifest's own `deadlineMs`, never widen
    // it. Validated BEFORE use, and — L-1 correction, architecture review round 2, 2026-08-03 — the
    // validation now branches on TWO DIFFERENT failure shapes instead of folding them into one
    // "else absent":
    //   1. Not a safe integer at all (`!Number.isSafeInteger(x)` — NaN, a string, `±Infinity`) is
    //      treated as ABSENT, exactly as before. `Math.min(a, NaN)` is `NaN`, and `NaN <= 0` is
    //      `false` — an unguarded NaN would make every downstream deadline comparison silently
    //      never fire, and the first real caller with any incentive to send a malformed value is
    //      T-014's untrusted paying client, not our own code.
    //   2. IS a safe integer, but `x <= Date.now()` — a PAST timestamp. An earlier draft of this
    //      comment folded this into case 1 ("treated as ABSENT"), which is the wrong direction for
    //      R-144: "absent" falls back to the FULL manifest budget — MORE time than the caller
    //      asked for — and R-144 forbids widening in EITHER direction, including from "the caller
    //      asked for a deadline already in the past" to "the caller asked for nothing in
    //      particular". This case throws an immediate typed refusal instead (a well-formed "I am
    //      already out of time" — the same `DeadlineExceededError`/`CapabilityDeadlineExceededError`
    //      family D4 already uses elsewhere, with `tried: []` since no adapter was ever attempted),
    //      rather than silently falling through to case 1's ABSENT branch. (Clamping to `now()` was
    //      considered and rejected: it would make an already-expired caller deadline behave for one
    //      instant exactly like "no deadline supplied", then re-expire on the very next tick — an
    //      unobservable distinction not worth the special case; an immediate refusal is honest
    //      about what actually happened instead.)
    // `effectiveDeadlineAtMs = min(Date.now() + manifest.deadlineMs, requestedDeadlineAtMs ??
    // Infinity)`, computed ONCE here (after both checks above) and threaded unchanged through every
    // adapter call below (the same "fixed once, passed through" pattern the budget gate's
    // `dayBucketMs` already uses). T-012 has exactly ONE caller (the engine itself) and passes
    // nothing — every call takes the `?? Infinity` branch today; the parameter exists so ADR-003's
    // future networked client (T-014) composes additively, with no change to this signature.
    requestedDeadlineAtMs?: number,
    // `attempted` (adversarial cycle 2, F-4) — the adapter ids whose `fetch()` this traversal
    // actually ENTERED, in walk order, omitted when empty (a pure cache hit entered nobody). It is
    // NOT `source`: the walk can enter a paid adapter and still return an earlier adapter's
    // truthful-but-unsatisfying answer (`unsatisfying ??=`), and `_meta.budget` derived from
    // `source` alone then reported no spend on a call that had just paid. Deliberately un-filtered
    // by tier here — the classification lives on `AdapterRegistration` and is applied by the one
    // consumer that needs it (`mcp-server/src/tools/budget-meta.ts`, interfaces.md §5.1.2).
  ): Promise<{
    result: unknown;
    source: string;
    cache: 'hit' | 'miss';
    ageMs?: number;
    attempted?: string[];
    deadlineOverrunMs?: number; // BUILT, T-012 — unchanged by T-013, listed above the line below
    // ---- everything from here down is DESIGNED (T-013), not built, additive and optional, and
    // present ONLY on a merge-enabled route's walk (R-174d) — the 18 non-merge capabilities see no
    // shape change. See "Merge mechanism" below for `sources`' exact membership rule (contributors,
    // not "answered" — corrected after review; the field docstring above ("`source` is who
    // ANSWERED") describes single-adapter `resolve()`, where answering and contributing are the
    // same adapter by construction, and stops being one fact once a walk can have more than one
    // participant).
    sources?: string[];
    missingSources?: { adapterId: string; reason: string }[];
    perSourceCache?: { adapterId: string; cache: 'hit' | 'miss'; ageMs?: number }[];
  }>;
  // If every adapter on the route is unavailable, throws CapabilityUnavailableError listing
  // (adapterId, reason) — never a silent empty answer (R-24). If the current adapter's
  // fetch/normalize fails, moves on to the next id in adapterIds (R-11 hot-swap) instead of
  // failing the whole call. D4 adds a THIRD distinguishable outcome, CapabilityDeadlineExceededError
  // — see "Call deadline" below and reliability.md §9.1.
  //
  // Cache-fault contract — TWO different contracts. A fetch/normalize error means "this adapter
  // could not answer, try the next one" (recorded in `tried`). A cache.get()/set() error is ALWAYS
  // best-effort, never fatal, never a CapabilityUnavailableError: a get() throw is logged and
  // treated as a miss; a set() throw is logged in its OWN nested try/catch (not in `tried`, does
  // not trigger fallback) and the already-fetched result is still returned as 'miss'.
}
```

**`CapabilityRoute.chains` is GONE (OQ-C, ADR-002 D2).** The field was declared, read by the router
(`packages/core/src/adapters/registry.ts:234-238`, `, which for a negative entry is the wrong`, narrowing `matching` routes), and set by ZERO of the 21 entries in
`providers.config.ts`. That was re-measured 2026-08-03, the same result already recorded at TASK-006
and in ADR-002 itself. T-012 deletes the field together with the filter that read it, per the escape
hatch ADR-002 D2 specifies. If a construction-time audit of all 28 routes ever finds one that
genuinely needs to narrow chains BELOW what `chainSupport()` already expresses, the field returns
with that route named as the consumer. open-questions.md records the closure.

**H-D (HIGH, architecture review round 2, 2026-08-03) — the deletion's test blast radius, stated
explicitly, not left implicit. DISCHARGED (T-012, task 012-1).** The edits below were made and the
suite is green; the line references are to the tree **as it was on 2026-08-03** and no longer
resolve. It is kept in full because it is the worked example of the rule it exists to teach. That
rule: "compiling past a type deletion is not the same as proving the mechanism it replaces is
equivalent". It is what a future field-removal needs, not the line numbers.

The type-level field is one thing; `CapabilityDescriptor.chains`
(a DIFFERENT field, on the adapter's OWN capability descriptor — §"Module: src/adapters/*" above) is
untouched and must not be confused with it. What DOES need editing: route-level `chains` is set by
**13 literals across 9 test files** — `packages/core/test/registry.test.ts:76,91,92,122,287`;
`packages/mcp-server/test/env-degradation.integration.test.ts:35`, `adapterIds: ['pg-history'],`; and one literal each in
`packages/mcp-server/test/tools/{active-pairs.test.ts:11, entity-label.test.ts:17,
protocol-tvl.test.ts:12, get-token.test.ts:18, token-risk.test.ts:15, wallet-balances.test.ts:19,
smart-money-flows.test.ts:22}`. Compiling past the type deletion is not the same as proving the
mechanism it replaces is equivalent. The test at `packages/core/test/registry.test.ts:87-111`, `expect(resolution.result).not.toBe(raw);`, titled "selects
the route whose chains list matches the requested chain…", builds its fakes (`makeAdapter`,
`:16-36`) with **no `chainSupport`** declared at all. Removing the `chains` filter with those fakes
left as-is means BOTH routes contribute adapters unfiltered, `rpc-evm` answers first for every
chain, and `expect(solResult.source).toBe('rpc-solana')` at `:108` **fails at runtime** — not a
compile error, a red test. It is the only test guarding route-selection-by-chain semantics, so it
must be **rewritten**. Its fakes must be given a `chainSupport` matching the route split they
exercise, and it must not be left to recompile unchanged. Otherwise the deletion would be "proven"
by a test that silently stopped testing the thing its own title names. AC-19's "≥1195 green plus
new tests" is met only AFTER these 9-file/13-literal edits, and this rewrite is attributable to
T-012, not a pre-existing failure this task happens to trip over.

**Policy descriptor + class registry (D2, R-133/R-134/R-135) — home: `src/adapters/policy.ts`.
LANDED (T-012, task 012-6).**

```ts
export type PolicyDescriptor =
  | { kind: 'any' } // default — omitting `policy` entirely means this
  | { kind: 'someElementHasAny'; fields: string[] };
```

The class registry is a DICTIONARY OF NAMES, deliberately not a policy engine. `adapters/types.ts`'
own docstring already forbids growing one (weights, partial merges, multi-source collection stay
the router's job). ADR-002 §Что отклонено п.7 rejects the nearest miss (configurable
field-mapping) on the identical ground. Exactly two entries are needed today:

| `kind`              | Predicate                                                       | Replaces                                                     |
| ------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| `any`               | always `true` (today's implicit default)                        | 27 of 28 routes, which carry no policy today                 |
| `someElementHasAny` | array, and ≥ 1 element has a non-empty value at one of `fields` | `entity.labels`'s literal predicate, bit-for-bit — see below |

**`someElementHasAny` — what it replaces.** `entity.labels`'s literal predicate
(`packages/core/src/providers.config.ts:132-142`,
`that nansen exists; the policy belongs here, as data, beside`), bit-for-bit. It is NEVER named or
aliased `nonEmpty` anywhere (H-1: a non-empty array of contentless Blockscout rows must still count
as unsatisfying).

**Resolved at `CapabilityRegistry` CONSTRUCTION, never lazily inside `resolve()` (R-135).** See the
exact validation order specified on the constructor above (manifest presence, then policy `kind`).
The resolved predicate is cached per route. `resolve()`'s existing `satisfies()` wrapper (fail-open
on a throwing policy, `packages/core/src/adapters/registry.ts:345-361`, `attempted?: string[];`, UNCHANGED) calls the cached predicate instead of a
route's own literal function — zero behaviour change on the 21 real routes (R-135d).

**Capability manifest (D3, R-136/R-137/R-138) — home: `src/capability-manifest.ts`. LANDED
(T-012, tasks 012-4/012-5).** A tier-1 config module sibling in spirit to `mcp-server`'s `tool-specs.ts` (T-011,
D7): one declarative, committed literal, replacing a table (`cache/ttl.ts`'s `TTL_SECONDS`). That
table's own comments already record hitting its `DEFAULT_TTL_SECONDS` fallback by accident three
times. The replacement has a shape the compiler enforces instead of a row someone can forget to add.

```ts
type CapabilityManifestBase = {
  ttlSeconds: number;
  // D4 — bounds ONLY the phase before a paid reservation commits (OD-3, owner decision 2026-08-03).
  // For a capability with no `tier: 'paid'` adapter anywhere on its route, this IS the whole worst
  // case. For one that does, it is the FIRST of two numbers — see `paidLegMs` and "Call deadline"
  // below; the two are never collapsed into one.
  deadlineMs: number;
  // ADR-003 D5 (T-014) is the first READER; NONE exists in T-012 — optional for exactly that
  // reason, matching `trust`/`shape` above: making it mandatory would put a ritual `true` on 20
  // capabilities with no consumer.
  shareable?: boolean;
  // OD-3 (2026-08-03): present ONLY on a capability whose route can reach a `tier: 'paid'` adapter.
  // D4 п.2 forbids cancelling a committed reservation, so the tail past that commit is
  // STRUCTURALLY uncancellable — `deadlineMs` cannot bound it, and treating it as if it could would
  // reproduce exactly the "retune nansen's own timeouts" option the owner rejected. Worst case for
  // such a capability is `deadlineMs + paidLegMs`, never `deadlineMs` alone. Derived the same way
  // R-149 already requires: measured sub-call count × each sub-call's existing, UNCHANGED ceiling,
  // with the derivation commented beside the number — the same discipline `cache/ttl.ts`'s rows
  // already follow.
  paidLegMs?: number;
};

// H4 (architecture review 2026-08-03): a FLAT interface discriminates nothing — a future `merge`
// field (D5/T-013) could legally be added to a `point` manifest and the compiler would never
// object. This union is what makes "merge only valid on `set`/`series`" a type error the moment
// T-013 adds the field.
//
// DESIGNED (T-013, R-159/R-160) — the obligation this union's own docstring hands to T-013
// (`packages/core/src/capability-manifest.ts:146-153`, `the obligation the paragraphs below used to describe as future is discharged.`)
// will be discharged once built: the `set | series` arm alone gains the
// merge-eligibility field. `mergeable` is illustrative (name is Development's call, R-159a);
// omitted on `entity.labels` and on every `set`/`series` capability that has no second live
// adapter — eligibility is a fact about the CAPABILITY's identity key (Snapshot's metric/asset/ts,
// D6 reason 1), not a promise that merging is ACTIVE (that is `CapabilityRoute.merge`, above,
// OQ-T013-2). Declaring `mergeable` on the `point` arm is a compile error (TC-UNIT-07's sibling
// negative type-test, R-160) — there is no field to name on `point` at all.
export type CapabilityManifest =
  | (CapabilityManifestBase & { shape: 'point' })
  | (CapabilityManifestBase & { shape: 'set' | 'series'; mergeable?: boolean });

export const capabilityManifests: Readonly<Record<string, CapabilityManifest>>; // one entry per
// routed capability — see the classification table below for what ADR-002 D3 already settles and
// what Development still has to classify (open-questions.md OQ-T012-1).
//
// L-3 (architecture review round 2, 2026-08-03): this map is keyed per CAPABILITY, but its
// derivation input (route composition, "Deadline budget tiers" above) is per ROUTE, and
// `wallet.balances.native` already has TWO routes (`rpc-evm` XOR `rpc-solana`) sharing this one
// entry. Harmless today — both routes happen to be single-free-adapter, so they'd derive the same
// `deadlineMs` even if computed separately — but the 1:1 assumption breaks the first time a
// capability gets two routes of genuinely DIFFERENT paid composition (e.g. one free-only, one
// reaching a paid adapter): the shared manifest entry would then have to describe both, which it
// cannot. Not a T-012 problem to solve — flagged here so the next capability that grows a second,
// differently-shaped route does not silently inherit the wrong number.
```

**No chains, no providers, no price (R-137)** — those still come from `chainSupport()`, `routes`,
and `costOf()` respectively, unchanged; restated because it is the exact shape a reviewer would
otherwise reach for first.

**The cache stays per-adapter, even though merge is off (D5, unchanged by T-012).** A `set`/`series`
manifest entry does not create an aggregate cache slot: every adapter on a route is still cached
under its own `(provider, capability, args_hash)` key (§4.2), exactly as today. This matters
precisely BECAUSE T-013 is not far off. Stating it now, while merging is still entirely disabled,
is cheaper than re-deriving it once a `shape: 'set'` capability tempts someone to cache the walk's
result as one unit. D5's own reasoning stands unchanged: an aggregate would have no single owner to
invalidate by provider, no TTL matching any one source, and would go stale silently if the route's
adapter set ever changed.

**Merge mechanism (D5/D6, T-013) — DESIGNED, not built, as of 2026-08-05.** Turns on for exactly
two capabilities (`privacy.shielded_pool.history`, `platform.metrics.history`), both routed
`['platform-explorer', 'pg-history']`. Three questions were left to Architecture (`docs/TASK.md`
§6, `OQ-T013-2`/`3`/`4`) and are decided here.

_Activation — TWO gates, not one (OQ-T013-2)._ R-159 already fixed **eligibility**: a fact on the
manifest's `set | series` arm, compile-blocked on `point`. Left open was whether a route ALSO needs
its own activation flag, per D5's literal text: "Маршрут собирает несколько источников, только
если это явно объявлено **в его дескрипторе**". There "его" (its) grammatically names the
**route's** own descriptor, not the capability's. **Decision: yes, `CapabilityRoute.merge?: boolean`
is a second, independent gate**, checked at construction (`R-183`, alongside the existing manifest/
policy checks, same fixed-order discipline). A route with `merge: true` whose capability has no
`mergeable` manifest entry throws, naming both (by analogy to `UnregisteredPolicyClassError`).

Why not "eligibility alone activates" (R-183/AC-45's branch B, which the TASK explicitly permits as
a structural argument instead of a test) — **two reasons, corrected after review**. An earlier third
reason claimed manifest-only activation could not express "merge on this route, not that one". This
same section then ruled that DISAGREEING routes are a construction-time defect, which makes
per-route selectivity unrepresentable under the two-gate design too, refuting the reason it was
meant to support. It is withdrawn, not repaired, because the two remaining reasons carry the
decision on their own. (1) It is a literal deviation from D5's text that R-181 does not budget for.
R-181/AC-40 fix the changelog at **exactly two** deviations (conflict rank, outcome distinction),
and a third would go unrecorded. (2) UC-20 itself is phrased "активирует слияние **на маршруте**" —
an activation act the route performs, which branch B cannot even construct. The two-gate design also
reads as the literal enforcement of D9 rule 3 one level up. `merge` and `mergeable` are independent
axes (route vs. capability), exactly as `trust` and adapter order are independent axes within a
route. Conflating either pair is the same mistake in two places.

_Multi-route capabilities are OUT OF SCOPE, stated rather than papered over._ Activation is decided
per CAPABILITY, at the point `resolve()` builds `plan`: if ANY matching route sets `merge: true`, the
walk merges. Neither real T-013 capability has more than one route, so this is unexercised. **No
construction-time cross-route consistency check is added.** A route disagreeing with a sibling route
of the same capability on `merge` is not validated, is not an R-number, is not an AC, and has no slot
in the numbered order below. A future task giving a capability a second, merge-eligible route needs
to design that check, not inherit one from here.

_Conflict rank (OQ-T013-3)._ OD-T013-2 (task file §1.4) already ruled out `.trust`
(`TC-GATE-02`) and `onchain.metrics.source_priority` (R-180) — Postgres — leaving two candidates.
**Decision: reuse the route's existing `adapterIds` order** (equivalently, the same de-duplicated,
per-route-pairing `plan` array `resolve()` already builds for policy pairing, §above) — the earlier
adapter in walk order wins a dedup conflict. No new table, no new construction-time validation:
R-163(b) applies constructively WITHOUT needing that rejection, and this tree has no such rejection
(measured, task 013-2 review — `rg` over `packages/` for an empty-`adapterIds` check returns
nothing). The argument does not need one: every PARTICIPANT is an element of `adapterIds`, so it
has an index, so it has a rank, by construction. Zero participants is the case where that universal
claim is vacuously true, not a case requiring a guard — `merge-activation.test.ts` pins this actual
(permissive) behaviour rather than assuming a rejection that isn't there.

The tension the TASK names directly: D9 rule 3 forbids conflating trust rank with the free-first
spend order — "Ранг доверия и порядок адаптеров в маршруте — независимые оси. Сливать их нельзя."
Reusing `adapterIds` for conflict rank does not conflate THOSE two axes: OD-T013-2 already
established the conflict rank is not trust. It does couple a NEW axis (correctness-on-conflict) to
the spend axis. D9 rule 3's underlying concern is silently deriving one ranking from another, so
that a change to one silently reorders the other. That concern applies to that coupling too, in
spirit if not by its letter. Three reasons make the coupling acceptable HERE, narrowly, rather than
as a general license.
(1) The direction of dependence is safe. `adapterIds` order continues to decide only spend (R-166 is
unchanged code, not a new invariant), and conflict rank READS that order without ever writing back
to it. A future re-prioritisation for cost reasons therefore cannot silently corrupt spend, only
conflict resolution, which is the smaller blast radius. (2) `platform-explorer` before `pg-history`
is already the wording the TASK's own §0 uses ("приоритет 1"/"приоритет 2") for these two adapters.
The reuse therefore states a fact the project already treats as true in prose, not a new one.
(3) T-016 is where the REAL per-row trust-based conflict axis (D9's `set`-segmentation, extended to
`series`) arrives (R-179e). A bespoke rank table today would be replaced within one further task, so
the placeholder is sized to its lifetime. The merge docstring must say plainly that this is a
narrow, documented, provisional reuse — never a claim that spend order and correctness rank are one
axis in general.

**The hazard this reuse creates, sized correctly, and ENFORCED rather than left to a docstring.**
R-166's spend order is free-before-paid, so a paid participant sits LAST — which is also LOWEST
conflict rank under this reuse. A paid, presumably more authoritative participant would then lose
EVERY dedup collision to a free one, silently. No test changes colour, nothing in the merge code
objects, and the hazard is triggered by whoever next edits `providers.config.ts`, not by whoever
reads the merge docstring. That inverts this project's own priorities, so it is not left as
narrative. **A new construction-time assertion,
`assertMergeParticipantsAreFree(routes, registrations)`, requires every adapter REACHABLE AS A
PARTICIPANT OF A MERGING CAPABILITY to resolve, in the injected `AdapterRegistration[]`, to
`tier: 'free'`. It throws, naming the capability and the first non-free participant, until T-016
replaces the reused-order placeholder with a real per-row trust rank.** **Scoped to the CAPABILITY's
flattened participant set, not to the literal `merge: true` route's own `adapterIds` (MN-1).**
`plan` is the de-duplicated UNION of every matching route's `adapterIds` for a capability
(`:638-650`). A paid adapter reachable only through a SIBLING, non-merge route of the same
capability would enter the merged walk unchecked if the assertion read `route.adapterIds`
literally. Unreachable today — neither merge capability has a sibling route. But the check is
scoped to "every id in the capability's flattened plan, for any capability with at least one
`merge: true` route". That closes it by construction rather than by the accident of today's route
table. Reads `tier`, never `.trust` (`TC-GATE-02` is untouched). Lives BESIDE
`CapabilityRegistry`, not inside its constructor — `AdapterRegistration[]` never reaches
`CapabilityRegistry` today (data-model.md, "M-6 correction"), and this hazard is a cross-check
between `routes` and the registration array, the same shape
`assertValidAdapterRegistrations()` already is. Called once by `mcp-server/src/index.ts`,
immediately after `assertValidAdapterRegistrations()` and before `CapabilityRegistry` is
constructed — the same startup seam `trust`'s own declare-only check already uses (R-154). A
future paid participant on a merge route therefore fails at PROCESS START, the same discipline as
every other construction-time gate in this file. That matches the precedent this repo just set
(WI-34…WI-37 turned a DECLARED rate limit and a DECLARED deadline into ENFORCED ones).

_Dedup and conflict resolution mechanics (R-161/R-162/R-167)._ Dedup implements "highest rank wins"
with no value comparison at all. CONTRIBUTING participants are walked in rank order (= `adapterIds`
order), and each point is inserted into a `Map` keyed by
`` `${metric}\0${asset}\0${ts}` `` **only if the key is absent**. The first (highest-ranked) writer
for a key is kept, and the later one is discarded whole. That satisfies R-167(b) ("choose one point
WHOLESALE, never average/reconcile") by construction. `value_raw` is never read through this path at
all, let alone through `Number(...)`. R-167(a)/(d)'s ban is satisfied because nothing compares two
conflicting values to pick a winner; rank alone decides. The `wallet.balances.native`-style
multi-route flattening already gives `resolve()` one ordered, de-duplicated adapter list per
capability (the `plan` array). Dedup walks that same list, so a capability's rank order can never
disagree between the merge builder and the walk that produced it.

_Policy evaluation point (OQ-T013-4)._ **Decision: per-participant**, not per-merged-whole. Each
participant's normalized answer (cache hit or fresh) is checked with the SAME `satisfies(policy,
value, adapterId)` the non-merge path already applies at `:876`/`:945`. That is unchanged code,
called from a new site for the merge branch. Satisfying means its points are eligible to enter the
merged `Map` (i.e. the participant becomes a CONTRIBUTOR, see `CapabilityResolution` shape below).
Not satisfying means the participant is recorded in `tried` exactly as today ("answered, but not
with what was asked for"), contributes nothing, but is NOT `hadFailure` and is NOT in
`missingSources`. R-164 counts it as "answered" — the policy question is orthogonal to R-164's
three-state model. This is the reading R-182(d) requires as a regression (per-participant, unchanged
for non-merge routes, `entity.labels`'s `someElementHasAny` untouched). It is also the one that
keeps H-1's existing cache-hit application (`:876`) as the SAME code path a merge walk also uses,
rather than a second, whole-array-shaped evaluation with its own semantics. Per R-182(b)/(c): both
real T-013 routes carry no `policy` (`{kind:'any'}`, always satisfying), so the choice is
unobservable in shipped scope. The equivalence test R-182(c) requires is exactly why the choice
still had to be made and stated, not left as two behaviourally-coincident readings.

**The one place this diverges from the non-merge contract on purpose, stated rather than left
implicit (M-6).** On a policy-bearing merge route where every participant answers and NONE
satisfies, the non-merge path falls back to the first truthful-but-unsatisfying answer
(`unsatisfying`,
`packages/core/src/adapters/registry.ts:835`, `let unsatisfying: CapabilityResolution | undefined;`, returned at `:1040`,
`if (unsatisfying && !hadFailure) return withDiagnostics(unsatisfying);`). That case is
hypothetical for T-013's shipped scope — both real routes carry no `policy`. **The merge path does
NOT reuse that fallback.** Falling back to one participant's raw, un-merged answer would silently
un-merge the very response the caller asked for — an arbitrary pick among equally-unsatisfying
sources, dressed as a merged result. Branch (a) applies instead: every participant answered,
`sources` is empty (nobody contributed), and the call returns an empty merged success. That is a
genuine, if perhaps surprising, divergence from the single-source contract, recorded here so it is a
decision and not a gap found in Development.

_Where the merge walk executes, relative to `resolve()`'s existing structure._ Unchanged, in this
order: GATE 2 (coverage, `:756-769`) → the one absolute `effectiveDeadlineAtMs` computed once
(`:584-618`) → `plan` built by the existing route-pairing loop (`:638-650`). What changes is what
happens FROM `plan` onward, gated on whether any matching route sets `merge: true`. The merge walk
reuses, per participant and UNCHANGED, the deadline pre-check (`:803-811`), the not-registered check
(`:813-824`) and the chain-scoped skip (`:830-832`). It also reuses `isAvailable()` (`:834-839`) and
the cache-hit read INCLUDING the negative-entry check but EXCLUDING the early `return` (`:843-875`,
`:877-880`). The fetch/normalize/cache.set triad is reused with the same exclusion (`:882-944`,
`:946-969`). The chain-scoped skip is silent in `tried[]` by existing design. R-174(b) requires
`missingSources` to SYNTHESIZE its own reason for this case rather than mirror an absent `tried[]`
entry, so "silent" describes `tried[]` only, never the merge diagnostic. On the cache-hit read,
`:876`'s `return withDiagnostics(hit)` is exactly what the merge loop replaces with an
accumulate-and-continue step, never performs. On the triad, `:945` is the fresh-result mirror of the
same early return. **Nothing about per-adapter caching is new code.** This is also how R-165's
invariant holds: nothing in the merge path ever calls `cache.set()` on anything but one adapter's
own normalized result. The merged array is assembled in memory, in `resolve()`, and is never itself
a cache write. The one structural difference: the non-merge loop returns on the FIRST satisfying
answer, and the merge loop never returns mid-walk. For each participant it either accumulates into
the dedup `Map`/`sources`/`perSourceCache` (satisfied) or into `missingSources` (not-asked/
asked-did-not-answer) or into neither (answered but policy-excluded, tracked only in `tried`). It
then applies the R-164/AC-48 outcome contract ONCE, after the walk. The full four-branch contract
and the deadline precondition live in reliability.md §9.1, including the THIRD deadline door — the
caller's own already-expired `requestedDeadlineAtMs`, `:615-617` — not restated here to avoid the
two copies drifting.

_Narrowed by T-013 013-3 (2026-08-06) — a FOURTH sentence, found by roast round 1 (B-4), carrying
the same narrower reading as the three already marked below._ The sentence is quoted next. "or into
neither (answered but policy-excluded, tracked only in `tried`)" couples `perSourceCache` to the
SAME `satisfied` condition as `sources`/the dedup `Map`. Under R-174(c) the cache fact is about the
answer, not the contribution, and not about whether the route's policy accepted it. A
policy-excluded participant DID answer, so it still gets a `perSourceCache` entry; only its absence
from `sources`/`missingSources` is correct. `docs/tasks/task-013-4-merge-walk.md`'s own TC-INT-11
and "Политика за участника" section are corrected to state this explicitly, so 013-4's implementer
is not left to infer it from this paragraph. Full argument: `docs/architectures/open-questions.md`
"T-013 task 013-3".

_Line references in this and the preceding two paragraphs corrected review round 3, LOW-4 —
`+87` lines landed above `resolve()` in this task's own diff (the new `MergeEligibilityNotDeclaredError`
class plus the constructor's step 3). That diff shifts every citation at or after old line 375 by
that constant. All twenty numeric anchors from `877` through `952` were re-measured against the
current file and corrected together. None of them pointed at unrelated, already-stale content,
unlike six sibling citations found nearby (see the task's own review record for the full count)._

_`CapabilityResolution` shape (R-174/R-175) — corrected after review: `sources` is CONTRIBUTORS,
not "answered"._ `sources: string[]` names every participant whose points are actually present in
`result` — NOT every participant who answered. The two readings differ on the composition TASK §1.5
names as ordinary: `platform-explorer` answers `[]`, and `pg-history` returns 40 points. An
"answered" reading would publish `source: 'platform-explorer'` — the higher-ranked participant —
over a payload containing none of its own data. `sources` including it would claim it contributed.
`sources` is OPTIONAL (R-174d), omitted when empty (mirrors `attempted`) — that happens on branch
(a) when every participant answered with zero points. `perSourceCache` carries one entry per member
of `sources`, same set, so it is never populated for a non-contributor either. `source` (singular,
required, never empty — AC-47) is the highest-ranked entry of `sources` when `sources` is
non-empty. When it IS empty (nobody contributed, branch (a)'s zero-point case), `source` falls back
to the highest-ranked ANSWERED participant instead, purely to keep the field non-empty as AC-47
requires. This two-tier rule is what makes `source` mean "who provided what is in `result`" whenever
`result` has content. It means "who is most authoritative among those asked" only in the one corner
case where nobody provided anything at all. `cache` stays the existing two-literal
`'hit' | 'miss'` (R-175b forbids widening an existing field's type). It is `'hit'` on a merge walk
only when EVERY entry of `perSourceCache` is `'hit'` — a coarse, conservative aggregate for the 11
unrelated tools that read it unmodified. `perSourceCache` carries the granular per-contributor truth
R-174(c) requires ("a fact is not lost, not that it reaches every reader" — M-5 below names ITS
reader). `resolveCapability()` (`mcp-server/src/tools/resolve-capability.ts`) is extended the same
way. `ResolveSuccess` gains `sources?`/`missingSources?`/`perSourceCache?`, forwarded verbatim when
the registry sets them — strictly additive, so its 11 existing callers recompile and behave
unchanged (R-175b). The 14th tool (interfaces.md §5.1.6) reuses the SAME wrapper for its error
translation and reads the new fields — including as its OWN `_meta.cache` (M-5: the reader
`perSourceCache`/`sources` were missing). It does not re-implement
`CapabilityUnavailableError`/`CapabilityDeadlineExceededError` handling from scratch.

_Narrowed by T-013 013-3 (2026-08-06)._ Two sentences above read `perSourceCache` as
CONTRIBUTORS-only. They are "`perSourceCache` carries one entry per member of `sources`, same set,
so it is never populated for a non-contributor either" (`:982-983`) and "the granular
per-contributor truth" (`:992`). The shipped field instead covers every participant that ANSWERED,
R-174(c): the cache fact is about the answer, not the contribution, and a participant that answered
empty from cache without contributing must not vanish from `_meta.cache` entirely. Full argument and
the composition on which the narrower reading loses the fact: `docs/architectures/open-questions.md`
"T-013 task 013-3". (A fourth sentence carrying the same narrower reading, in the earlier
procedural paragraph above, is marked separately at `:949-951` — roast round 1, B-4.)

**`ttlFor()` is a READER, its own contract UNCHANGED (R-138). LANDED (T-012, task 012-5).**
`cache/ttl.ts` still exports `ttlFor(capability): number` at the same path (`export { ttlFor } from
'./cache/ttl.js'` in `src/index.ts`) — `mcp-server/test/readme-tool-table.test.ts` imports exactly
that symbol and needed no edit to it. Internally `ttlFor` now reads
`capabilityManifests[capability]?.ttlSeconds`, and the `TTL_SECONDS` table it used to own is
**deleted**; `DEFAULT_TTL_SECONDS = 300` and `NEGATIVE_TTL_SECONDS = 60` (a DIFFERENT, deliberately
non-per-capability constant for cached deterministic failures — unaffected) both stay.
`DEFAULT_TTL_SECONDS` is UNREACHABLE for every routed capability the same way an unregistered
policy `kind` will be: `CapabilityRegistry`'s construction-time validation (above) also requires a
`capabilityManifests` entry for every `route.capability`. **M1 — this is what turns AC-13 ("every
`deadlineMs` carries a derivation record") into a RED TEST, not a code-review promise.** The WI-28
gate (`readme-tool-table.test.ts`) already asserted every routed capability's `ttlFor()` value
matches a documented row. It was extended in the same task to assert every capability's
`deadlineMs` (and, where applicable, `paidLegMs`) matches the by-capability table below. A manifest
row with a number and no matching documented derivation fails the SAME gate that already catches an
undocumented TTL. What that gate does **not** read is the Derivation column's prose, so it cannot
tell an alignment from an override. That limit is declared in the gate itself and is why the one
override below is marked in the row.

**Shape classification — 8 of 20 settled by ADR-002 D3 itself, the other 12 audited in task 012-4.
All 20 rows are written.**

| `shape`  | Settled capabilities                                        |
| -------- | ----------------------------------------------------------- |
| `point`  | `token.price`, `chain.tvl`, `chain.supply`                  |
| `set`    | `entity.labels`, `token.holders`, `wallet.balances.native`  |
| `series` | `privacy.shielded_pool.history`, `platform.metrics.history` |

**The remaining 12 were audited and the table is complete — DONE (T-012, task 012-4).** The 12 are
`token.metadata`, `pairs.active`, `pool.info`, `protocol.tvl`, `dex.volume.history`,
`privacy.shielded_pool`, `platform.identities`, `platform.contracts`, `platform.documents`,
`platform.credits`, `smart-money.flows` and `token.risk`. Each needed one pass over the adapter's
actual `normalize()` output shape rather than a guess made here. That audit ran, its per-row
evidence lives beside each row in `packages/core/src/capability-manifest.ts` as an `AUDIT:` comment,
and OQ-T012-1 is closed in `open-questions.md`. All 20 rows are written. The heading's "12 left to
Development" is the state at the time this section was authored. It is kept because the split is
what explains why half the rows cite ADR-002 and half cite a code reading.

**Deadline budget tiers (E-4, R-148/R-149) — the STARTING tiers, not a final 20-row table.**

**M-5 correction (architecture review round 2, 2026-08-03) — tiers are named by ROUTE
COMPOSITION, not by `shape`.** An earlier draft of this table named the first two tiers "Free
`point`" and "Free `set`/`series`", echoing OD-2's `shape` vocabulary. But the assignment below
("`deadlineMs`/`paidLegMs` by capability") puts `wallet.balances.native` (`shape: 'set'`, per the
classification table above) into the SAME ~15_000 row as `token.price` (`shape: 'point'`). That
placement follows the real criterion, already visible in this table's own Derivation column:
single-vs-multi FREE-ADAPTER composition, not result shape. `shape` and the deadline tier are
independent axes that happen to correlate for the 8 capabilities ADR-002 D3 names outright.
Renamed here to remove the false impression that `shape` decides `deadlineMs`:

| Tier (named by what decides it)        | `deadlineMs` | Applies to (examples)                                                    | Derivation                                                                  |
| -------------------------------------- | ------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Single free adapter, one attempt       | ~15_000      | `token.price`, `chain.tvl`, `chain.supply`, `wallet.balances.native`     | one adapter, one network attempt, no composite sub-calls                    |
| ≤2 free adapters in sequence           | ~30_000      | `entity.labels`'s free call stage alone, `privacy.shielded_pool.history` | ≤2 free adapters attempted in sequence, one attempt each                    |
| Paid composite — cancellable head only | ~60_000      | `entity.labels`'s full route, `smart-money.flows`, `token.risk`          | free call stage (if any) + the paid adapter's own free pre-reservation step |
| Single free adapter, MEASURED slow     | ~60_000      | `token.holders`                                                          | **Not a composition tier** — see the derivation notes below                 |

**Derivation notes for the tiers above.**

- **Single free adapter, one attempt** — regardless of whether the capability's OWN `shape` is
  `point` or `set`.
- **Paid composite — cancellable head only** — the pre-reservation step is e.g. nansen's `/account`
  resync; the tier covers everything up to, but NOT including, `checkAndReserve()`.
- **Single free adapter, MEASURED slow** — one adapter and one attempt, like the first row. The
  vendor's own index for this ROUTE was measured far slower than the routes beside it (task
  014-42), so the number comes from a measurement rather than from the route's shape. Shares a
  number with the paid tier and nothing else.

OD-2's `shape` labels (`point`/`set`/`series`) remain a useful ILLUSTRATIVE mapping for intuition —
most `point` capabilities happen to be single-free-adapter routes — but they are never the
assignment RULE; the route table (`providers.config.ts`) is. These three are the OWNER's starting
tiers (2026-08-03), not a final per-capability table. Assigning each of the 20 capabilities to a
tier and writing its exact `deadlineMs` (and, for paid composites, `paidLegMs`) is Development's
job. That job runs against a MEASURED envelope for that specific capability, per R-149 — not a
mechanical round-to-nearest-tier.

**Worked example — `entity.labels`, corrected 2026-08-03 (OD-3, supersedes an earlier draft of
this section that an architecture review found conflated the two phases into one "~410s → ~60s"
claim):**

| Phase                                            | Duration                                                | Cancellable?                  | Why                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Cancellable head                                 | ~60_000 (paid composite — cancellable head tier, above) | YES — bounded by `deadlineMs` | blockscout's free attempt + nansen's own free `/account` resync, both strictly BEFORE any reservation         |
| Paid call stage                                  | ~270_000 (derivation below the table)                   | NO — D4 п.2                   | credits already committed; cancelling here means paid-and-got-nothing                                         |
| **Worst case, T-012**                            | **~330_000**                                            | —                             | `deadlineMs + paidLegMs`, deterministic                                                                       |
| Worst case, TODAY (no deadline mechanism at all) | **~410_000, and not actually a bound**                  | —                             | nothing anywhere is cancelled; a slow/hung free call stage can ALSO push the total past the historical figure |

**Paid call stage (`paidLegMs`) — how ~270_000 is derived.** `30+4×15` × 3 nansen sub-calls, the historical
derivation, UNCHANGED — owner rejected retuning nansen's timeouts.

Do NOT retune nansen's own timeouts in this task — the owner considered and rejected that option on
2026-08-03. The ~270_000 of the historical envelope is written down as a DERIVED, ACCEPTED cost of
D4 п.2's correctness rule, not a gap to close here.

**Call deadline (D4, R-140…R-147) — LANDED (T-012, tasks 012-7/012-8/012-9; adapter uptake
completed by WI-37, 2026-08-05).** A pre-commitment budget for the cancellable
phase, threaded as a plain scalar (never wrapped in an object, D4 п.3 rejects a duration, not a
shape). The paid tail is a separate, honestly-budgeted number, per OD-3 above:

```
resolve(capability, chain, args, requestedDeadlineAtMs?)
  → requestedDeadlineAtMs validated (M4, L-1-corrected): !Number.isSafeInteger(x) ⇒ absent;
    Number.isSafeInteger(x) && x <= Date.now() ⇒ immediate typed refusal (see "resolve()" above);
    else used as-is
  → effectiveDeadlineAtMs = min(Date.now() + manifest.deadlineMs, requestedDeadlineAtMs ?? Infinity)
  → adapter.fetch(capability, args, effectiveDeadlineAtMs) — honoured ONLY before a reservation commits
    → throttle(providerId, config, weight?, effectiveDeadlineAtMs)
    → safeFetch(url, opts, allowlist, fetchImpl, { ...opts, deadlineAtMs: effectiveDeadlineAtMs })
```

**C-1 (CRITICAL, architecture review round 2, 2026-08-03) — TWO distinct signals per hop, not one
shared clock.** An earlier draft of this section read "one hop races `Math.min(timeoutMs, deadlineAtMs

- Date.now())`" and described the error class purely by "remaining time already `≤ 0`at the START of
a hop". That phrasing only covers a deadline expiring AT a hop boundary — it does not cover a deadline
that runs out WHILE a hop is already in flight, which is the ORDINARY case, not the exception:
**every route ends on some adapter's last hop, and that hop has no next iteration**, so the
next-iteration pre-check (below, and the registry loop under "Call deadline") cannot rescue it. On a
single-adapter route the pre-check never runs at all — and single-adapter is the common shape today,
**13 of the 27 routes** (measured from`providers.config.ts`; 14 of 28 after task 014-32b added the single-adapter `token.pools`route; the other 8 are the five`dash-platform`+`platform-explorer`pairs, the two`platform-explorer`+`pg-history`history routes,
and`entity.labels`). The argument does **not** rest on that count: the last-hop clause holds for all
21 regardless, which is why it is stated first. An earlier draft of this paragraph asserted "19 of
21" — a number no reading of the route table produces — and review round 3 caught it precisely
because the count was doing load-bearing work the universal clause does better. Under the single-shared-clock design, a mid-flight expiry aborts via
the SAME signal an ordinary per-hop timeout would, is caught by the registry's generic "this adapter
could not answer" branch (`registry.ts`, ~372-391), never sets `deadlineHit`, and the walk ends as a
plain `CapabilityUnavailableError`— R-145(a)/UC-4/AC-8 are unreachable as designed. **Corrected
design:**`safeFetch`builds two distinct`AbortSignal`s per hop and picks the thrown error class by
  WHICH one fired, never by "whichever branch of the code happened to observe the abort first":

```
// `effectiveHopMs` is `timeoutMs` — the per-hop bound, UNCLAMPED by the deadline. Clamping it to
// `min(timeoutMs, deadlineAtMs - Date.now())` is the trap C-1 exists to avoid, one level down:
// both signals would then expire on the SAME millisecond, `hopSignal` is constructed first so its
// abort fires first, `deadlineSignal.aborted` is still `false` inside `onAbort`, and the handler
// falls through to `SafeFetchTimeoutError` — so a genuine deadline expiry never reaches the C-1
// bridge, never sets `deadlineHit`, and the walk ends as `CapabilityUnavailableError`. The
// remaining time is already carried by `deadlineSignal`; clamping the hop buys nothing and costs
// the discriminator. (Found by plan review 2, 2026-08-03: the identifier appeared 8 times across
// this file and the plan with zero definitions.)
const effectiveHopMs = timeoutMs;
const hopSignal      = AbortSignal.timeout(effectiveHopMs);
const deadlineSignal = deadlineAtMs !== undefined
  ? AbortSignal.timeout(Math.max(0, deadlineAtMs - Date.now())) : undefined;
// on abort: deadlineSignal?.aborted → DeadlineExceededError
//           callerSignal?.aborted   → rethrow the caller's own reason
//           else                    → SafeFetchTimeoutError(url, effectiveHopMs)
```

A hop whose remaining time is already `≤ 0` at the START is still refused before any network attempt
at all (no signal race needed there) — that belt-and-braces short-circuit is unchanged. What C-1 fixes
is the hop that STARTS with time left and runs out of it mid-flight. `raceWithTimeout` now inspects
which signal actually aborted rather than manufacturing one error class unconditionally. That is
also what makes the registry's own `deadlineHit` flag (H2 below) reliable. It can only be set from a
genuine `DeadlineExceededError`, and that error can now actually be thrown from the case that
matters. The allowlist check (`assertAllowedHost`) itself is UNCHANGED. The deadline affects only
the timeout signals composed into each hop, never the per-hop host check (Boundaries, TASK.md §5:
the SSRF gate is not touched by this task in substance).

**H1 — the caller's own abort signal stops being silently clobbered, AND stops being conflated with
either timeout signal. SHIPPED (T-012, task 012-7).** The present tense below described the tree
BEFORE the fix, and is kept as the derivation. The argument that derivation carries — why the
one-line fix below reintroduces C-1 — is what stops the next author from writing it. What
shipped is `composeHopAbort` in `net/safe-fetch.ts`, which records WHICH input fired and resolves
the rejection class from that; the caller's own signal is honoured and returned unwrapped.
Read the rest of this block as "the state that was, and the reasoning out of it", not as a
description of running code.

Before the fix, `safe-fetch.ts` built each hop's options as
`{...currentOpts, redirect:'manual', signal}` with the PER-HOP timeout signal LAST, so any
caller-supplied `currentOpts.signal` is unconditionally overwritten and never observed — `safeFetch`
cannot currently be cancelled by its caller at all. The one-line fix — fold the caller's signal
and the deadline signal into one shared `AbortSignal.any([...])` and hand THAT single composite to
both `fetchImpl` and `raceWithTimeout` — reintroduces C-1 one level up. `AbortSignal.any` reports
only that ONE of its inputs fired, never WHICH. A caller's own abort would again be reported as a
vendor timeout (or a deadline expiry) to whatever reads the thrown error's type. PLANNED fix keeps
all three signals distinguishable all the way to the `catch`. For the actual `fetchImpl` call, which
only accepts one signal, `hopSignal`, `deadlineSignal` and the caller's own `currentOpts.signal` are
combined via `AbortSignal.any([...])`. The handler records, in a closure variable read inside
`onAbort`, which INPUT signal was the one that fired. That variable selects the class:
`deadlineSignal?.aborted` → `DeadlineExceededError`; `callerSignal?.aborted` → rethrow the caller's
OWN abort reason, never wrapped in either typed error; otherwise →
`SafeFetchTimeoutError(url, effectiveHopMs)`. Regression contract, stated so it is testable. With NO
`deadlineAtMs` and NO caller `signal`, behaviour is BYTE-IDENTICAL to today (a lone per-hop
`AbortSignal.timeout`). With a caller `signal` and no deadline, the caller's own abort now genuinely
cancels the fetch AND is reported under its own reason, never as `SafeFetchTimeoutError` (today it
silently does neither). With both present, whichever fires first wins. Each still reports through
its own typed error, so a caller cannot mistake "we cancelled you" for "the vendor timed out" or
"we ran out of our own time".

**The limiter is deadline-aware too (R-146, L4-corrected, H-A-corrected 2026-08-03).**
`throttle(providerId, config, weight?, deadlineAtMs?)` computes `remainingMs = deadlineAtMs ?
deadlineAtMs - now() : Infinity`, and distinguishes TWO conditions an earlier draft of this section
conflated into one flag:

- `remainingMs <= 0` — genuine expiry: the deadline itself has already passed, true for EVERY
  adapter on the route, not just this one. `throttle()` refunds the reservation immediately (the
  SAME `bucket.tokens += weight` pattern the `MAX_WAIT_MS` saturation case already uses,
  `net/rate-limit.ts`) and throws `DeadlineExceededError` WITHOUT waiting at all — sleeping only to
  reject afterward buys nothing.
- `remainingMs > 0` but the wait would not LEAVE `MIN_POST_WAIT_REMAINDER_MS` (5 000 ms — the
  shortest per-hop `REQUEST_TIMEOUT_MS` any adapter configures) behind it. That is a DIFFERENT fact:
  THIS PROVIDER's bucket specifically cannot free up in useful time (buckets are per-provider,
  `net/rate-limit.ts`); time still remains overall. `throttle()` refunds the reservation the same
  way but throws a DIFFERENT typed error, `DeadlineWouldExceedError` (new, `net/rate-limit.ts`,
  sibling to the existing `RateLimitRejectedError`) — a fact about ONE provider's saturation, never
  about the deadline itself.
  **The test is on the REMAINDER, not on whether the wait fits (adversarial cycle 2, F-2).** The
  first implementation compared `computedWaitMs > remainingMs`, which admitted the exact equality
  and every wait leaving a sliver. The caller then slept out its whole budget, and `safeFetch`
  answered with `DeadlineExceededError` — the TERMINAL class — one layer down, so the registry
  cancelled every adapter behind the saturated one. That is the H-A defect below, reintroduced by
  the branch written to prevent it (measured on `entity.labels`: 31 s of ceiling, a 30 s backlog,
  `nansen` never asked).

**H-A (HIGH, architecture review round 2, 2026-08-03) — only genuine expiry latches the
registry's `deadlineHit` flag; a saturated bucket must not skip the rest of the route.** An earlier
draft of the registry loop below skipped every remaining adapter the moment EITHER error was seen —
reproducing the H-1 defect one layer down. Concretely on `entity.labels`: a burst saturates
`blockscout`'s bucket (`capacity 5, refillPerSec 2`), its wait is 30s with 20s of deadline left —
`DeadlineWouldExceedError`. Treating that as route-ending means `nansen`, the very next adapter,
with an IDLE bucket and 20 real seconds still on the clock, is never even attempted. That is a free
source's unavailability terminating the route before the paid one is asked, which is exactly what
H-1 already forbids for a plain empty answer. A saturated bucket is a reason THIS adapter cannot
help right now, never a reason to stop asking. Otherwise (`remainingMs - computedWaitMs >=
MIN_POST_WAIT_REMAINDER_MS`) `throttle()` proceeds exactly as it does today; the deadline was not
this call's binding constraint.

**H2 — bridging a net-layer deadline throw into the registry's OWN typed outcome, and OD-4's
"never a partial-as-fact" rule.** `DeadlineExceededError` (net layer) is never rethrown to the
caller AS ITSELF. `CapabilityRegistry.resolve()`'s existing per-adapter `try/catch` catches it
instead, sets a NEW `deadlineHit = true` flag alongside the existing `hadFailure`, and records the
same informative `tried[]` entry any other fetch failure gets. That is the SAME `try/catch` that
already special-cases `CapabilityNotCoveredOnChainError` for immediate rethrow
(`packages/core/src/adapters/registry.ts:1549`, `if (error instanceof DeadlineExceededError) deadlineHit = true;` — the SINGLE-WINNER walk's catch; the merge walk grew its own twin at `:1176` in task 013-5).
**`DeadlineWouldExceedError` (H-A above) is caught by this SAME per-adapter branch but does
NOT set `deadlineHit`.** It is recorded in `tried[]` exactly like any other single-adapter failure
(e.g. `isAvailable() === false`), and the loop simply moves on to the next `adapterId`. Conflating
the two would reproduce H-1 one layer down, per H-A. **Unlike** `CapabilityNotCoveredOnChainError`, a
genuine `DeadlineExceededError` does NOT rethrow immediately: the walk's remaining, not-yet-tried
adapters still need an entry in `tried[]`, produced CHEAPLY by a pre-iteration check with no further
network attempt:

```
for (const { adapterId, policy } of plan) {
  // H-A: the ONLY thing that skips a not-yet-tried adapter for free, with no fetch() attempt at
  // all, is that TIME ITSELF is gone — never a sticky "some earlier adapter in this walk threw a
  // deadline-flavored error" flag. Buckets and per-adapter unavailability are per-PROVIDER; the
  // deadline is global. (An earlier draft read `if (deadlineHit || ...)` here — removed: `deadlineHit`
  // is set BELOW only by a genuine `DeadlineExceededError`, so ORing it back into this guard would
  // let one provider's `DeadlineWouldExceedError`, surfaced through a different code path, wrongly
  // end the walk for every adapter after it.)
  if (Date.now() >= effectiveDeadlineAtMs) {
    deadlineHit = true;
    tried.push({ adapterId, reason: 'deadline exceeded before this source could be attempted' });
    continue;              // no fetch() call at all — free
  }
  // ... existing cache/fetch/normalize logic; its own catch now matches BOTH new error classes —
  // DeadlineExceededError sets deadlineHit = true (genuine expiry, feeds the terminal branch below);
  // DeadlineWouldExceedError does NOT set deadlineHit and simply falls through to the next
  // adapterId, which is the whole point: a saturated FREE bucket must never stand between the walk
  // and a PAID adapter that still has time and an idle bucket of its own.
}
```

**OD-4 (owner, 2026-08-03) — a deadline is a fact about OUR OWN availability, exactly like a
missing key or a 5xx: it sets `hadFailure` UNCONDITIONALLY and is never treated as "everyone
answered and nobody had it".** This supersedes an earlier draft of this section, which read R-145's
"частичный результат" wording as licence to return the truthful-but-unsatisfying answer even when a
deadline (not every adapter) was why the walk ended. It does not — `hadFailure` and `deadlineHit`
are set TOGETHER, so the existing `if (unsatisfying && !hadFailure) return unsatisfying;`
(`packages/core/src/adapters/registry.ts:669`, `args: Record<string, unknown>,`, H-1) does NOT fire, preserving H-1's doctrine unchanged. The terminal throw
becomes:

```
// Belt-and-braces (C-1, architecture review round 2, 2026-08-03): `deadlineHit` is the primary
// signal, set by the per-adapter catch above from a genuine `DeadlineExceededError`. The SECOND
// disjunct guards a path that reaches this line with time already gone WITHOUT having gone through
// that catch (a future adapter whose own error handling swallows the typed error before it reaches
// the registry) — the walk must never report "unavailable" when the true reason is "we ran out of
// our own time". `DeadlineWouldExceedError` (H-A) never reaches this OR: it does not set
// `deadlineHit`, and by construction it is only thrown while `remainingMs > 0`, i.e. strictly BEFORE
// `Date.now() >= effectiveDeadlineAtMs` becomes true — so this guard cannot be tripped by one
// provider's saturation alone.
if (deadlineHit || Date.now() >= effectiveDeadlineAtMs) {
  throw new CapabilityDeadlineExceededError({ capability, chain, tried });
}
throw new CapabilityUnavailableError({ capability, chain, tried });
```

`CapabilityDeadlineExceededError` carries the identical `{capability, chain, tried}` shape.
`tried[]` names both the adapters that answered-but-not-satisfyingly BEFORE the deadline hit and the
ones the pre-iteration check marked "never attempted". That is what makes the thrown TEXT
informative WITHOUT any partial-domain-data return path (D5 stays off; `resolve()` never starts
returning data assembled from more than one source). **TASK.md's R-145(b) wording is being amended
to match this reading** (owner, OD-4) — record this as a dated decision, not an open interpretive
question.

**Fetch failures are still never negative-cached (unchanged) — a deadline cannot poison a
provider's cache slot.** `DeadlineExceededError` AND `DeadlineWouldExceedError` (H-A above) are both
caught by the SAME generic "this adapter could not answer, try the next one" branch every other
fetch-layer error already uses (`registry.ts`, ~372-391). Only `normalize()` failures are ever
written as a negative cache entry (L-1's doctrine, unchanged). A capability that legitimately hits
its deadline once is free to try fully again on the very next call, with no memory of the timeout.

**H3 — once a reservation commits, NOTHING further in that `fetch()` call receives the deadline,
not just its first sub-call.** Stated unambiguously because a singular "the paid HTTP request"
invites reading it as one call. For a composite capability with N paid sub-calls made under ONE
reservation, sub-calls 2..N and every throttle wait between them ALSO receive no deadline. The
reservation was made for the SUM of their prices (§3.2, "Post-call reconciliation"). Cutting off
sub-call 2 after paying for both would be exactly the "paid and got nothing" outcome D4 п.2
forbids, delayed by one step. **M-3 correction (architecture review round 2, 2026-08-03) —
per-tier sub-call counts, restated.** `entity.labels`'s DEFAULT tier issues **2 OR 3** paid
sub-calls under one reservation, depending on `args` (`packages/core/src/adapters/nansen/reconcile.ts:8`, `smart-money.flows`).
The case with 3 sub-calls is the one `paidLegMs ≈ 270_000` (the OD-3 worked example above) is
derived from. `paidLegMs` is documented as the WORST CASE over arguments, never a fixed count. A
lighter invocation that resolves to fewer sub-calls has a shorter ACTUAL uncancellable tail. The
manifest publishes the worst-case bound because that is what a caller must be told to expect. This
is the identical argument-dependence "Provider tier" above already uses to forbid deriving `tier`
from `costOf()`. A measured BOUND is allowed to vary with `args`, a CLASSIFICATION is not, and
`paidLegMs` is the former.
`smart-money.flows`/`token.risk` issue two each, unchanged. **Checkable, not a convention Development
could silently violate.** A contract test, parameterised over `adapterRegistrations.filter((r) =>
r.tier === 'paid')`, asserts that no `throttle()`/`safeFetch()` call issued by that adapter's
`fetch()` AFTER its own `checkAndReserve()` resolves `{ok:true}` ever carries a `deadlineAtMs`. A
fake `checkAndReserve` records a timestamp on success, and every subsequent injected
`throttle`/`safeFetch` spy asserts its own `deadlineAtMs` argument is `undefined`. **M-2
correction (architecture review round 2, 2026-08-03):** the paid set is `{dune, nansen}` ("Provider
tier" assignment above, matching TASK.md R-150b), NOT `nansen` alone. But `dune.isAvailable()` is
UNCONDITIONALLY `{ok: false}` (§3.2, "The adapters — summary") and its `fetch()`/`normalize()` are
not implemented, so it never reaches `checkAndReserve()`. A test filtering on
`.filter((r) => r.tier === 'paid')` alone would iterate a registration with no reservation to spy
on. The test either SKIPS registrations whose `isAvailable()` is unconditionally `{ok: false}`, or
filters on "reaches `checkAndReserve()`" rather than on `tier` alone. A test that takes the SKIP
branch names `dune` explicitly in a code comment, so a future real second paid adapter is not
silently skipped the same way. Either way the test is written against the registration's
properties, not a hardcoded id, so a second LIVE paid adapter is covered automatically. `tier` is
introduced by this very task, so nothing pre-T-012 could have written this test.

**Singleflight does not see the deadline (M5).** `nansen`'s singleflight key is
`deriveArgsHash(cap, args)` (`packages/core/src/adapters/nansen/index.ts:596`, `'s own docstring for why an OMITTED`) — `deadlineAtMs` never enters it, deliberately:
two calls for the identical `(capability, args)` with DIFFERENT deadlines are still logically one
request in flight. A follower whose OWN deadline expires while the leader's shared promise is still
pending abandons ITS wait and raises `CapabilityDeadlineExceededError` to its own caller. It does
NOT cancel the leader, which keeps running for whoever else may still be awaiting it (including a
caller whose looser deadline will still be satisfied).

**Adapter uptake WAS incremental, and is now complete for every adapter that can wait (R-140e).**
The parameter exists on every `ProviderAdapter.fetch()` signature. Whether a GIVEN adapter's
implementation reads it is a per-adapter decision. R-140e's guarantee — that an adapter ignoring
it degrades exactly to today's per-hop-timeout-only behaviour — still holds and is still tested
(`registry.deadline.test.ts` TC-INT-07). It is what made the staged uptake safe, not a permanent
state.

**SHIPPED state, measured 2026-08-05 (WI-37).** In that measurement,
**10 of 12 adapters read the parameter**: `blockscout`, `nansen`, `coingecko`, `dexscreener`,
`defillama`, `rpc-evm`, `rpc-solana`, `platform-explorer`, `blockchain-info`, `pg-history`. Each
forwards it to the limiter and to its transport, **except where the design forbids it**. `nansen`
stops at `checkAndReserve()`, so its paid sub-calls receive none (H3, and the paragraph on admission
control below). `defillama`'s two shared-document capabilities bound the caller's WAIT rather than
the shared download (`awaitSharedDocument`), so that one caller's expiry cannot abort a transfer
another is awaiting. The other two, `dune` and `dash-platform`, are M1 stubs whose `isAvailable()`
is unconditionally false and whose `fetch()` throws, so they spend no time and cannot weaken a
ceiling (the same fact as E-DASH = 0 in `capability-manifest.ts`). The ceiling is therefore enforced
on **20 of 20 capabilities**.

**What T-014/ADR-003 may read, stated precisely, because "`deadlineMs` is now an admission-control
input" is true only of free-only routes.** On the three capabilities that reach `nansen`, the
enforced ceiling bounds the CANCELLABLE HEAD alone; after `checkAndReserve()` nothing receives a
deadline (H3), by design — cancelling there means paying without receiving. The worst case an
admission controller has to reserve for is therefore `deadlineMs + (paidLegMs ?? 0)`, which for
`entity.labels` is 60_000 + 270_000 ≈ **330_000**, not 60_000. Two obligations follow, and neither is
met today. `paidLegMs` has **no runtime reader** — nothing under `packages/*/src` reads it, and its
only consumers are tests (the WI-28 doc gate, TC-UNIT-06 in `capability-manifest.test.ts`, and
`entity-labels-deadline-arithmetic.test.ts`). It appears nowhere in `interfaces.md`, so nothing on
the wire tells a client the second number exists.
T-014 is where that field acquires its first runtime consumer.

Both figures are re-derived on every test run **in `packages/core/src/capability-manifest.ts`**,
whose ENFORCEMENT prose `capability-manifest.test.ts`'s TC-F5-GATE regexes and compares against a
scan of the adapter sources and against each row's own ENFORCED/DECLARED marker. **The copies in
THIS document are transcriptions and no gate reads them** — `docs-counts.test.ts` anchors on the
route/adapter/tool counts, not on these.

`deadline-uptake.test.ts` carries the behavioural half. Its gate drives every adapter that can wait
except `nansen`, and requires the deadline to reach the limiter unchanged. Seven of them
(`coingecko`, `dexscreener`, `defillama`, `rpc-evm`, `rpc-solana`, `platform-explorer`,
`blockchain-info`) also get the two cases that prove an in-flight request is actually cancelled.
`blockscout` (`registry.deadline.test.ts` TC-INT-08a/08b) and `nansen`
(`nansen-deadline-boundary.test.ts`) are proved in their own files; `pg-history` has no cancellation
analogue at all, because a Postgres statement cannot be recalled — its bound stops the waiting. The
exemption for the two stubs is derived from whether an adapter imports a transport module at all.
The day a live gRPC transport lands for `dash-platform` (§11), it enters the population, and the
five rows it routes fail until it reads the deadline.

**How this read before WI-37, since the intermediate state is the thing that misled a reader.** From
012-9 to 2026-08-05 only `blockscout` (012-8) and `nansen` (012-9) read the parameter. Ten ignored
it, and the ceiling was enforced on 4 of 20 capabilities. On the other sixteen the registry still
refused sources it had not yet REACHED, while no in-flight attempt was cancelled and no limiter wait
shortened. The number in the table below was declared, not applied — sanctioned by R-140e, but not
safe to read as an admission-control bound, which is what
`docs/backlog/wi-37-call-deadline-declared-but-unenforced-on-ten-adapters.md` recorded until this
commit closed it.

**Architectural obligation carried into Development (ADR-002 D4, R-157). DISCHARGED (T-012, task
012-8).** `blockscout/index.ts`'s `REQUEST_TIMEOUT_MS` docstring ended "this docstring must be
rewritten in the SAME commit, not after it", and it was. The rewrite landed with the deadline and
stops saying the deadline "does not exist yet". It names the TWO-PHASE mechanism (a cancellable
`deadlineAtMs` head, and — per OD-3 — an UNCANCELLABLE `paidLegMs` tail for any paid route). It
KEEPS the historical `30 + 4×5 (blockscout) + 30 + 4×15 (resync) + 3×(30 + 4×15) (nansen) ≈ 410s`
derivation AS HISTORY. That derivation is recorded nowhere else. It is the reason the deadline
exists at all, and it is the source of the `~270_000` `paidLegMs` figure the manifest reuses
rather than re-measuring.

The obligation is kept rather than deleted because the reason for it still applies after it was
discharged. Landing the deadline without that rewrite would have reproduced, in a file no doc-count
gate reads, the exact documentation-drift class `docs-counts.test.ts` (WI-24) and
`readme-tool-table.test.ts` (WI-28) exist to catch elsewhere. This subsection's own six stale
`PLANNED (T-012)` markers turned out to be the same class, found by review on 2026-08-05 rather
than by any gate.

`providers.config.ts` holds the declarative routes plus the adapter registry (id →
hosts/rate-limit/env):

**The route table is NOT reproduced here.** `providers.config.ts` holds **28 routes** over 27
distinct capabilities, and the authoritative list is that file. A copy in this document is a copy
that drifts. That is exactly what happened between TASK-006 and TASK-010 (WI-24). This section
carried `chains:` literals for fourteen routes months after they were deleted from the code, and
was missing four routes that existed. What belongs here is the **shape and the rules**, which do
not change per route:

```ts
export const routes: CapabilityRoute[] = [
  // The ordinary shape: one capability, one adapter. `CapabilityRoute` no longer carries a chain
  // field of its own AT ALL (OQ-C, ADR-002 D2) — coverage comes from `chainSupport` (§4.2.3), and a
  // second, route-level narrowing would have been a drifting answer to the same question. The
  // field existed, unset by every route, until T-012's audit confirmed zero counter-examples and
  // deleted it.
  { capability: 'token.price', adapterIds: ['coingecko'] },

  // Two adapters, ordered. Order IS the spend rule, not a preference hint (R-11): a credit is
  // spent only when the free source cannot answer. `policy` (D2) refines it — without it an EMPTY
  // free answer would end the walk and shadow the paid source for a whole TTL.
  {
    capability: 'entity.labels',
    adapterIds: ['blockscout', 'nansen'],
    policy: { kind: 'someElementHasAny', fields: ['name', 'tags', 'labels'] },
  },

  // Two free adapters, one live vendor view + our own snapshotter history. This is the pair
  // ADR-002 D6 turns on merging for FIRST, because `Snapshot` has a legitimate identity key
  // (metric/asset/ts) and both sides are free.
  //
  // 🔴 DESIGNED (T-013), NOT in `providers.config.ts` as of 2026-08-05 — shown here anyway because
  // this block's own rule above ("shape and rules, which do not change per route") is exactly what
  // a not-yet-built field violates; flagged inline, not only in the paragraph above, so a reader who
  // skips straight to the literal still sees it. `merge: true` will activate collection on BOTH
  // `*.history` routes (this one and `platform.metrics.history`, not shown here) once built; it is
  // the SECOND of two required gates, the first being `mergeable: true` on each capability's
  // manifest row (OQ-T013-2, see "Merge mechanism" above). Order is unchanged and still the spend
  // rule (R-166) — merge never reorders `adapterIds`, and this same order doubles as the conflict
  // rank (OQ-T013-3).
  {
    capability: 'privacy.shielded_pool.history',
    adapterIds: ['platform-explorer', 'pg-history'],
    merge: true, // DESIGNED (T-013) — not yet in providers.config.ts, see the comment above
  },

  // Same capability, two routes rather than one route with two ids: the adapters serve DISJOINT
  // chain families, so the split is what keeps `chainSupport` the only chain authority.
  { capability: 'wallet.balances.native', adapterIds: ['rpc-evm'] },
  { capability: 'wallet.balances.native', adapterIds: ['rpc-solana'] },
];
```

Two absences in that file are decisions, not omissions, and both are recorded beside the routes
they concern. `mempool.space` is deliberately **not** an adapter (it is the eval's independent
reference — a source we answer from cannot also be the check on that answer, §5.1.5/R-89).
`dune` is registered but permanently unavailable (`isAvailable()` → `{ok: false}`), so its
capabilities are advertised by nobody.

**M-7 + L-4 correction (architecture review round 2, 2026-08-03) — reindented, and marked as a
snapshot, not a spec.** The block below reproduces the registrations **as they stand TODAY**
(`id`/`hosts`/`rateLimit`/`requiresEnv` only). It is NOT yet valid against the `AdapterRegistration`
interface declared above ("Module: src/adapters/*"), which makes `tier`/`trust` MANDATORY fields; as
printed, this snippet would not compile. **T-012 adds `tier`/`trust` to every one of the twelve
entries below**, per the two assignment tables above ("Provider tier" and "Source trust —
declare-only"). This is the BEFORE picture, kept because it is still the fastest way to see
hosts/rate-limits/env-keys side by side. The M8 fence repair below fixed the mismatched-fence bug
but left the block flush-left at column 0, which is also corrected here.

```ts
export const adapterRegistrations: AdapterRegistration[] = [
  {
    id: 'coingecko',
    hosts: ['api.coingecko.com', 'pro-api.coingecko.com'],
    rateLimit: { capacity: 10, refillPerSec: 0.5 },
    requiresEnv: [],
  },
  {
    id: 'dexscreener',
    hosts: ['api.dexscreener.com'],
    rateLimit: { capacity: 5, refillPerSec: 1 },
    requiresEnv: [],
  },
  {
    id: 'defillama',
    hosts: ['api.llama.fi'],
    // Raised from the M1 placeholder {capacity: 5, refillPerSec: 1} in TASK-007 (R-66). That value
    // was OUR brake, not the vendor's: the vendor publishes no numeric limit at all, and a live
    // cache-busted probe took 40 CONCURRENT origin requests with 40/40 HTTP 200 and zero 429s. At
    // 5/1 a ten-chain sweep — the DoD this capability was built against — spent ~5s asleep in our
    // own limiter, and a wide sweep would cross the 30s MAX_WAIT_MS fairness cap and start throwing.
    rateLimit: { capacity: 10, refillPerSec: 5 },
    requiresEnv: [],
  },
  // interface/config stub — isAvailable() returns false unconditionally (see below):
  {
    id: 'dune',
    hosts: ['api.dune.com'],
    rateLimit: { capacity: 2, refillPerSec: 0.1 },
    requiresEnv: ['DUNE_API_KEY'],
  },
  {
    id: 'rpc-evm',
    hosts: ['ethereum-rpc.publicnode.com', 'eth.drpc.org'],
    rateLimit: { capacity: 5, refillPerSec: 1 },
    requiresEnv: [],
  },
  {
    id: 'rpc-solana',
    hosts: ['api.mainnet-beta.solana.com'],
    rateLimit: { capacity: 5, refillPerSec: 1 },
    requiresEnv: [],
  },
  // No live host: interface + fixture contract only. Hosts get filled in when the deferred live
  // gRPC transport lands (§11):
  { id: 'dash-platform', hosts: [], rateLimit: { capacity: 5, refillPerSec: 1 }, requiresEnv: [] },
  {
    id: 'platform-explorer',
    hosts: ['platform-explorer.pshenmic.dev'],
    rateLimit: { capacity: 5, refillPerSec: 1 },
    requiresEnv: [],
  },
  // Not an HTTP host: the Postgres wire protocol. The DSN itself is the access control, not a
  // hostname allowlist. `hosts: []` is therefore empty by nature, not by omission.
  // **`rateLimit` is APPLIED since WI-34 (2026-08-05)** — this comment used to end "registered here
  // SOLELY for the providers FK (§4.2)", which read the whole row as decorative and was true of the
  // rate limit for as long as no code called the limiter. `pg-history.fetch()` now awaits
  // `throttle('pg-history', RATE_LIMIT, 1, deadlineAtMs)`, and that wait contributes 30_000 to the
  // E-PG envelope the two `*.history` deadlines are derived from. The pool's `max: 3` bounds
  // CONCURRENCY, which is a different quantity and never was this limit.
  // **T-013 task 013-6 re-derived the bucket** from `{capacity: 2, refillPerSec: 0.2}` when merge
  // was activated on the two `*.history` routes. The old pair was sized for a spare leg that the
  // merge walk stopped being: every merged cache-miss now takes a token, and one token per five
  // seconds capped both merged capabilities together at ~12 calls/minute. `pg-history` is our own
  // Postgres — no vendor quota to respect — so the limiter is a runaway guard, not a contract.
  {
    id: 'pg-history',
    hosts: [],
    rateLimit: { capacity: 10, refillPerSec: 5 },
    requiresEnv: ['ONCHAIN_PG_URL'],
  },
  // R-73 (TASK-008). ONE host. The two-host design this comment used to describe was reverted in
  // adversarial cycle 1 — the direct `api.blockscout.com` enforces auth (402 with no key) and
  // `token.holders` has no fallback adapter, so on a stock install it was advertised on 39 chains
  // and served on none. The stale host then survived in the allowlist on the argument that it
  // "costs nothing"; vdd-multi removed it, because `safeFetch` re-checks every REDIRECT hop against
  // this list, so an allowlisted host we never call is still a host a misbehaving facade can bounce
  // us to — and here the allowlist is the only egress control there is.
  //
  // `requiresEnv` stays EMPTY on purpose: the facade answers without a key today, so demanding one
  // would disable a working capability. The key is read inside fetch(), like COINGECKO_* — after
  // the cache key is derived, so it can never enter it.
  // `refillPerSec: 2`, not the 5 R-73(b) prescribed: DEFENSIVE, not measured. The vendor sends no
  // `RateLimit-*` header at all, so there is nothing to calibrate against, and the thing that runs
  // out is CREDITS, not requests — `get_address_info` fans out to three upstreams (~160 credits of
  // 100K/day ⇒ a ceiling near 625 calls/day), which 5 RPS would burn in ~125 seconds.
  {
    id: 'blockscout',
    hosts: ['mcp.blockscout.com'],
    rateLimit: { capacity: 5, refillPerSec: 2 },
    requiresEnv: [],
  },
  // R-81 (TASK-009) — keyless, no account, no secret of any kind. ONE host: `blockchain.info` and
  // `api.blockchain.info` were measured to serve `/q/*` and `/stats` identically (2026-07-29), so a
  // second entry would widen the redirect-hop allowlist (the L-4 lesson from `blockscout`) and buy
  // nothing. The limiter is defensive for the same reason as `blockscout`'s: no `RateLimit-*`, no
  // `Retry-After`, no documented number — five rapid probes returned 200 and that is ALL we know.
  {
    id: 'blockchain-info',
    hosts: ['blockchain.info'],
    rateLimit: { capacity: 5, refillPerSec: 1 },
    requiresEnv: [],
  },
];
```

> **M8 (fixed, T-012):** the fence around `adapterRegistrations` above and the one below the nansen
> registration snippet (`_Registration (…the tenth entry):_`) were previously a single mismatched
> pair. A stray 4-backtick line opened here with no matching 3-backtick close. It silently swallowed
> everything up to the next 4-backtick line (the nansen snippet's own closing fence) into ONE inert
> code block. The "Chain scoping" paragraph, the twelve-adapter table, all per-adapter hardening
> notes, and the blockscout/nansen narrative never rendered as prose. A parity check that only
> counts fence lines reported "balanced" here, because the total number of fence lines was even.
> Counting lines is not a substitute for checking that each OPEN pairs with a close of the SAME
> backtick count. Pre-existing (found at HEAD, not introduced by this task), fixed here because
> T-012 is the task already editing these exact lines.

**Chain scoping is a derived value, not a literal.** `CapabilityRoute` carries no chain field at all
(OQ-C, ADR-002 D2 — the field's fate is settled above) — it is never the authority on which chains a
capability serves. The registry resolves the chain, and `covered(capability, chain)` (§4.2.3)
composes the route with the adapter's `chainSupport()` predicate over `ChainInfo` — that composition
is the coverage matrix. A hand-kept list would have to track 458 registry rows; a predicate cannot
drift from them.

Rate-limit values are conservative starting points (not vendor-documented limits, except for the
Dune credits) and can be tuned by editing the config, with no change on the calling side (R-4).

**The adapters — summary.** Nine from M1, `nansen` from M2, `blockscout` from TASK-008,
`blockchain-info` from TASK-009 — **twelve registered, of which eleven serve something**: `dune`
remains a config stub whose `isAvailable()` is unconditionally `false`.

| id                  | Capabilities                                                   | Transport                                                                                                            | Key                                                                                                                    | Note                                                  |
| ------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `coingecko`         | `token.price`, `token.metadata`                                | REST (`fetch`), `/coins/{platform}/contract/{address}`                                                               | optional `COINGECKO_API_KEY` (demo; free works without) / `COINGECKO_PRO_API_KEY` (Pro circuit: pro host + pro header) | R-5, **live**                                         |
| `dexscreener`       | `pairs.active`, `pool.info`, `token.pools`                     | REST (`fetch`)                                                                                                       | none (keyless)                                                                                                         | R-6 Must requires the first two; note below; **live** |
| `defillama`         | `protocol.tvl`, `chain.tvl`, `dex.volume.history`              | REST (`fetch`), `/protocols`, `/v2/chains`, `/overview/dexs/{chain}`                                                 | none (keyless)                                                                                                         | R-7, R-53, **R-61 (TASK-007)**, **live**              |
| `dune`              | **none** (config stub; `token.holders` moved away in TASK-008) | REST Query API — **not implemented** (interface/config stub)                                                         | `DUNE_API_KEY` (free tier), but `isAvailable()` is unconditionally `false`                                             | R-8, decision below; note below                       |
| `blockscout`        | `token.holders`, `entity.labels`                               | REST (`fetch`), the **facade** `mcp.blockscout.com/v1/<tool>` for both — the two-host design was reverted, see below | optional `BLOCKSCOUT_PRO_API_KEY`, passed as the **`apikey` query parameter** (not a header)                           | **R-73..R-80 (TASK-008)**, **live**                   |
| `blockchain-info`   | `chain.supply` (bitcoin only)                                  | REST (`fetch`), `/stats` + `/q/totalbc`                                                                              | **none, and none possible** — the vendor offers no key for these surfaces                                              | **R-81..R-87 (TASK-009)**, **live**                   |
| `rpc-evm`           | `wallet.balances.native` (EVM)                                 | JSON-RPC `eth_getBalance` (`fetch`)                                                                                  | none (keyless)                                                                                                         | R-16/R-17, **live**                                   |
| `rpc-solana`        | `wallet.balances.native` (Solana)                              | JSON-RPC `getBalance` (`fetch`)                                                                                      | none (keyless)                                                                                                         | R-16/R-17, **live**                                   |
| `dash-platform`     | `privacy.shielded_pool`, `platform.*`                          | **gRPC** — **not implemented** (interface + fixture contract only)                                                   | none (keyless), but unreachable                                                                                        | R-9 via a mock; see below                             |
| `platform-explorer` | the same (fallback) + `*.history`                              | REST (`fetch`)                                                                                                       | none (keyless)                                                                                                         | R-10/R-11, **the only live Dash source**              |
| `pg-history`        | `privacy.shielded_pool.history`, `platform.metrics.history`    | Postgres wire (SELECT-only)                                                                                          | `ONCHAIN_PG_URL` (optional)                                                                                            | R-12, **live, optional**                              |

**Notes carried over from the table.**

- **`dexscreener`** — `pool.info` and `token.pools` gained their tools in task 014-32b
  (`interfaces.md` §5.1.7/§5.1.8).
- **`dune`** — until TASK-008 it _declared_ `token.holders` while covering zero chains — an
  advertised capability that answered nowhere.

**Input/response hardening per adapter — never trust a raw vendor response.**

- `rpc-evm`: the hex guard is `/^0x[0-9a-fA-F]+$/`, requiring at least one hex digit after `0x`.
  A bare `"0x"` otherwise produced a raw `BigInt("0x")` `SyntaxError` instead of a legible error.
- `rpc-solana`: `result.value` (lamports) is validated as a non-negative safe integer
  (`Number.isInteger && >=0 && <=Number.MAX_SAFE_INTEGER`) before `String()`. Documented default:
  a balance above ~9.007M SOL has already lost precision at `response.json()`. The vendor returns
  `result.value` as a JSON number, not a hex string as `eth_getBalance` does. So exact parsing of
  large values is out of scope here.
- `dexscreener.normalize()`: skip-and-log. Each candidate `Pool` is validated independently
  (`PoolSchema.safeParse`); a malformed one is dropped rather than failing the whole batch, with a
  single stderr line carrying the count. It throws only when **every** candidate in the batch is
  malformed — otherwise an empty `Pool[]` would be indistinguishable from "there are no new pairs
  right now" (R-24).
- `defillama.normalize()`: rejects non-finite/negative `tvlUsd`/`totalTvlUsd` **before** it reaches
  the cache; otherwise `onchain_protocol_tvl`'s own `.nonnegative()` schema would meet an already
  cached broken value.
- `defillama.normalize('dex.volume.history')` (TASK-007, R-68): **verifies the response's own `chain`
  echo field against the vendor name that was requested**, and refuses the response otherwise. This
  is not defensive decoration — it is forced by measured vendor behaviour. `/overview/dexs/{chain}`
  is name-tolerant (`op-mainnet`, `optimism` and `OP Mainnet` all return the same document). An
  unknown chain answers **HTTP 500**, not 404. A chain outside the vendor's own `allChains` list
  answers **HTTP 200 with zeros and a narrower key set** (`litecoin`, probed 2026-07-27). Without the
  echo check, "the vendor served a different chain than we asked for" and "this chain has no volume"
  are the same observation. The same normalize step rejects non-finite/negative volumes and
  non-integer timestamps before the cache write, and passes **no vendor free text through at all**.
  The document carries 151 protocol cards with `name`/`category`/`methodology`/`logo`, which are
  third-party-editable strings, and none of them reach the tool output.

  **That last rule holds on the ERROR path too, which is where it was first broken** (adversarial
  cycle 3). A `normalize()` throw becomes `tried[].reason` inside `CapabilityUnavailableError` and
  from there the tool's `isError` text. It lands in the model's context, and because `normalize()`
  failures are negative-cached it is replayed for the whole negative TTL with no further network
  traffic. The first version interpolated the vendor's value verbatim into three
  such messages, bounded only by the 2 MB body cap. Vendor values are now **described, never
  echoed** (`string(length=N)`, `array(length=N)`, or the number itself — a number cannot carry
  instructions), which is the discipline `stringifyTruncated` and `UnknownChainError` already
  encoded elsewhere in this codebase.

- Both RPC adapters truncate error messages through the shared
  `src/adapters/stringify-truncated.ts` (500 characters + `…[truncated]`), so a raw JSON-RPC
  envelope cannot land in `Error.message` in full, up to `safeFetch`'s 10MB cap.

- `blockscout.normalize()` (TASK-008, R-76): the vendor ships fields **addressed to a language
  model**, so the response passes through a mandatory sanitizer before anything else looks at it.
  This is a stronger requirement than the `defillama` rule above, and for a different reason: there
  the risk was third-party-editable strings that _happen_ to reach a model; here the vendor
  **intends** them to. `get_address_info` returns `instructions` — measured 2026-07-28 as seven
  imperatives of the form "This is only the native coin balance. **You MUST also call**
  `get_tokens_by_address`…", with the caller's own address interpolated verbatim — alongside `notes`
  and `data_description`. These three are **dropped, never truncated**: a truncated instruction is
  still an instruction. Label text that we do keep (`tags[].name`, `meta.main_entity`, `slug`) goes
  through `truncate-vendor-text`. The URL-valued fields (`tooltipUrl`, `tagIcon`,
  `tooltipAttribution`) are not emitted at all, since a URL in a model's context is a fetch
  suggestion.

- `blockchain-info.normalize()` (TASK-009, R-84/R-85): the vendor's two supply surfaces are **two
  different quantities, both correct**, and the adapter's job is to keep them from being mistaken
  for one another. Measured 2026-07-29 by a test that settles it without appeal — how many whole
  block subsidies fit between the value and the halving boundary at block 840 000:

  | surface          | subsidies past the boundary | therefore                                             |
  | ---------------- | --------------------------- | ----------------------------------------------------- |
  | `/stats.totalbc` | `120102` — **integer**      | the halving formula itself ⇒ **theoretical emission** |
  | `/q/totalbc`     | `120092.8` — **fractional** | cannot be the formula ⇒ **actually-claimed supply**   |

  The gap (28.75–31.88 BTC, ~0.00016%) is coinbase subsidy miners never claimed. A stale copy of the
  formula would sit at an INTEGER offset; a fractional one cannot. So `emission` and `circulating`
  are separate fields with separate names, and `normalize()` enforces the consensus invariant
  **`circulating ≤ emission`** — you cannot claim more than the subsidy — refusing the response
  rather than serving a number it cannot justify.

  Values are carried as **satoshi strings** through `bigint`, never `number` (DB-SCHEMA §1.7). They
  fit a double _today_, which is exactly the reasoning that rots: the rule is that the value is an
  exact integer, not that it currently happens to be small enough.

**Verifying supply against the formula is a TAUTOLOGY — the height is what carries information.**
This is the load-bearing insight of TASK-009 and the reason its cross-check is shaped the way it is.
`consensusEmission(n_blocks_total) === totalbc` held **bit-exactly at both probed heights**, and it
will keep holding for as long as the vendor computes the field the same way we do. A check must have
an input on which it fails, and `consensusEmission(n_blocks_total) === totalbc` has none. What a
second source can genuinely contradict is the **block height**. So the eval compares our answer's
height against `mempool.space` and lets the deterministic formula propagate that into supply
(§5.1.5). The delta is expressed in **blocks of subsidy, never percent**. One block is 0.000016%, so
an off-by-one and a full day of vendor staleness (144 blocks, 0.0023%) both round to "zero" on any
percentage scale a human would pick.

**Two hosts measured, one host used (TASK-008).** The vendor exposes the same data through two
hosts with materially different properties. The measurement below is what made the choice, and it is
kept because the rejected branch is the one a future reader will be tempted to re-propose:

|                        | `api.blockscout.com/<chain_id>/api/v2/…`                  | `mcp.blockscout.com/v1/<tool>`                        |
| ---------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| auth                   | enforced — real key 200, bogus **401**, absent **402**    | ignored (grace period; a bogus key still returns 200) |
| address labels         | **absent** (`metadata: null` even for Binance Hot Wallet) | present (`data.metadata.tags[]`)                      |
| `instructions`/`notes` | absent                                                    | present                                               |
| upstream cost          | one                                                       | fans out to three (~160 credits)                      |

Both capabilities use the **facade**. Holders were briefly routed to the direct host (cheaper, no
injection wrapper, key verifiable) until adversarial review pointed out the consequence. That host
answers **402 without a key**, `token.holders` routes to `['blockscout']` alone with nothing to
degrade to, and a stock install ships no key. So the capability was advertised on 39 chains and
served on none, which is the very defect this task removed from `dune`. Labels have no alternative
in any case: the enrichment is exactly what the three-way fan-out buys. The expensive path and the
useful path are the same path; that is the trade, and it is why the ~625 calls/day ceiling (not
~5 000) is a design input rather than a footnote.

**The key travels in the URL, which D10 forbids for logs and cache keys.** `apikey` is a query
parameter, not a header. This is the case `rpc-solana` anticipated when it chose to report
`hostOf(endpoint)` instead of the full URL, "because a curated endpoint could one day carry a key in
its path or query". That day arrived. Consequences, each of which is a test rather than an
intention. The full URL never reaches `Error.message`, stderr, or the cache key. The cache key is
derived from `(provider, capability, normalizedArgs)` and the key is not an arg. `safeFetch`'s own
error path already reports host-only.

**Coverage is keyed on the numeric `chain_id`, never on `ecosystem` or chain name.** The vendor's
`get_chains_list` carries an `ecosystem` field that reads like a family and is not one:
`ecosystem: "Solana"` is Neon (an **EVM** chain, id 245022934) and `ecosystem: "Bitcoin/BCH"` is
Rootstock (an **EVM** sidechain, id 30). All 100 ids are numeric, i.e. the whole list is EVM.
Mapping `ecosystem → family` would advertise `svm`/`utxo` coverage that does not exist — the H-1
defect class from TASK-006, and the same over-claim `dex.volume.history` was built to avoid. The
generated coverage list also drops the 47 testnets.

**`dash-platform` is narrowed to an interface + fixture contract.** A live gRPC transport is the
most expensive and least repaid item on the critical path. No tool consumes it (OQ-2 below), the
evonode host is unverified (§11), and `privacy.shielded_pool`/`platform.*` are already fully
covered by `platform-explorer` (keyless REST). So: `capabilities()` declares all five capabilities
(`privacy.shielded_pool` + `platform.identities/contracts/documents/credits`, R-9). `normalize()`
is implemented and golden-tested against a **hand-built** fixture whose shape is taken from the
addendum fields (`getShieldedPoolState`/`getTotalCreditsInPlatform`) — R-9 satisfied through a mock,
not a live probe. `fetch()` is a stub (`NotImplementedInM1Error`) and is unreachable at runtime
because `isAvailable()` cuts the adapter off earlier. `isAvailable()` **unconditionally** returns
`{ ok: false, reason: 'dash-platform live transport deferred — see backlog, use platform-explorer' }`
— not "if the evonode is down", always — so the Registry **always** routes
`privacy.shielded_pool`/`platform.*` to `platform-explorer`. That is not a simulated hot-swap kept
around for show but a real, permanently active fallback path that exercises the Registry mechanism
(R-11) on every run. The live gRPC transport is a separate backlog item (§11): vendoring the
`.proto`, `@grpc/grpc-js` + `@grpc/proto-loader`, a concrete evonode host (live probe), and a
channel-level `assertAllowedHost()`. When it lands, `isAvailable()` becomes a conditional check
without changing the `ProviderAdapter` contract outward.

**`platform-explorer` is the only live Dash source.** It implements the same capability surface as
`dash-platform` (REST, keyless, always available) **and** its own history method (R-10) — used
first on the history routes (`privacy.shielded_pool.history`/`platform.metrics.history` above), not
only as a fallback for live state.

**dash-platform / platform-explorer / dune get no tool of their own (OQ-2).** The ROADMAP names
exactly four MCP tools for M1, none of them about Platform metrics or holder statistics. The
Registry registers the capabilities and covers them with contract tests where they exist (R-9/R-10/
R-11 via `platform-explorer` + the `dash-platform` mock). The first real **consumer** tool for
Platform metrics arrives in M3 (privacy rules), and for `token.holders` in M2
(`onchain_token_risk`).

**`dune` — the R-8 resolution: an interface/config stub, narrower than the literal acceptance
text.** `capabilities()` declares `token.holders` (holder count + top-10 concentration — a
capability none of the other eight M1 adapters covers). The adapter does **not** implement
`fetch()`/`normalize()` (fixture-less — there is nothing to golden-test before the query is
authored). `isAvailable()` returns `{ ok: false, reason: 'dune query authoring deferred to M2' }`
unconditionally, regardless of `DUNE_API_KEY`. Authoring a live Dune SQL query (query id,
parameterization) moves to M2 together with its first real consumer (`onchain_token_risk`). None of
the four Must tools depends on `token.holders`, so an empty `.env` stays fully functional (UC-1)
regardless of this decision.

**ERC-20/SPL balances are out of scope.** `onchain_wallet_balances` fills only `assetType: 'native'`
(native ETH/SOL through `rpc-evm`/`rpc-solana`). Token balances require one of three things. The
first is per-contract `eth_call`/`getTokenAccountsByOwner` over an unbounded set of contracts, which
needs a source of "which tokens to check" — not a trivial question at $0. The second is an
indexer/multicall service (usually paid, or not reliable enough keyless). The third is Dune (credits
plus latency). R-17 acceptance stops at "the contract is fixed, ≥2 chains actually work", which the
native balance closes cheaply. `BalanceSchema` already carries `assetType`/`contractAddress`
precisely so that M1.5/M2 can add ERC-20/SPL **without** a schema change — only by appending rows to
the `balances` array. Recorded as a backlog work item.

**The tenth adapter (M2, TASK-005 `m2-alpha-paid`, R-29/R-30): `nansen`, the first paid adapter.**
Three capabilities — `smart-money.flows`, `entity.labels`, `token.risk` — over the REST API at
`api.nansen.ai`, **not** through Nansen's official MCP server (`mcp.nansen.ai/ra/mcp`, 37 tools;
owner decision, TASK.md §1.2). Several of its tools return markdown text, which is unusable for
canonical zod normalization (D5), and proxying would bypass our own cache, budget and SSRF gate.
The only sources for response shape and price are `nansen-probe-2026-07-23.json` (a live `/account`
call plus `credit_cost_table`) and `nansen-openapi-2026-07-23.json` (75 paths, request/response
contracts); TASK.md §7 forbids inventing anything beyond them.

_Registration (`providers.config.ts.adapterRegistrations`, the tenth entry):_

```ts
{
  id: 'nansen',
  hosts: ['api.nansen.ai'],
  // The same conservative start already used by five of the nine M1 adapters (dexscreener/
  // defillama/rpc-evm/rpc-solana/platform-explorer) — knowingly below ALL four vendor-documented
  // thresholds (ratelimit-limit: 15/window unconfirmed, -second: 150, -minute: 3000,
  // -credit-fails-minute: 10), whichever way the unconfirmed "15" window is read (R-29).
  rateLimit: { capacity: 5, refillPerSec: 1 },
  requiresEnv: ['NANSEN_API_KEY'],
},
```

_Authentication:_ the header is `apiKey: <NANSEN_API_KEY>`, **not** `Authorization: Bearer` (probe:
`auth.scheme: 'apiKey', in: 'header', name: 'apiKey'`). The MCP endpoint is the one that uses
`Authorization: Bearer <key>`; REST does not, and the two are easy to confuse. Every endpoint used
except `GET /api/v1/account` is a `POST` with a JSON body (confirmed by both the probe and the
openapi paths) — the same `fetch()` shape as `rpc-evm`'s JSON-RPC POST:
`{method:'POST', headers:{'content-type':'application/json', apiKey}, body: JSON.stringify(...)}`.
The fixture recorder (R-44, an extension of `record-fixture.mjs`) must serialize the request body,
not only the query string.

_The three routes M2 introduced (`providers.config.ts.routes`), shown in their CURRENT form — two
still have no fallback because there is no free equivalent (R-30), and `entity.labels` acquired one
in TASK-008:_

```ts
{ capability: 'smart-money.flows', adapterIds: ['nansen'] },
{
  capability: 'entity.labels',
  adapterIds: ['blockscout', 'nansen'],
  policy: { kind: 'someElementHasAny', fields: ['name', 'tags', 'labels'] },
},
{ capability: 'token.risk', adapterIds: ['nansen'] },
```

Two things changed after M2 and are shown above rather than in their M2 form. The route-level chain
field these three routes once carried is **gone** — coverage moved into `chainSupport()` in
TASK-006, and the paragraph below is what replaced them. And `entity.labels` is no longer paid-only:
TASK-008 put the free `blockscout` in front of `nansen`, with a route-level policy so that an EMPTY
free answer does
not end the walk. "No fallback adapter — there is no free equivalent (R-30)" therefore holds for two
of the three, not all three.

**Paid chain scope is derived, not enumerated.** The three routes were introduced with the same
`ethereum`+`solana` subset as M1. The vendor's own chain enumerators disagree with each other.
`SmartMoneyChain` lists 17 chains and `TGMHoldersChain`/`TGMChain` 24 each. The "~32 chains" of the
probe's `supported_chains_mcp` belongs to the out-of-scope MCP surface. No vendor list could
therefore be trusted as the definition of coverage. Coverage is now computed instead of enumerated:
the `nansen` adapter's `chainSupport()` composes the registry with the recorded `CoverageProbe`
(§4.2.3). With the paid address-family gate applied (§3.2.1) it resolves to **16** chains for
`smart-money.flows` and **18** each for `entity.labels` and `token.risk`. An unprobed chain is
reported as `unverified`, never as `unsupported` (R-58d).

_**Cost-table generation — the backbone of `costOf()` (R-37).**_ The
`(method+path, plan) → {free,pro}` table is generated **from the committed**
`nansen-openapi-2026-07-23.json`, whose `x-credit-cost` per-operation extension is present on all 74
operations of the spec. Determining a price therefore spends no credits. The mechanism is a
**committed `.ts` module generated by a dev script**, not runtime JSON parsing and not build-time
codegen in CI:

```ts
// packages/core/scripts/generate-nansen-cost-table.mjs — a manual dev script (like
// record-fixture.mjs, OUTSIDE CI): reads x-credit-cost from nansen-openapi-<date>.json and writes
// packages/core/src/adapters/nansen/cost-table.ts — a literal, committed and git-diffable, so a
// vendor price drift shows up as an ordinary diff on the next regeneration instead of hiding in a
// binary or a cache.
export const NANSEN_COST_TABLE: Readonly<Record<string, { free: number; pro: number }>> = {
  'GET /api/v1/account': { free: 0, pro: 0 },
  'POST /api/v1/smart-money/netflow': { free: 5, pro: 5 },
  'POST /api/v1/tgm/holders': { free: 5, pro: 5 },
  'POST /api/v1/search/general': { free: 0, pro: 0 },
  'POST /api/v1/search/entity-name': { free: 0, pro: 0 },
  'POST /api/v1/profiler/address/labels': { free: 100, pro: 100 },
  'POST /api/v1/tgm/indicators': { free: 5, pro: 5 },
  'POST /api/v1/tgm/token-information': { free: 1, pro: 1 },
  // Only the ~8 endpoints M2's 3 capabilities actually call — NOT all 74 (out of scope, TASK.md §4).
};
```

A committed `.ts` (rather than a `resolveJsonModule` import of the `.json`, or fetching the spec at
runtime) matches the style of `providers.config.ts` — declarative literals regenerated by editing a
file. It avoids `resolveJsonModule`/import-attributes friction under NodeNext ESM (`core` builds
with plain `tsc`, §6.1). It keeps the artifact human-readable and reviewable in a PR diff.

The `nansen` adapter's own `costOf(cap, args)` maps a capability to a fixed list of `(method, path)`
pairs and **sums** their prices under the live `plan` (account state below). The `ProviderAdapter`
method has existed since M1, where all nine adapters trivially return `{credits: 0}`; `nansen` is
the first to implement it for real. This is not an estimate — it is exactly the number that will be
charged:

| Capability                                                          | HTTP calls (method + path)                                                 | `costOf()`               |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------ |
| `smart-money.flows`                                                 | `POST /smart-money/netflow` + `POST /tgm/holders` (always both, R-41)      | **10** (5+5, both plans) |
| `entity.labels`, default (`query` only)                             | `POST /search/general` [+ `POST /search/entity-name`]                      | **0**                    |
| `entity.labels`, token-scoped (`tokenAddress`, `exhaustive: false`) | + `POST /tgm/holders`                                                      | **5**                    |
| `entity.labels`, `exhaustive: true`                                 | **only** `POST /profiler/address/labels` (does not repeat the cheap path)  | **100**                  |
| `token.risk`                                                        | `POST /tgm/indicators` + `POST /tgm/token-information` (always both, R-43) | **6** (5+1, both plans)  |

**An unknown `(method, path)` makes `costOf()` return `Number.POSITIVE_INFINITY`, never `0`** (R-37
MIN-3 — literally the second option of the requirement, "refuse / infinite price"): protection
against future spec drift, where a regeneration loses a key. With the current hand-picked
capability→endpoint map it should never fire. The gate checks `Number.isFinite(cost)` **before**
touching `BudgetStore` or the network, so `Infinity` never reaches a SQLite parameter — there would
be nothing to bind.

_**Account state — the shared basis for `costOf()`'s live plan and for the budget ceiling
(OQ-1).**_ `ProviderAdapter.costOf()` stays **synchronous**. Breaking that signature for one adapter
would be a cross-package breaking change touching all nine M1 adapters. The live plan is therefore
read from a mutable state object that the adapter refreshes asynchronously **before** the
synchronous `costOf()` call:

```ts
// packages/core/src/adapters/nansen/account-state.ts
export interface NansenAccountSnapshot {
  plan: 'free' | 'pro';
  creditsRemainingAtObserve: number;
  usageAtObserve: number; // usage.credits_used(provider, dayBucketMs) in the SAME logical step as /account
  observedAtMs: number;
  dayBucketMs: number; // floor(observedAtMs/86400000)*86400000 — the bucket this snapshot serves
}
export interface NansenAccountState {
  get(): NansenAccountSnapshot | undefined; // undefined = never resolved (cold start)
  set(snapshot: NansenAccountSnapshot): void;
  markUnreconciled(): void; // R-38 — transport error / 402 after a reservation
  isUnreconciled(): boolean;
  clearUnreconciled(): void;
}
export function createNansenAccountState(): NansenAccountState {
  /* plain mutable object, in-memory */
}
```

**The initial value is the conservative `plan: 'free'`, not "unknown"/0.** The price table shows the
`free` price `>=` the `pro` price on **every** one of the eight endpoints used. The single
`free≠pro` pair in the whole 74-path table is `GET /search/token-sectors`, 1 vs 0, which M2 does not
call. So defaulting to `free` before the first resolve never over-spends the budget on any M2 path.
In the worst case it under-states the Pro plan's generosity by one credit on an unused endpoint —
the safe direction to be wrong in.

**When a resync happens** (`GET /api/v1/account`, 0 credits, same rate-limit bucket as any other
nansen call):

1. **Cold start** — `accountState.get()` returns `undefined` (never resolved in this process) **or**
   the snapshot belongs to a **previous** day bucket (`snapshot.dayBucketMs !==
floor(now/86400000)*86400000`). A new bucket starts with a mandatory zero-credit resync, not with
   an unverified carry-over of yesterday's remainder.
2. **Unreconciled** (`accountState.isUnreconciled()`) — the previous call left a reservation
   unreconciled: a transport error/timeout with no response (R-38) **or** a `402 Payment Required`
   (UC-6). Both use the same flag and the same recovery path, not two mechanisms.
3. **Otherwise, no resync.** `/account` is free in credits but not free in rate-limit slots and
   latency; resolving before every paid call would double the network round-trips for no functional
   gain on top of (1)/(2). Between resyncs the bucket ceiling is the remainder **fixed at the last
   snapshot** (formula below), not a live figure.

_**The bucket ceiling formula (OQ-1) — TWO separate conditions, not one `min()`.**_ Anchor the
remainder to `usageAtObserve`. Measure the vendor term against spend "since the anchor", not spend
"since the start of the bucket":

```
spentSinceAnchor = usage.credits_used(provider, bucket) - snapshot.usageAtObserve

allowed  ⟺  (spentSinceAnchor + costOf()) <= snapshot.creditsRemainingAtObserve            // vendor limit, anchor-relative
           ∧  (usage.credits_used(provider, bucket) + costOf()) <= (NANSEN_DAILY_CREDIT_CAP ?? Infinity)  // self-imposed cap, bucket-relative
```

**Both conditions hold simultaneously and measure different things** (anchor-relative vs
bucket-relative), so raw `creditsRemainingAtObserve` must **not** be collapsed into a `min()` with
`NANSEN_DAILY_CREDIT_CAP`. Collapsing them is only correct when the resync happens at the start of a
bucket, where `usageAtObserve` is implicitly `0`. Trigger (2) fires **mid-bucket**, when
`creditsRemainingAtObserve` already accounts for everything spent in this bucket. There
`usage.credits_used(bucket)` counts that same spend a second time — a double count, and that double
count is the error the formula exists to avoid.

`BudgetStore.checkAndReserve()` (interface below, under "Module `src/cache/*`") deliberately takes a
**single** scalar `ceiling`: it is provider-agnostic, knows nothing about anchors, and stays
D7-compatible. The two conditions **reduce algebraically** to one bucket-relative scalar — but only
after the vendor term is rebased onto `usageAtObserve`:

```
spentSinceAnchor + cost <= creditsRemainingAtObserve
⟺  usage(bucket) - usageAtObserve + cost <= creditsRemainingAtObserve
⟺  usage(bucket) + cost <= usageAtObserve + creditsRemainingAtObserve

effectiveCeiling = min( snapshot.usageAtObserve + snapshot.creditsRemainingAtObserve,
                        NANSEN_DAILY_CREDIT_CAP ?? Infinity )

allowed  ⟺  usage.credits_used(provider, bucket) + costOf() <= effectiveCeiling
```

**That is the only place where `min()` is legitimate.** Collapsing to
`min(creditsRemainingAtObserve, CAP)` without the rebase produces a phantom lockout (worked example
below). `effectiveCeiling` is the value the adapter computes from `NansenAccountSnapshot` and passes
as the fourth argument to `checkAndReserve(provider, bucket, cost, effectiveCeiling, velocity?)`;
`BudgetStore` compares it literally against `usage.credits_used(bucket) + cost` — a plain
bucket-relative comparison, with all anchor arithmetic already folded away outside the store. That
is the same R-35 separation documented elsewhere here: `BudgetStore` is a provider-agnostic ledger,
the live ceiling/anchor is a Nansen-specific concern of the caller.

**`/account` and the read of `usage.credits_used(provider, bucket)` for `usageAtObserve` are one
logical resync step** — both values are read back to back with no paid call in between and land in
**one** `NansenAccountSnapshot`. Otherwise the anchor itself could go stale before becoming part of
the snapshot.

On cold start, `usageAtObserve` at the bucket's first resync is whatever is already persisted in
`usage` — usually `0` for a new day, but **not necessarily** `0` when the process restarts
mid-bucket. The same formula handles that case correctly; it is not specific to the unreconciled
trigger.

**Worked example** (a real free/100cr account; `NANSEN_DAILY_CREDIT_CAP` unset ⇒ `Infinity`, so it
does not affect the `min()`):

| Step                                 | `usage.credits_used` | `creditsRemainingAtObserve`                      | `usageAtObserve`                              | `spentSinceAnchor` | `effectiveCeiling`                       | Outcome                           |
| ------------------------------------ | -------------------- | ------------------------------------------------ | --------------------------------------------- | ------------------ | ---------------------------------------- | --------------------------------- |
| Cold start, resync #1                | 0                    | 100                                              | 0                                             | 0                  | `0 + 100 = 100`                          | snapshot: remaining 100, anchor 0 |
| 5 calls × 5cr, all succeed           | 25                   | 100 (snapshot unchanged)                         | 0                                             | 25                 | 100                                      | allowed: `25+5 ≤ 100`             |
| 6th call — timeout before a reply    | 25                   | 100                                              | 0                                             | —                  | 100                                      | `markUnreconciled()`              |
| Next entry into the gate → resync #2 | 25                   | **75** (live remainder after the five 5cr calls) | **25** (`usage.credits_used` at that instant) | 0                  | **`25 + 75 = 100`** (not `75` — rebased) | snapshot: remaining 75, anchor 25 |
| 7th call, 5cr                        | 25                   | 75                                               | 25                                            | 0                  | 100                                      | allowed: `25+5 ≤ 100` → passes    |

In the timeout row, `usage` reads 25 as the settled fact: the reservation for the sixth call was
written separately and is reconciled later, not counted here.

With the formula collapsed to `min(creditsRemainingAtObserve, CAP)`, resync #2 would give
`ceiling = min(75, Infinity) = 75` — no rebase onto `usageAtObserve = 25`. The check `25+5 ≤ 75`
still passes on _that_ step. But the ceiling for every subsequent call is now understated by 25.
There were 75 **new** credits available on top of the 25 already spent, and the collapsed formula
sees only 75 in total, i.e. 50 new. As resyncs accumulate (timeouts, process restarts) each one
subtracts already-counted spend again, until the available remainder converges to zero long before
the account is physically exhausted. That is the exact phantom lockout that resync R-38 exists to
cure. With the rebased `effectiveCeiling` (`usageAtObserve + creditsRemainingAtObserve = 100`,
stable across resyncs for as long as the vendor remainder only moves through spend we already
counted), no resync eats accounted spend twice, however often it fires.

**`NANSEN_DAILY_CREDIT_CAP` is an optional self-imposed cap (OQ-5).** Read through `EnvSchema`
(empty/absent = no restriction, behaviour unchanged from the live-derived base — owner decision
TASK.md §1.1 is not violated, since the cap can only **narrow** the live ceiling, never widen it
past `credits_remaining`). A cheap, entirely optional latch for an operator worried about an agent
burning through a day's credits, with nothing added to the mandatory path.

_**Budget gate placement (OQ-2) — inside the adapter, not registry-generic and not a wrapper
object.**_ Not `CapabilityRegistry.resolve()`: the gate there would be Nansen-specific code inside a
universal component. The alternative to that is generic `BudgetStore`/`costOf()` plumbing in
`registry.ts`, touching all nine M1 paths for the sake of one paid one. Not the MCP tool handler
either: `CapabilityRegistry` owns the cache lookup, so a handler-level gate would inevitably run
**before** it, breaking the mandatory order of R-37/UC-5.

**The gate is an internal layer of the `nansen` adapter's own `fetch()` implementation**
(`packages/core/src/adapters/nansen/index.ts`). It sits precisely on the seam where
`CapabilityRegistry.resolve()` already calls `adapter.fetch(cap, args)` **after** a cache miss and
**before** `normalize()` (the seam is documented in `registry.ts`'s own docstring; it needs no
edits). This is not a wrapper object around an adapter — two exported constructors, one of which can
be registered ungated by mistake. The only publicly exported factory of the package is
`createNansenAdapter(deps): ProviderAdapter`, and singleflight/gate/reconcile are private steps
inside its `fetch()`.

**Non-bypassability is structural, not a convention.** The `adapters: Map<string, ProviderAdapter>`
that `CapabilityRegistry` is constructed with is the only place anything is registered under the key
`'nansen'` (all three M2 routes point at that same id). Raw, ungated primitives are **absent from
the package's public API** entirely: `src/index.ts` re-exports nothing but `createNansenAdapter`.
The internal helpers under `adapters/nansen/*.ts` are reachable only by package-internal code — the
tests in `packages/core/test/` and the `record-fixture.mjs` dev script,
which bypasses the gate deliberately and documentedly **while recording fixtures**, never in
production.

**A key invariant follows from that placement for free:** from
`CapabilityRegistry.resolve()`'s point of view, a gate refusal is **indistinguishable** from an
ordinary adapter network failure. Both are a `throw` out of `adapter.fetch()`, caught by the
**already existing** try/catch in `resolve()` and recorded in `tried`. Since none of the three M2
routes has a fallback adapter (`adapterIds: ['nansen']`, a single element), the loop ends
immediately with `CapabilityUnavailableError` → the tool returns `isError: true`. That is the
**same** R-24/R-40 path as "the key is not set", without a single line of change in `registry.ts` or
`resolve-capability.ts`. The M1 tests and the `_meta.cache` contract are untouched.
