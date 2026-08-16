import { describe, expect, it } from 'vitest';
import type { VendorSpendRecord } from '@onchain-intel/core';
import type { Principal } from '../src/auth/principal.js';
import {
  buildRequestTraceRow,
  outcomeClassOf,
  readClientRequestId,
  servedFromOf,
  type RequestTraceRowInput,
} from '../src/tools/request-trace-row.js';

/**
 * Task 014-30 — assembling one `request_trace` row from what the wrapper observed.
 *
 * The rules here decide what a billing ledger says, so each case is written against a value the test
 * chose rather than against one recomputed the way the implementation computes it.
 */

const PRINCIPAL: Principal = {
  principalId: '01JTOKEN00000000000000000A',
  userId: '01JUSER000000000000000000A',
  accessProfileId: '01JPROFILE0000000000000000',
  role: 'user',
  transport: 'http',
};

const DAY = 1_784_851_200_000;
const WINDOW = 1_784_851_260_000;

const CHARGE: VendorSpendRecord = {
  v: 1,
  kind: 'charge',
  providerId: 'nansen',
  write: 'reservation',
  at: { dayBucketMs: DAY, windowStartMs: WINDOW },
  credits: 10,
  calls: 1,
};

const COALESCED: VendorSpendRecord = {
  v: 1,
  kind: 'coalesced',
  providerId: 'nansen',
  at: { dayBucketMs: DAY, windowStartMs: WINDOW },
  credits: null,
  calls: null,
};

const base = (over: Partial<RequestTraceRowInput> = {}): RequestTraceRowInput => ({
  id: '01JTRACE00000000000000000A',
  receivedAt: 1_784_851_234_000,
  completedAt: 1_784_851_234_500,
  principal: PRINCIPAL,
  clientRequestId: null,
  sessionId: 'sess-1',
  tool: 'onchain_entity_label',
  capability: 'entity.labels',
  argsHash: 'a'.repeat(64),
  ok: true,
  refusalClass: null,
  cacheStatus: 'miss',
  cacheAgeMs: undefined,
  overrunMs: undefined,
  receipts: [],
  ...over,
});

describe('served_from names the source of the ANSWER', () => {
  it('a cache hit reports cache even when the walk spent at a vendor', () => {
    // The decoupling, as a case rather than as a sentence (`OD-014-30-2`): the `entity.labels` walk
    // can enter a paid adapter, pay, and still return an earlier adapter's cached answer.
    expect(servedFromOf(true, 'hit', [CHARGE])).toBe('cache');
  });

  it('a follower reports coalesced, a leader vendor, and neither reports the other', () => {
    expect(servedFromOf(true, 'miss', [COALESCED])).toBe('coalesced');
    expect(servedFromOf(true, 'miss', [CHARGE])).toBe('vendor');
  });

  it('a request that reached neither reports none', () => {
    expect(servedFromOf(true, undefined, [])).toBe('none');
    expect(servedFromOf(true, 'miss', [])).toBe('none');
  });

  it('a refusal was served by nobody, whatever the walk entered', () => {
    // The column names the source of the ANSWER, and a refusal has none. The spend is not lost with
    // it: the five vendor columns are independent of this one.
    expect(servedFromOf(false, 'hit', [CHARGE])).toBe('none');
    expect(servedFromOf(false, 'miss', [COALESCED])).toBe('none');
  });
});

describe('the three outcome classes', () => {
  it('separates a late COMPLETE answer from a refusal', () => {
    // `partial_deadline` settles at full price; folding it into `refusal` would refund a delivered
    // answer and folding it into `answer` would make the overrun invisible in the ledger.
    expect(outcomeClassOf(true, 120)).toBe('partial_deadline');
    expect(outcomeClassOf(true, undefined)).toBe('answer');
    expect(outcomeClassOf(false, undefined)).toBe('refusal');
  });

  it('does not read a zero overrun as late', () => {
    expect(outcomeClassOf(true, 0)).toBe('answer');
  });
});

