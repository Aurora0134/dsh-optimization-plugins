/**
 * zcode-workflow: durable run / artifact / draft / saved-workflow storage.
 *
 * Everything here is plain Node ESM — no DSH values are imported, so the module can be unit
 * tested in isolation. The caller decides where `$DSH_HOME` and the project root are.
 *
 * On-disk layout (all project paths are relative to the project root `cwd`):
 *
 *   <cwd>/.dsh/workflow-runs/<runId>/            project runs
 *     meta.json                                  run metadata (no script text)
 *     script.ts                                  the exact script bytes the run executes
 *     journal.jsonl                              append-only event journal, one JSON object per line
 *     result.json                                the run's final result value (written on settle)
 *     artifacts/manifest.json                    artifact index
 *     artifacts/<artifactId>/v<version>/...      artifact payloads
 *
 *   $DSH_HOME/workflow-runs/<runId>/...          global runs
 *
 *   <cwd>/.dsh/workflow-drafts/<safe-name>.dwf.ts   machine-owned inline-script drafts
 *   <cwd>/.dsh/workflows/<name>.dwf.ts              project saved workflows
 *   $DSH_HOME/workflows/<name>.dwf.ts               global saved workflows
 *   <cwd>/.zcode/workflows/<name>.dwf.ts            ZCode-compat project archive (read-only here)
 *   $DSH_HOME/.zcode/workflows/<name>.dwf.ts        ZCode-compat global archive (read-only here)
 *
 * Saved workflow file shape:
 *
 *   /* zcode-workflow
 *   description: One line saying what the workflow does.
 *   whenToUse: When this workflow is the right answer.
 *   args:
 *     pr:
 *       type: string
 *       description: The pull request number
 *       required: true
 *   *\/
 *   ... script body ...
 *
 * Writes are atomic (temp file + rename). Missing directories are created on demand and corrupt
 * metadata is skipped rather than thrown on: a bad file must never take down a run listing.
 */

/*
 * §4 等价映射（SQLite 依赖不可用，用 JSON 文件实现同一套语义）:
 * - `dwf_run` → `meta.json`：字段名保持 `parent_session_id`/`script_hash`/`args_json`/
 *   `tool_call_id`/`resumed_from`/`caps_max_concurrency`/`spent_tokens`/`status`/
 *   `result_json`/`failure_json`/`time_created`/`time_updated`。`script_text` 落到 `script.ts`
 *   （避免把大段脚本塞进元数据）。DB 侧状态枚举是 pending/running/completed/failed/cancelled，
 *   事件侧是 pending/running/completed/errored/stopped；两者用 `workflow_state` 扩展字段并存，
 *   读取旧 meta 时按 §4.2 的映射还原。`superseded` 落在 DB 侧为 cancelled，靠 workflow_state 保留。
 * - `dwf_actor` → `actors.json`；`dwf_node` → `nodes.json`；`dwf_event` → `journal.jsonl`
 *   （见 host/journal.js）；artifact 版本 → `artifacts/manifest.json` 的一行（对应 §7.1 的
 *   `dwf_node(kind='artifact')`）。
 * - 保留策略：会话快照最多 8 条 run（按到达顺序，见 index.json）、每条 run 最多 32 个 artifact、
 *   每个 artifact 最多 16 个版本、report 快照上限 64（由投影层执行）。
 *
 * 运行表 / actor / 节点 / 事件的读写语义与 §4.3 的 SQL 一一对应；JSON 只是介质替换。
 */
import fsp from 'node:fs/promises';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pageEvents } from './journal.js';
import { projectRunEvents } from './projection.js';
import { isResumable } from './resumability.js';

/** Maximum length of a saved workflow name. */
export const MAX_SAVED_NAME_LENGTH = 64;
/** Extension of saved workflow files. */
export const SAVED_EXTENSION = '.dwf.ts';
/** Project-relative directory holding machine-owned drafts. */
export const DRAFT_DIR = '.dsh/workflow-drafts';
/** Project-relative directory holding durable runs. */
export const RUNS_DIR = '.dsh/workflow-runs';
/** Project-relative directory holding project saved workflows. */
export const SAVED_DIR = '.dsh/workflows';
/** Directory name (under $DSH_HOME) holding global runs. */
export const GLOBAL_RUNS_DIR = 'workflow-runs';
/** Directory name (under $DSH_HOME) holding global saved workflows. */
export const GLOBAL_SAVED_DIR = 'workflows';
/** Legacy ZCode root name, still read for compatibility. */
export const ZCODE_DIR = '.zcode';
/** Contents of the `.gitignore` written into the drafts directory on first use. */
export const DRAFT_GITIGNORE = '*';
/** Markers a project should ignore so machine-owned state is never committed. */
export const DEFAULT_IGNORE = ['.dsh/workflow-runs/', '.dsh/workflow-drafts/', '.zcode/workflow-drafts/'];
/** Exact message used when a saved workflow name is rejected. */
export const INVALID_SAVED_NAME_MESSAGE = "workflow names may only contain letters, digits, '.', '-' and '_', and must be 1-64 characters";
/** Charset a saved workflow name must match. */
export const SAVED_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;

/** 会话快照最多保留的 run 数（§3.2 `Lm.maxRuns`）。 */
export const MAX_RUNS_PER_SNAPSHOT = 8;
/** `workflowRuns` 默认条数与上限（§1.1(1)：省略 limit 返回 16，上限 64）。 */
export const DEFAULT_RUN_PAGE = 16;
export const MAX_RUN_PAGE = 64;
/** artifact 保留策略（§4.4）：每个 run ≤32 个 id，每个 id ≤16 个版本。 */
export const MAX_ARTIFACTS_PER_RUN = 32;
export const MAX_ARTIFACT_VERSIONS = 16;
/** report 快照上限（§4.4）。 */
export const MAX_REPORTS_PER_RUN = 64;
/** 一条 world 调用在**响应 schema** 里最多 16 个参数（§1.1(6) `M3.maxArgs`）。 */
export const MAX_WORLD_ARGS = 16;
/** 落库台账的入参上限（§9 `boundWorldReadInput`）：超过时只留前 8 个、每个 400 字符。 */
const WORLD_INPUT_MAX_ARGS = 8;
const WORLD_INPUT_ARG_CHARS = 400;
const WORLD_INPUT_MAX_BYTES = 4096;
/** world 节点结果读取上限（§8 `M3.resultMaxBytes`）。 */
export const MAX_NODE_RESULT_BYTES = 32 * 1024;

const DB_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'cancelled']);
const EVENT_TERMINAL = new Set(['completed', 'errored', 'stopped', 'superseded']);
const DB_TO_EVENT_STATUS = Object.freeze({ failed: 'errored', cancelled: 'stopped' });
const EVENT_TO_DB_STATUS = Object.freeze({ errored: 'failed', stopped: 'cancelled', superseded: 'cancelled' });


const FRONTMATTER_OPEN = '/* zcode-workflow';
const FRONTMATTER_CLOSE = '*/';
const ARTIFACT_KINDS = new Set(['file', 'markdown', 'chart', 'table', 'metrics', 'board']);
const ARGUMENT_TYPES = new Set(['string', 'number', 'boolean', 'json']);
const META_KEYS = new Set(['description', 'whenToUse', 'args']);
const ARG_KEYS = new Set(['type', 'description', 'required', 'default']);

/* ---------------------------------------------------------------------------------------------- */
/* small fs helpers                                                                                */
/* ---------------------------------------------------------------------------------------------- */

/** @param {string} file */
async function exists(file) {
  try {
    await fsp.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} file */
async function readTextSafe(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** @param {string} value */
function safeJson(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} file */
async function readJson(file) {
  const text = await readTextSafe(file);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Write a UTF-8 file atomically: temp sibling + rename, with an unlink+rename retry for Windows
 * antivirus / open-handle EPERM cases.
 *
 * @param {string} file
 * @param {string} text
 */
async function writeFileAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(temp, text, 'utf8');
  try {
    await fsp.rename(temp, file);
  } catch {
    await fsp.rm(file, { force: true }).catch(() => {});
    await fsp.rename(temp, file);
  }
}

/** @param {string} file @param {unknown} value */
async function writeJsonAtomic(file, value) {
  const text = safeJson(value);
  await writeFileAtomic(file, `${text === undefined ? 'null' : text}\n`);
}

/** @param {string} dir @returns {Promise<import('node:fs').Dirent[]>} */
async function readDirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* synchronous equivalents for the engine journal interface                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * 引擎（runtime.js）的 journal 接口是同步的：`record()` 不 await，`getRun()` 直接取字段。
 * 因此 run / actor / node / event 这几类核心写入用同步 fs；artifact、draft、saved workflow
 * 仍走异步实现（不在引擎热路径上）。
 */

/** @param {string} file @returns {Record<string, any> | undefined} */
function readJsonSync(file) {
  try {
    const text = readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} file @param {unknown} value */
function writeJsonAtomicSync(file, value) {
  const text = safeJson(value);
  writeFileAtomicSync(file, `${text === undefined ? 'null' : text}\n`);
}

/** @param {string} file @param {string} text */
function writeFileAtomicSync(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, 'utf8');
  try {
    renameSync(temp, file);
  } catch {
    rmSync(file, { force: true });
    renameSync(temp, file);
  }
}

/** @param {string} dir @returns {import('node:fs').Dirent[]} */
function readDirSafeSync(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Read one JSONL journal file synchronously, tolerating torn/legacy rows.
 *
 * @param {string} file
 * @returns {{ sequence: number, type: string, payload: Record<string, any>, time_created: number }[]}
 */
function readJournalRowsFromFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  /** @type {{ sequence: number, type: string, payload: Record<string, any>, time_created: number }[]} */
  const rows = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = /** @type {Record<string, any>} */ (parsed);
    if (Number.isInteger(record.sequence)) {
      rows.push({
        sequence: record.sequence,
        type: typeof record.type === 'string' ? record.type : 'log',
        payload: record.payload !== null && typeof record.payload === 'object' ? record.payload : record,
        time_created: Number.isFinite(record.time_created)
          ? record.time_created
          : (Number.isFinite(record.at) ? record.at : 0),
      });
    } else {
      rows.push({
        sequence: rows.length,
        type: typeof record.type === 'string' ? record.type : 'log',
        payload: record,
        time_created: Number.isFinite(record.at) ? record.at : 0,
      });
    }
  }
  rows.sort((left, right) => left.sequence - right.sequence);
  return rows;
}

/** @param {{ sequence: number, type: string, payload: Record<string, any>, time_created: number }} row */
function flattenJournalRow(row) {
  const timeCreated = row.time_created;
  return {
    ...row.payload,
    sequence: row.sequence,
    type: row.type,
    payload: row.payload,
    at: timeCreated,
    time_created: timeCreated,
  };
}

/** 代理对安全的 80 字符截断（`mRt` 的展示回退）。 */
function boundedLabelText(text) {
  const characters = [...String(text ?? '').trim()];
  return characters.slice(0, 80).join('');
}

/**
 * run 的展示标签（`resolveDynamicWorkflowRunLabel`，zcode-cli.js:73804-73830）：
 * 显式 name → 脚本第一段非空行（≤80 字符，代理对安全）→ runId。
 *
 * @param {Record<string, any>} meta
 * @param {string} dir
 * @returns {string}
 */
function resolveRunLabel(meta, dir) {
  const explicit = typeof meta.name === 'string' ? meta.name.trim() : '';
  if (explicit !== '') return explicit;
  try {
    const text = readFileSync(path.join(dir, 'script.ts'), 'utf8');
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed !== '') return boundedLabelText(trimmed);
    }
  } catch {
    // 没有脚本（或暂时读不到）时退回 runId。
  }
  return meta.id;
}


