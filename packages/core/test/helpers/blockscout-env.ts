/**
 * The env a `blockscout` adapter needs to be AVAILABLE at all (L-6).
 *
 * Since 2026-08-11 the facade refuses every `/v1/*` data route without a PRO key (HTTP 403), so
 * `isAvailable()` declines when `BLOCKSCOUT_PRO_API_KEY` is absent. Before that, `env: {}` meant
 * "keyless, which is a working state" and every suite could build the adapter that way; now the
 * same literal means "this adapter is switched off", which is a different test.
 *
 * This exists as one exported constant rather than eight copies of a string literal for a specific
 * reason: the next time the vendor changes the variable's NAME, a repo-wide grep must find one
 * definition and not eight look-alikes that drift apart. Suites asserting the DISABLED path keep
 * writing `env: {}` deliberately — the contrast is the assertion.
 *
 * The value is a placeholder, never a real credential: every suite that uses it injects `fetchImpl`
 * and reaches no network. Shaped like the vendor's own keys only so that a leak assertion has
 * something recognisable to search for.
 */
export const BLOCKSCOUT_TEST_ENV: Record<string, string> = {
  BLOCKSCOUT_PRO_API_KEY: 'proapi_test_placeholder_not_a_secret',
};
