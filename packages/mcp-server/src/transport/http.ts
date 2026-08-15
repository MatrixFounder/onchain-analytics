import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { TokenLookupRow } from '../auth/identity-types.js';
import { principalFromToken, toAuthInfo } from '../auth/principal.js';
import type { Diagnostics } from '../engine/diagnostics.js';
import { DEFAULT_SESSION_IDLE_MS, DEFAULT_SESSION_MAX } from '../env.js';
import {
  assertIdleTimeoutClearsManifest,
  createSessionManager,
  type SessionManager,
} from './session-manager.js';

/**
 * The second transport (task 014-09, R-1, ADR-003 D1): Streamable HTTP beside stdio.
 *
 * **stdio is not touched.** `index.ts` chooses one or the other from the deployment profile, and the
 * stdio path is the same call it has been since M0 — no listener, no port, no header. AC-2 freezes
 * that: `e2e.stdio.test.ts` and the `tools/list` snapshot are unedited by this task.
 *
 * **`createServer`'s signature is unchanged**, deliberately. It is the point through which every
 * dependency is assembled, so editing it touches every caller; the transport is chosen outside it.
 *
 * **Sessions, since task 014-10.** One `McpServer` and one transport per SESSION, kept in a map
 * keyed by the id the SDK mints, and removed when the session ends. Everything else — the registry,
 * the cache, the budget ledger — is assembled once per process in `runtime.ts` and shared by every
 * session, because a cache nobody shares is not a cache and a ceiling nobody shares is not a ceiling.
 * Task 014-13 moved that map into `session-manager.ts`, which owns the two removal causes a client
 * cannot signal — the idle sweep and the ceiling — and the two this file already had.
 *
 * **What this file still does NOT do, and the running server is unsafe until it does.** No token is
 * checked (task 014-12) and no perimeter is configured (014-11); the listener below accepts whatever
 * reaches it. `SHIPPED_TRANSPORTS` carries `'http'` because the transport exists, and the network
 * profile still refuses to start until 014-12's precondition is in place.
 */

export interface HttpTransportDeps {
  /**
   * Builds the `McpServer` that answers one request.
   *
   * **Why a factory and not an instance.** Task 014-10 turns this into one instance per SESSION, and
   * 014-04's inventory narrowing is applied where a session is built (`system-architecture.md`
   * §3.4.9). A single shared instance would make `tools/list` a fact about the process and leave
   * narrowing without a mechanism.
   */
  readonly createSessionServer: () => McpServer;
  readonly bind: string;
  readonly port: number;
  /** Endpoint path. One value, so the client and the listener cannot disagree about it. */
  readonly path?: string;
  /**
   * Accepted `Host` values (R-12.1). Unset means the bound address and port, with no wildcard.
   *
   * **One value, two readers** (task 014-11). This list is handed to our own check below AND to the
   * SDK transport's own. Two copies of a perimeter list diverge; two readers of one value cannot.
   */
  readonly allowedHosts?: readonly string[];
  /** Accepted `Origin` values (R-12.2). Unset means no browser origin is admitted. */
  readonly allowedOrigins?: readonly string[];
  /**
   * The diagnostics channel (task 014-27). Optional: the `local` profile has none, and the two
   * events this file emits — `auth.rejected` and `perimeter.rejected` — are network-only by
   * construction.
   */
  readonly diagnostics?: Diagnostics;
  /**
   * Step 2 of the admission order: the bearer, decided before anything is routed (task 014-12,
   * R-3, `deployment.md` §10.2.1).
   *
   * **Why it is REQUIRED and not optional.** An optional authenticator is an unauthenticated path
   * that still exists — and a test written against it stays green while asserting nothing about the
   * running server. Task 014-09 shipped exactly that path deliberately, and this is where it is
   * removed: a transport cannot be raised without saying who decides a token.
   *
   * The `local` profile is unaffected: it attaches stdio and never reaches this file. stdio requires
   * no token and checks none (`docs/TASK.md`), and a token issued into the store of a stdio process
   * is inert.
   */
  readonly authenticate: (presented: string | null) => Promise<AuthDecision>;
  /**
   * The session ceiling and the idle timeout (task 014-13, R-24). Both default to the value
   * `withDeclaredDefaults` applies, so a test raising a bare transport gets the SHIPPED numbers
   * rather than a second set that could drift from them.
   */
  readonly sessionMax?: number;
  readonly sessionIdleMs?: number;
  /** The clock the idle sweep measures against. Injectable so no test waits for real time. */
  readonly now?: () => number;
  /** Passed through to the sweeper; a test uses it to hold the timer handle. */
  readonly createTimer?: (tick: () => void, intervalMs: number) => NodeJS.Timeout;
}

