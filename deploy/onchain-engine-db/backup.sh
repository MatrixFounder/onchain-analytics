#!/bin/sh
# Regular backup of the engine's own Postgres (WI-62 follow-up; deployment.md §10.9.1).
#
# WHY THIS EXISTS AND THE ROLLBACK ARTIFACT DOES NOT COVER IT. Task 015-26 took ONE dump, before the
# migration, retained 30 days. After task 015-27 dropped the thirteen tables in the old container,
# that artifact became the only copy of `api_tokens.token_hash`, `access_profiles.credits_balance_raw`
# and the whole billing ledger — and it holds the state BEFORE the move. Every row written since is
# single-copy. The plan says so in as many words: "регулярную копию план не заводит."
#
# WHY THE WHOLE SCHEMA AND NOT A TABLE LIST. This is the lesson of 015-26, and it cost a measurement
# to learn: a table-scoped `pg_dump` carries no schema-level objects. The restore came back with the
# rows intact and `access_audit` UPDATABLE — triggers 0, functions 0 — while `pg_restore` exited 0.
# `--schema=onchain` carries the triggers, rules, functions and grants that make the audit journal
# append-only. The check below asserts it did, rather than trusting the flag.
#
# WHAT THIS DELIBERATELY DOES NOT DO. It does not copy the dump OFF the VM. That would need a
# scheduled job on the operator's machine, which this project does not allow, so the off-host step
# is a manual runbook item and is honest about being one. A copy that lives on the machine it
# protects survives a dropped table and not a dead host.
#
# Usage:
#   backup.sh --once     take one backup, verify it, rotate, exit
#   backup.sh --loop     the same, immediately and then every ONCHAIN_BACKUP_INTERVAL_S
#
# Environment (the compose service supplies all of it):
#   POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB   from the VM-local env_file
#   PGHOST                        the db service name on the compose network
#   ONCHAIN_BACKUP_DIR            where dumps land (a bind mount from the VM host)
#   ONCHAIN_BACKUP_KEEP           how many dumps to keep
#   ONCHAIN_BACKUP_INTERVAL_S     seconds between runs in --loop

set -eu

DIR="${ONCHAIN_BACKUP_DIR:-/backups}"
KEEP="${ONCHAIN_BACKUP_KEEP:-14}"
INTERVAL="${ONCHAIN_BACKUP_INTERVAL_S:-86400}"
LOG="$DIR/backup.log"
PREFIX="onchain-engine"

export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set}"
export PGHOST="${PGHOST:-db}"
export PGUSER="${POSTGRES_USER:?POSTGRES_USER is not set}"
export PGDATABASE="${POSTGRES_DB:?POSTGRES_DB is not set}"

# One line per run, appended, including a run that changed nothing — the project's "ничего молча"
# rule applied to this job. The log lives BESIDE the dumps rather than in the database, because a
# backup journal stored inside the thing being backed up is unreadable exactly when it is needed.
log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

# The counts the LIVE database reports, so the dump is checked against reality rather than against a
# number typed into this file. A hardcoded expectation is the defect this project keeps paying for:
# it goes stale silently and then agrees with whatever it finds.
live_count() {
  psql -qtAX -c "$1" 2>/dev/null | tr -d ' \n'
}

