import { nonEmpty } from '../case-lib.mjs';

export default {
  capability: 'token.holders',
  // TASK-008 — free (`['blockscout']`, `costOf: 0`), so unlike `entity.labels` an eval run of it
  // bills nobody. Needs a curated `token` per chain: a holder list is meaningless without a
  // contract to ask about, and the probe row already carries one for `token.price`. Chains with no
  // curated token report `no-probe` rather than silently vanishing — which is the whole point.
  args: (chain, probe) => (probe.token ? { chain, tokenAddress: probe.token } : null),
  catches:
    'an exact balance arriving as a JSON number, the completeness flags vanishing so a page ' +
    'reads as the whole holder set, and the vendor silently dropping its own ordering',
  check: (r) => {
    const problems = [
      nonEmpty(r?.chain, 'chain'),
      nonEmpty(r?.tokenAddress, 'tokenAddress'),
      nonEmpty(r?.source, 'source'),
    ].filter(Boolean);
    const holders = Array.isArray(r?.holders) ? r.holders : null;
    if (!holders) return [...problems, 'holders is not an array'];
    if (holders.length === 0) {
      // A curated probe token always has holders. An empty list here is either a vendor that
      // stopped answering or a filter that ate every row — both look like success otherwise.
      problems.push('holders is empty for a token curated because it has holders');
    }

    // **The completeness flags are the contract, not decoration.** "50 holders" and "the first
    // 50 of many" are different answers to a concentration question; if either field goes
    // missing, a caller reads a page as the complete set and the mistake is invisible.
    if (typeof r?.truncated !== 'boolean') {
      problems.push('truncated is missing — a page would read as the complete holder set');
    }
    if (!Number.isInteger(r?.droppedRows) || r.droppedRows < 0) {
      problems.push('droppedRows is missing or not a count — holes in the list become invisible');
    } else if (r.droppedRows > 0) {
      problems.push(`droppedRows=${r.droppedRows} — the vendor sent rows we refused to publish`);
    }

    // Exactness is why these are strings. A JSON number here means the value was already spent
    // by the time it reached us: balances routinely exceed 2^53.
    for (const [i, h] of holders.entries()) {
      if (typeof h?.amountRaw !== 'string') {
        problems.push(
          `holders[${i}].amountRaw is ${typeof h?.amountRaw}, not a string — exactness lost`,
        );
        break;
      }
      if (!/^(0|[1-9][0-9]*)$/.test(h.amountRaw)) {
        problems.push(
          `holders[${i}].amountRaw is not a decimal integer string: ${h.amountRaw.slice(0, 32)}`,
        );
        break;
      }
      if (!h?.address) {
        problems.push(`holders[${i}] has no address`);
        break;
      }
    }
    if (problems.length) return problems;

    if (holders.every((h) => h.amountRaw === '0')) {
      problems.push('every holder balance is 0 — a live token never reports this');
    }
    // Documented ordering: descending balance, as the vendor returned them. A vendor that stops
    // sorting still answers HTTP 200, and every "top holders" reading built on it becomes wrong.
    for (let i = 1; i < holders.length; i += 1) {
      if (BigInt(holders[i - 1].amountRaw) < BigInt(holders[i].amountRaw)) {
        problems.push(
          `holders are not in descending balance order at index ${i} — vendor ordering changed`,
        );
        break;
      }
    }
    return problems;
  },
};
