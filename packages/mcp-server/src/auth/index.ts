/**
 * Barrel for the identity side of T-014: the three repositories that reach `users`,
 * `access_profiles`, `api_tokens` and — through `TokenStore.appendAudit` — `access_audit`
 * (`data-model.md` §4.5.3 – §4.5.5).
 *
 * **Why a barrel inside the package and not an export from `packages/core`.** `security.md` §7.5.1
 * keeps identity beside the transport that needs it, and `packages/core/src/index.ts` gains no
 * re-export from this task: `packages/core` receives no type of token, role or header. That is an
 * acceptance criterion of task 014-02, checked by `test/engine-store-contracts.test.ts`.
 *
 * **What is deliberately absent.** `auth/principal.ts` (`system-architecture.md` §3.4.3),
 * `auth/access-profile.ts` and `auth/default-access-profile.ts` (task 014-04, `security.md`
 * §7.5.3a) and `auth/identity-types.ts` (task 014-06) are other tasks' files. Each joins this list
 * when its own task lands.
 */
export {
  createAccessProfileStoreStub,
  STUB_ACCESS_PROFILE,
  type AccessProfileRecord,
  type AccessProfileStore,
} from './access-profile-store.js';
export { createTokenStoreStub, type TokenStore } from './token-store.js';
export { createUserStoreStub, type UserStore } from './user-store.js';