describe('the incoming _meta key', () => {
  const NS = 'example.com';
  const KEY = 'example.com/client-request-id';

  it('accepts the value only under this deployment s namespace', () => {
    expect(readClientRequestId({ [KEY]: 'req-1' }, NS)).toStrictEqual({
      value: 'req-1',
      nearMiss: null,
    });
  });

  it('accepts nothing when no namespace is configured, and says a key was seen', () => {
    // The unset state must not silently become "accept anything": any default namespace would be a
    // domain we do not own, which is the collision the reverse-DNS form exists to prevent.
    expect(readClientRequestId({ [KEY]: 'req-1' }, undefined)).toStrictEqual({
      value: null,
      nearMiss: KEY,
    });
  });

  it('reports a key under the WRONG namespace instead of silently minting', () => {
    // Without this the operator cannot tell a mis-typed client from a client that sends no id — both
    // mint, and the stream is non-idempotent forever while looking correctly configured (L-10).
    expect(readClientRequestId({ 'other.example/client-request-id': 'req-1' }, NS)).toStrictEqual({
      value: null,
      nearMiss: 'other.example/client-request-id',
    });
  });

  it('reports a present-but-unusable value as a near miss, not as absence', () => {
    // The client believes it supplied an identity. Reporting nothing would leave it believing that.
    expect(readClientRequestId({ [KEY]: 42 }, NS).value).toBeNull();
    expect(readClientRequestId({ [KEY]: 42 }, NS).nearMiss).toBe(KEY);
    expect(readClientRequestId({ [KEY]: '' }, NS).nearMiss).toBe(KEY);
    expect(readClientRequestId({ [KEY]: 'x'.repeat(129) }, NS).nearMiss).toBe(KEY);
  });

  it('is silent when the client sent no metadata at all', () => {
    expect(readClientRequestId(undefined, NS)).toStrictEqual({ value: null, nearMiss: null });
    expect(readClientRequestId({ other: 1 }, NS)).toStrictEqual({ value: null, nearMiss: null });
  });
});

describe('the assembled row', () => {
  it('mints client_request_id as the row s own id, so "minted" is a query', () => {
    const { record } = buildRequestTraceRow(base());
    expect(record.clientRequestId).toBe(record.id);
  });

  it('keeps a client-supplied id distinct from the row id', () => {
    const { record } = buildRequestTraceRow(base({ clientRequestId: 'req-9' }));
    expect(record.clientRequestId).toBe('req-9');
    expect(record.clientRequestId).not.toBe(record.id);
  });

  it('pairs outcome and refusal_class exactly as the CHECK constraint does', () => {
    const refused = buildRequestTraceRow(
      base({ ok: false, refusalClass: 'CapabilityUnavailableError' }),
    ).record;
    expect(refused.outcome).toBe('refusal');
    expect(refused.refusalClass).toBe('CapabilityUnavailableError');

    // A class arriving on a SUCCESSFUL outcome is dropped rather than written: the constraint is an
    // equivalence, so a row with both would be rejected by the engine.
    const answered = buildRequestTraceRow(base({ ok: true, refusalClass: 'Leftover' })).record;
    expect(answered.outcome).toBe('answer');
    expect(answered.refusalClass).toBeNull();
  });

  it('records the spend of a request that failed after paying', () => {
    // The row the four-path table used to forbid. `usage` moved; `served_from` says nobody answered.
    const { record } = buildRequestTraceRow(
      base({
        ok: false,
        refusalClass: 'CapabilityUnavailableError',
        cacheStatus: undefined,
        receipts: [CHARGE, { ...CHARGE, write: 'reconciliation', credits: -5, calls: 0 }],
      }),
    );
    expect(record.outcome).toBe('refusal');
    expect(record.servedFrom).toBe('none');
    expect(record.vendorCredits).toBe(5);
    expect(record.vendorCalls).toBe(1);
    expect(record.vendorProvider).toBe('nansen');
  });

  it('writes cache_age_ms only on a hit', () => {
    expect(
      buildRequestTraceRow(base({ cacheStatus: 'hit', cacheAgeMs: 1200 })).record.cacheAgeMs,
    ).toBe(1200);
    // A miss has no age to report, and a coerced `0` would read as "served from a fresh entry".
    expect(
      buildRequestTraceRow(base({ cacheStatus: 'miss', cacheAgeMs: 1200 })).record.cacheAgeMs,
    ).toBeNull();
  });

  it('leaves escalated_to_paid at zero — paidness is not derived from a receipt', () => {
    // `ADR-003` D6 extends the call counter to any provider, after which a route of two FREE
    // adapters produces receipts. Reading a receipt as evidence of paidness would flag those.
    const { record } = buildRequestTraceRow(base({ receipts: [CHARGE] }));
    expect(record.escalatedToPaid).toBe(0);
  });

  it('carries the principal s identity and transport verbatim', () => {
    const { record } = buildRequestTraceRow(base());
    expect(record.principalId).toBe(PRINCIPAL.principalId);
    expect(record.userId).toBe(PRINCIPAL.userId);
    expect(record.accessProfileId).toBe(PRINCIPAL.accessProfileId);
    expect(record.transport).toBe('http');
  });

  it('reports receipts it could not fit rather than dropping them quietly', () => {
    const { spend } = buildRequestTraceRow(
      base({ receipts: [CHARGE, { ...CHARGE, providerId: 'dune' }] }),
    );
    expect(spend.dropped).toHaveLength(1);
    expect(spend.dropped[0]!.providerId).toBe('dune');
  });
});
