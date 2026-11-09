/* Shared identity and wire names for the whole client half. */

/** Locale namespace for the tool cards and their dictionaries. */
const NS = 'zcodeWorkflow';

/** Locale namespace for the full workspace surfaces. */
const UI_NS = 'zcodeWorkflowUi';

/** Locale namespace for the settings row. */
const SETTINGS_NS = 'zcodeWorkflowSettings';

/** Wire tool names this bundle owns: `tool.call.toolview` keys are matched exactly. */
const TOOL_NAMES = [
  'CreateWorkflow',
  'AmendWorkflow',
  'GetWorkflowRun',
  'ListWorkflowRuns',
  'TaskOutput',
  'StopWorkflowRun',
  'ResumeWorkflowRun',
  'FillWorkflowHole',
  'SaveWorkflow',
  'ListSavedWorkflows',
  'EvalWorkflowSnippet',
];
