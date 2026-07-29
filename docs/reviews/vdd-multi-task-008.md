# VDD Multi-Adversarial Report — TASK-008 `blockscout` free tier — iteration 1

**Target:** commit `0347fb0` (branch `task-008-blockscout-free-tier`), `--diff-only` vs `main` = 31 files.
**Invocation:** `/vdd-multi` (no flags) → `--scope=all`, fix loop ON, `--fail-on=none`, inline output.
**Date:** 2026-07-28.

## Summary

- **Critics run:** critic-logic, critic-security, critic-performance (parallel, one message, Layer A).
- **Model config:** all three on the wrapper default; `CLAUDE_CODE_SUBAGENT_MODEL` unset → overlap tag
  is **`corroborated`**, and per R3a same-mechanism agreement earns **no severity escalation**.
- **Evidence:** tests = RUN (`pnpm -r test` → 977 passed / 0 failed: core 770, mcp-server 207) ·
  scan = RUN (`run_audit.py packages/core/src/adapters/blockscout` → 13 findings: 1 critical,
  0 high, 12 medium).
  - Scan caveat recorded by critic-security and confirmed by the orchestrator: the `npm audit`
    sub-step **errored (ENOLOCK — this is a pnpm repo)**, so its `DEPENDENCIES: OK` is *not*
    evidence of a clean dependency tree. SBOM absent.
  - The scan's lone `[CRITICAL] exec() CWE-95 at index.ts:48` is a **false positive**
    (`RegExp.prototype.exec`); the `CWE-22` hits at lines 1–8 are `import` statements. Both critics
    that saw it said so independently.
- **Total issues (post-dedup): 41** — high 6 · medium 15 · low 20.
  Of these, **11 are corroborated** by ≥2 critics and **1 was escalated** on mechanism difference.
- **Convergence:** logic = `issues-found` · security = `issues-found` · performance = `issues-found`.
- **Verdict (per `--fail-on=none`): PASS.** Mechanically PASS because no threshold was set — *not*
  a clean bill. critic-logic returned its own verdict of **FAIL**; six findings are HIGH.

---

## Escalation ledger (Phase 2 rule 3)

| Location | Critics | Mechanisms | Ruling |
|---|---|---|---|
| `adapters/truncate-vendor-text.ts:19-28` | logic L-2, security M-3, performance M-3 | (a) code-point slice vs UTF-16 `.max()` → zod throws; (b) `Array.from` materializes the **entire** string before slicing | **Different mechanisms, same location → escalate +1** (MED → **HIGH**). Not paraphrases: (b) is a memory fault that occurs even when (a) never fires, and (a) fires on strings far too short for (b) to matter. [R3b] |
| all other overlaps (10) | 2–3 critics each | same mechanism | `corroborated` tag, severity = max, **no escalation** [R3a] |

---

## HIGH

### H-1 — An empty Blockscout answer terminates the `entity.labels` route `corroborated ×2`
`adapters/blockscout/index.ts:457-477` · logic HIGH-1 + performance M-1 · **content regression**

`normalizeLabels` does not throw on an empty tag set — it returns a well-formed `EntityLabel` with
`tags: []`, `labels: []`. `CapabilityRegistry.resolve()` (`adapters/registry.ts:299-314`) treats any
`normalize()` that *returns* as success: it writes the positive cache and stops. Fallback happens
only on a throw. So Nansen — the sole provider before this commit, and the holder of the CEX/fund
attributions — is never reached, and the empty answer is stored under
`ttlFor('entity.labels') = 3600` (`cache/ttl.ts:61`) and replayed for an hour per address.

This is **verbatim the failure the requirement names**, `docs/TASK.md:141-143`:
> «Провал: Blockscout отвечает «нет меток» и цепочка на этом останавливается, хотя Nansen ответил бы.»

It is the ordinary case, not the tail: the pinned `blockscout-addrinfo-2026-07-28.json` fixture is
**USDC** and its labels are empty; 40 of 50 rows in the holders fixture carry `metadata: null`.

The author's own asymmetry sets the standard — `normalizeHolders:394-399` explicitly refuses "to
report an empty holder list the vendor did not assert", on a route with *no* fallback, while
`normalizeLabels` does exactly that on a route that *has* a better provider queued behind it.

Performance adds the amplification half: the 3600 s TTL was justified at `cache/ttl.ts:57-61` by
"Nansen labels change on a timescale of DAYS" and "this is the 100cr call" — **neither premise
transfers** to a free provider's empty result.

**Aggravating:** `test/blockscout.transport.test.ts:215-227` *asserts* this behavior, so the defect
is pinned in place by a test whose fix is to invert it.

### H-2 — `query` is silently dropped whenever `tokenAddress` is also supplied
`adapters/blockscout/index.ts:259-288` · logic HIGH-2

