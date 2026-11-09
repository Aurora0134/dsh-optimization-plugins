/**
 * Prompt material and model-facing tool descriptions for the dynamic-workflow port.
 *
 * The authoring contract itself ships as a real DSH skill (`skills/SKILL.md`, copied verbatim
 * from ZCode), so these strings stay short on purpose — exactly like ZCode's tool descriptions.
 */

/** Replace ZCode's skill-directory placeholder with the installed skills directory. */
export function renderSkillContent(raw, skillDir) {
  return raw
    .replace(/^---[\s\S]*?---\s*/, '')
    .replaceAll('${ZCODE_SKILL_DIR}', skillDir.replaceAll('\\', '/'));
}

/** Frontmatter fields of the shipped ZCode skill. */
export const SKILL_NAME = 'dynamic-workflows';

/**
 * The per-session prompt section that tells the model dynamic workflows exist.
 * Mirrors ZCode's on-demand tool prompt: it states when to use a workflow, the minimum
 * authoring rules, and that the skill is the full contract.
 * @param {{ mode: string }} options
 * @returns {string}
 */
export function workflowPromptSection({ mode }) {
  const modeLine = mode === 'onDemand'
    ? 'The tools become available after the user types /workflow in this session.'
    : 'The tools are available in every turn.';
  return [
    '# Dynamic workflows',
    '',
    'Dynamic workflows run a TypeScript script that orchestrates many subagents in parallel, so a complex task can be covered properly instead of one reply at a time.',
    '',
    `Tools: CreateWorkflow, AmendWorkflow, GetWorkflowRun, ListWorkflowRuns, TaskOutput, ResumeWorkflowRun, FillWorkflowHole, SaveWorkflow, ListSavedWorkflows, EvalWorkflowSnippet. ${modeLine}`,
    '',
    'When to use one (binding):',
    '- The user explicitly names a workflow as the means ("use a workflow", "使用 workflow", "用工作流", "跑个工作流") or types /workflow. Then CreateWorkflow is mandatory, even if one reply could answer.',
    '- Never start a workflow on your own judgement that a task looks orchestration-shaped. A single delegation or a few independent lookups belong to the subagent tool instead.',
    '',
    'Before writing a workflow script, load the `dynamic-workflows` skill — it is the whole authoring contract (facade, rules, diagnostics, phases, report, artifacts, amend). The authoring tools are checked against it.',
    '',
    'Practical rules that the compiler enforces:',
    '- Plain TypeScript inside a function body: no import/export/declare, no process/fetch/fs, no Date.now()/Math.random(). Top-level await and a final `return <value>` are allowed.',
    '- Every script is grouped into named phases with `phase("...")`; each phase needs at least one subagent ask or world.run.',
    '- Name every subagent for the user (unique within a run); subagents run concurrently, so do not await one before starting the next unless the order matters.',
    '- Return a `WorkflowReport`-shaped value and publish the deliverable with `artifact.*`.',
    '',
    'The run starts in the background; you are notified with its final return value when it settles. Do not poll.',
  ].join('\n');
}

