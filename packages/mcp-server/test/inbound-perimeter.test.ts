import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';
import { createServer } from '../src/server.js';
import {
  DEFAULT_MCP_PATH,
  normalizeHost,
  normalizeOrigin,
  perimeterRefusal,
  resolvePerimeter,
  startHttpTransport,
  type HttpTransportDeps,
  type RunningHttpTransport,
} from '../src/transport/http.js';
import { acceptsTestToken, bearerHeader } from './helpers/test-auth.js';

/**
 * Task 014-11 — the inbound perimeter (R-12, `security.md` §7.5.4).
 *
 * Two checks guard one perimeter: ours, which normalizes, and the SDK transport's, which compares
 * exactly. Both are exercised — ours through the helpers, both together through a live listener.
 */

let running: RunningHttpTransport | null = null;
/** How many session servers were BUILT — the observable that says where the check runs. */
let sessionServersBuilt = 0;

async function listen(options: Partial<HttpTransportDeps> = {}): Promise<RunningHttpTransport> {
  sessionServersBuilt = 0;
  running = await startHttpTransport({
    createSessionServer: () => {
      sessionServersBuilt += 1;
      return createServer({ env: loadEnv({}), version: '0.0.0-test' });
    },
    authenticate: acceptsTestToken(),
    bind: '127.0.0.1',
    port: 0,
    ...options,
  });
  return running;
}

afterEach(async () => {
  await running?.close();
  running = null;
});

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'perimeter', version: '1.0.0' },
  },
};

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/**
 * A POST over `node:http`, NOT over `fetch`.
 *
 * **Measured the hard way:** `Host` is a forbidden header name in fetch, so undici silently drops an
 * attempt to set it and sends the URL's own authority instead. The first version of this file used
 * `fetch` and therefore tested nothing about `Host` — two assertions failed because the header never
 * left, and one PASSED for the same reason, which is the worse half. `node:http` sends what it is
 * given.
 */
function post(
  transport: RunningHttpTransport,
  headers: Record<string, string>,
): Promise<RawResponse> {
  const payload = JSON.stringify(initialize);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: transport.address.port,
        path: DEFAULT_MCP_PATH,
        method: 'POST',
        // `setHost: false` stops Node adding its own `Host` beside ours.
        setHost: false,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(payload),
          // A valid bearer by default: these tests are about the PERIMETER, which runs ahead of the
          // token check, and a request refused at step 2 would hide whether step 1 refused it first.
          ...bearerHeader(),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

describe('AC-23: a foreign Host or Origin is refused before any tool', () => {
  it('TC-E2E-01: a Host outside the list is refused with the SDK’s own shape', async () => {
    const transport = await listen({ allowedHosts: ['onchain.internal:8848'] });
    const response = await post(transport, { host: 'evil.example:8848' });

    expect(response.status).toBe(403);
    const body = JSON.parse(response.body) as { jsonrpc: string; error: { code: number } };
    // The same form the SDK's own refusal uses, so a client parses one shape.
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32000);
    // No session was built for it, so nothing downstream of the perimeter ran.
    expect(transport.sessionCount()).toBe(0);
  });

  it('TC-E2E-02: an Origin outside the list is refused at the same place', async () => {
    const transport = await listen({
      allowedHosts: ['onchain.internal:8848'],
      allowedOrigins: ['https://n8n.internal'],
    });
    const response = await post(transport, {
      host: 'onchain.internal:8848',
      origin: 'https://attacker.example',
    });
    expect(response.status).toBe(403);
    expect(transport.sessionCount()).toBe(0);
  });

  it('admits the configured Host and Origin', async () => {
    const transport = await listen({
      allowedHosts: ['onchain.internal:8848'],
      allowedOrigins: ['https://n8n.internal'],
    });
    const response = await post(transport, {
      host: 'onchain.internal:8848',
      origin: 'https://n8n.internal',
    });
    expect(response.status).toBe(200);
  });

  it('admits a request with NO Origin — the only client T-014 has sends none', async () => {
    const transport = await listen({
      allowedHosts: ['onchain.internal:8848'],
      allowedOrigins: ['https://n8n.internal'],
    });
    const response = await post(transport, { host: 'onchain.internal:8848' });
    expect(response.status).toBe(200);
  });
});

