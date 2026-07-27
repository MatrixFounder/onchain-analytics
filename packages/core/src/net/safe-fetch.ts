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

/**
 * Default response-size cap in bytes (adversarial cycle 1, finding B2; made real in TASK-007 task
 * 007-3, R-65 — item (1) of the R-47 carry-over).
 *
 * Enforced by BOTH mechanisms, in this order:
 *
 * 1. the advertised `Content-Length`, checked before the body is read at all — the cheapest
 *    possible rejection, and the only one that costs no transfer;
 * 2. a STREAMING byte counter over `response.body` when no `Content-Length` is advertised.
 *
 * Until task 007-3 only (1) existed, and the header's absence meant the cap silently did not apply.
 * That is not an exotic case: `api.llama.fi` — a host this engine talks to on three capabilities —
 * serves every response over HTTP/2 with no `Content-Length` at all (measured 2026-07-27), so the
 * cap was inert exactly where the traffic was about to grow. An unbounded chunked response could be
 * buffered into memory and from there into the cache.
 */
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

/**
 * Cheap EARLY REJECTION on the advertised `Content-Length` — nothing more.
 *
 * It deliberately does not report "this response is bounded", because a header cannot establish
 * that (adversarial cycle 3, corroborated independently by the security and performance critics).
 * The previous version returned `true` here and the caller then SKIPPED the streaming counter, so
 * the only real enforcement was disabled by the very input it was meant to distrust:
 *
 * - `Content-Length: abc` / `-1` → `Number()` gives `NaN`/negative, the `> maxBytes` test is false,
 *   the header path reported "bounded" and nothing counted the bytes;
 * - `Content-Encoding: gzip|br` → the header counts COMPRESSED bytes while the cap is enforced on
 *   DECODED bytes (undici decodes before `response.body`), so a ~8× compressible JSON body passed a
 *   2MB cap at 250KB advertised and expanded unbounded after `.json()` — a decompression bomb;
 * - `Content-Length` alongside `Transfer-Encoding: chunked`, where the header is not the framing.
 *
 * The caller now always installs the counter, so this is purely an optimisation: it refuses an
 * over-cap response before a single body byte is transferred.
 */
function assertResponseSizeWithinCap(response: Response, url: string, maxBytes: number): void {
  const contentLength = response.headers.get('content-length');
  if (contentLength === null) return;
  const size = Number(contentLength);
  if (Number.isFinite(size) && size > maxBytes) {
    throw new SafeFetchResponseTooLargeError(url, size, maxBytes);
  }
}

/**
 * Wraps `response` so reading its body can never yield more than `maxBytes` (TASK-007 task 007-3,
 * R-65). Used ONLY when the response advertises no `Content-Length` — otherwise the header check
 * above has already bounded the transfer more cheaply.
 *
 * The counter runs on the stream rather than after `.text()`/`.json()` for the reason the cap
 * exists at all: measuring a body you have already buffered tells you how much memory you already
 * spent. On overflow the upstream reader is **cancelled**, which closes the connection instead of
 * politely continuing to receive a payload we have decided to refuse.
 *
 * Status, statusText and headers are carried over verbatim, so every existing caller — `response.ok`,
 * `response.status`, the redirect handling below — behaves identically.
 *
 * The error surfaces where the body is READ (inside the calling adapter's `fetch()`), not where
 * `safeFetch` returns. That placement is correct rather than incidental: `CapabilityRegistry`
 * classifies a throw from `adapter.fetch()` as "this adapter could not answer right now, try the
 * next one" and — deliberately — does NOT negative-cache it. An oversized response is a transport
 * condition, not the deterministic `normalize()` verdict that negative caching exists for.
 */
function capResponseStream(response: Response, url: string, maxBytes: number): Response {
  const body = response.body;
  if (body === null) return response;

  const reader = body.getReader();
  let seen = 0;
  const capped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      // A chunk that is not a typed array would make `seen` NaN, and `NaN > maxBytes` is false
      // FOREVER — the counter would go inert for the rest of the response (cycle 3, security L-4).
      // Unreachable through real undici bodies; reachable through an injected `fetchImpl`, which is
      // how every test in this repo drives this code.
      const chunkBytes = (value as Partial<Uint8Array> | undefined)?.byteLength;
      if (typeof chunkBytes !== 'number' || !Number.isFinite(chunkBytes)) {
        controller.error(
          new Error(
            `safeFetch: non-binary chunk from ${url} (${typeof value}) — refusing to count`,
          ),
        );
        void reader.cancel().catch(() => undefined);
        return;
      }
      seen += chunkBytes;
      if (seen > maxBytes) {
        // ERROR FIRST, then cancel (cycle 3, security L-2). The previous order awaited the cancel
        // before constructing the error, so a rejecting or hanging `cancel()` replaced the typed
        // `SafeFetchResponseTooLargeError` with something no caller's `instanceof` handles — or
        // stalled the report entirely. `controller.error` is synchronous and does not resume the
        // transfer, so reporting first costs nothing and cannot be lost.
        controller.error(new SafeFetchResponseTooLargeError(url, seen, maxBytes));
        void reader.cancel().catch(() => undefined);
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      // RETURNED, not discarded: a caller cancelling the wrapper must be able to await the upstream
      // teardown. `.catch()` because an unhandled rejection here would take down a long-lived stdio
      // server on Node's default `--unhandled-rejections=throw` (cycle 3, security L-1).
      return reader.cancel(reason).catch(() => undefined);
    },
  });

  // `new Response` re-imposes constructor validation the original response never faced: a status
  // outside 200-599 throws `RangeError`, an odd `statusText` throws `TypeError` (cycle 3, security
  // L-3). undici builds its internal response without those checks, so a hostile upstream sending
  // `HTTP/1.1 999` would turn `safeFetch` into an untyped throw AND leak the reader taken above.
  // Fall back to the unwrapped response rather than inventing a failure — the header check has
  // already run, and an exotic status is a diagnostics problem, not a size one.
  try {
    return new Response(capped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    void reader.cancel().catch(() => undefined);
    return response;
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
 *   `options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES` BEFORE the caller reads the body, and
 *   — since TASK-007 task 007-3 (R-65) — a response that advertises NO `Content-Length` is bounded
 *   by a streaming byte counter instead, cancelling the upstream reader on overflow. The cap is
 *   therefore real on chunked/HTTP-2 responses, which is the common case rather than the exotic one.
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

    // Early rejection only — never a licence to skip the counter (see the function's docstring).
    assertResponseSizeWithinCap(response, currentUrl, maxResponseBytes);

    const location = isRedirectStatus(response.status) ? response.headers.get('location') : null;
    if (location === null) {
      // ALWAYS wrapped (cycle 3, security H-1 / performance H-2). The previous version skipped the
      // counter whenever a `Content-Length` was present and within the cap, which let an
      // untrustworthy or compressed header disable the only real enforcement. Wrapping costs ~10µs
      // and no byte copies (chunk references are passed through), which is the correct price for a
      // cap that actually holds.
      return capResponseStream(response, currentUrl, maxResponseBytes);
    }

    // A redirect hop's body is never read by anyone — so RELEASE it (cycle 3, security L-6 /
    // performance M-8). Merely dropping the reference keeps the connection out of undici's pool
    // until the socket is destroyed or the abort signal fires, up to MAX_REDIRECTS times per call.
    void response.body?.cancel().catch(() => undefined);

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
