import type {
  AccessAuditEntry,
  IssueOptions,
  IssuedToken,
  TokenLookupRow,
} from './identity-types.js';

/**
 * The `api_tokens` repository, and — through `appendAudit` — the `access_audit` journal
 * (`data-model.md` §4.5.4, §4.5.5).
 *
 * Task 014-02 declared the address, task 014-06 declares the members, task 014-07 supplies the
 * CSPRNG, the peppered digest, revocation and the journal's append-only behaviour.
 *
 * **Why the access journal gets no repository of its own.** It is written on the same paths that
 * issue and revoke, and a sixth store would be a second way to reach one table.
 *
 * **The stub must not reach a running network profile.** Its `issue` returns a predictable value —
 * a credential check that always agrees is worse than none, because it reports success.
 */
export interface TokenStore {
  /**
   * Mints a token for a user under an access profile, and returns the secret ONCE.
   *
   * **Why the access profile is a parameter and not a default.** `api_tokens.access_profile_id` is
   * `NOT NULL` with a foreign key (§4.5.4): an issue with no profile has no row to insert. Making it
   * a parameter means the caller decides which settings the token works within, at the moment the
   * token exists — rather than a default deciding it for every token ever issued.
   *
   * The returned `token` is the only time the secret exists outside the client. It is not stored,
   * not logged and not recoverable (`security.md` §7.5.2).
   */
  issue(userId: string, accessProfileId: string, options?: IssueOptions): Promise<IssuedToken>;

  /**
   * Looks a presented token up by DIGEST and returns the seven values of §4.5.4, or `null`.
   *
   * **`null` means "no row", never "refused".** The four refusing states are decided in code over
   * the returned row, because a `WHERE` that filtered them would answer zero rows for all four and
   * R-26 needs the class. `null` is only the first of the four.
   *
   * **The digest is the only lookup path.** The `prefix` identifies a token in prose and never finds
   * one: a lookup over a shorter, non-secret value would be a weaker credential in the same table.
   */
  lookup(presented: string): Promise<TokenLookupRow | null>;

  /**
   * Revokes a token: `status = 'revoked'` and `revoked_at` stamped. The row is not deleted.
   *
   * **Why the row stays.** Withdrawal of access is a state, not an absence (§4.5.3) — and
   * `request_trace` rows reference the principal that held this token, so deleting it would strand
   * the record of what it did.
   *
   * `actorId` is the admin performing it, and it is a parameter because R-15.7 requires the journal
   * row that accompanies the change to name who made it.
   */
  revoke(tokenId: string, actorId: string): Promise<void>;

  /**
   * Appends one row to `access_audit`. Never updates, never deletes — both engines refuse.
   *
   * The entry carries its own `id`, `ts` and `createdAt`, the same shape `RequestTraceStore.append`
   * takes: an append is then a pure function of its argument and a test needs no clock.
   */
  appendAudit(entry: AccessAuditEntry): Promise<void>;
}

/**
 * The stub: fixed answers, no database (`[STUB]`, task 014-06).
 *
 * **Why the issued value is visibly a stub.** It has the SHAPE of a token — `oi_`, a label, a
 * separator, a secret-length tail — so a caller's parsing is exercised, and it is CONSTANT, so no
 * reader can mistake it for something minted. Task 014-07's TC-UNIT-05 asserts that two real issues
 * differ; this one deliberately does not.
 */
export function createTokenStoreStub(
  fixed: TokenLookupRow | null = null,
): TokenStore & { readonly audited: readonly AccessAuditEntry[] } {
  const audited: AccessAuditEntry[] = [];
  return {
    audited,
    issue(): Promise<IssuedToken> {
      return Promise.resolve({
        id: '01JSTUBTOKEN0000000000000',
        token: `oi_stubstub_${'S'.repeat(43)}`,
        prefix: 'oi_stubstub', // the leading 11 characters, as §7.5.2 defines the prefix
      });
    },
    lookup(): Promise<TokenLookupRow | null> {
      return Promise.resolve(fixed);
    },
    revoke(): Promise<void> {
      return Promise.resolve();
    },
    appendAudit(entry: AccessAuditEntry): Promise<void> {
      audited.push(entry);
      return Promise.resolve();
    },
  };
}
