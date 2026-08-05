/**
 * The ANSWER POLICY of a route, as data — ADR-002 **D2** (closes OQ-4), task 012-6.
 *
 * A route used to carry a literal predicate (`CapabilityRoute.isSatisfying`, TASK-008 H-1). This
 * module replaces it with a serialisable descriptor `{ kind, ...params }` plus the dictionary of
 * classes that descriptor names are resolved against. Two consequences the function form could not
 * give: the policy of a route can be written down in a config file that is not TypeScript, and a
 * `kind` nobody implements is caught when `CapabilityRegistry` is CONSTRUCTED rather than on the
 * first request that happens to walk that route (see `UnregisteredPolicyClassError`).
 *
 * **This is a dictionary of NAMES, not a policy engine, and it is meant to stay one.** Weights,
 * partial merges and multi-source collection belong to the router that D5/T-013 designs; ADR-002
 * §"Что отклонено" п.7 rejects the nearest near-miss (a configurable field mapping) on the same
 * ground. Exactly two classes ship, and there is deliberately no third: the first candidate ("is
 * what I have COLLECTED enough") is a different question, and it arrives with the merge rule that
 * does not exist yet. A class with no consumer is a guess about the consumer.
 */

/**
 * What a route declares about "is this answer enough, or keep walking".
 *
 * Absence of the field means `{ kind: 'any' }` — 20 of the 21 production routes carry no descriptor
 * at all, and writing one on each of them would be ceremony, not information.
 */
export type PolicyDescriptor = { kind: 'any' } | { kind: 'someElementHasAny'; fields: string[] };

/** "Does this normalized result answer the request?" — what a class builds and a route caches. */
export type PolicyPredicate = (result: unknown) => boolean;

/**
 * A policy CLASS: given the route's descriptor, build the predicate it describes.
 *
 * A builder rather than a bare predicate because the parameters are per-ROUTE (`fields`) while the
 * class is per-KIND, and because `CapabilityRegistry` resolves each route's predicate ONCE, at
 * construction, instead of re-reading the descriptor on every answer.
 */
export type PolicyClass = (descriptor: PolicyDescriptor) => PolicyPredicate;

/**
 * Every implemented policy class, keyed by the `kind` a route names.
 *
 * Indexed with a plain `string` on purpose: the `kind` reaching the registry can come from a cast,
 * a JSON-shaped config or a hand-edited table, so the lookup must be able to MISS. That miss is
 * validation step 2 in `CapabilityRegistry`'s constructor.
 *
 * **The miss is decided with `Object.hasOwn`, not with `=== undefined` on the index** (adversarial
 * cycle 2, F-8). This is a plain object literal, so `policyClasses['constructor']` answers with
 * `Object` and `['toString']`/`['valueOf']`/`['hasOwnProperty']` with their prototype members — a
 * `kind` spelled like one of them resolved to a "class", `UnregisteredPolicyClassError` never fired,
 * and the route's policy fail-opened: `Object({kind:'constructor'})` returns a truthy object, so
 * every answer satisfied it and H-1's shadowing came back by way of a name. Making the dictionary
 * `Object.create(null)`-based would close it here instead; the guard was put at the lookup because
 * that is where the same mistake is made for `manifests`, and one rule is easier to keep than two.
 *
 * **Why `someElementHasAny` is not called `nonEmpty`, and why that is not a taste question.**
 * A literal "the array is not empty" reading reproduces defect **H-1** exactly: Blockscout answers
 * `entity.labels` with an array of ONE entry carrying no name and empty `tags`/`labels` — a
 * non-empty array with nothing in it. A `nonEmpty` predicate accepts that as an answer, ends the
 * route there, and shadows the paid source that would have known, for the whole 3600 s TTL. The
 * name has to say that CONTENT is what is being looked for, in named fields, not that a container
 * has a length. The prohibition is on the identifier — export name, dictionary key, alias, variable
 * or type name — and `test/policy.test.ts` holds the gate that keeps it out of `src` and `test`.
 */
export const policyClasses: Readonly<Record<string, PolicyClass>> = {
  /** Everything answers. The default, and what the ABSENCE of a descriptor resolves to. */
  any: () => () => true,

  /**
   * The result must be an array, and at least ONE of its elements must carry CONTENT under at
   * least one of the descriptor's `fields`.
   *
   * Both quantifiers are load-bearing and neither is decoration:
   * - "at least one ELEMENT" — Blockscout answers `entity.labels` with a one-element array; a
   *   predicate reading `result[0]` alone would agree with this on every recorded fixture and
   *   disagree the first time a provider returns two rows.
   * - "at least one FIELD" — an entity can be identified by a name, by tags, or by labels, and
   *   demanding all three would send answerable questions to the paid provider.
   */
  someElementHasAny: (descriptor) => {
    // Narrowed by `in`, not trusted from the union: the `kind` that selected this class arrives as
    // a plain string (see the dictionary's docstring), so the params may not match it. A descriptor
    // carrying no fields reads nothing and therefore satisfies nothing — which is the safe
    // direction: it hands the question to the next provider rather than ending the walk.
    const fields = 'fields' in descriptor ? descriptor.fields : [];
    return (result) =>
      Array.isArray(result) &&
      result.some((entry) => {
        if (entry === null || typeof entry !== 'object') return false;
        const record = entry as Record<string, unknown>;
        return fields.some((field) => hasContent(record[field]));
      });
  },
};

/**
 * Content, as opposed to presence — the distinction the whole class exists for.
 *
 * A non-empty string or a non-empty array; everything else (`''`, `[]`, `null`, `undefined`, a
 * number, an object) carries nothing this policy can call an answer. Arrays are judged by LENGTH
 * and not recursively: `['']` counts, exactly as the retired literal counted it, because a vendor
 * that returned a tag at all made a statement about the address.
 */
function hasContent(value: unknown): boolean {
  if (typeof value === 'string') return value !== '';
  return Array.isArray(value) && value.length > 0;
}
