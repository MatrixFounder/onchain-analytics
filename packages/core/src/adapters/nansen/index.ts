import type { ProviderAdapter } from '../types.js';
import {
  MAX_CHAIN_INPUT_LENGTH,
  type ChainInfo,
  type ChainRegistry,
} from '../../chain/registry-core.js';
import { loadChainRegistry } from '../../chain/registry.js';
import { CapabilityNotCoveredOnChainError } from '../../chain/errors.js';
import { NANSEN_CHAIN_COVERAGE, NANSEN_EXHAUSTIVE_LABELS_CHAINS } from './chain-coverage.js';
import type { BudgetStore } from '../../cache/budget-store.js';
import { hasAddressValidator, normalizeAddress } from '../../chain/address.js';
import { deriveArgsHash } from '../../net/args-hash.js';
import type { Throttle } from '../../net/rate-limit.js';
import { createNansenAccountState } from './account-state.js';
import { createNansenBudgetGate, type DailyCreditCapConfig } from './budget-gate.js';
import { costOf as costOfEndpoints } from './cost-of.js';
import {
  postProfilerAddressLabels,
  postSearchEntityName,
  postSearchGeneral,
  postSmartMoneyNetflow,
  postTgmHolders,
  postTgmIndicators,
  postTgmTokenInformation,
  type NansenChainRef,
  type NansenEndpointDeps,
  type NansenEndpointResult,
} from './endpoints.js';
import {
  normalizeEntityLabels,
  normalizeSmartMoneyFlow,
  normalizeTokenRiskScore,
  type EntityLabelsFetchResult,
  type SmartMoneyFlowsFetchResult,
  type TokenRiskFetchResult,
} from './normalize.js';
import { reconcile } from './reconcile.js';
import { createSingleflight } from './singleflight.js';

/**
 * Optional constructor dependencies (injectable — same DI convention already established in this
 * package: `safeFetch`'s `fetchImpl`, `createThrottle`'s `deps.now`, `resolveDataDir`'s `env`).
 * `env` is read only INSIDE the methods that need it (`isAvailable()`, and — task 005-4 — `fetch()`
 * itself) — never at module load, never at factory-call time, never logged, never folded into a
 * cache key — ARCHITECTURE.md §7.2/§3.2, task 005-1 reviewer note.
 *
 * `budgetStore`/`dailyCreditCap`/`budgetWarnRatio` (task 005-3, wired task 005-5): when
 * `budgetStore` is supplied, `fetch()` runs every capability through the full singleflight →
 * `budget-gate.ts`'s `ensureBudget()` → sub-calls → `reconcile.ts`'s post-call reconciliation
 * pipeline (system-architecture.md §3.2). When `budgetStore` is OMITTED, `fetch()` falls back to
 * the raw, ungated composite HTTP path (task 005-4's original behavior, still singleflight-wrapped)
 * ONLY when `__ungatedForTestsOnly: true` was ALSO explicitly set — a deliberate lower-level escape
 * hatch for isolated HTTP-contract testing (`nansen.contract.test.ts` constructs the adapter this
 * way, always with a fake `fetchImpl`, never live network). **M-6 (adversarial review cycle 1):**
 * this used to be inferred from `fetchImpl !== undefined` alone — proven false in-repo by
 * `scripts/record-fixture.mjs`, which injects a `fetchImpl` that wraps the REAL global `fetch` (to
 * capture live responses as fixtures) while ALWAYS supplying a real `budgetStore` too; a future
 * caller that forgot `budgetStore` but reused that same live-wrapping `fetchImpl` shape would have
 * silently passed the old check and made a genuinely paid, unaccounted call. The explicit boolean
 * flag can never be true by accident. **Reaching the ungated branch withOUT that flag set (no
 * `budgetStore` AND no opt-in) throws instead** (code review, 005-5 round 2 — OQ-2
 * non-bypassability: a genuinely paid Nansen call with zero budget accounting must never happen
 * silently). Never reachable from `CapabilityRegistry` in production either way: the package's only
 * real construction site (`packages/mcp-server/src/index.ts`, task 005-6) always supplies a real
 * `budgetStore`, so THERE `fetch()` is unconditionally budget-gated end-to-end.
 *
 * `now`/`fetchImpl`/`throttle` (task 005-4): now genuinely consumed by `fetch()`'s real HTTP step
 * below — `now` for a deterministic `fetchedAt` (same convention as every other M1 adapter),
 * `fetchImpl` for `safeFetch`'s injectable transport, `throttle` mirroring `budget-gate.ts`'s own
 * `NansenBudgetGateDeps.throttle` precedent (defaults to the real production singleton; test files
 * construct a fresh `createThrottle()` instance so many scenarios in one file never share a real,
 * process-lifetime token bucket).
 */
