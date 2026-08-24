// The gate's measurement of ITS OWN egress, taken while the gate runs (WI-65, owner decision
// 2026-08-24 option (b)).
//
// **The defect this closes, measured rather than imagined.** On 2026-08-24 one gate run reported
// four `capability deadline exceeded` rows across two defillama routes AND pushed both blockscout
// acknowledgements over their bounds — three vendors at once, presented as three independent facts.
// Five unrelated hosts probed in the same minute were all answering at a uniform ~1.6 s with CONNECT
// times of 0.22–0.50 s; ninety seconds later the same hosts answered in 0.39–0.53 s with 0.012 s
// connects, same machine, unchanged code. The gate had measured our link and reported it as vendor
// drift. Nothing in the run said so, and the only reason it was caught is that somebody probed by
// hand hours later.
//
// **Why this matters beyond reading one report.** Raising an acknowledgement bound is an act of
// MEASUREMENT (RF-10), and the owner's rule of 2026-08-24 makes that explicit: a bound is the
// maximum over TWO consecutive runs whose link was measured stable. A number taken from a run whose
// own egress had stalled is not a measurement, and baking it into a bound buys the vendor slack it
// never earned — after which the next real widening arrives inside that slack, unseen.
//
// **Why a raw TCP connect and not an HTTP request.** Three reasons, in order of weight.
// 1. It measures the thing that discriminated. Total response time conflates the network with the
//    server's own work — that is why the stall above showed up as a uniform 1.6 s FLOOR rather than
//    a clean signal, and why the CONNECT time (0.012 s healthy, 0.3 s stalled, a factor of 25) is
//    what actually separates the two states.
// 2. `fetch` cannot report it. Node's fetch exposes no transport timing at all, so an HTTP-based
//    probe would have to infer connect time from total time — the very conflation being avoided.
// 3. It asks nothing of the host. A TCP handshake loads no application, spends no quota and returns
//    no data, so probing every 30 s for ten minutes is polite on hosts that owe us nothing.
//
// The measured number includes DNS resolution, exactly as `curl`'s `time_connect` does — which is
// what the recorded observations above were taken with, so the two are comparable.
//
// **The hosts are DATA and are deliberately outside the engine** (`probes.json` → `linkProbes`),
// the same rule `referenceSources` carries: a source we answer from cannot be the check on that
// answer, and a host under test cannot be the control for the test.
//
// **This never suppresses a failure.** WI-65 says so in as many words. The verdict is printed and
// recorded NEXT TO the failures so a human reads both; a gate that decides on its own when to stop
// believing itself is a gate nobody can audit.
import net from 'node:net';

/**
 * Connect-time ceiling for a link called stable, in milliseconds.
 *
 * DEFENSIVE, not a measured ceiling, and it must not be cited as one. It sits an order of magnitude
 * above the healthy readings of 2026-08-24 (6–17 ms) and well below the stalled ones (215–502 ms),
 * so both observed states land unambiguously on their own side of it.
 */
export const MAX_STABLE_CONNECT_MS = 100;

/** Below this many samples per host the run has not measured its link, and says `unknown`. */
export const MIN_SAMPLES_PER_HOST = 3;

/** How long one connect attempt may take before it counts as a failure. */
export const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Times ONE TCP connect to `host:port`, including DNS. Resolves to `{ms}` or `{ms, error}`.
 *
 * Never rejects: a probe that throws would take the gate down over a measurement about the gate.
 */
export function connectOnce(
  host,
  port = 443,
  timeoutMs = CONNECT_TIMEOUT_MS,
  connect = net.connect,
) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (extra) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // A socket that cannot be destroyed is not a fact about the link.
      }
      resolve({ ms: Date.now() - started, ...extra });
    };
    const socket = connect({ host, port });
    socket.setTimeout?.(timeoutMs);
    socket.once('connect', () => done({}));
    socket.once('timeout', () => done({ error: `no connect in ${String(timeoutMs)}ms` }));
    socket.once('error', (err) => done({ error: String(err?.code ?? err?.message ?? err) }));
  });
}

