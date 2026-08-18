import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { captureToolsList, SNAPSHOT_PATH, type ToolsListEntry } from '../scripts/snapshot-tools.js';
import { toolSpecs } from '../src/tools/tool-specs.js';
import { ChainInputSchema } from '@onchain-intel/core';

/**
 * Task 014-22 — no tool input schema accepts a host, a URL or an RPC endpoint (R-11, AC-11).
 *
 * **Why this is a gate and not a review.** `ADR-003` D2 refuses a client's vendor keys; the
 * destination address is refused for the same reason. An argument a host can be derived from turns
 * this engine into an open proxy sitting inside our network perimeter — one that carries OUR vendor
 * credentials and OUR allowlist. The SSRF gate one layer down (task 014-21) checks where a call
 * goes; this one checks that the caller never gets to say.
 *
 * **What it reads, and why that surface and not the zod objects.** The published `tools/list` JSON
 * Schema — the bytes an untrusted client actually receives. `ToolSpec` does not expose its
 * `inputSchema` (it exposes `register`), and adding a field so a test could read it would change
 * production code to suit a test; more importantly, the published schema is the contract, and a
 * shape that reached a client through some rendering quirk would be invisible to a check that read
 * the zod object instead.
 *
 * **The count is never written here.** `toolSpecs.length` is the denominator, and the published list
 * is asserted to agree with it. A hardcoded number diverges from the registry on the first tool
 * added — task 014-32 adds one — and the divergence reads as "the gate passed" (the same argument
 * AC-7 and AC-11 make).
 */

/** A JSON Schema node, walked structurally rather than typed — the renderer may nest freely. */
type SchemaNode = Record<string, unknown>;

interface Field {
  readonly tool: string;
  /** Dotted path from the input root, so a nested offender is actionable (L-3: name the offender). */
  readonly path: string;
  readonly node: SchemaNode;
}

/**
 * Every leaf and branch a caller can address, at any depth.
 *
 * Recursion is the point: a top-level-only walk would be satisfied by moving `rpcUrl` one level
 * down into an object, which is not a fix.
 */
function fieldsOf(tool: string, schema: unknown, path = ''): Field[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const node = schema as SchemaNode;
  const found: Field[] = [];

  const properties = node['properties'];
  if (typeof properties === 'object' && properties !== null) {
    for (const [name, child] of Object.entries(properties)) {
      const childPath = path === '' ? name : `${path}.${name}`;
      found.push({ tool, path: childPath, node: (child ?? {}) as SchemaNode });
      found.push(...fieldsOf(tool, child, childPath));
    }
  }
  // Arrays, unions and intersections: a host hidden in `items` or one arm of an `anyOf` is still a
  // host the caller can send.
  for (const key of ['items', 'additionalProperties', 'not']) {
    found.push(...fieldsOf(tool, node[key], path === '' ? key : `${path}.${key}`));
  }
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const arm = node[key];
    if (Array.isArray(arm)) {
      for (const [index, entry] of arm.entries()) {
        found.push(...fieldsOf(tool, entry, `${path}.${key}[${String(index)}]`));
      }
    }
  }
  for (const key of ['$defs', 'definitions']) {
    const defs = node[key];
    if (typeof defs === 'object' && defs !== null) {
      for (const [name, entry] of Object.entries(defs)) {
        found.push(...fieldsOf(tool, entry, `${key}.${name}`));
      }
    }
  }
  return found;
}

/**
 * Words that make a field a destination, split out of camelCase / snake_case so `rpcUrl` and
 * `rpc_url` are both caught and `address` is not.
 *
 * **`address` is deliberately absent.** A blockchain address is the subject of a query, not a place
 * to send one; six tools take one. Adding it here would make the gate red on the tree it was written
 * for, which is the fastest way to have it switched off.
 */
const DESTINATION_WORDS = new Set([
  'url',
  'uri',
  'host',
  'hostname',
  'endpoint',
  'origin',
  'domain',
  'gateway',
  'proxy',
  'server',
  'webhook',
  'callback',
  'rpc',
  'node',
  'port',
  'ip',
]);

/** JSON Schema `format` values that describe a destination rather than a value. */
const DESTINATION_FORMATS = new Set([
  'uri',
  'uri-reference',
  'uri-template',
  'iri',
  'iri-reference',
  'url',
  'hostname',
  'idn-hostname',
  'ipv4',
  'ipv6',
]);

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part !== '')
    .map((part) => part.toLowerCase());
}

/** Why this field is a destination, or `null`. One reason per field, so a failure is readable. */
function destinationReason(field: Field): string | null {
  const leaf = field.path.split('.').at(-1) ?? field.path;
  const hit = words(leaf).find((word) => DESTINATION_WORDS.has(word));
  if (hit !== undefined) return `its name contains "${hit}"`;

  const format = field.node['format'];
  if (typeof format === 'string' && DESTINATION_FORMATS.has(format)) {
    return `its format is "${format}"`;
  }
  const pattern = field.node['pattern'];
  if (typeof pattern === 'string' && /:\/\/|\^https?/i.test(pattern)) {
    return `its pattern accepts a scheme: ${pattern}`;
  }
  return null;
}