export interface NansenAdapterDeps {
  env?: NodeJS.ProcessEnv;
  budgetStore?: BudgetStore;
  dailyCreditCap?: DailyCreditCapConfig;
  budgetWarnRatio?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  throttle?: Throttle;
  /** Chain registry used to map our slug → Nansen's own chain token and to enforce per-capability
   * coverage in the TRANSPORT, not just in the gate (vdd-multi cycle 5, H-1). Same DI convention as
   * `rpc-evm`/`dexscreener`; defaults to the shipped snapshot. */
  chains?: ChainRegistry;
  /**
   * Explicit opt-in for the ungated (no `budgetStore`) HTTP-contract-test escape hatch (M-6,
   * adversarial review cycle 1) — must be the literal `true`, never inferred from any other deps
   * shape (see this interface's own docstring above for why `fetchImpl` presence alone is NOT a
   * safe signal). Production code has no legitimate reason to ever set this — the real construction
   * site always supplies a `budgetStore` instead (`mcp-server/src/index.ts`).
   */
  __ungatedForTestsOnly?: boolean;
}

/** `Object.hasOwn`, never a bare index (vdd-multi cycle 5, L-2): `NANSEN_CHAIN_COVERAGE` is an
 * ordinary object literal, so `['toString']` yields a FUNCTION and `?? []` never fires — the caller
 * would then run `.includes` on `Function.prototype.toString`. Unreachable from today's three
 * capabilities, and the same class of bug `net/args-hash.ts` already moved to a null prototype for. */
function coveredTokensFor(capability: string): readonly string[] {
  return Object.hasOwn(NANSEN_CHAIN_COVERAGE, capability)
    ? (NANSEN_CHAIN_COVERAGE[capability] ?? [])
    : [];
}

/**
 * The ONE statement of "this paid adapter serves that chain" — read by `chainSupport()` (what the
 * coverage matrix advertises), by `resolveVendorChain()` (what the transport accepts), and by the
 * refusal path's "available on" list. Three readers, one predicate: cycle 5's H-1 was exactly what
 * happens when the advertisement and the transport are written twice.
 *
 * Three conditions, and the third is new (vdd-multi cycle 6, C-1):
 *   1. the chain is not deprecated — `coverage.ts` refuses those, and the adapter's own gate must
 *      not disagree with the matrix it feeds;
 *   2. the registry maps it to a Nansen chain token AND the spec covers that token for this
 *      capability;
 *   3. **its family has a real address validator** (`hasAddressValidator`). Without one we cannot
 *      tell a valid `tokenAddress` from arbitrary text, cannot canonicalize it into a stable cache
 *      key, and cannot know how the vendor cases its address column — on a route that spends money
 *      for every attempt. See `hasAddressValidator`'s docstring for the three concrete failures.
 *
 * **Stated cost of condition 3**, so it is a decision and not a silent narrowing: `entity.labels`
 * 25 → 18 chains, `token.risk` 24 → 18, `smart-money.flows` 17 → 16. Dropped: `bitcoin`, `near`,
 * `sei`, `starknet`, `sui`, `ton`, `tron`. Each becomes reachable again the moment its family gets
 * a validator — `sei` is the strongest candidate (it is EVM-addressed in practice; our generator
 * files it under `other` only because no EIP-155 chain id joined), but re-classifying it needs
 * evidence, not a guess, so it waits.
 */
function nansenServesChain(chain: ChainInfo, capability: string): boolean {
  if (chain.deprecated) return false;
  if (!hasAddressValidator(chain.family)) return false;
  const token = chain.vendors['nansen'];
  if (token == null) return false;
  return coveredTokensFor(capability).includes(token);
}

/**
 * Resolves the caller's chain slug into the pair the transport needs, and REFUSES a chain this
 * capability is not served on (vdd-multi cycle 5, H-1).
 *
 * This is the single place where "what the coverage matrix advertises" and "what `fetch()` can
 * actually build a request for" are forced to be the same statement: both read
 * `vendors.nansen` × `NANSEN_CHAIN_COVERAGE[capability]`, the same two inputs `chainSupport()`
 * reads. Before this, `chainSupport()` was widened to 17/25/25 chains while the transport still
 * hardcoded `'ethereum' | 'solana'`, so the gate admitted 23 chains the request builders could not
 * express — and the resulting throw was classified as a RETRYABLE outage.
 *
 * The refusal is a `CapabilityNotCoveredOnChainError` on purpose: "not here, and it will not be" is
 * permanent, and `CapabilityRegistry.resolve()` rethrows this class instead of folding it into
 * `CapabilityUnavailableError` (which means "retry, or add a key"). It is raised from
 * `validateArgs()`, i.e. BEFORE `ensureBudget()` — no credits are reserved to discover it.
 */
