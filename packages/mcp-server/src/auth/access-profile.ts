/**
 * The access profile — the settings a token works within — and the ONE interface they are read
 * through (task 014-04, R-13.1 – R-13.3, `security.md` §7.5.3a).
 *
 * **Why this lives in `mcp-server` and not in `core`.** §7.5.1: the checks live beside the transport
 * that needs them, and `packages/core` receives no type of token, role or header. The path is
 * declared in §7.5.3a.
 *
 * **What a profile is not.** It is not a role. The role lives on the user and decides whether
 * `_meta.budget` is rendered and whether issuing is permitted; the profile lives on the token and
 * decides which tools a session registers and what its ceilings are. Two tokens of one person must
 * not disagree about visibility, which is why the two mechanisms answer two different questions and
 * neither is expressed in the other (§7.5.3a).
 *
 * **A profile grants nothing.** Every value it carries removes: the tool set is an intersection, and
 * a ceiling only lowers. That is the property that lets these settings move to an editable store
 * later without the edit becoming a privilege escalation (`ADR-002` §8.5, R-29.4).
 */

/**
 * The seven settings of one access profile — column for column with `access_profiles`
 * (`data-model.md` §4.5.3), field for field with `security.md` §7.5.3a.
 *
 * **Why every value is accompanied by its mode.** "Unlimited" is DECLARED, never inferred from a
 * missing value. A `null` meaning unlimited cannot be told apart from a profile that was never
 * provisioned — the L-10 class of defect, where 43 chains of 458 answered a confident "not deployed"
 * and both gates stayed green. The three `CHECK` pairs of §4.5.3 hold the same distinction at the
 * engine level; this type holds it in the process.
 *
 * **Why `creditsBalanceRaw` is a string.** Credits are exact integers, and a JS number loses
 * precision past 2^53 — which is why §4.5.3 declares the column `TEXT` (DB-SCHEMA §1.7). Parsing it
 * into a number here would spend the exactness the column exists to preserve, one layer above the
 * storage that preserved it.
 *
 * **Why the seventh field has no paired value.** Three settings pair a mode with a quantity. Route
 * disclosure has no quantity, so the mode is the whole value; the column is `NOT NULL` and has no
 * unprovisioned state.
 *
 * **What this shape deliberately omits.** `access_profiles` also holds `name`, `status`,
 * `created_at`, `updated_at`. §7.5.3a declares seven fields and only seven, and the R-13.3a gate
 * counts exactly these seven names. A supplier that must refuse a retired profile REFUSES — the
 * reader's contract is fail-closed — rather than growing an eighth field for a caller to interpret.
 */
export interface AccessProfile {
  readonly creditsMode: 'unlimited' | 'metered';
  readonly creditsBalanceRaw: string | null; // exact value as a string
  readonly rateLimitMode: 'unlimited' | 'metered';
  readonly rateLimitPerMin: number | null;
  readonly toolAllowlistMode: 'all' | 'list';
  readonly toolAllowlist: readonly string[] | null;
  readonly routeDisclosureMode: 'full' | 'none'; // R-20.4 — data-model.md §4.5.3
}

/**
 * The one interface profile values are read through, never from the place they are stored (R-13.2).
 *
 * **Why asynchronous with a synchronous supplier behind it today.** The second supplier is a table
 * behind a connection. A synchronous signature would have to be rewritten to admit it (R-13.3), and
 * every caller rewritten with it — which is the rewrite this declaration exists to avoid. AC-38
 * observes the substitution rather than asserting it: two suppliers, one unchanged reader.
 *
 * **Why the result is `AccessProfile` and not `AccessProfile | null`.** A reader that could answer
 * "nothing" would hand every caller a third case to interpret, and the interpretation that costs
 * nothing to write is "then there is no narrowing" — the exact shape of a fail-OPEN. A supplier that
 * cannot answer REJECTS: a failed read at session creation refuses the session, and a failed read on
 * the request path refuses the request. No default profile is substituted (§7.5.3a).
 *
 * **Why fail-closed rather than a default.** A substituted default would widen an inventory or a
 * ceiling at the exact moment the settings source is unavailable — the one moment nobody is watching
 * it.
 */
export interface AccessProfileReader {
  read(accessProfileId: string): Promise<AccessProfile>;
}

/**
 * Thrown by a supplier that cannot answer. Carries the profile id and nothing else (D10).
 *
 * The id is not a secret — it is a ULID the operator provisioned — and naming it is what makes the
 * refusal actionable. The values behind it are never rendered.
 */
export class AccessProfileUnavailableError extends Error {
  constructor(
    readonly accessProfileId: string,
    readonly cause_: string,
  ) {
    super(`access profile ${accessProfileId} could not be read: ${cause_}`);
    this.name = 'AccessProfileUnavailableError';
  }
}

/**
 * **Where the tool list is applied, and why no predicate lives here.**
 *
 * §3.4.9 names ONE application point: the registration loop of `createServer`, once per session. A
 * convenience predicate beside this declaration was written and removed — with a single consumer it
 * added a second place the mode/list pairing is spelled out, which is what R-13.3a exists to
 * prevent, and it would have made §7.5.3a's named exception for `server.ts` cover a read that no
 * longer happened there. The rule is stated once, in the loop that applies it.
 *
 * When a second consumer appears, the pairing moves here and both read it through one function —
 * that is the change to make then, not now.
 */
