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

import { dayBucketMs } from '@onchain-intel/core';
import { httpStore, readUsage } from './shared/ledger-reader.mjs';

const TOOL = 'onchain_chain_transactions';
// The sentence a CLIENT sees, not the one the store throws. `toClientText`
// (`src/transport/failure-classes.ts:357`) replaces the internal `daily call ceiling reached: …`
// outright, because the reason behind it names the provider and its counters — so a case that
// asserts on the internal wording asserts on a string that never crosses the boundary. Measured on
// the 2026-09-01 rehearsal, where this case reported "refused but not by the ceiling" about a
// refusal that WAS the ceiling. `test/eval-transport-cases.test.ts` renders a ceiling reason
// through the real function and checks this literal against it, so the guess cannot come back.
const CEILING_MARKER = 'the daily call ceiling for this provider is reached';
// One chain per call, all distinct. The case takes as many as it needs — the HEADROOM left under
// the ceiling plus the one call that must be refused — so the list bounds how much headroom a single
// run can exercise, not the ceiling itself.
const CHAINS = ['ethereum', 'base', 'optimism', 'arbitrum', 'polygon', 'gnosis'];

/**
 * The calls a provider has already made ON ONE DAY, out of an `onchain.usage` read.
 *
 * `onchain.usage` keeps one row per `(provider, day)`, and on the Postgres axis yesterday's row is
 * still there tomorrow — so summing `calls_made` across rows measures a WEEK against a ceiling that
 * bounds a DAY. Measured on the acceptance run of 2026-09-02: this case read 9, the whole of
 * 2026-09-01, and refused to run while the day's own counter stood at 0.
 *
 * Exported, and used by BOTH the pre-run headroom read and the post-run assertion, because the two
 * had the identical defect and a rule living in two places is a rule that drifts in one of them.
 */
export const callsOnDay = (rows, provider, day) =>
  (rows ?? [])
    .filter((x) => String(x.provider) === provider && Number(x.day) === Number(day))
    .reduce((sum, x) => sum + Number(x.calls_made ?? 0), 0);

const textOf = (answer) => {
  const parts = answer?.result?.content ?? [];
  const joined = parts.map((p) => String(p?.text ?? '')).join(' ');
  return `${joined} ${String(answer?.error?.message ?? '')}`;
};

/** `'hit' | 'miss' | null` — where the answer came from, as the tool itself reports it. */
const cacheStatusOf = (answer) => {
  const status = answer?.result?._meta?.cache?.status;
  return status === 'hit' || status === 'miss' ? status : null;
};

