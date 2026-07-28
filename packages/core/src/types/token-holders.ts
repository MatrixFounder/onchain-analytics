import { z } from 'zod';
import { ChainSchema } from './chain.js';

/**
 * Canonical `TokenHolders` entity (TASK-008, R-74) — who holds a token and how much.
 *
 * The capability existed in routes, TTL and the coverage matrix since M1 but was wired to the
 * `dune` config-stub, which served zero chains: advertised everywhere, answered nowhere. This is
 * its first real shape.
 *
 * **`amountRaw` is a string and has no numeric twin.** The vendor returns `value` as a decimal
 * string of token base units, and DB-SCHEMA-CONCEPT §1.7 requires exact on-chain integers to stay
 * strings — a supply above 2^53 is ordinary for an 18-decimal token, so a `number` projection would
 * be wrong for realistic inputs rather than exotic ones. Unlike `Wallet.amountNum`, no lossy
 * companion is offered at all: this endpoint does not report the token's `decimals`, so the engine
 * cannot compute a human-scale figure honestly, and inventing one from an assumed 18 would be a
 * fabrication. A caller that needs display units gets `decimals` from `onchain_get_token`.
 */
const TokenHolderSchema = z
  .object({
    address: z.string(),
    /**
     * Vendor label, when the address has one — "Binance: Hot Wallet", "Sky: PSM". Bounded like
     * every other vendor-authored string that reaches a model (`MAX_VENDOR_NAME_LENGTH`), and
     * sourced only from `metadata.tags[].name`; the URL-valued decoration that travels beside it
     * (`tooltipUrl`, `tagIcon`, `tooltipAttribution`) is dropped at the adapter boundary, since a
     * URL in a model's context is a suggestion to fetch it.
     */
    label: z.string().max(256).optional(),
    /** Exact token base units, as a decimal string. Never parsed into a number — see above. */
    amountRaw: z.string().regex(/^(0|[1-9][0-9]*)$/),
    /**
     * ERC-1155/NFT token id, when the vendor reports one (M-5). A STRING for the same reason
     * `amountRaw` is: a uint256 id exceeds 2^53.
     *
     * Why it must be carried rather than dropped: this endpoint is not ERC-20-scoped. A live probe
     * of an ERC-1155 contract returned 50 rows keyed on `(address, token_id)` with only 40 DISTINCT
     * addresses — one address appearing six times. Without the id, a caller counting holders
     * over-counts, and one summing per address produces a figure the vendor never asserted.
     */
    tokenId: z.string().optional(),
    isContract: z.boolean().optional(),
    /**
     * The vendor's own scam flag. Carried through rather than filtered on: a holder list with the
     * flagged rows silently removed would misstate concentration, which is usually the reason the
     * question was asked. Reporting it lets the caller decide; dropping it decides for them.
     */
    isScam: z.boolean().optional(),
  })
  .strict();

export const TokenHoldersSchema = z
  .object({
    chain: ChainSchema,
    tokenAddress: z.string(),
    /** Ordered as the vendor returned them (descending balance), capped by the page size. */
    holders: z.array(TokenHolderSchema).max(200),
    /**
     * True when this list is NOT the complete exact tail — either more holders exist beyond the
     * page, or rows were dropped (see `droppedRows`). "50 holders" and "the first 50 of many" are
     * different answers to a concentration question and must not look alike.
     */
    truncated: z.boolean(),
    /**
     * Rows the adapter refused to publish: a malformed `value`/`hash`, or a balance the vendor
     * marked `value_truncated` (M-4).
     *
     * Separate from `truncated` and reported as a COUNT because the two say different things: a
     * paged list is incomplete at the tail, whereas a dropped row is a hole in the middle. Both
     * make the list non-exact — hence dropping any row also sets `truncated` — but only this field
     * tells a caller that the vendor sent something we would not stand behind. The alternative,
     * silently shrinking the list, is what made a previous netflow defect expensive: the answer
     * looked complete and was not.
     */
    droppedRows: z.number().int().nonnegative(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();

export type TokenHolders = z.infer<typeof TokenHoldersSchema>;
