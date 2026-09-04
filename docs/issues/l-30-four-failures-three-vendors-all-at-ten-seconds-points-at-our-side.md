---
id: L-30
type: known-issue
status: open
opened_at: 2026-09-02
category: logic
severity: SEV-3
slug: l-30-four-failures-three-vendors-all-at-ten-seconds-points-at-our-side
---

# L-30 — four failures across three vendors, all at ~10 s, and no bound found that explains it

> Filed because the SHAPE is the finding. Each of the four rows was attributable to a vendor record
> on its own, and three of them were so attributed the same evening. Together they are not a vendor
> story at all, and nothing would have noticed that from inside any single record.

**Symptom.** Two gate runs 21 minutes apart, both on a link the gate measured stable:

| row | vendor | run | elapsed | refusal |
| :-- | :-- | :-- | --: | :-- |
| `bsc/pairs.active` | DexScreener | A, 20:31 UTC | 10 152 ms | `capability unavailable` |
| `solana/chain.tvl.history` | DeFiLlama | A, 20:31 UTC | 10 507 ms | `capability unavailable` |
| `ethereum/token.price` | CoinGecko | B, 20:52 UTC | 10 010 ms | `capability unavailable` |
| `avalanche/token.price` | CoinGecko | B, 20:52 UTC | 10 510 ms | `capability unavailable` |

Every other row of those three vendors passed in the same runs, in 79–2818 ms. Two of the four
differ by **3 ms** and belong to different vendors.

**What the clustering does and does not support.** Four samples in a 500 ms band across three
independent endpoints is suggestive of a fixed bound and is not proof of one. The strongest-sounding
detail — two figures 3 ms apart — is the weakest: those two come from DIFFERENT runs 21 minutes
apart, so their closeness carries much less than it reads. Stated plainly because the first draft of
this record leaned on it as if it were decisive.

What the refusal class does support: `capability unavailable` means the provider call FAILED, not
that a deadline of ours cut it. A deadline refusal would have said so and named its phase (L-26 fix
path item 1).

**The obvious competing explanation was tested, not argued away: "that is simply how a free tier
answers."** Free vendors throttle by slowing as well as by refusing, so a ~10 s answer could be
ordinary vendor behaviour. That is a claim about HABITUAL behaviour, and habitual behaviour is
measurable at any time. Measured 2026-09-03 under deliberate load:

| vendor | concurrent requests | result |
| :-- | --: | :-- |
| DeFiLlama (`/v2/historicalChainTvl/Solana`) | 25 | all 200, 1.131–1.487 s |
| DexScreener (`/latest/dex/search`) | 20 | all 200, 0.964–1.056 s |
| CoinGecko (`/coins/ethereum/contract/…`) | 8 | all 200, 1.289–1.328 s |

None approaches 10 s under load. And when CoinGecko's keyless quota IS exhausted — five sequential
requests were enough on 2026-09-02 — it answers **429 in 0.35–0.39 s**: a free tier that has had
enough refuses fast here, it does not hold the connection. The explanation is therefore not supported
for these three endpoints, which is a different and weaker statement than "it is impossible".

**What that measurement cannot do.** It was taken after the window, so it says these vendors do not
HABITUALLY answer at ~10 s; it cannot say they were not slow at 20:31–20:52 on 2026-09-02. Same
limitation as the DNS probe below, for the same reason (L-25).

**No 10-second bound was FOUND in the request path — which is not the same as none existing.**
The search below is a grep plus a read of the retry paths, not a proof.
`safeFetch`'s `DEFAULT_TIMEOUT_MS` is `15_000`. The capability deadline for `token.price` is
`15_000`. The eval's retry (`RETRY_BACKOFF_MS = [4000, 12000]`) does not apply: `RETRIABLE` does not
match this refusal text, so each figure above is one call, not a sum. The only `10_000` constants in
the repository are `pg` connection timeouts, the link probe's own `CONNECT_TIMEOUT_MS`, and the
reference-source timeout — none of them on this path. `safeFetch` carries no retry, and neither
`defillama` nor `coingecko` retries at the adapter level, so a backoff ladder summing to ~10 s is
ruled out as well.