export default {
  kind: 'transport',
  transport: 'http',
  catches:
    'a daily ceiling that never fires, one that fires early and takes served calls with it, a ' +
    'refusal that cannot be told from a saturated bucket or a vendor outage, and an exhausted ' +
    'free provider escalating to the paid one',
  exercise: async (ctx) => {
    // FROM THE CONTEXT, never from this process's environment: the phase sets
    // `BLOCKSCOUT_DAILY_CALL_CAP` on the server it spawns, not on the runner the cases execute in.
    const cap = Number(ctx.dailyCallCap);
    const store = httpStore(ctx);
    // WHAT THE COUNTER ALREADY HOLDS, read BEFORE the first call.
    //
    // On the SQLite axis the store is a fresh temporary file and this is always zero. On the
    // Postgres axis it is the engine's own `onchain.usage`, and the row SURVIVES the run — so the
    // second gate run of a calendar day starts from whatever the first one left. Assuming zero made
    // this case silently unrepeatable: measured 2026-09-01, the first acceptance run left
    // `calls_made = 3` against a ceiling of 3, and a re-run would have met a refusal on its FIRST
    // call and reported it as "the ceiling fired before it was reached".
    //
    // Reading it turns a hidden precondition into the claim the gate actually makes: the ceiling
    // bounds the CUMULATIVE count for the day, not the count since this process started.
    // SCOPED TO THE DAY THE CEILING BOUNDS, and that scoping is the whole correctness of the read.
    // `onchain.usage` carries ONE ROW PER (provider, day), and on the Postgres axis yesterday's row
    // is still there tomorrow. Summing the column across rows therefore adds up a WEEK of calls
    // against a DAILY ceiling: measured 2026-09-02, this case refused to run because it read
    // `calls_made = 9` — the whole of 2026-09-01 — while today's counter stood at 0.
    //
    // `dayBucketMs` comes from core rather than being re-derived here: its own docstring forbids a
    // second hand-rolled copy of the formula, and a bucket that disagreed with the writer's by even
    // an hour would read the wrong row near midnight.
    const today = dayBucketMs(Date.now());
    const before = await readUsage(store.storage, store.location);
    const already = callsOnDay(before, 'blockscout', today);
    const remaining = cap - already;

    const session = await ctx.openSession();
    try {
      // WALK UNTIL A REFUSAL, SKIPPING CACHE HITS.
      //
      // A cached answer is served before the gate is consulted at all, so it neither consumes
      // headroom nor tests anything — it is not an admitted call and must not be counted as one.
      // The case's own header says a repeat never reaches the gate; what this loop adds is that on
      // the Postgres axis the cache SURVIVES THE RUN, so "different chains" stops being enough the
      // second time the gate runs in a TTL. Measured 2026-09-01: `optimism` came back from an entry
      // the 13:37 run had written, and the case read it as a served call past the ceiling.
      //
      // Sequential on purpose: the ceiling is a count, and concurrent calls would make "the call
      // after the Nth" ambiguous.
      const answers = [];
      let admitted = 0;
      let ceilingMet = false;
      for (const chain of CHAINS) {
        const answer = await session.callTool(TOOL, { chain });
        const text = textOf(answer);
        const isError = Boolean(answer.error) || answer.result?.isError === true;
        const cached = cacheStatusOf(answer) === 'hit';
        const isCeiling = isError && text.includes(CEILING_MARKER);
        answers.push({ chain, isError, cached, isCeiling, text });
        if (isCeiling) {
          ceilingMet = true;
          break; // the deciding refusal — the walk is over
        }
        // ONLY the ceiling ends the walk, and only a cache hit fails to count. A vendor failure
        // (`L-20` was live on `base` all day on 2026-09-01) is an ADMITTED call: the gate let it
        // through, the counter moved, the vendor then failed it. Stopping on any `isError` would
        // hand a filed vendor defect the role of the deciding refusal — RISK-6 wearing the
        // costume of the thing it imitates.
        if (!cached) admitted += 1;
      }
      const usage = await readUsage(store.storage, store.location);
      // `today` travels out so `check` scopes the post-run read to the SAME bucket this one used,
      // and `nansenBefore` so the escalation claim is a COMPARISON. A nansen row that was already
      // there says nothing about whether this case escalated; only growth does (R-12.2).
      const nansenBefore = before.filter((x) => String(x.provider) === 'nansen').length;
      return { cap, already, remaining, admitted, ceilingMet, answers, usage, today, nansenBefore };
    } finally {
      await session.close();
    }
  },
  check: (r) => {
    const problems = [];
    const cap = Number(r?.cap ?? 0);
    const already = Number(r?.already ?? 0);
    const remaining = Number(r?.remaining ?? 0);
    const answers = r?.answers ?? [];

    // Not enough headroom under the ceiling to make even one admitted call. Reported as a PROBLEM
    // rather than skipped: a case that quietly passes when it could not run is the shape this whole
    // file exists to refuse. The operator's remedy is a larger `ONCHAIN_EVAL_BLOCKSCOUT_CAP` for
    // the run, or waiting for the day bucket to roll over.
    if (remaining < 1) {
      problems.push(
        `the ceiling (${String(cap)}) was already reached before this case ran — ` +
          `usage.calls_made was ${String(already)}. Nothing about the gate was measured. Raise ` +
          'ONCHAIN_EVAL_BLOCKSCOUT_CAP above the standing count for this run',
      );
      return problems;
    }

    const admitted = Number(r?.admitted ?? 0);
    const cached = answers.filter((a) => a.cached).map((a) => String(a.chain));
    const last = answers[answers.length - 1];

    if (r?.ceilingMet !== true) {
      problems.push(
        `the walk ran out of chains without meeting the ceiling: ${String(admitted)} call(s) were ` +
          `admitted against headroom of ${String(remaining)}` +
          (cached.length === 0
            ? ''
            : `, and ${String(cached.length)} answer(s) came from CACHE (${cached.join(', ')}), ` +
              'which never reach the gate. On the Postgres axis the cache outlives the run, so a ' +
              'second run inside the TTL has fewer usable chains than the list suggests') +
          '. Nothing about the ceiling was measured',
      );
      return problems;
    }

    if (admitted !== remaining) {
      // The vendor failures are NAMED here rather than counted silently: they were admitted calls
      // (the gate let them through and the counter moved), so they belong in this arithmetic, and a
      // reader who does not see them listed cannot tell this from a gate that miscounted.
      const vendorFailures = answers.filter((a) => a.isError && !a.isCeiling).map((a) => a.chain);
      problems.push(
        `the refusal came after ${String(admitted)} admitted call(s), but the headroom under the ` +
          `ceiling of ${String(cap)} was ${String(remaining)} (the counter already held ` +
          `${String(already)})` +
          (vendorFailures.length === 0
            ? ''
            : `. ${String(vendorFailures.length)} of those were admitted and then failed at the ` +
              `vendor (${vendorFailures.join(', ')}) — counted, as the gate counts them`),
      );
    }

    // BY THE TEXT, not by the shape — the same discriminator UC-7 A1 fixes for the call after the
    // ceiling, applied to the calls before it. A vendor outage inside this window (`L-20` was live
    // on `base` during the 2026-09-01 rehearsal) is NOT the gate firing early: the call was
    // admitted, the vendor failed it, and `usage.calls_made` below still counts it. Judging these
    // by `isError` made a filed vendor defect read as a misfiring gate — RISK-6 in the other
    // direction, and the reason this case exists.
    // The walk stops AT the ceiling, so a ceiling refusal in any earlier position is impossible by
    // construction — the checks that remain are that the LAST one is the ceiling, and that the
    // admitted count before it matches the headroom.
    if (last?.isCeiling !== true) {
      problems.push(
        `the deciding call (${String(last?.chain)}) did not carry the ceiling's own text ` +
          `"${CEILING_MARKER}", so a saturated bucket or a vendor outage is indistinguishable ` +
          `from exhaustion. Got: ${String(last?.text).slice(0, 200)}`,
      );
    }

    const rows = r?.usage ?? [];
    const today = Number(r?.today ?? 0);
    // THE DAY'S ROW, not every row the table holds. `onchain.usage` keeps one row per
    // `(provider, day)` and on the Postgres axis they accumulate — summing the column across rows
    // measures the week against a ceiling that bounds the day. This read and the pre-run one above
    // share `today` so they cannot disagree across a midnight rollover mid-run.
    const counted = callsOnDay(rows, 'blockscout', today);
    // The CUMULATIVE count for the day, not this case's own calls: the ceiling bounds the day, so
    // after the refusal the counter must sit exactly ON the ceiling whatever it started the case
    // at. One higher would mean the refused call was admitted and counted anyway.
    if (counted !== cap) {
      problems.push(
        `usage.calls_made for blockscout on this day must equal the ceiling (${String(cap)}); ` +
          `found ${String(counted)}`,
      );
    }

    // GROWTH, not presence. A nansen row predating this case is somebody else's history; what
    // R-12.2 forbids is this exhaustion pushing the call to the paid provider, and only a new row
    // is evidence of that.
    const nansenAfter = rows.filter((x) => String(x.provider) === 'nansen').length;
    const nansenBefore = Number(r?.nansenBefore ?? 0);
    if (nansenAfter > nansenBefore) {
      problems.push(
        `an exhausted free provider escalated to the PAID one: nansen usage rows went from ` +
          `${String(nansenBefore)} to ${String(nansenAfter)} while this case ran (R-12.2)`,
      );
    }
    return problems;
  },
};