`fetch()` reads `args['tokenAddress']` and `args['exhaustive']`; `args['query']` is never touched.
The tool contract allows both (`mcp-server/src/tools/entity-label.ts:49-85`) and Nansen honors both
(`adapters/nansen/index.ts:276-289`). Post-commit, `{query:'Wintermute', tokenAddress:'0xA0b8…'}`
is answered from the address alone and reported as `source:'blockscout'` — the caller gets no
signal that half the request was discarded. `deriveArgsHash` includes `query`
(`net/args-hash.ts:44-47`), so the wrong-scope answer is cached per query string and replayed.

Silent narrowing is the one option that should be off the table: the decline shape already exists
15 lines above for `exhaustive` (`index.ts:276-282`).

### H-3 — Every holder row is fully processed, then 99.6 % are discarded `corroborated ×2`
`adapters/blockscout/index.ts:335-389` (slice at `:411`), `:190` · performance H-2 + security L-7

`items.flatMap(...)` walks **every** row the vendor sent — running a regex and a **keccak-256 plus a
40-element `Array.from().map().join()`** (`chain/address.ts:31-40`) per surviving row — and only then
`slice(0, 50)`. The sole bound on `items` is `safeFetch`'s **10 MB default**, which this adapter
declines to narrow. At the fixture's ~800 B/row that is ~12 000 rows → 12 000 keccak hashes, a full
sanitizer deep copy of all of it, tens of MB of churn on a single-threaded stdio server — to keep 50.

Fix is two lines (`const page = items.slice(0, HOLDERS_PAGE)` **before** the flatMap) plus
`maxResponseBytes: 512 * 1024`. The real payload is ~40 KB; a 10 MB ceiling on a 40 KB endpoint is
not a cap.

### H-4 — The declared limiter is ~690× the quota the task itself documents `corroborated ×2`
`providers.config.ts:167`, `adapters/blockscout/index.ts:225` · performance H-3 + security M-4

Three problems stacked in one registration:

1. **No measurement behind the number.** `rateLimit: {capacity: 5, refillPerSec: 5}` traces to
   R-73(b), which *prescribes* it. `docs/TASK.md §1.2` records that the vendor **sends no rate-limit
   headers** and no quota was probed. Compare `defillama` (`:119-146`, a documented 40-concurrent
   live probe) and `nansen` (`:205-221`, four named vendor thresholds).
2. **One throttle token ≠ one upstream request.** `TASK.md §1.2` measures `get_address_info` as a
   **3-way fan-out ≈160 vendor credits**. `.env.example:77-79` puts the ceiling at **≈625 calls/day**
   of a 100 K/day budget. The limiter permits 5 rps = **432 000 calls/day**; the whole daily quota
   burns in ~125 seconds. Nansen already models this (composite capabilities burn 2–3 tokens).
3. **`costOf: () => ({credits: 0})` means nothing is accounted** — no `usage` row, no budget gate.
   When the grace period ends (OQ-1: «он кончится молча»), the first symptom is 402s on the hot path.

Degradation is wrong in **opposite** directions on the two routes: a saturated bucket on
`entity.labels` throws → `registry.ts:295` → **falls through to paid Nansen** (overloading the free
provider silently starts spending money); on `token.holders` the route is blockscout-only, so the
same condition is a hard `CapabilityUnavailableError`.

> **Needs an owner decision** — the value is mandated by R-73(b) (`docs/TASK.md:121`); changing it
> contradicts an accepted Must.

### H-5 — A 45 s adapter placed in front of a 75 s adapter, with no per-request deadline
`providers.config.ts:84`, `adapters/blockscout/index.ts:180`, `:190` · performance H-1

`request()` awaits `throttle(...)` (up to `MAX_WAIT_MS = 30_000`, `net/rate-limit.ts:32`) then
`safeFetch(...)` with **no options**, inheriting `DEFAULT_TIMEOUT_MS = 15_000`. That is 45 s of
worst-case wall time per blockscout attempt, and the route walk is **sequential**
(`adapters/registry.ts:230`). `entity.labels` went from a ~75 s worst case to **~120 s**, on a
single-threaded stdio server with no whole-call deadline in `resolve()`. The MCP client will have
abandoned the request long before; the server keeps grinding for the ghost.

### H-6 — `truncateVendorText` is broken in two independent ways `ESCALATED +1` `×3 critics`
`adapters/truncate-vendor-text.ts:19-28` → call sites `blockscout/index.ts:443`, `sanitize.ts:142-143`
· logic L-2 + security M-3 + performance M-3

**Mechanism (a) — wrong unit.** It slices 256 **code points**; `types/token-holders.ts:29` and
`types/entity-label.ts:34-36` cap 256 **UTF-16 code units** (zod measures `input.length`). 300 astral
characters → truncated to 256 code points = **512 units** → `parse()` throws. The helper's docstring
claims it "keeps the schema caps unreachable"; for non-BMP text it does not.

