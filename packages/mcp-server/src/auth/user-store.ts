/**
 * The `users` repository (`data-model.md` §4.5.3) — declared here as a named seam, filled in by
 * task 014-06.
 *
 * **Why the file exists before its methods do.** Task 014-02's own table of ownership assigns
 * `createUser` / `findUser` / `listUsers` to task 014-06 and the implementation to 014-07. What this
 * task owes is the address: a declared name the barrel exports and the later tasks edit, so the
 * repository count is five from the first commit and nobody invents a sixth path to the same table.
 *
 * **Why `mcp-server` and not `core`.** `security.md` §7.5.1 keeps identity beside the transport that
 * needs it; `packages/core` receives no knowledge of tokens, roles or headers.
 *
 * **Why the identity types are not declared here either.** `Role`, `User`, `ApiToken`,
 * `TokenLookupRow` and `AccessAuditEntry` belong to `auth/identity-types.ts`, a file task 014-06
 * creates. Declaring a `User` here would give that task a type to reconcile instead of a file to
 * write, and two declarations of one row is the defect this split exists to avoid.
 */

/**
 * Reading and writing `users`.
 *
 * Deliberately memberless in task 014-02, and the emptiness is the recorded seam rather than an
 * oversight — see this module's docstring. Because it is empty, this interface constrains nothing
 * yet: a stub "implementing" it proves only that the name resolves. That is the whole claim
 * task 014-02 makes about this file, and no test here should be read as more.
 *
 * **The lint exemption below is the record of that, not a silenced complaint.**
 * `@typescript-eslint/no-empty-object-type` is right on the facts — an empty interface admits any
 * non-nullish value, `0` included — and the exemption is accepted for exactly as long as the
 * members are another task's to declare. Task 014-06 adds them and the directive goes with them:
 * an empty interface then stops being a seam and starts being a hole. The directive is written on
 * ONE line deliberately: `eslint-disable-next-line` applies to the line after the comment, so a
 * rationale wrapped onto a second line would aim the exemption at the wrong line and leave the
 * declaration reported anyway.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 014-06 declares the members
export interface UserStore {}

/**
 * The stub, `[STUB]` in the task title's sense. It answers no call because the interface declares
 * none; task 014-06 adds the methods and 014-07 replaces this with the repository over
 * `engine/pg-engine-store.ts` (task 014-03).
 */
export function createUserStoreStub(): UserStore {
  return Object.freeze({});
}
