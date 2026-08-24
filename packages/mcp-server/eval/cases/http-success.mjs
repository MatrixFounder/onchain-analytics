// Transport case — one end-to-end call over Streamable HTTP (task 014-33, UC-1).
//
// The two refusal cases prove the guards say no. This is the one that proves they can say YES: a
// valid token, an accepted perimeter, an MCP session, and a tool answering. Without it a perimeter
// that refuses everything would pass the other two.
export default {
  kind: 'transport',
  transport: 'http',
  catches:
    'the session layer failing to initialize over HTTP, a tool answering on stdio but not over ' +
    'the network transport, and the perimeter refusing the very clients it is configured to admit',
  exercise: async ({ openSession }) => {
    const session = await openSession();
    try {
      const ping = await session.callTool('onchain_ping', {});
      return {
        initialized: session.initialized,
        sessionId: typeof session.id === 'string' && session.id.length > 0,
        isError: ping.result?.isError ?? null,
        structured: ping.result?.structuredContent ?? null,
        rpcError: ping.error?.message ?? null,
      };
    } finally {
      await session.close();
    }
  },
  check: (o) => {
    const problems = [];
    if (o?.initialized !== true) problems.push('the MCP session did not initialize over HTTP');
    // A session id is what makes the transport stateful; without one the second request of a
    // session would open a third session and the shared-limiter case below would measure nothing.
    if (o?.sessionId !== true) problems.push('the transport returned no session id');
    if (o?.rpcError) problems.push(`JSON-RPC error on the call: ${o.rpcError}`);
    if (o?.isError === true) problems.push('the tool answered isError over HTTP');
    if (o?.structured === null || typeof o?.structured !== 'object') {
      problems.push('no structuredContent — the tool answered nothing a caller can read');
    }
    return problems;
  },
};
