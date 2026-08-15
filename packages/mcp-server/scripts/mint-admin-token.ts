#!/usr/bin/env tsx
/**
 * Mints the first admin's token and prints the five parameters `003_seed_engine_admin.sql` takes.
 *
 * **Why a script and not five hand-assembled values.** The seed needs a token in the exact form
 * `security.md` §7.5.2 defines, its leading 11 characters, `sha256(pepper || token)` as lowercase
 * hex, and two ULIDs — and SQL has no ULID generator while a shell has neither that nor a reason to
 * grow one. Assembling them by hand is five chances to mis-copy a value whose only failure mode is a
 * seeded row the running server can never match. This calls the SAME functions the server does, so
 * the token it mints is one the server parses and the digest it prints is one `lookup` will find.
 *
 * **What reaches disk: nothing.** The token is written to stdout once and never stored — that is the
 * whole point of seeding a digest. Redirecting this output to a file puts a working credential on
 * disk, which the runbook says not to do and this script cannot prevent.
 *
 * **The pepper must already be set** in the environment this runs in, and it must be the SAME value
 * the server will run with: it enters the digest here and again on every verification. A different
 * pepper on the server makes the seeded row unmatchable, with no error anywhere — the token is
 * simply never found.
 *
 * Usage:
 *   ONCHAIN_TOKEN_HASH_SALT=... pnpm --filter @onchain-intel/mcp-server exec tsx \
 *     scripts/mint-admin-token.ts you@example.com
 */
import { mintToken, tokenDigest, TOKEN_PREFIX_LENGTH } from '../src/auth/token-store.js';
import { ulid } from '../src/ulid.js';

const email = process.argv[2];
const pepper = process.env['ONCHAIN_TOKEN_HASH_SALT'] ?? '';

if (email === undefined || !email.includes('@')) {
  console.error('usage: tsx scripts/mint-admin-token.ts <admin-email>');
  process.exit(2);
}
if (pepper.trim() === '') {
  // Refusing rather than minting with an empty pepper: the digest would be a plain sha256, and the
  // row would be seeded under a value the server — which does have a pepper — cannot reproduce.
  console.error(
    'ONCHAIN_TOKEN_HASH_SALT is not set. Set the SAME value the server will run with, or the seeded row is unmatchable.',
  );
  process.exit(2);
}

const token = mintToken();
const now = Date.now();
const parameters = {
  ADMIN_EMAIL: email.toLowerCase(),
  ADMIN_TOKEN_SHA256: tokenDigest(pepper, token),
  ADMIN_TOKEN_PREFIX: token.slice(0, TOKEN_PREFIX_LENGTH),
  ADMIN_USER_ID: ulid(now),
  ADMIN_TOKEN_ID: ulid(now),
};

console.log('── the token, shown once — copy it into your password manager now ──');
console.log(token);
console.log('');
console.log('── the seed parameters; none of them is the token ──');
const flags = Object.entries(parameters)
  .map(([key, value]) => `-v ${key}=${value}`)
  .join(' \\\n    ');
console.log(
  `ssh vm 'docker exec -i supabase-db psql -qU supabase_admin -d postgres -v ON_ERROR_STOP=1 \\\n    ${flags}' \\\n  < sql/migrations/003_seed_engine_admin.sql`,
);
