import { describe, expect, it, vi } from 'vitest';
import {
  assertAllowedHost,
  safeFetch,
  SafeFetchResponseTooLargeError,
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
