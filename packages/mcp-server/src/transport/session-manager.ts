import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { capabilityManifests, type CapabilityManifest } from '@onchain-intel/core';
import type { Diagnostics } from '../engine/diagnostics.js';

/**
 * The session manager (task 014-13, R-24, R-25, `system-architecture.md` §3.4.2).
 *
 * **What it is for.** RISK-6 is a `sessionId → instance` map that only grows. Task 014-10 closed the
 * two removal paths a client can trigger — a `DELETE` and a transport that closes — and left the one
 * a client cannot: a caller that simply goes away sends nothing, and Streamable HTTP gives the
 * server no other signal (recorded as a passing test in `per-session-server.test.ts`, deliberately).
 * This module is the other two causes: the idle sweep, and the ceiling.
 *
 * **Why the map moved out of `http.ts`.** Four causes of removal and one removal path is a rule that
 * has to be enforced somewhere; spread across the request handler and two SDK callbacks it is a
 * convention instead. §3.4.2 designs it as one module owning one map, and the ceiling and the sweep
 * are testable here without a listener.
 *
 * **The path differs from §3.4.2's `src/http/session-manager.ts`** — the transport shipped in
 * `src/transport/` at task 014-09, and a second directory for the same concern would split it.
 */

/** One live session. The five fields of §3.4.2's `SessionEntry`, in its order. */
export interface SessionEntry {
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
  /**
   * The token that opened the session — `api_tokens.id`.
   *
   * It is carried so an eviction can NAME whose session was dropped. An alert that prints a count
   * can be neither acted on nor distinguished from its own background noise (L-3), and a session id
   * alone resolves to nothing once the session is gone.
   */
  readonly principalId: string;
  readonly createdAtMs: number;
  /**
   * Written on every inbound message, not only on `tools/call` (§3.4.2). A client that holds a
   * session open with notifications is not idle, and a sweeper judging by tool calls alone would
   * evict it mid-conversation.
   */
  lastSeenAtMs: number;
}

/** What the ceiling answers. A refusal carries the numbers that produced it, for the operator. */
export type Admission =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly retryAfterSeconds: number;
      readonly live: number;
      readonly max: number;
      /**
       * The `diagnostics` row this refusal wrote, or `null` where no channel exists (task 014-26).
       *
       * It travels back to the transport rather than being re-derived there: the row is written
       * before the response goes out, and the id the client is given has to be the id of THAT row.
       */
      readonly eventId: string | null;
    };

export interface SessionManagerDeps {
  /** `ONCHAIN_SESSION_MAX` — applied `64`, measured: none (§3.4.2, and it says so). */
  readonly max: number;
  /** `ONCHAIN_SESSION_IDLE_MS` — applied `900_000`, measured `330_000` (§3.4.2). */
  readonly idleMs: number;
  readonly now: () => number;
  readonly diagnostics?: Diagnostics;
  /**
   * How often the periodic sweep runs. Default: a quarter of the idle timeout, and never below a
   * second.
   *
   * **Why a fraction and not a constant.** The interval is how long an abandoned entry outlives its
   * own deadline, so it is a property OF the timeout rather than a number beside it: sweeping once
   * per `idleMs` would double the worst case, and a constant would stop tracking the timeout the
   * moment an operator changed it.
   */
  readonly sweepIntervalMs?: number;
  /** Injectable so a test can hold the handle the manager `unref`s. */
  readonly createTimer?: (tick: () => void, intervalMs: number) => NodeJS.Timeout;
}

export interface SessionManager {
  size(): number;
  get(id: string): SessionEntry | undefined;
  /** Stamps `lastSeenAtMs`. Silent for an unknown id — a request for one is a 404 upstream. */
  touch(id: string): void;
  /**
   * Whether a NEW session may be created, having first swept (§3.4.2's step 1 — an abandoned
   * session must not be able to deny service to a new one).
   */
  admit(principalId: string): Promise<Admission>;
  register(
    id: string,
    entry: Pick<SessionEntry, 'server' | 'transport' | 'principalId'>,
  ): SessionEntry;
  /**
   * Drops an entry whose transport is ALREADY closing — the `DELETE` and `onclose` paths, where the
   * SDK closed the stream and the `McpServer` is what is left to release.
   */
  forget(id: string): void;
  /** Evicts every entry past the idle timeout. Returns the ids, in map order. */
  sweep(): Promise<string[]>;
  /** Closes every session and stops the sweeper. */
  shutdown(): Promise<void>;
}

/**
 * The startup assertion of §3.4.2: `idleTimeoutMs > max(manifest.deadlineMs)`.
 *
 * **Why this bound and not the request envelope.** The envelope that produced the applied `900_000`
 * — a cancellable part plus a paid part that ADR-002 D4 п.2 forbids cancelling — is derived, not a
 * declared field, so no machine can check it. `deadlineMs` IS declared on every row, and a timeout
 * below it would evict a session whose own request is still inside its deadline. It is the weaker
 * of the two bounds and the one that can be enforced.
 *
 * **Why the manifest is a parameter.** So the check reads the table rather than a constant copied
 * out of it: a row raised to a deadline above the timeout has to fail this, and it cannot if the
 * number it is compared against was frozen when this line was written. Measured 2026-08-12:
 * `max(deadlineMs) = 60_000` over all 26 rows.
 */
