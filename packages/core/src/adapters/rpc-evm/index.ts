import { normalizeAddress } from '../../chain/address.js';
import { throttle } from '../../net/rate-limit.js';
import { safeFetch } from '../../net/safe-fetch.js';
import { adapterRegistrations } from '../../providers.config.js';
import { WalletSchema, type Wallet } from '../../types/wallet.js';
import type { Chain } from '../../types/chain.js';
import type { ProviderAdapter } from '../types.js';
import { stringifyTruncated } from '../stringify-truncated.js';

const REGISTRATION = adapterRegistrations.find((r) => r.id === 'rpc-evm');
if (!REGISTRATION) {
  throw new Error('rpc-evm: no matching entry in adapterRegistrations (providers.config.ts)');
}
const HOSTS = REGISTRATION.hosts;
const RATE_LIMIT = REGISTRATION.rateLimit;

/** Both hosts of the SSRF allowlist double as this adapter's OWN primary/fallback endpoint
 * chain, in the same order `HOSTS` lists them (ARCHITECTURE.md §3.2/§5.3, OQ-1 resolved by a
 * live probe, 2026-07-22 — `ethereum-rpc.publicnode.com` primary, `eth.drpc.org` fallback; both
 * confirmed live — two other keyless candidates considered during OQ-1's probe were confirmed
 * DOWN and deliberately excluded from `hosts`, see ARCHITECTURE.md §3.2's reviewer note for their
 * names). This is a within-THIS-adapter fallback (retry across two JSON-RPC endpoints for the
 * same capability), distinct from `CapabilityRegistry`'s own cross-adapter fallback (R-11) —
 * `wallet.balances.native` on ethereum has only `rpc-evm` in its route's `adapterIds`
 * (`providers.config.ts`), so a fully dead JSON-RPC layer needs its own retry inside this one
 * adapter. */
const ENDPOINTS = HOSTS.map((host) => `https://${host}`);

/** Optional constructor dependencies (injectable — same DI convention as the 003-4 adapters:
 * `fetchImpl`/`now`). Keyless — no `env` dependency needed. */
export interface RpcEvmAdapterDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** This adapter's own private hand-off shape from its HTTP step to `normalize()` — `address` is
 * already the EIP-55-checksummed form (re-normalized defensively, same pattern as the 003-4
 * adapters); `raw` is the untouched JSON-RPC envelope (`{jsonrpc, id, result}` on success). */
interface RpcEvmFetchResult {
  chain: Chain;
  address: string;
  raw: unknown;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/** Strict hex-wei guard (adversarial cycle 1, fix E) — requires at least one hex digit after the
 * `0x` prefix. The PREVIOUS check (`typeof === 'string' && startsWith('0x')`) accepted the bare
 * string `"0x"` (no digits at all), which `BigInt("0x")` throws a raw, unhelpful `SyntaxError` on
 * ("Cannot convert 0x to a BigInt") instead of this adapter's own clear, documented error. */
const HEX_BALANCE_RE = /^0x[0-9a-fA-F]+$/;

function extractFetchArgs(args: Record<string, unknown>): { chain: Chain; address: string } {
  const chain = args['chain'];
  const address = args['address'];
  if (chain !== 'ethereum' || typeof address !== 'string') {
    throw new Error(
      `rpc-evm.fetch: invalid args ${JSON.stringify(args)} (expected {chain: 'ethereum', address: string})`,
    );
  }
  return { chain, address };
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

  return {
    id: 'rpc-evm',
    capabilities: () => [{ id: 'wallet.balances.native', chains: ['ethereum'] }],
    costOf: () => ({ credits: 0 }),
    fetch: async (_cap: string, args: Record<string, unknown>): Promise<RpcEvmFetchResult> => {
      const { chain, address } = extractFetchArgs(args);
      // Defensive re-normalization (003-4 reviewer note, applied here too): the caller is expected
      // to have already normalized the address, but the adapter's own HTTP step doesn't trust that.
      const normalizedAddress = normalizeAddress(chain, address);
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [normalizedAddress, 'latest'],
      });

      await throttle('rpc-evm', RATE_LIMIT);

      let lastError: unknown;
      for (const endpoint of ENDPOINTS) {
        try {
          const response = await safeFetch(
            endpoint,
            { method: 'POST', headers: { 'content-type': 'application/json' }, body },
            HOSTS,
            fetchImpl,
          );
          if (!response.ok) {
            throw new Error(`rpc-evm: HTTP ${response.status} for ${endpoint}`);
          }
          const raw = (await response.json()) as JsonRpcResponse;
          if (raw.error) {
            throw new Error(
              `rpc-evm: JSON-RPC error from ${endpoint}: ${stringifyTruncated(raw.error)}`,
            );
          }
          return { chain, address: normalizedAddress, raw };
        } catch (error) {
          // Try the next endpoint in the primary->fallback chain before giving up entirely.
          lastError = error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(`rpc-evm: all endpoints failed (${ENDPOINTS.join(', ')})`);
    },
    normalize: (_cap: string, rawResult: unknown): Wallet => {
      const { chain, address, raw } = rawResult as RpcEvmFetchResult;
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
            symbol: 'ETH',
            decimals: 18,
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
