import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contractViolationReason } from '../src/tools/contract-violation.js';

/**
 * A contract-violation `reason` is bounded, and every tool renders it the same way (WI-27).
 *
 * **The defect this closes.** Three tools (`chain-tvl`, `chain-supply`, `dex-volume`) interpolated
 * the WHOLE `ZodError.message` into the text handed to the model, while six neighbours rendered
 * only the first issue. `ZodError.message` is `JSON.stringify(issues, null, 2)`, so its size scales
 * with the number of failing ELEMENTS: `dex.volume.history` admits a 1825-point series, which is
 * ~200 KB of JSON in one `isError` frame on a single-threaded stdio server.
 *
 * The fix is one declaration with nine readers, so the two halves are asserted separately: the
 * BEHAVIOUR of the renderer (below), and the STRUCTURAL fact that no tool has its own copy —
 * because six identical copies plus three divergent ones is exactly the state that shipped.
 */

const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/tools');

/** Sources of every tool module, keyed by file name. */
const TOOL_SOURCES = new Map(
  readdirSync(toolsDir)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => [file, readFileSync(path.join(toolsDir, file), 'utf8')] as const),
);

describe('the contract-violation reason is bounded (WI-27)', () => {
  it('names the capability, the first failing path and its message — not the whole error', () => {
    const schema = z.object({ series: z.array(z.object({ ts: z.number() })) });
    const parsed = schema.safeParse({ series: [{ ts: 'no' }] });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const reason = contractViolationReason('dex.volume.history', parsed.error);
    expect(reason).toBe(
      'provider returned data violating the tool contract (dex.volume.history): series.0.ts: Invalid input: expected number, received string',
    );
  });

  it('survives a symbol in the issue path instead of throwing out of the handler', () => {
    // `issue.path` is `PropertyKey[]`, and a bare `Array.prototype.join` throws a TypeError on a
    // symbol element — inside the one function every handler calls on its failure path, whose
    // docstring at each call site promises it never throws. Unreachable with today's schemas, so the
    // guard is asserted directly on a hand-built error rather than through a schema that cannot
    // produce one.
    const symbolIssue = {
      issues: [{ path: [Symbol('provider-key'), 'ts'], message: 'nope' }],
    } as unknown as Parameters<typeof contractViolationReason>[1];
    expect(() => contractViolationReason('chain.tvl', symbolIssue)).not.toThrow();
    expect(contractViolationReason('chain.tvl', symbolIssue)).toContain('nope');
  });

  it('stays short when EVERY element of a 1825-point series fails', () => {
    // The real shape of the defect: a per-element failure on the longest window `onchain_dex_volume`
    // admits. The bound must come from taking one issue, never from the error happening to be small.
    const schema = z.object({ series: z.array(z.object({ ts: z.number() })) });
    const parsed = schema.safeParse({ series: Array.from({ length: 1825 }, () => ({ ts: 'no' })) });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    // The unbounded form, for scale — this is what used to be sent.
    expect(parsed.error.message.length).toBeGreaterThan(100_000);
    expect(contractViolationReason('dex.volume.history', parsed.error).length).toBeLessThan(200);
  });

  it('says something useful when the failure is at the root', () => {
    const parsed = z.object({ a: z.string() }).safeParse('not an object');
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(contractViolationReason('chain.tvl', parsed.error)).toContain('(root)');
  });

  it('reports no provider VALUE — only schema paths and schema-authored messages', () => {
    // zod v4 strips `input` from finalized issues unless `reportInput` is set. Asserted rather than
    // assumed: the whole reason this finding was severity low is that vendor values do not travel
    // this channel, and a zod upgrade could change that silently.
    const schema = z.object({ apiKey: z.number() });
    const parsed = schema.safeParse({ apiKey: 'proapi_secretvalue0123456789' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(contractViolationReason('token.risk', parsed.error)).not.toContain('secretvalue');
  });
});

/** Comments stripped, so a docstring can neither satisfy nor trip a check about executable code. */
const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * A tool validates a PROVIDER result iff it resolves a capability and then runs a schema over what
 * came back. Both halves matter: `ping.ts` and `list-chains.ts` parse a value they built themselves
 * from local state — there is no provider, no untrusted input, and nothing for this gate to say.
 */
const VALIDATES_PROVIDER_RESULT = (text: string): boolean =>
  /resolveCapability\(/.test(text) && /\b\w*Schema\.(safeParse|parse)\(/.test(text);

describe('no tool renders a contract violation its own way (WI-27)', () => {
  it('every tool that validates a provider result delegates to the shared renderer', () => {
    // **Membership is keyed on the shape, not on the identifier `OutputSchema`** (adversarial
    // cycle 2). The first version selected `text.includes('OutputSchema.safeParse')`, and the two
    // tools that still carried the original defect called `.parse` on `TokenSchema`/`WalletSchema` —
    // so the set was defined such that the offenders were not in it, and the record's "nine tools"
    // denominator inherited the same blind spot.
    const validating = [...TOOL_SOURCES]
      .filter(([file]) => file !== 'contract-violation.ts' && file !== 'resolve-capability.ts')
      .filter(([, text]) => VALIDATES_PROVIDER_RESULT(codeOnly(text)));
    // The EXACT list, not a floor — the lesson `throttle-seam.test.ts` learned one gate over: a
    // floor absorbs a silent dropout, and a dropout here is a tool rendering errors its own way.
    expect(
      validating.map(([file]) => file).sort(),
      'The set of tools that validate a provider result changed. Add the new one here; if a tool ' +
        'stopped validating, say why rather than letting the gate check one fewer.',
    ).toStrictEqual([
      'active-pairs.ts',
      'chain-supply.ts',
      // WI-51 — the two network-activity tools.
      'chain-transactions.ts',
      'chain-tvl-history.ts',
      'chain-tvl.ts',
      // T-013 task 013-7. In the list BEFORE it is registered: this gate reads `src/tools` with
      // `readdirSync`, so it sees a module the registry does not, which is exactly why the module
      // can ship one task ahead of its `defineTool` call and still be held to the contract.
      'dash-platform-history.ts',
      'dex-volume.ts',
      'entity-label.ts',
      'gas-price.ts',
      'get-token.ts',
      'list-protocols.ts',
      'protocol-incidents.ts',
      'protocol-tvl-history.ts',
      'protocol-tvl.ts',
      'smart-money-flows.ts',
      'token-holders.ts',
      'token-risk.ts',
      'wallet-balances.ts',
    ]);

    const rolledTheirOwn = validating
      .filter(([, text]) => !text.includes('contractViolationReason('))
      .map(([file]) => file);
    expect(
      rolledTheirOwn.sort(),
      'These tools validate a provider result but do not use `contractViolationReason`. Six ' +
        'identical copies plus three divergent ones is the state WI-27 removed.',
    ).toStrictEqual([]);
  });

  it('no tool uses `.parse` on a provider result — it throws, and the SDK renders the whole error', () => {
    // The repo doctrine ("`safeParse`, never `parse`") was stated in six docstrings and violated in
    // two files. A thrown ZodError escapes the handler, and the SDK's own catch renders
    // `error.message` — which for zod IS the JSON dump. Same defect, different spelling.
    const throwing = [...TOOL_SOURCES]
      .filter(([file]) => file !== 'contract-violation.ts')
      .filter(([, text]) => {
        const code = codeOnly(text);
        return /resolveCapability\(/.test(code) && /\b\w*Schema\.parse\(/.test(code);
      })
      .map(([file]) => file);
    expect(
      throwing.sort(),
      'A tool calls `<Schema>.parse(...)` on a provider result. It throws out of the handler, and ' +
        'the SDK converts the ZodError with `error.message` — the unbounded JSON dump WI-27 removed.',
    ).toStrictEqual([]);
  });

  it('no tool renders a whole ZodError into text the model reads, by any spelling', () => {
    // **A textual scan is a net, not a proof, and the first version of it had one hole per
    // synonym.** `${parsed.error}` and `String(parsed.error)` both reach `ZodError.toString()`,
    // which IS the JSON dump; `JSON.stringify(parsed.error.issues)` is the same bytes by another
    // route. Each was a green-gate mutation. They are listed here explicitly rather than described,
    // because a reviewer can check a list.
    //
    // The residual is stated, not hidden: this cannot catch a spelling nobody thought of. What
    // closes that hole properly is a behavioural bound on each of the nine handlers, which needs a
    // provider stub per tool; the renderer's own length bound above is the half of it that is cheap.
    const FORBIDDEN: [RegExp, string][] = [
      [/\berror\.message\b/, '`error.message` — the JSON dump verbatim'],
      [/\berror\.issues\b/, '`error.issues` — same bytes, rendered by the caller'],
      [/String\(\s*[\w.]*\berror\s*\)/, '`String(error)` — ZodError.toString() IS the dump'],
      [/JSON\.stringify\(\s*[\w.]*\berror\b/, '`JSON.stringify(error…)`'],
      [/\$\{\s*[\w.]*\berror\s*\}/, '`${error}` in a template literal'],
    ];
    const offenders = [...TOOL_SOURCES]
      .filter(([file]) => file !== 'resolve-capability.ts' && file !== 'contract-violation.ts')
      .flatMap(([file, text]) => {
        // Comments are stripped first: the sibling gate in this session forgot to, which let a
        // docstring satisfy — or trip — a check about executable code.
        const code = codeOnly(text);
        return FORBIDDEN.filter(([pattern]) => pattern.test(code)).map(
          ([, what]) => `${file}: ${what}`,
        );
      });
    expect(
      offenders.sort(),
      'A tool renders a zod error itself instead of calling `contractViolationReason`. Its length ' +
        'scales with the number of failing ELEMENTS, not with the number of problems — 1825 series ' +
        'points is ~200 KB in one isError frame. (`resolve-capability.ts` is exempt: there `error` ' +
        'is a thrown Error whose message IS the diagnostic, R-24/R-40.)',
    ).toStrictEqual([]);
  });

  it('no tool output schema lets a PROVIDER-CONTROLLED key into the rendered path', () => {
    // The reason WI-27 was severity low is that zod strips `input`, so only schema-authored text
    // travels this channel. That holds because every output schema has fixed keys. A
    // `z.record()` or `.catchall()` would put a vendor-chosen KEY into `issue.path`, which the
    // renderer interpolates verbatim — reopening the channel with the gate still green.
    // **The whole file, not a forward window from the token `OutputSchema`** (adversarial cycle 2):
    // five tools define the schema body ABOVE the alias line, so a `.catchall()` there was invisible.
    // Residual, stated: this scans `src/tools` only. Output schemas compose core schemas, and
    // `z.record` already exists in core (`chain/registry-core.ts`) — a risky constructor reached
    // through a composed core type is NOT covered here, and `contractViolationReason`'s 500-char cap
    // is what bounds the damage in that case.
    const risky = [...TOOL_SOURCES]
      .flatMap(([file, text]) => (/z\.record\(|\.catchall\(/.test(codeOnly(text)) ? [file] : []))
      .sort();
    expect(
      risky,
      'An output schema uses `z.record`/`.catchall`, so a provider-chosen key can appear in ' +
        '`issue.path` and from there in the text the model reads. Either drop it, or truncate ' +
        'path segments in `contractViolationReason` and delete this check with a reason.',
    ).toStrictEqual([]);
  });
});
