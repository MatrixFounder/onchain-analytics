import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { adapterRegistrations } from '@onchain-intel/core';
import type { DiagnosticEvent } from '../engine/diagnostics-store.js';
import { EnvSchema } from '../env.js';

/**
 * Every way this server refuses, and at which of the TWO levels it is represented (task 014-25,
 * R-26, AC-32, AC-33).
 *
 * **Why a list at all.** RISK-5 is a protocol refusal rendered as a tool result: the client reads
 * `200` with `isError: true` inside and treats a rejected token as a tool that had a bad day. The
 * two levels are told apart by WHERE the refusal is decided, not by how bad it is — a request that
 * never reaches a handler cannot be answered by one.
 *
 * **Why the tool-execution form needed no code written for it.** `toCallToolResult` already renders
 * every unsuccessful outcome as `{ isError: true, content: [{ type: 'text', text: reason }] }`
 * (`tools/registry.ts`), and `defineTool` is the only registration path, so the shape covers every
 * tool in the registry. That is worth saying out loud, because an acceptance criterion phrased as
 * "a failure must not be rendered as a success with text inside" would pass on an untouched tree:
 * MCP's prescribed success form looks the same. What tells them apart is the FLAG, which is what
 * {@link assertRefusalIsFlagged} measures.
 *
 * **Why the protocol forms match the SDK's own, value for value.** Two of the five are produced by
 * this listener and three by the SDK transport underneath it, and a client that had to parse two
 * dialects to learn it was refused would be parsing ours wrong on the day the SDK answered first.
 * The 404 and 405 shapes below are copied from `webStandardStreamableHttp.js`
 * (`createJsonErrorResponse(404, -32001, 'Session not found')` and `handleUnsupportedRequest`).
 */

export type FailureLevel = 'protocol' | 'tool-execution';

interface FailureClassBase {
  /** Stable id — the key a test, a runbook and task 014-26's table all name the class by. */
  readonly id: string;
  readonly level: FailureLevel;
  /** Whether a tool handler runs at all. The whole point of the split (AC-32). */
  readonly reachesTool: boolean;
  /**
   * The `diagnostics` event this refusal writes, where it writes one.
   *
   * `null` is not an omission: `unknown-session` and `method-not-allowed` conceal nothing, so there
   * is no fuller text to recover and no identifier to hand out. Task 014-26 reads this column.
   */
  readonly diagnosticEvent: DiagnosticEvent | null;
}

export interface ProtocolFailureClass extends FailureClassBase {
  readonly level: 'protocol';
  readonly reachesTool: false;
  readonly httpStatus: number;
  readonly jsonRpcCode: number;
  /** Headers without which the status is not actionable — `Retry-After`, `WWW-Authenticate`. */
  readonly requiredHeaders: readonly string[];
}

export interface ToolFailureClass extends FailureClassBase {
  readonly level: 'tool-execution';
  readonly reachesTool: true;
  /**
   * Recognizes the class in a rendered text. It is what makes {@link assertRefusalIsFlagged} able to
   * catch a refusal that was handed back as a success — without a marker the gate could only check
   * results that already admit to being failures, which is the tautology R-26 is guarding against.
   */
  readonly marker: RegExp;
  /** Where the text is produced, so the marker can be re-checked against its source, not guessed. */
  readonly producedAt: string;
}

export type FailureClass = ProtocolFailureClass | ToolFailureClass;

