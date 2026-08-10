import { checkDashHistory, dashHistoryCatches } from './shared/dash-history.mjs';

// T-013 — one of two capabilities served by the same tool, which resolves ONE of them per call and
// picks it by the `series` selector. Free on both participants (`platform-explorer`, `pg-history`),
// so exercising it live spends nothing; that is why it is wired rather than excluded. Probed only
// where the registry declares it, which today is `dash` alone.
export default {
  capability: 'privacy.shielded_pool.history',
  args: (chain) => ({ chain, series: 'shielded_pool', limit: 20 }),
  catches: dashHistoryCatches,
  check: checkDashHistory,
};
