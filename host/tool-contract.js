/**
 * Model-facing tool contract for the dynamic-workflow port.
 *
 * The descriptions and notes below are the ZCode 3.17.2 / CLI 0.21.1 strings, copied
 * verbatim from the reversed bundle (`cli.md` §1.2–§1.11). Two DSH-local edits are applied
 * everywhere and only here:
 *  - `TaskStop` becomes `StopWorkflowRun`, the port's only tool-surface extension, because
 *    ZCode's generic background-task tools do not exist in the Harness;
 *  - ZCode's archive paths (`.zcode/workflows`, `~/.zcode/workflows`) become the port's
 *    (`.dsh/workflows`, `$DSH_HOME/workflows`), while `.zcode/workflows` stays readable.
 *
 * Nothing else is reworded: paragraph boundaries, sentence order and punctuation are the
 * bundle's, so a model that learned the upstream contract reads the same text here.
 */

/** The skill that carries the authoring contract (`q_` in the bundle). */
export const SKILL_NAME = 'dynamic-workflows';

/** Tool names in registration order (see the port's tool list). */
export const TOOL_NAMES = [
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
  'StopWorkflowRun',
];

export const DESCRIPTIONS = {
  createWorkflow: [
    'Create and run a dynamic workflow: a TypeScript script that orchestrates multiple model-driven subagents with plain control flow (loops, conditionals, fan-out) and typed intermediate results. The script is typechecked, the user is asked to confirm it, and the run starts in the background; you are notified with its final result when it settles. Compilation errors come back as diagnostics.',
    '',
    'When to use:',
    '- The user explicitly asks for a workflow — "use a workflow", "with a workflow", "使用 workflow", "用工作流", or any phrasing that names workflow/工作流 as the means: this tool is mandatory. Do not substitute the Agent/Task subagent tools, do not do the work inline yourself, and do not judge the task too small for a workflow — the user chose the tool, and that choice is theirs. Size only decides how many subagents the script gets, never whether it is written.',
    '- Without such an explicit request, do not start a workflow: delegate with the Agent tool or do the work yourself, even for multi-step or multi-subagent tasks.',
    '',
    'Before writing or revising a script, load the `dynamic-workflows` skill with the Skill tool: it carries the facade declarations the script is checked against, the authoring rules, and this tool\'s full contract. A call that submits a script is refused until that skill has been loaded in this session; running a saved workflow by name is exempt.',
    '',
    'Pass exactly one source: `script` (a one-off script written inline; it is saved to a draft file the result names — revise that file and resubmit with `path`, never paste the script again), `saved` (a workflow saved in this project or globally, by name; check ListSavedWorkflows before writing one from scratch), or `path` (a script file on disk, normally the file a previous result named). To change a run that already exists — errored, completed, stopped or still running — call AmendWorkflow instead of starting over.',
  ].join('\n'),

  amendWorkflow: [
    'Amend an existing dynamic-workflow run with a revised script or revised settings. Starts a NEW run that supersedes the old one and imports its finished work as a cache, so only what you changed is paid for again. Works on ANY run of this project: completed, errored, stopped — or still running.',
    '',
    'When to use:',
    '- The run errored, or completed but needs one more stage: fix or extend the script and amend. Never rewrite the workflow from scratch with CreateWorkflow.',
    '- The run is STILL RUNNING and is visibly going wrong: amend it NOW, in one call. Do not StopWorkflowRun it first and do not wait for it to finish — this tool stops the running predecessor and starts the revision; the earlier you amend, the less is re-paid.',
    '- The user wants the same workflow with fewer subagents at once, its subagents on another model, or another name: amend with only that field and neither `path` nor `script`.',
    '- To continue a stopped run unchanged, use ResumeWorkflowRun instead.',
    '',
    'Load the `dynamic-workflows` skill with the Skill tool before revising a script: it carries the cache rules, what each omitted field keeps, and the confirmation rule. A call that passes `path` or `script` is refused until that skill has been loaded in this session; a settings-only call is not. Pass `path` (the run\'s script file, edited in place — the usual form) or `script` (the whole revised script inline), never both.',
  ].join('\n'),

  resumeWorkflowRun: [
    'Resumes a dynamic-workflow run whose status is `stopped` — the user cancelled it, you stopped it with StopWorkflowRun, a provider-side error stopped it (expired sign-in, model not in the plan, quota cap), or the process that owned it exited (`interrupted`). The run continues under the same run ID: finished steps are replayed from the journal without spending tokens, unfinished steps are dispatched again. The one stopped run that is NOT resumable is a `superseded` one: an AmendWorkflow replaced it, and its successor is the live run.',
    '',
    '- Takes run_id — from CreateWorkflow\'s or AmendWorkflow\'s result, from a completion notification, or from GetWorkflowRun / ListWorkflowRuns.',
    '- The resumed run is backgrounded: you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.',
    '- An `errored` run (the script itself failed) is NOT resumable — replaying it would fail the same way. Fix the script and submit it with AmendWorkflow instead. A completed run is not resumable either; a `superseded` run is refused with the successor\'s ID.',
    '- Stop reason `user` means the user stopped it on purpose: resume it only when the user asks you to; never resume a run the user just cancelled on your own initiative. Reason `model` is your own StopWorkflowRun. Reason `provider` means a provider-side error stopped it: resolve the cause with the user first (the stop notification names it), then resume. The exception is a usage cap with a known reset time: ZCode resumes that run by itself after the reset, so do not resume it before then. Reason `interrupted` (the process died) is different: continuing it is usually what the user wants.',
  ].join('\n'),

  getWorkflowRun: [
    'Returns the current state of one dynamic-workflow run: progress, token usage and the tail of its log() narration while it runs; the final result once it completed; the structured failure if it errored or was stopped.',
    '',
    'Runs this session starts settle on their own: you receive a completion notification carrying the final output. Do NOT poll this tool while waiting for one — continue with other work.',
    'Reach for it when: (a) the user asks how a workflow is going, (b) you want to review this project\'s earlier runs, including ones other sessions started, (c) a completion notification was truncated and you need the run\'s full record by ID.',
    '',
    '- Takes run_id — from CreateWorkflow\'s or AmendWorkflow\'s result, from a completion notification, or from ListWorkflowRuns.',
    '- This is an instant snapshot and never waits. To block until a run THIS session started finishes, use TaskOutput instead: that is the waiting tool. GetWorkflowRun is the right tool when you must not wait, or when the run belongs to another session (TaskOutput cannot see those).',
    '- The `artifacts` section lists what the run published for the user — files, documents and live dashboards that are ALREADY shown to them as cards. Refer to one by its title; do not paste its contents back. The one marked `primary` is the deliverable: point the user to it first.',
    '- Three terminal states: `completed`; `errored` (the script itself failed — not resumable, amend it); `stopped` with a stop reason — `user` (cancelled on purpose: resume only when the user asks), `model` (your own StopWorkflowRun), `provider` (a provider-side error such as an expired sign-in, a model missing from the plan or a quota cap — the `<error>` block names the cause and the fix; resolve it with the user, then resume), `interrupted` (the process that owned the run exited — continuing it is usually what the user wants), `superseded` (an AmendWorkflow replaced it; `<superseded_by>` names the successor — read that run instead, never resume this one).',
    '- A stopped run (other than a superseded one) can be continued with ResumeWorkflowRun — no rebuild needed, same run ID, same script.',
    '- ANY run — completed, stopped, errored, or still running — can instead be revised with AmendWorkflow: pass its run ID and the corrected script, and the finished work is imported as cache. When the script itself errored, that is the move — fix the script and keep the work that already succeeded, rather than rewriting from scratch.',
  ].join('\n'),

  listWorkflowRuns: [
    'Lists this project\'s dynamic-workflow runs (the session\'s working directory is the project key), most recently updated first. Includes runs started by other sessions — the run journal is per-project, not per-session.',
    '',
    'Runs this session starts settle on their own: you receive a completion notification carrying the final output. Do NOT poll this tool while waiting for one — continue with other work.',
    'Reach for it when: (a) the user asks how a workflow is going, (b) you want to review this project\'s earlier runs, including ones other sessions started, (c) a completion notification was truncated and you need the run\'s full record by ID.',
    '',
    '- Each row gives the run ID, its label, lifecycle status, whether this session started it, tokens spent, and timestamps.',
    '- `possibly_interrupted="true"` means this session cannot confirm the run is still alive: it may be a leftover from a process that exited, or a sibling session\'s run still in flight. It is an annotation, not a verdict — do not report it as a failure.',
    '- Pass a run ID to GetWorkflowRun for progress detail, the log tail, the final result, or the failure.',
    '- Three terminal states: `completed`; `errored` (the script itself failed); `stopped` with `stop_reason` — `user` (cancelled on purpose: resume only when the user asks), `model` (your own StopWorkflowRun), `provider` (a provider-side error stopped it: read GetWorkflowRun for the cause, resolve it with the user, then resume), `interrupted` (the owning process exited: continuing it is usually what the user wants), `superseded` (an AmendWorkflow replaced it; `superseded_by` names the live successor — never resume a superseded run).',
    '- Any stopped run other than a superseded one can be continued with ResumeWorkflowRun — no rebuild needed, same run ID, same script. An errored run cannot.',
    '- ANY run here — completed, stopped, errored, or still running — can instead be revised with AmendWorkflow: pass its run ID and the corrected script; the new run imports the old one\'s finished work as a warm cache (and stops it first if it is still running). A run whose script errored is the case to reach for it — fix the script instead of rewriting the workflow from scratch. `resumed_from` on a row names the run it was amended from.',
  ].join('\n'),

  fillWorkflowHole: [
    'Supplies the body of a hole that a RUNNING dynamic-workflow run has reached and is waiting at. Starts nothing: the run keeps its id, journal and subagents, and grows by the statements you write.',
    '',
    '- Takes run_id and hole_id — both from the hole notification (or from GetWorkflowRun\'s holes if that notification was lost). Only the branch parked at the hole waits; the rest of the run keeps going, and nothing times out.',
    '- Read the run\'s draft at the path the notification names for context: the body is compiled WHERE THE HOLE STANDS and sees every binding declared before it. Write only the statements of the hole\'s function — not the `hole(...)` call, not an arrow, not the script around it — and return a value of the hole\'s type, or end with a new tail hole named for the next step when the workflow\'s shape is not known yet (the skill\'s §15).',
    '- Rehearse fixed logic in EvalWorkflowSnippet first. A hole is filled once: a body under a loop runs on every iteration with that iteration\'s bindings.',
    '- On diagnostics the fill is saved to a fill file; edit that file in place and resubmit with `path` instead of pasting the body again. To change anything OUTSIDE the hole, use AmendWorkflow.',
    '',
    'Load the `dynamic-workflows` skill with the Skill tool before writing a body: it carries the facade the body is checked against and the hole rules. A call is refused until that skill has been loaded in this session. Pass `script` (the statements inline) or `path` (a file holding them), never both.',
  ].join('\n'),

  evalWorkflowSnippet: [
    'Compile and run a small dynamic-workflow TypeScript snippet synchronously, against the same compiler, sandbox and world-read execution path a real run uses. It is the test bench for workflow authoring: check a parser against real command output, see what a glob actually returns, or exercise a gate predicate on real repository state before putting it in a CreateWorkflow script. No agent()/report(); nothing persists; the result comes back in this call.',
    '',
    'Load the `dynamic-workflows` skill with the Skill tool first: it carries the snippet facade and the rules. The call is refused until that skill has been loaded in this session. Pass `code` (inline) or `path` (a file holding the snippet), never both.',
  ].join('\n'),

  saveWorkflow: [
    'Save a dynamic-workflow script with its metadata so it can be run again later by name (CreateWorkflow\'s `saved` source; ListSavedWorkflows lists them). The required `scope` decides whether it lives in this project or globally.',
    '',
    'NEVER call this tool unsolicited: saving writes a file into the user\'s repository, and that is their decision. When a workflow you just built looks reusable, suggest saving it in one sentence and wait; call SaveWorkflow only after the user agrees, or when the user asks directly.',
    '',
    'Load the `dynamic-workflows` skill with the Skill tool first: it carries the file format, the argument declarations and the authoring rules. The call is refused until that skill has been loaded in this session. Pass `script` (the body only) or `script_path` (a draft file, saved without re-emitting it), never both.',
  ].join('\n'),

  listSavedWorkflows: [
    'Lists the dynamic workflows saved in this project (`.dsh/workflows/`, keyed on the session\'s working directory) and the global archive (`$DSH_HOME/workflows`, available from every project). These are workflow DEFINITIONS you can run, not past runs — for the run history use ListWorkflowRuns instead.',
    '',
    '- Each row gives the name, what the workflow does, when to reach for it, and the arguments it takes.',
    '- Run one by passing its name to CreateWorkflow as `saved: { name, args }`. The user still confirms the run.',
    '- Check here before writing a workflow from scratch: if the project already saved one that fits, running it beats rebuilding it.',
    '- `invalid` lists saved files that could not be read (usually a hand-edited metadata block). They are named so they can be fixed, not silently skipped.',
  ].join('\n'),

  resolveWorkflowQuestion: [
    'Answers a blocking question that a subagent escalated from inside a RUNNING dynamic-workflow run.',
    '',
    '- Takes question_id — the ID from the escalation notification (it looks like `dwfq-...`). If that notification was lost, GetWorkflowRun lists the questions a run still owes an answer to.',
    '- The run keeps running the whole time: only the subagent that asked is parked on its call, while every other subagent and the script\'s control flow keep going. Your answer becomes that call\'s result verbatim and the subagent continues from there.',
    '- Answer directly and actionably. If you are not sure, look at the run first with GetWorkflowRun, or ask the user with AskUserQuestion, then come back and answer — nothing answers on your behalf, and the subagent waits indefinitely.',
    '- If the question reveals the SCRIPT is structurally broken (a broken gate, wrong control flow), a sentence cannot fix that: cancel the run and continue with a revised script via CreateWorkflow\'s `resume_from`.',
  ].join('\n'),

  taskOutput: [
    'Waits for a dynamic-workflow run this session started to settle, then returns its final snapshot: the script\'s `return` value, the reported items, the artifacts and the failure if there was one.',
    '',
    '- Takes run_id — the ID a CreateWorkflow, AmendWorkflow or ResumeWorkflowRun result names, or the one in the completion notification.',
    '- Blocks until the run settles. The completion notification arrives on its own, so use this only when the user asked you to wait or you genuinely must block; do not poll GetWorkflowRun instead.',
    '- `timeout_ms` bounds the wait (default 600000, at most 3600000). On timeout the current snapshot comes back and the run keeps going; that is not a failure.',
    '- Only runs this session started are reachable here. For a run another session owns, use GetWorkflowRun.',
  ].join('\n'),

  stopWorkflowRun: [
    'Stops a running dynamic-workflow run, recording stop reason `model`, and makes it resumable.',
    '',
    'This port\'s only tool-surface extension: ZCode stops a workflow through its generic `TaskStop` background-task tool, and the Harness exposes no equivalent to plugins, so this tool is the stop entry here. Everything else on this surface mirrors ZCode.',
    '',
    'It becomes `stopped` (stop_reason `model`) and can be continued with ResumeWorkflowRun — finished steps replay from the journal — or revised with AmendWorkflow. To fix a script that is visibly going wrong, prefer AmendWorkflow: it stops the run and starts the revision in one call. Do not stop a run merely to wait for it.',
  ].join('\n'),
};

