import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AllowlistEntryInvalidError,
  RedirectLimitExceededError,
  SsrfBlockedError,
  allowlistAuthority,
  assertAllowedHost,
  isPassThroughTransportError,
  normalizeAllowlistEntry,
  safeFetch,
} from '../src/net/safe-fetch.js';
import { assertValidAdapterRegistrations } from '../src/adapters/types.js';
import { adapterRegistrations } from '../src/providers.config.js';

/**
 * Task 014-21 — the SSRF gate under untrusted input (R-10, AC-9, AC-10, AC-22).
 *
 * **What changed and what merely became measured.** Before T-014 the arguments reaching this engine
 * came from the repository owner through Claude Code; with a network transport the allowlist
 * comparison is a security boundary. Measuring it first showed that the WHATWG parser already does
 * most of the normalisation AC-9 names — so the cases below are written to fail against a WRONG
 * comparison rather than merely to pass against the current one, and each says which half is the
 * parser's work and which is ours.
 */

const LLAMA = 'api.llama.fi';

describe('TC-UNIT-01 / AC-9: a host whose case differs compares correctly', () => {
  it('on the CALLER side, which the URL parser already settles', () => {
    // `new URL('https://API.LLAMA.FI/x').hostname` is `api.llama.fi` on Node v24.15.0 — the parser
    // ASCII-lowercases the host before any of our code sees it.
    expect(allowlistAuthority('https://API.LLAMA.FI/x')).toBe(LLAMA);
    expect(() => assertAllowedHost('https://API.LLAMA.FI/x', [LLAMA])).not.toThrow();
  });

  it('on the ALLOWLIST side, which nothing settled before this task', () => {
    // This is the half that was broken. `hosts` is hand-written data with no schema behind it, so an
    // entry typed in mixed case matched NOTHING: the adapter carrying it refused every call it made,
    // and `SsrfBlockedError` named the target rather than the typo.
    expect(() => assertAllowedHost(LLAMA, ['API.Llama.FI'])).not.toThrow();
    expect(normalizeAllowlistEntry('API.Llama.FI')).toBe(LLAMA);
  });
});

describe('TC-UNIT-02 / AC-9: the default port is not a difference, and any other port is', () => {
  it('`https://host` and `https://host:443` compare as one, from either side', () => {
    expect(allowlistAuthority(`https://${LLAMA}:443/x`)).toBe(LLAMA);
    expect(() => assertAllowedHost(`https://${LLAMA}:443/x`, [LLAMA])).not.toThrow();
    expect(() => assertAllowedHost(`https://${LLAMA}/x`, [`${LLAMA}:443`])).not.toThrow();
  });

  it('a NON-default port is refused, which is what comparing the authority bought', () => {
    // The defect this closed: `URL.hostname` discards the port, so `https://api.llama.fi:8443/`
    // passed an allowlist that says `api.llama.fi`. The initial URL of every adapter is a compiled
    // constant, so the port is chosen by whoever controls an allowlisted vendor's `Location` header
    // — a compromised vendor or an open redirect on one — not by the remote caller.
    expect(allowlistAuthority(`https://${LLAMA}:8443/x`)).toBe(`${LLAMA}:8443`);
    expect(() => assertAllowedHost(`https://${LLAMA}:8443/x`, [LLAMA])).toThrow(SsrfBlockedError);
    // And an adapter that genuinely serves a non-default port can still declare it.
    expect(() => assertAllowedHost(`https://${LLAMA}:8443/x`, [`${LLAMA}:8443`])).not.toThrow();
  });
});

