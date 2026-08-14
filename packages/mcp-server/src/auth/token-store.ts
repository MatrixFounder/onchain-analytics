/**
 * The `api_tokens` repository, and — through `appendAudit` — the `access_audit` journal
 * (`data-model.md` §4.5.4, §4.5.5). Declared here as a named seam, filled in by task 014-06.
 *
 * **Why the file exists before its methods do.** Task 014-02's table of ownership assigns `issue`,
 * `lookup`, `revoke` and `appendAudit` to task 014-06 and the implementation to 014-07. This task
 * owes the address, not the surface.
 *
 * **Why the access journal gets no repository of its own.** `access_audit` is reached by
 * `appendAudit` on this store (task 014-02, «Why журнал доступа не получает шестого стора»). Five
 * repositories stay five: the journal is written on the same paths that issue and revoke, and a
 * sixth store would be a second way to reach one table.
 *
 * **Why `mcp-server` and not `core`.** `security.md` §7.5.1 keeps identity beside the transport that
 * needs it; `packages/core` receives no knowledge of tokens, roles or headers.
 *
 * **The stub must not reach a running network profile.** Task 014-07 introduces the CSPRNG, the
 * peppered digest, revocation and the journal's append-only guard. Until then a fixed answer from
 * here would be a credential check that always agrees — which is why task 014-06's own notes forbid
 * it on the startup path of the network profile.
 */

/**
 * Issuing, looking up and revoking `api_tokens`, plus appending to `access_audit`.
 *
 * Deliberately memberless in task 014-02, and the emptiness is the recorded seam rather than an
 * oversight — see this module's docstring. Because it is empty, this interface constrains nothing
 * yet: a stub "implementing" it proves only that the name resolves.
 *
 * **The lint exemption below is the record of that, not a silenced complaint** — same reasoning,
 * and same one-line form, as `user-store.ts`: `eslint-disable-next-line` binds to the line
 * immediately after the comment, so a rationale wrapped onto a second line would exempt that line
 * instead of the declaration.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 014-06 declares the members
export interface TokenStore {}

/**
 * The stub, `[STUB]` in the task title's sense. It answers no call because the interface declares
 * none; task 014-06 adds the methods and 014-07 replaces this with the repository over
 * `engine/pg-engine-store.ts` (task 014-03).
 */
export function createTokenStoreStub(): TokenStore {
  return Object.freeze({});
}