describe('the check runs BEFORE anything downstream of it', () => {
  it('builds no session server for a request from outside the perimeter', () => {
    // `sessionCount()` alone does not say this: a server built for a refused request never
    // initializes a session, so the map stays empty either way. What separates "checked first" from
    // "checked eventually" is whether the pair was CONSTRUCTED at all — and task 014-12's step order
    // rests on the same observable, one step further: a request outside the perimeter must not cause
    // a read of the token store.
    return listen({ allowedHosts: ['onchain.internal:8848'] }).then(async (transport) => {
      const response = await post(transport, { host: 'evil.example:8848' });
      expect(response.status).toBe(403);
      expect(sessionServersBuilt, 'a refused request built a session server').toBe(0);

      const admitted = await post(transport, { host: 'onchain.internal:8848' });
      expect(admitted.status).toBe(200);
      // Not vacuous: the counter does move when a request is admitted.
      expect(sessionServersBuilt).toBe(1);
    });
  });
});

describe('an EMPTY list admits nothing, and is not the same as an unset one', () => {
  it('refuses every host when the list is explicitly empty', () => {
    // The shape this project has now paid for three times: a legal empty value read as "no
    // restriction". An unset list defaults to the bound address (below); an empty one is a
    // perimeter that admits nobody, and saying so is the difference between fail-closed and
    // fail-open on the outermost check the process has.
    const perimeter = { hosts: [], origins: [], boundPort: 8848 };
    expect(perimeterRefusal({ host: 'onchain.internal:8848' }, perimeter)).toBe('Host');
    expect(perimeterRefusal({ host: '127.0.0.1:8848' }, perimeter)).toBe('Host');
    expect(perimeterRefusal({}, perimeter)).toBe('Host');
  });

  it('refuses every browser origin when the origin list is empty — the default (R-12.2)', () => {
    const perimeter = { hosts: ['onchain.internal:8848'], origins: [], boundPort: 8848 };
    expect(
      perimeterRefusal(
        { host: 'onchain.internal:8848', origin: 'https://n8n.internal' },
        perimeter,
      ),
    ).toBe('Origin');
    // And an absent Origin still passes: the engine's clients are servers.
    expect(perimeterRefusal({ host: 'onchain.internal:8848' }, perimeter)).toBeNull();
  });

  it('an UNSET list is the bound address, not an empty one', () => {
    const perimeter = resolvePerimeter(
      {
        createSessionServer: () => createServer({ env: loadEnv({}), version: 'x' }),
        authenticate: acceptsTestToken(),
        bind: '127.0.0.1',
        port: 0,
      },
      8848,
    );
    expect(perimeter.hosts).toStrictEqual(['127.0.0.1:8848']);
    expect(perimeter.origins).toStrictEqual([]);
  });
});

describe('AC-34: the default is the bound address, with no wildcard', () => {
  it('refuses a Host that is not the one bound, when nothing is configured', async () => {
    const transport = await listen();
    expect(transport.perimeter.hosts).toStrictEqual([
      `127.0.0.1:${String(transport.address.port)}`,
    ]);
    // A non-loopback name reaching an unconfigured server is refused: the default is the address
    // this process bound, and nothing else.
    expect((await post(transport, { host: 'onchain.internal' })).status).toBe(403);
    expect((await post(transport, { host: '0.0.0.0:1' })).status).toBe(403);
  });

  it('admits the loopback address it bound', async () => {
    const transport = await listen();
    const response = await post(transport, { host: `127.0.0.1:${String(transport.address.port)}` });
    expect(response.status).toBe(200);
  });
});

