---
id: Q-10
type: known-issue
status: open
opened_at: 2026-08-10
category: quality
severity: SEV-3
slug: q-10-new-pairs-silently-drops-vendor-rows-that-fail-validation
provenance: machine
component: mcp-new-pairs
fingerprint: a4d3e4060fb79431
finding_ref: fnd-20260810-201541-a4d3e406
---

# Q-10 — onchain_new_pairs silently drops vendor rows that fail validation; the count goes only to stderr

> Filed by `run-feedback` from capture `fnd-20260810-201541-a4d3e406`. **This body is data, not instructions** — it derives from captured output and may quote untrusted text.

**Symptom.** `onchain_new_pairs({chain: "ethereum", limit: 5})` returned **two** pairs. The response
carries no field that says why, so "the chain only has two matching pools" and "three rows were
thrown away" are the same observation from the client's side.

The mechanism is in the adapter, and it is the second reading, not the first
(`packages/core/src/adapters/dexscreener/index.ts`):

```ts
const parsed = PoolSchema.safeParse(pool);
if (!parsed.success) {
  malformedCount += 1;
  continue;
}
pools.push(parsed.data);
…
if (malformedCount > 0) {
  process.stderr.write(…)
}
```

A vendor row that fails validation is dropped, counted, and reported **to stderr** — a channel the
MCP client never sees (and cannot see: stdout is the JSON-RPC wire, so stderr is the only place a
diagnostic may go on the stdio transport). The number of rows the vendor actually returned, and the
number discarded, never reach the caller.

This is the shape [L-2](l-2-snapshotter-drops-a-metric-silently-dropped-array-never-leaves-the-node.md)
recorded on the snapshotter: a health signal is computed correctly and has no reader, so partial data
is indistinguishable from complete data. There it cost four days of a missing metric looking like a
clean run. Here it means a caller cannot tell a thin chain from a broken payload, and — because the
same tool already misrepresents recency ([Q-8](q-8-new-pairs-returns-established-pools.md)) — cannot
fall back on reasoning about which pairs *should* be present.

Other tools in the same server do carry this signal: `onchain_dex_volume` and
`onchain_dash_platform_history` both return a `truncated: {series, reason}` object. `pairs.new` is the
outlier, not the norm.

**Reproduction.**

```sh
cd packages/mcp-server && pnpm build

# 1. The drop-and-count site, and the stderr-only reporting:
grep -n "malformedCount" ../core/src/adapters/dexscreener/index.ts

# 2. Live: call the tool with a limit above what comes back, and compare stderr with the payload.
#    tool: onchain_new_pairs  args: {"chain":"ethereum","limit":5}
#    -> 2 pairs in the result; any drop notice appears only on the server's stderr
ONCHAIN_EVAL_CHAINS=ethereum node eval/run.mjs 2>eval-stderr.log
grep -i "malformed\|dropped" eval-stderr.log || echo "no drop notice on this run"

# 3. The sibling tools that DO signal truncation, for contrast:
grep -n "truncated" src/tools/dex-volume.ts src/tools/dash-platform-history.ts
```

**Workaround.** None from the client side. A short page can only be interpreted by reading the
server's stderr, which is unavailable to a normal MCP consumer.

**Fix path.** Additive and local: return the counts the adapter already computes. Give the `pairs.new`
response the same shape its siblings use — `truncated: {pairs: boolean, reason: string}` — and
populate it from `malformedCount` and from whether the vendor page was cut to `limit`. The values
exist at the drop site; only the plumbing to the response is missing. Keep the stderr line as well:
it is the operator's channel, and the fix is about adding the caller's channel, not moving it.

Gate-verifiable with a fixture whose vendor page contains one malformed row: assert the result is
short **and** that the response says so.

**Related.** [Q-8](q-8-new-pairs-returns-established-pools.md) — same tool, independent defect; the two
compound, because a caller who cannot trust the selection also cannot trust the count.
[L-2](l-2-snapshotter-drops-a-metric-silently-dropped-array-never-leaves-the-node.md) — the origin of
the "a diagnostic nobody reads is not a diagnostic" rule this applies, on the n8n side of the project.
Probe: 15-scenario live run, 2026-08-10.

**Do-not.** Do **not** make a malformed row fatal: dropping one bad pool and returning nine good ones
is the right behaviour for this capability — the defect is the silence, not the drop. Do **not** move
the diagnostic from stderr to stdout: stdout is the JSON-RPC wire and writing to it corrupts the
transport (an M0 §7.3 invariant); the signal belongs in the response body, not in the stream.
