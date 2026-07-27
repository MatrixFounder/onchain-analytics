---
id: WI-3
type: work-item
status: open
opened_at: 2026-07-23
slug: wi-3-triage-m1-cycle3-unverified-candidates
---

# Triage M1 adversarial cycle-3 unverified candidates (10 MINOR + 4 bikeshed)

Cycle-3 verification fleet was quota-starved (32/36 verify agents failed on session limit), so these critic candidates carry NO adversarial verdicts. The one claimed MAJOR (get_token served priceUsd under 3600s token.metadata TTL; token.price 60s route dead) was orchestrator-verified and FIXED (commit 8a602cc). Remaining unverified MINORs: new-pairs absent-vs-explicit-limit cache-key split; rpc-solana isError for >9M SOL wallets (MAX_SAFE_INTEGER); protocolSlug unbounded length; chunked-response size cap gap in safeFetch; pg Pool construction outside DSN-sanitizing catch; no singleflight coalescing; sqlite handle leak if constructor throws post-open; stderr backlog if host never drains; rate-limit refund untested; isAvailable-throw aborts route walk (1 verdict: refuted as bikeshed). Bikeshed: 3 handlers use .parse vs protocol-tvl safeParse; canonical string fields unbounded; defillama fixture breadth (~47 unused chains); rpc error messages JSON.stringify whole envelope. Triage each: fix-in-M2 / accept / reject. Full critic text: journal of workflow run wf_9d5da612-ce4.
**Triaged 2026-07-23 (user-authorized fix round):** ✅ fixed (6): new-pairs cache-key default-limit; protocolSlug .max(128); pg Pool construction sanitized; sqlite handle closed on constructor throw; rpc error messages truncated to 500 chars; rate-limit saturation-refund test. → M2 (3): singleflight coalescing (fits budget-guard — paid-call dedup), chunked-response size cap (stream counting), solana >9M SOL exact lamports (needs raw-text JSON parse). Accepted as documented (5): isAvailable-throw route-walk (refuted — unreachable today), stderr-drain backlog (host drains), .parse-vs-safeParse consistency (adapters pre-validate), canonical string .max bounds (10MB cap bounds it), defillama fixture breadth (proves slice fidelity). RF-1 fixed the same round (ledger flipped).