describe('AC-35: CORS is denied by being absent', () => {
  it('emits no Access-Control-Allow-Origin, admitted or refused', async () => {
    const transport = await listen({
      allowedHosts: ['onchain.internal:8848'],
      allowedOrigins: ['https://n8n.internal'],
    });
    const admitted = await post(transport, {
      host: 'onchain.internal:8848',
      origin: 'https://n8n.internal',
    });
    const refused = await post(transport, {
      host: 'onchain.internal:8848',
      origin: 'https://attacker.example',
    });
    // Denied by absence: no CORS header is produced anywhere in the SDK's server tree, and this
    // transport adds no middleware that would. An allowed Origin is not a granted one.
    for (const response of [admitted, refused]) {
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });
});

describe('AC-37: the SDK’s own protection is set on the transport', () => {
  it('hands the normalized list to both readers', async () => {
    const transport = await listen({ allowedHosts: ['ONCHAIN.internal'] });
    // One value, two readers. The list handed to the SDK is the normalized one, so the two can
    // disagree only in the fail-closed direction.
    expect(transport.perimeter.hosts).toStrictEqual([
      `onchain.internal:${String(transport.address.port)}`,
    ]);
  });

  it('sets enableDnsRebindingProtection where the transport is constructed', async () => {
    // Read from the source: the option is a constructor argument, and nothing on the built object
    // exposes it. What must stay true is that it is passed at all — R-12.3 requires the option, and
    // measurement 1 of §7.5.4 says a future SDK may drop it, which is why our own check exists too.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/transport/http.ts'),
      'utf8',
    );
    expect(source).toContain('enableDnsRebindingProtection: true');
  });
});

describe('normalization — the reason our check exists at all', () => {
  it('lowercases both sides and fills a missing port from the BOUND one', () => {
    expect(normalizeHost('ONCHAIN.Internal', 8848)).toBe('onchain.internal:8848');
    expect(normalizeHost('onchain.internal:8848', 8848)).toBe('onchain.internal:8848');
    // The symmetry is what makes a reverse proxy work: the operator configures the name the proxy
    // sends, and both sides gain the same port.
    expect(normalizeHost('onchain.internal', 8848)).toBe(normalizeHost('ONCHAIN.INTERNAL', 8848));
    // A stated port is kept, so a mismatch stays a mismatch.
    expect(normalizeHost('onchain.internal:9999', 8848)).toBe('onchain.internal:9999');
    // An IPv6 literal carries its own colons and is not mistaken for a port.
    expect(normalizeHost('[::1]', 8848)).toBe('[::1]:8848');
    expect(normalizeHost('[::1]:8848', 8848)).toBe('[::1]:8848');
  });

  it('normalizes an origin without inventing a port for it', () => {
    expect(normalizeOrigin('HTTPS://N8N.Internal/')).toBe('https://n8n.internal');
    expect(normalizeOrigin('https://n8n.internal:8443')).toBe('https://n8n.internal:8443');
  });

  it('measures the request against the PROCESS’s port, never the request’s own', () => {
    // The defect this shape prevents: filling the port in from the incoming header would make every
    // value match itself, and the check would admit everything while looking correct.
    const perimeter = resolvePerimeter(
      {
        createSessionServer: () => createServer({ env: loadEnv({}), version: 'x' }),
        authenticate: acceptsTestToken(),
        bind: '',
        port: 0,
        allowedHosts: ['onchain.internal'],
      },
      8848,
    );
    expect(perimeter.boundPort).toBe(8848);
    expect(perimeterRefusal({ host: 'onchain.internal' }, perimeter)).toBeNull();
    expect(perimeterRefusal({ host: 'onchain.internal:9999' }, perimeter)).toBe('Host');
    // A missing Host is a refusal, not a pass: the header is required and its absence is not "any".
    expect(perimeterRefusal({}, perimeter)).toBe('Host');
  });
});