Consequences, both new in this commit: `token.holders` (blockscout-only route) **fails outright and
is negative-cached** (`registry.ts:315-333`) — one attacker-labelled address in a token's top-50
disables holder lookups for that token for the whole negative TTL; `entity.labels` **escalates to
paid Nansen**, so an attacker who can attach a label (Blockscout ingests OLI attestations and
user-submitted public tags) chooses when we spend credits.

**Mechanism (b) — full materialization.** `Array.from(value)` walks the **entire** string before
slicing. Nothing bounds the input: `readString` (`sanitize.ts:105-108`) checks only
`typeof === 'string' && length > 0`. A 1 MB `name` becomes a 1 M-element array (~8 MB of backing
pointers) to produce 256 characters.

Fix for both: `Array.from(value.slice(0, maxLength * 2)).slice(0, maxLength).join('')` — a code point
is at most 2 UTF-16 units, so the `2×` window provably contains the first `maxLength` code points —
then trim until `.length <= maxLength`.

---

## MEDIUM

| # | Finding | Location | Source |
|---|---|---|---|
| M-1 | **Sanitizer denylist misses keys in the vendor's own recorded payload.** `DROPPED` is an exact-string, case- and whitespace-sensitive `Set`; all four fixtures ship **`"tagIcon "` with a trailing space**, plus `tooltipAttributionIcon`, `tooltipDescription`, `main_entity`. Contained today only because the normalizers read a narrow field set — an accident of the read path, not the control the module advertises ("keys removed wherever they appear, at any depth"). Fix: match on `key.trim().toLowerCase()` + patterns, or invert to an allowlist. | `blockscout/sanitize.ts:50-59,76` | security M-1 + logic L-4 + perf `corroborated ×3` |
| M-2 | **`tokenId` is the one unbounded, unvalidated vendor string in the canonical type.** `z.string().optional()` — no `.max()`, no regex — while every sibling field is guarded (`amountRaw` twice). Lands verbatim in `structuredContent`, the JSON-RPC frame and the SQLite cache row. Fix: `.regex(/^(0|[1-9][0-9]*)$/).max(78)`. | `blockscout/index.ts:376,382`, `types/token-holders.ts:41` | security M-2 |
| M-3 | **A 200 body with no `items` becomes an authoritative "zero holders".** `items` defaults to `[]` and the refusal guard only fires when `items.length > 0`. An error envelope or proxied 404 rendered as HTTP 200 — routine for an LLM-facing facade wrapping a REST call — yields `{holders: [], truncated: false}`, cached 3600 s, on a route with **no fallback**. | `blockscout/index.ts:328-329,394-399` | logic MED-1 |
| M-4 | **Truncation detection hangs on one optional field.** `holders.length > HOLDERS_PAGE` is unreachable (vendor page 50 = `HOLDERS_PAGE`), so only `next_page_params` can set it. The recorded response carries pagination in **two** places — `data.next_page_params` *and* root-level `pagination.next_call`. If the facade normalizes to the latter, "the first 50 of many" is presented as "50 holders" — precisely what `truncated` exists to prevent. | `blockscout/index.ts:413` | logic MED-2 |
| M-5 | **`HOLDERS_PAGE` documents an ask that is never made.** Comment says "page size we ask the vendor for"; the request sends only `chain_id` and `endpoint_path`. 50 is the vendor's *undeclared default*. If it rises to 100, `.slice(0,50)` silently discards 50 free rows the schema (max 200) would accept — and it is the assumption H-3's blast radius rests on. | `blockscout/index.ts:86-87`, `:252-255`, `:411` | logic MED-3 + perf M-4 `corroborated ×2` |
| M-6 | **The emitted URL is neither probed nor asserted.** The code interpolates the **EIP-55-checksummed** address; the pinned evidence was captured **lowercase** (`pagination.next_call.params.endpoint_path`). Tests mock `fetchImpl` and assert only `toContain('…/v1/direct_api_call')`. If path matching is case-sensitive anywhere in the proxy chain, `token.holders` 404s on 100 % of real calls with a fully green suite. Also unevidenced: that `get_address_info` accepts `chain_id` as a query param at all. | `blockscout/index.ts:254` | logic MED-4 |
| M-7 | **Coverage matrix over-claims in two new ways.** (a) On blockscout-only chains (gnosis, zkSync, scroll…) `onchain_list_chains` advertises `entity.labels`, but `{query}`-only and `{exhaustive:true}` calls can **never** be served there. (b) `token.holders` is listed on 39 chains and **no MCP tool resolves it** — previously `dune.chainSupport` was `false`, so it was advertised nowhere. The commit converts "not advertised, not served" into "advertised, not callable", and `mcp-server/test/tools/list-chains.test.ts:95-104` asserts that as desired. This is the very defect class the task exists to remove, relocated one layer up. | `providers.config.ts:76,84`, `chain/coverage.ts:70-79` | logic MED-5 + security (deferred) `corroborated ×2` |
| M-8 | **The OQ-2 kill switch crashes the process.** `index.ts:73-76` throws at **module scope** when the registration is missing, and the module is re-exported from `core/src/index.ts:92-95` — so an owner disabling blockscout by deleting the config entry makes `import '@onchain-intel/core'` throw before `main()` runs. The server does not boot: the opposite of "degrade honestly". `blockscout-disabled.test.ts` covers only the *other* disable form. | `blockscout/index.ts:73-76` | logic MED-6 + security L-8b `corroborated ×2` |
| M-9 | **`catch {}` collapses three failure classes.** `SafeFetchResponseTooLargeError` (surfaces at body-read time by design), a mid-body network abort, and a genuinely non-JSON payload all report "unparseable response body" with **no `cause`** — unlike the transport catch 12 lines above, which names the class *and* preserves `cause`. Different retryability, one message. | `blockscout/index.ts:212-216` | logic MED-7 + security L-5 `corroborated ×2` |
| M-10 | **`endpoint_path` interpolation rests on an unasserted cross-file invariant.** The value is handed to the vendor to build its own server-side request. `normalizeAddress` sanitizes only `family: 'evm'\|'svm'` and otherwise returns input **verbatim**; the adapter asserts `evmChainId(chain) !== undefined` — a *caip2* check — never `chain.family === 'evm'`. The two coincide only via a generated file that explicitly permits hand-edited curated columns. `isValidAddress` for `family:'other'` accepts any 1–128-char string, i.e. `../../v2/…`. And `token.holders` has no MCP tool, so no input schema bounds it. One-line fix. | `blockscout/index.ts:252-255`, `chain/address.ts:187-194` | security M-5 |
| M-11 | **The sanitizer deep-copies the entire response to read one array.** `strip()` rebuilds every node even when nothing is dropped; `Object.entries` allocates ~3 objects per node, all immediate garbage. On `entity.labels` the whole 3-upstream fan-out response is copied to read `data.metadata.tags[]`. At the 10 MB ceiling: ~500 k nodes, a GC pause per call. Fix: `Object.keys` + `continue`, identical semantics, half the allocation. | `blockscout/sanitize.ts:69-80` | perf M-2 |
| M-12 | **Address is normalized on the wrong side of the cache key.** `normalizeAddress` runs **inside** `fetch()`, after `resolve()` already hashed the raw string (`registry.ts:228`). `entity.labels` is clean (the tool canonicalizes first), but `token.holders` has no tool yet — so a future author must independently repeat the ritual, or `0xA0b8…` and `0xa0b8…` become two cache entries and two facade fan-outs for one logical request. `deriveArgsHash`'s docstring asserts args are "ALWAYS the normalized tool-input"; nothing enforces it. | `blockscout/index.ts:237` | perf M-5 |
| M-13 | **Third-party-authored label text reaches the model verbatim and unmarked.** R-76's headline is "vendor free text does not reach the model", but `metadata.tags[].name` *is* vendor free text, forwarded with only a 256-char bound. Blockscout ingests OLI attestations and user-submitted public tags — third-party-choosable at low cost — and 256 chars is ample for a directive. The tool rendering it is the one exposing a 100-credit `exhaustive` escalation. Fix: strip control chars/newlines so an injected payload cannot forge structure, and carry provenance. | `blockscout/index.ts:429-444`, `sanitize.ts:124-147` | security M-6 |
| M-14 | **The API key travels in the URL and survives in `error.cause`.** The adapter correctly re-messages `safeFetch` failures by class but attaches `cause: error`; `SafeFetchTimeoutError.message`, `…TooLargeError.message` and the redirect-limit message all interpolate the **full URL including `apikey=<secret>`**. Any future `console.error(err)`, `util.inspect`, logger or unhandled rejection prints `[cause]` with the key. `.env.example:82` and R-79(c) both assert the key never reaches an error message; `cause.message` is an error message. Root fix belongs in `safeFetch` (report `hostname + pathname`, never `search`) — removes the class for every adapter. | `blockscout/index.ts:177-199`, `net/safe-fetch.ts:67,81,352` | security L-3 |
| M-15 | **Scan meta: the dependency result is not evidence.** `npm audit` errored with ENOLOCK (pnpm repo, no `package-lock.json`), so `DEPENDENCIES: OK` means "not checked", not "clean". SBOM absent (CWE-1104). | tooling | security |

