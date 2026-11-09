/**
 * Host half of the `zcode-workflow` bundle: the port of ZCode's Dynamic workflow feature.
 *
 * What it registers:
 *  - the authoring tools (`CreateWorkflow`, `AmendWorkflow`, …) gated by the Off /
 *    On-command / Always-on mode;
 *  - a per-run background engine that compiles TypeScript workflow scripts and executes them
 *    against the facade in `host/facade.js`, spawning real DSH subagents per `agent()` ask;
 *  - durable runs, drafts, artifacts and saved workflows under `.dsh/` and `$DSH_HOME`;
 *  - the `/workflow` and `/dwf` commands;
 *  - the `dynamic-workflows` skill (ZCode's own authoring contract) plus a short prompt section.
 */
import { constants as fsConstants, readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileWorkflowScript, extractMetadataHeader } from './host/compiler.js';
import { userMessage } from './host/messages.js';
import { createRuntime } from './host/runtime.js';
import { createStore } from './host/store.js';
import { registerWorkflowUiApi } from './host/ui-api.js';
import { createWorkspace } from './host/workspace.js';
import { createWorkflowTools } from './host/tools.js';
import {
  COMMAND_DESCRIPTION,
  COMMAND_HINT,
  DWF_COMMAND_DESCRIPTION,
  DWF_COMMAND_HINT,
  SKILL_NAME,
  renderSkillContent,
  workflowPromptSection,
} from './host/prompt.js';

export const name = 'zcode-workflow';
export const inject = ['tools', 'systemPrompt'];

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(PACKAGE_DIR, 'skills');

const MODES = new Set(['disabled', 'onDemand', 'alwaysOn']);
const MODE_ALIASES = new Map([
  ['off', 'disabled'],
  ['onCommand', 'onDemand'],
  ['always', 'alwaysOn'],
]);

/**
 * Resolve a configured mode value, including ZCode's aliases.
 * @param {unknown} raw
 * @returns {'disabled' | 'onDemand' | 'alwaysOn' | undefined} undefined when the value is not a mode
 */
function explicitMode(raw) {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (MODES.has(value)) return /** @type {'disabled' | 'onDemand' | 'alwaysOn'} */ (value);
  return MODE_ALIASES.get(value);
}

/**
 * Normalize the configured mode to ZCode's enum.
 * @param {unknown} raw
 * @returns {'disabled' | 'onDemand' | 'alwaysOn'}
 */
function normalizeMode(raw) {
  return explicitMode(raw) ?? 'alwaysOn';
}

/**
 * Read the fallback mode persisted when `configEditor` cannot write the profile patch.
 * @param {string} file
 * @returns {string | undefined}
 */
