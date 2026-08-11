import { nonEmpty, positive } from '../case-lib.mjs';

export default {
  capability: 'chain.transactions',
  args: (chain) => ({ chain }),
  catches:
    'Blockscout renaming a stats counter, switching one to a string, or the engine starting to ' +
    'publish the cumulative all-time address count as if it were activity',
  check: (r) => {
    const defects = [
      positive(r?.transactionsPerDay, 'transactionsPerDay'),
      positive(r?.totalTransactions, 'totalTransactions'),
      positive(r?.totalBlocks, 'totalBlocks'),
      nonEmpty(r?.source, 'source'),
    ];

    // An arithmetic cross-check, not a second look at one field: a chain cannot have processed
    // fewer transactions in its whole life than it does in a day. This is what would catch a
    // vendor swapping two counters, which every per-field check passes.
    const perDay = r?.transactionsPerDay;
    const total = r?.totalTransactions;
    if (typeof perDay === 'number' && typeof total === 'number' && perDay > total) {
      defects.push(`transactionsPerDay ${perDay} exceeds totalTransactions ${total}`);
    }

    // WI-51's named gap, asserted as an absence. If a future edit fills `activeAddresses` from the
    // cumulative `total_addresses` — the substitution the record explicitly refused — this fails
    // instead of shipping a plausible number nobody can tell apart from a real one.
    if (r !== null && typeof r === 'object' && 'activeAddresses' in r) {
      defects.push(
        'activeAddresses appeared — no wired provider publishes an activity-scoped count',
      );
    }

    return defects.filter(Boolean);
  },
};
