/**
 * The refusal a REGISTERED tool answers with while its logic is still owed by a named task —
 * task 014-32b, Stub-First (`docs/PLAN.md:41`).
 *
 * **Why a refusal rather than an empty value.** On `onchain_pool_info` an empty object and on
 * `onchain_token_pools` an empty array are both indistinguishable from a real answer: "a pool
 * holding no tokens" and "a token trading in no pools". A stub returning either produces a response
 * with no mark of incompleteness — the L-10 failure class this project keeps filing, and the shape
 * memory M6 warns about (a new legal answer widens what the gate accepts).
 *
 * **Why the message names the task.** A refusal saying "not implemented" tells a reader that
 * something is missing and not who owes it. Naming the task makes the interval closable by anyone
 * who reads the response, and makes a stub that outlives its task visible in its own output rather
 * than only in a list somebody has to remember to check.
 *
 * **Why this file is a third declared producer of `{ok: false}`.**
 * `test/tools-refusal-class.test.ts` forbids a tool module from building a refusal by hand, because
 * `request_trace.refusal_class` is `NOT NULL` by CHECK constraint and a hand-built refusal is a row
 * the engine rejects on the failure path. The gate's subject is the missing CLASS, not the count of
 * files: this producer always carries one, which is exactly what the gate asks for.
 */

/**
 * The class recorded in `request_trace.refusal_class` for a stub interval.
 *
 * **Not an error class name, for the same reason `OUTPUT_CONTRACT_REFUSAL_CLASS` is not.** There is
 * no `Error` instance here — the handler branches, it does not throw — and inventing a throw to
 * have a name would put a stack unwind on a plain branch. The constant IS the name of the refusal.
 *
 * A distinct value from `OutputContractViolation` on purpose: a stub interval and a provider
 * returning malformed data are different facts about a request, and a shared name would merge them
 * in the one column that separates them.
 */
export const STUB_REFUSAL_CLASS = 'ToolLogicNotShipped';

/**
 * Builds the refusal for a tool whose `ToolSpec` is registered and whose logic is not shipped.
 *
 * @param capability the manifest capability the tool serves, so the reason names what is unserved
 * @param task the task id that removes this stub — e.g. `014-32c`
 */
export function stubRefusal(
  capability: string,
  task: string,
): { ok: false; reason: string; refusalClass: string } {
  return {
    ok: false,
    reason:
      `this tool is registered and its logic is not shipped yet: ${capability} is answered by ` +
      `task ${task}. No partial answer is returned, because an empty result here is ` +
      `indistinguishable from a real one.`,
    refusalClass: STUB_REFUSAL_CLASS,
  };
}
