// Transport case — a retry under one `client_request_id` is served once and charged once
// (task 015-29, AC-28b, R-13.3, UC-2 step 3).
//
// WHY BOTH TABLES ARE READ. One ledger row on its own does not say the retry was SERVED — it says
// as much about a second call that was refused outright. UC-2 requires the opposite: the repeat is
// answered, and only the CHARGE is suppressed. So the claim is a pair: exactly one `client_usage`
// row under the id, and two `request_trace` rows.
//
// WHY THE PHASE SETS `ONCHAIN_META_NAMESPACE`. Without it the server accepts no client-supplied id
// at all and mints a server-side one per call (`src/server.ts`), so both calls would get distinct
// ids and the case would be measuring two independent requests while reporting on a retry — green,
// and about nothing.
//
// The calls go to a free, keyless capability. The gate spends no Nansen credits.

import { httpStore, readClientUsage, readRequestTrace } from './shared/ledger-reader.mjs';

const TOOL = 'onchain_chain_tvl';
const CHAIN = 'optimism';
// The suffix is fixed (`src/tools/request-trace-row.ts`); only the namespace is configurable, and
// the phase declares it. Kept in step with `HTTP_META_NAMESPACE` in `eval/run.mjs`.
const META_KEY = 'eval.onchain-intel.invalid/client-request-id';

export default {
  kind: 'transport',
  transport: 'http',
  catches:
    'a retry charged twice, a retry refused instead of served, and a client-supplied request id ' +
    'silently ignored so that two calls look like two independent requests',
  exercise: async (ctx) => {
    const session = await ctx.openSession();
    const requestId = `eval-retry-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      // Third argument, not part of `arguments`: `_meta` belongs to `params`, and a `.strict()`
      // input schema would reject it as an unknown tool parameter.
      const meta = { [META_KEY]: requestId };
      const first = await session.callTool(TOOL, { chain: CHAIN }, meta);
      const second = await session.callTool(TOOL, { chain: CHAIN }, meta);

      const store = httpStore(ctx);
      const usage = await readClientUsage(store.storage, store.location);
      const trace = await readRequestTrace(store.storage, store.location);

      return {
        requestId,
        firstServed: !first.error,
        secondServed: !second.error,
        ledgerRows: usage.filter((x) => x.client_request_id === requestId),
        traceRows: trace.filter((x) => x.client_request_id === requestId),
      };
    } finally {
      await session.close();
    }
  },
  check: (r) => {
    const problems = [];
    if (!r?.firstServed) problems.push('the first call was refused; there is no retry to measure');
    if (!r?.secondServed) {
      problems.push(
        'the retry was REFUSED. UC-2 step 3 requires the repeat to be served and only the charge ' +
          'to be suppressed — a refusal is a different behaviour, not a stricter one',
      );
    }

    const ledger = r?.ledgerRows ?? [];
    if (ledger.length !== 1) {
      problems.push(
        `exactly one ledger row must carry client_request_id=${String(r?.requestId)}; found ` +
          String(ledger.length),
      );
    }

    const trace = r?.traceRows ?? [];
    if (trace.length !== 2) {
      problems.push(
        `two trace rows must carry that id — one per call; found ${String(trace.length)}. One row ` +
          'would mean the client id was ignored and each call got a server-minted one',
      );
    }
    const refused = trace.filter((x) => x.outcome === 'refusal');
    if (refused.length > 0) {
      problems.push(
        `${String(refused.length)} of the traced calls was a refusal (${[
          ...new Set(refused.map((x) => String(x.refusal_class))),
        ].join(', ')})`,
      );
    }
    return problems;
  },
};
