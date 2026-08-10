import { checkDashHistory, dashHistoryCatches } from './shared/dash-history.mjs';

// T-013 — the sibling of `privacy.shielded_pool.history`: same tool, different `series` selector,
// therefore a separate request and a separate coverage row. Same expectation, imported rather than
// copied.
export default {
  capability: 'platform.metrics.history',
  args: (chain) => ({ chain, series: 'platform_metrics', limit: 20 }),
  catches: dashHistoryCatches,
  check: checkDashHistory,
};
