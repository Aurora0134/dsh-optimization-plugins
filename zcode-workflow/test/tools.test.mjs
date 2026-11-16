import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { compileWorkflowScript, extractMetadataHeader } from '../host/compiler.js';
import { createWorkflowTools } from '../host/tools.js';
import {
  AMEND_BOTH_SCRIPTS,
  ANSWERING_UNAVAILABLE,
  ARGS_WITHOUT_PATH,
  DESCRIPTIONS,
  FILL_SOURCE,
  FILL_UNAVAILABLE,
  INTROSPECTION_UNAVAILABLE,
  MULTIPLE_WORKFLOW_SOURCES,
  NO_WORKFLOW_SOURCE,
  RESUME_MESSAGES,
  RESUME_UNAVAILABLE,
  SAVE_BODY_ONLY,
  SAVE_BOTH_SOURCES,
  SNIPPET_BOTH_SOURCES,
  SNIPPET_NO_SOURCE,
  STOP_UNAVAILABLE,
  TOOL_DENIED,
  TOOL_NAMES,
  runNotFound,
} from '../host/tool-contract.js';
import { TOOL_DESCRIPTIONS, workflowPromptSection } from '../host/prompt.js';

const ROOT = await mkdtemp(path.join(os.tmpdir(), 'zcode-tools-'));
after(() => rm(ROOT, { recursive: true, force: true }));

/** A snapshot the fake runtime returns when a test needs one. */
function runSnapshot(overrides = {}) {
  return {
    runId: 'r1',
    name: 'demo',
    status: 'completed',
    usage: { spentTokens: 0, nodesObserved: 0, nodesRunning: 0, nodesCompleted: 0, nodesFailed: 0 },
    actors: [],
    phases: [],
    holes: [],
    pendingQuestions: [],
    artifacts: [],
    reports: [],
    logTail: [],
    ...overrides,
  };
}

/**
 * Build the tools over a fake runtime/store/compiler and record every call.
 * @param {{ runtime?: object, store?: object, compiler?: object, approval?: object }} [overrides]
 */
function harness(overrides = {}) {
  const calls = [];
  const runtime = {
    prepare: async (request) => {
      calls.push(['prepare', request]);
      return {
        ok: true,
        diagnostics: [],
        draftPath: request.scriptPath,
        scriptPath: request.scriptPath,
        phases: ['Plan'],
        actors: [],
        holes: [],
        artifacts: [],
        worldCommands: [],
        prepared: {
          code: request.code,
          filename: request.scriptPath ?? 'workflow-script.ts',
          compile: { ok: true, phases: ['Plan'], actors: [], holes: [], scriptHash: 'hash', askSpecs: new Map(), sitePhases: new Map() },
        },
      };
    },
    start: async (request) => {
      calls.push(['start', request]);
      return {
        ok: true,
        runId: request.runId ?? 'dwf-run-1',
        scriptPath: request.prepared?.scriptPath ?? request.scriptPath,
        phases: ['Plan'],
        actors: [],
      };
    },
    resume: async (runId) => {
      calls.push(['resume', runId]);
      return { ok: true, runId };
    },
    amend: async (runId, request) => {
      calls.push(['amend', runId, request]);
      return { ok: true, runId: 'dwf-new', supersededRunId: runId, scriptPath: request.scriptPath };
    },
    getRun: async (runId) => {
      calls.push(['getRun', runId]);
      return undefined;
    },
    listRuns: async (options) => {
      calls.push(['listRuns', options]);
      return [];
    },
    waitForRun: async (runId, options) => {
      calls.push(['waitForRun', runId, options]);
      return undefined;
    },
    stopRun: async (runId, reason) => {
      calls.push(['stopRun', runId, reason]);
      return { ok: true, runId, stopReason: reason };
    },
    fillHole: async (runId, holeId, body) => {
      calls.push(['fillHole', runId, holeId, body]);
      return { ok: true, siteId: holeId, name: 'Decide' };
    },
    resolveQuestion: async (qid, answer) => {
      calls.push(['resolveQuestion', qid, answer]);
      return { ok: true, qid, response: `Answer delivered for question ${qid}.` };
    },
    evaluate: async (request) => {
      calls.push(['evaluate', request]);
      return { ok: true, value: { ok: true }, logs: [], diagnostics: [], durationMs: 12 };
    },
    defaultConcurrency: () => 4,
    newRunId: () => 'dwf-run-1',
    ...(overrides.runtime ?? {}),
  };
  const store = {
    writeDraft: async (name, code) => {
      const draft = path.join(ROOT, '.dsh', 'workflow-drafts', `${name}.dwf.ts`);
      calls.push(['writeDraft', name, code, draft]);
      return draft;
    },
    getSavedWorkflow: async () => undefined,
    listSavedWorkflows: async () => {
      const entries = [];
      entries.entries = entries;
      entries.invalid = [];
      return entries;
    },
    saveSavedWorkflow: async (input) => {
      calls.push(['saveSavedWorkflow', input]);
      return {
        ok: true,
        path: path.join(ROOT, '.dsh', 'workflows', `${input.name}.dwf.ts`),
        scope: input.scope,
        overwritten: false,
      };
    },
    validateSavedWorkflowName: () => ({ ok: true }),
    ...(overrides.store ?? {}),
  };
  const compiler = {
    extractMetadataHeader: () => ({ ok: false }),
    compileWorkflowScript: () => ({ ok: true, diagnostics: [], phases: ['Plan'] }),
    ...(overrides.compiler ?? {}),
  };
  const tools = createWorkflowTools({
    ctx: { get: () => undefined },
    runtime,
    store,
    compiler,
    approval: overrides.approval,
    logger: { warn() {}, info() {} },
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { tools, byName, calls, runtime, store, compiler };
}

/** A tool-call exec bound to a session whose cwd is the temp workspace. */
function execFor(cwd = ROOT) {
  return {
    sessionId: 'sess-1',
    agent: { session: { header: { cwd } }, followup() {} },
  };
}

/**
 * 一个带 3 行 metadata 头的脚本文件：正文第 2 行是编译错误（model() 只收字面量），
 * 所以同一个错误在文件里是第 5 行、在正文里是第 2 行。
 * @param {string} name file name inside the temp workspace
 * @returns {Promise<string>} absolute path
 */
async function headedScriptFile(name) {
  const dir = path.join(ROOT, 'headed');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, '/* zcode-workflow\ndescription: headed script\n*/\nconst a = 1;\nconst ref = model(String(args.m));\nreturn a;\n', 'utf8');
  return file;
}

/** A runtime whose prepare reports the real compiler's diagnostics for the body it was handed. */
const realPrepare = {
  prepare: async (request) => {
    const compiled = compileWorkflowScript({ code: request.code, filename: request.scriptPath ?? 'workflow-script.ts' });
    return { ok: false, diagnostics: compiled.diagnostics, draftPath: request.scriptPath, scriptPath: request.scriptPath };
  },
};

/**
 * Diagnose one value against the JSON Schema subset the tool contracts use, plus the lossless-JSON
 * rule the Host enforces on every tool output.
 * @param {object} schema the tool's `output.schema`
 * @param {unknown} value the value the tool returned
 * @param {string} [path] where in the value this node sits, for the message
 * @returns {string[]} violations; empty means the Host would accept the value
 */
function contractViolations(schema, value, path = 'value') {
  if (value === undefined) return [`${path} is undefined`];
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return [`${path} is not lossless JSON`];
  if (Array.isArray(value)) {
    const violations = schema?.type !== undefined && schema.type !== 'array' ? [`${path} must be ${schema.type}`] : [];
    value.forEach((entry, index) => violations.push(...contractViolations(schema?.items ?? {}, entry, `${path}[${index}]`)));
    return violations;
  }
  if (value !== null && typeof value === 'object') {
    const violations = schema?.type !== undefined && schema.type !== 'object' ? [`${path} must be ${schema.type}`] : [];
    for (const key of schema?.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`${path}.${key} is required`);
    }
    for (const [key, entry] of Object.entries(value)) {
      const declared = schema?.properties?.[key];
      if (declared === undefined) {
        if (schema?.additionalProperties === false) violations.push(`${path}.${key} is not declared`);
        else violations.push(...contractViolations({}, entry, `${path}.${key}`));
        continue;
      }
      violations.push(...contractViolations(declared, entry, `${path}.${key}`));
    }
    return violations;
  }
  if (Array.isArray(schema?.enum) && !schema.enum.includes(value)) return [`${path} is not one of ${schema.enum.join(', ')}`];
  const type = schema?.type;
  if (type === 'string' && typeof value !== 'string') return [`${path} must be a string`];
  if ((type === 'number' || type === 'integer') && typeof value !== 'number') return [`${path} must be a number`];
  if (type === 'boolean' && typeof value !== 'boolean') return [`${path} must be a boolean`];
  return [];
}

