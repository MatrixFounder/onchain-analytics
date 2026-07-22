import { describe, expect, it, vi } from 'vitest';
import { assertAllowedHost, safeFetch, SsrfBlockedError } from '../src/net/safe-fetch.js';

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
});
