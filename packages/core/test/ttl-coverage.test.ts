import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { routes } from '../src/providers.config.js';
import { ttlFor } from '../src/cache/ttl.js';

/**
 * Every routed capability must have an EXPLICIT TTL row (TASK-009 doc pass).
 *
 * **Why this is a gate and not a review item.** A capability with no row silently falls through to
 * `DEFAULT_TTL_SECONDS`, a constant whose own docstring says it should not be hit — and the failure
 * is invisible, because the cache works perfectly, just at a number nobody chose. It has happened
 * twice: all three of M2's PAID capabilities shipped that way (found by two independent adversarial
 * critics, not by a test), and then `dex.volume.history` did (found by review again). Both times the
 * mechanism that caught it was a human reading the file.
 *
 * `ttlFor()` cannot express the difference — it returns a number either way — so the check has to
 * read the table's own source. That is the point: this asserts a property of the SOURCE, which is
 * where the omission lives.
 */

const ttlSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cache/ttl.ts'),
  'utf8',
);

/** Capability ids that appear as an explicit `'<id>': <seconds>,` row in the table. */
const explicitRows = new Set(
  [...ttlSource.matchAll(/^\s+'([a-z0-9._-]+)':\s*\d+,/gm)].flatMap((match) =>
    // `noUncheckedIndexedAccess` types a capture group as possibly-undefined; a group that did not
    // participate is dropped rather than coerced, so the set never holds a phantom entry.
    match[1] === undefined ? [] : [match[1]],
  ),
);

const routedCapabilities = [...new Set(routes.map((route) => route.capability))].sort();

describe('TTL table covers every routed capability explicitly', () => {
  it('has at least one row and one route — otherwise the checks below are vacuous', () => {
    // Guards against the regex silently matching nothing, which would make every assertion here
    // pass while proving the opposite of what it claims.
    expect(explicitRows.size).toBeGreaterThan(10);
    expect(routedCapabilities.length).toBeGreaterThan(10);
  });

  it.each(routedCapabilities)('%s has an explicit row, not the fallback', (capability) => {
    expect(explicitRows.has(capability)).toBe(true);
  });

  it('has no TTL row for a capability nothing routes', () => {
    // The opposite drift: a capability removed from `routes` leaves its row behind, and the next
    // reader takes the dead row for a served capability.
    const orphans = [...explicitRows].filter((row) => !routedCapabilities.includes(row));
    expect(orphans).toEqual([]);
  });

  it('returns a positive TTL for every routed capability', () => {
    for (const capability of routedCapabilities) {
      expect(ttlFor(capability)).toBeGreaterThan(0);
    }
  });
});