/* ---------------------------------------------------------------------------------------- */
/* Surface and descriptions                                                                  */
/* ---------------------------------------------------------------------------------------- */

test('the surface is the 12 tools in contract order, with StopWorkflowRun last', () => {
  const h = harness();
  assert.deepEqual(h.tools.map((tool) => tool.name), TOOL_NAMES);
  assert.equal(h.tools.length, 12);
  assert.deepEqual(TOOL_NAMES.slice(0, 11), [
    'CreateWorkflow',
    'AmendWorkflow',
    'ResumeWorkflowRun',
    'GetWorkflowRun',
    'ListWorkflowRuns',
    'FillWorkflowHole',
    'EvalWorkflowSnippet',
    'SaveWorkflow',
    'ListSavedWorkflows',
    'ResolveWorkflowQuestion',
    'TaskOutput',
  ]);
  assert.equal(TOOL_NAMES[11], 'StopWorkflowRun');
});

test('every tool carries a non-empty English description from the contract', () => {
  const h = harness();
  for (const tool of h.tools) {
    assert.equal(typeof tool.description, 'string', tool.name);
    assert.ok(tool.description.length > 150, tool.name);
    assert.equal(tool.description, TOOL_DESCRIPTIONS[
      Object.entries(TOOL_DESCRIPTIONS).find(([, text]) => text === tool.description)?.[0]
    ]);
  }
  assert.equal(DESCRIPTIONS.createWorkflow, TOOL_DESCRIPTIONS.createWorkflow);
  assert.equal(DESCRIPTIONS.stopWorkflowRun, TOOL_DESCRIPTIONS.stopWorkflowRun);
});

test('CreateWorkflow keeps its four paragraphs and verbatim key sentences', () => {
  const text = DESCRIPTIONS.createWorkflow;
  assert.equal(text.split('\n\n').length, 4);
  assert.ok(text.startsWith('Create and run a dynamic workflow: a TypeScript script that orchestrates multiple model-driven subagents with plain control flow'));
  assert.ok(text.includes('- The user explicitly asks for a workflow — "use a workflow", "with a workflow", "使用 workflow", "用工作流", or any phrasing that names workflow/工作流 as the means: this tool is mandatory.'));
  assert.ok(text.includes('Before writing or revising a script, load the `dynamic-workflows` skill with the Skill tool:'));
  assert.ok(text.includes('Pass exactly one source: `script`'));
});

test('AmendWorkflow keeps its three paragraphs and the cache/StopWorkflowRun wording', () => {
  const text = DESCRIPTIONS.amendWorkflow;
  assert.equal(text.split('\n\n').length, 3);
  assert.ok(text.startsWith('Amend an existing dynamic-workflow run with a revised script or revised settings.'));
  assert.ok(text.includes('Do not StopWorkflowRun it first and do not wait for it to finish'));
  assert.ok(text.includes('Load the `dynamic-workflows` skill with the Skill tool before revising a script:'));
});

test('no description or prompt section revives the legacy Workflow facade', () => {
  for (const text of Object.values(DESCRIPTIONS)) {
    assert.ok(!text.includes('WorkflowReport'), text.slice(0, 80));
    assert.ok(!text.includes('parallel('), text.slice(0, 80));
    assert.ok(!text.includes('pipeline('), text.slice(0, 80));
    assert.ok(!/\bbudget\b/u.test(text), text.slice(0, 80));
    assert.ok(!text.includes('workflow(nameOrRef'), text.slice(0, 80));
  }
  const section = workflowPromptSection({ mode: 'alwaysOn' });
  assert.ok(!section.includes('WorkflowReport'));
  assert.ok(!section.includes('parallel('));
  assert.ok(!section.includes('pipeline('));
});

test('the port paths and the Skill name appear where the contract says they do', () => {
  assert.ok(DESCRIPTIONS.listSavedWorkflows.includes('`.dsh/workflows/`'));
  assert.ok(DESCRIPTIONS.listSavedWorkflows.includes('`$DSH_HOME/workflows`'));
  for (const key of ['createWorkflow', 'amendWorkflow', 'fillWorkflowHole', 'evalWorkflowSnippet', 'saveWorkflow']) {
    assert.ok(DESCRIPTIONS[key].includes('`dynamic-workflows`'), key);
  }
});

test('StopWorkflowRun explains that it is the port\'s only extension', () => {
  const text = DESCRIPTIONS.stopWorkflowRun;
  assert.ok(text.includes('This port\'s only tool-surface extension: ZCode stops a workflow through its generic `TaskStop` background-task tool'));
  assert.ok(text.includes('stop reason `model`'));
  assert.ok(text.includes('resumable'));
});

test('ResolveWorkflowQuestion and FillWorkflowHole descriptions match the contract', () => {
  assert.ok(DESCRIPTIONS.resolveWorkflowQuestion.startsWith('Answers a blocking question that a subagent escalated from inside a RUNNING dynamic-workflow run.'));
  assert.ok(DESCRIPTIONS.resolveWorkflowQuestion.includes('`dwfq-...`'));
  assert.ok(DESCRIPTIONS.fillWorkflowHole.startsWith('Supplies the body of a hole that a RUNNING dynamic-workflow run has reached and is waiting at.'));
  assert.ok(DESCRIPTIONS.fillWorkflowHole.includes('Write only the statements of the hole\'s function'));
});

test('TaskOutput states the waiting semantics', () => {
  const text = DESCRIPTIONS.taskOutput;
  assert.ok(text.includes('Blocks until the run settles.'));
  assert.ok(text.includes('The completion notification arrives on its own'));
  assert.ok(text.includes('timeout_ms'));
});

/* ---------------------------------------------------------------------------------------- */
/* Schemas                                                                                   */
/* ---------------------------------------------------------------------------------------- */

test('CreateWorkflow schema: one source, saved shape, trimmed name and bounded settings', () => {
  const schema = harness().byName.CreateWorkflow.parameters;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.required, undefined);
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    'args', 'max_concurrency', 'name', 'path', 'saved', 'script', 'subagent_model',
  ]);
  const saved = schema.properties.saved;
  assert.equal(saved.type, 'object');
  assert.equal(saved.additionalProperties, false);
  assert.deepEqual(saved.required, ['name']);
  assert.equal(saved.properties.name.maxLength, 64);
  assert.equal(saved.properties.name.minLength, 1);
  assert.deepEqual(saved.properties.scope.enum, ['project', 'global']);
  assert.equal(saved.description, 'A saved workflow to run, by name. Exactly one of `script`, `saved` and `path`.');
  assert.equal(schema.properties.script.description, 'The whole workflow script, inline. Exactly one of `script`, `saved` and `path`.');
  assert.equal(schema.properties.path.description, 'A script file on disk (relative or absolute), usually the file a previous result named. Exactly one of `script`, `saved` and `path`.');
  assert.equal(schema.properties.args.description, 'Values for the arguments a `path` file declares. Only with `path`.');
  assert.equal(schema.properties.max_concurrency.type, 'integer');
  assert.equal(schema.properties.max_concurrency.minimum, 1);
  assert.equal(schema.properties.subagent_model.minLength, 1);
  assert.ok(schema.properties.max_concurrency.description.includes('Only when the user asks for more or less parallelism; never as a reaction to provider errors.'));
  assert.ok(schema.properties.subagent_model.description.includes('never a model under another provider the user did not name'));
});

test('AmendWorkflow schema: nullable settings, exclusive script/path, run_id required', () => {
  const schema = harness().byName.AmendWorkflow.parameters;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['run_id']);
  // 契约允许 null（回到默认）；DSH 的 JSON Schema 只收单一 type，所以用 anyOf 表达可空。
  assert.deepEqual(schema.properties.max_concurrency.anyOf, [{ type: 'integer' }, { type: 'null' }]);
  assert.deepEqual(schema.properties.subagent_model.anyOf, [{ type: 'string' }, { type: 'null' }]);
  assert.ok(schema.properties.script.description.includes('This OR `path`, never both; omit both to keep the predecessor\'s script.'));
  assert.ok(schema.properties.path.description.includes('usually the predecessor\'s own script file edited in place'));
  assert.ok(schema.properties.run_id.description.startsWith('ID of the run to amend'));
});

test('FillWorkflowHole schema takes a body, never a JSON value', () => {
  const schema = harness().byName.FillWorkflowHole.parameters;
  assert.deepEqual(schema.required, ['run_id', 'hole_id']);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['hole_id', 'path', 'run_id', 'script']);
  assert.equal(schema.properties.value, undefined);
  assert.ok(schema.properties.script.description.includes('only the statements of the hole\'s function'));
  assert.ok(schema.properties.hole_id.description.includes('hole#21b40fca'));
});

