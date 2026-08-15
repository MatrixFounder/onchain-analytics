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

  /**
   * `sessionId` → the pair that serves it.
   *
   * **Why the map holds the transport and not only the server.** A Streamable HTTP session is a
   * stream the transport owns; routing a later request to a NEW transport would answer on a channel
   * the client is not reading.
   */
  const sessions = new Map<
    string,
    { server: McpServer; transport: StreamableHTTPServerTransport }
  >();

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
    sessionCount: () => sessions.size,
    close: async () => {
      // Every session is closed before the listener is: a transport left open holds a socket, and
      // `listener.close()` would then wait for a client that has no reason to leave.
      for (const { server, transport } of [...sessions.values()]) {
        await transport.close();
        await server.close();
      }
      sessions.clear();
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

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: HttpTransportDeps,
  sessions: Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>,
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
    // The same shape the SDK's own refusal uses: HTTP 403 and a JSON-RPC error carrying -32000, so
    // a client parses one form (`webStandardStreamableHttp.js`, `createJsonErrorResponse`).
    res.writeHead(403, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: `Invalid ${refused} header` },
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
      if (existing === undefined) {
        res.writeHead(404).end();
        return;
      }
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

    const server = deps.createSessionServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // R-12.3 requires the option to be set, and AC-37 asserts it on the transport. Ours ran above;
      // this is the second, independent check of one perimeter (§7.5.4).
      enableDnsRebindingProtection: true,
      allowedHosts: [...(perimeter?.hosts ?? [])],
      allowedOrigins: [...(perimeter?.origins ?? [])],
      onsessioninitialized: (id: string) => {
        sessions.set(id, { server, transport });
      },
      onsessionclosed: (id: string) => {
        sessions.delete(id);
      },
    });
    // Two removal paths, because a session ends in two ways: a client DELETE (`onsessionclosed`) and
    // the transport closing for any other reason. RISK-6 is a map that only ever grows, and one path
    // covered is a map that grows more slowly.
    transport.onclose = (): void => {
      const id = transport.sessionId;
      if (id !== undefined) sessions.delete(id);
    };

    await server.connect(transport);
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
