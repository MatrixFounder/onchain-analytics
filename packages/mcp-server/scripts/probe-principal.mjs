/**
 * OQ-D — live probe: does a principal reach a tool handler, and how is per-principal tool
 * visibility actually achievable on the installed SDK?
 *
 * **Why this exists as a script and not as a paragraph.** ADR-003 D1 asserts that a caller's
 * identity can be carried from the transport to a tool handler. That is a claim about a
 * third-party library, and a claim about a library nobody executed is an assumption wearing a
 * decision's clothes — so D1 stayed signed CONDITIONALLY until this ran (2026-08-01, SDK 1.29.0),
 * and OQ-D is closed by its output, not by reading the types. The SDK is a moving dependency:
 * **re-run this on every SDK bump.** Its verdicts are the evidence ADR-003 §"Проба принципала"
 * cites, and a bump that changes an answer changes that section too.
 *
 * **No network, no vendor calls, no credits.** `InMemoryTransport.send()` takes an `authInfo`
 * option that the SDK itself documents as "useful for testing authentication scenarios"; over
 * Streamable HTTP the same field is populated from `req.auth` by `requireBearerAuth`. The probe
 * therefore exercises the SAME seam the production path uses, one layer below the HTTP framing.
 *
 * Run: node packages/mcp-server/scripts/probe-principal.mjs
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { z } from 'zod';

const require = createRequire(import.meta.url);

/**
 * The SDK's export map points `./package.json` at `dist/cjs/package.json`, which carries only
 * `{"type":"commonjs"}` — reading it yields `undefined` for the version. Since the version IS the
 * evidence this probe produces, resolve a real module and walk up to the package root instead.
 */
function sdkVersion() {
  const marker = `${sep}@modelcontextprotocol${sep}sdk${sep}`;
  const entry = require.resolve('@modelcontextprotocol/sdk/server/mcp.js');
  const root = entry.slice(0, entry.indexOf(marker) + marker.length);
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}
const SDK_VERSION = sdkVersion();

const results = [];
const record = (id, question, verdict, detail) => results.push({ id, question, verdict, detail });

/**
 * A principal as `requireBearerAuth` would produce it: `verifyAccessToken` returns exactly this
 * shape, so a self-issued opaque token needs no OAuth server — just the one-method verifier.
 */
const PRINCIPAL = {
  token: 'probe-token-not-a-secret',
  clientId: 'probe-client',
  scopes: ['tool:onchain_ping', 'tool:onchain_get_token'],
  extra: { creditsBalance: 1000 },
};

/** Links a client to a server, injecting `authInfo` on every client→server message. */
async function connect(server, authInfo) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  if (authInfo) {
    const send = clientSide.send.bind(clientSide);
    clientSide.send = (message, options) => send(message, { ...options, authInfo });
  }
  const client = new Client({ name: 'probe', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

/** A server whose tool reports back whatever identity it can see. */
function serverThatEchoesPrincipal() {
  const server = new McpServer({ name: 'probe-server', version: '0.0.0' });
  server.registerTool(
    'whoami',
    { description: 'Echoes the principal the handler can see.', inputSchema: {} },
    async (_args, extra) => ({
      content: [{ type: 'text', text: JSON.stringify(extra?.authInfo ?? null) }],
    }),
  );
  return server;
}

// ── Q1. Does `authInfo` reach the registerTool callback (not just the low-level handler)? ─────────
{
  const client = await connect(serverThatEchoesPrincipal(), PRINCIPAL);
  const out = await client.callTool({ name: 'whoami', arguments: {} });
  const seen = JSON.parse(out.content[0].text);
  const ok = seen !== null && seen.clientId === PRINCIPAL.clientId;
  record(
    'Q1',
    'authInfo reaches the registerTool callback',
    ok ? 'YES' : 'NO',
    ok
      ? `handler saw clientId=${seen.clientId}, scopes=[${seen.scopes.join(', ')}], extra=${JSON.stringify(seen.extra)}`
      : `handler saw ${JSON.stringify(seen)}`,
  );
  await client.close();
}

// ── Q1b. Without auth, is it absent rather than stale? ───────────────────────────────────────────
{
  const client = await connect(serverThatEchoesPrincipal(), undefined);
  const out = await client.callTool({ name: 'whoami', arguments: {} });
  const seen = JSON.parse(out.content[0].text);
  record(
    'Q1b',
    'no auth ⇒ handler sees undefined, not a leaked previous principal',
    seen === null ? 'YES' : 'NO',
    `handler saw ${JSON.stringify(seen)}`,
  );
  await client.close();
}

// ── Q2. Can ONE shared McpServer serve two principals at all? ────────────────────────────────────
// The intended measurement was whether `RegisteredTool.disable()` (server-global state) leaks
// across principals. The instance never gets that far, and the reason it does not is the more
// important fact: this is the shape `mcp-server/src/index.ts` builds today — ONE server per
// process — and it is the shape a network server cannot keep.
{
  const server = new McpServer({ name: 'shared', version: '0.0.0' });
  server.registerTool('always', { description: 'a', inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }));
  server.registerTool('restricted', { description: 'b', inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }));

  const privileged = await connect(server, PRINCIPAL);
  let second = null;
  let refusal = null;
  try {
    second = await connect(server, undefined);
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }

  record(
    'Q2',
    'one shared McpServer accepts a second concurrent connection',
    refusal ? 'NO — refused outright' : 'YES',
    refusal
      ? `SDK: "${refusal.split('.')[0]}." Per-principal visibility is therefore not a question about ` +
          'enable()/disable() at all — a shared instance cannot carry two clients, so a network ' +
          'server needs one McpServer per session by construction.'
      : 'a second client connected to the same instance',
  );
  await privileged.close();
  if (second) await second.close();
}

