import { normalizeAddress } from '../../chain/address.js';
import type { ChainInfo, ChainRegistry } from '../../chain/registry-core.js';
import { loadChainRegistry } from '../../chain/registry.js';
import { throttle as productionThrottle, type Throttle } from '../../net/rate-limit.js';
import { DeadlineExceededError, safeFetch } from '../../net/safe-fetch.js';
import { adapterRegistrations } from '../../providers.config.js';
import { GasPriceSchema, type GasPrice } from '../../types/chain-activity.js';
import { WalletSchema, type Wallet } from '../../types/wallet.js';
import type { Chain } from '../../types/chain.js';
import type { ProviderAdapter } from '../types.js';
import { stringifyTruncated } from '../stringify-truncated.js';

const REGISTRATION = adapterRegistrations.find((r) => r.id === 'rpc-evm');
if (!REGISTRATION) {
  throw new Error('rpc-evm: no matching entry in adapterRegistrations (providers.config.ts)');
}
const RATE_LIMIT = REGISTRATION.rateLimit;

/* Endpoints and the SSRF allowlist come from the requested chain's own curated `rpcHosts` row and
 * from nowhere else (TASK-006 task 006-8, R-56; hardened in vdd-multi cycle 5, M-3). The
 * per-adapter `REGISTRATION.hosts` list is deliberately NOT used as a fallback: those are
 * ETHEREUM's endpoints, so falling back to them for any other chain answers with the wrong chain's
 * balance — schema-valid, cached, and undetectable downstream. Within-chain primary→fallback retry
 * still exists; it now walks that chain's own approved list, in the order a human approved it
 * (ARCHITECTURE.md §3.2/§5.3, security.md §7.2.1). */

/** `https://host/...` → `host`. The registry stores full URLs (a human approves a URL, not a bare
 * hostname); `safeFetch`'s allowlist is hostname-based.
 *
 * **Fails CLOSED** (vdd-multi cycle 6, security M-1). This used to `catch { return url; }` — a
 * security control defaulting to "trust the raw string" on malformed input. The value becomes an
 * SSRF allowlist ENTRY, so a bare `evil.example` (no scheme) was unusable as an endpoint, and
 * therefore never exercised by any test, while still widening the set of hosts a redirect could be
 * followed to. Throwing makes a malformed row a loud failure of that one chain's request instead of
 * a silent widening of the perimeter — and `ChainInfoSchema` now rejects such rows at load anyway,
 * so this is the second of two gates, not the only one. */
function hostOf(url: string): string {
  return new URL(url).hostname;
}

/** Optional constructor dependencies (injectable — same DI convention as the 003-4 adapters:
 * `fetchImpl`/`now`). Keyless — no `env` dependency needed. */
export interface RpcEvmAdapterDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Chain registry supplying family + curated RPC hosts (TASK-006 R-54/R-56). */
  chains?: ChainRegistry;
  /** Injectable throttle, the same seam `blockscout`/`blockchain-info`/`nansen` expose (WI-26).
   * Production omits it and gets the shared singleton; a test passes `createThrottle()` so its
   * bucket is its own and the file's runtime stops depending on what else ran in the process. */
  throttle?: Throttle;
}

/** This adapter's own private hand-off shape from its HTTP step to `normalize()` — `address` is
 * already the EIP-55-checksummed form (re-normalized defensively, same pattern as the 003-4
 * adapters); `raw` is the untouched JSON-RPC envelope (`{jsonrpc, id, result}` on success). */
interface RpcEvmFetchResult {
  chain: Chain;
  address: string;
  /** Carried from the registry through `fetch()` so `normalize()` labels the balance with THIS
   * chain's gas token (vdd-multi cycle 5, H-3) — `normalize()` receives only this shape, so the
   * alternative would be a second registry lookup with no way to prove it resolved the same row. */
  nativeSymbol: string;
  nativeDecimals: number;
  raw: unknown;
}

/**
 * WI-51's hand-off shape — `gas.price` needs a chain and a gas token, and no address at all.
 *
 * A separate interface rather than making `address` optional on the one above: `normalize()`
 * discriminates on the CAPABILITY it is already given, so nothing has to carry a `kind` tag, and the
 * balance path's shape is left byte-for-byte as it was. A field that is required for one capability
 * and meaningless for another is the shape that eventually gets read on the wrong path.
 */
