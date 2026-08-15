import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AccessProfileUnavailableError,
  PHASE_0_ACCESS_PROFILE,
  createDefaultAccessProfileReader,
  type AccessProfile,
  type AccessProfileReader,
} from '../src/auth/index.js';
import { EnvSchema, loadEnv } from '../src/env.js';
import { createServer } from '../src/server.js';
import { toolSpecs } from '../src/tools/tool-specs.js';

/**
 * Task 014-04 — one reader, two suppliers, and the narrowing applied at registration.
 *
 * The reader is an interface and the suppliers implement it, which is what makes AC-38 a measurement
 * rather than a claim: the second supplier is substituted and no reading code changes.
 */

/** A client over `InMemoryTransport`, the seam `e2e.inprocess` uses (no network, R-21). */
async function listTools(
  profile?: AccessProfile,
): Promise<{ name: string; title?: string; description?: string }[]> {
  const server = createServer({
    env: loadEnv({}),
    version: '0.0.0-test',
    ...(profile ? { accessProfile: profile } : {}),
  });
  const client = new Client({ name: 'access-profile', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      ...(tool.description === undefined ? {} : { description: tool.description }),
    }));
  } finally {
    await client.close();
    await server.close();
  }
}

const withProfile = (overrides: Partial<AccessProfile>): AccessProfile => ({
  ...PHASE_0_ACCESS_PROFILE,
  ...overrides,
});

describe('one reader, two suppliers (AC-38)', () => {
  /**
   * The consumer, written once against the interface. Nothing below re-implements it per supplier —
   * that is the whole assertion: substituting the supplier changes no reading code.
   */
  const consume = async (reader: AccessProfileReader, id: string): Promise<string> =>
    (await reader.read(id)).toolAllowlistMode;

  it('TC-UNIT-01: a second supplier answering with a delay needs no change to the reader', async () => {
    const table: AccessProfileReader = {
      read: () =>
        new Promise<AccessProfile>((resolve) =>
          setTimeout(
            () => resolve(withProfile({ toolAllowlistMode: 'list', toolAllowlist: [] })),
            5,
          ),
        ),
    };
    expect(await consume(createDefaultAccessProfileReader(), '01JX')).toBe('all');
    expect(await consume(table, '01JX')).toBe('list');
  });

  it('TC-UNIT-10: the phase-0 supplier answers `full`, and `none` is constructible by another', async () => {
    expect((await createDefaultAccessProfileReader().read('01JX')).routeDisclosureMode).toBe(
      'full',
    );
    const closed: AccessProfileReader = {
      read: () => Promise.resolve(withProfile({ routeDisclosureMode: 'none' })),
    };
    // The input of task 014-16's TC-E2E-02: a profile that hides the route, built without touching
    // the reader or the phase-0 supplier.
    expect((await closed.read('01JX')).routeDisclosureMode).toBe('none');
  });

  it('phase 0 declares all three limits unlimited, so no measured number enters this task', () => {
    expect(PHASE_0_ACCESS_PROFILE).toStrictEqual({
      creditsMode: 'unlimited',
      creditsBalanceRaw: null,
      rateLimitMode: 'unlimited',
      rateLimitPerMin: null,
      toolAllowlistMode: 'all',
      toolAllowlist: null,
      routeDisclosureMode: 'full',
    });
    // Every mode is paired with its value, so "unlimited" is declared and never inferred from null.
    expect(PHASE_0_ACCESS_PROFILE.creditsMode === 'metered').toBe(
      PHASE_0_ACCESS_PROFILE.creditsBalanceRaw !== null,
    );
    expect(PHASE_0_ACCESS_PROFILE.rateLimitMode === 'metered').toBe(
      PHASE_0_ACCESS_PROFILE.rateLimitPerMin !== null,
    );
    expect(Object.isFrozen(PHASE_0_ACCESS_PROFILE)).toBe(true);
  });

  it('TC-UNIT-04: EnvSchema.parse({}) passes (AC-24, first half)', () => {
    // The other half — the network profile refusing to start with no active token — is task 014-12.
    expect(() => EnvSchema.parse({})).not.toThrow();
  });
});

describe('a supplier that cannot answer refuses, and no default is substituted', () => {
  const broken: AccessProfileReader = {
    read: (id) => Promise.reject(new AccessProfileUnavailableError(id, 'state store unreachable')),
  };

  it('TC-UNIT-02: the failure propagates instead of resolving to a profile', async () => {
    await expect(broken.read('01JX')).rejects.toBeInstanceOf(AccessProfileUnavailableError);
    // What "no default is substituted" means concretely: the rejection reaches the caller, so no
    // caller ever holds a profile it did not read. A supplier that answered with PHASE_0 here would
    // widen an inventory and a ceiling at the moment the settings source is unavailable.
    const held = await broken.read('01JX').catch(() => null);
    expect(held).toBeNull();
  });

  it('TC-UNIT-03: the same failure on a later read refuses that read too', async () => {
    // The reader has no memory of a successful earlier read, so a failure on the request path is a
    // refusal of the request. Which refusal class it renders is task 014-16's; that it refuses at
    // all is this contract.
    const flaky = (() => {
      let calls = 0;
      return {
        read: (id: string): Promise<AccessProfile> => {
          calls += 1;
          return calls === 1
            ? Promise.resolve(PHASE_0_ACCESS_PROFILE)
            : Promise.reject(new AccessProfileUnavailableError(id, 'connection lost'));
        },
      };
    })();
    await expect(flaky.read('01JX')).resolves.toBe(PHASE_0_ACCESS_PROFILE);
    await expect(flaky.read('01JX')).rejects.toThrow(/could not be read/);
  });

  it('names the profile id and nothing else (D10)', async () => {
    const message = await broken
      .read('01JPROFILE')
      .then(() => '')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(message).toContain('01JPROFILE');
    expect(message).toContain('state store unreachable');
  });

  it('refuses an empty id rather than answering the defaults for it', async () => {
    // The stdio principal carries `accessProfileId: null` and must reach no profile at all. An
    // answer here would let that path receive an unlimited profile and never learn it asked nothing.
    await expect(createDefaultAccessProfileReader().read('')).rejects.toBeInstanceOf(
      AccessProfileUnavailableError,
    );
  });
});

