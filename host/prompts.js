/**
 * 工作流的模型可见文案：子代理身份、ask 尾巴、修复/催促提示词、升级提问标记协议。
 *
 * ## 与上游 ZCode 的差异（这是有意的、被决策过的偏离）
 * ZCode 的 actor 子会话有 `submit_result` / `escalate` 两个**真工具**（`cli.md` §1.13）。
 * DSH 的 subagent activation 没有工具注入通道（`host/subagent.js` 自述），所以本移植把
 * 这两条交互改成**回复协议**：
 * - 结构化结果：把符合 JSON Schema 的 JSON **作为最终回复直接输出**（不包裹、不加解说）；
 * - 阻塞提问：在最终回复里给一个 ```json {"escalate":{"question":"…","context":"…"}} ``` 围栏块，
 *   引擎识别后挂起该 ask，主代理用 ResolveWorkflowQuestion 回答，答案作为下一回合的文本回灌。
 * 文案按上游原文移植，仅把"调用工具"改成回复协议；改文案时以本文件为准。
 */

/** 子代理侧的结果/提问都走回复协议，没有工具名可用。 */
export const ESCALATION_MARKER_KEY = 'escalate';
/** 每个 ask 允许的升级提问次数（ZCode `QBn = 3`）。 */
export const ESCALATIONS_PER_ASK = 3;

/** 安全声明：所有 actor 的系统提示词都带它，与主代理保持同一份口径。 */
export const SECURITY_NOTICE = 'IMPORTANT: Assist with authorized security testing, defensive security, CTF '
  + 'challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass '
  + 'targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools '
  + '(C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting '
  + 'engagements, CTF competitions, security research, or defensive use cases.';

/**
 * Harness 段落。默认按 ZCode 的“系统 turn”措辞（`kDn(true)`）；DSH 注入方式不同时可传 false。
 * @param {boolean} [systemReminder]
 * @returns {string}
 */
export function buildHarnessBlock(systemReminder = true) {
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

/** 「工作流里干活」契约里“有什么工具”的那一条（已按回复协议改写）。 */
export const WORKFLOW_TOOL_LINE = 'You have the regular working tools — reading, searching, editing, running '
  + 'commands. Results and blocking questions travel in your final reply; there is no tool that asks a person anything.';

/** 契约里“证据与诚实”的那一条。 */
export const WORKFLOW_GROUNDING_LINE = 'Ground every claim in something you read or ran in this session, or in '
  + 'the material the ask gave you, and say which. Cite code as `path:line`. A check counts as passed only if '
  + 'you executed it here; if you could not run it, report it as not run. Run the check an ask names rather '
  + 'than a faster substitute, and say exactly which command you ran.';

/** 升级提问的回复协议（系统提示词、质量尾巴、schema 尾巴共用同一句）。 */
export const ESCALATION_PROTOCOL = 'If you are blocked by something outside your reach, end your reply with one fenced JSON block on its own: '
  + '```json\n{"escalate":{"question":"<one focused question>","context":"<what you tried and where you are stuck>"}}\n``` '
  + 'The run\'s owner answers it and your next turn starts with that answer. Questions written in prose reach nobody.';

/**
 * 每个 actor 都收到的「# Working inside a workflow」契约。
 * @returns {string}
 */
export function buildWorkflowContract() {
  return [
    '# Working inside a workflow',
    `- ${WORKFLOW_TOOL_LINE}`,
    '- Each ask states what to do. When the ask carries a result schema, make your final reply exactly the conforming JSON value — no prose, no code fence around it (unless the ask asks for one); otherwise your final message is the result.',
    `- ${WORKFLOW_GROUNDING_LINE}`,
    '- Report outcomes faithfully. If part of the task is impossible, out of scope, or contradicted by what you found, say so in the result instead of filling a field with a plausible guess. Never fake a passing result to satisfy an instruction.',
    `- ${ESCALATION_PROTOCOL}`,
    '- Do not write report or summary files on your own initiative; findings go in the result. When the ask names an output path, write exactly there and return that path in the result — the script publishes it to the user.',
  ].join('\n');
}

/**
 * actor 的系统提示词：身份句 + persona + 安全声明 + Harness + 工作流契约。
 * @param {{ name?: string, persona?: string, systemReminder?: boolean }} options
 * @returns {string}
 */
export function buildWorkflowActorIdentity({ name, persona, systemReminder = true } = {}) {
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
 * `qualityEpilogue`：每个 ask 尾巴上的「这份结果的标准」。
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
    `- ${ESCALATION_PROTOCOL}`,
  ].join('\n');
}