/**
 * What step 2 answers. The refusal class is the OPERATOR's answer, recorded in diagnostics; the
 * caller sees one `401` whichever of the four states applied (`security.md` §7.5.2).
 */
export type AuthDecision =
  | { readonly ok: true; readonly principal: TokenLookupRow }
  | { readonly ok: false; readonly refusalClass: string };

/** `Authorization: Bearer <token>` — the only form (§7.5.2). Anything else presents nothing. */
export function bearerOf(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * The perimeter, normalized (`security.md` §7.5.4).
 *
 * **Why our own check runs in front of the SDK's.** Three measurements make it load-bearing rather
 * than defensive habit:
 *
 * 1. The three SDK options are `@deprecated` in the installed version
 *    (`webStandardStreamableHttp.d.ts`), so a future release can remove them.
 * 2. The SDK's `Host` comparison is exact and case-sensitive
 *    (`webStandardStreamableHttp.js`: `!this._allowedHosts.includes(hostHeader)`), so a configured
 *    `LOCALHOST:8848` would not match a client sending `localhost:8848`.
 * 3. A request with NO `Origin` header passes the SDK's origin check — deliberately admitted here
 *    too, because the engine's clients are servers and n8n sends none. Refusing an absent `Origin`
 *    would refuse the only client T-014 has.
 *
 * **Both checks are kept.** R-12.3 requires the SDK option to be set, and two independent checks of
 * one perimeter fail independently. They can disagree only in the fail-closed direction: ours
 * normalizes, so anything ours admits and the SDK's refuses is still refused.
 */
export interface Perimeter {
  readonly hosts: readonly string[];
  readonly origins: readonly string[];
  /**
   * The port this process actually bound — the value a missing port is filled in from.
   *
   * **It is carried here, and not derived from the request.** The first draft of this file computed
   * the fill-in port from the incoming `Host` header, which would have made every value match its
   * own port and left the check admitting everything. The number a request is measured against has
   * to come from the process, never from the request.
   */
  readonly boundPort: number;
}

/**
 * Lowercases, and fills a missing port from the bound one — on BOTH sides.
 *
 * The symmetry is what makes it work behind a reverse proxy: a configured `onchain.internal` and an
 * incoming `Host: onchain.internal` both become `onchain.internal:8848`, so the operator does not
 * have to write a port the proxy never sends. A side that states a port explicitly keeps it, so a
 * mismatch is still a mismatch.
 */
export function normalizeHost(value: string, boundPort: number): string {
  const lowered = value.trim().toLowerCase();
  if (lowered === '') return '';
  // An IPv6 literal carries its own colons; only a `]:port` suffix is a port.
  const hasPort = lowered.startsWith('[')
    ? /\]:\d+$/.test(lowered)
    : /:\d+$/.test(lowered) && lowered.split(':').length === 2;
  return hasPort ? lowered : `${lowered}:${String(boundPort)}`;
}

/** Origins are compared lowercased and without a trailing slash; no port is invented. */
export function normalizeOrigin(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, '');
}

export function resolvePerimeter(deps: HttpTransportDeps, boundPort: number): Perimeter {
  return {
    boundPort,
    // Unset is NOT "anything": it is the address this process bound, and nothing else (R-12.1).
    hosts: (deps.allowedHosts ?? [`${deps.bind}:${String(boundPort)}`]).map((host) =>
      normalizeHost(host, boundPort),
    ),
    // Unset is the empty list, and an empty list admits no browser origin at all (R-12.2). CORS is
    // denied by being ABSENT (R-12.5): no `Access-Control-Allow-Origin` is produced anywhere in the
    // SDK's server tree, and this file adds no CORS middleware.
    origins: (deps.allowedOrigins ?? []).map(normalizeOrigin),
  };
}

/**
 * Whether the request is inside the perimeter.
 *
 * Returns the failing header's NAME, never its value: the caller chose that value, and reflecting it
 * into a response body is a habit worth not having. The SDK's own message does echo it — that text
 * is its own, and this one is ours.
 */
export function perimeterRefusal(
  headers: { readonly host?: string; readonly origin?: string },
  perimeter: Perimeter,
): 'Host' | 'Origin' | null {
  const host = normalizeHost(headers.host ?? '', perimeter.boundPort);
  if (host === '' || !perimeter.hosts.includes(host)) return 'Host';
  const origin = headers.origin;
  // Measurement 3: an absent `Origin` passes. The engine's clients are servers.
  if (origin === undefined) return null;
  return perimeter.origins.includes(normalizeOrigin(origin)) ? null : 'Origin';
}

