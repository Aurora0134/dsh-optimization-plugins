/**
 * ZCode "Dynamic workflow" — workflow-script compiler.
 *
 * One self-contained module: no DSH imports, plain Node 24 (ESM). It turns the TypeScript a model
 * submits into executable JavaScript, and into the structured facts the runtime and the UI need:
 * phase names, subagent names, artifact declarations, world commands and the JSON schemas that
 * typed `ask<T>()` answers are validated against.
 *
 * There is no TypeScript compiler here. Type erasure comes from Node's built-in
 * `stripTypeScriptTypes`; every ZCode rule from SKILL.md §16.3 is enforced structurally by this
 * module's own tokenizer, so a check never fires inside a comment, a string or a template literal.
 *
 * ## Public API
 *
 * ```js
 * compileWorkflowScript({ code, filename, mode })
 * // mode: 'workflow' (default) | 'snippet'
 * // -> { ok, js, diagnostics, phases, agents, artifacts, worldCommands, interfaces }
 * ```
 *
 * `js` is a complete runnable expression: the script wrapped as `(async () => { … })()` and then
 * transpiled, so a top-level `return` is legal and `await` works. The runtime evaluates it as
 * `new vm.Script(js).runInContext(context)` (or `new Function('return ' + js)()`); the value is a
 * promise for the script's `return` value. The wrapper adds exactly one line, so diagnostics are
 * reported at `wrappedLine - 1`.
 *
 * `interfaces` maps a marker name to a JSON-schema-ish object: `interfaces[__zcodeSchema(name)]`.
 * Because `stripTypeScriptTypes` erases type arguments, `agent("x").ask<Review>(...)` is rewritten
 * to `agent("x").ask(__zcodeSchema("Review"), ...)` before transpiling, and the schema of `Review`
 * is returned under `"Review"` (an array site `ask<Review[]>` also gets the exact marker key
 * `"Review[]"`, whose schema is `{ type: 'array', items: <Review> }`).
 *
 * `extractMetadataHeader(code)` parses the `/* zcode-workflow` YAML block of a saved `.dwf.ts`
 * file; `serializeMetadataHeader(meta, body)` writes one. Failures are returned, never thrown.
 *
 * ## Diagnostic codes (ZCode's own numbering, from `zcode.cjs`)
 *
 * | code | meaning |
 * | ---- | ------- |
 * | 9001 | a facade callable was stored, aliased or retyped — site identity would be lost |
 * | 9002 | a forbidden API (`process`/`fetch`/`fs`/`Date.now()`/`Math.random()`/`eval`), or a facade callable that does not exist in this mode |
 * | 9003 | a `world.run()` command that is not a compile-time string literal |
 * | 9004 | a `phase()` marker: non-literal name, empty name, not standalone — or phase coverage |
 * | 9005 | a duplicate literal `agent()` name |
 * | 9006 | a fixed `agent()` name inside a fan-out callback |
 * | 9007 | an artifact id (literal, empty, length, characters), an unknown kind, two kinds for one id, or two `primary` artifacts |
 * | 9008 | a preset artifact declared outside the top level (callback / branch / loop) |
 * | 9009 | a `report()` tag: not a literal, a file/markdown artifact, or (warning) unknown |
 * | 9010 | `import`, `export` or the `declare` modifier |
 * | 9011 | a syntax that cannot become a JSON schema (the type is named), or a `model()` model that is not a literal |
 * | 9012 | a `hole()` rule violation, a parse error, an empty script, or anything with no better code |
 *
 * Every diagnostic carries `{ path, line, column, code, message, severity }`. `ok` is false only
 * when at least one diagnostic has `severity: 'error'`; warnings ride along on a clean compile.
 *
 * ## Known deviations from ZCode's compiler
 *
 * - No type checker: only the rules above are enforced. `strict`-mode type errors (an unguarded
 *   `.find()` result, a wrong argument type) are not diagnosed statically; they surface at run time.
 * - Template literals are scanned as one opaque token, so a `.ask<T>` written inside a `${...}`
 *   substitution keeps its type argument (erased) instead of being rewritten with a schema marker.
 * - `phase()` coverage, "preset artifacts at the top level", and the fan-out-callback rules are
 *   structural best-effort scans, tuned to never fire on a correct script.
 */

import { stripTypeScriptTypes } from 'node:module';

/**
 * The ambient facade every workflow script is compiled against (SKILL.md §16.2, `facade-dts`
 * block, verbatim). Kept here because it is the compiler's contract: the runtime supplies exactly
 * these globals, and the tool description can quote it.
 *
 * @type {string}
 */
export const FACADE_DTS = `/** The pending result of one ask. Await it, or pass it to Promise.all with others. */
declare interface Node<T> extends PromiseLike<T> {}

/** A model declared with model(). */
declare class ModelRef { private constructor(); private readonly modelRef: never }

/**
 * Declare a model subagents may run on: "modelId" or "providerId/modelId", optional "$level".
 * String literal only (checked at launch); choose among ModelRefs at run time.
 */
declare function model(id: string): ModelRef;

/** Persona of a subagent, fixed when agent() creates it. Every subagent has the same working tools. */
declare interface AgentPersona {
  /** System prompt describing the actor's role. */
  system?: string;
  /** Model id literal or ModelRef; omitted = the run's subagent model. */
  model?: ModelRef | string;
}

/**
 * A subagent: one conversation that keeps its context across asks. Asks issued while it is
 * busy wait their turn, first in, first out.
 */
declare interface Agent {
  /**
   * Give the subagent one task. With a type argument, the answer is a value of type T,
   * validated against a schema built from it: T is an interface you define in this script
   * with a plain "interface" declaration (no "declare" modifier). Without one, the answer is
   * the subagent's final reply text.
   */
  ask<T = string>(instructions: string): Node<T>;
}

/**
 * Create a subagent. Every call starts a new, empty conversation; to share one, share the
 * returned value. A non-empty name is an identity: unique within the run (a literal duplicate
 * is a compile error, a computed one fails the run) and the key AmendWorkflow matches cached
 * work by. Unnamed subagents are allowed and never reuse cached work.
 */
declare function agent(name?: string, persona?: string | AgentPersona): Agent;

/**
 * The run's arguments. For a saved workflow they are validated against its declared
 * arguments, with defaults filled in, before the run starts; an inline script or a snippet
 * gets {}. Always defined; the values are unknown, so narrow them (String(args.target), a
 * typeof guard).
 */
declare const args: Readonly<Record<string, unknown>>;

/**
 * This run's id, and the run it amends. ResumeWorkflowRun keeps both; AmendWorkflow mints a
 * new id. Keep them out of ask text, personas and world arguments: those are cache keys.
 */
declare const run: { readonly id: string; readonly resumedFrom?: string };

/** Emit a progress message to the user. */
declare function log(message: string): void;

/**
 * Publish one intermediate result while the run is going; returns nothing. Items are
 * recorded: a resumed run never shows one twice, and they reach the completion notification
 * even when the run fails. The item must be JSON-serializable (plain objects, arrays, strings,
 * numbers, booleans, null); functions, class instances, Date and promises are compile
 * errors. Caps fail the whole run, not the call: 65,536 items per run, 1 MiB per serialized
 * item, 1 GiB per run.
 *
 * artifactId routes the item to a dashboard: a compile-time literal naming a preset
 * (artifact.chart / table / metrics / board) whose declaration has executed by then. The
 * item becomes one point, row, tile value or card there and still lands in the run's
 * Results. A tag naming nothing, or a file/markdown artifact, fails the run.
 */
declare function report(item: unknown, artifactId?: string): void;

/** A published artifact version: the id it was published under, and which version this call minted. */
declare interface ArtifactRef { id: string; version: number }
/** Card metadata every artifact kind accepts. */
declare interface ArtifactOptions {
  /** Shown as the card title; defaults to the id. In the user's language. */
  title?: string;
  /** A sentence or two, shown beside the title when this artifact is the run's primary. */
  description?: string;
  /** The run's deliverable: the card and the run pane lead with it. At most one id per run; once set it stays set for later versions. */
  primary?: boolean;
}
declare interface ArtifactFileOptions extends ArtifactOptions {
  /** Overrides the type sniffed from the extension ("application/pdf", "text/html", …). */
  contentType?: string;
}
/** One value taken from a reported item: a dot path into the item ("timing.after"). */
declare interface ArtifactField { field: string; label?: string; unit?: string }
declare interface ChartSpec extends ArtifactOptions {
  type?: "line" | "bar" | "scatter";        // default "line"
  x: ArtifactField;
  y: ArtifactField | ArtifactField[];        // several = several series
  scale?: "linear" | "log";                  // y axis, default "linear"
  /** A reference value drawn as a horizontal rule, taken from the first item that has the field. */
  baseline?: ArtifactField;
}
declare interface TableSpec extends ArtifactOptions {
  columns: ArtifactField[];
  /** Field that identifies a row; a later item with the same key replaces the row. Absent = append-only. */
  key?: string;
}
declare interface MetricsSpec extends ArtifactOptions {
  /** Each tile shows the value from the latest item that has the field. */
  metrics: ArtifactField[];
}
declare interface BoardSpec extends ArtifactOptions {
  /** Field identifying a card; a later item with the same key moves/updates the card. */
  key: string;
  /** Field holding the card's column. */
  status: string;
  /** Column order. Items whose status is not listed land in a trailing "other" column. */
  columns: string[];
  /** Field for the card title (default: the key) and extra fields shown on the card. */
  cardTitle?: string;
  detail?: ArtifactField[];
}
/**
 * Publish what the user keeps: cards beside the run, kept after it ends. Every id is a
 * compile-time string literal (non-empty, at most 64 characters of [A-Za-z0-9_.-]) and is
 * used with one member only.
 * - CONTENT (file, markdown) are effects: async, resolve to an ArtifactRef, and reject
 *   catchably (missing file, not a file, outside the workspace, over the cap, or no artifact
 *   store in this host).
 *   Bytes are copied at publish time; republishing an id mints the next version and keeps
 *   the old ones.
 * - PRESET (chart, table, metrics, board) are declarations: synchronous and void, drawn from
 *   the items tagged report(item, "<id>"). Declare each once, at the top level; an identical
 *   re-declaration is a no-op, a different or malformed spec fails the whole run.
 * Caps: 32 ids per run, 16 versions per id, 20 MiB per file, 256 KB per markdown, 120
 * characters of title and 500 of description.
 */
declare const artifact: {
  /** Publish a workspace file, path resolved as in files.read(). The type comes from the extension unless opts.contentType sets it. */
  file(id: string, path: string, opts?: ArtifactFileOptions): Promise<ArtifactRef>;
  /** Publish markdown text the script composed. */
  markdown(id: string, content: string, opts?: ArtifactOptions): Promise<ArtifactRef>;
  /** Declare a chart fed by report(item, id): each tagged item is one point. */
  chart(id: string, spec: ChartSpec): void;
  /** Declare a table fed by report(item, id): each tagged item is one row. */
  table(id: string, spec: TableSpec): void;
  /** Declare a metric tile row fed by report(item, id): each tile shows the newest value it has. */
  metrics(id: string, spec: MetricsSpec): void;
  /** Declare a board fed by report(item, id): each tagged item is a card, placed by its status field. */
  board(id: string, spec: BoardSpec): void;
};

/**
 * Mark the start of a phase: a named group of the steps that follow, drawn as one node on
 * the graph the user approves. Presentation only: it starts, waits for and returns nothing.
 * Required. The name is a non-empty compile-time literal and the call a standalone
 * statement. A marker covers every step from it to the end of the block it stands in
 * (nested blocks and inlined helpers included); two markers with the same name are one
 * phase. Every phase contains at least one ask or world.run.
 */
declare function phase(name: string): void;

/**
 * A typed gap: code you write later, once an earlier step's findings are in. When the run
 * reaches an unfilled hole, that branch waits while you write the body (FillWorkflowHole);
 * the rest of the run keeps going. prompt is the message you will receive, so interpolate
 * the values the decision needs. The body runs in the hole's place, sees the bindings
 * declared before it, and returns the hole's value. The filled form passes the body last.
 */
declare function hole<T>(name: string, prompt?: string): Promise<T>;
declare function hole<T>(name: string, body: () => Promise<T>): Promise<T>;
declare function hole<T>(name: string, prompt: string, body: () => Promise<T>): Promise<T>;

/** One matching line found by files.grep. */
declare interface GrepMatch {
  /** Workspace-relative path of the file the match was found in. */
  path: string;
  /** One-based line number of the match. */
  line: number;
  /** The full text of the matching line. */
  text: string;
}

/**
 * Read-only views of the workspace. Each result is recorded, so a resumed run gets the same
 * answer back instead of reading again. There is no write: writing is a subagent's task.
 */
declare const files: {
  /** Workspace-relative paths matching a glob, sorted. Over 2000 files the call rejects. */
  glob(pattern: string): Promise<string[]>;
  /** Read one workspace file as UTF-8 text. Size-capped. */
  read(path: string): Promise<string>;
  /**
   * Search contents with a ripgrep-compatible regex, optionally narrowed by a glob over
   * paths ("*.ts", "src/**"); one entry per matching line. Over 2000 matches or 256KB of
   * results the call rejects.
   */
  grep(pattern: string, glob?: string): Promise<GrepMatch[]>;
};

/** The working tree's status, as reported by git.status(). */
declare interface GitStatus {
  /** Current branch name; absent when HEAD is detached. */
  branch?: string;
  /** True when nothing is staged, modified, or untracked. */
  clean: boolean;
  /** Workspace-relative paths staged for the next commit. */
  staged: string[];
  /** Workspace-relative paths modified in the working tree but not staged. */
  unstaged: string[];
  /** Workspace-relative paths git does not track (honouring .gitignore). */
  untracked: string[];
}

/** One commit, as reported by git.log(). */
declare interface GitCommit {
  /** Full commit hash. */
  hash: string;
  /** First line of the commit message. */
  subject: string;
  /** Author name. */
  author: string;
  /** Author date, ISO 8601. */
  date: string;
}

/**
 * Read-only git views, recorded like files.* so a resumed run gets the same answer back; no
 * call can write. A base names a single ref (no ".." ranges). Paths are workspace-relative, and
 * changes outside the workspace are not reported; git.log alone is repository-wide. Caps
 * reject rather than truncate: diff at 512KB, log at 100 commits. Outside a git repository,
 * or without git, every call rejects catchably.
 */
declare const git: {
  /**
   * Workspace-relative paths that changed. With no base: files modified against HEAD, plus
   * untracked files. With a base ref: tracked files whose current state differs from that
   * ref, uncommitted edits included, untracked files not.
   */
  changedFiles(base?: string): Promise<string[]>;
  /**
   * Unified diff against base (default HEAD). Covers the whole workspace unless you
   * narrow it to one workspace-relative path.
   */
  diff(base?: string, path?: string): Promise<string>;
  /** The current working-tree status, for the workspace. */
  status(): Promise<GitStatus>;
  /** The most recent commits, newest first. Default 20, maximum 100. */
  log(count?: number): Promise<GitCommit[]>;
};

/** The outcome of one world.run command, including nonzero exits. */
declare interface WorldRunResult {
  /** The process exit code. Nonzero is a normal, returned outcome — branch on it. */
  exitCode: number;
  /** Captured output (UTF-8), shaped by opts.output. */
  stdout: string;
  stderr: string;
}

/**
 * Run a command. Each call runs once and its result is recorded: a resumed run reuses the
 * recorded result instead of running the command again. A completed process RESOLVES,
 * nonzero exit included; the promise rejects (catchably) only on spawn failure or timeout
 * (default 300000ms, timeoutMs overrides, no upper cap). cmd is a compile-time string
 * literal, shown to the user at confirmation. Fixed argv, never a shell: no pipes,
 * redirection or expansion. cwd is the workspace. Node builtins are reachable as
 * world.run("node", ["-e", code]).
 * opts.output (both streams): "full" (default) rejects over 16 MiB; "discard" is "";
 * { tail: n } keeps the last n bytes, n <= 16777216 (16 MiB). Neither bounds what the process prints.
 */
declare const world: {
  run(cmd: string, args?: string[], opts?: { timeoutMs?: number; output?: "full" | "discard" | { tail: number } }): Promise<WorldRunResult>;
};

/**
 * A stream of typed items between two stages: one stage send()s, another drains it with
 * for await. Unbounded, first-in-first-out, each item to exactly one receiver.
 */
declare interface Channel<T> extends AsyncIterable<T> {
  /** Enqueue one item; synchronous, never waits. Throws ChannelClosed after close(). */
  send(item: T): void;
  /**
   * End the stream: receivers get the remaining items, then their loops exit. Idempotent.
   * A channel nobody closes fails the run as ChannelDeadlock, naming it, once nothing in
   * flight could send to it again.
   */
  close(): void;
}

/**
 * Create a channel. The name labels the deadlock message; it is not an identity. A receiver
 * on an empty, open channel waits until a send or the close.
 */
declare function channel<T>(name?: string): Channel<T>;

/**
 * Run an async block as a concurrent stage. It starts immediately, not when awaited, and
 * returns its promise.
 */
declare function future<T>(body: () => Promise<T>): Promise<T>;`;

