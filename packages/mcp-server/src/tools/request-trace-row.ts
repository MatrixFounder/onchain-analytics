import type { VendorSpendRecord } from '@onchain-intel/core';
import type { Principal } from '../auth/principal.js';
import type {
  RequestTraceOutcome,
  RequestTraceRecord,
  RequestTraceServedFrom,
} from '../engine/request-trace-store.js';
import { vendorSpendColumns, type VendorSpendCollapse } from './vendor-spend-columns.js';

/**
 * Assembling one `request_trace` row from what the wrapper observed (task 014-30).
 *
 * **Pure, and separate from the wrapper.** Every rule here — which of four sources answered, which
 * of three outcome classes applies, which client-supplied id is accepted — is a decision a test
 * should be able to exercise by handing it values, without a server, a transport or a clock. The
 * wrapper's job is to observe and to write; deciding what was observed is this module's.
 */

/** The suffix of the incoming `_meta` key. Ours, and not configurable — only the namespace is. */
export const CLIENT_REQUEST_ID_META_SUFFIX = 'client-request-id';

/**
 * Bounds on an accepted client-supplied request id.
 *
 * A client value becomes a component of this table's unique key, so an unbounded string would let a
 * caller choose the size of an indexed column. 128 characters accommodates a ULID, a UUID and every
 * correlation-id convention in ordinary use.
 */
const MAX_CLIENT_REQUEST_ID_CHARS = 128;

export interface ClientRequestIdReading {
  /** The accepted client value, or `null` when none was accepted. */
  readonly value: string | null;
  /**
   * A key that carried our suffix under some OTHER namespace.
   *
   * **Why this is reported rather than ignored.** Without it, a client that mis-typed its namespace
   * is indistinguishable from a client that sends no id at all — both mint — and the operator would
   * be left with a permanently non-idempotent stream that looks exactly like a correctly configured
   * one (L-10). The request is still served; only the identity is minted.
   */
  readonly nearMiss: string | null;
}

/**
 * Reads the client-supplied request id out of the request's `_meta` (`OD-014-30-14`).
 *
 * `namespace` absent ⇒ nothing is accepted. Any default namespace would be a domain we do not own,
 * which is the collision the reverse-DNS form exists to prevent.
 */
export function readClientRequestId(
  meta: Record<string, unknown> | undefined,
  namespace: string | undefined,
): ClientRequestIdReading {
  if (meta === undefined) return { value: null, nearMiss: null };

  const suffix = `/${CLIENT_REQUEST_ID_META_SUFFIX}`;
  const wanted = namespace === undefined ? null : `${namespace}${suffix}`;

  let nearMiss: string | null = null;
  for (const key of Object.keys(meta)) {
    if (key === wanted) continue;
    if (key.endsWith(suffix)) nearMiss ??= key;
  }

  if (wanted === null) return { value: null, nearMiss };
  const raw = meta[wanted];
  // A present-but-unusable value is a near miss too: the client believes it supplied an identity.
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CLIENT_REQUEST_ID_CHARS) {
    return { value: null, nearMiss: raw === undefined ? nearMiss : wanted };
  }
  return { value: raw, nearMiss };
}

/**
 * Which of the four sources answered (`data-model.md` §4.5.7).
 *
 * **Cache is decided FIRST, and that is the decoupling** (`OD-014-30-2`). `served_from` names the
 * source of the ANSWER; the five vendor columns name this request's contribution to the ledger, and
 * the two are independent. A walk that entered a paid adapter, spent, and then returned an earlier
 * adapter's cached answer records `cache` here AND its spend in the vendor columns.
 *
 * A follower outranks a charge for the reverse reason: a request that waited on somebody else's call
 * made none of its own, whatever else is in the receipt set.
 */
