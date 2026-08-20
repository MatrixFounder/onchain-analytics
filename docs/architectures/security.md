# 7. Security

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

### 7.1. Authentication and authorization

The answer differs by deployment profile. A **deployment profile** is a named combination of one
transport and one store, one per process (`docs/TASK.md:21-24`, `` `Профиль развёртывания` — режим запуска процесса ``).

**Transport and store are two independent axes** (owner decision, 2026-08-12). Three combinations
carry a name; `system-architecture.md` §3.4.8 owns the names.

| Profile          | Transport       | Store                      | Inbound boundary |
| :--------------- | :-------------- | :------------------------- | :--------------- |
| `local`          | stdio           | SQLite in `DATA_DIR`       | none             |
| `network`        | Streamable HTTP | Postgres, schema `onchain` | §7.5 in full     |
| `network-sqlite` | Streamable HTTP | SQLite in `DATA_DIR`       | §7.5 in full     |

**The trust boundary follows the transport axis, never the store.** `network-sqlite` authenticates
every request exactly as `network` does.

**Why `network-sqlite` exists.** The owner debugs HTTP on the development machine before
switching `.mcp.json` over. Requiring Postgres for that would be a cost with no purpose.

**Why it is not an authentication exception.** A debugging combination that skipped the token would
be the one configuration whose refusal path never runs.

- **Local stdio** — no inbound perimeter; trust is delegated to the host process. No token is
  required and none is checked (`docs/TASK.md:451`, `значение не требуется и не проверяется`).
- **Streamable HTTP, under either store** — every request carries a bearer token, verified before
  routing. The inbound design is §7.5; the tables it reads and writes are §4.5.

The optional read-only PG client adds no auth perimeter: authorization happens on the Postgres role
(recommendation in §7.3), and the engine only consumes a DSN.

### 7.2. Data protection

- Secrets live only in `.env` (0600) with zod validation (D10). All six optional keys (§3.2) obey
  the same rule: never logged, never part of a cache key.
- `NANSEN_API_KEY` (M2, TASK-005, R-45) is the sixth optional key and follows the same contract. The
  `apiKey: <NANSEN_API_KEY>` header is already covered by the existing
  `SENSITIVE_HEADER_RE = /authorization|api-?key/i` in `packages/core/src/net/safe-fetch.ts:251`, `const SENSITIVE_HEADER_RE = /authorization|api-?key/i;` — **no regex change is
  needed**: the `Headers` API strips case from the header name before the comparison (`"apiKey"` →
  `"apikey"`), and `api-?key` matches `"apikey"` literally because the hyphen is optional. A
  cross-host redirect therefore drops this header exactly as it drops `Authorization` and
  `x-cg-*-api-key`. A regression test pins that behaviour for `nansen` specifically (R-45
  acceptance) instead of touching the regex. The key is read by the adapter inside `fetch()`
  **after** `args_hash` has been computed — the same invariant as the other five keys.
- `NANSEN_DAILY_CREDIT_CAP` (OQ-5, §3.2/§11) is **not** a secret: it is an ordinary numeric config
  value, like the rate-limit numbers in `providers.config.ts`, and may safely appear in stderr or in
  `_meta`. The API key itself never may.
- **The cache key excludes env values by construction.** `args_hash` in `cache_entries` is
  `sha256(hex)` over the **normalized arguments of the tool call** (`chain`, address,
  `protocolSlug`, `limit`, `tokenAddress`, `query`, `exhaustive`, …) taken **after** zod validation
  and `normalizeAddress`. Neither `COINGECKO_API_KEY`/`COINGECKO_PRO_API_KEY`, nor `DUNE_API_KEY`,
  nor `ONCHAIN_PG_URL`, nor `NANSEN_API_KEY` ever enters the hashed object — adapters read them
  read-only inside `fetch()`, after the key has already been derived from the args. Two calls with
  different `NANSEN_API_KEY` and identical args produce an identical `args_hash` (R-45 acceptance):

  ```ts
  function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce(
          (acc, k) => {
            acc[k] = canonicalize((value as Record<string, unknown>)[k]);
            return acc;
          },
          {} as Record<string, unknown>,
        );
    }
    return value;
  }

  function deriveArgsHash(capability: string, args: Record<string, unknown>): string {
    // args — ONLY the normalized tool input (chain/address/limit/...), NEVER process.env.
    // canonicalize() sorts keys recursively BEFORE JSON.stringify — otherwise {chain,address} and
    // {address,chain} (semantically the same input, built in a different order) serialize to
    // different JSON strings → different hashes → a spurious cache miss.
    return sha256Hex(JSON.stringify({ capability, args: canonicalize(args) }));
  }
  ```

#### 7.2.1. Multichain RPC and the SSRF allowlist (TASK-006, R-56 — resolves TASK-006 OQ-2)

Growing the chain set from 2 to 458 carries the **only** non-trivial security risk in the whole
task: `wallet.balances.native` needs an RPC endpoint **per chain**, and `chainid.network` publishes
`rpc[]` for **2660** chains. The naive implementation — "take the hosts from the vendor catalog" —
would mean that **the list of hosts we trust with outbound requests is decided by a third party over
the network**. That destroys the SSRF gate outright (§7.3, R-25): a gate whose allowlist is set by
an untrusted source is not a gate.

**The decision — five hard rules:**

1. **`rpcHosts` is a curated registry column, not a catalog import (R-56a).** The generator (§3.2,
   `sync-chain-registry.ts`) **proposes** candidates from `chainid.network`, but they reach the
   registry only through human review and a commit (TASK-006 UC-4). This is the one registry field
   where automatic population is explicitly forbidden.
2. **The allowlist stays static for the entire runtime (R-56c).** No vendor response can widen the
   set of permitted hosts. The wording is deliberately broader than "do not take hosts from
   `chainid.network`": any path in which data from the network influences the allowlist is
   forbidden.
3. **A chain without `rpcHosts` is honestly uncovered, not broken (R-56b).** `rpcHosts: null` makes
   `servesChain()` return `false` in both RPC adapters, and the coverage matrix (§4.2.3) returns
   `CapabilityNotCoveredOnChainError` **before** any network access. The alternative — try and fail
   on a timeout — would disguise a missing configuration as a network failure.
4. **The shape of an entry is validated at LOAD time, not just its presence.** A bare `.min(1)`
   string check on the column lets through `https://rpc.legit.org@evil.example` (userinfo — the real
   host is `evil.example`), `https://127.0.0.1:8545`, and a scheme-less `evil.example`. The last one
   is the nastiest: as an endpoint it is unreachable (`new URL` inside `safeFetch` rejects it), so no
   test ever touches it — yet it **does** land in the allowlist, silently widening the set of hosts a
   redirect is allowed to reach. `ChainInfoSchema` therefore requires `https:`, no userinfo and no IP
   literal, and a malformed entry is a **load error** of the same class as a duplicate `caip2`. On
   top of that, `hostOf()` in both adapters throws instead of returning the input string: for a
   security control, the default behaviour on unparsed input is "drop", not "trust".
   **A path segment of 20+ characters is refused by the same rule** (T-012 adversarial cycle 3): the
   Alchemy/Infura convention puts the API key IN the path (`https://…/v2/<32 chars>`), and
   `net/safe-fetch.ts` publishes `origin + pathname` in its timeout and deadline errors — messages
   that reach stderr and reach the model through `tried[].reason`. The redactor strips the query
   (because that is how `blockscout` authenticates) and keeps the path, justified by "the path is
   ours, never a secret". That sentence was an assumption about every URL the redactor might ever be
   handed; refusing the entry here is what makes it a fact. Redacting at the printer instead would
   blind legitimate long ids (`/api/v2/addresses/0x…`) while still guessing at the next vendor's
   convention.
5. **Both RPC adapters, not just EVM.** Both `rpc-evm` and `rpc-solana` are confined to the same
   perimeter — endpoints and allowlist come only from the requested chain's `rpcHosts`. A
   module-level `ENDPOINT` constant (Solana mainnet) combined with advertised coverage for ANY `svm`
   chain that has a curated host is latent with one SVM chain and guaranteed to break on the second,
   and the entire point of TASK-006 is that adding a chain is a data edit. The `servesChain()`
   predicate is the same one for `chainSupport` and for transport in both adapters, so advertising
   and execution cannot drift apart.

