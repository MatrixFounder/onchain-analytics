// Transport case — the RATE two HTTP sessions produce is bounded by ONE bucket (WI-63, UC-2, R-7).
//
// **What this adds to `http-shared-limiter.mjs`, which is a different assertion.** That case proves
// the session PLUMBING: two sessions get distinct ids and every call both make is served. It says
// nothing about the quantity UC-2 is finally about — the aggregate rate the vendor sees. Task
// 014-33 shipped it in that narrower form and filed the gap as WI-63; this file closes it.
//
// **The defect it exists to catch.** A server that builds one engine PER SESSION — a plausible
// refactor, and invisible to every assertion the other case makes — gives each session its own
// token bucket. Every call still succeeds, every session id is still distinct, and the vendor
// quietly sees twice the rate we declared. That is the failure mode R-7 was written for, and until
// this file it was unmeasured on the deployed transport.
//
// **Why the argument axis is synthetic addresses.** The measurement needs calls that reach the
// LIMITER, and a repeated argument is answered by the cache without ever getting there. An earlier
// version of the sibling case compared six calls on one session against six split across two and
// reported "9ms versus 312ms" — the second arm was reading the cache the first arm had filled, and
// it would have called a healthy limiter broken. `eval/probes.json` curates twelve chains in total,
// which is not enough distinct arguments to fill one arm, let alone two.
//
// `wallet.balances.native` is the one free capability whose argument axis is unbounded, and asking
// a node for the balance of an address with no funds is not a lie to the vendor: zero is a correct
// answer to a well-formed question. `probes.json` already rests on exactly that reasoning for its
// zero-address wallet probe. The addresses start at 0x1000 so they cannot collide with the
// precompiles at 0x01..0x0a, whose latency is not an ordinary account lookup's.
//
// **Why the assertion is derived and not pinned.** The bucket is read from `adapterRegistrations` —
// the same object `adapters/rpc-evm/call-rpc.ts` reads at run time, so there is no second copy of
// `{capacity, refillPerSec}` to go stale the day that file is tuned, and no threshold in this file
// a reader has to reconcile with the config. The probe size scales itself off the bucket too:
// everything below is a function of those two numbers.
//
// **Why one bucket and not one per chain.** `rpc-evm` is the one provider that declares
// `scopeKey: 'chain'`, so its bucket is per (provider, chain). Every call here is on ONE chain by
// construction; spreading them would measure as many buckets as chains.
//
// **What this case costs, stated rather than hidden**: two full-refill waits and the throttle wait
// itself — about 19 s at today's `{capacity: 5, refillPerSec: 1}`, plus 18 keyless RPC calls. It
// spends no credits.
//
// **Why the verdict is a one-sided bound and NOT `measure − control`, which is what this case did
// first.** Subtracting the control arm looks like the careful thing to do: it removes the vendor's
// latency and leaves our own wait. It also inherits every wobble in that latency, with the sign
// pointing the wrong way — an OVER-measured control subtracts real throttle wait and reports a
// healthy limiter as split. Measured 2026-08-24 on the gate's own fifth run: `measureMs = 7088`
// against a shared-bucket floor of 7000 — the limiter had done exactly its job — while the control
// arm read 4420 ms because the RPC endpoint was slow for those few seconds, so the subtraction gave
// 2668 ms and the case reported a defect that did not exist.
//
// So the verdict is now `measureMs >= sharedFloorMs`, with nothing subtracted. Under a shared bucket
// that holds by construction, whatever the vendor's latency, because elapsed is the forced wait PLUS
// latency. Under two per-session buckets it can only hold if latency alone covers the gap between
// the hypotheses — and that case is not silently passed: the control arm is still measured, and when
// it is large enough to explain the result on its own the case reports the run as INCONCLUSIVE
// rather than green. A test that cannot tell must say so; "cannot tell" reading as "fine" is L-10's
// shape.
//
// **What it does NOT cover.** On a Postgres-backed profile the bucket is shared with every other
// process against that database, so a concurrent snapshotter would consume tokens this case
// attributes to itself. The artifact records `httpProfile` on every run, which is where a reader
// checks which axis produced a given number.
import { adapterRegistrations } from '@onchain-intel/core';

const PROVIDER = 'rpc-evm';
const REGISTRATION = adapterRegistrations.find((r) => r.id === PROVIDER);
if (!REGISTRATION) {
  throw new Error(
    `eval/cases/http-shared-limiter-rate: no ${PROVIDER} entry in adapterRegistrations`,
  );
}
const { capacity, refillPerSec } = REGISTRATION.rateLimit;

/** One chain, because the bucket is scoped per chain. Curated RPC hosts, keyless. */
const CHAIN = 'ethereum';
const TOOL = 'onchain_wallet_balances';

