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
     * **Its outer text is IDENTICAL to `deadline-expired`'s, and that is recorded rather than
     * papered over.** Both arrive as `capability deadline exceeded: …`; which of the two happened
     * is legible only from the nested attempt reason. They stay two classes because the operator's
     * next action differs — raise the limiter's rate, or raise the deadline — and the gate does not
     * need them disjoint: a text matching either is a failure that must carry the flag.
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
export function toClientText(reason: string, eventId: string | null): string {
  const suffix = eventId === null ? '' : ` (event ${eventId})`;
  const head = (reason.split(TRAVERSAL_MARKER)[0] ?? reason).trim();

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
  if (head === '' || containsOperatorToken(head)) return `${GENERIC_REFUSAL}${suffix}`;
  return `${head}${suffix}`;
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
