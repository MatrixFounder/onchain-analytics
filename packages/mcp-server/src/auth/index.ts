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
 * **When each file joined.** `access-profile.ts` and `default-access-profile.ts` with task 014-04,
 * `identity-types.ts` with 014-06, `principal.ts` (`system-architecture.md` §3.4.3) with 014-14 —
 * the note here used to predict 014-10, which shipped the session without touching the type.
 */
export {
  AUTH_REFUSAL_CLASSES,
  type AccessAuditEntry,
  type ApiToken,
  type AuditAction,
  type AuditTargetType,
  type AuthRefusalClass,
  type IssueOptions,
  type IssuedToken,
  type NewUser,
  type Role,
  type TokenLookupRow,
  type TokenStatus,
  type User,
  type UserStatus,
} from './identity-types.js';
export {
  AccessProfileUnavailableError,
  type AccessProfile,
  type AccessProfileReader,
} from './access-profile.js';
export {
  createDefaultAccessProfileReader,
  PHASE_0_ACCESS_PROFILE,
} from './default-access-profile.js';
export {
  createAccessProfileStoreStub,
  STUB_ACCESS_PROFILE,
  type AccessProfileRecord,
  type AccessProfileStore,
} from './access-profile-store.js';
export { classifyToken, type AuthOutcome } from './authenticate.js';
export {
  PRINCIPAL_EXTRA_KEY,
  PrincipalMissingError,
  STDIO_PRINCIPAL,
  createHttpPrincipalResolver,
  principalFor,
  principalFromToken,
  toAuthInfo,
  type Principal,
  type PrincipalResolver,
} from './principal.js';
export {
  createTokenStore,
  createTokenStoreStub,
  mintToken,
  tokenDigest,
  MissingPepperError,
  TokenMintExhaustedError,
  TokenNotRevocableError,
  TOKEN_PREFIX_LENGTH,
  type TokenStore,
  type TokenStoreDeps,
} from './token-store.js';
export {
  createUserStore,
  createUserStoreStub,
  type UserStore,
  type UserStoreDeps,
} from './user-store.js';