function resolveVendorChain(
  capabilityLabel: string,
  rawChain: unknown,
  chains: ChainRegistry,
  serves: (chain: ChainInfo) => boolean,
  hint?: string,
): { chain: ChainInfo; ref: NansenChainRef } {
  const chain = typeof rawChain === 'string' ? chains.tryResolve(rawChain) : null;
  if (!chain || !serves(chain)) {
    throw new CapabilityNotCoveredOnChainError({
      capability: capabilityLabel,
      // Truncated like `UnknownChainError` does (vdd-multi cycle 6, L): this message is rendered
      // back into the model's context, and a direct `CapabilityRegistry` caller is not bounded by
      // the tools' `ChainInputSchema.max(64)`.
      chain: chain?.slug ?? truncateForMessage(String(rawChain)),
      // Computed lazily and BOUNDED (vdd-multi cycle 6, perf): the previous version scanned all
      // 458 rows and built a ~450-element array so the error could render ten of them, which made
      // the refusal path far more expensive than the success path it protects.
      availableChains: listServedChains(chains, serves, ERROR_LIST_LIMIT),
      totalServedChains: countServedChains(chains, serves),
      // `availableCapabilities` deliberately OMITTED, not `[]` (vdd-multi cycle 6, M-6): this
      // adapter knows nothing about the other adapters' capabilities, and `[]` would render as
      // "No capability is available on '<chain>'" — a denial we never checked and which is false
      // for every chain `chain.tvl` covers.
      ...(hint !== undefined ? { hint } : {}),
    });
  }
  const token = chain.vendors['nansen'] as string; // non-null by `serves`
  return { chain, ref: { token, family: chain.family } };
}

/** How many slugs an error message may name; the constructor renders the same number. */
const ERROR_LIST_LIMIT = 10;

function listServedChains(
  chains: ChainRegistry,
  serves: (chain: ChainInfo) => boolean,
  limit: number,
): string[] {
  const out: string[] = [];
  for (const candidate of chains.list()) {
    if (!serves(candidate)) continue;
    out.push(candidate.slug);
    if (out.length >= limit) break;
  }
  return out;
}

function countServedChains(chains: ChainRegistry, serves: (chain: ChainInfo) => boolean): number {
  let n = 0;
  for (const candidate of chains.list()) if (serves(candidate)) n += 1;
  return n;
}

function truncateForMessage(raw: string): string {
  return raw.length > MAX_CHAIN_INPUT_LENGTH
    ? `${raw.slice(0, MAX_CHAIN_INPUT_LENGTH)}… (${raw.length} chars)`
    : raw;
}

/** Shared `{chain, tokenAddress}` arg extraction for `smart-money.flows`/`token.risk` (both tool
 * contracts use the same two-field shape, interfaces.md §5.1.2). `cap` is both the coverage key and
 * the error message's subject (which capability rejected the args). */
function extractChainTokenAddress(
  cap: string,
  args: Record<string, unknown>,
  chains: ChainRegistry,
): { chain: ChainInfo; ref: NansenChainRef; tokenAddress: string } {
  const tokenAddress = args['tokenAddress'];
  if (typeof tokenAddress !== 'string') {
    throw new Error(
      `nansen.fetch(${cap}): invalid args ${JSON.stringify(args)} (expected {chain: string, tokenAddress: string})`,
    );
  }
  const { chain, ref } = resolveVendorChain(cap, args['chain'], chains, (candidate) =>
    nansenServesChain(candidate, cap),
  );
  return { chain, ref, tokenAddress };
}

function extractEntityLabelArgs(
  args: Record<string, unknown>,
  chains: ChainRegistry,
): {
  chain: ChainInfo;
  ref: NansenChainRef;
  query: string | undefined;
  tokenAddress: string | undefined;
  exhaustive: boolean;
} {
  const exhaustiveRequested = args['exhaustive'] === true;
  // **The exhaustive tier is gated on its OWN, narrower chain list** (vdd-multi cycle 5, M-7).
  // `NANSEN_EXHAUSTIVE_LABELS_CHAINS` was generated, documented as refusing "before the 100cr
  // escalation", and then read by nobody: `chainSupport()` cannot see `args.exhaustive`, so the
  // only place the distinction can be enforced is here. A money guard that exists in a comment but
  // not in code is worse than none — it reads as covered, and it discourages writing the real one.
  const { chain, ref } = exhaustiveRequested
    ? resolveVendorChain(
        'entity.labels (exhaustive)',
        args['chain'],
        chains,
        (candidate) =>
          nansenServesChain(candidate, 'entity.labels') &&
          NANSEN_EXHAUSTIVE_LABELS_CHAINS.includes(candidate.vendors['nansen'] as string),
        // The tier-specific way out (vdd-multi cycle 6, M-6). Without it the message says
        // `entity.labels` is unavailable here, which is wrong for the DEFAULT tier on most of
        // these chains — and an agent reading it abandons a call that would have succeeded.
        'This is the opt-in exhaustive tier; retry with exhaustive:false for the default tier.',
      )
    : resolveVendorChain('entity.labels', args['chain'], chains, (candidate) =>
        nansenServesChain(candidate, 'entity.labels'),
      );
  const query = typeof args['query'] === 'string' ? args['query'] : undefined;
  const tokenAddress = typeof args['tokenAddress'] === 'string' ? args['tokenAddress'] : undefined;
  const exhaustive = exhaustiveRequested;
  if (!query && !tokenAddress) {
    throw new Error(
      `nansen.fetch(entity.labels): invalid args ${JSON.stringify(args)} (expected query and/or tokenAddress)`,
    );
  }
  if (exhaustive && !tokenAddress) {
    throw new Error(
      `nansen.fetch(entity.labels): invalid args ${JSON.stringify(args)} (exhaustive:true requires tokenAddress)`,
    );
  }
  return { chain, ref, query, tokenAddress, exhaustive };
}

