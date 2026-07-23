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

/** Default per-call timeout (ms) — adversarial cycle 1, finding B1: every `safeFetch` call now
 * races against `AbortSignal.timeout(timeoutMs)` instead of being able to hang indefinitely on a
 * dead/slow endpoint. Overridable per call via `SafeFetchOptions.timeoutMs` (e.g. a future
 * adapter-specific config); no adapter currently overrides it. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Default response-size cap in bytes, enforced via the `Content-Length` response header when
 * present (adversarial cycle 1, finding B2). **Documented limitation:** this checks the
 * ADVERTISED `Content-Length` before the body is read — a response with NO `Content-Length`
 * header (e.g. chunked transfer-encoding) is not currently capped mid-stream; a true streaming
 * byte-counter is future hardening (out of this fix's scope), not silently claimed as done here. */
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10MB

/** Per-call overrides for `safeFetch` (adversarial cycle 1, fix B) — both optional, both default
 * to the conservative module constants above. */
export interface SafeFetchOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Thrown when a `safeFetch` call (including any redirect hop) doesn't settle within
 * `timeoutMs` — lets a caller's own fallback loop (e.g. `rpc-evm`'s primary->secondary endpoint
 * retry) advance to the next candidate instead of hanging forever on a dead host. */
export class SafeFetchTimeoutError extends Error {
  constructor(
    public readonly url: string,
    public readonly timeoutMs: number,
  ) {
    super(`safeFetch: timed out after ${timeoutMs}ms fetching ${url}`);
    this.name = 'SafeFetchTimeoutError';
  }
}

/** Thrown when a response's advertised `Content-Length` exceeds `maxResponseBytes` — rejected
 * BEFORE the caller ever reads the body (`.json()`/`.text()`). */
export class SafeFetchResponseTooLargeError extends Error {
  constructor(
    public readonly url: string,
    public readonly contentLength: number,
    public readonly maxBytes: number,
  ) {
    super(
      `safeFetch: response Content-Length ${contentLength} exceeds the ${maxBytes}-byte cap for ${url}`,
    );
    this.name = 'SafeFetchResponseTooLargeError';
  }
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Case-insensitive substring match for header names that must never survive a cross-host
 * redirect (adversarial cycle 1, finding B3) — covers `Authorization` and every `x-...-api-key`
 * style header this package's adapters send (e.g. coingecko's `x-cg-demo-api-key`). */
const SENSITIVE_HEADER_RE = /authorization|api-?key/i;

/** Strips sensitive headers from `headers` — called ONLY when a redirect hop's hostname differs
 * from the PREVIOUS hop's, so a same-host redirect (a plain path-only 301, say) keeps the
 * caller's original headers untouched. Normalizes through the `Headers` API first so this works
 * regardless of whether `headers` was supplied as a plain object, an array of pairs, or a
 * `Headers` instance.
 *
 * Typed via `RequestInit['headers']` (an indexed-access type) rather than the bare `HeadersInit`
 * name: `@types/node`'s bundled `undici-types` declares `HeadersInit` as a plain module export,
 * not a global type, so referencing it by name here doesn't resolve under this package's
 * `types: ["node"]` (no DOM lib) tsconfig — `RequestInit['headers']` is the identical type,
 * reached through a global interface that already IS declared ambiently. */
function stripCrossHostHeaders(
  headers: RequestInit['headers'],
): RequestInit['headers'] | undefined {
  if (!headers) return headers;
  const source = new Headers(headers);
  const filtered = new Headers();
  for (const [name, value] of source.entries()) {
    if (!SENSITIVE_HEADER_RE.test(name)) {
      filtered.append(name, value);
    }
  }
  return filtered;
}

/**
 * Races `fetchPromise` against `signal`'s own abort event, rejecting with a
 * `SafeFetchTimeoutError` the moment `signal` aborts — regardless of whether `fetchPromise`
 * itself ever settles. This extra listener (rather than relying solely on passing `signal` into
 * `fetchImpl` and trusting it to reject on abort) is deliberate: an injected TEST `fetchImpl` that
 * never resolves (and never inspects its own `signal` argument) must still time out, exactly like
 * a real hung `fetch()` call would once the real implementation honors the abort signal.
 */