---

## LOW

| # | Finding | Location | Source |
|---|---|---|---|
| L-1 | Vendor `ordinal` rank ignored while the docstring disclaims reliance on vendor order — `named[0]` is picked by array position though every recorded row ships an explicit `ordinal` (10 = curated, 0 = OLI secondary). Reorder the fixture's tags and the label flips from `"Binance: Hot Wallet 34"` to `"StrategyExecutor"`. Sort by `ordinal` desc. | `blockscout/index.ts:429-444,460-468` | logic L-1 |
| L-2 | `tags`/`labels` `.max(64)` enforced by **throw, not slice** — 65+ tags on one address pays Nansen every 60 s. The holders path already does the right thing. | `blockscout/index.ts:463-476` | logic L-3 |
| L-3 | **Prototype-pollution-shaped reconstruction:** `const out: Record<string,unknown> = {}` then `out[key] = …` over `Object.entries`. `JSON.parse` yields `__proto__` as an **own** key, so the assignment fires the inherited setter — the vendor chooses the reconstructed object's prototype, and every downstream read is inherited-aware bracket access. Not global pollution (no recursive merge downstream), hence LOW. `net/args-hash.ts:22-32` already fixed this exact class with `Object.create(null)`. | `blockscout/sanitize.ts:74-79` | security L-1 + logic L-5 + perf `corroborated ×3` |
| L-4 | **SSRF allowlist wider than the code needs and wider than the requirement:** `['api.blockscout.com','mcp.blockscout.com']` while the adapter's own comment says the first "is no longer called" and R-73(b) specifies one host. `safeFetch` re-checks each redirect hop against this list, so a misbehaving facade can bounce us to the second host. Small blast radius, but the allowlist is the *only* egress control — and it contradicts an accepted Must. | `providers.config.ts:166` | security L-2 + logic (noted) `corroborated ×2` |
| L-5 | `BLOCKSCOUT_PRO_API_KEY` is **outside the validated env surface** — no entry in `mcp-server/src/env.ts:46-80`, and `index.ts:93` builds the adapter with no `env`, so it falls back to raw `process.env` (unlike `coingecko`/`pg-history`). R-79(a) requires optional zod validation in `env.ts`; `.env.example:14-15` tells the operator everything is validated. Neither holds for the one secret this commit introduces. | `mcp-server/src/env.ts`, `mcp-server/src/index.ts:93` | security L-4 |
| L-6 | `BlockscoutDegradedError` is a distinction the registry cannot act on — every `fetch()` throw is treated identically except `CapabilityNotCoveredOnChainError`. R-78 is satisfied by the generic path too, which is why the test has to assert a *string* to get a guard at all. | `blockscout/index.ts:126-141` vs `registry.ts:279-297` | logic L-6 |
| L-7 | A capability/payload mismatch throws `unsupported capability token.holders` **for a capability the adapter does support**; `raw as BlockscoutFetchResult` then throws a bare `TypeError` on `null`. The registry converts that into a **negative cache entry** — a self-inflicted outage rather than a transient failure. Two-line guard. | `blockscout/index.ts:294-303` | logic L-7 + security L-8a `corroborated ×2` |
| L-8 | Generator header states "N testnets dropped" but computes `rows − sorted`, which also absorbs dedup and flag-less rows — a generated fact that is only coincidentally true, in the one file meant to be trusted as evidence-derived. | `scripts/gen-blockscout-chains.ts:102` | logic L-8 |
| L-9 | A permanent vendor 404 on the no-fallback `token.holders` route surfaces as `CapabilityUnavailableError` (contract: "retry") and is **never negative-cached**, so an agent loops against the vendor at 5 rps forever. | `providers.config.ts:76`, `registry.ts:290-296` | logic L-9 |
| L-10 | `execFileSync('pnpm', […])` in the generator: PATH-resolved binary, no shell, fixed argv, dev-time only, and it runs *after* `writeFileSync` so a hostile PATH entry cannot alter the artifact. The generator's injection surface is otherwise **verified closed** (`parseChainId` enforces `/^(0\|[1-9][0-9]*)$/` **and** `Number.isSafeInteger`; only numbers are interpolated; `is_testnet !== false` is fail-closed; `MIN_PLAUSIBLE_MAINNETS` catches truncation). Residual: no hash binds `chains.ts` to the evidence file. | `scripts/gen-blockscout-chains.ts:129` | security L-6 |
| L-11 | DNS-name-only egress allowlist (pre-existing): `URL.hostname` compared against the list — no resolved-IP check, no port constraint. A redirect to `…:9200` is permitted; rebound vendor DNS pointing at RFC1918 would be fetched. Flagged because this commit adds a host contacted on **every free call, keyless, by default**. | `net/safe-fetch.ts:19-23,323` | security L-9 |
| L-12 | `readObject({t: tag}, 't')` allocates a throwaway wrapper **per tag** (~200 objects/response) purely to reuse a helper. | `blockscout/index.ts:437` | perf L-1 |
| L-13 | 4 passes over the same tag array (2 `filter` + 2 `map`); `readRowLabel` builds two full arrays to read `[0]` of each. | `blockscout/index.ts:436-442,460-469` | perf L-2 |
| L-14 | `TokenHoldersSchema.parse` re-runs the `amountRaw` regex already applied at `:345`, ×50 rows. | `types/token-holders.ts:31` | perf L-3 |
| L-15 | `evmChainId` evaluates a regex **literal** per call; invoked 458× per capability while building each coverage set. Hoist to a module const (free to fix; memoized after first build). | `blockscout/index.ts:48` | perf L-4 |
| L-16 | A `query`-only `entity.labels` call pays a **synchronous** `better-sqlite3` SELECT, a chain resolve and a thrown-`Error` stack capture on the blockscout leg before reaching nansen — 100 % waste, knowable from args before the cache read. | `blockscout/index.ts:266-275`, `registry.ts:254` | perf L-5 |
| L-17 | `process.stderr.write` on the normalize path is synchronous when stderr is a TTY/file. Bounded (one line per response), consistent with repo pattern. | `blockscout/index.ts:403` | perf L-6 |
| L-18 | `normalize()` re-resolves the chain because `fetch()` returns `chain.slug` instead of the resolved `ChainInfo`. Registry is memoized → a `Map.get`. Listed for completeness. | `blockscout/index.ts:297` | perf L-7 |
| L-19 | `strip()` bounds **depth** (24) but not node count or width — defensible only because `safeFetch`'s byte cap is the real bound, a cap this adapter leaves 10 MB wider than it needs. Compounds H-3/M-11. | `blockscout/sanitize.ts:67` | perf L-8 |
| L-20 | `pagination.next_call` — an object literally shaped as a machine-readable instruction (`{tool_name, params, cursor}`) — survives `strip()` untouched. | `blockscout/sanitize.ts` | perf (deferred to security) |

