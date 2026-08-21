import type { ChainInfo } from '../../chain/registry-core.js';
import { scopedProviderId } from '../../net/limiter-store.js';
import { throttle as productionThrottle, type Throttle } from '../../net/rate-limit.js';
import { DeadlineExceededError, safeFetch } from '../../net/safe-fetch.js';
import { adapterRegistrations } from '../../providers.config.js';
import { stringifyTruncated } from '../stringify-truncated.js';

/**
 * The `rpc-evm` JSON-RPC transport, as ONE implementation with two callers — task 014-32c.
 *
 * **Why it is a module rather than a closure inside the adapter.** It was a closure, and its own
 * docstring already stated why it must not be copied: every non-obvious rule in it is one a review
 * paid for once — the no-fallback-to-registration-hosts rule (M-3), the hostname-only error text
 * (security L-2), the deadline break that does not burn the endpoint list (WI-37) — and a second
 * hand-written copy would hold none of them by construction. Task 014-32c added the second caller
 * (`fee-tier.ts`, the `fee()` derivation `interfaces.md` §5.1.7 assigns to this adapter), which is
 * exactly the moment that docstring was written for. Moving it changes no behaviour: the body below
 * is the same code, one indent level out.
 *
 * **This is an SSRF-bearing path**, which is the other half of the reason. The allowlist handed to
 * `safeFetch` is built HERE from the requested chain's own curated `rpcHosts`, so a second copy
 * would be a second place for that rule to drift (security.md §7.2.1).
 */

const REGISTRATION = adapterRegistrations.find((r) => r.id === 'rpc-evm');
if (!REGISTRATION) {
  throw new Error('rpc-evm: no matching entry in adapterRegistrations (providers.config.ts)');
}
const RATE_LIMIT = REGISTRATION.rateLimit;

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
  // The AUTHORITY, not the hostname (task 014-21, AC-9): `URL.host` keeps a non-default port and
  // drops `:443`. This value is both the SSRF allowlist entry and the string an error message
  // names, and `assertAllowedHost` now compares authorities — so a curated `rpcHosts` endpoint on a
  // non-default port would, with `.hostname` here, build an allowlist that refuses the very
  // endpoint it was derived from. None of the 34 registry rows carries a port today; this is what
  // keeps that from becoming a condition nobody wrote down.
  return new URL(url).host;
}

export interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export interface RpcCallerDeps {
  fetchImpl?: typeof fetch;
  throttle?: Throttle;
}

/** Builds the transport bound to one set of injected dependencies — a factory, never a module
 * singleton (ARCHITECTURE.md §8), the same convention every adapter in this package follows. */
export function createRpcCaller(
  deps: RpcCallerDeps = {},
): (chain: ChainInfo, body: string, deadlineAtMs?: number) => Promise<JsonRpcResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
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
    // **One bucket per CHAIN, not per provider** (task 014-17, AC-42). The split is declared in
    // `providers.config.ts` and composed here, because the scope has to be a value this call site
    // knows: the hostname is not — `chain.rpcHosts` is read below, after this line, and the loop
    // over endpoints is further down still. The chain is known; the host is not.
    await throttle(scopedProviderId('rpc-evm', chain.caip2), RATE_LIMIT, 1, deadlineAtMs);

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

  return callRpc;
}
