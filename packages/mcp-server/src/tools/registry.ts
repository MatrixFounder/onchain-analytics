import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BudgetStore, CapabilityRegistry } from '@onchain-intel/core';
import type { z } from 'zod';
import type { AccessProfileReader } from '../auth/access-profile.js';
import { principalFor, type Principal, type PrincipalResolver } from '../auth/principal.js';
import type { Diagnostics } from '../engine/diagnostics.js';
import { toClientText } from '../transport/failure-classes.js';
import {
  DEFAULT_META_VIEW,
  applyRouteDisclosure,
  metaFor,
  type MetaView,
} from './meta-visibility.js';
import type { BudgetMeta } from './budget-meta.js';
import type { CacheMeta, MergedCacheMeta, TimingMeta } from './resolve-capability.js';

/**
 * The single source of the MCP tool inventory (TASK-011, ADR-002 D7).
 *
 * **The problem this replaces.** The list of tool names was restated in **seventeen** files
 * (`docs/TASK.md` §1.1), each with its own format and its own moment of failure, and three of those
 * restatements disagreed with the code the day this was written — across **four** files: both
 * READMEs named eight tools of thirteen, `.AGENTS.md` named twelve, and the live eval graded a tool
 * it had no check for as `ok`. Adding a tool cost four separate edits discovered one at a time, the
 * last only after `test` AND `build` had already passed.
 *
 * (Sixteen was ADR-002 D7's count the day before; the seventeenth file was `docs/TASK.md` itself.
 * Cycle 2 corrected this number in `tool-inventory-docs.test.ts` and left it wrong here and in one
 * more place — the same half-applied correction that cycle diagnosed elsewhere. Fixed in cycle 3.)
 *
 * From here the inventory is data. Registration, the stdio inventory suite, the dependency-free
 * `smoke-dist` script, the eval's capability axis and the documentation gates all become READERS of
 * this list. What stops being duplicated is the data, not the checking: the four independent
 * observation channels of WI-20 all survive, each still failing in its own way.
 *
 * **What deriving everything from one list costs, and where that cost is paid.** Every derived
 * guard agrees with this array by construction. So if an entry is ever *lost* — a bad merge, a
 * dropped line — all of them agree on the smaller list and the suite stays green. The documentation
 * gate cannot help: it iterates registered tools, so a tool that vanished is never iterated. Three
 * guards exist for exactly that, and they are deliberately outside this file:
 * `test/tools-list-contract.test.ts` (a frozen snapshot plus a hand-written lower bound that no
 * command regenerates), the orphan-name check over gated documents, and the in-sync test of the
 * generated artifact.
 */

/**
 * Everything a tool handler could need, assembled once by `createServer`.
 *
 * A tool never receives this whole object — see `needs` on {@link ToolDefinition}.
 */
export interface ToolContext {
  /** The running package version, threaded in from `index.ts`; never hardcoded in a tool. */
  version: string;
  /** The capability registry; injectable, which is what makes E2E-without-network possible. */
  registry: CapabilityRegistry;
  /** Read-only `_meta.budget` visibility. Absent is legal: the tool degrades, never errors. */
  budgetStore?: BudgetStore;
  /**
   * Who the request is on behalf of (task 014-14, R-4). REQUIRED, and rationed like every other key:
   * a tool that does not declare `'principal'` in its `needs` receives an object without it.
   *
   * **Why required and not optional.** There is a principal on every transport — `STDIO_PRINCIPAL`
   * is the local one — so an optional key would only describe a state that does not exist, while
   * costing the compiler's check at every read.
   */
  principal: Principal;
  /**
   * Resolves the principal FOR THIS REQUEST from the SDK's `extra.authInfo` (task 014-15). Read by
   * `defineTool`'s wrapper, never by a handler — the same rationing as `diagnostics` below.
   *
   * **Why a resolver in the context and not a resolved value.** `principal` above is fixed when the
   * session server is constructed, which is once per session; AC-26 requires a revoked token to be
   * refused on the NEXT request, and a value held for a session would keep it working until the idle
   * timeout — up to 900 000 ms (§3.4.2). Absent means stdio, where the constant is the answer.
   */
  principals?: PrincipalResolver;
  /**
   * The access-profile reader (task 014-16, R-13.2). Read by `defineTool`'s wrapper, never by a
   * handler — a tool that could read a profile could decide what an operator sees.
   *
   * **Why on the request path and not at session creation.** The profile is named by the TOKEN, and
   * the token is resolved per request (§3.4.3). A value held for a session would lag a profile
   * change until the idle timeout.
   *
   * **Why the read is skipped for a principal with no profile id, and that is a DECISION.** The
   * stdio principal carries `accessProfileId: null` (§3.4.3) while `AccessProfileReader.read` takes
   * a non-null id and is fail-closed with no default substitution — so calling it on the local path
   * would refuse every local call and the eval gate with them. No document declares this branch;
   * `'full'` is chosen because it is the phase-0 default and the value the task's own regression
   * test ("the local profile keeps its previous volume of `_meta`") assumes.
   */
  accessProfiles?: AccessProfileReader;
  /**
   * The diagnostics channel (task 014-26). Read by `defineTool`'s WRAPPER, never by a handler.
   *
   * **Why it is here and still not reachable from a tool.** `register` receives the whole context
   * and `project` hands the handler only the keys it declared, so a tool cannot ask for this one:
   * `needs: ['diagnostics']` does not typecheck, because the key is not in any tool's `K`. The
   * refusal rendering is the transport's business, not a tool's, and a handler able to write its
   * own diagnostics rows would be a handler able to choose what an operator sees.
   *
   * **Absent means no identifier.** Then the client rendering is redacted with nothing to recover
   * it by — worse than either half alone — so production always supplies one, with `store: null` on
   * the local profile where stderr IS the operator's channel.
   */
  diagnostics?: Diagnostics;
}

