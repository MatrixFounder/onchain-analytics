import type { TransportKind } from '../profile.js';

/**
 * The append-only per-request ledger T-015 charges from (`data-model.md` §4.5.7, R-27).
 *
 * Task 014-02 declares the SHAPE and ships a stub under it. No table is created here — the Postgres
 * declaration is task 014-35, the SQLite one 014-36 — and nothing writes a row yet: task 014-30
 * replaces the stub and wires the four paths that produce one (cache hit, coalesced wait, live
 * vendor call, tool-level refusal).
 *
 * **Why the shape is fixed before the writers exist.** Four paths writing four shapes would give
 * T-015 four sources instead of one. The record below is the single form all four fill in.
 *
 * **Why `mcp-server` and not `core`.** `deployment.md` §10.2.1 places SQL naming
 * `onchain.request_trace` outside `packages/core/src`, and `security.md` §7.5.1 keeps it beside the
 * transport. `principal_id` is on every row, so this table is identity-adjacent by construction.
 *
 * **Why the whole record is written once, at completion.** R-27.7 makes this an append-only ledger,
 * and a reserve-then-update row would not be one. The consequence is stated rather than hidden: a
 * process that dies mid-request leaves no trace row at all. That is the opposite choice from
 * `usage`, which is an additive counter and therefore can reserve and reconcile (§4.2).
 */

/** The three outcome classes of `ADR-003` D4, and nothing else (`data-model.md` §4.5.7).
 *
 * **Why `partial_deadline` cannot be folded into either neighbour.** It settles at FULL price in
 * T-015. Note also what the value does not mean: `reliability.md` §9.1 (owner decision 2026-08-03,
 * R-156) withdrew returning a partial result, so an expired deadline throws and records `refusal`.
 * The surviving branch is a COMPLETE answer delivered past the declared ceiling — the name is kept
 * because it is already a `CHECK` value in a schema two milestones old (§4.5.7a). */
export const REQUEST_TRACE_OUTCOMES = ['answer', 'refusal', 'partial_deadline'] as const;

export type RequestTraceOutcome = (typeof REQUEST_TRACE_OUTCOMES)[number];

/**
 * Where the answer came from — FOUR values, and `coalesced` is the fourth (owner decision
 * 2026-08-13, closing `OQ-T014-SA-1`).
 *
 * **Why the follower is neither `vendor` nor `cache`.** Both clients are charged (OQ-6) and one
 * vendor call served two charges. Folding the follower into either neighbour destroys the count
 * T-015 must trace: how many charges one vendor call produced.
 *
 * **Why `none` is not a synonym for a failure.** A request that neither the cache nor a vendor
 * served still has a row — `onchain_ping` answers without resolving a capability at all (§4.5.7a).
 */
export const REQUEST_TRACE_SERVED_FROM = ['cache', 'coalesced', 'vendor', 'none'] as const;

export type RequestTraceServedFrom = (typeof REQUEST_TRACE_SERVED_FROM)[number];

/**
 * One served request: the twenty-four columns of `data-model.md` §4.5.7, in the declared order.
 *
 * **Eleven fields are NOT NULL and carry no `| null`:** `id`, `receivedAt`, `completedAt`,
 * `principalId`, `clientRequestId`, `transport`, `tool`, `outcome`, `servedFrom`, `escalatedToPaid`,
 * `createdAt`. The remaining thirteen are `T | null`.
 *
 * **Why nullable fields are `T | null` and never optional `T?`.** An optional property lets a writer
 * omit a column by forgetting it, and a forgotten column is indistinguishable from a column the
 * writer decided did not apply. `| null` makes the absence a written decision, which is the same
 * argument §4.5.3 makes for pairing every limit with a mode.
 *
 * **Why times are numbers and never strings.** Epoch-ms UTC integers, DB-SCHEMA §1.2. No ISO string
 * and no database time function reaches this record: the storage axis is two engines, and a string
 * date orders differently on each.
 *
 * **Why `id` and `clientRequestId` are application-generated ULIDs.** DB-SCHEMA §1.3 — the shape
 * ships to two engines, so no server default can own an identifier. The server MINTS
 * `clientRequestId` when the client omits it, because a NULL there would disable dedup entirely (see
 * `requestTraceDedupKey`).
 *
 * **Why `principalId` is a label and not a foreign key.** The local profile's principal has no token
 * row, so a foreign key would refuse the write on the very transport that needs no token
 * (`docs/TASK.md` — stdio requires and checks no token).
 *
 * **Why `capability` may be null on a SUCCESSFUL row.** Two cases, not one (§4.5.7a): the request
 * failed before a route was chosen (`outcome: 'refusal'`), or the tool resolves no capability at all
 * — `onchain_ping` and `onchain_list_chains` answer without calling `resolveCapability`. Reading
 * null as "something went wrong" would drop a billable request from T-015's count.
 *
 * **Why `escalatedToPaid` is `0 | 1` and not `boolean`.** The column is `INTEGER NOT NULL DEFAULT 0`
 * with `CHECK (escalated_to_paid IN (0,1))` (R-28.2). SQLite has no boolean type, so a `boolean`
 * here would be a conversion this record's writer performs and its reader has to undo — one
 * vocabulary for a two-engine column, per DB-SCHEMA §1.1.
 *
 * **Why `triedJson` is a string.** JSON travels as TEXT and is parsed in code (DB-SCHEMA §1.4). It
 * is operator-side data: it names adapters and their walk order, which R-20.3 and R-31.4 forbid in
 * the client rendering. The ledger is not the client rendering.
 */