---

## Test-guard analysis — assertions that survive deletion of the code they cover

This is the section that matters most for the cycle-1 fixes, and it is critic-logic's independent
finding (focus area 5). **Eight assertions do not guard what their comments claim:**

1. `blockscout.contract.test.ts:107-123` — "entity.labels tries blockscout first and nansen only
   after it". The adapter Map holds **only blockscout**, so `nansen` appears in `tried[]` via
   `registry.ts:233` `'no adapter registered for this id'`. It guards route *order* (a swap in
   `providers.config.ts` does go red) but proves **nothing about fallback**.
2. `nansen.adapter.test.ts:118-139` — identical construction (Map holds only nansen), and its comment
   claims it is what "makes a credit spendable only where the free source could not answer".
   **It never runs the free source.**
3. `blockscout/index.ts:394-399` (the all-rows-unusable refusal) — **no test at all**. Delete it and
   the suite stays green: the fixture always leaves one usable row.
4. `blockscout/index.ts:413`, the `holders.length > HOLDERS_PAGE` disjunct — **dead**. No test
   produces >50 valid rows.
5. `blockscout/index.ts:191-200` — the **transport-failure catch (the M-7 key-leak wrapper)**: no test
   makes `fetchImpl` reject or time out. Delete the try/catch, re-opening `safeFetch`'s
   full-URL-in-message leak, and everything stays green. *(Independently confirmed by the
   orchestrator before this run: 770/770 green with the wrapper removed.)*