export const FAILURE_CLASSES: readonly FailureClass[] = Object.freeze([
  {
    id: 'auth',
    level: 'protocol',
    reachesTool: false,
    httpStatus: 401,
    jsonRpcCode: -32000,
    // The challenge is what makes this a 401 rather than a bare refusal; the four internal states
    // (unknown, revoked, expired, suspended) answer one status and are told apart in diagnostics.
    requiredHeaders: ['www-authenticate'],
    diagnosticEvent: 'auth.rejected',
  },
  {
    id: 'perimeter',
    level: 'protocol',
    reachesTool: false,
    httpStatus: 403,
    jsonRpcCode: -32000,
    requiredHeaders: [],
    diagnosticEvent: 'perimeter.rejected',
  },
  {
    id: 'session-limit',
    level: 'protocol',
    reachesTool: false,
    httpStatus: 503,
    jsonRpcCode: -32000,
    // Without it the refusal is a timeout with better manners (task 014-13).
    requiredHeaders: ['retry-after'],
    diagnosticEvent: 'session.limit_reached',
  },
  {
    id: 'unknown-session',
    level: 'protocol',
    reachesTool: false,
    httpStatus: 404,
    jsonRpcCode: -32001,
    requiredHeaders: [],
    // Nothing is concealed: the caller presented an id this process does not know, and that is the
    // whole of it.
    diagnosticEvent: null,
  },
  {
    id: 'method-not-allowed',
    level: 'protocol',
    reachesTool: false,
    httpStatus: 405,
    jsonRpcCode: -32000,
    requiredHeaders: ['allow'],
    diagnosticEvent: null,
  },
  /**
   * The four below are matched against the text a CLIENT sees, which is not always the text its
   * producer wrote.
   *
   * `resolve-capability.ts` collapses every throw from `registry.resolve()` into `error.message`,
   * and the registry wraps a traversal in one of two classes whose message embeds each attempt as
   * `adapterId (reason)`. So the limiter's own sentence and the budget gate's own sentence arrive
   * NESTED inside a `capability …` text, and a marker written against the producer's line alone
   * would match nothing on the wire. Measured against the constructors in
   * `packages/core/src/adapters/registry.ts` and `nansen/budget-gate.ts`.
   */
  {
    id: 'limiter-saturated',
    level: 'tool-execution',
    reachesTool: true,
    /**
     * The wait inside the shared limiter, ended by the call deadline — thrown as
     * `DeadlineExceededError('provider "…"')` and delivered as `CapabilityDeadlineExceededError`.
     *
     * **Its outer text is identical to `deadline-expired`'s, and since L-26 the two are still
     * distinguishable.** Both arrive as `capability deadline exceeded: …`, so this marker stays
     * broad on purpose — it is the safety net asserting that a refusal carries `isError`, and a
     * narrower one would stop catching the case it exists for. What tells them apart now is the
     * PHASE: every `DeadlineExceededError` names it, `toClientText` lifts it to the caller as
     * `[phase: limiter]` or `[phase: wire]`, and the operator's diagnostics row carries the whole
     * sentence. They were always two classes because the next action differs — widen the limiter's
     * rate, or chase the vendor — and now the wire says which.
     */
    marker: /capability deadline exceeded: /i,
    producedAt: 'packages/core/src/net/rate-limit.ts',
    diagnosticEvent: 'tool.refused',
  },
  {
    id: 'budget-exhausted',
    level: 'tool-execution',
    reachesTool: true,
    // Two producers, one class: the store's own refusal and the Nansen gate that fail-closes ahead
    // of it. Both reach the client nested in a `capability unavailable:` attempt list.
    marker: /budget exceeded for provider=|budget gate refused: /i,
    producedAt: 'packages/core/src/cache/budget-store.ts',
    diagnosticEvent: 'tool.refused',
  },
  {
    id: 'capability-unavailable',
    level: 'tool-execution',
    reachesTool: true,
    marker: /capability unavailable: /i,
    producedAt: 'packages/core/src/adapters/registry.ts',
    diagnosticEvent: 'tool.refused',
  },
  {
    id: 'deadline-expired',
    level: 'tool-execution',
    reachesTool: true,
    marker: /capability deadline exceeded: /i,
    producedAt: 'packages/core/src/net/safe-fetch.ts',
    diagnosticEvent: 'tool.refused',
  },
  /**
   * Task 015-15 (ADR-003 D6, R-9/R-11, `system-architecture.md` §3.5.4) — the daily call gate's
   * refusal, distinct from `budget-exhausted` (a CREDIT ceiling) and from `limiter-saturated` (a
   * per-second rate). Reaches the client nested exactly like `budget-exhausted` does — `blockscout`
   * is the sole adapter on `token.holders`/`chain.transactions`, so `registry.ts` wraps its throw as
   * `blockscout (daily call ceiling reached: …)` inside a `capability unavailable: … — tried: …`
   * envelope, and WITHOUT this class `toClientText` would cut everything past the traversal marker
   * and leave "unavailable" — indistinguishable from a chain this provider never serves, i.e. from
   * NEVER instead of RETRY TOMORROW.
   *
   * Marker matched against `ProviderCallCeilingExceededError`'s own text
   * (`packages/core/src/adapters/blockscout/call-gate.ts`), never against its sibling
   * `ProviderCallGateUnavailableError` — that class's text starts `daily call gate unavailable: `
   * and never contains `ceiling reached` (see that class's own docstring for why the two must not
   * share a substring: a corrupted ledger is not an exhausted ceiling).
   */
  {
    id: 'call-ceiling',
    level: 'tool-execution',
    reachesTool: true,
    marker: /daily call ceiling reached: /i,
    producedAt: 'packages/core/src/adapters/blockscout/call-gate.ts',
    diagnosticEvent: 'tool.refused',
  },
] satisfies readonly FailureClass[]);

export const PROTOCOL_FAILURE_CLASSES: readonly ProtocolFailureClass[] = FAILURE_CLASSES.filter(
  (entry): entry is ProtocolFailureClass => entry.level === 'protocol',
);

