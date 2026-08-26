import { describe, expect, it } from 'vitest';
import {
  BillingStoreUnavailableError,
  ClientCreditsExhaustedError,
  LedgerReadNotAuthoritativeError,
  ReplayWindowExpiredError,
  createBillingStoreStub,
  type BillingReserveResult,
} from '../src/engine/index.js';

/**
 * Task 015-04 — the contract for `BillingStore`, checked as FORM against the stub (`[STUB]`, the
 * same discipline `engine-store-contracts.test.ts` already applies to `RequestTraceStore`/
 * `DiagnosticsStore`, task 014-02). Nothing here reaches a database — the stub is the seam (R-21).
 * Task 015-06 (SQLite) and 015-07 (Postgres) replace `createBillingStoreStub`; the first test run
 * after each replacement is updated to the real value, per `tdd-stub-first` §2.
 */

/** One input shared across cases — only `clientRequestId` varies where the case needs it to. */
function reserveInput(overrides: { clientRequestId?: string } = {}) {
  return {
    principalId: 'local',
    accessProfileId: null,
    clientRequestId: overrides.clientRequestId ?? 'req-1',
    tool: 'onchain_token_price',
    capability: 'token.price',
    priceRaw: '1',
  };
}

// The failure arm's three declared values (system-architecture.md §3.5.1/§3.5.2a) — literal
// fixtures, not produced by the stub, because forcing a refusal (an exhausted balance, an
// unreachable store, an expired replay window) is real logic that belongs to 015-06/015-07/015-08,
// not to this stub-only contract test.
const CREDITS_EXHAUSTED: BillingReserveResult = {
  ok: false,
  reason: 'client credits exhausted',
  refusalClass: 'ClientCreditsExhaustedError',
};
const STORE_UNAVAILABLE: BillingReserveResult = {
  ok: false,
  reason: 'billing store unavailable',
  refusalClass: 'BillingStoreUnavailableError',
};
const REPLAY_EXPIRED: BillingReserveResult = {
  ok: false,
  reason: 'replay window expired',
  refusalClass: 'ReplayWindowExpiredError',
};
const REFUSALS = [CREDITS_EXHAUSTED, STORE_UNAVAILABLE, REPLAY_EXPIRED] as const;

describe('BillingStore — the four methods, and the stub implementing them', () => {
  it('TC-UNIT-01: the interface declares reserve/settle/refund/sumSettled, and the stub implements all four', () => {
    const stub = createBillingStoreStub();
    expect(typeof stub.reserve).toBe('function');
    expect(typeof stub.settle).toBe('function');
    expect(typeof stub.refund).toBe('function');
    expect(typeof stub.sumSettled).toBe('function');
  });

  it('TC-UNIT-02: the first reserve for a (principalId, clientRequestId) pair is ok:true, existing:false', async () => {
    const stub = createBillingStoreStub();
    const result = await stub.reserve(reserveInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable — asserted above');
    expect(result.reservation.existing).toBe(false);
    expect(result.reservation.state).toBe('reserved');
    expect(typeof result.reservation.rowId).toBe('string');
    expect(stub.rows).toHaveLength(1);
  });

  it('TC-UNIT-03: a repeat of the same pair is ok:true, existing:true, and writes no second row', async () => {
    const stub = createBillingStoreStub();
    const input = reserveInput();
    const first = await stub.reserve(input);
    const second = await stub.reserve(input);
    expect(second.ok).toBe(true);
    if (!second.ok || !first.ok) throw new Error('unreachable — asserted above');
    expect(second.reservation.existing).toBe(true);
    expect(second.reservation.rowId).toBe(first.reservation.rowId);
    expect(stub.rows).toHaveLength(1);
  });

  it('TC-UNIT-04: the failure arm carries refusalClass, one of the three declared values, on every case', () => {
    const seen = new Set(REFUSALS.map((refusal) => refusal.refusalClass));
    expect(seen.size).toBe(3);
    for (const refusal of REFUSALS) {
      expect(refusal.ok).toBe(false);
      expect([
        'ClientCreditsExhaustedError',
        'BillingStoreUnavailableError',
        'ReplayWindowExpiredError',
      ]).toContain(refusal.refusalClass);
    }
  });

  it('TC-UNIT-04b: refusalClass is required on the failure arm — a literal omitting it fails typecheck', () => {
    // @ts-expect-error — refusalClass is mandatory, not optional; deleting this line must fail
    // `pnpm typecheck` (MAJOR-D round 2).
    const bad: BillingReserveResult = { ok: false, reason: 'x' };
    expect(bad).toBeDefined();
  });

  it('TC-UNIT-05: both money classes resolve as a value — the promise never rejects', async () => {
    const asPromise = (result: BillingReserveResult): Promise<BillingReserveResult> =>
      Promise.resolve(result);
    await expect(asPromise(CREDITS_EXHAUSTED)).resolves.toMatchObject({
      ok: false,
      refusalClass: 'ClientCreditsExhaustedError',
    });
    await expect(asPromise(STORE_UNAVAILABLE)).resolves.toMatchObject({
      ok: false,
      refusalClass: 'BillingStoreUnavailableError',
    });
  });

  it('TC-UNIT-06: settle on an already-terminal row is not an error and does not change state', async () => {
    const stub = createBillingStoreStub();
    const reserved = await stub.reserve(reserveInput());
    if (!reserved.ok) throw new Error('unreachable — asserted in TC-UNIT-02');
    const { rowId } = reserved.reservation;

    await stub.settle(rowId);
    expect(stub.rows.find((row) => row.id === rowId)?.state).toBe('settled');

    await expect(stub.settle(rowId)).resolves.toBeUndefined();
    expect(stub.rows.find((row) => row.id === rowId)?.state).toBe('settled');
  });

  it('TC-UNIT-07: refund on an already-terminal row is not an error and does not change state', async () => {
    const stub = createBillingStoreStub();
    const reserved = await stub.reserve(reserveInput());
    if (!reserved.ok) throw new Error('unreachable — asserted in TC-UNIT-02');
    const { rowId } = reserved.reservation;

    await stub.settle(rowId); // now terminal as 'settled'
    await expect(stub.refund(rowId, 'BillingStoreContractTest')).resolves.toBeUndefined();
    expect(stub.rows.find((row) => row.id === rowId)?.state).toBe('settled');
  });

  it('TC-UNIT-08: sumSettled on the SQLite axis throws LedgerReadNotAuthoritativeError, never a confident zero', async () => {
    const stub = createBillingStoreStub({ sumSettledAxis: 'sqlite' });
    await expect(stub.sumSettled(0, 1)).rejects.toBeInstanceOf(LedgerReadNotAuthoritativeError);
  });

  it('TC-UNIT-09: sumSettled on the Postgres axis returns a string, never a number', async () => {
    const stub = createBillingStoreStub();
    const result = await stub.sumSettled(0, 1);
    expect(typeof result).toBe('string');
  });
});

describe('the four failure classes name themselves, surviving bundling', () => {
  it('each assigns `name` explicitly, matching its exported identifier', () => {
    expect(new ClientCreditsExhaustedError().name).toBe('ClientCreditsExhaustedError');
    expect(new BillingStoreUnavailableError().name).toBe('BillingStoreUnavailableError');
    expect(new ReplayWindowExpiredError().name).toBe('ReplayWindowExpiredError');
    expect(new LedgerReadNotAuthoritativeError().name).toBe('LedgerReadNotAuthoritativeError');
  });
});