6. `blockscout.transport.test.ts:97-109` — `not.toMatch(/https?:\/\//)` passes for a reason unrelated
   to sanitization: `normalizeHolders` emits only `address`/`label`/`amountRaw`/`tokenId`/
   `isContract`/`isScam`, so no URL could appear whatever `strip()` does. The author fixed the
   equivalent tautology for labels at `:195-213`; the same fix was not applied here.
7. `blockscout-sanitize.test.ts:61-68` — iterates `DROPPED_KEYS` itself, so **by construction** it can
   never catch a key the vendor ships that is missing from the list (this is why M-1 survived).
8. `blockscout.contract.test.ts:74-82` — `servesChain` ignores its `capability` argument entirely, so
   the equality is trivially true; the `slice(0,100)` bound also hides any capability-specific
   narrowing past index 100.

**Genuinely strong guards** (keep as-is): `blockscout-chains-in-sync.test.ts:25-40` (regeneration
equality — the only thing making "generated" a fact), `blockscout.transport.test.ts:195-213`
(sanitizer asserted at the transport boundary, verified by mutation), `blockscout-disabled.test.ts:96-122`
(asserts the phrase only the degrade branch produces), `blockscout.transport.test.ts:243-261`
(key substring, not "looks safe").

Performance adds the complementary gap: **none of the 977 tests bounds `items.length`, exercises the
throttle, or feeds a payload larger than the ~40 KB fixture.**

---

## Verified clean (recorded so it is not re-litigated)

From critic-security, each checked against source rather than assumed:

- **Zod error messages cannot leak vendor values** — `finalizeIssue` destructures `input` out of every
  finalized issue unless `ctx.reportInput` is set, and no `.strict()` schema on this path is parsed
  with vendor-chosen keys. The `normalize()` → `tried[].reason` → `isError` path is clean of vendor
  content from the schema side.
- **The sanitizer is genuinely invoked on every network path** — `request()` is the only site calling
  `response.json()`, the branded type makes a bypass a compile error, and the transport test asserts
  at the `fetch()` boundary.