test('ResolveWorkflowQuestion schema requires the question id and the answer', () => {
  const schema = harness().byName.ResolveWorkflowQuestion.parameters;
  assert.deepEqual(schema.required, ['question_id', 'answer']);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['answer', 'question_id']);
  assert.equal(schema.properties.question_id.minLength, 1);
  assert.equal(schema.properties.answer.minLength, 1);
  assert.ok(schema.properties.question_id.description.includes('looks like `dwfq-...`'));
  assert.equal(schema.properties.answer.description, 'The answer text, delivered verbatim to the subagent that asked');
});

test('ListWorkflowRuns schema clamps limit and filters statuses', () => {
  const schema = harness().byName.ListWorkflowRuns.parameters;
  assert.equal(schema.properties.limit.type, 'integer');
  assert.equal(schema.properties.limit.minimum, 1);
  assert.equal(schema.properties.limit.maximum, 50);
  assert.equal(schema.properties.limit.default, 20);
  assert.deepEqual(schema.properties.statuses.items.enum, ['completed', 'errored', 'pending', 'running', 'stopped']);
  assert.ok(schema.properties.limit.description.startsWith('Maximum number of runs to return (1-50, default 20).'));
});

test('EvalWorkflowSnippet, SaveWorkflow, GetWorkflowRun and TaskOutput schemas', () => {
  const h = harness();
  const evalSchema = h.byName.EvalWorkflowSnippet.parameters;
  assert.equal(evalSchema.properties.timeoutMs.minimum, 1000);
  assert.equal(evalSchema.properties.timeoutMs.maximum, 600000);
  assert.ok(evalSchema.properties.code.description.includes('This OR `path`, never both.'));

  const saveSchema = h.byName.SaveWorkflow.parameters;
  assert.deepEqual(saveSchema.required, ['name', 'description', 'scope']);
  assert.equal(saveSchema.properties.name.maxLength, 64);
  assert.deepEqual(saveSchema.properties.scope.enum, ['project', 'global']);
  // 逐项 ArgSpec 结构表达不了：DSH 的 JSON Schema 校验只收布尔 additionalProperties（插件激活时会
  // 直接报 JsonSchemaError），元数据结构由宿主侧校验。
  assert.equal(saveSchema.properties.args.additionalProperties, true);
  assert.ok(saveSchema.properties.args.description.includes('Argument declarations'));

  const getSchema = h.byName.GetWorkflowRun.parameters;
  assert.deepEqual(getSchema.required, ['run_id']);
  assert.equal(getSchema.additionalProperties, false);

  const taskSchema = h.byName.TaskOutput.parameters;
  assert.deepEqual(taskSchema.required, ['run_id']);
  assert.equal(taskSchema.properties.block.type, 'boolean');
  assert.equal(taskSchema.properties.block.default, true);
  assert.equal(taskSchema.properties.timeout_ms.default, 600000);
  assert.equal(taskSchema.properties.timeout_ms.maximum, 3600000);
});

/* ---------------------------------------------------------------------------------------- */
/* CreateWorkflow                                                                            */
/* ---------------------------------------------------------------------------------------- */

test('CreateWorkflow: exactly one source, with the verbatim errors', async () => {
  const h = harness();
  const exec = execFor();
  assert.equal((await h.byName.CreateWorkflow.execute({}, exec)).text, NO_WORKFLOW_SOURCE);
  assert.equal((await h.byName.CreateWorkflow.execute({ script: 'return 1;', path: 'a.ts' }, exec)).text, MULTIPLE_WORKFLOW_SOURCES);
  assert.equal((await h.byName.CreateWorkflow.execute({ script: 'return 1;', saved: { name: 'x' } }, exec)).text, MULTIPLE_WORKFLOW_SOURCES);
  assert.equal((await h.byName.CreateWorkflow.execute({ script: 'return 1;', args: { a: 'b' } }, exec)).text, ARGS_WITHOUT_PATH);
  assert.equal((await h.byName.CreateWorkflow.execute({ saved: { name: 'x' }, args: {} }, exec)).text, ARGS_WITHOUT_PATH);
});

test('CreateWorkflow: a clean compile starts the run and names the draft', async () => {
  const h = harness();
  const result = await h.byName.CreateWorkflow.execute({ script: 'return 1;', name: 'demo' }, execFor());
  assert.equal(result.ok, true);
  assert.equal(result.runId, 'dwf-run-1');
  assert.equal(result.status, 'backgrounded');
  assert.ok(result.text.startsWith('The workflow script compiled cleanly and the run started in the background with ID: dwf-run-1.'));
  assert.ok(result.text.includes('It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.'));
  assert.ok(result.text.includes('The script is saved at '));
  assert.ok(result.text.includes('pass `path` to AmendWorkflow'));
  const draft = h.calls.find(([name]) => name === 'writeDraft');
  assert.equal(draft[1], 'demo');
  const started = h.calls.find(([name]) => name === 'start')[1];
  assert.equal(started.runId, 'dwf-run-1');
  assert.equal(started.name, 'demo');
  assert.equal(started.args && Object.keys(started.args).length, 0);
});

test('CreateWorkflow: compile diagnostics name the draft and say nothing ran', async () => {
  const h = harness({
    runtime: {
      prepare: async (request) => ({
        ok: false,
        diagnostics: [{ line: 3, column: 7, message: 'Cannot find name X.' }],
        draftPath: request.scriptPath,
        scriptPath: request.scriptPath,
      }),
    },
  });
  const result = await h.byName.CreateWorkflow.execute({ script: 'return X;', name: 'demo' }, execFor());
  assert.equal(result.ok, false);
  assert.ok(result.text.startsWith('The workflow script has errors:'));
  assert.match(result.text, /\.dsh[\\/]workflow-drafts[\\/]demo\.dwf\.ts:L3:C7 Cannot find name X\./u);
  assert.match(result.text, /NOTE: The workflow was NOT executed\. The script is saved at .*\.dwf\.ts\./u);
  assert.ok(result.text.includes('do not paste the script inline again.'));
  assert.equal(h.calls.some(([name]) => name === 'start'), false);
});

test('CreateWorkflow: a diagnostic in a headed file is reported on the file line', async () => {
  const file = await headedScriptFile('headed.dwf.ts');
  const h = harness({ compiler: { extractMetadataHeader, compileWorkflowScript }, runtime: realPrepare });
  const result = await h.byName.CreateWorkflow.execute({ path: file }, execFor());
  assert.equal(result.ok, false);
  // 3 行头之后的正文第 2 行，在文件里是第 5 行；列号不随行偏移改变。
  assert.match(result.text, /headed\.dwf\.ts:L5:C13 /u);
  assert.doesNotMatch(result.text, /:L2:/u, 'the body line must not be reported as the file line');
});

test('AmendWorkflow: a diagnostic in a headed file is reported on the file line', async () => {
  const file = await headedScriptFile('headed-amend.dwf.ts');
  const h = harness({
    compiler: { extractMetadataHeader, compileWorkflowScript },
    runtime: {
      ...realPrepare,
      getRun: async () => ({
        id: 'run-prev',
        runId: 'run-prev',
        status: 'completed',
        ownedByThisSession: true,
        name: 'previous',
        cwd: ROOT,
        scriptPath: path.join(ROOT, 'previous.ts'),
        args: {},
      }),
    },
  });
  const result = await h.byName.AmendWorkflow.execute({ run_id: 'run-prev', path: file }, execFor());
  assert.equal(result.ok, false);
  assert.match(result.text, /headed-amend\.dwf\.ts:L5:C13 /u);
  assert.doesNotMatch(result.text, /:L2:/u, 'the body line must not be reported as the file line');
});

test('SaveWorkflow: a diagnostic in a headed file is reported on the file line', async () => {
  const file = await headedScriptFile('headed-save.dwf.ts');
  const h = harness({ compiler: { extractMetadataHeader, compileWorkflowScript } });
  const result = await h.byName.SaveWorkflow.execute({ name: 'saved-headed', description: 'd', scope: 'project', script_path: file }, execFor());
  assert.equal(result.ok, false);
  // 行号属于 script_path 那个文件，文件名也必须是它——不是一个还没写出来的存盘文件。
  assert.match(result.text, /headed[\\/]headed-save\.dwf\.ts:L5:C13 /u);
  assert.doesNotMatch(result.text, /:L2:/u, 'the body line must not be reported as the file line');
  assert.doesNotMatch(result.text, /saved-headed/u, 'the diagnostic names the file its line numbers belong to');
});

