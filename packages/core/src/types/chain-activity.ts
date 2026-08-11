import { z } from 'zod';

/**
 * Canonical chain-activity entities (WI-51) — what a chain costs to use, and how much it is used.
 *
 * WI-51 named three gaps: gas price, transaction counts, and ACTIVE ADDRESSES. Two are filled here
 * and the third deliberately is not — see `ChainTransactionsSchema` for why the field that looks
 * like it (`total_addresses`) is not it, and what publishing it anyway would have cost.
 *
 * @module
 */

/**
 * What one unit of gas costs right now.
 *
 * **Two sources, two shapes, and the split is the whole design.** A node (`rpc-evm`) answers
 * `eth_gasPrice` with an exact integer of wei and nothing else; an indexer (`blockscout`) answers
 * with three rounded Gwei floats and a timestamp saying when it measured. Flattening those into one
 * "gas price" number would mean either inventing tiers a node never gave or claiming wei precision
 * for a vendor's rounded float. So both forms are carried, each nullable, and a null means "this
 * source does not state it" rather than zero.
 */
export const GasPriceSchema = z
  .object({
    chain: z.string(),
    /**
     * Exact wei, as a decimal string — DB-SCHEMA-CONCEPT §1.7. Only a node can assert this, so it
     * is null on indexer-sourced answers.
     *
     * A string rather than a number for the reason every on-chain integer in this repo is: gas
     * prices are ordinary at 1e9–1e12 wei today, which fits, but the type has to hold for the chain
     * that prices gas in something larger, and "fits today" is how `amountRaw` got its own lesson.
     * 78 is the decimal width of 2^256-1.
     */
    gasPriceWei: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .max(78)
      .nullable(),
    /**
     * The lossy Gwei projection — DB-SCHEMA-CONCEPT §1.7's `value_num` idiom, for charts and for
     * comparing two chains at a glance.
     *
     * Derived from `gasPriceWei` when that is exact (a unit conversion, not an estimate), and taken
     * from the vendor's own `average` otherwise. It is therefore NOT always the same statistic:
     * on the node path it is what the node suggests, on the indexer path it is the middle of three
     * published tiers. Both answer "roughly what will this cost", which is the question; a caller
     * that needs the exact figure reads `gasPriceWei` and gets a null where none exists.
     */
    gasPriceGwei: z.number().nonnegative().nullable(),
    /**
     * Tiered estimates, when the source publishes them. Null — never three copies of one number —
     * when it does not: a node states one price, and spreading it across `slow`/`fast` would
     * manufacture a confidence interval nobody measured.
     */
    tiers: z
      .object({
        slowGwei: z.number().nonnegative(),
        averageGwei: z.number().nonnegative(),
        fastGwei: z.number().nonnegative(),
      })
      .nullable(),
    /**
     * The native gas token's symbol.
     *
     * Carried for the reason `rpc-evm` learned the hard way on balances (its H-3): a bare number
     * labelled with the wrong unit is a wrong answer that looks right. 386 Gwei on polygon is POL
     * and 0.3 Gwei on ethereum is ETH, and an agent comparing "gas price" across the two without
     * the symbol concludes polygon is a thousand times more expensive.
     */
    nativeSymbol: z.string().max(32).nullable(),
    /**
     * When the SOURCE says it measured, epoch-ms UTC — not when we fetched.
     *
     * Blockscout stamps this (`gas_price_updated_at`) and it genuinely moves: two probes 45 s apart
     * carried different stamps. A node states nothing, so it is null there. The distinction matters
     * because a gas price is the most perishable number this engine serves, and `fetchedAt` answers
     * a different question — how fresh OUR copy is, not how fresh the vendor's is.
     */
    measuredAt: z.number().int().nullable(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();

export type GasPrice = z.infer<typeof GasPriceSchema>;

/**
 * How much a chain is used.
 *
 * **The field WI-51 asked for and this type does not have: active addresses.** The vendor publishes
 * `total_addresses` — 704 045 987 on ethereum — and it is cumulative since genesis, not active in
 * any window. Nothing else in the payload is an activity-scoped address count. Mapping the
 * cumulative figure onto a field called `activeAddresses` would be the exact substitution WI-51
 * warned about in its own words («подменять одну другой без оговорки было бы подлогом»), and it
 * would be undetectable downstream: 704 million is a plausible-looking number that no consumer can
 * tell apart from a real one. So the gap stays open and named, in the record and in the tool
 * description, rather than closed with a number that means something else.
 */
export const ChainTransactionsSchema = z
  .object({
    chain: z.string(),
    /**
     * The vendor's DAILY transaction aggregate.
     *
     * Named for how it behaves, not for how the vendor labels it. The field is `transactions_today`,
     * which reads as a running count of the current day — measured 2026-08-11, it is not: across
     * 45 s in which `total_blocks` advanced by 10 and the gas stamp moved twice, this number did not
     * change at all. It is a periodically-recomputed daily figure, so a caller must not read it as
     * "so far today" and must not difference two readings to get a rate.
     *
     * This is the same two-clock split the snapshotter already runs on (CLAUDE.n8n.md): immutable
     * per-block facts advance continuously, revisable daily aggregates do not.
     */
    transactionsPerDay: z.number().int().nonnegative().nullable(),
    /** Cumulative since genesis. Unambiguous, and the only honest denominator for a share. */
    totalTransactions: z.number().int().nonnegative().nullable(),
    /** Cumulative since genesis. */
    totalBlocks: z.number().int().nonnegative().nullable(),
    /** Mean block interval in milliseconds, as the vendor computes it. */
    averageBlockTimeMs: z.number().nonnegative().nullable(),
    /**
     * Percent of block gas capacity in use, as the vendor computes it. The closest thing in this
     * payload to "how busy is the chain" that is actually scoped to now rather than to all time.
     */
    networkUtilizationPct: z.number().nonnegative().nullable(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();

export type ChainTransactions = z.infer<typeof ChainTransactionsSchema>;