const tools = await captureToolsList();

describe('TC-UNIT-01 / AC-11: no input schema accepts a host, a URL or an endpoint', () => {
  it('the published list is the registry, so the gate has the registry’s denominator', () => {
    // A gate whose input is empty passes forever, and one whose input is a literal disagrees with
    // the registry on the first tool added.
    expect(tools.length).toBe(toolSpecs.length);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((tool) => tool.name).sort()).toStrictEqual(
      toolSpecs.map((spec) => spec.name).sort(),
    );
  });

  it('and the denominator has a FLOOR that does not come from the registry', () => {
    // Found by mutation: deleting a tool from `toolSpecs` left every assertion above green, because
    // the published list is derived from that same array — both shrink together and agree perfectly
    // on the smaller set. A gate that walks "every tool" is worth exactly what its population is
    // worth, so the population needs one expectation the registry cannot move.
    //
    // The committed `tools/list` snapshot is that expectation (it is the same argument
    // `tools-list-contract.test.ts` makes for itself). A floor rather than equality: adding a tool
    // is legitimate and its own gate already demands the snapshot be regenerated; losing one is not.
    const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as ToolsListEntry[];
    const missing = snapshot
      .map((entry) => entry.name)
      .filter((name) => !tools.some((tool) => tool.name === name));
    expect(missing, 'a tool in the committed contract is no longer published').toStrictEqual([]);
    expect(tools.length).toBeGreaterThanOrEqual(snapshot.length);
  });

  it('every field of every tool, at every depth', () => {
    const fields = tools.flatMap((tool) => fieldsOf(tool.name, tool.inputSchema));
    // The walk found something: a recursion that silently returned nothing would report a clean
    // inventory of nothing at all.
    expect(fields.length).toBeGreaterThan(10);

    const offenders = fields
      .map((field) => ({ field, reason: destinationReason(field) }))
      .filter((entry) => entry.reason !== null)
      .map((entry) => `${entry.field.tool}.${entry.field.path} — ${String(entry.reason)}`);

    expect(offenders, 'a tool argument the caller can derive a destination from').toStrictEqual([]);
  });
});

describe('TC-UNIT-02: the gate is red on a field that was planted', () => {
  it('flags `rpcUrl` by name, at the top level and nested', () => {
    const planted = {
      type: 'object',
      properties: {
        chain: { type: 'string' },
        rpcUrl: { type: 'string' },
        options: { type: 'object', properties: { endpoint: { type: 'string' } } },
      },
    };
    const reasons = fieldsOf('planted', planted)
      .map((field) => ({ path: field.path, reason: destinationReason(field) }))
      .filter((entry) => entry.reason !== null);

    expect(reasons.map((entry) => entry.path).sort()).toStrictEqual(['options.endpoint', 'rpcUrl']);
  });

  it('flags a destination by FORMAT and by PATTERN, not only by name', () => {
    // A field called `source` typed as a URI is the same hole with a friendlier label, and it is the
    // one a name list alone would miss.
    const byFormat = { type: 'object', properties: { source: { type: 'string', format: 'uri' } } };
    const byPattern = {
      type: 'object',
      properties: { target: { type: 'string', pattern: '^https?://.+' } },
    };
    expect(destinationReason(fieldsOf('x', byFormat)[0]!)).toContain('format');
    expect(destinationReason(fieldsOf('x', byPattern)[0]!)).toContain('pattern');
  });

  it('does NOT flag the fields the shipped tools legitimately take', () => {
    // The other half of a usable gate: a rule red on the tree it was written for gets switched off.
    const benign = {
      type: 'object',
      properties: {
        chain: { type: 'string' },
        address: { type: 'string' },
        tokenAddress: { type: 'string' },
        protocolSlug: { type: 'string' },
        sortedBy: { type: 'string' },
        includeSeries: { type: 'boolean' },
      },
    };
    expect(fieldsOf('x', benign).filter((f) => destinationReason(f) !== null)).toStrictEqual([]);
  });
});

describe('TC-UNIT-03 / R-11.3: `chain` stays a key into the registry', () => {
  it('a value outside the registry is refused by the schema, before any outgoing call', () => {
    // This is what makes `chain` not a hole: it selects a row from a file committed to this
    // repository, and the rejection happens in zod — before the handler, before the adapter, and
    // therefore before anything could leave the process.
    expect(ChainInputSchema.safeParse('ethereum').success).toBe(true);
    for (const outside of ['evil.example.com', 'https://evil.example.com', '../etc/passwd', '']) {
      expect(ChainInputSchema.safeParse(outside).success, outside).toBe(false);
    }
  });

  it('and the registry it keys into is committed data, not a caller-supplied list', () => {
    const parsed = ChainInputSchema.safeParse('ethereum');
    expect(parsed.success).toBe(true);
    // The gate above would be worth nothing if the accepted set could be widened from the wire.
    // It cannot: the schema is built at module load from the compiled registry.
    expect(ChainInputSchema.safeParse('a-chain-nobody-committed').success).toBe(false);
  });
});
