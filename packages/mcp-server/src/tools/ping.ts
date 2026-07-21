import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Input contract for `onchain_ping`. The tool takes no parameters — the empty, `.strict()`
 * schema exists explicitly anyway so there is a single source of truth even for an "empty"
 * contract (ARCHITECTURE.md §4.1, R-10).
 */
export const PingInputSchema = z.object({}).strict();
export type PingInput = z.infer<typeof PingInputSchema>;

/**
 * Output contract for `onchain_ping` (ARCHITECTURE.md §4.1):
 * - `ok`      — literal `true` (deterministic success, R-10).
 * - `service` — literal service name, identifies the responding server.
 * - `version` — the running package version (never hardcoded — threaded in via `ctx`).
 * - `ts`      — epoch-ms UTC (`Date.now()`), consistent with the DB-SCHEMA-CONCEPT §1.2 time
 *   convention, even though M0 persists nothing.
 */
export const PingOutputSchema = z.object({
  ok: z.literal(true),
  service: z.literal('onchain-intel-mcp-server'),
  version: z.string(),
  ts: z.number().int(),
});
export type PingOutput = z.infer<typeof PingOutputSchema>;

/** Context threaded explicitly into the handler — no hardcoded version literals (reviewer note 1). */
export interface PingContext {
  version: string;
}

/**
 * Pure handler for `onchain_ping`. Deliberately separated from `registerPingTool` (SDK wiring):
 * this function is pure and unit testable without standing up a transport (ARCHITECTURE.md
 * §5.2). The return value is routed through `PingOutputSchema.parse` — the same schema instance
 * used to build the MCP tool's output schema — so runtime validation and the protocol contract
 * can never drift apart.
 */
export function pingHandler(_input: PingInput, ctx: PingContext): PingOutput {
  return PingOutputSchema.parse({
    ok: true,
    service: 'onchain-intel-mcp-server',
    version: ctx.version,
    ts: Date.now(),
  });
}

/**
 * Registers the `onchain_ping` tool — exactly this name (R-10) — on `server`. `PingInputSchema`
 * / `PingOutputSchema` are passed straight through as `inputSchema` / `outputSchema`: the SDK's
 * `registerTool` accepts a full zod schema (not just a raw shape) as of the installed
 * `@modelcontextprotocol/sdk` version, so there is exactly one schema object driving both
 * runtime validation and the generated MCP tool-schema (no hand-written JSON-Schema duplicate).
 */
export function registerPingTool(server: McpServer, ctx: PingContext): void {
  server.registerTool(
    'onchain_ping',
    {
      description: 'Deterministic liveness check for the onchain-intel MCP server.',
      inputSchema: PingInputSchema,
      outputSchema: PingOutputSchema,
    },
    (input) => {
      const output = pingHandler(input, ctx);
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}
