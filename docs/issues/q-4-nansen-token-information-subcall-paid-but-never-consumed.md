---
id: Q-4
type: known-issue
status: fixed
opened_at: 2026-07-25
category: quality
severity: SEV-3
slug: q-4-nansen-token-information-subcall-paid-but-never-consumed
resolved_at: 2026-07-25
resolved_by: consume the sub-call (R-43 as written)
---

> **RESOLVED 2026-07-25 — by CONSUMING the sub-call, not dropping it.** The two options below were
> genuinely open until the recorded fixtures were compared, and the evidence went the opposite way
> from the cheaper-looking guess. `/tgm/indicators`' own `token_info` carries **three** fields
> (`market_cap_usd`, `market_cap_group`, `is_stablecoin`); `/tgm/token-information` carries **~20**,
> including deployment date, FDV, circulating/total supply, spot liquidity and holder count — all
> first-order risk inputs. So R-43's "(метаданные)" was correct and the implementation was the part
> that was wrong. Dropping the call would have deleted real data the requirement promises, to save
> 1cr. See "How the decision was made" at the end.

# Q-4 — `token.risk` pays 1cr per call for `/tgm/token-information`, whose body is never read

**Symptom.** Every `onchain_token_risk` cache miss issues two sequential sub-calls:
`/tgm/indicators` (5cr) and `/tgm/token-information` (1cr). `normalizeTokenRiskScore` builds the
entire `TokenRiskScore` — metadata included — from `indicators.body.token_info`. The
`tokenInformation` response is fetched, parsed, carried through `reconcile()`, and discarded. Its own
docstring says so: *"`raw.tokenInformation` is fetched (R-43, always both) but intentionally unused
here."*

So **1 of every 6 credits spent on this capability (16.7%) buys nothing**, plus one fully serialized
extra round trip on the critical path and one throttle token. On a 100-credit free plan that is 16
wasted credits per 100 spent on `token.risk`.

**Why this is filed, not patched.** R-43 in `docs/TASK.md` specifies *"`/tgm/indicators` +
`/tgm/token-information` (метаданные)"* — "always both" is the requirement as written, and
`TC-E2E-09` asserts the resulting `creditsUsedToday === 6`. So the code matches the spec; the spec
buys a payload it does not use. Changing it is a requirement decision, and it cuts two ways:

- **Drop the sub-call** → `token.risk` costs 5cr instead of 6 (−17%), one less round trip, and the
  cost table, `costOf()`, `TC-E2E-09` and the R-43 row all move together. Loses nothing that is
  currently returned.
- **Consume it** → deliver the metadata R-43 actually promises (whatever `/tgm/token-information`
  carries that `token_info` does not), keeping the 6cr price honest.

Either is defensible. Paying for it and discarding it is the one option that is not.

**Adjacent, same shape but free:** `entity.labels` issues `POST /search/entity-name` (0cr) whose
response `normalize.ts` also never reads — kept for "HTTP-call/cost parity". At zero credits the
waste is one round trip, not money, but the parity argument buys nothing either.

**Also noted:** `NANSEN_COST_TABLE['GET /api/v1/account']` is never looked up — `endpointsFor()` has
no branch returning it. Harmless (the resync is genuinely 0cr), but it is dead config.

**Raised by:** `/vdd-multi` cycle 4 (2026-07-25) — performance H-2 and the RTM completeness audit
(R-43 verdict PARTIAL) independently.

## Related

- `docs/TASK.md` R-43 — the requirement whose "метаданные" half is paid for but not delivered.
- `packages/core/src/adapters/nansen/index.ts` (sub-call sequencing),
  `packages/core/src/adapters/nansen/normalize.ts` (`TokenRiskFetchResult` docstring),
  `packages/core/src/adapters/nansen/cost-table.ts`.

---

## How the decision was made (2026-07-25)

The issue framed two options and called drop-it the cheaper win. **That framing was wrong, and the
fixtures settled it at zero credits** — both responses had already been recorded in task 005-7, so
deciding cost nothing but reading them.

| Source | Fields it carries |
| --- | --- |
| `/tgm/indicators` → `token_info` | `market_cap_usd`, `market_cap_group`, `is_stablecoin` — **3** |
| `/tgm/token-information` | name, symbol, contract, logo, deployment date, website, socials, market cap, FDV, circulating/total supply, and a full `spot_metrics` block (volume, buys/sells, unique buyers/sellers, liquidity, holders) — **~20** |

Dropping the sub-call would have saved 1cr per call and deleted the metadata R-43 promises.

### What is now surfaced, and what is deliberately not

Added to `TokenRiskScore` — selected because a **risk** verdict rests on them:

- `deploymentDate` — token age; a mint deployed yesterday is not the same risk as one from 2018.
  Kept as the vendor's raw string (`2018-08-03 19:28:24`), **never parsed to epoch-ms**: the format
  carries no timezone, and this project does not guess vendor semantics.
- `liquidityUsd` — the best single proxy for exit risk; a large cap on thin liquidity is the classic
  shape this capability exists to flag.
- `totalHolders` — concentration proxy.
- `fdvUsd`, `circulatingSupply`, `totalSupply` — dilution/unlock risk that `marketCapUsd` hides.
- `name`, `symbol` — identity, so a caller can verify it got the token it asked for.

**Deliberately excluded:** `logo`, `website`, `x`, `telegram`. Vendor-authored URLs with no
analytical value for a risk score, and a needless prompt-injection surface into the model's context
— the same reasoning that bounds every other vendor-authored string in `normalize.ts`.

### Failure behaviour

The two sub-responses are **not equal in weight**. A malformed `indicators` body stays fatal — it is
the substance of a risk score. A malformed `token-information` body is not: every field it
contributes is optional, so it degrades to "those fields absent" rather than throwing away an
already-paid 6cr response and sending the retry to pay again. That is the
[L-1](l-1-nansen-no-negative-caching-paid-call-discarded-on-empty-result.md) class, and it is
regression-tested (`nansen.hardening.test.ts`, "Q-4" block: null/garbage body, out-of-domain
numbers).

`TC-CONTRACT-04`'s golden assertion was widened to include the eight new fields, read straight from
the already-recorded fixture — logged here and in the test's own comment rather than changed
silently.

### Still true

The price of `token.risk` is unchanged at **6cr** — this fix does not make the capability cheaper,
it makes the 6cr honest. The adjacent `entity.labels` → `POST /search/entity-name` call remains
fetched-and-unread, but at **0cr** it wastes a round trip rather than money; not addressed here.
