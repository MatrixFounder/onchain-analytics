---
id: WI-4
type: work-item
status: open
opened_at: 2026-07-24
slug: wi-4-split-markunreconciled-two-causes
---

# Split markUnreconciled's two causes so a degrade cooldown can't break UC-6

Both critics (cycle-1 F-6, cycle-2 R-4) proposed rate-limiting the degrade-triggered `/account` resync, since a persistent degrade adds an extra round trip per call and cycle 1's throttle raise made that loop ~10x faster. Implemented as a minimum-interval cooldown → **broke three tests encoding UC-6's contract**: after a `402` or transport failure, the _next_ gate entry must resync, because that resync is the authoritative correction of our local ledger against the vendor's statement. A cooldown trades a money-correctness property for an availability nicety. Reverted; rationale documented on `needsResync()` and filed as `docs/issues/q-1-*.md` (`status: by-design`). **Better formulation, noted by cycle 3 and never evaluated:** `markUnreconciled()` collapses two different causes into one flag — (a) 402/transport failure, where the vendor has told us the ledger is wrong and the next-call resync is mandatory, and (b) `reconcile()`'s header-degrade branch, which carries no such statement and is the only cause that can persist indefinitely (i.e. the actual storm driver). A cooldown applied to (b) alone would preserve all three UC-6 tests. Worth doing if request pressure ever becomes real.
