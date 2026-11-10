/**
 * 工作流的模型可见文案：子代理身份、ask 尾巴、修复/催促提示词、升级提问回执。
 *
 * 这里只放“会被模型读到”的字符串，并且逐字取自 ZCode CLI 0.21.1（`beauty/zcode-cli.js`
 * 的 657371-657424 / 739040-739062 / 739775-739786 / 739847-739870 / 424118-424189 /
 * 424259-424268）。为什么单独成文件：这些文案是行为的一部分（子代理靠它们决定怎么交付结果），
 * 散落在调度器里时任何一处手改都无法被测试逐一断言。
 *
 * 与原 bundle 的对应关系（原文位置）：
 * - `buildWorkflowActorIdentity` ← `wBa`（657383）+ `SBa`（657371）+ `kDn`（657321）+ `lBo`（657318）
 * - `qualityEpilogue` ← `ZBn`（739040）
 * - `schemaEpilogue` ← `lmi`（739775） / `genericSubmitEpilogue` ← `umi`（739855）
 * - `NUDGE_PROMPT` ← `cmi`（739852）
 * - `ESCALATION_BUDGET_EXHAUSTED` ← `imi`（739847）
 * - `TRANSIENT_CONTINUE` ← `hmi`（739867）
 * - `escalateRefusal` / `submitResult` 回执 ← 424259-424189
 */

/** 子代理侧提交结果的工具名（G2 引擎按这个名字识别 typed ask 的完成）。 */
export const SUBMIT_RESULT_TOOL = 'submit_result';
/** 子代理侧升级提问的工具名。 */
export const ESCALATE_TOOL = 'escalate';
/** 每个 ask 允许的 escalate 次数（`QBn = 3`）。 */
export const ESCALATIONS_PER_ASK = 3;

/** 安全声明：所有 actor 的系统提示词都带它，与主代理保持同一份口径。 */
export const SECURITY_NOTICE = 'IMPORTANT: Assist with authorized security testing, defensive security, CTF '
  + 'challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass '
  + 'targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools '
  + '(C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting '
  + 'engagements, CTF competitions, security research, or defensive use cases.';

/**
 * Harness 段落。`systemReminder` 决定用「系统会插入提醒」还是「`<system-reminder>` 标签」的说法，
 * 与宿主注入方式一致：DSH 走标签，ZCode 走系统 turn。
 * @param {boolean} [systemReminder]
 * @returns {string}
 */
export function buildHarnessBlock(systemReminder = false) {
  return [
    '# Harness',
    ' - Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.',
    " - Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.",
    ` - ${systemReminder
      ? 'The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results.'
      : '`<system-reminder>` tags in messages and tool results are injected by the harness, not the user.'} Hooks may intercept tool calls; treat hook output as user feedback.`,
    ' - Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.',
    " - Reference code as `file_path:line_number` — it's clickable.",
  ].join('\n');
}

/** 「工作流里干活」契约里“有什么工具”的那一条（`vBa`）。 */
export const WORKFLOW_TOOL_LINE = 'You have the regular working tools — reading, searching, editing, running '
  + 'commands — plus `submit_result` and `escalate`. There is no tool that asks a person anything.';

/** 契约里“证据与诚实”的那一条（`bBa`）。 */
export const WORKFLOW_GROUNDING_LINE = 'Ground every claim in something you read or ran in this session, or in '
  + 'the material the ask gave you, and say which. Cite code as `path:line`. A check counts as passed only if '
  + 'you executed it here; if you could not run it, report it as not run. Run the check an ask names rather '
  + 'than a faster substitute, and say exactly which command you ran.';

/**
 * 每个 actor 都收到的「# Working inside a workflow」契约（`SBa` 逐行）。
 * @returns {string}
 */
export function buildWorkflowContract() {
  return [
    '# Working inside a workflow',
    `- ${WORKFLOW_TOOL_LINE}`,
    '- Each ask states what to do. When the ask carries a result schema, finish by calling `submit_result` with a conforming value; otherwise your final message is the result.',
    `- ${WORKFLOW_GROUNDING_LINE}`,
    '- Report outcomes faithfully. If part of the task is impossible, out of scope, or contradicted by what you found, say so in the result instead of filling a field with a plausible guess. Never fake a passing result to satisfy an instruction.',
    "- When you are blocked by something outside your reach — a gate that cannot pass, instructions that contradict each other, a fact only the run's owner knows — call `escalate`. Questions written in prose reach nobody.",
    '- Do not write report or summary files on your own initiative; findings go in the result. When the ask names an output path, write exactly there and return that path in the result — the script publishes it to the user.',
  ].join('\n');
}

