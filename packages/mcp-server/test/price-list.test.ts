import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICE_RAW, PRICE_LIST, priceFor } from '../src/billing/price-list.js';
import * as PriceListModule from '../src/billing/price-list.js';

/**
 * Task 015-05 — the price list: `capability ?? tool` lookup, TEXT value, no version field.
 *
 * Source: docs/tasks/task-015-05-price-list.md, TC-UNIT-01 through TC-UNIT-06.
 * The lookup key order and the DEFAULT_PRICE_RAW fallback are R-4.6; the TEXT value is R-4.5;
 * copy-not-reference at reserve time is R-4.2/R-4.3/AC-8/AC-9; two independently priced tools is
 * AC-43.
 */

describe('price-list (task 015-05)', () => {
  it('TC-UNIT-01: a missing key resolves to DEFAULT_PRICE_RAW', () => {
    const result = priceFor('token.holders', 'onchain_token_holders', {});
    expect(result).toBe('1');
    expect(result).toBe(DEFAULT_PRICE_RAW);
  });

  it('TC-UNIT-02: a declared capability outranks the tool name', () => {
    const priceList = { 'token.holders': '5', onchain_token_holders: '7' };
    const result = priceFor('token.holders', 'onchain_token_holders', priceList);
    expect(result).toBe('5');
  });

  it('TC-UNIT-03: a tool with no static capability is looked up by its wire name', () => {
    const priceList = { onchain_ping: '3' };
    const result = priceFor(null, 'onchain_ping', priceList);
    expect(result).toBe('3');
  });

  it('TC-UNIT-04 (AC-43): two tools with different prices each resolve to their own', () => {
    const priceList = { 'token.holders': '5', 'chain.transactions': '2' };
    const holdersPrice = priceFor('token.holders', 'onchain_token_holders', priceList);
    const transactionsPrice = priceFor(
      'chain.transactions',
      'onchain_chain_transactions',
      priceList,
    );
    expect(holdersPrice).toBe('5');
    expect(transactionsPrice).toBe('2');
  });

  it('TC-UNIT-05 (AC-9): a later price-list edit does not change an already-read price', () => {
    const priceListV1 = { 'token.holders': '5' };
    const priceListV2 = { 'token.holders': '9' };

    const priceAtReserve = priceFor('token.holders', 'onchain_token_holders', priceListV1);
    // Simulate the copy into a ledger row (client_usage.price_raw), the way R-4.2/R-4.3 require.
    const ledgerRow = { price_raw: priceAtReserve };

    // The price list moves on; the already-written ledger row must not.
    expect(ledgerRow.price_raw).toBe('5');
    expect(priceFor('token.holders', 'onchain_token_holders', priceListV2)).toBe('9');
    expect(ledgerRow.price_raw).toBe('5');
  });

  it('TC-UNIT-06: the module exports exactly DEFAULT_PRICE_RAW, PRICE_LIST and the lookup function, and PRICE_LIST is frozen', () => {
    expect(Object.keys(PriceListModule).sort()).toEqual(
      ['DEFAULT_PRICE_RAW', 'PRICE_LIST', 'priceFor'].sort(),
    );
    expect(Object.isFrozen(PRICE_LIST)).toBe(true);
  });
});
