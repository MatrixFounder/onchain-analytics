import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadEnv } from '../src/env.js';
import { createServer } from '../src/server.js';
import {
  DEFAULT_MCP_PATH,
  startHttpTransport,
  type RunningHttpTransport,
} from '../src/transport/http.js';
import { acceptsTestToken, bearerHeader } from './helpers/test-auth.js';

/**
 * Task 014-09 — the second transport answers what the first one answers (AC-1).
 *
 * **Binding a loopback port inside `pnpm test` is inside R-21, not an exception to it.** The
 * invariant forbids a call that LEAVES the machine; a listener on 127.0.0.1 reaches no vendor,
 * spends no credit and reads no secret. `deployment.md` §10.2.1 item 3 states the same.
 *
 * **Since task 014-12 these run on the AUTHENTICATED path.** They described a token-free path when
 * 014-09 shipped one; making `authenticate` a required dependency of the transport is what turned
 * "re-assert AC-1 with a token" from an obligation somebody remembers into a compile error at every
 * call site that had none.
 */

let running: RunningHttpTransport;

const buildServer = (): ReturnType<typeof createServer> =>
  createServer({ env: loadEnv({}), version: '0.0.0-test' });

beforeEach(async () => {
  running = await startHttpTransport({
    createSessionServer: buildServer,
    authenticate: acceptsTestToken(),
    bind: '127.0.0.1',
    // Port 0: the OS picks a free one. A fixed port makes the suite fail on a developer's machine
    // for a reason that has nothing to do with the code.
    port: 0,
  });
});

afterEach(async () => {
  await running.close();
});

const endpoint = (): URL =>
  new URL(`http://127.0.0.1:${String(running.address.port)}${DEFAULT_MCP_PATH}`);

async function overHttp<T>(use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'e2e-http', version: '1.0.0' });
  // Task 014-12's obligation, discharged mechanically: AC-1 is re-asserted on the path that now
  // exists — the authenticated one — rather than on the token-free path task 014-09 shipped.
  const transport = new StreamableHTTPClientTransport(endpoint(), {
    requestInit: { headers: bearerHeader() },
  });
  await client.connect(transport);
  try {
    return await use(client);
  } finally {
    await client.close();
  }
}

/**
 * A JSON round-trip, applied to the IN-PROCESS answer before comparing it with the wire one.
 *
 * **Why it is needed, and why it is not a weakening of AC-1.** `InMemoryTransport` hands the result
 * object to the client BY REFERENCE — nothing is serialized. Every serializing transport, stdio
 * included, sends the same value through `JSON.stringify`, which DROPS keys whose value is
 * `undefined`. Measured here: the SDK's `registerTool` publishes `_meta: undefined` and
 * `annotations: undefined` on every tool, so the in-memory listing carries two keys the wire listing
 * cannot.
 *
 * AC-1 compares HTTP with STDIO, and stdio serializes exactly as HTTP does — so the round-trip makes
 * the in-process answer stand in for stdio faithfully instead of holding HTTP to a shape no wire
 * client ever receives.
 *
 * **The finding is worth stating on its own:** `e2e.inprocess.test.ts` can pass on a value no wire
 * client would see. Anything asserted only there is asserted about a transport this server does not
 * ship.
 */
const asWire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** `onchain_ping`'s reading of the clock, from the structured half of its answer. */
const clockOf = (result: unknown): number =>
  (result as { structuredContent?: { ts?: number } }).structuredContent?.ts ?? 0;

/**
 * The same answer with the clock replaced by a constant, in BOTH halves.
 *
 * The text half is the JSON of the structured half, so a substitution applied to one and not the
 * other would compare a doctored object against an undoctored string and pass on nothing.
 */
const withoutClock = (result: unknown): unknown =>
  JSON.parse(
    // The optional backslashes are not decoration: the text half is the JSON of the structured half,
    // so once the whole result is stringified its key appears as `\"ts\":` while the structured
    // one appears as `"ts":`. A pattern that matched only the second would doctor one half, leave
    // the other, and compare them against each other — passing on nothing.
    JSON.stringify(result).replace(/(\\?"ts\\?":)\d+/g, (_match, key: string) => `${key}0`),
  ) as unknown;