export function assertIdleTimeoutClearsManifest(
  idleTimeoutMs: number,
  manifests: Readonly<Record<string, CapabilityManifest>> = capabilityManifests,
): void {
  let worst = 0;
  let worstCapability = '';
  for (const [capability, manifest] of Object.entries(manifests)) {
    if (manifest.deadlineMs > worst) {
      worst = manifest.deadlineMs;
      worstCapability = capability;
    }
  }
  if (idleTimeoutMs > worst) return;
  // Both numbers are in the text, and so is the row that produced the larger one: an operator who
  // reads only "too low" has to go find which capability moved.
  throw new Error(
    `ONCHAIN_SESSION_IDLE_MS is ${String(idleTimeoutMs)} ms, which does not clear the longest ` +
      `declared deadline of ${String(worst)} ms (${worstCapability}) — a session would be evicted ` +
      `while its own request was still inside its deadline (system-architecture.md §3.4.2)`,
  );
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const entries = new Map<string, SessionEntry>();
  const { idleMs, max } = deps;
  /**
   * The `Retry-After` this process can honestly assert.
   *
   * The soonest a slot frees by THIS process's own action is the idle timeout; a live session may of
   * course end sooner, and nothing forbids a client retrying earlier. A smaller number here would be
   * a guess with no measurement behind it, which is the habit §7 of DB-SCHEMA-CONCEPT names.
   */
  const retryAfterSeconds = Math.ceil(idleMs / 1000);
  const sweepIntervalMs = deps.sweepIntervalMs ?? Math.max(1_000, Math.floor(idleMs / 4));

  /** Releases both halves. §3.4.2: removal closes the `McpServer` AND the transport. */
  async function release(entry: SessionEntry): Promise<string | null> {
    try {
      await entry.transport.close();
      await entry.server.close();
      return null;
    } catch (error) {
      // Reported, never rethrown: a session that failed to close cleanly is still gone from the
      // map, and the alternative is a sweep that stops at the first bad entry.
      return error instanceof Error ? error.message : String(error);
    }
  }

  async function sweep(): Promise<string[]> {
    const now = deps.now();
    const stale = [...entries].filter(([, entry]) => now - entry.lastSeenAtMs > idleMs);
    for (const [id, entry] of stale) {
      // Removed from the map FIRST: `release` closes the transport, whose `onclose` calls `forget`,
      // and an entry still present there would be released a second time.
      entries.delete(id);
      const closeError = await release(entry);
      await deps.diagnostics?.emit('session.evicted', {
        severity: 'info',
        sessionId: id,
        principalId: entry.principalId,
        detail: {
          cause: 'idle',
          idleMs,
          idleForMs: now - entry.lastSeenAtMs,
          ageMs: now - entry.createdAtMs,
          ...(closeError === null ? {} : { closeError }),
        },
      });
    }
    return stale.map(([id]) => id);
  }

  const createTimer =
    deps.createTimer ?? ((tick: () => void, intervalMs: number) => setInterval(tick, intervalMs));
  // `unref`'d: a periodic sweep that kept the event loop alive would stop the process from exiting
  // after the listener closes (§3.4.2).
  const timer = createTimer(() => void sweep(), sweepIntervalMs);
  timer.unref();

  return {
    size: () => entries.size,
    get: (id) => entries.get(id),
    touch(id) {
      const entry = entries.get(id);
      if (entry !== undefined) entry.lastSeenAtMs = deps.now();
    },
    async admit(principalId) {
      await sweep();
      if (entries.size < max) return { ok: true };
      // **Refuse the newcomer; never evict a live session to admit one** (§3.4.2, and it says why):
      // a live session may hold a paid call already past its credit reservation, and dropping it
      // spends the credit for nobody. Refusing costs one client a retry.
      //
      // The row names the PRINCIPAL and carries no `session_id`, because the refused session was
      // never created — a value there would name something that does not exist. This is a stated
      // deviation from TC-E2E-03's wording, which asks each of the two rows to carry "its own"
      // session id; the caller is identified by the token that presented itself, which is both true
      // and the more actionable of the two.
      const eventId =
        (await deps.diagnostics?.emit('session.limit_reached', {
          severity: 'warn',
          principalId,
          sessionId: null,
          detail: { live: entries.size, max, retryAfterSeconds },
        })) ?? null;
      return { ok: false, retryAfterSeconds, live: entries.size, max, eventId };
    },
    register(id, entry) {
      const now = deps.now();
      const created: SessionEntry = { ...entry, createdAtMs: now, lastSeenAtMs: now };
      entries.set(id, created);
      return created;
    },
    forget(id) {
      const entry = entries.get(id);
      if (entry === undefined) return;
      entries.delete(id);
      // The SDK's callbacks are synchronous and the transport is already closing; what is left is
      // the `McpServer`, released without blocking the response that triggered this.
      void entry.server.close().catch(() => undefined);
    },
    sweep,
    async shutdown() {
      clearInterval(timer);
      for (const [id, entry] of [...entries]) {
        entries.delete(id);
        await release(entry);
      }
    },
  };
}