function raceWithTimeout(
  fetchPromise: Promise<Response>,
  signal: AbortSignal,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const onAbort = (): void => reject(new SafeFetchTimeoutError(url, timeoutMs));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    fetchPromise.then(
      (response) => {
        signal.removeEventListener('abort', onAbort);
        resolve(response);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Rejects with `SafeFetchResponseTooLargeError` BEFORE the caller ever reads the body, when the
 * response advertises a `Content-Length` over `maxBytes`. A response with no `Content-Length`
 * header is not checked here (see `DEFAULT_MAX_RESPONSE_BYTES`'s docstring). */
function assertResponseSizeWithinCap(response: Response, url: string, maxBytes: number): void {
  const contentLength = response.headers.get('content-length');
  if (contentLength === null) return;
  const size = Number(contentLength);
  if (Number.isFinite(size) && size > maxBytes) {
    throw new SafeFetchResponseTooLargeError(url, size, maxBytes);
  }
}

/**
 * The single point of outgoing HTTP for every adapter (R-25, ARCHITECTURE.md §3.2/§7.3):
 * resolves the target host against `allowlist` BEFORE the network call, then follows redirects
 * manually (`redirect: 'manual'`), re-checking each hop's `Location` host against the same
 * `allowlist` before following it (max 3 hops) — never trusts a redirect blindly.
 *
 * **Hardened (adversarial cycle 1, fix B):**
 * - Every hop races against `AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)` —
 *   rejects with a typed `SafeFetchTimeoutError` instead of hanging forever on a dead/slow host.
 * - Every response's advertised `Content-Length` is checked against
 *   `options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES` BEFORE the caller reads the body.
 * - A redirect `Location` resolving to a non-`https:` target is rejected outright.
 * - A redirect `Location` resolving to a DIFFERENT hostname than the current hop strips
 *   `Authorization`/`*-api-key`-style headers from the request before following it — a same-host
 *   redirect (e.g. a path-only 301) keeps the original headers untouched.
 * - **(adversarial cycle 2, fix 4)** The INITIAL `url` itself is now ALSO rejected if it isn't
 *   `https:` — cycle 1's non-https check only ever covered redirect targets, leaving the very
 *   first hop uncovered; this closes that gap symmetrically.
 *
 * `fetchImpl` is injectable (default: the global `fetch`) so this is unit-testable without any
 * real network access — tests supply a fake that returns canned `Response`s per hop.
 *
 * @throws {SsrfBlockedError} for the initial URL or any redirect hop outside `allowlist`.
 * @throws {SafeFetchTimeoutError} if any hop doesn't settle within the timeout.
 * @throws {SafeFetchResponseTooLargeError} if a response's `Content-Length` exceeds the cap.
 */
export async function safeFetch(
  url: string,
  opts: RequestInit,
  allowlist: string[],
  fetchImpl: typeof fetch = fetch,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  // Adversarial cycle 2, fix 4 — the non-https rejection previously only applied to REDIRECT
  // targets (fix B3, cycle 1); the INITIAL url got no such check at all. Mirrored here so a
  // caller-supplied `http://` URL is rejected up front, before any network attempt, exactly like
  // an insecure redirect hop already is.
  const initialUrl = new URL(url);
  if (initialUrl.protocol !== 'https:') {
    throw new Error(
      `safeFetch: refusing to fetch a non-https initial URL (${initialUrl.protocol}//${initialUrl.hostname})`,
    );
  }

  let currentUrl = url;
  let currentHostname = initialUrl.hostname;
  let currentOpts: RequestInit = opts;
  let redirectsFollowed = 0;

  for (;;) {
    assertAllowedHost(currentHostname, allowlist);

    const signal = AbortSignal.timeout(timeoutMs);
    const response = await raceWithTimeout(
      fetchImpl(currentUrl, { ...currentOpts, redirect: 'manual', signal }),
      signal,
      currentUrl,
      timeoutMs,
    );

    assertResponseSizeWithinCap(response, currentUrl, maxResponseBytes);

    const location = isRedirectStatus(response.status) ? response.headers.get('location') : null;
    if (location === null) {
      return response;
    }

    if (redirectsFollowed >= MAX_REDIRECTS) {
      throw new Error(`safeFetch: exceeded ${MAX_REDIRECTS} redirects following ${url}`);
    }

    // Resolve a relative Location against the current hop's URL, exactly like a real browser
    // redirect would — then the NEXT loop iteration re-checks its hostname before following it.
    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.protocol !== 'https:') {
      throw new Error(
        `safeFetch: refusing to follow a redirect to a non-https target (${nextUrl.protocol}//${nextUrl.hostname})`,
      );
    }

    if (nextUrl.hostname !== currentHostname) {
      currentOpts = { ...currentOpts, headers: stripCrossHostHeaders(currentOpts.headers) };
    }
    currentUrl = nextUrl.toString();
    currentHostname = nextUrl.hostname;
    redirectsFollowed += 1;
  }
}