/** Diagnostic codes, numbered like ZCode's own (SKILL.md §16.3). @type {Readonly<Record<string, number>>} */
export const COMPILER_DIAGNOSTIC_CODES = Object.freeze({
  FACADE_MISUSE: 9001,
  FORBIDDEN_API: 9002,
  WORLD_COMMAND: 9003,
  PHASE: 9004,
  DUPLICATE_AGENT: 9005,
  FIXED_ACTOR_NAME: 9006,
  ARTIFACT: 9007,
  PRESET_PLACEMENT: 9008,
  REPORT_TAG: 9009,
  MODULE_SYNTAX: 9010,
  UNSUPPORTED: 9011,
  HOLE: 9012,
  SYNTAX: 9012,
});

const CODE = COMPILER_DIAGNOSTIC_CODES;

/** The async wrapper every script is transpiled inside; the opening line is line 1, so user line = wrapped line - 1. */
const WRAPPER_OPEN = '(async () => {';
const WRAPPER_CLOSE = '})()';
const WRAPPER_LINE_OFFSET = 1;

/**
 * Wrap a script (already rewritten with schema markers) so that a top-level `return` and
 * top-level `await` are both legal.
 * @param {string} code
 * @returns {string}
 */
function wrapScript(code) {
  return `${WRAPPER_OPEN}\n${code}\n${WRAPPER_CLOSE}`;
}

const SNIPPET_FORBIDDEN_GLOBALS = new Set(['agent', 'phase', 'report', 'artifact', 'hole', 'model']);

const FORBIDDEN_GLOBAL_NAMES = new Set(['process', 'require', 'fetch', 'fs']);

/** Member calls that are forbidden because a replayable run cannot contain them. */
const FORBIDDEN_STATIC_MEMBERS = [
  { object: 'Date', member: 'now', hint: 'a replayable run cannot read the clock' },
  { object: 'Math', member: 'random', hint: 'a replayable run cannot be random' },
];

const ARTIFACT_KINDS = new Set(['file', 'markdown', 'chart', 'table', 'metrics', 'board']);
const PRESET_ARTIFACT_KINDS = new Set(['chart', 'table', 'metrics', 'board']);

/** Array methods whose callback runs once per element, concurrently: a hole may not stand there. */
const FANOUT_METHODS = new Set([
  'map', 'flatMap', 'forEach', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex',
  'some', 'every', 'reduce', 'reduceRight', 'sort', 'toSorted', 'toReversed',
]);

const MAX_ARTIFACT_ID_LENGTH = 64;
const MAX_HOLE_NAME_LENGTH = 128;
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_.-]+$/u;

/** Names the script may use as an `ask<T>` type argument without declaring a schema. */
const BUILTIN_SCHEMAS = new Map([
  ['string', { type: 'string' }],
  ['number', { type: 'number' }],
  ['boolean', { type: 'boolean' }],
  ['null', { type: 'null' }],
  ['any', {}],
  ['unknown', {}],
  ['void', {}],
]);

const KEYWORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function',
  'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'async', 'of', 'as', 'satisfies', 'from', 'get', 'set', 'static', 'implements', 'interface',
  'namespace', 'module', 'declare', 'abstract', 'public', 'private', 'protected', 'readonly',
  'override', 'type', 'infer', 'keyof', 'is', 'asserts', 'unique',
]);

/** Keywords after which a `/` starts a regular expression rather than a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case',
  'do', 'else', 'yield', 'await', 'extends', 'default', 'satisfies', 'as',
]);

const PUNCTUATORS = [
  '>>>=', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=', '...',
  '=>', '>=', '<=', '==', '!=', '**', '++', '--', '+=', '-=', '*=', '/=', '%=',
  '&&', '||', '??', '?.', '<<',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^',
  '!', '~', '?', ':', '=', '.', '@', '#',
];

const OPENERS = new Set(['(', '[', '{']);
const CLOSER_TO_OPENER = new Map([[')', '('], [']', '['], ['}', '{']]);

const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;

/* ------------------------------------------------------------------------------------------------
 * Source text: BOM + line endings, and offset -> line/column
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {string} input raw script text
 * @returns {{ code: string, hadBom: boolean }}
 */
function normalizeSource(input) {
  let text = typeof input === 'string' ? input : String(input ?? '');
  let hadBom = false;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    hadBom = true;
  }
  if (text.includes('\r')) text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return { code: text, hadBom };
}

/**
 * @param {string} code normalized source
 * @returns {number[]} offset of the first character of every line
 */
function lineStartIndex(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i += 1) {
    if (code.charCodeAt(i) === LINE_FEED) starts.push(i + 1);
  }
  return starts;
}

/**
 * @param {number[]} starts line starts from {@link lineStartIndex}
 * @param {number} offset
 * @returns {{ line: number, column: number }} 1-based
 */
function locate(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - starts[low] + 1 };
}

/* ------------------------------------------------------------------------------------------------
 * Tokenizer
 * ---------------------------------------------------------------------------------------------- */

/**
 * @typedef {object} Token
 * @property {'id'|'num'|'str'|'tpl'|'regex'|'punct'|'eof'} type
 * @property {string|number|undefined} value cooked value for `id` / `num` / `str` / `tpl` / `regex`, the raw text for `punct`
 * @property {number} start
 * @property {number} end exclusive
 * @property {boolean} [hasSubstitutions] template literals only
 * @property {string} [raw]
 */

/**
 * @typedef {object} Comment
 * @property {'line'|'block'} kind
 * @property {number} start
 * @property {number} end exclusive
 * @property {string} text raw text including the delimiters
 */

/**
 * Tokenize a whole TypeScript script. Comments are collected separately; template literals are
 * opaque single tokens (their `${...}` bodies are not analyzed — see the module deviations).
 *
 * @param {string} code normalized source
 * @returns {{ tokens: Token[], comments: Comment[], error: { message: string, offset: number } | null }}
 */
function tokenize(code) {
  /** @type {Token[]} */
  const tokens = [];
  /** @type {Comment[]} */
  const comments = [];
  let i = 0;
  const length = code.length;

  /** @param {number} at @returns {Token | undefined} */
  const previous = (at) => tokens[at - 1];

  while (i < length) {
    const char = code[i];
    const codePoint = code.codePointAt(i) ?? 0;

    // Whitespace, including the Unicode space separators a model may paste in.
    if (char === ' ' || char === '\t' || char === '\n' || char === '\u000b' || char === '\u000c' || char === '\u00a0' || char === '\ufeff' || (codePoint > 0x2000 && /\s/u.test(char))) {
      i += 1;
      continue;
    }

    // Comments.
    if (char === '/' && code[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < length && code[i] !== '\n') i += 1;
      comments.push({ kind: 'line', start, end: i, text: code.slice(start, i) });
      continue;
    }
    if (char === '/' && code[i + 1] === '*') {
      const start = i;
      const close = code.indexOf('*/', i + 2);
      if (close < 0) {
        return { tokens, comments, error: { message: 'unterminated comment', offset: start } };
      }
      i = close + 2;
      comments.push({ kind: 'block', start, end: i, text: code.slice(start, i) });
      continue;
    }

    // Strings.
    if (char === '\'' || char === '"') {
      const scanned = scanQuoted(code, i, char);
      if (scanned === null) {
        return { tokens, comments, error: { message: 'unterminated string constant', offset: i } };
      }
      tokens.push({ type: 'str', value: scanned.value, start: i, end: scanned.end, raw: code.slice(i, scanned.end) });
      i = scanned.end;
      continue;
    }

    // Template literals: one opaque token.
    if (char === '`') {
      const scanned = scanTemplate(code, i);
      if (scanned === null) {
        return { tokens, comments, error: { message: 'unterminated template literal', offset: i } };
      }
      tokens.push({
        type: 'tpl',
        value: scanned.hasSubstitutions ? undefined : scanned.value,
        hasSubstitutions: scanned.hasSubstitutions,
        start: i,
        end: scanned.end,
        raw: code.slice(i, scanned.end),
      });
      i = scanned.end;
      continue;
    }

    // Regular expression literals, when the previous token can precede one.
    if (char === '/' && regexAllowed(previous(tokens.length))) {
      const scanned = scanRegex(code, i);
      if (scanned !== null) {
        tokens.push({ type: 'regex', value: undefined, start: i, end: scanned.end, raw: code.slice(i, scanned.end) });
        i = scanned.end;
        continue;
      }
    }

    // Numbers.
    if (isDigit(char) || (char === '.' && isDigit(code[i + 1] ?? ''))) {
      const end = scanNumber(code, i);
      tokens.push({ type: 'num', value: Number(code.slice(i, end).replace(/_/g, '')), start: i, end, raw: code.slice(i, end) });
      i = end;
      continue;
    }

    // Identifiers, including non-ASCII ones (Chinese phase/agent names are expected).
    if (isIdentifierStart(codePoint)) {
      const start = i;
      i += char.length;
      while (i < length) {
        const next = code.codePointAt(i) ?? 0;
        if (!isIdentifierPart(next)) break;
        i += String.fromCodePoint(next).length;
      }
      tokens.push({ type: 'id', value: code.slice(start, i), start, end: i, raw: code.slice(start, i) });
      continue;
    }

    // Punctuators, longest match first.
    let matched = null;
    for (const punctuator of PUNCTUATORS) {
      if (code.startsWith(punctuator, i)) {
        // `?.` followed by a digit is a conditional `?` and a `.5` number, not optional chaining.
        if (punctuator === '?.' && isDigit(code[i + 2] ?? '')) continue;
        matched = punctuator;
        break;
      }
    }
    if (matched !== null) {
      tokens.push({ type: 'punct', value: matched, start: i, end: i + matched.length, raw: matched });
      i += matched.length;
      continue;
    }

    return { tokens, comments, error: { message: `unexpected character ${JSON.stringify(char)}`, offset: i } };
  }

  tokens.push({ type: 'eof', value: undefined, start: length, end: length, raw: '' });
  return { tokens, comments, error: null };
}

/** @param {string} char @returns {boolean} */
function isDigit(char) {
  return char >= '0' && char <= '9';
}

/** @param {number} codePoint @returns {boolean} */
function isIdentifierStart(codePoint) {
  if (codePoint === 0x24 || codePoint === 0x5f) return true; // $ _
  const char = String.fromCodePoint(codePoint);
  return /[\p{ID_Start}]/u.test(char);
}

/** @param {number} codePoint @returns {boolean} */
function isIdentifierPart(codePoint) {
  if (codePoint === 0x24 || codePoint === 0x5f || codePoint === 0x200c || codePoint === 0x200d) return true;
  const char = String.fromCodePoint(codePoint);
  return /[\p{ID_Continue}]/u.test(char);
}

/**
 * Whether a `/` after this token starts a regular expression.
 * @param {Token | undefined} token
 * @returns {boolean}
 */
function regexAllowed(token) {
  if (token === undefined) return true;
  if (token.type === 'num' || token.type === 'str' || token.type === 'tpl' || token.type === 'regex') return false;
  if (token.type === 'id') return REGEX_PRECEDING_KEYWORDS.has(String(token.value));
  const value = String(token.value ?? '');
  if (value === ')' || value === ']' || value === '++' || value === '--') return false;
  return true;
}

/**
 * @param {string} code
 * @param {number} start index of the opening quote
 * @param {string} quote
 * @returns {{ value: string, end: number } | null}
 */
function scanQuoted(code, start, quote) {
  let value = '';
  let i = start + 1;
  while (i < code.length) {
    const char = code[i];
    if (char === '\\') {
      const escaped = readEscape(code, i);
      if (escaped === null) return null;
      value += escaped.value;
      i = escaped.end;
      continue;
    }
    if (char === quote) return { value, end: i + 1 };
    if (char === '\n') return null;
    value += char;
    i += 1;
  }
  return null;
}

/**
 * @param {string} code
 * @param {number} start index of the backslash
 * @returns {{ value: string, end: number } | null}
 */
function readEscape(code, start) {
  const char = code[start + 1];
  if (char === undefined) return null;
  switch (char) {
    case 'n': return { value: '\n', end: start + 2 };
    case 't': return { value: '\t', end: start + 2 };
    case 'r': return { value: '\r', end: start + 2 };
    case 'b': return { value: '\b', end: start + 2 };
    case 'f': return { value: '\f', end: start + 2 };
    case 'v': return { value: '\v', end: start + 2 };
    case '0': return { value: '\0', end: start + 2 };
    case '\n': return { value: '', end: start + 2 };
    case '\r': return { value: '', end: code[start + 2] === '\n' ? start + 3 : start + 2 };
    case 'x': {
      const hex = code.slice(start + 2, start + 4);
      if (!/^[0-9a-fA-F]{2}$/u.test(hex)) return { value: 'x', end: start + 2 };
      return { value: String.fromCharCode(Number.parseInt(hex, 16)), end: start + 4 };
    }
    case 'u': {
      if (code[start + 2] === '{') {
        const close = code.indexOf('}', start + 3);
        if (close < 0) return { value: 'u', end: start + 2 };
        const hex = code.slice(start + 3, close);
        if (!/^[0-9a-fA-F]+$/u.test(hex)) return { value: 'u', end: start + 2 };
        return { value: String.fromCodePoint(Number.parseInt(hex, 16)), end: close + 1 };
      }
      const hex = code.slice(start + 2, start + 6);
      if (!/^[0-9a-fA-F]{4}$/u.test(hex)) return { value: 'u', end: start + 2 };
      return { value: String.fromCharCode(Number.parseInt(hex, 16)), end: start + 6 };
    }
    default:
      return { value: char, end: start + 2 };
  }
}

/**
 * Scan one template literal (opaque: `${...}` bodies are skipped with brace counting).
 * @param {string} code
 * @param {number} start index of the opening backtick
 * @returns {{ value: string, hasSubstitutions: boolean, end: number } | null}
 */
function scanTemplate(code, start) {
  let i = start + 1;
  let value = '';
  let hasSubstitutions = false;
  while (i < code.length) {
    const char = code[i];
    if (char === '\\') {
      const escaped = readEscape(code, i);
      if (escaped === null) return null;
      value += escaped.value;
      i = escaped.end;
      continue;
    }
    if (char === '`') return { value, hasSubstitutions, end: i + 1 };
    if (char === '$' && code[i + 1] === '{') {
      hasSubstitutions = true;
      const skipped = skipTemplateExpression(code, i + 2);
      if (skipped === null) return null;
      i = skipped;
      continue;
    }
    value += char;
    i += 1;
  }
  return null;
}

/**
 * Skip one `${ ... }` body of a template literal, honouring nested strings/templates/comments.
 * @param {string} code index just after `${`
 * @param {number} start
 * @returns {number | null} index just after the closing `}`
 */
function skipTemplateExpression(code, start) {
  let depth = 1;
  let i = start;
  let previousSignificant = '';
  while (i < code.length) {
    const char = code[i];
    if (char === '\n' || char === ' ' || char === '\t' || char === '\r') {
      i += 1;
      continue;
    }
    if (char === '\'' || char === '"') {
      const scanned = scanQuoted(code, i, char);
      if (scanned === null) return null;
      i = scanned.end;
      previousSignificant = 'value';
      continue;
    }
    if (char === '`') {
      const scanned = scanTemplate(code, i);
      if (scanned === null) return null;
      i = scanned.end;
      previousSignificant = 'value';
      continue;
    }
    if (char === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i += 1;
      continue;
    }
    if (char === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2);
      if (close < 0) return null;
      i = close + 2;
      continue;
    }
    if (char === '{') {
      depth += 1;
      previousSignificant = '{';
      i += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
      previousSignificant = '}';
      continue;
    }
    if (char === '/' && previousSignificant !== 'value' && previousSignificant !== ')' && previousSignificant !== ']') {
      const scanned = scanRegex(code, i);
      if (scanned !== null) {
        i = scanned.end;
        previousSignificant = 'value';
        continue;
      }
    }
    previousSignificant = /[\w$]/.test(char) ? 'value' : char;
    i += 1;
  }
  return null;
}

/**
 * @param {string} code
 * @param {number} start index of the slash
 * @returns {{ end: number } | null}
 */
function scanRegex(code, start) {
  let i = start + 1;
  let inClass = false;
  while (i < code.length) {
    const char = code[i];
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '\n') return null;
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) {
      i += 1;
      while (i < code.length && /[a-z]/u.test(code[i])) i += 1;
      return { end: i };
    }
    i += 1;
  }
  return null;
}

/**
 * @param {string} code
 * @param {number} start
 * @returns {number} index just after the number
 */
function scanNumber(code, start) {
  let i = start;
  const prefix = code.slice(start, start + 2).toLowerCase();
  if (prefix === '0x' || prefix === '0b' || prefix === '0o') {
    i += 2;
    while (i < code.length && /[0-9a-fA-F_]/u.test(code[i])) i += 1;
  } else {
    while (i < code.length && /[0-9_]/u.test(code[i])) i += 1;
    if (code[i] === '.') {
      i += 1;
      while (i < code.length && /[0-9_]/u.test(code[i])) i += 1;
    }
    if (code[i] === 'e' || code[i] === 'E') {
      let probe = i + 1;
      if (code[probe] === '+' || code[probe] === '-') probe += 1;
      if (isDigit(code[probe] ?? '')) {
        i = probe;
        while (i < code.length && /[0-9_]/u.test(code[i])) i += 1;
      }
    }
  }
  if (code[i] === 'n') i += 1;
  return i;
}

/* ------------------------------------------------------------------------------------------------
 * Structure: bracket pairs, frames, statement context
 * ---------------------------------------------------------------------------------------------- */

const FRAME_KINDS = Object.freeze({
  BLOCK: 'block',
  OBJECT: 'object',
  FUNCTION: 'function',
  CLASS: 'class',
  PARAMS: 'params',
  ARGS: 'args',
  ARRAY: 'array',
  INDEX: 'index',
  LOOP: 'loop',
  BRANCH: 'branch',
  CATCH: 'catch',
  SWITCH: 'switch',
});

