import { describe, expect, it, vi } from 'vitest';
import {
  assertAllowedHost,
  DeadlineExceededError,
  isPassThroughTransportError,
  PASS_THROUGH_TRANSPORT_ERRORS,
  safeFetch,
  SafeFetchResponseTooLargeError,
  RedirectLimitExceededError,
  SafeFetchTimeoutError,
  SsrfBlockedError,
} from '../src/net/safe-fetch.js';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe('assertAllowedHost [Phase 2]', () => {
  it('does not throw when the hostname is in the allowlist', () => {
    expect(() => assertAllowedHost('api.coingecko.com', ['api.coingecko.com'])).not.toThrow();
  });

  it('throws SsrfBlockedError when the hostname is not in the allowlist', () => {
    expect(() => assertAllowedHost('evil.example.com', ['api.coingecko.com'])).toThrow(
      SsrfBlockedError,
    );
  });

  it('SsrfBlockedError carries the hostname but not the full URL/query', () => {
    try {
      assertAllowedHost('evil.example.com', ['api.coingecko.com']);
      expect.unreachable('assertAllowedHost should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SsrfBlockedError);
      expect((error as SsrfBlockedError).hostname).toBe('evil.example.com');
    }
  });
});

describe('safeFetch [Phase 2, no real network — fetchImpl injected]', () => {
  it('rejects with SsrfBlockedError for an off-allowlist target host BEFORE any network call', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      safeFetch('https://evil.example.com/x', {}, ['api.coingecko.com'], fetchImpl),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves with the response when the host is allowed and there is no redirect', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));

    const response = await safeFetch(
      'https://api.coingecko.com/coins',
      {},
      ['api.coingecko.com'],
      fetchImpl,
    );

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.coingecko.com/coins',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('follows a redirect chain, re-checking each hop host against the allowlist before following it', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectResponse('https://api.coingecko.com/final'))
      .mockResolvedValueOnce(jsonResponse({ done: true }));

    const response = await safeFetch(
      'https://api.coingecko.com/start',
      {},
      ['api.coingecko.com'],
      fetchImpl,
    );

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.coingecko.com/final',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('rejects with SsrfBlockedError when a redirect Location points at a host outside the allowlist — never follows it', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectResponse('https://evil.example.com/steal'));

    await expect(
      safeFetch('https://api.coingecko.com/start', {}, ['api.coingecko.com'], fetchImpl),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('resolves a relative Location against the current hop URL before re-checking its host', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectResponse('/moved'))
      .mockResolvedValueOnce(jsonResponse({ done: true }));

    const response = await safeFetch(
      'https://api.coingecko.com/start',
      {},
      ['api.coingecko.com'],
      fetchImpl,
    );

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.coingecko.com/moved',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('rejects after exceeding the max of 3 redirect hops, never following a 4th', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectResponse('https://api.coingecko.com/hop1'))
      .mockResolvedValueOnce(redirectResponse('https://api.coingecko.com/hop2'))
      .mockResolvedValueOnce(redirectResponse('https://api.coingecko.com/hop3'))
      .mockResolvedValueOnce(redirectResponse('https://api.coingecko.com/hop4'));

    await expect(
      safeFetch('https://api.coingecko.com/start', {}, ['api.coingecko.com'], fetchImpl),
    ).rejects.toThrow(/redirects/i);
    // start + 3 followed hops = 4 calls; the would-be 4th redirect is never followed.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  describe('timeout + size-cap + redirect hardening (adversarial cycle 1, fix B)', () => {
    it('rejects with a typed SafeFetchTimeoutError when fetchImpl never resolves (B1)', async () => {
      const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));

      await expect(
        safeFetch('https://api.coingecko.com/slow', {}, ['api.coingecko.com'], fetchImpl, {
          timeoutMs: 20,
        }),
      ).rejects.toBeInstanceOf(SafeFetchTimeoutError);
    });

    it('rejects with SafeFetchResponseTooLargeError when Content-Length exceeds the cap, before the body is ever read (B2)', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { 'content-length': String(20 * 1024 * 1024) },
        }),
      );

      await expect(
        safeFetch('https://api.coingecko.com/huge', {}, ['api.coingecko.com'], fetchImpl, {
          maxResponseBytes: 10 * 1024 * 1024,
        }),
      ).rejects.toBeInstanceOf(SafeFetchResponseTooLargeError);
    });

    it('does not reject a response within the size cap', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-length': '2' },
        }),
      );

      const response = await safeFetch(
        'https://api.coingecko.com/small',
        {},
        ['api.coingecko.com'],
        fetchImpl,
        { maxResponseBytes: 10 * 1024 * 1024 },
      );
      expect(response.status).toBe(200);
    });

    /**
     * TASK-007 task 007-3 (R-65, AC-2) — the cap for responses that advertise NO `Content-Length`.
     *
     * This is not a corner case: `api.llama.fi` sends no `Content-Length` on any response
     * (HTTP/2 + Cloudflare, measured 2026-07-27), so before this change the cap was inert on a host
     * the engine calls on three capabilities. Closes item (1) of the R-47 carry-over.
     */
    describe('streaming size cap when no Content-Length is advertised (R-65)', () => {
      /** A body delivered in `count` chunks of `size` bytes, with NO content-length header — the
       * shape a chunked/HTTP-2 response actually has. `pulled` counts chunks the source was asked
       * for, which is how "did we stop receiving?" is observed. */
      function chunkedResponse(
        chunkSize: number,
        count: number,
      ): { response: Response; pulled: () => number; cancelled: () => boolean } {
        let pulled = 0;
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulled >= count) {
              controller.close();
              return;
            }
            pulled += 1;
            controller.enqueue(new Uint8Array(chunkSize).fill(97));
          },
          cancel() {
            cancelled = true;
          },
        });
        return {
          response: new Response(stream, { status: 200, statusText: 'OK' }),
          pulled: () => pulled,
          cancelled: () => cancelled,
        };
      }

      it('rejects a body that exceeds the cap mid-stream', async () => {
        const { response } = chunkedResponse(1024, 40); // 40KB against a 10KB cap
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

        const capped = await safeFetch(
          'https://api.llama.fi/huge',
          {},
          ['api.llama.fi'],
          fetchImpl,
          { maxResponseBytes: 10 * 1024 },
        );

        await expect(capped.text()).rejects.toBeInstanceOf(SafeFetchResponseTooLargeError);
      });

      it('CANCELS the upstream reader on overflow instead of draining the rest', async () => {
        const { response, pulled, cancelled } = chunkedResponse(1024, 1000); // 1MB available
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

        const capped = await safeFetch(
          'https://api.llama.fi/huge',
          {},
          ['api.llama.fi'],
          fetchImpl,
          { maxResponseBytes: 4 * 1024 },
        );
        await expect(capped.text()).rejects.toBeInstanceOf(SafeFetchResponseTooLargeError);

        // The point of the cap is to STOP the transfer. Merely reporting the size after receiving
        // all 1000 chunks would spend exactly the memory and bandwidth the cap exists to refuse.
        expect(cancelled()).toBe(true);
        expect(pulled()).toBeLessThan(10);
      });

      it('passes a within-cap body through byte-for-byte', async () => {
        const payload = JSON.stringify({ chains: ['Ethereum', 'Solana'], n: 42 });
        const fetchImpl = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(payload, { status: 200 }));

        const capped = await safeFetch(
          'https://api.llama.fi/small',
          {},
          ['api.llama.fi'],
          fetchImpl,
          { maxResponseBytes: 10 * 1024 },
        );

        expect(await capped.text()).toBe(payload);
      });

      it('preserves status, statusText and headers on the wrapped response', async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
          new Response('{}', {
            status: 418,
            statusText: 'I am a teapot',
            headers: { 'content-type': 'application/json', 'x-lb-route': 'primary' },
          }),
        );

        const capped = await safeFetch(
          'https://api.llama.fi/echo',
          {},
          ['api.llama.fi'],
          fetchImpl,
          { maxResponseBytes: 10 * 1024 },
        );

        // Every existing caller reads `response.ok` / `response.status` before touching the body;
        // a wrapper that changed either would break all of them silently.
        expect(capped.status).toBe(418);
        expect(capped.statusText).toBe('I am a teapot');
        expect(capped.headers.get('content-type')).toBe('application/json');
        expect(capped.headers.get('x-lb-route')).toBe('primary');
        expect(capped.ok).toBe(false);
      });

      /**
       * Cycle 3 (security H-1 / performance H-2, found independently by both critics). The cap
       * used to be SKIPPED whenever a `Content-Length` was present and within bounds — so the
       * header, the one input a size cap exists to distrust, could switch off the only real
       * enforcement.
       */
      describe('a Content-Length can no longer disable the counter', () => {
        function streamOf(totalBytes: number, headers: Record<string, string>): Response {
          const chunk = new Uint8Array(1024).fill(97);
          let sent = 0;
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (sent >= totalBytes) {
                  controller.close();
                  return;
                }
                sent += chunk.byteLength;
                controller.enqueue(chunk);
              },
            }),
            { status: 200, headers },
          );
        }

        it.each([
          ['an unparseable Content-Length', 'abc'],
          ['a negative Content-Length', '-1'],
          ['a zero Content-Length that lies', '0'],
          ['duplicate values joined by Headers.get', '100, 100'],
        ])('still caps the body when the header is %s', async (_label, value) => {
          const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValue(streamOf(64 * 1024, { 'content-length': value }));

          const capped = await safeFetch(
            'https://api.llama.fi/liar',
            {},
            ['api.llama.fi'],
            fetchImpl,
            { maxResponseBytes: 8 * 1024 },
          );
          await expect(capped.text()).rejects.toBeInstanceOf(SafeFetchResponseTooLargeError);
        });

        it('caps a compressed body whose Content-Length counts WIRE bytes', async () => {
          // undici decodes before `response.body`, and per the Fetch spec `Content-Length` stays in
          // the header list — so on a `content-encoding` response the header is the COMPRESSED size
          // while the cap is enforced on DECODED bytes. Trusting it made a decompression bomb pass.
          const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValue(
              streamOf(64 * 1024, { 'content-length': '900', 'content-encoding': 'gzip' }),
            );

          const capped = await safeFetch(
            'https://api.llama.fi/bomb',
            {},
            ['api.llama.fi'],
            fetchImpl,
            { maxResponseBytes: 8 * 1024 },
          );
          await expect(capped.text()).rejects.toBeInstanceOf(SafeFetchResponseTooLargeError);
        });

        it('still rejects an over-cap Content-Length before the body is read at all', async () => {
          // The header keeps its value as a CHEAP EARLY REJECTION — it just no longer grants a pass.
          const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValue(
              new Response(null, { status: 200, headers: { 'content-length': String(20 * 1024) } }),
            );
          await expect(
            safeFetch('https://api.llama.fi/huge', {}, ['api.llama.fi'], fetchImpl, {
              maxResponseBytes: 8 * 1024,
            }),
          ).rejects.toBeInstanceOf(SafeFetchResponseTooLargeError);
        });

        it('passes a within-cap body through unchanged even with a valid Content-Length', async () => {
          const payload = JSON.stringify({ ok: true });
          const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(payload, {
              status: 200,
              headers: { 'content-length': String(payload.length) },
            }),
          );
          const capped = await safeFetch(
            'https://api.llama.fi/small',
            {},
            ['api.llama.fi'],
            fetchImpl,
            { maxResponseBytes: 8 * 1024 },
          );
          expect(await capped.text()).toBe(payload);
        });
      });

      it('reports overflow as the typed error even when cancelling the upstream fails', async () => {
        // Cycle 3, security L-2: the old order awaited `reader.cancel()` BEFORE constructing the
        // error, so a rejecting cancel replaced SafeFetchResponseTooLargeError with something no
        // caller's `instanceof` handles.
        const chunk = new Uint8Array(4096).fill(97);
        const hostile = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(chunk);
          },
          cancel() {
            return Promise.reject(new Error('cancel exploded'));
          },
        });
        const fetchImpl = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(hostile, { status: 200 }));

        const capped = await safeFetch(
          'https://api.llama.fi/hostile',
          {},
          ['api.llama.fi'],
          fetchImpl,
          { maxResponseBytes: 1024 },
        );
        await expect(capped.text()).rejects.toBeInstanceOf(SafeFetchResponseTooLargeError);
      });

      it('leaves a null body alone (204 and friends)', async () => {
        const fetchImpl = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(null, { status: 204 }));

        const capped = await safeFetch(
          'https://api.llama.fi/empty',
          {},
          ['api.llama.fi'],
          fetchImpl,
          { maxResponseBytes: 10 * 1024 },
        );
        expect(capped.status).toBe(204);
        expect(await capped.text()).toBe('');
      });
    });

    it('rejects a redirect Location that resolves to a non-https target (B3)', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(redirectResponse('http://api.coingecko.com/insecure'));

      await expect(
        safeFetch('https://api.coingecko.com/start', {}, ['api.coingecko.com'], fetchImpl),
      ).rejects.toThrow(/https/i);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('rejects a non-https INITIAL url before any network attempt (adversarial cycle 2, fix 4 — mirrors the redirect-hop check)', async () => {
      const fetchImpl = vi.fn<typeof fetch>();

      await expect(
        safeFetch('http://api.coingecko.com/start', {}, ['api.coingecko.com'], fetchImpl),
      ).rejects.toThrow(/https/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('drops Authorization/x-api-key-style headers when a redirect hop changes hostname, but keeps them on a same-host redirect (B3)', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(redirectResponse('https://api.coingecko.com/same-host'))
        .mockResolvedValueOnce(redirectResponse('https://other.example.com/final'))
        .mockResolvedValueOnce(jsonResponse({ done: true }));

      const response = await safeFetch(
        'https://api.coingecko.com/start',
        {
          headers: {
            Authorization: 'Bearer secret',
            'x-cg-demo-api-key': 'demo-key',
            'content-type': 'application/json',
          },
        },
        ['api.coingecko.com', 'other.example.com'],
        fetchImpl,
      );

      expect(response.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(3);

      // Same-host redirect (hop 2) — original headers untouched.
      const sameHostHeaders = new Headers(fetchImpl.mock.calls[1]![1]?.headers);
      expect(sameHostHeaders.get('authorization')).toBe('Bearer secret');
      expect(sameHostHeaders.get('x-cg-demo-api-key')).toBe('demo-key');

      // Cross-host redirect (hop 3) — sensitive headers stripped, others kept.
      const crossHostHeaders = new Headers(fetchImpl.mock.calls[2]![1]?.headers);
      expect(crossHostHeaders.has('authorization')).toBe(false);
      expect(crossHostHeaders.has('x-cg-demo-api-key')).toBe(false);
      expect(crossHostHeaders.get('content-type')).toBe('application/json');
    });
  });
});