/**
 * How far apart the two hypotheses must be before this case is allowed to decide between them.
 *
 * WI-63's own refusal, kept as a rule: an assertion resolvable only within noise is worse than one
 * that states its limit. Two seconds is above any plausible scheduling or vendor-latency wobble on
 * a loopback transport, and the probe size below is chosen to reach it rather than assumed to.
 */
const MIN_SEPARATION_MS = 2_000;
/** Beyond this the case refuses to measure rather than hammering a free vendor. */
const MAX_CALLS = 24;

/**
 * The probe size, derived.
 *
 * With `n` distinct calls split evenly over two sessions, one shared bucket forces
 * `(n - capacity)/refill` seconds of wait and two per-session buckets force
 * `(n/2 - capacity)/refill` — so the separation between the hypotheses is exactly
 * `n / (2 × refill)` seconds. `n > 2 × capacity` is what keeps the per-session floor above zero,
 * and the second term is what keeps the separation above the noise bound.
 */
const CALLS = (() => {
  const overCapacity = 2 * capacity + 2;
  const forSeparation = Math.ceil((2 * refillPerSec * MIN_SEPARATION_MS) / 1000);
  const n = Math.max(overCapacity, forSeparation);
  return n % 2 === 0 ? n : n + 1;
})();

/** The control arm fits inside the bucket, so it measures latency and nothing else. */
const CONTROL_CALLS = capacity;
/** A provably full bucket, whatever ran before this case. */
const FULL_REFILL_MS = Math.ceil((capacity / refillPerSec) * 1000);
const SHARED_FLOOR_MS = Math.round(((CALLS - capacity) / refillPerSec) * 1000);
const SPLIT_FLOOR_MS = Math.round(((CALLS / 2 - capacity) / refillPerSec) * 1000);
/**
 * How far apart the two hypotheses actually are, in milliseconds.
 *
 * It is also the latency at which the test stops being able to decide: a per-session bucket plus
 * this much vendor latency produces the same elapsed time as a shared bucket with none.
 */
const GAP_MS = SHARED_FLOOR_MS - SPLIT_FLOOR_MS;

/**
 * The whole derivation, in one object, exported so it can be checked WITHOUT a network run.
 *
 * `validate` in `cases/index.mjs` reads only the default export, so this is inert at run time. It
 * exists because the numbers above are the case's actual claim: `test/eval-transport-cases.test.ts`
 * re-derives them from `adapterRegistrations` and compares, which is what keeps "derived, not
 * pinned" a property the suite proves rather than a sentence in a comment.
 */