/**
 * @typedef {object} Structure
 * @property {Token[]} tokens
 * @property {number[]} pairs matching bracket token index (either direction)
 * @property {number[]} parent innermost enclosing opener index, -1 at script level
 * @property {string[]} kinds frame kind of every opener
 */

/**
 * @param {Token[]} tokens
 * @returns {Structure}
 */
function buildStructure(tokens) {
  const count = tokens.length;
  const pairs = new Array(count).fill(-1);
  const parent = new Array(count).fill(-1);
  const kinds = new Array(count).fill('');
  const stack = [];

  for (let i = 0; i < count; i += 1) {
    const token = tokens[i];
    if (token.type === 'punct' && OPENERS.has(String(token.value))) {
      parent[i] = stack.length > 0 ? stack[stack.length - 1] : -1;
      kinds[i] = classifyOpener(tokens, i, pairs, kinds, stack);
      stack.push(i);
      continue;
    }
    if (token.type === 'punct' && CLOSER_TO_OPENER.has(String(token.value))) {
      const want = CLOSER_TO_OPENER.get(String(token.value));
      let index = stack.length - 1;
      while (index >= 0 && tokens[stack[index]].value !== want) index -= 1;
      if (index >= 0) {
        pairs[stack[index]] = i;
        pairs[i] = stack[index];
        stack.length = index;
      }
      parent[i] = stack.length > 0 ? stack[stack.length - 1] : -1;
      continue;
    }
    parent[i] = stack.length > 0 ? stack[stack.length - 1] : -1;
  }

  return { tokens, pairs, parent, kinds };
}

/**
 * @param {Token[]} tokens
 * @param {number} index opener token index
 * @param {number[]} pairs
 * @param {string[]} kinds
 * @param {number[]} stack
 * @returns {string} frame kind
 */
function classifyOpener(tokens, index, pairs, kinds, stack) {
  const token = tokens[index];
  const value = String(token.value);
  const previousIndex = index - 1;
  const previous = previousIndex >= 0 ? tokens[previousIndex] : undefined;
  const enclosingKind = stack.length > 0 ? kinds[stack[stack.length - 1]] || FRAME_KINDS.BLOCK : 'script';

  if (value === '(') {
    if (previous === undefined) return FRAME_KINDS.PARAMS;
    if (previous.type === 'id') {
      const previousValue = String(previous.value);
      if (['if', 'for', 'while', 'switch', 'catch', 'with'].includes(previousValue)) return FRAME_KINDS.PARAMS;
      if (['function', 'async'].includes(previousValue)) return FRAME_KINDS.PARAMS;
      if (previousIndex >= 2 && tokens[previousIndex - 1].value === 'function') return FRAME_KINDS.PARAMS;
      return FRAME_KINDS.ARGS;
    }
    if (previous.type === 'punct' && [')', ']', '?.'].includes(String(previous.value))) return FRAME_KINDS.ARGS;
    return FRAME_KINDS.PARAMS;
  }

  if (value === '[') {
    if (previous === undefined) return FRAME_KINDS.ARRAY;
    if (previous.type === 'id') {
      const previousValue = String(previous.value);
      if (KEYWORDS.has(previousValue) && !['this', 'super', 'true', 'false', 'null'].includes(previousValue)) {
        return previousValue === 'return' || previousValue === 'typeof' || previousValue === 'yield' || previousValue === 'await'
          ? FRAME_KINDS.ARRAY
          : FRAME_KINDS.INDEX;
      }
      return FRAME_KINDS.INDEX;
    }
    if (previous.type === 'punct') {
      const previousValue = String(previous.value);
      if (previousValue === ')' || previousValue === ']') return FRAME_KINDS.INDEX;
      return FRAME_KINDS.ARRAY;
    }
    return FRAME_KINDS.ARRAY;
  }

  // `{`
  if (previous === undefined) return FRAME_KINDS.BLOCK;
  if (previous.type === 'punct') {
    const previousValue = String(previous.value);
    if (previousValue === '=>') return FRAME_KINDS.FUNCTION;
    if (previousValue === ')') {
      const openParen = pairs[previousIndex];
      const before = openParen > 0 ? tokens[openParen - 1] : undefined;
      if (before !== undefined) {
        const beforeValue = String(before.value);
        if (['if', 'while'].includes(beforeValue)) return FRAME_KINDS.BRANCH;
        if (beforeValue === 'for') return FRAME_KINDS.LOOP;
        if (beforeValue === 'switch') return FRAME_KINDS.SWITCH;
        if (beforeValue === 'catch') return FRAME_KINDS.CATCH;
        if (beforeValue === 'with') return FRAME_KINDS.BRANCH;
        if (beforeValue === 'function' || beforeValue === 'async') return FRAME_KINDS.FUNCTION;
      }
      return FRAME_KINDS.FUNCTION;
    }
    if (['=', '(', ',', '[', '?', ':', '||', '&&', '??', '!', '~', '+', '-', '*', '/', '%',
      '<', '>', '<=', '>=', '==', '===', '!=', '!==', '||=', '&&=', '??=', '+=', '-=', '*=', '/='].includes(previousValue)) {
      return FRAME_KINDS.OBJECT;
    }
    return FRAME_KINDS.BLOCK;
  }
  if (previous.type === 'id') {
    const previousValue = String(previous.value);
    const before = previousIndex > 0 ? tokens[previousIndex - 1] : undefined;
    if (previousValue === 'do') return FRAME_KINDS.LOOP;
    if (previousValue === 'try' || previousValue === 'finally') return FRAME_KINDS.BLOCK;
    if (previousValue === 'else') return FRAME_KINDS.BRANCH;
    if (before !== undefined) {
      const beforeValue = String(before.value);
      if (before.type === 'id') {
        if (beforeValue === 'class' || beforeValue === 'extends') return FRAME_KINDS.CLASS;
        if (beforeValue === 'return' || beforeValue === 'yield' || beforeValue === 'await' ||
          beforeValue === 'typeof' || beforeValue === 'in' || beforeValue === 'of' ||
          beforeValue === 'case' || beforeValue === 'default' || beforeValue === 'throw' ||
          beforeValue === 'void' || beforeValue === 'delete' || beforeValue === 'new' ||
          beforeValue === 'instanceof') return FRAME_KINDS.OBJECT;
      }
      if (before.type === 'punct' && String(before.value) === ':') {
        return enclosingKind === FRAME_KINDS.OBJECT || enclosingKind === FRAME_KINDS.ARGS || enclosingKind === FRAME_KINDS.ARRAY
          ? FRAME_KINDS.OBJECT
          : FRAME_KINDS.BLOCK;
      }
    }
    // `name {` — a class heritage, a labelled block, or (rarely) something else.
    return FRAME_KINDS.BLOCK;
  }
  return FRAME_KINDS.BLOCK;
}

/**
 * Frame kinds that make a position "not at the top level" for a preset artifact declaration.
 * @param {string} kind
 * @returns {boolean}
 */
function disqualifiesTopLevel(kind) {
  return kind === FRAME_KINDS.FUNCTION || kind === FRAME_KINDS.CLASS || kind === FRAME_KINDS.LOOP ||
    kind === FRAME_KINDS.BRANCH || kind === FRAME_KINDS.CATCH || kind === FRAME_KINDS.SWITCH;
}

/**
 * Whether a token sits at the script's top level: not inside a function, class, loop, branch or
 * callback body.
 * @param {Structure} structure
 * @param {number} index
 * @returns {boolean}
 */
function isTopLevel(structure, index) {
  let frame = structure.parent[index];
  while (frame >= 0) {
    if (disqualifiesTopLevel(structure.kinds[frame])) return false;
    frame = structure.parent[frame];
  }
  return true;
}

/**
 * The token index that closes the block containing `index` (the matching `}` of the innermost
 * `{}` frame), or the token count for the script body.
 * @param {Structure} structure
 * @param {number} index
 * @returns {number}
 */
function enclosingBlockEnd(structure, index) {
  let frame = structure.parent[index];
  while (frame >= 0) {
    if (structure.tokens[frame].value === '{') {
      const close = structure.pairs[frame];
      return close >= 0 ? close : structure.tokens.length;
    }
    frame = structure.parent[frame];
  }
  return structure.tokens.length;
}

/**
 * Whether a position sits inside an array-method fan-out callback (`xs.map(...)`, `Promise.all(xs.map(...))`).
 * @param {Structure} structure
 * @param {number} index
 * @returns {boolean}
 */
function isInsideFanOutCallback(structure, index) {
  const tokens = structure.tokens;
  let frame = structure.parent[index];
  while (frame >= 0) {
    if (structure.kinds[frame] === FRAME_KINDS.ARGS && isFanOutCallArguments(structure, frame)) {
      // An expression-bodied arrow (`xs.map((p) => p.ask(…))`) has no body frame; the call sits
      // directly inside the fan-out's argument list, after its `=>`.
      for (let i = frame + 1; i < index; i += 1) {
        if (isPunct(tokens[i], '=>') && structure.parent[i] === frame) return true;
      }
    }
    frame = structure.parent[frame];
  }
  return false;
}

/**
 * Whether the `(` at this index belongs to an array-method fan-out call (`xs.map(`).
 * @param {Structure} structure
 * @param {number} argsFrame
 * @returns {boolean}
 */
function isFanOutCallArguments(structure, argsFrame) {
  const callee = argsFrame - 1;
  if (callee < 0) return false;
  const calleeToken = structure.tokens[callee];
  if (calleeToken.type !== 'id') return false;
  if (!FANOUT_METHODS.has(String(calleeToken.value))) return false;
  const dot = callee - 1;
  return dot >= 0 && structure.tokens[dot].type === 'punct' &&
    (structure.tokens[dot].value === '.' || structure.tokens[dot].value === '?.');
}

/* ------------------------------------------------------------------------------------------------
 * Small token helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {Token | undefined} token
 * @returns {boolean}
 */
function isIdentifier(token) {
  return token !== undefined && token.type === 'id';
}

/**
 * @param {Token | undefined} token
 * @param {string} value
 * @returns {boolean}
 */
function isPunct(token, value) {
  return token !== undefined && token.type === 'punct' && token.value === value;
}

/**
 * Whether the token is the identifier `value`.
 * @param {Token | undefined} token
 * @param {string} value
 * @returns {boolean}
 */
function isId(token, value) {
  return token !== undefined && token.type === 'id' && token.value === value;
}

/**
 * The value of a compile-time string literal token: a plain string literal or a template with no
 * substitutions. Anything else is not a compile-time literal.
 * @param {Token | undefined} token
 * @returns {string | undefined}
 */
function literalText(token) {
  if (token === undefined) return undefined;
  if (token.type === 'str') return String(token.value);
  if (token.type === 'tpl' && token.hasSubstitutions === false) return String(token.value ?? '');
  return undefined;
}

/**
 * Split the arguments of a call, given the index of its `(`.
 * @param {Structure} structure
 * @param {number} openParen
 * @returns {{ start: number, end: number }[]} token ranges, `end` exclusive; empty args excluded
 */
function callArguments(structure, openParen) {
  const close = structure.pairs[openParen];
  const tokens = structure.tokens;
  if (close < 0) return [];
  /** @type {{ start: number, end: number }[]} */
  const ranges = [];
  let start = openParen + 1;
  let index = start;
  while (index < close) {
    const token = tokens[index];
    if (token.type === 'punct' && OPENERS.has(String(token.value))) {
      const inner = structure.pairs[index];
      if (inner > index) {
        index = inner + 1;
        continue;
      }
    }
    if (token.type === 'punct' && token.value === ',') {
      if (index > start) ranges.push({ start, end: index });
      index += 1;
      start = index;
      continue;
    }
    index += 1;
  }
  if (close > start) ranges.push({ start, end: close });
  return ranges;
}

/**
 * The single token inside a range, or undefined when the range is empty or holds more than one token.
 * @param {Token[]} tokens
 * @param {{ start: number, end: number }} range
 * @returns {Token | undefined}
 */
function singleToken(tokens, range) {
  return range.end - range.start === 1 ? tokens[range.start] : undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Diagnostic context
 * ---------------------------------------------------------------------------------------------- */

/**
 * @typedef {object} Diagnostic
 * @property {string} path
 * @property {number} line 1-based, in the submitted script
 * @property {number} column 1-based
 * @property {number} code 90xx
 * @property {string} message
 * @property {'error'|'warning'} severity
 */

/**
 * @param {string} code normalized source
 * @param {string} filename
 * @returns {{ code: string, filename: string, diagnostics: Diagnostic[], add: Function }}
 */
function createContext(code, filename) {
  const starts = lineStartIndex(code);
  /** @type {Diagnostic[]} */
  const diagnostics = [];

  /**
   * @param {number} codeNumber
   * @param {string} message
   * @param {number} offset
   * @param {'error'|'warning'} [severity]
   */
  const add = (codeNumber, message, offset, severity = 'error') => {
    const clamped = Math.max(0, Math.min(Math.trunc(offset), code.length));
    const { line, column } = locate(starts, clamped);
    diagnostics.push({ path: filename, line, column, code: codeNumber, message, severity });
  };

  /** @param {number} offset @returns {number} 1-based line */
  const lineAt = (offset) => locate(starts, Math.max(0, Math.min(Math.trunc(offset), code.length))).line;

  return { code, filename, starts, diagnostics, add, lineAt };
}

/**
 * Render one diagnostic the way ZCode does: `{path}:L{line}:C{column} {message}`.
 * @param {Diagnostic} diagnostic
 * @returns {string}
 */
export function formatDiagnostic(diagnostic) {
  return `${diagnostic.path}:L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`;
}

/* ------------------------------------------------------------------------------------------------
 * Type declarations -> JSON schemas
 *
 * ZCode binds an `ask<T>` answer to a schema built from T's TypeScript declaration. Without a type
 * checker this module parses the small, documented subset a workflow script is expected to use:
 * primitives, string/number/boolean literal unions, arrays, object literals, nested interfaces,
 * optional properties, index signatures and JSDoc descriptions. Anything else is reported (9011)
 * with the type's name instead of silently producing a schema that would accept anything.
 * ---------------------------------------------------------------------------------------------- */

/**
 * @typedef {object} TypeDeclaration
 * @property {'interface'|'alias'} kind
 * @property {string} name
 * @property {number} keywordIndex token index of `interface` / `type`
 * @property {number} nameIndex
 * @property {number} [openBrace] interface body opener
 * @property {number} [typeStart] alias right-hand side start
 * @property {string} [unsupported] reason the declaration cannot become a schema
 * @property {string} [description]
 */

/**
 * Collect every `interface X { … }` and `type X = …` declaration in the script.
 * @param {object} ctx
 * @param {Structure} structure
 * @param {Comment[]} comments
 * @returns {{ declarations: Map<string, TypeDeclaration>, schemaOf: (name: string) => { ok: boolean, schema?: object, reason?: string } }}
 */
function collectTypeDeclarations(ctx, structure, comments) {
  const tokens = structure.tokens;
  /** @type {Map<string, TypeDeclaration>} */
  const declarations = new Map();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!isIdentifier(token)) continue;
    const keyword = String(token.value);

    if (keyword === 'interface') {
      const nameToken = tokens[i + 1];
      if (!isIdentifier(nameToken)) continue;
      const name = String(nameToken.value);
      if (declarations.has(name)) continue;
      let cursor = i + 2;
      let unsupported;
      if (isPunct(tokens[cursor], '<')) unsupported = 'generic interface parameters are not supported';
      // Skip `extends Base` clauses; bases are merged when the body is parsed.
      const bases = [];
      while (cursor < tokens.length) {
        if (isPunct(tokens[cursor], '{')) break;
        if (isId(tokens[cursor], 'extends')) {
          cursor += 1;
          while (cursor < tokens.length && isIdentifier(tokens[cursor])) {
            bases.push(String(tokens[cursor].value));
            cursor += 1;
            if (isPunct(tokens[cursor], ',')) cursor += 1;
            else break;
          }
          continue;
        }
        cursor += 1;
      }
      const openBrace = isPunct(tokens[cursor], '{') ? cursor : -1;
      if (openBrace < 0) unsupported = 'its body could not be found';
      declarations.set(name, {
        kind: 'interface',
        name,
        keywordIndex: i,
        nameIndex: i + 1,
        openBrace,
        bases,
        unsupported,
        description: jsDocDescription(comments, ctx.code, token.start),
      });
      i = cursor;
      continue;
    }

    if (keyword === 'type') {
      const nameToken = tokens[i + 1];
      const equals = tokens[i + 2];
      if (!isIdentifier(nameToken) || !isPunct(equals, '=')) continue;
      const name = String(nameToken.value);
      if (declarations.has(name)) continue;
      declarations.set(name, {
        kind: 'alias',
        name,
        keywordIndex: i,
        nameIndex: i + 1,
        typeStart: i + 3,
        unsupported: undefined,
        description: jsDocDescription(comments, ctx.code, token.start),
      });
      i += 2;
      continue;
    }
  }

  /** @type {Map<string, object>} */
  const cache = new Map();
  const resolving = new Set();

  /**
   * @param {string} name
   * @returns {{ ok: boolean, schema?: object, reason?: string }}
   */
  const schemaOf = (name) => {
    const builtin = BUILTIN_SCHEMAS.get(name);
    if (builtin !== undefined) return { ok: true, schema: { ...builtin } };
    const declaration = declarations.get(name);
    if (declaration === undefined) {
      return { ok: false, reason: `"${name}" is not declared in this script` };
    }
    if (cache.has(name)) return { ok: true, schema: cache.get(name) };
    if (declaration.unsupported !== undefined) return { ok: false, reason: declaration.unsupported };
    if (resolving.has(name)) {
      return { ok: false, reason: `"${name}" is recursive, and a recursive type has no finite schema` };
    }
    resolving.add(name);
    const parsed = declaration.kind === 'interface'
      ? parseInterfaceDeclaration(ctx, structure, comments, declaration, schemaOf)
      : parseTypeAliasDeclaration(ctx, structure, comments, declaration, schemaOf);
    resolving.delete(name);
    if (!parsed.ok) return parsed;
    const schema = parsed.schema ?? {};
    if (declaration.description !== undefined && declaration.description.length > 0 && schema.description === undefined) {
      schema.description = declaration.description;
    }
    cache.set(name, schema);
    return { ok: true, schema };
  };

  return { declarations, schemaOf };
}

