---
id: WI-2
type: work-item
status: open
opened_at: 2026-07-22
slug: wi-2-typescript-pin-revisit-when-tsup-supports-ts7-dts
effort: M
value: 'unpins the toolchain from a major behind, and would collapse the mcp-server build to one step'
last_checked: 2026-07-28
---

# Revisit typescript pin ^6.0.3 when tsup supports TS7 dts

> **Re-measured 2026-07-28 — still open, but the question has split in two and one half is
> answered.** The original entry framed this as one blocked decision. It is two, and only one of
> them is actually blocked.

## Original record (M0, 2026-07-22)

tsup 8.5.1's dts pipeline breaks under `typescript@7` (native API TypeError) and emits TS5101
(`baseUrl` deprecated) under TS6 — M0 ships TS `^6.0.3` with a two-step build (tsup `dts:false` +
`tsc --emitDeclarationOnly -p tsconfig.build.json`). Error signatures documented in
`packages/mcp-server/.AGENTS.md`.

## (a) Collapse the build back to one step — STILL BLOCKED

Measured 2026-07-28 in an isolated project (tsup 8.5.1 + typescript 7.0.2, `dts: true`):

```
TypeError: Cannot read properties of undefined (reading 'useCaseSensitiveFileNames')
    at node_modules/.pnpm/rollup-plugin-dts@6.1.1_rollup@4.53.2_typescript@5.7.3/...
```

Identical failure to M0. Two corrections to the original record:

- **The blocker is not "tsup" — it is `rollup-plugin-dts@6.1.1`,** which tsup vendors for its dts
  path and which resolves its own `typescript@5.7.3`. That is the package to watch, and the reason
  waiting on a tsup release is the wrong trigger.
- **tsup has not released since M0** (still 8.5.1, and 8.5.1 is npm `latest`), so nothing upstream
  has moved in six days. Do not re-check this on a schedule; check it when
  `rollup-plugin-dts` ships a TS7-compatible major.

Re-check, one command:

```sh
mkdir -p /tmp/dtsprobe && cd /tmp/dtsprobe && npm i -D tsup typescript >/dev/null \
  && printf 'export const x = (n: number): string => `${n}`\n' > index.ts \
  && npx tsup index.ts --dts --format esm
```

## (b) Re-evaluate the pin itself — ANSWERED, and the stated reason no longer applies

Two facts measured 2026-07-28 that the original entry could not have known:

1. **`packages/core` does not use tsup at all** — its build is plain `tsc -p tsconfig.build.json`.
   Only `packages/mcp-server` uses tsup, and it uses it with **`dts: false`**. So the broken dts
   path is one this repository does not execute; it cannot be what forces the pin.
2. **Both packages typecheck clean under TypeScript 7.0.2.** Run read-only, with a TS7 compiler
   from a scratch install against the repo's own tsconfigs and sources, touching nothing:

   ```
   tsc 7.0.2 --noEmit -p packages/core/tsconfig.json         -> exit 0
   tsc 7.0.2 --noEmit -p packages/mcp-server/tsconfig.json   -> exit 0
   ```

So the pin's justification is stale: the sources are TS7-clean and the tsup dts path is unused. What
remains is a genuine toolchain decision rather than a blocked wait — bumping a major dev dependency
changes the lockfile, `typescript-eslint`'s peer range, and the declaration output that ships, and
it deserves its own task with the five gates run against it. **Not done here** because a backlog
closeout is not the place to move a toolchain major.

## Next step

Owner decides between:

- **Bump to TS 7 now** (own task; two-step build stays until (a) unblocks) — the pin is no longer
  buying anything measurable.
- **Hold the pin** and record the _real_ reason for holding it, which is no longer "tsup dts".

Whichever is chosen, `packages/mcp-server/.AGENTS.md` should be corrected: it attributes the
breakage to tsup rather than to `rollup-plugin-dts`'s own pinned TypeScript.
