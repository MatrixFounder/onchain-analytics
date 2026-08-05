# 7. Security

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

### 7.1. Authentication and authorization

N/A for the engine itself — it is a local stdio process and trust is delegated to the host process.
The optional read-only PG client adds no auth perimeter: authorization happens on the Postgres role
(recommendation in §7.3), and the engine only consumes a DSN.

### 7.2. Data protection

- Secrets live only in `.env` (0600) with zod validation (D10). All six optional keys (§3.2) obey
  the same rule: never logged, never part of a cache key.
- `NANSEN_API_KEY` (M2, TASK-005, R-45) is the sixth optional key and follows the same contract. The
  `apiKey: <NANSEN_API_KEY>` header is already covered by the existing
  `SENSITIVE_HEADER_RE = /authorization|api-?key/i` in `net/safe-fetch.ts:83` — **no regex change is
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
(`chain.tvl`, `token.price`, `token.metadata`, `pairs.new`), which need no RPC.

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

- **stdout discipline** (M0 invariant) holds for all 13 tools. `_meta` — including `_meta.budget`
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
- **PG read-only (R-12):** the engine issues `SELECT` only, enforced by a code-review gate. The
  **recommendation for the DB operator** is that the Postgres role the engine connects as be
  server-side SELECT-only (`GRANT SELECT ON SCHEMA onchain TO <role>`, no `INSERT/UPDATE/DELETE`) —
  code discipline is not protection against a leaked key or DSN. This is defense in depth the engine
  cannot provide for itself.
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
