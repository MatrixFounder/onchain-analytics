// Dependency-free smoke test for the SHIPPED build artifact (`dist/index.js`) — the one thing
// that actually reaches consumers/production. task 001-5 (adversarial cycle 2, F-3): the stdio
// E2E suite (test/e2e.stdio.test.ts) always spawns `src/index.ts` via tsx (ARCHITECTURE §10.2:
// `test` runs before `build` in CI, so `dist/` may not exist yet during that suite) — it never
// executes `dist/index.js`. Nothing in the automated gate exercised the actual bin before this
// script; it closes that gap as a CI step run immediately AFTER `pnpm build`.
//
// Deliberately does NOT import `@modelcontextprotocol/sdk`: it speaks the wire protocol directly
// (newline-delimited JSON-RPC over stdio — verified against the installed SDK's own
// `shared/stdio.js` framing: `JSON.stringify(message) + '\n'`, no other envelope). That keeps
// this script dependency-free, matching its own `scripts/` home (never bundled, never shipped,
// no package.json `dependencies` entry to maintain here).
//
// Sequence: initialize -> notifications/initialized -> tools/list -> tools/call onchain_ping.
// Asserts (a) tools/list returns exactly one tool, onchain_ping; (b) the call's
// structuredContent.version matches package.json's version (read here, never hardcoded); (c)
// every line the child writes to stdout parses as JSON (a non-JSON line would mean something
// other than MCP protocol touched stdout, ARCHITECTURE §7.3 — the same invariant the stdio E2E
// suite checks for the tsx-run server, now checked for the built one too). Exits 0 on success, 1
// with a clear stderr message otherwise. Bounded by an overall timeout that SIGKILLs a hung child
// rather than hanging CI.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..');
const distEntry = path.resolve(packageRoot, 'dist', 'index.js');
const packageJsonPath = path.resolve(packageRoot, 'package.json');

const OVERALL_TIMEOUT_MS = 10_000;
const PROTOCOL_VERSION = '2025-11-25';

function fail(message) {
  console.error(`smoke-dist: FAIL: ${message}`);
  process.exitCode = 1;
}

if (!existsSync(distEntry)) {
  fail(`dist entry not found at ${distEntry} — run \`pnpm build\` first.`);
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

const child = spawn(process.execPath, [distEntry], {
  cwd: packageRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdoutTail = '';
let stderrTail = '';
let settled = false;
const pending = new Map(); // JSON-RPC id -> { resolve, reject }
let nextId = 1;

const overallTimer = setTimeout(() => {
  finish(
    1,
    `timed out after ${OVERALL_TIMEOUT_MS}ms (child stderr so far: ${stderrTail || '(empty)'})`,
  );
}, OVERALL_TIMEOUT_MS);

function finish(exitCode, message) {
  if (settled) {
    return;
  }
  settled = true;
  clearTimeout(overallTimer);
  if (exitCode === 0) {
    console.log(`smoke-dist: PASS: ${message}`);
  } else {
    console.error(`smoke-dist: FAIL: ${message}`);
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already dead — nothing to do
  }
  process.exitCode = exitCode;
}

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function sendRequest(method, params) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function sendNotification(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

child.stdout.on('data', (chunk) => {
  stdoutTail += chunk.toString('utf8');
  let newlineIndex;
  // Buffered-line loop, mirrors the SDK's own ReadBuffer.readMessage() (shared/stdio.js): drain
  // every complete line in this chunk.
  while ((newlineIndex = stdoutTail.indexOf('\n')) !== -1) {
    const line = stdoutTail.slice(0, newlineIndex).replace(/\r$/, '');
    stdoutTail = stdoutTail.slice(newlineIndex + 1);
    if (line.length === 0) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      finish(
        1,
        `stdout produced a non-JSON line (protocol violation, §7.3): ${JSON.stringify(line)}`,
      );
      return;
    }
    if (typeof message.id !== 'undefined' && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        reject(new Error(`JSON-RPC error for id ${message.id}: ${JSON.stringify(message.error)}`));
      } else {
        resolve(message.result);
      }
    }
    // Notifications (no `id`) from the server are ignored — this smoke test needs none of them.
  }
});

child.stderr.on('data', (chunk) => {
  stderrTail += chunk.toString('utf8');
});

child.on('error', (error) => {
  finish(1, `failed to spawn child process: ${error.message}`);
});

child.on('exit', (code, signal) => {
  if (!settled) {
    finish(
      1,
      `child exited before the smoke sequence completed (code=${code}, signal=${signal}); stderr: ${stderrTail || '(empty)'}`,
    );
  }
});

async function run() {
  const initResult = await sendRequest('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'onchain-intel-smoke-dist', version: '0.0.0-smoke' },
  });
  if (!initResult || typeof initResult.protocolVersion !== 'string') {
    throw new Error(`initialize did not return a protocolVersion: ${JSON.stringify(initResult)}`);
  }

  sendNotification('notifications/initialized', {});

  const listResult = await sendRequest('tools/list', {});
  const tools = listResult && listResult.tools;
  if (
    !Array.isArray(tools) ||
    tools.length !== 1 ||
    !tools[0] ||
    tools[0].name !== 'onchain_ping'
  ) {
    throw new Error(`tools/list did not return exactly [onchain_ping]: ${JSON.stringify(tools)}`);
  }

  const callResult = await sendRequest('tools/call', { name: 'onchain_ping', arguments: {} });
  const structuredContent = callResult && callResult.structuredContent;
  if (!structuredContent || structuredContent.version !== packageJson.version) {
    throw new Error(
      `structuredContent.version (${structuredContent && structuredContent.version}) !== ` +
        `package.json version (${packageJson.version}): ${JSON.stringify(callResult)}`,
    );
  }
  if (structuredContent.ok !== true || structuredContent.service !== 'onchain-intel-mcp-server') {
    throw new Error(`unexpected structuredContent shape: ${JSON.stringify(structuredContent)}`);
  }

  finish(0, `onchain_ping OK over dist/index.js (version ${packageJson.version})`);
}

run().catch((error) => {
  finish(
    1,
    `${error instanceof Error ? error.message : String(error)} (child stderr: ${stderrTail || '(empty)'})`,
  );
});