/**
 * Validates + normalizes every address `performSubCalls` will itself derive for `(cap, args)` —
 * called BEFORE `ensureBudget()` (M-2(c), adversarial review cycle 1) so a malformed chain/address
 * throws BEFORE any credits are reserved, never after. Deliberately validation-only: the value
 * computed here is discarded — `performSubCalls` re-derives it independently right after, a pure,
 * side-effect-free function of the address bytes, so re-deriving it is behavior-neutral, never a
 * second source of truth to drift out of sync. An unrecognized capability is deliberately NOT
 * handled here (`default: return`) — that stays the existing fail-closed `costOf()`/`ensureBudget()`
 * path's job (`NansenBudgetExceededError`), unchanged by this fix.
 */
function validateArgs(cap: string, args: Record<string, unknown>, chains: ChainRegistry): void {
  switch (cap) {
    case 'smart-money.flows':
    case 'token.risk': {
      const { chain, tokenAddress } = extractChainTokenAddress(cap, args, chains);
      normalizeAddress(chain, tokenAddress);
      return;
    }
    case 'entity.labels': {
      const { chain, tokenAddress } = extractEntityLabelArgs(args, chains);
      if (tokenAddress !== undefined) {
        normalizeAddress(chain, tokenAddress);
      }
      return;
    }
    default:
      return;
  }
}

/**
 * The raw composite HTTP path for one capability (task 005-4's own routing table, UNCHANGED by
 * this task — only factored out of `fetch()`'s body into its own function). Returns the "raw
 * hand-off" shape `normalize()` already expects (task 005-4); every `NansenEndpointResult` this
 * call produces is ALSO pushed, in call order, into the caller-owned `subResponses` accumulator —
 * `fetch()`'s own post-call reconciliation seam (task 005-5, R-38): `reconcile()` sums
 * `subResponses[].creditsUsedHeader` directly, rather than re-deriving them from the typed
 * `result`, whose sub-call fields are nested under different names per capability (`netflow`/
 * `holders` vs `indicators`/`tokenInformation` vs `search`/`entityName`/`holders`/
 * `profilerLabels`). **`subResponses` is a caller-owned, mutable accumulator (M-2(b), adversarial
 * review cycle 1) specifically so it survives a THROW partway through:** if a LATER sub-call
 * throws after an EARLIER one already succeeded, this `async function`'s own rejection propagates
 * naturally — no partial canonical result ever reaches `normalize()` — but every sub-call that DID
 * complete before the throw is still sitting in `subResponses`, so `fetch()`'s own catch can still
 * call `reconcile()` with that partial set and refund the unspent portion, instead of leaving the
 * full reservation as a phantom charge (system-architecture.md §3.2 "Частичный отказ", TC-UNIT-11
 * from task 005-4, TC-UNIT-05 from task 005-5). Sequential `await`s throughout, never `Promise.all`
 * — **the real reason is credit conservation, not "no partial canonical result" (M-2 docstring fix,
 * adversarial review cycle 1):** `Promise.all` starts every sub-call concurrently, so by the time an
 * EARLIER one's rejection is observed, a LATER one may already have been sent (and billed by the
 * vendor) regardless — sequential `await`s are what keep "a later sub-call never even starts once
 * an earlier one has failed" true, which is what makes the partial-`subResponses` refund above
 * exact rather than an overestimate.
 */
