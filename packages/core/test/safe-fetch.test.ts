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