/**
 * Task 012-7 — the ABSOLUTE call deadline on the transport path (ADR-002 D4, R-142/R-143).
 *
 * **Why there are no injectable clocks here, stated once.** `SafeFetchOptions` is
 * `{timeoutMs?, maxResponseBytes?, deadlineAtMs?}` — `safeFetch` has no dependency seam, and task
 * 012-7 decides it does not get one (that would be a FOURTH seam where PLAN §0.3 names three, and
 * OD-6 already decided their extent by name). The mechanism is instead the one this file already
 * uses at line 138: a fake `fetchImpl` plus a TINY REAL timeout. Real, because `AbortSignal.timeout`
 * runs on Node's own timers, which vitest's fake timers do not move — and mocking `AbortSignal`
 * would leave the test with no input on which it can fail. Every wait below is 20-60 ms.
 *
 * **The margins are the determinism.** Each case that races two real timers keeps them at least
 * 2.5x apart (20 vs 200, 25 vs 50), so the verdict cannot flip on a loaded machine; the one case
 * that must land BETWEEN two hops blocks the event loop instead of sleeping on it, so no timer can
 * fire while it is in flight.
 */
describe('call deadline — two distinguishable signals per hop (task 012-7)', () => {
  const HOST = 'api.coingecko.com';
  const ALLOW = [HOST];

  /** Burns `ms` of wall clock WITHOUT yielding to the event loop.
   *
   * Deliberate, and the alternative was measured against the property the test asserts: with an
   * `await setTimeout` delay, whether hop 3's entry pre-check or hop 2's in-flight `deadlineSignal`
   * notices the expiry first is a scheduler race, and "exactly 2 calls" would then be a coin flip on
   * a busy machine. Blocking makes the hop's own duration the only variable — no timer, deadline
   * signal included, can fire while it is running, and the loop's next pre-check runs in a
   * microtask, i.e. still before any pending timer. */
  function blockFor(ms: number): void {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* spin — see the docstring: yielding here would reintroduce the race */
    }
  }

  /** TC-UNIT-01 (R-142d) — the hop-by-hop remainder.
   * EXPECTED_FAIL_REASON (phase 1, `deadlineAtMs` declared and ignored): all three hops run and the
   * call RESOLVES with 200, so `rejects` reports "promise resolved instead of rejecting". */
  it('TC-UNIT-01: a deadline that expires between hops stops the chain — hop 3 never starts', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => {
        blockFor(5); // ends at ~5ms of the 40ms budget — hop 2 is entered with time to spare
        return Promise.resolve(redirectResponse(`https://${HOST}/hop2`));
      })
      .mockImplementationOnce(() => {
        blockFor(60); // ends at ~65ms — the budget is spent, but only AFTER hop 2 answered
        return Promise.resolve(redirectResponse(`https://${HOST}/hop3`));
      })
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ done: true })));

    await expect(
      safeFetch(`https://${HOST}/hop1`, {}, ALLOW, fetchImpl, {
        timeoutMs: 5_000, // far away: this case is about the DEADLINE, not the hop timeout
        deadlineAtMs: Date.now() + 40,
      }),
    ).rejects.toBeInstanceOf(DeadlineExceededError);

    // The type alone would not distinguish "refused hop 3" from "aborted hop 3 mid-flight".
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  /** TC-UNIT-02 (R-142c) — a deadline already spent on entry.
   * EXPECTED_FAIL_REASON (phase 1): the deadline is ignored, the single hop answers 200 and the
   * call RESOLVES — "promise resolved instead of rejecting". */
  it('TC-UNIT-02: a deadline already in the past is refused with no network call at all', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));

    await expect(
      safeFetch(`https://${HOST}/coins`, {}, ALLOW, fetchImpl, {
        deadlineAtMs: Date.now() - 1,
      }),
    ).rejects.toBeInstanceOf(DeadlineExceededError);

    // The pre-check is not made redundant by the signal race: a signal can only abort a call that
    // has already been issued, and issuing it is the thing a spent deadline must prevent.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /** TC-UNIT-03 (C-1) — expiry MID-FLIGHT, the case the two signals exist for.
   * EXPECTED_FAIL_REASON (phase 1): only the hop signal exists, so after 200ms the call rejects with
   * `SafeFetchTimeoutError` — "expected SafeFetchTimeoutError to be an instance of
   * DeadlineExceededError". */
  it('TC-UNIT-03: a deadline expiring mid-flight reports the deadline, never the hop timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));

    const error = await safeFetch(`https://${HOST}/slow`, {}, ALLOW, fetchImpl, {
      timeoutMs: 200,
      deadlineAtMs: Date.now() + 20,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeadlineExceededError);
    // Stated as its own assertion because this is the confusion C-1 is about: "we ran out of our
    // own budget" must never be reported as "the vendor did not answer".
    expect(error).not.toBeInstanceOf(SafeFetchTimeoutError);
  });

  /** TC-UNIT-04 (R-143d) — the caller's signal stops being overwritten.
   * EXPECTED_FAIL_REASON (phase 1): `{...opts, signal}` still overwrites the caller's signal, so the
   * abort is ignored and after 200ms the hop signal rejects — "expected SafeFetchTimeoutError to be
   * [Error: caller changed its mind]". */
  it("TC-UNIT-04: the caller's own abort reason travels out unwrapped", async () => {
    const controller = new AbortController();
    const reason = new Error('caller changed its mind');
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));

    const pending = safeFetch(
      `https://${HOST}/slow`,
      { signal: controller.signal },
      ALLOW,
      fetchImpl,
      {
        timeoutMs: 200,
      },
    );
    controller.abort(reason);

    // `toBe`, not `toBeInstanceOf`: wrapping the caller's reason in one of our classes would tell
    // the caller its own cancellation was a transport failure.
    await expect(pending).rejects.toBe(reason);
  });

  /** TC-UNIT-05 (R-143c) — the no-deadline path is byte-for-byte what it was.
   *
   * GREEN AT PHASE 1 BY CONSTRUCTION, and that is the contract: it pins behaviour that must SURVIVE
   * the change, so there is no state of the tree in which it is red and the task unfinished. Its
   * power is shown by mutation instead (clamp `effectiveHopMs` to the remainder → this case still
   * passes, since there is no remainder to clamp to; drop the per-hop timeout entirely → it dies).
   * The other half of R-143c is the 30 cases above it, which this task did not edit. */
  it('TC-UNIT-05: without a deadline every hop still gets the FULL timeout, reported as such', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => Promise.resolve(redirectResponse(`https://${HOST}/hop2`)))
      .mockImplementationOnce(() => new Promise<Response>(() => {}));

    const error = await safeFetch(`https://${HOST}/hop1`, {}, ALLOW, fetchImpl, {
      timeoutMs: 20,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SafeFetchTimeoutError);
    // The SECOND hop's error names the full 20ms, not a remainder of anything — today's behaviour.
    expect((error as SafeFetchTimeoutError).timeoutMs).toBe(20);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  describe('TC-UNIT-06: with BOTH a deadline and a caller signal, each source reports its own type', () => {
    /** EXPECTED_FAIL_REASON (phase 1): the deadline is ignored and the caller never aborts, so after
     * 200ms the hop signal rejects — "expected SafeFetchTimeoutError to be an instance of
     * DeadlineExceededError". */
    it('the deadline expiring first gives DeadlineExceededError', async () => {
      const controller = new AbortController(); // never aborted
      const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));

      await expect(
        safeFetch(`https://${HOST}/slow`, { signal: controller.signal }, ALLOW, fetchImpl, {
          timeoutMs: 200,
          deadlineAtMs: Date.now() + 20,
        }),
      ).rejects.toBeInstanceOf(DeadlineExceededError);
    });

    /** EXPECTED_FAIL_REASON (phase 1): the caller's signal is overwritten, so its abort is ignored
     * and after 200ms the hop signal rejects — "expected SafeFetchTimeoutError to be [Error: caller
     * gave up first]". */
    it('the caller aborting first gives the caller its own reason back', async () => {
      const controller = new AbortController();
      const reason = new Error('caller gave up first');
      const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));

      const pending = safeFetch(
        `https://${HOST}/slow`,
        { signal: controller.signal },
        ALLOW,
        fetchImpl,
        { timeoutMs: 200, deadlineAtMs: Date.now() + 5_000 },
      );
      controller.abort(reason);

      await expect(pending).rejects.toBe(reason);
    });
  });

  /**
   * TC-UNIT-06a — the ASYMMETRIC pin of `effectiveHopMs = timeoutMs` (UNCLAMPED).
   *
   * | Implementation             | `effectiveHopMs` | Fires first          | Verdict                 |
   * | -------------------------- | ---------------- | -------------------- | ----------------------- |
   * | unclamped (this repo)      | 50ms             | `deadlineSignal` (25)| `DeadlineExceededError` |
   * | clamped `min(50, 25)`      | 25ms             | tie → `hopSignal`    | `SafeFetchTimeoutError` |
   *
   * The originally requested EXACT TIE (`remainingMs === timeoutMs`) is deliberately NOT used:
   * `min(t, t) = t`, so both implementations build two identical timers and both answer
   * `SafeFetchTimeoutError` — such a case cannot tell the two apart, and the cheapest ways to make
   * it green are the two things the decision forbids (clamping the hop, or replacing the
   * discriminator with a `Date.now() >= deadlineAtMs` read).
   *
   * EXPECTED_FAIL_REASON (phase 1): no deadline signal exists, so the 50ms hop timer rejects —
   * "expected SafeFetchTimeoutError to be an instance of DeadlineExceededError".
   */
  it('TC-UNIT-06a: with the deadline 25ms out and the hop timeout 50ms, the DEADLINE wins', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));

    await expect(
      safeFetch(`https://${HOST}/slow`, {}, ALLOW, fetchImpl, {
        timeoutMs: 50,
        deadlineAtMs: Date.now() + 25,
      }),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  /**
   * TC-UNIT-07 — the SSRF gate is untouched, including under a deadline.
   *
   * GREEN AT PHASE 1 BY CONSTRUCTION, same class as TC-UNIT-05: a regression case cannot be red
   * before the change it guards. Proven by mutation instead — hoisting `assertAllowedHost` out of
   * the hop loop kills the first case below.
   */
  describe('TC-UNIT-07: the allowlist is still checked on every hop when a deadline is present', () => {
    it('refuses an off-allowlist redirect target and never follows it', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(redirectResponse('https://evil.example.com/steal'));

      await expect(
        safeFetch(`https://${HOST}/start`, {}, ALLOW, fetchImpl, {
          deadlineAtMs: Date.now() + 5_000,
        }),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('refuses a non-https redirect target', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(redirectResponse(`http://${HOST}/insecure`));

      await expect(
        safeFetch(`https://${HOST}/start`, {}, ALLOW, fetchImpl, {
          deadlineAtMs: Date.now() + 5_000,
        }),
      ).rejects.toThrow(/https/i);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  /** M-14 for the NEW class. `blockscout` authenticates with `?apikey=<key>`, so a deadline error
   * built from a hop URL is on the same path the redaction of `SafeFetchTimeoutError` /
   * `SafeFetchResponseTooLargeError` exists for (D10: secrets never in logs or error messages).
   * EXPECTED_FAIL_REASON (phase 1): the deadline is ignored and the call RESOLVES — "promise
   * resolved instead of rejecting". */
  it('DeadlineExceededError redacts a query-string secret, exactly like its two siblings (M-14)', async () => {
    const secret = 'proapi_secretvalue0123456789';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));

    const error = await safeFetch(
      `https://mcp.blockscout.com/v1/get_address_info?address=0x1&apikey=${secret}`,
      { method: 'GET' },
      ['mcp.blockscout.com'],
      fetchImpl,
      { deadlineAtMs: Date.now() - 1 },
    )
      // `.then(() => undefined)` first, exactly like the M-14 block below: without it the awaited
      // value is `DeadlineExceededError | Response` and no property of either can be read.
      .then(() => undefined)
      .catch((caught: unknown) => caught as DeadlineExceededError);

    expect(error).toBeInstanceOf(DeadlineExceededError);
    expect(error!.message).not.toContain(secret);
    expect(error!.message).not.toContain('apikey');
    expect(error!.at, 'the property is printed by inspectors too').not.toContain(secret);
    expect(error!.message).toContain('mcp.blockscout.com/v1/get_address_info');
  });
});

/**
 * Adversarial cycle 2, finding F-1 — a caller signal that is ALREADY aborted when `safeFetch` is
 * called must not leave the in-flight `fetchImpl` promise without a rejection handler.
 *
 * The hole and why the existing 30+ cases could not see it: every abort case above this one aborts
 * AFTER the call started, which reaches `raceWithTimeout`'s listener path — where the `.then(…)`
 * handlers are attached before anything can reject. The pre-aborted entry took the early-return
 * branch instead, which used to reject and return BEFORE attaching them, while `fetchImpl` had
 * already been invoked in the argument position (`safeFetch`'s call site builds the promise there).
 * A real `fetch` handed an aborted signal rejects with `AbortError` immediately, so that promise
 * rejected with nobody listening.
 *
 * Why that is fatal rather than untidy: on Node's default `--unhandled-rejections=throw` an
 * unhandled rejection terminates the process, and this package's consumer is a LONG-LIVED stdio MCP
 * server (`mcp-server/src/index.ts`) that installs no `process.on('unhandledRejection')` — its
 * `main().catch(...)` cannot see a rejection that belongs to no awaited chain. Same class as the
 * `capResponseStream` `cancel()` note (cycle 3, security L-1), one function up.
 */
describe('cycle 2 F-1 — a signal aborted BEFORE the call leaves no unhandled rejection', () => {
  const HOST = 'api.coingecko.com';
  const ALLOW = [HOST];

  /**
   * Behaves like the REAL `fetch`, which is the whole input of this case: handed a signal that is
   * already aborted, it rejects with an `AbortError` instead of returning a pending promise. A
   * `fetchImpl` that ignores its `signal` (what every other case here injects) never rejects, and a
   * promise that never settles cannot be unhandled.
   *
   * **A plain function, NOT `vi.fn` — measured, not stylistic.** Vitest 4's mock records each
   * returned promise's settled result, and doing so ATTACHES a handler to it: written with
   * `vi.fn<typeof fetch>(...)` this very case passed against the unfixed `raceWithTimeout`, because
   * the mock had already handled the rejection the assertion was looking for. A test double that
   * quietly fixes the defect under test is worse than no test.
   */
  function abortAwareFetch(): { fetchImpl: typeof fetch; calls: () => number } {
    let calls = 0;
    const fetchImpl: typeof fetch = (_url, init) => {
      calls += 1;
      const signal = (init as RequestInit | undefined)?.signal ?? undefined;
      if (signal?.aborted === true) {
        return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    };
    return { fetchImpl, calls: () => calls };
  }

  it('rejects with the caller’s own reason and the fetch rejection is handled', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled before the call');
    controller.abort(reason);
    const { fetchImpl, calls } = abortAwareFetch();

    const leaked: unknown[] = [];
    const record = (rejection: unknown): void => {
      leaked.push(rejection);
    };
    process.on('unhandledRejection', record);
    try {
      await expect(
        safeFetch(`https://${HOST}/x`, { signal: controller.signal }, ALLOW, fetchImpl),
      ).rejects.toBe(reason);
      // Node reports an unhandled rejection on the tick AFTER the microtask queue drains, so the
      // verdict cannot be read synchronously — this wait is the measurement, not padding.
      await new Promise((settle) => setTimeout(settle, 50));
    } finally {
      process.off('unhandledRejection', record);
    }

    // Sign of work: the fixture really did produce a rejecting promise for us to have handled.
    expect(calls()).toBe(1);
    expect(
      leaked.map((rejection) => (rejection instanceof Error ? rejection.name : String(rejection))),
      'the fetch promise rejected with nobody listening — on Node’s default this kills the process',
    ).toStrictEqual([]);
  });
});

describe('M-14 — a secret in the query string never reaches an error message or `.url`', () => {
  // vdd-multi TASK-008. `blockscout` authenticates with `?apikey=<key>` because that is the
  // vendor's choice, and `safeFetch` used to interpolate the FULL url into three of its own errors
  // AND store it on a public `url` property that `util.inspect`, a structured logger or a bare
  // `console.error(err)` all print. The adapter wraps and re-messages, which closed the `.message`
  // channel at one call site — the cause chain it attaches was never closed, and the next adapter
  // to put a credential in a query string would have started from zero.
  //
  // Redaction lives in `safeFetch` so the class is closed for every caller. `pathname` is kept:
  // it is built from our own routing, never from a secret, and it is what makes the error readable.
  const SECRET = 'proapi_secretvalue0123456789';
  const URL_WITH_SECRET = `https://mcp.blockscout.com/v1/get_address_info?address=0x1&apikey=${SECRET}`;

  it('redacts it out of SafeFetchTimeoutError', async () => {
    const error = await safeFetch(
      URL_WITH_SECRET,
      { method: 'GET' },
      ['mcp.blockscout.com'],
      () => new Promise(() => undefined),
      { timeoutMs: 5 },
    )
      .then(() => undefined)
      .catch((caught: unknown) => caught as SafeFetchTimeoutError);

    expect(error).toBeInstanceOf(SafeFetchTimeoutError);
    expect(error!.message).not.toContain(SECRET);
    expect(error!.message).not.toContain('apikey');
    expect(error!.url, 'the property is printed by inspectors too').not.toContain(SECRET);
    // Still diagnosable: host and path survive.
    expect(error!.message).toContain('mcp.blockscout.com/v1/get_address_info');
  });

  it('redacts it out of SafeFetchResponseTooLargeError', async () => {
    const error = await safeFetch(
      URL_WITH_SECRET,
      { method: 'GET' },
      ['mcp.blockscout.com'],
      () =>
        Promise.resolve(
          new Response('{}', { status: 200, headers: { 'content-length': '99999999' } }),
        ),
      { maxResponseBytes: 1024 },
    )
      .then(() => undefined)
      .catch((caught: unknown) => caught as SafeFetchResponseTooLargeError);

    expect(error).toBeInstanceOf(SafeFetchResponseTooLargeError);
    expect(error!.message).not.toContain(SECRET);
    expect(error!.url).not.toContain(SECRET);
    expect(error!.message).toContain('mcp.blockscout.com/v1/get_address_info');
  });
});

// =============================================================================================
// WI-36 — the pass-through list, and the property that makes it safe
// =============================================================================================

/**
 * `PASS_THROUGH_TRANSPORT_ERRORS` is the answer to "which transport errors may an adapter rethrow
 * unwrapped", declared once beside the classes instead of re-decided in each adapter's `catch`.
 *
 * The list is only as good as the property it rests on: **every member redacts its own context at
 * construction**. So the gate is two-sided —
 *
 * 1. each member, constructed with a URL carrying `?apikey=<secret>`, must produce a `.message` with
 *    neither the secret nor a query string in it (the ONE thing an adapter's wrapper was buying);
 * 2. every Error class this module exports must be either ON the list or knowingly off it — so the
 *    next class added has to make the decision rather than inherit one.
 *
 * (2) is the half that keeps this from decaying. WI-36 rejected the "prove the classes are safe by
 * reading them" option precisely because such a list drifts on the next class; a check that
 * enumerates the module's exports cannot drift silently.
 */
describe('WI-36 — every pass-through transport error redacts its own context', () => {
  const SECRET = 'proapi_secretvalue0123456789';
  const URL_WITH_SECRET = `https://mcp.blockscout.com/v1/get_address_info?address=0x1&apikey=${SECRET}`;

  /** One constructed instance per listed class, each handed the credential-bearing URL. */
  const INSTANCES: Array<[name: string, error: Error]> = [
    // `SsrfBlockedError` never receives a URL at all — a hostname is all `assertAllowedHost` has,
    // which is why it is on the list for a different reason than the other three. Handed the URL's
    // HOST here, i.e. the most it could ever be given.
    ['SsrfBlockedError', new SsrfBlockedError('mcp.blockscout.com')],
    ['SafeFetchTimeoutError', new SafeFetchTimeoutError(URL_WITH_SECRET, 5_000)],
    ['DeadlineExceededError', new DeadlineExceededError(URL_WITH_SECRET, 1_700_000_000_000)],
    [
      'SafeFetchResponseTooLargeError',
      new SafeFetchResponseTooLargeError(URL_WITH_SECRET, 99_999_999, 1024),
    ],
    // Task 014-21 joined the list. Handed the RAW credential-bearing URL on purpose: the class
    // redacts at construction, so a future call site that forgets `redactUrl` cannot leak through it.
    ['RedirectLimitExceededError', new RedirectLimitExceededError(3, URL_WITH_SECRET)],
  ];

  it('the list is the one the module exports, and it is not empty', () => {
    expect(PASS_THROUGH_TRANSPORT_ERRORS.length).toBeGreaterThan(0);
    expect(INSTANCES.map(([name]) => name).sort()).toStrictEqual(
      PASS_THROUGH_TRANSPORT_ERRORS.map((constructor) => constructor.name).sort(),
    );
  });

  it.each(INSTANCES)('%s carries no secret and no query string', (_name, error) => {
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain('apikey');
    expect(error.message).not.toContain('?');
    // Rendering the whole object is what a logger or a bare `console.error(err)` does — the channel
    // M-14 closed, re-checked here for every class the list now invites adapters to pass through.
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(SECRET);
  });

  it('`isPassThroughTransportError` recognises every member and nothing else', () => {
    for (const [name, error] of INSTANCES) {
      expect(isPassThroughTransportError(error), name).toBe(true);
    }
    // The negative side, which is what keeps an adapter's wrapper doing its job: an untyped throw —
    // including the three plain `Error`s `safeFetch` itself raises — must still be wrapped.
    expect(isPassThroughTransportError(new Error('safeFetch: exceeded 3 redirects'))).toBe(false);
    expect(isPassThroughTransportError(new TypeError('fetch failed'))).toBe(false);
    expect(isPassThroughTransportError('a string')).toBe(false);
    expect(isPassThroughTransportError(undefined)).toBe(false);
  });

  it('every Error class this module exports has been DECIDED about, not defaulted', async () => {
    // The anti-drift half. A new error class added to `safe-fetch.ts` lands here on the day it is
    // written: it is either on the pass-through list (and then the redaction cases above cover it,
    // because the first case in this block requires the two sets to match) or named below as
    // deliberately wrapped.
    const module: Record<string, unknown> = await import('../src/net/safe-fetch.js');
    const exportedErrorClasses = Object.entries(module)
      .filter(
        ([, value]) =>
          typeof value === 'function' &&
          (value === Error || Object.prototype.isPrototypeOf.call(Error, value)),
      )
      .map(([name]) => name)
      .sort();

    const listed = PASS_THROUGH_TRANSPORT_ERRORS.map((constructor) => constructor.name);
    /** Exported error classes deliberately NOT on the list — the moment it stops being empty,
     * somebody wrote a reason here. */
    const DELIBERATELY_WRAPPED: string[] = [
      // Task 014-21. `AllowlistEntryInvalidError` is a CONFIGURATION error, not a transport one: it
      // says an entry in `AdapterRegistration.hosts` is not a bare `host[:port]`, which is a defect
      // in our own repository and identical for every call the adapter will ever make. Passing it
      // through would hand a caller a permanent failure dressed as a per-request one; wrapped, it
      // reaches an operator as that adapter failing, which is what it is.
      'AllowlistEntryInvalidError',
    ];

    expect(exportedErrorClasses.length).toBeGreaterThan(0);
    expect(
      exportedErrorClasses.filter(
        (name) => !listed.includes(name) && !DELIBERATELY_WRAPPED.includes(name),
      ),
      'A new transport error class must state whether an adapter may rethrow it unwrapped. ' +
        'Silence defaults it to "wrapped", which is how WI-36 lost a class into `.cause` for four ' +
        'tasks — so silence is what this fails on.',
    ).toStrictEqual([]);
  });
});
