import { normalizeAddress } from '../../chain/address.js';
import type { ChainInfo, ChainRegistry } from '../../chain/registry-core.js';
import { loadChainRegistry } from '../../chain/registry.js';
import { throttle as productionThrottle, type Throttle } from '../../net/rate-limit.js';
import { DeadlineExceededError, safeFetch } from '../../net/safe-fetch.js';
import { adapterRegistrations } from '../../providers.config.js';
import { WalletSchema, type Wallet } from '../../types/wallet.js';
import type { Chain } from '../../types/chain.js';
import type { ProviderAdapter } from '../types.js';
import { stringifyTruncated } from '../stringify-truncated.js';

const REGISTRATION = adapterRegistrations.find((r) => r.id === 'rpc-solana');
if (!REGISTRATION) {
  throw new Error('rpc-solana: no matching entry in adapterRegistrations (providers.config.ts)');
}
const RATE_LIMIT = REGISTRATION.rateLimit;

/* Endpoints and the SSRF allowlist come from the REQUESTED chain's own curated `rpcHosts` and from
 * nowhere else (vdd-multi cycle 6, H-1) — the identical fix `rpc-evm` received one cycle earlier
 * and this twin did not. The module used to hold `const ENDPOINT = https://${HOSTS[0]}`, i.e.
 * Solana mainnet, and send every request there while `chainSupport()` advertised coverage for ANY
 * svm row with a curated host. The moment a second SVM chain is curated — which this branch exists
 * to make a data edit rather than a code change — that chain's balance query would have been
 * answered by Solana mainnet, labelled with the other chain's slug, cached, and schema-valid. */

/** `https://host/...` → `host`. **Throws** on an unparseable entry rather than passing it through
 * (vdd-multi cycle 6, security M-1): this value becomes an SSRF ALLOWLIST entry, and a security
 * control's default on malformed input must be "drop", never "trust the raw string". A bare
 * `evil.example` would otherwise be unusable as an endpoint (so no test would ever exercise it)
 * while still widening the set of hosts a redirect may be followed to. */
function hostOf(url: string): string {
  // The AUTHORITY, not the hostname (task 014-21, AC-9): `URL.host` keeps a non-default port and
  // drops `:443`. This value is both the SSRF allowlist entry and the string an error message
  // names, and `assertAllowedHost` now compares authorities — so a curated `rpcHosts` endpoint on a
  // non-default port would, with `.hostname` here, build an allowlist that refuses the very
  // endpoint it was derived from. None of the 34 registry rows carries a port today; this is what
  // keeps that from becoming a condition nobody wrote down.
  return new URL(url).host;
}

/** Optional constructor dependencies (injectable, same DI convention as `rpc-evm`). Keyless — no
 * `env` dependency needed. */
export interface RpcSolanaAdapterDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Chain registry supplying family + curated RPC hosts (TASK-006 R-54/R-56). */
  chains?: ChainRegistry;
  /** Injectable throttle, the same seam `blockscout`/`blockchain-info`/`nansen` expose (WI-26).
   * Production omits it and gets the shared singleton; a test passes `createThrottle()` so its
   * bucket is its own and the file's runtime stops depending on what else ran in the process. */
  throttle?: Throttle;
}

interface RpcSolanaFetchResult {
  chain: Chain;
  address: string;
  /** Carried from the registry so `normalize()` labels the balance with THIS chain's gas token —
   * same reasoning as `rpc-evm` (cycle 5, H-3). `SOL`/9 were literals here. */
  nativeSymbol: string;
  nativeDecimals: number;
  raw: unknown;
  /**
   * WI-8 — `result.value`'s digits **exactly as they appeared on the wire**, before any conversion
   * to a double. Optional on purpose: it is present for everything `fetch()` produces, and absent
   * when `normalize()` is driven directly with a hand-built object (contract tests, and any future
   * caller replaying a stored DTO). `normalize()` treats its absence as "exactness unknown" and
   * falls back to the conservative pre-WI-8 rule rather than inventing digits.
   */
  lamportsRaw?: string;
}

