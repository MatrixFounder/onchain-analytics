import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from './env.js';
import { registerPingTool } from './tools/ping.js';

/**
 * Dependencies passed explicitly into the server factory (reviewer note 1: version is never
 * hardcoded — it is threaded through from `index.ts`, which reads it once from `package.json`).
 * `env` is accepted (not just `version`) per ARCHITECTURE.md §5.2's factory signature, even
 * though no M0 tool currently reads it — future `src/tools/*.ts` (M1+, provider adapters) will.
 */
export interface CreateServerDeps {
  env: Env;
  version: string;
}

/**
 * Transport-agnostic `McpServer` factory (D3): builds the server and registers every tool, but
 * never creates or attaches a transport — `index.ts` is the only place that decides stdio vs. a
 * future (M6) alternative HTTP-based transport, so this factory can be reused unchanged either way.
 */
export function createServer(deps: CreateServerDeps): McpServer {
  const server = new McpServer({ name: 'onchain-intel-mcp-server', version: deps.version });
  registerPingTool(server, { version: deps.version });
  return server;
}