/**
 * The JSDoc comment immediately above a token, if there is one: only whitespace may separate the
 * comment from the declaration it documents.
 * @param {Comment[]} comments
 * @param {string} code
 * @param {number} tokenStart
 * @returns {string|undefined}
 */
function jsDocDescription(comments, code, tokenStart) {
  /** @type {Comment|undefined} */
  let found;
  for (const comment of comments) {
    if (comment.kind !== 'block') continue;
    if (comment.end > tokenStart) break;
    if (!comment.text.startsWith('/**')) continue;
    if (code.slice(comment.end, tokenStart).trim() !== '') continue;
    found = comment;
  }
  if (found === undefined) return undefined;
  return cleanJsDoc(found.text);
}

/**
 * @param {string} text raw `/** … *\/` comment
 * @returns {string}
 */
function cleanJsDoc(text) {
  const body = text.replace(/^\/\*\*?/u, '').replace(/\*\/$/u, '');
  const lines = body.split('\n').map((line) => line.replace(/^\s*\*?\s?/u, '').replace(/\s+$/u, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n').trim();
}

/**
 * @param {object} ctx
 * @param {Structure} structure
 * @param {Comment[]} comments
 * @param {TypeDeclaration} declaration
 * @param {(name: string) => { ok: boolean, schema?: object, reason?: string }} schemaOf
 * @returns {{ ok: boolean, schema?: object, reason?: string }}
 */
function parseInterfaceDeclaration(ctx, structure, comments, declaration, schemaOf) {
  if (declaration.openBrace === undefined || declaration.openBrace < 0) {
    return { ok: false, reason: `the body of "${declaration.name}" could not be found` };
  }
  const body = parseObjectMembers(ctx, structure, comments, declaration.openBrace, declaration.name, schemaOf);
  if (!body.ok) return body;
  /** @type {Record<string, object>} */
  const properties = { ...body.properties };
  /** @type {string[]} */
  const required = [...body.required];
  for (const base of declaration.bases ?? []) {
    const resolved = schemaOf(base);
    if (!resolved.ok) return { ok: false, reason: `"${declaration.name}" extends "${base}", which ${resolved.reason ?? 'cannot be turned into a schema'}` };
    const baseSchema = resolved.schema ?? {};
    if (baseSchema.properties !== undefined && typeof baseSchema.properties === 'object') {
      for (const [key, value] of Object.entries(baseSchema.properties)) {
        if (properties[key] === undefined) properties[key] = value;
      }
    }
    for (const key of baseSchema.required ?? []) {
      if (!required.includes(key)) required.push(key);
    }
  }
  return { ok: true, schema: objectSchema(properties, required, body.additionalProperties === undefined ? {} : { additionalProperties: body.additionalProperties }) };
}

/**
 * @param {object} ctx
 * @param {Structure} structure
 * @param {Comment[]} comments
 * @param {TypeDeclaration} declaration
 * @param {(name: string) => { ok: boolean, schema?: object, reason?: string }} schemaOf
 * @returns {{ ok: boolean, schema?: object, reason?: string }}
 */
function parseTypeAliasDeclaration(ctx, structure, comments, declaration, schemaOf) {
  const start = declaration.typeStart ?? -1;
  if (start < 0) return { ok: false, reason: `the right-hand side of "${declaration.name}" could not be found` };
  const parsed = parseTypeNode(ctx, structure, comments, start, schemaOf);
  if (!parsed.ok) {
    return { ok: false, reason: `"${declaration.name}" uses ${parsed.reason}` };
  }
  return { ok: true, schema: parsed.schema };
}

/**
 * @param {Record<string, object>} properties
 * @param {string[]} required
 * @param {object} [extra]
 * @returns {object}
 */
function objectSchema(properties, required, extra) {
  /** @type {Record<string, object>} */
  const sorted = {};
  for (const key of Object.keys(properties).sort()) sorted[key] = properties[key];
  return {
    type: 'object',
    properties: sorted,
    required: [...required].sort(),
    additionalProperties: false,
    ...(extra ?? {}),
  };
}

/**
 * Parse the members of an interface body or object type literal.
 * @param {object} ctx
 * @param {Structure} structure
 * @param {Comment[]} comments
 * @param {number} openBrace token index of `{`
 * @param {string} owner name used in diagnostics
 * @returns {{ ok: boolean, properties?: Record<string, object>, required?: string[], reason?: string }}
 */
function parseObjectMembers(ctx, structure, comments, openBrace, owner, schemaOf) {
  const tokens = structure.tokens;
  const close = structure.pairs[openBrace];
  if (close < 0) return { ok: false, reason: `the body of "${owner}" is not closed` };
  /** @type {Record<string, object>} */
  const properties = {};
  /** @type {string[]} */
  const required = [];
  /** @type {object|undefined} */
  let additionalProperties;
  let after = openBrace + 1;

  while (after < close) {
    const token = tokens[after];
    if (isPunct(token, ';') || isPunct(token, ',')) {
      after += 1;
      continue;
    }
    const memberStartToken = token;
    let cursor = after;
    if (isId(tokens[cursor], 'readonly')) cursor += 1;

    // Index signature: `[key: string]: T`.
    if (isPunct(tokens[cursor], '[')) {
      const bracketClose = structure.pairs[cursor];
      if (bracketClose < 0 || bracketClose >= close) return { ok: false, reason: `an index signature in "${owner}" is not closed` };
      const colon = tokens[bracketClose + 1];
      if (!isPunct(colon, ':')) return { ok: false, reason: `an index signature in "${owner}" has no value type` };
      const parsed = parseTypeNode(ctx, structure, comments, bracketClose + 2, schemaOf);
      if (!parsed.ok) return { ok: false, reason: `an index signature in "${owner}" uses ${parsed.reason}` };
      additionalProperties = parsed.schema;
      after = parsed.end;
      if (isPunct(tokens[after], ';') || isPunct(tokens[after], ',')) after += 1;
      continue;
    }

    if (!isIdentifier(tokens[cursor]) && tokens[cursor].type !== 'str' && tokens[cursor].type !== 'num') {
      return { ok: false, reason: `a member of "${owner}" could not be read at ${describeToken(tokens[cursor])}` };
    }
    const name = String(tokens[cursor].value);
    cursor += 1;
    let optional = false;
    if (isPunct(tokens[cursor], '?')) {
      optional = true;
      cursor += 1;
    }
    if (isPunct(tokens[cursor], '(')) {
      return { ok: false, reason: `"${owner}" declares the method ${name}(); a schema can only describe data` };
    }
    if (!isPunct(tokens[cursor], ':')) {
      return { ok: false, reason: `the member "${name}" of "${owner}" has no type annotation` };
    }
    const parsed = parseTypeNode(ctx, structure, comments, cursor + 1, schemaOf);
    if (!parsed.ok) return { ok: false, reason: `"${name}" of "${owner}" uses ${parsed.reason}` };
    const description = jsDocDescription(comments, ctx.code, memberStartToken.start);
    const schema = { ...parsed.schema };
    if (description !== undefined && description.length > 0 && schema.description === undefined) {
      schema.description = description;
    }
    properties[name] = schema;
    if (!optional) required.push(name);
    after = parsed.end;
    if (isPunct(tokens[after], ';') || isPunct(tokens[after], ',')) after += 1;
  }

  return {
    ok: true,
    properties,
    required,
    ...(additionalProperties === undefined ? {} : { additionalProperties }),
  };
}

/**
 * @param {Token} token
 * @returns {string}
 */
function describeToken(token) {
  if (token === undefined) return 'the end of the script';
  if (token.type === 'id' || token.type === 'punct') return `\`${String(token.value)}\``;
  if (token.type === 'eof') return 'the end of the script';
  return 'an unexpected token';
}

/**
 * Parse one type expression into a JSON schema.
 * @param {object} ctx
 * @param {Structure} structure
 * @param {Comment[]} comments
 * @param {number} start token index
 * @param {(name: string) => { ok: boolean, schema?: object, reason?: string }} schemaOf
 * @returns {{ ok: boolean, schema?: object, end: number, reason?: string }}
 */
function parseTypeNode(ctx, structure, comments, start, schemaOf) {
  const parsed = parseUnionType(ctx, structure, comments, start, schemaOf);
  if (!parsed.ok) return parsed;
  return parsed;
}

/**
 * @param {object} ctx
 * @param {Structure} structure
 * @param {Comment[]} comments
 * @param {number} start
 * @param {Function} schemaOf
 * @returns {{ ok: boolean, schema?: object, end: number, reason?: string }}
 */
function parseUnionType(ctx, structure, comments, start, schemaOf) {
  const first = parsePostfixType(ctx, structure, comments, start, schemaOf);
  if (!first.ok) return first;
  const members = [first];
  let cursor = first.end;
  while (isPunct(structure.tokens[cursor], '|')) {
    const next = parsePostfixType(ctx, structure, comments, cursor + 1, schemaOf);
    if (!next.ok) return next;
    members.push(next);
    cursor = next.end;
  }
  if (members.length === 1) return first;

  const enumValues = [];
  let allLiteral = true;
  const survivors = [];
  for (const member of members) {
    const schema = member.schema ?? {};
    const keys = Object.keys(schema);
    const isLiteral = keys.length === 1 && schema.enum !== undefined;
    if (isLiteral) {
      enumValues.push(...schema.enum);
      survivors.push(member);
      continue;
    }
    if (schema.type === 'null' || schema.type === 'undefined') continue;
    allLiteral = false;
    survivors.push(member);
  }
  if (allLiteral) return { ok: true, schema: { enum: enumValues }, end: cursor };
  if (survivors.length === 1) return { ok: true, schema: survivors[0].schema, end: cursor };
  return { ok: false, reason: 'a union of object types, which a schema cannot describe', end: cursor };
}

/**
 * @param {object} ctx
 * @param {Structure} structure
 * @param {Comment[]} comments
 * @param {number} start
 * @param {Function} schemaOf
 * @returns {{ ok: boolean, schema?: object, end: number, reason?: string }}
 */
function parsePostfixType(ctx, structure, comments, start, schemaOf) {
  let parsed = parsePrimaryType(ctx, structure, comments, start, schemaOf);
  if (!parsed.ok) return parsed;
  const tokens = structure.tokens;
  let cursor = parsed.end;
  let schema = parsed.schema ?? {};
  while (isPunct(tokens[cursor], '[') && isPunct(tokens[cursor + 1], ']')) {
    schema = { type: 'array', items: schema };
    cursor += 2;
  }
  return { ...parsed, schema, end: cursor };
}

/**
 * @param {object} ctx
 * @param {Structure} structure
 * @param {Comment[]} comments
 * @param {number} start
 * @param {Function} schemaOf
 * @returns {{ ok: boolean, schema?: object, end: number, reason?: string }}
 */
function parsePrimaryType(ctx, structure, comments, start, schemaOf) {
  const tokens = structure.tokens;
  let index = start;
  while (isId(tokens[index], 'readonly')) index += 1;
  const token = tokens[index];
  if (token === undefined) return { ok: false, reason: 'a missing type', end: index };

  if (isPunct(token, '(')) {
    const parsed = parseTypeNode(ctx, structure, comments, index + 1, schemaOf);
    if (!parsed.ok) return parsed;
    let end = parsed.end;
    if (isPunct(tokens[end], ')')) end += 1;
    else return { ok: false, reason: 'an unbalanced parenthesized type', end };
    return { ...parsed, end };
  }

  if (isPunct(token, '{')) {
    const body = parseObjectMembers(ctx, structure, comments, index, 'an inline object type', schemaOf);
    if (!body.ok) return { ok: false, reason: body.reason, end: index };
    const close = structure.pairs[index];
    return {
      ok: true,
      schema: objectSchema(body.properties, body.required, body.additionalProperties === undefined ? {} : { additionalProperties: body.additionalProperties }),
      end: close >= 0 ? close + 1 : index + 1,
    };
  }

  if (isPunct(token, '[')) {
    return { ok: false, reason: 'a tuple type, which a schema cannot describe', end: index };
  }

  if (token.type === 'str') {
    return { ok: true, schema: { enum: [String(token.value)] }, end: index + 1 };
  }
  if (token.type === 'num') {
    return { ok: true, schema: { enum: [Number(token.value)] }, end: index + 1 };
  }
  if (isPunct(token, '-') && tokens[index + 1]?.type === 'num') {
    return { ok: true, schema: { enum: [-Number(tokens[index + 1].value)] }, end: index + 2 };
  }

  if (!isIdentifier(token)) return { ok: false, reason: `${describeToken(token)} is not a type`, end: index };
  const name = String(token.value);

  if (name === 'true' || name === 'false') {
    return { ok: true, schema: { enum: [name === 'true'] }, end: index + 1 };
  }
  if (name === 'string' || name === 'number' || name === 'boolean' || name === 'null') {
    return { ok: true, schema: { type: name }, end: index + 1 };
  }
  if (name === 'any' || name === 'unknown' || name === 'undefined' || name === 'void' || name === 'never' || name === 'object') {
    return { ok: true, schema: {}, end: index + 1 };
  }
  if (name === 'Array' || name === 'ReadonlyArray') {
    if (!isPunct(tokens[index + 1], '<')) return { ok: false, reason: `${name} without an element type`, end: index + 1 };
    const inner = parseTypeNode(ctx, structure, comments, index + 2, schemaOf);
    if (!inner.ok) return inner;
    let end = inner.end;
    if (isPunct(tokens[end], '>')) end += 1;
    else return { ok: false, reason: `${name}<…> without its closing \`>\``, end };
    return { ok: true, schema: { type: 'array', items: inner.schema }, end };
  }
  if (name === 'Record') {
    if (!isPunct(tokens[index + 1], '<')) return { ok: false, reason: 'Record without its key and value types', end: index + 1 };
    const key = parseTypeNode(ctx, structure, comments, index + 2, schemaOf);
    if (!key.ok) return key;
    if (!isPunct(tokens[key.end], ',')) return { ok: false, reason: 'Record with one type argument', end: key.end };
    const value = parseTypeNode(ctx, structure, comments, key.end + 1, schemaOf);
    if (!value.ok) return value;
    let end = value.end;
    if (isPunct(tokens[end], '>')) end += 1;
    else return { ok: false, reason: 'Record without its closing `>`', end };
    return { ok: true, schema: { type: 'object', additionalProperties: value.schema }, end };
  }
  if (name === 'Promise' || name === 'PromiseLike' || name === 'Map' || name === 'Set' || name === 'Date' ||
    name === 'Function' || name === 'Error' || name === 'typeof' || name === 'keyof' || name === 'infer' ||
    name === 'unique' || name === 'symbol' || name === 'bigint') {
    return { ok: false, reason: `\`${name}\`, which a schema cannot describe`, end: index + 1 };
  }
  if (isPunct(tokens[index + 1], '<')) {
    return { ok: false, reason: `a generic type (\`${name}<…>\`)`, end: index + 1 };
  }

  const resolved = schemaOf(name);
  if (!resolved.ok) return { ok: false, reason: resolved.reason ?? `"${name}" cannot be turned into a schema`, end: index + 1 };
  return { ok: true, schema: resolved.schema, end: index + 1 };
}
/* ------------------------------------------------------------------------------------------------
 * Verbatim diagnostic messages (docs/recon/zcode-host.md §3.3, extracted from zcode.cjs)
 * ---------------------------------------------------------------------------------------------- */

const MESSAGES = Object.freeze({
  phaseLiteral: 'phase()\'s argument must be a compile-time string literal ("gate" or a no-substitution template): the script\'s phase names are fixed when it is submitted, because they label the graph the user confirms before anything runs. Write the name inline — a name that only exists at run time cannot be drawn.',
  phaseEmpty: 'phase("") has no name to show: the phase label is what the confirmation graph draws. Give the group a word ("preflight", "gate", "wrap-up"), or drop the marker — a script with no markers is perfectly legal and is drawn step by step.',
  phaseStandalone: 'phase("…") must stand alone as its own statement. The marker claims the rest of the block it stands in, so one in expression position (a variable initializer, an argument, a ternary arm) has no rest-of-block to claim. Put the call on its own line at the head of the steps it names.',
  phaseMissing: 'a workflow script needs at least one phase("…") marker: the phases are the graph the user approves before anything runs, and a run with none is drawn as a wall of steps. Add a phase at the head of each stage.',
  worldLiteral: 'world.run\'s first argument must be a compile-time string literal ("lean" or a no-substitution template): the script\'s command set is shown to the user at confirmation and only those commands are executable. Move the command name out of the variable/template, and put runtime values in the args array instead.',
  duplicateActor: (name, firstLine) => `two actors are named "${name}" (the first is on line ${firstLine}): an actor name must be unique within a run. The name is the identity key an amended re-run matches its imported cache against, and any run can become the predecessor of one, so a repeated name makes that match ambiguous. Give this one its own name, or drop the name entirely — anonymous actors are legal (they just never reuse cached work).`,
  actorInFanOut: (name) => `this agent(...) runs once per element of a fan-out but its name "${name}" is a fixed string, so every element creates a different actor under the same name — the run fails with DuplicateActorName as soon as the collection holds more than one item. An actor name must be unique within a run: it is the identity key an amended re-run matches its imported cache against. Build a per-element name (\`${name}-\${item}\`), or drop the name — anonymous actors are legal (they just never reuse cached work).`,
  holeTypeArgument: 'hole() needs an explicit type argument (hole<Plan>(...)): the type is the contract the fill is compiled against, and an inferred unknown is no contract. Write what the rest of the script needs from the hole.',
  holeNameLiteral: 'hole()\'s name must be a compile-time string literal: it is the hole\'s phase name and the identity every surface shows (the station, the notification, the fill file). Write it inline.',
  holeNameEmpty: 'hole("") has no name to show. Give the gap a word in the user\'s language ("决定分组", "choose the plan"); it labels the station and the notification.',
  holeNameLong: (limit) => `hole()'s name is longer than ${limit} characters; a phase name is a label, not a paragraph.`,
  holeNotAwaited: 'hole() must be awaited where it is called (await hole<T>(...) or return await hole<T>(...)): the script must not run past a gap that has no value yet.',
  holeInFanOut: 'hole() cannot stand inside a fan-out callback (xs.map(...), Promise.all(xs.map(...)) and the other per-element array methods): the elements run concurrently, so its fill would have to be written while they are already running. Hoist the decision out of the callback, or use a loop (for, for...of, while), where one round waits and the fill runs in every later round.',
  holeBodyNotArrow: 'hole()\'s body must be an inline async arrow (async () => { ... }): a fill is spliced into the script as text, so a function held in a variable has nothing to splice.',
  holeDuplicate: (name) => `two holes are named "${name}"; a hole's name is its identity and must be unique among the script's holes and phase markers.`,
  holePhaseCollision: (name) => `hole "${name}" shares its name with a phase("${name}") marker; a hole is a phase of its own, so the name must be unique among holes and markers.`,
  artifactIdLiteral: 'an artifact id must be a compile-time string literal ("report" or a no-substitution template): the set of artifacts a run can publish is fixed when the script is submitted, so it can be listed before anything runs. Write the id inline; put the runtime value in the title instead (artifact.file("report", path, { title: `Report for ${name}` })).',
  artifactIdEmpty: 'an artifact id must not be empty: it is the identity the card, the version history and the report tag all key off. Give it a short stable name ("book", "perf", "coverage").',
  artifactIdLong: (name, length, limit) => `artifact id "${name}" is ${length} characters; the limit is ${limit}. The id is a key, not a description — put the prose in the title.`,
  artifactIdCharacters: (name) => `artifact id "${name}" contains characters outside [A-Za-z0-9_.-]. The id is carried verbatim through the journal, the artifact store and the side pane, so it is restricted to characters that need no escaping anywhere ("build-log", "perf.p95").`,
  artifactKindConflict: (name, firstKind, firstLine, kind) => `artifact id "${name}" is used with two different kinds: artifact.${firstKind} on line ${firstLine} and artifact.${kind} here. Within one run an id belongs to exactly one kind — publishing it again is what mints the next VERSION, and a version cannot change what the thing is. Give this one its own id.`,
  artifactUnknownKind: (kind) => `artifact has no member "${kind}": the kinds are file and markdown (content, published once per call) and chart, table, metrics and board (presets, fed by report(item, id)).`,
  artifactPrimaryConflict: (name, otherId, otherKind, otherLine) => `artifact "${name}" is marked primary, but "${otherId}" already is (artifact.${otherKind} on line ${otherLine}). A run has one deliverable — the card and the run pane lead with it. Drop primary from one of them, or publish this content as a new version of the other id.`,
  presetInCallback: 'a preset artifact declared inside a callback: hoist it to the top level and declare it once. A preset is a declaration, not a step — it says how the items tagged with its id are drawn, and the tagged report() calls are what fill it in. Declaring it where the callback runs buries it: move artifact.<kind>("<id>", spec) to the head of the script and keep only report(item, "<id>") in the callback.',
  presetInBranch: 'a preset artifact declared inside a conditional branch: hoist it to the top level and declare it once. The card should exist from the moment the run starts (it is legitimately empty until the first tagged report arrives), and a declaration that may or may not have run is a card that may or may not exist. Declare it unconditionally and let the branch decide what to report.',
  presetInLoop: 'a preset artifact declared inside a loop: hoist it to the top level and declare it once. A preset is declared once and fed many times — the loop body is where report(item, "<id>") belongs, not the declaration. Re-declaring the same spec is a no-op, but re-declaring it with a different spec fails the whole run, so the loop is the wrong place for it either way.',
  reportTagLiteral: 'report()\'s artifact tag must be a compile-time string literal naming a preset artifact declared in this script: the tag is how an item finds its dashboard, and a tag that only exists at run time cannot be checked against the declarations. Write the id inline.',
  reportTagContent: (tag) => `report()'s tag "${tag}" names a file/markdown artifact, which holds content rather than a stream of items — there is nothing for this item to become. Tag the item with a preset artifact (chart / table / metrics / board), or drop the tag and let the item go to the Run's Results.`,
  reportTagUnknown: (tag, presets) => `report()'s tag "${tag}" names no preset artifact declared in this script${presets}. Declare it first — artifact.chart("${tag}", { x, y }) at the top of the script — or drop the tag.`,
  reportTagNoPresets: ' (this script declares no preset artifacts at all)',
  declareModifier: 'The `declare` modifier is not allowed in a workflow script: the script is compiled inside a function body, where ambient declarations are illegal. Remove `declare` and write a plain declaration (e.g. `interface Foo { ... }`).',
  exportStatement: '`export` is not allowed in a workflow script: the script is compiled inside a function body. Remove `export` — the workflow\'s output is its final `return` value.',
  importStatement: '`import` is not allowed in a workflow script: the script is compiled inside a function body, so it has no module graph. The facade (agent, world, files, git, artifact) is its whole outside world; remove the import.',
  modelLiteral: 'model() takes the model name as a non-empty string literal (a model id or "providerId/modelId", optionally with "$level"): every model a script can use is checked against the configured models before the run starts. Put runtime choices in which ModelRef you pass, not in the name.',
  askTypeUnsupported: (text) => `ask<${text}> needs an interface or type alias declared in this script: the runtime validates the subagent's answer against a schema built from that declaration, and this type argument is not one this compiler can build a schema from. Declare \`interface ${text.replace(/\[\]$/u, '')} { … }\` and pass its name (an array of it as \`Name[]\`).`,
  askTypeUndeclared: (name) => `ask<${name}> needs an interface declared in this script: the runtime validates the subagent's answer against a schema built from that declaration, and "${name}" is not declared here. Define \`interface ${name} { … }\` (a plain interface, no declare) or drop the type argument to take the answer as text.`,
  emptyScript: 'the workflow script is empty: it needs at least a phase("…") marker and a step (an agent ask, a world.run, or a return value).',
  syntax: (message) => `the script does not parse: ${message}`,
  snippetAbsent: (name) => `${name}() does not exist in a snippet: a snippet is the test bench for the fixed logic of a script, not for orchestration — agent(), phase(), report(), artifact.*, hole() and model() are absent. Run the orchestration through the workflow tool instead.`,
  forbiddenGlobal: (name) => `${name} is not available in a workflow script: Node and web APIs are not reachable from a script. Use world.run for a command, files/git for the workspace, and a subagent for anything else.`,
  forbiddenClock: 'Date.now() is not available in a workflow script: a replayable run cannot read the clock. The run records wall-clock times for you; if a step needs the time, pass it in through args.',
  forbiddenRandom: 'Math.random() is not available in a workflow script: a replayable run cannot be random. Derive a stable value from the inputs, or let a subagent choose and record its choice.',
  forbiddenEval: 'eval() is not available in a workflow script: it would run code the compiler never checked. Write the logic in the script.',
  forbiddenFunctionConstructor: 'the Function constructor is not available in a workflow script: it would run code the compiler never checked. Write the function in the script.',
  forbiddenNodeModule: (specifier) => `"${specifier}" cannot be imported in a workflow script: Node builtins are not reachable, and there are no imports. Reach the outside world through world.run, files, git or a subagent.`,
  facadeMisuse: (name) => `facade function '${name}' may only be called directly; taking a reference to it defeats site identity (journal and replay key off call sites).`,
});

/* ------------------------------------------------------------------------------------------------
 * Discovery helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Names the script declares itself; a facade call to a shadowed name is the script's own function.
 * @param {Structure} structure
 * @returns {Set<string>}
 */
function collectDeclaredNames(structure) {
  const tokens = structure.tokens;
  /** @type {Set<string>} */
  const names = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!isIdentifier(token)) continue;
    const value = String(token.value);
    if (value === 'const' || value === 'let' || value === 'var') {
      let cursor = i + 1;
      while (isIdentifier(tokens[cursor])) {
        names.add(String(tokens[cursor].value));
        cursor += 1;
        if (isPunct(tokens[cursor], ',')) cursor += 1;
        else break;
      }
      continue;
    }
    if (value === 'function' || value === 'class') {
      if (isIdentifier(tokens[i + 1])) names.add(String(tokens[i + 1].value));
    }
  }
  // Parameters of function literals.
  for (let i = 0; i < tokens.length; i += 1) {
    if (structure.kinds[i] !== FRAME_KINDS.PARAMS || !isIdentifier(tokens[i])) continue;
    const previous = tokens[i - 1];
    const next = tokens[i + 1];
    if (!(isPunct(previous, '(') || isPunct(previous, ',') || isPunct(previous, '?'))) continue;
    if (isPunct(next, ')') || isPunct(next, ',') || isPunct(next, ':') || isPunct(next, '=') || isPunct(next, '?')) {
      names.add(String(tokens[i].value));
    }
  }
  return names;
}