describe('a trailing dot is refused rather than normalised, and that is the decision', () => {
  it('fails CLOSED, so nothing is owed', () => {
    // The parser preserves it: `api.llama.fi.` is not `api.llama.fi`, so a dotted target misses the
    // allowlist and is refused.
    expect(allowlistAuthority(`https://${LLAMA}./x`)).toBe(`${LLAMA}.`);
    expect(() => assertAllowedHost(`https://${LLAMA}./x`, [LLAMA])).toThrow(SsrfBlockedError);
  });

  it('normalising it would widen a SECOND comparison — the one that moves secrets', async () => {
    // Memory M6: a new legal answer widens what the gate accepts. `safeFetch` strips
    // `Authorization` and `*-api-key*` when a redirect changes host; were `host.` to stop counting
    // as a different host, a hop that today loses its credential would carry it forward. The
    // assertion below is that direction, measured: the dotted hop is treated as cross-host.
    const seen: (string | undefined)[] = [];
    const fetchImpl = ((_input: string | URL, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string> | undefined)?.['authorization']);
      if (seen.length === 1) {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: `https://${LLAMA}./v1` } }),
        );
      }
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    }) as unknown as typeof fetch;

    const thrown = await safeFetch(
      `https://${LLAMA}/v1`,
      { headers: { authorization: 'Bearer secret-value' } },
      [LLAMA, `${LLAMA}.`],
      fetchImpl,
    ).catch((error: unknown) => error);

    // Both hosts are allowlisted here on purpose: this case is about the HEADER, not the refusal.
    expect(thrown, 'the dotted hop was followed').not.toBeInstanceOf(SsrfBlockedError);
    expect(seen[0]).toBe('Bearer secret-value');
    expect(seen[1], 'the credential survived a host change').toBeUndefined();
  });
});

describe('a port change is a host change as far as a credential is concerned', () => {
  it('a hop to another port on the SAME hostname loses `Authorization`', async () => {
    // The half a trailing-dot case cannot reach: there the hostname differs too, so the strip fires
    // under either comparison. Here the hostname is identical and only the authority differs —
    // which is precisely the state `URL.hostname` could not see. Both authorities are allowlisted
    // on purpose, so what is measured is the HEADER and not the refusal.
    const seen: (string | undefined)[] = [];
    const fetchImpl = ((_input: string | URL, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string> | undefined)?.['authorization']);
      if (seen.length === 1) {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: `https://${LLAMA}:8443/v1` } }),
        );
      }
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    }) as unknown as typeof fetch;

    await safeFetch(
      `https://${LLAMA}/v1`,
      { headers: { authorization: 'Bearer secret-value' } },
      [LLAMA, `${LLAMA}:8443`],
      fetchImpl,
    ).catch((error: unknown) => error);

    expect(seen[0]).toBe('Bearer secret-value');
    expect(seen[1], 'the credential followed the redirect to another port').toBeUndefined();
  });
});

describe('TC-UNIT-03 / AC-10: the redirect cap is a typed error', () => {
  it('throws `RedirectLimitExceededError`, and it is on the pass-through list', async () => {
    let hops = 0;
    const fetchImpl = (() => {
      hops += 1;
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: `https://${LLAMA}/hop${String(hops)}` },
        }),
      );
    }) as unknown as typeof fetch;

    const thrown = await safeFetch(
      `https://${LLAMA}/v1?apikey=secret`,
      {},
      [LLAMA],
      fetchImpl,
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(RedirectLimitExceededError);
    expect((thrown as RedirectLimitExceededError).limit).toBe(3);
    // Its own redaction, which is the property the pass-through list rests on (WI-36).
    expect((thrown as Error).message).not.toContain('apikey');
    expect((thrown as Error).message).not.toContain('?');
    expect(isPassThroughTransportError(thrown)).toBe(true);
  });

  it('the case fails on an UNtyped error, which is what AC-10 asks it to prove', () => {
    // Stated as an assertion rather than left to the reader: a plain `Error` carrying the same
    // message must NOT satisfy the check above, or the case would pass against the pre-014-21 tree.
    const untyped = new Error('safeFetch: exceeded 3 redirects following https://api.llama.fi/v1');
    expect(untyped).not.toBeInstanceOf(RedirectLimitExceededError);
    expect(isPassThroughTransportError(untyped)).toBe(false);
  });
});