interface RpcEvmGasFetchResult {
  chain: Chain;
  nativeSymbol: string;
  raw: unknown;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/**
 * A hex quantity with at least one digit — `eth_gasPrice`'s answer, guarded exactly as
 * `HEX_BALANCE_RE` guards `eth_getBalance`'s, and for the same reason (`BigInt('0x')` throws a raw
 * `SyntaxError` instead of this adapter's own message).
 */
const HEX_QUANTITY_RE = /^0x[0-9a-fA-F]+$/;

/**
 * Wei per Gwei. Named rather than inlined as `1e9` because the two are not interchangeable here:
 * the division is deliberately done in floating point AFTER the exact value is preserved as a
 * string, and a reader has to be able to see which side of that line each constant is on.
 */
const WEI_PER_GWEI = 1_000_000_000;

/** Strict hex-wei guard (adversarial cycle 1, fix E) — requires at least one hex digit after the
 * `0x` prefix. The PREVIOUS check (`typeof === 'string' && startsWith('0x')`) accepted the bare
 * string `"0x"` (no digits at all), which `BigInt("0x")` throws a raw, unhelpful `SyntaxError` on
 * ("Cannot convert 0x to a BigInt") instead of this adapter's own clear, documented error. */
const HEX_BALANCE_RE = /^0x[0-9a-fA-F]+$/;

function extractFetchArgs(
  args: Record<string, unknown>,
  chains: ChainRegistry,
): { chain: ChainInfo; address: string } {
  const rawChain = args['chain'];
  const address = args['address'];
  const chain = typeof rawChain === 'string' ? chains.tryResolve(rawChain) : null;
  // TASK-006 (task 006-5): the same condition `chainSupport()` reports — family, a CURATED RPC
  // host, and a known gas token. `rpcHosts: null` is not "misconfigured", it is "we never approved
  // a host for this chain" (security.md §7.2.1), and the coverage gate should have refused long
  // before here. Kept EXACTLY in step with `chainSupport()` below: the two conditions diverging is
  // how a chain passes the gate and then fails in the transport — H-1's mechanism, one adapter over.
  if (!chain || !servesChain(chain) || typeof address !== 'string') {
    throw new Error(
      `rpc-evm.fetch: invalid args ${JSON.stringify(args)} (expected {chain: <an evm chain with a curated RPC host and a known native currency>, address: string})`,
    );
  }
  return { chain, address };
}

/**
 * The single definition of "this adapter can serve that chain" — read by `chainSupport()` (what the
 * coverage gate and `onchain_list_chains` advertise) AND by `extractFetchArgs()` (what the
 * transport actually accepts).
 *
 * `nativeSymbol`/`nativeDecimals` are part of the condition, not an afterthought (vdd-multi cycle 5,
 * H-3): `eth_getBalance` answers with a bare integer, so without both values there is no way to
 * label the result. Returning it as `ETH`/18 anyway — which is what this adapter used to do for
 * every chain, harmless while the route was ethereum-only and wrong for 17 chains the moment
 * TASK-006 widened it — reports a BNB balance as ETH, and a downstream agent then multiplies it by
 * the price of ETH. An uncovered chain is a refusal the caller can act on; a mislabelled balance is
 * a wrong answer that looks right.
 */
function servesChain(chain: ChainInfo): boolean {
  return (
    chain.family === 'evm' &&
    chain.rpcHosts !== null &&
    chain.nativeSymbol !== null &&
    chain.nativeDecimals !== null
  );
}

/**
 * `rpc-evm` adapter (ARCHITECTURE.md §3.2/§5.3, R-16/R-17, OQ-1 resolved): `wallet.balances.native`
 * on ethereum via JSON-RPC `eth_getBalance` — keyless, no env precondition. The hex-wei `result`
 * is converted to an exact **decimal string** via `BigInt`, never parsed into a JS `number`
 * (DB-SCHEMA-CONCEPT §1.7 — wei routinely exceeds the safe 2^53 integer range).
 *
 * **Bounded error messages (post-M1 polish, cheap-fix backlog item 5):** the JSON-RPC error
 * payload and the invalid-response envelope are embedded via `stringifyTruncated()`
 * (`../stringify-truncated.js`), never a raw, unbounded `JSON.stringify(...)` — an oversized or
 * malicious response body no longer produces an equally-oversized `Error` message.
 */
export function createRpcEvmAdapter(deps: RpcEvmAdapterDeps = {}): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const chains = deps.chains ?? loadChainRegistry();
  const throttle = deps.throttle ?? productionThrottle;