export const PLAN = {
  provider: PROVIDER,
  chain: CHAIN,
  tool: TOOL,
  capacity,
  refillPerSec,
  calls: CALLS,
  controlCalls: CONTROL_CALLS,
  fullRefillMs: FULL_REFILL_MS,
  sharedFloorMs: SHARED_FLOOR_MS,
  splitFloorMs: SPLIT_FLOOR_MS,
  gapMs: GAP_MS,
  minSeparationMs: MIN_SEPARATION_MS,
  maxCalls: MAX_CALLS,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Addresses that miss the cache by construction, above the precompile range. */
const ADDRESS_BASE = 0x1000;
const addressAt = (i) => `0x${(ADDRESS_BASE + i).toString(16).padStart(40, '0')}`;

/** Issues `count` calls at once, alternating sessions, and reports what came back. */
async function armOf(sessions, count, nextAddress) {
  const started = Date.now();
  const answers = await Promise.all(
    // `(_, i) => …`, never a bare function reference: `Array.from`'s mapper is handed the INDEX as
    // its second argument, and a mapper that accepts one would silently receive it as a second
    // parameter. The same slip made three cases of `eval-gate.test.ts` assert nothing.
    Array.from({ length: count }, (_, i) =>
      sessions[i % sessions.length].callTool(TOOL, { chain: CHAIN, address: nextAddress() }),
    ),
  );
  return {
    elapsedMs: Date.now() - started,
    answered: answers.filter((x) => x.result?.structuredContent).length,
    toolErrors: answers.filter((x) => x.result?.isError).map((x) => x.result?.content?.[0]?.text),
    rpcErrors: answers.filter((x) => x.error).map((x) => x.error.message),
  };
}

export default {
  kind: 'transport',
  transport: 'http',
  catches:
    'a deployment that gives each MCP session its own token bucket — every call succeeds, every ' +
    'session id is distinct, and the vendor sees twice the rate we declared, which no ' +
    'single-session test and no session-plumbing assertion can see',
  exercise: async ({ openSession }) => {
    if (CALLS > MAX_CALLS) {
      return { unmeasurable: `${String(CALLS)} calls`, capacity, refillPerSec, calls: CALLS };
    }
    const a = await openSession();
    const b = await openSession();
    let next = 0;
    const nextAddress = () => addressAt(next++);
    try {
      // One call first, so the control arm is not the one paying DNS and TLS setup: an
      // over-measured control subtracts real wait out of the result and would report a healthy
      // limiter as split.
      await armOf([a], 1, nextAddress);
      await sleep(FULL_REFILL_MS);
      const control = await armOf([a, b], CONTROL_CALLS, nextAddress);
      // The control arm drained the bucket it just measured through.
      await sleep(FULL_REFILL_MS);
      const measure = await armOf([a, b], CALLS, nextAddress);
      return {
        sessionA: a.id,
        sessionB: b.id,
        capacity,
        refillPerSec,
        calls: CALLS,
        controlCalls: CONTROL_CALLS,
        controlMs: control.elapsedMs,
        measureMs: measure.elapsedMs,
        // Kept for the record and for the inconclusive test below — NOT subtracted from the
        // verdict. See the docstring: subtracting it is what produced a false red on 2026-08-24.
        waitObservedMs: measure.elapsedMs - control.elapsedMs,
        sharedFloorMs: SHARED_FLOOR_MS,
        splitFloorMs: SPLIT_FLOOR_MS,
        gapMs: GAP_MS,
        controlAnswered: control.answered,
        answered: measure.answered,
        rpcErrors: [...control.rpcErrors, ...measure.rpcErrors],
        toolErrors: [...control.toolErrors, ...measure.toolErrors],
      };
    } finally {
      await a.close();
      await b.close();
    }
  },
  check: (o) => {
    const problems = [];
    if (o?.unmeasurable) {
      // A config change, not a defect — and reported rather than skipped, because a case that
      // quietly stops measuring is indistinguishable from one that measures and passes.
      return [
        `the bucket {capacity: ${String(o.capacity)}, refillPerSec: ${String(o.refillPerSec)}} needs ` +
          `${o.unmeasurable} to separate a shared bucket from a per-session one, over the ` +
          `${String(MAX_CALLS)}-call ceiling this case will spend on a free vendor. Raise the ceiling ` +
          'with the measurement that justifies it, or measure this property somewhere other than ' +
          'the live gate',
      ];
    }
    if (typeof o?.sessionA !== 'string' || typeof o?.sessionB !== 'string') {
      problems.push('one of the two sessions has no session id');
    } else if (o.sessionA === o.sessionB) {
      // Two clients on one session id would make this a measurement of one session twice.
      problems.push(`both sessions were given the same id ${o.sessionA}`);
    }
    for (const message of o?.rpcErrors ?? []) problems.push(`JSON-RPC error: ${message}`);
    for (const message of o?.toolErrors ?? []) problems.push(`the tool refused: ${String(message)}`);
    if (o?.controlAnswered !== o?.controlCalls || o?.answered !== o?.calls) {
      // An incomplete arm makes the elapsed time mean nothing, so the timing assertion is withheld
      // rather than evaluated against a number that measures a vendor failure.
      problems.push(
        `${String(o?.controlAnswered)}/${String(o?.controlCalls)} and ${String(o?.answered)}/${String(o?.calls)} ` +
          'calls answered — the rate measurement needs both arms complete and is not asserted',
      );
      return problems;
    }
    if (o.measureMs < o.sharedFloorMs) {
      problems.push(
        `${String(o.calls)} distinct calls across two sessions completed in ${String(o.measureMs)}ms. One ` +
          `shared bucket cannot finish them in under ${String(o.sharedFloorMs)}ms — that is the wait it ` +
          `forces before any vendor latency — while two per-session buckets imply ` +
          `${String(o.splitFloorMs)}ms, so this is the per-session answer: the sessions are not sharing ` +
          `${PROVIDER}'s ceiling and the vendor is seeing more than the rate we declare ` +
          `(control arm ${String(o.controlMs)}ms)`,
      );
    } else if (o.controlMs >= o.gapMs) {
      // The bound held, but the vendor was slow enough that it could have held on latency alone.
      // Reported rather than passed: a run that cannot decide must not read as one that decided.
      problems.push(
        `INCONCLUSIVE: the ${String(o.calls)} calls took ${String(o.measureMs)}ms, at or above the ` +
          `${String(o.sharedFloorMs)}ms one shared bucket forces — but the control arm measured ` +
          `${String(o.controlMs)}ms of vendor latency, which alone covers the ${String(o.gapMs)}ms between ` +
          'the two hypotheses. The bucket may be shared or per-session; this run cannot tell. Re-run ' +
          'when the provider is answering normally',
      );
    }
    return problems;
  },
};
