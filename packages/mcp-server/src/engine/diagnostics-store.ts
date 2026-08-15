import type { EngineStore } from './pg-engine-store.js';

/**
 * The stored diagnostics channel (`data-model.md` §4.5.8, R-32) — the events an administrator must
 * be able to read WITHOUT access to the process stderr.
 *
 * Task 014-02 declares the SHAPE and ships a stub under it. No table is created here — the Postgres
 * declaration is task 014-35, the SQLite one 014-36 — and nothing emits an event yet: task 014-27
 * replaces the stub and writes each event to both channels.
 *
 * **Why a stored channel exists beside stderr.** On the HTTP transport neither the client nor its
 * operator reads stderr. A diagnostic nobody reads is not a diagnostic (L-2) — the snapshotter spent
 * four days losing one metric of eleven while every run looked clean, because the signal was
 * computed and never delivered.
 *
 * **Why `mcp-server` and not `core`.** `deployment.md` §10.2.1 places SQL naming
 * `onchain.diagnostics` outside `packages/core/src`, and `security.md` §7.5.1 keeps it beside the
 * transport that produces the events.
 */

/**
 * The CLOSED vocabulary: eight events, compiled, exactly as `data-model.md` §4.5.8 tabulates them.
 *
 * | event                      | written when                                                  |
 * | :------------------------- | :------------------------------------------------------------ |
 * | `auth.rejected`            | a request presents no valid token (R-19.3)                    |
 * | `perimeter.rejected`       | `Host` or `Origin` fails the transport check (R-19.4)         |
 * | `session.limit_reached`    | the session ceiling refuses a new session (R-24.3)            |
 * | `session.evicted`          | an idle session is dropped (R-24.2)                           |
 * | `limiter.degraded`         | the shared limiter store failed and the process fell back (R-7.7) |
 * | `source.escalated_to_paid` | a free source yielded nothing and a paid one was called (R-28.1) |
 * | `tool.refused`             | a tool execution failed; `detailJson` holds the full text (R-31.1) |
 * | `retention.cleanup`        | a retention job finished (R-32.3)                             |
 *
 * **Why compiled and not free text.** An event name invented at runtime makes AC-48's query
 * impossible to write. Same three reasons the chain registry is compiled (§4.2.1): the offline gate,
 * CI determinism, and a reviewable diff.
 *
 * **Why the dictionary carries no event for an interrupted request, and that is stated not hidden.**
 * `request_trace` is written once at completion, so a process that dies mid-request leaves no trace
 * row (§4.5.7). What survives is whatever diagnostics rows it wrote first, whose `traceId` then
 * resolves to nothing. A request that died without emitting one of these eight is not observable at
 * all. Closing that gap needs a reserve-then-update trace row, which R-27.7 forbids.
 */
export const DIAGNOSTIC_EVENTS = [
  'auth.rejected',
  'perimeter.rejected',
  'session.limit_reached',
  'session.evicted',
  'limiter.degraded',
  'source.escalated_to_paid',
  'tool.refused',
  'retention.cleanup',
] as const;

export type DiagnosticEvent = (typeof DIAGNOSTIC_EVENTS)[number];

/** `CHECK (severity IN ('info','warn','error'))` (§4.5.8), as a type. */
export const DIAGNOSTIC_SEVERITIES = ['info', 'warn', 'error'] as const;

export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