  /**
   * The one transport path both capabilities use: throttle, then walk THIS chain's curated
   * endpoints until one answers.
   *
   * Extracted for WI-51 rather than copied. Every non-obvious rule below is one a review already
   * paid for once — the no-fallback-to-registration-hosts rule (M-3), the hostname-only error text
   * (security L-2), the deadline break that does not burn the endpoint list (WI-37) — and a second
   * hand-written copy would hold none of them by construction. `servesChain()`'s own docstring names
   * the failure mode: two conditions that must agree, maintained in two places.
   */
  async function callRpc(
    chain: ChainInfo,
    body: string,
    deadlineAtMs?: number,
  ): Promise<JsonRpcResponse> {
    await throttle('rpc-evm', RATE_LIMIT, 1, deadlineAtMs);

    // TASK-006 (task 006-8, R-56): endpoints and the SSRF allowlist BOTH come from this chain's
    // curated `rpcHosts` row — per chain, never merged. The allowlist handed to `safeFetch` is
    // exactly the hosts a human approved for THIS chain, so one chain's endpoint can never be
    // used to reach another's (security.md §7.2.1).
    //
    // **No fallback to the registration hosts** (vdd-multi cycle 5, M-3). The previous
    // `chainHosts.length > 0 ? … : HOSTS` had a comment asserting the else-branch was
    // unreachable — and it was reachable, via `rpcHosts: []`, which passed both `chainSupport()`
    // (`!== null`) and the load schema. That branch sent a `bsc` balance query to ETHEREUM's
    // endpoints and cached the answer under `bsc`. The empty case is now rejected at load
    // (`.min(1)`), and this code carries no silent way to serve the wrong chain: if the list were
    // somehow empty, the loop below has nothing to try and throws.
    const chainHosts = [...(chain.rpcHosts ?? [])];
    const allowlist = chainHosts.map(hostOf);

    let lastError: unknown;
    for (const endpoint of chainHosts) {
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
          // full-URL column and this message reaches the model via `tried[].reason`. A curated
          // endpoint could one day carry a key in its path or query.
          //
          // What actually holds the line is one layer further back: `isApprovableRpcUrl` refuses
          // such an entry when the registry LOADS (adversarial cycle 3). This narrowing stays
          // regardless — it is cheap, and it also covers the query, which the load-time rule
          // does not.
          throw new Error(`rpc-evm: HTTP ${response.status} for ${hostOf(endpoint)}`);
        }
        const raw = (await response.json()) as JsonRpcResponse;
        if (raw.error) {
          throw new Error(
            `rpc-evm: JSON-RPC error from ${hostOf(endpoint)}: ${stringifyTruncated(raw.error)}`,
          );
        }
        return raw;
      } catch (error) {
        // Try the next endpoint in the primary->fallback chain before giving up entirely.
        lastError = error;
        // …EXCEPT when our own time is up (WI-37). The fallback loop exists because ONE endpoint
        // can be down while another answers; a spent deadline is not a fact about an endpoint, it
        // is true of every remaining one. Continuing would burn the list on `safeFetch` entry
        // checks and report the LAST endpoint's failure for a condition that had nothing to do
        // with it.
        if (error instanceof DeadlineExceededError) break;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`rpc-evm: all endpoints failed for chain ${chain.slug}`);
  }
  return {
    id: 'rpc-evm',
    // TASK-006 (R-54/R-56b): any EVM chain, but ONLY if the registry carries a curated RPC host
    // for it. `rpcHosts: null` therefore means honestly uncovered — the coverage gate refuses
    // before any network attempt, instead of letting a request time out against a host we never
    // approved (security.md §7.2.1). Curation itself is task 006-8. See `servesChain()` for why a
    // known gas token is part of the same condition.
    chainSupport: servesChain,
    // No `chains` literal — `servesChain` owns that answer (vdd-multi cycle 6, M-7).
    capabilities: () => [
      { id: 'wallet.balances.native' },
      // WI-51 — `eth_gasPrice`, the same keyless transport on the same curated hosts. This is the
      // reason `gas.price` does not die with one vendor's auth decision: L-6 was a capability with
      // exactly one adapter, and building the next one the same way would have re-earned it.
      { id: 'gas.price' },
    ],
    costOf: () => ({ credits: 0 }),
    fetch: async (
      cap: string,
      args: Record<string, unknown>,
      /** WI-37 — forwarded to the limiter and to EVERY hop of the endpoint fallback loop below. */
      deadlineAtMs?: number,
    ): Promise<RpcEvmFetchResult | RpcEvmGasFetchResult> => {
      // WI-51: `gas.price` is chain-scoped and takes no address, so it cannot go through
      // `extractFetchArgs` — that guard requires one. It gets the same three-part coverage test
      // (`servesChain`) by hand, because the alternative is a capability whose accepted args and
      // whose advertised coverage are decided in two places. That divergence is H-1's mechanism,
      // named in `servesChain`'s own docstring.
      const isGas = cap === 'gas.price';
      if (isGas) {
        const rawChain = args['chain'];
        const gasChain = typeof rawChain === 'string' ? chains.tryResolve(rawChain) : null;
        if (!gasChain || !servesChain(gasChain)) {
          throw new Error(
            `rpc-evm.fetch: invalid args ${JSON.stringify(args)} (expected {chain: <an evm chain with a curated RPC host and a known native currency>})`,
          );
        }
        const gasBody = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_gasPrice',
          params: [],
        });
        const raw = await callRpc(gasChain, gasBody, deadlineAtMs);
        // Non-null by `servesChain()`, exactly as the balance path asserts it.
        return { chain: gasChain.slug, nativeSymbol: gasChain.nativeSymbol as string, raw };
      }

      const { chain, address } = extractFetchArgs(args, chains);
      // Defensive re-normalization (003-4 reviewer note, applied here too): the caller is expected
      // to have already normalized the address, but the adapter's own HTTP step doesn't trust that.
      const normalizedAddress = normalizeAddress(chain, address);
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [normalizedAddress, 'latest'],
      });

      const raw = await callRpc(chain, body, deadlineAtMs);
      return {
        chain: chain.slug,
        address: normalizedAddress,
        // Non-null by `servesChain()`, which `extractFetchArgs` enforced above.
        nativeSymbol: chain.nativeSymbol as string,
        nativeDecimals: chain.nativeDecimals as number,
        raw,
      };
    },
    normalize: (cap: string, rawResult: unknown): Wallet | GasPrice => {
      if (cap === 'gas.price') {
        const gas = rawResult as RpcEvmGasFetchResult;
        const body = gas.raw as JsonRpcResponse;
        if (typeof body.result !== 'string' || !HEX_QUANTITY_RE.test(body.result)) {
          throw new Error(
            `rpc-evm.normalize: invalid gas price hex in "result": ${stringifyTruncated(gas.raw)}`,
          );
        }
        // Exact first, lossy second — DB-SCHEMA-CONCEPT §1.7's rule applied in that order on
        // purpose. `BigInt` preserves the node's answer to the wei; the Gwei projection is computed
        // FROM the exact value and is explicitly the disposable one. Doing it the other way round
        // (parse to Number, stringify back) is how an exact figure quietly becomes an estimate.
        const wei = BigInt(body.result);
        return GasPriceSchema.parse({
          chain: gas.chain,
          gasPriceWei: wei.toString(10),
          gasPriceGwei: Number(wei) / WEI_PER_GWEI,
          // A node states ONE suggested price. Spreading it across slow/average/fast would
          // manufacture a spread nobody measured — see `GasPriceSchema.tiers`.
          tiers: null,
          nativeSymbol: gas.nativeSymbol,
          // A node stamps nothing: `eth_gasPrice` answers for the head of the chain as of the
          // request, and there is no vendor measurement time distinct from our own fetch time.
          measuredAt: null,
          source: 'rpc-evm',
          fetchedAt: now(),
        });
      }
      const { chain, address, nativeSymbol, nativeDecimals, raw } = rawResult as RpcEvmFetchResult;
      const body = raw as JsonRpcResponse;
      if (typeof body.result !== 'string' || !HEX_BALANCE_RE.test(body.result)) {
        throw new Error(
          `rpc-evm.normalize: invalid balance hex in "result": ${stringifyTruncated(raw)}`,
        );
      }
      // Exact integer as a decimal string via BigInt — never Number() (>2^53 for large balances).
      const amountRaw = BigInt(body.result).toString(10);

      const wallet: Wallet = {
        chain,
        address,
        balances: [
          {
            assetType: 'native',
            // From the registry row, never a literal (vdd-multi cycle 5, H-3 — see `servesChain()`).
            symbol: nativeSymbol,
            decimals: nativeDecimals,
            amountRaw,
            // Lossy display projection only (DB-SCHEMA-CONCEPT §1.7) — amountRaw is the source
            // of truth; Number() here may lose precision for very large balances, by design.
            amountNum: Number(amountRaw),
          },
        ],
        source: 'rpc-evm',
        fetchedAt: now(),
      };
      return WalletSchema.parse(wallet);
    },
    // Keyless JSON-RPC — no env precondition to check.
    isAvailable: () => ({ ok: true }),
  };
}
