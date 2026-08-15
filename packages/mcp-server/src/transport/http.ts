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
}

export interface RunningHttpTransport {
  /** The bound address — the PORT is what a test needs, since it asks for an ephemeral one. */
  readonly address: { readonly host: string; readonly port: number };
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

  const listener = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, path, deps, sessions);
  });

  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(deps.port, deps.bind, () => {
      listener.removeListener('error', reject);
      resolve();
    });
  });

  const bound = listener.address() as AddressInfo;
  return {
    address: { host: bound.address, port: bound.port },
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
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://placeholder');
  if (url.pathname !== path) {
    // A path this transport does not serve is a 404 and nothing else — no body describing what the
    // process does serve. An unauthenticated caller learns the shape of the surface from that.
    res.writeHead(404).end();
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