async function performSubCalls(
  cap: string,
  args: Record<string, unknown>,
  endpointDeps: NansenEndpointDeps,
  subResponses: NansenEndpointResult[],
  chains: ChainRegistry,
): Promise<{ result: unknown }> {
  switch (cap) {
    case 'smart-money.flows': {
      // Always BOTH sub-calls, unconditionally (R-41 — system-architecture.md §3.2's capability
      // table, "netflow + tgm/holders, всегда оба").
      //
      // `ref` (the VENDOR's chain token) goes on the wire; `chain` (our `ChainInfo`) drives address
      // normalization and is what the canonical result carries. Sending our slug where the vendor
      // expects its own token is the H-1 defect in miniature — `bsc` is `bnb` at Nansen.
      const { chain, ref, tokenAddress } = extractChainTokenAddress(cap, args, chains);
      const normalizedAddress = normalizeAddress(chain, tokenAddress);
      const netflow = await postSmartMoneyNetflow(
        { chain: ref, tokenAddress: normalizedAddress },
        endpointDeps,
      );
      subResponses.push(netflow);
      // Forward the flag so PRICE AND REQUEST AGREE (cycle-3 3.3). `costOf` charges the flat
      // 150cr NANSEN_PREMIUM_LABELS_COST off `args['premium_labels']`; wiring it only into
      // `postTgmHolders`'s signature (cycle 2) left NO production call site, so a future change
      // that exposes the flag on a tool schema would reserve 150 for a request the transport
      // still sends as a plain 5cr call — a hard refusal, on a 100cr plan, of a call that would
      // have succeeded. Unreachable today (no tool schema exposes it, all three are `.strict()`),
      // but price and request can no longer drift apart.
      const holders = await postTgmHolders(
        {
          chain: ref,
          tokenAddress: normalizedAddress,
          premiumLabels: args['premium_labels'] === true,
        },
        endpointDeps,
      );
      subResponses.push(holders);
      const result: SmartMoneyFlowsFetchResult = {
        chain: chain.slug,
        family: chain.family,
        tokenAddress: normalizedAddress,
        netflow,
        holders,
      };
      return { result };
    }
    case 'token.risk': {
      // Always BOTH sub-calls, unconditionally (R-43 — same "always both" pattern).
      const { chain, ref, tokenAddress } = extractChainTokenAddress(cap, args, chains);
      const normalizedAddress = normalizeAddress(chain, tokenAddress);
      const indicators = await postTgmIndicators(
        { chain: ref, tokenAddress: normalizedAddress },
        endpointDeps,
      );
      subResponses.push(indicators);
      const tokenInformation = await postTgmTokenInformation(
        { chain: ref, tokenAddress: normalizedAddress },
        endpointDeps,
      );
      subResponses.push(tokenInformation);
      const result: TokenRiskFetchResult = {
        chain: chain.slug,
        address: normalizedAddress,
        indicators,
        tokenInformation,
      };
      return { result };
    }
    case 'entity.labels': {
      const { chain, ref, query, tokenAddress, exhaustive } = extractEntityLabelArgs(args, chains);

      if (exhaustive) {
        // "только /profiler/address/labels" — never alongside search/general or tgm/holders
        // (system-architecture.md §3.2 capability table). `tokenAddress` presence is already
        // guaranteed by extractEntityLabelArgs() above.
        const normalizedAddress = normalizeAddress(chain, tokenAddress as string);
        const profilerLabels = await postProfilerAddressLabels(
          { chain: ref, address: normalizedAddress },
          endpointDeps,
        );
        subResponses.push(profilerLabels);
        const result: EntityLabelsFetchResult = {
          chain: chain.slug,
          vendorChain: ref.token,
          tokenAddress: normalizedAddress,
          premiumRequested: true,
          search: undefined,
          entityName: undefined,
          holders: undefined,
          profilerLabels,
        };
        return { result };
      }

      // Default/token-scoped: search/general [+ entity-name] always; + tgm/holders only when
      // tokenAddress was given (R-32/cost-of.ts's own endpointsFor() — the same routing rule). A
      // raw address is a valid `search_query` value too (GeneralSearchRequest's own documented
      // examples include a contract address) — falls back to it when no `query` text was given
      // (extractEntityLabelArgs() already guarantees at least one is present).
      const searchQuery = query ?? (tokenAddress as string);
      const search = await postSearchGeneral({ chain: ref, searchQuery }, endpointDeps);
      subResponses.push(search);
      const entityName = await postSearchEntityName({ searchQuery }, endpointDeps);
      subResponses.push(entityName);

      let holders: NansenEndpointResult | undefined;
      let normalizedAddress: string | undefined;
      if (typeof tokenAddress === 'string') {
        normalizedAddress = normalizeAddress(chain, tokenAddress);
        // Same price/request coupling as above (cycle-3 3.3).
        holders = await postTgmHolders(
          {
            chain: ref,
            tokenAddress: normalizedAddress,
            premiumLabels: args['premium_labels'] === true,
          },
          endpointDeps,
        );
        subResponses.push(holders);
      } else {
        holders = undefined;
      }

      const result: EntityLabelsFetchResult = {
        chain: chain.slug,
        vendorChain: ref.token,
        tokenAddress: normalizedAddress,
        premiumRequested: false,
        search,
        entityName,
        holders,
        profilerLabels: undefined,
      };
      return { result };
    }
    default:
      throw new Error(`nansen.fetch: unrecognized capability "${cap}"`);
  }
}

