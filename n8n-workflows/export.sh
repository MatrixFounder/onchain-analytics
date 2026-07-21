#!/usr/bin/env bash
# Export the onchain-* n8n workflows to n8n-workflows/exported/ as JSON.
# Adapted from czlonkowski/n8n-lazy-loading (n8n-workflows/export.sh): fetch via the n8n
# public API and STRIP volatile metadata so git diffs track content, not clock drift.
#
# Exports credential *references* (id/name) only — n8n never returns secret data via the API.
# The API key is read from env, else from the gitignored project .mcp.json (never committed).
#
# Usage:  ./n8n-workflows/export.sh
#         N8N_URL=... N8N_API_KEY=... ./n8n-workflows/export.sh
#         PREFIX=onchain- ./n8n-workflows/export.sh   # name filter (default onchain-)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$SCRIPT_DIR/exported"
MCP_JSON="$REPO_ROOT/.mcp.json"

N8N_URL="${N8N_URL:-http://ubuntu-linux-2404.local:5678}"
N8N_API_KEY="${N8N_API_KEY:-}"
PREFIX="${PREFIX:-onchain-}"

# Fallback: read the n8n-mcp key from the gitignored .mcp.json (stays local).
if [[ -z "$N8N_API_KEY" && -f "$MCP_JSON" ]]; then
  N8N_API_KEY=$(python3 -c "import json;print(json.load(open('$MCP_JSON'))['mcpServers']['n8n-mcp']['env']['N8N_API_KEY'])" 2>/dev/null || true)
fi
[[ -n "$N8N_API_KEY" ]] || { echo "Error: N8N_API_KEY not set (env or .mcp.json)" >&2; exit 1; }

# Drop instance-specific / volatile fields so exports are portable and diff-clean.
STRIP='
import json, sys
wf = json.load(sys.stdin)
for k in ("id", "updatedAt", "createdAt", "versionId", "triggerCount", "shared",
          "isArchived", "tags", "meta", "pinData", "staticData", "activeVersionId",
          "versionCounter", "activeVersion"):
    wf.pop(k, None)
print(json.dumps(wf, indent=2, ensure_ascii=False))
'

mkdir -p "$OUT_DIR"
echo "Exporting ${PREFIX}* workflows from $N8N_URL ..."
LIST=$(curl -sf --max-time 15 -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N_URL/api/v1/workflows?limit=200")

echo "$LIST" | python3 -c "
import json, sys
d = json.load(sys.stdin)
seen = {}
for w in d.get('data', d):
    if not w['name'].startswith('$PREFIX'):
        continue
    if w.get('isArchived'):          # skip soft-deleted copies (name-collision → clobbered export)
        continue
    if w['name'] in seen:            # two live workflows, same name → refuse to silently overwrite
        sys.exit('ERROR: duplicate active workflow name %r (ids %s, %s) — resolve before export'
                 % (w['name'], seen[w['name']], w['id']))
    seen[w['name']] = w['id']
    print(w['id'] + ' ' + w['name'])
" | while read -r id name; do
  curl -sf --max-time 15 -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N_URL/api/v1/workflows/$id" \
    | python3 -c "$STRIP" > "$OUT_DIR/$name.json"
  echo "  exported: $name.json"
done

echo "Done -> $OUT_DIR"