/**
 * Calls of a bare facade function: `phase(…)`, `agent(…)`, `report(…)`, …
 * @param {Structure} structure
 * @param {string} name
 * @returns {{ callee: number, openParen: number }[]}
 */
function findBareCalls(structure, name) {
  const tokens = structure.tokens;
  /** @type {{ callee: number, openParen: number }[]} */
  const calls = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isId(tokens[i], name)) continue;
    if (isPunct(tokens[i - 1], '.') || isPunct(tokens[i - 1], '?.')) continue;
    if (isPunct(tokens[i + 1], '(')) {
      calls.push({ callee: i, openParen: i + 1 });
      continue;
    }
    // A typed call: `hole<T>(…)`, `model<T>(…)`.
    const range = typeArgumentRange(structure, i);
    if (range !== null) calls.push({ callee: i, openParen: range.close + 1 });
  }
  return calls;
}

/**
 * Calls of a member function: `world.run(…)`, `artifact.chart(…)`.
 * @param {Structure} structure
 * @param {string} object
 * @param {string} member
 * @returns {{ objectToken: number, memberToken: number, openParen: number }[]}
 */
function findMemberCalls(structure, object, member) {
  const tokens = structure.tokens;
  /** @type {{ objectToken: number, memberToken: number, openParen: number }[]} */
  const calls = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isId(tokens[i], object)) continue;
    if (isPunct(tokens[i - 1], '.') || isPunct(tokens[i - 1], '?.')) continue;
    if (!(isPunct(tokens[i + 1], '.') || isPunct(tokens[i + 1], '?.'))) continue;
    if (!isId(tokens[i + 2], member)) continue;
    if (!isPunct(tokens[i + 3], '(')) continue;
    calls.push({ objectToken: i, memberToken: i + 2, openParen: i + 3 });
  }
  return calls;
}

/**
 * Find the type-argument range of a call: `name<…>(`.
 * @param {Structure} structure
 * @param {number} callee token index of the callee
 * @returns {{ open: number, close: number } | null}
 */
function typeArgumentRange(structure, callee) {
  const tokens = structure.tokens;
  if (!isPunct(tokens[callee + 1], '<')) return null;
  let depth = 1;
  let index = callee + 2;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.type === 'punct' && token.value === '<') depth += 1;
    else if (token.type === 'punct' && token.value === '>') {
      depth -= 1;
      if (depth === 0) {
        const after = tokens[index + 1];
        return isPunct(after, '(') ? { open: callee + 1, close: index } : null;
      }
    } else if (isPunct(token, '(') || isPunct(token, ')') || isPunct(token, ';') || isPunct(token, '{') || isPunct(token, '}')) {
      return null;
    }
    index += 1;
  }
  return null;
}

/**
 * Whether a call is a standalone statement: `phase("a");` yes, `const x = phase("a")` no.
 * @param {Structure} structure
 * @param {number} callee
 * @param {number} openParen
 * @returns {boolean}
 */
function isStandaloneStatement(structure, callee, openParen) {
  const tokens = structure.tokens;
  const close = structure.pairs[openParen];
  if (close < 0) return false;
  const previous = tokens[callee - 1];
  if (previous !== undefined) {
    if (isPunct(previous, ';') || isPunct(previous, '{') || isPunct(previous, '}') || isPunct(previous, ')')) {
      // `)` ends a control header (`if (x)`, `for (…)`, `while (…)`) or a parenthesized expression —
      // either way a call after it starts a statement.
    } else if (isId(previous, 'else')) {
      // `else phase("…");`
    } else if (isPunct(previous, ':')) {
      let frame = structure.parent[callee];
      let inSwitch = false;
      while (frame >= 0) {
        if (structure.kinds[frame] === FRAME_KINDS.SWITCH) {
          inSwitch = true;
          break;
        }
        frame = structure.parent[frame];
      }
      if (!inSwitch) return false;
    } else {
      return false;
    }
  }
  const after = tokens[close + 1];
  if (after === undefined || after.type === 'eof') return true;
  if (isPunct(after, ';') || isPunct(after, '}')) return true;
  return lineStartIndexOf(structure, after.start) > lineStartIndexOf(structure, tokens[close].start);
}

/**
 * The offset of the start of the line containing `offset`; used for automatic-semicolon boundaries.
 * @param {Structure} structure
 * @param {number} offset
 * @returns {number}
 */
function lineStartIndexOf(structure, offset) {
  const code = structure.code ?? '';
  const index = code.lastIndexOf('\n', offset - 1);
  return index + 1;
}

/**
 * Whether a token range contains a step: a subagent `ask` or a `world.run`.
 * @param {Structure} structure
 * @param {number} from
 * @param {number} to exclusive
 * @returns {boolean}
 */
function containsStep(structure, from, to) {
  const tokens = structure.tokens;
  const limit = Math.min(to, tokens.length);
  for (let i = Math.max(from, 1); i < limit; i += 1) {
    if (isId(tokens[i], 'ask') && isPunct(tokens[i - 1], '.')) {
      if (isPunct(tokens[i + 1], '(')) return true;
      if (isPunct(tokens[i + 1], '<')) {
        const range = typeArgumentRange(structure, i);
        if (range !== null) return true;
      }
    }
    if (isId(tokens[i], 'world') && isPunct(tokens[i + 1], '.') && isId(tokens[i + 2], 'run') && isPunct(tokens[i + 3], '(')) return true;
    // A hole is a station of its own: its fill adds the asks, so a marker around it shows work.
    if (isId(tokens[i], 'hole') && !isPunct(tokens[i - 1], '.') && !isPunct(tokens[i - 1], '?.')) {
      if (isPunct(tokens[i + 1], '(')) return true;
      if (isPunct(tokens[i + 1], '<') && typeArgumentRange(structure, i) !== null) return true;
    }
  }
  return false;
}

/**
 * Names of local helpers whose bodies contain a step: a phase that only calls one of these still
 * shows work on the graph (ZCode counts inlined helpers).
 * @param {Structure} structure
 * @returns {Set<string>}
 */
function collectStepHelperNames(structure) {
  const tokens = structure.tokens;
  /** @type {Set<string>} */
  const names = new Set();

  /** @param {number} from @param {number} max @returns {number} */
  const nextFunctionBody = (from, max) => {
    for (let i = from; i < tokens.length && i < from + max; i += 1) {
      if (isPunct(tokens[i], '{')) return i;
      if (isPunct(tokens[i], ';')) return -1;
    }
    return -1;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    if (isId(tokens[i], 'function') && isIdentifier(tokens[i + 1])) {
      const open = nextFunctionBody(i + 2, 40);
      if (open < 0) continue;
      const close = structure.pairs[open];
      if (close > open && containsStep(structure, open, close)) names.add(String(tokens[i + 1].value));
      continue;
    }
    if ((isId(tokens[i], 'const') || isId(tokens[i], 'let') || isId(tokens[i], 'var')) && isIdentifier(tokens[i + 1])) {
      let equals = -1;
      for (let j = i + 2; j < tokens.length && j < i + 40; j += 1) {
        if (isPunct(tokens[j], '=')) {
          equals = j;
          break;
        }
        if (isPunct(tokens[j], ';')) break;
      }
      if (equals < 0) continue;
      const open = nextFunctionBody(equals + 1, 40);
      if (open < 0) continue;
      const previous = tokens[open - 1];
      if (!(isPunct(previous, '=>') || isPunct(previous, ')'))) continue;
      const close = structure.pairs[open];
      if (close > open && containsStep(structure, open, close)) names.add(String(tokens[i + 1].value));
    }
  }
  return names;
}