/** ZCode's re-used JSON-parse hint (`Lun`). */
export const JSON_PARSE_HINT = 'If you did pass one, the call\'s arguments were not valid JSON, and a call that does not parse arrives empty. The usual cause is an unescaped backslash or double quote in the inline source: inside a JSON string a regex\'s `\\d` must be written `\\\\d`. Escape it, or write the source to a file and pass `path`.';

/** `nFr`: no source at all. */
export const NO_WORKFLOW_SOURCE = `No workflow source arrived. Pass \`script\` for a one-off script written inline, \`saved\` to run a workflow saved in this project, or \`path\` for a script file on disk. ${JSON_PARSE_HINT}`;

/** `tFr`: more than one source. */
export const MULTIPLE_WORKFLOW_SOURCES = 'Provide exactly one workflow source: `script` for a one-off script written inline, `saved` to run a workflow saved in this project, or `path` for a script file on disk (the file a previous result named). Passing more than one is ambiguous.';

/** `rFr`: `args` with anything but `path`. */
export const ARGS_WITHOUT_PATH = '`args` belongs to the `path` source: it carries values for the arguments a script file declares in its `/* zcode-workflow` block. For a saved workflow pass `saved.args`; an inline `script` declares no arguments, so it takes none.';

/** `q2n`: compile failure with no file to name. */
export const COMPILE_FAILED_NOTE = 'NOTE: The workflow was NOT executed — fix the errors above and resubmit.';

