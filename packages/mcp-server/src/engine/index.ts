/**
 * Barrel for the operational side of T-014: the two repositories that record what the engine did,
 * rather than who it belongs to — `request_trace` and `diagnostics` (`data-model.md` §4.5.7,
 * §4.5.8).
 *
 * **Why these two sit outside `auth/`.** They are records of work, not identity tables. Both are
 * still written from this package: `deployment.md` §10.2.1 names `onchain.request_trace` and
 * `onchain.diagnostics` among the SQL kept outside `packages/core/src`.
 *
 * **What is deliberately absent.** `engine/pg-engine-store.ts` — the shared, schema-qualified access
 * mechanism every replacement is built over — is task 014-03's file, and `engine/diagnostics.ts`
 * (the two-channel writer) is task 014-27's. Naming the mechanism in one place is what stops each of
 * the four stub-replacing tasks from growing its own path to the database.
 */
export {
  createDiagnosticsStoreStub,
  DIAGNOSTIC_EVENTS,
  DIAGNOSTIC_SEVERITIES,
  type DiagnosticEvent,
  type DiagnosticSeverity,
  type DiagnosticsRecord,
  type DiagnosticsStore,
  type DiagnosticsStoreStub,
} from './diagnostics-store.js';
export {
  createRequestTraceStoreStub,
  REQUEST_TRACE_OUTCOMES,
  REQUEST_TRACE_SERVED_FROM,
  requestTraceDedupKey,
  type RequestTraceAppendResult,
  type RequestTraceDedupKey,
  type RequestTraceOutcome,
  type RequestTraceRecord,
  type RequestTraceServedFrom,
  type RequestTraceStore,
  type RequestTraceStoreStub,
} from './request-trace-store.js';