/**
 * actor 的系统提示词（`wBa`）：身份句 + persona + 安全声明 + Harness + 工作流契约。
 *
 * 为什么身份句要写「没有真人可对话」：actor 的多轮对话只由脚本消费，模型若把 ask 当聊天会写出
 * 面向用户的过程叙述，脚本拿到的东西就不再是结果。
 *
 * @param {{ name?: string, persona?: string, systemReminder?: boolean }} options
 * @returns {string}
 */
export function buildWorkflowActorIdentity({ name, persona, systemReminder = false } = {}) {
  const actorName = typeof name === 'string' ? name.trim() : '';
  const identity = `You are a subagent inside a dynamic workflow run${actorName ? `, named "${actorName}"` : ''}. `
    + 'A script created you and hands you work one ask at a time; the script — not a person — consumes what you '
    + 'return. There is no user in this conversation to talk to.';
  const personaText = typeof persona === 'string' ? persona.trim() : '';
  return [
    identity,
    ...(personaText ? ['', personaText] : []),
    '',
    SECURITY_NOTICE,
    '',
    buildHarnessBlock(systemReminder),
    '',
    buildWorkflowContract(),
  ].join('\n');
}

/**
 * `qualityEpilogue`（`ZBn`）：每个 ask 尾巴上的「这份结果的标准」。
 *
 * schema 里声明了 `evidence` / `confidence` 字段时追加对应条目——这两个字段名的含义由脚本定义，
 * 尾巴必须提醒模型它们会被当真，否则模型会填一个好看的值而不是诚实的值。
 *
 * @param {object | undefined} schema
 * @returns {string}
 */
export function qualityEpilogue(schema) {
  const fields = schema !== null && typeof schema === 'object' && schema.properties !== null
    && typeof schema.properties === 'object'
    ? new Set(Object.keys(schema.properties))
    : new Set();
  return [
    '',
    '',
    '---',
    'Standard for this result:',
    '- Every finding cites what you read or ran: path and line for code; the exact command and its output for a check; the part of the ask for material the ask itself gave you.',
    '- A check counts as passed only if you ran it during this ask. Otherwise report it as not run.',
    "- Run the check the ask names, at the scale it names. A narrower or faster substitute — one test file for the suite, a build for the tests — is reported as what it is, never as the ask's check; say the exact command you ran.",
    '- Anything you could not do, verify, or find is stated as such — never filled with a plausible guess.',
    ...(fields.has('evidence') ? ["- Put each finding's citation in its `evidence` field."] : []),
    ...(fields.has('confidence')
      ? ['- Rate `confidence` honestly; a low value with a reason beats a confident guess.']
      : []),
    '- If you are blocked by something outside your reach, call `escalate` instead of inventing a value.',
  ].join('\n');
}

/**
 * typed ask 的实现尾巴（`lmi`）：把 schema 原样写进提示词。
 *
 * 为什么把 schema 全文塞进提示词：DSH 的 actor 没有宿主侧工具 schema 可变注册，模型只能靠这段
 * 文本知道结果该长什么样；JSON Schema 本身就是最不容易被误读的写法。
 *
 * @param {object | undefined} schema
 * @returns {string}
 */
export function schemaEpilogue(schema) {
  return [
    '',
    '',
    '---',
    'When you have finished, call the `submit_result` tool to submit your final result. Its `result` argument must be a JSON value conforming to this JSON Schema:',
    '',
    schema === undefined ? '(any JSON value)' : JSON.stringify(schema, null, 2),
    '',
    'Pass the conforming JSON as the `result` argument — do not wrap it or add commentary.',
  ].join('\n');
}

/** mono 提交档位（schema 已知、工具 schema 固定）用的通用尾句（`umi`）。 */
export const GENERIC_SUBMIT_EPILOGUE = [
  '',
  '',
  '---',
  "When you have finished, call the `submit_result` tool to submit your final result. Its `result` argument must match the tool's declared schema — pass the conforming JSON directly, do not wrap it or add commentary.",
].join('\n');

