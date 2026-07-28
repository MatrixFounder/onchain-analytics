import { isValidAddress, normalizeAddress } from '../../chain/address.js';
import type { ChainInfo, ChainRegistry } from '../../chain/registry-core.js';
import { loadChainRegistry } from '../../chain/registry.js';
import { throttle } from '../../net/rate-limit.js';
import { safeFetch } from '../../net/safe-fetch.js';
import { adapterRegistrations } from '../../providers.config.js';
import { EntityLabelSchema, type EntityLabel } from '../../types/entity-label.js';
import { TokenHoldersSchema, type TokenHolders } from '../../types/token-holders.js';
import { MAX_VENDOR_NAME_LENGTH, truncateVendorText } from '../truncate-vendor-text.js';
import type { ProviderAdapter } from '../types.js';
import { BLOCKSCOUT_CHAIN_IDS } from './chains.js';
import {
  asPlain,
  extractTags,
  sanitizeBlockscoutBody,
  type SanitizedBlockscoutBody,
} from './sanitize.js';

/**
 * `blockscout` adapter (TASK-008, R-73…R-78) — free tier for `token.holders` and `entity.labels`.
 *
 * What this adapter is for: `token.holders` had been routed to the `dune` config-stub, which
 * covered zero chains — an advertised capability that answered nowhere — and `entity.labels` went
 * straight to paid Nansen. Blockscout serves both for free.
 *
 * **One host, and the reason it is not two.** An earlier revision split the capabilities across
 * `api.blockscout.com` (holders) and `mcp.blockscout.com` (labels), on the reasoning that the
 * direct host is cheaper and enforces auth so the key is verifiable there. Adversarial review
 * killed it: the direct host answers **402 without a key** and `token.holders` has no fallback
 * adapter, so on a stock install the capability was advertised on 39 chains and served on none.
 * Both capabilities now go through the facade, which answers keyless:
 *
 * - `token.holders` → `/v1/direct_api_call` proxying `/api/v2/tokens/<addr>/holders`.
 * - `entity.labels` → `/v1/get_address_info`. The labels exist **only** here — the direct
 *   `/api/v2/addresses/<addr>` returns `metadata: null` even for Binance Hot Wallet, because the
 *   facade's three-way fan-out is what buys the label enrichment. The expensive path and the
 *   useful path are the same path.
 *
 * Everything the facade returns must pass through `./sanitize.ts` first — it ships an
 * `instructions` array written at a language model. See that module for why the rule is enforced by
 * the type system rather than by convention.
 *
 * @module
 */

/** Numeric EVM chain id of a registry row, or `undefined` for anything not `eip155:<n>`. */
export function evmChainId(chain: ChainInfo): number | undefined {
  const matched = /^eip155:(\d+)$/.exec(chain.caip2);
  if (matched === null) return undefined;
  const id = Number(matched[1]);
  return Number.isSafeInteger(id) ? id : undefined;
}

const SERVED = new Set<number>(BLOCKSCOUT_CHAIN_IDS);

/**
 * Coverage is the intersection of "Blockscout runs a mainnet explorer for this chain id" and "our
 * registry models that chain at all".
 *
 * Keyed on the numeric chain id, deliberately: the vendor's own `ecosystem` field reads like a
 * chain family and is not one (`ecosystem: "Solana"` is Neon, an EVM chain; `"Bitcoin/BCH"` is
 * Rootstock, an EVM sidechain), so keying on it would advertise `svm`/`utxo` coverage that does not
 * exist. Measured today: 53 vendor mainnets, of which 39 correspond to a registry row.
 *
 * The `capability` argument is ignored — unlike `nansen`, both capabilities here reach exactly the
 * chains the explorer covers.
 */
export function servesChain(chain: ChainInfo): boolean {
  const id = evmChainId(chain);
  return id !== undefined && SERVED.has(id);
}

const REGISTRATION = adapterRegistrations.find((entry) => entry.id === 'blockscout');
if (!REGISTRATION) {
  throw new Error('blockscout: no matching entry in adapterRegistrations (providers.config.ts)');
}
const RATE_LIMIT = REGISTRATION.rateLimit;
const ALLOWLIST = [...REGISTRATION.hosts];

