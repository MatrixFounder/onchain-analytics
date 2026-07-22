/** Thrown by `assertAllowedHost`/`safeFetch` when a hostname is outside an adapter's own
 * SSRF allowlist (R-25). Never carries the full URL/query — just the hostname, which is not a
 * secret and is the only piece needed to diagnose a misconfigured allowlist. */
export class SsrfBlockedError extends Error {
  constructor(public readonly hostname: string) {
    super(`host not in adapter allowlist: ${hostname}`);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * Transport-agnostic host check (ARCHITECTURE.md §2.1/§7.3 — designed for future non-HTTP
 * transports too, e.g. a future live gRPC channel for `dash-platform`, though only `safeFetch`
 * actually calls it in M1). `allowlist` is always the ONE calling adapter's own `hosts` list
 * (`AdapterRegistration.hosts`), never a merged/global allowlist (R-25 per-adapter isolation).
 *
 * @throws {SsrfBlockedError} if `hostname` is not in `allowlist`.
 */
export function assertAllowedHost(hostname: string, allowlist: string[]): void {
  if (!allowlist.includes(hostname)) {
    throw new SsrfBlockedError(hostname);
  }
}

/** R-25: manual redirect chain, re-checked hop-by-hop — never trust a `Location` header blindly. */
const MAX_REDIRECTS = 3;

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * The single point of outgoing HTTP for every adapter (R-25, ARCHITECTURE.md §3.2/§7.3):
 * resolves the target host against `allowlist` BEFORE the network call, then follows redirects
 * manually (`redirect: 'manual'`), re-checking each hop's `Location` host against the same
 * `allowlist` before following it (max 3 hops) — never trusts a redirect blindly.
 *
 * `fetchImpl` is injectable (default: the global `fetch`) so this is unit-testable without any
 * real network access — tests supply a fake that returns canned `Response`s per hop.
 *
 * @throws {SsrfBlockedError} for the initial URL or any redirect hop outside `allowlist`.
 */
export async function safeFetch(
  url: string,
  opts: RequestInit,
  allowlist: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  let currentUrl = url;
  let redirectsFollowed = 0;

  for (;;) {
    const hostname = new URL(currentUrl).hostname;
    assertAllowedHost(hostname, allowlist);

    const response = await fetchImpl(currentUrl, { ...opts, redirect: 'manual' });

    const location = isRedirectStatus(response.status) ? response.headers.get('location') : null;
    if (location === null) {
      return response;
    }

    if (redirectsFollowed >= MAX_REDIRECTS) {
      throw new Error(`safeFetch: exceeded ${MAX_REDIRECTS} redirects following ${url}`);
    }

    // Resolve a relative Location against the current hop's URL, exactly like a real browser
    // redirect would — then the NEXT loop iteration re-checks its hostname before following it.
    currentUrl = new URL(location, currentUrl).toString();
    redirectsFollowed += 1;
  }
}
