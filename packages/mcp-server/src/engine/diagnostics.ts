import { ulid } from '../ulid.js';
import type { DiagnosticEvent, DiagnosticSeverity, DiagnosticsStore } from './diagnostics-store.js';

/**
 * The diagnostics channel: one event, two destinations (task 014-27, R-19, R-32).
 *
 * **Why a stored channel exists beside stderr.** On the HTTP transport neither the client nor its
 * operator reads stderr — the process runs in a container someone else owns. A diagnostic nobody
 * reads is not a diagnostic (L-2): the snapshotter lost one metric of eleven for four days while
 * every run looked clean, because the signal was computed and never delivered. AC-48 is the
 * requirement that an administrator can find the event without shell access to the process.
 *
 * **What the stderr line carries, and what it must not.** It carries the event name and the `id` of
 * the row — never the principal. R-5.3 forbids a principal on stderr; R-19.3 requires authentication
 * refusals to be observable. The row id satisfies both: it is the key `data-model.md` §4.5.8 names
 * for joining a refusal to its full text, and it identifies nobody on its own.
 *
 * **When the store fails, the event still reaches stderr.** A row written into a database that
 * refused the write would be lost, and the process would have reported nothing at all
 * (`system-architecture.md` §3.4.8). The failure is never propagated to the caller: an emit is a
 * side effect of some other decision, and turning a diagnostics outage into a refused request would
 * make the observability layer able to take the service down.
 *
 * **A failed append returns `null`, not the id** (RF-17, 2026-09-04). On the live-gate run of
 * 2026-09-02 20:23 UTC three refusals reached the client with event ids, and two of them —
 * `01M1HWAZ3FV3GM7SKDH3AAW1A9` and `01M1HWF65CJBNEXFN0W40BMJZ0` — matched no row in
 * `onchain.diagnostics` and none in `request_trace`. Retention had not removed them: the table held
 * 96 rows spanning 2026-08-24 to 2026-09-04, seven of them from later minutes of the same run. The
 * caller could not tell a persisted event from a lost one, because both returned a string. The
 * error's own `cause` was in the rows that were never written, which is why L-30 cannot name the
 * mechanism behind its four ~10 000 ms failures.
 */

export interface DiagnosticDetail {
  readonly severity: DiagnosticSeverity;
  readonly principalId?: string | null;
  readonly sessionId?: string | null;
  readonly provider?: string | null;
  readonly capability?: string | null;
  readonly traceId?: string | null;
  /**
   * The full text — REQUIRED, because `diagnostics.detail_json` is `NOT NULL` and this row is the
   * operator rendering (R-31.1). An event with nothing in it would be a row that records that
   * something happened and not what: the second half of the L-2 defect, where the signal exists and
   * says nothing. It reaches the table and never the client (SEC-2).
   */
  readonly detail: Record<string, unknown>;
}

export interface DiagnosticsDeps {
  /**
   * The stored channel, or `null` when the profile has none.
   *
   * `null` is the `local` profile: stdio, one operator, and that operator IS reading stderr. It is
   * not a silent degradation — the event still reaches the one channel that exists there.
   */
  readonly store: DiagnosticsStore | null;
  readonly now: () => number;
  readonly newId?: (nowMs: number) => string;
  /** Injectable so a test reads the line without capturing a stream. */
  readonly writeStderr?: (line: string) => void;
}

export interface Diagnostics {
  /**
   * Records one event. Returns the row id, so a caller can hand it to a client as the ONE token that
   * links a refusal to its full text (SEC-2) without disclosing any of it.
   *
   * Returns `null` when the event is not retrievable by id: the store was asked and refused the
   * append. `toClientText` renders no `(event …)` suffix for `null`, so the client is given a
   * bounded refusal with no handle rather than a handle that resolves to nothing (RF-17).
   *
   * A `null` store is the other case and returns the id. See `DiagnosticsDeps.store`: there the
   * channel is stderr, the id was printed on it, and it resolves for the only reader present.
   */
  emit(event: DiagnosticEvent, detail: DiagnosticDetail): Promise<string | null>;
}

export function createDiagnostics(deps: DiagnosticsDeps): Diagnostics {
  const newId = deps.newId ?? ((nowMs: number): string => ulid(nowMs));
  const writeStderr =
    deps.writeStderr ?? ((line: string): void => void process.stderr.write(`${line}\n`));

  return {
    async emit(event: DiagnosticEvent, detail: DiagnosticDetail): Promise<string | null> {
      const ts = deps.now();
      const id = newId(ts);

      // The stderr line first, and deliberately: if the store is slow or unreachable, the operator
      // reading the container log still sees the event at the moment it happened.
      writeStderr(`diagnostic id=${id} event=${event} severity=${detail.severity}`);

      // No stored channel at all, which is a different case from a channel that refused the write:
      // the id was printed on stderr above and that is the channel the local operator reads, so it
      // resolves there. See `DiagnosticsDeps.store`.
      if (deps.store === null) return id;

      try {
        await deps.store.append({
          id,
          ts,
          severity: detail.severity,
          event,
          principalId: detail.principalId ?? null,
          sessionId: detail.sessionId ?? null,
          provider: detail.provider ?? null,
          capability: detail.capability ?? null,
          traceId: detail.traceId ?? null,
          detailJson: JSON.stringify(detail.detail),
          createdAt: ts,
        });
      } catch (error) {
        // Never rethrown — see this module's docstring. The failure itself is reported on the one
        // channel that is still working, and it names the event that was lost from the table so the
        // gap is visible rather than inferred from a missing row.
        writeStderr(
          `diagnostic id=${id} event=${event} store=unreachable reason=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        // `null`, not `id`: the row does not exist, so the id names nothing an administrator can
        // query (RF-17). The two stderr lines above are unchanged and remain the record of the
        // event and of the gap.
        return null;
      }
      return id;
    },
  };
}