// `api.blockscout.com` stays in the SSRF allowlist (`providers.config.ts`) but is no longer
// called: it enforces auth, and this adapter must work on a stock install with no key (B-3).
// Keeping the host allowlisted costs nothing and leaves the door open for a future key-gated
// path — removing it would be the change that needs justifying, not this one.
const FACADE_HOST = 'https://mcp.blockscout.com';

/** Page size we ask the vendor for; also the cap the canonical schema enforces. */
const HOLDERS_PAGE = 50;

export interface BlockscoutAdapterDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Injectable for tests; production reads `process.env` (D10 — never a literal in code). */
  env?: Record<string, string | undefined>;
  chains?: ChainRegistry;
}

interface HoldersFetchResult {
  kind: 'holders';
  chain: string;
  tokenAddress: string;
  body: SanitizedBlockscoutBody;
}

interface LabelsFetchResult {
  kind: 'labels';
  chain: string;
  address: string;
  body: SanitizedBlockscoutBody;
}

type BlockscoutFetchResult = HoldersFetchResult | LabelsFetchResult;

/**
 * HTTP statuses that mean "ask someone else", not "the answer is no".
 *
 * `401` — a rejected key. Measured caveat (2026-07-28): the FACADE currently ignores auth entirely
 * and answers 200 even to a garbage key, so this branch is unreachable there today and is covered by
 * fixture rather than by a live probe. The DIRECT host does enforce it (`401` bogus, `402` absent),
 * and the facade's enforcement is announced, so the branch must exist before it is observable —
 * the alternative is discovering it in production on the day the grace period ends.
 * `402` — no key where one is now required. Same handling for the same reason.
 * `429` — throttled. Ours is a client-side limiter with no server signal to read (the responses
 * carry no `RateLimit-*` or `Retry-After` headers at all), so a 429 is information we cannot
 * anticipate, only yield to.
 */
const DEGRADE_STATUSES = new Set([401, 402, 429]);

/**
 * Thrown for a status that should send the registry to the next adapter in the chain. Carries no
 * response body: the point of degrading is to move on, and a vendor body on this path would reach
 * the model through `tried[].reason` (the R-68e error-path lesson from TASK-007 cycle 3).
 */
export class BlockscoutDegradedError extends Error {
  constructor(
    readonly status: number,
    host: string,
  ) {
    super(`blockscout: HTTP ${status} from ${host} — falling through to the next adapter`);
    this.name = 'BlockscoutDegradedError';
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`blockscout: "${key}" is required and must be a non-empty string`);
  }
  return value;
}

/** `https://host/...` → `host`; used so error text never carries a URL. */
function hostOf(url: string): string {
  return new URL(url).hostname;
}

