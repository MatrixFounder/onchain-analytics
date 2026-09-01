// Transport case — the blockscout daily call ceiling fires on a synthetic threshold
// (task 015-29, AC-41, UC-7, R-12.1, R-12.2).
//
// WHY A SYNTHETIC THRESHOLD AND NOT THE PRODUCTIVE ONE. The productive figure is an ESTIMATE
// (`ADR-003` D6, ~625 calls/day) and stays labelled as one; a live case that walked toward it would
// spend hundreds of real calls and starve the shared limiter for every other case in the run. Task
// 015-16 introduced `BLOCKSCOUT_DAILY_CALL_CAP` for exactly this, and the runner sets it to single
// digits for the phase.
//
// WHY `chain.transactions` AND NOT `entity.labels`. `entity.labels` falls back to the PAID nansen
// adapter, so a refusal from the gate would push the call there (R-11.1) — and R-12.2 forbids
// spending a single Nansen credit. This route has no paid fallback, so a refusal stays a refusal.
//
// WHY DIFFERENT CHAINS. A repeat is answered from cache without ever reaching the limiter or the
// gate, so the same argument N times is ONE live call and N-1 cache reads. The same defect was
// measured on `http-shared-limiter` (2026-08-24): an arm reading the cache the other arm had filled
// reported as a working limiter.
//
// WHY THE REFUSAL IS CHECKED BY ITS TEXT. `L-12`, `L-20` and `L-27` all produce a refusal of the
// same outward shape, and a bucket that saturates produces another. The discriminator is the
// substring the ceiling names and nothing else does (RISK-6, AC-25).
//
// WHY THE ZERO nansen ROW IS ASSERTED HERE. This is the only point in the whole run where a
// blockscout exhaustion happens live — so it is the only point where an escalation to the paid
// provider could occur unnoticed.

import { httpStore, readUsage } from './shared/ledger-reader.mjs';

const TOOL = 'onchain_chain_transactions';
const CEILING_MARKER = 'daily call ceiling reached';
// One chain per call, all distinct. Enough for a threshold of up to five plus the call that must be
// refused; the runner's synthetic cap is smaller than this list by construction.
const CHAINS = ['ethereum', 'base', 'optimism', 'arbitrum', 'polygon', 'gnosis'];

const textOf = (answer) => {
  const parts = answer?.result?.content ?? [];
  const joined = parts.map((p) => String(p?.text ?? '')).join(' ');
  return `${joined} ${String(answer?.error?.message ?? '')}`;
};

export default {
  kind: 'transport',
  transport: 'http',
  catches:
    'a daily ceiling that never fires, one that fires early and takes served calls with it, a ' +
    'refusal that cannot be told from a saturated bucket or a vendor outage, and an exhausted ' +
    'free provider escalating to the paid one',
  exercise: async (ctx) => {
    const cap = Number(process.env.BLOCKSCOUT_DAILY_CALL_CAP ?? 3);
    const session = await ctx.openSession();
    try {
      const answers = [];
      // Sequential on purpose: the ceiling is a count, and concurrent calls would make "the call
      // after the Nth" ambiguous.
      for (const chain of CHAINS.slice(0, cap + 1)) {
        const answer = await session.callTool(TOOL, { chain });
        answers.push({
          chain,
          isError: Boolean(answer.error) || answer.result?.isError === true,
          text: textOf(answer),
        });
      }
      const store = httpStore(ctx);
      const usage = await readUsage(store.storage, store.location);
      return { cap, answers, usage };
    } finally {
      await session.close();
    }
  },
  check: (r) => {
    const problems = [];
    const cap = Number(r?.cap ?? 0);
    const answers = r?.answers ?? [];

    if (answers.length !== cap + 1) {
      problems.push(`expected ${String(cap + 1)} attempts, made ${String(answers.length)}`);
      return problems;
    }

    const served = answers.slice(0, cap);
    const refusedEarly = served.filter((a) => a.isError);
    if (refusedEarly.length > 0) {
      problems.push(
        `the ceiling fired before it was reached: ${refusedEarly.map((a) => a.chain).join(', ')} ` +
          `refused within the first ${String(cap)} calls`,
      );
    }

    const last = answers[answers.length - 1];
    if (!last?.isError) {
      problems.push(`call ${String(cap + 1)} (${String(last?.chain)}) was SERVED past the ceiling`);
    } else if (!String(last.text).includes(CEILING_MARKER)) {
      problems.push(
        `call ${String(cap + 1)} was refused but not by the ceiling: its text does not contain ` +
          `"${CEILING_MARKER}", so a saturated bucket or a vendor outage is indistinguishable ` +
          `from exhaustion. Got: ${String(last.text).slice(0, 200)}`,
      );
    }

    const rows = r?.usage ?? [];
    const blockscout = rows.filter((x) => String(x.provider) === 'blockscout');
    const counted = blockscout.reduce((sum, x) => sum + Number(x.calls_made ?? 0), 0);
    if (counted !== cap) {
      problems.push(
        `usage.calls_made for blockscout must equal the ceiling (${String(cap)}); found ` +
          String(counted),
      );
    }

    const nansen = rows.filter((x) => String(x.provider) === 'nansen');
    if (nansen.length > 0) {
      problems.push(
        `an exhausted free provider escalated to the PAID one: ${String(nansen.length)} nansen ` +
          'usage row(s) exist after this case ran (R-12.2)',
      );
    }
    return problems;
  },
};