export interface RunningHttpTransport {
  /** The bound address — the PORT is what a test needs, since it asks for an ephemeral one. */
  readonly address: { readonly host: string; readonly port: number };
  /** The perimeter in force, resolved from the port actually bound. */
  readonly perimeter: Perimeter;
  /** Live sessions. RISK-6 is a map that only grows; this is what a test watches it with. */
  sessionCount(): number;
  /**
   * The manager itself — the SAME instance the handler routes through, never a view of it.
   *
   * Exposed so a test can drive the sweep on an injected clock instead of waiting for the periodic
   * one. A second object here would be a copy that agreed with the first until one was edited.
   */
  readonly sessions: SessionManager;
  close(): Promise<void>;
}

/**
 * The largest request body this transport will buffer.
 *
 * The listener is network-facing and reads the body before anything has authenticated the caller, so
 * an unbounded read is memory an unauthenticated client controls. Four mebibytes is far above any
 * MCP request this server answers and far below anything that matters to the process.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export const DEFAULT_MCP_PATH = '/mcp';

/**
 * The three methods Streamable HTTP defines, in the SDK's own order and spelling — its `Allow`
 * header reads `GET, POST, DELETE`, and answering a different list from the same endpoint would
 * make the two halves of one transport disagree in writing.
 */
export const ALLOWED_METHODS = Object.freeze(['GET', 'POST', 'DELETE']);

/**
 * Raises the listener and answers MCP over it.
 *
 * **One server and one transport per REQUEST, and that is the stub.** The SDK's stateless mode is
 * exactly this shape, and it is what makes the milestone's first HTTP answer comparable to stdio's
 * without inventing a session model that task 014-10 would then replace. The cost is stated rather
 * than hidden: nothing survives a request, so a client cannot hold a session, and `initialize` has
 * to be repeated. 014-10 is where a session becomes a thing this process remembers.
 *
 * **Why the pair is closed when the response ends.** Without it, every request leaks a server and a
 * transport — RISK-6's growth, arriving one milestone before the session map it was written about.
 */
export async function startHttpTransport(deps: HttpTransportDeps): Promise<RunningHttpTransport> {
  const path = deps.path ?? DEFAULT_MCP_PATH;
  const idleMs = deps.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;

  // **Before anything is bound** (task 014-13, §3.4.2). The assertion lives here rather than in
  // `index.ts` so that no caller can raise this transport without it: a timeout below the longest
  // declared deadline evicts a session whose own request is still running, and the only way to make
  // that unreachable is to make the listener unreachable without the check.
  assertIdleTimeoutClearsManifest(idleMs);

  /**
   * `sessionId` → the pair that serves it, plus the two timestamps the sweep reads.
   *
   * **Why the map holds the transport and not only the server.** A Streamable HTTP session is a
   * stream the transport owns; routing a later request to a NEW transport would answer on a channel
   * the client is not reading.
   */
  const sessions = createSessionManager({
    max: deps.sessionMax ?? DEFAULT_SESSION_MAX,
    idleMs,
    now: deps.now ?? ((): number => Date.now()),
    ...(deps.diagnostics ? { diagnostics: deps.diagnostics } : {}),
    ...(deps.createTimer ? { createTimer: deps.createTimer } : {}),
  });

  // The perimeter needs the BOUND port, which port 0 only reveals after `listen`. The listener is
  // created first and the perimeter resolved from the address it actually got.
  let perimeter: Perimeter | null = null;

  const listener = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, path, deps, sessions, perimeter);
  });

  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(deps.port, deps.bind, () => {
      listener.removeListener('error', reject);
      resolve();
    });
  });

  const bound = listener.address() as AddressInfo;
  perimeter = resolvePerimeter(deps, bound.port);
  return {
    address: { host: bound.address, port: bound.port },
    perimeter,
    sessionCount: () => sessions.size(),
    sessions,
    close: async () => {
      // Every session is closed before the listener is: a transport left open holds a socket, and
      // `listener.close()` would then wait for a client that has no reason to leave. The sweeper
      // timer is cleared in the same call — `unref` keeps it from holding the process open, and
      // clearing it keeps it from firing against a map nothing is serving.
      await sessions.shutdown();
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
        listener.closeIdleConnections();
      });
    },
  };
}

/** Reads a POST body, refusing one larger than the cap rather than buffering it. */
async function readBody(
  req: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (req.method !== 'POST') return { ok: true, value: undefined };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return { ok: false };
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    // Unparseable is not oversized: the SDK renders its own parse error, so the body is handed on.
    return { ok: true, value: undefined };
  }
}

