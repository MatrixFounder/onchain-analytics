import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * TC-UNIT-01..09 (task 015-19, `docs/tasks/task-015-19-client-usage-retention.md`), AC-40.
 *
 * The fourth `onchain-retention` job — `client_usage.purge` — is n8n JSON, not TypeScript: there is
 * no compiled artifact to import, and `pnpm test` otherwise has no opinion on it at all. This suite
 * is the one thing that would notice a regression exported into the workflow file.
 *
 * **Why the Code-node bodies are EXECUTED, not re-derived.** A test that reimplements the floor/max
 * validation in TypeScript beside the real one would drift the moment either copy changes — the
 * exact class of defect this project keeps naming (CLAUDE.n8n.md: "n8n's surface drifts"; L-2, L-3,
 * L-10 in the same file). So the jsCode strings are read verbatim out of the exported JSON and run
 * with `new Function`, exercising the SAME source n8n would load. `$` and `$input` are the only
 * external surface every Code node here touches; both are stubbed with the minimum n8n gives them
 * (`.first().json`). `Buffer`/`Date`/`Math` are real Node globals, visible to `new Function` bodies
 * because they execute in the module's global scope — nothing is mocked there.
 *
 * **What this deliberately does not do.** It does not open a live Postgres connection or run
 * `validate_workflow` — those are TC-INT-01..04, excluded from `pnpm test` by design (R-21: no
 * network in CI) and named as a runner in `docs/tasks/task-015-32-acceptance.md`.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW_PATH = 'n8n-workflows/exported/onchain-retention.json';

interface N8nAssignment {
  id: string;
  name: string;
  value: unknown;
  type: string;
}

interface N8nNode {
  id: string;
  name: string;
  type: string;
  parameters: Record<string, unknown>;
}

interface N8nWorkflow {
  nodes: N8nNode[];
}

const workflow: N8nWorkflow = JSON.parse(
  readFileSync(path.join(repoRoot, WORKFLOW_PATH), 'utf8'),
) as N8nWorkflow;

const nodeByName = new Map(workflow.nodes.map((n) => [n.name, n]));

function requireNode(name: string): N8nNode {
  const node = nodeByName.get(name);
  if (!node) throw new Error(`fixture node not found in ${WORKFLOW_PATH}: ${name}`);
  return node;
}

/**
 * Executes a captured n8n Code-node `jsCode` string as the function body n8n itself wraps it in.
 * `refs` stands in for every `$('Node Name')` the body reads; `input` stands in for `$input`.
 */
function runCode(jsCode: string, refs: Record<string, unknown>, input?: unknown): unknown {
  const $ = (name: string): { first: () => { json: unknown } } => {
    if (!(name in refs)) throw new Error(`runCode: no fixture registered for $('${name}')`);
    return { first: () => ({ json: refs[name] }) };
  };
  const $input = { first: () => ({ json: input }) };
  // `new Function`, deliberately: this executes the captured n8n Code-node source verbatim (see the
  // docstring above) rather than a reimplementation that could drift from it.
  const fn = new Function('$', '$input', 'return (function(){' + jsCode + '})()');
  return (fn($, $input) as Array<{ json: unknown }>)[0]!.json;
}

function runPlanJobs(setParametersJson: Record<string, unknown>): {
  startedAt: number;
  jobs: Record<
    string,
    {
      valid: boolean;
      cutoff: number | null;
      detail: string;
      targetTable: string;
      periodFrom: number;
    }
  >;
  b64: Record<string, string>;
} {
  const jsCode = requireNode('Plan jobs').parameters.jsCode as string;
  return runCode(jsCode, { 'Set Parameters': setParametersJson }) as ReturnType<typeof runPlanJobs>;
}

const DEFAULT_PARAMS = {
  diagnosticsPurgeDays: 90,
  traceRawNullDays: 90,
  tracePurgeDays: 365,
  clientUsagePurgeDays: 1095,
};

