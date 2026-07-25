import { describe, expect, it, vi } from 'vitest';
import { deriveArgsHash } from '../src/net/args-hash.js';
import { safeFetch } from '../src/net/safe-fetch.js';
import { createThrottle } from '../src/net/rate-limit.js';
import { createNansenAdapter, normalizeAddress } from '../src/index.js';

// R-45 secret discipline for NANSEN_API_KEY: the key never enters `args_hash` (TC-SEC-13), is
// stripped by the EXISTING `SENSITIVE_HEADER_RE` on a cross-host redirect without any regex edit
// (TC-SEC-14), and never appears in console output or thrown error messages across a full fetch()
// cycle including its 429/402/generic-error paths (TC-SEC-15). No live network anywhere in this
// file — every call uses an injected `fetchImpl`.

const FIXED_NOW = 1_700_000_000_000;
const UNI_ADDRESS = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';
const LIVE_LOOKING_KEY = 'nansen-secret-key-should-never-leak-9f8e7d6c';

describe('nansen secret discipline (R-45)', () => {
  it('TC-SEC-13: deriveArgsHash(cap, args) is identical for two DIFFERENT NANSEN_API_KEY values, same args', () => {
    const capability = 'smart-money.flows';
    const args = { chain: 'ethereum', tokenAddress: normalizeAddress('ethereum', UNI_ADDRESS) };

    const originalKey = process.env['NANSEN_API_KEY'];
    try {
      process.env['NANSEN_API_KEY'] = 'first-key-AAAAAAAAAA';
      const hashA = deriveArgsHash(capability, args);

      process.env['NANSEN_API_KEY'] = 'second-completely-different-key-BBBBBBBBBB';
      const hashB = deriveArgsHash(capability, args);

      expect(hashA).toBe(hashB);
    } finally {
      if (originalKey === undefined) {
        delete process.env['NANSEN_API_KEY'];
      } else {
        process.env['NANSEN_API_KEY'] = originalKey;
      }
    }
  });

  it('TC-SEC-14: cross-host redirect strips apiKey via the EXISTING SENSITIVE_HEADER_RE (no regex edit needed)', async () => {
    // A synthetic 2-host allowlist purely for this regression test — the real nansen registration
    // has exactly ONE host (`api.nansen.ai`), so a genuine "redirect to another IN-allowlist host"
    // scenario can't occur through the real adapter; this proves the shared `safeFetch` mechanism
    // this adapter's own `endpoints.ts` calls through already covers the literal `apiKey` header
    // name case-insensitively (net/safe-fetch.ts's own `SENSITIVE_HEADER_RE`,
    // `/authorization|api-?key/i`), same as documented in this directory's own `.AGENTS.md`.
    const allowlist = ['api.nansen.ai', 'mirror.nansen.ai'];
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({ url: String(url), headers });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://mirror.nansen.ai/api/v1/account' },
        });
      }
      return new Response(JSON.stringify({ plan: 'free', credits_remaining: 100 }), {
        status: 200,
      });
    };

    await safeFetch(
      'https://api.nansen.ai/api/v1/account',
      { headers: { apiKey: LIVE_LOOKING_KEY } },
      allowlist,
      fetchImpl,
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers['apikey']).toBe(LIVE_LOOKING_KEY);
    // Cross-host hop (api.nansen.ai -> mirror.nansen.ai) — apiKey stripped, never forwarded.
    expect(calls[1]!.headers).not.toHaveProperty('apikey');
  });

  it('TC-SEC-15: the key value never appears in console.log/console.error output or thrown error messages, across success/429/402/generic-error paths', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const throttle = createThrottle();
      const netflowFixtureBody = {
        data: [
          {
            token_address: UNI_ADDRESS,
            token_symbol: 'UNI',
            net_flow_1h_usd: 1,
            net_flow_24h_usd: 1,
            net_flow_7d_usd: 1,
            net_flow_30d_usd: 1,
            chain: 'ethereum',
            token_sectors: [],
            trader_count: 1,
            token_age_days: 1,
          },
        ],
        pagination: { page: 1, per_page: 10, is_last_page: true },
      };
      const collectedErrors: string[] = [];

      // 1) success path (both sub-calls 200)
      const successAdapter = createNansenAdapter({
        env: { NANSEN_API_KEY: LIVE_LOOKING_KEY },
        now: () => FIXED_NOW,
        throttle,
        fetchImpl: async () => new Response(JSON.stringify(netflowFixtureBody), { status: 200 }),
        __ungatedForTestsOnly: true, // M-6 (adversarial review cycle 1) — explicit opt-in required
      });
      await successAdapter.fetch('smart-money.flows', {
        chain: 'ethereum',
        tokenAddress: UNI_ADDRESS,
      });

      // 2) 429 path
      const rateLimitedAdapter = createNansenAdapter({
        env: { NANSEN_API_KEY: LIVE_LOOKING_KEY },
        now: () => FIXED_NOW,
        throttle,
        fetchImpl: async () =>
          new Response(null, { status: 429, headers: { 'retry-after': '30' } }),
        __ungatedForTestsOnly: true, // M-6 (adversarial review cycle 1) — explicit opt-in required
      });
      try {
        await rateLimitedAdapter.fetch('smart-money.flows', {
          chain: 'ethereum',
          tokenAddress: UNI_ADDRESS,
        });
      } catch (error) {
        collectedErrors.push(error instanceof Error ? error.message : String(error));
      }

      // 3) 402 path
      const paymentRequiredAdapter = createNansenAdapter({
        env: { NANSEN_API_KEY: LIVE_LOOKING_KEY },
        now: () => FIXED_NOW,
        throttle,
        fetchImpl: async () => new Response(null, { status: 402 }),
        __ungatedForTestsOnly: true, // M-6 (adversarial review cycle 1) — explicit opt-in required
      });
      try {
        await paymentRequiredAdapter.fetch('smart-money.flows', {
          chain: 'ethereum',
          tokenAddress: UNI_ADDRESS,
        });
      } catch (error) {
        collectedErrors.push(error instanceof Error ? error.message : String(error));
      }

      // 4) generic HTTP-error path (the response body here is deliberately UNRELATED to the key —
      // this test asserts on OUR OWN code never embedding the key anywhere it constructs, not on
      // defending against a vendor response that pathologically echoes back request headers).
      const genericErrorAdapter = createNansenAdapter({
        env: { NANSEN_API_KEY: LIVE_LOOKING_KEY },
        now: () => FIXED_NOW,
        throttle,
        fetchImpl: async () =>
          new Response('internal server error, please retry later', { status: 500 }),
        __ungatedForTestsOnly: true, // M-6 (adversarial review cycle 1) — explicit opt-in required
      });
      try {
        await genericErrorAdapter.fetch('smart-money.flows', {
          chain: 'ethereum',
          tokenAddress: UNI_ADDRESS,
        });
      } catch (error) {
        collectedErrors.push(error instanceof Error ? error.message : String(error));
      }

      expect(collectedErrors.length).toBeGreaterThan(0);
      for (const message of collectedErrors) {
        expect(message).not.toContain(LIVE_LOOKING_KEY);
      }

      const allConsoleArgs = [...logSpy.mock.calls, ...errorSpy.mock.calls]
        .flat()
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)));
      for (const arg of allConsoleArgs) {
        expect(arg).not.toContain(LIVE_LOOKING_KEY);
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
  // --- adversarial review cycle 1 (security F-2) ---
  it('TC-SEC-16: redacts the apiKey out of a vendor error body before it reaches the model', async () => {
    // The tool layer forwards `error.message` verbatim as `isError` text -> model context ->
    // transcripts. Echoing request headers in a 4xx debug body is common gateway/WAF behavior, and
    // the tests above deliberately only cover OUR code never embedding the key. This covers the
    // vendor echoing it back: the adapter is the only layer holding the key, so it must redact.
    const KEY = 'nsn_super_secret_key_value_do_not_leak';
    const echoingFetch = vi.fn(
      async () =>
        new Response(`{"error":"bad request","received_headers":{"apiKey":"${KEY}"}}`, {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const adapter = createNansenAdapter({
      env: { NANSEN_API_KEY: KEY },
      fetchImpl: echoingFetch as unknown as typeof fetch,
      throttle: async () => {},
      __ungatedForTestsOnly: true,
    });

    const err = await adapter
      .fetch('token.risk', { chain: 'ethereum', tokenAddress: UNI_ADDRESS })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).not.toContain(KEY);
    expect(message).toContain('***');
  });
  it('TC-SEC-17 (cycle-2 R-2): redacts BEFORE truncating, so a boundary-straddling key cannot leak a prefix', async () => {
    // stringifyTruncated slices to 500 chars. Redacting AFTER truncation left an unredacted key
    // PREFIX whenever the echoed key straddled the boundary — and whoever influences the body's
    // length picks where that boundary falls, so two differently-padded responses leak two
    // fragments that concatenate to the whole key.
    const KEY = 'nsn_boundary_straddling_secret_key_abcdefghijklmnop';
    const padding = 'P'.repeat(480); // pushes the key across the 500-char truncation point
    const echoingFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ pad: padding, echoed: KEY }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const adapter = createNansenAdapter({
      env: { NANSEN_API_KEY: KEY },
      fetchImpl: echoingFetch as unknown as typeof fetch,
      throttle: async () => {},
      __ungatedForTestsOnly: true,
    });

    const err = (await adapter
      .fetch('token.risk', { chain: 'ethereum', tokenAddress: UNI_ADDRESS })
      .then(() => null)
      .catch((e: unknown) => e)) as Error;

    expect(err).toBeInstanceOf(Error);
    // No fragment of the key of meaningful length may survive.
    for (let len = 12; len <= KEY.length; len += 6) {
      expect(err.message).not.toContain(KEY.slice(0, len));
    }
  });
});
