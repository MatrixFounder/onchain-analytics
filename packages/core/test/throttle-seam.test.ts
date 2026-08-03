import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every adapter that calls the limiter must let a caller INJECT one (WI-26).
 *
 * **Why this is a gate and not a review item.** An adapter with no `throttle` seam falls back to
 * the module-level production singleton — one bucket per process, shared by every test in the file.
 * Vitest isolates per file, not per test, so the buckets accumulate across a file's tests and the
 * later ones sleep on real timers. Measured on the day this gate was written: **46.8 s of the core
 * suite's 48.5 s cumulative test time was limiter sleep, spread over FIVE files** — and the run that
 * filed WI-26 went red on an assertion (`HTTP 401 throws a degrade error`) that had nothing to do
 * with the cause. WI-26 named one of those four files; the other three were found by measuring,
 * which is why the property — not one file — is what is asserted here. (The capture's `1010515ms`
 * figure is quoted in that record and deliberately not repeated as a measurement: see
 * `helpers/isolated-throttle.ts` for why this configuration cannot produce it.)
 *
 * **The property, stated once:** a test cannot isolate what the adapter does not let it inject. So
 * the seam is required of every adapter that throttles, and the requirement is derived from the
 * source rather than from a list someone remembered to update — a new adapter that calls
 * `throttle()` without exposing `throttle?: Throttle` fails this on the day it is written, not
 * after its suite has grown slow enough for someone to notice.
 *
 * **What this deliberately does NOT assert.** It does not police test files for USING the seam.
 * That check would have to read call sites textually, and a heuristic strong enough to be worth
 * having would also fire on the two production-wiring suites whose whole purpose is to construct
 * the real thing. The seam is the structural half; `helpers/isolated-throttle.ts` is the other half,
 * and per-file runtime is what proves it (a file that regresses goes from ~50 ms to seconds).
 * That leaves a real residual, stated rather than implied: **14 of the 26 core test files that
 * construct a throttling adapter still take the process singleton** (12 inject one — five through
 * this session's helper, seven through their own `createThrottle`). They do not measurably wait
 * today (every one of them is under 50 ms), which is why they were left alone — but nothing here
 * would notice if one of them grew a loop.
 *
 * **Adversarial cycle 1 found two ways to keep this green while reopening the defect**, and both are
 * closed below:
 *   1. *Rename the binding.* The first version keyed on `await throttle(` / `await throttleFn(` —
 *      three hard-coded local names. `const limiter = productionThrottle; await limiter(…)` dropped
 *      the adapter out of the checked SET entirely, and the population floor was loose enough to
 *      absorb the dropout silently. Membership is now decided by the IMPORT, which a rename cannot
 *      hide, and the floor is the exact count.
 *   2. *Keep the seam, bypass it at one call site.* `defillama` awaits the limiter in three places;
 *      changing one of them to `await productionThrottle(…)` satisfied both the declaration and the
 *      resolution check while putting that path back on the shared bucket — the literal "seam is
 *      decoration" failure this gate's own message claims to prevent. The singleton alias may now
 *      appear only on the resolution line.
 */

const adaptersDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/adapters');

/** Strips line comments and block-comment bodies, so a docstring can neither satisfy nor trip a
 * check about executable code. */
const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** `<adapter id> -> concatenated source of every `.ts` file directly inside its directory. */
function adapterSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const entry of readdirSync(adaptersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(adaptersDir, entry.name);
    const text = readdirSync(dir)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => codeOnly(readFileSync(path.join(dir, file), 'utf8')))
      .join('\n');
    sources.set(entry.name, text);
  }
  return sources;
}

const SOURCES = adapterSources();

/**
 * Membership: the adapter IMPORTS the limiter module. Keyed on the import rather than on a call
 * spelling because a local rename must not be able to remove an adapter from the checked set.
 */
const IMPORTS_LIMITER = /from '(?:\.\.\/)+net\/rate-limit\.js'/;
/** Declares the injection seam on its own `*AdapterDeps` (or `*Deps`) interface. */
const DECLARES_SEAM = /throttle\?:\s*Throttle;/;
/** Resolves it with the production singleton as the default, rather than ignoring what was passed. */
const RESOLVES_SEAM = /deps\.throttle\s*(\?\?|\?)/;
/**
 * Every LOCAL BINDING the adapter gives the limiter module, whatever it calls them — cycle 2 defeated
 * the previous version by adding a second import under a different alias
 * (`import { throttle as sharedLimiter } …; await sharedLimiter(...)`), which satisfied the
 * declaration and resolution checks while putting that call back on the shared bucket. Keying on one
 * hard-coded spelling was the same mistake as keying membership on one, one cycle later.
 */
const IMPORT_BINDINGS = /import\s*\{([^}]*)\}\s*from\s*'(?:\.\.\/)+net\/rate-limit\.js'/g;
/** `throttle as productionThrottle, type Throttle` → the value bindings, dropping `type` imports. */
function limiterBindings(text: string): string[] {
  return [...text.matchAll(IMPORT_BINDINGS)].flatMap((match) =>
    (match[1] as string)
      .split(',')
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0 && !clause.startsWith('type '))
      .map((clause) => (clause.split(/\s+as\s+/).pop() as string).trim()),
  );
}

/** Exactly the adapters that reach a rate-limited host. The other three (`dash-platform`, `dune`,
 * `pg-history`) never import the limiter: two are M1 stubs and one speaks Postgres. */
const THROTTLING = [...SOURCES].filter(([, text]) => IMPORTS_LIMITER.test(text));

describe('every throttling adapter exposes an injectable throttle (WI-26)', () => {
  it('found the adapter sources at all — otherwise everything below is vacuous', () => {
    expect(SOURCES.size).toBe(12);
    // The EXACT count, not a floor. A floor absorbs a silent dropout, which is precisely how the
    // first version of this gate could have been defeated by renaming one local binding.
    expect(
      THROTTLING.map(([id]) => id).sort(),
      'The set of limiter-importing adapters changed. If an adapter was added, it belongs here; if ' +
        'one stopped importing the limiter, say why in this list rather than letting the gate ' +
        'quietly check one fewer.',
    ).toStrictEqual([
      'blockchain-info',
      'blockscout',
      'coingecko',
      'defillama',
      'dexscreener',
      'nansen',
      'platform-explorer',
      'rpc-evm',
      'rpc-solana',
    ]);
  });

  it.each([...SOURCES.keys()].sort())('%s', (adapter) => {
    const text = SOURCES.get(adapter) as string;
    if (!IMPORTS_LIMITER.test(text)) return; // does not throttle — nothing to inject

    expect(
      DECLARES_SEAM.test(text),
      `${adapter} imports the limiter but its deps declare no \`throttle?: Throttle\`. Every test ` +
        "driving it then shares the production singleton's bucket, and the file's runtime starts " +
        'depending on what else ran in the process.',
    ).toBe(true);

    expect(
      RESOLVES_SEAM.test(text),
      `${adapter} declares \`throttle?: Throttle\` but never reads \`deps.throttle\` — the seam is ` +
        'decoration: a caller passing a throttle would be silently ignored.',
    ).toBe(true);

    // The seam can be declared, resolved, and then bypassed at one call site out of three. So: for
    // EVERY name this adapter imports the limiter under, the only legitimate use is the
    // `deps.throttle ?? <name>` resolution. Any other use is a call that ignores what the caller
    // injected. Derived from the import, so a rename or a second alias cannot hide it.
    const bypasses = limiterBindings(text).flatMap((binding) => {
      const uses = (text.match(new RegExp(`\\b${binding}\\b`, 'g')) ?? []).length;
      const declaration = (
        text.match(
          new RegExp(`\\bas\\s+${binding}\\b|\\{[^}]*\\b${binding}\\b[^}]*\\}\\s*from`, 'g'),
        ) ?? []
      ).length;
      const resolution = (
        text.match(new RegExp(`deps\\.throttle\\s*\\?\\?\\s*${binding}\\b`, 'g')) ?? []
      ).length;
      return uses - declaration - resolution > 0
        ? [`${binding} (${uses - declaration - resolution} extra use(s))`]
        : [];
    });
    expect(
      bypasses.sort(),
      `${adapter} uses a limiter binding somewhere other than its import and its ` +
        '`deps.throttle ?? <binding>` resolution — i.e. at least one call site bypasses the seam ' +
        'and goes straight to the shared process bucket.',
    ).toStrictEqual([]);
  });
});
