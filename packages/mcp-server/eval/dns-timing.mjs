// Name-resolution timing for the live gate (L-30 fix path item 1).
//
// WHY THIS EXISTS. On 2026-09-02 four rows failed across THREE vendors, every one of them at
// ~10 000–10 510 ms, with `capability unavailable` — the class that reaches the caller with its
// cause removed. Three of the four were written up as vendor behaviour the same evening, and the
// competing explanation could not be tested after the fact: probing a vendor once the window has
// closed answers a question nobody asked (L-25). This module makes the discriminator available
// DURING the run instead: a 10 s row whose name lookup took 10 s is one defect, a 10 s row whose
// lookup took 60 ms is a different one.
//
// WHY A PRELOAD AND NOT A CHANGE IN `safeFetch`. The production request path should not grow an
// instrumentation branch to answer a question about the harness's own environment. `--import` puts
// this in the eval's spawned server and nowhere else: no shipped code is touched, and a gate run is
// the only context where it loads.
//
// WHY `dns.lookup` IS THE RIGHT HOOK. Node's `fetch` reaches the network through `net.connect`,
// which resolves with `dns.lookup` unless a caller passes its own resolver — nothing here does. The
// promise form delegates to the callback form, so wrapping the callback covers both.
//
// WHAT IT REPORTS AND WHAT IT MUST NOT. One stderr line per lookup slower than the threshold,
// carrying the host, the elapsed ms and whether it resolved. Hostnames of our own providers are not
// secrets — they are in `providers.config.ts` — but no address is printed: a resolved IP says
// nothing about latency and would be the one field a reader could mistake for a target.

import dns from 'node:dns';

/**
 * The floor for reporting, in ms.
 *
 * A healthy lookup on this machine measures 60–90 ms, and a gate run makes hundreds. Printing all of
 * them would bury the signal in the channel that already carries it (`report()` reads stderr for one
 * substring today and discards the rest — L-2 in our own harness, recorded under L-26). 250 ms is
 * two to four times the healthy figure: high enough to stay quiet on a good run, low enough that a
 * resolver falling back between servers cannot hide under it.
 */
const REPORT_ABOVE_MS = Number(process.env.ONCHAIN_EVAL_DNS_REPORT_MS ?? 250);

/** The marker `eval/run.mjs` greps for. Deliberately unlike any other line the server writes. */
const MARKER = 'DNS-TIMING';

const original = dns.lookup;

/**
 * `dns.lookup` with the elapsed time reported, and otherwise untouched.
 *
 * The wrapper forwards every argument shape the original accepts — `(host, cb)`,
 * `(host, options, cb)` — and calls the original callback with exactly what it received. A wrapper
 * that normalised the arguments would change behaviour for the sake of measuring it.
 */
function timedLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const started = process.hrtime.bigint();
  const done = (err, ...rest) => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms >= REPORT_ABOVE_MS) {
      // No address, on purpose — see the header.
      process.stderr.write(
        `${MARKER} host=${String(hostname)} ms=${ms.toFixed(0)} resolved=${err ? 'no' : 'yes'}\n`,
      );
    }
    cb(err, ...rest);
  };
  return typeof options === 'function'
    ? original.call(dns, hostname, done)
    : original.call(dns, hostname, options, done);
}

// `dns.promises.lookup` is a separate implementation in some Node versions rather than a wrapper
// around the callback form, so it is left alone deliberately: double-counting a single lookup would
// be worse than missing a path nothing in this process uses. `undici` uses the callback form.
dns.lookup = timedLookup;

export { MARKER as DNS_TIMING_MARKER, REPORT_ABOVE_MS };