**Criterion for including a chain in `rpcHosts`** (TASK-006 OQ-2, in force — the 19 chains below
were curated under it): top-N by TVL with a **manual** liveness check of the endpoint at generation
time. The
TVL threshold is the criterion because the top 50 chains cover 99.1% of all TVL (measured, TASK §0)
— curating dozens of hosts rather than thousands gives practically complete coverage of real demand.
Every other chain gets `rpcHosts: null` and stays fully functional for the keyless capabilities
(`chain.tvl`, `token.price`, `token.metadata`, `pairs.active`), which need no RPC.

**Curated chains (task 006-8, verified 2026-07-26).** 19 of 458: `ethereum`, `solana` (carried over
from M1 unchanged) plus `arbitrum`, `avalanche`, `base`, `bsc`, `cronos`, `flare`, `gnosis`, `ink`,
`katana`, `mantle`, `monad`, `op-mainnet`, `plasma`, `polygon`, `robinhood-chain`, `rootstock`,
`x-layer`. The criterion is top-by-TVL among the EVM chains for which `chainid.network` proposes an
https endpoint that needs no API key; every endpoint was checked with an `eth_chainId` call, and
**only** those that returned the **expected** chain id entered the registry.

> **Rejected by hand — and this is the illustration of why the rule exists.** `hyperliquid-l1`
> (chainId 999): its only live candidate is `https://gwan-ssl.wandevs.org:46891/`, i.e. a **Wanchain**
> domain. Both chains historically claim chainId 999, so `eth_chainId` returns exactly the expected
> value and **the automated check passes**. Hyperliquid balance queries would go to Wanchain. A
> machine check cannot tell "answered with the right chain id" from "is the chain we meant"; a human
> can. That is precisely why automatic population of this column is forbidden rather than merely
> discouraged.

**Coverage asymmetry is not a defect — it is a consequence of honesty.** `chain.tvl` is available on
hundreds of chains, `wallet.balances.native` on dozens. The coverage matrix makes that difference
**visible** (`onchain_list_chains({capability})`) instead of hiding it behind a single promise of
"we support everything".

**What the chain registry does NOT change in the security perimeter:** `safeFetch()` remains the
single outbound-HTTP point; the allowlist remains per-adapter; redirect checking on every hop,
`SENSITIVE_HEADER_RE`, and the exclusion of env values from the cache key are unchanged. The
registry adds **data** to the existing mechanism; it does not replace the mechanism.

#### 7.2.2. How much vendor-authored text one call can put in front of the model (T-012, cycle 3)

Token names, tags and entity labels are chosen by whoever deployed the contract or edited the
explorer entry, and every one of them is rendered into the model's context. Per-field caps have
existed since vdd-multi cycle 5 (`truncateVendorText`, `truncateStringArray`, the zod `.max()`
backstops) and a row cap since cycle 1 — each added for its own reason, and **the product was never
taken**. "There are caps" is not a bound; the finding this section answers was that the SURFACE was
unstated, not that a cap was missing.

**Measured, 2026-08-05** (`packages/core/test/nansen.hardening.test.ts`, the `cycle 3 security`
block — the numbers are produced by feeding inputs over every cap and weighing the output, not by
restating constants):

| Path                        | What binds                                               | Ceiling                  |
| --------------------------- | -------------------------------------------------------- | ------------------------ |
| `entity.labels`, nansen     | `MAX_VENDOR_ROWS` × (`name` 256 + 64 tags × 256)         | < 17.5 KB per entity     |
| `entity.labels`, nansen     | `tokens[]` and `entities[]` are sliced **independently** | 400 entries per response |
| `entity.labels`, blockscout | transport: `MAX_RESPONSE_BYTES`                          | 512 KiB per call         |

The two vendor arrays being capped separately is the part a reader gets wrong: the ceiling is twice
the row cap, not the row cap. `blockscout` needs no field arithmetic — its transport cap bounds
everything downstream of it, which is why that adapter's number is a byte count and nansen's is a
product. Nansen runs on the 10 MB `safeFetch` default, so for it the field and row caps are what
bind.

This is a **bound, not a defence**. Text inside it is still attacker-chosen, and the mitigations that
matter are elsewhere: the tool descriptions tell the model these strings are vendor data, and no
label value reaches a shell, a query or a URL. What the numbers buy is the ability to notice a
change — a future cap edit that multiplies the surface fails the gate above instead of passing
review as "a bigger limit".

### 7.3. Attack surface and hardening

- **stdout discipline** (M0 invariant) holds for all 22 tools. `_meta` — including `_meta.budget`
  (§5.1.2) — and every log line go through the MCP protocol response or stderr, never through raw
  stdout.
- **The eval's reference sources are a second egress path, and it is bounded by being outside the
  server** (TASK-009, R-88). `eval/run.mjs` fetches an independent vendor directly, not through
  `safeFetch`, so the SSRF gate does not cover it. That is acceptable for exactly one reason: the
  eval is a developer script that is deliberately **not part of `pnpm test`** and not shipped in
  `dist/`, so nothing an agent or a client can reach ever executes it. The URLs are not computed —
  they live in `probes.json`, a reviewed data file in git, and are constrained to `https`. The
  server's own perimeter is untouched: no adapter, no route and no tool gains a host from this axis,
  and `mempool.space` appears in **no** allowlist precisely because the engine never calls it.
- **SSRF gate (R-25):** `safeFetch()` is the single outbound-HTTP point; the allowlist is
  **per-adapter**, not a global union, so a bug in or compromise of one adapter grants no access to
  another adapter's hosts. Redirects are checked on every hop (max 3) and the `Location` header is
  never trusted blindly (§3.2/§5.3). `assertAllowedHost()` is the same primitive, transport-agnostic
  by design (intended for future non-HTTP transports such as gRPC), but no live adapter exercises it
  today — `dash-platform`'s gRPC channel is not created — so it stays ready for the backlog task of
  a live DAPI transport (§11), when channel-level checking is needed again.
- **Response-size cap (R-65, TASK-007):** `safeFetch()` bounds **every** response body against
  `maxResponseBytes` (default 10 MB) by counting bytes off the stream, cancelling the upstream reader
  and throwing `SafeFetchResponseTooLargeError` the moment the cap is crossed. The advertised
  `Content-Length` is used **only as a cheap early rejection** — never as grounds to skip the
  counter. This closes item (1) of the R-47 carry-over.

  Both halves of that sentence were learned the hard way. Until TASK-007 the cap read the header and
  returned early when it was absent, which is the common case rather than the exotic one:
  `api.llama.fi` serves every response over HTTP/2 with **no `Content-Length` at all** (measured
  2026-07-27), so the cap was inert on a host the engine was about to send more traffic to. The first
  fix then trusted the header when it _was_ present — and the security and performance critics found
  independently (adversarial cycle 3) that this let the header, the one input a size cap exists to
  distrust, switch the enforcement off: `Content-Length: abc` or `-1` fails the `> maxBytes` test and
  reported "bounded"; a `Content-Encoding: gzip` response advertises **compressed** bytes while the
  cap is enforced on **decoded** ones, making an ~8×-compressible JSON body a decompression bomb that
  passes a 2 MB cap at 250 KB advertised. Always wrapping costs ~10 µs and no byte copies.

- **Rate limit (R-26):** a per-provider token bucket protects both the provider (good citizen) and
  us (we do not burn paid credit faster than necessary). The budget guard sits on top of the rate
  limit; the two are independent and both mandatory. The rate limit protects against 429 regardless
  of what a request costs; the budget guard (§3.2/§4.2) protects the budget regardless of how fast
  requests arrive. `retry-after` on a 429 and `X-Nansen-Credits-*` are two different headers driving
  two different mechanisms.