describe('the profile narrows the tool inventory and changes no text (AC-25)', () => {
  it('TC-E2E-01: a list of three yields three tools, byte-identical in title and description', async () => {
    const unnarrowed = await listTools();
    expect(unnarrowed.length).toBeGreaterThan(3);
    const chosen = unnarrowed.slice(0, 3).map((tool) => tool.name);

    const narrowed = await listTools(
      withProfile({ toolAllowlistMode: 'list', toolAllowlist: chosen }),
    );
    expect(narrowed.map((tool) => tool.name)).toStrictEqual(chosen);
    // The second half of AC-25, and the reason it is a separate assertion: a narrowing that also
    // rewrote a description would pass a count check. `title`/`description` come from the tool
    // definition (R-14.3), never from the profile.
    for (const tool of narrowed) {
      expect(tool).toStrictEqual(unnarrowed.find((candidate) => candidate.name === tool.name));
    }
  });

  it('TC-UNIT-05: mode `list` with an EMPTY list allows nothing, and differs from mode `all`', async () => {
    const empty = await listTools(withProfile({ toolAllowlistMode: 'list', toolAllowlist: [] }));
    expect(empty).toStrictEqual([]);
    // The distinction the engine holds with a CHECK pair and this process holds here: an empty list
    // is "no tool permitted", not "no narrowing". Read the second way, empty becomes safe.
    expect((await listTools(withProfile({ toolAllowlistMode: 'all' }))).length).toBeGreaterThan(0);
  });

  it('TC-UNIT-06: a name no spec carries selects nothing and widens nothing', async () => {
    const invented = await listTools(
      withProfile({ toolAllowlistMode: 'list', toolAllowlist: ['onchain_not_a_tool'] }),
    );
    expect(invented).toStrictEqual([]);
    // And the process inventory is untouched: the next session with no profile sees everything.
    expect((await listTools()).map((tool) => tool.name)).toStrictEqual(
      toolSpecs.map((spec) => spec.name),
    );
  });

  it('a null list under mode `list` registers nothing rather than guessing', async () => {
    // A state the engine's CHECK pair forbids. If it ever reaches the process, the fail-closed
    // reading is the only one that cannot widen an inventory.
    expect(
      await listTools(withProfile({ toolAllowlistMode: 'list', toolAllowlist: null })),
    ).toStrictEqual([]);
  });

  it('a narrowed-away tool is NOT FOUND, never "disabled" — the inventory stays unobservable', async () => {
    // The alternative implementation — register everything, disable what the profile excludes —
    // also makes `tools/list` answer, and it answers `Tool X disabled` on a call. That sentence
    // tells a narrowed principal the tool exists on this server. Skipping registration is what makes
    // the two indistinguishable, and this is the assertion that keeps it that way.
    const [kept, excluded] = toolSpecs.map((spec) => spec.name) as [string, string];
    const server = createServer({
      env: loadEnv({}),
      version: '0.0.0-test',
      accessProfile: withProfile({ toolAllowlistMode: 'list', toolAllowlist: [kept] }),
    });
    const client = new Client({ name: 'narrowed-call', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: excluded, arguments: {} });
      const text = JSON.stringify(result);
      expect(text).toContain('not found');
      expect(text).not.toContain('disabled');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('the placeholder that keeps an empty tools/list answerable is never reachable', async () => {
    // `keepToolListAnswerable` registers one tool and removes it, so the SDK installs its handlers.
    // The removal happens before any transport exists; this asserts the consequence rather than the
    // mechanism — nothing named `onchain_none` is listed, and calling it is a plain not-found.
    const server = createServer({
      env: loadEnv({}),
      version: '0.0.0-test',
      accessProfile: withProfile({ toolAllowlistMode: 'list', toolAllowlist: [] }),
    });
    const client = new Client({ name: 'placeholder', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect((await client.listTools()).tools).toStrictEqual([]);
      const result = await client.callTool({ name: 'onchain_none', arguments: {} });
      expect(JSON.stringify(result)).toContain('not found');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('an absent profile is the unnarrowed process inventory — the local path is unchanged', async () => {
    expect((await listTools()).map((tool) => tool.name)).toStrictEqual(
      toolSpecs.map((spec) => spec.name),
    );
  });

  it('TC-UNIT-09: narrowing happens in the registration loop, not per request', async () => {
    // Where the narrowing is applied is a requirement, not an implementation detail: at registration
    // it is one inventory per session, and any later mechanism would have to be a second one.
    const registerTool = vi.spyOn(McpServer.prototype, 'registerTool');
    try {
      const chosen = toolSpecs.slice(0, 2).map((spec) => spec.name);
      const server = createServer({
        env: loadEnv({}),
        version: '0.0.0-test',
        accessProfile: withProfile({ toolAllowlistMode: 'list', toolAllowlist: chosen }),
      });
      expect(registerTool).toHaveBeenCalledTimes(2);

      const client = new Client({ name: 'locus', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        await client.listTools();
        await client.listTools();
        // Two more `tools/list` round trips move nothing: the inventory was decided once, when the
        // session was built.
        expect(registerTool).toHaveBeenCalledTimes(2);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      registerTool.mockRestore();
    }
  });
});