/** `W2n`: no execution capability in this session. */
export const NO_EXECUTION_NOTE = 'NOTE: The workflow was NOT executed — workflow execution is not available in this session, so the script was only typechecked.';

/** `Wwt`: compile failure that does have a file to name. */
export function scriptFileNote({ kind, described }) {
  return `NOTE: The workflow was NOT executed. ${kind === 'draft' ? `The script is saved at ${described}.` : `The script file is ${described}.`} Edit that file in place and resubmit with \`path: "${described}"\` — do not paste the script inline again.`;
}

/** `jMo`: the launch result's script-location sentence. */
export function launchedScriptSentence({ kind, described }) {
  return ` ${kind === 'draft' ? `The script is saved at ${described}` : `The script file is ${described}`}; to revise it later, edit that file and pass \`path\` to AmendWorkflow.`;
}

/** `BMo`: the amend result's revision-location sentence. */
export function revisedScriptSentence(described) {
  return ` The revision's script is at ${described}; edit it there for a further revision.`;
}

/** `fFr`: AmendWorkflow takes at most one revised script. */
export const AMEND_BOTH_SCRIPTS = 'Provide at most one revised script: `path` for the script file you edited (the usual form), or `script` for the whole revised script inline. Passing both is ambiguous; omit both to keep the predecessor\'s script unchanged.';

