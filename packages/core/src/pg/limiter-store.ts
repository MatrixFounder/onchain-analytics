import type { StateClient } from './state-client.js';

/**
 * Thrown by the slot operator that task 014-18 owns and this task deliberately does not write.
 *
 * **Why a class of its own rather than a plain `Error`.** R-7.7 degrades the limiter to an
 * in-process bucket when its STORE fails, and that fallback is reached by catching a throw
 * (`system-architecture.md` §3.4.4, task 014-19). An anonymous throw from an unwritten operator
 * would land in that catch and be indistinguishable from a Postgres outage: the process would
 * announce a degraded limiter, write a `limiter.degraded` diagnostics row, and keep running against
 * a per-process ceiling forever — a green path that never names the real reason (L-10). A named
 * class lets 014-19 tell "the store is unreachable" from "this axis has no operator yet", and lets
 * a test assert on the difference.
 */
export class LimiterOperatorNotImplementedError extends Error {
  constructor(readonly member: string) {
    super(
      `PgLimiterStore.${member}() is not implemented — the atomic slot operator is task 014-18 ` +
        `(data-model.md §4.5.6). This is NOT a storage failure: R-7.7's in-process fallback must ` +
        `not treat it as one.`,
    );
    this.name = 'LimiterOperatorNotImplementedError';
  }
}

/** Constructor options for `PgLimiterStore`. */
export interface PgLimiterStoreOptions {
  /** The write-capable client (`createStateClient`) — the same one the cache and budget stores of
   * this axis take, so all three share one pool and one role. */
  client: StateClient;
}

/**
 * The Postgres axis's limiter store: its client and its place in the axis (`system-architecture.md`
 * §3.4.4, `data-model.md` §4.5.6). The atomic slot operator is task 014-18 and is NOT written here.
 *
 * **What this task delivers and what it withholds.** The class exists so the axis table of §3.4.8
 * has a third row that resolves to something, and so 014-18 lands one method into an already-wired
 * store rather than a new file plus its wiring. The operator itself is withheld because writing it
 * would mean writing the statement of §4.5.6 — refill, consume and read in one
 * `INSERT … ON CONFLICT … RETURNING` — together with the `LEAST`/`MIN` dialect split, the clock
 * sample that must be taken AFTER the store answers, and the post-wait re-check. That is a design
 * another task owns, and a plausible-looking guess at it would be the worst of the three possible
 * outcomes: a limiter that runs and is wrong.
 *
 * **Why `provider_buckets` needs no bootstrap here.** `provider_buckets.provider` references
 * `onchain.providers`, whose twelve rows `PgBudgetStore` upserts at construction. `pg/stores.ts`
 * builds the two together, which is what makes that ordering a property of the axis rather than of
 * a call site.
 */
export class PgLimiterStore {
  private readonly client: StateClient;

  constructor(options: PgLimiterStoreOptions) {
    this.client = options.client;
  }

  /**
   * Refills, consumes and reads one bucket in a single statement, returning the tokens left after
   * this caller's `weight` was taken (negative means a backlog the next caller waits out).
   *
   * **Not implemented — task 014-18.** The parameter list is fixed here because it is already fixed
   * elsewhere: it is the parameter list of the statement in `data-model.md` §4.5.6 (`$3` capacity,
   * `$4` weight, `$5` now, `$6` `refillPerSec`) keyed by `(provider, scope_key)` per R-7.3, with
   * `scopeKey` defaulting to `''` — one bucket per provider (R-7.4). Declaring it now is what keeps
   * 014-18 to a body, and keeps this class from being a name with no shape.
   *
   * `client` is held for that task and used by nothing yet; the reference below is what makes that
   * a stated fact rather than an unused field a future reader would delete.
   */
  takeTokens(
    provider: string,
    scopeKey: string,
    capacityTokens: number,
    weight: number,
    nowMs: number,
    refillPerSec: number,
  ): Promise<number> {
    // The parameters are referenced rather than underscored away: each one is already fixed by the
    // statement in §4.5.6, and a tidy-up that trimmed the signature to `()` would leave 014-18 to
    // re-derive it from the document. One expression, no behaviour.
    void [this.client, provider, scopeKey, capacityTokens, weight, nowMs, refillPerSec];
    throw new LimiterOperatorNotImplementedError('takeTokens');
  }
}