/** The median of a non-empty numeric array. */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Turns raw samples into the verdict the report and the ledger carry.
 *
 * `samples` is `[{host, ms, error?}]`. Pure, so `test/eval-link-probe.test.ts` can pin every branch
 * without a network — which is the point: the instrument that decides whether a run is admissible
 * as evidence has to be checkable itself.
 */
export function summarizeLink(samples, hosts = []) {
  const names = hosts.length ? hosts : [...new Set(samples.map((s) => s.host))];
  const perHost = names.map((host) => {
    const mine = samples.filter((s) => s.host === host);
    const ok = mine.filter((s) => !s.error).map((s) => s.ms);
    return {
      host,
      samples: mine.length,
      failures: mine.length - ok.length,
      medianConnectMs: ok.length ? median(ok) : null,
      maxConnectMs: ok.length ? Math.max(...ok) : null,
    };
  });

  const reasons = [];
  for (const h of perHost) {
    if (h.samples < MIN_SAMPLES_PER_HOST) {
      reasons.push(
        `${h.host}: ${String(h.samples)} samples, under the ${String(MIN_SAMPLES_PER_HOST)} this needs`,
      );
    }
  }
  // Too few samples is NOT a degraded link — it is no measurement at all, and the two must not be
  // reported as the same thing. `unknown` blocks a bound exactly as `degraded` does, but it says
  // "nobody looked" rather than "the link was bad", which is a different thing to go and fix.
  if (reasons.length) {
    return { verdict: 'unknown', reasons, perHost, thresholdMs: MAX_STABLE_CONNECT_MS };
  }

  for (const h of perHost) {
    if (h.failures > 0) {
      reasons.push(`${h.host}: ${String(h.failures)} of ${String(h.samples)} connects failed`);
    } else if (h.medianConnectMs > MAX_STABLE_CONNECT_MS) {
      reasons.push(
        `${h.host}: median connect ${String(h.medianConnectMs)}ms over the ${String(MAX_STABLE_CONNECT_MS)}ms bound`,
      );
    }
  }
  return {
    verdict: reasons.length ? 'degraded' : 'stable',
    reasons,
    perHost,
    thresholdMs: MAX_STABLE_CONNECT_MS,
  };
}

/**
 * One line for the report, and the same text for the ledger.
 *
 * A `stable` run says so out loud rather than staying silent, because silence is what the previous
 * shape offered and it read as "fine" on the run that was anything but.
 */
export function renderLink(summary) {
  if (!summary) return 'link: not measured (no linkProbes configured)';
  const per = summary.perHost
    .map(
      (h) => `${h.host} ${h.medianConnectMs === null ? 'n/a' : `${String(h.medianConnectMs)}ms`}`,
    )
    .join(' · ');
  const n = summary.perHost.reduce((a, h) => a + h.samples, 0);
  if (summary.verdict === 'stable') {
    return `link: stable — median connect ${per} over ${String(n)} probes, 0 failures`;
  }
  return (
    `link: ${summary.verdict.toUpperCase()} — ${summary.reasons.join('; ')} (${per}). ` +
    'Vendor rows from this run are an OBSERVATION, not a measurement: do not set an ' +
    'acknowledgement bound from it'
  );
}

/**
 * Samples every host until `stop()` is called. Returns a handle whose `stop()` resolves to the
 * summary.
 *
 * The first round runs immediately so a short run is still measured; `unref` keeps the timer from
 * holding the process open if the gate finishes between rounds.
 */
export function startLinkProbe(config, deps = {}) {
  const hosts = config?.hosts ?? [];
  const intervalMs = config?.intervalMs ?? 30_000;
  if (hosts.length === 0) return { stop: async () => null };

  const probe = deps.connectOnce ?? connectOnce;
  const samples = [];
  let stopped = false;
  let timer = null;
  let inFlight = Promise.resolve();

  const round = () => {
    inFlight = Promise.all(
      hosts.map((host) =>
        probe(host).then((r) => {
          if (!stopped) samples.push({ host, ...r });
        }),
      ),
    );
    return inFlight;
  };

  round();
  timer = setInterval(round, intervalMs);
  timer.unref?.();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      await inFlight.catch(() => {});
      return summarizeLink(samples, hosts);
    },
  };
}