- **PG read-only (R-12) — three controls, named in the order they actually hold.** This entry used
  to name only the code-review gate as an engine-side control — the weakest of the three — and to
  omit the one doing the work. (The operator recommendation below was already here and is unchanged;
  the runtime guard was documented in `system-architecture.md` but not in this list of controls.)
  1. **The SQL is static and every caller-supplied value is a bound parameter.** `pg-history` issues
     one literal statement with `$1/$2/$3` (`adapters/pg-history/index.ts`); nothing an agent
     supplies is ever concatenated into SQL. This is the PRIMARY control — it is what makes injection
     impossible rather than merely non-obvious, and a new adapter that concatenated an agent-supplied
     value would defeat everything below while still passing it.
  2. **A runtime guard** in `pg/read-client.ts` (`SELECT_ONLY_RE`, R-27) rejects a statement that
     does not begin with `SELECT`. Defense in depth, and deliberately described for what it is: it
     constrains the FIRST TOKEN, so it is a guard against a wrong-shaped call, not a parser.
  3. **A code-review gate**, the weakest, and last.

  The **recommendation for the DB operator** is defense in depth the engine cannot provide for
  itself: code discipline is not protection against a leaked key or DSN. The read role is granted
  **by table, never by schema** (owner decision, 2026-08-13):

  ```sql
  GRANT USAGE ON SCHEMA onchain TO <read-role>;
  GRANT SELECT ON onchain.assets, onchain.metrics, onchain.snapshots TO <read-role>;
  -- and NOT: GRANT SELECT ON ALL TABLES IN SCHEMA onchain
  -- and NOT: ALTER DEFAULT PRIVILEGES IN SCHEMA onchain GRANT SELECT ... TO <read-role>
  ```

  **Why by table.** Since T-014 the engine's own tables live in the same schema, and `api_tokens`
  holds the stored token digests. A schema-wide grant would put them inside a `SELECT` issued over
  `ONCHAIN_PG_URL`, together with `users`, `access_audit` and `request_trace`.

  **The earlier wording here recommended `GRANT SELECT ON SCHEMA onchain`, and it is not
  executable.** A schema accepts `USAGE` and `CREATE`, not `SELECT`.

  **What an operator would have run instead.** The `ALL TABLES` form, which reaches the four tables
  named above.

  **Why this needs a measurement, not only a grant.** The read role predates T-014, and the
  migration grants without revoking. Its EXISTING privileges therefore decide the outcome.

  **The measurement is install step 2a** (`deployment.md` §10.4.2). It reads `role_table_grants` and
  `pg_default_acl` for that role **before** granting anything to it, and revokes any grant reaching
  one of the twelve engine tables before the profile starts.

  **T-014 adds a second connection, and the two roles are not the same role.** The network profile
  opens one DSN per purpose (§10.3, §10.5).

  | DSN                    | Reads                                        | Writes                                      |
  | :--------------------- | :------------------------------------------- | :------------------------------------------ |
  | `ONCHAIN_PG_URL`       | the snapshotter's tables in schema `onchain` | nothing                                     |
  | `ONCHAIN_STATE_PG_URL` | the engine's own tables in schema `onchain`  | the engine's own tables in schema `onchain` |

  **The engine's tables live in schema `onchain`, beside the snapshotter's** (owner decision,
  2026-08-12, reversing the earlier answer to `OQ-T014-DEP-1`). `deployment.md` §10.5 lists the
  tables and the grants; this section states the separation they carry.

  **Isolation is by role and grant, not by a second schema.** The state role is granted on the
  engine's own tables only.

  **The state role receives no grant on `assets`, `metrics` or `snapshots`.** The read role receives
  no write grant on any table in the schema.

  **The read role's grant reaches no engine table.** Three tables are named, with no `ALL TABLES`
  form and no default privileges.

  **Why the list carries the separation alone.** Sharing one schema removes the namespace that used
  to keep the two sets of tables apart.

  **Why the read axis is checked and not only the write axis.** `api_tokens` holds the token
  digests, and a `SELECT` on it is the whole attack.

  **Why two roles rather than one with both grants.** ARCHITECTURE §1.2 item 5 forbids the engine to
  write the snapshotter's tables. With no grant, Postgres enforces the prohibition that prose
  otherwise only promises.

  **What the reversal costs, recorded rather than discovered later.** A per-table grant list replaces
  a per-schema one, so a table added by §4.5 needs its grant named in the same migration.

  **A missed grant fails toward refusal, not toward access.** Postgres refuses a statement on a
  table the role was never granted.

  **Why.** An omission shows as a refused statement ⇒ it is observed on the first run, not later.

  **R-30 is unaffected by the reversal.** It requires explicit schema qualification and forbids
  creating anything in `public`; it does not require a second schema.

- **Supply chain / licenses:** the M1 dependencies — `@noble/hashes` (MIT), `bs58` (MIT), `pg`
  (MIT), `better-sqlite3` (MIT), `lru-cache` (ISC), `ulid` (MIT) — are all permissive and compatible
  with the engine's Apache-2.0 (D12). `@grpc/grpc-js` + `@grpc/proto-loader` (Apache-2.0) and a
  vendored `platform-v0.proto` (an IDL file, not code; the `dashpay/platform` license must be
  checked before vendoring, expected permissive) are **not** dependencies today — they arrive with
  the deferred backlog task of a live DAPI transport (§11), not before.
- `pnpm install --frozen-lockfile` in CI.

### 7.4. Provenance of live-recorded artifacts (RF-2)

The golden test and the nine Nansen fixtures are live-recorded evidence that was paid for in
credits. A silent edit to them is indistinguishable from "the vendor changed its response", so their
provenance is pinned by a manifest, a verifier and a pre-commit hook. A hash that a human is
expected to remember to recompute with `shasum` and paste into a document header is not a gate:
nothing can check that the human remembered, and the pasted hash describes a working tree rather
than the commit.

`docs/provenance.json` pins `path → sha256`; `scripts/verify-provenance.mjs` recomputes and compares
from three sources, and the choice between them is the substance of the decision:

| Source     | Who runs it                        | Which gap it closes                                                                                  |
| ---------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `worktree` | `pnpm test` (`provenance.test.ts`) | Catches an edit seconds after it happens, long before a commit                                       |
| `index`    | `.githooks/pre-commit`             | Checks what is ACTUALLY being committed — a clean working tree says nothing about the staged content |
| `head`     | manually                           | Post-hoc analysis                                                                                    |

`--update` is deliberately part of **no gate**: a check that silently rewrites the hash it has just
declared wrong is worse than no check — every silent edit would become a green build. Re-pinning
puts the edit and the new hash in the same diff.

**The boundary of the guarantee.** Git hooks are local: `--no-verify`, or a clone without
`git config core.hooksPath .githooks`, bypasses the commit half. What survives that is the test — a
bypassed commit goes red on anyone's next run — and the manifest itself, whose absence from a diff
touching a pinned file is visible to a reviewer. The mechanism makes a bypass **loud**, not
impossible; by local means it cannot be made impossible. Files are listed explicitly rather than by
glob: adding a new live artifact to the pinned set is also a visible decision.

### 7.5. T-014 — the inbound trust boundary (network deployment profile)

Everything above §7.5 is the OUTBOUND side: what the engine may call, with which secret, and how a
vendor's answer is bounded. T-014 adds the INBOUND side — the first remote caller and the first
trust boundary on the way in.

**In scope.**

- authentication — R-3, R-15
- the principal and its roles — R-6, R-15.3a
- what the role allows, and how profile values are read — R-13, R-14
- the network perimeter — R-12
- the SSRF gate re-read under untrusted input — R-10, R-11
- the two renderings of a refusal — R-31, R-20
- token secrecy — R-5

**Out of scope**, by owner decision.

- charging a client balance and the price list — T-015
- the identity tables' columns and constraints — §4.5
- the transport and session machinery — §3

**Nothing in this section reaches the local stdio profile.** That profile checks no token, so a row
in its identity tables is not protection of stdio (§4.5.1).

#### 7.5.1. The order of checks on one request

The network profile answers a request in this order. Each step states what holds after it.

1. **Perimeter.** `Host` and `Origin` are compared against the configured lists (§7.5.4). Postcondition:
   a request from an unlisted host has cost one string comparison and no store read.
2. **Bearer.** The `Authorization` header is parsed and the token verified (§7.5.2). Postcondition:
   an unauthenticated request has caused no vendor call and no cache read (R-3.3, R-3.4, AC-3).
3. **Principal.** The verified row becomes a `Principal` value (§7.5.3). Postcondition: `ctx.principal`
   is present at the tool boundary, before `resolve()` and before the cache (R-4.3, R-4.4).
4. **Session.** The `sessionId` → `McpServer` mapping is resolved or created (§3). Postcondition: the
   session record names the principal that opened it.
5. **Routing.** The SDK transport dispatches the JSON-RPC message to the tool.

**Why the perimeter runs before authentication.** A perimeter refusal must not read the token store.
Ordering it first makes R-3.3 and R-3.4 hold for it too, without a second argument.

