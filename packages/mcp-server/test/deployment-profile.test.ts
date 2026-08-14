import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';
import {
  DEFAULT_PROFILE,
  PROFILES,
  PreStartCheckFailed,
  UnknownProfileError,
  assertNetworkPreconditions,
  networkPreStartChecks,
  resolveProfile,
  SHIPPED_TRANSPORTS,
  TransportNotShippedError,
  assertTransportAvailable,
  type PreStartCheck,
} from '../src/profile.js';

/**
 * Task 014-38 — the profile resolves into a transport and a storage axis, and the network profile
 * refuses to start rather than quietly downgrading.
 *
 * The pair is asserted on the DESCRIPTOR, not on a constructed store: this task chooses the axis,
 * task 014-39 builds it. Asserting a `PgCacheStore` instance here would be asserting another task's
 * deliverable through this one.
 */
describe('deployment profile — three declared pairs', () => {
  it('TC-UNIT-01: local is stdio over SQLite', () => {
    expect(resolveProfile({ ONCHAIN_PROFILE: 'local' })).toEqual({
      name: 'local',
      transport: 'stdio',
      storage: 'sqlite',
    });
  });

  it('TC-UNIT-02: network is Streamable HTTP over Postgres', () => {
    const profile = resolveProfile({
      ONCHAIN_PROFILE: 'network',
      ONCHAIN_STATE_PG_URL: 'postgres://user@host/db',
    });
    expect(profile.transport).toBe('http');
    expect(profile.storage).toBe('postgres');
  });

  it('TC-UNIT-03: network-sqlite is HTTP over SQLite, and needs no DSN', async () => {
    const profile = resolveProfile({ ONCHAIN_PROFILE: 'network-sqlite' });
    expect(profile).toEqual({ name: 'network-sqlite', transport: 'http', storage: 'sqlite' });
    await expect(assertNetworkPreconditions(profile, {})).resolves.toBeUndefined();
  });

  it('TC-UNIT-05: an unset key resolves to local, and EnvSchema.parse({}) still passes', () => {
    expect(resolveProfile({}).name).toBe(DEFAULT_PROFILE);
    expect(resolveProfile({ ONCHAIN_PROFILE: '' }).name).toBe('local');
    expect(() => loadEnv({})).not.toThrow();
  });

  it('declares exactly three pairs, and the fourth combination is not among them', () => {
    expect(Object.keys(PROFILES)).toEqual(['local', 'network', 'network-sqlite']);
    const pairs = Object.values(PROFILES).map((p) => `${p.transport}+${p.storage}`);
    expect(pairs).not.toContain('stdio+postgres');
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('refuses an unknown value instead of falling back to the default', () => {
    expect(() => resolveProfile({ ONCHAIN_PROFILE: 'production' })).toThrow(UnknownProfileError);
  });

  it('names no key value in the refusal beyond the one presented (D10)', () => {
    const raw = { ONCHAIN_PROFILE: 'production', NANSEN_API_KEY: 'secret-value' };
    const message = (() => {
      try {
        resolveProfile(raw);
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    expect(message).not.toContain('secret-value');
  });
});

describe('deployment profile — the network profile refuses rather than downgrades', () => {
  it('TC-UNIT-04: network without a DSN fails its first check by name', async () => {
    const profile = resolveProfile({ ONCHAIN_PROFILE: 'network' });
    await expect(assertNetworkPreconditions(profile, {})).rejects.toThrow(PreStartCheckFailed);
    await expect(assertNetworkPreconditions(profile, {})).rejects.toThrow(
      /ONCHAIN_STATE_PG_URL is set/,
    );
  });

  it('TC-UNIT-04b: a whitespace-only DSN is not a DSN', async () => {
    const profile = resolveProfile({ ONCHAIN_PROFILE: 'network' });
    await expect(
      assertNetworkPreconditions(profile, { ONCHAIN_STATE_PG_URL: '   ' }),
    ).rejects.toThrow(PreStartCheckFailed);
  });

  it('TC-UNIT-06: an unreachable state store stops the start, naming the failed check', async () => {
    const unreachable: PreStartCheck[] = [
      { name: 'the state store answers', owner: 'test', probe: () => Promise.resolve(false) },
    ];
    const profile = resolveProfile({ ONCHAIN_PROFILE: 'network' });
    await expect(
      assertNetworkPreconditions(profile, { ONCHAIN_STATE_PG_URL: 'postgres://x' }, unreachable),
    ).rejects.toThrow(/the state store answers/);
  });

  it('stops at the FIRST failing check, so a later probe cannot mask an earlier one', async () => {
    const seen: string[] = [];
    const checks: PreStartCheck[] = [
      {
        name: 'first',
        owner: 'test',
        probe: () => {
          seen.push('first');
          return Promise.resolve(false);
        },
      },
      {
        name: 'second',
        owner: 'test',
        probe: () => {
          seen.push('second');
          return Promise.resolve(true);
        },
      },
    ];
    const profile = resolveProfile({ ONCHAIN_PROFILE: 'network' });
    await expect(assertNetworkPreconditions(profile, {}, checks)).rejects.toThrow(/first/);
    expect(seen).toEqual(['first']);
  });

  it('runs no check at all for local — the local path is unchanged by this task', async () => {
    const ran: string[] = [];
    const checks: PreStartCheck[] = [
      {
        name: 'must not run',
        owner: 'test',
        probe: () => {
          ran.push('ran');
          return Promise.resolve(false);
        },
      },
    ];
    await expect(assertNetworkPreconditions(PROFILES.local, {}, checks)).resolves.toBeUndefined();
    expect(ran).toEqual([]);
  });
});

describe('deployment profile — an unshipped transport refuses, never falls back', () => {
  it('refuses an http profile while only stdio is shipped', () => {
    expect(() => assertTransportAvailable(PROFILES.network, SHIPPED_TRANSPORTS)).toThrow(
      TransportNotShippedError,
    );
    expect(() => assertTransportAvailable(PROFILES['network-sqlite'], SHIPPED_TRANSPORTS)).toThrow(
      TransportNotShippedError,
    );
  });

  it('admits the local profile, whose transport is shipped', () => {
    expect(() => assertTransportAvailable(PROFILES.local, SHIPPED_TRANSPORTS)).not.toThrow();
  });

  it('admits every profile once its transport is shipped — the set is the only thing to change', () => {
    for (const profile of Object.values(PROFILES)) {
      expect(() => assertTransportAvailable(profile, ['stdio', 'http'])).not.toThrow();
    }
  });

  it('names the task that ships the missing transport, so the refusal is actionable', () => {
    expect(() => assertTransportAvailable(PROFILES.network, SHIPPED_TRANSPORTS)).toThrow(
      /task 014-09/,
    );
  });
});

describe('deployment profile — unwired checks are declared, not silent', () => {
  /**
   * Two of the three checks cannot run yet: their code arrives with tasks 014-39 and 014-07.
   *
   * A check that passed because nothing executed it is indistinguishable from a check that passed
   * because the condition held. So an unwired check must NAME the task that wires it, and this gate
   * is what keeps that true.
   */
  it('every check without a probe names the task that supplies it', () => {
    const unwired = networkPreStartChecks().filter((c) => c.probe === null);
    expect(unwired.length).toBeGreaterThan(0);
    for (const check of unwired) {
      expect(check.owner, `check "${check.name}" has no owner`).toMatch(/task \d{3}-\d{2}/);
    }
  });

  /**
   * TC-UNIT-07 — the profile does not reach a tool.
   *
   * Read off the source of `index.ts` rather than off a constructed server: what must stay true is
   * that the ONE call site never threads the profile in. A test that inspected a built object would
   * pass just as well if a future call site added the field under another name.
   */
  it('TC-UNIT-07: index.ts does not pass the profile into createServer (R-1.2)', () => {
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts'),
      'utf8',
    );
    const call = /createServer\(\{([^}]*)\}\)/.exec(source);
    expect(call, 'createServer is called exactly once, with an object literal').not.toBeNull();
    const keys = (call?.[1] ?? '').split(',').map((k) => k.trim().split(':')[0]?.trim());
    expect(keys.filter(Boolean)).toEqual(['env', 'version', 'registry', 'budgetStore']);
    expect(keys).not.toContain('profile');
  });

  it('keeps the order deployment.md §10.3.2 fixes — the DSN is checked first', () => {
    expect(networkPreStartChecks().map((c) => c.name)).toEqual([
      'ONCHAIN_STATE_PG_URL is set',
      'the state store answers',
      'api_tokens holds a live active row',
    ]);
  });
});
