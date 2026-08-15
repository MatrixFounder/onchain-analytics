import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

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
