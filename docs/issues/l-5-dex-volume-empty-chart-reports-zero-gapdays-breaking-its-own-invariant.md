---
id: L-5
type: known-issue
status: fixed
opened_at: 2026-07-28
category: logic
severity: SEV-3
slug: l-5-dex-volume-empty-chart-reports-zero-gapdays-breaking-its-own-invariant
component: defillama-dex-volume
fingerprint: 01253f659bdfabc0
evidence_paths:
  - packages/core/src/adapters/defillama/index.ts
  - packages/mcp-server/src/tools/dex-volume.ts
  - packages/core/test/defillama-dex-volume.test.ts
  - packages/core/test/fixtures/defillama/dexs-doge-no-history.json
finding_ref: fnd-20260728-012141-01253f65
resolved_at: 2026-07-28
resolved_by: option 1 of the fix path — a requested-but-empty series counts the whole window as missing
---

> **RESOLVED 2026-07-28** — option 1 of the fix path below. `coveredDays` no longer collapses to `0`
> when a REQUESTED series comes back empty: it becomes `args.days`, so the whole unmeasured window is
> reported as missing and `points + gapDays === window.days` holds again. The `includeSeries: false`
> path is untouched and still reports `gapDays: 0`, which the second new test pins down.
>
> Evidence, all three kinds: the vendor's answer is recorded as
> `packages/core/test/fixtures/defillama/dexs-doge-no-history.json` (provenance-pinned, so a later
> silent edit turns a gate red); two tests in `defillama-dex-volume.test.ts` cover the requested and
> the not-requested case; and the live eval now grades this invariant on every run for every curated
> chain — see [RF-5](rf-5-live-eval-capability-axis-is-hand-written-so-dex-volume-history-ships-untested.md),
> without which this defect would have stayed invisible between manual sweeps. Full live run after
> the fix: 0 error, 0 degraded, exit 0.

# L-5 — onchain_dex_volume reports gapDays: 0 for a window with no data at all — the empty-chart case breaks its own invariant

**Symptom.** For a chain the capability COVERS whose vendor document carries `totalDataChart: []`,
`onchain_dex_volume` answers — with the series requested — `points: 0`, `gapDays: 0`,
`window.days: <what was asked>`. The window claims N days, none of them were measured, and the gap
counter says nothing is missing. The contract the tool publishes to its callers says the opposite:

> Daily steps missing inside the covered window. Counted, never stitched. Invariant when a series
> was requested: `points + gapDays === window.days`.
> — `packages/mcp-server/src/tools/dex-volume.ts:59-61`

Live over the full covered set (274 chains, `days: 30`, 2026-07-28): **5 chains break it** —
`bchyper`, `bsquared`, `camp-network`, `doge`, `zigchain`. Live tool call:

```json
{"chain":"doge","name":"Doge","window":{"fromMs":1784764800000,"toMs":1785110400000,"days":5},
 "series":[],"points":0,"gapDays":0,
 "totals":{"h24":null,"d7":null,"d30":null,"d1y":0,"allTime":0},
 "truncated":{"series":false,"reason":""},"source":"defillama","fetchedAt":1785190309415}
```

Nothing is fabricated — the series is empty and the totals are honest — but the one field that
exists to say "data is missing here" says the opposite, which is the L-2 shape: a health signal that
reads clean while the data is gone.

**Reproduction.**

```sh
cd "$(git rev-parse --show-toplevel)/packages/core"
cat > test/tmp-empty-chart-probe.test.ts <<'TS'
import { describe, expect, it } from 'vitest';
import { createDefillamaAdapter } from '../src/index.js';
import type { DexVolumeResult } from '../src/index.js';

describe('covered chain, empty vendor chart, series REQUESTED', () => {
  it('holds the documented invariant points + gapDays === window.days', async () => {
    // The live shape of `doge` on 2026-07-28: covered, HTTP 200, totalDataChart: []
    const doc = { chain: 'Doge', totalDataChart: [], total24h: null, total1y: 0, totalAllTime: 0 };
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(doc), { status: 200 });
    const adapter = createDefillamaAdapter({ fetchImpl, now: () => 1785190000000 });
    const raw = await adapter.fetch('dex.volume.history', { chain: 'doge', days: 5 });
    const r = adapter.normalize('dex.volume.history', raw) as DexVolumeResult;
    expect(r.points + r.gapDays).toBe(r.window.days); // present defect: 0 !== 5
  });
});
TS
npx vitest run test/tmp-empty-chart-probe.test.ts; rc=$?
rm -f test/tmp-empty-chart-probe.test.ts
exit $rc
```

Non-zero exit while the defect is present. No network — the adapter is driven by an injected
`fetchImpl`, per the package's own no-network-in-CI rule (R-21).

**Workaround.** A caller must treat `points === 0` as its own signal and NOT trust `gapDays` in that
case: with an empty series the only honest reading is "no data in this window", regardless of what
`gapDays` reports.

**Fix path.** `packages/core/src/adapters/defillama/index.ts:471-481`. `coveredDays` collapses to
`0` when `returnedSeries` is empty, so `gapDays = max(0, 0 - 0) = 0`, while line 481 falls back to
`args.days` for `window.days` — the two halves of the invariant are computed from different frames.
Pick ONE of:

1. count the whole requested window as missing when a series was requested and the vendor has no
   points at all (`gapDays = args.days`), which keeps the published invariant true; or
2. keep `gapDays: 0` and make the emptiness explicit in `window` instead — but `window.days` is
   `z.number().int().positive()`, so `0` is not expressible without a schema change.

Option 1 is the smaller change and the one the invariant already promises. Whichever is chosen, the
`includeSeries: false` path must keep `gapDays: 0` — there `points: 0` is the honest signal and the
invariant explicitly does not apply.

**Test gap that let it through.** Both existing empty-chart tests (`WI-17/D-2`,
`packages/core/test/defillama-dex-volume.test.ts:329-352`) drive the case with
`includeSeries: false`, where the behaviour is correct. The combination "series requested, vendor
has none" is untested; add it alongside, asserting the invariant rather than the literal numbers.

**Related.** Same class as [L-2](l-2-snapshotter-drops-a-metric-silently-dropped-array-never-leaves-the-node.md)
(a diagnostic that reads clean while data is missing) and the `gapDays`-frame regression fixed in
TASK-007 adversarial cycle 3 (logic L-1), which repaired the leading-edge case but not the
zero-point case. Sibling of the eval blind spot filed as the `eval-harness` finding from the same
run — that harness is where a defect of this class would otherwise have been caught live.

**Do-not.** Do not "fix" it by stitching or by inventing a zero-volume point for missing days: an
interpolated point is a number nobody measured, and the whole `gapDays` design exists to refuse
that. Do not widen the C2-1 unreadable-chart guard to fire on an empty array either — an empty
`totalDataChart` is a legitimate vendor answer (recorded fixture `dexs-ethereum-no-chart.json`), and
conflating it with a decoding failure would make `includeSeries: false` throw.
