import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { TokenLookupRow } from './identity-types.js';

/**
 * Who a request is on behalf of (task 014-14, R-4, `system-architecture.md` §3.4.3).
 *
 * **Five fields, and the declaration is reproduced from §3.4.3 unchanged.** The type is fixed before
 * the interception that fills it (014-15) and before the trace row that reads it (014-30), because
 * both of those read its fields and a field added after them is a field neither considered.
 *
 * **Why the secret is not here.** The SDK's `AuthInfo` carries `token: string`. This type has no
 * such field, and the mapping below is the only place that reads one. R-5.3 forbids a principal on
 * stderr and R-5.4 forbids it in `_meta`; a type that CANNOT hold the secret makes both halves
 * mechanical rather than remembered.
 */
export interface Principal {
  /** `api_tokens.id`, or `local` on the stdio transport. Never empty. */
  readonly principalId: string;
  /** `users.id`; `null` on stdio, where there is no token and therefore no user row. */
  readonly userId: string | null;
  /** R-15.3 — decides `_meta.budget` visibility (task 014-16). Always defined. */
  readonly role: 'admin' | 'user';
  /** R-13.1 — the settings the token works within; `null` on stdio. */
  readonly accessProfileId: string | null;
  /**
   * R-27.1 — written to `request_trace.transport`, declared `TEXT NOT NULL` (`data-model.md`
   * §4.5.7).
   *
   * **A field, not a derivation.** The trace row is written at a moment when the session may already
   * have closed, and a stdio principal belongs to no session at all — so there is nothing left to
   * derive it from when the value is needed.
   */
  readonly transport: 'stdio' | 'http';
}

/**
 * The stdio principal — a constant, not an absence.
 *
 * **Why a constant and not an optional key.** Code branching on "is there a principal" gets an
 * optional field and loses the compiler's check on every read of it. A required key with a value for
 * the local case removes the branch entirely.
 *
 * **Why the role is DERIVED rather than chosen.** UC-3 step 3 requires `_meta.budget` in the local
 * profile (`docs/TASK.md:442`), and R-6.1 gives that field to the `admin` role. Naming any other
 * role here would silently withdraw a field the local scenario is specified to show.
 */
export const STDIO_PRINCIPAL: Principal = Object.freeze({
  principalId: 'local',
  userId: null,
  role: 'admin',
  accessProfileId: null,
  transport: 'stdio',
});

/**
 * Maps the SDK's `AuthInfo` — what a transport attached to the request — into our own type.
 *
 * **Why the parameter is `AuthInfo | undefined` and not the request.** The wrapper receives
 * `extra.authInfo` from the SDK, and nothing below the transport should hold a request object.
 * `undefined` is the stdio case.
 *
 * **Why it returns rather than throws when there is no principal.** By the time the wrapper runs,
 * step 2 of the admission order has already refused every request without a valid token
 * (`deployment.md` §10.2.1) — so an absent `AuthInfo` here means stdio, never an unauthenticated
 * HTTP request.
 *
 * **Why the mapping is synchronous.** The presented token is verified and `api_tokens` is read
 * before `transport.handleRequest` (§3.4.3, hop 1). What is left is a projection of an
 * already-verified row, and an `async` signature would invite a second read on the request path.
 */
export type PrincipalResolver = (authInfo: AuthInfo | undefined) => Principal;

/**
 * The resolver, or the stdio default when none was injected.
 *
 * **Why the defaulting is a named function and not an inline `??`.** Two call sites need it — the
 * context assembly in `server.ts` today, and `defineTool`'s wrapper from task 014-15 — and the
 * default is the one place where "no resolver" is turned into a role, which decides `_meta.budget`
 * visibility. An `??` repeated twice is two chances for those to disagree about who the local
 * operator is.
 */
export function principalFor(
  resolver: PrincipalResolver | undefined,
  authInfo: AuthInfo | undefined,
): Principal {
  return resolver === undefined ? STDIO_PRINCIPAL : resolver(authInfo);
}

/** The key our principal travels under inside `AuthInfo.extra` — written once, read once. */
export const PRINCIPAL_EXTRA_KEY = 'principal';

/**
 * The key the admission timestamp travels under, beside the principal (task 014-30,
 * `OD-014-30-13`).
 *
 * **Why it rides the SAME seam rather than getting its own.** `AuthInfo.extra` is the one declared
 * channel from a transport to a tool callback in SDK 1.29.0 — `RequestHandlerExtra` carries no clock
 * of any kind. A second mechanism (`AsyncLocalStorage`, a synthetic header) would be a second
 * per-request channel beside an existing one, and the synthetic header additionally does not exist
 * on stdio and is rewritable by any intermediary.
 *
 * **Why a separate key rather than a field on `Principal`.** A principal is WHO; this is WHEN. The
 * principal is also compared, logged and carried into the profile read, and none of those should
 * acquire a timestamp that varies per request.
 */