Steps 1 and 2 are protocol-level refusals in R-26.2's sense: they are expressed as an HTTP status
and never reach a tool. Step 5 is where R-26.3's `isError: true` form begins.

**The checks live in the `mcp-server` package**, beside the transport that needs them.
`packages/core` gains no knowledge of tokens, roles or headers. `createServer` keeps its signature
(owner decision, `docs/TASK.md:84`, `не меняет сигнатуру`).

**The SQL that names the identity tables therefore lives in `mcp-server` too.** The authentication
read of `data-model.md` §4.5.4 is issued from this package.

**A second statement arrives with the table-backed profile supplier** (§7.5.3a). T-014 ships the
code-defaults supplier, so that statement is not written this milestone.

**The schema-qualification gate reads `packages/mcp-server/src` as well as `packages/core/src`**
(R-30.3, AC-46). `deployment.md` §10.2.1 item 1 owns the gate and states its input.

**Why.** Every identity statement is a SQL literal in `mcp-server` ⇒ a gate whose input is
`packages/core/src` alone observes none of them.

#### 7.5.2. Authentication (R-3, R-15)

**The credential.** One opaque string presented as `Authorization: Bearer <token>`. It is minted by
a CSPRNG (`node:crypto`'s `randomBytes`) and carries at least 128 bits of entropy (R-15.1).

**Its shape, and why it has one.** `oi_` + an 8-character random label + `_` + a 43-character
base64url secret over 32 random bytes. The stored `prefix` is the leading 11 characters.

**Why a prefix at all.** R-15.2 requires a token to be identifiable without being disclosed. The
prefix names it in an audit row, in an admin listing and in a diagnostics record.

**The prefix is never a lookup key.** Lookup is by digest only. A second lookup path over a shorter,
non-secret value would be a weaker credential wearing the same table.

**The stored value.** `api_tokens.token_hash` holds `sha256(pepper || presented)` as lowercase hex,
where `pepper` is the token hashing salt R-29.1 keeps in `.env` permanently.

**The column declaration carries the same expression** (`docs/architectures/data-model.md:1019`,
`sha256(pepper || presented), lowercase hex`). No deviation is recorded here.

**Why the agreement is recorded.** Review round 1 found this column commented as an unsalted
`sha256` ⇒ the comment was corrected in §4.5.4, and no deviation from it remains.

**Why a single process-wide pepper and not a per-row salt.** The read is one indexed equality on
`token_hash` (§4.5.4). A per-row salt would force a scan over every candidate row.

**Consequence, stated rather than discovered later.** Rotating the pepper invalidates every issued
token at once. There is no re-hash path, because the presented secrets are not stored.

**No secret comparison happens in code.** The engine hashes the presented value and asks the index
for a match, so there is no string equality over a credential to time.

**The verification decision** is taken in code, over the row the query returned, not in its `WHERE`
clause (§4.5.4). Four states refuse, and each is a distinct `refusal_class`:

| State            | Observed on the row             | Client sees |
| :--------------- | :------------------------------ | :---------- |
| unknown token    | no row                          | `401`       |
| revoked          | `api_tokens.status = 'revoked'` | `401`       |
| expired          | `api_tokens.expires_at <= now`  | `401`       |
| suspended person | `users.status = 'suspended'`    | `401`       |

**Why one status for four states.** The class is what an operator needs, and it is recorded in the
`auth.rejected` diagnostics row (§4.5.8). A caller who does not hold a valid token learns nothing
from the difference.

**The class is NOT recorded in `request_trace.refusal_class` on this path.** A request refused at
step 2 has no principal, and `request_trace.principal_id` is `NOT NULL` (`data-model.md` §4.5.7), so
no row of that table can exist for it. `refusal_class` serves the tool-execution refusals, where a
principal has already been resolved. `interfaces.md` §5.4.3 states the same rule from the wire side.

**Why the correction is recorded rather than silently applied.** Two documents disagreed on where an
authentication refusal is observable, and a test written from the wrong one would assert a row that
the schema forbids.

**The response.** HTTP `401` with `WWW-Authenticate: Bearer`, and a JSON-RPC error body carrying
code `-32000` — the same code the SDK's own transport-level refusal uses, so a client parses one
shape (`@modelcontextprotocol/sdk@1.29.0`, `dist/esm/server/webStandardStreamableHttp.js` line 118,
`return this.createJsonErrorResponse(403, -32000, error);`).

**Every request is verified, including a request on an established session.** No verified-token
cache is introduced (§4.5.4), so revocation takes effect on the next request (R-15.6, AC-26).

**A revoked token also loses its session, and the NEXT request is what triggers the drop.** The
refused request removes the `sessionId` → `McpServer` entry and closes the transport.

**A stream already open issues no request, so nothing triggers the drop for it.** Whether such a
stream is terminated is `OQ-T014-IF-2` (`docs/architectures/interfaces.md` §5.4.7).

**The drop is recorded as `session.evicted`, with the cause in `detail_json`.** §4.5.8 names the idle
drop as that event's other cause (R-24.2). The vocabulary is closed and compiled, so revocation
reuses the event rather than inventing a name.

**Why the entry is dropped and not only the request refused.** A Streamable HTTP session holds an
open stream. Leaving the entry in place would let a later POST reattach to a session whose owner no
longer exists.

**A session is bound to the token that opened it.** A request whose principal differs from the one
recorded on the session is refused, even when its own token is valid.

**Why bind it.** A `sessionId` travels in a header and identifies a stream. Without the binding, a
leaked session id would let a second valid principal read the first one's stream.

**Issuing and revoking are admin operations** (R-15.4) and are not request-path code. Every one of
them writes an `access_audit` row (R-15.7).

**The first admin is created by a seed migration** (owner decision, 2026-08-12, closing
`OQ-T014-DM-3`). The migration takes the digest and the visible prefix as parameters, as the
reference project does
(`/Users/sergey/dev-projects/n8n-lazy-loading-skills/sql/019_seed_admin.sql:7`,
`-v ADMIN_TOKEN_SHA256=abc123...64hexchars`).

**The plaintext token reaches neither disk nor the repository.** The operator mints it, computes
`sha256(pepper || token)` outside the migration, and passes the hex digest in
(`/Users/sergey/dev-projects/n8n-lazy-loading-skills/sql/019_seed_admin.sql:17`,
`-- The plaintext token is NEVER stored here. Generate externally:`).

**Why a migration and not a first-run endpoint.** An endpoint that creates an admin is reachable
before any admin exists, which is the one unauthenticated write the network profile must not have.

**The operator procedure is written once, in the runbook**
(`docs/onchain-analytics/PROD-RUNBOOK.md:175`, `## Engine network profile — the first admin token`).
This section states the design; the runbook states the five steps and the loss case.

**The cost of an unauthenticated flood is one indexed read per request**, by construction of steps 1
and 2. Rate limiting of failed attempts belongs to the TLS-terminating proxy (§7.5.4), not here.

#### 7.5.3. The principal, its roles, and what each role sees (R-6, R-15.3a)

**Definition.** A `Principal` is the value that names the caller for the whole request. Its five
fields are declared once, in `system-architecture.md` §3.4.3
(`docs/architectures/system-architecture.md`, `export interface Principal {`). This section states
what the value may not carry and what each role sees.

**Why the declaration is not repeated here.** Two declarations of one type drifted in review round 1:
this section carried `transport` and §3.4.3 did not, while `request_trace.transport` is `NOT NULL`
(§4.5.7).

**It carries no secret.** No token, no digest, no email. `principalId` holds `api_tokens.id` on HTTP
and the literal `local` on stdio (§4.5.7).

**Two roles, from R-15.3a.** Role `admin` is the operator principal of ADR-002 D8. Role `user` is the
client. The local stdio principal has role `admin`, which is what keeps `_meta.budget` present in
UC-3 (`docs/TASK.md:442`, `` `_meta.budget` присутствует в ответах ``).

**The role lives on the user, not on the token** (§4.5.3). A person's two tokens cannot disagree
about what that person may see.

**Limits do not live on the role** (R-15.3b). A role difference in limits is expressed by which
access profile a token references. One mechanism, not two.

**`_meta` visibility is an allowlist per role, applied once**, in `toCallToolResult`
(`packages/mcp-server/src/tools/registry.ts:207`, `const meta = {`):

| `_meta` key | role `admin` | role `user` |
| :---------- | :----------- | :---------- |
| `cache`     | yes          | yes         |
| `timing`    | yes          | yes         |
| `budget`    | yes          | no          |

**Why an allowlist and not a `budget`-shaped exception.** R-6.4 extends the rule to fields added
later. A key absent from the table is invisible to role `user` until someone adds it there.

**Why the projection sits in `toCallToolResult` and not in `budgetMeta()`.** One function renders
every tool's result (`packages/mcp-server/src/tools/registry.ts:205`,
`return { isError: true, content: [{ type: 'text', text: outcome.reason }] };`), so a new tool
inherits the rule instead of restating it.

