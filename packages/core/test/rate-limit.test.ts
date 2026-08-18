import { describe, expect, it, vi } from 'vitest';
import {
  createThrottle,
  DeadlineWouldExceedError,
  RateLimitRejectedError,
  throttle as productionThrottle,
} from '../src/net/rate-limit.js';
import { DeadlineExceededError } from '../src/net/safe-fetch.js';

/** Builds an injectable, real-timer-free clock: `now()` returns a controllable counter; `wait(ms)`
 * never actually sleeps — it advances the same counter by `ms` and resolves immediately, so tests
 * can assert on the requested wait duration without spending real wall-clock time. */
function fakeClock(startMs = 0) {
  let current = startMs;
  const waitCalls: number[] = [];
  return {
    now: () => current,
    wait: vi.fn((ms: number) => {
      waitCalls.push(ms);
      current += ms;
      return Promise.resolve();
    }),
    advance: (ms: number) => {
      current += ms;
    },
    waitCalls,
  };
}

describe('throttle (token-bucket) [Phase 2, injectable clock — no real timers]', () => {
  it('lets up to `capacity` calls through immediately without waiting', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    const config = { capacity: 3, refillPerSec: 1 };

    await throttle('coingecko', config);
    await throttle('coingecko', config);
    await throttle('coingecko', config);

    expect(clock.wait).not.toHaveBeenCalled();
  });

  it('waits once capacity is exhausted, for exactly the time needed to refill one token', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    const config = { capacity: 1, refillPerSec: 2 }; // one token, refills fully in 500ms

    await throttle('coingecko', config); // consumes the only token, no wait
    await throttle('coingecko', config); // must wait

    expect(clock.wait).toHaveBeenCalledTimes(1);
    expect(clock.wait).toHaveBeenCalledWith(500);
  });

  it('refills tokens proportionally to elapsed time before deciding whether to wait', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    const config = { capacity: 2, refillPerSec: 1 };

    await throttle('dexscreener', config);
    await throttle('dexscreener', config); // bucket now empty
    clock.advance(1000); // one full second passes — refills exactly one token

    await throttle('dexscreener', config); // should proceed without waiting

    expect(clock.wait).not.toHaveBeenCalled();
  });

  it('never refills beyond `capacity`, even after a very long idle period', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    const config = { capacity: 2, refillPerSec: 5 };

    await throttle('defillama', config);
    await throttle('defillama', config); // bucket empty
    clock.advance(10_000); // would refill far more than 2 tokens if uncapped

    await throttle('defillama', config); // 1st of the refilled tokens
    await throttle('defillama', config); // 2nd — still within capacity, no wait
    await throttle('defillama', config); // 3rd — bucket exhausted again, must wait

    expect(clock.wait).toHaveBeenCalledTimes(1);
  });

  it('maintains an independent bucket per providerId — exhausting one never throttles another', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    const tightConfig = { capacity: 1, refillPerSec: 0.1 };
    const roomyConfig = { capacity: 5, refillPerSec: 1 };

    await throttle('dune', tightConfig); // exhausts dune's single token

    await throttle('coingecko', roomyConfig); // unrelated provider, unaffected

    expect(clock.wait).not.toHaveBeenCalled();
  });

  it('the production `throttle` singleton is a real, callable Throttle built with real timers (smoke check only, not exercised for timing)', () => {
    expect(typeof productionThrottle).toBe('function');
  });

  describe('concurrency-safe token bucket (adversarial cycle 1, fix C)', () => {
    it('serializes 3 concurrent callers against a 1-capacity bucket into distinct, cascading wait durations — never all firing after the same single wait', async () => {
      // A frozen clock (`now()` never advances on its own) — `wait()` only records the requested
      // duration, with NO clock mutation — isolates the spacing logic under test from the
      // real-time-elapsed refill logic the tests above already cover via `clock.advance()`. This
      // matters because 3 calls issued via `Promise.all` all run their synchronous bucket-math
      // prefix back-to-back, in the same real instant, before any of them awaits a real timer.
      const waitCalls: number[] = [];
      const deps = {
        now: () => 0,
        wait: vi.fn((ms: number) => {
          waitCalls.push(ms);
          return Promise.resolve();
        }),
      };
      const throttle = createThrottle(deps);
      const config = { capacity: 1, refillPerSec: 2 }; // 1 token every 500ms

      await Promise.all([
        throttle('shared', config),
        throttle('shared', config),
        throttle('shared', config),
      ]);

      // 1st caller consumes the initial token immediately (no wait call at all); the 2nd and 3rd
      // each get their OWN, progressively later slot — never the same duration twice (the bug
      // this fix closes: both used to compute the identical 500ms wait).
      expect(waitCalls).toEqual([500, 1000]);
    });

    it('rejects with a typed RateLimitRejectedError when refillPerSec is 0 — never busy-spins or hangs forever', async () => {
      const clock = fakeClock();
      const throttle = createThrottle(clock);

      await expect(
        throttle('broken-provider', { capacity: 1, refillPerSec: 0 }),
      ).rejects.toBeInstanceOf(RateLimitRejectedError);
      expect(clock.wait).not.toHaveBeenCalled();
    });

    it('rejects with a typed RateLimitRejectedError for a negative refillPerSec too', async () => {
      const clock = fakeClock();
      const throttle = createThrottle(clock);

      await expect(
        throttle('broken-provider', { capacity: 1, refillPerSec: -1 }),
      ).rejects.toBeInstanceOf(RateLimitRejectedError);
    });

    it('rejects with a typed RateLimitRejectedError (naming the provider + saturation) when the computed wait would exceed the 30s fairness cap (adversarial cycle 2, fix 7)', async () => {
      const clock = fakeClock();
      const throttle = createThrottle(clock);
      // Far too slow a refill rate: 1 token per 1000 real seconds — any 2nd call within the same
      // instant computes a multi-hundred-thousand-ms wait, well past the 30s cap.
      const config = { capacity: 1, refillPerSec: 0.001 };

      await throttle('saturated-provider', config); // consumes the only token immediately

      await expect(throttle('saturated-provider', config)).rejects.toBeInstanceOf(
        RateLimitRejectedError,
      );
      await expect(throttle('saturated-provider', config)).rejects.toThrow(/saturated-provider/);
      await expect(throttle('saturated-provider', config)).rejects.toThrow(/saturat/i);
      // Never actually waits — rejected fast instead of blocking for hundreds of thousands of ms.
      expect(clock.wait).not.toHaveBeenCalled();
    });

    it('refunds the reserved token after a saturation rejection — a subsequent call sees the SAME bucket state as before the rejected attempt, never a growing double-pay backlog (post-M1 polish, fix 6)', async () => {
      const clock = fakeClock(); // frozen unless advanced — never advances on its own here
      const throttle = createThrottle(clock);
      const config = { capacity: 1, refillPerSec: 0.001 }; // any 2nd call computes a multi-hundred-thousand-ms wait

      await throttle('saturated-refund-check', config); // consumes the only token, succeeds immediately

      function extractComputedWaitMs(error: unknown): number {
        const match = /computed wait (\d+)ms/.exec((error as Error).message);
        expect(match).not.toBeNull();
        return Number(match![1]);
      }

      // 1st saturating call — rejected, but per fix 7's own contract its reserved token is
      // refunded (`bucket.tokens += 1`) BEFORE the throw.
      let firstWaitMs: number | undefined;
      try {
        await throttle('saturated-refund-check', config);
        expect.unreachable();
      } catch (error) {
        firstWaitMs = extractComputedWaitMs(error);
      }

      // A 2nd saturating call, clock still frozen (zero elapsed time, so refill contributes
      // nothing either way). If the 1st rejection's reservation had NOT been refunded, the bucket's
      // deficit would have grown by a further unit (double-pay), and this call would compute a
      // LARGER waitMs than the 1st did. With the refund in place, this call sees the IDENTICAL
      // pre-rejection bucket state (proven by computing the exact same waitMs).
      let secondWaitMs: number | undefined;
      try {
        await throttle('saturated-refund-check', config);
        expect.unreachable();
      } catch (error) {
        secondWaitMs = extractComputedWaitMs(error);
      }

      expect(secondWaitMs).toBe(firstWaitMs);
      // Neither rejection ever actually waits.
      expect(clock.wait).not.toHaveBeenCalled();
    });
  });
});