/**
 * Whether a token range calls a local helper by name.
 * @param {Structure} structure
 * @param {number} from
 * @param {number} to
 * @param {string} name
 * @returns {boolean}
 */
function rangeCallsHelper(structure, from, to, name) {
  const tokens = structure.tokens;
  for (let i = Math.max(from, 1); i < Math.min(to, tokens.length); i += 1) {
    if (!isId(tokens[i], name)) continue;
    if (isPunct(tokens[i - 1], '.') || isPunct(tokens[i - 1], '?.')) continue;
    if (isPunct(tokens[i + 1], '(')) return true;
  }
  return false;
}

/**
 * Find a `primary: true` literal inside the object literal at a token range.
 * @param {Structure} structure
 * @param {{ start: number, end: number } | undefined} range
 * @returns {boolean}
 */
function hasPrimaryTrue(structure, range) {
  if (range === undefined) return false;
  const tokens = structure.tokens;
  if (!isPunct(tokens[range.start], '{')) return false;
  const close = structure.pairs[range.start];
  if (close < 0) return false;
  for (let i = range.start + 1; i < close; i += 1) {
    if (!isId(tokens[i], 'primary')) continue;
    if (!isPunct(tokens[i + 1], ':')) continue;
    return isId(tokens[i + 2], 'true');
  }
  return false;
}

/* ------------------------------------------------------------------------------------------------
 * Rule checks
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {object} ctx
 * @param {Structure} structure
 * @param {string} mode
 */
function checkModuleSyntax(ctx, structure) {
  const tokens = structure.tokens;
  const DECLARATION_KEYWORDS = new Set(['const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'namespace', 'module', 'abstract', 'async']);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!isIdentifier(token)) continue;
    const value = String(token.value);
    if (value === 'import') {
      ctx.add(CODE.MODULE_SYNTAX, MESSAGES.importStatement, token.start);
      continue;
    }
    if (value === 'export') {
      ctx.add(CODE.MODULE_SYNTAX, MESSAGES.exportStatement, token.start);
      continue;
    }
    if (value === 'declare' && DECLARATION_KEYWORDS.has(String(tokens[i + 1]?.value))) {
      ctx.add(CODE.MODULE_SYNTAX, MESSAGES.declareModifier, token.start);
    }
  }
}

/**
 * @param {object} ctx
 * @param {Structure} structure
 * @param {Set<string>} declaredNames
 */
function checkForbiddenApis(ctx, structure, declaredNames) {
  const tokens = structure.tokens;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === 'str' || token.type === 'tpl') {
      const text = String(token.value ?? '');
      if (text.startsWith('node:')) ctx.add(CODE.FORBIDDEN_API, MESSAGES.forbiddenNodeModule(text), token.start);
      continue;
    }
    if (!isIdentifier(token)) continue;
    const value = String(token.value);
    const previous = tokens[i - 1];

    if (FORBIDDEN_GLOBAL_NAMES.has(value)) {
      if (isPunct(previous, '.') || isPunct(previous, '?.')) continue;
      // Object keys (`{ process: true }`) and property definitions are not references.
      if (isPunct(tokens[i + 1], ':') && (isPunct(previous, '{') || isPunct(previous, ','))) continue;
      if (declaredNames.has(value)) continue;
      ctx.add(CODE.FORBIDDEN_API, MESSAGES.forbiddenGlobal(value), token.start);
      continue;
    }

    if (value === 'Date' || value === 'Math') {
      if (isPunct(previous, '.') || isPunct(previous, '?.')) continue;
      const entry = FORBIDDEN_STATIC_MEMBERS.find((candidate) => candidate.object === value && isId(tokens[i + 2], candidate.member) && isPunct(tokens[i + 1], '.') && isPunct(tokens[i + 3], '('));
      if (entry !== undefined) {
        ctx.add(CODE.FORBIDDEN_API, value === 'Date' ? MESSAGES.forbiddenClock : MESSAGES.forbiddenRandom, token.start);
      }
      continue;
    }

    if (value === 'eval' && isPunct(tokens[i + 1], '(') && !isPunct(previous, '.')) {
      ctx.add(CODE.FORBIDDEN_API, MESSAGES.forbiddenEval, token.start);
      continue;
    }
    if (value === 'new' && isId(tokens[i + 1], 'Function')) {
      ctx.add(CODE.FORBIDDEN_API, MESSAGES.forbiddenFunctionConstructor, tokens[i + 1].start);
    }
  }
}

/**
 * 9001: a facade callable taken as a value instead of called.
 * @param {object} ctx
 * @param {Structure} structure
 * @param {Set<string>} declaredNames
 */
function checkFacadeMisuse(ctx, structure, declaredNames) {
  if (structure.tokens.length > 4000) return; // large scripts: skip the O(n) heuristic
  const tokens = structure.tokens;
  const CALLABLES = new Set(['agent', 'phase', 'report', 'hole', 'model', 'log', 'channel', 'future']);

  for (let i = 0; i < tokens.length; i += 1) {
    if (!isIdentifier(tokens[i])) continue;
    const value = String(tokens[i].value);
    if (!CALLABLES.has(value)) continue;
    if (declaredNames.has(value)) continue;
    if (isPunct(tokens[i - 1], '.') || isPunct(tokens[i - 1], '?.')) continue;
    if (isPunct(tokens[i + 1], '(')) continue; // called directly: fine
    if (typeArgumentRange(structure, i) !== null) continue; // `channel<T>(…)`: still called directly
    if (isPunct(tokens[i + 1], ':')) continue; // object key or label

    const previous = tokens[i - 1];
    // `const f = phase;` / `f = phase;`
    const declarationLike = isPunct(previous, '=') || isPunct(previous, ',') || isPunct(previous, '(') ||
      isPunct(previous, '[') || isPunct(previous, ':') ||
      isId(previous, 'return') || isId(previous, 'await') || isId(previous, 'typeof');
    if (!declarationLike) continue;
    // A type position (`typeof phase`, `Array<typeof phase>`) is not a reference.
    if (structure.kinds[structure.parent[i]] === FRAME_KINDS.PARAMS) continue;
    ctx.add(CODE.FACADE_MISUSE, MESSAGES.facadeMisuse(value), tokens[i].start);
  }
}

/**
 * 9004: phase markers, plus coverage.
 * @param {object} ctx
 * @param {Structure} structure
 * @param {string} mode
 * @returns {{ markers: { name?: string, callee: number, blockEnd: number }[] }}
 */
function checkPhases(ctx, structure, mode) {
  const tokens = structure.tokens;
  /** @type {{ name?: string, callee: number, blockEnd: number }[]} */
  const markers = [];
  if (mode !== 'workflow') return { markers };

  for (const call of findBareCalls(structure, 'phase')) {
    const args = callArguments(structure, call.openParen);
    let name;
    if (args.length === 0) {
      ctx.add(CODE.PHASE, MESSAGES.phaseLiteral, tokens[call.openParen].start);
    } else {
      const token = singleToken(tokens, args[0]);
      name = literalText(token);
      if (name === undefined) {
        ctx.add(CODE.PHASE, MESSAGES.phaseLiteral, tokens[args[0].start].start);
      } else if (name.trim() === '') {
        ctx.add(CODE.PHASE, MESSAGES.phaseEmpty, tokens[args[0].start].start);
      }
    }
    if (!isStandaloneStatement(structure, call.callee, call.openParen)) {
      ctx.add(CODE.PHASE, MESSAGES.phaseStandalone, tokens[call.callee].start);
    }
    if (name !== undefined && name.trim() !== '') {
      markers.push({ name, callee: call.callee, blockEnd: enclosingBlockEnd(structure, call.callee) });
    }
  }

  if (markers.length === 0) {
    ctx.add(CODE.PHASE, MESSAGES.phaseMissing, 0);
    return { markers };
  }

  const helperNames = collectStepHelperNames(structure);
  /** @type {Map<string, { name: string, callee: number, blockEnd: number }[]>} */
  const groups = new Map();
  for (const marker of markers) {
    const list = groups.get(marker.name) ?? [];
    list.push(marker);
    groups.set(marker.name, list);
  }
  for (const [name, group] of groups) {
    const covered = group.some((marker) => {
      if (containsStep(structure, marker.callee, marker.blockEnd)) return true;
      for (const helper of helperNames) {
        if (rangeCallsHelper(structure, marker.callee, marker.blockEnd, helper)) return true;
      }
      return false;
    });
    if (!covered) {
      ctx.add(
        CODE.PHASE,
        `phase("${name}") has no ask(...) or world.run(...) in the steps it covers: plain script logic is not a stage, so this marker adds a node that shows no progress. Fold it into the phase before or after it, or give it the step that belongs to it.`,
        tokens[group[0].callee].start,
        'warning',
      );
    }
  }
  return { markers };
}

/**
 * 9005 / 9006: agent names.
 * @param {object} ctx
 * @param {Structure} structure
 * @param {string} mode
 * @param {Set<string>} declaredNames
 * @returns {string[]} literal names in source order, deduped
 */
function checkAgents(ctx, structure, mode, declaredNames) {
  if (mode !== 'workflow' || declaredNames.has('agent')) return [];
  const tokens = structure.tokens;
  /** @type {Map<string, number>} */
  const firstSeen = new Map();
  /** @type {string[]} */
  const names = [];
  for (const call of findBareCalls(structure, 'agent')) {
    const args = callArguments(structure, call.openParen);
    if (args.length === 0) continue;
    const name = literalText(singleToken(tokens, args[0]));
    if (name === undefined || name.length === 0) continue; // computed or anonymous: allowed
    const previous = firstSeen.get(name);
    if (previous !== undefined) {
      ctx.add(CODE.DUPLICATE_AGENT, MESSAGES.duplicateActor(name, ctx.lineAt(tokens[previous].start)), tokens[call.callee].start);
    } else {
      firstSeen.set(name, call.callee);
      names.push(name);
    }
    if (isInsideFanOutCallback(structure, call.callee)) {
      ctx.add(CODE.FIXED_ACTOR_NAME, MESSAGES.actorInFanOut(name), tokens[call.callee].start);
    }
  }
  return names;
}

/**
 * 9003: world.run command literals.
 * @param {object} ctx
 * @param {Structure} structure
 * @param {Set<string>} declaredNames
 * @returns {string[]} literal commands, source order, deduped
 */
function checkWorldCommands(ctx, structure, declaredNames) {
  if (declaredNames.has('world')) return [];
  const tokens = structure.tokens;
  /** @type {string[]} */
  const commands = [];
  for (const call of findMemberCalls(structure, 'world', 'run')) {
    const args = callArguments(structure, call.openParen);
    const command = args.length === 0 ? undefined : literalText(singleToken(tokens, args[0]));
    if (command === undefined) {
      ctx.add(CODE.WORLD_COMMAND, MESSAGES.worldLiteral, args.length === 0 ? tokens[call.openParen].start : tokens[args[0].start].start);
      continue;
    }
    if (!commands.includes(command)) commands.push(command);
  }
  return commands;
}

/**
 * 9007 / 9008 / 9009: artifact declarations, preset placement and report tags.
 * @param {object} ctx
 * @param {Structure} structure
 * @param {string} mode
 * @returns {{ artifacts: { id: string, kind: string, primary: boolean }[] }}
 */
function checkArtifactsAndReports(ctx, structure, mode) {
  if (mode !== 'workflow') return { artifacts: [] };
  const tokens = structure.tokens;
  /** @type {Map<string, { kind: string, line: number, primary: boolean }>} */
  const declared = new Map();
  /** @type {{ id: string, kind: string, primary: boolean }[]} */
  const artifacts = [];
  /** @type {{ id: string, kind: string, line: number, nameToken: number } | undefined} */
  let primarySite;

  for (let i = 0; i < tokens.length; i += 1) {
    if (!isId(tokens[i], 'artifact')) continue;
    if (isPunct(tokens[i - 1], '.') || isPunct(tokens[i - 1], '?.')) continue;
    if (!(isPunct(tokens[i + 1], '.') || isPunct(tokens[i + 1], '?.'))) continue;
    if (!isIdentifier(tokens[i + 2])) continue;
    if (!isPunct(tokens[i + 3], '(')) continue;

    const kind = String(tokens[i + 2].value);
    const openParen = i + 3;
    if (!ARTIFACT_KINDS.has(kind)) {
      ctx.add(CODE.ARTIFACT, MESSAGES.artifactUnknownKind(kind), tokens[i + 2].start);
      continue;
    }
    const args = callArguments(structure, openParen);
    const id = args.length === 0 ? undefined : literalText(singleToken(tokens, args[0]));
    if (id === undefined) {
      ctx.add(CODE.ARTIFACT, MESSAGES.artifactIdLiteral, args.length === 0 ? tokens[openParen].start : tokens[args[0].start].start);
      continue;
    }
    const idOffset = tokens[args[0].start].start;
    if (id.length === 0) {
      ctx.add(CODE.ARTIFACT, MESSAGES.artifactIdEmpty, idOffset);
      continue;
    }
    if (id.length > MAX_ARTIFACT_ID_LENGTH) {
      ctx.add(CODE.ARTIFACT, MESSAGES.artifactIdLong(id, id.length, MAX_ARTIFACT_ID_LENGTH), idOffset);
      continue;
    }
    if (!ARTIFACT_ID_PATTERN.test(id)) {
      ctx.add(CODE.ARTIFACT, MESSAGES.artifactIdCharacters(id), idOffset);
      continue;
    }

    const previous = declared.get(id);
    if (previous !== undefined && previous.kind !== kind) {
      ctx.add(CODE.ARTIFACT, MESSAGES.artifactKindConflict(id, previous.kind, previous.line, kind), idOffset);
      continue;
    }

    const primary = hasPrimaryTrue(structure, PRESET_ARTIFACT_KINDS.has(kind) ? args[1] : args[2]);
    if (primary) {
      if (primarySite === undefined) {
        primarySite = { id, kind, line: ctx.lineAt(idOffset), nameToken: args[0].start };
      } else if (primarySite.id !== id) {
        ctx.add(CODE.ARTIFACT, MESSAGES.artifactPrimaryConflict(id, primarySite.id, primarySite.kind, primarySite.line), idOffset);
      }
    }

    if (PRESET_ARTIFACT_KINDS.has(kind) && !isTopLevel(structure, i)) {
      const context = presetHoistingContext(structure, i);
      ctx.add(CODE.PRESET_PLACEMENT, context === 'callback' ? MESSAGES.presetInCallback : context === 'loop' ? MESSAGES.presetInLoop : MESSAGES.presetInBranch, tokens[i].start);
    }

    if (previous === undefined) {
      declared.set(id, { kind, line: ctx.lineAt(idOffset), primary });
      artifacts.push({ id, kind, primary });
    } else if (primary && !previous.primary) {
      previous.primary = true;
      const entry = artifacts.find((candidate) => candidate.id === id);
      if (entry !== undefined) entry.primary = true;
    }
  }

  // report(item, "tag")
  const presetIds = [...declared.entries()].filter(([, value]) => PRESET_ARTIFACT_KINDS.has(value.kind)).map(([id]) => id);
  const presetsText = presetIds.length === 0
    ? MESSAGES.reportTagNoPresets
    : ` (declared presets: ${[...presetIds].sort().map((id) => `"${id}"`).join(', ')})`;
  for (const call of findBareCalls(structure, 'report')) {
    const args = callArguments(structure, call.openParen);
    if (args.length < 2) continue;
    const tagToken = singleToken(tokens, args[1]);
    // `report(item, undefined)` / `report(item, null)` is a legal spelling of "no tag".
    if (tagToken !== undefined && tagToken.type === 'id' && (tagToken.value === 'undefined' || tagToken.value === 'null')) continue;
    if (tagToken === undefined && args[1].end - args[1].start === 2 && isId(tokens[args[1].start], 'void')) continue;
    const tag = literalText(tagToken);
    if (tag === undefined) {
      ctx.add(CODE.REPORT_TAG, MESSAGES.reportTagLiteral, tokens[args[1].start].start);
      continue;
    }
    const artifact = declared.get(tag);
    if (artifact === undefined) {
      ctx.add(CODE.REPORT_TAG, MESSAGES.reportTagUnknown(tag, presetsText), tokens[args[1].start].start, 'warning');
      continue;
    }
    if (!PRESET_ARTIFACT_KINDS.has(artifact.kind)) {
      ctx.add(CODE.REPORT_TAG, MESSAGES.reportTagContent(tag), tokens[args[1].start].start);
    }
  }

  return { artifacts };
}

/**
 * Where a preset artifact was declared: a callback body, a loop body, or a conditional branch.
 * @param {Structure} structure
 * @param {number} index
 * @returns {'callback'|'loop'|'branch'}
 */
function presetHoistingContext(structure, index) {
  let frame = structure.parent[index];
  while (frame >= 0) {
    const kind = structure.kinds[frame];
    if (kind === FRAME_KINDS.LOOP) return 'loop';
    if (kind === FRAME_KINDS.BRANCH || kind === FRAME_KINDS.CATCH || kind === FRAME_KINDS.SWITCH) return 'branch';
    if (kind === FRAME_KINDS.FUNCTION) return 'callback';
    frame = structure.parent[frame];
  }
  return 'branch';
}

/**
 * 9012: hole() rules.
 * @param {object} ctx
 * @param {Structure} structure
 * @param {string} mode
 * @param {{ name?: string }[]} phaseMarkers
 */
