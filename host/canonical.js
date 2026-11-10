/**
 * 稳定化 JSON 与输入哈希。
 *
 * 为什么要自己的 canonical JSON：journal 的每个节点都带 `inputHash`，续跑/amend 靠它判断
 * “这一行还是不是同一个动作”。对象字面量的键顺序在 JS 里是书写顺序，同一份逻辑换个写法就会
 * 换哈希，缓存全失效，所以键必须排序（`beauty/zcode-cli.js:648602-648627` 的 `VS`/`qj`）。
 */

/**
 * 键排序后的 JSON 文本（`undefined` 值被丢弃，`undefined` 标量记作 `null`）。
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    return text === undefined ? 'null' : text;
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = /** @type {Record<string, unknown>} */ (value);
  const parts = [];
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * FNV-1a 32 位，按 UTF-16 码元逐字节喂入（与原实现 `w2n` 一致，保证同一输入同一哈希）。
 * @param {string} text
 * @returns {string} 8 位十六进制
 */
export function fnv1a(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) & 255;
    hash ^= (text.charCodeAt(index) >> 8) & 255;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 一个节点动作的输入哈希。
 * @param {unknown} value
 * @returns {string}
 */
export function inputHash(value) {
  return fnv1a(canonicalJson(value));
}

/**
 * UTF-8 字节数（`TextEncoder` 在 Node 里始终可用；不引 Buffer 以免把宿主 Buffer 语义带进沙箱代码）。
 * @param {string} text
 * @returns {number}
 */
export function utf8Length(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * 把任意值压成一行可读文本（日志/通知用，永不抛出）。
 * @param {unknown} value
 * @returns {string}
 */
export function safeJson(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/**
 * JSON 值的浅层预览：超长截断并补省略号。
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function preview(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
