import { MAX_CHAIN_INPUT_LENGTH } from './registry-core.js';

/**
 * Chain-registry errors (TASK-006, R-48/R-50c, ARCHITECTURE.md §3.2 "Модуль src/chain/registry.ts").
 *
 * Kept in their own module rather than inside `registry.ts` because `chain/coverage.ts` (task
 * 006-4) adds `CapabilityNotCoveredOnChainError` alongside this one, and both are imported by
 * `mcp-server`'s tool handlers — a shared error module avoids a cycle between registry and
 * coverage.
 */

/**
 * Thrown by `ChainRegistry.resolve()` when the input matches no canonical id, slug, or alias.
 *
 * Carries `candidates` so the caller can render an actionable message ("Did you mean: berachain?")
 * instead of a bare failure. Computing candidates is O(n) over the registry, which is why it
 * happens HERE — at the point of failure — and never on the hot path (§3.2).
 *
 * This error is deliberately raised BEFORE any network call or credit reservation: a mistyped
 * chain name is the most common way an agent misses on a PAID route, and paying for a typo would
 * make widening the chain set a way to spend money (ARCHITECTURE.md §3.2, gate order 1→6).
 */
export class UnknownChainError extends Error {
  readonly input: string;
  readonly candidates: readonly string[];
  readonly registrySize: number;

  constructor(input: string, candidates: readonly string[], registrySize: number) {
    const suggestion = candidates.length > 0 ? ` Did you mean: ${candidates.join(', ')}?` : '';
    // The input is TRUNCATED before it is echoed (vdd-multi cycle 5, L-4). This message travels
    // back into the model's context as the tool's error text, so reflecting an arbitrarily long
    // argument verbatim hands a caller a way to put a megabyte of its own text there. The
    // neighbouring `CapabilityNotCoveredOnChainError` already truncates both of its lists for the
    // same reason. Bound taken from `MAX_CHAIN_INPUT_LENGTH` rather than repeated as a literal
    // (vdd-multi cycle 6, L): a literal would silently start truncating legitimate inputs the day
    // that constant is raised.
    const shown =
      input.length > MAX_CHAIN_INPUT_LENGTH
        ? `${input.slice(0, MAX_CHAIN_INPUT_LENGTH)}… (${input.length} chars)`
        : input;
    super(
      `unknown chain '${shown}'.${suggestion} ` +
        `Call onchain_list_chains to browse ${registrySize} chains.`,
    );
    this.name = 'UnknownChainError';
    this.input = input;
    this.candidates = candidates;
    this.registrySize = registrySize;
  }
}

/**
 * Thrown by `loadChainRegistry()` when the registry data is missing, malformed, or violates one of
 * the invariants in DB-SCHEMA/ARCHITECTURE §4.1 (duplicate `caip2`/`slug`, colliding alias, bad
 * CAIP-2 shape).
 *
 * **Why this is a throw and never a silent empty registry (R-60d):** an empty registry would turn
 * EVERY request into "unknown chain" while the process still looked healthy — a total outage
 * wearing the costume of normal operation. Failing at load is loud, immediate, and points at the
 * actual cause.
 */
export class ChainRegistryLoadError extends Error {
  constructor(message: string) {
    super(`chain registry failed to load: ${message}`);
    this.name = 'ChainRegistryLoadError';
  }
}

/**
 * Thrown when a capability exists but is not served on the requested chain (TASK-006 R-51b).
 *
 * **Deliberately NOT merged with `CapabilityUnavailableError`** (R-24), even though both end up as
 * an `isError: true` tool response. They demand opposite reactions from the caller:
 *
 * | This error                          | `CapabilityUnavailableError`                |
 * | ----------------------------------- | ------------------------------------------- |
 * | "not here, and it will not be"      | "could work — fix the key, or retry later"  |
 * | look for an alternative             | retrying is the correct move                |
 *
 * Collapsing them would send an agent into an endless retry where repeating is pointless, and make
 * it give up where adding an API key was all that was needed.
 *
 * The message carries BOTH lists — the chains this capability IS available on, and the capabilities
 * that ARE available on this chain — because they are computed from the same two sources as the
 * predicate itself (routes × `chainSupport`) and therefore cannot drift from real behaviour.
 */
export class CapabilityNotCoveredOnChainError extends Error {
  readonly capability: string;
  readonly chain: string;
  readonly availableChains: readonly string[];
  readonly availableCapabilities: readonly string[];

  constructor(details: {
    capability: string;
    chain: string;
    /** May already be truncated by the caller — pass `totalServedChains` so the "+N more" count
     * stays honest. */
    availableChains: readonly string[];
    /** **`undefined` means NOT COMPUTED, and renders nothing** (vdd-multi cycle 6, M-6). It used to
     * be a required array, so a caller with no cheap way to compute it passed `[]` — and `[]` is
     * indistinguishable from a computed empty list, which this constructor rendered as the flat
     * assertion "No capability is available on 'ton'". That was false: `chain.tvl`/`protocol.tvl`
     * are served there. An error whose stated purpose is to save the caller a wasted call must not
     * talk an agent out of calls that would succeed, so an uncomputed list now says nothing. */
    availableCapabilities?: readonly string[];
    /** Total served chains before the caller truncated `availableChains`. Omit when the list is
     * complete. */
    totalServedChains?: number;
    /** Appended verbatim — for a refusal the two lists cannot express, e.g. "this is the exhaustive
     * tier; the default tier IS served here". */
    hint?: string;
  }) {
    // Both lists are truncated: an error meant to save the caller a wasted call must not itself
    // dump 458 chain slugs into the model's context.
    const more = (shown: number, total: number): string =>
      total > shown ? `, … (+${total - shown} more)` : '';
    const chains = details.availableChains.slice(0, 10);
    const caps = (details.availableCapabilities ?? []).slice(0, 10);
    super(
      `capability '${details.capability}' is not available on chain '${details.chain}'.` +
        (chains.length
          ? ` Available on: ${chains.join(', ')}${more(chains.length, details.totalServedChains ?? details.availableChains.length)}.`
          : ' It is not available on any known chain.') +
        (caps.length
          ? ` Available on '${details.chain}' instead: ${caps.join(', ')}${more(caps.length, details.availableCapabilities?.length ?? 0)}.`
          : details.availableCapabilities === undefined
            ? '' // not computed — say nothing rather than deny
            : ` No capability is available on '${details.chain}'.`) +
        (details.hint ? ` ${details.hint}` : ''),
    );
    this.name = 'CapabilityNotCoveredOnChainError';
    this.capability = details.capability;
    this.chain = details.chain;
    this.availableChains = details.availableChains;
    this.availableCapabilities = details.availableCapabilities ?? [];
  }
}
