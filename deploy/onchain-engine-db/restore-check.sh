#!/bin/sh
# The restore drill for the engine's backups (WI-62 follow-up; deployment.md §10.9.1).
#
# WHY THIS IS A SEPARATE STEP AND NOT PART OF TAKING THE BACKUP. A dump that verifies its own table
# of contents is a readable file. That is not the same claim as "the data comes back". Task 015-26
# is the measurement that separates the two: `pg_restore` exited 0, the rows were all there, and
# `access_audit` came back UPDATABLE — triggers 0, functions 0 — because the dump had been scoped to
# a table list. Every guard the schema carries was silently absent, and nothing in the exit code
# said so. This script asks the restored database what it actually has.
#
# WHY IT RESTORES INTO A SCRATCH DATABASE IN THE SAME CLUSTER. The roles the grants name
# (`onchain_engine_read` and the writer) live at CLUSTER level, not in the dump — `pg_dump` carries
# GRANT statements and not the roles they mention. Restoring here proves the archive against the
# cluster it would actually be restored into. A restore onto a FRESH host needs those roles created
# first, and the runbook says so; this drill does not simulate that.
#
# Usage:
#   restore-check.sh              the newest dump in ONCHAIN_BACKUP_DIR
#   restore-check.sh <file.dump>  a named one
#
# Exit 0 = the archive restored and every structural guard came back. Exit 1 = it did not.

set -eu

DIR="${ONCHAIN_BACKUP_DIR:-/backups}"
LOG="$DIR/backup.log"
# The scratch database this script creates and drops. The name is fixed and unmistakable, and the
# drop below refuses anything that is not exactly it — a `DROP DATABASE` that takes a name from a
# variable is one typo away from being the incident it was written to prevent.
SCRATCH='onchain_restore_check'

export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set}"
export PGHOST="${PGHOST:-db}"
export PGUSER="${POSTGRES_USER:?POSTGRES_USER is not set}"
export PGDATABASE="${POSTGRES_DB:?POSTGRES_DB is not set}"

log() {
  printf '%s restore-check %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"
  printf '%s restore-check %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ]; then
  ARCHIVE=$(find "$DIR" -maxdepth 1 -name 'onchain-engine-*.dump' | sort | tail -n 1)
fi
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  log "FAIL no archive to check in $DIR"
  exit 1
fi

# Structural counts are compared, and row counts only reported. Rows move between the dump and this
# check — `request_trace` and `client_usage` are written by every served call — so asserting row
# equality against the live database would fail for the healthy case and teach everyone to ignore
# it. What does NOT move with traffic is the shape: tables, triggers, rules, functions.
q() { psql -qtAX -d "$2" -c "$1" | tr -d ' \n'; }
Q_TABLES="SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='onchain' AND c.relkind='r'"
Q_TRIG="SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='onchain' AND NOT t.tgisinternal"
Q_RULE="SELECT count(*) FROM pg_rules WHERE schemaname='onchain'"
Q_FUNC="SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='onchain'"
Q_GRANTEES="SELECT count(DISTINCT grantee) FROM information_schema.role_table_grants WHERE table_schema='onchain'"

cleanup() {
  # Only ever this one name, and only a database this script created.
  psql -d "$PGDATABASE" -qc "DROP DATABASE IF EXISTS $SCRATCH" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
if ! psql -d "$PGDATABASE" -qc "CREATE DATABASE $SCRATCH" >/dev/null 2>&1; then
  log "FAIL could not create the scratch database $SCRATCH"
  exit 1
fi

# `--no-owner` because the scratch database is owned by whoever runs this, not by the engine's role;
# ownership is not what this drill is about and a failure there would mask the ones that are.
if ! err=$(pg_restore --dbname="$SCRATCH" --no-owner "$ARCHIVE" 2>&1); then
  log "FAIL pg_restore rejected $(basename "$ARCHIVE"): $(printf '%s' "$err" | tr '\n' ' ' | cut -c1-300)"
  exit 1
fi

live_t=$(q "$Q_TABLES" "$PGDATABASE");  rest_t=$(q "$Q_TABLES" "$SCRATCH")
live_g=$(q "$Q_TRIG" "$PGDATABASE");    rest_g=$(q "$Q_TRIG" "$SCRATCH")
live_r=$(q "$Q_RULE" "$PGDATABASE");    rest_r=$(q "$Q_RULE" "$SCRATCH")
live_f=$(q "$Q_FUNC" "$PGDATABASE");    rest_f=$(q "$Q_FUNC" "$SCRATCH")
live_a=$(q "$Q_GRANTEES" "$PGDATABASE"); rest_a=$(q "$Q_GRANTEES" "$SCRATCH")

bad=''
[ "$rest_t" = "$live_t" ] || bad="$bad tables=$rest_t/live=$live_t"
[ "$rest_g" = "$live_g" ] || bad="$bad triggers=$rest_g/live=$live_g"
[ "$rest_r" = "$live_r" ] || bad="$bad rules=$rest_r/live=$live_r"
[ "$rest_f" = "$live_f" ] || bad="$bad functions=$rest_f/live=$live_f"
[ "$rest_a" = "$live_a" ] || bad="$bad grantees=$rest_a/live=$live_a"

# The three tables whose loss cannot be reconstructed from anywhere else. Reported by name and
# required non-empty: a structurally perfect restore of an empty archive would otherwise pass.
rows=''
for t in api_tokens users access_profiles client_usage request_trace; do
  n=$(q "SELECT count(*) FROM onchain.$t" "$SCRATCH")
  rows="$rows $t=$n"
  case "$t" in
    api_tokens | users | access_profiles) [ "${n:-0}" -gt 0 ] || bad="$bad ${t}_EMPTY" ;;
  esac
done

if [ -n "$bad" ]; then
  log "FAIL $(basename "$ARCHIVE") —$bad; rows:$rows"
  exit 1
fi
log "OK $(basename "$ARCHIVE") restored: tables=$rest_t triggers=$rest_g rules=$rest_r functions=$rest_f grantees=$rest_a; rows:$rows"
