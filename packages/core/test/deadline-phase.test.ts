import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DeadlineExceededError } from '../src/net/safe-fetch.js';

/**
 * L-26 fix-path item 1 — a deadline failure says WHERE the budget went.
 *
 * **The defect this closes was an absence, which is why it needed a record before it needed a
 * test.** Every producer of `DeadlineExceededError` ends the call the same way, and until the phase
 * existed they also ended it with the same sentence — so "we queued behind our own limiter" and
 * "the vendor did not answer" were indistinguishable once the call was over. Two investigations on
 * 2026-08-24 (L-25 and L-26) each began by trying to recover that distinction after the fact and
 * could not; both had to be re-measured live instead.
 */
describe('TC-UNIT-19 — the deadline error names its phase', () => {
  it('puts the phase in the message, where every consumer already reads', () => {
    const err = new DeadlineExceededError('provider "coingecko"', 1_770_000_000_000, 'limiter');
    expect(err.phase).toBe('limiter');
    expect(err.message).toContain('deadline exceeded in limiter');
    // The context and the budget survive unchanged: the phase is added, nothing is displaced.
    expect(err.message).toContain('deadlineAtMs=1770000000000');
    expect(err.at).toContain('coingecko');
  });

  it('defaults to `wire`, the commonest answer, rather than inventing a sixth value', () => {
    // The default exists only so a NEW producer that forgets the argument still says something
    // true-ish rather than nothing. The test below is what stops that default from being used.
    expect(new DeadlineExceededError('https://example.invalid/x', 1).phase).toBe('wire');
  });
});

describe('TC-UNIT-20 — every producer in this package labels its phase explicitly', () => {
  const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

  const filesUnder = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      return statSync(full).isDirectory() ? filesUnder(full) : full.endsWith('.ts') ? [full] : [];
    });

  it('no `new DeadlineExceededError(...)` relies on the default', () => {
    // A SOURCE assertion, deliberately. Reaching every producer at run time would need a Postgres
    // client, a singleflight follower and two live adapters — and the failure this guards is a new
    // call site added without a phase, which no amount of behavioural coverage of the OLD ones
    // would catch. The same instrument `failure-representation.test.ts` already uses on markers.
    const unlabelled: string[] = [];
    const KNOWN = ["'limiter'", "'wire'", "'shared-document'", "'coalesced'", "'pg-query'"];
    let found = 0;
    for (const file of filesUnder(srcDir)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/new DeadlineExceededError\(([\s\S]{0,200}?)\)[;,)\s]/g)) {
        found += 1;
        const args = match[1] ?? '';
        if (!KNOWN.some((phase) => args.includes(phase))) {
          unlabelled.push(
            `${path.relative(srcDir, file)}: ${args.replace(/\s+/g, ' ').slice(0, 80)}`,
          );
        }
      }
    }
    // Sign of work before the verdict: a regex that matched nothing would report a clean sweep,
    // which is the exact way a source-text assertion passes for the wrong reason.
    expect(found, 'the scan found no producers at all — the pattern has drifted').toBeGreaterThan(
      5,
    );
    expect(unlabelled, `producers with no explicit phase:\n${unlabelled.join('\n')}`).toStrictEqual(
      [],
    );
  });

  it('and the producers cover every phase the type declares — no dead value', () => {
    // A phase nothing produces is a value a reader will look for and never see, which is its own
    // kind of lie. If one is retired, this fails and the type is edited with it.
    const all = filesUnder(srcDir)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    for (const phase of ['limiter', 'wire', 'shared-document', 'coalesced', 'pg-query']) {
      expect(
        all.includes(`new DeadlineExceededError(`) && all.includes(`'${phase}'`),
        `no producer emits phase '${phase}'`,
      ).toBe(true);
    }
  });
});