export const TOOL_FAILURE_CLASSES: readonly ToolFailureClass[] = FAILURE_CLASSES.filter(
  (entry): entry is ToolFailureClass => entry.level === 'tool-execution',
);

/**
 * The keys a PROTOCOL refusal body must not carry (AC-32).
 *
 * A body with any of them is a tool result, whatever the status line says — and a client that
 * unwraps `content[0].text` gets a refusal it never called a tool for.
 */
export const TOOL_RESULT_KEYS = Object.freeze(['isError', 'content', 'structuredContent']);

/**
 * Whether a response body is a tool result rather than a protocol refusal.
 *
 * **Why this is a function and not a loop written inside the test.** A list can be emptied, and an
 * empty list makes the loop that reads it pass everything — the gate would be green because it
 * stopped asking, which is the shape L-10 and memory M6 name. As a function it has an input, and a
 * test can prove it answers `true` for an envelope and `false` for a JSON-RPC error.
 */
export function isToolResultEnvelope(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  return TOOL_RESULT_KEYS.some((key) => Object.hasOwn(body, key));
}

/**
 * The separator the registry puts between a refusal and its attempt list
 * (`packages/core/src/adapters/registry.ts` — `\`… — tried: ${triedText}\``).
 *
 * Everything after it is the TRAVERSAL: which adapters were entered, in what order, and what each
 * one said. Task 014-26 removes it from the client rendering, and the reason is not that the text is
 * long — the order tells a caller which provider is free and which is paid, which is a fact about
 * our unit economics rather than about their request.
 */
export const TRAVERSAL_MARKER = ' — tried: ';

/**
 * Tokens a client rendering must never contain, read from the repository's own two sources.
 *
 * **Why the redactor and the gate read ONE list.** A scrub list written by hand beside a test that
 * checks a different list is two lists, and the day they disagree the one that stops matching is the
 * redactor. `adapterRegistrations` and `EnvSchema` are where these names are declared, so a
 * thirteenth adapter or a new key is covered by both at the same instant.
 */
export const OPERATOR_TOKENS: readonly string[] = Object.freeze([
  ...adapterRegistrations.map((registration) => registration.id),
  ...Object.keys(EnvSchema.shape),
]);

/** What a client is told when nothing more specific can be said safely. */
export const GENERIC_REFUSAL = 'the call was refused';

const BUDGET_CLASS_ID = 'budget-exhausted';
/** Task 015-15 — the tenth class, resolved past `toClientText`'s traversal cut the SAME way
 * `BUDGET_CLASS_ID` above already is. See that constant's own use, a few lines down, for why a
 * class is matched against the WHOLE reason rather than patched into the traversal-cut `head`. */
const CALL_CEILING_CLASS_ID = 'call-ceiling';

function containsOperatorToken(text: string): boolean {
  const lowered = text.toLowerCase();
  return OPERATOR_TOKENS.some((token) => lowered.includes(token.toLowerCase()));
}

/**
 * The CLIENT half of a refusal (task 014-26, R-20, AC-47).
 *
 * The operator half is the `diagnostics` row: full text, unedited. This one carries as much as can
 * be said without describing the inside of the process, plus the row id — which is what makes the
 * pair recoverable rather than merely halved. An identifier that resolves to nothing is worse than
 * no identifier (§"Порядок записи"), so the caller emits FIRST and renders with the id it got.
 *
 * Three steps, fail-closed at each:
 *
 * 1. Cut the traversal. `capability unavailable: entity.labels on ethereum` survives — the caller
 *    asked for both of those — and the attempt list does not.
 * 2. A budget refusal is replaced outright rather than trimmed: its sentence is built from the
 *    operator's remaining credits and ceiling, and there is no prefix of it that is safe.
 * 3. Anything still naming an adapter or an environment key is replaced by {@link GENERIC_REFUSAL}.
 *    Not patched in place: a surgical substitution assumes the rest of an unrecognised sentence is
 *    safe, and the whole point of this step is that it is the sentence nobody classified.
 */
/**
 * The closed set of `DeadlinePhase` values, restated here as STRINGS on purpose (L-26).
 *
 * `packages/core` owns the type; this file owns what may cross the client boundary, and those are
 * two different questions. Importing the type would tie the boundary's allowlist to a union that a
 * future edit could widen without anyone looking at this file — and the whole point of step 3 below
 * is that an unclassified word never reaches a caller. A phase this list does not know is simply
 * not rendered, which fails closed.
 */
const RENDERABLE_DEADLINE_PHASES: readonly string[] = [
  'limiter',
  'wire',
  'shared-document',
  'coalesced',
  'pg-query',
];

