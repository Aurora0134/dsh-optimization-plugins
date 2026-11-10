/**
 * 产物（artifact）的逐字错误文案与 MIME 规则（契约见 `docs/port-contract.md`）。
 *
 * 为什么单独成文件：这些字符串是**契约**的一部分（模型会照着修），而且被发布路径、
 * 宿主侧校验和测试同时引用；散在 runtime.js 里既容易被改写，也无法逐条断言。
 * 文案逐字照搬 ZCode Desktop 3.17.2 的 CLI 契约。注意上游这些
 * 文案**不带** `(at site@ordinal)` 后缀——站点定位信息只在 journal/事件里，不进面向模型的错误。
 */

import { ARTIFACT_CAPS, ARTIFACT_ID_PATTERN } from './concurrency.js';

/** 扩展名 → MIME（`cli:739012-739030`）。 */
export const EXTENSION_MIME = Object.freeze({
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  gif: 'image/gif',
  htm: 'text/html',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  markdown: 'text/markdown',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  webp: 'image/webp',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

/** 裸 MIME 的形态（`cli:739031-739032`）：不允许参数（`; charset=…`）。 */
export const BARE_MIME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u;

/**
 * 一个值的可读描述（与 §6.6 的 `describeArg` 同形）。
 * @param {unknown} value
 * @returns {string}
 */
export function describeArg(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array (${value.length} items)`;
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 39)}…` : value);
  return String(value);
}

/**
 * 按扩展名嗅探 MIME；不认识的扩展名给 `undefined`（由 store 兜底）。
 * @param {string} filePath
 * @returns {string | undefined}
 */
export function mimeForPath(filePath) {
  const match = /\.([A-Za-z0-9]+)$/u.exec(String(filePath));
  if (match === null) return undefined;
  return EXTENSION_MIME[match[1].toLowerCase()];
}

/**
 * 产物 id 校验；非法时给出 §6.6 的逐字文案。
 * @param {string} op
 * @param {unknown} id
 * @returns {string | undefined}
 */
export function invalidArtifactIdMessage(op, id) {
  if (typeof id !== 'string' || id === '' || id.length > ARTIFACT_CAPS.maxIdLength || !ARTIFACT_ID_PATTERN.test(id)) {
    return `artifact.${op}: id '${typeof id === 'string' ? id : describeArg(id)}' is not a valid artifact id. Use at most ${ARTIFACT_CAPS.maxIdLength} characters from [A-Za-z0-9_.-].`;
  }
  return undefined;
}

/**
 * `opts` 的形状校验（title/description/primary/contentType）。
 * @param {string} op
 * @param {unknown} opts
 * @returns {string | undefined}
 */
export function invalidArtifactOptionsMessage(op, opts) {
  if (opts === undefined || opts === null) return undefined;
  if (typeof opts !== 'object' || Array.isArray(opts)) {
    return `artifact.${op}: opts must be an options object, got ${describeArg(opts)}. Pass an object or omit the argument.`;
  }
  const record = /** @type {Record<string, unknown>} */ (opts);
  for (const field of ['title', 'description']) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      return `artifact.${op}: opts.${field} must be a string, got ${describeArg(value)}.`;
    }
    const cap = field === 'title' ? ARTIFACT_CAPS.maxTitleLength : ARTIFACT_CAPS.maxDescriptionLength;
    if (value.length > cap) {
      return `artifact.${op}: opts.${field} is ${value.length} characters, over the cap of ${cap}. Shorten it.`;
    }
  }
  if (record.primary !== undefined && typeof record.primary !== 'boolean') {
    return `artifact.${op}: opts.primary must be a boolean, got ${describeArg(record.primary)}.`;
  }
  if (op === 'file' && record.contentType !== undefined) {
    if (typeof record.contentType !== 'string') {
      return `artifact.file: opts.contentType must be a string, got ${describeArg(record.contentType)}.`;
    }
    if (!BARE_MIME_PATTERN.test(record.contentType)) {
      return `artifact.file: opts.contentType '${record.contentType}' is not a bare MIME type such as 'application/pdf'. Drop any parameters ('; charset=...'); the viewer dispatches on the exact string.`;
    }
  }
  return undefined;
}

/**
 * markdown 正文校验（§6.6 两条）。
 * @param {unknown} content
 * @param {number} [bytes] 已编码的 UTF-8 字节数
 * @returns {string | undefined}
 */
export function invalidMarkdownMessage(content, bytes) {
  if (typeof content !== 'string') {
    return `artifact.markdown: content must be a string, got ${describeArg(content)}.`;
  }
  const size = bytes ?? new TextEncoder().encode(content).length;
  if (size > ARTIFACT_CAPS.maxMarkdownBytes) {
    return `artifact.markdown: content is ${size} bytes, over the cap of ${ARTIFACT_CAPS.maxMarkdownBytes} bytes. Shorten it, or write the long content to a workspace file and publish it with artifact.file.`;
  }
  return undefined;
}

/**
 * 文件产物的路径/大小校验文案工厂。
 * @param {{path: string, reason: 'outside_workspace'|'missing'|'not_file'|'too_large', bytes?: number, errorText?: string}} input
 * @returns {string}
 */
export function fileArtifactFailureMessage({ path, reason, bytes, errorText }) {
  if (reason === 'outside_workspace') {
    return `artifact.file: cannot publish '${path}' because it is outside the workspace. Publish a workspace-relative path.`;
  }
  if (reason === 'missing' || reason === 'not_file') {
    return `artifact.file: failed to read '${path}': ${errorText ?? (reason === 'missing' ? 'no such file' : 'not a regular file')}`;
  }
  const size = Number.isFinite(bytes) ? bytes : 0;
  return `artifact.file: '${path}' is ${size} bytes, over the cap of ${ARTIFACT_CAPS.maxFileBytes} bytes. Publish a smaller file, or link to it from the result instead.`;
}

/** store 不可用 / 二进制不支持 / 无会话作用域（§6.6 三条）。 */
export const ARTIFACT_STORE_UNAVAILABLE = (op, id) => `artifact.${op}: cannot publish "${id}" because this assembly has no artifact store.`;
export const ARTIFACT_BINARY_UNSUPPORTED = (id) => `artifact.file: cannot publish "${id}" because this assembly's artifact store does not support binary writes.`;
export const ARTIFACT_NO_SESSION_SCOPE = (op, id) => `artifact.${op}: cannot publish "${id}" because the artifact store has no session scope (parent session id not wired).`;