take_one() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$DIR/${PREFIX}-${stamp}.dump"
  part="$out.part"

  # Written to `.part` and renamed only after it verifies. A half-written file that carries the
  # final name is worse than no file: rotation would count it as a good copy and delete a real one.
  if ! pg_dump --schema=onchain --format=custom --file="$part" 2>"$part.err"; then
    log "FAIL pg_dump: $(tr '\n' ' ' <"$part.err" | cut -c1-300)"
    rm -f "$part" "$part.err"
    return 1
  fi
  rm -f "$part.err"

  # `pg_dump` exiting 0 is not proof the file can be read back. Listing the archive's table of
  # contents parses the whole header and every entry — cheap, and it catches truncation and
  # corruption, which is what a backup fails at in practice.
  if ! toc="$(pg_restore --list "$part" 2>&1)"; then
    log "FAIL pg_restore --list rejected the archive: $(printf '%s' "$toc" | tr '\n' ' ' | cut -c1-300)"
    rm -f "$part"
    return 1
  fi

  # THE 015-26 CHECK, made mechanical. Each kind is compared against what the live schema holds, so
  # losing a guard shows up as a mismatch rather than as a smaller number nobody reads.
  d_tables=$(printf '%s\n' "$toc" | grep -c ' TABLE onchain ' || true)
  d_data=$(printf '%s\n' "$toc" | grep -c ' TABLE DATA onchain ' || true)
  d_trig=$(printf '%s\n' "$toc" | grep -c ' TRIGGER onchain ' || true)
  d_rule=$(printf '%s\n' "$toc" | grep -c ' RULE onchain ' || true)
  d_func=$(printf '%s\n' "$toc" | grep -c ' FUNCTION onchain ' || true)

  l_tables=$(live_count "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='onchain' AND c.relkind='r'")
  l_trig=$(live_count "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='onchain' AND NOT t.tgisinternal")
  l_rule=$(live_count "SELECT count(*) FROM pg_rules WHERE schemaname='onchain'")
  l_func=$(live_count "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='onchain'")

  mismatch=''
  [ "$d_tables" = "$l_tables" ] || mismatch="$mismatch tables=$d_tables/live=$l_tables"
  [ "$d_data" = "$l_tables" ] || mismatch="$mismatch tabledata=$d_data/live=$l_tables"
  [ "$d_trig" = "$l_trig" ] || mismatch="$mismatch triggers=$d_trig/live=$l_trig"
  [ "$d_rule" = "$l_rule" ] || mismatch="$mismatch rules=$d_rule/live=$l_rule"
  [ "$d_func" = "$l_func" ] || mismatch="$mismatch functions=$d_func/live=$l_func"

  if [ -n "$mismatch" ]; then
    # Kept, not deleted: a dump that disagrees with the schema is evidence, and the next run's
    # rotation must not be the thing that destroys it. The name says what it is.
    mv "$part" "$out.MISMATCH"
    log "FAIL dump does not match the live schema —$mismatch; kept as $(basename "$out").MISMATCH"
    return 1
  fi

  mv "$part" "$out"
  # 0600: the archive carries `api_tokens.token_hash` and `access_profiles.credits_balance_raw`.
  # Digests are not tokens, but with the pepper known they are material to grind against.
  chmod 600 "$out"
  bytes=$(wc -c <"$out" | tr -d ' ')
  log "OK $(basename "$out") bytes=$bytes tables=$d_tables data=$d_data triggers=$d_trig rules=$d_rule functions=$d_func"
}

rotate() {
  # Newest KEEP survive. Only OUR prefix is listed, so the 015-26 rollback artifact and anything an
  # operator parked here by hand are out of this job's reach by construction.
  total=$(find "$DIR" -maxdepth 1 -name "${PREFIX}-*.dump" | wc -l | tr -d ' ')
  if [ "$total" -le "$KEEP" ]; then
    log "rotate kept=$total limit=$KEEP removed=0"
    return 0
  fi
  removed=0
  # shellcheck disable=SC2012 — names are ours and timestamped, so a lexical sort is a time sort.
  for old in $(ls -1 "$DIR"/${PREFIX}-*.dump | sort | head -n "$((total - KEEP))"); do
    rm -f "$old" && removed=$((removed + 1))
  done
  log "rotate kept=$((total - removed)) limit=$KEEP removed=$removed"
}

run() {
  if take_one; then rotate; else return 1; fi
}

case "${1:---once}" in
  --once)
    run
    ;;
  --loop)
    # A fixed interval rather than a wall-clock time: the container may restart, and re-deriving
    # "next 03:00" after every restart is more machinery than a dev VM's daily copy is worth. The
    # drift is real and the log records the actual instant of every run, so it is visible.
    log "loop starting interval=${INTERVAL}s keep=$KEEP dir=$DIR"
    while true; do
      run || log "run failed; continuing — the next attempt is in ${INTERVAL}s"
      sleep "$INTERVAL"
    done
    ;;
  *)
    echo "usage: backup.sh [--once|--loop]" >&2
    exit 2
    ;;
esac