function checkHoles(ctx, structure, mode, phaseMarkers) {
  if (mode !== 'workflow') return;
  const tokens = structure.tokens;
  const phaseNames = new Set((phaseMarkers ?? []).map((marker) => marker.name).filter((name) => name !== undefined));
  /** @type {Map<string, number>} */
  const holes = new Map();

  for (const call of findBareCalls(structure, 'hole')) {
    const typeRange = typeArgumentRange(structure, call.callee);
    if (typeRange === null) {
      ctx.add(CODE.HOLE, MESSAGES.holeTypeArgument, tokens[call.callee].start);
    } else {
      // Models named in a hole type are checked at fill time; only the presence matters here.
    }

    const args = callArguments(structure, call.openParen);
    let name;
    if (args.length === 0) {
      ctx.add(CODE.HOLE, MESSAGES.holeNameLiteral, tokens[call.openParen].start);
    } else {
      name = literalText(singleToken(tokens, args[0]));
      if (name === undefined) {
        ctx.add(CODE.HOLE, MESSAGES.holeNameLiteral, tokens[args[0].start].start);
      } else if (name.trim() === '') {
        ctx.add(CODE.HOLE, MESSAGES.holeNameEmpty, tokens[args[0].start].start);
      } else if (name.length > MAX_HOLE_NAME_LENGTH) {
        ctx.add(CODE.HOLE, MESSAGES.holeNameLong(MAX_HOLE_NAME_LENGTH), tokens[args[0].start].start);
      }
    }

    if (name !== undefined && name.trim() !== '' && name.length <= MAX_HOLE_NAME_LENGTH) {
      if (phaseNames.has(name)) {
        ctx.add(CODE.HOLE, MESSAGES.holePhaseCollision(name), tokens[call.callee].start);
      } else if (holes.has(name)) {
        ctx.add(CODE.HOLE, MESSAGES.holeDuplicate(name), tokens[call.callee].start);
      } else {
        holes.set(name, call.callee);
      }
    }

    if (!isId(tokens[call.callee - 1], 'await')) {
      ctx.add(CODE.HOLE, MESSAGES.holeNotAwaited, tokens[call.callee].start);
    }
    if (isInsideFanOutCallback(structure, call.callee)) {
      ctx.add(CODE.HOLE, MESSAGES.holeInFanOut, tokens[call.callee].start);
    }

    // The body, when passed, must be an inline async arrow rather than a held reference.
    const bodyRange = args.length === 3 ? args[2] : args.length === 2 ? args[1] : undefined;
    if (bodyRange !== undefined) {
      const bodyToken = singleToken(tokens, bodyRange);
      if (bodyToken !== undefined && bodyToken.type === 'id') {
        ctx.add(CODE.HOLE, MESSAGES.holeBodyNotArrow, bodyToken.start);
      }
    }
  }
}

/**
 * String constants the script declares at any scope: `const MODEL = "provider/model" as const;`.
 * A model name written once and reused keeps working without forcing it back inline.
 * @param {Structure} structure
 * @returns {Map<string, string>}
 */
function collectStringConstants(structure) {
  const tokens = structure.tokens;
  /** @type {Map<string, string>} */
  const constants = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isId(tokens[i], 'const') || !isIdentifier(tokens[i + 1])) continue;
    if (!isPunct(tokens[i + 2], '=')) continue;
    const value = literalText(tokens[i + 3]);
    if (value === undefined) continue;
    const after = tokens[i + 4];
    const endsValue = after === undefined || after.type === 'eof' || isPunct(after, ';') ||
      isPunct(after, ',') || isPunct(after, '}') || isId(after, 'as');
    if (!endsValue) continue;
    constants.set(String(tokens[i + 1].value), value);
  }
  return constants;
}

/**
 * 9011: model() takes a literal model name.
 * @param {object} ctx
 * @param {Structure} structure
 * @param {string} mode
 */
function checkModels(ctx, structure, mode) {
  if (mode !== 'workflow') return;
  const tokens = structure.tokens;
  const stringConstants = collectStringConstants(structure);
  for (const call of findBareCalls(structure, 'model')) {
    const args = callArguments(structure, call.openParen);
    let name = args.length === 0 ? undefined : literalText(singleToken(tokens, args[0]));
    if (name === undefined && args.length > 0 && args[0].end - args[0].start === 1 && isIdentifier(tokens[args[0].start])) {
      // `const MODEL = "provider/model" as const; model(MODEL)` is still a literal model name.
      name = stringConstants.get(String(tokens[args[0].start].value));
    }
    if (name === undefined || name.trim() === '') {
      ctx.add(CODE.UNSUPPORTED, MESSAGES.modelLiteral, args.length === 0 ? tokens[call.openParen].start : tokens[args[0].start].start);
    }
  }
}

/**
 * 9002: facade callables that do not exist in a snippet.
 * @param {object} ctx
 * @param {Structure} structure
 */
function checkSnippetFacade(ctx, structure) {
  for (const name of SNIPPET_FORBIDDEN_GLOBALS) {
    for (const call of findBareCalls(structure, name)) {
      ctx.add(CODE.FORBIDDEN_API, MESSAGES.snippetAbsent(name), structure.tokens[call.callee].start);
    }
  }
}
/* ------------------------------------------------------------------------------------------------
 * `ask<T>` schema markers
 *
 * `stripTypeScriptTypes` erases type arguments, so the runtime would never learn which interface an
 * `ask` answer must satisfy. Before transpiling, every `.ask<T>(` site is rewritten to
 * `.ask(__zcodeSchema("T"), ` (arrays become `"T[]"`), and the schema is returned in `interfaces`
 * under both the bare name and that exact marker key. The rewrite is textual, but driven by the
 * token stream, so nothing inside a comment, string or template literal is touched.
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {string} code
 * @param {{ start: number, end: number, text: string }[]} edits
 * @returns {string}
 */
function applyEdits(code, edits) {
  if (edits.length === 0) return code;
  const ordered = [...edits].sort((left, right) => left.start - right.start);
  let output = '';
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor) continue; // overlapping edit: keep the first
    output += code.slice(cursor, edit.start);
    output += edit.text;
    cursor = edit.end;
  }
  output += code.slice(cursor);
  return output;
}

/**
 * @typedef {object} SchemaRewrite
 * @property {{ start: number, end: number, text: string }[]} edits
 * @property {Map<string, object>} markerSchemas marker key -> schema
 */

/**
 * @param {object} ctx
 * @param {Structure} structure
 * @param {(name: string) => { ok: boolean, schema?: object, reason?: string }} schemaOf
 * @returns {SchemaRewrite}
 */
function rewriteAskSites(ctx, structure, schemaOf) {
  const tokens = structure.tokens;
  /** @type {{ start: number, end: number, text: string }[]} */
  const edits = [];
  /** @type {Map<string, object>} */
  const markerSchemas = new Map();

  for (let i = 1; i < tokens.length; i += 1) {
    if (!isPunct(tokens[i], '.') && !isPunct(tokens[i], '?.')) continue;
    if (!isId(tokens[i + 1], 'ask')) continue;
    const range = typeArgumentRange(structure, i + 1);
    if (range === null) continue;
    const openParen = range.close + 1;

    const inner = tokens.slice(range.open + 1, range.close);
    const typeText = inner.map((token) => token.raw ?? String(token.value ?? '')).join('');
    let name;
    let isArray = false;
    if (inner.length === 1 && isIdentifier(inner[0])) {
      name = String(inner[0].value);
    } else if (inner.length === 3 && isIdentifier(inner[0]) && isPunct(inner[1], '[') && isPunct(inner[2], ']')) {
      name = String(inner[0].value);
      isArray = true;
    } else if (inner.length === 4 && isId(inner[0], 'Array') && isPunct(inner[1], '<') && isIdentifier(inner[2]) && isPunct(inner[3], '>')) {
      name = String(inner[2].value);
      isArray = true;
    }

    if (name === undefined) {
      ctx.add(CODE.UNSUPPORTED, MESSAGES.askTypeUnsupported(typeText.trim()), tokens[range.open].start);
      continue;
    }

    const resolved = schemaOf(name);
    if (!resolved.ok) {
      const declared = resolved.reason !== undefined && resolved.reason.includes('is not declared in this script');
      ctx.add(
        CODE.UNSUPPORTED,
        declared ? MESSAGES.askTypeUndeclared(name) : `ask<${isArray ? `${name}[]` : name}> cannot be validated: ${resolved.reason ?? 'its type cannot be turned into a schema'}.`,
        tokens[range.open].start,
      );
      continue;
    }

    const marker = isArray ? `${name}[]` : name;
    const markerSchema = isArray ? { type: 'array', items: resolved.schema } : resolved.schema;
    if (!markerSchemas.has(marker)) markerSchemas.set(marker, markerSchema);
    if (isArray && !markerSchemas.has(name)) markerSchemas.set(name, resolved.schema);

    edits.push({
      start: tokens[range.open].start,
      end: tokens[openParen].end,
      text: `(__zcodeSchema(${JSON.stringify(marker)}), `,
    });
  }

  return { edits, markerSchemas };
}

/* ------------------------------------------------------------------------------------------------
 * Transpile
 * ---------------------------------------------------------------------------------------------- */

/**
 * Parse the line/column amaro puts on the first line of a syntax error's stack (`:12` / `:12:7`).
 * @param {unknown} error
 * @returns {{ line: number, column: number } | null}
 */
function parseSyntaxErrorPosition(error) {
  const stack = String(error?.stack ?? '');
  const lines = stack.split('\n');
  const header = /^:(\d+)(?::(\d+))?$/u.exec(lines[0] ?? '');
  if (header === null) return null;
  const line = Number(header[1]);
  let column = header[2] === undefined ? 1 : Number(header[2]);
  // amaro's snippet puts a caret line (`      ^^^^^`) under the offending span; its offset is the
  // only column information the error carries.
  if (header[2] === undefined) {
    for (let index = 1; index < lines.length; index += 1) {
      const snippetLine = lines[index];
      if (/^SyntaxError\b/u.test(snippetLine) || /^\s+at\s/u.test(snippetLine)) break;
      const match = /^([ \t]*)[\^~]+[ \t]*$/u.exec(snippetLine);
      if (match !== null) {
        column = match[1].length + 1;
        break;
      }
    }
  }
  return { line: Number.isFinite(line) ? line : 1, column: Number.isFinite(column) ? column : 1 };
}

/**
 * Map a position in the rewritten, wrapped script back to the submitted script's line/column.
 * The wrapper adds one leading line; the `ask<T>` rewrites add characters on their own lines only.
 * @param {object} ctx
 * @param {{ start: number, end: number, text: string }[]} edits
 * @param {{ line: number, column: number }} position
 * @returns {{ line: number, column: number }}
 */
function mapWrappedPosition(ctx, edits, position) {
  const line = Math.max(1, position.line - WRAPPER_LINE_OFFSET);
  let column = Math.max(1, position.column);

  // Per rewritten line, how much the edits shifted the text before a column.
  const perLine = new Map();
  for (const edit of edits) {
    const original = locate(ctx.starts, edit.start);
    const prior = perLine.get(original.line) ?? [];
    const previousDelta = prior.reduce((total, entry) => total + entry.delta, 0);
    const delta = edit.text.length - (edit.end - edit.start);
    prior.push({ rewrittenStartColumn: original.column + previousDelta, delta });
    perLine.set(original.line, prior);
  }
  const changes = perLine.get(line) ?? [];
  let shift = 0;
  for (const change of changes) {
    if (change.rewrittenStartColumn < column) shift += change.delta;
  }
  column = Math.max(1, column - shift);
  return { line, column };
}

/**
 * @param {object} ctx
 * @param {string} code normalized original source
 * @param {{ start: number, end: number, text: string }[]} edits
 * @returns {{ ok: true, js: string } | { ok: false }}
 */
function transpile(ctx, code, edits) {
  const rewritten = applyEdits(code, edits);
  const wrapped = wrapScript(rewritten);
  let js;
  try {
    js = stripTypeScriptTypes(wrapped, { mode: 'transform' });
  } catch (error) {
    const position = parseSyntaxErrorPosition(error);
    if (position === null) {
      ctx.add(CODE.SYNTAX, MESSAGES.syntax(String(error?.message ?? error)), 0);
    } else {
      const mapped = mapWrappedPosition(ctx, edits, position);
      const lineStarts = ctx.starts;
      const lineStart = lineStarts[Math.min(Math.max(mapped.line, 1), lineStarts.length) - 1] ?? 0;
      ctx.add(CODE.SYNTAX, MESSAGES.syntax(String(error?.message ?? error)), lineStart + mapped.column - 1);
    }
    return { ok: false };
  }
  return { ok: true, js };
}

/* ------------------------------------------------------------------------------------------------
 * Saved-workflow metadata block (`/* zcode-workflow` … `*\/`)
 * ---------------------------------------------------------------------------------------------- */

const METADATA_OPEN = '/* zcode-workflow';
const METADATA_CLOSE = '*/';
const ARG_TYPES = new Set(['string', 'number', 'boolean', 'json']);

/**
 * @typedef {object} WorkflowArgument
 * @property {'string'|'number'|'boolean'|'json'} type
 * @property {string} [description]
 * @property {boolean} [required]
 * @property {unknown} [default]
 *
 * @typedef {object} WorkflowMetadata
 * @property {string} [name]
 * @property {string} description
 * @property {string} [whenToUse]
 * @property {Record<string, WorkflowArgument>} [args]
 */

/**
 * Parse the `/* zcode-workflow` metadata block of a saved workflow file.
 *
 * Returns `{ ok: true, meta, body, bodyLineOffset }` or, on a malformed block, a diagnostic-style
 * `{ ok: false, reason, detail, diagnostics }` — never throws.
 *
 * @param {string} input file text
 * @param {{ path?: string }} [options]
 * @returns {{ ok: true, meta: WorkflowMetadata, body: string, header: string, bodyLineOffset: number, diagnostics: Diagnostic[] } | { ok: false, reason: 'missing_frontmatter'|'unterminated_frontmatter'|'invalid_yaml'|'invalid_metadata', detail: string, meta: null, body: null, diagnostics: Diagnostic[] }}
 */
export function extractMetadataHeader(input, options = {}) {
  const path = typeof options.path === 'string' && options.path.length > 0 ? options.path : '<workflow>';
  const { code } = normalizeSource(input);
  const starts = lineStartIndex(code);
  const lines = code.split('\n');

  /** @param {'missing_frontmatter'|'unterminated_frontmatter'|'invalid_yaml'|'invalid_metadata'} reason @param {string} detail @param {number} line */
  const fail = (reason, detail, line = 1) => ({
    ok: false,
    reason,
    detail,
    meta: null,
    body: null,
    diagnostics: [{ path, line, column: 1, code: CODE.SYNTAX, message: detail, severity: 'error' }],
  });

  let index = 0;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  if (index >= lines.length) {
    return fail('missing_frontmatter', 'file does not start with the `/* zcode-workflow` metadata block', 1);
  }
  if (lines[index].trim() !== METADATA_OPEN) {
    return fail('missing_frontmatter', 'file does not start with the `/* zcode-workflow` metadata block', index + 1);
  }
  let close = index + 1;
  while (close < lines.length && lines[close].trim() !== METADATA_CLOSE) close += 1;
  if (close >= lines.length) {
    return fail('unterminated_frontmatter', 'metadata block is never closed with `*/`', index + 1);
  }

  const yamlText = lines.slice(index + 1, close).join('\n');
  const parsed = parseYamlSubset(yamlText);
  if (!parsed.ok) {
    return fail('invalid_yaml', parsed.detail, index + 1 + (parsed.line ?? 0));
  }
  const metaResult = normalizeMetadata(parsed.value);
  if (!metaResult.ok) {
    return fail('invalid_metadata', metaResult.detail, index + 1);
  }

  return {
    ok: true,
    meta: metaResult.meta,
    body: lines.slice(close + 1).join('\n'),
    header: lines.slice(index, close + 1).join('\n'),
    bodyLineOffset: close + 1,
    diagnostics: [],
  };
}

/**
 * @param {unknown} value parsed YAML value
 * @returns {{ ok: true, meta: WorkflowMetadata } | { ok: false, detail: string }}
 */
function normalizeMetadata(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, detail: '(root): the metadata block must be a mapping of `description`, `whenToUse` and `args`' };
  }
  /** @type {Record<string, unknown>} */
  const raw = /** @type {any} */ (value);
  /** @type {WorkflowMetadata} */
  const meta = { description: '' };

  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || raw.name.trim() === '') {
      return { ok: false, detail: 'name: must be a non-empty string' };
    }
    meta.name = raw.name;
  }
  if (typeof raw.description !== 'string' || raw.description.trim() === '') {
    return { ok: false, detail: 'description: Required' };
  }
  meta.description = raw.description;
  if (raw.whenToUse !== undefined) {
    if (typeof raw.whenToUse !== 'string' || raw.whenToUse.trim() === '') {
      return { ok: false, detail: 'whenToUse: must be a non-empty string' };
    }
    meta.whenToUse = raw.whenToUse;
  }
  if (raw.args !== undefined) {
    const args = normalizeArgumentDeclarations(raw.args);
    if (!args.ok) return args;
    meta.args = args.args;
  }
  return { ok: true, meta };
}

/**
 * Accept both metadata shapes ZCode-era files and this port's tool fields use: the ZCode object map
 * (`args: { pr: { type: string } }`) and a list (`args: [{ name: pr, type: string }]`).
 * @param {unknown} value
 * @returns {{ ok: true, args: Record<string, WorkflowArgument> } | { ok: false, detail: string }}
 */