export function servedFromOf(
  ok: boolean,
  cacheStatus: 'hit' | 'miss' | undefined,
  receipts: readonly VendorSpendRecord[],
): RequestTraceServedFrom {
  // **A refusal was served by nobody**, whatever was entered on the way. The column names the source
  // of the ANSWER, and a refusal has none: a vendor that was called and did not answer did not serve
  // this request, and neither did a cache entry we then rejected on our own output contract.
  //
  // This does not lose the spend. The five vendor columns are independent of this one
  // (`OD-014-30-2`), so a call that paid and then failed still carries its contribution — which is
  // precisely why the two axes had to be decoupled before this rule could be this simple.
  if (!ok) return 'none';
  if (cacheStatus === 'hit') return 'cache';
  if (receipts.some((r) => r.kind === 'coalesced')) return 'coalesced';
  if (receipts.some((r) => r.kind === 'charge')) return 'vendor';
  return 'none';
}

/**
 * Which of `ADR-003` D4's three classes this call ended in.
 *
 * `partial_deadline` is a COMPLETE answer produced past the call's own ceiling — the surviving
 * branch after owner decision 2026-08-03 withdrew partial results (R-156). An expired deadline that
 * produced nothing throws, and therefore lands in `refusal` with its class recorded.
 */
export function outcomeClassOf(ok: boolean, overrunMs: number | undefined): RequestTraceOutcome {
  if (!ok) return 'refusal';
  return overrunMs !== undefined && overrunMs > 0 ? 'partial_deadline' : 'answer';
}

export interface RequestTraceRowInput {
  readonly id: string;
  readonly receivedAt: number;
  readonly completedAt: number;
  readonly principal: Principal;
  readonly clientRequestId: string | null;
  readonly sessionId: string | null;
  readonly tool: string;
  readonly capability: string | null;
  readonly argsHash: string | null;
  readonly ok: boolean;
  readonly refusalClass: string | null;
  readonly cacheStatus: 'hit' | 'miss' | undefined;
  readonly cacheAgeMs: number | undefined;
  readonly overrunMs: number | undefined;
  readonly receipts: readonly VendorSpendRecord[];
}

export interface BuiltRequestTraceRow {
  readonly record: RequestTraceRecord;
  readonly spend: VendorSpendCollapse;
}

/**
 * Builds the row. Every field is either observed or explicitly `null` — nothing is guessed.
 *
 * **`escalatedToPaid` is a constant `0` here, and that is task 014-28's field, not this one's.**
 * The presence of a spend receipt is NOT evidence of paidness: `ADR-003` D6 extends the call counter
 * to any provider, after which a route of two free adapters produces receipts. Paidness has one
 * classification and it reads `AdapterRegistration.tier`.
 *
 * **`triedJson` is `null`, and that is a named residual rather than an oversight.** The ordered walk
 * with its per-attempt reasons exists only on two error classes; on the success path the registry
 * reports adapter ids without reasons and `ToolOutcome` does not carry them at all. That channel has
 * a different arity and a different owner (`OQ-014-28-B`) and is not this task's.
 */
export function buildRequestTraceRow(input: RequestTraceRowInput): BuiltRequestTraceRow {
  const spend = vendorSpendColumns(input.receipts);
  return {
    spend,
    record: {
      id: input.id,
      receivedAt: input.receivedAt,
      completedAt: input.completedAt,
      principalId: input.principal.principalId,
      userId: input.principal.userId,
      accessProfileId: input.principal.accessProfileId,
      // Minted as this row's own id when the client supplied none, so "the server minted it" is the
      // predicate `client_request_id = id` rather than a guess or a twenty-fifth column.
      clientRequestId: input.clientRequestId ?? input.id,
      sessionId: input.sessionId,
      transport: input.principal.transport,
      tool: input.tool,
      capability: input.capability,
      argsHash: input.argsHash,
      outcome: outcomeClassOf(input.ok, input.overrunMs),
      // The CHECK constraint pairs these two: a refusal has a class, an answer has none.
      refusalClass: input.ok ? null : input.refusalClass,
      servedFrom: servedFromOf(input.ok, input.cacheStatus, input.receipts),
      cacheAgeMs: input.cacheStatus === 'hit' ? (input.cacheAgeMs ?? null) : null,
      ...spend.columns,
      escalatedToPaid: 0,
      triedJson: null,
      createdAt: input.completedAt,
    },
  };
}
