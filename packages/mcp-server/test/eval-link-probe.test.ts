import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// prettier-ignore
// @ts-expect-error — the eval is plain .mjs by design (no build step, no SDK); only its data is read
import { MAX_STABLE_CONNECT_MS, MIN_SAMPLES_PER_HOST, renderLink, startLinkProbe, summarizeLink } from '../eval/link-probe.mjs';
import { adapterRegistrations } from '@onchain-intel/core';

/**
 * TC-UNIT-17 — the gate's measurement of its own egress (WI-65, owner decision 2026-08-24).
 *
 * **Why this instrument needs its own tests more than most.** It is the thing that decides whether a
 * run's vendor rows count as EVIDENCE. Under the owner's rule an acknowledgement bound is the
 * maximum over two consecutive runs whose link was stable, so a verdict function that answered
 * `stable` too readily would quietly re-admit exactly the run that caused WI-65 — and it would do so
 * invisibly, because the failing rows look identical either way.
 *
 * Everything here is offline. `summarizeLink` is pure, and `startLinkProbe` takes its connect
 * function as a dependency, so no test touches the network (R-21).
 */
describe('TC-UNIT-17 — the link probe decides whether a run is admissible as evidence', () => {
  const samplesFor = (host: string, ms: number[], errors = 0) => [
    ...ms.map((m) => ({ host, ms: m })),
    ...Array.from({ length: errors }, (_, i) => ({ host, ms: 10_000, error: `boom ${String(i)}` })),
  ];

  it('calls a healthy link stable, on the numbers actually measured on 2026-08-24', () => {
    // The healthy readings that day were 6–17ms of TCP connect.
    const summary = summarizeLink([
      ...samplesFor('a', [7, 8, 9, 12]),
      ...samplesFor('b', [6, 7, 17, 8]),
    ]);
    expect(summary.verdict).toBe('stable');
    expect(summary.reasons).toStrictEqual([]);
    expect(summary.perHost[0]).toMatchObject({ host: 'a', samples: 4, failures: 0 });
  });

  it('calls the measured stall degraded, and names the host and the number', () => {
    // The stalled readings that day were 215–502ms, on five unrelated hosts at once.
    const summary = summarizeLink([
      ...samplesFor('a', [215, 345, 501, 502]),
      ...samplesFor('b', [220, 300, 410, 430]),
    ]);
    expect(summary.verdict).toBe('degraded');
    expect(summary.reasons).toHaveLength(2);
    expect(summary.reasons[0]).toContain('median connect');
    expect(summary.reasons[0]).toContain(String(MAX_STABLE_CONNECT_MS));
  });

  it('one slow host is enough — a uniform floor is not required to call it degraded', () => {
    // Deliberate: the verdict gates whether a bound may be SET, and a link that is bad on one path
    // out of three is already a link nobody should measure a vendor through.
    const summary = summarizeLink([
      ...samplesFor('a', [7, 8, 9]),
      ...samplesFor('b', [400, 420, 450]),
    ]);
    expect(summary.verdict).toBe('degraded');
    expect(summary.reasons).toHaveLength(1);
    expect(summary.reasons[0]).toContain('b');
  });

  it('a failed connect is degraded even when the successful ones were fast', () => {
    const summary = summarizeLink(samplesFor('a', [7, 8, 9], 1));
    expect(summary.verdict).toBe('degraded');
    expect(summary.reasons[0]).toContain('1 of 4 connects failed');
  });

  it('too few samples is `unknown`, which is NOT `degraded`', () => {
    // The two must stay distinct: both block a bound, but one says "nobody looked" and the other
    // says "the link was bad", and they send a reader to different places.
    const summary = summarizeLink(samplesFor('a', [7]));
    expect(summary.verdict).toBe('unknown');
    expect(summary.reasons[0]).toContain(String(MIN_SAMPLES_PER_HOST));
  });

  it('a host with zero samples is `unknown`, not silently dropped from the verdict', () => {
    // The hosts list is passed explicitly for exactly this: a host that never answered would
    // otherwise vanish from `perHost` and the run would look fully measured.
    const summary = summarizeLink(samplesFor('a', [7, 8, 9]), ['a', 'never-answered']);
    expect(summary.verdict).toBe('unknown');
    expect(summary.perHost.map((h: { host: string }) => h.host)).toContain('never-answered');
  });

  it('says out loud that a non-stable run may not set a bound', () => {
    const degraded = renderLink(summarizeLink(samplesFor('a', [400, 420, 450])));
    expect(degraded).toContain('DEGRADED');
    expect(degraded).toContain('do not set an acknowledgement bound');
    const stable = renderLink(summarizeLink(samplesFor('a', [7, 8, 9])));
    expect(stable).toContain('stable');
    expect(stable).not.toContain('do not set');
    // A stable run states its numbers rather than staying silent — silence is what the shape before
    // WI-65 offered, and it read as "fine" on the run that was anything but.
    expect(stable).toContain('median connect');
  });

  it('renders an unmeasured run as unmeasured rather than as fine', () => {
    expect(renderLink(null)).toContain('not measured');
  });

  it('samples every host on a schedule and stops cleanly', async () => {
    const seen: string[] = [];
    const probe = startLinkProbe(
      { hosts: ['h1', 'h2'], intervalMs: 5 },
      {
        connectOnce: (host: string) => {
          seen.push(host);
          return Promise.resolve({ ms: 9 });
        },
      },
    );
    await new Promise((r) => setTimeout(r, 40));
    const summary = await probe.stop();
    expect(seen.filter((h) => h === 'h1').length).toBeGreaterThanOrEqual(MIN_SAMPLES_PER_HOST);
    expect(summary.verdict).toBe('stable');
    // Stopped means stopped: no further samples land after the summary is taken.
    const after = seen.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(summary.perHost[0].samples).toBeLessThanOrEqual(after);
  });

  it('is a no-op when no hosts are configured, and says so', async () => {
    const probe = startLinkProbe({ hosts: [] });
    expect(await probe.stop()).toBeNull();
    expect(renderLink(null)).toContain('not measured');
  });
});

describe('TC-UNIT-18 — the probe hosts are outside everything under test', () => {
  const evalDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'eval');
  const probes = JSON.parse(readFileSync(path.join(evalDir, 'probes.json'), 'utf8')) as {
    linkProbes?: { hosts?: string[]; intervalMs?: number };
    referenceSources?: Record<string, { url: string }>;
  };

  it('names at least three hosts, on a real interval', () => {
    // Three rather than one because the signal is a UNIFORM floor across unrelated paths.
    expect(probes.linkProbes?.hosts ?? []).toHaveLength(3);
    expect(probes.linkProbes?.intervalMs).toBeGreaterThan(0);
  });

  it('none of them is an engine adapter host — a host under test cannot be the control', () => {
    const adapterHosts = new Set(adapterRegistrations.flatMap((r) => r.hosts));
    for (const host of probes.linkProbes?.hosts ?? []) {
      expect(adapterHosts, `${host} is an adapter host`).not.toContain(host);
    }
  });

  it('none of them is a reference source either', () => {
    // `mempool.space` is fetched by the eval itself, so a slow one there must not read as a slow
    // link — that would make the control and the thing controlled the same measurement.
    const referenceHosts = new Set(
      Object.values(probes.referenceSources ?? {}).map((r) => new URL(r.url).hostname),
    );
    for (const host of probes.linkProbes?.hosts ?? []) {
      expect(referenceHosts, `${host} is a reference source host`).not.toContain(host);
    }
  });
});