**`tier` reaches no response** (R-6.2). It stays an `AdapterRegistration` field, `ToolSpec` declares
none (`packages/mcp-server/src/tools/registry.ts:157`, ``**No `tier`, and no price.**``), and AC-7
walks the tool registry rather than a hardcoded count.

**Route disclosure on a SUCCESSFUL response is a per-token setting** (`OQ-T014-IF-1`, closed by the
owner 2026-08-13). It is not a property of the role. It is not a property of the transport.

**Where the setting lives.** On the access profile the token references (R-13), beside
`creditsBalance`, `rateLimit` and `toolAllowlist`. Its column is designed in `data-model.md` §4.5.3.

**Which fields it governs.** `_meta.cache.provider`, `_meta.cache.perSource[]` and
`structuredContent.missingSources`. Each names adapter ids or the order they were walked
(`interfaces.md` §5.4.4, §5.1.6).

**The setting only removes fields from a response.** It adds none. That is what makes it a narrowing
setting under R-29.4, and therefore eligible to move to Postgres later.

**Two boundaries the setting does not reach.**

- `tier` — declared on no transport, unconditionally (`ADR-002` D8, R-6.2). No profile value turns
  that off.
- `_meta.budget` — role `admin` only (R-6.1). The allowlist table above stays its sole rule.

**Phase 0 default: disclosure is permitted.** This matches `ADR-003` D5's single self-issued token,
which carries unlimited quota and all tools. The field exists from the start while its value is
permissive.

**Why the field exists before anyone narrows it.** `ADR-003` D5 states the argument: an absent field
cannot be set to unlimited.

**Why a setting rather than a fixed rule of the wire.** Two kinds of client have opposite needs. An
operator debugging a merge reads which source answered. A paying third party must not read our
supplier list from a successful response.

**The residual, with the phase-0 default in force.** A client today reads our supplier list and our
walk order from a successful response. That is the chosen default, not an oversight. The narrowing
is available per token on the day a paying third party exists.

**The principal reaches the tool through `ToolContext`, not through `AuthInfo`** — see §7.5.7.

#### 7.5.3a. What the role decides, what the access profile decides (R-13, R-14)

The role and the access profile are two mechanisms answering two questions. `system-architecture.md`
§3.4.9 designs where a profile's tool list is applied. This subsection states the split, the reading
rule and the gate over it.

| Question                                   | Decided by                          | Applied in                             |
| :----------------------------------------- | :---------------------------------- | :------------------------------------- |
| which tools a session registers            | the access profile, `toolAllowlist` | §3.4.9, at registration                |
| whether `_meta.budget` is present          | the role                            | §7.5.3, `toCallToolResult`             |
| which rendering of a refusal is returned   | the transport, not the role         | §7.5.6                                 |
| whether issuing and revoking are permitted | the role                            | §7.5.2                                 |
| the credit ceiling and the rate limit      | the access profile                  | T-015; phase 0 declares both unlimited |

**A role carries no number** (R-15.3b). A limit that differs by role is expressed by which profile
the token references.

**Why the split is drawn there.** The role lives on the user and the profile on the token (§4.5.3,
§4.5.4). Two tokens of one person must not disagree about visibility.

**An access profile grants nothing the role withholds.** It selects a subset of the tools the
process serves, and it names no `_meta` key and no refusal rendering.

**Why narrowing cannot grant.** The applied tool set is an intersection (§3.4.9), and `_meta` is an
allowlist per role (§7.5.3). Both operations only remove.

**The stdio principal reaches no profile.** It carries `accessProfileId: null` (§3.4.3), so this
subsection changes nothing in the `local` profile.

**AC-25 belongs to the inventory side and is asserted there** (§3.4.9).

**Profile values are read through one asynchronous interface** (R-13.2, R-13.3), never from the
place they are stored. The declaration:

```ts
// PLANNED — packages/mcp-server/src/auth/access-profile.ts
export interface AccessProfile {
  readonly creditsMode: 'unlimited' | 'metered';
  readonly creditsBalanceRaw: string | null; // exact value as a string
  readonly rateLimitMode: 'unlimited' | 'metered';
  readonly rateLimitPerMin: number | null;
  readonly toolAllowlistMode: 'all' | 'list';
  readonly routeDisclosureMode: 'full' | 'none'; // R-20.4 — data-model.md §4.5.3
  readonly toolAllowlist: readonly string[] | null;
}

export interface AccessProfileReader {
  read(accessProfileId: string): Promise<AccessProfile>;
}
```

**The shape follows the `access_profiles` columns of `data-model.md` §4.5.3, field for field.** Every
value is accompanied by its mode, so "unlimited" is declared rather than inferred from `null`.

**Why a mode beside each value.** A `null` that means unlimited cannot be told apart from a profile
that was never provisioned — the L-10 class of defect.

**T-014 ships one supplier, over defaults in code** (R-13.3). The columns exist and are not read this
milestone (`data-model.md` §4.5.3, `The three limit values are not read from this table in T-014`).

**Why the reader is asynchronous with a single supplier.** The second supplier is a table behind a
connection. A synchronous signature would have to be rewritten to admit it.

**AC-38 observes two suppliers and one reader**, so the substitution is measured rather than
asserted.

**A supplier may refuse, and the refusal is fail-closed.** A failed read at session creation refuses
the session; a failed read on the request path refuses the request. No default profile is
substituted.

**Why fail-closed.** A substituted default would widen an inventory or a ceiling at the moment the
settings source is unavailable.

**R-13.3a — no consumer reads `process.env` or a setting literal directly.** Every consumer receives
the value through the reader above, or through `EnvSchema` for a process setting (§10.3).

**Today's code already satisfies the rule in form.** Measured 2026-08-13 with
`grep -RnE --include='*.ts' "process\.env" packages/core/src packages/mcp-server/src`: 20
occurrences, of which 10 are in comments and 10 in code.

| Form                      | Code sites | Example                                                                                                                    |
| :------------------------ | :--------- | :------------------------------------------------------------------------------------------------------------------------- |
| `deps.env ?? process.env` | 8          | `packages/core/src/adapters/coingecko/index.ts:96`, `const env = deps.env ?? process.env;`                                 |
| a default parameter       | 1          | `packages/core/src/cache/data-dir.ts:13`, `export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {` |
| the schema parse          | 1          | `packages/mcp-server/src/env.ts:167`, `const result = EnvSchema.safeParse(raw ?? process.env);`                            |

**The rule is a property of the code, and R-13.3a makes it checkable.** Nine of the ten sites inject
the environment and fall back to it; one is the schema parse itself.

**The gate: a static check over `packages/core/src` and `packages/mcp-server/src`** — PLANNED,
`packages/mcp-server/test/settings-access.gate.test.ts`. It runs inside `pnpm test`, which
`deployment.md` §10.2 already lists in the pipeline. Its input is the grep above.

1. An occurrence of `process.env` outside `env.ts` and outside the two injection forms fails the
   check. Postcondition: a consumer that reads an environment value directly cannot merge.
2. One of the **seven** `AccessProfile` field names, read outside the reader, its supplier, their
   tests and the two named points of application, fails the check. Postcondition: a second reader of
   one setting cannot appear beside the first.

**The two points of application are named, not excepted wholesale.** The tool-registration loop in
`createServer` reads `toolAllowlist` (§3.4.9); `toCallToolResult` reads `routeDisclosureMode`
(§7.5.3). A rule with no exception would forbid the very use the profile is read for.

**Why a static check rather than review.** §7.3 already names the code-review gate as the weakest of
its three controls, and a direct read is a one-line change.

**Each default carries its measurement beside it** (R-13.4). Phase 0 declares all three limit fields
unlimited (R-13.7, R-14.4) and `routeDisclosureMode` `'full'`, so no measured number is introduced
this milestone.

