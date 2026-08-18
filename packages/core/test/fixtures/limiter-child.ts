/**
 * One OS process taking slots from a shared bucket — the child half of TC-E2E-01 and TC-E2E-02
 * (task 014-18, AC-4/AC-5 on the SQLite axis).
 *
 * **Why a real process and not a second connection in the test's own.** AC-4 is a claim about two
 * processes, and SQLite's write lock is a POSIX advisory lock on a file: whether it serializes two
 * connections inside one process and whether it serializes two processes are, strictly, two
 * measurements. This one is the measurement AC-4 names.
 *
 * **The clock is an argument, so the test is deterministic across the boundary.** Both children are
 * handed the SAME `nowMs`, so the refill term is zero however the two interleave, and the admitted
 * count is decided by the bucket alone. That is possible only because `LimiterStore.take` takes the
 * instant as a parameter rather than sampling one — see the interface's own note on why.
 *
 * Prints one JSON line on stdout: the tokens left after each take, in order.
 */
import { createSqliteLimiterStore } from '../../src/cache/limiter-store.js';

const [dbPath, provider, capacity, refillPerSec, weight, count, nowMs] = process.argv.slice(2);

async function main(): Promise<void> {
  const store = createSqliteLimiterStore({ dbPath: String(dbPath) });
  const config = { capacity: Number(capacity), refillPerSec: Number(refillPerSec) };
  const takes: number[] = [];
  for (let i = 0; i < Number(count); i += 1) {
    const take = await store.take(
      { providerId: String(provider), scopeKey: '' },
      config,
      Number(weight),
      Number(nowMs),
    );
    takes.push(take.tokensLeft);
  }
  store.close();
  process.stdout.write(`${JSON.stringify({ takes })}\n`);
}

void main();