/**
 * What a handler returns, covering all three response shapes this server actually has — instead of
 * assuming they are one. `ping`/`list-chains` answer synchronously and publish no `_meta`; the M1
 * tools attach `_meta.cache`; the M2 tools add `_meta.budget` on a miss. Absent `cache`/`budget`
 * render as an absent key, never as `_meta: {}`.
 *
 * **`reason` is forwarded to the model verbatim, and on the capability path it IS a thrown error's
 * `.message`.** `resolveCapability` returns `error.message` unchanged, and a
 * `CapabilityUnavailableError` concatenates every adapter's failure — which can include up to 500
 * characters of a vendor's own response body. `toCallToolResult` renders it as the `text` of an
 * `isError` result, so it reaches the model with **none** of the sanitizing the success path gets
 * (`blockscout/sanitize.ts` exists because that vendor returns model-directed `instructions` and
 * `notes` fields). Treat it as untrusted third-party text when adding a failure path: never
 * assume it is curated first-party copy.
 *
 * No secret reaches it today — but the mechanism matters more than the fact, because the mechanism
 * is what a new adapter will copy (narrowed in cycle 4). Exactly **one** adapter embeds a vendor
 * body and redacts its key before truncating (`nansen/endpoints.ts`); the others are safe by
 * **abstention** — they never embed one — and `safeFetch` reduces every URL it reports to
 * origin+pathname, which is what keeps Blockscout's query-string key out. "Adapters redact" is
 * therefore not a property anything inherits: a new key-holding adapter that echoes a response body
 * must redact first, and **nothing in the suite enforces that** (`nansen.secrets.test.ts` is
 * nansen-scoped).
 *
 * (Corrected across adversarial cycles 3 and 4. This claim lived in FOUR places — this docstring,
 * `.AGENTS.md`, `get-token.ts` and `docs/architectures/system-architecture.md` — and was corrected
 * one file per cycle, which is the partial-application pattern those cycles kept diagnosing
 * elsewhere.)
 */
export type ToolOutcome<TOutput> =
  | {
      ok: true;
      output: TOutput;
      /** Either the shared single-winner shape or a merged answer's own (T-013 task 013-8). Nothing
       * here reads its fields — `_meta` is passed to the client verbatim — so the union widens what
       * a tool may PUBLISH without weakening `CacheMeta` for the eleven that use it (R-175(b)). */
      cache?: CacheMeta | MergedCacheMeta;
      timing?: TimingMeta;
      budget?: BudgetMeta;
      /**
       * This request waited on another caller's in-flight vendor call (task 014-30). Read by the
       * wrapper to write `request_trace.served_from = 'coalesced'`; `toCallToolResult` does NOT
       * publish it, because `_meta.cache.status` keeps its two values and a follower reports `miss`
       * (`interfaces.md` §5.4.4) — a third value would redefine that field on every tool.
       */
      coalesced?: true;
    }
  | { ok: false; reason: string };