**Why `'full'` and not `'none'`.** Phase 0 has one principal, and it is the owner's. Starting closed
would hide the merge detail from the only person who reads it, to protect a paying third party who
does not exist yet.

#### 7.5.4. The inbound perimeter (R-12)

Six settings, and what each is measured against.

| Requirement | Setting                        | Default                                 |
| :---------- | :----------------------------- | :-------------------------------------- |
| R-12.1      | `allowedHosts`                 | the bound address and port, no wildcard |
| R-12.2      | `allowedOrigins`               | empty — no browser origin is admitted   |
| R-12.3      | `enableDnsRebindingProtection` | `true`                                  |
| R-12.4      | bind address                   | `127.0.0.1`                             |
| R-12.5      | CORS                           | absent                                  |
| R-12.6      | TLS                            | terminated at the proxy                 |

**The SDK options are set, and a check of our own runs in front of them.** Three measurements make
the second check load-bearing rather than defensive habit.

1. **The three options are deprecated in the installed SDK** (`@modelcontextprotocol/sdk@1.29.0`,
   `dist/esm/server/webStandardStreamableHttp.d.ts` line 82, `@deprecated Use external middleware for host validation instead.`).
2. **The `Host` comparison is exact and case-sensitive** (`dist/esm/server/webStandardStreamableHttp.js` line 115,
   `if (!hostHeader || !this._allowedHosts.includes(hostHeader)) {`). A configured `LOCALHOST:8848`
   would not match a client sending `localhost:8848`.
3. **A request with no `Origin` header passes the origin check** (`dist/esm/server/webStandardStreamableHttp.js` line 124,
   `if (originHeader && !this._allowedOrigins.includes(originHeader)) {`).

**Our check normalizes before comparing:** both sides are lowercased, and a missing port is filled in
from the bound port. It runs before `transport.handleRequest` and returns the same `403` shape.

**Why not rely on the SDK option alone.** Measurement 1 makes it removable by a future SDK release,
and measurement 2 makes a correct configuration depend on the exact letter case a client chooses.

**Why keep the SDK option anyway.** R-12.3 requires it, and two independent checks of one perimeter
fail independently. AC-37 asserts the option is set on the transport.

**Measurement 3 is admitted deliberately.** The engine's clients are servers, and n8n sends no
`Origin`. Refusing an absent `Origin` would refuse the only client T-014 has.

**Loopback is the default bind** (R-12.4). A non-loopback bind is an explicit setting; AC-34
observes that an unconfigured server refuses a connection from a non-loopback address.

**CORS is denied by being absent** (R-12.5). No `Access-Control-Allow-Origin` header is produced
anywhere in the installed SDK's server tree (measured 2026-08-12: `grep -r "Access-Control" dist/esm`
returns nothing), and the engine adds no CORS middleware.

**TLS is terminated at the proxy** (R-12.6). The engine holds no certificate and no private key.

**AC-36 is met by a gate over the schema, not by a parse failure.** `EnvSchema` is deliberately not
`.strict()` (`packages/mcp-server/src/env.ts:30`, ``Deliberately NOT `.strict()`: the real input is `process.env` ``),
so an unknown key is stripped rather than rejected. The gate asserts that no declared key names a
certificate or a private key; 12 keys are declared today (measured 2026-08-12).

**Perimeter refusals are observable** (R-19.4) as the `perimeter.rejected` diagnostics event
(§4.5.8); authentication refusals as `auth.rejected` (R-19.3).

#### 7.5.5. The SSRF gate re-read under untrusted input (R-10, R-11)

The gate was designed when every URL was built from a constant and a validated argument. T-014 adds
a caller the engine did not authenticate before. This subsection re-reads it under that input.

**What the gate compares today.** `assertAllowedHost` tests membership of `url.hostname` in the
allowlist the calling adapter handed it (`packages/core/src/net/safe-fetch.ts:20`,
`if (!allowlist.includes(hostname)) {`).

**The allowlist has two sources, and only one of them is compiled.** Measured 2026-08-12.

| Source                                    | Supplied by                      | Entries                                      |
| :---------------------------------------- | :------------------------------- | :------------------------------------------- |
| `AdapterRegistration.hosts`               | `providers.config.ts`, compiled  | 12 hostnames over 10 of the 12 registrations |
| `chain.rpcHosts`, projected by `hostOf()` | the chain registry, at call time | 34 URLs over 19 chains                       |

**Two registrations carry `hosts: []` and are not HTTP allowlists.** `dash-platform` has no live
transport, and `pg-history` speaks the Postgres wire protocol
(`packages/core/src/providers.config.ts:392`, ``not a hostname allowlist, so `hosts: []` is empty by nature``).

**No entry from either source carries a port today** (measured: 12 bare hostnames, and 0 of the 34
`rpcHosts` URLs with an explicit port).

**Case is already normalized, and by the parser.** Measured 2026-08-12 with `new URL`:
`https://API.Llama.FI/x` has `hostname` `api.llama.fi`, and `https://api.llama.fi:443/x` has `port` `''`.

**The port is not compared at all.** Measured on the same input set: `https://api.llama.fi:8443/x`
has `hostname` `api.llama.fi` and passes an allowlist entry of `api.llama.fi`.

**Design (R-10.1): the comparison becomes a pair.** An allowlist entry is `host` or `host:port`; the
gate compares `(hostname, port === '' ? '443' : port)`. An entry with no port means 443 only.

**Why the port belongs in the comparison.** A redirect `Location` is attacker-influenced input, and
a hop to an allowlisted name on another port is admitted by a hostname-only test.

**Every compiled entry keeps its meaning.** All 12 static hostnames acquire the implicit `:443` they
already meant.

**The runtime-built allowlist needs the same projection.** Both RPC adapters derive their entries
with `hostOf()`, which returns `new URL(url).hostname` and discards the port
(`packages/core/src/adapters/rpc-evm/index.ts:196`, `const allowlist = chainHosts.map(hostOf);`, and
`packages/core/src/adapters/rpc-solana/index.ts:213`, `const allowlist = endpoints.map(hostOf);`).
Under R-10.1 that projection carries the port.

**Why this is a correctness condition, not a refinement.** The endpoint and its allowlist entry are
derived from one curated string. A projection that discards the port refuses the endpoint it came from.

**No curated chain changes meaning today** (measured: 0 of 34 `rpcHosts` entries carry an explicit
port). The load check admits one: `isApprovableRpcUrl` refuses a non-`https` scheme, userinfo, an IP
literal and a credential-shaped path segment, and tests no port
(`packages/core/src/chain/registry-core.ts:142`, `function isApprovableRpcUrl(raw: string): boolean {`).

**A trailing-dot host stays refused.** `https://api.llama.fi./x` has `hostname` `api.llama.fi.`
(measured), which matches no entry. No adapter emits that form, so the gate stays fail-closed and
this paragraph exists so the behaviour is not "fixed" silently.

**Two different mechanisms are both called DNS-rebinding protection, and they face opposite
directions.** They are named apart here because neither substitutes for the other.

| Name                           | Direction | Protects against                                      | Where                         |
| :----------------------------- | :-------- | :---------------------------------------------------- | :---------------------------- |
| `enableDnsRebindingProtection` | inbound   | a browser tricked into addressing our loopback server | SDK transport option (§7.5.4) |
| the outbound address check     | outbound  | a vendor hostname resolving into our network          | `safeFetch` (below)           |

**Design (R-10.2): the outbound address check.** Before the hop, the hostname is resolved with
`node:dns` and every returned address is classified. A loopback, private, link-local, unique-local,
CGNAT or multicast address refuses the call with `SsrfBlockedError`, whose message carries the
hostname only (`packages/core/src/net/safe-fetch.ts:6`,
``super(`host not in adapter allowlist: ${hostname}`);``).

**The class is reused; its message is not.** `SsrfBlockedError`'s current text names the allowlist as
the cause, which is a different refusal. The address check constructs it with its own text and keeps
the hostname as the only interpolated value.

**Why reuse the class at all.** It is already in `PASS_THROUGH_TRANSPORT_ERRORS`
(`packages/core/src/net/safe-fetch.ts:228`, `export const PASS_THROUGH_TRANSPORT_ERRORS = [`), so
every adapter's `catch` treats the new refusal like the old one with no edit.