describe('TC-UNIT-05: a host outside the adapter allowlist is refused', () => {
  it('per adapter, never against a merged set', async () => {
    // R-25's isolation: `defillama`'s allowlist does not admit `nansen`'s host, and the refusal
    // carries the authority and nothing else.
    const nansen = adapterRegistrations.find((r) => r.id === 'nansen');
    const defillama = adapterRegistrations.find((r) => r.id === 'defillama');
    expect(nansen?.hosts[0]).toBeDefined();
    expect(() => assertAllowedHost(String(nansen?.hosts[0]), defillama?.hosts ?? [])).toThrow(
      SsrfBlockedError,
    );

    const thrown = await safeFetch('https://evil.example.com/v1', {}, defillama?.hosts ?? [], (() =>
      Promise.reject(new Error('must not be called'))) as unknown as typeof fetch).catch(
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(SsrfBlockedError);
    expect((thrown as SsrfBlockedError).message).toContain('evil.example.com');
  });
});

describe('R-10.4: the per-adapter allowlist is kept usable, and checked at START', () => {
  it('every shipped entry is a bare authority', () => {
    for (const registration of adapterRegistrations) {
      for (const entry of registration.hosts) {
        expect(() => normalizeAllowlistEntry(entry), `${registration.id}: ${entry}`).not.toThrow();
        // Already canonical as shipped: normalisation is the safety net, not the reason they work.
        expect(normalizeAllowlistEntry(entry), `${registration.id}: ${entry}`).toBe(entry);
      }
    }
  });

  it('an entry that no URL can equal fails the process at start, naming the entry', () => {
    const base = adapterRegistrations[0];
    expect(base).toBeDefined();
    if (base === undefined) return;
    for (const bad of [
      'api.x.com/v1',
      'https://api.x.com/v1?k=1',
      'user:pw@api.x.com',
      'not a host',
    ]) {
      expect(() => assertValidAdapterRegistrations([{ ...base, hosts: [bad] }]), bad).toThrow(
        /unusable SSRF allowlist entry/,
      );
    }
    // The class is available for a caller that wants to branch, and the message names the entry.
    expect(() => normalizeAllowlistEntry('api.x.com/v1')).toThrow(AllowlistEntryInvalidError);
    expect(() => normalizeAllowlistEntry('api.x.com/v1')).toThrow(/api\.x\.com\/v1/);
  });
});

describe('TC-UNIT-04 / AC-22: TLS name verification is on, and the accepted risk is recorded', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

  /** Every `.ts` file under a directory, recursively. */
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return sources(full);
      return full.endsWith('.ts') ? [full] : [];
    });
  }

  /**
   * **This is a STRUCTURAL gate, and saying so is part of it.** Proving name verification
   * behaviourally needs a TLS listener with a certificate that fails to validate, i.e. a committed
   * key pair that expires or a live host — and R-21 forbids the network in CI. What is provable
   * offline is that nothing in the shipped tree turns verification OFF, which is the whole of how
   * it could be lost: Node verifies the chain and the name by default, and only an explicit opt-out
   * changes that.
   */
  it('no shipped source weakens TLS', () => {
    const weakeners = [
      /NODE_TLS_REJECT_UNAUTHORIZED/,
      /rejectUnauthorized/,
      /checkServerIdentity/,
      /new\s+(?:https?\.)?Agent\s*\(/,
      /setGlobalDispatcher/,
    ];
    const offenders: string[] = [];
    for (const file of [
      ...sources(path.join(repoRoot, 'packages/core/src')),
      ...sources(path.join(repoRoot, 'packages/mcp-server/src')),
    ]) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const pattern of weakeners) {
        if (pattern.test(code))
          offenders.push(`${path.relative(repoRoot, file)} :: ${String(pattern)}`);
      }
    }
    expect(offenders, 'TLS verification can only be lost by an explicit opt-out').toStrictEqual([]);
    // The gate can go red: the same scan over a string that DOES opt out.
    expect(
      weakeners.some((p) => p.test('fetch(u, { dispatcher: new Agent({ connect: {} }) })')),
    ).toBe(true);
  });

  it('`safeFetch` passes no dispatcher, agent or TLS option of its own', () => {
    const code = readFileSync(path.join(repoRoot, 'packages/core/src/net/safe-fetch.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/dispatcher\s*:/);
    expect(code).not.toMatch(/\bagent\s*:/i);
  });

  it('the accepted risk is written down where the criterion says it is', () => {
    // AC-22 is two halves — name verification AND a recorded accepted risk — and a test that
    // checked only the first would report the criterion met while the second was a memory.
    const security = readFileSync(path.join(repoRoot, 'docs/architectures/security.md'), 'utf8');
    expect(security).toMatch(/7\.5\.5/);
    expect(security.toLowerCase()).toContain('wi-60');
    const backlog = readdirSync(path.join(repoRoot, 'docs/backlog'));
    expect(backlog.filter((f) => f.startsWith('wi-60-'))).toHaveLength(1);
  });
});
