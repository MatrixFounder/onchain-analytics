import {
  AccessProfileUnavailableError,
  type AccessProfile,
  type AccessProfileReader,
} from './access-profile.js';

/**
 * The phase-0 supplier: profile values from defaults in code (task 014-04, R-13.3).
 *
 * T-014 ships ONE supplier, and the columns of `access_profiles` exist without being read this
 * milestone (`data-model.md` §4.5.3). The second supplier — the table behind a connection — is what
 * the reader's asynchronous shape was chosen for, and `auth/access-profile-store.ts` already
 * declares its interface.
 */

/**
 * Phase 0's profile: all three limits unlimited, route disclosure `'full'`.
 *
 * **Why no measured number appears here** (R-13.4). Each default must carry its measurement beside
 * it — and the way this task satisfies that rule is by introducing no measured number at all. All
 * three limit fields are declared unlimited (R-13.7, R-14.4), so there is nothing to measure and
 * nothing to justify. `ADR-003` D5 is the reason the FIELDS exist anyway: an absent field cannot be
 * set to unlimited later, so T-014 declares them and T-015 applies quotas to them.
 *
 * **Why `'full'` and not `'none'`.** Phase 0 has one principal and it is the owner's. Starting
 * closed would hide the merge detail from the only person who reads it, in order to protect a paying
 * third party who does not exist yet. Narrowing is available per token the day one does
 * (`interfaces.md` §5.4.4.1), and `'none'` is constructible by any supplier without touching the
 * reader — which is precisely what task 014-16 exercises.
 *
 * **Why this is frozen.** A caller that mutated the shared default would change the settings of
 * every session in the process, from anywhere, with nothing to observe it.
 */
export const PHASE_0_ACCESS_PROFILE: AccessProfile = Object.freeze({
  creditsMode: 'unlimited',
  creditsBalanceRaw: null,
  rateLimitMode: 'unlimited',
  rateLimitPerMin: null,
  toolAllowlistMode: 'all',
  toolAllowlist: null,
  routeDisclosureMode: 'full',
} satisfies AccessProfile);

/**
 * The phase-0 reader: every id resolves to the same defaults.
 *
 * **Why it does not model row identity.** A supplier keeping a map of ids would be a small, untested
 * reimplementation of the table it stands in for — and the first thing to diverge from it. Phase 0
 * has one profile; the second supplier is the one that knows about rows.
 *
 * **Why an id that is not a string is refused rather than answered.** The defaults are the same for
 * every id, so answering would cost nothing and hide everything: a caller that passed `undefined`
 * because the principal carried no profile would receive an unlimited profile and never learn it did
 * not ask a real question. The stdio principal carries `accessProfileId: null` (§3.4.3) and reaches
 * no profile at all — that is a path that must not arrive here, not a path that must be tolerated.
 */
export function createDefaultAccessProfileReader(
  profile: AccessProfile = PHASE_0_ACCESS_PROFILE,
): AccessProfileReader {
  return {
    read(accessProfileId: string): Promise<AccessProfile> {
      if (typeof accessProfileId !== 'string' || accessProfileId.trim() === '') {
        return Promise.reject(
          new AccessProfileUnavailableError(
            String(accessProfileId),
            'no profile id was presented; a principal without one reaches no profile (§3.4.3)',
          ),
        );
      }
      return Promise.resolve(profile);
    },
  };
}