test('CreateWorkflow: the saved source validates args and defaults its label', async () => {
  const meta = { name: 'saved-flow', description: 'd', args: { target: { type: 'string', required: true } } };
  const h = harness({
    store: {
      getSavedWorkflow: async () => ({ code: 'return args.target;', meta, path: path.join(ROOT, '.dsh', 'workflows', 'saved-flow.dwf.ts') }),
    },
    compiler: { extractMetadataHeader: () => ({ ok: true, body: 'return args.target;', meta }) },
  });
  const missing = await h.byName.CreateWorkflow.execute({ saved: { name: 'saved-flow' } }, execFor());
  assert.equal(missing.ok, false);
  assert.ok(missing.text.startsWith("missing required argument 'target'"));
  const ok = await h.byName.CreateWorkflow.execute({ saved: { name: 'saved-flow', args: { target: 'src' } } }, execFor());
  assert.equal(ok.ok, true);
  const started = h.calls.find(([name]) => name === 'start')[1];
  assert.equal(started.name, 'saved-flow');
  assert.deepEqual(started.args, { target: 'src' });
});

test('CreateWorkflow: the launch gate asks only after a clean compile, and denial is a result', async () => {
  let asked = 0;
  const approval = {
    allowsSession: () => false,
    request: async () => {
      asked += 1;
      return { decision: 'deny', optionId: 'deny', reason: '' };
    },
  };
  const h = harness({ approval });
  const result = await h.byName.CreateWorkflow.execute({ script: 'return 1;', name: 'demo' }, execFor());
  assert.equal(result.ok, false);
  assert.equal(result.rejected, true);
  assert.equal(result.reason, TOOL_DENIED);
  assert.equal(result.text, TOOL_DENIED);
  assert.equal(asked, 1);
  assert.equal(h.calls.some(([name]) => name === 'start'), false);

  const failing = harness({
    approval,
    runtime: { prepare: async (request) => ({ ok: false, diagnostics: [{ line: 1, column: 1, message: 'bad' }], draftPath: request.scriptPath }) },
  });
  await failing.byName.CreateWorkflow.execute({ script: 'return 1;', name: 'demo' }, execFor());
  assert.equal(asked, 1, 'a compile failure must not open the confirmation window');

  const refined = harness({
    approval: {
      allowsSession: () => false,
      request: async () => ({ decision: 'deny', optionId: 'workflowRefine', reason: 'Use fewer subagents.', reasonSource: 'workflow_refine_feedback' }),
    },
  });
  const refineResult = await refined.byName.CreateWorkflow.execute({ script: 'return 1;', name: 'demo' }, execFor());
  assert.equal(refineResult.ok, false);
  assert.equal(refineResult.reason, 'Use fewer subagents.');
  assert.equal(refineResult.reasonSource, 'workflow_refine_feedback');
  assert.equal(refineResult.preserveReasonFormatting, true);
});

test('the launch gate tells the broker which call asked and how to stop waiting', async () => {
  const seen = [];
  const controller = new AbortController();
  const h = harness({
    approval: {
      allowsSession: () => false,
      request: async (input) => {
        seen.push(input);
        return { decision: 'allow' };
      },
    },
  });
  await h.byName.CreateWorkflow.execute(
    { script: 'return 1;', name: 'demo' },
    { ...execFor(), callId: 'call-42', signal: controller.signal },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].toolCallId, 'call-42');
  assert.equal(seen[0].signal, controller.signal);
  assert.equal(seen[0].payload.script, 'return 1;');
  assert.equal(seen[0].payload.name, 'demo');
  assert.equal(seen[0].payload.kind, 'create_workflow');
});

test('a refused launch answers with a value its own contract accepts', async () => {
  const h = harness({
    approval: {
      allowsSession: () => false,
      // 用户点了拒绝、没填理由：`reasonSource` / `preserveReasonFormatting` 都不存在。
      request: async () => ({ decision: 'deny', optionId: 'deny', reason: '' }),
    },
  });
  const result = await h.byName.CreateWorkflow.execute({ script: 'return 1;', name: 'demo' }, execFor());
  assert.deepEqual(contractViolations(h.byName.CreateWorkflow.output.schema, result), []);
  assert.equal(result.rejected, true);
  assert.equal(result.reason, TOOL_DENIED);
  assert.equal(Object.hasOwn(result, 'reasonSource'), false, 'an absent reason source must not arrive as undefined');
  assert.equal(Object.hasOwn(result, 'preserveReasonFormatting'), false);
});

test('every tool answers a refused call with a value its own contract accepts', async () => {
  const h = harness();
  for (const tool of h.tools) {
    const value = await tool.execute({}, execFor());
    assert.deepEqual(contractViolations(tool.output.schema, value), [], tool.name);
  }
});

test('CreateWorkflow: a session grant skips the window and adjustments reach start', async () => {
  let requested = 0;
  const approval = {
    allowsSession: () => true,
    request: async () => {
      requested += 1;
      return { decision: 'allow' };
    },
  };
  const h = harness({ approval });
  const result = await h.byName.CreateWorkflow.execute({ script: 'return 1;', name: 'demo' }, execFor());
  assert.equal(result.ok, true);
  assert.equal(requested, 0);

  const adjusted = harness({
    approval: {
      allowsSession: () => false,
      request: async () => ({ decision: 'allow', adjustments: { maxConcurrency: 2, subagentModel: 'provider/model' } }),
    },
  });
  await adjusted.byName.CreateWorkflow.execute({ script: 'return 1;', name: 'demo' }, execFor());
  const started = adjusted.calls.find(([name]) => name === 'start')[1];
  assert.equal(started.maxConcurrency, 2);
  assert.equal(started.subagentModel, 'provider/model');
});

test('CreateWorkflow: a path source is read and metadata-less files stay whole', async () => {
  const file = path.join(ROOT, 'inline-script.dwf.ts');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'return 2;\n', 'utf8');
  const h = harness();
  const result = await h.byName.CreateWorkflow.execute({ path: 'inline-script.dwf.ts', name: 'path source' }, execFor());
  assert.equal(result.ok, true);
  assert.ok(result.text.includes('The script file is inline-script.dwf.ts; to revise it later, edit that file and pass `path` to AmendWorkflow.'));
  const started = h.calls.find(([name]) => name === 'start')[1];
  assert.equal(started.code, 'return 2;\n');
  assert.equal(h.calls.some(([name]) => name === 'writeDraft'), false, 'a path source already is the draft');
});

test('CreateWorkflow: paths outside the workspace are refused', async () => {
  const h = harness();
  const result = await h.byName.CreateWorkflow.execute({ path: '../escape.ts' }, execFor());
  assert.equal(result.ok, false);
  assert.ok(result.text.includes('the file path escapes the workspace: ../escape.ts'));
});

/* ---------------------------------------------------------------------------------------- */
/* AmendWorkflow                                                                             */
/* ---------------------------------------------------------------------------------------- */

test('AmendWorkflow: script and path are mutually exclusive', async () => {
  const h = harness();
  const result = await h.byName.AmendWorkflow.execute({ run_id: 'r1', script: 'return 1;', path: 'a.ts' }, execFor());
  assert.equal(result.text, AMEND_BOTH_SCRIPTS);
  assert.equal(h.calls.length, 0);
});

test('AmendWorkflow: unknown run and unreadable script keep ZCode wording', async () => {
  const missing = await harness().byName.AmendWorkflow.execute({ run_id: 'r1', script: 'return 1;' }, execFor());
  assert.equal(missing.text, runNotFound('r1'));

  const h = harness({ runtime: { getRun: async () => runSnapshot({ status: 'errored' }) } });
  const unreadable = await h.byName.AmendWorkflow.execute({ run_id: 'r1', path: 'nope.dwf.ts' }, execFor());
  assert.ok(unreadable.text.startsWith('workflow_script_file_unreadable:'));
  assert.ok(unreadable.text.endsWith('Nothing was stopped or created.'));
});

test('AmendWorkflow: an unchanged file is refused before touching the run', async () => {
  const file = path.join(ROOT, 'unchanged.dwf.ts');
  await writeFile(file, 'return 3;\n', 'utf8');
  const h = harness({ runtime: { getRun: async () => runSnapshot({ status: 'errored', scriptPath: file }) } });
  const result = await h.byName.AmendWorkflow.execute({ run_id: 'r1', path: 'unchanged.dwf.ts' }, execFor());
  assert.ok(result.text.startsWith('workflow_script_unchanged: unchanged.dwf.ts is byte-for-byte the script run r1 was started with'));
  assert.ok(result.text.endsWith('Nothing was stopped or created.'));
  assert.equal(h.calls.some(([name]) => name === 'amend'), false);
});

