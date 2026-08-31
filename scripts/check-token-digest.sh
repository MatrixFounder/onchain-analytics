#!/usr/bin/env sh
# Does a token in hand still resolve to the row on record? (T-015 task 015-25, AC-44.)
#
# Answers three questions and prints NOTHING ELSE: how long the value read was, whether its prefix
# is the one stored, and whether sha256(pepper || token) equals the stored digest. The token, the
# pepper and the digest never reach the screen.
#
#   ./scripts/check-token-digest.sh                     # digest from the engine container
#   ENGINE_CONTAINER=supabase-db ENGINE_PSQL_USER=supabase_admin ./scripts/check-token-digest.sh
#
# WHY A FILE AND NOT A COMMAND TO PASTE. A block containing an interactive `read` cannot be pasted:
# the paste itself becomes the input, so `read` consumes the NEXT LINE of the block as the token and
# the remaining lines execute as commands. Run from a file, `read` takes the terminal.
#
# WHY `printf` AND A BARE `read -rs`. `read -rs -p 'token: '` is a bashism; in zsh `-p` means "read
# from the coprocess" and fails with `read: -p: no coprocess`, leaving the variable UNSET — after
# which every comparison below answers `false` about the empty string. That is a check failing for
# the wrong reason, which is indistinguishable from a real answer. Hence the guards.
set -eu

ENGINE_CONTAINER="${ENGINE_CONTAINER:-onchain-engine-db}"
ENGINE_PSQL_USER="${ENGINE_PSQL_USER:-postgres}"

printf 'token: '
stty -echo 2>/dev/null || true
read -r TOKEN
stty echo 2>/dev/null || true
printf '\n'

EXPECTED=$(ssh vm "docker exec -i ${ENGINE_CONTAINER} psql -qtA -U ${ENGINE_PSQL_USER} -d postgres \
  -c \"SELECT token_hash FROM onchain.api_tokens\"" | tr -d '[:space:]')
PREFIX=$(ssh vm "docker exec -i ${ENGINE_CONTAINER} psql -qtA -U ${ENGINE_PSQL_USER} -d postgres \
  -c \"SELECT prefix FROM onchain.api_tokens\"" | tr -d '[:space:]')

TOKEN="$TOKEN" EXPECTED="$EXPECTED" PREFIX="$PREFIX" node -e '
  process.loadEnvFile();
  const { createHash } = require("node:crypto");
  const token = process.env.TOKEN ?? "";
  const expected = process.env.EXPECTED ?? "";
  const prefix = process.env.PREFIX ?? "";
  const pepper = process.env.ONCHAIN_TOKEN_HASH_SALT;

  // Refuse rather than answer about an input that was never supplied. Each refusal names the ONE
  // thing missing, so the reader is not left choosing among four explanations for one "false".
  const refuse = (why) => { console.log("REFUSED:", why); process.exit(1); };
  if (!token) refuse("nothing was read into the token variable");
  if (!pepper) refuse("ONCHAIN_TOKEN_HASH_SALT is not set — run this from the repository root");
  if (expected.length !== 64) refuse("no 64-character digest came back from the container");
  if (!prefix) refuse("no prefix came back from the container");

  const digest = createHash("sha256").update(pepper + token, "utf8").digest("hex");
  console.log("token length                :", token.length);
  console.log("prefix is the one on record :", token.slice(0, prefix.length) === prefix);
  console.log("digest matches the row      :", digest === expected);
'
