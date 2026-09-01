// Loader for the atomic eval cases — the file that makes the capability axis stop being
// hand-written.
//
// WHY A DIRECTORY AND NOT A LIST. The capability axis used to be a literal array in
// `capabilities.mjs`, and its per-tool assertions a second literal object in `checks.mjs`. That
// shape has a recorded failure: `dex.volume.history` shipped, neither literal grew, and the live
// eval showed nothing at all for it — not a failure, not a `no-probe` row, no trace, while a green
// run read as "the free contour is verified" (RF-5). A list you must remember to edit is a list
// that eventually disagrees with reality.
//
// Here a case is a FILE. Adding coverage means adding one file that carries its own request, its
// own expectation and its own assertion; there is no shared list to forget. Discovery is a
// directory read, so the axis cannot silently fail to grow.
//
// WHAT A CASE FILE LOOKS LIKE (default export):
//
//   TRANSPORT CASE CONTEXT (task 015-29 added the last three fields):
//     baseUrl, token, request, openSession — the raised profile, its token, one HTTP call, a session
//     dataDir       — this phase's temporary DATA_DIR; the SQLite axis keeps `cache.sqlite3` there
//     stdioDataDir  — the CAPABILITY phase's DATA_DIR, so a case can compare a local principal's
//                     ledger rows against an authenticated one (AC-28). It outlives this phase by
//                     the runner's existing order, not by anything held open here
//     storage       — the raised profile's axis, `'postgres'` or `'sqlite'`. A reader wired to a
//                     FILENAME reads empty on `network` (cache and budget both go to Postgres there)
//                     and the case then asserts against its own zero
//     stateDsn      — the phase's ONE declared Postgres target. A case must not read
//                     `process.env` for it: the server and both `admin()` calls were given this
//                     value, and reaching past it can read a different database than the run wrote
//
//   capability cases — one per capability the registry can declare:
//     { capability: 'chain.tvl',
//       args: (chain, probe) => ({ chain }) | null,   // null => "no probe input curated"
//       catches: 'the vendor drift this case exists to catch',
//       check: (structured) => string[] }             // [] means ok
//
//   bootstrap cases — the two rows that are not per-chain (the server answering at all, and the
//   registry loading). They name a tool directly because no capability describes them:
//     { tool: 'onchain_ping', kind: 'bootstrap', catches: '...', check: (structured) => [...] }
//
//   transport cases — rows that are not about a capability at all, but about the TRANSPORT in front
//   of it: a token refused, a perimeter refused, one end-to-end call, two sessions sharing a vendor
//   quota (task 014-33). They carry no tool and no capability:
//     { kind: 'transport', transport: 'http', catches: '...',
//       exercise: (ctx) => observation,     // issues the requests against a raised profile
//       check: (observation) => string[] }  // [] means ok
//
//   WHY A THIRD KIND AND NOT A BOOTSTRAP IN DISGUISE. `indexByTool` in `../checks.mjs` keys cases by
//   tool and refuses two cases claiming one tool with different `check` functions, so an
//   `http-success` case naming `onchain_ping` would collide with `bootstrap-ping.mjs` at import. And
//   a bootstrap `check` receives `structuredContent`, which a request refused by the token or by the
//   perimeter never has — so neither refusal case could present the status and header it observed.
//   The capability shape does not fit either: `toolFor` resolves a capability through the generated
//   inventory and throws on an unknown one, and `auth-rejected` is a capability of no registry.
//
//   The report label comes from the FILE NAME: `http-auth-rejected.mjs` reports as
//   `transport:http-auth-rejected`, keyed `—/transport:http-auth-rejected`. A transport row is
//   therefore nameable in `eval/acknowledged.json` without a second source for its name.
//
// The tool for a capability case is NOT written here. It is resolved from the generated
// `tool-inventory.json` (R-117): a hand-written tool name is a second source for a fact the build
// already owns, and it survives a rename that the inventory would have caught.
//
// Top-level await is deliberate: it blocks the module graph until every case is loaded, so
// importers see a fully built list and stay synchronous. Keeping this module import-only — no
// server, no network — is what lets the offline test suite read the axis.

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const casesDir = path.dirname(fileURLToPath(import.meta.url));

/** Every `*.mjs` in this directory except this loader, in stable alphabetical order. */
function caseFiles() {
  return readdirSync(casesDir)
    .filter((f) => f.endsWith('.mjs') && f !== 'index.mjs')
    .sort();
}

/**
 * Refuses a malformed case at import time rather than at run time.
 *
 * A case that loads but cannot assert anything is the exact hazard `grade()` was hardened against
 * (TASK-011, R-118): the eval calls the tool, grades whatever comes back as fine, and the harness
 * reports coverage it does not have. Throwing here means `pnpm test` fails offline instead.
 */
function validate(file, mod) {
  const c = mod?.default;
  const where = `eval/cases/${file}`;
  if (!c || typeof c !== 'object') throw new Error(`${where}: no default-exported case object`);
  if (typeof c.check !== 'function') throw new Error(`${where}: case.check must be a function`);
  if (typeof c.catches !== 'string' || c.catches.trim() === '') {
    throw new Error(
      `${where}: case.catches must say what vendor drift this case exists to catch — ` +
        'a case that cannot state that is decoration',
    );
  }
  if (c.kind === 'transport') {
    if (typeof c.transport !== 'string' || c.transport.trim() === '') {
      throw new Error(`${where}: a transport case must name its transport`);
    }
    if (typeof c.exercise !== 'function') {
      throw new Error(`${where}: a transport case must carry an exercise(ctx) function`);
    }
    // `check` and `catches` were already required above, for EVERY kind. A transport case that
    // asserts nothing is refused by the same two lines that refuse a capability case that does.
    return { ...c, file, kind: 'transport', label: `transport:${file.replace(/\.mjs$/, '')}` };
  }
  const isBootstrap = c.kind === 'bootstrap';
  if (isBootstrap) {
    if (typeof c.tool !== 'string' || !c.tool) {
      throw new Error(`${where}: a bootstrap case must name its tool`);
    }
  } else {
    if (typeof c.capability !== 'string' || !c.capability) {
      throw new Error(`${where}: a capability case must name its capability`);
    }
    if (typeof c.args !== 'function') {
      throw new Error(`${where}: a capability case must carry an args(chain, probe) builder`);
    }
  }
  return { ...c, file, kind: isBootstrap ? 'bootstrap' : 'capability' };
}

const loaded = [];
for (const file of caseFiles()) {
  const mod = await import(new URL(file, import.meta.url).href);
  loaded.push(validate(file, mod));
}

/** Every case, both kinds, in file order. */
export const CASES = loaded;

/** Cases exercised per chain, keyed by the capability the registry declares. */
export const CAPABILITY_CASES = loaded.filter((c) => c.kind === 'capability');

/** The two non-per-chain rows: the server answering, and the registry loading. */
export const BOOTSTRAP_CASES = loaded.filter((c) => c.kind === 'bootstrap');

/** The rows about the TRANSPORT in front of the capabilities, not about a capability (task 014-33). */
export const TRANSPORT_CASES = loaded.filter((c) => c.kind === 'transport');

/**
 * The validator itself, exported so the offline suite can prove it REFUSES.
 *
 * **Why the function and not the directory.** The proof needed is "an incomplete case does not
 * load", and a file carrying an incomplete case, placed in this directory, would throw at import
 * for every consumer — the suite, the runner, both coverage tests. So the test hands objects to
 * this function instead of writing them to disk.
 */
export { validate as validateCase };