export const RECEIVED_AT_EXTRA_KEY = 'receivedAtMs';

/** The verified token row, projected into a principal. `transport` is `http` by construction. */
export function principalFromToken(row: TokenLookupRow): Principal {
  return {
    principalId: row.tokenId,
    userId: row.userId,
    role: row.role,
    accessProfileId: row.accessProfileId,
    transport: 'http',
  };
}

/**
 * Packs a principal into the SDK's `AuthInfo`, the ONE seam that carries per-request data from a
 * transport to a tool callback (measured against SDK 1.29.0, and by a live probe).
 *
 * The chain is four hops, all in installed source: `handleRequest` reads `req.auth`
 * (`streamableHttp.d.ts` types the parameter as `IncomingMessage & { auth?: AuthInfo }`, so this is
 * a declared seam and not a private field) → `HandleRequestOptions.authInfo` → `onmessage(message,
 * { authInfo })` → `RequestHandlerExtra.authInfo` → the tool callback's second argument.
 *
 * **`token` is deliberately EMPTY.** The SDK's field is the access token; ours is a secret that has
 * already been verified, and putting it here would leave it one property access away from every
 * tool callback and every error dump for the rest of the request. Nothing downstream reads it: we
 * do not use `requireBearerAuth` (which is Express-shaped and additionally rejects any `AuthInfo`
 * without a numeric `expiresAt` — our tokens are allowed to have none).
 *
 * **`clientId` carries the token ID, not the token.** It identifies the principal to an operator
 * reading a dump and discloses nothing that `api_tokens.id` does not.
 */
export function toAuthInfo(principal: Principal, receivedAtMs?: number): AuthInfo {
  return {
    token: '',
    clientId: principal.principalId,
    scopes: [],
    extra: {
      [PRINCIPAL_EXTRA_KEY]: principal,
      // Omitted rather than written as `undefined` when the caller has none, so `extra` keeps the
      // shape it had before this task on every path that does not supply one.
      ...(receivedAtMs === undefined ? {} : { [RECEIVED_AT_EXTRA_KEY]: receivedAtMs }),
    },
  };
}

/**
 * The admission timestamp this request was pinned with, or `undefined` when none travelled.
 *
 * **`undefined` has two meanings and the caller can tell them apart.** On stdio there is no request
 * channel at all — `StdioServerTransport` invokes `onmessage` with no second argument — so no
 * timestamp can exist and the tool boundary's own clock is the honest answer. On HTTP an absent
 * value means this process failed to pin one, which is a defect in our own wiring. The reader
 * returns the same `undefined` for both; `principal.transport` is what distinguishes them, and the
 * caller is expected to say so out loud rather than silently substitute (L-10).
 *
 * Validated rather than cast: `extra` is `Record<string, unknown>`, and a non-integer here would
 * become a `received_at` that orders wrongly and a dedup key component that never matches.
 */
export function receivedAtFrom(authInfo: AuthInfo | undefined): number | undefined {
  const carried = authInfo?.extra?.[RECEIVED_AT_EXTRA_KEY];
  return typeof carried === 'number' && Number.isSafeInteger(carried) && carried >= 0
    ? carried
    : undefined;
}

/** Thrown when the HTTP path reaches a tool without the principal its transport should have set. */
export class PrincipalMissingError extends Error {
  constructor(detail: string) {
    super(`no principal reached the tool boundary: ${detail}`);
    this.name = 'PrincipalMissingError';
  }
}

function isPrincipal(value: unknown): value is Principal {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['principalId'] === 'string' &&
    (candidate['userId'] === null || typeof candidate['userId'] === 'string') &&
    (candidate['role'] === 'admin' || candidate['role'] === 'user') &&
    (candidate['accessProfileId'] === null || typeof candidate['accessProfileId'] === 'string') &&
    (candidate['transport'] === 'stdio' || candidate['transport'] === 'http')
  );
}

/**
 * The resolver the HTTP transport injects: unpacks what `toAuthInfo` packed, and REFUSES otherwise.
 *
 * **Why it throws where the stdio default returns.** The stdio principal is `role: 'admin'`. A
 * resolver that fell back to it when `authInfo` was missing would turn a plumbing bug on the network
 * path into an administrator — the failure would be a privilege escalation that looks like a default.
 * Step 2 of the admission order has already refused every request without a valid token
 * (`deployment.md` §10.2.1), so an absent principal here is an invariant this process broke itself,
 * and refusing is the only answer that cannot be mistaken for success.
 */
export function createHttpPrincipalResolver(): PrincipalResolver {
  return (authInfo) => {
    if (authInfo === undefined) throw new PrincipalMissingError('the request carried no AuthInfo');
    const carried = authInfo.extra?.[PRINCIPAL_EXTRA_KEY];
    if (!isPrincipal(carried)) {
      throw new PrincipalMissingError(
        `AuthInfo.extra.${PRINCIPAL_EXTRA_KEY} is absent or malformed`,
      );
    }
    return carried;
  };
}