/**
 * A tool as its own module declares it.
 *
 * `K` is the set of context keys this tool uses. The handler receives `Pick<ToolContext, K>`, so a
 * tool that did not ask for `budgetStore` cannot read it — and that is a compile error, not a
 * convention. See {@link defineTool} for why the object is also narrowed at runtime.
 */
export interface ToolDefinition<
  TInput,
  TOutput extends Record<string, unknown>,
  K extends keyof ToolContext,
> {
  /** The wire name, e.g. `onchain_ping`. Declared here and nowhere else in `src`. */
  readonly name: string;
  /**
   * Human-readable label shown by MCP clients. **Required, not optional** (owner decision
   * 2026-08-01): four tools carried one and nine did not, and a registry built over that
   * inconsistency would preserve it forever.
   */
  readonly title: string;
  readonly description: string;
  /**
   * The capability this tool resolves, or `null` when it serves none (`onchain_ping` computes its
   * answer; `onchain_list_chains` reads the chain registry). `null` is written explicitly so that
   * "serves no capability" is a statement rather than an omission.
   *
   * **Stays `string | null` and is NOT widened to an array** (T-013 task 013-7). Six declarations
   * and two silent readers compare it with `===`; an array value equals no string, so widening
   * would make every one of those comparisons quietly false rather than loudly wrong. A tool
   * serving more than one capability says so in `servedCapabilities` below and leaves this `null`.
   */
  readonly capability: string | null;
  /**
   * Every capability this tool can resolve, when there is more than one and `capability` is
   * therefore `null` (T-013 task 013-7, PLAN §0.11). Absent on the 13 single-capability tools.
   *
   * The pair `{capability: null, servedCapabilities: [...]}` is what distinguishes a MULTI-capability
   * tool from a SERVER-level one (`onchain_ping`, `onchain_list_chains`), which carries `null` and
   * no `servedCapabilities` at all. Two readers depend on exactly that distinction —
   * `eval-capability-coverage.test.ts` (a tool invisible to it is a capability nobody serves) and
   * `eval-checks-coverage.test.ts` (which reads the bare `null` as "server-level") — and both are
   * taught the difference in 013-8.
   */
  readonly servedCapabilities?: readonly string[];
  /** The context keys this tool uses. Data, so the dependency is inspectable rather than inferred. */
  readonly needs: readonly K[];
  /**
   * The full zod schema — never a raw `.shape`. The SDK wraps a raw shape in a NON-strict object,
   * which silently discards `.strict()`, and `.superRefine` chains keep a `.shape` that carries
   * none of their checks: passing `GetTokenInputSchema.shape` compiles and stops validating
   * addresses while looking correct.
   */
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  readonly handler: (
    input: TInput,
    ctx: Pick<ToolContext, K>,
  ) => ToolOutcome<TOutput> | Promise<ToolOutcome<TOutput>>;
}

/**
 * A tool after `defineTool` erases its type parameters, so a heterogeneous list is possible without
 * `any`. Identity stays readable; the schemas and handler are reachable only through `register`.
 *
 * **No `tier`, and no price.** Which provider tier answers a capability is `AdapterRegistration`'s
 * business (ADR-002 D8, stage T-012). A field with no consumer today is an invitation to fill it in
 * wrongly, and this registry is precisely the place where a wrong classification would spread.
 */
export interface ToolSpec {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly capability: string | null;
  /** See {@link ToolDefinition.servedCapabilities} — forwarded verbatim by `defineTool`, and only
   * when the definition declared it, so the key is absent rather than `undefined` on the 13. */
  readonly servedCapabilities?: readonly string[];
  readonly needs: readonly (keyof ToolContext)[];
  readonly register: (server: McpServer, ctx: ToolContext) => void;
}

/**
 * The context a tool actually receives: only the keys it declared.
 *
 * The two assertions below are the price of a dynamic key write and are sound by construction —
 * `key` comes from `keyof ToolContext`, and the loop writes exactly the keys of `K`. TypeScript
 * cannot prove the second part, so `tool-spec.test.ts` asserts it at runtime instead.
 *
 * **`Object.hasOwn`, not `in`** (adversarial cycle 2). `in` walks the prototype chain, so a polluted
 * `Object.prototype.budgetStore` would satisfy the test on an installation where no store was ever
 * injected, and a future context key named `constructor`/`valueOf` would be answered by the
 * prototype instead of reported absent. This repository already made the same correction twice
 * (`net/args-hash.ts`, `blockscout/sanitize.ts`); the inconsistency here was the finding.
 */