/** `Zun`: FillWorkflowHole takes exactly one body source. */
export const FILL_SOURCE = 'Provide exactly one body source: `script` for the hole\'s statements written inline, or `path` for a file holding them (usually the fill file a rejected attempt was saved to). Passing both, or neither, is ambiguous.';

/** EvalWorkflowSnippet's two source errors (`AFr`, `PFr`). */
export const SNIPPET_BOTH_SOURCES = 'Provide exactly one snippet source: `code` for the snippet inline, or `path` for a file holding it. Passing both is ambiguous.';
export const SNIPPET_NO_SOURCE = `No snippet source arrived. Pass \`code\` for the snippet inline, or \`path\` for a file holding it. ${JSON_PARSE_HINT}`;

/** SaveWorkflow's source errors (`_Fr`, `yFr`). */
export const SAVE_BOTH_SOURCES = 'Provide exactly one script source: `script` for the body inline, or `script_path` for the file holding it (a draft, usually). Passing both, or neither, is ambiguous.';
export const SAVE_BODY_ONLY = 'The `script` must be the workflow body only — it already starts with a `/* zcode-workflow` metadata block. Pass the metadata through the `description` / `whenToUse` / `args` fields instead; the block is written for you.';

/** The generic denial text ZCode returns for a plain deny (§5.3 `bTe`). */
export const TOOL_DENIED = 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.';