/**
 * `weight` (TASK-008 follow-up, R-73b) — one call may cost more than one token.
 *
 * A bucket counts OUR requests; a vendor quota counts UPSTREAM ones. `blockscout`'s
 * `/v1/get_address_info` fans out to three upstreams server-side, so a weightless bucket
 * under-counts the thing it exists to limit by 3×.
 */
describe('throttle weight', () => {
  const config = { capacity: 5, refillPerSec: 2 };

  it('consumes `weight` tokens, not one', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);

    // Capacity 5: one weight-3 call leaves 2, so a second weight-3 call must wait for 1 token.
    await throttle('blockscout', config, 3);
    expect(clock.waitCalls).toEqual([]);
    await throttle('blockscout', config, 3);
    // Deficit of 1 token at 2/sec = 500ms. A weightless implementation would not have waited at all.
    expect(clock.waitCalls).toEqual([500]);
  });

  it('defaults to 1 — every existing caller is unaffected', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    for (let i = 0; i < 5; i += 1) await throttle('defillama', config);
    expect(clock.waitCalls).toEqual([]);
  });

  it('computes ONE wait against ONE fairness cap, not N of them', async () => {
    // The reason this is a weight rather than N sequential calls: N calls compute N independent
    // waits, each capped at MAX_WAIT_MS, so a saturated bucket could park one logical request for
    // N × 30s — reintroducing the latency stacking that free-first ordering exists to avoid.
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    await throttle('blockscout', config, 5);
    await throttle('blockscout', config, 5);
    expect(clock.waitCalls).toHaveLength(1);
    expect(clock.waitCalls[0]).toBe(2500);
  });

  it('refunds the FULL weight when it rejects, so the bucket does not leak tokens', async () => {
    // A partial refund would tighten the limiter a little on every rejected weighted call until it
    // admitted nothing at all.
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    const slow = { capacity: 5, refillPerSec: 0.05 };

    await throttle('blockscout', slow, 5);
    await expect(throttle('blockscout', slow, 3)).rejects.toBeInstanceOf(RateLimitRejectedError);
    // 100 seconds of refill at 0.05/s = 5 tokens: a full bucket again IF the rejection refunded
    // all three. With a 1-token refund it would still be short and this call would reject too.
    clock.advance(100_000);
    await expect(throttle('blockscout', slow, 5)).resolves.toBeUndefined();
  });

  it('refuses a weight it can never satisfy instead of waiting forever on a full bucket', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    await expect(throttle('blockscout', config, 6)).rejects.toThrow(/exceeds bucket capacity/);
  });

  it('refuses a non-integer or non-positive weight rather than silently treating it as 1', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(throttle('blockscout', config, bad)).rejects.toThrow(/weight must be/);
    }
  });
});

