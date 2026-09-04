/** Thrown by `assertAllowedHost`/`safeFetch` when an authority is outside an adapter's own
 * SSRF allowlist (R-25). Never carries the full URL/query — just the authority, which is not a
 * secret and is the only piece needed to diagnose a misconfigured allowlist. */
export class SsrfBlockedError extends Error {
  constructor(public readonly hostname: string) {
    super(`host not in adapter allowlist: ${hostname}`);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * Thrown when the allowlist itself is malformed — task 014-21, R-10.4.
 *
 * **Why a configuration error and not a silent refusal.** An entry the parser cannot read as a bare
 * authority can never match anything, so the adapter carrying it refuses every call it makes, with
 * `SsrfBlockedError` naming the target rather than the typo. That is a misconfiguration wearing the
 * clothes of a security decision. `AdapterRegistration.hosts` is an unconstrained `string[]`
 * (`adapters/types.ts`) and no load-time check reads it, so the first reader is this one.
 */
export class AllowlistEntryInvalidError extends Error {
  constructor(
    public readonly entry: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(
      `allowlist entry is not a bare host[:port]: ${JSON.stringify(entry)} — ${reason}`,
      options,
    );
    this.name = 'AllowlistEntryInvalidError';
  }
}

/**
 * The string a host comparison is made ON: the hostname, plus the port when it is not the scheme's
 * default (task 014-21, R-10.1, AC-9).
 *
 * **Why the authority and not the hostname.** `URL.hostname` DISCARDS the port. Comparing it means
 * `https://api.llama.fi:8443/` passes an allowlist that says `api.llama.fi` — measured on Node
 * v24.15.0 — and, because the redirect loop's cross-host test compared the same field, such a hop
 * was also not treated as a host change, so `Authorization` and every `*-api-key` header travelled
 * to that port. The initial URL of every adapter is a compiled constant, so the port is chosen by
 * whoever controls an allowlisted vendor's `Location` header — a compromised vendor, or an ordinary
 * open redirect on one — not by the remote caller. `URL.host` keeps a non-default port and drops
 * `:443`, which is exactly what AC-9 asks for: `https://host` and `https://host:443` compare as one.
 *
 * **What the WHATWG parser already does, so this function does not repeat it.** Measured on Node
 * v24.15.0: the host is ASCII-lowercased (`API.LLAMA.FI` → `api.llama.fi`), IDN goes through IDNA
 * ToASCII (a Cyrillic `а` becomes `xn--pi-6kc…`, which then misses the allowlist), IPv6 is
 * canonicalised inside brackets (`[0:0:...:1]` → `[::1]`), IPv4 shorthand is expanded (`0x7f.1` →
 * `127.0.0.1`), and userinfo never reaches `host` at all. Re-implementing any of that here would be
 * a second normaliser to keep in step with the first.
 *
 * **A trailing dot is deliberately NOT stripped.** `api.llama.fi.` and `api.llama.fi` are distinct
 * to the parser, so a dotted target MISSES the allowlist and is refused — the gate fails closed.
 * Normalising it would be a new legal answer that widens what the gate accepts (memory M6), and it
 * would widen a second comparison too: the cross-host header strip below would stop seeing `host.`
 * as a different host, so a redirect that today loses its credential header would carry it forward.
 * A refusal we can explain is worth more than a match we would have to defend.
 */
export function allowlistAuthority(hostOrUrl: string): string {
  const candidate = hostOrUrl.includes('://') ? hostOrUrl : `https://${hostOrUrl}`;
  return new URL(candidate).host;
}

/**
 * Canonicalises ONE allowlist entry, refusing anything that is not a bare `host[:port]`.
 *
 * A path, a query or a fragment in an entry is refused rather than silently dropped: `api.x.com/v1`
 * parses to the authority `api.x.com`, so accepting it would grant the whole host to an entry whose
 * author believed they had granted one prefix.
 */
export function normalizeAllowlistEntry(entry: string): string {
  let parsed: URL;
  try {
    parsed = new URL(entry.includes('://') ? entry : `https://${entry}`);
  } catch (error) {
    throw new AllowlistEntryInvalidError(entry, 'it is not a parseable host', { cause: error });
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new AllowlistEntryInvalidError(
      entry,
      'it carries a path, query or fragment, which an authority comparison cannot honour',
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new AllowlistEntryInvalidError(entry, 'it carries userinfo, which is never compared');
  }
  if (parsed.host === '') {
    throw new AllowlistEntryInvalidError(entry, 'it has no host');
  }
  return parsed.host;
}

/**
 * Transport-agnostic host check (ARCHITECTURE.md §2.1/§7.3 — designed for future non-HTTP
 * transports too, e.g. a future live gRPC channel for `dash-platform`, though only `safeFetch`
 * actually calls it in M1). `allowlist` is always the ONE calling adapter's own `hosts` list
 * (`AdapterRegistration.hosts`), never a merged/global allowlist (R-25 per-adapter isolation).
 *
 * **Both sides are normalised, and that is task 014-21's second half.** The caller's side comes out
 * of `new URL(...)` already canonical; the allowlist side is hand-written data with no schema and no
 * load-time gate behind it, so an entry typed as `API.Nansen.ai` or `api.nansen.ai:443` would match
 * NOTHING and the adapter would refuse every call it makes — a typo indistinguishable, from the
 * outside, from a security decision. Normalising here makes the two sides one comparison.
 *
 * @throws {SsrfBlockedError} if `authority` is not in `allowlist`.
 * @throws {AllowlistEntryInvalidError} if an entry is not a bare `host[:port]`.
 */
export function assertAllowedHost(authority: string, allowlist: string[]): void {
  const wanted = allowlistAuthority(authority);
  if (!allowlist.some((entry) => normalizeAllowlistEntry(entry) === wanted)) {
    throw new SsrfBlockedError(authority);
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
 * The connect bound the RUNTIME applies to every `fetch`, in ms — recorded here, never set here
 * (issue L-30).
 *
 * **Measured on this machine, Node v24.15.0.** `fetch('http://10.255.255.1/')` was issued against a
 * non-routable IPv4 literal, so no name had to be resolved and the packets were dropped rather
 * than refused. The call failed after 10 558 ms of wall time with `TypeError: fetch failed`. Its `cause`
 * was `ConnectTimeoutError: Connect Timeout Error (attempted address: 10.255.255.1:80, timeout:
 * 10000ms)`, carrying `code = 'UND_ERR_CONNECT_TIMEOUT'`. The `10000ms` in that text is this
 * constant. The remaining 558 ms is call overhead outside the bound.
 *
 * **This repository does not set the bound and cannot currently set it.** Changing it means passing
 * a `dispatcher` to `fetch`, and a dispatcher can only be constructed from `undici`. `undici` is
 * neither a dependency of this package nor a Node builtin, so no dispatcher can be passed today.
 * The value is therefore written down rather than declared: it is the client default, and a reader
 * of this file had no other way to learn that it exists. Whether to OWN the bound by adding that
 * dependency is a separate decision, recorded outside this file.
 *
 * **What this constant claims, and nothing beyond it.** The bound exists. It belongs to the
 * runtime, not to this code. It ends a hop before a declared per-hop budget LARGER than itself;
 * `DEFAULT_TIMEOUT_MS` is 15 000 ms. Two shipped adapters declare 5 000 ms
 * (`blockscout/index.ts`, `blockchain-info/index.ts`), and there the order is the other way round.
 * Its signature is the `code` above, which `isRuntimeConnectTimeout` matches.
 *
 * **UNRESOLVED: whether the four L-30 failures were this bound.** L-30 records them at 10 152,
 * 10 507, 10 010 and 10 510 ms across three vendors. It also states that no 10-second bound was
 * FOUND in the request path. It calls four samples inside a 500 ms band suggestive of a fixed
 * bound and not proof of one. This constant does not upgrade that finding.
 *
 * **A second mechanism yields the same ten seconds, and it is L-30's own candidate.** A resolver
 * stall reaches ten seconds as five seconds across two attempts, which is libresolv's default and
 * not a value either resolver here prints. Its signature differs — `EAI_AGAIN` or `ENOTFOUND` —
 * and `isRuntimeConnectTimeout` does not match it.
 *
 * **Both readings are measured against a confounded path, which neither record accounts for.**
 * `scutil --dns` on 2026-09-04 shows the default resolver as ONE nameserver, `198.18.0.2`, on
 * `utun8`, flagged `Transient Connection`; `/etc/resolv.conf` carries the same single address. That
 * address is inside the benchmarking range 198.18.0.0/15. It ANSWERS WITH SYNTHESIZED addresses:
 * `api.dexscreener.com` resolves to `198.18.0.255` and `::ffff:198.18.0.255`, `api.llama.fi` to
 * `198.18.0.253`. Those are not the vendors' addresses. Every vendor call from this machine
 * therefore crosses a tunnel that maps the destination, so a measurement here cannot separate a
 * vendor outage from a stall in that tunnel. A SECOND resolver block in the same output lists two
 * nameservers on `en0`, and that is the one L-30's arithmetic cites.
 *
 * **Why the records cannot decide between the two.** The refusals reached the client as
 * `capability unavailable … (event <id>)`. The two ids checked resolve to no row in `diagnostics`
 * and to no row in `request_trace`. The full text an event id promises was never persisted, so the
 * original `cause` cannot be read back. Deciding this needs the next occurrence instrumented in
 * advance, which is L-30's own "what would settle it" list.
 *
 * Nothing in this module starts a timer from this constant. It is the value
 * `RuntimeConnectTimeoutError` falls back to when the runtime's own error carries no
 * `timeout: <n>ms` text, and it is read nowhere else.
 */
export const RUNTIME_CONNECT_TIMEOUT_MS = 10_000;

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

/** Per-call overrides for `safeFetch` (adversarial cycle 1, fix B) — all optional; the first two
 * default to the conservative module constants above, the third to "no deadline at all". */
export interface SafeFetchOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  /**
   * ABSOLUTE moment (epoch-ms, `Date.now()` scale) after which this call must stop — NEVER a
   * duration (ADR-002 D4 point 3, task 012-7). A duration would have to be re-derived at every
   * step that forwards it, and durations between steps do not add up: each hop of a redirect chain
   * would silently get a fresh full budget. A moment forwards itself.
   *
   * Omitted (`undefined`) means no deadline, and then this module behaves EXACTLY as it did before
   * task 012-7: one `AbortSignal.timeout(timeoutMs)` per hop and nothing else.
   */
  deadlineAtMs?: number;
}

/**
 * `https://host/path?apikey=SECRET#frag` → `https://host/path` (vdd-multi TASK-008, M-14).
 *
 * A query string can carry a credential, and at least one adapter's vendor requires exactly that:
 * `blockscout` authenticates with `?apikey=<key>` because that is the vendor's choice, not ours.
 * Every error below used to interpolate the FULL url — into `.message`, and into a `url` property
 * that `util.inspect`, a structured logger, a crash reporter or a bare `console.error(err)` all
 * print. `blockscout` wraps these errors and re-messages them by class, so the message channel was
 * closed at that one call site; the **cause chain** it attaches was not, and neither would the next
 * adapter's be.
 *
 * Redacting here rather than at each call site is the point: this removes the class for every
 * present and future caller, and D10 ("secrets never in logs or error messages") stops depending on
 * each adapter remembering to wrap. Nothing in the repo reads `.url` programmatically — checked.
 *
 * `pathname` is kept because it is what makes the error diagnosable at all. "It is ours: the path is
 * built from our own capability routing, never from a secret" was the whole argument, and it was an
 * assumption about every present and future URL this function is handed — the one shape that breaks
 * it is the RPC endpoint whose key IS the path (`https://…/v2/<key>`, the Alchemy/Infura
 * convention), and `rpc-evm` dials a curated list of full URLs. Adversarial cycle 1 raised it; cycle
 * 3 closed it where the URL is admitted rather than where it is printed:
 * `chain/registry-core.ts`'s `isApprovableRpcUrl` REFUSES an `rpcHosts` entry with a
 * credential-shaped path segment, at load, as a `ChainRegistryLoadError`. So the sentence above is
 * now enforced instead of assumed, and the diagnostic keeps its path.
 *
 * A redactor that guessed which segments are secret was the alternative, and it is worse in both
 * directions: it would blind `/api/v2/addresses/0x…` (a long, entirely public id) while still
 * guessing at whatever the next vendor invents.
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // Not parseable as a URL — say so rather than echoing a string we could not inspect.
    return '<unparseable url>';
  }
}

/** Thrown when a `safeFetch` call (including any redirect hop) doesn't settle within
 * `timeoutMs` — lets a caller's own fallback loop (e.g. `rpc-evm`'s primary->secondary endpoint
 * retry) advance to the next candidate instead of hanging forever on a dead host.
 *
 * `url` is the REDACTED form (no query string) — see `redactUrl`. */
export class SafeFetchTimeoutError extends Error {
  public readonly url: string;
  constructor(
    url: string,
    public readonly timeoutMs: number,
  ) {
    const safe = redactUrl(url);
    super(`safeFetch: timed out after ${timeoutMs}ms fetching ${safe}`);
    this.url = safe;
    this.name = 'SafeFetchTimeoutError';
  }
}

/**
 * Thrown when the runtime's own connect bound ended a hop — issue L-30. Whether it got there before
 * the declared per-hop budget depends on which of the two is larger; see `declaredTimeoutMs` below.
 *
 * **It corrects an attribution; it does not change a behaviour.** The hop ends at the same moment
 * either way, and no retry is added. What changes is the sentence an operator reads.
 * `raceWithTimeout` used to reject with the runtime's raw `TypeError: fetch failed`, and the
 * traversal row then read `capability unavailable: … tried: <adapter> (fetch failed)`. That row
 * names the vendor and names nothing else. L-23 was read that way from 2026-08-24 until its own
 * update of 2026-09-02 — nine days — and that update now calls the attribution one reading of two.
 * The vendor is healthy today: THIS session probed the L-23 reproduction URL five times on
 * 2026-09-04 and got HTTP 200 in 0.41–0.45 s each. Those are this session's probes, not the five
 * L-23 records.
 *
 * **Why not `SafeFetchTimeoutError`.** That class means "the vendor did not answer within the
 * per-hop timeout", and the per-hop signal has not fired when this error is raised. Reusing it
 * would state a measurement nobody took, on the same side of the wire as the row it was meant to
 * correct.
 *
 * `declaredTimeoutMs` is the per-hop budget carried alongside, so both numbers stand in one line
 * and the ordering between them is checkable. The message states that ordering ONLY where the
 * declared budget is larger than the bound that fired; two shipped adapters declare 5 000 ms,
 * below the measured bound, and for them the claim would be false.
 *
 * `connectTimeoutMs` is the bound the RUNTIME named, parsed from the `cause`'s own
 * `timeout: <n>ms` text, and `RUNTIME_CONNECT_TIMEOUT_MS` only when the cause carries no such text.
 * A headline that contradicts its own `cause` after a Node upgrade is the failure this class was
 * added to prevent.
 *
 * The runtime's own error is kept as `cause`, so its text survives verbatim.
 *
 * `url` is the REDACTED form (no query string) — see `redactUrl`.
 */
export class RuntimeConnectTimeoutError extends Error {
  public readonly url: string;
  public readonly connectTimeoutMs: number;
  constructor(
    url: string,
    public readonly declaredTimeoutMs: number,
    options?: { cause?: unknown },
  ) {
    const safe = redactUrl(url);
    const bound = reportedConnectTimeoutMs(options?.cause);
    super(runtimeConnectTimeoutMessage(safe, bound, declaredTimeoutMs), options);
    this.url = safe;
    this.connectTimeoutMs = bound;
    this.name = 'RuntimeConnectTimeoutError';
  }
}

/**
 * The message text, split on the one thing that is not always true.
 *
 * "The bound ended the hop BEFORE the declared budget" holds only where the declared budget is
 * larger. `DEFAULT_TIMEOUT_MS` is 15 000 ms and satisfies it; `REQUEST_TIMEOUT_MS = 5_000` in
 * `blockscout` and `blockchain-info` does not. On that side the two numbers are still both named,
 * and no ordering between them is asserted.
 */
function runtimeConnectTimeoutMessage(
  safeUrl: string,
  boundMs: number,
  declaredTimeoutMs: number,
): string {
  const owner = 'The bound belongs to this runtime, not to the vendor.';
  if (declaredTimeoutMs > boundMs) {
    return `safeFetch: the runtime connect bound of ${boundMs}ms ended the hop to ${safeUrl} before the declared ${declaredTimeoutMs}ms per-hop budget. ${owner}`;
  }
  return `safeFetch: the runtime connect bound of ${boundMs}ms ended the hop to ${safeUrl}. The declared ${declaredTimeoutMs}ms per-hop budget is not larger, so no ordering between the two is claimed. ${owner}`;
}

/**
 * `redactUrl` for a context string that may not be a URL at all.
 *
 * `DeadlineExceededError` is raised on TWO paths: the transport path, where the context is a URL
 * that can carry `?apikey=<secret>` (M-14 — `blockscout` authenticates that way because the vendor
 * chose to), and the limiter path (`net/rate-limit.ts`), where it is `provider "<id>"` and there is
 * no URL to redact. `redactUrl` answers `<unparseable url>` for the second, which would erase the
 * only diagnostic the limiter has. Redaction stays INSIDE the error class for the M-14 reason:
 * closing the channel here closes it for every present and future call site, rather than depending
 * on each of them remembering to redact.
 */
function redactContext(text: string): string {
  try {
    const parsed = new URL(text);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // Not a URL — nothing to redact, and the string is ours (`provider "<id>"`), not a vendor's.
    return text;
  }
}

/**
 * Thrown when the ABSOLUTE call deadline (`SafeFetchOptions.deadlineAtMs`, ADR-002 D4) has already
 * passed — the NETWORK-layer class, task 012-7.
 *
 * It is deliberately NOT `SafeFetchTimeoutError`: that one means "this vendor did not answer within
 * the per-hop timeout", i.e. a statement about the vendor, while this one means "we ran out of our
 * OWN time budget" — a statement about us, and the only one that may end a capability traversal.
 * Confusing the two is defect C-1 (task 012-7 §"two signals per hop"): a traversal that never sees
 * this class ends in `CapabilityUnavailableError`, which OD-4/R-145 forbid.
 *
 * **This class does not reach the caller of a capability.** The registry catches it and translates
 * it into `CapabilityDeadlineExceededError` (task 012-8), which carries `{capability, chain, tried}`
 * — none of which exists down here, which is exactly why there are two classes and not one.
 *
 * `at` is the REDACTED context (see `redactContext`): the origin+path of the hop on the transport
 * path, `provider "<id>"` on the limiter path.
 *
 * **`phase` says WHERE the budget went, and it exists because the answer was unrecoverable** (L-26,
 * fix-path item 1). Every producer of this class ends the same way for the caller — the capability
 * refuses — but the operator's next move is completely different: time spent queueing in our own
 * limiter is a rate to widen or a sweep to narrow, and time spent on the wire is a vendor to chase
 * or a deadline to re-derive. Until this field existed both arrived as the identical sentence
 * `capability deadline exceeded: …`, and `transport/failure-classes.ts` had to record in prose that
 * its two classes were indistinguishable on the wire. Two investigations of 2026-08-24 (L-25, and
 * this record) each began by trying to recover that distinction after the fact and could not.
 *
 * It is a CLOSED set rather than free text, so a reader can group by it and a test can pin every
 * producer to exactly one value.
 */
export type DeadlinePhase =
  /** Waiting for a token in the shared provider limiter — our own queue. */
  | 'limiter'
  /** Waiting on the vendor: connection, headers or body of a hop. */
  | 'wire'
  /** Waiting on a document another caller is already downloading (defillama's shared caches). */
  | 'shared-document'
  /** Waiting on a query already in flight for the same key (nansen singleflight). */
  | 'coalesced'
  /** Waiting on the Postgres read path. */
  | 'pg-query';

export class DeadlineExceededError extends Error {
  public readonly at: string;
  constructor(
    at: string,
    public readonly deadlineAtMs: number,
    /**
     * REQUIRED, and it used to carry a default of `wire` (L-26/L-27, made required 2026-08-28).
     *
     * The default existed so a producer added without the argument "still said something true-ish".
     * That is a guess, and this project forbids guesses in exactly this position: L-2's rule is
     * "refuse rather than guess — a fallback that always yields something is a fabrication engine",
     * and `data-model.md` applies the same rule to a derived metric. The harm here is specific. A
     * forgotten phase reported `wire`, which sends the next investigation to the vendor when the
     * truth may be our own queue — the one distinction L-26 and L-27 exist to preserve, and the one
     * both records bet their fix path on.
     *
     * With no default, a producer that forgets is a COMPILE error rather than a confident wrong
     * answer. TC-UNIT-20's source scan is kept as a second line: it also covers the case of a
     * producer passing a variable the compiler accepts but the closed set does not describe.
     */
    public readonly phase: DeadlinePhase,
  ) {
    const safe = redactContext(at);
    super(`deadline exceeded in ${phase} (deadlineAtMs=${deadlineAtMs}) at ${safe}`);
    this.at = safe;
    this.name = 'DeadlineExceededError';
  }
}

/**
 * Thrown when a redirect chain exceeds `MAX_REDIRECTS` — task 014-21, R-10.3, AC-10.
 *
 * **Why a class and not the plain `Error` this was.** `isPassThroughTransportError` is the single
 * predicate every adapter's `catch` asks, and it answers on class. An untyped throw answered `false`
 * for the two adapters that wrap (`blockscout`, `blockchain-info`), which re-message a failure by
 * `error.name` — and `name` on a plain `Error` is literally the string `"Error"`. So a redirect loop
 * arrived at an operator as `blockscout: transport failure from mcp.blockscout.com (Error)`,
 * indistinguishable from a vendor 500, with the only surviving detail on a `.cause` nobody reads.
 * The redirect cap and a vendor's bad day call for opposite responses: one is a vendor-side loop or
 * an open redirect to chase, the other is a retry.
 *
 * `url` is the REDACTED form (no query string) — see `redactUrl`. Consistent with `SsrfBlockedError`,
 * which has carried a bare hostname on this list since M1: the traversal these messages land in is
 * cut before the wire (`transport/failure-classes.ts`).
 */
export class RedirectLimitExceededError extends Error {
  public readonly url: string;
  constructor(
    public readonly limit: number,
    url: string,
  ) {
    // Redacted HERE, not by the caller — the property WI-36 requires of every class on the
    // pass-through list is that it redacts its OWN context at construction. A class that trusted its
    // call site would be safe exactly as long as every future call site remembered.
    const safe = redactUrl(url);
    super(`safeFetch: exceeded ${limit} redirects following ${safe}`);
    this.url = safe;
    this.name = 'RedirectLimitExceededError';
  }
}

/** Thrown when a response's advertised `Content-Length` exceeds `maxResponseBytes` — rejected
 * BEFORE the caller ever reads the body (`.json()`/`.text()`).
 *
 * `url` is the REDACTED form (no query string) — see `redactUrl`. */
export class SafeFetchResponseTooLargeError extends Error {
  public readonly url: string;
  constructor(
    url: string,
    public readonly contentLength: number,
    public readonly maxBytes: number,
  ) {
    const safe = redactUrl(url);
    super(
      `safeFetch: response Content-Length ${contentLength} exceeds the ${maxBytes}-byte cap for ${safe}`,
    );
    this.url = safe;
    this.name = 'SafeFetchResponseTooLargeError';
  }
}

/**
 * The transport errors an adapter may rethrow **as they are** — WI-36.
 *
 * **The defect this closes.** `blockscout` and `blockchain-info` caught every throw out of
 * `safeFetch` and rewrapped it as `new Error('… transport failure … (<class name>)', {cause})`. The
 * wrapper has a real reason (see the next paragraph), and the price was that the CLASS survived only
 * on `.cause`, where `instanceof` cannot see it — so `CapabilityRegistry`'s
 * `error instanceof DeadlineExceededError` was false for every blockscout call and `deadlineHit` was
 * never set on that path. The outcome was restored one layer up by re-reading the clock, which
 * recovers the VERDICT and not the FACT: a clock cannot tell "the deadline expired inside this
 * adapter" from "it expired while we were doing something else".
 *
 * **Why the wrapper existed, and why removing it wholesale would be wrong (M-7).** Three of the
 * errors below interpolate a URL, and `blockscout` is the one adapter in the tree that authenticates
 * with a secret IN the URL (`?apikey=<key>`, the vendor's choice). An adapter error's `.message`
 * travels into `tried[].reason` and from there to the model, so the wrapper was closing a real
 * credential channel (D10).
 *
 * **What makes the list safe is a property of the classes, not a judgement by the adapter.** Every
 * member redacts its own context AT CONSTRUCTION — `redactUrl` for those that carry a URL,
 * `redactContext` for `DeadlineExceededError`, and `SsrfBlockedError` never receives more than a
 * hostname. So "safe to rethrow" is decided once, here, beside the classes, instead of being
 * re-decided by each adapter that catches them; `test/safe-fetch.test.ts` holds the property with an
 * `?apikey=` input per class, and requires every Error class this module exports to be either on
 * this list or deliberately off it.
 *
 * **Untyped throws stay wrapped.** `safeFetch` also raises three plain `Error`s (non-https initial
 * URL, non-https redirect target, redirect cap) and `fetchImpl` can raise anything at all. Those are
 * not on the list and adapters keep wrapping them — which is also why the list is a list and not
 * "rethrow anything that came from the transport".
 */
export const PASS_THROUGH_TRANSPORT_ERRORS = [
  SsrfBlockedError,
  SafeFetchTimeoutError,
  // L-30. On the list for the same reason as its neighbours: it redacts its own URL at
  // construction. One reason is its own — the class names which side owns the bound that ended the
  // hop, and a wrapper would replace that sentence in `tried[].reason`.
  RuntimeConnectTimeoutError,
  DeadlineExceededError,
  SafeFetchResponseTooLargeError,
  RedirectLimitExceededError,
] as const;

/**
 * `true` when `error` is one of `PASS_THROUGH_TRANSPORT_ERRORS` — the single predicate an adapter's
 * `catch` asks, so that adding a class to the list reaches every catch site at once and no adapter
 * ever holds its own copy of the answer.
 */
export function isPassThroughTransportError(error: unknown): boolean {
  return PASS_THROUGH_TRANSPORT_ERRORS.some((constructor) => error instanceof constructor);
}

/** The error code the runtime sets when its connect bound fires. Measured — see
 * `RUNTIME_CONNECT_TIMEOUT_MS` for the probe. On a dual-stack failure it sits on the aggregate's
 * MEMBERS rather than on the cause itself; `causeCandidates` flattens the two into one list. */
const RUNTIME_CONNECT_TIMEOUT_CODE = 'UND_ERR_CONNECT_TIMEOUT';

/** The `cause.name` observed in the same probe. Read only where `code` is absent — see
 * `isConnectTimeoutShape` for why that restriction is deliberate. */
const RUNTIME_CONNECT_TIMEOUT_NAME = 'ConnectTimeoutError';

/** The `timeout: <n>ms` the runtime writes into its own connect-timeout message — the probe on
 * `RUNTIME_CONNECT_TIMEOUT_MS` recorded `timeout: 10000ms`. Read so the headline reports the
 * runtime's number rather than this file's copy of it. */
const RUNTIME_CONNECT_TIMEOUT_TEXT = /\btimeout:\s*(\d+)ms/;

/**
 * ONE level of `cause`, flattened: the cause itself, plus the members of its `errors` array when it
 * has one.
 *
 * The array is the dual-stack shape, and it is handled defensively rather than because it was
 * observed. No probe in this change produced an `AggregateError`; the only measured rejection is
 * the single-cause one recorded on `RUNTIME_CONNECT_TIMEOUT_MS`. What IS measured is that every
 * name here resolves to both an A and an AAAA answer, so a dual-stack connect is reachable — those
 * answers come from the synthesizing resolver described on that constant, not from the vendors.
 * Node attempts both families by default. Where a connect then fails on both, the runtime reports
 * an `AggregateError` whose `errors[]` carry the per-family failures, and the code this predicate
 * needs sits on the members rather than on the aggregate.
 *
 * **One level, and no recursion.** Deeper nesting has not been observed here, and a walk that
 * descends until it finds something is a walk that eventually finds something.
 */
function causeCandidates(error: unknown): unknown[] {
  if (!(error instanceof Error)) return [];
  const cause: unknown = error.cause;
  if (typeof cause !== 'object' || cause === null) return [];
  const nested: unknown = (cause as { errors?: unknown }).errors;
  return Array.isArray(nested) ? [cause, ...(nested as unknown[])] : [cause];
}

/**
 * `true` for one candidate carrying the runtime's connect-bound signature.
 *
 * The decisive field is `code`. It is the runtime's own error code and it was observed in the probe
 * recorded on `RUNTIME_CONNECT_TIMEOUT_MS`. Which other failures may carry the same code was not
 * enumerated here, so the predicate is narrow by choice rather than by proof of exclusivity.
 *
 * `name` is the SECONDARY signal. It came out of the same probe, and it is admitted only where
 * `code` is absent, because a name is a plain string that any library may set on any error.
 * Accepting the name beside a code that says something else would widen what this predicate matches
 * (memory M6), and the class it selects exists to fix an attribution.
 */
function isConnectTimeoutShape(candidate: unknown): boolean {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const { code, name } = candidate as { code?: unknown; name?: unknown };
  if (code === RUNTIME_CONNECT_TIMEOUT_CODE) return true;
  return code === undefined && name === RUNTIME_CONNECT_TIMEOUT_NAME;
}

/**
 * `true` when `error` is the runtime's connect-bound rejection, and for nothing else.
 *
 * Every other rejection returns `false` and travels on untouched. A failure this predicate cannot
 * identify stays the runtime's own: relabelling it would repeat the defect this change fixes, under
 * a different wrong name.
 */
function isRuntimeConnectTimeout(error: unknown): boolean {
  return causeCandidates(error).some(isConnectTimeoutShape);
}

/**
 * The bound in milliseconds as the RUNTIME named it, read from the matching candidate's own text.
 *
 * `RUNTIME_CONNECT_TIMEOUT_MS` is the fallback and only that: it is this file's record of one probe
 * on one Node version, and a runtime that changes its default would otherwise be reported with a
 * number its own `cause` contradicts.
 */
function reportedConnectTimeoutMs(error: unknown): number {
  for (const candidate of causeCandidates(error)) {
    if (!isConnectTimeoutShape(candidate)) continue;
    const { message } = candidate as { message?: unknown };
    if (typeof message !== 'string') continue;
    const digits = RUNTIME_CONNECT_TIMEOUT_TEXT.exec(message)?.[1];
    if (digits === undefined) continue;
    const parsed = Number(digits);
    if (Number.isFinite(parsed)) return parsed;
  }
  return RUNTIME_CONNECT_TIMEOUT_MS;
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

/** One hop's cancellation: the single signal `fetchImpl` is given, the reason THIS hop's abort must
 * reject with, and a teardown for the listeners that decide it. */
interface HopAbort {
  /** The one composed signal handed to `fetchImpl` and raced against. */
  signal: AbortSignal;
  /** The rejection reason, resolved by WHICH INPUT fired — never by which branch noticed. */
  reason: () => unknown;
  /** Detaches this hop's recorder listeners. The caller's signal outlives the hop (and the call),
   * so a hop that settles normally must not leave a listener on it — 4 hops per call, forever. */
  release: () => void;
}

/**
 * Composes a hop's cancellation sources into the ONE signal `fetch` accepts, while REMEMBERING
 * WHICH SOURCE FIRED (task 012-7, defects C-1 and H1).
 *
 * **Why remembering is the whole mechanism.** `AbortSignal.any` reports that ONE OF its inputs
 * aborted and never which; and reading `deadlineSignal.aborted` inside the composed signal's own
 * handler answers a different question — "has it aborted BY NOW" — whose answer depends on timer
 * construction order rather than on what happened. Each input therefore gets its own listener, and
 * the FIRST one to fire writes the verdict that `reason()` later reads. Per the DOM specification a
 * source signal's abort event fires before its dependent signals' (signal abort, steps 5 then 6),
 * so the verdict is always written before the composed handler asks for it.
 *
 * The three outcomes are three different facts, and the caller must be able to act on them:
 *
 * | Fired            | Rejection                                                    |
 * | ---------------- | ------------------------------------------------------------ |
 * | deadline         | `DeadlineExceededError` — our own budget is spent            |
 * | caller's signal  | the caller's OWN reason, unwrapped — it already knows why    |
 * | hop timeout      | `SafeFetchTimeoutError` — the vendor did not answer in time  |
 *
 * **Byte-for-byte compatibility (R-143c):** with neither a deadline nor a caller signal there is
 * exactly one input, and it is passed through as-is — no `AbortSignal.any` wrapper, one
 * `AbortSignal.timeout` per hop, exactly as before this task.
 */
function composeHopAbort(inputs: {
  hopSignal: AbortSignal;
  deadline: { signal: AbortSignal; atMs: number } | undefined;
  callerSignal: AbortSignal | undefined;
  url: string;
  effectiveHopMs: number;
}): HopAbort {
  const { hopSignal, deadline, callerSignal, url, effectiveHopMs } = inputs;

  let firedBy: 'hop' | 'deadline' | 'caller' | undefined;
  const detachers: Array<() => void> = [];

  const record = (source: 'hop' | 'deadline' | 'caller', signal: AbortSignal | undefined): void => {
    if (signal === undefined) return;
    // Already aborted on entry (a caller that cancelled before this hop started): no event will
    // ever fire, so the state IS the verdict. `??=` throughout — only the FIRST source counts.
    if (signal.aborted) {
      firedBy ??= source;
      return;
    }
    const onAbort = (): void => {
      firedBy ??= source;
    };
    signal.addEventListener('abort', onAbort, { once: true });
    detachers.push(() => signal.removeEventListener('abort', onAbort));
  };

  // Order matters ONLY for signals already aborted on entry, where there is no event order to read.
  // The caller comes first there: it is the one source that can be aborted before we were called.
  record('caller', callerSignal);
  record('deadline', deadline?.signal);
  record('hop', hopSignal);

  const sources = [hopSignal, deadline?.signal, callerSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );

  return {
    signal: sources.length === 1 ? hopSignal : AbortSignal.any(sources),
    reason: () => {
      if (firedBy === 'deadline' && deadline !== undefined) {
        return new DeadlineExceededError(url, deadline.atMs, 'wire');
      }
      if (firedBy === 'caller' && callerSignal !== undefined) {
        // NOT wrapped in anything of ours: the caller asked for this and already knows why.
        return callerSignal.reason;
      }
      return new SafeFetchTimeoutError(url, effectiveHopMs);
    },
    release: () => {
      for (const detach of detachers) detach();
    },
  };
}

/**
 * Races `fetchPromise` against `signal`'s own abort event, rejecting the moment `signal` aborts —
 * regardless of whether `fetchPromise` itself ever settles. This extra listener (rather than
 * relying solely on passing `signal` into `fetchImpl` and trusting it to reject on abort) is
 * deliberate: an injected TEST `fetchImpl` that never resolves (and never inspects its own `signal`
 * argument) must still time out, exactly like a real hung `fetch()` call would once the real
 * implementation honors the abort signal.
 *
 * **It no longer MANUFACTURES the rejection (task 012-7, defect C-1).** It used to build a
 * `SafeFetchTimeoutError` unconditionally, having no way to know which of the hop's cancellation
 * sources actually fired — so a deadline expiring mid-flight was reported as a vendor timeout, and
 * a caller's own `abort()` as one too. The reason now comes from `abortReason`, which
 * `composeHopAbort` closes over the answer to "which INPUT signal fired".
 *
 * **`fetchPromise`'s handlers are attached FIRST, before the already-aborted check (cycle 2, F-1).**
 * The order is the whole fix, not tidiness. `fetchPromise` is built in the CALLER's argument list,
 * so by the time this function runs the request has already been issued; a real `fetch` handed a
 * signal that was aborted before the call rejects with `AbortError` immediately. The previous order
 * — reject, `return`, never attach — left that rejection with no handler at all, and on Node's
 * default `--unhandled-rejections=throw` an unhandled rejection ENDS THE PROCESS. The consumer is a
 * long-lived stdio MCP server whose `main().catch(...)` cannot see a rejection belonging to no
 * awaited chain, so "a caller cancelled early" was a way to kill the server.
 *
 * Attaching first changes nothing else: `signal.aborted` is still read synchronously and still wins,
 * because a `.then` handler can only run in a later microtask. The settled promise's `reject(...)`
 * is then a no-op on an already-rejected one — which is precisely how the rejection becomes handled
 * rather than swallowed.
 *
 * **The rejection branch is the one place a raw `fetchImpl` failure passes through** (L-30). One
 * such failure is reclassified here and no other: the runtime's connect bound, identified by
 * `isRuntimeConnectTimeout` and rewritten as `RuntimeConnectTimeoutError` with the original kept as
 * `cause`. It is reclassified in this branch rather than in `safeFetch` because the abort branch
 * above cannot produce it — the hop signal has not fired when the runtime gives up on the
 * connection. `context` carries the two facts the new class needs and this function did not
 * previously hold: the hop's URL, and the declared per-hop budget that did not get to fire.
 */
function raceWithTimeout(
  fetchPromise: Promise<Response>,
  signal: AbortSignal,
  abortReason: () => unknown,
  context: { url: string; declaredTimeoutMs: number },
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason());
    fetchPromise.then(
      (response) => {
        signal.removeEventListener('abort', onAbort);
        resolve(response);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        const raised = error instanceof Error ? error : new Error(String(error));
        reject(
          isRuntimeConnectTimeout(raised)
            ? new RuntimeConnectTimeoutError(context.url, context.declaredTimeoutMs, {
                cause: raised,
              })
            : raised,
        );
      },
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
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
            `safeFetch: non-binary chunk from ${redactUrl(url)} (${typeof value}) — refusing to count`,
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
 * **Call deadline (task 012-7, ADR-002 D4 — `options.deadlineAtMs`):** an ABSOLUTE epoch-ms moment
 * the whole call must respect, redirect hops included. Two things follow, and they are two
 * mechanisms rather than one because a deadline that expires mid-flight is the ordinary case, not
 * the exotic one — every route ends on somebody's last hop, and a last hop has no next iteration:
 * - On ENTRY to each hop, a remainder of `<= 0` throws `DeadlineExceededError` with no network call.
 * - DURING each hop, a second `AbortSignal.timeout(remainder)` runs beside the per-hop one. The hop
 *   timeout is NOT shortened to the remainder (see the `effectiveHopMs` comment in the loop for the
 *   defect that would reintroduce), and the class thrown is decided by WHICH signal fired, not by
 *   which branch noticed the abort.
 *
 * **The caller's own `opts.signal` is honoured** (H1). It used to be overwritten by the internal
 * timeout signal — silently, so an external cancellation did nothing. It is now composed in, and if
 * it is what aborted the hop, ITS OWN reason is what the caller gets back, unwrapped.
 *
 * With neither a deadline nor a caller signal, all of the above collapses to exactly the previous
 * behaviour: one `AbortSignal.timeout(timeoutMs)` per hop, rejecting with `SafeFetchTimeoutError`.
 *
 * `fetchImpl` is injectable (default: the global `fetch`) so this is unit-testable without any
 * real network access — tests supply a fake that returns canned `Response`s per hop.
 *
 * @throws {SsrfBlockedError} for the initial URL or any redirect hop outside `allowlist`.
 * @throws {SafeFetchTimeoutError} if any hop doesn't settle within the timeout.
 * @throws {RuntimeConnectTimeoutError} if the runtime's own connect bound (10 000 ms as measured
 *   here — see `RUNTIME_CONNECT_TIMEOUT_MS`) ends a hop.
 * @throws {DeadlineExceededError} if `options.deadlineAtMs` passes before the call completes.
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
  const deadlineAtMs = options.deadlineAtMs;
  // Read ONCE, before the loop: `currentOpts` is rebuilt on a cross-host redirect, and reading the
  // caller's signal out of the rebuilt copy each time would tie a cancellation contract to header
  // stripping. `?? undefined` because `RequestInit['signal']` is nullable.
  const callerSignal = opts.signal ?? undefined;

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
  // The AUTHORITY, not the hostname — `URL.host` keeps a non-default port and drops `:443`
  // (task 014-21, AC-9). See `allowlistAuthority` for what changing this field closed.
  let currentHostname = initialUrl.host;
  let currentOpts: RequestInit = opts;
  let redirectsFollowed = 0;

  for (;;) {
    assertAllowedHost(currentHostname, allowlist);

    // The DUPLICATE check, and it is not made redundant by `deadlineSignal` below: a signal can
    // only abort a call that has already been issued, and issuing it is exactly what a spent
    // deadline must prevent (R-142c). Costs nothing on the hop that is still in budget.
    if (deadlineAtMs !== undefined && deadlineAtMs - Date.now() <= 0) {
      throw new DeadlineExceededError(currentUrl, deadlineAtMs, 'wire');
    }

    // `effectiveHopMs = timeoutMs` — UNCLAMPED BY THE DEADLINE, and that is a decision, not an
    // omission (task 012-7, plan review 2). Clamping to `min(timeoutMs, deadlineAtMs - now)` makes
    // both timers expire in the SAME millisecond; `hopSignal` is constructed first, so it wins
    // every tie, and `DeadlineExceededError` is then never born. Downstream that is C-1 verbatim:
    // the registry never sets `deadlineHit`, the traversal ends in `CapabilityUnavailableError`,
    // and OD-4/R-145 forbid exactly that outcome. The remainder is already carried by
    // `deadlineSignal`, so clamping buys nothing and costs the discriminator.
    //
    // A THIRD timer can settle before either of those two, and it is not ours (L-30): the
    // runtime's connect bound, `RUNTIME_CONNECT_TIMEOUT_MS` = 10 000 ms, measured rather than
    // configured. It gets there first only where `timeoutMs` EXCEEDS it — `DEFAULT_TIMEOUT_MS` is
    // 15 000, while `blockscout` and `blockchain-info` declare 5 000 and are cut by their own hop
    // signal instead. In the first case neither `hopSignal` nor the deadline signal fires, so the
    // tie reasoned about above is never reached. No timer here is derived from that bound, because
    // this repository cannot set it; the rejection it produces is reclassified as
    // `RuntimeConnectTimeoutError` in `raceWithTimeout` so the row names the side that owns it.
    const effectiveHopMs = timeoutMs;
    const hop = composeHopAbort({
      hopSignal: AbortSignal.timeout(effectiveHopMs),
      // Rebuilt from the ABSOLUTE moment on every hop, which is what stops the budget from being
      // re-granted in full to each of the up-to-4 hops (`MAX_REDIRECTS = 3`).
      deadline:
        deadlineAtMs === undefined
          ? undefined
          : {
              signal: AbortSignal.timeout(Math.max(0, deadlineAtMs - Date.now())),
              atMs: deadlineAtMs,
            },
      callerSignal,
      url: currentUrl,
      effectiveHopMs,
    });

    let response: Response;
    try {
      response = await raceWithTimeout(
        // `signal` is LAST here as before, but it no longer discards the caller's: `hop.signal`
        // composes it in (H1 — the previous version silently overwrote `opts.signal`).
        fetchImpl(currentUrl, { ...currentOpts, redirect: 'manual', signal: hop.signal }),
        hop.signal,
        hop.reason,
        { url: currentUrl, declaredTimeoutMs: effectiveHopMs },
      );
    } finally {
      hop.release();
    }

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
      throw new RedirectLimitExceededError(MAX_REDIRECTS, url);
    }

    // Resolve a relative Location against the current hop's URL, exactly like a real browser
    // redirect would — then the NEXT loop iteration re-checks its hostname before following it.
    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.protocol !== 'https:') {
      throw new Error(
        `safeFetch: refusing to follow a redirect to a non-https target (${nextUrl.protocol}//${nextUrl.hostname})`,
      );
    }

    // Compared on the AUTHORITY too, and the two must move together: with the allowlist checking
    // `host` and this checking `hostname`, a hop to another PORT on an allowlisted host would be
    // refused on the next iteration but would already have been handed the credential headers on
    // this one. A port change is a host change as far as a secret is concerned.
    if (nextUrl.host !== currentHostname) {
      currentOpts = { ...currentOpts, headers: stripCrossHostHeaders(currentOpts.headers) };
    }
    currentUrl = nextUrl.toString();
    currentHostname = nextUrl.host;
    redirectsFollowed += 1;
  }
}