**The candidate, named as a candidate, with arithmetic behind it.** This machine's resolver timeout
is **5 s** (`scutil --dns`), and one of its scoped configurations lists **two** nameservers
(`fe80::1%en0`, `192.168.1.1`). Two servers at five seconds is ten seconds. A resolver stall would
be vendor-independent by construction, would produce a fetch failure rather than a deadline refusal,
and would leave the vendors themselves healthy — which is what the direct probes found minutes
later: DexScreener 200 on five of five, CoinGecko `ethereum/WETH` 200 in 0.42–0.71 s three times,
DeFiLlama 200. Resolution itself measured 60–90 ms for all three hosts.

**That measurement was taken AFTER the window, and therefore proves nothing about the window.** This
is [L-25](l-25-a-wide-sweep-makes-defillama-rows-fail-that-answer-fine-alone.md)'s lesson, which was
itself a record refuted for asserting a mechanism from measurements taken at different times. The
candidate is written down so the next occurrence has somewhere to start, not because it is
established.

**What this costs the records that already exist.** Three of these four rows were read as vendor
behaviour the same evening, and two of those readings are now doubtful:

- [L-26](l-26-token-price-on-tron-exceeded-its-deadline-once-with-the-vendor-healthy.md) had its
  bound raised 1 → 2 on the two CoinGecko rows. The count is right and the attribution may not be.
- [L-23](l-23-dexscreener-stopped-answering-entirely-and-took-three-capabilities-with-it.md) kept
  `pairs.active` acknowledged at a narrowed bound of 1 on the strength of `bsc` failing once. Same
  caveat.
- `solana/chain.tvl.history` is covered by no entry at all — `chain.tvl.history` is absent from both
  of L-24's sets — which is why the gate blocked on it and why this record exists.

Neither bound is being reverted: they are measurements of how many rows failed, which is true
whatever caused it, and an acknowledgement's job is to keep a failing row visible rather than to
explain it. What changes is that both records now point here.

**What would settle it.** A capture DURING the window, which means instrumenting before the next
occurrence rather than probing after it:

1. ~~Record DNS resolution time per call in the eval's own row data.~~ **DONE 2026-09-03.**
   `eval/dns-timing.mjs` is an `--import` preload wrapping `dns.lookup`, loaded into BOTH servers a
   run spawns; anything slower than `ONCHAIN_EVAL_DNS_REPORT_MS` (default 250 ms, against a healthy
   60–90 ms here) writes one `DNS-TIMING host=… ms=… resolved=…` line. `report()` reads those lines,
   prints the ten slowest, and carries them into the JSON artifact as `slowDns` — the console
   scrolls away and the artifact is what a later reader has.

   **A preload, not a change in `safeFetch`:** the shipped request path should not grow a branch to
   answer a question about the harness's environment, and `--import` confines this to a gate run.
   `dns.lookup` is the hook because `fetch` reaches the network through `net.connect`, which
   resolves that way unless a caller supplies its own resolver — nothing here does. No address is
   printed, only the host and the elapsed time.

   Proven both ways before it was trusted: at a floor of 0 ms it reports a healthy lookup
   (`api.llama.fi`, 9 ms, `resolved=yes`) and a failing one (`…invalid`, 11 ms, `resolved=no`); at
   the working floor it stays silent on a healthy run. Two assertions guard it, each proven by
   mutation — one that the preload reaches BOTH phases (instrumenting one and not the other makes a
   silent run meaningless), one that the lines have a reader in the console AND the artifact, which
   is the very defect L-26 recorded about this channel.
2. Failing that, run the gate with a resolver that has a single nameserver and see whether the
   ~10 s signature becomes ~5 s. A bound that moves with the configuration is a bound.
3. `capability unavailable` still reaches the caller with its cause removed (L-26's update of the
   same day). Until that changes, every occurrence of this class starts an investigation from zero.