**Why the check is worth having even though the name is allowlisted.** The allowlist constrains the
NAME. Nothing today constrains where that name resolves, so a hijacked or misconfigured vendor
record points the engine at an internal address.

**What bounds the residual risk: TLS name validation.** `safeFetch` refuses a non-`https` initial URL
(`packages/core/src/net/safe-fetch.ts:601`, `if (initialUrl.protocol !== 'https:') {`) and a
non-`https` redirect target (`:684`, `if (nextUrl.protocol !== 'https:') {`), and no code in
`packages/` sets `rejectUnauthorized` or `NODE_TLS_REJECT_UNAUTHORIZED` (measured: zero occurrences).
An internal host that answers a rebound connection cannot present a certificate for the vendor's
name, so the handshake fails before a request body is sent.

**The residual, stated exactly.** The connection attempt still reaches the substituted address. The
check-then-connect window stays open: `fetch` in Node core exposes no DNS hook, so the verified
address cannot be pinned for the connect.

**The residual is ACCEPTED for T-014** (owner decision, 2026-08-12, closing `OQ-T014-SEC-1`). Its
bound is TLS certificate name validation, measured in the paragraph above.

**Rejected for this milestone: pinning the verified address.** An `undici` agent adds the first
runtime dependency since M1; an `https.request` transport rewrites `safeFetch`
(`docs/backlog/wi-60-verified-outbound-address-is-not-pinned-for-the-connect.md:33`, `**Options.**`).

**The curated allowlist is a declared precondition of the acceptance**, not a background fact. Every
outbound host is approved by a human and committed (§7.2.1, rule 1).

**AC-22 was reformulated to match what is designed** (`docs/TASK.md:487`,
`Проверенный исходящий адрес не закрепляется`). It asks for the TLS name check plus a recorded
acceptance of the residual, and names the curated allowlist as the precondition.

**The original requirement is filed as WI-60, with a trigger and no date**
(`docs/backlog/wi-60-verified-outbound-address-is-not-pinned-for-the-connect.md:29`,
`**Условие пересмотра — не календарь, а событие.**`).

**What reopens it: the first non-curated outbound host.** A host that enters the allowlist from data
ends the precondition, and WI-60 becomes a defect at that moment.

**Design (R-10.3): the redirect limit gets a type.** `safeFetch` throws a plain `Error` on the
redirect cap (`packages/core/src/net/safe-fetch.ts:678`,
``throw new Error(`safeFetch: exceeded ${MAX_REDIRECTS} redirects following ${redactUrl(url)}`);``).
It becomes `SafeFetchRedirectLimitError`, redacting its URL at construction, and joins
`PASS_THROUGH_TRANSPORT_ERRORS` (`:228`, `export const PASS_THROUGH_TRANSPORT_ERRORS = [`).

**Why a type rather than a message match.** An adapter that wraps an untyped throw loses the class
on `.cause`, where `instanceof` cannot see it — the defect WI-36 already closed for the other three
transport classes.

**Two plain `Error`s remain and are named here rather than left to be discovered:** the non-`https`
initial URL and the non-`https` redirect target. R-10.3 covers the redirect cap only, and typing
these two is a separate decision.

**The allowlist stays per-adapter, and per-chain in the two RPC adapters** (R-10.4, §7.2.1). The port
term narrows an entry and merges no lists; a compromise of one adapter still grants no access to
another's hosts (§7.3).

**No tool input yields a host, a URL or an RPC endpoint (R-11).** Measured 2026-08-12 over
`packages/mcp-server/test/fixtures/tools-list.snapshot.json` — the frozen `tools/list` contract:

| Quantity                                  | Value |
| :---------------------------------------- | :---- |
| tools                                     | 20    |
| input properties across all tools         | 43    |
| distinct property names                   | 14    |
| properties naming a host, URL or endpoint | 0     |

The 14 names are `address`, `capability`, `chain`, `days`, `exhaustive`, `family`, `includeSeries`,
`limit`, `minTvlUsd`, `protocolSlug`, `query`, `series`, `sortedBy`, `tokenAddress`.

**`chain` remains a registry key** (R-11.3). It selects a curated row, and `rpcHosts` on that row is
the only source of an RPC endpoint (§7.2.1). A chain string never becomes a host.

**An argument can reach a vendor URL's PATH or QUERY, and that is bounded elsewhere.** Measured
2026-08-12: 6 `encodeURIComponent` call sites in three adapters, 1 `URLSearchParams`, and
`blockscout` composing its URL from a literal path at all three of its call sites
(`packages/core/src/adapters/blockscout/index.ts:370`, `const url = new URL(path, base);`). The host
is decided before any of it.

**AC-11's gate walks the tool registry** and asserts the property per schema. The count is not
written into the gate, so a 21st tool is checked without an edit (the RF-5 rule §3 already applies
to eval cases).

#### 7.5.6. Two renderings of a refusal (R-31, R-20)

**What leaks today.** Every string below reaches the client verbatim. The path is one:
`error.message` → `tried[].reason` → `CapabilityUnavailableError.message` →
`resolveCapability`'s `reason` (`packages/mcp-server/src/tools/resolve-capability.ts:174`,
`return { ok: false, reason: error instanceof Error ? error.message : String(error) };`) → the
`isError` text (`packages/mcp-server/src/tools/registry.ts:205`,
`return { isError: true, content: [{ type: 'text', text: outcome.reason }] };`).

| Coordinate                                             | What the client is handed                                                                             | Forbidden by |
| :----------------------------------------------------- | :---------------------------------------------------------------------------------------------------- | :----------- |
| `packages/core/src/cache/budget-store.ts:346`          | `` `budget exceeded for provider=${provider}: need ${cost}, used ${used}, ceiling ${ceiling}` ``      | R-31.3       |
| `packages/core/src/cache/budget-store.ts:377`          | `` `velocity limit reached for provider=${provider}: need ${cost}, used ${windowUsed} ` ``            | R-31.3       |
| `packages/core/src/cache/budget-store.ts:395`          | `` `call rate limit reached for provider=${provider}: ${windowCalls} of ` ``                          | R-31.3       |
| `packages/core/src/adapters/nansen/budget-gate.ts:664` | `` ` — set NANSEN_DAILY_CREDIT_CAP to raise it, or ${DAILY_CAP_OFF} to disable it` ``                 | R-31.2       |
| `packages/core/src/adapters/nansen/budget-gate.ts:612` | `` `NANSEN_MAX_CALLS_PER_MIN to raise it, or ${MAX_CALLS_OFF} to disable it. ` ``                     | R-31.2       |
| `packages/core/src/adapters/nansen/budget-gate.ts:621` | `` `or set NANSEN_VELOCITY_CREDITS_PER_MIN to raise it, or ${VELOCITY_OFF} to disable it. ` ``        | R-31.2       |
| `packages/core/src/adapters/registry.ts:38`            | `` `capability unavailable: ${details.capability} on ${details.chain} — tried: ${triedText}` ``       | R-31.4       |
| `packages/core/src/adapters/registry.ts:83`            | `` `capability deadline exceeded: ${details.capability} on ${details.chain} — tried: ${triedText}` `` | R-31.4       |
| `packages/core/src/net/rate-limit.ts:136`              | ``super(`throttle: rejected for provider "${providerId}": ${reason}`);``                              | R-31.4       |

**The table above is a sample, and says so.** `budget-store.ts` carries 8 strings interpolating
`provider=${provider}` (measured 2026-08-12); 3 of them are listed. The 5 unlisted ones are the
fail-closed branches, and they name the provider and the ledger state the same way.

**Why the sample is not enlarged into a list.** The design below builds client text from the refusal
class, so a complete census of producers is not a precondition for it. A census would be one, and
that is the property §7.5.6 exists to avoid.

**The walk order is the disclosure that is easy to miss.** `entity.labels` is routed
`['blockscout', 'nansen']` (`packages/core/src/providers.config.ts:169-170`), so a refusal naming
the order tells a client which source is free and which is paid.

**Design: two renderings, produced from one refusal value.**

- **Operator rendering** — today's full text, unchanged, written to stderr and to
  `diagnostics.detail_json` under event `tool.refused` (§4.5.8).
- **Client rendering** — a compiled template chosen by refusal class, plus four parameters:
  capability, chain, retry-after seconds where the class has one, and the correlation id.

**The client rendering is built from the class, never from `error.message`.** No branch derives
client text by editing, truncating or filtering an existing message.

