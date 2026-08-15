import { describe, expect, it } from 'vitest';
import { createSingleflight } from '../src/adapters/nansen/singleflight.js';

/**
 * Task 014-30, TC-UNIT-10 — the follower announces itself; the leader does not.
 *
 * **Why a callback and not a field on the result.** Leader and follower receive the SAME promise and
 * the same value. The fact distinguishes CALLERS, not answers, so it cannot travel in the result —
 * which is why `singleflight` gained a fourth parameter rather than a wrapper type.
 *
 * **What it is for.** One vendor call served two charges. The owner's model is that both clients pay
 * (OQ-6), so a follower's row in `request_trace` is a paid request that made no vendor call. Without
 * this signal the number of charges one vendor call produced is unrecoverable from the ledger — and
 * that number is exactly what T-015 reconciles against `usage` (R-27.3).
 */

/** A promise plus the handle that settles it, so a test controls when the leader finishes. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('TC-UNIT-10: `onCoalesced` fires for the follower and only the follower', () => {
  it('the second caller on one key is marked, the first is not', async () => {
    const singleflight = createSingleflight();
    const gate = deferred<string>();
    const marked: string[] = [];

    // No `await` between the two starts — the entry is stored synchronously before `fn()`'s first
    // suspension, which is the precondition the whole mechanism rests on.
    const leader = singleflight(
      'k',
      () => gate.promise,
      undefined,
      () => marked.push('leader'),
    );
    const follower = singleflight(
      'k',
      () => gate.promise,
      undefined,
      () => marked.push('follower'),
    );

    gate.resolve('one answer');
    expect(await leader).toBe('one answer');
    expect(await follower).toBe('one answer');
    // Called once, by the second caller. A leader that announced itself would make every row
    // `coalesced` and the ledger would attribute the vendor spend to nobody.
    expect(marked).toStrictEqual(['follower']);
  });

  it('a lone caller is never marked', async () => {
    const singleflight = createSingleflight();
    let marks = 0;
    await singleflight(
      'k',
      () => Promise.resolve(1),
      undefined,
      () => {
        marks += 1;
      },
    );
    expect(marks).toBe(0);
  });

  it('a caller arriving AFTER the first settled is a new leader, not a follower', async () => {
    // The entry is deleted in `finally`, so a later call is a genuinely new-in-time request. Marking
    // it would report a coalesce that never happened and hide a real second vendor call.
    const singleflight = createSingleflight();
    const marked: string[] = [];
    await singleflight(
      'k',
      () => Promise.resolve(1),
      undefined,
      () => marked.push('first'),
    );
    await singleflight(
      'k',
      () => Promise.resolve(2),
      undefined,
      () => marked.push('second'),
    );
    expect(marked).toStrictEqual([]);
  });

  it('the parameter is optional — every existing caller keeps working unchanged', async () => {
    const singleflight = createSingleflight();
    const gate = deferred<number>();
    const leader = singleflight('k', () => gate.promise);
    const follower = singleflight('k', () => gate.promise);
    gate.resolve(7);
    expect(await leader).toBe(7);
    expect(await follower).toBe(7);
  });

  it('marks the follower BEFORE the shared promise is handed back, not when it settles', async () => {
    // Synchronously, so a walk that records the flag beside `attempted` sees it whatever the leader
    // does next — including a leader that never settles inside this test.
    const singleflight = createSingleflight();
    const gate = deferred<number>();
    let marked = false;
    void singleflight('k', () => gate.promise);
    void singleflight(
      'k',
      () => gate.promise,
      undefined,
      () => {
        marked = true;
      },
    );
    expect(marked, 'the flag was deferred to settlement').toBe(true);
    gate.resolve(1);
  });
});