export function createBlockscoutAdapter(deps: BlockscoutAdapterDeps = {}): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const chains = deps.chains ?? loadChainRegistry();

  /**
   * Performs the request and hands back a SANITIZED body — the raw one is never returned, so no
   * caller can accidentally read a field this adapter is supposed to have removed.
   *
   * **The key is applied HERE and nowhere else.** `apikey` is a query parameter rather than a
   * header (the vendor's choice, measured), which is exactly the case `rpc-solana` anticipated when
   * it decided to report `hostOf(endpoint)` instead of full URLs. So: the key is read inside
   * `fetch()` — after `CapabilityRegistry` has already derived the cache key from
   * `(provider, capability, normalizedArgs)`, where it is not an argument — and every error below
   * names a HOST, never a URL.
   */
  async function request(base: string, path: string, query: Record<string, string>) {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const apiKey = env['BLOCKSCOUT_PRO_API_KEY'];
    if (apiKey !== undefined && apiKey.length > 0) url.searchParams.set('apikey', apiKey);

    await throttle('blockscout', RATE_LIMIT);

    // M-7 (adversarial cycle 1). `safeFetch` interpolates the FULL URL into three of its own
    // errors — timeout, response-too-large, redirect cap — and this is the only adapter in the repo
    // that puts a secret in a URL, so those messages were never a secret channel before. They
    // travel verbatim into `tried[].reason` and from there into the tool's `isError` text, i.e. to
    // the model. The docstring above claimed "every error names a HOST, never a URL"; that was true
    // only of the errors THIS file constructs. Nothing but a wrapper can fix it here.
    let response: Response;
    try {
      response = await safeFetch(url.toString(), { method: 'GET' }, ALLOWLIST, fetchImpl);
    } catch (error) {
      // Name the failure CLASS, never the message — a vendor- or network-supplied string is exactly
      // what must not be echoed, and the URL that carries the key lives in some of them.
      const kind = error instanceof Error ? error.name : 'UnknownError';
      // `cause` preserves the original for a debugger while keeping the MESSAGE free of the URL —
      // only `.message` is interpolated into `tried[].reason`, never the cause chain.
      throw new Error(`blockscout: transport failure from ${hostOf(base)} (${kind})`, {
        cause: error,
      });
    }

    if (DEGRADE_STATUSES.has(response.status)) {
      throw new BlockscoutDegradedError(response.status, hostOf(base));
    }
    if (!response.ok) {
      throw new Error(`blockscout: HTTP ${response.status} from ${hostOf(base)}`);
    }
    // m-11: `response.json()` on a non-JSON body throws a message that QUOTES the first ~10
    // characters of the vendor's response ("Unexpected token '<'…"), and that message travels into
    // `tried[].reason` → the model. Tiny, but it is vendor-controlled text on the error path —
    // the exact channel R-68e closes — so the parse failure is reported by class, not by content.
    try {
      return sanitizeBlockscoutBody(await response.json());
    } catch {
      throw new Error(`blockscout: unparseable response body from ${hostOf(base)}`);
    }
  }

  return {
    id: 'blockscout',
    chainSupport: servesChain,
    capabilities: () => [{ id: 'token.holders' }, { id: 'entity.labels' }],
    // Free tier: no Nansen-style credit accounting. The vendor's own quota is bounded by the
    // per-adapter throttle and the capability TTL cache (PLAN §3).
    costOf: () => ({ credits: 0 }),

    fetch: async (cap: string, args: Record<string, unknown>): Promise<BlockscoutFetchResult> => {
      const chain = chains.resolve(requireString(args, 'chain'));
      const chainId = evmChainId(chain);
      if (chainId === undefined) {
        // Unreachable through the registry (chainSupport gates first); explicit so a direct call
        // cannot silently build a URL with `undefined` in the path.
        throw new Error(`blockscout: ${chain.slug} has no EVM chain id`);
      }

      if (cap === 'token.holders') {
        const tokenAddress = normalizeAddress(chain, requireString(args, 'tokenAddress'));
        // B-3 (adversarial cycle 1): this used to call `api.blockscout.com` directly. That host
        // enforces auth — 402 with no key, 401 with a bad one — and `token.holders` routes to
        // `['blockscout']` ALONE, so there was no next adapter to degrade to. Meanwhile
        // `requiresEnv: []`, `costOf: 0` and `isAvailable: {ok:true}` all promised a free,
        // available capability, and the coverage matrix advertised it on 39 chains. On a stock
        // install (`.env.example` ships the key commented out) it answered on NONE of them: the
        // exact "advertised by the matrix, served nowhere" defect this task was written to remove,
        // with `dune` swapped for `blockscout`.
        //
        // The facade proxies the same REST endpoint and — measured 2026-07-28, keyless — returns
        // the identical `data.items` payload (50 rows, `value` as a string, 10 of them labelled),
        // which `normalizeHolders` already accepts. It wraps that in the model-directed
        // `instructions`/`notes` fields, which is precisely what `sanitize.ts` exists for, and the
        // transport-boundary test now proves the sanitizer is actually invoked on this path too.
        const body = await request(FACADE_HOST, '/v1/direct_api_call', {
          chain_id: String(chainId),
          endpoint_path: `/api/v2/tokens/${tokenAddress}/holders`,
        });
        return { kind: 'holders', chain: chain.slug, tokenAddress, body };
      }

      if (cap === 'entity.labels') {
        // B-1 (adversarial cycle 1): this used to read `args.address`, a name NO caller can send.
        // `onchain_entity_label` builds `{chain, exhaustive, query?, tokenAddress?}` and its input
        // schema is `.strict()`, so `address` was unreachable — the adapter threw before the
        // network on 100% of real calls and every request fell through to PAID Nansen. The
        // capability's whole reason for existing produced exactly zero saving, and the unit tests
        // missed it because they hand-built args instead of driving the tool.
        const tokenAddress = args['tokenAddress'];
        if (typeof tokenAddress !== 'string' || tokenAddress.length === 0) {
          // Declines that name WHY, so the registry's fallback to Nansen is a deliberate handoff
          // rather than an accident. Blockscout resolves an ADDRESS; it has no free-text entity
          // search, so a `query`-only call is genuinely Nansen's to answer.
          throw new Error(
            'blockscout: entity.labels needs a tokenAddress — this provider resolves an address, ' +
              'not a free-text query',
          );
        }
        if (args['exhaustive'] === true) {
          // The exhaustive tier is a paid Nansen escalation. Answering it from the free source
          // would silently downgrade what the caller explicitly paid to ask for.
          throw new Error(
            'blockscout: entity.labels exhaustive tier is not served by this provider',
          );
        }
        const address = normalizeAddress(chain, tokenAddress);
        const body = await request(FACADE_HOST, '/v1/get_address_info', {
          chain_id: String(chainId),
          address,
        });
        return { kind: 'labels', chain: chain.slug, address, body };
      }

      throw new Error(`blockscout: unsupported capability ${cap}`);
    },

    normalize: (cap: string, raw: unknown): TokenHolders | EntityLabel[] => {
      const result = raw as BlockscoutFetchResult;
      if (cap === 'token.holders' && result.kind === 'holders') {
        return normalizeHolders(result, now(), chains.resolve(result.chain));
      }
      if (cap === 'entity.labels' && result.kind === 'labels') {
        return normalizeLabels(result, now());
      }
      throw new Error(`blockscout.normalize: unsupported capability ${cap}`);
    },

    // No env precondition: the facade answers without a key today, and demanding one would disable
    // a working capability on a stock install. `BLOCKSCOUT_PRO_API_KEY` is read inside `fetch()`
    // when present — after the cache key is derived, so it can never enter one.
    isAvailable: () => ({ ok: true }),
  };
}

