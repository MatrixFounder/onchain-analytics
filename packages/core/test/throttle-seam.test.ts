import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adapterRegistrations } from '../src/providers.config.js';

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

/** Exactly the adapters that pace their traffic. The other two (`dash-platform`, `dune`) never
 * import the limiter, and the gate below derives WHY rather than taking it on trust: both are M1
 * stubs whose `fetch()` throws, so their declared `rateLimit` describes traffic that never happens.
 * (`pg-history` was a third such name until WI-34 — it speaks Postgres rather than HTTP, which is a
 * fact about its transport and was never a reason not to pace.) */
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
      // WI-34 — added the day this adapter stopped declaring a limit it did not apply.
      'pg-history',
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

// =============================================================================================
// WI-34 — a DECLARED rate limit is an APPLIED rate limit
// =============================================================================================

/**
 * The gate above asks "does every adapter that calls the limiter let a test inject one". This one
 * asks the question one step earlier, and it is the question WI-34 is about: **does every adapter
 * that DECLARES a rate limit actually call the limiter at all?**
 *
 * **Why the first gate could not see it, by construction.** Its population is decided by the IMPORT
 * (a deliberate choice — cycle 1 defeated an earlier version by renaming a local binding), so an
 * adapter that never imports the limiter is not in the checked set. `pg-history` declared
 * `{capacity: 2, refillPerSec: 0.2}` and imported nothing, and this gate's own docstring recorded the
 * three non-importers as harmless — true of the two stubs, false of the one available adapter among
 * them. PLAN §0.2a then derived the E-PG call envelope THROUGH that declaration. A second reader of
 * a control that does not exist already existed, and had already been wrong.
 *
 * **Population: every registration, because `rateLimit` is a required field of every registration.**
 * Which makes the exemption the whole design question. WI-34 proposed "a declared list of
 * exceptions — a line somebody writes deliberately". This derives it instead, from the property that
 * actually justifies the exemption: an adapter whose `fetch()` does nothing but throw
 * `NotImplementedInM1Error` generates no traffic, so there is no rate to limit. That is checkable
 * from the source, and it fails CLOSED in the direction that matters — the day a stub grows a real
 * `fetch()`, it stops matching and lands in the population on the same commit, whereas an id on an
 * exception list would sit there silently.
 *
 * **What this deliberately does NOT assert:** that the limiter is called on every PATH through an
 * adapter (`defillama` has three call sites; a fourth added without one would pass here). That is
 * the residual the first gate's `bypasses` check partially covers, and it is stated rather than
 * implied.
 */

/** The adapter imports the shared M1-stub error and its `fetch` does nothing but throw it. */
const IS_M1_STUB =
  /from '(?:\.\.\/)+adapters\/not-implemented-error\.js'|from '\.\.\/not-implemented-error\.js'/;
