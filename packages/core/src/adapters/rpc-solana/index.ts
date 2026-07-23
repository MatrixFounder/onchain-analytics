import { normalizeAddress } from '../../chain/address.js';
import { throttle } from '../../net/rate-limit.js';
import { safeFetch } from '../../net/safe-fetch.js';
import { adapterRegistrations } from '../../providers.config.js';
import { WalletSchema, type Wallet } from '../../types/wallet.js';
import type { Chain } from '../../types/chain.js';
import type { ProviderAdapter } from '../types.js';

const REGISTRATION = adapterRegistrations.find((r) => r.id === 'rpc-solana');
if (!REGISTRATION) {
  throw new Error('rpc-solana: no matching entry in adapterRegistrations (providers.config.ts)');
}
const HOSTS = REGISTRATION.hosts;
const RATE_LIMIT = REGISTRATION.rateLimit;

const ENDPOINT = `https://${HOSTS[0]}`;

/** Optional constructor dependencies (injectable, same DI convention as `rpc-evm`). Keyless — no
 * `env` dependency needed. */
export interface RpcSolanaAdapterDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface RpcSolanaFetchResult {
  chain: Chain;
  address: string;
  raw: unknown;
}

interface JsonRpcGetBalanceResponse {
  result?: { context?: { slot?: unknown }; value?: unknown };
  error?: { code?: unknown; message?: unknown };
}

function extractFetchArgs(args: Record<string, unknown>): { chain: Chain; address: string } {
  const chain = args['chain'];
  const address = args['address'];
  if (chain !== 'solana' || typeof address !== 'string') {
    throw new Error(
      `rpc-solana.fetch: invalid args ${JSON.stringify(args)} (expected {chain: 'solana', address: string})`,
    );
  }
  return { chain, address };
}

/**
 * `rpc-solana` adapter (ARCHITECTURE.md §3.2/§5.3, R-16/R-17, OQ-1 resolved): `wallet.balances.native`
 * on solana via JSON-RPC `getBalance` — keyless, single confirmed endpoint
 * (`api.mainnet-beta.solana.com`, live-probed 2026-07-22). A second keyless Solana RPC fallback
 * candidate is explicitly OUT of M1 (ARCHITECTURE.md §11 — "not a hot-swap, a single point of
 * failure with retry" until a second candidate gets its own live probe); this adapter therefore
 * has exactly one endpoint, unlike `rpc-evm`'s two.
 *
 * **Known vendor limitation, not an engine bug (documented, not silently accepted):** unlike
 * `eth_getBalance` (which returns hex-wei as a STRING, preserving arbitrary precision),
 * `getBalance`'s `result.value` is a JSON **number** in the wire response itself — so any lamport
 * balance above `Number.MAX_SAFE_INTEGER` (~9.007 x 10^15, i.e. ~9.007M SOL) has already lost
 * precision by the time `response.json()` parses it, before this adapter ever sees it. This is a
 * limitation of Solana's own JSON-RPC wire format, not something a client-side string conversion
 * can recover — `amountRaw` is still emitted as a string (DB-SCHEMA-CONCEPT §1.7 convention), but
 * for values already-imprecise past that threshold, the string merely reflects the JSON-parsed
 * (already lossy) number, not a true arbitrary-precision integer.
 */
export function createRpcSolanaAdapter(deps: RpcSolanaAdapterDeps = {}): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  return {
    id: 'rpc-solana',
    capabilities: () => [{ id: 'wallet.balances.native', chains: ['solana'] }],
    costOf: () => ({ credits: 0 }),
    fetch: async (_cap: string, args: Record<string, unknown>): Promise<RpcSolanaFetchResult> => {
      const { chain, address } = extractFetchArgs(args);
      const normalizedAddress = normalizeAddress(chain, address);
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [normalizedAddress],
      });

      await throttle('rpc-solana', RATE_LIMIT);
      const response = await safeFetch(
        ENDPOINT,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body },
        HOSTS,
        fetchImpl,
      );
      if (!response.ok) {
        throw new Error(`rpc-solana: HTTP ${response.status} for ${ENDPOINT}`);
      }
      const raw = (await response.json()) as JsonRpcGetBalanceResponse;
      if (raw.error) {
        throw new Error(
          `rpc-solana: JSON-RPC error from ${ENDPOINT}: ${JSON.stringify(raw.error)}`,
        );
      }
      return { chain, address: normalizedAddress, raw };
    },
    normalize: (_cap: string, rawResult: unknown): Wallet => {
      const { chain, address, raw } = rawResult as RpcSolanaFetchResult;
      const body = raw as JsonRpcGetBalanceResponse;
      const lamports = body.result?.value;
      // Adversarial cycle 1, fix F: `lamports` must be a non-negative SAFE integer before it's
      // ever handed to `String()` — a fractional value (e.g. `1.5`, never a valid lamport count),
      // a negative value, or a value already past `Number.MAX_SAFE_INTEGER` (silently imprecise,
      // per this module's own docstring on Solana's lossy JSON-number wire format) all get a
      // loud, clear error here instead of silently propagating a wrong/misleading `amountRaw`.
      if (
        typeof lamports !== 'number' ||
        !Number.isInteger(lamports) ||
        lamports < 0 ||
        lamports > Number.MAX_SAFE_INTEGER
      ) {
        throw new Error(
          `rpc-solana.normalize: invalid lamports value in "result.value": ${JSON.stringify(raw)}`,
        );
      }

      const wallet: Wallet = {
        chain,
        address,
        balances: [
          {
            assetType: 'native',
            symbol: 'SOL',
            decimals: 9,
            // Exact integer as a string (DB-SCHEMA-CONCEPT §1.7) — see this module's docstring for
            // the vendor-side precision caveat above ~9.007M SOL.
            amountRaw: String(lamports),
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