function readObject(source: unknown, key: string): Record<string, unknown> | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeHolders(
  result: HoldersFetchResult,
  fetchedAt: number,
  chain: ChainInfo,
): TokenHolders {
  const plain = asPlain(result.body);
  // The direct host answers `{items, next_page_params}`; the facade wraps the same under `data`.
  // Accepting either keeps the normalizer honest if a route is ever moved between hosts.
  const container = readObject(plain, 'data') ?? (plain as Record<string, unknown>);
  const items = Array.isArray(container['items']) ? container['items'] : [];

  // M-4: counted, not silent. A shrinking list that still reports `truncated: false` claims to be
  // the exact tail while having holes in it — and concentration is the question this type exists
  // to answer.
  let droppedRows = 0;
  const holders = items.flatMap((item) => {
    const row = item as Record<string, unknown>;
    const address = readObject(row, 'address');
    const hash = address?.['hash'];
    const amount = row['value'];
    // Skip-and-drop rather than fail the batch (the `dexscreener` precedent): one malformed row
    // must not turn a useful holder list into no answer at all.
    if (
      typeof hash !== 'string' ||
      typeof amount !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(amount)
    ) {
      droppedRows += 1;
      return [];
    }

    // R-80 — the vendor may cut a value server-side and say so. A truncated integer is not a
    // smaller number, it is a WRONG one, and `amountRaw` is contractually exact — so the row is
    // dropped rather than published with a plausible-looking balance. Not observed on any recorded
    // response (2026-07-28), which is precisely why it is handled here instead of relied upon to
    // stay absent: the failure mode is silent, and the cost of the guard is one condition.
    if (row['value_truncated'] === true || address?.['value_truncated'] === true) {
      droppedRows += 1;
      return [];
    }

    // M-6: canonicalize and validate, exactly as `nansen`'s mappers do for vendor-supplied
    // addresses and as this same adapter already does for `entity.labels` twelve lines away.
    // Coverage is EVM-only, so `normalizeAddress` genuinely canonicalizes (EIP-55) rather than
    // passing text through — and a row whose address is not an address is a row we cannot stand
    // behind, so it is dropped and counted rather than published.
    if (!isValidAddress(chain, hash)) {
      droppedRows += 1;
      return [];
    }

    // Labels are per-row here (each holder carries its own `metadata.tags`), unlike the
    // address-scoped block `entity.labels` reads — so they come from this row's own subtree.
    const label = readRowLabel(address);
    // M-5: `token_id` distinguishes ERC-1155 rows that share an address. Kept as the vendor's own
    // string — a uint256 id does not fit a JS number.
    const tokenId = row['token_id'];
    return [
      {
        address: normalizeAddress(chain, hash),
        ...(label === undefined ? {} : { label }),
        amountRaw: amount,
        ...(typeof tokenId === 'string' && tokenId.length > 0 ? { tokenId } : {}),
        ...(typeof address?.['is_contract'] === 'boolean'
          ? { isContract: address['is_contract'] }
          : {}),
        ...(typeof address?.['is_scam'] === 'boolean' ? { isScam: address['is_scam'] } : {}),
      },
    ];
  });

  // A body whose every row is unusable is not "zero holders" — it is a response we failed to read,
  // and answering `{holders: [], truncated: false}` would state a fact the vendor never gave us.
  // Same rule `dexscreener` follows for its batch.
  if (items.length > 0 && holders.length === 0) {
    throw new Error(
      `blockscout.normalize(token.holders): all ${items.length} row(s) were unusable — refusing ` +
        'to report an empty holder list the vendor did not assert',
    );
  }
  if (droppedRows > 0) {
    // A diagnostic nobody reads is not a diagnostic: the count reaches the caller in the result,
    // and the operator on stderr.
    process.stderr.write(
      `blockscout: dropped ${droppedRows} unusable holder row(s) for ${result.tokenAddress}\n`,
    );
  }

  return TokenHoldersSchema.parse({
    chain: result.chain,
    tokenAddress: result.tokenAddress,
    holders: holders.slice(0, HOLDERS_PAGE),
    truncated:
      holders.length > HOLDERS_PAGE || container['next_page_params'] != null || droppedRows > 0,
    droppedRows,
    source: 'blockscout',
    fetchedAt,
  });
}