test('AmendWorkflow: a settled predecessor and a revised script report both sentences', async () => {
  const h = harness({ runtime: { getRun: async () => runSnapshot({ status: 'completed' }) } });
  const result = await h.byName.AmendWorkflow.execute({ run_id: 'r1', script: 'return 4;' }, execFor());
  assert.equal(result.ok, true);
  assert.equal(result.runId, 'dwf-new');
  // 契约 cli.md:135：supersededRunId 只在前驱仍在跑时出现。
  assert.equal(Object.hasOwn(result, 'supersededRunId'), false);
  assert.ok(result.text.startsWith('Run r1 had already settled; its finished work is imported as cache. The revised script started in the background as run dwf-new.'));
  assert.ok(result.text.includes('It is still running — you will be notified with the final output when it completes.'));
  const amended = h.calls.find(([name]) => name === 'amend')[1];
  assert.equal(amended, 'r1');
  assert.equal(h.calls.find(([name]) => name === 'amend')[2].code, 'return 4;');
});

test('AmendWorkflow: a running predecessor is reported as superseded', async () => {
  const h = harness({ runtime: { getRun: async () => runSnapshot({ status: 'running' }) } });
  const result = await h.byName.AmendWorkflow.execute({ run_id: 'r1', script: 'return 5;' }, execFor());
  assert.equal(result.ok, true);
  assert.ok(result.text.startsWith('Run r1 was still running: it has been stopped and superseded, and everything it finished before the stop is imported as cache. It will not send a notification of its own.'));
});

test('AmendWorkflow: a settings-only call reuses the predecessor script', async () => {
  const file = path.join(ROOT, 'settings-only.dwf.ts');
  await writeFile(file, 'return 6;\n', 'utf8');
  const h = harness({ runtime: { getRun: async () => runSnapshot({ status: 'stopped', scriptPath: file }) } });
  const result = await h.byName.AmendWorkflow.execute({ run_id: 'r1', max_concurrency: 3 }, execFor());
  assert.equal(result.ok, true);
  assert.ok(result.text.includes('The script of run r1 started unchanged in the background as run dwf-new.'));
  assert.ok(result.text.includes('At most 3 subagents run at once'));
  const amended = h.calls.find(([name]) => name === 'amend')[2];
  assert.equal(amended.code, 'return 6;\n');
  assert.equal(amended.maxConcurrency, 3);
});

test('AmendWorkflow: diagnostics stop the call before anything is touched', async () => {
  const h = harness({
    runtime: {
      getRun: async () => runSnapshot({ status: 'errored' }),
      prepare: async (request) => ({
        ok: false,
        diagnostics: [{ line: 2, column: 4, message: 'Bad type.' }],
        draftPath: request.scriptPath,
      }),
    },
  });
  const result = await h.byName.AmendWorkflow.execute({ run_id: 'r1', script: 'return x;' }, execFor());
  assert.equal(result.ok, false);
  assert.ok(result.text.startsWith('The revised workflow script has errors:'));
  assert.match(result.text, /L2:C4 Bad type\./u);
  assert.ok(result.text.endsWith('Run r1 was not touched.'));
  assert.equal(h.calls.some(([name]) => name === 'amend'), false);
});

/* ---------------------------------------------------------------------------------------- */
/* ResumeWorkflowRun                                                                         */
/* ---------------------------------------------------------------------------------------- */

test('ResumeWorkflowRun: unavailable runtime and refusal texts', async () => {
  const unavailable = harness({ runtime: { resume: undefined } });
  assert.equal((await unavailable.byName.ResumeWorkflowRun.execute({ run_id: 'r1' }, execFor())).text, RESUME_UNAVAILABLE);

  const notResumable = harness({ runtime: { resume: async () => ({ ok: false, code: 'NOT_RESUMABLE', message: 'nope' }) } });
  assert.equal((await notResumable.byName.ResumeWorkflowRun.execute({ run_id: 'r1' }, execFor())).text, RESUME_MESSAGES.not_resumable);

  const superseded = harness({ runtime: { resume: async () => ({ ok: false, code: 'NOT_RESUMABLE', message: 'superseded by r2' }) } });
  const supersededText = (await superseded.byName.ResumeWorkflowRun.execute({ run_id: 'r1' }, execFor())).text;
  assert.ok(supersededText.startsWith('workflow_run_not_resumable:'));
});

test('ResumeWorkflowRun: success uses the same run id and the contract text', async () => {
  const h = harness();
  const result = await h.byName.ResumeWorkflowRun.execute({ run_id: 'r1' }, execFor());
  assert.equal(result.ok, true);
  assert.equal(result.runId, 'r1');
  assert.equal(result.status, 'backgrounded');
  assert.equal(result.text, 'The workflow run r1 has been resumed and is running in the background. It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.');
  assert.deepEqual(h.calls[0], ['resume', 'r1']);
});

test('ResumeWorkflowRun: a compile failure carries the diagnostics', async () => {
  const h = harness({
    runtime: {
      resume: async () => ({ ok: false, diagnostics: [{ line: 1, column: 2, message: 'Still broken.' }], draftPath: 'draft.dwf.ts' }),
    },
  });
  const result = await h.byName.ResumeWorkflowRun.execute({ run_id: 'r1' }, execFor());
  assert.equal(result.ok, false);
  assert.ok(result.text.startsWith('workflow_run_compile_failed: the stored script of run r1 no longer compiles'));
  assert.ok(result.text.includes('draft.dwf.ts:L1:C2 Still broken.'));
});

/* ---------------------------------------------------------------------------------------- */
/* GetWorkflowRun / ListWorkflowRuns                                                          */
/* ---------------------------------------------------------------------------------------- */

test('GetWorkflowRun: unavailable, missing, then a full snapshot', async () => {
  const unavailable = harness({ runtime: { getRun: undefined } });
  assert.equal((await unavailable.byName.GetWorkflowRun.execute({ run_id: 'r1' }, execFor())).text, INTROSPECTION_UNAVAILABLE);

  const missing = harness();
  assert.equal((await missing.byName.GetWorkflowRun.execute({ run_id: 'r1' }, execFor())).text, runNotFound('r1'));

  const snapshot = runSnapshot({
    status: 'running',
    usage: { spentTokens: 12, nodesObserved: 2, nodesRunning: 1, nodesCompleted: 1, nodesFailed: 0 },
    actors: [{ siteId: 'ask#1', ordinal: 1, name: 'judge', status: 'running' }],
    phases: ['Plan', 'Review'],
    currentPhase: 'Review',
    holes: [{ siteId: 'hole#abc', name: 'Decide', state: 'waiting', type: 'Plan' }],
    pendingQuestions: [{ qid: 'dwfq-1', actorName: 'judge', question: 'Which one?', context: 'ctx' }],
    artifacts: [{ id: 'report', kind: 'markdown', version: 2, title: 'Report', primary: true }],
    reports: [{ preview: '{"found":1}' }],
    logTail: [{ sequence: 1, message: 'hello' }],
  });
  const h = harness({ runtime: { getRun: async () => snapshot } });
  const result = await h.byName.GetWorkflowRun.execute({ run_id: 'r1' }, execFor());
  assert.equal(result.ok, true);
  for (const expected of [
    'Run r1 "demo" — running',
    'Usage: 12 tokens',
    '- judge, running',
    '- Plan',
    '- Review (current)',
    'hole#abc "Decide", waiting',
    'dwfq-1 from judge: Which one?',
    '- report v2 (markdown) "Report" [primary]',
    '{"found":1}',
    '- hello',
  ]) {
    assert.ok(result.text.includes(expected), expected);
  }
});

test('ListWorkflowRuns: clamp, filter, annotation and empty state', async () => {
  const rows = [
    { runId: 'r1', label: 'one', status: 'running', runId2: undefined, ownedByThisSession: true, createdAt: 1, updatedAt: 2, spentTokens: 0 },
    { runId: 'r2', label: 'two', status: 'completed', ownedByThisSession: false, createdAt: 1, updatedAt: 2, spentTokens: 0 },
  ];
  const h = harness({ runtime: { listRuns: async (options) => { h.calls.push(['listRuns', options]); return rows; } } });
  const all = await h.byName.ListWorkflowRuns.execute({ limit: 100 }, execFor());
  assert.equal(all.ok, true);
  assert.equal(all.runs.length, 2);
  assert.ok(all.text.includes('possibly_interrupted="true"'));
  assert.ok(all.text.includes('another session'));
  const clamped = h.calls.find(([name]) => name === 'listRuns')[1];
  // 多要一行来判定 `truncated`：50 是契约上限，探测请求是 limit + 1。
  assert.equal(clamped.limit, 51);
  assert.equal(clamped.sessionId, 'sess-1');

  const filtered = await h.byName.ListWorkflowRuns.execute({ statuses: ['running'] }, execFor());
  assert.equal(filtered.runs.length, 1);
  assert.equal(filtered.runs[0].runId, 'r1');

  const filteredNone = await h.byName.ListWorkflowRuns.execute({ statuses: ['stopped'] }, execFor());
  assert.equal(filteredNone.text, 'No workflow runs match that status filter (stopped).');
  assert.deepEqual(filteredNone.runs, []);

  const empty = harness();
  const emptyResult = await empty.byName.ListWorkflowRuns.execute({}, execFor());
  assert.equal(emptyResult.text, 'No workflow runs exist in this project yet.');
  assert.deepEqual(emptyResult.runs, []);
});

