/**
 * Model-facing tools of the dynamic-workflow port.
 *
 * The surface mirrors ZCode's authoring tools (`CreateWorkflow`, `AmendWorkflow`,
 * `GetWorkflowRun`, `ListWorkflowRuns`, `TaskOutput`, `ResumeWorkflowRun`,
 * `FillWorkflowHole`, `SaveWorkflow`, `ListSavedWorkflows`, `EvalWorkflowSnippet`) plus
 * `StopWorkflowRun` for the stop action DSH's generic `TaskStop` does not expose to plugins.
 *
 * Every definition is a plain object: `{ name, description, parameters, output, execute }`.
 * They are registered through `ctx.tools.register` by `index.js`.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { userMessage } from './messages.js';
import { TOOL_DESCRIPTIONS } from './prompt.js';
import { createSubagentRunner } from './subagent.js';

const MAX_MODEL_TEXT = 48 * 1024;

/**
 * Truncate one model-facing text while keeping its head and tail readable.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
function budget(text, limit = MAX_MODEL_TEXT) {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = Math.floor(limit * 0.25);
  return `${text.slice(0, head)}\n… output truncated (${text.length - head - tail} characters) …\n${text.slice(-tail)}`;
}

/**
 * Render one diagnostic list in ZCode's `path:Lline:Ccolumn message` form.
 * @param {string} scriptPath
 * @param {readonly { line: number, column: number, message: string }[]} diagnostics
 * @returns {string}
 */
function renderDiagnostics(scriptPath, diagnostics) {
  return diagnostics
    .map((diagnostic) => `${scriptPath}:L${diagnostic.line ?? 1}:C${diagnostic.column ?? 1} ${diagnostic.message}`)
    .join('\n');
}

/**
 * Resolve the working directory of the calling agent.
 * @param {object} ctx
 * @param {{ agent?: { session?: unknown } }} exec
 * @returns {string}
 */
function sessionCwd(ctx, exec) {
  const agent = exec?.agent;
  try {
    const workingDirectory = ctx.get?.('workingDirectory');
    const fromAgent = workingDirectory?.get?.(agent?.session);
    if (typeof fromAgent === 'string' && fromAgent.length > 0) return fromAgent;
  } catch {
    // fall through
  }
  const fromSession = agent?.session?.header?.cwd ?? agent?.session?.cwd;
  if (typeof fromSession === 'string' && fromSession.length > 0) return fromSession;
  return process.cwd();
}

/**
 * Read a script file relative to the workspace.
 * @param {string} cwd
 * @param {string} inputPath
 * @returns {Promise<{ ok: true, text: string, absolute: string } | { ok: false, message: string }>}
 */