/** The refusal ZCode uses for every alias of "workflow execution is not available here". */
export const INTROSPECTION_UNAVAILABLE = 'workflow_introspection_unavailable: this session cannot read workflow runs — workflow execution is not available here, so no run history is reachable. This is a capability gap, not an empty project.';
export const RESUME_UNAVAILABLE = 'workflow_resume_unavailable: this session cannot resume workflow runs — workflow execution is not available here. This is a capability gap, not a status problem.';
export const FILL_UNAVAILABLE = 'workflow_fill_unavailable: this session cannot fill workflow holes — workflow execution is not available here. This is a capability gap, not a bad hole id.';
export const ANSWERING_UNAVAILABLE = 'workflow_answering_unavailable: this session cannot answer workflow questions — workflow execution is not available here. This is a capability gap, not an unknown question.';
export const EVAL_UNAVAILABLE = 'workflow_eval_unavailable: this session cannot run workflow snippets — workflow execution is not available here. This is a capability gap, not a bad snippet.';
export const STOP_UNAVAILABLE = 'workflow_stop_unavailable: this session cannot stop workflow runs — workflow execution is not available here. This is a capability gap, not a bad run id.';

/** `run_not_found` (shared by Get, Resume, Fill, Stop). */
export function runNotFound(runId) {
  return `run_not_found: no workflow run with ID ${runId} exists for this project. Use ListWorkflowRuns to see the runs that do.`;
}

/** Resume refusal texts (`dBa`, `uBa`). */
export const RESUME_MESSAGES = {
  not_resumable: 'workflow_run_not_resumable: this run is not in the resumable set — only a `stopped` run can be resumed (any stop reason except `superseded`). An `errored` run needs a corrected script submitted with AmendWorkflow; a completed run has nothing to resume. Check the status with GetWorkflowRun.',
  already_running: 'workflow_run_already_running: this run is already in flight in this session\'s workflow runtime. Wait for its completion notification instead of resuming it again.',
  script_missing: 'workflow_run_script_missing: this run\'s journal record has no stored script text (it predates script persistence), so there is nothing to re-run. Start a fresh run with CreateWorkflow instead.',
  compile_failed: 'workflow_run_compile_failed: the stored script of run {runId} no longer compiles against the current workflow facade, so it cannot be replayed as-is. Rewrite it for the current facade and submit it with AmendWorkflow, which keeps the finished work of this run.',
  superseded: 'workflow_run_superseded: run {runId} was stopped by an AmendWorkflow and superseded; its unfinished work belongs to the successor run (see GetWorkflowRun\'s <superseded_by>). Read or amend the successor instead of resuming this run.',
  other: 'workflow_run_not_resumable: the workflow runtime refused to resume run {runId} (reason: {reason}).',
};

/** The success text every backgrounded run returns (`CreateWorkflow`, `AmendWorkflow`). */
export function backgroundedNotice(runId) {
  return `The workflow script compiled cleanly and the run started in the background with ID: ${runId}. It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.`;
}
