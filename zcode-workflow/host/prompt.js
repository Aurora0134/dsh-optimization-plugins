/**
 * Prompt material and model-facing tool text for the dynamic-workflow port.
 *
 * The authoring contract itself ships as the real DSH skill (`skills/SKILL.md`, ZCode's own
 * `dynamic-workflows` skill), so the section below stays short and points at the skill, the
 * way ZCode's `/workflow` command prompt does. Tool descriptions live in
 * `host/tool-contract.js` and are re-exported here for the tool definitions.
 */
import { DESCRIPTIONS, SKILL_NAME, TOOL_NAMES } from './tool-contract.js';

export { SKILL_NAME };

/** Replace ZCode's skill-directory placeholder with the installed skills directory. */
export function renderSkillContent(raw, skillDir) {
  return raw
    .replace(/^---[\s\S]*?---\s*/, '')
    .replaceAll('${ZCODE_SKILL_DIR}', skillDir.replaceAll('\\', '/'));
}

/**
 * The per-session prompt section that tells the model dynamic workflows exist.
 *
 * It carries the substance of ZCode's `/workflow` command prompt (the topology-first
 * instruction and the tool that must be called) plus the port's mode gating; the facade,
 * the rules and every tool's fields stay in the `dynamic-workflows` skill.
 *
 * @param {{ mode: string }} options
 * @returns {string}
 */
export function workflowPromptSection({ mode }) {
  const modeLine = mode === 'onDemand'
    ? 'The tools become available after the user types /workflow in this session.'
    : mode === 'disabled'
      ? 'Dynamic workflows are turned off in this profile.'
      : 'The tools are available in every turn.';
  return [
    'Use the `dynamic-workflows` skill to design and launch a dynamic workflow when the user asks for one — "use a workflow", "使用 workflow", "用工作流", "跑个工作流", or `/workflow`:',
    '',
    'Decide the subagent topology before writing any code: how many subagents, which of them share a context, what result each one returns. Then write the script and call the `CreateWorkflow` tool. (`CreateWorkflow` is the dynamic-workflow tool; do not do the work inline instead, and do not judge the task too small for a workflow — size only decides how many subagents the script gets.)',
    '',
    `Tools: ${TOOL_NAMES.join(', ')}. ${modeLine}`,
    '',
    'The skill is the whole authoring contract — the facade the compiler checks against, the rules a script must satisfy, and each tool\'s fields and error texts. Load it before writing or revising a script. The run starts in the background after the user confirms it; you are notified with its final `return` value when it settles, so do not poll.',
  ].join('\n');
}

/** Tool descriptions, verbatim from ZCode's bundle (see `host/tool-contract.js`). */
export const TOOL_DESCRIPTIONS = {
  createWorkflow: DESCRIPTIONS.createWorkflow,
  amendWorkflow: DESCRIPTIONS.amendWorkflow,
  resumeWorkflowRun: DESCRIPTIONS.resumeWorkflowRun,
  getWorkflowRun: DESCRIPTIONS.getWorkflowRun,
  listWorkflowRuns: DESCRIPTIONS.listWorkflowRuns,
  fillWorkflowHole: DESCRIPTIONS.fillWorkflowHole,
  evalWorkflowSnippet: DESCRIPTIONS.evalWorkflowSnippet,
  saveWorkflow: DESCRIPTIONS.saveWorkflow,
  listSavedWorkflows: DESCRIPTIONS.listSavedWorkflows,
  resolveWorkflowQuestion: DESCRIPTIONS.resolveWorkflowQuestion,
  taskOutput: DESCRIPTIONS.taskOutput,
  stopWorkflowRun: DESCRIPTIONS.stopWorkflowRun,
};

/** The `/workflow` command metadata (ZCode's own summary and usage). */
export const COMMAND_DESCRIPTION = 'Design and launch a dynamic workflow for a task.';
export const COMMAND_HINT = '[what the workflow should accomplish]';

/** The `/dwf` companion command metadata. */
export const DWF_COMMAND_DESCRIPTION = 'List, cancel, or resume dynamic workflow runs.';
export const DWF_COMMAND_HINT = '[list|cancel [runId]|resume <runId>]';