function project<K extends keyof ToolContext>(
  ctx: ToolContext,
  keys: readonly K[],
): Pick<ToolContext, K> {
  const narrowed: Partial<ToolContext> = {};
  for (const key of keys) {
    if (Object.hasOwn(ctx, key)) {
      // One assignment across a union of value types; the read and the write use the same key.
      (narrowed as Record<string, unknown>)[key] = ctx[key];
    }
  }
  return narrowed as Pick<ToolContext, K>;
}

/**
 * Renders an outcome into the SDK's result shape, reproducing all three response forms exactly.
 *
 * **Exported for task 014-25's AC-33 gate, and for a measured reason.** Asserting the flag through a
 * client cannot see this function: with an `outputSchema` declared — which `defineTool` requires —
 * the SDK demands `structuredContent` on any result NOT flagged `isError`, so a mutation flipping
 * the flag below makes the SDK throw and render its own `isError: true` in place of ours. The
 * end-to-end assertion then passes while the renderer is broken. The gate reads this function
 * directly, and keeps the end-to-end case beside it as what it actually measures: the SDK backstop.
 */
export function toCallToolResult<TOutput extends Record<string, unknown>>(
  outcome: ToolOutcome<TOutput>,
  view: MetaView = DEFAULT_META_VIEW,
): CallToolResult {
  if (!outcome.ok) {
    return { isError: true, content: [{ type: 'text', text: outcome.reason }] };
  }
  // **The projection runs HERE and nowhere else** (§5.4.4 property 2, `security.md` §7.5.3): one
  // function renders every tool's result, so a new tool inherits the rule instead of repeating it.
  // `budgetMeta()` keeps computing its part and does not decide who sees it (task 014-16).
  const meta = metaFor(
    {
      ...(outcome.cache ? { cache: outcome.cache } : {}),
      ...(outcome.budget ? { budget: outcome.budget } : {}),
      // `timing` is present only when the answer crossed its own ceiling (OQ-T012-6): the owner's
      // decision returns such an answer rather than discarding it, and this is the half of the
      // decision that keeps "late" from being invisible. On every ordinary call the key is absent,
      // so no existing `_meta` assertion moves.
      ...(outcome.timing ? { timing: outcome.timing } : {}),
    },
    view,
  );
  // The third governed field, which is not a `_meta` field at all — and stripped BEFORE the two
  // publications below, because the output is mirrored into `content[0].text`.
  const output = applyRouteDisclosure(outcome.output, view);
  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    structuredContent: output,
    ...(meta === undefined ? {} : { _meta: meta }),
  };
}

/**
 * The only place in this package that calls `server.registerTool`, which is what makes a tool's
 * name appear exactly once in `src`.
 *
 * **Why `needs` is data and the context is projected, rather than just typed.** Before this, each
 * tool got a fresh literal from `server.ts` (`{version}`, `{registry}`, `{registry, budgetStore}`),
 * so a free tool held no reference to the budget store at all. A loop handing one wide context to
 * all thirteen would replace that guarantee with self-restraint — and self-restraint is weak here,
 * because `budgetStore` is optional in every M2 context, so any tool could add
 * `budgetStore?: BudgetStore` to its own type and read it, compiling in silence. Projecting the
 * object keeps least privilege a runtime fact that a test can assert, and `Pick<ToolContext, K>`
 * keeps it a compile error too. `ToolContext` is assignable to `Pick<ToolContext, K>` by
 * construction, so the seam between the loop and a handler carries **no** type assertion — and the
 * handler's `input` is genuinely `TInput` rather than a silently-inferred `any` (checked by making
 * `satisfies number` fail on it). The only two assertions live inside `project`, where a dynamic
 * key is written across a union of value types; they are covered by a runtime test rather than
 * trusted.
 *
 * **Scope of the guarantee, stated exactly** (adversarial cycle 2 narrowed two overclaims here):
 *
 * - It covers the **context channel only**. `needs` cannot ration imports — `createBudgetStore` is
 *   a public export of `@onchain-intel/core`, so a tool could build its own store and never touch
 *   `ctx`. That second channel is closed by a source-level gate in `tool-spec.test.ts`, not by this
 *   projection, and the two together are what make least privilege real.
 * - It rations **keys, not object graphs**. `registry` is a wide key: a tool declaring it receives
 *   the live, network-capable `CapabilityRegistry` and can resolve any capability through it. So
 *   "a tool reaches only what it declared" is true of context keys and is *not* a promise that a
 *   tool declaring `registry` is confined to its own capability — `onchain_list_chains` advertising
 *   "makes no network calls" rests on its implementation, not on this projection. What the
 *   projection does guarantee transitively is the budget store: the Nansen adapter closes over it
 *   and never exposes it as a property, so it is unreachable from `registry`.
 * - `needs` is frozen at definition time. `readonly K[]` is erased at runtime, and the array was
 *   shared by reference with the spec, so anything holding `toolSpecs` could have widened a tool's
 *   privileges for every later call.
 */