/**
 * typed ask 的实现尾巴：JSON Schema + “直接作为最终回复输出”。
 * @param {object | undefined} schema
 * @returns {string}
 */
export function schemaEpilogue(schema) {
  return [
    '',
    '',
    '---',
    'When you have finished, your final reply must be exactly one JSON value conforming to this JSON Schema:',
    '',
    schema === undefined ? '(any JSON value)' : JSON.stringify(schema, null, 2),
    '',
    'Output the conforming JSON as your final reply — do not wrap it in prose, a code fence, or commentary.',
  ].join('\n');
}

/** mono 提交档位用的通用尾句（schema 已在工具侧声明时的等价文本）。 */
export const GENERIC_SUBMIT_EPILOGUE = [
  '',
  '',
  '---',
  'When you have finished, your final reply must be exactly the JSON value the task described — output it directly, no wrapping or commentary.',
].join('\n');

/**
 * 一次 turn 的完整用户提示词：指令 + 质量尾巴 + 提交尾巴。
 * @param {{ instructions: string, typed?: boolean, schema?: object }} ask
 * @returns {string}
 */
export function buildAskPrompt({ instructions, typed = false, schema }) {
  const head = `${instructions}${qualityEpilogue(schema)}`;
  return typed ? `${head}${schemaEpilogue(schema)}` : head;
}

/** typed ask 结束却未给出结果时，引擎发出的催促（回复协议版本）。 */
export const NUDGE_PROMPT = 'You ended your turn without giving the result. Output the JSON conforming to the '
  + 'required schema now, as your final reply — no wording, no code fence around it.';

/** 每个 ask 的升级预算用尽后的回执。 */
export const ESCALATION_BUDGET_EXHAUSTED = `Escalation budget exhausted: at most ${ESCALATIONS_PER_ASK} escalations per task. `
  + 'Do not ask again. Proceed on your best judgement with the information you have, and state in your final '
  + 'result the assumptions you relied on and the doubts that remain.';

/** 模型请求瞬断后重试前注入的续跑提示。 */
export const TRANSIENT_CONTINUE = 'The previous model request failed transiently and was abandoned; continue from '
  + 'where you left off.';

/** 没有在飞 ask 时升级提问的回执。 */
export const ESCALATION_NO_ACTIVE_ASK = 'No ask is in flight, so there is nowhere to park this question and nobody '
  + 'would answer it. Raise a question only while working on an ask.';

/** 结果校验失败时回给模型（repair 回合）的抬头。 */
export const SUBMIT_VIOLATIONS_HEADER = 'The reply did not match the required schema:';

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
 * 从一段回复里取出升级提问标记（```json {"escalate":{...}} ```）。
 *
 * 为什么是围栏块而不是裸 JSON：最终回复在 typed ask 里本身就是 JSON，裸对象无法区分
 * “结果”与“提问”；围栏是模型最稳定能产出的分隔形态。
 *
 * @param {string} text
 * @returns {{ escalations: {question: string, context?: string}[], rest: string }}
 */
export function parseEscalationMarkers(text) {
  const source = typeof text === 'string' ? text : '';
  /** @type {{question: string, context?: string}[]} */
  const escalations = [];
  const cleaned = source.replace(/```(?:json)?\s*([\s\S]*?)```/giu, (whole, body) => {
    let parsed;
    try {
      parsed = JSON.parse(String(body).trim());
    } catch {
      return whole;
    }
    const marker = parsed?.escalate;
    if (marker === undefined || marker === null) return whole;
    const record = typeof marker === 'string' ? { question: marker } : marker;
    const question = typeof record?.question === 'string' ? record.question.trim() : '';
    if (question === '') return whole;
    escalations.push({
      question,
      ...(typeof record.context === 'string' && record.context.trim() !== '' ? { context: record.context.trim() } : {}),
    });
    return '';
  });
  return { escalations, rest: cleaned.trim() };
}

/** 升级提问标记的示例文本（测试与技能文档共用）。 */
export const ESCALATION_MARKER_EXAMPLE = '```json\n{"escalate":{"question":"Which branch should I take?","context":"both look valid and the gate cannot decide"}}\n```';