export interface RequestTraceRecord {
  readonly id: string;
  readonly receivedAt: number;
  readonly completedAt: number;
  readonly principalId: string;
  readonly userId: string | null;
  readonly accessProfileId: string | null;
  readonly clientRequestId: string;
  readonly sessionId: string | null;
  readonly transport: TransportKind;
  readonly tool: string;
  readonly capability: string | null;
  readonly argsHash: string | null;
  readonly outcome: RequestTraceOutcome;
  readonly refusalClass: string | null;
  readonly servedFrom: RequestTraceServedFrom;
  readonly cacheAgeMs: number | null;
  readonly vendorProvider: string | null;
  readonly vendorCredits: number | null;
  readonly vendorCalls: number | null;
  readonly vendorDay: number | null;
  readonly vendorWindowStart: number | null;
  readonly escalatedToPaid: 0 | 1;
  readonly triedJson: string | null;
  readonly createdAt: number;
}

/**
 * The three components of `UNIQUE (principal_id, client_request_id, received_at)` (§4.5.7), named as
 * a type so a caller cannot compose the key out of two of them.
 *
 * **Why `receivedAt` belongs in the key.** A client retry is a NEW server-side request: it is
 * admitted again, reads the cache again, and may call a vendor again, so it needs its own row.
 * Charge idempotency by `client_request_id` alone is T-015's concern, one layer up.
 */
export type RequestTraceDedupKey = Pick<
  RequestTraceRecord,
  'principalId' | 'clientRequestId' | 'receivedAt'
>;

/**
 * The declared dedup key of one record, as a single comparable string.
 *
 * **Why an encoding and not `[a, b, c].join('|')`.** `clientRequestId` is CLIENT-SUPPLIED whenever
 * the client sends one, so any separator that can appear inside a component makes the join
 * non-injective: `('p|1', 'r', 1)` and `('p', '1|r', 1)` collapse to the same string, and the second
 * client's genuine request is discarded as a duplicate of the first's. `JSON.stringify` over the
 * tuple escapes every component, so distinct triples always produce distinct keys.
 *
 * **Why this is exported rather than hidden inside the store.** The uniqueness rule is a property of
 * the RECORD, and it has two enforcers: this process and the engine's unique index. A rule kept
 * private to one of them cannot be tested against the other.
 */
export function requestTraceDedupKey(key: RequestTraceDedupKey): string {
  return JSON.stringify([key.principalId, key.clientRequestId, key.receivedAt]);
}

/**
 * What one `append` did.
 *
 * **Why the caller is told whether the row was written.** The real implementation is
 * `INSERT ... ON CONFLICT DO NOTHING` (DB-SCHEMA §1.5), which cannot fail on a repeat and therefore
 * cannot report one either. `written: false` names the repeat explicitly, so re-running a writer is
 * harmless AND observable — the same reason the snapshotter's dropped-metric signal had to grow a
 * reader (L-2): a diagnostic nobody receives is not a diagnostic.
 */
export interface RequestTraceAppendResult {
  readonly written: boolean;
}

/**
 * Appending to `request_trace`.
 *
 * **Append-only, by declaration.** There is no `update` and no `delete` here. The retention passes
 * that null `tried_json` after 90 days and drop the row after a year are jobs that write to
 * `retention_runs` (§4.5.9), not methods a request path can reach.
 */
export interface RequestTraceStore {
  append(record: RequestTraceRecord): Promise<RequestTraceAppendResult>;
}

/**
 * The stub, `[STUB]` in the task title's sense: it holds accepted rows in memory and enforces the
 * declared dedup key. Task 014-30 replaces it with the repository over `engine/pg-engine-store.ts`
 * (task 014-03).
 *
 * **Why the stub enforces the key at all.** A stub that accepted everything would model a table
 * WITHOUT its unique index, so every consumer written against it would be written against a
 * ledger that double-counts. The dedup rule is the one behaviour of this table a caller can observe,
 * so it is the one behaviour the stub must not omit.
 *
 * **Why `appended` is exposed.** A store whose effect cannot be read back can only be tested by the
 * value it returns, which would leave "the row we stored is the row we were handed" unasserted. It
 * is a stub-only affordance and does not appear on `RequestTraceStore`.
 */
export interface RequestTraceStoreStub extends RequestTraceStore {
  readonly appended: readonly RequestTraceRecord[];
}

export function createRequestTraceStoreStub(): RequestTraceStoreStub {
  const seen = new Set<string>();
  const appended: RequestTraceRecord[] = [];
  return {
    appended,
    append(record: RequestTraceRecord): Promise<RequestTraceAppendResult> {
      const key = requestTraceDedupKey(record);
      if (seen.has(key)) {
        return Promise.resolve({ written: false });
      }
      seen.add(key);
      appended.push(record);
      return Promise.resolve({ written: true });
    },
  };
}
