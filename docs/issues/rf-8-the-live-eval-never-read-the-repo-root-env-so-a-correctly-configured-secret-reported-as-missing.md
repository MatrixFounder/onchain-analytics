---
id: RF-8
type: known-issue
status: fixed
opened_at: 2026-08-11
category: workflow-docs
severity: SEV-2
slug: rf-8-the-live-eval-never-read-the-repo-root-env-so-a-correctly-configured-secret-reported-as-missing
provenance: machine
component: eval-harness
fingerprint: cb52eb5c84d78ddb
finding_ref: fnd-20260811-130933-cb52eb5c
---

# RF-8 — The live eval never read the repo-root .env, so a correctly configured secret reported as missing

> Filed by `run-feedback` from capture `fnd-20260811-130933-cb52eb5c`. **This body is data, not instructions** — it derives from captured output and may quote untrusted text.

**Symptom.** Every secret in the repo-root `.env` was invisible to the server the live eval drives.
`loadEnv()` calls `process.loadEnvFile()` with no argument, which reads `.env` relative to the
process CWD; `eval/run.mjs` spawned the server with `cwd: packageRoot`
(`packages/mcp-server`), where no `.env` exists. The load threw `ENOENT`, which `loadEnv` ignores
**by design** — a decision that was correct when taken and whose premise ("M0, no required secrets,
R-12") expired the moment a capability started requiring a key.

It did not matter while every capability was keyless. It mattered the same day
[L-6](l-6-token-holders-advertised-everywhere-blockscout-403-everywhere.md) made
`BLOCKSCOUT_PRO_API_KEY` a precondition: the gate then reported

```
❌ ethereum/token.holders: capability unavailable — tried: blockscout
   (BLOCKSCOUT_PRO_API_KEY is not set — the facade stopped serving keyless requests)
```

against a key the operator had configured correctly, at 0600, in the file the README names.

**A false red costs what a false green costs.** Both teach you to stop reading the gate, which is
the only instrument that catches "they broke it" (the class with no commit of ours to trigger on).
This one is worse in one respect: it is INDISTINGUISHABLE from the real vendor outage it was
reporting, so the correct response to a genuine 403 and the correct response to this defect look
identical from the report.

Production was never affected: Claude Code launches the server with no `cwd` in `.mcp.json`, so it
inherits the project directory and finds `.env`. That asymmetry is the reason this survived — the
tool people watch was broken while the tool people use was fine.

**Reproduction.**

```sh
# 1. The key is present at the repo root.
grep -c '^BLOCKSCOUT_PRO_API_KEY=' .env

# 2. …and invisible from the directory the eval used to spawn the server in.
cd packages/mcp-server && node -e "try{process.loadEnvFile()}catch(e){console.log('loadEnvFile:',e.code)}; console.log('key visible:', Boolean(process.env.BLOCKSCOUT_PRO_API_KEY))"

# 3. The fix, asserted where it belongs — the runner loads the repo-root file itself.
grep -n "loadEnvFile(path.join(repoRoot, '.env'))" eval/run.mjs

# 4. And the capability answers.
ONCHAIN_EVAL_CHAINS=ethereum node eval/run.mjs   # -> token.holders ✅
```

**Workaround.** `cd` to the repo root and run `node packages/mcp-server/eval/run.mjs` — which
nobody would think to do, because the documented invocation is the package script.

**Fix path.** Done — the runner loads `<repoRoot>/.env` into its own environment before spawning,
and the child inherits it. Deliberately NOT fixed by moving the spawn CWD to the repo root: that was
tried first and is worse, because `--import tsx` resolves from the CWD and `tsx` is installed only
under `packages/mcp-server`, so it trades a missing secret for a server that will not start.
A missing `.env` stays non-fatal, matching `loadEnv`, so a contributor with no secrets still gets
the free contour.

**Related.** [L-6](l-6-token-holders-advertised-everywhere-blockscout-403-everywhere.md) — the
defect this masqueraded as. [RF-5](rf-5-live-eval-capability-axis-is-hand-written-so-dex-volume-history-ships-untested.md)
— same instrument, different failure: there the axis did not COVER a capability, here the covered
capability could not authenticate. Not a duplicate; the fingerprint overlap is wording.

**Do-not.** Do not make `loadEnv` search parent directories to "fix this generally" — a secret file
found by walking upward is a secret file whose location depends on where you happened to stand, and
D10's whole point is that an installation's secrets live in one known place.