export function defineTool<
  TInput,
  TOutput extends Record<string, unknown>,
  K extends keyof ToolContext,
>(definition: ToolDefinition<TInput, TOutput, K>): ToolSpec {
  // Copied and frozen, not aliased: the projection below reads this on every call, so sharing the
  // caller's array would let a later `spec.needs.push('budgetStore')` widen a live tool.
  const needs = Object.freeze([...definition.needs]) as readonly K[];
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    capability: definition.capability,
    // Conditional spread, not `servedCapabilities: definition.servedCapabilities`:
    // `exactOptionalPropertyTypes` is off (tsconfig.base.json), so the unconditional form compiles
    // and publishes `{servedCapabilities: undefined}` on all 13 single-capability tools — which
    // `Object.keys()` sees as a fourth key and the artifact gate reads as a shape change. Same
    // idiom, same reason, as `resolve-capability.ts`'s forwarding of `sources`/`missingSources`.
    ...(definition.servedCapabilities !== undefined
      ? { servedCapabilities: Object.freeze([...definition.servedCapabilities]) }
      : {}),
    needs,
    register(server, ctx) {
      server.registerTool(
        definition.name,
        {
          title: definition.title,
          description: definition.description,
          inputSchema: definition.inputSchema,
          outputSchema: definition.outputSchema,
        },
        async (input, extra: { authInfo?: AuthInfo }) => {
          // **The interception point** (task 014-15, `system-architecture.md` §3.4.3 names this
          // wrapper by name). It runs BEFORE `resolve()` and therefore before the cache: a cache HIT
          // is a billable request — the owner's model is that both clients pay, and the second one
          // was served from cache (`docs/TASK.md:530`) — so a hook below the cache would undercount
          // exactly the requests the margin is built on.
          //
          // **Why here and not `resolve-capability.ts`.** Two handlers never enter that file:
          // `onchain_ping` and `onchain_list_chains` answer synchronously and resolve no capability.
          // This wrapper is the ONE place in `src` that reaches `server.registerTool` for a tool
          // spec, so the hook is written once and cannot be forgotten by a twenty-first tool.
          //
          // Resolved per request, never cached — see `ToolContext.principals`.
          const principal = principalFor(ctx.principals, extra.authInfo);
          // R-13.3a's second named point of application. A failed read REFUSES the request rather
          // than substituting a default (task 014-04): a profile that could not be read is not a
          // permissive profile.
          const routeDisclosureMode =
            ctx.accessProfiles === undefined || principal.accessProfileId === null
              ? 'full'
              : (await ctx.accessProfiles.read(principal.accessProfileId)).routeDisclosureMode;
          const view: MetaView = { principal, routeDisclosureMode };
          const outcome = await definition.handler(input, project({ ...ctx, principal }, needs));
          if (outcome.ok) return toCallToolResult(outcome, view);

          // **Two renderings of one refusal** (task 014-26, R-31, AC-47, AC-50).
          //
          // The operator's is the row: the reason unedited, which is where a `tried:` list, a
          // vendor's own body and the budget arithmetic belong. The client's is what
          // `toClientText` leaves plus the row id, and that id is the whole mechanism — a bounded
          // message with a handle beats a full text handed to whoever holds a token.
          //
          // The row is written BEFORE the response goes out. An identifier resolving to nothing is
          // worse than no identifier, and the emit is awaited here precisely so the ordering is
          // causal rather than probable.
          const eventId =
            (await ctx.diagnostics?.emit('tool.refused', {
              severity: 'warn',
              capability: definition.capability,
              detail: { tool: definition.name, reason: outcome.reason },
            })) ?? null;
          return toCallToolResult(
            { ok: false, reason: toClientText(outcome.reason, eventId) },
            view,
          );
        },
      );
    },
  };
}