/**
 * One diagnostics row: the eleven columns of `data-model.md` §4.5.8, in the declared order. Six are
 * NOT NULL — `id`, `ts`, `severity`, `event`, `detailJson`, `createdAt`; the other five are
 * `string | null`.
 *
 * **Why `detailJson` is NOT NULL and carries the FULL operator rendering** (R-31.1). This row is the
 * other half of a refusal: the client is shown a bounded message and an identifier, and the whole
 * text lives here. A row that omitted it would leave the identifier resolving to nothing useful,
 * which is worse than showing no identifier at all.
 *
 * **Why `id` is the join key handed to a client, and no second identifier exists.** Owner decision
 * 2026-08-13, closing `OQ-T014-SEC-2`. It is already the handle the stderr rendering carries, and
 * ULID-as-`TEXT` makes it safe to hand out: 80 random bits per value leave another principal's row
 * non-derivable, and the payload is timestamp plus randomness only — the refusal REASON stays in
 * `event` and `detailJson`, under the visibility rules that already bind those columns.
 *
 * **Why `principalId` is nullable while `request_trace.principal_id` is not.** A request refused at
 * the perimeter or at authentication has no principal yet, and those are exactly the two events
 * R-19.3 and R-19.4 require to be observable. Note the asymmetry with stderr: R-5.3 forbids the
 * principal on stderr, so the stderr rendering of the same event carries the row `id` instead and
 * the principal is read from this column.
 *
 * **Why `traceId` carries no foreign key, deliberately.** `limiter.degraded` fires MID-request,
 * before the trace row exists. With `PRAGMA foreign_keys=ON` (DB-SCHEMA §1.6) that insert would
 * fail and the process would lose the diagnostic saying the limiter degraded. The reader joins on
 * the column; a `traceId` matching nothing is a request that never reached completion.
 *
 * **Why times are numbers.** Epoch-ms UTC integers, DB-SCHEMA §1.2 — no ISO string, no DB time
 * function.
 */
export interface DiagnosticsRecord {
  readonly id: string;
  readonly ts: number;
  readonly severity: DiagnosticSeverity;
  readonly event: DiagnosticEvent;
  readonly principalId: string | null;
  readonly sessionId: string | null;
  readonly provider: string | null;
  readonly capability: string | null;
  readonly traceId: string | null;
  readonly detailJson: string;
  readonly createdAt: number;
}

/**
 * Appending to `diagnostics`.
 *
 * **Why `append` reports nothing back, unlike `RequestTraceStore.append`.** This table has NO
 * natural unique dedup key (§4.5.8), so a repeat is not a concept here: two identical events a
 * millisecond apart are two facts about the process, not one fact written twice. There is nothing
 * for a return value to distinguish.
 *
 * **A row that gates a response is written BEFORE the response is sent** (§4.5.8). An identifier
 * that resolves to nothing is worse than no identifier, which makes the ordering part of the
 * caller's contract rather than an implementation preference.
 */
export interface DiagnosticsStore {
  append(record: DiagnosticsRecord): Promise<void>;
}

/**
 * The stub, `[STUB]` in the task title's sense: it keeps rows in memory. Task 014-27 replaces it
 * with the repository over `engine/pg-engine-store.ts` (task 014-03) and adds the second channel.
 *
 * **Why `appended` is exposed.** `append` returns nothing, so without a readable effect the only
 * assertion left would be that the call did not throw — which is precisely the "computed but never
 * delivered" shape this table exists to prevent. It is a stub-only affordance and does not appear on
 * `DiagnosticsStore`.
 */
export interface DiagnosticsStoreStub extends DiagnosticsStore {
  readonly appended: readonly DiagnosticsRecord[];
}

export function createDiagnosticsStoreStub(): DiagnosticsStoreStub {
  const appended: DiagnosticsRecord[] = [];
  return {
    appended,
    append(record: DiagnosticsRecord): Promise<void> {
      appended.push(record);
      return Promise.resolve();
    },
  };
}

/* --------------------------------------------------------------------------------------------- *
 * Task 014-27 — the repository over the shared access mechanism.
 * --------------------------------------------------------------------------------------------- */

/**
 * `onchain.diagnostics`, over the write client of task 014-39 through the mechanism of 014-03.
 *
 * **Append-only by use, not by trigger.** Unlike `access_audit`, this table carries no engine guard
 * against `UPDATE`: §4.5.8 makes it a retention-managed log rather than a record of what an admin
 * did, and the `onchain-retention` job DELETEs from it by design (task 014-41). The append-only
 * property here is a property of the only writer, which is this function.
 */
export function createDiagnosticsStore(engine: EngineStore): DiagnosticsStore {
  return {
    async append(record: DiagnosticsRecord): Promise<void> {
      await engine.query(
        `INSERT INTO ${engine.qualify('diagnostics')}
           (id, ts, severity, event, principal_id, session_id, provider, capability, trace_id, detail_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          record.id,
          record.ts,
          record.severity,
          record.event,
          record.principalId,
          record.sessionId,
          record.provider,
          record.capability,
          record.traceId,
          record.detailJson,
          record.createdAt,
        ],
      );
    },
  };
}