**Why not sanitize the existing message.** A filter must know every producer of the string,
including a vendor body an adapter embeds. A compiled template has no such dependency.

**The correlation id is the `request_trace.id`.** It is what lets an operator answer "why" from
`diagnostics`, and it discloses nothing on its own.

**Which rendering each side receives** (`OQ-T014-SEC-2`, closed by the owner 2026-08-13).

| Deployment profile          | Principal    | Rendering returned to the caller | Operator rendering is read in |
| :-------------------------- | :----------- | :------------------------------- | :---------------------------- |
| `network`, `network-sqlite` | role `admin` | client                           | stderr and `diagnostics`      |
| `network`, `network-sqlite` | role `user`  | client                           | stderr and `diagnostics`      |
| `network`, `network-sqlite` | no principal | client                           | stderr and `diagnostics`      |
| `local`                     | role `admin` | operator                         | stderr, read directly         |

**The network rule is unconditional in the role.** No response over the network transport carries
operator detail.

**Why not a role-conditional rule.** A gate over it passes while constructing only the client
principal, so the operator branch is never asserted. An operator rendering on the wire also turns a
leaked `admin` token into disclosure of our unit economics.

**The client rendering carries the event identifier and nothing of the operator's.** It names no
environment variable, no credit or ceiling number, no adapter id and no walk order.

**The identifier appears in both places or it joins nothing.** The client rendering carries it, and
the stored row carries the same value. An administrator who needs the detail looks it up.

**Neither the stored column nor the wire field is designed here.** The stored coordinate is
`data-model.md` §4.5.8. The response field is `interfaces.md` §5.4.3.

**`_meta.budget` is untouched by this decision.** It stays bound to role `admin` (R-6.1). It is a
field of a SUCCESSFUL response, and a refusal rendering does not carry it.

**Local stdio is unchanged** — its principal is `admin` (§7.5.3), there is no remote principal, and
the operator reads stderr directly. Today's text is what the host keeps seeing, and
`packages/mcp-server/test/e2e.inprocess.test.ts:539`
(`expect(block.text).toContain('token.price');`) holds.

**AC-47's gate reads two vocabularies out of the repository** rather than restating them: the 12
adapter ids in `adapterRegistrations` and the 12 keys of `EnvSchema` (both measured 2026-08-12). For
every refusal class, the client rendering must contain neither.

**AC-47's scope is settled by this decision.** The criterion asserts that no response over the
network transport carries operator detail. The gate constructs no role exception.

**The settled scope makes the gate simpler to write, not harder.** A role-conditional gate is the
kind that passes by only building one principal.

**R-20.3 — the composition of `tried[]` and `missingSources`, revised.**

1. **`tried[]` is operator-side only.** It is already absent from every response body and lives
   inside the message being replaced; the ordered walk stays in `request_trace.tried_json` (§4.5.7).
2. **`missingSources` stays on the wire, with adapter ids.** One tool publishes it
   (`packages/mcp-server/src/tools/dash-platform-history.ts:110`, `missingSources: z`), and its
   participants are all `tier: 'free'` by a startup check (`assertMergeParticipantsAreFree`), so an
   id there discloses no paidness and no walk order.
3. **`missingSources[].reason` becomes a compiled class label for role `user`.** Its value can be a
   participant's own `error.message` today (`packages/core/src/adapters/registry.ts:1232`,
   `tried.push({ adapterId, reason: error instanceof Error ? error.message : String(error) });`),
   which is vendor text. The free text stays in the trace.

**Why `missingSources` is kept rather than dropped.** It is the only carrier of "a source
contributed nothing" (T-013 R-171(e)).

**What dropping it would produce.** A partial merge would be answered as a complete one — the L-10
class of defect this project has already paid for once.

**The refusal path and the success path use different mechanisms** (`OQ-T014-IF-1`, closed by the
owner 2026-08-13). Which rendering of a refusal is returned stays a function of the role, as stated
above. Route disclosure on a SUCCESSFUL response is a per-token setting on the access profile
(§7.5.3).

**What this changes for item 2 above.** `missingSources` stays published by default, and the
per-token setting is what can remove it. `interfaces.md` §5.1.6 owns the resulting wire shape.

**The two rules compose on item 3.** The role decides the text of `missingSources[].reason`. The
setting decides whether the field is present at all.

**The setting is not an escape hatch, and two boundaries show it.** `tier` reaches no response on
any transport (`ADR-002` D8). `_meta.budget` stays bound to role `admin` (R-6.1). A profile value
widens neither, because the setting can only remove fields.

**The residual on this path is stated in §7.5.3.** With the phase-0 default permissive, a successful
response still discloses our supplier list and walk order.

#### 7.5.7. Token secrecy (R-5)

**Four channels, and what each carries.**

| Channel     | Carries the token | Mechanism                                                  |
| :---------- | :---------------- | :--------------------------------------------------------- |
| `args_hash` | no                | the hash input is `(capability, args)` only                |
| `_meta`     | no                | the role allowlist has no principal key (§7.5.3)           |
| stderr      | no                | diagnostics print the row id, never the principal (§4.5.8) |
| the store   | digest only       | `sha256(pepper \|\| presented)` (§7.5.2)                   |

**`args_hash` is unchanged by T-014** (R-5.1). It is `deriveArgsHash(capability, args)`
(`packages/core/src/net/args-hash.ts:44`,
`export function deriveArgsHash(capability: string, args: Record<string, unknown>): string {`), and
no principal is added to either input. AC-8 observes two principals producing one hash.

**`AuthInfo.token` is filled with the token's PREFIX, never the presented secret.** The SDK forwards
the whole object into every tool handler's `extra`
(`@modelcontextprotocol/sdk@1.29.0`, `dist/esm/shared/protocol.d.ts` line 181, `authInfo?: AuthInfo;`).

**Why this matters more than a convention.** `AuthInfo.token` is a required field of the SDK's type,
so the credential would travel into handler code the engine did not write, and one handler logging
`extra` would publish it. The prefix satisfies the type and identifies the token (R-15.2).

**The principal reaches a tool through `ToolContext`**, projected by `needs` like every other
context key (`packages/mcp-server/src/tools/registry.ts:42`,
`export interface ToolContext {`), so a tool that did not declare it cannot read it.

**The bearer never enters a cache key, a trace row or an audit row.** `request_trace` records
`principal_id` (`api_tokens.id`), and `access_audit` records the token's `id` and `prefix` (§4.5.5).

#### 7.5.8. Questions raised by this section, and their state

**`OQ-T014-SEC-1`, 2026-08-12, owner Sergey: closed for T-014.** The verified outbound address is not
pinned for the connect. The residual is bounded by TLS certificate name validation and is ACCEPTED,
on the declared precondition that every outbound host is curated (§7.5.5). Rejected: an `undici`
dependency with `Agent({connect: {lookup}})` — the first runtime dependency since M1; and an
`https.request` transport using `net.connect`'s `lookup` option — a rewrite of `safeFetch`.

**The requirement itself is carried forward, not dropped.** WI-60 holds it, triggered by the first
non-curated outbound host
(`docs/backlog/wi-60-verified-outbound-address-is-not-pinned-for-the-connect.md:29`,
`**Условие пересмотра — не календарь, а событие.**`).

**AC-22 no longer depends on an open question.** Its current text asserts what §7.5.5 designs
(`docs/TASK.md:487`, `Проверенный исходящий адрес не закрепляется`).

**`OQ-T014-SEC-2`, 2026-08-13, owner Sergey: closed for T-014.** No principal receives the operator
rendering of a refusal over the network transport, whatever its role. The client rendering carries
the event identifier; the full text stays in the log and in `diagnostics` (R-32.1, R-32.2). The rule
is designed in §7.5.6.

**Rejected: return the operator rendering to role `admin`.** The gate over it would be
role-conditional, and such a gate passes while constructing only the client principal. A leaked
`admin` token would additionally disclose our unit economics.

**Rejected: bind the operator rendering to the `local` profile with no identifier in the client
rendering.** A remote operator then loses the detail entirely. The container log may not be
reachable from where that operator works.

**AC-47 no longer depends on an open question.** Its scope is the network transport with no role
exception (§7.5.6), which its current text asserts
(`docs/TASK.md:510`, `Ни один ответ по сетевому транспорту не несёт операторских деталей`).