/**
 * Lifts the deadline PHASE out of the traversal text that step 1 cuts away (L-26, fix-path item 1).
 *
 * **Why it is worth rescuing exactly this token.** The head of a deadline refusal —
 * `capability deadline exceeded: token.price on tron` — tells a caller that the call ran out of
 * budget and nothing about where the budget went. The tail knows, and the tail cannot be shown: it
 * names adapters. The phase is the one word in it that names none, and it is the word that decides
 * the operator's next move — our own queue is a rate to widen or a sweep to narrow, the wire is a
 * vendor to chase. Before this, both arrived as the same sentence, and two investigations on
 * 2026-08-24 each began by trying to recover the difference after the fact and could not.
 */
function deadlinePhaseOf(reason: string): string | null {
  const found = /deadline exceeded in ([a-z-]+)/i.exec(reason)?.[1]?.toLowerCase();
  if (found !== undefined && RENDERABLE_DEADLINE_PHASES.includes(found)) return found;
  // **The limiter refuses under TWO classes, and labelling only one was this fix applied halfway.**
  // `DeadlineExceededError` is the wait that ran out; `DeadlineWouldExceedError` is the wait that
  // was never begun because it would not have left enough of the deadline to be worth issuing. Both
  // are our own queue and both end as `capability deadline exceeded: …` for the caller — so a
  // refusal of the second kind rendered no phase at all, which is how the first live occurrence
  // after this feature shipped (`ethereum/protocol.incidents`, 2026-08-24, 15 008 ms against a
  // document `curl` fetched in 0.46 s) still could not say where its budget went.
  //
  // Matched on the limiter's own sentence, and ONLY the closed-set word `limiter` is rendered from
  // it — the provider name in that text stays on the operator's side of the boundary.
  return /throttle: rejected for provider /i.test(reason) ? 'limiter' : null;
}

export function toClientText(reason: string, eventId: string | null): string {
  const suffix = eventId === null ? '' : ` (event ${eventId})`;
  const head = (reason.split(TRAVERSAL_MARKER)[0] ?? reason).trim();
  const phase = deadlinePhaseOf(reason);

  // Against the WHOLE reason, traversal included, and that is a decision rather than an oversight.
  // A budget refusal reaches a caller nested inside `capability unavailable: … — tried: nansen
  // (budget …)`, so matching only the head would tell the caller "unavailable" — indistinguishable
  // from "this chain is not served", which is the difference between "retry later" and "never".
  // The budget FACT names nothing on the forbidden list; the arithmetic behind it does, which is
  // why the sentence is replaced outright rather than trimmed.
  const budget = TOOL_FAILURE_CLASSES.find((entry) => entry.id === BUDGET_CLASS_ID);
  if (budget !== undefined && budget.marker.test(reason)) {
    return `the provider budget for this call is exhausted${suffix}`;
  }
  // Task 015-15 — the SAME precedent, one class down: `blockscout`'s daily-call refusal reaches a
  // caller nested inside `capability unavailable: … — tried: blockscout (daily call ceiling
  // reached: …)`, past the traversal cut `head` never sees. Replaced outright, not trimmed, for the
  // identical reason the budget sentence is: the fact ("the ceiling is reached, try tomorrow")
  // names nothing forbidden, but the reason text behind it names the provider and its counters.
  const callCeiling = TOOL_FAILURE_CLASSES.find((entry) => entry.id === CALL_CEILING_CLASS_ID);
  if (callCeiling !== undefined && callCeiling.marker.test(reason)) {
    return `the daily call ceiling for this provider is reached — try again tomorrow${suffix}`;
  }
  if (head === '' || containsOperatorToken(head)) return `${GENERIC_REFUSAL}${suffix}`;
  // Appended AFTER the operator-token check, never woven into the head: the check must see the
  // sentence the traversal produced, not one this function has already edited.
  return phase === null ? `${head}${suffix}` : `${head} [phase: ${phase}]${suffix}`;
}

export class RefusalRenderedAsSuccessError extends Error {
  constructor(
    readonly classId: string,
    readonly text: string,
  ) {
    super(
      `a ${classId} failure was rendered WITHOUT isError — the client reads it as an answer: ${text}`,
    );
    this.name = 'RefusalRenderedAsSuccessError';
  }
}

/**
 * AC-33's gate: a tool-execution failure is never handed back as a success.
 *
 * It reads the rendered result, not the outcome that produced it — the defect it exists for is a
 * handler that returns `ok: true` carrying a refusal in its payload, and an outcome-level check
 * would believe that handler. `isError: true` clears it whatever the text says: a flagged failure is
 * the correct rendering, and this gate has no opinion about the words.
 */
export function assertRefusalIsFlagged(result: CallToolResult): void {
  if (result.isError === true) return;
  const rendered = JSON.stringify(result);
  for (const entry of TOOL_FAILURE_CLASSES) {
    if (entry.marker.test(rendered)) throw new RefusalRenderedAsSuccessError(entry.id, rendered);
  }
}