/**
 * 一次 turn 的完整用户提示词：指令 + 质量尾巴 + 提交尾巴。
 * 对应 `startAsk` 里的 `${o.instructions}${ZBn(...)}${typed ? … : ''}`。
 *
 * @param {{ instructions: string, typed?: boolean, schema?: object }} ask
 * @returns {string}
 */
export function buildAskPrompt({ instructions, typed = false, schema }) {
  const head = `${instructions}${qualityEpilogue(schema)}`;
  return typed ? `${head}${schemaEpilogue(schema)}` : head;
}

/** typed ask 结束却未提交结果时，引擎发出的催促（`cmi`，逐字）。 */
export const NUDGE_PROMPT = 'You ended your turn without submitting a result. Call the submit_result tool now '
  + 'with a payload conforming to the required schema.';

/** 每个 ask 的 escalate 预算用尽后的回执（`imi`，逐字含 `${QBn}` 展开）。 */
export const ESCALATION_BUDGET_EXHAUSTED = `Escalation budget exhausted: at most ${ESCALATIONS_PER_ASK} escalations per task. `
  + 'Do not call escalate again. Proceed on your best judgement with the information you have, and state in your '
  + 'final result the assumptions you relied on and the doubts that remain.';

/** 模型请求瞬断后重试前注入的续跑提示（`hmi`）。 */
export const TRANSIENT_CONTINUE = 'The previous model request failed transiently and was abandoned; continue from '
  + 'where you left off.';

/** 没有在飞 ask 时 escalate 的回执（424270 分支，逐字）。 */
export const ESCALATION_NO_ACTIVE_ASK = 'No ask is in flight, so there is nowhere to park this question and nobody '
  + 'would answer it. Escalate only while working on an ask.';

/** submit_result 校验失败时回给模型的抬头（424178-424183）。 */
export const SUBMIT_VIOLATIONS_HEADER = 'The submitted result does not match the required schema:';

/** 校验通过 / 未通过时 submit_result 的模型可见回执（424186-424189）。 */
export const SUBMIT_ACCEPTED_RECEIPT = 'The result was accepted.';
export const SUBMIT_INVALID_RECEIPT = 'submit_result returned an invalid result.';

/**
 * 逐行渲染校验违规：`${path}: expected ${expected}, got ${got}`；无细节时 `(no details provided)`。
 * @param {{ path?: string, expected?: string, got?: string }[]} violations
 * @returns {string}
 */
export function formatViolations(violations) {
  if (!Array.isArray(violations) || violations.length === 0) return '(no details provided)';
  return violations
    .map((violation) => `${violation?.path ?? '$'}: expected ${violation?.expected ?? 'a conforming value'}, got ${violation?.got ?? 'something else'}`)
    .join('\n');
}

/**
 * submit_result 工具描述（有 schema / 无 schema 两版，424123-424125）。
 * @param {{ schema?: object }} [options]
 * @returns {string}
 */
export function submitResultDescription({ schema } = {}) {
  return schema === undefined
    ? 'Submit the structured result for the current ask. The required JSON shape is described in the ask instructions.'
    : "Submit the structured result for the current ask. The `result` argument must match this tool's schema.";
}

/** escalate 工具描述（424259-424268 逐行）。 */
export const ESCALATE_DESCRIPTION = [
  'Escalates a question that is BLOCKING you to the main agent that created this workflow, and waits here for the answer.',
  '',
  'This is a LAST RESORT, for when you are genuinely stuck on something outside your reach:',
  '- a gate that is broken or impossible to pass (a check capped at 95 when the threshold is 96);',
  '- instructions that contradict each other, so no output can satisfy both;',
  "- a fact you cannot obtain (a tradeoff, an external convention, what 'good' means here) that only whoever started this run knows.",
  '',
  'Do NOT use it for curiosity, progress reports, asking permission, confirming a conclusion you could verify yourself, or thinking out loud. None of those are blocked — keep working.',
  '',
  'Ask ONE focused question that can be answered in a sentence, and put your evidence in `context`: what you already tried, and exactly where you are stuck. The quality of the answer depends on it.',
  '',
  'The cost: this call BLOCKS until the main agent answers, which may take a long time. You get at most 3 escalations per ask; the 4th tells you the budget is spent and to proceed on your own best judgement. Do not spend them on questions not worth waiting for.',
].join('\n');