/** @param {string} value @param {string} [fallback] */
function safeSegment(value, fallback = 'item') {
  const text = String(value ?? '').replace(/[^\w.-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (text === '' || text === '.' || text === '..') return fallback;
  return text.slice(0, 96);
}

/** @param {number|undefined} pid */
function isProcessAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* metadata YAML subset                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A YAML subset that is exactly enough for the saved-workflow metadata block: one level of
 * mappings, an `args` mapping (or a sequence of named declarations), and scalar leaves.
 * Unknown constructs are a parse error rather than silently ignored: the block is machine-written.
 */
class YamlError extends Error {}

const YAML_RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n', '~']);
const YAML_NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/u;
const PLAIN_SCALAR = /^[A-Za-z0-9_][A-Za-z0-9 _.,()/'’\/+-]*$/u;

/** @param {string} value */
function isPlainYamlScalar(value) {
  if (value === '') return false;
  if (/[\n\r\t\u0000]/u.test(value)) return false;
  if (value !== value.trim()) return false;
  if (!PLAIN_SCALAR.test(value)) return false;
  if (YAML_RESERVED.has(value.toLowerCase())) return false;
  if (YAML_NUMBER.test(value)) return false;
  return true;
}

/** @param {unknown} value */
function yamlScalar(value) {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  const text = String(value);
  if (isPlainYamlScalar(text)) return text;
  return JSON.stringify(text);
}

/** `default` may be any JSON value; flow-style JSON is also valid YAML. @param {unknown} value */
function yamlValue(value) {
  if (value !== null && typeof value === 'object') {
    const text = safeJson(value);
    return text === undefined ? 'null' : text;
  }
  return yamlScalar(value);
}

/**
 * Accept either the canonical `Record<name, declaration>` or ZCode's model-facing array
 * `[{ name, type, ... }]`. Returns undefined when the input is neither shape.
 *
 * @param {unknown} input
 * @returns {Record<string, object> | undefined}
 */
function normalizeArgs(input) {
  if (input === undefined || input === null) return undefined;
  if (Array.isArray(input)) {
    /** @type {Record<string, object>} */
    const record = {};
    input.forEach((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return;
      const { name, ...rest } = /** @type {Record<string, unknown>} */ (entry);
      const key = typeof name === 'string' && name !== '' ? name : `arg${index + 1}`;
      record[key] = rest;
    });
    return record;
  }
  if (typeof input === 'object') return /** @type {Record<string, object>} */ ({ ...input });
  return undefined;
}

/**
 * Serialize metadata to the block's YAML body (without the surrounding comment markers).
 *
 * @param {{ description: string, whenToUse?: string, args?: unknown }} meta
 * @returns {string}
 */
function stringifyMetadataYaml(meta) {
  const lines = [`description: ${yamlScalar(meta.description)}`];
  if (meta.whenToUse !== undefined) lines.push(`whenToUse: ${yamlScalar(meta.whenToUse)}`);
  const args = normalizeArgs(meta.args);
  if (args !== undefined && Object.keys(args).length > 0) {
    lines.push('args:');
    for (const [name, declaration] of Object.entries(args)) {
      if (declaration === null || typeof declaration !== 'object') continue;
      const decl = /** @type {Record<string, unknown>} */ (declaration);
      lines.push(`  ${yamlScalar(name)}:`);
      lines.push(`    type: ${yamlScalar(decl.type ?? 'string')}`);
      if (decl.description !== undefined) lines.push(`    description: ${yamlScalar(decl.description)}`);
      if (decl.required !== undefined) lines.push(`    required: ${yamlScalar(decl.required === true)}`);
      if (decl.default !== undefined) lines.push(`    default: ${yamlValue(decl.default)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Parse one scalar leaf with YAML implicit typing.
 *
 * @param {string} text
 * @returns {unknown}
 */
function parseYamlScalar(text) {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '~' || trimmed === 'null' || trimmed === 'Null' || trimmed === 'NULL') return null;
  if (trimmed === 'true' || trimmed === 'True' || trimmed === 'TRUE') return true;
  if (trimmed === 'false' || trimmed === 'False' || trimmed === 'FALSE') return false;
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new YamlError(`unterminated double-quoted string: ${trimmed}`);
    }
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) throw new YamlError(`unterminated single-quoted string: ${trimmed}`);
    return trimmed.slice(1, -1).replace(/''/gu, "'");
  }
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new YamlError(`unsupported flow collection: ${trimmed}`);
    }
  }
  if (YAML_NUMBER.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/**
 * Parse a `key: value` line into a mapping.
 *
 * @param {Record<string, unknown>} target
 * @param {string} line
 */
function parseKeyValueLine(target, line) {
  const separator = line.indexOf(':');
  if (separator <= 0) throw new YamlError(`expected "key: value", got: ${line}`);
  const rawKey = line.slice(0, separator).trim();
  if (rawKey === '') throw new YamlError(`expected a key, got: ${line}`);
  const key = rawKey.startsWith('"') || rawKey.startsWith("'")
    ? String(parseYamlScalar(rawKey))
    : rawKey;
  const rest = line.slice(separator + 1).trim();
  target[key] = rest === '' ? {} : parseYamlScalar(rest);
  return key;
}

/**
 * Parse the metadata YAML subset into a plain object.
 *
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
function parseMetadataYaml(text) {
  /** @type {Record<string, unknown>} */
  const root = {};
  /** @type {{ indent: number, node: any, parent?: any, key?: string, isList?: boolean }[]} */
  const stack = [{ indent: -1, node: root }];

  for (const rawLine of text.split(/\r?\n/u)) {
    if (rawLine.trim() === '' || rawLine.trim().startsWith('#')) continue;
    if (/^\s*\t/u.test(rawLine)) throw new YamlError('tabs are not allowed for indentation');
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    let entry = stack[stack.length - 1];

    if (line.startsWith('- ')) {
      const listLine = line.slice(2).trim();
      if (!entry.isList) {
        if (entry.parent === undefined) throw new YamlError('unexpected sequence item');
        const list = [];
        entry.parent[entry.key] = list;
        entry.node = list;
        entry.isList = true;
      }
      if (listLine === '') {
        const item = {};
        entry.node.push(item);
        stack.push({ indent, node: item });
      } else {
        const item = {};
        entry.node.push(item);
        parseKeyValueLine(item, listLine);
        stack.push({ indent: indent + 2, node: item });
      }
      continue;
    }

    if (entry.isList) throw new YamlError(`cannot mix mappings into a sequence: ${line}`);
    const key = parseKeyValueLine(entry.node, line);
    if (entry.node[key] !== null && typeof entry.node[key] === 'object' && !Array.isArray(entry.node[key])) {
      stack.push({ indent, node: entry.node[key], parent: entry.node, key });
    }
  }

  return root;
}

/**
 * Validate parsed metadata against the saved-workflow contract.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, meta: { description: string, whenToUse?: string, args?: Record<string, object> } } | { ok: false, detail: string }}
 */
function validateMetadata(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, detail: '(root): expected an object' };
  const record = /** @type {Record<string, unknown>} */ (raw);
  /** @type {string[]} */
  const issues = [];
  for (const key of Object.keys(record)) {
    if (!META_KEYS.has(key)) issues.push(`${key}: unrecognized key`);
  }

  /** @type {{ description: string, whenToUse?: string, args?: Record<string, object> }} */
  const meta = { description: '' };
  if (typeof record.description !== 'string') {
    issues.push('description: expected a string');
  } else {
    // §1.2 `Ow.description: J`：必填但允许空串（契约只要求存在且为字符串）。
    meta.description = record.description;
  }

  if (record.whenToUse !== undefined) {
    if (typeof record.whenToUse !== 'string' || record.whenToUse.trim() === '') issues.push('whenToUse: must be a non-empty string');
    else meta.whenToUse = record.whenToUse;
  }

  if (record.args !== undefined) {
    if (Array.isArray(record.args) || (record.args !== null && typeof record.args === 'object')) {
      const args = normalizeArgs(record.args) ?? {};
      /** @type {Record<string, object>} */
      const declarations = {};
      for (const [name, declaration] of Object.entries(args)) {
        if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
          issues.push(`args.${name}: expected a declaration object`);
          continue;
        }
        const decl = /** @type {Record<string, unknown>} */ (declaration);
        for (const key of Object.keys(decl)) {
          if (!ARG_KEYS.has(key)) issues.push(`args.${name}.${key}: unrecognized key`);
        }
        if (typeof decl.type !== 'string' || !ARGUMENT_TYPES.has(decl.type)) {
          issues.push(`args.${name}.type: expected one of "string", "number", "boolean", "json"`);
        }
        if (decl.description !== undefined && typeof decl.description !== 'string') {
          issues.push(`args.${name}.description: expected a string`);
        }
        if (decl.required !== undefined && typeof decl.required !== 'boolean') {
          issues.push(`args.${name}.required: expected a boolean`);
        }
        declarations[name] = {
          type: decl.type,
          ...(decl.description === undefined ? {} : { description: decl.description }),
          ...(decl.required === undefined ? {} : { required: decl.required }),
          ...(decl.default === undefined ? {} : { default: decl.default }),
        };
      }
      meta.args = declarations;
    } else {
      issues.push('args: expected a mapping of argument names to declarations');
    }
  }

  if (issues.length > 0) return { ok: false, detail: issues.join('; ') };
  return { ok: true, meta };
}

/* ---------------------------------------------------------------------------------------------- */
/* saved-workflow file format                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * @typedef {object} ParsedSavedWorkflow
 * @property {true} ok
 * @property {{ description: string, whenToUse?: string, args?: Record<string, { type: 'string'|'number'|'boolean'|'json', description?: string, required?: boolean, default?: unknown }> }} meta
 * @property {string} body the script body (everything after the metadata block)
 * @property {string} script alias of `body`, for callers that name it that way
 * @property {number} bodyLineOffset number of header lines; `script` line N is file line N + offset
 */

/**
 * Parse a `.dwf.ts` file into its metadata block and body.
 *
 * @param {string} text
 * @returns {ParsedSavedWorkflow | { ok: false, reason: 'missing_frontmatter'|'unterminated_frontmatter'|'invalid_yaml'|'invalid_metadata', detail: string }}
 */
export function parseSavedWorkflowFile(text) {
  const source = typeof text === 'string' ? text.replace(/^\uFEFF/u, '') : '';
  const openPattern = /^\s*\/\*\s*zcode-workflow/u;
  if (!openPattern.test(source)) {
    return {
      ok: false,
      reason: 'missing_frontmatter',
      detail: `file does not start with the \`${FRONTMATTER_OPEN}\` metadata block`,
    };
  }
  const openIndex = source.indexOf('zcode-workflow');
  const yamlStart = source.indexOf('\n', openIndex);
  if (yamlStart < 0) {
    return { ok: false, reason: 'unterminated_frontmatter', detail: `metadata block is never closed with \`${FRONTMATTER_CLOSE}\`` };
  }
  const closeIndex = source.indexOf(FRONTMATTER_CLOSE, yamlStart);
  if (closeIndex < 0) {
    return { ok: false, reason: 'unterminated_frontmatter', detail: `metadata block is never closed with \`${FRONTMATTER_CLOSE}\`` };
  }

  const yamlText = source.slice(yamlStart + 1, closeIndex);
  /** @type {Record<string, unknown>} */
  let parsed;
  try {
    parsed = parseMetadataYaml(yamlText);
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid_yaml',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const validated = validateMetadata(parsed);
  if (!validated.ok) return { ok: false, reason: 'invalid_metadata', detail: validated.detail };

  const bodyStart = closeIndex + FRONTMATTER_CLOSE.length;
  let body = source.slice(bodyStart);
  const headerLines = (source.slice(0, bodyStart).match(/\n/gu) ?? []).length;
  const newline = /^\r?\n/u.exec(body);
  const bodyLineOffset = headerLines + (newline === null ? 0 : 1);
  if (newline !== null) body = body.slice(newline[0].length);

  return { ok: true, meta: validated.meta, body, script: body, bodyLineOffset };
}

/**
 * Serialize metadata + body into the exact on-disk `.dwf.ts` shape.
 *
 * @param {{ description: string, whenToUse?: string, args?: unknown }} meta
 * @param {string} script
 * @returns {string}
 */
export function serializeSavedWorkflowFile(meta, script) {
  const description = typeof meta?.description === 'string'
    ? meta.description
    : 'Saved workflow.';
  const whenToUse = typeof meta?.whenToUse === 'string' && meta.whenToUse.trim() !== '' ? meta.whenToUse : undefined;
  const args = normalizeArgs(meta?.args);
  const yaml = stringifyMetadataYaml({
    description,
    whenToUse,
    ...(args === undefined || Object.keys(args).length === 0 ? {} : { args }),
  });
  // pwe 的落盘形态：`*/` 后只跟一个换行，`workflows/get.script` 返回脚本原文而不带前导空行。
  return `${FRONTMATTER_OPEN}\n${yaml}${FRONTMATTER_CLOSE}\n${String(script ?? '')}`;
}

/**
 * Validate a saved workflow name.
 *
 * @param {unknown} name
 * @returns {{ ok: true, name: string } | { ok: false, message: string }}
 */
export function validateSavedWorkflowName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_SAVED_NAME_LENGTH || !SAVED_NAME_PATTERN.test(name)) {
    return { ok: false, message: INVALID_SAVED_NAME_MESSAGE };
  }
  return { ok: true, name };
}

/* ---------------------------------------------------------------------------------------------- */
/* store                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------------------------- */
/* §4 row encoding: canonical meta.json <-> public run row                                         */
/* ---------------------------------------------------------------------------------------------- */

/** @param {string} text */
function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 事件侧状态 → DB 侧状态（§4.2 `kdn`）。 */
function toDbStatus(status) {
  if (typeof status !== 'string') return 'running';
  if (EVENT_TO_DB_STATUS[status] !== undefined) return EVENT_TO_DB_STATUS[status];
  return DB_STATUSES.has(status) ? status : 'running';
}

/** DB 侧状态 + `workflow_state` 扩展 → 事件侧状态（§4.2 `fct`）。 */
function toEventStatus(dbStatus, workflowState) {
  if (typeof workflowState === 'string' && workflowState !== '') return workflowState;
  if (typeof dbStatus !== 'string') return 'running';
  return DB_TO_EVENT_STATUS[dbStatus] ?? dbStatus;
}

/** @param {unknown} value */
function parseJsonMaybe(value) {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * 把磁盘上的 dwf_run 行归一化。兼容旧版 meta.json（camelCase、status 直接是事件枚举）。
 *
 * @param {Record<string, any>} raw
 * @param {string} fallbackId
 */
function normalizeRunMeta(raw, fallbackId) {
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : fallbackId;
  const timeCreated = Number.isFinite(raw.time_created)
    ? raw.time_created
    : (Number.isFinite(raw.createdAt) ? raw.createdAt : 0);
  const timeUpdated = Number.isFinite(raw.time_updated)
    ? raw.time_updated
    : (Number.isFinite(raw.updatedAt) ? raw.updatedAt : timeCreated);
  const rawStatus = typeof raw.status === 'string' ? raw.status : 'running';
  const workflowState = typeof raw.workflow_state === 'string' && raw.workflow_state !== ''
    ? raw.workflow_state
    : (DB_STATUSES.has(rawStatus) ? undefined : rawStatus);
  return {
    ...raw,
    id,
    status: DB_STATUSES.has(rawStatus) ? rawStatus : toDbStatus(rawStatus),
    ...(workflowState === undefined ? {} : { workflow_state: workflowState }),
    time_created: timeCreated,
    time_updated: timeUpdated,
  };
}

/**
 * 把 dwf_run 行投影成 host 公共形状：既包含 §4 的规范字段，也保留旧调用方使用的
 * camelCase 别名（runtime/tools 仍按旧 API 读）。
 *
 * @param {Record<string, any>} meta
 */
function publicRunMeta(meta) {
  const status = toEventStatus(meta.status, meta.workflow_state);
  const terminal = EVENT_TERMINAL.has(status);
  const args = parseJsonMaybe(meta.args_json) ?? (meta.args !== null && typeof meta.args === 'object' ? meta.args : {});
  const resultJson = parseJsonMaybe(meta.result_json);
  const failure = meta.failure_json !== null && typeof meta.failure_json === 'object'
    ? meta.failure_json
    : (typeof meta.failure_json === 'string' ? parseJsonMaybe(meta.failure_json) : undefined);
  const error = typeof failure?.message === 'string'
    ? failure.message
    : (typeof meta.error === 'string' ? meta.error : undefined);
  const failureCode = typeof failure?.code === 'string' && failure.code !== ''
    ? failure.code.slice(0, 64)
    : undefined;
  return {
    ...meta,
    id: meta.id,
    name: meta.name ?? meta.id,
    status,
    cwd: meta.cwd,
    scriptPath: meta.script_path ?? meta.scriptPath,
    scriptHash: meta.script_hash ?? meta.scriptHash,
    args,
    maxConcurrency: meta.caps_max_concurrency ?? meta.maxConcurrency,
    subagentModel: meta.subagent_model ?? meta.subagentModel,
    origin: meta.origin,
    phases: meta.phases ?? [],
    agentNames: meta.agent_names ?? meta.agentNames,
    createdAt: meta.time_created,
    updatedAt: meta.time_updated,
    finishedAt: terminal ? meta.time_updated : meta.finishedAt,
    stopReason: meta.stopReason ?? meta.stop_reason,
    error,
    ...(failureCode === undefined ? {} : { failureCode }),
    result: resultJson !== undefined ? resultJson : meta.result,
    resumedFrom: meta.resumed_from ?? meta.resumedFrom,
    supersededBy: meta.superseded_by ?? meta.supersededBy,
    parentSessionId: meta.parent_session_id ?? meta.parentSessionId,
    toolCallId: meta.tool_call_id ?? meta.toolCallId,
    spentTokens: meta.spent_tokens ?? meta.spentTokens ?? meta.usage?.spentTokens ?? 0,
    labelSource: meta.labelSource ?? meta.origin,
    pid: meta.pid,
  };
}

/**
 * 创建/更新时把旧 API 的 patch 映射到 §4 字段名。
 *
 * @param {Record<string, any>} patch
 * @param {Record<string, any>} current 归一化后的当前行
 * @param {number} now
 */
function applyRunPatch(patch, current, now) {
  /** @type {Record<string, any>} */
  const next = { ...current };
  const set = (key, value) => {
    if (value !== undefined) next[key] = value;
  };
  set('name', patch.name);
  set('cwd', patch.cwd);
  set('parent_session_id', patch.parentSessionId ?? patch.parent_session_id);
  set('script_path', patch.scriptPath ?? patch.script_path);
  set('script_hash', patch.scriptHash ?? patch.script_hash);
  set('tool_call_id', patch.toolCallId ?? patch.tool_call_id);
  set('resumed_from', patch.resumedFrom ?? patch.resumed_from);
  set('superseded_by', patch.supersededBy ?? patch.superseded_by);
  set('subagent_model', patch.subagentModel ?? patch.subagent_model);
  set('origin', patch.origin);
  set('phases', patch.phases);
  set('agent_names', patch.agentNames ?? patch.agent_names);
  set('pid', patch.pid);
  set('last_event_sequence', patch.lastEventSequence ?? patch.last_event_sequence);
  if (patch.args !== undefined) next.args_json = safeJson(patch.args);
  if (patch.maxConcurrency !== undefined || patch.caps_max_concurrency !== undefined) {
    next.caps_max_concurrency = patch.maxConcurrency ?? patch.caps_max_concurrency;
  }
  if (patch.spentTokens !== undefined || patch.spent_tokens !== undefined) {
    next.spent_tokens = patch.spentTokens ?? patch.spent_tokens;
  }
  if (patch.usage !== undefined && typeof patch.usage === 'object' && patch.usage !== null) {
    next.spent_tokens = patch.usage.spentTokens ?? next.spent_tokens;
  }
  if (patch.status !== undefined) {
    next.workflow_state = patch.status;
    next.status = toDbStatus(patch.status);
  }
  if (patch.stopReason !== undefined || patch.stop_reason !== undefined) {
    next.stop_reason = patch.stopReason ?? patch.stop_reason;
  }
  if (patch.error !== undefined) {
    const record = patch.error !== null && typeof patch.error === 'object' && !Array.isArray(patch.error)
      ? patch.error
      : { message: typeof patch.error === 'string' ? patch.error : String(patch.error) };
    next.failure_json = record;
    next.error = typeof record.message === 'string' ? record.message : String(record.message ?? '');
  }
  if (patch.result !== undefined) {
    const serialized = safeJson(patch.result);
    if (serialized !== undefined) {
      next.result_json = serialized;
      next.result = patch.result;
    }
  }
  if (patch.finishedAt !== undefined) {
    next.time_updated = patch.finishedAt;
  }
  next.time_updated = Number.isFinite(patch.updatedAt) ? patch.updatedAt : next.time_updated ?? now;
  return next;
}

/**
 * world 调用入参的等价截断（§9 `boundWorldReadInput`，zcode-cli.js:650436-650443）：
 * 整体 JSON ≤4096 字节时原样保留；超限才只留前 8 个参数，每个序列化截到 400 字符 + `…`。
 *
 * @param {unknown} input
 * @returns {Record<string, any> | undefined}
 */
function boundWorldInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = /** @type {Record<string, any>} */ ({ ...input });
  const args = Array.isArray(record.args) ? record.args : undefined;
  if (args === undefined) {
    return { ...(typeof record.op === 'string' ? { op: record.op.slice(0, 32) } : {}) };
  }
  const op = typeof record.op === 'string' ? record.op : '';
  try {
    const whole = JSON.stringify({ op, args });
    if (whole !== undefined && Buffer.byteLength(whole, 'utf8') <= WORLD_INPUT_MAX_BYTES) {
      return { ...(op === '' ? {} : { op }), args };
    }
  } catch {
    // 序列化失败（循环/大数）时走截断路径。
  }
  const boundedArgs = args.slice(0, WORLD_INPUT_MAX_ARGS).map((arg) => {
    let text;
    if (typeof arg === 'string') text = arg;
    else {
      try {
        text = JSON.stringify(arg) ?? String(arg);
      } catch {
        text = String(arg);
      }
    }
    return text.length > WORLD_INPUT_ARG_CHARS ? `${text.slice(0, WORLD_INPUT_ARG_CHARS)}\u2026` : text;
  });
  return {
    ...(op === '' ? {} : { op }),
    args: boundedArgs,
    truncated: true,
  };
}

/**
 * Create the durable store facade.
 *
 * Every method takes an optional per-call `{ cwd }` project root; when omitted the store falls
 * back to `getProjectRoot()` (and finally `process.cwd()`).
 *
 * @param {object} [options]
 * @param {string} [options.homeDir] `$DSH_HOME`; defaults to `DSH_HOME` or the OS home directory
 * @param {() => string} [options.getProjectRoot] default project root resolver
 */
export function createStore(options = {}) {
  const { homeDir, getProjectRoot } = options;

  const home = () => path.resolve(homeDir ?? process.env.DSH_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? '.');
  const projectRoot = () => path.resolve(typeof getProjectRoot === 'function' ? getProjectRoot() : process.cwd());
  const resolveRoot = (cwd) => path.resolve(typeof cwd === 'string' && cwd !== '' ? cwd : projectRoot());

  const projectRunsDir = (root) => path.join(root, RUNS_DIR);
  const globalRunsDir = () => path.join(home(), GLOBAL_RUNS_DIR);

  /**
   * Synchronous run directory lookup for the engine journal interface.
   *
   * @param {string} id
   * @param {string} [cwd]
   * @returns {string | undefined}
   */
  const locateRunDirSync = (id, cwd) => {
    if (typeof id !== 'string' || id === '') return undefined;
    const candidates = [
      path.join(projectRunsDir(resolveRoot(cwd)), id),
      path.join(globalRunsDir(), id),
    ];
    for (const dir of candidates) {
      if (existsSync(path.join(dir, 'meta.json'))) return dir;
    }
    for (const dir of candidates) {
      if (existsSync(dir)) return dir;
    }
    return undefined;
  };

  /** @param {string} dir @returns {Record<string, any> | undefined} */
  const readRunMetaSync = (dir) => {
    const meta = readJsonSync(path.join(dir, 'meta.json'));
    if (meta === undefined) return undefined;
    return normalizeRunMeta(meta, path.basename(dir));
  };

  const snapshotIndexFile = (root) => path.join(projectRunsDir(root), 'index.json');

  /**
   * 会话快照索引（`Lm` 等价物）：`{revision, runs: runId[]}`，按到达顺序保留最后 8 条。
   * ZCode 把快照放在会话存储里；这里放在项目运行目录下，语义相同：只影响快照列表，不影响
   * `workflowRuns` RPC 的 16/64 条枚举。
   *
   * @param {string} root
   * @returns {Promise<{ revision: number, runs: string[] }>}
   */
  const readSnapshotIndex = async (root) => {
    const raw = await readJson(snapshotIndexFile(root));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { revision: 0, runs: [] };
    const runs = Array.isArray(raw.runs) ? raw.runs.filter((id) => typeof id === 'string' && id !== '') : [];
    return {
      revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
      runs,
    };
  };

  /**
   * Synchronous snapshot-index bump for createRun/appendEvent (the engine calls them without
   * awaiting). The async reader above sees the same file.
   *
   * @param {string} root
   * @param {string} runId
   */
  const touchSnapshotIndexSync = (root, runId) => {
    const raw = readJsonSync(snapshotIndexFile(root));
    const current = raw === undefined
      ? { revision: 0, runs: /** @type {string[]} */ ([]) }
      : {
        revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
        runs: Array.isArray(raw.runs) ? raw.runs.filter((id) => typeof id === 'string' && id !== '') : [],
      };
    const runs = current.runs.filter((id) => id !== runId);
    runs.push(runId);
    const trimmed = runs.length > MAX_RUNS_PER_SNAPSHOT ? runs.slice(runs.length - MAX_RUNS_PER_SNAPSHOT) : runs;
    writeJsonAtomicSync(snapshotIndexFile(root), { revision: current.revision + 1, runs: trimmed });
  };


  /** @returns {{ scope: 'project'|'global', dir: string, flavor: 'dsh'|'zcode' }[]} */
  const savedRoots = (root, scope) => {
    const project = [
      { scope: /** @type {const} */ ('project'), dir: path.join(root, SAVED_DIR), flavor: /** @type {const} */ ('dsh') },
      { scope: /** @type {const} */ ('project'), dir: path.join(root, ZCODE_DIR, 'workflows'), flavor: /** @type {const} */ ('zcode') },
    ];
    const global = [
      { scope: /** @type {const} */ ('global'), dir: path.join(home(), GLOBAL_SAVED_DIR), flavor: /** @type {const} */ ('dsh') },
      { scope: /** @type {const} */ ('global'), dir: path.join(home(), ZCODE_DIR, 'workflows'), flavor: /** @type {const} */ ('zcode') },
    ];
    if (scope === 'project') return project;
    if (scope === 'global') return global;
    // Precedence: project shadows global, and within a scope `.dsh` shadows `.zcode`.
    return [...project, ...global];
  };

  const savedTargetDir = (root, scope) => (scope === 'global' ? path.join(home(), GLOBAL_SAVED_DIR) : path.join(root, SAVED_DIR));

  /**
   * Locate the directory of a run: the project runs dir first, then `$DSH_HOME/workflow-runs`.
   *
   * @param {string} id
   * @param {string} [cwd]
   * @returns {Promise<string | undefined>}
   */
  const locateRunDir = async (id, cwd) => {
    if (typeof id !== 'string' || id === '') return undefined;
    const candidates = [path.join(projectRunsDir(resolveRoot(cwd)), id), path.join(globalRunsDir(), id)];
    for (const dir of candidates) {
      if (await exists(path.join(dir, 'meta.json'))) return dir;
    }
    for (const dir of candidates) {
      if (await exists(dir)) return dir;
    }
    return undefined;
  };

  /* ------------------------------- runs ------------------------------------------------------- */

  /**
   * Create one durable run directory.
   *
   * Synchronous because the engine's journal interface calls it without awaiting; existing async
   * callers `await` the returned value, which is legal for a plain object.
   *
   * @param {Record<string, any>} input engine or legacy run fields
   * @returns {Record<string, any>} public run row
   */
  const createRun = (input = {}) => {
    const id = input.id ?? input.runId;
    if (typeof id !== 'string' || id === '') throw new Error('createRun requires a string run id');
    const root = resolveRoot(input.cwd);
    const dir = path.join(projectRunsDir(root), id);
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const scriptText = typeof input.code === 'string'
      ? input.code
      : (typeof input.scriptText === 'string' ? input.scriptText : undefined);
    /** @type {string | undefined} */
    let scriptHash = typeof input.scriptHash === 'string' ? input.scriptHash : undefined;
    if (scriptText !== undefined) {
      scriptHash = scriptHash ?? sha256Hex(scriptText);
      writeFileAtomicSync(path.join(dir, 'script.ts'), scriptText);
    }
    const workflowStatus = typeof input.status === 'string' ? input.status : 'running';
    const timeCreated = Number.isFinite(input.timeCreated)
      ? input.timeCreated
      : (Number.isFinite(input.createdAt) ? input.createdAt : now);
    /** @type {Record<string, any>} */
    const meta = {
      id,
      parent_session_id: input.parentSessionId ?? input.parent_session_id ?? input.sessionId ?? null,
      cwd: root,
      ...(typeof input.name === 'string' && input.name !== '' ? { name: input.name } : {}),
      script_path: input.scriptPath ?? input.script_path ?? null,
      script_hash: scriptHash ?? null,
      args_json: safeJson(input.args ?? {}) ?? '{}',
      tool_call_id: input.toolCallId ?? input.tool_call_id ?? null,
      resumed_from: input.resumedFrom ?? input.resumed_from ?? null,
      superseded_by: input.supersededBy ?? input.superseded_by ?? null,
      caps_max_concurrency: input.caps?.maxConcurrency
        ?? input.maxConcurrency
        ?? input.caps_max_concurrency
        ?? 1,
      spent_tokens: input.spentTokens ?? input.spent_tokens ?? 0,
      status: toDbStatus(workflowStatus),
      workflow_state: workflowStatus,
      ...(input.result !== undefined ? { result_json: safeJson(input.result) } : {}),
      ...(input.failure !== undefined || input.error !== undefined
        ? { failure_json: input.failure ?? { message: typeof input.error === 'string' ? input.error : String(input.error?.message ?? input.error) } }
        : {}),
      time_created: timeCreated,
      time_updated: Number.isFinite(input.updatedAt) ? input.updatedAt : timeCreated,
      last_event_sequence: 0,
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(input.subagentModel === undefined ? {} : { subagent_model: input.subagentModel }),
      ...(input.phases === undefined ? {} : { phases: input.phases }),
      ...(input.agentNames === undefined ? {} : { agent_names: input.agentNames }),
      pid: input.pid ?? process.pid,
    };
    writeJsonAtomicSync(path.join(dir, 'meta.json'), meta);
    touchSnapshotIndexSync(root, id);
    return publicRunMeta(meta);
  };

  /**
   * Read one run's metadata, searching the project then the global runs dir.
   *
   * @param {string} id
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<Record<string, any> | undefined>}
   */
  const getRun = (id, options = {}) => {
    const dir = locateRunDirSync(id, options.cwd);
    if (dir === undefined) return undefined;
    const meta = readRunMetaSync(dir);
    if (meta === undefined) return undefined;
    const run = publicRunMeta(meta);
    const scriptFile = path.join(dir, 'script.ts');
    if (typeof run.scriptText !== 'string' && existsSync(scriptFile)) {
      try {
        run.scriptText = readFileSync(scriptFile, 'utf8');
      } catch {
        // A missing/unreadable script only affects resume; the run row stays usable.
      }
    }
    return {
      ...run,
      runId: run.id,
      sessionId: run.parentSessionId,
      timeCreated: run.createdAt,
      timeUpdated: run.updatedAt,
      caps: { maxConcurrency: run.maxConcurrency ?? 1 },
      ...(meta.failure_json === undefined ? {} : { failure: meta.failure_json }),
      phases: meta.phases ?? run.phases,
    };
  };

  /**
   * List runs newest first. Synchronous for the engine's `listRuns`; async callers may await it.
   *
   * @param {{ project?: boolean, limit?: number, cwd?: string }} [options]
   * @returns {Record<string, any>[]}
   */
  const listRuns = (options = {}) => {
    const root = resolveRoot(options.cwd);
    const dirs = options.project === false
      ? [projectRunsDir(root), globalRunsDir()]
      : [projectRunsDir(root)];
    /** @type {Map<string, Record<string, any>>} */
    const rows = new Map();
    for (const dir of dirs) {
      const entries = readDirSafeSync(dir);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const runDir = path.join(dir, entry.name);
        const meta = readRunMetaSync(runDir);
        if (meta === undefined || rows.has(entry.name)) continue;
        const run = publicRunMeta(meta);
        const runningElsewhere = run.status === 'running' && typeof run.pid === 'number' && run.pid !== process.pid;
        rows.set(entry.name, {
          // §1.1(1) 摘要字段
          runId: run.id,
          toolCallId: run.toolCallId,
          label: resolveRunLabel(meta, runDir),
          updatedAt: run.updatedAt,
          status: run.status,
          stopReason: run.stopReason,
          resumedFrom: run.resumedFrom,
          supersededBy: run.supersededBy,
          ...(run.failureCode === undefined ? {} : { failureCode: run.failureCode }),
          ...(run.error === undefined ? {} : { failureMessage: run.error }),
          resumable: isResumable(run.status, run.stopReason),
          // 旧调用方（runtime / UI 目录）继续读这些别名
          id: run.id,
          name: run.name,
          createdAt: run.createdAt,
          finishedAt: run.finishedAt,
          cwd: run.cwd ?? root,
          args: run.args,
          labelSource: run.labelSource,
          spentTokens: run.spentTokens,
          parentSessionId: run.parentSessionId,
          sessionId: run.parentSessionId,
          scriptPath: run.scriptPath,
          maxConcurrency: run.maxConcurrency,
          timeCreated: run.createdAt,
          timeUpdated: run.updatedAt,
          possibleInterruption: meta.possibleInterruption === true
            || (runningElsewhere && !isProcessAlive(run.pid)),
        });
      }
    }
    const sorted = [...rows.values()].sort((a, b) => {
      const left = Number(a.createdAt ?? a.finishedAt ?? 0);
      const right = Number(b.createdAt ?? b.finishedAt ?? 0);
      if (right !== left) return right - left;
      return String(a.id).localeCompare(String(b.id));
    });
    const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 0;
    return limit > 0 ? sorted.slice(0, limit) : sorted;
  };

  /**
   * 会话内运行列表（§1.1(1)）：按 `time_updated desc, id desc`，默认 16、上限 64。
   *
   * 等价映射说明：ZCode 按 `parent_session_id` 精确过滤；本插件的历史运行可能没有记录
   * parent_session_id（旧 runtime 未传），此时退回"该项目的全部 run"，避免升级后页面空白。
   *
   * @param {{ parentSessionId?: string, sessionId?: string, limit?: number, cwd?: string }} [options]
   * @returns {Promise<Record<string, any>[]>}
   */
  const listRunsForSession = async (options = {}) => {
    const parentSessionId = options.parentSessionId ?? options.sessionId;
    const rows = await listRuns({ cwd: options.cwd });
    const attributed = parentSessionId === undefined
      ? rows
      : rows.filter((row) => row.parentSessionId === parentSessionId);
    const usable = attributed.length > 0 || parentSessionId === undefined ? attributed : rows;
    const rawLimit = Number.isFinite(options.limit) ? Math.floor(options.limit) : DEFAULT_RUN_PAGE;
    const limit = Math.max(1, Math.min(rawLimit, MAX_RUN_PAGE));
    return [...usable]
      .sort((left, right) => {
        const updated = Number(right.updatedAt ?? right.createdAt ?? 0) - Number(left.updatedAt ?? left.createdAt ?? 0);
        if (updated !== 0) return updated;
        return String(right.id).localeCompare(String(left.id));
      })
      .slice(0, limit);
  };

  /**
   * 读取一条 run 的脚本原文（`dwf_run.script_text` 的等价物）。
   *
   * @param {string} id
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<string | undefined>}
   */
  const readRunScript = (id, options = {}) => {
    const dir = locateRunDirSync(id, options.cwd);
    if (dir === undefined) return undefined;
    const file = path.join(dir, 'script.ts');
    if (existsSync(file)) {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    }
    const meta = readRunMetaSync(dir);
    return typeof meta?.script_text === 'string' ? meta.script_text : undefined;
  };

  /**
   * Patch a run's metadata. Missing runs are a no-op (`undefined` result) rather than a throw.
   *
   * @param {string} id
   * @param {Record<string, any>} patch
   * @param {{ cwd?: string }} [options]
   * @returns {Record<string, any> | undefined}
   */
  const updateRun = (id, patch = {}, options = {}) => {
    const dir = locateRunDirSync(id, options.cwd);
    if (dir === undefined) return undefined;
    const current = readRunMetaSync(dir) ?? normalizeRunMeta({ id }, id);
    const clean = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    const next = applyRunPatch(clean, current, Date.now());
    next.time_updated = Number.isFinite(clean.updatedAt) ? clean.updatedAt : Date.now();
    writeJsonAtomicSync(path.join(dir, 'meta.json'), next);
    return publicRunMeta(next);
  };

  /**
   * 引擎的终态写入（`updateRunStatus`）：只关心 status + stopReason/supersededBy/failure。
   *
   * @param {string} id
   * @param {'completed'|'stopped'|'errored'} status
   * @param {{ stopReason?: string, supersededBy?: string, failure?: Record<string, any> }} [info]
   * @param {{ cwd?: string }} [options]
   */
  const updateRunStatus = (id, status, info = {}, options = {}) => {
    const dir = locateRunDirSync(id, options.cwd);
    if (dir === undefined) return undefined;
    const current = readRunMetaSync(dir) ?? normalizeRunMeta({ id }, id);
    const next = applyRunPatch({
      status,
      ...(info.stopReason === undefined ? {} : { stopReason: info.stopReason }),
      ...(info.supersededBy === undefined ? {} : { supersededBy: info.supersededBy }),
      ...(info.failure === undefined ? {} : { error: info.failure }),
      ...(info.result === undefined ? {} : { result: info.result }),
      finishedAt: Date.now(),
    }, current, Date.now());
    next.time_updated = Date.now();
    if (info.result !== undefined) {
      const serialized = safeJson(info.result);
      if (serialized !== undefined) writeFileAtomicSync(path.join(dir, 'result.json'), `${serialized}\n`);
    }
    writeJsonAtomicSync(path.join(dir, 'meta.json'), next);
    return publicRunMeta(next);
  };

  /**
   * 引擎的 token 计数写入（`updateRunUsage`）。
   *
   * @param {string} id
   * @param {number} spentTokens
   * @param {{ cwd?: string }} [options]
   */
  const updateRunUsage = (id, spentTokens, options = {}) => {
    const dir = locateRunDirSync(id, options.cwd);
    if (dir === undefined) return undefined;
    const current = readRunMetaSync(dir) ?? normalizeRunMeta({ id }, id);
    current.spent_tokens = Number.isFinite(spentTokens) ? spentTokens : current.spent_tokens;
    writeJsonAtomicSync(path.join(dir, 'meta.json'), current);
    return publicRunMeta(current);
  };

  /**
   * Settle a run: patch status/reason/error, write `result.json`, stamp `finishedAt`.
   *
   * @param {string} id
   * @param {{ status?: string, stopReason?: string, error?: unknown, result?: unknown, finishedAt?: number }} outcome
   * @param {{ cwd?: string }} [options]
   * @returns {Record<string, any> | undefined}
   */
  const settleRun = (id, outcome = {}, options = {}) => {
    const dir = locateRunDirSync(id, options.cwd);
    if (dir === undefined) return undefined;
    const finishedAt = Number.isFinite(outcome.finishedAt) ? /** @type {number} */ (outcome.finishedAt) : Date.now();
    /** @type {Record<string, any>} */
    const patch = { finishedAt, updatedAt: finishedAt };
    if (outcome.status !== undefined) patch.status = outcome.status;
    if (outcome.stopReason !== undefined) patch.stopReason = outcome.stopReason;
    if (outcome.error !== undefined) patch.error = outcome.error;
    if (outcome.result !== undefined) {
      const serialized = safeJson(outcome.result);
      if (serialized !== undefined) {
        writeFileAtomicSync(path.join(dir, 'result.json'), `${serialized}\n`);
        patch.result = outcome.result;
      }
    }
    const current = readRunMetaSync(dir) ?? normalizeRunMeta({ id }, id);
    const next = applyRunPatch(patch, current, finishedAt);
    next.time_updated = finishedAt;
    writeJsonAtomicSync(path.join(dir, 'meta.json'), next);
    return publicRunMeta(next);
  };

  /**
   * Append one event to the run journal (`dwf_event`), then refresh the run row's watermark.
   *
   * Synchronous: the engine calls `record()` → `appendEvent()` without awaiting, and a rejected
   * promise there would be an unhandled rejection instead of a logged storage failure. Storage
   * errors still return `undefined`; the engine treats the journal as best-effort telemetry.
   *
   * @param {string} id
   * @param {Record<string, any>} event
   * @param {{ cwd?: string }} [options]
   * @returns {Record<string, any> | undefined} the stored row
   */
  const appendEvent = (id, event, options = {}) => {
    try {
      const root = resolveRoot(options.cwd);
      const dir = locateRunDirSync(id, options.cwd) ?? path.join(projectRunsDir(root), id);
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'journal.jsonl');
      const rows = readJournalRowsFromFile(file);
      const sequence = rows.length === 0 ? 0 : Math.max(rows[rows.length - 1].sequence + 1, rows.length);
      const { sequence: _ignoredSequence, ...rest } = event ?? {};
      const payload = { ...rest };
      const type = typeof payload.type === 'string' && payload.type !== '' ? payload.type : 'log';
      const timeCreated = Number.isFinite(payload.at)
        ? /** @type {number} */ (payload.at)
        : (Number.isFinite(payload.time_created) ? /** @type {number} */ (payload.time_created) : Date.now());
      const row = { sequence, type, payload, time_created: timeCreated };
      appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');

      const meta = readRunMetaSync(dir);
      if (meta !== undefined) {
        meta.last_event_sequence = sequence;
        meta.time_updated = timeCreated;
        if (payload.type === 'usage-updated' && typeof payload.spentTokens === 'number') {
          meta.spent_tokens = payload.spentTokens;
        }
        if (payload.type === 'run-settled' && typeof payload.status === 'string') {
          meta.workflow_state = payload.status;
          meta.status = toDbStatus(payload.status);
          if (typeof payload.stopReason === 'string') meta.stop_reason = payload.stopReason;
          if (typeof payload.supersededBy === 'string') meta.superseded_by = payload.supersededBy;
          if (payload.error !== null && typeof payload.error === 'object' && typeof payload.error.message === 'string') {
            meta.failure_json = {
              ...(typeof payload.error.code === 'string' ? { code: payload.error.code.slice(0, 64) } : {}),
              message: payload.error.message.slice(0, 2048),
            };
          }
        }
        writeJsonAtomicSync(path.join(dir, 'meta.json'), meta);
        touchSnapshotIndexSync(root, id);
      }
      return row;
    } catch {
      return undefined;
    }
  };

  /**
   * Read the run journal, flattened to `{...payload, sequence, type, at}`.
   *
   * @param {string} id
   * @param {{ cwd?: string }} [options]
   * @returns {Record<string, any>[]}
   */
  const readEvents = (id, options = {}) => {
    const dir = locateRunDirSync(id, options.cwd);
    if (dir === undefined) return [];
    return readJournalRowsFromFile(path.join(dir, 'journal.jsonl')).map(flattenJournalRow);
  };

  /**
   * `workflowRunEvents` 的分页读取（§1.1(2) / §2.5）。
   *
   * @param {string} id
   * @param {{ cwd?: string, afterSequence?: unknown, limit?: unknown, maxBytes?: number }} [options]
   * @returns {{ events: Record<string, any>[], hasMore: boolean, lastEventSequence: number }}
   */
  const readEventPage = (id, options = {}) => {
    const dir = locateRunDirSync(id, options.cwd);
    if (dir === undefined) return { events: [], hasMore: false, lastEventSequence: 0 };
    const rows = readJournalRowsFromFile(path.join(dir, 'journal.jsonl'));
    const page = pageEvents(rows, {
      afterSequence: options.afterSequence,
      limit: options.limit,
      maxBytes: options.maxBytes,
    });
    const watermark = rows.length === 0 ? 0 : rows[rows.length - 1].sequence;
    return {
      events: page.events.map((row) => ({ sequence: row.sequence, type: row.type, payload: row.payload })),
      hasMore: page.hasMore,
      lastEventSequence: Math.max(watermark, page.lastEventSequence),
    };
  };

  /**
   * 引擎 `listEvents`：返回 `{sequence, event, timeCreated}` 信封（runtime getRun/eventsAfter 读 `event.event`）。
   *
   * @param {string} id
   * @param {{ cwd?: string, types?: 'all'|string[], afterSequence?: number, limit?: number, reportItems?: object }} [options]
   * @returns {{ sequence: number, type: string, event: Record<string, any>, timeCreated: number }[]}
   */
  const listEvents = (id, options = {}) => {
    const dir = locateRunDirSync(id, options.cwd);
    if (dir === undefined) return [];
    let rows = readJournalRowsFromFile(path.join(dir, 'journal.jsonl'));
    if (Array.isArray(options.types)) {
      const allowed = new Set(options.types);
      rows = rows.filter((row) => allowed.has(row.type));
    }
    if (Number.isInteger(options.afterSequence)) {
      rows = rows.filter((row) => row.sequence > options.afterSequence);
    }
    if (Number.isInteger(options.limit) && options.limit >= 0) rows = rows.slice(0, options.limit);
    return rows.map((row) => ({
      sequence: row.sequence,
      type: row.type,
      event: flattenJournalRow(row),
      timeCreated: row.time_created,
    }));
  };

  /**
   * 折叠一条 run 的事件流，得到 §3.1 的 `Im` 快照。
   *
   * @param {string} id
   * @param {{ cwd?: string }} [options]
   * @returns {Record<string, any> | undefined}
   */
  const projectRun = (id, options = {}) => {
    const dir = locateRunDirSync(id, options.cwd);
    if (dir === undefined) return undefined;
    const meta = readRunMetaSync(dir);
    if (meta === undefined) return undefined;
    const run = publicRunMeta(meta);
    const rows = readJournalRowsFromFile(path.join(dir, 'journal.jsonl'));
    const lastEventSequence = Number.isInteger(meta.last_event_sequence)
      ? Math.max(meta.last_event_sequence, rows.length === 0 ? 0 : rows[rows.length - 1].sequence)
      : (rows.length === 0 ? 0 : rows[rows.length - 1].sequence);
    const seed = {
      runId: run.id,
      ...(run.toolCallId === undefined ? {} : { toolCallId: run.toolCallId }),
      status: run.status,
      ...(run.subagentModel === undefined ? {} : { subagentModel: run.subagentModel }),
      ...(run.resumedFrom === undefined ? {} : { resumedFrom: run.resumedFrom }),
      ...(run.supersededBy === undefined ? {} : { supersededBy: run.supersededBy }),
      ...(run.result === undefined
        ? {}
        : {
          resultPreview: (typeof run.result === 'string' ? run.result : (safeJson(run.result) ?? ''))
            .slice(0, 2048),
        }),
      ...(Array.isArray(meta.phases) && meta.phases.length > 0
        ? {
          phaseNames: meta.phases
            .filter((name) => typeof name === 'string' && name !== '')
            .slice(0, 32)
            .map((name) => name.slice(0, 128)),
        }
        : {}),
      lastEventSequence,
      lastEventSequenceUnknown: false,
    };
    let snapshot = projectRunEvents(rows, seed);
    // 旧 runtime 没有 run-settled 事件：终态以 run 表为准，否则快照会永远停在 running。
    if (EVENT_TERMINAL.has(run.status) && !rows.some((row) => row.type === 'run-settled')) {
      snapshot = {
        ...snapshot,
        status: run.status,
        ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
        ...(run.error === undefined ? {} : { error: run.error }),
        ...(run.resumedFrom === undefined ? {} : { resumedFrom: run.resumedFrom }),
        ...(run.supersededBy === undefined ? {} : { supersededBy: run.supersededBy }),
      };
    }
    snapshot.lastEventSequence = Math.max(snapshot.lastEventSequence, lastEventSequence);
    return snapshot;
  };

  /**
   * 会话快照容器（§3.2 `Lm`）：`{revision, runs}`，按到达顺序最多 8 条。
   *
   * @param {{ cwd?: string, limit?: number }} [options]
   * @returns {Promise<{ revision: number, runs: Record<string, any>[] }>}
   */
  const listRunSnapshots = async (options = {}) => {
    const root = resolveRoot(options.cwd);
    const index = await readSnapshotIndex(root);
    const max = Math.max(1, Math.min(options.limit ?? MAX_RUNS_PER_SNAPSHOT, MAX_RUNS_PER_SNAPSHOT));
    let ids = index.runs.slice(index.runs.length - max);
    if (ids.length === 0) {
      // 没有索引（旧数据）时按更新时间取最近的 run，再翻成"旧 → 新"。
      const rows = await listRuns({ cwd: root, limit: max });
      ids = rows.map((row) => row.id).reverse();
    }
    const runs = [];
    for (const id of ids) {
      const snapshot = await projectRun(id, { cwd: root });
      if (snapshot !== undefined) runs.push(snapshot);
    }
    return { revision: index.revision, runs };
  };

  /* ------------------------------- actors / nodes -------------------------------------------- */

  /** @param {string} file @returns {Record<string, any>[]} */
  const readRowArraySync = (file) => {
    const raw = readJsonSync(file);
    if (raw !== undefined && Array.isArray(raw.rows)) {
      return raw.rows.filter((row) => row !== null && typeof row === 'object');
    }
    return Array.isArray(raw) ? raw.filter((row) => row !== null && typeof row === 'object') : [];
  };

  /**
   * Public actor row: §4 snake_case storage plus the camelCase aliases the engine reads.
   *
   * @param {Record<string, any>} row
   * @param {{ withPersona?: boolean }} [options]
   */
  const publicActor = (row, options = {}) => ({
    ...row,
    runId: row.run_id,
    siteId: row.site_id,
    resolvedModel: row.resolved_model,
    sessionId: row.session_id,
    ...(options.withPersona === false || row.persona_json === undefined ? {} : { persona: row.persona_json }),
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  });

  /**
   * Upsert one `dwf_actor` row (engine `putActor`). Keyed by run + siteId + ordinal.
   *
   * @param {Record<string, any>} actor
   * @param {{ cwd?: string }} [options]
   * @returns {Record<string, any> | undefined}
   */
  const putActor = (actor = {}, options = {}) => {
    const runId = actor.runId ?? actor.run_id;
    const dir = locateRunDirSync(runId, options.cwd);
    if (dir === undefined) return undefined;
    if (typeof actor.siteId !== 'string' || actor.siteId === '' || !Number.isInteger(actor.ordinal)) {
      throw new Error('putActor requires siteId and an integer ordinal');
    }
    const file = path.join(dir, 'actors.json');
    const rows = readRowArraySync(file);
    const index = rows.findIndex((row) => row.site_id === actor.siteId && row.ordinal === actor.ordinal);
    const now = Date.now();
    const previous = index >= 0 ? rows[index] : undefined;
    const entry = {
      ...previous,
      id: previous?.id ?? rows.length + 1,
      run_id: runId,
      site_id: actor.siteId,
      ordinal: actor.ordinal,
      ...(actor.name === undefined ? {} : { name: actor.name }),
      ...(actor.persona === undefined ? {} : { persona_json: actor.persona }),
      ...(actor.resolvedModel === undefined && actor.model === undefined
        ? {}
        : { resolved_model: actor.resolvedModel ?? actor.model }),
      ...(actor.sessionId === undefined ? {} : { session_id: actor.sessionId }),
      status: actor.status ?? previous?.status ?? 'waiting',
      time_created: previous?.time_created ?? now,
      time_updated: now,
    };
    if (index >= 0) rows[index] = entry;
    else rows.push(entry);
    writeJsonAtomicSync(file, rows);
    return publicActor(entry);
  };

  /**
   * Legacy alias used by the UI/test layer; synchronous and await-compatible.
   *
   * @param {string} runId
   * @param {Record<string, any>} actor
   * @param {{ cwd?: string }} [options]
   */
  const recordActor = (runId, actor = {}, options = {}) => {
    const dir = locateRunDirSync(runId, options.cwd);
    if (dir === undefined) return undefined;
    return putActor({ ...actor, runId }, { cwd: options.cwd });
  };

  /**
   * @param {string} runId
   * @param {string} siteId
   * @param {number} ordinal
   * @param {{ cwd?: string, withPersona?: boolean }} [options]
   */
  const getActor = (runId, siteId, ordinal, options = {}) => {
    const dir = locateRunDirSync(runId, options.cwd);
    if (dir === undefined) return undefined;
    const row = readRowArraySync(path.join(dir, 'actors.json'))
      .find((candidate) => candidate.site_id === siteId && candidate.ordinal === ordinal);
    return row === undefined ? undefined : publicActor(row, options);
  };

  /**
   * @param {string} runId
   * @param {{ cwd?: string, withPersona?: boolean }} [options]
   * @returns {Record<string, any>[]}
   */
  const listActors = (runId, options = {}) => {
    const dir = locateRunDirSync(runId, options.cwd);
    if (dir === undefined) return [];
    return readRowArraySync(path.join(dir, 'actors.json')).map((row) => publicActor(row, options));
  };

  /** @param {Record<string, any>} row */
  function publicNode(row) {
    return {
      ...row,
      runId: row.run_id,
      siteId: row.site_id,
      actorSiteId: row.actor_site_id,
      actorOrdinal: row.actor_ordinal,
      inputHash: row.input_hash,
      artifactId: row.artifact_id,
      messageBoundary: row.message_boundary,
      phase: row.phase ?? (row.status === 'running' ? 'executing' : 'settled'),
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
    };
  }

  /**
   * Upsert one `dwf_node` row (engine `putNode`). Keyed by run + siteId + ordinal.
   *
   * @param {Record<string, any>} node
   * @param {{ cwd?: string }} [options]
   * @returns {Record<string, any> | undefined}
   */
  const putNode = (node = {}, options = {}) => {
    const runId = node.runId ?? node.run_id;
    const dir = locateRunDirSync(runId, options.cwd);
    if (dir === undefined) return undefined;
    if (typeof node.siteId !== 'string' || node.siteId === '' || !Number.isInteger(node.ordinal)) {
      throw new Error('putNode requires siteId and an integer ordinal');
    }
    const kind = ['ask', 'world-read', 'world-run', 'report', 'artifact'].includes(node.kind) ? node.kind : 'ask';
    const status = ['running', 'completed', 'failed'].includes(node.status) ? node.status : 'running';
    const file = path.join(dir, 'nodes.json');
    const rows = readRowArraySync(file);
    const index = rows.findIndex((row) => row.site_id === node.siteId && row.ordinal === node.ordinal);
    const now = Date.now();
    const previous = index >= 0 ? rows[index] : undefined;
    const input = kind === 'world-read' || kind === 'world-run' ? boundWorldInput(node.input) : node.input;
    const entry = {
      ...previous,
      id: previous?.id ?? rows.length + 1,
      run_id: runId,
      site_id: node.siteId,
      ordinal: node.ordinal,
      kind,
      ...(node.actorSiteId === undefined ? {} : { actor_site_id: node.actorSiteId }),
      ...(node.actorOrdinal === undefined ? {} : { actor_ordinal: node.actorOrdinal }),
      ...(node.actorSeq === undefined ? {} : { actor_seq: node.actorSeq }),
      input_hash: node.inputHash ?? previous?.input_hash ?? sha256Hex(safeJson(input) ?? ''),
      ...(input === undefined ? {} : { input }),
      status,
      ...(node.phase === undefined ? {} : { phase: node.phase }),
      ...(node.outcome === undefined ? {} : { outcome: node.outcome }),
      ...(node.result === undefined ? {} : { result: node.result }),
      ...(node.error === undefined ? {} : { error: node.error }),
      ...(node.stats === undefined ? {} : { stats: node.stats }),
      ...(node.messageBoundary === undefined ? {} : { message_boundary: node.messageBoundary }),
      ...(node.artifactId === undefined ? {} : { artifact_id: node.artifactId }),
      time_created: previous?.time_created ?? now,
      time_updated: now,
    };
    if (index >= 0) rows[index] = entry;
    else rows.push(entry);
    writeJsonAtomicSync(file, rows);
    return publicNode(entry);
  };

  /**
   * Legacy alias used by the UI/test layer; synchronous and await-compatible.
   *
   * @param {string} runId
   * @param {Record<string, any>} node
   * @param {{ cwd?: string }} [options]
   */
  const recordNode = (runId, node = {}, options = {}) => {
    const dir = locateRunDirSync(runId, options.cwd);
    if (dir === undefined) return undefined;
    return putNode({ ...node, runId }, { cwd: options.cwd });
  };

  /**
   * @param {string} runId
   * @param {string} siteId
   * @param {number} ordinal
   * @param {{ cwd?: string, withResult?: boolean }} [options]
   */
  const getNode = (runId, siteId, ordinal, options = {}) => {
    const dir = locateRunDirSync(runId, options.cwd);
    if (dir === undefined) return undefined;
    const row = readRowArraySync(path.join(dir, 'nodes.json'))
      .find((candidate) => candidate.site_id === siteId && candidate.ordinal === ordinal);
    if (row === undefined) return undefined;
    const node = publicNode(row);
    if (options.withResult === false) delete node.result;
    return node;
  };

  /**
   * @param {string} runId
   * @param {{ cwd?: string, kinds?: string[], withResult?: boolean, limit?: number }} [options]
   * @returns {Record<string, any>[]}
   */
  const listNodes = (runId, options = {}) => {
    const dir = locateRunDirSync(runId, options.cwd);
    if (dir === undefined) return [];
    let rows = readRowArraySync(path.join(dir, 'nodes.json'));
    if (Array.isArray(options.kinds)) {
      const allowed = new Set(options.kinds);
      rows = rows.filter((row) => allowed.has(row.kind));
    }
    if (Number.isInteger(options.limit) && options.limit >= 0) rows = rows.slice(0, options.limit);
    return rows.map((row) => {
      const node = publicNode(row);
      if (options.withResult === false) delete node.result;
      return node;
    });
  };

  /**
   * @param {string} runId
   * @param {string} kind
   * @param {{ cwd?: string }} [options]
   * @returns {number}
   */
  const countNodes = (runId, kind, options = {}) => {
    const dir = locateRunDirSync(runId, options.cwd);
    if (dir === undefined) return 0;
    return readRowArraySync(path.join(dir, 'nodes.json')).filter((row) => row.kind === kind).length;
  };

  /**
   * @param {string} runId
   * @param {string} kind
   * @param {{ cwd?: string }} [options]
   * @returns {number}
   */
  const sumResultBytes = (runId, kind, options = {}) => {
    const dir = locateRunDirSync(runId, options.cwd);
    if (dir === undefined) return 0;
    let total = 0;
    for (const row of readRowArraySync(path.join(dir, 'nodes.json'))) {
      if (row.kind !== kind || row.result === undefined) continue;
      total += Buffer.byteLength(safeJson(row.result) ?? 'null', 'utf8');
    }
    return total;
  };

  /**
   * `workflowRunWorkspace` 的等价查询：只取 world-read/world-run，映射成 §9 台账行。
   *
   * @param {string} runId
   * @param {{ cwd?: string, limit?: number }} [options]
   * @returns {{ nodes: Record<string, any>[], truncated: boolean }}
   */
  const listWorldNodes = (runId, options = {}) => {
    const rows = listNodes(runId, { ...options, withResult: true });
    const world = rows
      .filter((row) => row.kind === 'world-read' || row.kind === 'world-run')
      .map((row) => ({
        siteId: row.siteId,
        ordinal: row.ordinal,
        kind: row.kind,
        ...(row.input === undefined ? {} : {
          ...(typeof row.input.op === 'string' ? { op: row.input.op } : {}),
          ...(Array.isArray(row.input.args) ? { args: row.input.args } : {}),
          ...(row.input.truncated === true ? { inputTruncated: true } : {}),
        }),
        status: row.status,
        ...(row.error === undefined ? {} : {
          error: {
            code: typeof row.error.code === 'string' ? row.error.code.slice(0, 64) : 'error',
            message: typeof row.error.message === 'string' ? row.error.message.slice(0, 2000) : '',
          },
        }),
        ...(row.status === 'completed' ? (() => {
          const serialized = safeJson(row.result ?? null) ?? 'null';
          const summary = { resultBytes: Buffer.byteLength(serialized, 'utf8') };
          if (Array.isArray(row.result)) summary.resultCount = row.result.length;
          if (row.result !== null && typeof row.result === 'object' && !Array.isArray(row.result)) {
            if (Number.isInteger(row.result.exitCode)) summary.exitCode = row.result.exitCode;
            if (typeof row.result.stdout === 'string') summary.stdoutBytes = Buffer.byteLength(row.result.stdout, 'utf8');
            if (typeof row.result.stderr === 'string') summary.stderrBytes = Buffer.byteLength(row.result.stderr, 'utf8');
          }
          return { summary };
        })() : {}),
        createdAt: row.timeCreated ?? 0,
        updatedAt: row.timeUpdated ?? row.timeCreated ?? 0,
      }));
    const max = 2000;
    const nodes = world.slice(0, max);
    return { nodes, truncated: world.length > max };
  };

  /* ------------------------------- artifacts ------------------------------------------------- */

  /**
   * Read the raw artifact manifest document for a run.
   *
   * @param {string} runId
   * @returns {Promise<{ artifacts: Record<string, any>[] }>}
   */
  const readManifestDoc = async (runId) => {
    const dir = await locateRunDir(runId);
    if (dir === undefined) return { artifacts: [] };
    const raw = await readJson(path.join(dir, 'artifacts', 'manifest.json'));
    if (Array.isArray(raw)) return { artifacts: raw.filter((row) => row !== null && typeof row === 'object') };
    if (raw !== null && typeof raw === 'object' && Array.isArray(raw.artifacts)) {
      return { artifacts: raw.artifacts.filter((row) => row !== null && typeof row === 'object') };
    }
    return { artifacts: [] };
  };

  /**
   * Read the artifact manifest rows, newest version last per artifact.
   *
   * @param {string} runId
   * @returns {Promise<Record<string, any>[]>}
   */
  const readArtifactManifest = async (runId) => (await readManifestDoc(runId)).artifacts;

  /**
   * Absolute path of a previously published artifact payload.
   *
   * @param {string} runId
   * @param {string} artifactId
   * @param {number} version
   * @returns {Promise<string | undefined>}
   */
  const artifactFilePath = async (runId, artifactId, version) => {
    const dir = await locateRunDir(runId);
    if (dir === undefined) return undefined;
    const record = (await readArtifactManifest(runId)).find(
      (row) => row.id === artifactId && Number(row.version) === Number(version),
    );
    if (record === undefined) return undefined;
    if (typeof record.file === 'string' && record.file !== '') {
      const file = path.join(dir, ...record.file.split('/'));
      return (await exists(file)) ? file : undefined;
    }
    return undefined;
  };

  /**
   * Publish one artifact version. File bytes are copied, text/spec/items payloads are written as
   * files; the manifest is merged atomically.
   *
   * @param {string} runId
   * @param {{ id: string, kind: string, version?: number, title?: string, description?: string,
   *   primary?: boolean, contentType?: string, sourcePath?: string, text?: string,
   *   spec?: unknown, items?: unknown[] }} artifact
   * @returns {Promise<Record<string, any>>} the manifest record
   */
  const publishArtifact = async (runId, artifact = /** @type {any} */ ({})) => {
    const runDir = await locateRunDir(runId);
    if (runDir === undefined) throw new Error(`unknown run "${runId}"`);
    const artifactId = typeof artifact.id === 'string' && artifact.id !== '' ? artifact.id : 'artifact';
    const idSegment = safeSegment(artifactId, 'artifact');
    const kind = ARTIFACT_KINDS.has(artifact.kind) ? artifact.kind : 'file';
    const version = Number.isFinite(artifact.version) && artifact.version > 0 ? Math.floor(artifact.version) : 1;

    // §4.4 保留策略：每 run ≤32 个 artifact id，每 id ≤16 个版本。超限必须报错而不是静默丢弃，
    // 否则脚本会以为自己发布了产物。
    const existing = await readArtifactManifest(runId);
    const versionsForId = existing.filter((row) => row.id === artifactId);
    const distinctIds = new Set(existing.map((row) => row.id));
    if (!distinctIds.has(artifactId) && distinctIds.size >= MAX_ARTIFACTS_PER_RUN) {
      const error = new Error(`artifact cap exceeded: run "${runId}" already has ${MAX_ARTIFACTS_PER_RUN} artifacts`);
      error.name = 'ArtifactCapExceeded';
      throw error;
    }
    if (!versionsForId.some((row) => Number(row.version) === version) && versionsForId.length >= MAX_ARTIFACT_VERSIONS) {
      const error = new Error(`artifact version cap exceeded: "${artifactId}" already has ${MAX_ARTIFACT_VERSIONS} versions`);
      error.name = 'ArtifactVersionCapExceeded';
      throw error;
    }

    const versionDir = path.join(runDir, 'artifacts', idSegment, `v${version}`);
    await fsp.mkdir(versionDir, { recursive: true });
    const now = Date.now();

    /** @type {Record<string, any>} */
    const record = {
      id: artifactId,
      kind,
      version,
      ...(artifact.title === undefined ? {} : { title: artifact.title }),
      ...(artifact.description === undefined ? {} : { description: artifact.description }),
      ...(artifact.primary === true ? { primary: true } : {}),
      ...(artifact.sourcePath === undefined ? {} : { sourcePath: artifact.sourcePath }),
      contentType: artifact.contentType ?? inferContentType(kind, artifact.sourcePath),
      createdAt: now,
      // §7.1 的版本行字段：uri/publishedAt 与 dwf_node.result_json 对齐。
      publishedAt: now,
    };

    if (typeof artifact.sourcePath === 'string' && artifact.sourcePath !== '') {
      const source = path.resolve(runDir, artifact.sourcePath);
      const baseName = path.basename(source) || 'artifact.bin';
      const target = path.join(versionDir, baseName);
      await fsp.copyFile(source, target);
      const stat = await fsp.stat(target).catch(() => undefined);
      record.file = `artifacts/${idSegment}/v${version}/${baseName}`;
      record.uri = record.file;
      record.bytes = stat?.size ?? 0;
    } else if (typeof artifact.text === 'string') {
      const fileName = `${artifactFileName(artifact.title, artifactId, record.contentType)}`;
      const target = path.join(versionDir, fileName);
      await writeFileAtomic(target, artifact.text);
      const stat = await fsp.stat(target).catch(() => undefined);
      record.file = `artifacts/${idSegment}/v${version}/${fileName}`;
      record.uri = record.file;
      record.bytes = stat?.size ?? Buffer.byteLength(artifact.text, 'utf8');
      if (artifact.text.length <= 100_000) record.text = artifact.text;
    }

    if (artifact.spec !== undefined) {
      const target = path.join(versionDir, 'spec.json');
      await writeJsonAtomic(target, artifact.spec);
      record.spec = artifact.spec;
      record.specFile = `artifacts/${idSegment}/v${version}/spec.json`;
      record.uri = record.uri ?? record.specFile;
      if (record.bytes === undefined) record.bytes = (await fsp.stat(target).catch(() => undefined))?.size ?? 0;
    }

    if (Array.isArray(artifact.items)) {
      const target = path.join(versionDir, 'items.json');
      await writeJsonAtomic(target, artifact.items);
      record.itemsFile = `artifacts/${idSegment}/v${version}/items.json`;
      record.uri = record.uri ?? record.itemsFile;
      record.itemCount = artifact.items.length;
      if (record.bytes === undefined) record.bytes = (await fsp.stat(target).catch(() => undefined))?.size ?? 0;
    }

    const doc = await readManifestDoc(runId);
    const kept = doc.artifacts.filter((row) => !(row.id === artifactId && Number(row.version) === version));
    kept.push(record);
    kept.sort((left, right) => String(left.id).localeCompare(String(right.id)) || Number(left.version) - Number(right.version));
    await writeJsonAtomic(path.join(runDir, 'artifacts', 'manifest.json'), {
      runId,
      updatedAt: now,
      artifacts: kept,
    });
    return record;
  };

  /**
   * `workflowRunArtifacts` 的等价投影（§1.1(3)）：按 artifact id 分组，附版本明细。
   *
   * `itemCount` 来自 `type='report'` 且 `artifactId` 指向该 id 的事件条数（§4.3）。
   *
   * @param {string} runId
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<Record<string, any>[]>}
   */
  const listArtifacts = async (runId, options = {}) => {
    const rows = await readArtifactManifest(runId);
    const events = await readEvents(runId, options);
    /** @type {Map<string, number>} */
    const itemCounts = new Map();
    for (const event of events) {
      if (event.type !== 'report') continue;
      const artifactId = typeof event.artifactId === 'string' ? event.artifactId : undefined;
      if (artifactId === undefined) continue;
      itemCounts.set(artifactId, (itemCounts.get(artifactId) ?? 0) + 1);
    }
    /** @type {Map<string, Record<string, any>[]>} */
    const groups = new Map();
    /** @type {Set<string>} */
    const seen = new Set();
    for (const row of rows) {
      const id = typeof row.id === 'string' ? row.id : undefined;
      if (id === undefined) continue;
      const list = groups.get(id) ?? [];
      if (!list.some((candidate) => Number(candidate.version) === Number(row.version))) {
        list.push(row);
        seen.add(`${id}@${Number(row.version)}`);
      }
      groups.set(id, list);
    }
    // 新版引擎把 artifact 声明/发布同时写进 dwf_node(kind='artifact')；preset
    // （chart/table/metrics/board）只有这张表，没有二进制 manifest 行。两边按 id@version 去重合并。
    for (const node of listNodes(runId, { ...options, kinds: ['artifact'], withResult: true })) {
      const result = node.result;
      if (result === null || typeof result !== 'object' || typeof result.id !== 'string') continue;
      const version = Number.isInteger(result.version) ? result.version : 1;
      const key = `${result.id}@${version}`;
      if (seen.has(key)) continue;
      const fake = {
        id: result.id,
        kind: result.kind,
        version,
        ...(result.title === undefined ? {} : { title: result.title }),
        ...(result.description === undefined ? {} : { description: result.description }),
        ...(result.primary === true ? { primary: true } : {}),
        ...(result.spec === undefined ? {} : { spec: result.spec }),
        contentType: result.contentType ?? inferContentType(result.kind, undefined),
        publishedAt: node.timeCreated ?? 0,
      };
      const list = groups.get(result.id) ?? [];
      list.push(fake);
      seen.add(key);
      groups.set(result.id, list);
    }
    const artifacts = [];
    for (const [id, versions] of groups) {
      versions.sort((left, right) => Number(left.version) - Number(right.version));
      const latest = versions[versions.length - 1];
      const primary = versions.some((row) => row.primary === true);
      artifacts.push({
        id,
        kind: latest.kind,
        ...(latest.title === undefined ? {} : { title: latest.title }),
        ...(latest.description === undefined ? {} : { description: latest.description }),
        ...(latest.contentType === undefined ? {} : { contentType: latest.contentType }),
        ...(latest.sourcePath === undefined ? {} : { sourcePath: latest.sourcePath }),
        ...(latest.spec === undefined ? {} : { spec: latest.spec }),
        version: Number(latest.version),
        versions: versions.map((row) => ({
          version: Number(row.version),
          ...(row.title === undefined ? {} : { title: row.title }),
          ...(row.description === undefined ? {} : { description: row.description }),
          ...(row.contentType === undefined ? {} : { contentType: row.contentType }),
          ...(row.bytes === undefined ? {} : { bytes: row.bytes }),
          ...(row.uri === undefined ? {} : { uri: row.uri }),
          ...(row.sourcePath === undefined ? {} : { sourcePath: row.sourcePath }),
          ...(row.spec === undefined ? {} : { spec: row.spec }),
          publishedAt: row.publishedAt ?? row.createdAt ?? 0,
          ...(row.primary === true ? { primary: true } : {}),
        })),
        itemCount: itemCounts.get(id) ?? (latest.itemCount ?? 0),
        ...(primary ? { primary: true } : {}),
      });
    }
    // primary 优先（§1.1(3) 的排序），其余按 id 稳定。
    artifacts.sort((left, right) => {
      const primaryDelta = Number(right.primary === true) - Number(left.primary === true);
      if (primaryDelta !== 0) return primaryDelta;
      return String(left.id).localeCompare(String(right.id));
    });
    return artifacts.slice(0, MAX_ARTIFACTS_PER_RUN);
  };

  /**
   * 读取某个 artifact 版本的完整字节（§7.1/§7.2），供 base64 分片路由使用。
   *
   * @param {string} runId
   * @param {string} artifactId
   * @param {number | string} version
   * @returns {Promise<{ bytes: Buffer, mediaType: string, totalBytes: number, record: Record<string, any> } | undefined>}
   */
  const readArtifactPayload = async (runId, artifactId, version) => {
    const runDir = await locateRunDir(runId);
    if (runDir === undefined) return undefined;
    let record = (await readArtifactManifest(runId)).find(
      (row) => row.id === artifactId && Number(row.version) === Number(version),
    );
    if (record === undefined) {
      // preset artifact：没有二进制载荷，内容就是节点 result 里的 spec。
      const node = listNodes(runId, { kinds: ['artifact'], withResult: true })
        .find((candidate) => candidate.result?.id === artifactId
          && (Number.isInteger(candidate.result?.version) ? candidate.result.version : 1) === Number(version));
      if (node?.result?.spec !== undefined) {
        return {
          bytes: Buffer.from(JSON.stringify(node.result.spec), 'utf8'),
          mediaType: 'application/json',
          totalBytes: Buffer.byteLength(JSON.stringify(node.result.spec), 'utf8'),
          record: node.result,
        };
      }
      return undefined;
    }
    const mediaType = typeof record.contentType === 'string' && record.contentType !== ''
      ? record.contentType
      : 'application/octet-stream';
    let bytes;
    if (typeof record.file === 'string' && record.file !== '') {
      const file = path.join(runDir, ...record.file.split('/'));
      bytes = await fsp.readFile(file).catch(() => undefined);
    }
    if (bytes === undefined && typeof record.text === 'string') bytes = Buffer.from(record.text, 'utf8');
    if (bytes === undefined && record.spec !== undefined) bytes = Buffer.from(JSON.stringify(record.spec), 'utf8');
    if (bytes === undefined && typeof record.itemsFile === 'string') {
      const file = path.join(runDir, ...record.itemsFile.split('/'));
      bytes = await fsp.readFile(file).catch(() => undefined);
    }
    if (bytes === undefined) return undefined;
    return { bytes, mediaType, totalBytes: bytes.byteLength, record };
  };

  /* ------------------------------- drafts ---------------------------------------------------- */

  /**
   * Write an inline script draft under `<cwd>/.dsh/workflow-drafts/`, uniquifying with `-2`, `-3`, …
   *
   * @param {string} name draft label
   * @param {string} code script text
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<string>} absolute draft path
   */
  const writeDraft = async (name, code, options = {}) => {
    const root = resolveRoot(options.cwd);
    const dir = path.join(root, DRAFT_DIR);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '.gitignore'), `${DRAFT_GITIGNORE}\n`, { flag: 'wx' }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });

    const base = sanitizeDraftName(name);
    let candidate = path.join(dir, `${base}${SAVED_EXTENSION}`);
    for (let index = 2; index <= 999 && (await exists(candidate)); index += 1) {
      candidate = path.join(dir, `${base}-${index}${SAVED_EXTENSION}`);
    }
    if (await exists(candidate)) candidate = path.join(dir, `${base}-${Date.now()}${SAVED_EXTENSION}`);
    await writeFileAtomic(candidate, String(code ?? ''));
    return candidate;
  };

  /* ------------------------------- saved workflows ------------------------------------------- */

  /**
   * List saved workflows from project + global archives, `.dsh` before `.zcode`, project before
   * global. The returned value is an array (so `entries.length` / `.map` work) that also exposes
   * `.entries` (itself) and `.invalid`.
   *
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<Record<string, any>[]>}
   */
  const listSavedWorkflows = async (options = {}) => {
    const root = resolveRoot(options.cwd);
    /** @type {Record<string, any>[]} */
    const entries = [];
    /** @type {{ path: string, reason: string }[]} */
    const invalid = [];
    const seen = new Set();

    for (const { scope, dir } of savedRoots(root, options.scope)) {
      for (const dirent of await readDirSafe(dir)) {
        if (!dirent.isFile() || !dirent.name.endsWith(SAVED_EXTENSION)) continue;
        const file = path.join(dir, dirent.name);
        const name = dirent.name.slice(0, -SAVED_EXTENSION.length);
        const nameCheck = validateSavedWorkflowName(name);
        if (!nameCheck.ok) {
          invalid.push({ path: file, reason: 'file name is not a usable workflow name' });
          continue;
        }
        if (seen.has(name)) continue;
        const text = await readTextSafe(file);
        if (text === undefined) {
          invalid.push({ path: file, reason: 'file could not be read' });
          continue;
        }
        const parsed = parseSavedWorkflowFile(text);
        if (!parsed.ok) {
          invalid.push({ path: file, reason: `${parsed.reason}: ${parsed.detail}` });
          continue;
        }
        seen.add(name);
        entries.push(savedEntry(name, scope, file, parsed));
      }
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    /** @type {any} */
    const result = entries;
    result.entries = entries;
    result.invalid = invalid;
    return result;
  };

  /**
   * Resolve one saved workflow by name and optional scope.
   *
   * @param {string} name
   * @param {{ scope?: 'project'|'global', cwd?: string }} [options]
   * @returns {Promise<Record<string, any> | undefined>}
   */
  const getSavedWorkflow = async (name, options = {}) => {
    const nameCheck = validateSavedWorkflowName(name);
    if (!nameCheck.ok) return undefined;
    const root = resolveRoot(options.cwd);
    for (const { scope, dir } of savedRoots(root, options.scope)) {
      const file = path.join(dir, `${name}${SAVED_EXTENSION}`);
      const text = await readTextSafe(file);
      if (text === undefined) continue;
      const parsed = parseSavedWorkflowFile(text);
      if (!parsed.ok) continue;
      return savedEntry(name, scope, file, parsed);
    }
    return undefined;
  };

  /**
   * Create or replace a saved workflow.
   *
   * @param {{ cwd?: string, name: string, scope?: 'project'|'global', code: string,
   *   meta?: { description?: string, whenToUse?: string, args?: unknown }, overwrite?: boolean }} input
   * @returns {Promise<{ ok: true, path: string, scope: 'project'|'global', overwritten: boolean, shadowing?: string } | { ok: false, message: string }>}
   */
  const saveSavedWorkflow = async (input = /** @type {any} */ ({})) => {
    const nameCheck = validateSavedWorkflowName(input.name);
    if (!nameCheck.ok) return nameCheck;
    const scope = input.scope === undefined ? 'project' : input.scope;
    if (scope !== 'project' && scope !== 'global') {
      return { ok: false, message: `unknown workflow scope "${String(scope)}" (expected "project" or "global")` };
    }
    const root = resolveRoot(input.cwd);
    const dir = savedTargetDir(root, scope);
    const file = path.join(dir, `${input.name}${SAVED_EXTENSION}`);
    const alreadyThere = await exists(file);
    if (alreadyThere && input.overwrite !== true) {
      return {
        ok: false,
        reason: 'target_exists',
        message: `a ${scope} workflow named "${input.name}" already exists at ${file}`,
      };
    }

    const description = typeof input.meta?.description === 'string'
      ? input.meta.description
      : `Saved workflow "${input.name}".`;
    const text = serializeSavedWorkflowFile(
      {
        description,
        ...(input.meta?.whenToUse === undefined ? {} : { whenToUse: input.meta.whenToUse }),
        ...(input.meta?.args === undefined ? {} : { args: input.meta.args }),
      },
      input.code ?? '',
    );
    await writeFileAtomic(file, text);

    /** @type {Record<string, any>} */
    const result = { ok: true, path: file, scope, overwritten: alreadyThere };
    if (scope === 'project' && await exists(path.join(home(), GLOBAL_SAVED_DIR, `${input.name}${SAVED_EXTENSION}`))) {
      result.shadowing = 'hides_global';
    }
    return result;
  };

  /**
   * Delete a saved workflow. Returns whether a file was removed.
   *
   * @param {string} name
   * @param {{ scope?: 'project'|'global', cwd?: string }} [options]
   * @returns {Promise<boolean>}
   */
  const deleteSavedWorkflow = async (name, options = {}) => {
    const nameCheck = validateSavedWorkflowName(name);
    if (!nameCheck.ok) return false;
    const root = resolveRoot(options.cwd);
    for (const { dir } of savedRoots(root, options.scope)) {
      const file = path.join(dir, `${name}${SAVED_EXTENSION}`);
      if (!(await exists(file))) continue;
      try {
        await fsp.unlink(file);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  };

  /**
   * Move a globally saved workflow into the project archive. Only `global → project` is supported.
   *
   * @param {string} name
   * @param {{ from?: 'global', to?: 'project', cwd?: string }} [options]
   * @returns {Promise<{ ok: true, from: string, to: string, path: string } | { ok: false, reason: string, message: string }>}
   */
  const moveSavedWorkflow = async (name, options = {}) => {
    const from = options.from ?? 'global';
    const to = options.to ?? 'project';
    const nameCheck = validateSavedWorkflowName(name);
    if (!nameCheck.ok) return { ok: false, reason: 'invalid_name', message: INVALID_SAVED_NAME_MESSAGE };
    if (from !== 'global' || to !== 'project') {
      return { ok: false, reason: 'unsupported', message: 'only global → project workflow moves are supported' };
    }
    const root = resolveRoot(options.cwd);
    let source;
    for (const { dir } of savedRoots(root, 'global')) {
      const file = path.join(dir, `${name}${SAVED_EXTENSION}`);
      if (await exists(file)) {
        source = file;
        break;
      }
    }
    if (source === undefined) return { ok: false, reason: 'not_found', message: `no global workflow named "${name}"` };

    const targetDir = savedTargetDir(root, 'project');
    const target = path.join(targetDir, `${name}${SAVED_EXTENSION}`);
    if (await exists(target)) {
      return { ok: false, reason: 'target_exists', message: `a project workflow named "${name}" already exists at ${target}` };
    }
    await fsp.mkdir(targetDir, { recursive: true });
    try {
      await fsp.rename(source, target);
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error;
      await fsp.copyFile(source, target);
      await fsp.unlink(source);
    }
    return { ok: true, from, to, path: target };
  };

  /**
   * Locate one saved workflow file without parsing it.
   *
   * @param {string} name
   * @param {{ scope?: 'project'|'global', cwd?: string }} [options]
   * @returns {Promise<{ file: string, scope: 'project'|'global' } | undefined>}
   */
  const findSavedFile = async (name, options = {}) => {
    const nameCheck = validateSavedWorkflowName(name);
    if (!nameCheck.ok) return undefined;
    const root = resolveRoot(options.cwd);
    for (const { scope, dir } of savedRoots(root, options.scope)) {
      const file = path.join(dir, `${name}${SAVED_EXTENSION}`);
      if (await exists(file)) return { file, scope };
    }
    return undefined;
  };

  /**
   * `workflows/updateMeta`（§1.2 #3）：只改元数据，保留脚本正文。
   *
   * @param {string} name
   * @param {{ description?: string, whenToUse?: string, args?: unknown }} meta
   * @param {{ scope?: 'project'|'global', cwd?: string }} [options]
   * @returns {Promise<{ ok: true, path: string, scope: string } | { ok: false, reason: string, detail?: string }>}
   */
  const updateSavedWorkflowMeta = async (name, meta = {}, options = {}) => {
    const nameCheck = validateSavedWorkflowName(name);
    if (!nameCheck.ok) return { ok: false, reason: 'invalid_name', detail: INVALID_SAVED_NAME_MESSAGE };
    // §1.2 `Ow.description: J` 必填但允许空串；缺字段必须失败，不能沿用旧值。
    if (typeof meta.description !== 'string') {
      return { ok: false, reason: 'parse_error', detail: 'meta.description is required' };
    }
    const found = await findSavedFile(name, options);
    if (found === undefined) return { ok: false, reason: 'not_found' };
    const text = await readTextSafe(found.file);
    if (text === undefined) return { ok: false, reason: 'read_error', detail: 'the workflow file could not be read' };
    const parsed = parseSavedWorkflowFile(text);
    if (!parsed.ok) return { ok: false, reason: 'parse_error', detail: parsed.detail };
    const nextMeta = {
      description: meta.description,
      whenToUse: meta.whenToUse !== undefined ? meta.whenToUse : parsed.meta.whenToUse,
      args: meta.args !== undefined ? meta.args : parsed.meta.args,
    };
    try {
      await writeFileAtomic(found.file, serializeSavedWorkflowFile(nextMeta, parsed.body));
    } catch (error) {
      return { ok: false, reason: 'write_error', detail: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, path: found.file, scope: found.scope };
  };

  /**
   * `workflows/delete` 的契约形态：返回被删除的文件路径（旧 API 只返回布尔值）。
   *
   * @param {string} name
   * @param {{ scope?: 'project'|'global', cwd?: string }} [options]
   * @returns {Promise<{ ok: true, path: string, scope: string } | { ok: false, reason: string }>}
   */
  const removeSavedWorkflow = async (name, options = {}) => {
    const nameCheck = validateSavedWorkflowName(name);
    if (!nameCheck.ok) return { ok: false, reason: 'invalid_name' };
    const found = await findSavedFile(name, options);
    if (found === undefined) return { ok: false, reason: 'not_found' };
    try {
      await fsp.unlink(found.file);
    } catch (error) {
      return { ok: false, reason: 'write_error', detail: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, path: found.file, scope: found.scope };
  };

  /**
   * `workflows/runs`（§1.2 #5）：按保存名反查运行历史，附 artifacts 摘要（最多 8 条）。
   *
   * @param {string} [name] 省略时返回全部保存名的运行
   * @param {{ scope?: 'project'|'global', cwd?: string, limit?: number }} [options]
   * @returns {Promise<{ runs: Record<string, any>[], truncated: boolean }>}
   */
  const listSavedWorkflowRuns = async (name, options = {}) => {
    const rawLimit = Number.isFinite(options.limit) ? Math.floor(options.limit) : 20;
    const limit = Math.max(1, Math.min(rawLimit, 50));
    const rows = (await listRuns({ cwd: options.cwd }))
      .filter((row) => name === undefined || row.name === name)
      .sort((left, right) => {
        const updated = Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0);
        return updated !== 0 ? updated : String(right.id).localeCompare(String(left.id));
      });
    const page = rows.slice(0, limit);
    const runs = [];
    for (const row of page) {
      const artifacts = (await listArtifacts(row.id, { cwd: options.cwd })).slice(0, 8).map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        ...(artifact.title === undefined ? {} : { title: artifact.title }),
        version: artifact.version,
        ...(artifact.contentType === undefined ? {} : { contentType: artifact.contentType }),
      }));
      runs.push({
        runId: row.id,
        name: row.name,
        status: row.status,
        ...(row.stopReason === undefined ? {} : { stopReason: row.stopReason }),
        createdAt: row.createdAt ?? 0,
        updatedAt: row.updatedAt ?? row.createdAt ?? 0,
        spentTokens: row.spentTokens ?? 0,
        ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }),
        ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
        ...(row.args === undefined ? {} : { args: row.args }),
        ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
        ...(artifacts.length === 0 ? {} : { artifacts }),
      });
    }
    return { runs, truncated: rows.length > limit };
  };

  /**
   * 目标文件是否存在（供 `workflows/save` 在编译前判 target_exists，§1.2 #7 / N19）。
   *
   * @param {string} name
   * @param {{ scope?: 'project'|'global', cwd?: string }} [options]
   * @returns {{ scope: 'project'|'global', path: string, exists: boolean } | undefined}
   */
  const savedWorkflowTarget = (name, options = {}) => {
    const nameCheck = validateSavedWorkflowName(name);
    if (!nameCheck.ok) return undefined;
    const scope = options.scope === 'global' ? 'global' : 'project';
    const root = resolveRoot(options.cwd);
    const file = path.join(savedTargetDir(root, scope), `${name}${SAVED_EXTENSION}`);
    return { scope, path: file, exists: existsSync(file) };
  };

  /**
   * `workflows/save`（§1.2 #7）的契约形态：从 run 的脚本落盘并返回 `reason` 词表。
   * 编译校验由调用方完成（store 不依赖 compiler），脚本缺失在这里判定。
   *
   * @param {{ runId?: string, code?: string, name: string, meta?: Record<string, any>,
   *   scope?: 'project'|'global', overwrite?: boolean, cwd?: string }} input
   * @returns {Promise<{ ok: true, name: string, scope: string, path: string, overwritten: boolean, shadowing?: string }
   *   | { ok: false, reason: string, path?: string, detail?: string }>}
   */
  const saveWorkflow = async (input = /** @type {any} */ ({})) => {
    const nameCheck = validateSavedWorkflowName(input.name);
    if (!nameCheck.ok) return { ok: false, reason: 'invalid_name', detail: INVALID_SAVED_NAME_MESSAGE };
    const scope = input.scope === undefined ? 'project' : input.scope;
    if (scope !== 'project' && scope !== 'global') {
      return { ok: false, reason: 'invalid_name', detail: `unknown workflow scope "${String(scope)}"` };
    }
    const root = resolveRoot(input.cwd);
    const file = path.join(savedTargetDir(root, scope), `${input.name}${SAVED_EXTENSION}`);
    const alreadyThere = await exists(file);
    // §1.2 #7：overwrite 缺省等价 false；只有显式 true 才允许覆盖。
    if (alreadyThere && input.overwrite !== true) {
      return {
        ok: false,
        reason: 'target_exists',
        path: file,
        detail: `a ${scope} workflow named "${input.name}" already exists`,
      };
    }
    let code = typeof input.code === 'string' ? input.code : undefined;
    if (code === undefined && typeof input.runId === 'string') {
      const run = getRun(input.runId, { cwd: input.cwd });
      if (run === undefined) return { ok: false, reason: 'run_not_found' };
      code = readRunScript(run.id, { cwd: input.cwd });
    }
    if (typeof code !== 'string' || code.trim() === '') return { ok: false, reason: 'script_missing' };
    const description = typeof input.meta?.description === 'string'
      ? input.meta.description
      : `Saved workflow "${input.name}".`;
    try {
      await writeFileAtomic(file, serializeSavedWorkflowFile({
        description,
        ...(input.meta?.whenToUse === undefined ? {} : { whenToUse: input.meta.whenToUse }),
        ...(input.meta?.args === undefined ? {} : { args: input.meta.args }),
      }, code));
    } catch (error) {
      return { ok: false, reason: 'write_error', path: file, detail: error instanceof Error ? error.message : String(error) };
    }
    /** @type {Record<string, any>} */
    const result = { ok: true, name: input.name, scope, path: file, overwritten: alreadyThere };
    const otherScopeExists = await exists(path.join(
      scope === 'project' ? path.join(home(), GLOBAL_SAVED_DIR) : savedTargetDir(root, 'project'),
      `${input.name}${SAVED_EXTENSION}`,
    ));
    if (otherScopeExists) result.shadowing = scope === 'project' ? 'hides_global' : 'hidden_by_project';
    return result;
  };

  /**
   * `workflows/forRun`（§1.2 #8）：判断一个 run 是从哪个保存工作流跑出来的。
   *
   * 匹配优先级按契约：显式 candidate → 脚本正文相同 → run 名称相同。`entry` 是 Aw 形状
   * （不含脚本正文），`runArgs` 是 run 实际使用的实参。
   *
   * @param {{ runId: string, candidates?: { name: string, scope?: 'project'|'global' }[], cwd?: string }} input
   * @returns {Promise<{ entry?: Record<string, any>, match?: 'candidate'|'script'|'name', runArgs?: Record<string, any> }>}
   */
  const resolveSavedWorkflowForRun = async (input = /** @type {any} */ ({})) => {
    const run = getRun(input.runId, { cwd: input.cwd });
    if (run === undefined) return {};
    const runArgs = run.args ?? {};
    const candidates = Array.isArray(input.candidates) ? input.candidates.slice(0, 8) : [];
    // §1.2 #8：显式候选优先，任一候选存在即短路返回，不再比较名字。
    for (const candidate of candidates) {
      if (candidate === null || typeof candidate !== 'object' || typeof candidate.name !== 'string') continue;
      const entry = await getSavedWorkflow(candidate.name, {
        cwd: input.cwd,
        ...(candidate.scope === undefined ? {} : { scope: candidate.scope }),
      });
      if (entry !== undefined) return { entry: savedWorkflowSummary(entry), match: 'candidate', runArgs };
    }
    const script = readRunScript(run.id, { cwd: input.cwd });
    const listed = await listSavedWorkflows({ cwd: input.cwd });
    const entries = Array.isArray(listed) ? listed : [];
    if (script !== undefined && script.trim() !== '') {
      const byScript = entries.find((entry) => typeof entry.code === 'string' && entry.code.trim() === script.trim());
      if (byScript !== undefined) return { entry: savedWorkflowSummary(byScript), match: 'script', runArgs };
    }
    const byName = entries.find((entry) => entry.name === run.name);
    if (byName !== undefined) return { entry: savedWorkflowSummary(byName), match: 'name', runArgs };
    return {};
  };

  /* ------------------------------- misc ------------------------------------------------------ */

  return {
    homeDir: home,
    projectRoot,
    parseSavedWorkflowFile,
    serializeSavedWorkflowFile,
    validateSavedWorkflowName,
    // runs
    createRun,
    getRun,
    listRuns,
    listRunsForSession,
    updateRun,
    updateRunStatus,
    updateRunUsage,
    settleRun,
    appendEvent,
    readEvents,
    readEventPage,
    listEvents,
    projectRun,
    listRunSnapshots,
    readRunScript,
    // actors / nodes / workspace
    putActor,
    getActor,
    recordActor,
    listActors,
    putNode,
    getNode,
    recordNode,
    listNodes,
    countNodes,
    sumResultBytes,
    listWorldNodes,
    // artifacts
    publishArtifact,
    readArtifactManifest,
    listArtifacts,
    readArtifactPayload,
    artifactFilePath,
    // drafts
    writeDraft,
    // saved workflows
    listSavedWorkflows,
    getSavedWorkflow,
    saveSavedWorkflow,
    saveWorkflow,
    savedWorkflowTarget,
    updateSavedWorkflowMeta,
    removeSavedWorkflow,
    listSavedWorkflowRuns,
    resolveSavedWorkflowForRun,
    deleteSavedWorkflow,
    moveSavedWorkflow,
    // paths (handy for callers / tests)
    paths: {
      projectRunsDir: (cwd) => projectRunsDir(resolveRoot(cwd)),
      globalRunsDir,
      projectDraftsDir: (cwd) => path.join(resolveRoot(cwd), DRAFT_DIR),
      projectSavedDir: (cwd) => savedTargetDir(resolveRoot(cwd), 'project'),
      globalSavedDir: () => savedTargetDir(resolveRoot(undefined), 'global'),
    },
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* helpers shared by the facade                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/** @param {string} name @param {'project'|'global'} scope @param {string} file @param {ParsedSavedWorkflow} parsed */
function savedEntry(name, scope, file, parsed) {
  return {
    name,
    scope,
    path: file,
    code: parsed.body,
    meta: parsed.meta,
    // Flattened aliases: older callers (and the ZCode RPC shape) read these directly.
    description: parsed.meta.description,
    whenToUse: parsed.meta.whenToUse,
    args: parsed.meta.args,
    bodyLineOffset: parsed.bodyLineOffset,
  };
}

/**
 * Aw（§1.2 列表条目）投影：脚本正文不进目录列表，避免把大段脚本送到浏览器。
 *
 * @param {Record<string, any>} entry
 */
function savedWorkflowSummary(entry) {
  return {
    name: entry.name,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.whenToUse === undefined ? {} : { whenToUse: entry.whenToUse }),
    ...(entry.args === undefined ? {} : { args: entry.args }),
    scope: entry.scope,
    path: entry.path,
  };
}

