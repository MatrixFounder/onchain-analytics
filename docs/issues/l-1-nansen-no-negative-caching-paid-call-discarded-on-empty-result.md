---
id: L-1
type: known-issue
status: open
opened_at: 2026-07-25
category: logic
severity: SEV-2
slug: l-1-nansen-no-negative-caching-paid-call-discarded-on-empty-result
---

# L-1 — a paid Nansen call whose result `normalize()` rejects is never cached, so every retry pays again

**Symptom.** `registry.ts` caches **only after** `normalize()` returns. Every `throw` inside
`normalize.ts` therefore discards an already-paid vendor response: nothing is cached, the adapter is
recorded as `tried`, the tool returns `CapabilityUnavailableError`, and the agent's natural retry
pays the full price again — indefinitely, because the same input reproduces the same throw.

The reachable throw sites and what each attempt costs:

| Site | Trigger | Cost per attempt |
| --- | --- | --- |
| `normalize.ts` `normalizeSmartMoneyFlow` | `/smart-money/netflow` returns `data: []`, or no row echoes the requested address | 10cr |
| same | non-string `token_symbol`, or any of the four `net_flow_*_usd` missing/non-finite | 10cr |
| `normalizeTokenRiskScore` | `/tgm/indicators` missing either array, or an indicator lacking `indicator_type` | 6cr |
| `normalizeEntityLabels` (exhaustive tier) | `profiler/address/labels` returns a non-array `data` | **100cr — an entire free-plan balance** |

**Why this is worth a decision.** This is not hypothetical: [DF-1](df-1-nansen-smart-money-netflow-empty-for-base-pair-tokens.md)
burned **35 real credits** on exactly this loop. DF-1's two *request-construction* causes were fixed;
the *empty-result-throws-after-payment* mechanism was not. Any token Nansen genuinely has no
smart-money row for — obscure or newly-deployed tokens, precisely what an agent reading an on-chain
token name would look up — still yields `data: []` at HTTP 200 and re-pays 10cr on every attempt.
Each distinct `tokenAddress` is a fresh cache key, so a list of such addresses converts the whole
daily cap into zero results (on the default derived cap of 30 on a free plan: three attempts, then
the day is over).

The codebase already understands this failure class and closed it **for value-shaped problems** —
`normalize.ts` truncates oversized vendor strings rather than letting a schema cap throw, for exactly
this reason, and cycle 4 extended the same reasoning to `null` array elements. What remains open is
the **structural** case: "the vendor answered correctly, and the answer is empty or unusable". There
is no negative caching anywhere in the engine.

**Raised by:** `/vdd-multi` cycle 4 (2026-07-25) — found independently by all three critics
(logic L-4/L-5 family, security S-2, performance H-3), which is why it is filed rather than argued.

## Options (not decided)

1. **Negative-cache the empty/unusable outcome** under a short TTL, so the second identical request
   is free. Needs a canonical "no data" representation that the tool layer can distinguish from a
   populated result without lying to the model.
2. **Return an empty-but-valid canonical object** instead of throwing, where the domain genuinely
   permits emptiness (an address with zero labels is a real answer; a netflow row with missing
   required windows is not). This narrows the problem rather than solving it.
3. **Cache the raw vendor response before normalization**, so a normalize change re-reads it for
   free. Largest change; also the only one that makes a normalize bug non-repeat-paying.

Option 2 is already the behaviour for `entity.labels` with zero results (`TC-CONTRACT-03`); the gap
is the other two capabilities and the structural throws.

**Known instance, deliberately left in place (2026-07-25).** `mapIndicator` throws on a `null`
element or a missing `indicator_type`, so one bad row still destroys the paid 6cr `token.risk`
response. The cycle-4 `isRecord()` sweep converted the raw TypeError there into a typed error but
did NOT convert it into a dropped row, because that path already throws by design
(`TC-CONTRACT-05`) — turning it into a drop is a change to a documented contract, which belongs to
this issue's decision rather than to a guard. `normalize.ts`'s own `isRecord` docstring records the
same limitation so it does not overstate its bound.

## Related

- [DF-1](df-1-nansen-smart-money-netflow-empty-for-base-pair-tokens.md) — the live 35cr incident whose
  request-construction half was fixed and whose payment-loss half is this issue.
- [Q-2](q-2-nansen-daily-credit-cap-has-no-default.md) — the daily cap bounds how much this can cost
  in one day; it does not stop the loop.
- `packages/core/src/adapters/nansen/normalize.ts` — the truncate-don't-throw precedent this issue
  asks to extend from values to structure.
