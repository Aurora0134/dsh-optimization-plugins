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

import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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

const FRONTMATTER_OPEN = '/* zcode-workflow';
const FRONTMATTER_CLOSE = '*/';
const ARTIFACT_KINDS = new Set(['file', 'markdown', 'chart', 'table', 'metrics', 'board']);
const ARGUMENT_TYPES = new Set(['string', 'number', 'boolean', 'json']);
const META_KEYS = new Set(['description', 'whenToUse', 'args']);
const ARG_KEYS = new Set(['type', 'description', 'required', 'default']);
const MAX_INLINE_META_RESULT = 4000;

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
  } else if (record.description.trim() === '') {
    issues.push('description: must not be empty');
  } else {
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
  const description = typeof meta?.description === 'string' && meta.description.trim() !== ''
    ? meta.description
    : 'Saved workflow.';
  const whenToUse = typeof meta?.whenToUse === 'string' && meta.whenToUse.trim() !== '' ? meta.whenToUse : undefined;
  const args = normalizeArgs(meta?.args);
  const yaml = stringifyMetadataYaml({
    description,
    whenToUse,
    ...(args === undefined || Object.keys(args).length === 0 ? {} : { args }),
  });
  return `${FRONTMATTER_OPEN}\n${yaml}${FRONTMATTER_CLOSE}\n\n${String(script ?? '')}`;
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

  /** @param {string} dir */
  const readRunMeta = async (dir) => {
    const meta = await readJson(path.join(dir, 'meta.json'));
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
    return /** @type {Record<string, any>} */ (meta);
  };

  /* ------------------------------- runs ------------------------------------------------------- */

  /**
   * Create one durable run directory.
   *
   * @param {Record<string, any>} input metadata; `code` becomes `script.ts` and is not stored in meta.json
   * @returns {Promise<Record<string, any>>} stored metadata (with timestamps)
   */
  const createRun = async (input = {}) => {
    const id = input.id ?? input.runId;
    if (typeof id !== 'string' || id === '') throw new Error('createRun requires a string run id');
    const root = resolveRoot(input.cwd);
    const dir = path.join(projectRunsDir(root), id);
    await fsp.mkdir(dir, { recursive: true });
    const now = Date.now();
    const meta = { ...input, cwd: root, id };
    delete meta.code;
    const stored = {
      ...meta,
      id,
      status: meta.status ?? 'running',
      createdAt: meta.createdAt ?? now,
      updatedAt: meta.updatedAt ?? now,
      pid: meta.pid ?? process.pid,
    };
    if (typeof input.code === 'string') await writeFileAtomic(path.join(dir, 'script.ts'), input.code);
    await writeJsonAtomic(path.join(dir, 'meta.json'), stored);
    return stored;
  };

  /**
   * Read one run's metadata, searching the project then the global runs dir.
   *
   * @param {string} id
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<Record<string, any> | undefined>}
   */
  const getRun = async (id, options = {}) => {
    const dir = await locateRunDir(id, options.cwd);
    if (dir === undefined) return undefined;
    const meta = await readRunMeta(dir);
    if (meta === undefined) return undefined;
    return { ...meta, id: meta.id ?? id };
  };

  /**
   * List runs newest first.
   *
   * @param {{ project?: boolean, limit?: number, cwd?: string }} [options]
   * @returns {Promise<Record<string, any>[]>}
   */
  const listRuns = async (options = {}) => {
    const root = resolveRoot(options.cwd);
    const dirs = options.project === false
      ? [projectRunsDir(root), globalRunsDir()]
      : [projectRunsDir(root)];
    /** @type {Map<string, Record<string, any>>} */
    const rows = new Map();
    for (const dir of dirs) {
      const entries = await readDirSafe(dir);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const runDir = path.join(dir, entry.name);
        const meta = await readRunMeta(runDir);
        if (meta === undefined || rows.has(entry.name)) continue;
        const status = meta.status ?? 'unknown';
        const runningElsewhere = status === 'running' && typeof meta.pid === 'number' && meta.pid !== process.pid;
        rows.set(entry.name, {
          id: meta.id ?? entry.name,
          name: meta.name ?? entry.name,
          status,
          stopReason: meta.stopReason,
          resumedFrom: meta.resumedFrom,
          supersededBy: meta.supersededBy,
          createdAt: meta.createdAt,
          finishedAt: meta.finishedAt,
          cwd: meta.cwd ?? root,
          labelSource: meta.labelSource ?? meta.origin,
          spentTokens: meta.usage?.spentTokens ?? meta.spentTokens,
          possibleInterruption: meta.possibleInterruption === true || (runningElsewhere && !isProcessAlive(meta.pid)),
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
   * Patch a run's metadata. Missing runs are a no-op (`undefined` result) rather than a throw.
   *
   * @param {string} id
   * @param {Record<string, any>} patch
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<Record<string, any> | undefined>}
   */
  const updateRun = async (id, patch = {}, options = {}) => {
    const dir = await locateRunDir(id, options.cwd);
    if (dir === undefined) return undefined;
    const current = (await readRunMeta(dir)) ?? { id };
    const clean = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    const next = { ...current, ...clean, id: current.id ?? id, updatedAt: clean.updatedAt ?? Date.now() };
    await writeJsonAtomic(path.join(dir, 'meta.json'), next);
    return next;
  };

  /**
   * Settle a run: patch status/reason/error, write `result.json`, stamp `finishedAt`.
   *
   * @param {string} id
   * @param {{ status?: string, stopReason?: string, error?: unknown, result?: unknown, finishedAt?: number }} outcome
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<Record<string, any> | undefined>}
   */
  const settleRun = async (id, outcome = {}, options = {}) => {
    const dir = await locateRunDir(id, options.cwd);
    if (dir === undefined) return undefined;
    const finishedAt = Number.isFinite(outcome.finishedAt) ? /** @type {number} */ (outcome.finishedAt) : Date.now();
    /** @type {Record<string, any>} */
    const patch = { finishedAt, updatedAt: finishedAt };
    if (outcome.status !== undefined) patch.status = outcome.status;
    if (outcome.stopReason !== undefined) patch.stopReason = outcome.stopReason;
    if (outcome.error !== undefined) {
      patch.error = typeof outcome.error === 'string'
        ? outcome.error
        : (outcome.error?.message !== undefined ? String(outcome.error.message) : String(outcome.error));
    }
    if (outcome.result !== undefined) {
      const serialized = safeJson(outcome.result);
      if (serialized !== undefined) {
        await writeFileAtomic(path.join(dir, 'result.json'), `${serialized}\n`);
        if (serialized.length <= MAX_INLINE_META_RESULT) patch.result = outcome.result;
      }
    }
    const current = (await readRunMeta(dir)) ?? { id };
    const next = { ...current, ...patch, id: current.id ?? id };
    await writeJsonAtomic(path.join(dir, 'meta.json'), next);
    return next;
  };

  /**
   * Append one journal line to `journal.jsonl`.
   *
   * @param {string} id
   * @param {Record<string, any>} event
   * @param {{ cwd?: string }} [options]
   */
  const appendEvent = async (id, event, options = {}) => {
    // Runtime callers do `void store.appendEvent(...)`: the journal is best-effort telemetry and a
    // failed append must never surface as an unhandled rejection.
    try {
      const dir = (await locateRunDir(id, options.cwd)) ?? path.join(projectRunsDir(resolveRoot(options.cwd)), id);
      await fsp.mkdir(dir, { recursive: true });
      const row = { at: Date.now(), ...(event ?? {}) };
      await fsp.appendFile(path.join(dir, 'journal.jsonl'), `${safeJson(row) ?? '{}'}\n`, 'utf8');
    } catch {
      // ignored on purpose
    }
  };

  /**
   * Read the run journal. Corrupt lines are skipped, never thrown.
   *
   * @param {string} id
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<Record<string, any>[]>}
   */
  const readEvents = async (id, options = {}) => {
    const dir = await locateRunDir(id, options.cwd);
    if (dir === undefined) return [];
    const text = await readTextSafe(path.join(dir, 'journal.jsonl'));
    if (text === undefined) return [];
    const events = [];
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() === '') continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // A torn last line is expected after a crash: skip it.
      }
    }
    return events;
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
    const versionDir = path.join(runDir, 'artifacts', idSegment, `v${version}`);
    await fsp.mkdir(versionDir, { recursive: true });

    /** @type {Record<string, any>} */
    const record = {
      id: artifactId,
      kind,
      version,
      ...(artifact.title === undefined ? {} : { title: artifact.title }),
      ...(artifact.description === undefined ? {} : { description: artifact.description }),
      ...(artifact.primary === true ? { primary: true } : {}),
      contentType: artifact.contentType ?? inferContentType(kind, artifact.sourcePath),
      createdAt: Date.now(),
    };

    if (typeof artifact.sourcePath === 'string' && artifact.sourcePath !== '') {
      const source = path.resolve(runDir, artifact.sourcePath);
      const baseName = path.basename(source) || 'artifact.bin';
      const target = path.join(versionDir, baseName);
      await fsp.copyFile(source, target);
      const stat = await fsp.stat(target).catch(() => undefined);
      record.file = `artifacts/${idSegment}/v${version}/${baseName}`;
      record.bytes = stat?.size ?? 0;
    } else if (typeof artifact.text === 'string') {
      const fileName = `${artifactFileName(artifact.title, artifactId, record.contentType)}`;
      const target = path.join(versionDir, fileName);
      await writeFileAtomic(target, artifact.text);
      const stat = await fsp.stat(target).catch(() => undefined);
      record.file = `artifacts/${idSegment}/v${version}/${fileName}`;
      record.bytes = stat?.size ?? Buffer.byteLength(artifact.text, 'utf8');
      if (artifact.text.length <= 100_000) record.text = artifact.text;
    }

    if (artifact.spec !== undefined) {
      const target = path.join(versionDir, 'spec.json');
      await writeJsonAtomic(target, artifact.spec);
      record.spec = artifact.spec;
      record.specFile = `artifacts/${idSegment}/v${version}/spec.json`;
      if (record.bytes === undefined) record.bytes = (await fsp.stat(target).catch(() => undefined))?.size ?? 0;
    }

    if (Array.isArray(artifact.items)) {
      const target = path.join(versionDir, 'items.json');
      await writeJsonAtomic(target, artifact.items);
      record.itemsFile = `artifacts/${idSegment}/v${version}/items.json`;
      record.itemCount = artifact.items.length;
      if (record.bytes === undefined) record.bytes = (await fsp.stat(target).catch(() => undefined))?.size ?? 0;
    }

    const doc = await readManifestDoc(runId);
    const kept = doc.artifacts.filter((row) => !(row.id === artifactId && Number(row.version) === version));
    kept.push(record);
    kept.sort((left, right) => String(left.id).localeCompare(String(right.id)) || Number(left.version) - Number(right.version));
    await writeJsonAtomic(path.join(runDir, 'artifacts', 'manifest.json'), {
      runId,
      updatedAt: Date.now(),
      artifacts: kept,
    });
    return record;
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

    for (const { scope, dir } of savedRoots(root, undefined)) {
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
    if (alreadyThere && input.overwrite === false) {
      return { ok: false, message: `a ${scope} workflow named "${input.name}" already exists at ${file}` };
    }

    const description = typeof input.meta?.description === 'string' && input.meta.description.trim() !== ''
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
    updateRun,
    settleRun,
    appendEvent,
    readEvents,
    // artifacts
    publishArtifact,
    readArtifactManifest,
    artifactFilePath,
    // drafts
    writeDraft,
    // saved workflows
    listSavedWorkflows,
    getSavedWorkflow,
    saveSavedWorkflow,
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