/** @param {unknown} name */
function sanitizeDraftName(name) {
  let text = String(name ?? '').trim().replace(/\.dwf\.ts$/u, '');
  text = text.replace(/[^\w\u4e00-\u9fa5 .-]+/gu, '-').replace(/-{2,}/gu, '-').replace(/^[.\s-]+|[.\s-]+$/gu, '');
  if (text === '') text = 'workflow';
  return text.slice(0, MAX_SAVED_NAME_LENGTH);
}

/** @param {string} kind @param {string|undefined} sourcePath */
function inferContentType(kind, sourcePath) {
  if (kind === 'markdown') return 'text/markdown';
  if (kind === 'chart') return 'image/svg+xml';
  if (kind === 'table' || kind === 'board') return 'application/json';
  if (kind === 'metrics') return 'application/json';
  if (typeof sourcePath === 'string') {
    const extension = path.extname(sourcePath).toLowerCase();
    if (extension === '.md' || extension === '.mdx') return 'text/markdown';
    if (extension === '.json') return 'application/json';
    if (extension === '.csv') return 'text/csv';
    if (extension === '.svg') return 'image/svg+xml';
    if (extension === '.html' || extension === '.htm') return 'text/html';
    if (extension === '.png') return 'image/png';
    if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
    if (extension === '.txt') return 'text/plain';
  }
  return 'application/octet-stream';
}

/** @param {unknown} title @param {string} id @param {string} contentType */
function artifactFileName(title, id, contentType) {
  const base = safeSegment(typeof title === 'string' && title.trim() !== '' ? title : id, 'artifact');
  const extension = contentType === 'text/markdown' ? '.md'
    : contentType === 'text/csv' ? '.csv'
      : contentType === 'image/svg+xml' ? '.svg'
        : contentType === 'text/html' ? '.html'
          : contentType === 'application/json' ? '.json'
            : contentType === 'image/png' ? '.png'
              : contentType === 'image/jpeg' ? '.jpg'
                : contentType === 'text/plain' ? '.txt'
                  : '.bin';
  return `${base}${extension}`;
}