function normalizeArgumentDeclarations(value) {
  /** @type {Record<string, WorkflowArgument>} */
  const args = {};

  /**
   * @param {string} name
   * @param {unknown} declaration
   * @param {string} at
   * @returns {string | null} a validation error, or null
   */
  const add = (name, declaration, at) => {
    if (name.trim() === '') return `${at}: the argument name is empty`;
    if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
      return `${at}: must be a mapping with a \`type\``;
    }
    /** @type {Record<string, unknown>} */
    const raw = /** @type {any} */ (declaration);
    if (typeof raw.type !== 'string' || !ARG_TYPES.has(raw.type)) {
      return `${at}.type: Invalid enum value. Expected 'string' | 'number' | 'boolean' | 'json'`;
    }
    if (raw.description !== undefined && typeof raw.description !== 'string') {
      return `${at}.description: must be a string`;
    }
    if (raw.required !== undefined && typeof raw.required !== 'boolean') {
      return `${at}.required: must be a boolean`;
    }
    args[name] = {
      type: /** @type {WorkflowArgument['type']} */ (raw.type),
      ...(raw.description === undefined ? {} : { description: raw.description }),
      ...(raw.required === undefined ? {} : { required: raw.required }),
      ...(raw.default === undefined ? {} : { default: raw.default }),
    };
    return null;
  };

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string') {
        return { ok: false, detail: `args.${index}: must be a mapping with a \`name\` and a \`type\`` };
      }
      const error = add(entry.name, entry, `args.${index}`);
      if (error !== null) return { ok: false, detail: error };
    }
    return { ok: true, args };
  }

  if (value === null || typeof value !== 'object') {
    return { ok: false, detail: 'args: must be a mapping of argument name to declaration' };
  }
  for (const [name, declaration] of Object.entries(value)) {
    const error = add(name, declaration, `args.${name}`);
    if (error !== null) return { ok: false, detail: error };
  }
  return { ok: true, args };
}

/* --- YAML subset ------------------------------------------------------------------------------- */

/**
 * Parse the small YAML subset a workflow metadata block uses: a mapping of scalars, a nested
 * mapping (`args`), sequences of mappings, block scalars (`|` / `>`), quoted scalars and flow JSON.
 *
 * @param {string} text
 * @returns {{ ok: true, value: unknown } | { ok: false, detail: string, line: number }}
 */
function parseYamlSubset(text) {
  const lines = text.split('\n');
  try {
    const result = parseYamlNode(lines, 0, -1);
    let cursor = result.next;
    while (cursor < lines.length && (lines[cursor].trim() === '' || lines[cursor].trim().startsWith('#'))) cursor += 1;
    if (cursor < lines.length) {
      return { ok: false, detail: `YAML: unexpected content on line ${cursor + 1}`, line: cursor };
    }
    return { ok: true, value: result.value };
  } catch (error) {
    const failure = /** @type {any} */ (error);
    return { ok: false, detail: String(failure?.yamlDetail ?? failure?.message ?? error), line: Number(failure?.yamlLine ?? 0) };
  }
}

/**
 * @param {string} detail
 * @param {number} line 0-based
 * @returns {Error}
 */
function yamlError(detail, line) {
  const error = new Error(detail);
  error.yamlDetail = detail;
  error.yamlLine = line;
  return error;
}

/**
 * @param {string} line
 * @returns {number}
 */
function indentOf(line) {
  let index = 0;
  while (index < line.length && line[index] === ' ') index += 1;
  if (line[index] === '\t') throw yamlError('YAML: tab characters cannot be used for indentation', 0);
  return index;
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isBlankLine(line) {
  return line.trim() === '' || line.trim().startsWith('#');
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @param {number} parentIndent
 * @returns {{ value: unknown, next: number }}
 */
function parseYamlNode(lines, start, parentIndent) {
  let index = start;
  while (index < lines.length && isBlankLine(lines[index])) index += 1;
  if (index >= lines.length) return { value: null, next: index };
  const indent = indentOf(lines[index]);
  if (indent <= parentIndent) return { value: null, next: index };
  const content = lines[index].slice(indent).trimEnd();
  if (content === '-' || content.startsWith('- ')) return parseYamlSequence(lines, index, indent);
  return parseYamlMapping(lines, index, indent);
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @param {number} indent
 * @returns {{ value: Record<string, unknown>, next: number }}
 */
function parseYamlMapping(lines, start, indent) {
  /** @type {Record<string, unknown>} */
  const mapping = {};
  let index = start;
  while (true) {
    while (index < lines.length && isBlankLine(lines[index])) index += 1;
    if (index >= lines.length) break;
    const line = lines[index];
    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) throw yamlError(`YAML: unexpected indentation on line ${index + 1}`, index);
    const content = line.slice(lineIndent).trimEnd();
    const colon = findKeyColon(content);
    if (colon < 0) throw yamlError(`YAML: expected \`key: value\` on line ${index + 1}`, index);
    const key = parseScalarKey(content.slice(0, colon).trim(), index);
    const rest = content.slice(colon + 1).trim();
    index += 1;

    if (rest === '') {
      const child = parseYamlNode(lines, index, indent);
      mapping[key] = child.value;
      index = child.next;
      continue;
    }
    const block = /^([|>])([+-]?)$/u.exec(rest);
    if (block !== null) {
      const scalar = readBlockScalar(lines, index, indent, block[1] === '>', block[2]);
      mapping[key] = scalar.value;
      index = scalar.next;
      continue;
    }
    mapping[key] = parseScalar(rest, index);
  }
  return { value: mapping, next: index };
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @param {number} indent
 * @returns {{ value: unknown[], next: number }}
 */
function parseYamlSequence(lines, start, indent) {
  /** @type {unknown[]} */
  const items = [];
  let index = start;
  while (true) {
    while (index < lines.length && isBlankLine(lines[index])) index += 1;
    if (index >= lines.length) break;
    const line = lines[index];
    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) throw yamlError(`YAML: unexpected indentation on line ${index + 1}`, index);
    const content = line.slice(lineIndent).trimEnd();
    if (!(content === '-' || content.startsWith('- '))) break;
    const itemText = content === '-' ? '' : content.slice(2).trim();
    index += 1;
    if (itemText === '') {
      const child = parseYamlNode(lines, index, indent);
      items.push(child.value);
      index = child.next;
      continue;
    }
    const colon = findKeyColon(itemText);
    if (colon < 0) {
      items.push(parseScalar(itemText, index));
      continue;
    }
    // `- name: pr` opens an inline mapping whose continuation lines are indented past the dash.
    const virtualIndent = indent + 2;
    const firstLine = ' '.repeat(virtualIndent) + itemText;
    const merged = [firstLine, ...lines.slice(index)];
    const child = parseYamlMapping(merged, 0, virtualIndent);
    items.push(child.value);
    index += Math.max(0, child.next - 1);
  }
  return { value: items, next: index };
}

/**
 * The index of the `:` that separates a key from its value, honouring quoted keys.
 * @param {string} content
 * @returns {number}
 */
function findKeyColon(content) {
  let quote = '';
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quote !== '') {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ':' && (index + 1 === content.length || content[index + 1] === ' ')) return index;
  }
  return -1;
}

/**
 * @param {string} text
 * @param {number} line
 * @returns {string}
 */
function parseScalarKey(text, line) {
  const value = parseScalar(text, line);
  if (typeof value !== 'string') throw yamlError(`YAML: the key on line ${line + 1} must be a string`, line);
  return value;
}

/**
 * @param {string} text
 * @param {number} line
 * @returns {unknown}
 */
function parseScalar(text, line) {
  const value = text.trim();
  if (value === '' || value === '~' || value === 'null' || value === 'Null' || value === 'NULL') return null;
  if (value === 'true' || value === 'True' || value === 'TRUE') return true;
  if (value === 'false' || value === 'False' || value === 'FALSE') return false;
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) throw yamlError(`YAML: unterminated double-quoted string on line ${line + 1}`, line);
    try {
      return JSON.parse(value);
    } catch {
      throw yamlError(`YAML: invalid double-quoted string on line ${line + 1}`, line);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw yamlError(`YAML: unterminated single-quoted string on line ${line + 1}`, line);
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/u.test(value)) return Number(value);
  return stripInlineComment(value);
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripInlineComment(value) {
  const index = value.search(/\s#/u);
  return (index < 0 ? value : value.slice(0, index)).trim();
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @param {number} parentIndent
 * @param {boolean} folded
 * @param {string} chomping
 * @returns {{ value: string, next: number }}
 */
function readBlockScalar(lines, start, parentIndent, folded, chomping) {
  const collected = [];
  let index = start;
  let blockIndent = -1;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      collected.push('');
      index += 1;
      continue;
    }
    const indent = indentOf(line);
    if (indent <= parentIndent) break;
    if (blockIndent < 0) blockIndent = indent;
    if (indent < blockIndent) break;
    collected.push(line.slice(blockIndent));
    index += 1;
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') {
    if (chomping === '-' || chomping === '') {
      collected.pop();
      continue;
    }
    break;
  }
  const value = folded ? collected.join(' ').trim() : collected.join('\n');
  if (chomping === '-') return { value, next: index };
  return { value: `${value}\n`, next: index };
}

/* --- serialization ----------------------------------------------------------------------------- */

/**
 * Serialize a saved workflow: the `/* zcode-workflow` metadata block, then the script verbatim.
 * Mirrors ZCode's `serializeSavedWorkflow` shape.
 *
 * @param {WorkflowMetadata} meta
 * @param {string} body the workflow script
 * @returns {string}
 */
export function serializeMetadataHeader(meta, body) {
  /** @type {Record<string, unknown>} */
  const mapping = { description: String(meta?.description ?? '') };
  if (meta?.name !== undefined) mapping.name = meta.name;
  if (meta?.whenToUse !== undefined) mapping.whenToUse = meta.whenToUse;
  if (meta?.args !== undefined && Object.keys(meta.args).length > 0) {
    /** @type {Record<string, unknown>} */
    const args = {};
    for (const [name, declaration] of Object.entries(meta.args)) {
      /** @type {Record<string, unknown>} */
      const entry = { type: declaration.type };
      if (declaration.description !== undefined) entry.description = declaration.description;
      if (declaration.required !== undefined) entry.required = declaration.required;
      if (declaration.default !== undefined) entry.default = declaration.default;
      args[name] = entry;
    }
    mapping.args = args;
  }
  return `${METADATA_OPEN}\n${serializeYamlMapping(mapping, 0)}${METADATA_CLOSE}\n${body}`;
}

/**
 * @param {Record<string, unknown>} mapping
 * @param {number} indent
 * @returns {string}
 */
function serializeYamlMapping(mapping, indent) {
  const pad = ' '.repeat(indent);
  let output = '';
  for (const [key, value] of Object.entries(mapping)) {
    const renderedKey = needsYamlQuote(key) ? JSON.stringify(key) : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      output += `${pad}${renderedKey}:\n${serializeYamlMapping(/** @type {Record<string, unknown>} */ (value), indent + 2)}`;
      continue;
    }
    output += `${pad}${renderedKey}: ${renderYamlScalar(value, indent + 2)}\n`;
  }
  return output;
}

/**
 * @param {unknown} value
 * @param {number} indent
 * @returns {string}
 */
function renderYamlScalar(value, indent) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value);
  if (text.includes('\n')) {
    const pad = ' '.repeat(indent);
    const trailing = text.endsWith('\n') ? '' : '-';
    const body = (trailing === '' ? text.slice(0, -1) : text).split('\n').map((line) => `${pad}${line}`).join('\n');
    return `|${trailing}\n${body}`;
  }
  return needsYamlQuote(text) ? JSON.stringify(text) : text;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function needsYamlQuote(text) {
  if (text === '' || text !== text.trim()) return true;
  if (/^(true|false|null|~|yes|no|on|off|[-+]?\d+(\.\d+)?)$/iu.test(text)) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/u.test(text)) return true;
  if (/:\s/u.test(text) || /\s#/u.test(text) || text.includes('\t')) return true;
  return false;
}

/* ------------------------------------------------------------------------------------------------
 * Public compile entry point
 * ---------------------------------------------------------------------------------------------- */

/**
 * @typedef {object} CompileOptions
 * @property {string} code the workflow script (TypeScript)
 * @property {string} [filename] path used in diagnostics
 * @property {'workflow'|'snippet'} [mode]
 */

/**
 * Compile one workflow script.
 *
 * @param {CompileOptions} options
 * @returns {{
 *   ok: boolean,
 *   js: string|null,
 *   diagnostics: Diagnostic[],
 *   phases: string[],
 *   agents: string[],
 *   artifacts: { id: string, kind: string, primary: boolean }[],
 *   worldCommands: string[],
 *   interfaces: Record<string, object>,
 * }}
 */
export function compileWorkflowScript(options = {}) {
  const mode = options.mode ?? 'workflow';
  const filename = typeof options.filename === 'string' && options.filename.length > 0 ? options.filename : 'workflow.ts';
  const { code } = normalizeSource(options.code);

  if (mode !== 'workflow' && mode !== 'snippet') {
    return {
      ok: false,
      js: null,
      diagnostics: [{
        path: filename,
        line: 1,
        column: 1,
        code: CODE.SYNTAX,
        message: `unknown compiler mode ${JSON.stringify(mode)}; use "workflow" or "snippet"`,
        severity: 'error',
      }],
      phases: [],
      agents: [],
      artifacts: [],
      worldCommands: [],
      interfaces: {},
    };
  }

  const ctx = createContext(code, filename);

  /** @type {Diagnostic[]} */
  const diagnostics = ctx.diagnostics;
  /** @param {boolean} ok @param {string|null} js @param {object} facts */
  const finish = (ok, js, facts) => {
    diagnostics.sort((left, right) => left.line - right.line || left.column - right.column || left.code - right.code);
    const failed = diagnostics.some((diagnostic) => diagnostic.severity !== 'warning');
    return {
      ok: failed ? false : ok,
      js: failed ? null : js,
      diagnostics,
      phases: facts.phases ?? [],
      agents: facts.agents ?? [],
      artifacts: facts.artifacts ?? [],
      worldCommands: facts.worldCommands ?? [],
      interfaces: facts.interfaces ?? {},
    };
  };

  if (code.trim() === '') {
    ctx.add(CODE.SYNTAX, MESSAGES.emptyScript, 0);
    return finish(false, null, {});
  }

  const tokenized = tokenize(code);
  if (tokenized.error !== null) {
    ctx.add(CODE.SYNTAX, MESSAGES.syntax(tokenized.error.message), tokenized.error.offset);
    return finish(false, null, {});
  }

  const structure = buildStructure(tokenized.tokens);
  structure.code = code;
  const declaredNames = collectDeclaredNames(structure);
  const types = collectTypeDeclarations(ctx, structure, tokenized.comments);

  // Rules that apply to both modes.
  checkModuleSyntax(ctx, structure);
  checkForbiddenApis(ctx, structure, declaredNames);
  checkFacadeMisuse(ctx, structure, declaredNames);

  /** @type {{ phases: string[], agents: string[], artifacts: object[], worldCommands: string[] }} */
  const facts = { phases: [], agents: [], artifacts: [], worldCommands: [] };

  if (mode === 'snippet') {
    checkSnippetFacade(ctx, structure);
  } else {
    const phaseResult = checkPhases(ctx, structure, mode);
    facts.phases = [...new Set(phaseResult.markers.map((marker) => marker.name).filter((name) => name !== undefined))];
    facts.agents = checkAgents(ctx, structure, mode, declaredNames);
    const artifactResult = checkArtifactsAndReports(ctx, structure, mode);
    facts.artifacts = artifactResult.artifacts;
    facts.worldCommands = checkWorldCommands(ctx, structure, declaredNames);
    checkHoles(ctx, structure, mode, phaseResult.markers);
    checkModels(ctx, structure, mode);
  }

  // Type declarations that cannot become a schema: warn when unused, error when an ask needs them.
  const schemaOf = (name) => types.schemaOf(name);
  for (const declaration of types.declarations.values()) {
    if (declaration.unsupported !== undefined) {
      ctx.add(CODE.UNSUPPORTED, `type "${declaration.name}" cannot be turned into a JSON schema: ${declaration.unsupported}. It is only checked when an ask<T> names it.`, tokenized.tokens[declaration.nameIndex].start, 'warning');
      continue;
    }
    const resolved = schemaOf(declaration.name);
    if (!resolved.ok) {
      ctx.add(CODE.UNSUPPORTED, `type "${declaration.name}" cannot be turned into a JSON schema: ${resolved.reason ?? 'unsupported'}. It is only checked when an ask<T> names it.`, tokenized.tokens[declaration.nameIndex].start, 'warning');
    }
  }

  // Bind `ask<T>` answers to their schemas.
  const rewrite = rewriteAskSites(ctx, structure, schemaOf);

  /** @type {Record<string, object>} */
  const interfaces = {};
  for (const [name, declaration] of types.declarations) {
    if (declaration.unsupported !== undefined) continue;
    const resolved = schemaOf(name);
    if (resolved.ok) interfaces[name] = resolved.schema;
  }
  for (const [marker, schema] of rewrite.markerSchemas) {
    if (interfaces[marker] === undefined) interfaces[marker] = schema;
  }

  const transpiled = transpile(ctx, code, rewrite.edits);
  return finish(transpiled.ok, transpiled.ok ? transpiled.js : null, { ...facts, interfaces });
}
