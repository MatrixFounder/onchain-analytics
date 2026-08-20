import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { createServer } from '../src/server.js';
import { loadEnv } from '../src/env.js';
import { toolSpecs } from '../src/tools/tool-specs.js';
import { ROUTE_DISCLOSURE_OUTPUT_FIELD } from '../src/tools/meta-visibility.js';

/**
 * Task 014-30 — the gate that keeps the SDK's output validation unreachable, in place of predicting
 * its verdict at run time.
 *
 * **The failure being prevented.** `applyRouteDisclosure` DELETES a governed field from the response
 * after the handler has already validated its own output, and the SDK then validates what is left
 * against the registered `outputSchema`. If that field were ever required, the SDK would reject the
 * response — for role `user` only, since role `admin` gets `routeDisclosureMode: 'full'` and no
 * stripping. The request would already have been recorded as an `answer`, so the ledger would claim
 * a delivered response the client received as an error.
 *
 * **Why a gate and not a re-parse in the wrapper.** A wrapper re-parse would validate the STRIPPED
 * object, while the handler validated the UNSTRIPPED one — so the two checks disagree by
 * construction, and the "observer" becomes able to refuse answers the SDK would have accepted. The
 * defect is a disagreement between two DECLARATIONS, which is what a gate catches best and cheapest;
 * a run-time parse would pay for every 1825-point series forever to catch a branch that needs a bug
 * elsewhere to reach.
 *
 * **The residual is pinned rather than assumed** — see the last case.
 */

/** Every `outputSchema` as it is actually REGISTERED with the SDK, captured from the real server. */
function registeredOutputSchemas(): Map<string, z.ZodType> {
  const captured = new Map<string, z.ZodType>();
  const spy = vi.spyOn(McpServer.prototype, 'registerTool').mockImplementation(function (
    this: McpServer,
    name: string,
    config: unknown,
  ) {
    const schema = (config as { outputSchema?: z.ZodType }).outputSchema;
    if (schema !== undefined) captured.set(name, schema);
    return undefined as never;
  });
  try {
    createServer({ env: loadEnv({}), version: '0.0.0-test' });
  } finally {
    spy.mockRestore();
  }
  return captured;
}

describe('a governed field is never required by the schema that validates without it', () => {
  it('captures a schema for every registered tool', () => {
    // The denominator: a capture that silently found nothing would make every assertion below
    // vacuous, which is the shape this repository's own gates keep being caught by.
    const schemas = registeredOutputSchemas();
    expect(schemas.size).toBe(toolSpecs.length);
  });

  it('declares every route-disclosure field optional wherever it appears', () => {
    // `applyRouteDisclosure` removes exactly this key. A tool that declared it required would work
    // for an admin and fail for a `user` — and the whole suite runs as admin, so nothing else here
    // would notice.
    const offenders: string[] = [];
    for (const [name, schema] of registeredOutputSchemas()) {
      const shape = (schema as unknown as { shape?: Record<string, z.ZodType> }).shape;
      const governed = shape?.[ROUTE_DISCLOSURE_OUTPUT_FIELD];
      if (governed === undefined) continue;
      if (!governed.safeParse(undefined).success) offenders.push(name);
    }

    expect(
      offenders.sort(),
      `These tools declare \`${ROUTE_DISCLOSURE_OUTPUT_FIELD}\` as REQUIRED while ` +
        '`applyRouteDisclosure` strips it for any principal whose profile is not `full`. The SDK ' +
        'validates the stripped object, so those calls would fail for role `user` alone — and the ' +
        'request_trace row, written before the SDK validates, would claim an answer the client ' +
        'never received.',
    ).toStrictEqual([]);
  });

  it('proves the check can fail, by running it against a required declaration', () => {
    // A gate whose positive case is never exercised is a gate nobody has seen work. This is the same
    // shape the scanner in `contract-violation.test.ts` documents about itself.
    const schemas = registeredOutputSchemas();
    const withField = [...schemas].find(
      ([, schema]) =>
        (schema as unknown as { shape?: Record<string, z.ZodType> }).shape?.[
          ROUTE_DISCLOSURE_OUTPUT_FIELD
        ] !== undefined,
    );
    expect(
      withField,
      'no tool declares the governed field at all — the gate has no subject',
    ).toBeDefined();

    const governed = (withField![1] as unknown as { shape: Record<string, z.ZodType> }).shape[
      ROUTE_DISCLOSURE_OUTPUT_FIELD
    ]!;
    // The real declaration accepts `undefined`; its non-optional inner type does not, which is what
    // the predicate above is reading.
    expect(governed.safeParse(undefined).success).toBe(true);
    const required = (governed as unknown as { unwrap?: () => z.ZodType }).unwrap?.();
    expect(required, 'the governed field is not an optional wrapper').toBeDefined();
    expect(required!.safeParse(undefined).success).toBe(false);
  });
});

describe('the residual this gate does NOT close, measured rather than assumed', () => {
  it('names the tools that publish output without validating it against their own schema', () => {
    // These build their response from local state — no provider, no untrusted input — so they have
    // nothing to validate against a provider contract, and they are therefore the only place a
    // response could diverge from the registered schema without a gate noticing. The list is EXACT
    // so a third such tool is a decision somebody made rather than an accident nobody saw.
    //
    // **Membership is keyed on the SHAPE, not on the identifier `OutputSchema`.** `get-token.ts` and
    // `wallet-balances.ts` validate against `TokenSchema`/`WalletSchema`, and a scan for the literal
    // identifier reports them as unvalidated. That blind spot is documented in `get-token.ts:126`
    // and in `contract-violation.test.ts`, where the same scan once defined its set such that the
    // two offenders were not in it — and the first draft of THIS gate walked into it from the other
    // side, as a false positive.
    //
    // The finer residual those two carry is real and separate: they validate a SUB-schema of what is
    // registered, so the envelope the SDK checks is checked by nobody else. It is not what this gate
    // is about, and it is named here rather than left for the next reader to rediscover.
    //
    // **`pool-info.ts` and `token-pools.ts` are here for a DIFFERENT and TEMPORARY reason** (task
    // 014-32b). They are registered stubs: they publish no output at all, they answer a typed
    // refusal naming the task that removes them. There is nothing to validate because there is
    // nothing produced. Task 014-32c removes `pool-info.ts` from this list together with its logic,
    // and 014-32d removes `token-pools.ts` — 014-34 checks both are gone. Distinguishing the two
    // reasons matters: the first two entries are permanent by design, these two are an interval.
    const VALIDATES_OUTPUT = /\b\w*Schema\.safeParse\(/;
    const dir = path.resolve(__dirname, '../src/tools');
    const notValidating = readdirSync(dir)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /defineTool\(/.test(readFileSync(path.join(dir, file), 'utf8')))
      .filter((file) => !VALIDATES_OUTPUT.test(readFileSync(path.join(dir, file), 'utf8')))
      .sort();

    expect(
      notValidating,
      'A tool publishes output it never checked against its own schema. If the response and the ' +
        'registered schema ever disagree, the SDK refuses AFTER the request_trace row is written — ' +
        'so the row claims an answer the client received as an error. Either validate, or add the ' +
        'tool here with the reason it has nothing to validate.',
    ).toStrictEqual(['list-chains.ts', 'ping.ts', 'pool-info.ts', 'token-pools.ts']);
  });
});
