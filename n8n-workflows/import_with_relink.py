#!/usr/bin/env python3
"""Import the onchain-* workflows from n8n-workflows/exported/ into a target n8n instance,
relinking credentials + errorWorkflow. Adapted from czlonkowski/n8n-lazy-loading
(scripts/import_with_relink.py). Stdlib only — no pip deps.

Idempotent by design: a workflow whose NAME already exists on the target is UPDATED in place
(PUT by id), NOT duplicated — this is the safe way to re-sync (a raw UI "Import from File" would
create a second same-name workflow). `onchain-error-alert` is imported FIRST so the schedules'
`settings.errorWorkflow` can be relinked to its id. Node `credentials.id` is relinked BY NAME to the
prod ids you pass (the public API has no list-credentials endpoint, so ids can't be discovered).

Usage (via import.sh, or directly):
    python3 import_with_relink.py --url URL --api-key KEY --exported-dir ./exported \
        --pg-cred-id <prod "Supabase DB" id> --tg-cred-id <prod "Onchain bot" id> [--dry-run 1]

Note: on a dual-stack / mDNS `.local` host, Python may resolve to IPv6 and hit a reverse-proxy 503
where curl (IPv4) succeeds — point --url at the resolvable IPv4 if that happens (prod DNS names are
usually single-stack, so this is a dev-only quirk).
"""
import argparse
import copy
import json
import os
import sys
import urllib.error
import urllib.request

# Volatile/instance metadata + fields a strict public-API create/update rejects.
META_KEYS = ["id", "createdAt", "updatedAt", "versionId", "versionCounter", "activeVersionId",
             "triggerCount", "shared", "tags", "staticData", "meta", "pinData", "activeVersion",
             "isArchived", "sourceWorkflowId", "nodeGroups", "description"]
ALLOWED_SETTINGS = {"executionOrder", "timezone", "errorWorkflow", "saveDataErrorExecution",
                    "saveDataSuccessExecution", "saveManualExecutions", "saveExecutionProgress",
                    "executionTimeout"}  # NB: drops binaryMode — the public API rejects it
ERROR_WF_NAME = "onchain-error-alert"


def api(url, key, method="GET", data=None):
    headers = {"X-N8N-API-KEY": key, "User-Agent": "onchain-import/1.0"}
    body = json.dumps(data).encode("utf-8") if data is not None else None
    if body is not None:
        # Only send Content-Type WITH a body — a GET carrying "Content-Type: application/json" and an
        # empty body makes n8n try to JSON-parse nothing and return 503 (curl omits it on GET → 200).
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"API {method} {url} -> {e.code}: {e.read().decode('utf-8', 'replace')}")


def existing_map(url, key):
    """{name: id} for the target's workflows; a non-archived match wins over an archived same-name."""
    d = api(f"{url}/api/v1/workflows?limit=250", key)
    m, archived_only = {}, {}
    for wf in d.get("data", []):
        (archived_only if wf.get("isArchived") else m).setdefault(wf["name"], wf["id"])
    for nm, wid in archived_only.items():
        m.setdefault(nm, wid)
    return m


def prepare(wf, cred_ids, error_wf_id):
    """Strip volatile fields, whitelist settings, relink node credentials by name + errorWorkflow."""
    c = copy.deepcopy(wf)
    for k in META_KEYS:
        c.pop(k, None)
    c["settings"] = {k: v for k, v in (c.get("settings") or {}).items() if k in ALLOWED_SETTINGS}
    relinked = 0
    for n in c.get("nodes", []):
        for _type, cred in (n.get("credentials") or {}).items():
            pid = cred_ids.get(cred.get("name"))
            if pid:
                cred["id"] = pid           # keep the name, swap the dangling id for the prod one
                relinked += 1
    if error_wf_id and c["settings"].get("errorWorkflow"):
        c["settings"]["errorWorkflow"] = error_wf_id
    return c, relinked


def activate(url, key, wid):
    try:
        api(f"{url}/api/v1/workflows/{wid}/activate", key, "POST")
        return True
    except Exception as e:
        print(f"    (activate failed for {wid}: {e})")
        return False


def main():
    ap = argparse.ArgumentParser(description="Import onchain-* workflows with relink")
    ap.add_argument("--url", required=True)
    ap.add_argument("--api-key", required=True)
    ap.add_argument("--exported-dir", required=True)
    ap.add_argument("--pg-cred-id", required=True, help='prod "Supabase DB" credential id')
    ap.add_argument("--tg-cred-id", required=True, help='prod "Onchain bot" credential id')
    ap.add_argument("--dry-run", default="0")
    a = ap.parse_args()
    dry = a.dry_run == "1"
    cred_ids = {"Supabase DB": a.pg_cred_id, "Onchain bot": a.tg_cred_id}

    files = sorted(f for f in os.listdir(a.exported_dir) if f.endswith(".json"))
    files.sort(key=lambda f: (ERROR_WF_NAME not in f, f))  # error-alert first (errorWorkflow target)

    print(f"Connecting to {a.url} ...  {'[DRY RUN — no changes]' if dry else ''}")
    existing = existing_map(a.url, a.api_key)
    print(f"Found {len(existing)} existing workflows.\n")

    error_wf_id = existing.get(ERROR_WF_NAME)     # known upfront if already on target
    stats = {"created": 0, "updated": 0, "activated": 0, "failed": 0}
    final_error_id = error_wf_id

    for fn in files:
        with open(os.path.join(a.exported_dir, fn)) as fh:
            raw = json.load(fh)
        name = raw.get("name", fn[:-5])
        body, relinked = prepare(raw, cred_ids, error_wf_id)
        eid = existing.get(name)
        action = "update" if eid else "create"
        ew = f"errorWorkflow→{error_wf_id or '(new)'}" if body["settings"].get("errorWorkflow") else "no-errWF"

        if dry:
            print(f"  [DRY] would {action.upper()}: {name}  (creds relinked: {relinked}; {ew})")
            if name == ERROR_WF_NAME:
                error_wf_id = final_error_id = eid or "(new error-alert id)"
            continue
        try:
            if eid:
                r = api(f"{a.url}/api/v1/workflows/{eid}", a.api_key, "PUT", body)
            else:
                r = api(f"{a.url}/api/v1/workflows", a.api_key, "POST", body)
            wid = r["id"]
            stats[action + "d" if action == "create" else "updated"] += 1
            print(f"  {action.upper()}D: {name} (id {wid}; creds {relinked}; {ew})")
            if name == ERROR_WF_NAME:
                error_wf_id = final_error_id = wid   # schedules imported next relink to this
            if activate(a.url, a.api_key, wid):
                stats["activated"] += 1
        except Exception as e:
            stats["failed"] += 1
            print(f"  FAILED: {name} — {e}")

    print(f"\nDone. created={stats['created']} updated={stats['updated']} "
          f"activated={stats['activated']} failed={stats['failed']}")
    if not dry:
        print(f"Verify: no 'credential not found' nodes; snapshotter+verify errorWorkflow = "
              f"{final_error_id}; then smoke-run the snapshotter.")
    sys.exit(1 if stats["failed"] else 0)


if __name__ == "__main__":
    main()