interface JsonRpcGetBalanceResponse {
  result?: { context?: { slot?: unknown }; value?: unknown };
  error?: { code?: unknown; message?: unknown };
}

/**
 * The third reviver argument from *JSON.parse source text access* (ES2025; measured available on
 * this project's declared floor — Node v22.23.1 — and on CI's Node 22). Typed locally because the
 * TypeScript lib bundled with this repo does not yet declare it.
 */
interface JsonParseContext {
  source?: string;
}

/**
 * WI-8 — parse a `getBalance` response while keeping `result.value`'s **exact** integer digits.
 *
 * Solana's JSON-RPC returns the lamport balance as a bare JSON **number**, unlike `eth_getBalance`
 * which returns a hex string. Past `Number.MAX_SAFE_INTEGER` (~9.007e15 lamports ≈ 9.007M SOL) a
 * double can no longer represent every integer, so `JSON.parse` alone loses the true value before
 * any adapter code runs: `12345678901234567` comes back as `12345678901234568`.
 *
 * The recovery is to ask the parser what it *read*, not what it produced. The reviver's `context`
 * carries `source` — the literal substring for each primitive — and `this` is the holder object, so
 * the digits can be attributed to the specific object they came from. Keying a `WeakMap` on holder
 * identity is what makes this exact rather than a heuristic: no regex over the body, no assumption
 * that `"value"` occurs once, no ambiguity if the vendor ever nests another `value` elsewhere. The
 * token is taken only from the holder that turns out to BE `result`.
 */
function parseGetBalance(text: string): {
  raw: JsonRpcGetBalanceResponse;
  lamportsRaw: string | undefined;
} {
  const valueSources = new WeakMap<object, string>();
  const reviver = function (
    this: unknown,
    key: string,
    value: unknown,
    context?: JsonParseContext,
  ): unknown {
    if (key === 'value' && typeof context?.source === 'string' && typeof this === 'object') {
      if (this !== null) valueSources.set(this, context.source);
    }
    return value;
  } as (key: string, value: unknown) => unknown;

  const raw = JSON.parse(text, reviver) as JsonRpcGetBalanceResponse;
  const holder = raw.result;
  return {
    raw,
    lamportsRaw:
      typeof holder === 'object' && holder !== null ? valueSources.get(holder) : undefined,
  };
}

function extractFetchArgs(
  args: Record<string, unknown>,
  chains: ChainRegistry,
): { chain: ChainInfo; address: string } {
  const rawChain = args['chain'];
  const address = args['address'];
  const chain = typeof rawChain === 'string' ? chains.tryResolve(rawChain) : null;
  // TASK-006 (task 006-5): the same condition `chainSupport()` reports — family plus a CURATED
  // RPC host. `rpcHosts: null` is not "misconfigured", it is "we never approved a host for this
  // chain" (security.md §7.2.1), and the coverage gate should have refused long before here.
  if (!chain || !servesChain(chain) || typeof address !== 'string') {
    throw new Error(
      `rpc-solana.fetch: invalid args ${JSON.stringify(args)} (expected {chain: <an svm chain with a curated RPC host and a known native currency>, address: string})`,
    );
  }
  return { chain, address };
}

/** The single definition of "this adapter can serve that chain" — read by `chainSupport()` (what
 * the coverage matrix advertises) AND by `extractFetchArgs()` (what the transport accepts). Two
 * readers, one predicate; mirrors `rpc-evm`'s `servesChain` exactly. */
function servesChain(chain: ChainInfo): boolean {
  return (
    chain.family === 'svm' &&
    chain.rpcHosts !== null &&
    chain.nativeSymbol !== null &&
    chain.nativeDecimals !== null
  );
}