/**
 * `nansen` adapter (ARCHITECTURE.md §3.2 "Десятый адаптер", M2/TASK-005, R-29/R-30) — the tenth
 * `providers.config.ts` adapter id and the first PAID one. Declares the three M2 capabilities
 * (`smart-money.flows`, `entity.labels`, `token.risk`) so `providers.config.ts`'s three new routes
 * have a real, registered `ProviderAdapter` to resolve to — `capabilities()`/`isAvailable()` were
 * real from task 005-1; `costOf()` is real from task 005-3 (table-driven, see cost-of.ts);
 * `fetch()`/`normalize()` are real from task 005-4 — the "raw" composite HTTP path
 * (`endpoints.ts`) + normalization (`normalize.ts`), for all three capabilities including
 * `entity.labels`'s three tiers. This is the package's ONLY publicly exported factory for this
 * adapter (no separate raw-client export).
 *
 * **THIS task (005-5) composes the final three layers around that same raw HTTP path, from the
 * inside of `fetch()` (§3.2 OQ-2 — never a second, bypassable call site):**
 * `singleflight()` (outermost, `singleflight.ts`) → `budget-gate.ts`'s `ensureBudget()` (when
 * `deps.budgetStore` is supplied) → the sub-calls (`performSubCalls()` above, task 005-4's own
 * routing, unchanged) → `reconcile.ts`'s post-call reconciliation (exactly once per logical
 * `fetch()`, R-38). None of `singleflight`/the gate/`reconcile` are exported — they are private
 * implementation seams of THIS factory's own `fetch()` closure. **Non-bypassability (OQ-2, code
 * review round 2) — stated precisely (vdd-multi cycle 4, completeness G-3):** the ONLY way to reach
 * `performSubCalls()` without a budget reservation is `deps.budgetStore` omitted AND
 * `deps.__ungatedForTestsOnly === true` explicitly set (the isolated-HTTP-contract-test escape
 * hatch) — omitting `budgetStore` alone throws instead of silently making an unaccounted paid call.
 *
 * This docstring previously said the escape hatch also required an injected `deps.fetchImpl`. It
 * does NOT: `fetchImpl` falls back to the real global `fetch` a few lines below, so the boolean
 * alone opens a real-transport, zero-accounting path. That is a deliberate test-only affordance and
 * production never sets it (`mcp-server/src/index.ts` always supplies a `budgetStore`), but the
 * guarantee is "one explicit opt-in flag", not "two independent conditions" — and a money guard's
 * documentation must not claim a stronger bound than the code enforces.
 *
 * `accountState` (task 005-3) is constructed ONCE here, per adapter instance — never a module
 * singleton — and shared between `costOf()` below and the budget gate (`createNansenBudgetGate`
 * constructed against this SAME instance, below), so a live `/account` resync the gate performs is
 * immediately visible to `costOf()`'s plan-dependent pricing without any extra plumbing.
 */