- **No raw or sanitized body escapes `normalize()`** — `resolve()` returns only the normalized result.
- **Adapter-constructed errors name a hostname, never a URL**; the degrade path carries no vendor body.
- **The key cannot enter a cache key** — read strictly after `deriveArgsHash` runs; `requiresEnv: []`
  means `isAvailable()` does not signal its presence either.
- **No real secret is committed** — `.env.example` holds `proapi_xxxx…`, the test key is a fixture literal.

From critic-performance:

- **No N+1 across the route walk**; cache keys include `adapter.id`, so blockscout cannot poison
  nansen's entries (H-1 is a routing effect, not a key collision).
- **No pagination following** — the cursor is deliberately unused, so the holder list is bounded by
  one vendor page. The unbounded risk is the response-size door (H-3), not a cursor loop.
- **Cache layers are properly bounded** — LRU caps by entry count *and* serialized bytes with
  `ttlAutopurge`; SQLite statements prepared once.
- **Fetch failures are correctly not negative-cached** — a 429 stays transient.
- **No resource leaks on the error path** — redirect bodies cancelled, stream reader cancelled on
  overflow and on `new Response` construction failure.
- **No ReDoS** in any new regex — all linear, no nested quantifiers, checked explicitly.
- **Sanitizer complexity is linear with a depth cap** — no revisiting, no quadratic blowup on a
  hostile shape.

---

## Items requiring an owner decision (not fixable by review)

1. ~~**H-4 rate limit**~~ — **RESOLVED 2026-07-29, owner decision: defensive, not measured.**
   `refillPerSec` 5 → 2, and `entity.labels` weighted at **3 throttle tokens** — implemented as a
   `weight` parameter on `throttle()`, not as three sequential calls, because N calls compute N
   independent waits against N separate `MAX_WAIT_MS` caps and would park one logical request for up
   to N × 30 s. The deviation from R-73(b) is recorded in `TASK.md` §4.1 and in the config comment,
   with the number explicitly marked as not citable as a ceiling: the vendor sends no `RateLimit-*`
   headers, so nothing here is calibrated against a measurement.
   **Still open:** nothing ACCOUNTS for the spend — `costOf` is 0, no `usage` row, no budget gate.
   PLAN §3 ruled a Nansen-style gate out for a free vendor deliberately; it becomes its own task,
   with a measurement attached, if the ceiling is ever actually reached.
2. ~~**M-7(b) `token.holders` advertised with no tool**~~ — **RESOLVED 2026-07-29.** The §5 boundary
   was lifted by the owner and `onchain_token_holders` shipped. Two gates in this repo caught the
   consequences that a hand-written checklist would have missed: the stdio suite's exact tool-list
   assertion, and RF-5's offline eval-coverage test, which refuses a tool-served capability that the
   live eval never exercises — so the capability was wired into `CAPABILITY_TOOLS` rather than
   shipping with silent eval coverage of nothing.
3. **H-1 empty-labels semantics** — fixing it is what UC-2 requires, but it converts free empty
   answers into paid Nansen calls for every untagged address. Owner decision 2026-07-29: **the OQ-4
   redesign is coming soon, after the remaining track-A tasks** (`dune-tasks.md` A-3 — independent
   cross-check of BTC figures; A-4 — three incidental `dune` defects). Until then the behaviour
   stands as shipped: a deliberate deferral with a date attached, not an oversight.
   *(Superseded in scope by iteration 2 — see perf H-3 below.)*

---

# Iteration 2 — re-spawn on the fixed tree

Same three critics, same evidence contract. **Convergence: all three `issues-found`.**

## The regression iteration 1's own fix introduced — found by all three, independently

**H-1(i2) — the `unsatisfying` fallback masked a downstream FAILURE as a successful "no labels".**

The iteration-1 fix returned the first truthful-but-unsatisfying answer when nobody satisfied the
route policy, and **discarded `tried[]`** on the way out. On a stock install with no
`NANSEN_API_KEY`: blockscout answers empty → unsatisfying → nansen is unavailable → the empty answer
is published with `isError: false`. Before TASK-008 that call returned an explicit error naming the
key (R-40). On a mixer or sanctioned address it is a false negative delivered with full authority.

**Why nothing saw it:** no mcp-server suite registered `blockscout` at all. `TC-INT-01` survived only
because it asks with `query`, which blockscout declines outright; the **address-scoped** form — the
common one — was unguarded. Deleting the blockscout registration from `src/index.ts` left the entire
package green.

**Fix.** The registry now separates *"asked everyone, nobody had it"* (a fact about the data → return
it, R-32) from *"somebody could not be asked"* (an outage → `CapabilityUnavailableError`, R-40). The
first attempt at that separation then over-corrected and counted "no adapter registered for this id"
as a failure, which broke R-32 — that branch is a **configuration** fact, not a runtime one, and is
now excluded explicitly. Both contracts hold simultaneously, each with its own test.