/**
 * `rpc-solana` adapter (ARCHITECTURE.md §3.2/§5.3, R-16/R-17, OQ-1 resolved): `wallet.balances.native`
 * on solana via JSON-RPC `getBalance` — keyless, single confirmed endpoint
 * (`api.mainnet-beta.solana.com`, live-probed 2026-07-22). A second keyless Solana RPC fallback
 * candidate is explicitly OUT of M1 (ARCHITECTURE.md §11 — "not a hot-swap, a single point of
 * failure with retry" until a second candidate gets its own live probe); this adapter therefore
 * has exactly one endpoint, unlike `rpc-evm`'s two.
 *
 * **Exact lamports past 2^53 (WI-8, closed 2026-07-28).** Unlike `eth_getBalance` (hex-wei as a
 * STRING, arbitrary precision for free), `getBalance` returns `result.value` as a bare JSON
 * **number**, so a balance above `Number.MAX_SAFE_INTEGER` (~9.007e15 lamports ≈ 9.007M SOL) is
 * not representable as a double. This module used to record that as an unrecoverable vendor
 * limitation and refuse such balances outright; that was true of `response.json()`, and false of
 * the wire format. The response text still carries the exact digits — `parseGetBalance()` lifts
 * them straight out of the parser (see its docstring), and `amountRaw` carries them verbatim
 * (DB-SCHEMA-CONCEPT §1.7). `amountNum` remains the deliberately lossy projection.
 *
 * A refusal is still possible and still loud: when the exact digits are unavailable (a caller
 * driving `normalize()` with a hand-built DTO rather than a `fetch()` result) a value past the safe
 * range throws instead of emitting a plausible-looking wrong number.
 *
 * **Bounded error messages (post-M1 polish, cheap-fix backlog item 5):** the JSON-RPC error
 * payload and the invalid-response envelope are embedded via `stringifyTruncated()`
 * (`../stringify-truncated.js`), never a raw, unbounded `JSON.stringify(...)` — an oversized or
 * malicious response body no longer produces an equally-oversized `Error` message.
 */