/** Tool descriptions, kept short like ZCode's own. */
export const TOOL_DESCRIPTIONS = {
  createWorkflow: [
    'Compile and start a dynamic-workflow run from a TypeScript script. On a clean compile the run starts in the background and you are notified with its final `return` value when it settles; diagnostics mean nothing ran.',
    '',
    'Pass exactly one source: `script` (inline; saved to a draft file the result names), `path` (a script file on disk), or `saved: { name, args? }` (a workflow saved in this project or globally).',
    '',
    'Fields: `name` labels the run (always pass it for an inline script); `args` declares the values a saved workflow takes; `max_concurrency` caps concurrent subagents; `subagent_model` sets the model subagents run on (only when the user asked for one).',
    '',
    'Load the `dynamic-workflows` skill before authoring: it carries the facade the compiler checks against and the rules a script must satisfy.',
    '',
    'This starts a NEW run. To change an existing run, use AmendWorkflow.',
  ].join('\n'),
  amendWorkflow: [
    'Revise an existing dynamic-workflow run. Starts a new run that supersedes the predecessor and runs the revised script from the start (this port does not yet replay the predecessor journal as a cache). Works on completed, errored, stopped and still-running runs (a running predecessor is stopped in the same call).',
    '',
    'Pass `path` (the run\'s script file, edited in place) or `script` (the whole revised script), never both; omit both to change only settings. `max_concurrency`, `subagent_model` and `name` keep the predecessor\'s values when omitted.',
    '',
    'To continue a stopped run unchanged, use ResumeWorkflowRun instead. Load the `dynamic-workflows` skill before revising.',
  ].join('\n'),
  getWorkflowRun: [
    'Read one dynamic-workflow run: lifecycle status, phases, steps, reported items, artifacts, pending holes, log tail, world commands, final result or failure.',
    '',
    'Use it when you must not block, or for a run another session started; use TaskOutput to wait for a run this session started.',
  ].join('\n'),
  listWorkflowRuns: [
    'List this project\'s dynamic-workflow runs, most recently updated first, including runs another session started.',
    '',
    'Each row gives the run ID, label, status, resumability, tokens spent and timestamps. Pass an ID to GetWorkflowRun for detail. A run stops in exactly one of: completed; errored (the script itself failed; not resumable); stopped (resumable, with `stop_reason`); superseded (an amendment replaced it).',
  ].join('\n'),
  taskOutput: [
    'Wait for a dynamic-workflow run this session started to settle, then return its final snapshot. Use it only when you genuinely need to wait; the completion notification arrives on its own otherwise.',
  ].join('\n'),
  resumeWorkflowRun: [
    'Continue a stopped dynamic-workflow run with the same run ID and script. A completed or errored run cannot be resumed; use AmendWorkflow to revise its script.',
  ].join('\n'),
  fillWorkflowHole: [
    'Resolve the hole a running dynamic-workflow run is waiting at. The run keeps its id, journal and subagents; only the branch parked at the hole continues.',
    '',
    'Pass `run_id` and `hole_id` (from the notification or GetWorkflowRun), and `value`: the JSON value the hole\'s `await hole<T>(...)` call resolves to. This port resolves holes with a value rather than a spliced code body; write the branch inline in the script when its logic depends on earlier bindings.',
  ].join('\n'),
  saveWorkflow: [
    'Save a dynamic-workflow script with its metadata so it can be run again by name (CreateWorkflow\'s `saved` source; ListSavedWorkflows lists them). `scope` decides whether it lives in this project (`.dsh/workflows`) or globally (`$DSH_HOME/workflows`).',
    '',
    'NEVER call this unsolicited: saving writes a file into the user\'s repository, which is their decision. Suggest it in one sentence and wait for agreement. Pass `script` (body only) or `script_path` (an existing draft), never both.',
  ].join('\n'),
  listSavedWorkflows: [
    'List the dynamic-workflow scripts saved for this project and globally, with the name, scope, description, when-to-use text and declared arguments each one carries.',
  ].join('\n'),
  evalWorkflowSnippet: [
    'Compile and run a small workflow-authoring TypeScript snippet synchronously against the same compiler and workspace sandbox a real run uses. The test bench for authoring: check what a glob returns, how a command\'s stderr parses, or a gate predicate, before putting it in a script. No agent()/report()/artifact.*/hole(); nothing persists; the result comes back in this call.',
    '',
    'Pass `code` (inline) or `path` (a file), never both. `timeoutMs` defaults to 60000 and caps at 600000.',
  ].join('\n'),
  stopWorkflowRun: [
    'Stop a running dynamic-workflow run. It becomes `stopped` and can be resumed with ResumeWorkflowRun or revised with AmendWorkflow.',
  ].join('\n'),
};

/** The `/workflow` command metadata (ZCode's own summary and usage). */
export const COMMAND_DESCRIPTION = 'Design and launch a dynamic workflow for a task.';
export const COMMAND_HINT = '[what the workflow should accomplish]';

/** The `/dwf` companion command metadata. */
export const DWF_COMMAND_DESCRIPTION = 'List, cancel, or resume dynamic workflow runs.';
export const DWF_COMMAND_HINT = '[list|cancel [runId]|resume <runId>]';