/* ---------------------------------------------------------------------------------------- */
/* FillWorkflowHole                                                                          */
/* ---------------------------------------------------------------------------------------- */

test('FillWorkflowHole: exactly one body source, verbatim', async () => {
  const h = harness();
  assert.equal((await h.byName.FillWorkflowHole.execute({ run_id: 'r1', hole_id: 'hole#1' }, execFor())).text, FILL_SOURCE);
  assert.equal((await h.byName.FillWorkflowHole.execute({ run_id: 'r1', hole_id: 'hole#1', script: 'return 1;', path: 'f.ts' }, execFor())).text, FILL_SOURCE);
});

test('FillWorkflowHole: the body statements reach the runtime and phases are diffed', async () => {
  let snapshots = 0;
  const h = harness({
    runtime: {
      getRun: async () => {
        snapshots += 1;
        return runSnapshot({
          status: 'running',
          phases: snapshots === 1 ? ['Plan'] : ['Plan', 'Review'],
          scriptPath: path.join(ROOT, '.dsh', 'workflow-drafts', 'demo.dwf.ts'),
        });
      },
    },
  });
  const result = await h.byName.FillWorkflowHole.execute({ run_id: 'r1', hole_id: 'hole#abc', script: 'return { plan: "x" };' }, execFor());
  assert.equal(result.ok, true);
  assert.equal(result.fill.siteId, 'hole#abc');
  assert.equal(result.fill.name, 'Decide');
  assert.deepEqual(h.calls.find(([name]) => name === 'fillHole')[3], { script: 'return { plan: "x" };' });
  assert.ok(result.text.startsWith('The fill joined run r1 at hole "Decide" (hole#abc); the branch parked there has resumed'));
  assert.ok(result.text.includes('It added the phase Review.'));
  assert.ok(result.text.includes('Do not wait for the run or poll it with TaskOutput; you will be notified when it completes.'));
});

test('FillWorkflowHole: a missing run and a non-waiting hole keep the contract errors', async () => {
  const missing = harness({ runtime: { fillHole: async () => ({ ok: false, code: 'RUN_NOT_FOUND', message: 'nope' }) } });
  const missingResult = await missing.byName.FillWorkflowHole.execute({ run_id: 'r9', hole_id: 'hole#1', script: 'return 1;' }, execFor());
  assert.ok(missingResult.text.startsWith(runNotFound('r9')));
  assert.ok(missingResult.text.includes('Nothing was filled:'));

  const notWaiting = harness({ runtime: { fillHole: async () => ({ ok: false, code: 'NOT_WAITING', message: 'workflow_hole_not_waiting: run r1 is not waiting at hole#1.' }) } });
  const notWaitingResult = await notWaiting.byName.FillWorkflowHole.execute({ run_id: 'r1', hole_id: 'hole#1', script: 'return 1;' }, execFor());
  assert.ok(notWaitingResult.text.startsWith('workflow_hole_not_waiting: run r1 is not waiting at hole#1.'));
  assert.ok(notWaitingResult.text.endsWith('Nothing was filled.'));

  const unavailable = harness({ runtime: { fillHole: undefined } });
  assert.equal((await unavailable.byName.FillWorkflowHole.execute({ run_id: 'r1', hole_id: 'hole#1', script: 'return 1;' }, execFor())).text, FILL_UNAVAILABLE);
});

test('FillWorkflowHole: a file body is read whole', async () => {
  const file = path.join(ROOT, 'fill-body.ts');
  await writeFile(file, 'return 7;\n', 'utf8');
  const h = harness();
  await h.byName.FillWorkflowHole.execute({ run_id: 'r1', hole_id: 'hole#1', path: 'fill-body.ts' }, execFor());
  assert.deepEqual(h.calls.find(([name]) => name === 'fillHole')[3], { script: 'return 7;\n' });
});

/* ---------------------------------------------------------------------------------------- */
/* EvalWorkflowSnippet                                                                       */
/* ---------------------------------------------------------------------------------------- */

test('EvalWorkflowSnippet: source errors and the timeout clamp', async () => {
  const h = harness();
  assert.equal((await h.byName.EvalWorkflowSnippet.execute({}, execFor())).text, SNIPPET_NO_SOURCE);
  assert.equal((await h.byName.EvalWorkflowSnippet.execute({ code: 'return 1;', path: 's.ts' }, execFor())).text, SNIPPET_BOTH_SOURCES);

  await h.byName.EvalWorkflowSnippet.execute({ code: 'return 1;', timeoutMs: 5 }, execFor());
  await h.byName.EvalWorkflowSnippet.execute({ code: 'return 1;', timeoutMs: 900000 }, execFor());
  await h.byName.EvalWorkflowSnippet.execute({ code: 'return 1;' }, execFor());
  const timeouts = h.calls.filter(([name]) => name === 'evaluate').map(([, request]) => request.timeoutMs);
  assert.deepEqual(timeouts, [1000, 600000, 60000]);
});

test('EvalWorkflowSnippet: compile failure and success responses', async () => {
  const failing = harness({ runtime: { evaluate: async () => ({ ok: false, diagnostics: [{ line: 1, column: 2, message: 'bad' }] }) } });
  const failure = await failing.byName.EvalWorkflowSnippet.execute({ code: 'x' }, execFor());
  assert.equal(failure.ok, false);
  assert.ok(failure.text.startsWith('The snippet has errors:'));
  assert.ok(failure.text.includes('snippet.ts:L1:C2 bad'));
  assert.ok(failure.text.includes('NOTE: The snippet was NOT executed — fix the errors above and call the tool again.'));

  const success = harness();
  const result = await success.byName.EvalWorkflowSnippet.execute({ code: 'return { ok: true };' }, execFor());
  assert.equal(result.ok, true);
  assert.ok(result.text.startsWith('The snippet completed in 12ms.'));
  assert.ok(result.text.includes('"ok": true'));
});

/* ---------------------------------------------------------------------------------------- */
/* SaveWorkflow / ListSavedWorkflows                                                         */
/* ---------------------------------------------------------------------------------------- */

test('SaveWorkflow: source exclusivity, body-only rule, scope and success', async () => {
  const h = harness();
  assert.equal((await h.byName.SaveWorkflow.execute({ name: 'x', description: 'd', scope: 'project' }, execFor())).text, SAVE_BOTH_SOURCES);
  assert.equal((await h.byName.SaveWorkflow.execute({ name: 'x', description: 'd', scope: 'project', script: 'a', script_path: 'b' }, execFor())).text, SAVE_BOTH_SOURCES);
  const withBlock = await h.byName.SaveWorkflow.execute({ name: 'x', description: 'd', scope: 'project', script: '/* zcode-workflow\nx\n*/\nreturn 1;' }, execFor());
  assert.equal(withBlock.text, SAVE_BODY_ONLY);
  const missingScope = await h.byName.SaveWorkflow.execute({ name: 'x', description: 'd', script: 'return 1;' }, execFor());
  assert.ok(missingScope.text.includes('`scope` is required'));
  const saved = await h.byName.SaveWorkflow.execute({ name: 'x', description: 'd', scope: 'global', script: 'return 1;', args: { target: { type: 'string' } } }, execFor());
  assert.equal(saved.ok, true);
  assert.ok(saved.text.startsWith('Saved the global workflow "x" at '));
  assert.equal(saved.scope, 'global');
  const input = h.calls.find(([name]) => name === 'saveSavedWorkflow')[1];
  assert.equal(input.scope, 'global');
  assert.deepEqual(input.meta.args, { target: { type: 'string' } });
});

test('SaveWorkflow: an invalid name and compile errors save nothing', async () => {
  const invalid = harness({ store: { validateSavedWorkflowName: () => ({ ok: false, message: 'workflow names may only contain letters' }) } });
  const invalidResult = await invalid.byName.SaveWorkflow.execute({ name: 'bad name', description: 'd', scope: 'project', script: 'return 1;' }, execFor());
  assert.ok(invalidResult.text.startsWith('workflow names may only contain letters'));

  const broken = harness({ compiler: { compileWorkflowScript: () => ({ ok: false, diagnostics: [{ line: 1, column: 1, message: 'bad' }] }) } });
  const brokenResult = await broken.byName.SaveWorkflow.execute({ name: 'x', description: 'd', scope: 'project', script: 'return x;' }, execFor());
  assert.ok(brokenResult.text.startsWith('The workflow script has errors:'));
  assert.ok(brokenResult.text.includes('NOTE: Nothing was saved'));
});