export function createNansenAdapter(deps: NansenAdapterDeps = {}): ProviderAdapter {
  const accountState = createNansenAccountState();
  const chains = deps.chains ?? loadChainRegistry();
  const now = deps.now ?? Date.now;
  const singleflight = createSingleflight();
  const budgetStore = deps.budgetStore;
  // Constructed ONCE per adapter instance (mirrors `accountState`/`singleflight` above) — `undefined`
  // when no `budgetStore` was injected (see `NansenAdapterDeps`'s own docstring above for why this
  // is a deliberate, test-only escape hatch rather than a silent-default real disk-backed store).
  const gate = budgetStore
    ? createNansenBudgetGate({
        budgetStore,
        accountState,
        ...(deps.dailyCreditCap !== undefined ? { dailyCreditCap: deps.dailyCreditCap } : {}),
        ...(deps.budgetWarnRatio !== undefined ? { budgetWarnRatio: deps.budgetWarnRatio } : {}),
        now,
        fetchImpl: deps.fetchImpl ?? fetch,
        env: deps.env ?? process.env,
        ...(deps.throttle ? { throttle: deps.throttle } : {}),
      })
    : undefined;

  return {
    id: 'nansen',
    // TASK-006 (task 006-9, R-58): coverage comes from the COMMITTED OpenAPI spec, PER CAPABILITY,
    // and a composite capability is covered only by the INTERSECTION of its sub-calls —
    // `smart-money.flows` issues both `/smart-money/netflow` (17 chains) and `/tgm/holders` (25),
    // so its coverage is 17. The union would add 8 chains where the first sub-call succeeds, the
    // second is refused by the vendor, and the credits for the first are already gone (DF-1).
    //
    // `vendors.nansen` is the vendor's OWN chain token (`bnb`, not `bsc`; `optimism`, not
    // `op-mainnet`); a chain the registry cannot map is simply not covered.
    chainSupport: nansenServesChain,
    // **No `chains` literal** (vdd-multi cycle 6, M-7). `CapabilityDescriptor.chains` is a
    // documented part of the public `ProviderAdapter` contract ("narrows which chains the
    // capability applies to"), and it still said `['ethereum','solana']` while `chainSupport`
    // served 16–18. An adapter that answers the same question twice will eventually answer it two
    // different ways — which is precisely cycle 5's H-1. `providers.config.ts` made this argument
    // for the route-level literals already; it holds identically here.
    capabilities: () => [
      { id: 'smart-money.flows' },
      { id: 'entity.labels' },
      { id: 'token.risk' },
    ],
    // Real from task 005-3: exact, table-driven price under the live plan
    // (accountState.get()?.plan ?? 'free' — cost-of.ts). Fail-closed for an unrecognized
    // capability or a cost-table key that doesn't exist: Number.POSITIVE_INFINITY, NEVER 0.
    costOf: (cap: string, args: Record<string, unknown>) => ({
      credits: costOfEndpoints(accountState, cap, args),
    }),
    // `fetch()` itself (task 005-5): `singleflight()` (outermost, `singleflight.ts`) — a call
    // arriving while an IDENTICAL in-flight call (same `deriveArgsHash(cap, args)`) hasn't settled
    // yet shares that same call's outcome (R-39), never a second reservation/HTTP round
    // trip/`usage` write. Inside it: budget gate → `performSubCalls()` (the unchanged task-005-4
    // raw composite HTTP path, factored out above) → `reconcile()`, exactly once per logical call
    // (R-38). `gate`/`budgetStore` were resolved ONCE above, at factory-construction time — see
    // `NansenAdapterDeps`'s own docstring for why an OMITTED `budgetStore` falls back to the raw,
    // ungated path instead of a silently-defaulted real disk-backed store — and why that fallback
    // itself fail-closes (throws) unless `__ungatedForTestsOnly: true` was explicitly set (OQ-2
    // non-bypassability, code review round 2: never a real paid call with zero accounting). NOTE
    // this comment previously said "unless `fetchImpl` was ALSO explicitly injected" — false: the
    // flag alone suffices, `fetchImpl` falls back to the real global `fetch` below.
    //
    // `apiKey` is read HERE, inside the method body, on every call — never at module load, never
    // cached across calls, never logged, never folded into a cache key (R-45). A missing key is a
    // defensive re-check (the same precedent as `budget-gate.ts`'s own `refreshAccount()`):
    // `CapabilityRegistry` already keeps `isAvailable()` from ever letting this be reached without
    // one, but a direct/out-of-band call still fails with a clear, typed message instead of
    // silently sending an `apiKey: undefined` header.
    fetch: async (cap: string, args: Record<string, unknown>): Promise<unknown> =>
      singleflight(deriveArgsHash(cap, args), async () => {
        const env = deps.env ?? process.env;
        const apiKey = env['NANSEN_API_KEY'];
        if (!apiKey) {
          throw new Error(
            'nansen.fetch: NANSEN_API_KEY is required (isAvailable() should have blocked this)',
          );
        }
        const endpointDeps: NansenEndpointDeps = {
          apiKey,
          fetchImpl: deps.fetchImpl ?? fetch,
          ...(deps.throttle ? { throttle: deps.throttle } : {}),
        };

        if (!budgetStore || !gate) {
          // Fail-closed (code review, 005-5 round 2 — OQ-2 non-bypassability; M-6, adversarial
          // review cycle 1): this ungated branch is a TEST-ONLY escape hatch for isolated
          // HTTP-contract testing. Consent is now an EXPLICIT opt-in boolean, never inferred from
          // `fetchImpl` presence alone — see `NansenAdapterDeps.__ungatedForTestsOnly`'s own
          // docstring for why that inference was proven false in-repo (`scripts/record-fixture.mjs`
          // wraps the REAL global `fetch`). Reaching this branch withOUT the flag set means a
          // genuinely paid Nansen call with ZERO budget accounting — silently, no throw, no stderr —
          // exactly the money-leak OQ-2's "structurally non-bypassable" decision forbids. Refuse
          // loudly instead of leaking credits.
          if (deps.__ungatedForTestsOnly !== true) {
            throw new Error(
              'nansen.fetch: refusing an ungated paid call over the real transport — construct ' +
                'createNansenAdapter() with a budgetStore (production) or set ' +
                '__ungatedForTestsOnly: true (isolated HTTP-contract test only)',
            );
          }
          const { result } = await performSubCalls(cap, args, endpointDeps, [], chains);
          return result;
        }

        // M-2(c) (adversarial review cycle 1): validated + normalized BEFORE ensureBudget() — a
        // malformed chain/address must throw before any credits are ever reserved, never after.
        validateArgs(cap, args, chains);

        // M-2(a) (adversarial review cycle 1): `ensureBudget()` now runs INSIDE this try — a
        // post-commit throw from it (its own warn-block best-effort try/catch already absorbs the
        // expected ones, `budget-gate.ts`, but this is a second, defense-in-depth layer) is caught
        // the SAME way a sub-call failure is, below. `reservation` starts `undefined` and is only
        // ever assigned once `ensureBudget()` has genuinely resolved — this is what lets the catch
        // tell "a reservation was committed, then something else failed" (reconcile + mark) apart
        // from "ensureBudget() itself refused before committing anything" (nothing to reconcile,
        // rethrow as-is — a `NansenBudgetExceededError` refusal must never mark `accountState`
        // unreconciled, TC-INT-02 in `mcp-server`'s own degradation suite depends on this).
        let reservation: { reservedTotal: number; bucket: number } | undefined;
        // Guards against DOUBLE-APPLYING the signed delta (cycle-2 review L-1). The catch below
        // cannot otherwise distinguish "reconcile never ran" from "reconcile ran, COMMITTED, and
        // then threw". With `SqliteBudgetStore` that second case is unreachable (`recordDelta` is a
        // single synchronous `stmt.run()`), but `BudgetStore` is explicitly forward-declared for a
        // Postgres implementation (D7), where a commit followed by a dropped connection on the
        // response read is ordinary — and re-applying the common `delta = -reservedTotal` full
        // refund would DOUBLE-refund, silently widening the budget. Skipping the retry is the safe
        // direction: `markUnreconciled()` still forces a resync, which self-corrects an
        // un-refunded reservation, whereas a double refund does not self-correct.
        let reconcileAttempted = false;
        const subResponses: NansenEndpointResult[] = [];
        try {
          reservation = await gate.ensureBudget(cap, args);
          const { result } = await performSubCalls(cap, args, endpointDeps, subResponses, chains);
          reconcileAttempted = true;
          try {
            await reconcile({
              subResponses,
              reservedTotal: reservation.reservedTotal,
              bucket: reservation.bucket,
              budgetStore,
              accountState,
            });
          } catch (reconcileError) {
            // BEST-EFFORT, and the failure is absorbed HERE rather than in the catch below
            // (vdd-multi cycle 4, logic L-3 + L-4). Two defects shared this one `await`:
            //
            // (L-4) The call is already PAID and `result` is already valid. Letting a bookkeeping
            // write propagate meant `registry.ts` recorded the adapter as failed, nothing was
            // cached, the tool returned `CapabilityUnavailableError`, and the agent's retry paid
            // the full 10/6/100cr again — the exact post-payment-throw class `normalize.ts` was
            // hardened against three separate times, left open on the last step. `SQLITE_BUSY`
            // past the 5s busy timeout is realistic: `budget-store.ts` explicitly designs for
            // several stdio sessions sharing one `cache.sqlite3`. The neighbouring contracts
            // already work this way — the gate's warn block never fails a committed write over an
            // observability side effect, and `registry.ts` treats a cache fault as non-fatal.
            //
            // (L-3) `markUnreconciled()` lived only in the `!reconcileAttempted` branch below, so
            // in exactly the case its own comment was written for — "reconcile ran and threw" — the
            // documented safety net never fired. It fires here instead.
            //
            // Ledger state after this path is conservative: the full reservation stays charged
            // (never a phantom refund), and the forced resync rebases on the vendor's authoritative
            // remainder on the next gate entry, which is what self-corrects the difference.
            // `markUnreconciled()` FIRST, then the log — the ledger correction must not depend on
            // stderr being writable.
            accountState.markUnreconciled();
            try {
              // The write is itself wrapped (cycle-4 verification pass): stderr can throw EPIPE once
              // the stdio client has closed — the very case `budget-gate.ts`'s warn block already
              // guards against with this same shape. Unwrapped, that throw escaped this catch into
              // the outer one, where `reconcileAttempted === true` skips the retry and rethrows,
              // discarding the paid result again — i.e. it re-opened the exact hole this handler
              // exists to close.
              process.stderr.write(
                `nansen reconcile: ledger write failed AFTER a paid call — reservation stays charged, ` +
                  `next gate entry resyncs /account: ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}\n`,
              );
            } catch {
              // Diagnostics are best-effort; never fail a paid, valid result over a log line.
            }
          }
          return result;
        } catch (error) {
          if (reservation && !reconcileAttempted) {
            // M-2(b) (adversarial review cycle 1): a reservation WAS committed before this error —
            // sum whatever sub-responses DID complete (possibly none, e.g. a malformed capability
            // dispatch; possibly a partial set, e.g. sub-call #2 of a composite failed) through the
            // SAME reconcile() path a successful call uses, so the unspent portion is refunded
            // instead of the FULL reservation staying a phantom charge forever. Best-effort: a
            // reconcile() failure here must never mask the ORIGINAL error that triggered this catch.
            try {
              await reconcile({
                subResponses,
                reservedTotal: reservation.reservedTotal,
                bucket: reservation.bucket,
                budgetStore,
                accountState,
              });
            } catch {
              // best-effort — see this block's own comment above.
            }
            // Transport failure on any sub-call OR a synchronous throw for an unrecognized
            // capability — either way, the NEXT `ensureBudget()` entry is forced to resync
            // `/account` before trusting the local snapshot again (system-architecture.md §3.2
            // "Post-call reconciliation + transport-failure/402 resync"). One mechanism covers both
            // "network died" and "Nansen said 402" (`NansenPaymentRequiredError`, endpoints.ts) — no
            // special-cased branch here for either.
            accountState.markUnreconciled();
          }
          throw error;
        }
      }),
    // Real from THIS task (005-4): dispatches to normalize.ts's three pure functions. `raw` is
    // always this SAME adapter instance's own `fetch()` hand-off shape (never validated against a
    // schema here — that trust boundary is `fetch()`'s own return type, anti-corruption layer D4).
    normalize: (cap: string, raw: unknown): unknown => {
      switch (cap) {
        case 'smart-money.flows':
          return normalizeSmartMoneyFlow(raw as SmartMoneyFlowsFetchResult, now);
        case 'entity.labels':
          return normalizeEntityLabels(raw as EntityLabelsFetchResult, now);
        case 'token.risk':
          return normalizeTokenRiskScore(raw as TokenRiskFetchResult, now);
        default:
          throw new Error(`nansen.normalize: unrecognized capability "${cap}"`);
      }
    },
    // Real from task 005-1 (reviewer note): env is read HERE, inside the method itself — never at
    // module load, never at factory-call time — so a key set/unset AFTER createNansenAdapter()
    // runs is still observed correctly.
    isAvailable: () => {
      const env = deps.env ?? process.env;
      return env['NANSEN_API_KEY'] ? { ok: true } : { ok: false, reason: 'needs NANSEN_API_KEY' };
    },
  };
}