// ── Q3. Does a per-session McpServer give a per-principal tools/list? ────────────────────────────
{
  const build = (scopes) => {
    const server = new McpServer({ name: 'per-session', version: '0.0.0' });
    server.registerTool('onchain_ping', { description: 'a', inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    if (scopes.includes('tool:onchain_get_token')) {
      server.registerTool('onchain_get_token', { description: 'b', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }));
    }
    return server;
  };

  const full = await connect(build(PRINCIPAL.scopes), PRINCIPAL);
  const thin = await connect(build(['tool:onchain_ping']), {
    ...PRINCIPAL,
    scopes: ['tool:onchain_ping'],
  });
  const fullNames = (await full.listTools()).tools.map((t) => t.name).sort();
  const thinNames = (await thin.listTools()).tools.map((t) => t.name).sort();
  const ok = fullNames.length === 2 && thinNames.length === 1;
  record(
    'Q3',
    'a per-session McpServer yields a per-principal tools/list',
    ok ? 'YES' : 'NO',
    `full-scope session sees [${fullNames.join(', ')}]; narrow-scope session sees [${thinNames.join(', ')}]`,
  );
  await Promise.all([full.close(), thin.close()]);
}

// ── Q4. Do `scopes` carry arbitrary strings, i.e. can they express a tool allowlist? ─────────────
{
  // One server instance per connection — Q2 established that this is not a style choice.
  const build = () => {
    const server = new McpServer({ name: 'scopes', version: '0.0.0' });
    server.registerTool(
      'gated',
      { description: 'c', inputSchema: { x: z.string().optional() } },
      async (_a, extra) => {
        const scopes = extra?.authInfo?.scopes ?? [];
        if (!scopes.includes('tool:gated')) {
          return { isError: true, content: [{ type: 'text', text: 'refused: scope missing' }] };
        }
        return { content: [{ type: 'text', text: 'allowed' }] };
      },
    );
    return server;
  };

  const denied = await connect(build(), PRINCIPAL); // scopes lack 'tool:gated'
  const deniedOut = await denied.callTool({ name: 'gated', arguments: {} });
  await denied.close();

  const allowedClient = await connect(build(), { ...PRINCIPAL, scopes: ['tool:gated'] });
  const allowedOut = await allowedClient.callTool({ name: 'gated', arguments: {} });
  await allowedClient.close();

  const ok = deniedOut.isError === true && allowedOut.content[0].text === 'allowed';
  record(
    'Q4',
    'scopes carry arbitrary strings ⇒ usable as a tool allowlist, enforced at call time',
    ok ? 'YES' : 'NO',
    `without the scope: ${deniedOut.content[0].text}; with it: ${allowedOut.content[0].text}`,
  );
}

// ── Report ───────────────────────────────────────────────────────────────────────────────────────
console.log(`\nOQ-D probe — @modelcontextprotocol/sdk ${SDK_VERSION}, no network, no credits\n`);
for (const r of results) {
  console.log(`${r.id}  ${r.verdict}`);
  console.log(`    q: ${r.question}`);
  console.log(`    → ${r.detail}\n`);
}
const undecided = results.filter((r) => r.verdict === 'NO' && r.id !== 'Q2');
console.log(
  undecided.length === 0
    ? 'All load-bearing answers obtained. ADR-003 D1 can drop its conditional status.'
    : `UNRESOLVED: ${undecided.map((r) => r.id).join(', ')} — ADR-003 D1 stays conditional.`,
);
