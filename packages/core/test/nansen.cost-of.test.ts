import { describe, expect, it } from 'vitest';
import { createNansenAccountState } from '../src/adapters/nansen/account-state.js';
import { costOf } from '../src/adapters/nansen/cost-of.js';

// Pure-function coverage of costOf()'s capability -> (method,path) -> price mapping
// (system-architecture.md §3.2 "Cost-table generation", task 005-3's own capability table). Every
// case here is table-lookup arithmetic — no network, no BudgetStore, no adapter at all.

describe('costOf() — capability x args -> exact credit price (R-37)', () => {
  it('smart-money.flows always sums BOTH netflow (5) + tgm/holders (5) = 10, regardless of args', () => {
    const accountState = createNansenAccountState();
    expect(costOf(accountState, 'smart-money.flows', {})).toBe(10);
    expect(costOf(accountState, 'smart-money.flows', { tokenAddress: '0xabc' })).toBe(10);
  });

  it('entity.labels default (query-only, no tokenAddress) = 0 (search/general + search/entity-name)', () => {
    const accountState = createNansenAccountState();
    expect(costOf(accountState, 'entity.labels', {})).toBe(0);
    expect(costOf(accountState, 'entity.labels', { query: 'wintermute' })).toBe(0);
  });

  it('entity.labels token-scoped (tokenAddress, no exhaustive) = 5 (+ tgm/holders)', () => {
    const accountState = createNansenAccountState();
    expect(costOf(accountState, 'entity.labels', { tokenAddress: '0xabc' })).toBe(5);
  });

  it('entity.labels exhaustive:true = 100 (ONLY profiler/address/labels — does not also dupe the cheap path)', () => {
    const accountState = createNansenAccountState();
    expect(costOf(accountState, 'entity.labels', { tokenAddress: '0xabc', exhaustive: true })).toBe(
      100,
    );
  });

  it('a non-string tokenAddress is treated as absent (falls back to the 0cr default mapping)', () => {
    const accountState = createNansenAccountState();
    expect(costOf(accountState, 'entity.labels', { tokenAddress: 12345 })).toBe(0);
  });

  it('token.risk always sums BOTH tgm/indicators (5) + tgm/token-information (1) = 6', () => {
    const accountState = createNansenAccountState();
    expect(costOf(accountState, 'token.risk', {})).toBe(6);
  });

  it('premium_labels:true on smart-money.flows replaces the 5cr tgm/holders leg with a flat 150 (netflow 5 + 150 = 155)', () => {
    const accountState = createNansenAccountState();
    expect(costOf(accountState, 'smart-money.flows', { premium_labels: true })).toBe(155);
  });

  it('premium_labels:true on entity.labels token-scoped = exactly 150 (0 + 0 + 150, the real UC-3 refusal case)', () => {
    const accountState = createNansenAccountState();
    expect(
      costOf(accountState, 'entity.labels', { tokenAddress: '0xabc', premium_labels: true }),
    ).toBe(150);
  });

  it('premium_labels:true is a no-op on the exhaustive escalation path (no tgm/holders leg to upgrade)', () => {
    const accountState = createNansenAccountState();
    expect(
      costOf(accountState, 'entity.labels', {
        tokenAddress: '0xabc',
        exhaustive: true,
        premium_labels: true,
      }),
    ).toBe(100);
  });

  it('defaults to plan "free" before any /account resync ever populates a snapshot', () => {
    const accountState = createNansenAccountState();
    expect(accountState.get()).toBeUndefined();
    expect(costOf(accountState, 'token.risk', {})).toBe(6);
  });

  it('reads the live "pro" plan once accountState has a snapshot (values unchanged — free===pro on every real M2 endpoint)', () => {
    const accountState = createNansenAccountState();
    accountState.set({
      plan: 'pro',
      creditsRemainingAtObserve: 100000,
      usageAtObserve: 0,
      observedAtMs: Date.now(),
      dayBucketMs: 0,
    });
    expect(costOf(accountState, 'smart-money.flows', {})).toBe(10);
    expect(costOf(accountState, 'token.risk', {})).toBe(6);
  });

  it('an unrecognized capability id is fail-closed to Number.POSITIVE_INFINITY, NEVER 0 (R-37 MIN-3)', () => {
    const accountState = createNansenAccountState();
    expect(costOf(accountState, 'not-a-real-capability', {})).toBe(Number.POSITIVE_INFINITY);
  });
});
