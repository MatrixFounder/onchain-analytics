---
id: L-16
type: known-issue
status: fixed
opened_at: 2026-08-17
category: logic
severity: SEV-2
slug: l-16-createserver-with-the-http-principal-resolver-throws-so-the-network-profile-cannot-create-a-session
resolved_at: 2026-08-17
resolved_by: TASK-014 задача 014-30 (commit 5ebb695)
---

# L-16 — `createServer` with the HTTP principal resolver throws, so the network profile cannot create a session

> **Fixed 2026-08-17** (commit `5ebb695`). The session-construction placeholder no longer CALLS the
> resolver. With no resolver it stays `STDIO_PRINCIPAL`; with one it becomes a new
> `UNRESOLVED_PRINCIPAL` — least privilege in the role vocabulary, and an id that names itself. A
> value that ever reaches a decision is then visibly wrong rather than quietly `admin`.
>
> The regression is held by `test/e2e.request-trace.test.ts`. It is the first suite to drive
> `createServer` through the HTTP transport with the resolver injected.

> Origin: found while writing task 014-30's end-to-end suite, 2026-08-17. Not a `run-feedback`
> capture — the suite would not start, and the cause was two layers below what it was testing.

**Symptom.** Every request on the `network` profile answers HTTP 500. The client sees
`Error POSTing to endpoint`; the server writes one stderr line per request:

```
onchain-intel-mcp-server: http transport: no principal reached the tool boundary:
the request carried no AuthInfo
```

No tool is reached, no session is created, and the message names a request-time condition for a
failure that happened before any request was read.

**Cause.** `createServer` built the session context with:

```ts
principal: principalFor(deps.principals, undefined),
```

`principalFor` calls the resolver when one is present, and `createHttpPrincipalResolver` is
deliberately fail-closed — it THROWS `PrincipalMissingError` on absent `AuthInfo`, because an
absent principal on the HTTP path is a privilege-escalation risk rather than a default. Session
construction has no request and therefore no `AuthInfo`, so on the profile that injects the
resolver — which `index.ts` does for `transport === 'http'` — `createSessionServer()` threw before
the transport could hand it anything.

The value being computed was dead in both directions: `defineTool`'s wrapper resolves the principal
per request from `extra.authInfo` and overwrites it before any handler runs. The construction-time
call was therefore pure cost with a fail-closed edge.

**Why no test caught it, stated exactly.** The combination `createServer` + HTTP resolver is
covered by nothing:

- `test/e2e.http.test.ts` drives the real transport and the real `createServer`, but passes **no**
  `principals`, so `principalFor` returns `STDIO_PRINCIPAL` and the throwing branch is never taken.
- `test/principal-interception.test.ts` DOES inject `createHttpPrincipalResolver()`, but registers
  its probe against a hand-built `new McpServer(...)` and never calls `createServer`.
- `test/meta-visibility.test.ts` uses the resolver as a function, not as a server dependency.

Each suite covers one half. Nothing covered the seam, and the seam is the only place the two meet
in production.

**Blast radius.** The whole `network` profile, from the commit that introduced the line. `stdio` is
unaffected: it passes no resolver, so the expression returns the constant it always did.

**Introduced by** commit `37bd4d5` (task 014-14, "Principal пятью полями и `ctx.principal` у
каждого тула"), which added the line. Tasks 014-15 and 014-16 both read `ctx.principal` and neither
observed the defect: both are exercised on paths that construct the context without a resolver.

**Do not** re-derive the placeholder by calling the resolver with a synthetic `AuthInfo`. That puts
a manufactured principal one property access away from every session. It also satisfies the
resolver's fail-closed branch with our own value rather than with a token — and that branch is what
makes an absent principal a refusal instead of an `admin` default.

**Do not** use `STDIO_PRINCIPAL` as the placeholder on the HTTP path. It carries `role: 'admin'`;
a placeholder that leaked into a `_meta` visibility decision or a `request_trace` row would be an
escalation wearing the clothes of a default.

**What this says about the gate set, beyond the fix.** The engine has no suite that starts the
shipped network profile the way `index.ts` starts it. Every HTTP suite assembles its own subset of
the production wiring, and this defect lived in exactly the part no subset included. Task 014-33
(the live gate over the network transport) is where that hole is addressed; until it lands, a
change to session construction is verified by suites that each omit a different production
dependency.
