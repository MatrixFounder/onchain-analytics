// Transport case — two HTTP sessions work concurrently against one vendor (task 014-33, UC-2, R-7).
//
// **What this case asserts, and what it deliberately does NOT.**
//
// It asserts that two independent MCP sessions over Streamable HTTP each get their own session id
// and that every call both of them make is SERVED — no refusal, no error, no cross-session
// interference. That is the half of UC-2 observable from outside the process.
//
// It does NOT assert the aggregate RATE against the declared bucket, and the reason is a
// measurement rather than an omission. `defillama` carries `{capacity: 10, refillPerSec: 5}`
// (`providers.config.ts`), so the bucket only bites after ten calls — and the calls have to be ten
// DISTINCT ones, because the cache answers a repeat without ever reaching the limiter. The eval
// curates twelve chains in total, which is not enough to fill one arm of a comparison, let alone
// two. Measured 2026-08-24: an earlier version of this case compared six calls on one session
// against six split across two and reported "9ms versus 312ms" — the second arm was reading the
// cache the first arm had filled, and the case would have reported that as a broken limiter.
//
// The rate property is real and worth measuring; it needs an arg axis wider than the probe set, and
// that is filed as WI-63 rather than approximated here. A case that asserts a threshold it cannot
// resolve is worse than one that states its limit.
//
// The calls go to a free, keyless capability. The gate spends no Nansen credits.
const CHAINS_A = ['ethereum', 'base', 'arbitrum'];
const CHAINS_B = ['polygon', 'bsc', 'avalanche'];
const TOOL = 'onchain_chain_tvl';

export default {
  kind: 'transport',
  transport: 'http',
  catches:
    'a second concurrent session being refused, two sessions colliding on one session id, and a ' +
    'vendor call that succeeds on a lone session and fails when another session is active — the ' +
    'shapes that make a multi-client deployment fail in a way no single-session test reaches',
  exercise: async ({ openSession }) => {
    const a = await openSession();
    const b = await openSession();
    try {
      const started = Date.now();
      // Interleaved on purpose: both sessions have calls in flight at the same moment, which is the
      // state a per-session limiter and a shared one disagree about.
      const answers = await Promise.all([
        ...CHAINS_A.map((chain) => a.callTool(TOOL, { chain })),
        ...CHAINS_B.map((chain) => b.callTool(TOOL, { chain })),
      ]);
      return {
        sessionA: a.id,
        sessionB: b.id,
        calls: answers.length,
        elapsedMs: Date.now() - started,
        rpcErrors: answers.filter((x) => x.error).map((x) => x.error.message),
        toolErrors: answers.filter((x) => x.result?.isError).length,
        answered: answers.filter((x) => x.result?.structuredContent).length,
      };
    } finally {
      await a.close();
      await b.close();
    }
  },
  check: (o) => {
    const problems = [];
    const expected = CHAINS_A.length + CHAINS_B.length;
    if (typeof o?.sessionA !== 'string' || typeof o?.sessionB !== 'string') {
      problems.push('one of the two sessions has no session id');
    } else if (o.sessionA === o.sessionB) {
      // Two clients sharing one session id would share a principal and a transcript. It is also how
      // the case above would silently measure one session twice.
      problems.push(`both sessions were given the same id ${o.sessionA}`);
    }
    for (const message of o?.rpcErrors ?? [])
      problems.push(`JSON-RPC error under concurrency: ${message}`);
    if (o?.toolErrors > 0) problems.push(`${o.toolErrors} of ${expected} calls answered isError`);
    if (o?.answered !== expected) {
      problems.push(
        `${String(o?.answered)} of ${expected} concurrent calls returned structuredContent`,
      );
    }
    return problems;
  },
};