/**
 * Task 012-7 — the limiter under an ABSOLUTE call deadline (ADR-002 D4, R-146; AC-9).
 *
 * **Entirely on virtual clocks, and that is a gate requirement, not a style preference** (PLAN §0.7,
 * the residual risk left behind when WI-26 closed): every case below builds its own
 * `createThrottle({now, wait})`, so no new branch can reach for the production singleton's shared
 * bucket and start depending on what else the process ran. Real timers are not merely unnecessary
 * here — they would reintroduce exactly the 46.8 s of sleep WI-26 removed.
 */
describe('call deadline — two typed refusals, one per fact (task 012-7)', () => {
  /** One token per 20 s: the second call's honest wait is 20 000 ms — under `MAX_WAIT_MS`, so
   * today's limiter really does sit it out. That is what a deadline has to be able to cut short. */
  const SLOW = { capacity: 1, refillPerSec: 0.05 };

  /** TC-UNIT-08 (R-146a / AC-9) — the wait stops being unconditional.
   * EXPECTED_FAIL_REASON (phase 1, the 4th parameter declared and ignored): the deadline changes
   * nothing, `wait(20000)` is called and the call RESOLVES — "promise resolved instead of
   * rejecting". */
  it('TC-UNIT-08: a saturated bucket under an expiring deadline is not sat out', async () => {
    // The control is half of the claim: without a deadline this same second call DOES wait 20 s.
    // Measured here rather than asserted in prose, so the comparison cannot drift.
    const control = fakeClock();
    const controlThrottle = createThrottle(control);
    await controlThrottle('blockscout', SLOW);
    await controlThrottle('blockscout', SLOW);
    expect(control.waitCalls).toEqual([20_000]);

    const clock = fakeClock();
    const throttle = createThrottle(clock);
    await throttle('blockscout', SLOW); // consumes the only token, no wait

    await expect(throttle('blockscout', SLOW, 1, clock.now() + 1_000)).rejects.toThrow(/deadline/i);
    expect(clock.waitCalls).toEqual([]);
  });

  /** TC-UNIT-09 — a spent deadline refuses without waiting at all.
   * EXPECTED_FAIL_REASON (phase 1): the deadline is ignored, `wait(500)` is called and the call
   * RESOLVES — "promise resolved instead of rejecting". */
  it('TC-UNIT-09: remaining <= 0 gives DeadlineExceededError with no wait call whatsoever', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    const config = { capacity: 1, refillPerSec: 2 }; // 500ms per token

    await throttle('blockscout', config); // consumes the only token

    // The boundary itself (exactly zero left) and a deadline already behind us — both are the same
    // fact ("our time is up"), and both must refuse before the bucket's arithmetic matters.
    await expect(throttle('blockscout', config, 1, clock.now())).rejects.toBeInstanceOf(
      DeadlineExceededError,
    );
    await expect(throttle('blockscout', config, 1, clock.now() - 5)).rejects.toBeInstanceOf(
      DeadlineExceededError,
    );
    expect(clock.wait).not.toHaveBeenCalled();
  });

  /** TC-UNIT-10 (H-A) — the two facts are two classes.
   * EXPECTED_FAIL_REASON (phase 1): the deadline is ignored, `wait(2500)` is called and the call
   * resolves; since this case captures with `.catch`, the resolution surfaces as
   * "expected undefined to be an instance of DeadlineWouldExceedError". */
  it('TC-UNIT-10: remaining > 0 but the bucket cannot make it gives DeadlineWouldExceedError', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    const config = { capacity: 5, refillPerSec: 2 }; // blockscout's real numbers

    await throttle('blockscout', config, 5); // empties the bucket; the next weight-5 call needs 2500ms

    const error = await throttle('blockscout', config, 5, clock.now() + 2_000).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DeadlineWouldExceedError);
    // Merging the two classes is H-1 one floor down: "blockscout's bucket is backed up" would end
    // the traversal before `nansen`, whose bucket is idle and for whom those 2 s are real.
    expect(error).not.toBeInstanceOf(DeadlineExceededError);
    expect((error as Error).message).toContain('blockscout');
    expect(clock.wait).not.toHaveBeenCalled();
  });

  /** TC-UNIT-11 — both refusals refund, proven by the NEXT caller's behaviour rather than by
   * reading private bucket state.
   * EXPECTED_FAIL_REASON (phase 1): the deadline is ignored, so the first `rejects` assertion fails
   * with "promise resolved \"undefined\" instead of rejecting" before the refund can be observed at
   * all. */
  it('TC-UNIT-11: both deadline refusals refund the reservation — no inherited backlog', async () => {
    const config = { capacity: 1, refillPerSec: 2 }; // 500ms per token

    // Branch A — remaining <= 0.
    const clockA = fakeClock();
    const throttleA = createThrottle(clockA);
    await throttleA('blockscout', config);
    await expect(throttleA('blockscout', config, 1, clockA.now())).rejects.toBeInstanceOf(
      DeadlineExceededError,
    );
    await throttleA('blockscout', config); // no deadline — waits for ONE token, not two
    expect(clockA.waitCalls).toEqual([500]);

    // Branch B — remaining > 0, bucket too slow.
    const clockB = fakeClock();
    const throttleB = createThrottle(clockB);
    await throttleB('blockscout', config);
    await expect(throttleB('blockscout', config, 1, clockB.now() + 100)).rejects.toBeInstanceOf(
      DeadlineWouldExceedError,
    );
    await throttleB('blockscout', config);
    expect(clockB.waitCalls).toEqual([500]);
  });

  /** TC-UNIT-12 (R-146b) — the no-deadline path keeps its exact type AND text.
   *
   * GREEN AT PHASE 1 BY CONSTRUCTION: it pins behaviour that must SURVIVE the change, so it cannot
   * be red before it. Its power is shown by mutation (any rewording of the saturation branch, or
   * letting the new 4th parameter reach that branch, kills the string equality). The other half of
   * R-146b is the 17 cases above, which this task did not edit. */
  /**
   * **The pinned string changed once, in task 014-20, and deliberately.** R-9.4 requires a limiter
   * refusal to name the bucket's remainder and its ceiling: before the shared limiter a saturated
   * bucket was a fact about one process, and with two sessions against one row "the wait was 40 s"
   * cannot tell a bucket configured too tight from a bucket another tenant drained. The prefix —
   * everything R-146b pinned — is unchanged; the parenthetical is the addition.
   */
  it('TC-UNIT-12: with no deadline the saturation rejection names the bucket and nothing else', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    const config = { capacity: 1, refillPerSec: 0.001 };

    await throttle('saturated-provider', config);
    const error = await throttle('saturated-provider', config, 1, undefined).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RateLimitRejectedError);
    expect((error as Error).message).toBe(
      'throttle: rejected for provider "saturated-provider": computed wait 1000000ms exceeds the ' +
        '30000ms fairness cap (saturated bucket) (bucket remaining -1 of ceiling 1 at 0.001/s)',
    );
    // The same two numbers as FIELDS, because a message is for an operator and a field is what a
    // caller can act on without parsing prose.
    expect((error as RateLimitRejectedError).bucket).toStrictEqual({
      remaining: -1,
      ceiling: 1,
      refillPerSec: 0.001,
    });
    expect(clock.wait).not.toHaveBeenCalled();
  });
});

