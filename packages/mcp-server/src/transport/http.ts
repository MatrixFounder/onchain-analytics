import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
 * **What this task does NOT do, and the running server is unsafe until it does.** No token is
 * checked (task 014-12), no perimeter is configured (014-11) and no session outlives one request
 * (014-10). `SHIPPED_TRANSPORTS` gains `'http'` here because the transport now exists, and the
 * network profile still refuses to start until 014-12's precondition is in place — the listener
 * below accepts whatever reaches it.
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
  close(): Promise<void>;
}

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

  const listener = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, path, deps);
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
        // Node keeps a `close()` pending while a keep-alive socket is idle; the client's own close
        // is not something this process can wait for.
        listener.closeIdleConnections();
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: HttpTransportDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://placeholder');
  if (url.pathname !== path) {
    // A path this transport does not serve is a 404 and nothing else — no body describing what the
    // process does serve. An unauthenticated caller learns the shape of the surface from that.
    res.writeHead(404).end();
    return;
  }

  const server = deps.createSessionServer();
  const transport = new StreamableHTTPServerTransport({
    // Stateless: no session id is minted and none is validated. Task 014-10 replaces this with a
    // generator and the map that goes with it.
    sessionIdGenerator: undefined,
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    // The SDK answers most protocol errors itself; this covers the rest. The message is not
    // rendered to the client — an error text from inside the process is an operator detail (R-20).
    console.error(
      `onchain-intel-mcp-server: http transport: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (!res.headersSent) res.writeHead(500).end();
  }
}