function readStoredMode(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return typeof raw?.mode === 'string' ? raw.mode : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mode persistence for the settings row.
 *
 * `configEditor` is the primary channel: it writes the profile patch and reconciles the Loader,
 * so the plugin reloads with the new mode and the model-facing gate changes immediately. A
 * profile without it falls back to `$DSH_HOME/zcode-workflow/settings.json`, which overrides the
 * patch config at the next start only.
 *
 * @param {object} options
 * @param {object} options.ctx plugin context
 * @param {'disabled' | 'onDemand' | 'alwaysOn'} options.appliedMode mode this process runs with
 * @param {string} options.settingsFile fallback file path
 * @param {{ warn?: Function }} [options.logger]
 */
function createModeController({ ctx, appliedMode, settingsFile, logger = console }) {
  // `name` is this package's name, which is also the profile row id and name the bundle inserts.
  let applied = appliedMode;
  let stored = explicitMode(readStoredMode(settingsFile)) ?? appliedMode;
  /** @type {Promise<boolean> | undefined} */
  let writableProbe;

  /** @returns {object | undefined} the profile row this plugin can edit */
  const entryFor = () => {
    const editor = ctx.get?.('configEditor');
    if (editor === undefined) return undefined;
    try {
      const rows = editor.entries();
      return rows.find((entry) => entry?.options?.id === name || entry?.options?.name === name);
    } catch (error) {
      logger.warn?.(`zcode-workflow: could not read config entries: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  /** @returns {Record<string, unknown>} a JSON object from an arbitrary value */
  const recordOf = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {});

  /** @returns {Promise<boolean>} */
  const fileWritable = async () => {
    if (writableProbe === undefined) {
      writableProbe = (async () => {
        try {
          const dir = path.dirname(settingsFile);
          await fsp.mkdir(dir, { recursive: true });
          await fsp.access(dir, fsConstants.W_OK);
          return true;
        } catch {
          return false;
        }
      })();
    }
    return writableProbe;
  };

  /** @param {string} next */
  const writeSettings = async (next) => {
    await fsp.mkdir(path.dirname(settingsFile), { recursive: true });
    let current = {};
    try {
      current = recordOf(JSON.parse(await fsp.readFile(settingsFile, 'utf8')));
    } catch {
      current = {};
    }
    await fsp.writeFile(settingsFile, `${JSON.stringify({ ...current, mode: next }, null, 2)}\n`, 'utf8');
  };

  const readMode = async () => {
    const viaConfig = entryFor() !== undefined;
    // A fallback file that was written after this process started is a pending choice: it wins
    // at the next start, so the row must show it now and say when it takes effect.
    const pending = stored !== applied;
    return {
      mode: pending ? stored : applied,
      writable: viaConfig || await fileWritable(),
      effective: pending || !viaConfig ? 'restart' : 'immediate',
    };
  };

  /** @param {string} next @returns {Promise<{ mode: string, effective: string }>} */
  const writeMode = async (next) => {
    const canonical = explicitMode(next);
    if (canonical === undefined) throw new Error(`unknown workflow mode "${String(next)}"`);
    const editor = ctx.get?.('configEditor');
    const entry = editor === undefined ? undefined : entryFor();
    if (entry !== undefined) {
      try {
        // The edit reconciles the Loader and reloads this plugin, so a stale fallback file must
        // be gone BEFORE the reload or it would shadow the patch value the edit just wrote.
        await fsp.rm(settingsFile, { force: true });
        await editor.edit(entry, (current) => ({ ...recordOf(current), mode: canonical }));
        applied = canonical;
        stored = canonical;
        return { mode: canonical, effective: 'immediate' };
      } catch (error) {
        logger.warn?.(`zcode-workflow: configEditor rejected the mode change (${error instanceof Error ? error.message : String(error)}); using ${settingsFile}`);
      }
    }
    await writeSettings(canonical);
    stored = canonical;
    return { mode: canonical, effective: 'restart' };
  };

  return { readMode, writeMode };
}

/** Windows canonical paths may differ only in case. */
function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Read the shipped ZCode skill files.
 * @returns {Promise<{ body: string, description: string, whenToUse: string, examples: string, patterns: string } | undefined>}
 */
async function readSkillFiles() {
  try {
    const raw = await fsp.readFile(path.join(SKILLS_DIR, 'SKILL.md'), 'utf8');
    const frontmatter = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(raw);
    const field = (key) => {
      if (frontmatter === null) return '';
      const match = new RegExp(`^${key}:\\s*"?([\\s\\S]*?)"?\\s*$`, 'm').exec(frontmatter[1]);
      return match === null ? '' : match[1];
    };
    return {
      body: renderSkillContent(raw, SKILLS_DIR),
      description: field('description'),
      whenToUse: field('when_to_use'),
      examples: await fsp.readFile(path.join(SKILLS_DIR, 'examples.md'), 'utf8').catch(() => ''),
      patterns: await fsp.readFile(path.join(SKILLS_DIR, 'patterns.md'), 'utf8').catch(() => ''),
    };
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Harness home directory.
 * @returns {string}
 */
function dshHome() {
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME;
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), '.dsh');
}

/**
 * Register the Host half.
 * @param {object} ctx Cordis context
 * @param {object} [config] Loader row config
 */
export function apply(ctx, config = {}) {
  const homeDir = dshHome();
  const settingsFile = path.join(homeDir, 'zcode-workflow', 'settings.json');
  // An explicit fallback file outranks the patch config: it is only written when configEditor
  // could not persist a mode change, and keeps that choice across restarts.
  const mode = explicitMode(readStoredMode(settingsFile)) ?? normalizeMode(config.mode);
  /** The host logger is optional; console keeps a failure visible without a service dependency. */
  let logger = console;
  try {
    const hostLogger = ctx.get?.('logger');
    if (hostLogger !== undefined) logger = hostLogger;
  } catch {
    // keep console
  }
  const store = createStore({ homeDir, getProjectRoot: () => process.cwd() });
  const storesByCwd = new Map();
  const workspacesByCwd = new Map();
  const runtimes = new Map();
  const agentActivations = new Map();

  /**
   * One store per project root (the store's run layout is project-relative).
   * @param {string} cwd
   */
  const storeFor = (cwd) => {
    const root = path.resolve(cwd);
    const existing = storesByCwd.get(root);
    if (existing !== undefined) return existing;
    const created = createStore({ homeDir, getProjectRoot: () => root });
    storesByCwd.set(root, created);
    return created;
  };

  /**
   * One workspace view per project root.
   * @param {string} cwd
   */
  const workspaceFor = (cwd) => {
    const root = path.resolve(cwd);
    const existing = workspacesByCwd.get(root);
    if (existing !== undefined) return existing;
    const created = createWorkspace({ cwd: root, subprocess: ctx.get?.('subprocess') });
    workspacesByCwd.set(root, created);
    return created;
  };

  /**
   * One runtime per project root so run journals and drafts stay project-local.
   * @param {string} cwd
   */
  const runtimeFor = (cwd) => {
    const root = path.resolve(cwd);
    const existing = runtimes.get(root);
    if (existing !== undefined) return existing;
    const created = createRuntime({
      store: storeFor(root),
      workspaceFor,
      compiler: { compileWorkflowScript, extractMetadataHeader },
      config: {
        maxConcurrency: config.maxConcurrency,
        stallMs: config.stallMs,
        answerHistoryChars: config.answerHistoryChars,
      },
      logger: logger,
    });
    runtimes.set(root, created);
    return created;
  };

  const baseRuntime = createRuntime({
    store,
    workspaceFor,
    compiler: { compileWorkflowScript, extractMetadataHeader },
    config: {
      maxConcurrency: config.maxConcurrency,
      stallMs: config.stallMs,
      answerHistoryChars: config.answerHistoryChars,
    },
    logger: logger,
  });

  // A tool call resolves the project root from its agent; this registry lets one plugin
  // instance serve every project without recreating tools per session.
  const runtimeLookup = (cwd) => (cwd === undefined || cwd.length === 0 ? baseRuntime : runtimeFor(cwd));

  /**
   * Admit a browser-supplied project root only when it names a registered workspace. Without a
   * registry, the process working directory is the only project this profile serves.
   * @param {unknown} raw
   * @returns {Promise<string | undefined>}
   */
  const resolveProjectRoot = async (raw) => {
    if (typeof raw !== 'string' || raw.trim() === '') return undefined;
    let requested;
    try {
      requested = await fsp.realpath(raw);
    } catch {
      return undefined;
    }
    let roots;
    try {
      const registry = ctx.get?.('workspaceRegistry');
      roots = registry === undefined ? [process.cwd()] : registry.list().map((workspace) => workspace?.path);
    } catch {
      return undefined;
    }
    for (const root of roots) {
      if (typeof root !== 'string' || root === '') continue;
      const canonical = await fsp.realpath(root).catch(() => path.resolve(root));
      if (samePath(requested, canonical)) return canonical;
    }
    return undefined;
  };

  const modeController = createModeController({ ctx, appliedMode: mode, settingsFile, logger });

  // The browser data channel stays registered in every mode so the settings row can read and
  // change the mode while the model-facing surface is off; run/start itself refuses to start a
  // run while the applied mode is disabled.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'connection'], (child) => {
      registerWorkflowUiApi({
        ctx: child,
        storeFor,
        runtimeFor,
        resolveProjectRoot,
        readMode: modeController.readMode,
        writeMode: modeController.writeMode,
        logger,
      });
    });
  } else {
    logger.warn?.('zcode-workflow: ctx.inject is unavailable; the browser data channel is not registered');
  }

  if (mode === 'disabled') {
    logger.info?.('zcode-workflow: mode is disabled; model-facing tools stay off and only the browser data channel is registered');
    return;
  }

  /**
   * Resolve the calling agent's working directory.
   * @param {{ agent?: { session?: unknown } }} exec
   * @returns {string}
   */
  const cwdOf = (exec) => {
    try {
      const workingDirectory = ctx.get?.('workingDirectory');
      const value = workingDirectory?.get?.(exec?.agent?.session);
      if (typeof value === 'string' && value.length > 0) return value;
    } catch {
      // ignore
    }
    return process.cwd();
  };

  /**
   * Tool definitions bound to one project root.
   * @param {string} cwd
   */
  const toolsetFor = (cwd) => createWorkflowTools({
    ctx,
    runtime: runtimeLookup(cwd),
    store: storeFor(cwd),
    compiler: { compileWorkflowScript, extractMetadataHeader },
    config,
    logger: logger,
  });

  /**
   * The registered definitions are shared across projects: name, description, parameter schema,
   * output contract and presentation are project-independent, while `execute` resolves the
   * calling agent's project root and forwards to that project's tool set.
   */
  const toolCache = new Map();
  /** @param {string} cwd */
  const toolsetAt = (cwd) => {
    const cached = toolCache.get(cwd);
    if (cached !== undefined) return cached;
    const created = toolsetFor(cwd);
    toolCache.set(cwd, created);
    return created;
  };
  const template = toolsetAt(process.cwd());
  const CARD_TITLES = {
    CreateWorkflow: 'Dynamic workflow',
    AmendWorkflow: 'Amend workflow',
    GetWorkflowRun: 'Workflow run',
    ListWorkflowRuns: 'Workflow runs',
    TaskOutput: 'Workflow run',
    StopWorkflowRun: 'Stop workflow',
    ResumeWorkflowRun: 'Resume workflow',
    FillWorkflowHole: 'Fill workflow hole',
    SaveWorkflow: 'Save workflow',
    ListSavedWorkflows: 'Saved workflows',
    EvalWorkflowSnippet: 'Workflow snippet',
  };
  const definitions = template.map((source) => ({
    name: source.name,
    description: source.description,
    parameters: source.parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => {
      const label = args?.name ?? args?.saved?.name;
      const title = source.name === 'CreateWorkflow'
        ? `Dynamic workflow${typeof label === 'string' && label.length > 0 ? `: ${label}` : ''}`
        : (CARD_TITLES[source.name] ?? source.name);
      if (source.name === 'CreateWorkflow') {
        return {
          card: 'generic',
          title,
          rawInput: typeof args?.script === 'string' ? args.script : (typeof args?.path === 'string' ? args.path : ''),
        };
      }
      const runId = args?.run_id;
      return {
        card: 'generic',
        title: typeof runId === 'string' && runId.length > 0 ? `${title}: ${runId}` : title,
      };
    },
    presentResult: (_args, result) => {
      const text = typeof result?.text === 'string'
        ? result.text
        : (typeof result?.value?.text === 'string' ? result.value.text : '');
      const headline = text.split('\n').find((line) => line.trim().length > 0) ?? CARD_TITLES[source.name] ?? source.name;
      return { card: 'generic', title: headline.slice(0, 160) };
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec);
      const forward = toolsetAt(cwd);
      const definition = forward.find((candidate) => candidate.name === source.name);
      if (definition === undefined) throw new Error(`zcode-workflow: tool ${source.name} is unavailable`);
      return definition.execute(args, exec);
    },
  }));

  /**
   * Register the tool set in one scope (global for alwaysOn, agent-scoped for onCommand).
   * @param {object} scopeContext
   * @returns {(() => void)[]}
   */
  const registerTools = (scopeContext) => definitions.map((definition) => scopeContext.tools.register(definition));

  if (mode === 'alwaysOn') {
    ctx.effect(() => {
      const disposers = registerTools(ctx);
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            // individual tool disposal is best-effort
          }
        }
      };
    }, 'zcode-workflow tools');
  }

  // Prompt section: available immediately for alwaysOn, after /workflow for onCommand.
  const promptText = workflowPromptSection({ mode });
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'zcode-workflow',
    order: 60,
    text: promptText,
    interpolate: false,
  }), 'zcode-workflow prompt section');

  // Register ZCode's authoring skill as a real DSH skill so the model can load it by name.
  void (async () => {
    const skill = await readSkillFiles();
    if (skill === undefined) {
      logger.warn?.('zcode-workflow: shipped skill files are missing; the authoring contract is unavailable');
      return;
    }
    const skills = ctx.get?.('skills');
    if (skills === undefined) {
      logger.warn?.('zcode-workflow: no skills service in this profile; the authoring skill is not registered');
      return;
    }
    try {
      ctx.effect(() => skills.register({
        name: SKILL_NAME,
        description: skill.description,
        whenToUse: skill.whenToUse,
        content: skill.body,
        source: 'runtime',
        resourceBase: { kind: 'directory', path: SKILLS_DIR },
      }), 'zcode-workflow skill');
      ctx.effect(() => skills.register({
        name: `${SKILL_NAME}-examples`,
        description: 'Worked examples for authoring dynamic workflows.',
        content: skill.examples,
        source: 'runtime',
        resourceBase: { kind: 'directory', path: SKILLS_DIR },
      }), 'zcode-workflow skill examples');
      ctx.effect(() => skills.register({
        name: `${SKILL_NAME}-patterns`,
        description: 'Patterns for authoring dynamic workflows.',
        content: skill.patterns,
        source: 'runtime',
        resourceBase: { kind: 'directory', path: SKILLS_DIR },
      }), 'zcode-workflow skill patterns');
    } catch (error) {
      logger.warn?.(`zcode-workflow: skill registration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  /**
   * Activate the workflow tools for one agent (onCommand mode).
   * @param {object} agent
   * @returns {string}
   */
  const activateForAgent = (agent) => {
    if (agentActivations.has(agent)) return 'Dynamic workflow tools are already available in this session.';
    const disposers = [];
    const scope = agent.ctx;
    for (const definition of definitions) {
      try {
        disposers.push(scope.tools.register(definition));
      } catch (error) {
        logger.warn?.(`zcode-workflow: agent tool registration failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      disposers.push(scope.systemPrompt.section({
        name: 'zcode-workflow',
        order: 60,
        text: promptText,
        interpolate: false,
      }));
    } catch {
      // a scoped section failing must not keep the tools from being usable
    }
    agentActivations.set(agent, disposers);
    return 'Dynamic workflow tools are now available in this session. Describe the workflow you want, or call CreateWorkflow with a script.';
  };

  ctx.effect(() => ctx.on('agent/disposed', (agent) => {
    const disposers = agentActivations.get(agent);
    if (disposers === undefined) return;
    agentActivations.delete(agent);
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // best effort
      }
    }
  }), 'zcode-workflow agent cleanup');

  // `/workflow` — the ZCode command that requests a workflow or activates on-demand tools.
  const commands = ctx.get?.('commands');
  if (commands !== undefined && typeof commands.register === 'function') {
    ctx.effect(() => commands.register({
      name: 'workflow',
      description: COMMAND_DESCRIPTION,
      input: { hint: COMMAND_HINT },
      handler: async (invocation) => {
        const agent = invocation.agent;
        const raw = String(invocation.rawInput ?? '').trim();
        if (mode === 'onDemand') {
          const note = activateForAgent(agent);
          if (raw.length === 0) return { kind: 'success', text: note };
        }
        if (raw.length === 0) {
          return {
            kind: 'success',
            text: 'Ask for the workflow in your next message, or call CreateWorkflow with a script. The dynamic-workflows skill is the authoring contract.',
          };
        }
        try {
          agent.followup(userMessage([
            'The user explicitly asked for a dynamic workflow with /workflow:',
            '',
            raw,
            '',
            'Load the `dynamic-workflows` skill, then write and run a workflow with CreateWorkflow. The explicit request is binding: use a workflow even if one reply could answer.',
          ].join('\n')));
          return { kind: 'success', text: 'Starting a dynamic workflow for this request…' };
        } catch (error) {
          return { kind: 'error', text: `could not start the workflow turn: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    }), 'zcode-workflow command');

    // `/dwf` — list, cancel or resume runs, mirroring ZCode's companion command.
    ctx.effect(() => commands.register({
      name: 'dwf',
      description: DWF_COMMAND_DESCRIPTION,
      input: { hint: DWF_COMMAND_HINT },
      handler: async (invocation) => {
        const cwd = cwdOf({ agent: invocation.agent });
        const runtime = runtimeLookup(cwd);
        const raw = String(invocation.rawInput ?? '').trim();
        const [action = 'list', arg] = raw.split(/\s+/);
        if (action === 'list' || raw.length === 0) {
          const rows = await runtime.listRuns({ project: true, limit: 10 });
          if (rows.length === 0) return { kind: 'success', text: 'No dynamic-workflow runs in this project yet.' };
          return {
            kind: 'success',
            text: ['Recent runs:', ...rows.map((row) => `- ${row.id} "${row.name}" — ${row.status}`)].join('\n'),
          };
        }
        if (arg === undefined) return { kind: 'error', text: `usage: /dwf [list|cancel [runId]|resume <runId>]` };
        if (action === 'cancel') {
          const run = await runtime.stopRun(arg, 'user');
          return run === undefined
            ? { kind: 'error', text: `no run with id ${arg}` }
            : { kind: 'success', text: `Stopped ${run.id}; it is resumable with /dwf resume ${run.id}.` };
        }
        if (action === 'resume') {
          const run = await runtime.getRun(arg);
          if (run === undefined) return { kind: 'error', text: `no run with id ${arg}` };
          if (run.status !== 'stopped') return { kind: 'error', text: `run ${arg} is ${run.status}; only a stopped run can be resumed.` };
          return { kind: 'success', text: `Ask the model to call ResumeWorkflowRun with run_id ${arg}, or continue with an amended script.` };
        }
        return { kind: 'error', text: `usage: /dwf [list|cancel [runId]|resume <runId>]` };
      },
    }), 'zcode-workflow run command');
  }
}