**Reproduction.** None on demand — the four samples came from two runs out of fourteen taken over
two days. The signature to watch for is the number itself: any `capability unavailable` row whose
elapsed time lands within a few hundred ms of 10 000 or 10 500.

**Related.** [L-26](l-26-token-price-on-tron-exceeded-its-deadline-once-with-the-vendor-healthy.md),
[L-23](l-23-dexscreener-stopped-answering-entirely-and-took-three-capabilities-with-it.md),
[L-25](l-25-a-wide-sweep-makes-defillama-rows-fail-that-answer-fine-alone.md) — the record that
established why the candidate above is written as a candidate.
[WI-65](../backlog/wi-65-the-gate-cannot-tell-a-vendor-outage-from-a-stall-on-our-own-link.md) — the
gate's link probe answers "was OUR egress healthy", and it said yes in both runs. It measures
connect time to three control hosts and does not measure name resolution, so it cannot see this.

---

**Update 2026-09-04 — a ten-second bound DOES exist in the request path, and it is not ours to see.**
This record says none was found. One was, by probing the runtime rather than by reading the
repository:

```
node -e "fetch('http://10.255.255.1/')"     # non-routable IPv4 literal, no DNS involved
-> failed after 10 558 ms
   TypeError: fetch failed
   cause: ConnectTimeoutError … (attempted address: 10.255.255.1:80, timeout: 10000ms)
          code = UND_ERR_CONNECT_TIMEOUT
```

The bound is the runtime's default connect timeout. It is invisible to a reader grepping this
repository because it is a client default, not a constant here. `safeFetch` declares
`DEFAULT_TIMEOUT_MS = 15_000` per hop; where the declared budget is larger than 10 000 ms, this
bound ends the hop first. Setting it requires an `undici` dispatcher, and `undici` is neither a
dependency of `@onchain-intel/core` nor a Node builtin, so the bound cannot currently be changed.

**This does not settle the four rows, and the difference matters.** The probe used an IPv4 literal,
so it never resolved a name. The four failing rows named hosts. A resolver stall remains the
candidate this record already carries, and it reaches the same ten seconds by a different route.
The two mechanisms are distinguished by signature — `UND_ERR_CONNECT_TIMEOUT` against `EAI_AGAIN` or
`ENOTFOUND` — and the signature of those four rows was never persisted (see the next paragraph).

**A confound neither this record nor L-23 accounts for.** `scutil --dns` on 2026-09-04 shows the
default resolver as a single nameserver, `198.18.0.2`, on interface `utun8`, flagged
`Transient Connection`; `/etc/resolv.conf` carries the same one address. It answers with
SYNTHESIZED addresses inside the benchmarking range 198.18.0.0/15:

| host | A | AAAA |
| :-- | :-- | :-- |
| `api.dexscreener.com` | `198.18.0.255` | `::ffff:198.18.0.255` |
| `api.llama.fi` | `198.18.0.253` | `::ffff:198.18.0.253` |

Those are not the vendors' addresses. Every vendor call from this machine crosses a tunnel that maps
the destination, so a measurement taken here cannot separate a vendor outage from a stall in that
tunnel. The two-nameserver configuration this record's candidate cites is a DIFFERENT block of the
same `scutil --dns` output, scoped to `en0`. Step 2 of the list above — run the gate with a
single-nameserver resolver — therefore has a second reading: it also changes which path the traffic
takes.

**What changed in code.** `safeFetch` now recognises the connect-timeout signature and raises
`RuntimeConnectTimeoutError` instead of letting `TypeError: fetch failed` reach the adapter as an
opaque vendor failure. The message names which side owns the bound that fired, reports the number
the runtime itself wrote, and carries the original error as `cause`. It claims an ordering only
where the declared per-hop budget is larger than the bound, because `blockscout` and
`blockchain-info` declare 5 000 ms and there the hop signal cuts first. The dual-stack
`AggregateError` shape is matched one level deep, defensively: no probe here produced one.

This does not diagnose the four rows retroactively. It makes the next occurrence of THIS mechanism
name itself instead of arriving as `fetch failed`.
