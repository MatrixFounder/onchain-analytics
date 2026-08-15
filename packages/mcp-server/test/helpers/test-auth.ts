import type { TokenLookupRow } from '../../src/auth/identity-types.js';
import type { AuthDecision } from '../../src/transport/http.js';

/**
 * A minimal authenticator for the HTTP suites (task 014-12).
 *
 * **Why every HTTP test now carries one.** `authenticate` is a required dependency of the transport
 * from task 014-12 onward, because an optional one is an unauthenticated path that still exists —
 * and the suites written against that path in task 014-09 would have stayed green while asserting
 * nothing about the running server. This is what makes their re-assertion on the authenticated path
 * a mechanical consequence rather than an obligation somebody has to remember.
 *
 * It decides on the VALUE alone: the digest, the store and the four refusal states are task 014-07's
 * and are measured in `token-lifecycle.test.ts` against a real engine. Repeating that here would
 * test the store twice and the admission order not at all.
 */

/** A value in the §7.5.2 form, so nothing in the pipeline can reject it for its shape. */
export const TEST_TOKEN = `oi_testtest_${'A'.repeat(43)}`;

export const TEST_PRINCIPAL: TokenLookupRow = Object.freeze({
  tokenId: '01JTESTTOKEN00000000000000',
  tokenStatus: 'active',
  expiresAt: null,
  accessProfileId: '01JPHASE00000000000000000A',
  userId: '01JTESTUSER000000000000000',
  role: 'user',
  userStatus: 'active',
});

/** Counts what it was asked, so a test can assert the store was NOT consulted. */
export interface CountingAuthenticator {
  (presented: string | null): Promise<AuthDecision>;
  calls: string[];
}

export function acceptsTestToken(accepted: string = TEST_TOKEN): CountingAuthenticator {
  const authenticate = (presented: string | null): Promise<AuthDecision> => {
    authenticate.calls.push(presented ?? '(none)');
    return Promise.resolve(
      presented === accepted
        ? { ok: true, principal: TEST_PRINCIPAL }
        : { ok: false, refusalClass: 'auth.unknown_token' },
    );
  };
  authenticate.calls = [] as string[];
  return authenticate;
}

/** The header a client sends to be admitted. */
export const bearerHeader = (token: string = TEST_TOKEN): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});