/**
 * Hands the verified principal to the SDK, which is what makes it visible inside a tool (014-15).
 *
 * **`req.auth` is a DECLARED seam, not a private field.** `streamableHttp.d.ts` types the parameter
 * as `IncomingMessage & { auth?: AuthInfo }` and `handleRequest` reads exactly that property before
 * forwarding it as `HandleRequestOptions.authInfo`. Measured against SDK 1.29.0 and confirmed by a
 * probe that drove a real session end to end.
 *
 * **Set on every request, including one on an established session.** The token is re-verified per
 * request (no verified-token cache exists), so the principal a tool sees is the one this request
 * presented — which is what makes a revocation take effect on the next call (R-15.6, AC-26) rather
 * than at the idle timeout.
 *
 * **Only the POST branch carries it.** The web-standard transport passes its options to
 * `handlePostRequest` alone, so `GET` (the standalone SSE stream) and `DELETE` drop it. That costs
 * nothing here: a `tools/call` is always a POST, and neither of the other two reaches a tool.
 */
function attachPrincipal(req: IncomingMessage, row: TokenLookupRow): void {
  (req as IncomingMessage & { auth?: AuthInfo }).auth = toAuthInfo(principalFromToken(row));
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: HttpTransportDeps,
  sessions: SessionManager,
  perimeter: Perimeter | null,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://placeholder');
  if (url.pathname !== path) {
    // A path this transport does not serve is a 404 and nothing else — no body describing what the
    // process does serve. An unauthenticated caller learns the shape of the surface from that.
    res.writeHead(404).end();
    return;
  }

  // **The perimeter is checked FIRST** — before the body is read, before a session is looked up and,
  // from task 014-12, before the token store is asked anything. A request from outside the perimeter
  // must not cause a read of the credential table (§10.2.1, task 014-12's step order).
  const refused =
    perimeter === null
      ? 'Host'
      : perimeterRefusal(
          {
            ...(typeof req.headers.host === 'string' ? { host: req.headers.host } : {}),
            ...(typeof req.headers.origin === 'string' ? { origin: req.headers.origin } : {}),
          },
          perimeter,
        );
  if (refused !== null) {
    // R-19.4: a perimeter refusal is OBSERVABLE. The header VALUE goes to the stored channel and
    // never to the client — the caller chose it, and an operator is the one who needs to see what
    // was presented.
    const eventId =
      (await deps.diagnostics?.emit('perimeter.rejected', {
        severity: 'warn',
        detail: { header: refused, presented: req.headers[refused.toLowerCase()] ?? null },
      })) ?? null;
    // The same shape the SDK's own refusal uses: HTTP 403 and a JSON-RPC error carrying -32000, so
    // a client parses one form (`webStandardStreamableHttp.js`, `createJsonErrorResponse`).
    res.writeHead(403, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: `Invalid ${refused} header`,
          // The client's half of the pair (task 014-26): an identifier, never the operator text.
          // It resolves to the row that holds what was presented.
          ...(eventId === null ? {} : { data: { event: eventId } }),
        },
        id: null,
      }),
    );
    return;
  }

  // **Step 2: authentication, before the body is read and before anything is routed** (R-3).
  //
  // Ahead of the body so an unauthenticated caller cannot make this process buffer megabytes, and
  // far ahead of the registry and the cache: AC-3 requires that an unauthenticated request produce
  // no outgoing vendor call and no cache read, and the only way to guarantee that is to refuse
  // before either is reachable.
  const decision = await deps.authenticate(bearerOf(req.headers.authorization));
  if (!decision.ok) {
    // R-19.3: an authentication refusal is observable, and the CLASS is what an operator needs —
    // the four states answer one `401` on the wire and are told apart only here (§7.5.2).
    const eventId =
      (await deps.diagnostics?.emit('auth.rejected', {
        severity: 'warn',
        detail: { refusalClass: decision.refusalClass },
      })) ?? null;
    // `WWW-Authenticate: Bearer` is what makes this a challenge rather than a bare refusal, and the
    // body carries -32000 — the code the SDK's own transport-level refusal uses — so a client parses
    // one shape. The refusal CLASS is not rendered: it is the operator's, and a caller without a
    // valid token learns nothing from the difference between "unknown" and "revoked".
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Unauthorized',
          ...(eventId === null ? {} : { data: { event: eventId } }),
        },
        id: null,
      }),
    );
    return;
  }

  // **Step 3: the method** (task 014-25's `method-not-allowed` class). Streamable HTTP uses exactly
  // three, and the SDK's own `handleUnsupportedRequest` answers 405 with `Allow` — but it is only
  // reached once a request has been routed to a transport, so a `PUT` with no session used to be
  // answered 400 here and the declared class had no producer on that path.
  if (!ALLOWED_METHODS.includes(req.method ?? '')) {
    res
      .writeHead(405, { 'content-type': 'application/json', allow: ALLOWED_METHODS.join(', ') })
      .end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null,
        }),
      );
    return;
  }

  const body = await readBody(req);
  if (!body.ok) {
    res.writeHead(413).end();
    return;
  }

  const presented = req.headers['mcp-session-id'];
  const sessionId = typeof presented === 'string' ? presented : undefined;

  try {
    if (sessionId !== undefined) {
      const existing = sessions.get(sessionId);
      // An id this process does not know is a 404, which is what the SDK answers for the same case.
      // Minting a session for it would let a client choose its own id.
      //
      // The BODY is the SDK's too, value for value: `createJsonErrorResponse(404, -32001, 'Session
      // not found')`. A bare 404 was the same status with nothing to parse, and it left one of the
      // five declared protocol classes without a JSON-RPC code on the path this listener owns.
      if (existing === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null,
          }),
        );
        return;
      }
      // On EVERY inbound message, not only on `tools/call` (§3.4.2). A client holding its session
      // open with notifications is not idle, and a sweeper judging by tool calls would evict it
      // mid-conversation. Unconditional assignment, no read-modify-write: this is the one
      // per-session field a request writes, and R-25.2 is why it stays that way.
      sessions.touch(sessionId);
      attachPrincipal(req, decision.principal);
      await existing.transport.handleRequest(req, res, body.value);
      return;
    }

    if (!isInitializeRequest(body.value)) {
      // A request with no session and no `initialize` has nothing to attach to. Answering 400 here
      // rather than building a pair for it is what keeps an unauthenticated caller from creating one
      // `McpServer` per request.
      res.writeHead(400).end();
      return;
    }

    // **Step 4: the ceiling** (R-24.3, AC-30). It runs here and not earlier for two reasons: an
    // established session must not be refused by it, and a request that is not an `initialize`
    // creates nothing to count. `admit` sweeps first, so an abandoned session cannot deny service
    // to a new one.
    const admission = await sessions.admit(decision.principal.tokenId);
    if (!admission.ok) {
      // **503 and not 429.** A 429 asserts that THIS caller called too often; the measured cause is
      // the capacity of the process across every principal. `Retry-After` is what makes the refusal
      // actionable, and AC-30 asks for a declared class rather than a timeout — so the caller gets a
      // named answer inside its own deadline instead of a hang.
      res
        .writeHead(503, {
          'content-type': 'application/json',
          'retry-after': String(admission.retryAfterSeconds),
        })
        .end(
          JSON.stringify({
            jsonrpc: '2.0',
            // The same -32000 the perimeter and the authentication refusals carry, so a client
            // parses one shape. The live/max numbers stay in diagnostics: they describe the
            // process's capacity across every principal, and this caller is one of them.
            error: {
              code: -32000,
              message: 'Session limit reached',
              ...(admission.eventId === null ? {} : { data: { event: admission.eventId } }),
            },
            id: null,
          }),
        );
      return;
    }

    const server = deps.createSessionServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // R-12.3 requires the option to be set, and AC-37 asserts it on the transport. Ours ran above;
      // this is the second, independent check of one perimeter (§7.5.4).
      enableDnsRebindingProtection: true,
      allowedHosts: [...(perimeter?.hosts ?? [])],
      allowedOrigins: [...(perimeter?.origins ?? [])],
      onsessioninitialized: (id: string) => {
        sessions.register(id, { server, transport, principalId: decision.principal.tokenId });
      },
      onsessionclosed: (id: string) => {
        sessions.forget(id);
      },
    });
    // Four removal causes, one removal path (§3.4.2). Two are here — a client DELETE
    // (`onsessionclosed`) and the transport closing for any other reason; the other two are the
    // sweep and the ceiling, and both live in the manager. RISK-6 is a map that only ever grows.
    transport.onclose = (): void => {
      const id = transport.sessionId;
      if (id !== undefined) sessions.forget(id);
    };

    await server.connect(transport);
    attachPrincipal(req, decision.principal);
    await transport.handleRequest(req, res, body.value);
  } catch (error) {
    // The SDK answers most protocol errors itself; this covers the rest. The message is not
    // rendered to the client — an error text from inside the process is an operator detail (R-20).
    console.error(
      `onchain-intel-mcp-server: http transport: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (!res.headersSent) res.writeHead(500).end();
  }
}
