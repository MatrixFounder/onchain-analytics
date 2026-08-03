import type { ZodError } from 'zod';

/**
 * The `reason` a tool reports when a provider's result fails that tool's own output contract —
 * declared ONCE, read by every tool that validates an output (WI-27).
 *
 * **Bounded on purpose.** `ZodError.message` is `JSON.stringify(issues, null, 2)`
 * (`zod@4.4.3/v4/core/errors.js`), so its length grows with the number of failing ELEMENTS, not with
 * the number of distinct problems. Three tools used to interpolate it whole. For
 * `dex.volume.history` the series can hold 1825 points, so a per-element failure rendered on the
 * order of **200 KB of JSON in a single `isError` frame** — sent to the model, over a single-threaded
 * stdio transport. One issue names the defect just as precisely and costs a line.
 *
 * **`capability` is carried, and that is a correction.** The first version of this helper dropped it,
 * on the reasoning that "the tool name is in the `isError` frame anyway". It is not:
 * `registry.ts`'s `toCallToolResult` renders `{isError: true, content: [{type: 'text', text:
 * outcome.reason}]}` and nothing else, and MCP's `CallToolResult` does not echo the tool name — so
 * nine tools would have emitted one byte-identical string, and a server-side log of `reason` would
 * no longer say which tool produced it. The client can still correlate by request id; a log line
 * cannot. One parameter buys that back without giving up the single declaration.
 *
 * **What it does NOT carry.** No provider VALUES: zod v4 strips `input` from finalized issues unless
 * `reportInput` is set (`v4/core/util.js`), so only schema paths and schema-authored messages appear
 * here. That is why the finding this closes was severity low rather than medium — the volume was the
 * defect, not a leak. The residual is that a `z.record()`/`.catchall()` output schema would put a
 * PROVIDER-CONTROLLED KEY into `issue.path`; no tool has one, and `contract-violation.test.ts` holds
 * that line so adding one cannot quietly reopen the channel.
 *
 * **One declaration rather than nine copies.** The same five lines were pasted into six tools while
 * three others diverged; the divergence is exactly what nobody noticed for four shipped tasks. A
 * synchronized copy has to be re-synchronized on every future change — a declaration does not
 * (`vdd-enhanced` §4.6).
 */
/** Hard ceiling on the rendered reason. Long enough for a real path plus a real message; short
 * enough that no single issue can flood the model's context. */
const MAX_REASON_CHARS = 500;

export function contractViolationReason(capability: string, error: ZodError): string {
  const firstIssue = error.issues[0];
  // `map(String)`, not a bare `join`: `issue.path` is `PropertyKey[]`, and `Array.prototype.join`
  // THROWS a TypeError on a symbol element. Unreachable with today's schemas, and this is the one
  // function in the server that renders a path — the cheapest possible place to make the invariant
  // every call site asserts ("never throws out of the handler") true by construction rather than by
  // the shape of the schemas that happen to exist.
  const path =
    firstIssue && firstIssue.path.length > 0 ? firstIssue.path.map(String).join('.') : '(root)';
  const message = firstIssue?.message ?? 'invalid output shape';
  // Capped, because bounding the issue COUNT is not the same as bounding the STRING (adversarial
  // cycle 2). Every output schema here is `.strict()`, and zod renders an `unrecognized_keys` issue
  // as `Unrecognized key(s): a, b, c…` — provider-influenced names, growing with how many the vendor
  // sent. One issue can therefore still be arbitrarily long. A slice makes the bound structural
  // instead of dependent on which issue happened to come first, which is the same argument that put
  // `map(String)` on the line above.
  const reason = `provider returned data violating the tool contract (${capability}): ${path}: ${message}`;
  return reason.length <= MAX_REASON_CHARS ? reason : `${reason.slice(0, MAX_REASON_CHARS)}…`;
}