/**
 * Adversarial cycle 2, finding F-2 — the refusal tests what the wait LEAVES, not whether it fits.
 *
 * The hole the four cases above could not see: every one of them makes `waitMs` STRICTLY greater
 * than `remainingMs`, so all four are green under `waitMs > remainingMs` and under
 * `remainingMs - waitMs < floor` alike. What was admitted was the whole band in between — starting
 * with the exact equality, which the old comparison let through by construction. A caller admitted
 * there sleeps out its entire budget and wakes with nothing, and the layer below then answers with
 * `DeadlineExceededError`, the class that ENDS the traversal for every adapter behind it. The
 * registry-level consequence is `TC-F2-INT` in `registry.deadline.test.ts`; these two cases pin the
 * arithmetic that causes it.
 */
describe('cycle 2 F-2 — a wait that leaves no useful budget is refused, not served', () => {
  /** The floor is `MIN_POST_WAIT_REMAINDER_MS`, a module-private constant (like `MAX_WAIT_MS`,
   * which `rate-limit.test.ts` has always mirrored rather than imported). 5 000 ms — the shortest
   * `REQUEST_TIMEOUT_MS` any adapter in the repo configures. */
  const FLOOR_MS = 5_000;

  it('TC-F2-UNIT-a: waitMs === remainingMs refuses instead of sleeping the budget away', async () => {
    const clock = fakeClock();
    const throttle = createThrottle(clock);
    const config = { capacity: 1, refillPerSec: 2 }; // 500 ms per token

    await throttle('blockscout', config); // consumes the only token; the next call needs 500 ms

    const error = await throttle('blockscout', config, 1, clock.now() + 500).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DeadlineWouldExceedError);
    // The class matters as much as the refusal: the terminal one would cancel the next provider.
    expect(error).not.toBeInstanceOf(DeadlineExceededError);
    expect(clock.wait).not.toHaveBeenCalled();
    // The refund is what keeps a refused call from worsening the backlog it refused over.
    await throttle('blockscout', config);
    expect(clock.waitCalls).toEqual([500]);
  });

  it('TC-F2-UNIT-b: the boundary is the floor — one ms under refuses, exactly the floor waits', async () => {
    const config = { capacity: 1, refillPerSec: 2 }; // 500 ms per token

    // Under the floor by 1 ms: 500 ms of wait against 5 499 ms left leaves 4 999 ms.
    const tight = fakeClock();
    const tightThrottle = createThrottle(tight);
    await tightThrottle('blockscout', config);
    const error = await tightThrottle(
      'blockscout',
      config,
      1,
      tight.now() + 500 + FLOOR_MS - 1,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeadlineWouldExceedError);
    expect((error as DeadlineWouldExceedError).minRemainderMs).toBe(FLOOR_MS);
    expect((error as Error).message).toContain('4999ms of the 5499ms');
    expect(tight.wait).not.toHaveBeenCalled();

    // Exactly the floor: the same wait against 5 500 ms leaves 5 000 ms, and is served.
    const ample = fakeClock();
    const ampleThrottle = createThrottle(ample);
    await ampleThrottle('blockscout', config);
    await expect(
      ampleThrottle('blockscout', config, 1, ample.now() + 500 + FLOOR_MS),
    ).resolves.toBeUndefined();
    expect(ample.waitCalls).toEqual([500]);
  });
});