/** …and the throw is really in `fetch`, not merely somewhere in the file. */
const STUB_FETCH = /fetch:\s*async\s*\([^)]*\)\s*=>\s*\{\s*throw new NotImplementedInM1Error\(/;
/** The local the adapter resolved the seam into — `const <name> = deps.throttle ?? …`. */
const RESOLVED_LOCALS = /const\s+(\w+)\s*=\s*deps\.throttle\s*\?\?/g;

describe('every registration that declares a rateLimit has an adapter that applies it (WI-34)', () => {
  it('the population is the real registration table — otherwise everything below is vacuous', () => {
    expect(adapterRegistrations).toHaveLength(12);
    // `rateLimit` is required on `AdapterRegistration`, so "declares one" is every registration.
    // Asserted rather than assumed: if the field ever became optional, the population of this gate
    // would silently shrink to whoever still filled it in.
    expect(adapterRegistrations.every((r) => r.rateLimit !== undefined)).toBe(true);
    expect([...SOURCES.keys()].sort()).toStrictEqual(adapterRegistrations.map((r) => r.id).sort());
  });

  it('the exemption is DERIVED and lands on exactly the two stubs', () => {
    const exempt = adapterRegistrations
      .map((r) => r.id)
      .filter((id) => {
        const text = SOURCES.get(id) as string;
        return IS_M1_STUB.test(text) && STUB_FETCH.test(text);
      })
      .sort();
    expect(
      exempt,
      'An adapter is excused from applying its declared rate limit only by generating no traffic ' +
        'at all. If this list grew, a real adapter is being read as a stub; if it shrank, a stub ' +
        'grew a fetch() and now owes the limiter a call.',
    ).toStrictEqual(['dash-platform', 'dune']);
  });

  it.each(adapterRegistrations.map((r) => r.id).sort())('%s', (id) => {
    const text = SOURCES.get(id) as string;
    if (IS_M1_STUB.test(text) && STUB_FETCH.test(text)) {
      // The exemption is not taken on trust: a stub that is unreachable is what makes an unapplied
      // limit harmless, so the unreachability is asserted here rather than described above.
      expect(
        /isAvailable:\s*\(\)\s*=>\s*\(\{\s*ok:\s*false/.test(text),
        `${id} is excused from applying its rate limit because it never runs — but its ` +
          'isAvailable() is not unconditionally false, so it CAN be reached.',
      ).toBe(true);
      return;
    }

    expect(
      IMPORTS_LIMITER.test(text),
      `${id}'s registration declares a rateLimit and its adapter never imports the limiter. The ` +
        'declaration then reads as a control that exists — which is how PLAN §0.2a derived a call ' +
        'envelope through a limiter nothing called (WI-34).',
    ).toBe(true);

    // Imported is not applied. Every local the adapter resolved the seam into must be AWAITED
    // somewhere, or the seam is wiring with no consumer. Derived from the resolution line, so a
    // rename cannot drop the adapter out of the check (WI-26 cycle 1's lesson).
    const locals = [...text.matchAll(RESOLVED_LOCALS)].map((match) => match[1] as string);
    expect(
      locals.length,
      `${id} imports the limiter but never resolves \`deps.throttle\``,
    ).toBeGreaterThan(0);
    const applied = locals.filter((local) => new RegExp(`await\\s+${local}\\(`).test(text));
    expect(
      applied,
      `${id} resolves the limiter into ${locals.join(', ')} and never awaits it — the limit is ` +
        'declared in providers.config.ts and applied by nothing.',
    ).not.toStrictEqual([]);
  });

  it('the detectors DETECT — a resolved-but-never-awaited limiter is caught', () => {
    // Positive control for the half that is easy to get wrong: the "applies it" check must fail on
    // an adapter that has the import, the seam and the resolution and simply never calls it. This is
    // the mutation WI-34's acceptance names ("remove the limiter application from any of the nine
    // adapters → red"), run against a literal instead of by editing a real adapter.
    const resolvedNeverAwaited = `import { throttle as productionThrottle } from '../../net/rate-limit.js';
      const throttle = deps.throttle ?? productionThrottle;
      const response = await safeFetch(url, {}, HOSTS, fetchImpl);`;
    const locals = [...resolvedNeverAwaited.matchAll(RESOLVED_LOCALS)].map((m) => m[1] as string);
    expect(locals).toStrictEqual(['throttle']);
    expect(
      locals.filter((l) => new RegExp(`await\\s+${l}\\(`).test(resolvedNeverAwaited)),
    ).toStrictEqual([]);

    // And the control in the other direction, so the check is not simply always red.
    const applied = `${resolvedNeverAwaited}\n await throttle('x', RATE_LIMIT);`;
    expect(
      [...applied.matchAll(RESOLVED_LOCALS)]
        .map((m) => m[1] as string)
        .filter((l) => new RegExp(`await\\s+${l}\\(`).test(applied)),
    ).toStrictEqual(['throttle']);
  });
});
