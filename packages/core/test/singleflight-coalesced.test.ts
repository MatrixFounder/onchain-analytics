import { describe, expect, it } from 'vitest';
import { createSingleflight } from '../src/adapters/nansen/singleflight.js';

/**
 * Task 014-30, TC-UNIT-10 — the follower is announced at ITS OWN settlement and receives whatever
 * the leader published; the leader is never announced.
 *
 * **Why a callback and not a field on the result.** Leader and follower receive the SAME promise and
 * the same value. The fact distinguishes CALLERS, not answers, so it cannot travel in the result.
 *
 * **Why at settlement and not at join — this is the correction OD-014-30-1 rests on.** The first
 * shipped version fired synchronously when a follower joined. At that instant the leader has run
 * only up to its first `await`, so its ledger coordinates do not exist yet; on a cold start it is
 * still inside an `/account` resync a full velocity window later. A follower that must carry the
 * leader's `(day, window)` therefore cannot be told anything useful at join time.
 *
 * **What it is for.** One vendor call served two charges. The owner's model is that both clients pay
 * (OQ-6), so a follower's row in `request_trace` is a paid request that made no vendor call. Without
 * this signal the number of charges one vendor call produced is unrecoverable from the ledger — and
 * that number is exactly what T-015 reconciles against `usage` (R-27.3).
 */

/** A promise plus the handle that settles it, so a test controls when the leader finishes. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('TC-UNIT-10: the follower is announced, the leader is not', () => {
  it('the second caller on one key is announced, the first is not', async () => {
    const singleflight = createSingleflight<string>();
    const gate = deferred<string>();
    const announced: string[] = [];

    // No `await` between the two starts — the entry is stored synchronously before `fn()`'s first
    // suspension, which is the precondition the whole mechanism rests on.
    const leader = singleflight(
      'k',
      () => gate.promise,
      undefined,
      () => announced.push('leader'),
    );
    const follower = singleflight(
      'k',
      () => gate.promise,
      undefined,
      () => announced.push('follower'),
    );

    gate.resolve('one answer');
    expect(await leader).toBe('one answer');
    expect(await follower).toBe('one answer');
    // Called once, by the second caller. A leader that announced itself would make every row
    // `coalesced` and the ledger would attribute the vendor spend to nobody.
    expect(announced).toStrictEqual(['follower']);
  });

  it('a lone caller is never announced', async () => {
    const singleflight = createSingleflight<string>();
    let calls = 0;
    await singleflight(
      'k',
      () => Promise.resolve(1),
      undefined,
      () => {
        calls += 1;
      },
    );
    expect(calls).toBe(0);
  });

  it('a caller arriving AFTER the first settled is a new leader, not a follower', async () => {
    // The entry is deleted in `finally`, so a later call is a genuinely new-in-time request.
    // Announcing it would report a coalesce that never happened and hide a real second vendor call.
    const singleflight = createSingleflight<string>();
    const announced: string[] = [];
    await singleflight(
      'k',
      () => Promise.resolve(1),
      undefined,
      () => announced.push('first'),
    );
    await singleflight(
      'k',
      () => Promise.resolve(2),
      undefined,
      () => announced.push('second'),
    );
    expect(announced).toStrictEqual([]);
  });

  it('both new parameters are optional — every existing caller keeps working unchanged', async () => {
    const singleflight = createSingleflight<string>();
    const gate = deferred<number>();
    const leader = singleflight('k', () => gate.promise);
    const follower = singleflight('k', () => gate.promise);
    gate.resolve(7);
    expect(await leader).toBe(7);
    expect(await follower).toBe(7);
  });

  it('announces the follower at ITS settlement, never when it joins', async () => {
    // The inverse of what the first shipped version asserted, and the reason is not stylistic: at
    // join time the leader has published nothing, so anything handed over then is empty by
    // construction. Mutating the implementation back to a join-time call fails this case.
    const singleflight = createSingleflight<string>();
    const gate = deferred<number>();
    let announced = false;
    void singleflight('k', (publish) => {
      publish('coordinates');
      return gate.promise;
    });
    const follower = singleflight(
      'k',
      () => gate.promise,
      undefined,
      () => {
        announced = true;
      },
    );
    expect(announced, 'announced at join, before the follower had settled').toBe(false);
    gate.resolve(1);
    await follower;
    expect(announced).toBe(true);
  });

  it('hands the follower what the leader published', async () => {
    const singleflight = createSingleflight<{ day: number; window: number | null }>();
    const gate = deferred<number>();
    let received: { day: number; window: number | null } | undefined | 'never called' =
      'never called';

    void singleflight('k', (publish) => {
      // Published asynchronously, after the follower has already joined — the ordering a real
      // leader has, since its coordinates exist only once `ensureBudget()` has resolved.
      return gate.promise.then((value) => {
        publish({ day: 172_800_000, window: 60_000 });
        return value;
      });
    });
    const follower = singleflight(
      'k',
      () => gate.promise,
      undefined,
      (shared) => {
        received = shared;
      },
    );

    gate.resolve(1);
    await follower;
    expect(received).toStrictEqual({ day: 172_800_000, window: 60_000 });
  });

  it('hands the follower `undefined` when the leader published nothing', async () => {
    // The honest state, not a defensive branch: a leader refused by the budget gate committed no
    // reservation, so no coordinate exists. The follower is still announced — "waited on a vendor
    // call whose buckets are unknown" must stay distinguishable from "no vendor was involved".
    const singleflight = createSingleflight<string>();
    const gate = deferred<number>();
    let calls = 0;
    let received: string | undefined = 'not overwritten';

    const leader = singleflight('k', () => gate.promise);
    const follower = singleflight(
      'k',
      () => gate.promise,
      undefined,
      (shared) => {
        calls += 1;
        received = shared;
      },
    );

    gate.reject(new Error('budget refused'));
    await expect(leader).rejects.toThrow('budget refused');
    await expect(follower).rejects.toThrow('budget refused');
    expect(calls).toBe(1);
    expect(received).toBeUndefined();
  });

  it('announces the follower on a rejection, not only on a value', async () => {
    // A follower that shares the leader's failure still made no vendor call of its own, and the
    // request it belongs to is still billable. Announcing only the happy path would drop those rows.
    const singleflight = createSingleflight<string>();
    const gate = deferred<number>();
    let calls = 0;

    const leader = singleflight('k', (publish) => {
      publish('coordinates');
      return gate.promise;
    });
    const follower = singleflight(
      'k',
      () => gate.promise,
      undefined,
      () => {
        calls += 1;
      },
    );

    gate.reject(new Error('sub-call failed'));
    await expect(leader).rejects.toThrow('sub-call failed');
    await expect(follower).rejects.toThrow('sub-call failed');
    expect(calls).toBe(1);
  });
});