/**
 * Adversarial cycle 3 (performance critic) — the floor was a PREDICTION, and nothing measured it.
 *
 * `remainingMs - waitMs >= floor` is evaluated before `await wait(waitMs)`. A timer is only
 * guaranteed not to fire early; it may fire arbitrarily late. So on a loaded event loop the call
 * admitted by that arithmetic wakes with less than the floor anyway, issues its hop, and produces
 * exactly the `DeadlineExceededError` — the TERMINAL class — that F-2 added the floor to avoid. The
 * guarantee the constant's docstring states ("blockscout's own hop timeout expires no later than the
 * deadline does") was therefore a property of the scheduler, not of this function.
 *
 * The clock below overruns every wait by a fixed amount, which is the only way to make the
 * difference between predicting and measuring observable at all.
 */
describe('cycle 3 — the floor is re-checked AFTER the wait, not only predicted before it', () => {
  const FLOOR_MS = 5_000;

  /** `fakeClock`, except every wait costs `overrunMs` more than it was asked for. */
  function overrunningClock(overrunMs: number, startMs = 0) {
    let current = startMs;
    const waitCalls: number[] = [];
    return {
      now: () => current,
      wait: vi.fn((ms: number) => {
        waitCalls.push(ms);
        current += ms + overrunMs;
        return Promise.resolve();
      }),
      waitCalls,
    };
  }

  it('TC-C3-UNIT-a: an overrunning wait is refused on waking, as `observed`', async () => {
    const clock = overrunningClock(200);
    const throttle = createThrottle(clock);
    const config = { capacity: 1, refillPerSec: 2 }; // 500 ms per token

    await throttle('blockscout', config); // consumes the only token

    // 500 ms of wait against 5 500 ms leaves exactly the floor — admitted by TC-F2-UNIT-b above.
    const error = await throttle('blockscout', config, 1, clock.now() + 500 + FLOOR_MS).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DeadlineWouldExceedError);
    // Not the terminal class: an overrun is still a fact about THIS provider's bucket, so the
    // adapters behind it must still be asked.
    expect(error).not.toBeInstanceOf(DeadlineExceededError);
    expect((error as DeadlineWouldExceedError).phase).toBe('observed');
    // 5 500 − (500 + 200): what was MEASURED, not what was predicted.
    expect((error as DeadlineWouldExceedError).remainingMs).toBe(4_800);
    // The refusal is post-wake — the wait really was served, which is what distinguishes this case
    // from the predicted one (`expect(clock.wait).not.toHaveBeenCalled()` there).
    expect(clock.waitCalls).toEqual([500]);
  });

  it('TC-C3-UNIT-b: the post-wake refusal does NOT refund — the wait earned the token', async () => {
    // The other two refusals refund because they never waited. This one slept the full interval, and
    // the deficit it leaves is repaid by the lazy refill the next caller performs. Refunding as well
    // would credit the bucket twice for one interval; the next wait is where that shows.
    const clock = overrunningClock(200);
    const throttle = createThrottle(clock);
    const config = { capacity: 1, refillPerSec: 2 };

    await throttle('blockscout', config);
    const refused = await throttle('blockscout', config, 1, clock.now() + 500 + FLOOR_MS).catch(
      (caught: unknown) => caught,
    );
    // The premise, stated: this case is about the POST-WAKE path, and says nothing about a call
    // that was simply admitted. (Without this, the case passes identically when no post-wake check
    // exists at all — it discriminates only the `bucket.tokens += weight` mutant below.)
    expect(refused).toBeInstanceOf(DeadlineWouldExceedError);
    expect((refused as DeadlineWouldExceedError).phase).toBe('observed');

    // t = 700 ms, bucket still at −1. The refill owed for 700 ms is 1.4 tokens, so this caller is
    // 0.6 short and waits 300 ms. Had the refusal refunded, the bucket would be full and this would
    // not wait at all — a token created out of a refusal.
    await throttle('blockscout', config);
    expect(clock.waitCalls.map((ms) => Math.round(ms))).toEqual([500, 300]);
  });

  it('TC-C3-UNIT-c: a wait that does NOT overrun is still served — the check is not a tax', async () => {
    const clock = overrunningClock(0);
    const throttle = createThrottle(clock);
    const config = { capacity: 1, refillPerSec: 2 };

    await throttle('blockscout', config);
    await expect(
      throttle('blockscout', config, 1, clock.now() + 500 + FLOOR_MS),
    ).resolves.toBeUndefined();
    expect(clock.waitCalls).toEqual([500]);
  });
});
