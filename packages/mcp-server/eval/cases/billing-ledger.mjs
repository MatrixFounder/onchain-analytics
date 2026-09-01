// Transport case — the billing ledger, both phases, hit and miss (task 015-29, AC-28, AC-28b).
//
// ONE file asserts BOTH halves because the criterion is a COMPARISON. AC-28 is not "the local phase
// writes rows" and "the network phase writes rows" side by side; it is that revenue and internal
// consumption land in the same table and are told apart by `principal_id` and `access_profile_id`
// (R-7.5). Split across two files, each half would pass while the distinction it exists to make
// went unchecked.
//
// The second claim is AC-28b: a cache HIT is charged the SAME as a miss. A hit costs the vendor
// nothing and the client the full price (R-2.2) — there is no discount, and the shape of the defect
// would be a ledger that silently rewards a repeat.
//
// WHY THE LEDGER AND NOT `_meta.cache`. `_meta` says where the answer came from; the question here
// is whether a charge was RECORDED. Two different facts, and the first is already covered by other
// cases.
//
// The calls go to a free, keyless capability. The gate spends no Nansen credits.

import { httpStore, readClientUsage, stdioStore } from './shared/ledger-reader.mjs';

const TOOL = 'onchain_chain_tvl';
const CHAIN = 'ethereum';

export default {
  kind: 'transport',
  transport: 'http',
  catches:
    'a cache hit charged less than a miss or not charged at all, a reservation left open instead ' +
    'of settled, and revenue rows that cannot be told from internal consumption — the failures ' +
    'that make the ledger disagree with what was actually served',
  exercise: async (ctx) => {
    const session = await ctx.openSession();
    try {
      // The SAME argument twice: the first call is a miss, the second is answered from cache. Both
      // are charged, and that equality is the claim.
      const first = await session.callTool(TOOL, { chain: CHAIN });
      const second = await session.callTool(TOOL, { chain: CHAIN });

      const http = httpStore(ctx);
      const stdio = stdioStore(ctx);
      const httpRows = await readClientUsage(http.storage, http.location);

      // The capability phase ran on the LOCAL profile, over stdio, with no token at all. Its rows
      // are what "internal consumption" looks like, and reading them here is the only place in the
      // run where the two shapes can be compared against each other.
      let stdioRows = null;
      let stdioError = null;
      try {
        stdioRows = await readClientUsage(stdio.storage, stdio.location);
      } catch (error) {
        stdioError = String(error?.message ?? error);
      }

      return {
        storage: ctx.storage,
        firstServed: !first.error,
        secondServed: !second.error,
        httpRows: httpRows.filter((r) => r.tool === TOOL),
        stdioRows,
        stdioError,
      };
    } finally {
      await session.close();
    }
  },
  check: (r) => {
    const problems = [];
    if (!r?.firstServed)
      problems.push('the first call was refused; nothing was charged to compare');
    if (!r?.secondServed)
      problems.push('the second call was refused; the cache hit was not served');

    const rows = r?.httpRows ?? [];
    if (rows.length < 2) {
      problems.push(`expected two ledger rows for ${TOOL}, found ${String(rows.length)}`);
    }

    const open = rows.filter((x) => x.state !== 'settled');
    if (open.length > 0) {
      problems.push(
        `every row must be settled after a served call; found ${String(open.length)} in ` +
          `${[...new Set(open.map((x) => String(x.state)))].join(', ')}`,
      );
    }

    // AC-28b — the hit and the miss carry the SAME exact price. Compared as STRINGS: `price_raw` is
    // the canonical exact value and a numeric comparison would be the very lossiness the column
    // exists to avoid (DB-SCHEMA §1 item 7).
    const prices = [...new Set(rows.map((x) => String(x.price_raw)))];
    if (rows.length >= 2 && prices.length !== 1) {
      problems.push(
        `a cache hit must cost the same as a miss; prices differ: ${prices.join(' vs ')}`,
      );
    }

    // AC-28 — the two shapes, told apart by the pair R-7.5 names.
    const local = rows.filter((x) => x.principal_id === 'local');
    if (local.length > 0) {
      problems.push(
        `${String(local.length)} authenticated row(s) carry principal_id='local' — revenue is ` +
          'indistinguishable from internal consumption',
      );
    }
    if (rows.length > 0 && rows.some((x) => !x.access_profile_id)) {
      problems.push('an authenticated row carries no access_profile_id');
    }

    if (r?.stdioError) {
      problems.push(`the capability phase's ledger could not be read: ${r.stdioError}`);
    } else {
      const stdioRows = r?.stdioRows ?? [];
      const wrongPrincipal = stdioRows.filter((x) => x.principal_id !== 'local');
      if (wrongPrincipal.length > 0) {
        problems.push(
          `${String(wrongPrincipal.length)} local-phase row(s) do not carry principal_id='local'`,
        );
      }
      const wrongProfile = stdioRows.filter((x) => x.access_profile_id);
      if (wrongProfile.length > 0) {
        problems.push(
          `${String(wrongProfile.length)} local-phase row(s) carry an access_profile_id; the ` +
            'local transport has no profile to charge',
        );
      }
    }
    return problems;
  },
};