test('ListSavedWorkflows: empty state, entries and invalid files', async () => {
  const empty = harness();
  assert.equal((await empty.byName.ListSavedWorkflows.execute({}, execFor())).text, 'No saved workflows exist for this project or globally.');

  const entries = [{ name: 'review', scope: 'project', meta: { description: 'Reviews PRs.', whenToUse: 'When reviewing.', args: { pr: { type: 'number', required: true } } }, path: path.join(ROOT, '.dsh', 'workflows', 'review.dwf.ts') }];
  entries.entries = entries;
  entries.invalid = [{ path: path.join(ROOT, '.dsh', 'workflows', 'bad.dwf.ts'), reason: 'invalid_metadata' }];
  const h = harness({ store: { listSavedWorkflows: async () => entries } });
  const result = await h.byName.ListSavedWorkflows.execute({}, execFor());
  assert.equal(result.ok, true);
  assert.ok(result.text.includes('- review [project] — Reviews PRs.'));
  assert.ok(result.text.includes('When to use: When reviewing.'));
  assert.ok(result.text.includes('pr:number (required)'));
  assert.ok(result.text.includes('(unreadable)'));
  assert.equal(result.workflows[0].name, 'review');
});

/* ---------------------------------------------------------------------------------------- */
/* ResolveWorkflowQuestion                                                                   */
/* ---------------------------------------------------------------------------------------- */

test('ResolveWorkflowQuestion: both fields required (min 1)', async () => {
  const h = harness();
  assert.equal((await h.byName.ResolveWorkflowQuestion.execute({ question_id: 'dwfq-1' }, execFor())).ok, false);
  assert.equal((await h.byName.ResolveWorkflowQuestion.execute({ answer: 'yes' }, execFor())).ok, false);
  assert.equal((await h.byName.ResolveWorkflowQuestion.execute({ question_id: '', answer: 'yes' }, execFor())).ok, false);
});

test('ResolveWorkflowQuestion: the answer reaches the runtime and the success text is verbatim', async () => {
  const h = harness();
  const result = await h.byName.ResolveWorkflowQuestion.execute({ question_id: 'dwfq-1', answer: 'Use the second option.' }, execFor());
  assert.equal(result.ok, true);
  assert.equal(result.qid, 'dwfq-1');
  assert.equal(result.text, 'Answer delivered for question dwfq-1. The subagent that asked has resumed its turn with your answer; the run keeps going as before.');
  assert.deepEqual(h.calls[0], ['resolveQuestion', 'dwfq-1', 'Use the second option.']);
});

test('ResolveWorkflowQuestion: unknown, already resolved, and unavailable', async () => {
  const unknown = harness({ runtime: { resolveQuestion: async () => ({ ok: false, code: 'UNKNOWN_QUESTION', message: 'nope' }) } });
  assert.ok((await unknown.byName.ResolveWorkflowQuestion.execute({ question_id: 'dwfq-1', answer: 'a' }, execFor())).text.startsWith('unknown_question: no workflow question with ID dwfq-1 is waiting'));

  const resolved = harness({ runtime: { resolveQuestion: async () => ({ ok: false, code: 'ALREADY_RESOLVED', message: 'nope' }) } });
  assert.ok((await resolved.byName.ResolveWorkflowQuestion.execute({ question_id: 'dwfq-1', answer: 'a' }, execFor())).text.startsWith('already_resolved: question dwfq-1 has already been answered'));

  const unavailable = harness({ runtime: { resolveQuestion: undefined, answerQuestion: undefined } });
  assert.equal((await unavailable.byName.ResolveWorkflowQuestion.execute({ question_id: 'dwfq-1', answer: 'a' }, execFor())).text, ANSWERING_UNAVAILABLE);
});

/* ---------------------------------------------------------------------------------------- */
/* TaskOutput / StopWorkflowRun                                                              */
/* ---------------------------------------------------------------------------------------- */

test('TaskOutput: missing run, terminal snapshot, blocking success and timeout', async () => {
  const missing = harness();
  assert.equal((await missing.byName.TaskOutput.execute({ run_id: 'r1' }, execFor())).text, runNotFound('r1'));

  const done = harness({ runtime: { getRun: async () => runSnapshot({ status: 'completed', result: { ok: true } }) } });
  const terminal = await done.byName.TaskOutput.execute({ run_id: 'r1' }, execFor());
  assert.equal(terminal.retrieval_status, 'success');
  assert.ok(terminal.text.includes('Return value:'));
  assert.equal(done.calls.some(([name]) => name === 'waitForRun'), false);

  const running = runSnapshot({ status: 'running' });
  const waited = harness({
    runtime: {
      getRun: async () => running,
      waitForRun: async () => runSnapshot({ status: 'completed', result: 'done' }),
    },
  });
  const blocking = await waited.byName.TaskOutput.execute({ run_id: 'r1', timeout_ms: 2000 }, execFor());
  assert.equal(blocking.retrieval_status, 'success');
  assert.ok(blocking.text.includes('done'));

  const timedOut = harness({ runtime: { getRun: async () => running, waitForRun: async () => running } });
  const timeout = await timedOut.byName.TaskOutput.execute({ run_id: 'r1', timeout_ms: 1000 }, execFor());
  assert.equal(timeout.retrieval_status, 'timeout');
  assert.ok(timeout.text.includes('It is still running after 1000ms.'));

  const nonBlocking = await timedOut.byName.TaskOutput.execute({ run_id: 'r1', block: false }, execFor());
  assert.equal(nonBlocking.retrieval_status, 'not_ready');

  const foreign = harness({
    runtime: {
      listRuns: async () => [{ runId: 'r1', status: 'running', ownedByThisSession: false }],
      getRun: async () => running,
    },
  });
  const foreignResult = await foreign.byName.TaskOutput.execute({ run_id: 'r1' }, execFor());
  assert.equal(foreignResult.ok, false);
  assert.equal(foreignResult.text, 'No task found with ID: r1 — this session did not start it. Use GetWorkflowRun for a run another session owns.');
});

test('StopWorkflowRun: the port extension stops with reason model', async () => {
  const h = harness();
  const result = await h.byName.StopWorkflowRun.execute({ run_id: 'r1' }, execFor());
  assert.equal(result.ok, true);
  assert.equal(result.stopReason, 'model');
  assert.ok(result.text.startsWith('Stopped run r1 (stop_reason "model")'));
  assert.deepEqual(h.calls[0], ['stopRun', 'r1', 'model']);

  const settled = harness({ runtime: { stopRun: async () => ({ ok: false, code: 'RUN_SETTLED', message: 'workflow_run_settled: run r1 already settled.' }) } });
  const settledResult = await settled.byName.StopWorkflowRun.execute({ run_id: 'r1' }, execFor());
  assert.equal(settledResult.ok, false);
  assert.ok(settledResult.text.startsWith('workflow_run_settled:'));

  const unavailable = harness({ runtime: { stopRun: undefined } });
  assert.equal((await unavailable.byName.StopWorkflowRun.execute({ run_id: 'r1' }, execFor())).text, STOP_UNAVAILABLE);
});

/* ---------------------------------------------------------------------------------------- */
/* 契约输出形状（cli.md §1.2–§1.6：k4 / X0e / Uoe / V0e）                                     */
/* ---------------------------------------------------------------------------------------- */

test('CreateWorkflow / ResumeWorkflowRun：信封用契约的 camelCase 字段', async () => {
  const h = harness();
  const created = await h.byName.CreateWorkflow.execute({ script: 'return 1;', name: 'demo' }, execFor());
  assert.equal(created.ok, true);
  assert.deepEqual(Object.keys(created).sort(), [
    'backgroundTaskId', 'diagnostics', 'ok', 'response', 'runId', 'scriptPath', 'status', 'text',
  ]);
  assert.equal(created.status, 'backgrounded');
  assert.equal(created.backgroundTaskId, 'dwf-run-1');

  const resumed = await h.byName.ResumeWorkflowRun.execute({ run_id: 'r1' }, execFor());
  assert.deepEqual(Object.keys(resumed).sort(), ['backgroundTaskId', 'ok', 'response', 'runId', 'status', 'text']);
  assert.equal(resumed.runId, 'r1');
  assert.equal(resumed.backgroundTaskId, 'r1');
});