describe('onchain-retention — client_usage.purge (task 015-19, AC-40)', () => {
  it('TC-UNIT-01: Set Parameters carries clientUsagePurgeDays = 1095', () => {
    const setParameters = requireNode('Set Parameters');
    const assignments = (setParameters.parameters.assignments as { assignments: N8nAssignment[] })
      .assignments;
    const field = assignments.find((a) => a.name === 'clientUsagePurgeDays');
    expect(field).toBeDefined();
    expect(field?.value).toBe(1095);
    expect(field?.type).toBe('number');
  });

  it('TC-UNIT-02: the delete statement counts from terminal_at, never reserved_at', () => {
    const query = requireNode('Purge client_usage').parameters.query as string;
    expect(query).toContain('terminal_at');
    expect(query).not.toContain('reserved_at');
  });

  it('TC-UNIT-03: the delete statement does not branch on state', () => {
    const query = requireNode('Purge client_usage').parameters.query as string;
    expect(query).not.toContain('state');
  });

  it('TC-UNIT-04: a window below the floor (30d) is refused, cutoff null, reason named', () => {
    const plan = runPlanJobs({ ...DEFAULT_PARAMS, clientUsagePurgeDays: 30 });
    const job = plan.jobs['client_usage.purge']!;
    expect(job.valid).toBe(false);
    expect(job.cutoff).toBeNull();
    const detail = JSON.parse(job.detail) as { requestedSetting: unknown; refused: string[] };
    expect(detail.requestedSetting).toBe(30);
    expect(detail.refused.some((r) => r.includes('below the floor'))).toBe(true);
  });

  it('TC-UNIT-05: a window above the maximum (3000d) is refused, cutoff null, reason named', () => {
    const plan = runPlanJobs({ ...DEFAULT_PARAMS, clientUsagePurgeDays: 3000 });
    const job = plan.jobs['client_usage.purge']!;
    expect(job.valid).toBe(false);
    expect(job.cutoff).toBeNull();
    const detail = JSON.parse(job.detail) as { requestedSetting: unknown; refused: string[] };
    expect(detail.requestedSetting).toBe(3000);
    expect(detail.refused.some((r) => r.includes('above the maximum'))).toBe(true);
  });

  it('TC-UNIT-06: a non-integer window ("ninety") is refused, named verbatim in detail', () => {
    const plan = runPlanJobs({ ...DEFAULT_PARAMS, clientUsagePurgeDays: 'ninety' });
    const job = plan.jobs['client_usage.purge']!;
    expect(job.valid).toBe(false);
    expect(job.cutoff).toBeNull();
    const detail = JSON.parse(job.detail) as { requestedSetting: unknown; refused: string[] };
    // The RAW setting, not a parsed/coerced form — "ninety" survives as the exact string.
    expect(detail.requestedSetting).toBe('ninety');
    expect(detail.refused.some((r) => r.includes('not a whole number of days'))).toBe(true);
  });

  it('TC-UNIT-07: Pass event lists all four jobs in outcomes and rowsAffected', () => {
    const plan = runPlanJobs(DEFAULT_PARAMS);
    const rowsAffectedByJob: Record<string, number> = {
      'diagnostics.purge': 0,
      'request_trace.raw_null': 0,
      'request_trace.purge': 0,
      'client_usage.purge': 7,
    };
    const passEventCode = requireNode('Pass event').parameters.jsCode as string;
    const passOut = runCode(passEventCode, {
      'Plan jobs': plan,
      'Row diagnostics.purge': { rows_affected: rowsAffectedByJob['diagnostics.purge'] },
      'Row request_trace.raw_null': { rows_affected: rowsAffectedByJob['request_trace.raw_null'] },
      'Row request_trace.purge': { rows_affected: rowsAffectedByJob['request_trace.purge'] },
      'Row client_usage.purge': { rows_affected: rowsAffectedByJob['client_usage.purge'] },
    }) as { event_b64: string; failed: string[] };

    const [event] = JSON.parse(Buffer.from(passOut.event_b64, 'base64').toString('utf8')) as Array<{
      detail_json: string;
    }>;
    const detail = JSON.parse(event!.detail_json) as {
      outcomes: Array<{ job: string; outcome: string }>;
      rowsAffected: Record<string, number>;
    };
    expect(detail.outcomes).toHaveLength(4);
    expect(detail.outcomes.map((o) => o.job).sort()).toEqual(
      [
        'client_usage.purge',
        'diagnostics.purge',
        'request_trace.purge',
        'request_trace.raw_null',
      ].sort(),
    );
    expect(Object.keys(detail.rowsAffected)).toHaveLength(4);
    expect(detail.rowsAffected['client_usage.purge']).toBe(7);
  });

  it('TC-UNIT-08: Check outcomes names a denominator of 4, not 3', () => {
    const plan = runPlanJobs({ ...DEFAULT_PARAMS, tracePurgeDays: 1000 }); // invalidates three jobs
    const rowsAffectedByJob: Record<string, number> = {
      'diagnostics.purge': 0,
      'request_trace.raw_null': 0,
      'request_trace.purge': 0,
      'client_usage.purge': 0,
    };
    const passEventCode = requireNode('Pass event').parameters.jsCode as string;
    const passOut = runCode(passEventCode, {
      'Plan jobs': plan,
      'Row diagnostics.purge': { rows_affected: rowsAffectedByJob['diagnostics.purge'] },
      'Row request_trace.raw_null': { rows_affected: rowsAffectedByJob['request_trace.raw_null'] },
      'Row request_trace.purge': { rows_affected: rowsAffectedByJob['request_trace.purge'] },
      'Row client_usage.purge': { rows_affected: rowsAffectedByJob['client_usage.purge'] },
    }) as { failed: string[] };
    expect(passOut.failed.length).toBeGreaterThan(0);

    const checkOutcomesCode = requireNode('Check outcomes').parameters.jsCode as string;
    expect(() => runCode(checkOutcomesCode, { 'Plan jobs': plan, 'Pass event': passOut })).toThrow(
      /of 4 windows/,
    );
    try {
      runCode(checkOutcomesCode, { 'Plan jobs': plan, 'Pass event': passOut });
    } catch (err) {
      expect((err as Error).message).toContain('of 4');
      expect((err as Error).message).not.toContain('of 3');
    }

    // A clean pass (all four windows valid) returns the denominator too.
    const cleanPlan = runPlanJobs(DEFAULT_PARAMS);
    const cleanPassOut = runCode(passEventCode, {
      'Plan jobs': cleanPlan,
      'Row diagnostics.purge': { rows_affected: 0 },
      'Row request_trace.raw_null': { rows_affected: 0 },
      'Row request_trace.purge': { rows_affected: 0 },
      'Row client_usage.purge': { rows_affected: 0 },
    }) as { failed: string[] };
    const clean = runCode(checkOutcomesCode, {
      'Plan jobs': cleanPlan,
      'Pass event': cleanPassOut,
    }) as { ok: boolean; jobs: number };
    expect(clean).toEqual({ ok: true, jobs: 4 });
  });

  it('TC-UNIT-09: the cutoff parameter binds as base64 via queryReplacement, not inline SQL text', () => {
    const purgeNode = requireNode('Purge client_usage');
    const options = purgeNode.parameters.options as { queryReplacement: string };
    // An n8n expression referencing Plan jobs' minted base64 payload for this job — not a literal.
    expect(options.queryReplacement).toBe(
      "={{ $('Plan jobs').first().json.b64['client_usage.purge'] }}",
    );
    expect(options.queryReplacement.startsWith('={{')).toBe(true);

    // The query text itself carries no n8n expression syntax — the only channel in is $1.
    const query = purgeNode.parameters.query as string;
    expect(query).not.toContain('{{');
    expect(query).not.toContain('clientUsagePurgeDays');
  });
});