/**
 * Display label of a holder row, bounded — or `undefined` when unlabelled.
 *
 * m-9: prefers `tagType: 'name'` (the display label, e.g. "Sky: PSM") over a `protocol` tag
 * ("Sky"), instead of taking whichever came first — the vendor lists both and their order is its
 * business, not ours. Bounded with `truncateVendorText`, the same helper the sanitizer and the
 * nansen path use, rather than a bare `String.slice`: they differ on multi-byte input, and a label
 * cut mid-surrogate is a mojibake string handed to a model.
 */
function readRowLabel(address: Record<string, unknown> | undefined): string | undefined {
  const metadata = readObject(address, 'metadata');
  const tags = metadata?.['tags'];
  if (!Array.isArray(tags)) return undefined;

  const named: string[] = [];
  const fallback: string[] = [];
  for (const tag of tags) {
    const row = readObject({ t: tag }, 't');
    const name = row?.['name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    (row?.['tagType'] === 'name' ? named : fallback).push(name);
  }
  const chosen = named[0] ?? fallback[0];
  return chosen === undefined ? undefined : truncateVendorText(chosen, MAX_VENDOR_NAME_LENGTH);
}

/**
 * B-2 (adversarial cycle 1): returns an ARRAY, like `nansen.normalizeEntityLabels` does.
 *
 * This used to return a bare object. `EntityLabelOutputSchema.entities` is
 * `z.array(EntityLabelSchema)`, so the tool could never render it — but `normalize()` SUCCEEDED,
 * which is what made it dangerous: `CapabilityRegistry.resolve` takes the happy path on success,
 * writes the unusable shape into the POSITIVE cache under `ttlFor('entity.labels') = 3600`, and
 * never falls through to Nansen (fallback happens only on a throw). So the defect would have
 * turned into a one-hour outage per address the moment B-1 was fixed — which is why both are
 * fixed in the same commit.
 */
function normalizeLabels(result: LabelsFetchResult, fetchedAt: number): EntityLabel[] {
  const tags = extractTags(result.body, ['data', 'metadata', 'tags']);
  // `tagType: 'name'` is the display label; everything else (observed: `protocol`) is a tag.
  const named = tags.filter((tag) => tag.tagType === 'name');
  const others = tags.filter((tag) => tag.tagType !== 'name');

  return [
    EntityLabelSchema.parse({
      chain: result.chain,
      address: result.address,
      ...(named[0] === undefined ? {} : { name: named[0].name }),
      tags: others.map((tag) => tag.name),
      labels: named.map((tag) => tag.name),
      // Blockscout has no paid escalation tier — this flag exists for Nansen's `exhaustive: true`
      // path and is structurally false here, never merely defaulted.
      premiumRequested: false,
      source: 'blockscout',
      fetchedAt,
    }),
  ];
}