async function readScriptFile(cwd, inputPath) {
  const absolute = path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
  try {
    const relative = path.relative(cwd, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ok: false, message: `the script path escapes the workspace: ${inputPath}` };
    }
    const text = await fsp.readFile(absolute, 'utf8');
    return { ok: true, text, absolute };
  } catch (error) {
    return { ok: false, message: `cannot read the script file ${inputPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Render one run snapshot as model-facing text.
 * @param {object} run
 * @returns {string}
 */
function renderRun(run) {
  const lines = [];
  lines.push(`Run ${run.id} "${run.name}" — ${run.status}${run.stopReason === undefined ? '' : ` (${run.stopReason})`}`);
  lines.push(`Script: ${run.scriptPath}`);
  lines.push(`Created: ${new Date(run.createdAt).toISOString()}${run.finishedAt === undefined ? '' : `, finished: ${new Date(run.finishedAt).toISOString()}`}`);
  if (run.resumedFrom !== undefined) lines.push(`Resumed from: ${run.resumedFrom}`);
  lines.push(`Steps: ${run.steps.settled} settled, ${run.steps.failed} failed, ${run.steps.running} running of ${run.steps.started} started`);
  if (run.phases.length > 0) lines.push(`Phases: ${run.phases.join(' → ')}`);
  if (run.agents.length > 0) {
    lines.push('Subagents:');
    for (const agent of run.agents) {
      lines.push(`- ${agent.name}: ${agent.settled} settled, ${agent.failed} failed, ${agent.asks} asks`);
    }
  }
  if (run.holes.length > 0) {
    lines.push('Holes waiting to be filled:');
    for (const hole of run.holes) lines.push(`- ${hole.id} (${hole.name})${hole.prompt === undefined ? '' : `: ${hole.prompt}`}`);
  }
  if (run.reports.length > 0) {
    lines.push(`Reported items (${run.reports.length}):`);
    for (const report of run.reports.slice(-40)) {
      lines.push(`- ${budget(JSON.stringify(report.item), 2000)}`);
    }
  }
  if (run.artifacts.length > 0) {
    lines.push('Artifacts:');
    for (const artifact of run.artifacts) {
      lines.push(`- ${artifact.id} v${artifact.version} (${artifact.kind})${artifact.title === undefined ? '' : ` "${artifact.title}"`}${artifact.primary === true ? ' [primary]' : ''}`);
    }
  }
  if (run.world.length > 0) {
    lines.push('Commands:');
    for (const command of run.world.slice(-20)) {
      lines.push(`- ${[command.cmd, ...(command.args ?? [])].join(' ')} → exit ${command.exitCode}`);
    }
  }
  if (run.log.length > 0) {
    lines.push('Log:');
    for (const entry of run.log) lines.push(`- ${entry.text}`);
  }
  if (run.error !== undefined) lines.push(`Error: ${run.error}`);
  if (run.result !== undefined && run.result !== null) {
    lines.push('Return value:');
    lines.push(budget(JSON.stringify(run.result, null, 2), 20000));
  }
  return budget(lines.join('\n'));
}

/**
 * Render one run row for `ListWorkflowRuns`.
 * @param {object} row
 * @returns {string}
 */
function renderRunRow(row) {
  const when = new Date(row.createdAt).toISOString();
  const status = row.status === 'stopped'
    ? `stopped (${row.stopReason ?? 'unknown'})`
    : row.status;
  return `- ${row.id} "${row.name}" — ${status}, created ${when}${row.finishedAt === undefined ? '' : `, finished ${new Date(row.finishedAt).toISOString()}`}${row.resumedFrom === undefined ? '' : `, resuming ${row.resumedFrom}`}`;
}

/**
 * Validate saved-workflow arguments against their declarations, using ZCode's verbatim
 * messages (docs/recon/zcode-host.md §5.4).
 * @param {Record<string, unknown>} supplied
 * @param {Record<string, { type?: string, description?: string, required?: boolean, default?: unknown }>} declarations
 * @returns {{ ok: true, args: Record<string, unknown> } | { ok: false, message: string }}
 */
function validateSavedArgs(supplied, declarations) {
  const declared = declarations ?? {};
  const names = Object.keys(declared);
  const args = { ...supplied };
  for (const key of Object.keys(args)) {
    if (Object.prototype.hasOwnProperty.call(declared, key)) continue;
    return {
      ok: false,
      message: names.length === 0
        ? `unknown argument '${key}': this workflow declares no arguments`
        : `unknown argument '${key}' (declared: ${names.join(', ')})`,
    };
  }
  for (const [name, declaration] of Object.entries(declared)) {
    const value = args[name];
    if (value === undefined) {
      if (declaration.default !== undefined) {
        args[name] = declaration.default;
        continue;
      }
      if (declaration.required === true) return { ok: false, message: `missing required argument '${name}'` };
      continue;
    }
    const type = declaration.type ?? 'string';
    const describe = (entry) => {
      if (entry === null) return 'null';
      if (Array.isArray(entry)) return 'an array';
      const kind = typeof entry;
      return kind === 'number' ? 'a number' : kind === 'boolean' ? 'a boolean' : kind === 'string' ? 'a string' : `a ${kind}`;
    };
    const mismatch = type === 'string' && typeof value !== 'string' ? `expected a string, got ${describe(value)}`
      : type === 'number' && !(typeof value === 'number' && Number.isFinite(value)) ? `expected a finite number, got ${describe(value)}`
        : type === 'boolean' && typeof value !== 'boolean' ? `expected a boolean, got ${describe(value)}`
          : undefined;
    if (mismatch !== undefined) {
      return { ok: false, message: `argument '${name}': ${mismatch} (${JSON.stringify(value)})` };
    }
  }
  return { ok: true, args };
}

/**
 * Build the tool definitions bound to one plugin instance.
 *
 * @param {object} options
 * @param {object} options.ctx plugin context
 * @param {object} options.runtime workflow runtime (host/runtime.js)
 * @param {object} options.store durable store (host/store.js)
 * @param {object} options.compiler compiler module (host/compiler.js)
 * @param {object} [options.config]
 * @param {object} [options.logger]
 * @returns {object[]} tool definitions
 */
export function createWorkflowTools({ ctx, runtime, store, compiler, config = {}, logger = console }) {
  const baseRunner = createSubagentRunner({ ctx, config, logger });

  /**
   * Build the per-run subagent runner bound to the calling agent and workspace.
   * @param {object} exec
   * @param {string} cwd
   */
  const runnerFor = (exec, cwd) => {
    if (exec?.agent === undefined) {
      throw new Error('dynamic workflows need an agent turn; these tools are not callable outside a session');
    }
    return (request) => baseRunner({ ...request, agent: exec.agent, cwd });
  };

  /**
   * Send the completion notification into the owning agent's inbox.
   * @param {object} agent
   * @returns {(text: string) => void}
   */
  const notifierFor = (agent) => (text) => {
    try {
      const result = agent.followup(userMessage(text));
      if (result !== undefined && typeof result.catch === 'function') {
        result.catch((error) => logger.warn?.(`zcode-workflow: notification delivery failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    } catch (error) {
      logger.warn?.(`zcode-workflow: notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * Resolve a `saved` source into its script body and validated args.
   * @param {{ name: string, args?: Record<string, unknown> }} saved
   * @param {string} cwd
   */
  const resolveSaved = async (saved, cwd) => {
    const entry = await store.getSavedWorkflow(saved.name, { cwd });
    if (entry === undefined) {
      return { ok: false, message: `no saved workflow named "${saved.name}". Use ListSavedWorkflows to see the names that exist.` };
    }
    const header = compiler.extractMetadataHeader(entry.code);
    const body = header.ok ? header.body : entry.code;
    const declarations = header.ok ? header.meta?.args ?? {} : entry.meta?.args ?? {};
    const validated = validateSavedArgs(saved.args ?? {}, declarations);
    if (!validated.ok) return { ok: false, message: validated.message };
    return { ok: true, code: body, meta: header.ok ? header.meta : entry.meta, args: validated.args };
  };

  /** @type {object[]} */
  const tools = [];

  tools.push({
    name: 'CreateWorkflow',
    description: TOOL_DESCRIPTIONS.createWorkflow,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        script: { type: 'string', description: 'The whole workflow script inline (TypeScript, function body, top-level await allowed, end with `return <value>`). Save to a draft the result names.' },
        path: { type: 'string', description: 'A workflow script file, relative to the workspace or absolute.' },
        saved: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', description: 'Saved workflow name.' },
            args: { type: 'object', additionalProperties: true, description: 'Argument values for the saved workflow.' },
          },
          description: 'A workflow saved in this project or globally, by name.',
        },
        name: { type: 'string', description: 'Short run label in the user\'s language. Always pass it for an inline script; it also names the draft file.' },
        args: { type: 'object', additionalProperties: true, description: 'The script\'s arguments when the file declares them.' },
        max_concurrency: { type: 'number', description: 'Upper bound on concurrent subagents. Set only when the user asks to limit parallelism.' },
        subagent_model: { type: 'string', description: 'Model subagents run on ("providerId/modelId" or a bare model id). Only when the user asked for a specific model.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: value.text ?? '' }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `CreateWorkflow: ${args?.name ?? args?.saved?.name ?? 'workflow'}`,
      rawInput: typeof args?.script === 'string' ? args.script : (args?.path ?? ''),
    }),
    async execute(args, exec) {
      const cwd = sessionCwd(ctx, exec);
      const sources = [args?.script, args?.path, args?.saved].filter((value) => value !== undefined);
      if (sources.length !== 1) {
        return { ok: false, text: `CreateWorkflow needs exactly one source: script, path or saved (got ${sources.length}). Nothing ran.` };
      }
      let code;
      let scriptPath;
      let runName = args?.name;
      let runArgs = args?.args ?? {};
      let savedMeta;
      if (typeof args.script === 'string') {
        code = args.script;
      } else if (typeof args.path === 'string') {
        const file = await readScriptFile(cwd, args.path);
        if (!file.ok) return { ok: false, text: `${file.message} Nothing ran.` };
        scriptPath = file.absolute;
        const header = compiler.extractMetadataHeader(file.text);
        if (header.ok && header.meta !== undefined) {
          savedMeta = header.meta;
          code = header.body;
          if (runArgs === undefined || Object.keys(runArgs).length === 0) {
            const declared = header.meta.args ?? {};
            runArgs = Object.fromEntries(
              Object.entries(declared)
                .filter(([, declaration]) => declaration?.default !== undefined)
                .map(([name, declaration]) => [name, declaration.default]),
            );
          }
          runName = runName ?? header.meta.name;
        } else {
          code = file.text;
        }
      } else {
        const saved = await resolveSaved(args.saved, cwd);
        if (!saved.ok) return { ok: false, text: `${saved.message} Nothing ran.` };
        code = saved.code;
        savedMeta = saved.meta;
        runArgs = saved.args;
        runName = runName ?? saved.meta?.name ?? args.saved.name;
      }
      if (typeof code !== 'string' || code.trim().length === 0) {
        return { ok: false, text: 'the workflow script is empty. Nothing ran.' };
      }
      const started = await runtime.start({
        code,
        scriptPath,
        name: String(runName ?? args?.saved?.name ?? 'workflow'),
        cwd,
        args: runArgs ?? {},
        maxConcurrency: typeof args?.max_concurrency === 'number' ? args.max_concurrency : undefined,
        subagentModel: typeof args?.subagent_model === 'string' ? args.subagent_model : undefined,
        origin: args?.saved !== undefined ? 'saved' : (args?.path === undefined ? 'inline' : 'path'),
        runner: runnerFor(exec, cwd),
        notify: notifierFor(exec.agent),
      });
      if (!started.ok) {
        if (Array.isArray(started.diagnostics) && started.diagnostics.length > 0) {
          const rendered = renderDiagnostics(started.scriptPath ?? 'workflow.ts', started.diagnostics);
          return {
            ok: false,
            script_path: started.scriptPath,
            text: budget([
              'The workflow script has errors:',
              rendered,
              '',
              'NOTE: Nothing ran — fix the errors above and call the tool again. Pass the script file back as `path` after editing it; do not paste the whole script again.',
            ].join('\n')),
          };
        }
        return { ok: false, text: started.error ?? 'the workflow could not start. Nothing ran.' };
      }
      const phaseList = (started.phases ?? []).length === 0 ? '' : `\nPhases: ${started.phases.join(' → ')}`;
      return {
        ok: true,
        run_id: started.runId,
        script_path: started.scriptPath,
        name: String(runName ?? 'workflow'),
        phases: started.phases,
        agents: started.agents,
        text: budget([
          `The workflow "${String(runName ?? 'workflow')}" is running in the background.`,
          `Run ID: ${started.runId}`,
          `Script: ${started.scriptPath}${phaseList}`,
          '',
          'You will receive a completion notification carrying the script\'s final `return` value and every reported item when it settles. Do not poll it; continue with other work unless the user asked you to wait.',
        ].join('\n')),
      };
    },
  });

  tools.push({
    name: 'GetWorkflowRun',
    description: TOOL_DESCRIPTIONS.getWorkflowRun,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id'],
      properties: { run_id: { type: 'string', description: 'The run id.' } },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: value.text ?? '' }],
    },
    async execute(args) {
      const run = await runtime.getRun(args?.run_id);
      if (run === undefined) {
        return { ok: false, text: `run_not_found: no workflow run with ID ${String(args?.run_id)} exists for this project. Use ListWorkflowRuns to see the runs that do.` };
      }
      return { ok: true, run_id: run.id, status: run.status, text: renderRun(run) };
    },
  });

  tools.push({
    name: 'ListWorkflowRuns',
    description: TOOL_DESCRIPTIONS.listWorkflowRuns,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'How many runs to list (default 20, at most 100).' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: value.text ?? '' }],
    },
    async execute(args) {
      const limit = Math.min(Math.max(1, Number(args?.limit ?? 20) || 20), 100);
      const rows = await runtime.listRuns({ project: true, limit });
      if (rows.length === 0) {
        return { ok: true, runs: [], text: 'No workflow runs exist in this project yet.' };
      }
      return {
        ok: true,
        runs: rows.map((row) => ({ run_id: row.id, name: row.name, status: row.status, created_at: row.createdAt })),
        text: budget([`${rows.length} workflow run(s), most recent first:`, ...rows.map(renderRunRow)].join('\n')),
      };
    },
  });

  tools.push({
    name: 'TaskOutput',
    description: TOOL_DESCRIPTIONS.taskOutput,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id'],
      properties: {
        run_id: { type: 'string', description: 'The run id to wait for.' },
        timeout_ms: { type: 'number', description: 'How long to wait (default 600000, at most 3600000).' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: value.text ?? '' }],
    },
    async execute(args, exec) {
      const runId = args?.run_id;
      const existing = await runtime.getRun(runId);
      if (existing === undefined) {
        return { ok: false, text: `run_not_found: no workflow run with ID ${String(runId)} exists for this project. Use ListWorkflowRuns to see the runs that do.` };
      }
      if (existing.status !== 'running') {
        return { ok: true, run_id: existing.id, status: existing.status, text: renderRun(existing) };
      }
      const timeoutMs = Math.min(Math.max(1000, Number(args?.timeout_ms ?? 600000) || 600000), 3600000);
      const run = await runtime.waitForRun(runId, { timeoutMs, signal: exec?.signal });
      if (run === undefined) {
        return { ok: false, text: `run ${runId} is still running after ${timeoutMs}ms. Wait for the completion notification instead of polling.` };
      }
      return { ok: true, run_id: run.id, status: run.status, text: renderRun(run) };
    },
  });

  tools.push({
    name: 'StopWorkflowRun',
    description: TOOL_DESCRIPTIONS.stopWorkflowRun,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id'],
      properties: { run_id: { type: 'string', description: 'The run id to stop.' } },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: value.text ?? '' }],
    },
    async execute(args) {
      const run = await runtime.stopRun(args?.run_id, 'user');
      if (run === undefined) return { ok: false, text: `run_not_found: no workflow run with ID ${String(args?.run_id)}` };
      return { ok: true, run_id: run.id, status: run.status, text: `Stopped run ${run.id}. It is resumable with ResumeWorkflowRun.` };
    },
  });

  tools.push({
    name: 'ResumeWorkflowRun',
    description: TOOL_DESCRIPTIONS.resumeWorkflowRun,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id'],
      properties: {
        run_id: { type: 'string', description: 'The stopped run id.' },
        name: { type: 'string', description: 'A new label for the continued run.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: value.text ?? '' }],
    },
    async execute(args, exec) {
      const previous = await runtime.getRun(args?.run_id);
      if (previous === undefined) return { ok: false, text: `run_not_found: no workflow run with ID ${String(args?.run_id)}` };
      if (previous.status === 'completed' || previous.status === 'errored' || previous.status === 'superseded') {
        return { ok: false, text: `run ${previous.id} is ${previous.status}; only a stopped run can be resumed. Use AmendWorkflow to revise its script.` };
      }
      const file = await readScriptFile(previous.cwd, path.relative(previous.cwd, previous.scriptPath) || previous.scriptPath);
      if (!file.ok) return { ok: false, text: `${file.message} Nothing was resumed.` };
      const cwd = sessionCwd(ctx, exec);
      const started = await runtime.start({
        code: file.text,
        scriptPath: file.absolute,
        name: String(args?.name ?? previous.name),
        cwd: cwd || previous.cwd,
        args: previous.args ?? {},
        maxConcurrency: previous.maxConcurrency,
        subagentModel: previous.subagentModel,
        resumedFrom: previous.id,
        origin: 'resume',
        runner: runnerFor(exec, cwd || previous.cwd),
        notify: notifierFor(exec.agent),
      });
      if (!started.ok) {
        return { ok: false, script_path: started.scriptPath, text: `the stored script no longer compiles:\n${renderDiagnostics(started.scriptPath ?? '', started.diagnostics ?? [])}` };
      }
      return {
        ok: true,
        run_id: started.runId,
        resumed_from: previous.id,
        text: `Resumed run ${previous.id} as ${started.runId} ("${String(args?.name ?? previous.name)}"). The script runs again from the start, so side effects repeat.`,
      };
    },
  });

  tools.push({
    name: 'AmendWorkflow',
    description: TOOL_DESCRIPTIONS.amendWorkflow,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id'],
      properties: {
        run_id: { type: 'string', description: 'The run to revise.' },
        path: { type: 'string', description: 'The run\'s script file, edited in place.' },
        script: { type: 'string', description: 'The whole revised script inline.' },
        name: { type: 'string', description: 'A new display label.' },
        max_concurrency: { type: 'number', description: 'New concurrency cap.' },
        subagent_model: { type: 'string', description: 'New subagent model route.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: value.text ?? '' }],
    },
    async execute(args, exec) {
      const previous = await runtime.getRun(args?.run_id);
      if (previous === undefined) return { ok: false, text: `run_not_found: no workflow run with ID ${String(args?.run_id)}` };
      let code;
      let scriptPath;
      if (args?.script !== undefined && args?.path !== undefined) {
        return { ok: false, text: 'pass `path` or `script`, never both. Nothing was stopped or created.' };
      }
      if (typeof args?.script === 'string') {
        code = args.script;
      } else if (typeof args?.path === 'string') {
        const file = await readScriptFile(sessionCwd(ctx, exec), args.path);
        if (!file.ok) return { ok: false, text: `${file.message} Nothing was stopped or created.` };
        scriptPath = file.absolute;
        code = file.text;
        const header = compiler.extractMetadataHeader(file.text);
        if (header.ok && header.meta !== undefined) code = header.body;
      } else if (typeof previous.scriptPath === 'string') {
        const file = await readScriptFile(previous.cwd, previous.scriptPath);
        if (!file.ok) return { ok: false, text: `${file.message} Nothing was stopped or created.` };
        code = file.text;
        scriptPath = previous.scriptPath;
      } else {
        return { ok: false, text: 'this run has no stored script; pass `script` or `path`. Nothing was stopped or created.' };
      }
      const sameScript = typeof previous.scriptPath === 'string'
        && (args?.script === undefined)
        && (await fsp.readFile(previous.scriptPath, 'utf8').catch(() => '')).trim() === code.trim();
      if (sameScript && args?.max_concurrency === undefined && args?.subagent_model === undefined) {
        return { ok: false, text: 'script_unchanged: the script bytes did not change, so nothing was stopped and nothing was created. Edit the file first.' };
      }
      if (previous.status === 'running') await runtime.stopRun(previous.id, 'supersede');
      await store.updateRun(previous.id, { status: 'superseded', supersededBy: 'pending' });
      const cwd = sessionCwd(ctx, exec) || previous.cwd;
      const started = await runtime.start({
        code,
        scriptPath,
        name: String(args?.name ?? previous.name),
        cwd,
        args: previous.args ?? {},
        maxConcurrency: args?.max_concurrency ?? previous.maxConcurrency,
        subagentModel: args?.subagent_model ?? previous.subagentModel,
        resumedFrom: previous.id,
        origin: 'amend',
        runner: runnerFor(exec, cwd),
        notify: notifierFor(exec.agent),
      });
      if (!started.ok) {
        await store.updateRun(previous.id, { status: 'superseded', supersededBy: undefined });
        return {
          ok: false,
          script_path: started.scriptPath,
          text: `The revised script has errors:\n${renderDiagnostics(started.scriptPath ?? '', started.diagnostics ?? [])}\n\nNOTE: Nothing was stopped and nothing was created — fix the file the result names and call again with \`path\`.`,
        };
      }
      await store.updateRun(previous.id, { status: 'superseded', supersededBy: started.runId });
      return {
        ok: true,
        run_id: started.runId,
        superseded_run_id: previous.id,
        text: [
          `Started revised run ${started.runId} (it supersedes ${previous.id}).`,
          `Script: ${started.scriptPath}`,
          'Work whose named subagents and ask text stayed the same replays from the predecessor\'s journal; only changed work runs again.',
          'You are notified when the revised run settles; do not poll it.',
        ].join('\n'),
      };
    },
  });

  tools.push({
    name: 'FillWorkflowHole',
    description: TOOL_DESCRIPTIONS.fillWorkflowHole,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['run_id', 'hole_id'],
      properties: {
        run_id: { type: 'string', description: 'The run that is waiting.' },
        hole_id: { type: 'string', description: 'The hole id (hole#...) from the notification or GetWorkflowRun.' },
        value: { description: 'The JSON value the hole resolves to. Pass a JSON value or a JSON-encoded string.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: value.text ?? '' }],
    },
    async execute(args) {
      let value = args?.value;
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          // keep the raw string: the script may expect a string
        }
      }
      const resolved = await runtime.fillHole(args?.run_id, args?.hole_id, value);
      if (!resolved) {
        return { ok: false, text: `hole_not_waiting: run ${String(args?.run_id)} is not in flight or is not waiting at ${String(args?.hole_id)}. Check GetWorkflowRun for the hole ids it is waiting at.` };
      }
      return { ok: true, run_id: args?.run_id, hole_id: args?.hole_id, text: `Resolved hole ${String(args?.hole_id)} on run ${String(args?.run_id)}; the parked branch continues.` };
    },
  });

  tools.push({
    name: 'SaveWorkflow',
    description: TOOL_DESCRIPTIONS.saveWorkflow,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'description', 'scope'],
      properties: {
        name: { type: 'string', description: 'File-safe workflow name (letters, digits, dot, dash, underscore).' },
        description: { type: 'string', description: 'One-line description shown wherever the workflow is listed.' },
        when_to_use: { type: 'string', description: 'When a reader should run this workflow.' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'project: this workspace\'s .dsh/workflows; global: $DSH_HOME/workflows for every project.' },
        script: { type: 'string', description: 'The script body only (no metadata block).' },
        script_path: { type: 'string', description: 'A draft file to save without re-emitting it.' },
        args: {
          type: 'object',
          description: 'Values that change between runs, keyed by argument name. Each entry declares a type (string, number, boolean or json) plus optional description, required and default.',
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            required: ['type'],
            properties: {
              type: { type: 'string', enum: ['string', 'number', 'boolean', 'json'] },
              description: { type: 'string' },
              required: { type: 'boolean' },
              default: {},
            },
          },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: value.text ?? '' }],
    },
    async execute(args, exec) {
      const cwd = sessionCwd(ctx, exec);
      if ((args?.script === undefined) === (args?.script_path === undefined)) {
        return { ok: false, text: 'pass `script` or `script_path`, never both. Nothing was saved.' };
      }
      let code;
      if (typeof args.script === 'string') {
        code = args.script;
      } else {
        const file = await readScriptFile(cwd, args.script_path);
        if (!file.ok) return { ok: false, text: `${file.message} Nothing was saved.` };
        const header = compiler.extractMetadataHeader(file.text);
        code = header.ok ? header.body : file.text;
      }
      const compiled = compiler.compileWorkflowScript({ code, filename: `${args.name}.dwf.ts`, mode: 'workflow' });
      if (!compiled.ok) {
        return {
          ok: false,
          text: `The workflow script has errors:\n${renderDiagnostics(`${args.name}.dwf.ts`, compiled.diagnostics)}\n\nNOTE: Nothing was saved — fix the errors above and call the tool again.`,
        };
      }
      const saved = await store.saveSavedWorkflow({
        cwd,
        name: args.name,
        scope: args.scope,
        code,
        meta: {
          description: args.description,
          whenToUse: args.when_to_use,
          args: args.args !== null && typeof args.args === 'object' && !Array.isArray(args.args) ? args.args : undefined,
        },
        overwrite: true,
      });
      if (!saved.ok) return { ok: false, text: `${saved.message} Nothing was saved.` };
      const scopeNote = saved.scope === 'global' ? 'global' : 'project';
      return {
        ok: true,
        name: args.name,
        scope: saved.scope,
        path: saved.path,
        overwritten: saved.overwritten,
        text: `${saved.overwritten ? 'Replaced' : 'Saved'} the ${scopeNote} workflow "${args.name}" at ${saved.path}. Run it with CreateWorkflow using \`saved: { name: "${args.name}" }\`.`,
      };
    },
  });

  tools.push({
    name: 'ListSavedWorkflows',
    description: TOOL_DESCRIPTIONS.listSavedWorkflows,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: value.text ?? '' }],
    },
    async execute(args, exec) {
      const cwd = sessionCwd(ctx, exec);
      const listed = await store.listSavedWorkflows({ cwd });
      const entries = Array.isArray(listed) ? listed : (listed?.entries ?? []);
      const invalid = Array.isArray(listed) ? [] : (listed?.invalid ?? []);
      if (entries.length === 0 && invalid.length === 0) {
        return { ok: true, workflows: [], text: 'No saved workflows exist for this project or globally.' };
      }
      const lines = [`${entries.length} saved workflow(s):`];
      for (const entry of entries) {
        const args = entry.meta?.args;
        const argText = args !== null && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length > 0
          ? `\n  Args: ${Object.entries(args).map(([name, declaration]) => `${name}:${declaration?.type ?? 'string'}${declaration?.required === true ? ' (required)' : ''}`).join(', ')}`
          : '';
        const whenText = entry.meta?.whenToUse === undefined ? '' : `\n  When to use: ${entry.meta.whenToUse}`;
        lines.push(`- ${entry.name} [${entry.scope}] — ${entry.meta?.description ?? '(no description)'}${whenText}${argText}`);
      }
      for (const bad of invalid) lines.push(`- (unreadable) ${bad.path}: ${bad.reason}`);
      return {
        ok: true,
        workflows: entries.map((entry) => ({ name: entry.name, scope: entry.scope, description: entry.meta?.description })),
        invalid,
        text: budget(lines.join('\n')),
      };
    },
  });

  tools.push({
    name: 'EvalWorkflowSnippet',
    description: TOOL_DESCRIPTIONS.evalWorkflowSnippet,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', description: 'The snippet inline.' },
        path: { type: 'string', description: 'A file holding the snippet.' },
        timeoutMs: { type: 'number', description: 'Wall clock for the snippet in milliseconds (default 60000, at most 600000).' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: value.text ?? '' }],
    },
    async execute(args, exec) {
      const cwd = sessionCwd(ctx, exec);
      if ((args?.code === undefined) === (args?.path === undefined)) {
        return { ok: false, text: 'pass `code` or `path`, never both. Nothing ran.' };
      }
      let code;
      if (typeof args.code === 'string') {
        code = args.code;
      } else {
        const file = await readScriptFile(cwd, args.path);
        if (!file.ok) return { ok: false, text: `${file.message} Nothing ran.` };
        code = file.text;
      }
      const result = await runtime.evaluate({
        code,
        cwd,
        timeoutMs: typeof args?.timeoutMs === 'number' ? args.timeoutMs : undefined,
        signal: exec?.signal,
      });
      if (!result.ok && Array.isArray(result.diagnostics) && result.diagnostics.length > 0) {
        return {
          ok: false,
          text: `The snippet has errors:\n${renderDiagnostics('snippet.ts', result.diagnostics)}\n\nNOTE: The snippet was NOT executed — fix the errors above and call the tool again.`,
        };
      }
      if (!result.ok) {
        return { ok: false, text: `The snippet failed: ${result.error ?? 'unknown error'}${result.logs?.length ? `\n\nLogs:\n${result.logs.map((line) => `- ${line}`).join('\n')}` : ''}` };
      }
      const rendered = result.value === undefined || result.value === null
        ? 'It returned no value.'
        : `Return value:\n${budget(JSON.stringify(result.value, null, 2), 4000)}`;
      return {
        ok: true,
        value: result.value,
        text: budget([
          `The snippet completed in ${result.durationMs ?? 0}ms.`,
          rendered,
          ...(result.logs?.length ? ['', 'Logs:', ...result.logs.map((line) => `- ${line}`)] : []),
        ].join('\n')),
      };
    },
  });

  return tools;
}