export function createRpcSolanaAdapter(deps: RpcSolanaAdapterDeps = {}): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const chains = deps.chains ?? loadChainRegistry();
  const throttle = deps.throttle ?? productionThrottle;

  return {
    id: 'rpc-solana',
    // TASK-006 (R-54): mirrors `rpc-evm` — the SVM family plus a curated RPC host. data-model.md
    // §4.2.3 words this as `caip2 === <solana mainnet>`; expressed as family + `rpcHosts` instead,
    // it stays consistent with its EVM twin and avoids hardcoding a chain id back into an adapter,
    // which is the coupling this task removes. Equivalent while Solana is the only SVM chain with
    // a curated host, and correct by construction if another ever appears.
    chainSupport: servesChain,
    // No `chains` literal — `servesChain` owns that answer (vdd-multi cycle 6, M-7).
    capabilities: () => [{ id: 'wallet.balances.native' }],
    costOf: () => ({ credits: 0 }),
    fetch: async (
      _cap: string,
      args: Record<string, unknown>,
      /** WI-37 — forwarded to the limiter and to EVERY hop of the endpoint fallback loop below. */
      deadlineAtMs?: number,
    ): Promise<RpcSolanaFetchResult> => {
      const { chain, address } = extractFetchArgs(args, chains);
      const normalizedAddress = normalizeAddress(chain, address);
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [normalizedAddress],
      });

      await throttle('rpc-solana', RATE_LIMIT, 1, deadlineAtMs);

      // Per-chain endpoints + per-chain allowlist, walked in the order a human approved them.
      const endpoints = [...(chain.rpcHosts ?? [])];
      const allowlist = endpoints.map(hostOf);

      let lastError: unknown;
      for (const endpoint of endpoints) {
        try {
          const response = await safeFetch(
            endpoint,
            { method: 'POST', headers: { 'content-type': 'application/json' }, body },
            allowlist,
            fetchImpl,
            // Spread conditionally so a call without a deadline builds the same options object
            // this loop built before WI-37.
            { ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }) },
          );
          if (!response.ok) {
            // `hostOf`, not the full URL (vdd-multi cycle 6, security L-2): `rpcHosts` is a
            // full-URL column, this message reaches the model, and a curated endpoint could one
            // day carry a key in its path or query. `safeFetch`'s own errors already do this.
            throw new Error(`rpc-solana: HTTP ${response.status} for ${hostOf(endpoint)}`);
          }
          // `.text()` then `parseGetBalance`, never `.json()` (WI-8): `response.json()` hands back
          // only the parsed double, discarding the digits needed to stay exact past 2^53.
          const { raw, lamportsRaw } = parseGetBalance(await response.text());
          if (raw.error) {
            throw new Error(
              `rpc-solana: JSON-RPC error from ${hostOf(endpoint)}: ${stringifyTruncated(raw.error)}`,
            );
          }
          return {
            chain: chain.slug,
            address: normalizedAddress,
            // Non-null by `servesChain()`, enforced in `extractFetchArgs` above.
            nativeSymbol: chain.nativeSymbol as string,
            nativeDecimals: chain.nativeDecimals as number,
            raw,
            lamportsRaw,
          };
        } catch (error) {
          lastError = error;
          // Our own time being up is true of every REMAINING endpoint, not of this one — see the
          // identical break in `rpc-evm` for the full reasoning. The fallback list exists for
          // endpoints that are down, and a deadline is not an endpoint's condition.
          if (error instanceof DeadlineExceededError) break;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(`rpc-solana: all endpoints failed for chain ${chain.slug}`);
    },
    normalize: (_cap: string, rawResult: unknown): Wallet => {
      const { chain, address, nativeSymbol, nativeDecimals, raw, lamportsRaw } =
        rawResult as RpcSolanaFetchResult;
      const body = raw as JsonRpcGetBalanceResponse;
      const lamports = body.result?.value;
      // Adversarial cycle 1, fix F: `lamports` must be a non-negative integer before it is ever
      // handed to `String()` — a fractional value (`1.5`, never a valid lamport count) or a
      // negative one gets a loud, clear error instead of a silently wrong `amountRaw`.
      if (typeof lamports !== 'number' || !Number.isInteger(lamports) || lamports < 0) {
        throw new Error(
          `rpc-solana.normalize: invalid lamports value in "result.value": ${stringifyTruncated(raw)}`,
        );
      }

      // WI-8 — exactness, in three cases and no fourth. `lamportsRaw` carries the wire digits when
      // `fetch()` produced this result (`parseGetBalance`), so a balance past 2^53 is now exact
      // rather than refused. Its ABSENCE is not treated as permission to guess: without the
      // digits, anything past the safe range is unrepresentable and the call is refused, which is
      // exactly the pre-WI-8 behaviour for that path. `String(lamports)` is used only where it is
      // provably lossless.
      let amountRaw: string;
      if (
        typeof lamportsRaw === 'string' &&
        /^(0|[1-9][0-9]*)$/.test(lamportsRaw) &&
        // Self-check: the digits must be the ones this very number was parsed from. Cheap, and it
        // makes a future mis-attribution a loud failure rather than a wrong balance.
        Number(lamportsRaw) === lamports
      ) {
        amountRaw = lamportsRaw;
      } else if (lamports > Number.MAX_SAFE_INTEGER) {
        throw new Error(
          `rpc-solana.normalize: invalid lamports value in "result.value" — past ` +
            `Number.MAX_SAFE_INTEGER with no exact wire digits available, so the true balance ` +
            `cannot be recovered: ${stringifyTruncated(raw)}`,
        );
      } else {
        amountRaw = String(lamports);
      }

      const wallet: Wallet = {
        chain,
        address,
        balances: [
          {
            assetType: 'native',
            // From the registry, never a literal (vdd-multi cycle 6, H-1 — see `servesChain()`).
            symbol: nativeSymbol,
            decimals: nativeDecimals,
            // Exact integer as a string (DB-SCHEMA-CONCEPT §1.7) — carrying the wire digits
            // verbatim past 2^53, where `amountNum` below cannot (WI-8).
            amountRaw,
            // The lossy projection, kept deliberately (§1.7): convenient for charts/comparisons,
            // never the source of truth. Above ~9.007M SOL it differs from `amountRaw`, which is
            // the whole reason `amountRaw` is a string.
            amountNum: lamports,
          },
        ],
        source: 'rpc-solana',
        fetchedAt: now(),
      };
      return WalletSchema.parse(wallet);
    },
    // Keyless JSON-RPC — no env precondition to check.
    isAvailable: () => ({ ok: true }),
  };
}
