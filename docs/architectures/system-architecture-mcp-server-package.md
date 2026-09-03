> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md) → [system-architecture.md](system-architecture.md).
> Heading levels are the parent document's, unchanged: the section numbers are how
> every other document addresses this text.

#### Component: `@onchain-intel/mcp-server` (M0, extended in M1)

- Type and technologies are unchanged (Node CLI, stdio, `@modelcontextprotocol/sdk`, zod, tsup +
  tsx + vitest), plus a `workspace:*` dependency on `@onchain-intel/core`.
- `createServer(deps: { env: Env; version: string; registry?: CapabilityRegistry; budgetStore?: BudgetStore })`
  — the **registry is injectable**; tests pass a fixture-backed implementation of the same
  `resolve()` interface. This is the only mechanism for "MCP E2E without network" (R-21): the global
  `fetch` is never mocked; a different implementation of the same contract is injected at the
  `createServer` boundary. The injection
  works **in-process only** — it cannot cross the boundary of a spawned child process
  (`e2e.stdio.test.ts` spawns `src/index.ts` through `tsx`, and that process has no way to receive
  the caller's `registry` object). Hence the split between the spawn suite and the in-process suite
  (below).
  - **The omitted-`registry` default is INERT, not the real registry.** This bullet read
    "defaulting to the real one assembled from `providers.config.ts`" until T-014's architecture
    pass. The fallback is `new CapabilityRegistry(routes, new Map())`
    (`packages/mcp-server/src/server.ts:70`, `registry: deps.registry ?? new CapabilityRegistry(routes, new Map())`)
    — the real route table with an **empty** adapter map, so every capability degrades to
    `CapabilityUnavailableError`. `index.ts` is the only place the twelve real adapters are
    assembled (`packages/mcp-server/src/index.ts:136`,
    `return new CapabilityRegistry(routes, adapters, createCacheStore());`).
  - **T-014 keeps this factory transport-agnostic.** It takes no transport argument and attaches
    none; the deployment profile is decided in `index.ts` (§3.4.1). The one additive change is
    described in §3.4.3: `CreateServerDeps` gains an optional principal resolver, and the per-session
    server is constructed by calling this same factory once per session.
- **The tool inventory is data, not prose (TASK-011, [ADR-002](../onchain-analytics/ADR-002-configurable-routing.md)
  D7).** Every tool module exports a `ToolSpec` — `name`, `title?`, `description`, the served
  `capability` (`null` for the two that serve none), both zod schemas, and a handler — and
  `createServer` registers by iterating `toolSpecs`. `title?` is OPTIONAL in the type because it
  described a split when written: 4 of the 13 tools carried one and 9 did not. A spec without it
  would silently drop four titles from `tools/list`. **Today all 22 carry one** (measured while
  closing WI-48), so the optionality is now a tolerance the type still permits, not a state it
  describes. Whether to require it is a separate decision, deliberately not taken here. One helper
  (`defineTool`) is the only place that touches `server.registerTool`, so a tool's name is
  **declared** exactly once.
  - **DESIGNED, corrected (T-013) — `capability` does NOT widen to a union. A new, additive
    field carries the second capability instead.** A first draft of this entry proposed
    `capability: string | string[] | null` and called it "the one change" and "backward-compatible".
    Measured against the tree, it is neither. **Three** type declarations name the field:
    `packages/mcp-server/src/tools/registry.ts:110`, `readonly capability: string | null;` in
    `ToolDefinition`; the same line at `:139` in `ToolSpec`; **and**
    `packages/mcp-server/scripts/gen-tool-inventory.ts:42`, `readonly capability: string | null;`
    in `ToolInventoryEntry`. The third is the schema of the _committed artifact_
    `tool-inventory.json`, read by `smoke-dist.mjs` and the eval. A `string[]` value is not equal
    to any string, so every reader that compares `capability` with `===` or as a `Set` member goes
    from "matches" to "silently never matches". That is a hard, offline failure
    (`eval/capabilities.mjs`'s `toolFor()` throws AT IMPORT), not a compile error a reviewer
    would catch.
  - **Decision: `capability: string | null` is UNCHANGED — same type, same meaning ("the ONE
    capability this tool serves, or `null` for none"). A new, optional field,
    `servedCapabilities?: readonly string[]`, is added to all three declarations above, present
    ONLY on a tool serving more than one capability** (today: only the 14th tool,
    `['privacy.shielded_pool.history', 'platform.metrics.history']`). `capability` itself is `null`
    for it, same value it already carries for `ping`/`list-chains`, but a DIFFERENT fact. It is
    disjoint from "serves none", which is why the readers below cannot treat `capability === null`
    as one case any more. Additive at the type level (every existing literal recompiles
    unchanged) — the honesty this buys is that no reader capable of comparing a scalar is handed an
    array it was never written to expect.
  - **Readers enumerated by grep — corrected round 2 (MJ-1): FIVE require a behaviour change, not
    three. The two missed both fail SILENTLY, which is the one failure mode this design cannot
    afford to reproduce.**
    (1) `eval/capabilities.mjs`'s `toolFor(capability)` — extend the match to
    `tool.capability === capability || tool.servedCapabilities?.includes(capability)`.
    (2) `docs-counts.test.ts`'s R-119 pairing gate — `documented` becomes `Map<string, string[]>`
    (one tool name can attribute more than one anchor, M-3/BL-1 below), and the equality check
    becomes a SET comparison against `spec.servedCapabilities ?? [spec.capability]`. The `served`
    Set must flatten `servedCapabilities` too or the 14th tool's anchors read as orphaned.
    (3) `tool-spec.test.ts`'s two existing assertions — the "serves no capability" sorted-list
    check (`capability === null`) now also catches the 14th tool and must be told apart by
    `servedCapabilities === undefined`. The "routes every declared capability" check
    (`routed.has(spec.capability)`) silently skips a `capability: null` entry today and must gain an
    `OR`-clause walking `servedCapabilities`. Without it the 14th tool's two routes are never
    checked to exist.
    (4) `test/eval-capability-coverage.test.ts`'s `capabilitiesServedByTools()` — this is RF-5's
    OWN guard. `dex.volume.history` shipped with no eval case and a green run read as "the free
    contour is verified"; this test exists so that never happens again silently. Today it does
    `if (spec.capability !== null) byCapability.set(spec.capability, spec.name)` — a tool with
    `capability: null` is invisible to it BY THE SAME CONSTRUCTION that makes `ping`/`list-chains`
    invisible on purpose. **`capabilitiesServedByTools()` MUST also flatten `servedCapabilities`** —
    for each entry, map EVERY member to the tool's name. Without that, the 14th tool's two
    capabilities are never required in `CAPABILITY_TOOLS`/`CAPABILITY_EXCLUSIONS`, and RF-5's own
    gate stays green over exactly the hole it was built to close. `test/inventory-channels.ts`'s
    channel description ("fires only when the tool serves a capability") is also wrong for a tool
    serving two and needs the same correction in prose.
    (5) `test/eval-checks-coverage.test.ts`'s `serverLevelTools` — `toolSpecs.filter(spec =>
spec.capability === null)` reads "answers without a provider" from the SAME bit `null` now
    carries a second meaning under. Left unfixed, it classifies the 14th tool as server-level (like
    `ping`) and demands an `eval/checks.mjs` entry FOR THE WRONG REASON (it is capability-routed,
    just through two capabilities). Since it is also absent from `CAPABILITY_TOOLS` under this
    misreading, it produces a LOUD failure, just not the true one. Unlike (4), the danger here is
    noise, not silence. The fix is the same source of truth: filter on
    `spec.capability === null && spec.servedCapabilities === undefined`.
    **Verified unaffected, not left unexamined:** `readme-tool-table.test.ts`'s
    `CAPABILITY_OF`/`PAID_CAPABILITIES` (neither of the 14th tool's capabilities routes through
    `nansen`, so its README pricing cell is never consulted) and `smoke-dist.mjs` (does not read
    `capability` at all).
  - **MN-2 — the artifact mapper is a SIXTH site, and it is the one reader (1) reads through.**
    `gen-tool-inventory.ts`'s `buildToolInventory()` maps `toolSpecs` to `{name, title, capability}`
    literally; adding `servedCapabilities` to the TYPE (above) does not make this mapper emit it —
    it compiles unchanged and silently drops the field. Readers (2)-(5) import `toolSpecs` directly
    in TypeScript and are unaffected by this mapper. Reader (1), `eval/capabilities.mjs`, is plain
    `.mjs` and can ONLY read the generated `tool-inventory.json`. A mapper that drops the field
    therefore defeats reader (1)'s fix above by itself, silently, downstream of it. The mapper needs
    the same field added to its object literal: `capability: spec.capability, servedCapabilities:
spec.servedCapabilities`.
  - **Least privilege stays a RUNTIME fact, not a type-level promise.** Today `server.ts` hands
    each tool a fresh literal (`{version}`, `{registry}`, `{registry, budgetStore}`), so a free
    tool has no reference to the budget store at all. A uniform loop that passed one wide context
    to all twenty-two would replace that with self-restraint. Self-restraint is weak here:
    `budgetStore` is declared **optional** in all three M2 contexts, so any tool could add
    `budgetStore?: BudgetStore` to its own context type and read it, compiling silently. So the
    spec declares the context keys it needs (`needs: ['registry', 'budgetStore']`), the handler
    receives `Pick<ToolContext, K>`, and **the loop projects the object before calling** —
    `pick(ctx, spec.needs)`. Two properties, not one. The type narrows with no assertion anywhere
    (`ToolContext` is assignable to `Pick<ToolContext, K>` by construction — verified by compiling
    it). The object a tool receives genuinely lacks the keys it did not ask for, which a test can
    assert. `needs` is data, so "what this tool depends on" is inspectable rather than inferred.
  - **Schemas: one form, and picking it changes the contract for four tools.** Nine tools pass a
    full zod schema to `registerTool`; four (`chain-tvl`, `chain-supply`, `dex-volume`,
    `list-chains` — the same four that carry `title`) pass `.shape`. The SDK wraps a raw shape in a
    NON-strict object, so those four declare `.strict()` and do not get it: in the captured
    baseline their `inputSchema` has **no** `additionalProperties`, while the other nine have
    `additionalProperties: false`. `ToolSpec` therefore requires the **full schema**, `.shape` is
    rejected by the type — which fixes a latent defect and, in doing so, changes those four tools'
    published schema. That is an enumerated, owner-approved contract change, not a silent one.
    The opposite choice (standardise on `.shape`) is rejected outright: in zod 4 `.superRefine`
    returns `this`, so `GetTokenInputSchema.shape` compiles and carries **none** of the checks —
    `onchain_get_token` would stop validating addresses while still looking correct.
  - **Readers, not copies.** The stdio inventory suite, the dependency-free `smoke-dist` script,
    the eval's capability axis and the documentation gates all derive the list from the registry.
    Non-TypeScript readers go through a committed generated artifact, following
    `gen-blockscout-chains.ts` + `blockscout-chains-in-sync.test.ts` (the generator is an exported
    pure function, regenerated into a tmpdir by a test and compared). They do **not** go through
    `registry.data.json`, whose generator hits three live vendor catalogues and carries
    hand-curated columns, and whose committed file has no freshness gate at all. The artifact is
    read with `readFileSync`, never imported from `src/`: `resolveJsonModule` is core-only and
    `with { type: 'json' }` is pinned as flaky under this TypeScript/NodeNext combination. Both
    generated files go into `.prettierignore` in the same commit, for the reason core already
    records: a generator owns its file's bytes, and byte-identity across two runs is the
    acceptance criterion prettier would break.
    The four independent observation channels of
    [WI-20](../backlog/wi-20-three-tool-inventory-lists.md) all remain — what stops being
    duplicated is the _data_, not the _checking_.
  - **Three independent guards against a tool DISAPPEARING.** Deriving every reader from the
    registry would otherwise leave zero. The documentation gate iterates _registered_ tools, so a
    vanished one is simply not iterated. (1) A hand-written lower bound,
    `expect(toolSpecs.length).toBeGreaterThanOrEqual(13)` — the idiom `docs-counts.test.ts` already
    uses, and the only one **no command can regenerate**. (2) Orphan-name detection — any
    `onchain_*` token in a gated document must exist in the registry. (3) The artifact in-sync
    test. The frozen `tools/list` snapshot proves the refactor changed no byte, but it is
    deliberately **not** the sole deletion guard. Its byte comparison reddens on every SDK/zod bump
    and is healed by re-running the snapshot command. A routine that says "red → regenerate →
    green" would eventually accept a disappearance as conforming too.
  - **Response shape is not uniform today** and the loop has to name that rather than assume it.
    `ping` and `list-chains` are synchronous and emit no `_meta`. The M1 tools are async with
    `_meta.cache`. The M2 tools add `_meta.budget` on a miss. A canonical outcome type covers all
    three, and the two synchronous tools are brought to it.
- **The M1 `src/tools/*.ts`** (`get-token.ts`, `wallet-balances.ts`, `active-pairs.ts`,
  `protocol-tvl.ts`) follow the `ping.ts` pattern: a pure handler (unit-testable without a
  transport, returning `{ok:true,...} | {ok:false,reason}`, never throwing) plus the SDK wiring,
  which on `{ok:false}` explicitly builds
  `{ isError: true, content: [{ type: 'text', text: <reason, no secret values> }] }`. The installed
  SDK (`@modelcontextprotocol/sdk@1.29.0`) already wraps the **whole** `tools/call` handler — input
  validation, the callback itself, and output-schema validation — in one try/catch and converts any
  thrown error into `isError: true` (verified by reading the installed `server/mcp.js`). The
  explicit construction is kept deliberately so each handler's `{ok:false,reason}` contract is
  unit-testable at the pure level with no transport. **`reason` is NOT curated copy:** on the
  capability path `resolveCapability` forwards `error.message` verbatim, and a
  `CapabilityUnavailableError` concatenates every adapter's failure — which can carry up to 500
  characters of a vendor's own response body. It reaches the model as `isError` text with none of
  the success path's sanitizing, so a new failure path must treat it as untrusted input. No secret
  reaches it: adapters that embed a vendor body redact keys first, and `safeFetch` reduces URLs to
  origin+pathname. _(This bullet asserted the opposite until adversarial cycle 4. That was the
  fourth place the same claim lived, corrected one file at a time across three cycles.)_
- `src/env.ts` — four optional keys (R-23): `COINGECKO_API_KEY`, `DUNE_API_KEY`, `ONCHAIN_PG_URL`
  (`z.string().url().optional()` — WHATWG URL parsing accepts `postgres://`), and `DATA_DIR`
  (`z.string().optional()`). `EnvSchema.parse({})` still does not throw (R-23). A fifth optional key,
  `COINGECKO_PRO_API_KEY`, exists because a CoinGecko Pro subscription is a **separate**
  authentication circuit, not "the same key with higher limits". The circuit is host
  `pro-api.coingecko.com` + header `x-cg-pro-api-key`; the pro host ignores the demo header —
  confirmed by a live probe. Key formats are identical across tiers (`CG-…`), so the circuit is
  declared by which variable is set and never guessed from the format; when both are set, Pro wins.
