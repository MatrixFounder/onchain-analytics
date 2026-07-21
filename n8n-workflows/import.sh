#!/usr/bin/env bash
# Import the onchain-* workflows from n8n-workflows/exported/ into a target n8n instance.
# Thin wrapper over import_with_relink.py (structure mirrors czlonkowski/n8n-lazy-loading).
#
# IDEMPOTENT: a same-name workflow already on the target is UPDATED in place (not duplicated) —
# the safe way to re-sync. Imports onchain-error-alert first, relinks node credentials BY NAME to the
# prod ids you pass + points settings.errorWorkflow at the (new) error-alert, strips settings.binaryMode,
# and activates each. See PROD-RUNBOOK "Import workflows".
#
# Required env (PROD — NEVER the dev .mcp.json):
#   N8N_URL           prod instance base URL
#   N8N_API_KEY       prod public API key
#   PROD_PG_CRED_ID   prod "Supabase DB" (postgres) credential id
#   PROD_TG_CRED_ID   prod "Onchain bot"  (telegram) credential id
# Optional: DRY_RUN=1 (preview, POST/PUT nothing).
#
# First run against any instance: DRY_RUN=1 and eyeball the plan.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${N8N_URL:?set N8N_URL (prod instance)}"
: "${N8N_API_KEY:?set N8N_API_KEY (prod public API key)}"
: "${PROD_PG_CRED_ID:?set PROD_PG_CRED_ID (prod \"Supabase DB\" credential id)}"
: "${PROD_TG_CRED_ID:?set PROD_TG_CRED_ID (prod \"Onchain bot\" credential id)}"

exec python3 "$SCRIPT_DIR/import_with_relink.py" \
  --url "$N8N_URL" --api-key "$N8N_API_KEY" \
  --exported-dir "$SCRIPT_DIR/exported" \
  --pg-cred-id "$PROD_PG_CRED_ID" --tg-cred-id "$PROD_TG_CRED_ID" \
  --dry-run "${DRY_RUN:-0}"
