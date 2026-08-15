#!/usr/bin/env tsx
import { createStateClient } from '@onchain-intel/core';
import { createTokenStore } from '../auth/token-store.js';
import { createUserStore } from '../auth/user-store.js';
import { createEngineStore } from '../engine/pg-engine-store.js';
import { loadEnv, toProcessEnv } from '../env.js';
import { runAdminCommand } from './cli.js';

/**
 * The executable behind the four admin operations — the only place `cli.ts`'s output is printed.
 *
 * **Why the wiring is here and the logic is next door.** `runAdminCommand` returns its lines, so
 * every assertion about what an operator sees is made without capturing a stream. This file is the
 * part a test cannot make claims about: reading the environment, opening the write client, exiting.
 *
 * **Why it refuses without a DSN and without a pepper.** Both failures are silent otherwise. A
 * missing DSN would surface as a connection error mid-command, after the operator believed the tool
 * was working; a missing pepper would digest without one, seeding rows the running server — which
 * has a pepper — can never match.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const raw = toProcessEnv(env);

  const dsn = env.ONCHAIN_STATE_PG_URL;
  if (dsn === undefined) {
    console.error(
      "onchain-admin: ONCHAIN_STATE_PG_URL is not set. These operations write the engine's own state (deployment.md §10.5).",
    );
    process.exit(2);
  }
  const pepper = env.ONCHAIN_TOKEN_HASH_SALT;
  if (pepper === undefined) {
    console.error(
      'onchain-admin: ONCHAIN_TOKEN_HASH_SALT is not set. Set the SAME value the server runs with, or every row written here is unmatchable.',
    );
    process.exit(2);
  }

  const engine = createEngineStore(createStateClient({ env: raw }));
  const available = engine.isAvailable();
  if (!available.ok) {
    console.error(`onchain-admin: ${available.reason}`);
    process.exit(2);
  }

  const now = (): number => Date.now();
  const result = await runAdminCommand(process.argv.slice(2), {
    users: createUserStore({ engine, now }),
    tokens: createTokenStore({ engine, pepper, now }),
    engine,
    now,
  });

  for (const line of result.lines) console.log(line);
  process.exit(result.code);
}

await main();