async function overInMemory<T>(use: (client: Client) => Promise<T>): Promise<T> {
  const server = buildServer();
  const client = new Client({ name: 'e2e-inprocess', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await use(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('TC-E2E-01: the same call answers the same over both transports (AC-1)', () => {
  it('agrees on onchain_ping, field for field except the clock', async () => {
    const overWire = await overHttp((client) =>
      client.callTool({ name: 'onchain_ping', arguments: {} }),
    );
    const inProcess = await overInMemory((client) =>
      client.callTool({ name: 'onchain_ping', arguments: {} }),
    );

    // `ts` is the one field that is NOT a function of the arguments — the two calls are milliseconds
    // apart, and AC-1 is about the answer to the same question, not about the instant it was asked.
    // Pinned rather than dropped: both answers must still carry a plausible epoch-ms reading, so a
    // transport that lost the field entirely fails here instead of being normalized past.
    expect(clockOf(overWire)).toBeGreaterThan(1_700_000_000_000);
    expect(clockOf(inProcess)).toBeGreaterThan(1_700_000_000_000);
    expect(withoutClock(overWire)).toStrictEqual(withoutClock(asWire(inProcess)));
  });

  it('agrees on onchain_list_chains, which returns a body rather than a word', async () => {
    // `ping` would agree even if the transport dropped most of a result. This tool answers with a
    // structured payload, so the comparison is over something with shape.
    const overWire = await overHttp((client) =>
      client.callTool({ name: 'onchain_list_chains', arguments: {} }),
    );
    const inProcess = await overInMemory((client) =>
      client.callTool({ name: 'onchain_list_chains', arguments: {} }),
    );
    expect(overWire).toStrictEqual(asWire(inProcess));
  });

  it('serves the same inventory over the wire as in process', async () => {
    const overWire = await overHttp(async (client) => (await client.listTools()).tools);
    const inProcess = await overInMemory(async (client) => (await client.listTools()).tools);
    expect(overWire).toStrictEqual(asWire(inProcess));

    // And the difference the round-trip removes is exactly the one claimed above — keys whose value
    // is `undefined`, never a key with a value. Asserted rather than assumed, because a round-trip
    // applied without checking what it hides is how a real divergence gets normalized away.
    const hidden = inProcess.flatMap((tool) =>
      Object.entries(tool)
        .filter(([, value]) => value === undefined)
        .map(([key]) => key),
    );
    expect([...new Set(hidden)].sort()).toStrictEqual(['_meta', 'annotations']);
    expect(overWire.every((tool) => !('_meta' in tool) && !('annotations' in tool))).toBe(true);
  });
});

describe('the listener serves one path and describes nothing else', () => {
  it('answers 404 on any other path, with no body', async () => {
    const response = await fetch(new URL(`http://127.0.0.1:${String(running.address.port)}/`));
    expect(response.status).toBe(404);
    // An unauthenticated caller learns the shape of the surface from a helpful 404.
    expect(await response.text()).toBe('');
  });

  it('binds the address it was given, and reports the port it actually got', () => {
    expect(running.address.host).toBe('127.0.0.1');
    expect(running.address.port).toBeGreaterThan(0);
  });
});

describe('TC-UNIT-01: the stdio path raises no listener', () => {
  it('index.ts binds only on the http axis', async () => {
    // Read rather than run: starting `index.ts` here would attach a real stdio transport to this
    // process. What the assertion needs is the STRUCTURE — that the stdio branch returns before
    // anything binds — and that is visible in the source.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts'),
      'utf8',
    );
    const stdioBranch = source.indexOf("profile.transport === 'stdio'");
    const bind = source.indexOf('startHttpTransport(');
    expect(stdioBranch).toBeGreaterThan(0);
    expect(bind).toBeGreaterThan(stdioBranch);
    // And the stdio branch leaves `main` before reaching it.
    expect(source.slice(stdioBranch, bind)).toContain('return;');
  });
});
