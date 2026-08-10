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