**Guard added:** `TC-INT-05` in `m2-degradation.integration.test.ts` — the first mcp-server test that
registers blockscout ahead of nansen with the real route table.

## Other iteration-2 findings, fixed

| # | Finding | Fix |
|---|---|---|
| M-1 | A route's policy was taken from the first declaring route and applied to adapters contributed by **every** matching route. `wallet.balances.native` already ships as two routes, so the shape is live. | The walk plan pairs each adapter with the policy of the route that contributed it. |
| M-2 | A throwing `isSatisfying` was blamed on the **provider** — negative-cached under its key, its message into `tried[].reason` → the model. The cache-hit call site had the opposite flaw: outside every `try`, so it aborted `resolve()` untyped. | One `satisfies()` helper, **failing open**, identical on both branches. |
| sec M-1 | Sanitizer key matching was `trim().toLowerCase()`: zero-width, soft-hyphen, fullwidth and `İ` variants bypassed every entry and every pattern. | NFKC + strip `\p{Cf}\p{Zs}` before matching. |
| logic M-4 | `amountRaw` was still an unbounded vendor string — the exact class `tokenId` was bounded for one field away, while that fix's own comment called `tokenId` "the ONE place". | `.max(78)` in the schema, the shared `UINT256_DECIMAL_RE` in the normalizer. |
| logic L-1 | A literal `null` body bypassed M-3's typed refusal and produced a bare `TypeError`. | Explicit type check before the container read. |
| perf M-4 | The response body was never cancelled on 401/402/429 — the status class this adapter is *designed* to hit — leaving a half-read socket per degraded response. | `response.body?.cancel()` before the throw, matching what `safeFetch` already does for redirect hops. |
| perf H-1 | The `REQUEST_TIMEOUT_MS` docstring asserted a "~120 s" worst case. `safeFetch` builds its `AbortSignal.timeout` **inside** the redirect loop (per hop, ×4) and nansen's default tier issues three sequential sub-calls — the real envelope is several hundred seconds. The number was repeated, not derived. | Docstring corrected to state what the constant does **not** do; the missing whole-call deadline recorded in OQ-4. |

## Open — recorded rather than fixed

- **sec H-2 — one planted community label suppresses the authoritative source.** `isSatisfying`
  distinguishes empty from non-empty and nothing else, and Blockscout ingests OLI attestations and
  user-submitted public tags. A single planted tag terminates the route ahead of Nansen and is
  positive-cached for an hour. This is the *inverse* of the defect the policy fixed: the router now
  knows that *empty* is not an answer — not that *attacker-authored* is not one. **Provider trust is
  an OQ-4 question**; it needs the merge design, not another predicate.
- **perf H-3 — the free-first route can exhaust a free plan in six lookups.** Every unsatisfying free
  answer costs exactly 5 credits (`tgm/holders`) against a default 30 cr/day self-imposed cap. The
  canonical workload — label the 50 holders a `token.holders` call just returned, 40 of which carry
  `metadata: null` in the recorded fixture — demands 200 cr. Amortised per `(address, hour)`, **not**
  across distinct addresses, which is the actual workload. Belongs with the R-73(b) rate-limit
  decision already awaiting the owner.
- **sec H-3 — `nansen/endpoints.ts` echoes up to ~500 characters of vendor response body** into
  `tried[].reason` → the tool's isError text. R-68e was enforced per-adapter (a whole module, a
  branded type, four catch blocks) instead of at the seam that feeds the model — and the new routing
  sends *more* traffic through the one remaining open door. Outside TASK-008's file scope; worth a
  work item.
- **logic M-5 — "bound before per-row work" made a bad *head* fatal.** The slice takes the first 50
  **raw** rows, so a response whose first 50 rows are all unusable now fails the capability outright
  (no fallback adapter, negative-cached) where the old code kept 50 good rows from further down. Fix
  is two bounds instead of one: stop after 50 *kept*, cap rows *examined*.
- **sec M-4/M-5 — `BLOCKSCOUT_PRO_API_KEY` is outside `env.ts`'s validated surface**, and
  `.env.example` tells the operator the key "never enters a URL" while the adapter puts it in the
  query string by vendor requirement. The claim is right about *our* logs and errors and wrong about
  the request line; someone who believes it will not treat a proxy-log incident as a key compromise.

## Final state

- **Gates:** typecheck · lint · format:check · provenance (20 files match) — all pass.
  **1007 tests** (core 799, mcp-server 208), 0 failures.
- **Mutation battery: 25/25 caught.** Every fix from both iterations was deliberately broken and the
  suite noticed each one. Two gaps were found *by* the battery rather than by reading — the cache-hit
  branch of the route policy, and an M-2 test whose predicate was too weak to distinguish its own
  mutation — and both were closed.
- **Verdict (per `--fail-on=none`): PASS.** Iteration 2's HIGH findings are fixed or recorded; the
  items marked "open" are owner/redesign decisions, not defects left silently in the code.