test('GetWorkflowRun：response 是 Uoe 形状，health/holes/logTail/pendingQuestions 按契约', async () => {
  const stalledSince = 1_700_000_100_000;
  const snapshot = runSnapshot({
    name: 'n'.repeat(600),
    status: 'stopped',
    stopReason: 'superseded',
    supersededBy: 'dwf-next',
    usage: { spentTokens: 42, nodesObserved: 3, nodesRunning: 0, nodesCompleted: 2, nodesFailed: 1 },
    actors: [{ siteId: 'ask#1', ordinal: 1, name: 'judge', status: 'completed' }],
    phases: ['Plan', 'Review'],
    currentPhase: 'Review',
    health: {
      consecutiveFailures: 1, cachedSteps: 2, pendingQuestionsKnown: true,
      lastProgressAt: 1_700_000_000_000, stalledSince,
    },
    holes: [
      { siteId: 'hole#a', ordinal: 1, name: 'Decide', state: 'waiting', since: 5 },
      { siteId: 'hole#b', ordinal: 1, name: 'Draft', state: 'filled', filledAt: 7, filledBy: 'sess-1' },
    ],
    pendingQuestions: [{ qid: 'dwfq-1', actorSiteId: 'ask#1', actorOrdinal: 1, actorName: 'judge', question: 'Which one?', askedAt: 9 }],
    artifacts: [{ id: 'report', kind: 'markdown', version: 2, title: 'Report', itemCount: 3, primary: true }],
    logTail: [{ sequence: 4, message: 'x'.repeat(3000), at: 1234 }],
  });
  const h = harness({ runtime: { getRun: async () => snapshot } });
  const result = await h.byName.GetWorkflowRun.execute({ run_id: 'r1' }, execFor());
  assert.equal(result.ok, true);
  assert.equal(typeof result.spentTokens, 'number');
  assert.equal(typeof result.generatedAt, 'number');
  assert.equal(result.summary.length, 400, 'summary 截到契约的 400');
  assert.deepEqual(result.usage, { spentTokens: 42, nodesObserved: 3, nodesRunning: 0, nodesCompleted: 2, nodesFailed: 1 });
  assert.deepEqual(result.actors, [{ siteId: 'ask#1', ordinal: 1, name: 'judge' }]);
  assert.deepEqual(result.phases.map((phase) => `${phase.name}:${phase.state}`), ['Plan:done', 'Review:current']);
  assert.equal(result.health.lastProgressAt, 1_700_000_000_000);
  assert.equal(result.health.stalledSince, stalledSince);
  // 契约 cli.md:190：`<superseded_by>` 指名后继，模型面文本里要真的出现。
  assert.match(result.text, /<superseded_by>dwf-next<\/superseded_by>/);
  // health.concurrency 只透契约四字段，内部 key/epoch/streak 不外泄（cli.md:171）。
  // 快照没给 concurrency 就不造一个（投影发生在 runtime，不在这层）。
  assert.equal(result.health.concurrency, undefined);
  assert.deepEqual(result.logTail, [{ sequence: 4, message: `${'x'.repeat(1023)}…`, at: 1234 }]);
  assert.deepEqual(result.holes.map((hole) => `${hole.siteId}:${hole.state}`), ['hole#a:waiting', 'hole#b:filled']);
  assert.equal(result.holes[1].filledAt, 7);
  assert.equal(result.holes[1].filledBy, 'sess-1');
  assert.equal(result.pendingQuestions[0].actor, 'ask#1@1');
  assert.deepEqual(result.artifacts[0], { id: 'report', kind: 'markdown', title: 'Report', version: 2, itemCount: 3, primary: true });
  // 旧自由形状与契约外的名字不再出现。
  for (const legacy of ['run_id', 'stop_reason', 'actorSiteId', 'actorOrdinal']) {
    assert.equal(Object.hasOwn(result, legacy), false, legacy);
  }

  // 没有停滞时 `stalledSince` 不出现，`lastProgressAt` 仍在。
  const healthy = harness({
    runtime: {
      getRun: async () => runSnapshot({ health: { consecutiveFailures: 0, cachedSteps: 0, pendingQuestionsKnown: true, lastProgressAt: 5 } }),
    },
  });
  const healthyResult = await healthy.byName.GetWorkflowRun.execute({ run_id: 'r1' }, execFor());
  assert.equal(Object.hasOwn(healthyResult.health, 'stalledSince'), false);
  assert.equal(healthyResult.health.lastProgressAt, 5);
});

test('ListWorkflowRuns：行按 V0e，超过 limit 时带 truncated', async () => {
  const rows = (count) => Array.from({ length: count }, (unused, index) => ({
    runId: `r${index + 1}`, label: `run ${index + 1}`, status: 'completed',
    ownedByThisSession: true, createdAt: index, updatedAt: index, spentTokens: 0,
  }));
  const overflow = harness({ runtime: { listRuns: async (options) => { overflow.calls.push(['listRuns', options]); return rows(3); } } });
  const page = await overflow.byName.ListWorkflowRuns.execute({ limit: 2 }, execFor());
  assert.equal(page.runs.length, 2);
  assert.equal(page.truncated, true);
  assert.deepEqual(page.runs.map((row) => row.runId), ['r1', 'r2']);
  assert.deepEqual(Object.keys(page.runs[0]).sort(), [
    'createdAt', 'label', 'labelSource', 'ownedByThisSession', 'runId', 'spentTokens', 'status', 'updatedAt',
  ]);
  assert.equal(page.runs[0].labelSource, 'script');
  // store 判定为显式命名的 run，模型面必须是 "name"（cli.md:205）。
  const named = harness({
    runtime: { listRuns: async () => [{ ...rows(1)[0], label: '部署收口', name: '部署收口', labelSource: 'name' }] },
  });
  const namedPage = await named.byName.ListWorkflowRuns.execute({ limit: 1 }, execFor());
  assert.equal(namedPage.runs[0].label, '部署收口');
  assert.equal(namedPage.runs[0].labelSource, 'name');
  assert.equal(overflow.calls.find(([name]) => name === 'listRuns')[1].limit, 3);

  const exact = harness({ runtime: { listRuns: async () => rows(2) } });
  const noOverflow = await exact.byName.ListWorkflowRuns.execute({ limit: 2 }, execFor());
  assert.equal(noOverflow.truncated, undefined);
  assert.equal(noOverflow.runs.length, 2);
});

test('每个工具的输出字段都在自己声明的 output schema 里，required 一个不缺', async () => {
  const h = harness({
    runtime: {
      getRun: async () => runSnapshot({ status: 'completed' }),
      listRuns: async () => [{
        runId: 'r1', label: 'demo', status: 'completed',
        ownedByThisSession: true, createdAt: 1, updatedAt: 2, spentTokens: 0,
      }],
    },
  });
  const exec = execFor();
  const calls = [
    ['CreateWorkflow', { script: 'return 1;', name: 'demo' }],
    ['AmendWorkflow', { run_id: 'r1', script: 'return 2;' }],
    ['ResumeWorkflowRun', { run_id: 'r1' }],
    ['GetWorkflowRun', { run_id: 'r1' }],
    ['ListWorkflowRuns', {}],
    ['FillWorkflowHole', { run_id: 'r1', hole_id: 'hole#a', script: 'return 1;' }],
    ['EvalWorkflowSnippet', { code: 'return 1;' }],
    ['SaveWorkflow', { name: 'x', description: 'd', scope: 'project', script: 'return 1;' }],
    ['ListSavedWorkflows', {}],
    ['ResolveWorkflowQuestion', { question_id: 'dwfq-1', answer: 'left' }],
    ['TaskOutput', { run_id: 'r1', block: false }],
    ['StopWorkflowRun', { run_id: 'r1' }],
  ];
  for (const [name, args] of calls) {
    const tool = h.byName[name];
    const result = await tool.execute(args, exec);
    assert.equal(result.ok, true, name);
    const declared = Object.keys(tool.output.schema.properties);
    for (const key of Object.keys(result)) {
      assert.equal(declared.includes(key), true, `${name} 返回了未声明的字段 ${key}`);
    }
    for (const key of tool.output.schema.required ?? []) {
      assert.equal(Object.hasOwn(result, key), true, `${name} 缺必填输出字段 ${key}`);
    }
  }
});

/* ---------------------------------------------------------------------------------------- */
/* Prompt section                                                                            */
/* ---------------------------------------------------------------------------------------- */

test('the prompt section names the real skill and every registered tool, gated by mode', () => {
  const always = workflowPromptSection({ mode: 'alwaysOn' });
  assert.ok(always.includes('`dynamic-workflows`'));
  assert.ok(always.includes('The tools are available in every turn.'));
  for (const name of TOOL_NAMES) assert.ok(always.includes(name), name);
  assert.ok(!always.includes('WorkflowReport'));
  assert.ok(!always.includes('pipeline('));

  const onDemand = workflowPromptSection({ mode: 'onDemand' });
  assert.ok(onDemand.includes('The tools become available after the user types /workflow in this session.'));

  const disabled = workflowPromptSection({ mode: 'disabled' });
  assert.ok(disabled.includes('Dynamic workflows are turned off in this profile.'));
});
