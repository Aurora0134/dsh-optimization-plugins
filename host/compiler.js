/**
 * 工作流脚本编译器（现行 G3 语义：TypeScript → lowering → JS）。
 *
 * 与旧实现的区别（这是重写的理由）：
 * - 旧版按 G1「Workflow 工具」的 facade 编译（`agent(prompt, opts)` + `parallel/pipeline`），
 *   现行 facade 是 `agent(name?, persona?) → Agent{ask<T>()}`，脚本编译后并不调用 facade 本身，
 *   而是调用宿主注入的 `__host.*`（`beauty/zcode-cli.js:648735-648860`）。
 * - 旧版把 `ask<T>` 改写成 `__zcodeSchema("T")` 标记；现行 lowering 是「站点 id + `__host.ask`」，
 *   journal/重放都按站点 id 做键，`<T>` 只用来生成 JSON Schema 供结果校验。
 * - 诊断码与文案按 ZCode 0.21.1 的码表逐字复刻（9001、9003–9010、9012；没有 9002，9011 无产生点，
 *   未知名字用 TS 的 2304，模块语法用 1184——见 docs/port-contract.md）。
 *
 * 这里没有 TypeScript 编译器：结构分析用本模块自己的 tokenizer（所以检查永远不会命中注释、
 * 字符串或模板字面量内部的文字），类型擦除交给 Node 内建的 `stripTypeScriptTypes`
 * （标准库，不引依赖）。lowering 是**文本编辑**：每个站点改写只在原文字符串上插入/替换一段，
 * 因此可以精确保持行号（诊断行号就是用户脚本行号）。
 *
 * ## 公共 API
 * ```js
 * compileWorkflowScript({ code, filename, mode }) // mode: 'workflow'(默认) | 'snippet'
 * // -> { ok, diagnostics, lowered, js, sites, askSpecs, sitePhases, phases, actors, holes,
 * //      artifacts, worldReads, models, interfaces, metadata, scriptHash, lineOffset }
 * ```
 * `lowered` 是可以直接塞进 `(async (__host) => { … })` 的语句体（cell.js 负责包壳）；
 * `js` 是包好壳的完整表达式，供不经过 cell 的调用方（测试、片段求值）。
 *
 * 诊断形状：`{ code, line, column, message }`。`ok` 为真当且仅当没有诊断。
 *
 * ## 已知偏差（不是遗漏，是无 TS 类型检查器的边界）
 * - 没有语义类型检查：`strict` 下的类型错误（未判空的 `.find()` 结果等）不在编译期报出。
 * - 「facade 值被重定型」那条 9001 无法检测（需要类型系统）；「取引用」那条能检测。
 * - 未声明的名字只查**调用点**：`frobnicate(1)`、`process`/`require`/`fetch`、以及 G1 旧 facade
 *   名字（`parallel`/`pipeline`/`budget`/`workflow`）报 TS 的 2304 `Cannot find name 'x'.`
 *   （契约 §3.2 A 把语义诊断交给 TS；bundle 的文案表见 `cli.md:441455`）。读一个未声明变量
 *   （`return nope;`）不报，真 TS 会报。
 * - `Date.now()`/`new Date()`/`Math.random()` 是**运行期**禁令（§2.13，cell 抛错），不是编译期
 *   诊断；`eval`/`Function` 在 bundle 的 cell 里同样可达（lowering 自己就发 `eval`）。
 * - 模板字面量被当作一个不透明 token，`${…}` 里的 facade 调用不做站点改写（与旧实现同一边界）。
 * - `import` 语句的文案由 TS 的语义诊断产生，这里没有原文，用 1184 + 自有措辞。
 */

import { stripTypeScriptTypes } from 'node:module';

/* ================================================================================================
 * 1. facade 声明（逐字，cli.md:427451-427790）
 * ============================================================================================== */

const MODEL_DTS = `/** A model declared with model(). */
declare class ModelRef { private constructor(); private readonly modelRef: never }

/**
 * Declare a model subagents may run on: "modelId" or "providerId/modelId", optional "$level".
 * String literal only (checked at launch); choose among ModelRefs at run time.
 */
declare function model(id: string): ModelRef;
`;

const AGENT_DTS = `
/** The pending result of one ask. Await it, or pass it to Promise.all with others. */
declare interface Node<T> extends PromiseLike<T> {}

${MODEL_DTS}
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
`;

const ARGS_DTS = `
/**
 * The run's arguments. For a saved workflow they are validated against its declared
 * arguments, with defaults filled in, before the run starts; an inline script or a snippet
 * gets {}. Always defined; the values are unknown, so narrow them (String(args.target), a
 * typeof guard).
 */
declare const args: Readonly<Record<string, unknown>>;
`;

const RUN_DTS = `
/**
 * This run's id, and the run it amends. ResumeWorkflowRun keeps both; AmendWorkflow mints a
 * new id. Keep them out of ask text, personas and world arguments: those are cache keys.
 */
declare const run: { readonly id: string; readonly resumedFrom?: string };
`;

const LOG_DTS = `
/** Emit a progress message to the user. */
declare function log(message: string): void;
`;

const REPORT_DTS = `
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
`;

const ARTIFACT_DTS = `
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
  /** Declare a board fed by report(item, id): each tagged item is one card, placed by its status field. */
  board(id: string, spec: BoardSpec): void;
};
`;

const PHASE_DTS = `
/**
 * Mark the start of a phase: a named group of the steps that follow, drawn as one node on
 * the graph the user approves. Presentation only: it starts, waits for and returns nothing.
 * Required. The name is a non-empty compile-time literal and the call a standalone
 * statement. A marker covers every step from it to the end of the block it stands in
 * (nested blocks and inlined helpers included); two markers with the same name are one
 * phase. Every phase contains at least one ask or world.run.
 */
declare function phase(name: string): void;
`;

const HOLE_DTS = `
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
`;

const FILES_GIT_DTS = `
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
`;

const WORLD_DTS = `
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
`;

const CHANNEL_DTS = `
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
declare function future<T>(body: () => Promise<T>): Promise<T>;
`;

/** 完整 facade（`fRn = QMa + JMo + KMo + VMo + eNa + tNa + nNa + qMo + HMo + GMo + pRn`）。 */
export const FACADE_DTS = `${AGENT_DTS}${ARGS_DTS}${RUN_DTS}${LOG_DTS}${REPORT_DTS}${ARTIFACT_DTS}${PHASE_DTS}${HOLE_DTS}${FILES_GIT_DTS}${WORLD_DTS}${CHANNEL_DTS}`;

/** 片段（snippet）facade：只有 args/run/log/files/git/world/channel/future（`n8e`）。 */
export const SNIPPET_FACADE_DTS = `${ARGS_DTS}${RUN_DTS}${LOG_DTS}${FILES_GIT_DTS}${WORLD_DTS}${CHANNEL_DTS}`;

/* ================================================================================================
 * 2. 诊断码与文案（cli.md §3.2 逐字）
 * ============================================================================================== */

export const COMPILER_DIAGNOSTIC_CODES = Object.freeze({
  FACADE_MISUSE: 9001,
  /**
   * TS 的语义诊断 `Cannot find name '{0}'.`。契约的自定义码是 9001 与 9003–9012，**没有 9002**
   * （`cli.md` §3.2 的码表：9001、9003、9004、9005、9006、9007、9008、9009、9010、9011、9012），
   * 所以「名字不存在」走 TS 自己的码：§3.2 A 说语义诊断由 TS 出，bundle 的文案表里 2304 正是
   * 这个形状（`cli.md:441455`）。本实现只覆盖调用点与 Node/web 全局，不覆盖普通标识符读取。
   */
  UNKNOWN_NAME: 2304,
  WORLD_COMMAND: 9003,
  PHASE: 9004,
  DUPLICATE_ACTOR: 9005,
  FIXED_ACTOR_NAME: 9006,
  ARTIFACT: 9007,
  PRESET_PLACEMENT: 9008,
  PRIMARY_CONFLICT: 9009,
  MODEL: 9010,
  HOLE: 9012,
  /**
   * 契约里还有 9011（模型可用性），本移植不产生它：它的两个产生点都要「这个 run 能用的模型集」，
   * 一是目录在校验之后才出现该模型（`The model "…" became available only after this call was
   * checked; submit the script again.`），二是 fill 里点了一个 run 不可用的模型。Harness 不向
   * 插件暴露模型清单，也没有 per-fill 的选择，两处都无从判定（见 `docs/port-contract.md`）。
   * `model("…")` 因此只校验「非空字面量」这一条（9010）。
   */
  /** TS 1184：`declare` / `export` / `import` 这类在函数体里非法的语法修饰。 */
  MODULE_SYNTAX: 1184,
});

const CODE = COMPILER_DIAGNOSTIC_CODES;

/** 全部逐字文案。函数形态的那些带插值参数。 */
export const DIAGNOSTIC_MESSAGES = Object.freeze({
  facadeReturned: (name) => `facade function '${name}' may only be called directly; taking a reference to it defeats site identity (journal and replay key off call sites)`,
  worldLiteral: 'world.run\'s first argument must be a compile-time string literal ("lean" or a no-substitution template): the script\'s command set is shown to the user at confirmation and only those commands are executable. Move the command name out of the variable/template, and put runtime values in the args array instead.',
  phaseLiteral: 'phase()\'s argument must be a compile-time string literal ("gate" or a no-substitution template): the script\'s phase names are fixed when it is submitted, because they label the graph the user confirms before anything runs. Write the name inline — a name that only exists at run time cannot be drawn.',
  phaseEmpty: 'phase("") has no name to show: the phase label is what the confirmation graph draws. Give the group a word ("preflight", "gate", "wrap-up"), or drop the marker — a script with no markers is perfectly legal and is drawn step by step.',
  phaseStandalone: 'phase("…") must stand alone as its own statement. The marker claims the rest of the block it stands in, so one in expression position (a variable initializer, an argument, a ternary arm) has no rest-of-block to claim. Put the call on its own line at the head of the steps it names.',
  duplicateActor: (name, firstLine) => `two actors are named "${name}" (the first is on line ${firstLine}): an actor name must be unique within a run. The name is the identity key an amended re-run matches its imported cache against, and any run can become the predecessor of one, so a repeated name makes that match ambiguous. Give this one its own name, or drop the name entirely — anonymous actors are legal (they just never reuse cached work).`,
  fixedActorName: (name) => `this agent(...) runs once per element of a fan-out but its name "${name}" is a fixed string, so every element creates a different actor under the same name — the run fails with DuplicateActorName as soon as the collection holds more than one item. An actor name must be unique within a run: it is the identity key an amended re-run matches its imported cache against. Build a per-element name (\`${name}-\${item}\`), or drop the name — anonymous actors are legal (they just never reuse cached work).`,
  holeTypeArgument: 'hole() needs an explicit type argument (hole<Plan>(...)): the type is the contract the fill is compiled against, and an inferred unknown is no contract. Write what the rest of the script needs from the hole.',
  holeNameLiteral: 'hole()\'s name must be a compile-time string literal: it is the hole\'s phase name and the identity every surface shows (the station, the notification, the fill file). Write it inline.',
  holeNameEmpty: 'hole("") has no name to show. Give the gap a word in the user\'s language ("决定分组", "choose the plan"); it labels the station and the notification.',
  holeNameLong: (limit) => `hole()'s name is longer than ${limit} characters; a phase name is a label, not a paragraph.`,
  holeNotAwaited: 'hole() must be awaited where it is called (await hole<T>(...) or return await hole<T>(...)): the script must not run past a gap that has no value yet.',
  holeInFanOut: 'hole() cannot stand inside a fan-out callback (xs.map(...), Promise.all(xs.map(...)) and the other per-element array methods): the elements run concurrently, so its fill would have to be written while they are already running. Hoist the decision out of the callback, or use a loop (for, for...of, while), where one round waits and the fill runs in every later round.',
  holeBodyNotArrow: 'hole()\'s body must be an inline async arrow (async () => { ... }): a fill is spliced into the script as text, so a function held in a variable has nothing to splice.',
  holeDuplicate: (name) => `two holes are named "${name}"; a hole's name is its identity and must be unique among the script's holes and phase markers.`,
  holePhaseCollision: (name) => `hole "${name}" shares its name with a phase("${name}") marker; a hole is a phase of its own, so the name must be unique among holes and markers.`,
  holeIdCollision: (first, second) => `hole "${first}" and hole "${second}" hash to the same site id; rename one of them (any change to the name gives it a new id).`,
  artifactIdLiteral: 'an artifact id must be a compile-time string literal ("report" or a no-substitution template): the set of artifacts a run can publish is fixed when the script is submitted, so it can be listed before anything runs. Write the id inline; put the runtime value in the title instead (artifact.file("report", path, { title: `Report for ${name}` })).',
  artifactIdEmpty: 'an artifact id must not be empty: it is the identity the card, the version history and the report tag all key off. Give it a short stable name ("book", "perf", "coverage").',
  artifactIdLong: (name, length, limit) => `artifact id "${name}" is ${length} characters; the limit is ${limit}. The id is a key, not a description — put the prose in the title.`,
  artifactIdCharacters: (name) => `artifact id "${name}" contains characters outside [A-Za-z0-9_.-]. The id is carried verbatim through the journal, the artifact store and the side pane, so it is restricted to characters that need no escaping anywhere ("build-log", "perf.p95").`,
  artifactKindConflict: (name, firstKind, firstLine, kind) => `artifact id "${name}" is used with two different kinds: artifact.${firstKind} on line ${firstLine} and artifact.${kind} here. Within one run an id belongs to exactly one kind — publishing it again is what mints the next VERSION, and a version cannot change what the thing is. Give this one its own id.`,
  artifactUnknownKind: (kind) => `artifact has no member "${kind}": the kinds are file and markdown (content, published once per call) and chart, table, metrics and board (presets, fed by report(item, id)).`,
  reportTagLiteral: 'report()\'s artifact tag must be a compile-time string literal naming a preset artifact declared in this script: the tag is how an item finds its dashboard, and a tag that only exists at run time cannot be checked against the declarations. Write the id inline.',
  reportTagContent: (tag) => `report()'s tag "${tag}" names a file/markdown artifact, which holds content rather than a stream of items — there is nothing for this item to become. Tag the item with a preset artifact (chart / table / metrics / board), or drop the tag and let the item go to the run's Results.`,
  reportTagUnknown: (tag, presets) => `report()'s tag "${tag}" names no preset artifact declared in this script${presets}. Declare it first — artifact.chart("${tag}", { x, y }) at the top of the script — or drop the tag.`,
  noPresets: ' (this script declares no preset artifacts at all)',
  declaredPresets: (ids) => ` (declared presets: ${ids.map((id) => JSON.stringify(id)).join(', ')})`,
  presetInCallback: 'a preset artifact declared inside a callback: hoist it to the top level and declare it once. A preset is a declaration, not a step — it says how the items tagged with its id are drawn, and the tagged report() calls are what fill it in. Declaring it where the callback runs buries it: move artifact.<kind>("<id>", spec) to the head of the script and keep only report(item, "<id>") in the callback.',
  presetInBranch: 'a preset artifact declared inside a conditional branch: hoist it to the top level and declare it once. The card should exist from the moment the run starts (it is legitimately empty until the first tagged report arrives), and a declaration that may or may not have run is a card that may or may not exist. Declare it unconditionally and let the branch decide what to report.',
  presetInLoop: 'a preset artifact declared inside a loop: hoist it to the top level and declare it once. A preset is declared once and fed many times — the loop body is where report(item, "<id>") belongs, not the declaration. Re-declaring the same spec is a no-op, but re-declaring it with a different spec fails the whole run, so the loop is the wrong place for it either way.',
  primaryConflict: (id, otherId, otherKind, otherLine) => `artifact "${id}" is marked primary, but "${otherId}" already is (artifact.${otherKind} on line ${otherLine}). A run has one deliverable — the card and the run pane lead with it. Drop primary from one of them, or publish this content as a new version of the other id.`,
  modelLiteral: 'model() takes the model name as a non-empty string literal (a model id or "providerId/modelId", optionally with "$level"): every model a script can use is checked against the configured models before the run starts. Put runtime choices in which ModelRef you pass, not in the name.',
  /**
   * `{type}` 是 TS 推断出的类型名。本移植没有类型检查器，一律填 `unknown`：这在 TS 里正是
   * 「可能是任何模型名」的那个类型，与被拒的条件同义。
   */
  /**
   * TS 2304 的逐字文案（`Cannot find name '{0}'.`）。契约把「这个名字不存在」交给 TS 的语义
   * 诊断，所以这里既不另起码也不改文案：未声明的调用、Node/web 全局（`process`/`require`/`fetch`）、
   * G1 旧 facade 名字（`parallel`/`pipeline`/`budget`/`workflow`）都报它。
   */
  unknownName: (name) => `Cannot find name '${name}'.`,
  actorModelDynamic: (type) => `A subagent's \`model\` must be known before the run starts: a string literal, a union of string literals, or a ModelRef from model("…"). This value's type is ${type}, which could be any model name. Write the name inline, add \`as const\` where it is declared, or declare the candidates with model() and choose among those ModelRefs at run time.`,
  declareModifier: 'The `declare` modifier is not allowed in a workflow script: the script is compiled inside a function body, where ambient declarations are illegal. Remove `declare` and write a plain declaration (e.g. `interface Foo { ... }`).',
  exportStatement: '`export` is not allowed in a workflow script: the script is compiled inside a function body. Remove `export` — the workflow\'s output is its final `return` value.',
  importStatement: '`import` is not allowed in a workflow script: the script is compiled inside a function body, so it has no module graph. The facade (agent, world, files, git, artifact) is its whole outside world; remove the import.',
  snippetAbsent: (name) => `${name}() does not exist in a snippet: a snippet is the test bench for the fixed logic of a script, not for orchestration — agent(), phase(), report(), artifact.*, hole() and model() are absent. Run the orchestration through the workflow tool instead.`,
  askTypeUndeclared: (name) => `ask<${name}> needs an interface declared in this script: the runtime validates the subagent's answer against a schema built from that declaration, and "${name}" is not declared here. Define \`interface ${name} { … }\` (a plain interface, no declare) or drop the type argument to take the answer as text.`,
  askTypeUnsupported: (text) => `ask<${text}> needs an interface or type alias declared in this script: the runtime validates the subagent's answer against a schema built from that declaration, and this type argument is not one this compiler can build a schema from. Declare \`interface ${text.replace(/\[\]$/u, '')} { … }\` and pass its name (an array of it as \`Name[]\`).`,
  emptyScript: 'the workflow script is empty: it needs at least a phase("…") marker and a step (an agent ask, a world.run, or a return value).',
  syntax: (message) => `the script does not parse: ${message}`,
});

/* ================================================================================================
 * 3. 源码归一化与 tokenizer
 * ============================================================================================== */

const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;

const KEYWORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function',
  'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'async', 'of', 'as', 'satisfies', 'from', 'get', 'set', 'static', 'implements', 'interface',
  'namespace', 'module', 'declare', 'abstract', 'public', 'private', 'protected', 'readonly',
  'override', 'type', 'infer', 'keyof', 'is', 'asserts', 'unique',
]);

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case',
  'do', 'else', 'yield', 'await', 'extends', 'default', 'satisfies', 'as',
]);

const PUNCTUATORS = [
  '>>>=', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=', '...',
  '=>', '>=', '<=', '==', '!=', '**', '++', '--', '+=', '-=', '*=', '/=', '%=',
  '&&', '||', '??', '?.', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^',
  '!', '~', '?', ':', '=', '.', '@', '#',
];

const OPENERS = new Set(['(', '[', '{']);
const CLOSER_TO_OPEN = new Map([[')', '('], [']', '['], ['}', '{']]);

/**
 * 去 BOM、统一换行（行号必须与用户提交的脚本一致，所以只做等价替换）。
 * @param {string} input
 * @returns {string}
 */
function normalizeSource(input) {
  return input.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
}

/**
 * token 化。返回的 token 带 1-based 的 `line`/`column` 与 0-based 的 `start`/`end`，
 * 只保留有意义的 token（注释被丢弃，但换行信息留在 `line` 上）。
 *
 * 为什么模板字面量整体成一个 token：`${…}` 里的表达式需要完整表达式解析才能安全改写，
 * 而站点改写对模板内的调用本就不可见（文件头已列为偏差）。
 *
 * @param {string} code
 * @returns {object[]}
 */
function tokenize(code) {
  /** @type {object[]} */
  const tokens = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const advance = (count) => {
    for (let step = 0; step < count; step += 1) {
      if (code.charCodeAt(index) === LINE_FEED) {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      index += 1;
    }
  };
  const push = (kind, value, start, startLine, startColumn) => {
    tokens.push({ kind, value, start, end: index, line: startLine, column: startColumn, endLine: line });
  };
  const previousMeaningful = () => tokens[tokens.length - 1];

  while (index < code.length) {
    const char = code[index];
    // whitespace
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v' || char === '\u00a0') {
      advance(1);
      continue;
    }
    // comments
    if (char === '/' && code[index + 1] === '/') {
      while (index < code.length && code[index] !== '\n') advance(1);
      continue;
    }
    if (char === '/' && code[index + 1] === '*') {
      advance(2);
      while (index < code.length && !(code[index] === '*' && code[index + 1] === '/')) advance(1);
      if (index < code.length) advance(2);
      continue;
    }
    const start = index;
    const startLine = line;
    const startColumn = column;
    // strings
    if (char === '"' || char === '\'') {
      const quote = char;
      advance(1);
      let text = '';
      while (index < code.length && code[index] !== quote) {
        if (code[index] === '\\') {
          const escapeStart = index;
          advance(1);
          if (index < code.length) {
            text += readEscape(code, escapeStart);
            advance(1);
          }
          continue;
        }
        if (code[index] === '\n') break;
        text += code[index];
        advance(1);
      }
      if (index < code.length && code[index] === quote) advance(1);
      push('string', text, start, startLine, startColumn);
      continue;
    }
    // templates
    if (char === '`') {
      advance(1);
      let text = '';
      let hasSubstitution = false;
      while (index < code.length) {
        if (code[index] === '\\') {
          const escapeStart = index;
          advance(1);
          if (index < code.length) {
            text += readEscape(code, escapeStart);
            advance(1);
          }
          continue;
        }
        if (code[index] === '`') {
          advance(1);
          break;
        }
        if (code[index] === '$' && code[index + 1] === '{') {
          hasSubstitution = true;
          advance(2);
          let depth = 1;
          while (index < code.length && depth > 0) {
            const inner = code[index];
            if (inner === '{') depth += 1;
            else if (inner === '}') depth -= 1;
            else if (inner === '`') {
              // 嵌套模板：跳过（简化处理，见文件头偏差）
              advance(1);
              while (index < code.length && code[index] !== '`') {
                if (code[index] === '\\') advance(1);
                advance(1);
              }
            } else if (inner === '"' || inner === '\'') {
              const quote = inner;
              advance(1);
              while (index < code.length && code[index] !== quote) {
                if (code[index] === '\\') advance(1);
                advance(1);
              }
            }
            advance(1);
          }
          continue;
        }
        text += code[index];
        advance(1);
      }
      const token = { kind: 'template', value: text, start, end: index, line: startLine, column: startColumn, endLine: line, hasSubstitution };
      tokens.push(token);
      continue;
    }
    // regex
    if (char === '/' && regexAllowed(previousMeaningful())) {
      advance(1);
      let inClass = false;
      while (index < code.length) {
        const inner = code[index];
        if (inner === '\\') {
          advance(2);
          continue;
        }
        if (inner === '\n') break;
        if (inner === '[') inClass = true;
        else if (inner === ']') inClass = false;
        else if (inner === '/' && !inClass) {
          advance(1);
          break;
        }
        advance(1);
      }
      while (index < code.length && /[a-z]/iu.test(code[index])) advance(1);
      push('regex', code.slice(start, index), start, startLine, startColumn);
      continue;
    }
    // numbers
    if (/[0-9]/u.test(char) || (char === '.' && /[0-9]/u.test(code[index + 1] ?? ''))) {
      advance(1);
      while (index < code.length && /[0-9a-fA-FxXoObBeE._n]/u.test(code[index])) {
        if ((code[index] === '+' || code[index] === '-') && /[eE]/u.test(code[index - 1] ?? '')) {
          advance(1);
          continue;
        }
        advance(1);
      }
      push('number', code.slice(start, index), start, startLine, startColumn);
      continue;
    }
    // identifiers / keywords
    if (/[A-Za-z_$]/u.test(char)) {
      advance(1);
      while (index < code.length && /[A-Za-z0-9_$]/u.test(code[index])) advance(1);
      const text = code.slice(start, index);
      push(KEYWORDS.has(text) ? 'keyword' : 'ident', text, start, startLine, startColumn);
      continue;
    }
    // punctuators
    let matched = null;
    for (const punctuator of PUNCTUATORS) {
      if (code.startsWith(punctuator, index)) {
        matched = punctuator;
        break;
      }
    }
    advance(matched === null ? 1 : matched.length);
    push('punct', matched ?? char, start, startLine, startColumn);
  }
  return tokens;
}

/**
 * 读取一个反斜杠转义（调用方已越过 `\`），返回其解码后的文本。
 * @param {string} code
 * @param {number} backslash
 * @returns {string}
 */
function readEscape(code, backslash) {
  const next = code[backslash + 1] ?? '';
  switch (next) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case 'b': return '\b';
    case 'f': return '\f';
    case 'v': return '\v';
    case '0': return '\0';
    case 'u': {
      if (code[backslash + 2] === '{') {
        const closing = code.indexOf('}', backslash + 3);
        if (closing > 0) return String.fromCodePoint(Number.parseInt(code.slice(backslash + 3, closing), 16));
        return '';
      }
      const hex = code.slice(backslash + 2, backslash + 6);
      return /^[0-9a-fA-F]{4}$/u.test(hex) ? String.fromCharCode(Number.parseInt(hex, 16)) : next;
    }
    case 'x': {
      const hex = code.slice(backslash + 2, backslash + 4);
      return /^[0-9a-fA-F]{2}$/u.test(hex) ? String.fromCharCode(Number.parseInt(hex, 16)) : next;
    }
    default: return next;
  }
}

/**
 * `/` 之前能否开始一个正则字面量。
 * @param {object | undefined} previous
 * @returns {boolean}
 */
function regexAllowed(previous) {
  if (previous === undefined) return true;
  if (previous.kind === 'keyword') return REGEX_PRECEDING_KEYWORDS.has(String(previous.value));
  if (previous.kind !== 'punct') return false;
  return previous.value !== ')' && previous.value !== ']' && previous.value !== '}';
}

/**
 * 括号配对（`(`↔`)`、`[`↔`]`、`{`↔`}`）。
 * @param {object[]} tokens
 * @returns {{ pairs: Map<number, number>, enclosing: (index: number) => number[] }}
 */
function buildStructure(tokens) {
  /** @type {Map<number, number>} */
  const pairs = new Map();
  /** @type {number[]} */
  const stack = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'punct') continue;
    if (OPENERS.has(token.value)) {
      stack.push(index);
      continue;
    }
    const opener = CLOSER_TO_OPEN.get(token.value);
    if (opener === undefined) continue;
    // 找到最近的同类开括号（容错：不匹配时向上冒泡）
    for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
      if (tokens[stack[depth]].value === opener) {
        pairs.set(stack[depth], index);
        pairs.set(index, stack[depth]);
        stack.length = depth;
        break;
      }
    }
  }
  return { pairs };
}

/* ================================================================================================
 * 4. 小工具
 * ============================================================================================== */

const isIdent = (token, value) => token !== undefined && token.kind === 'ident' && (value === undefined || token.value === value);
const isKeyword = (token, value) => token !== undefined && token.kind === 'keyword' && (value === undefined || token.value === value);
const isPunct = (token, value) => token !== undefined && token.kind === 'punct' && (value === undefined || token.value === value);

/**
 * 一个字面量的文本值：`"a"` / `'a'` / `` `a` ``（无替换模板）。变量或带替换模板返回 undefined。
 * @param {object | undefined} token
 * @returns {string | undefined}
 */
function literalText(token) {
  if (token === undefined) return undefined;
  if (token.kind === 'string') return token.value;
  if (token.kind === 'template' && token.hasSubstitution !== true) return token.value;
  return undefined;
}

/**
 * 一段 token 区间的源码文本。
 * @param {string} code
 * @param {object[]} tokens
 * @param {number} from
 * @param {number} to 开区间
 * @returns {string}
 */
function rangeText(code, tokens, from, to) {
  const first = tokens[from];
  const last = tokens[to - 1];
  if (first === undefined) return '';
  return code.slice(first.start, last.end);
}

/**
 * 拆分调用实参：`open` 是 `(` 的下标，返回各实参的 token 区间。
 * @param {object[]} tokens
 * @param {Map<number, number>} pairs
 * @param {number} open
 * @returns {{ from: number, to: number }[]}
 */
function callArguments(tokens, pairs, open) {
  const close = pairs.get(open);
  if (close === undefined) return [];
  /** @type {{from: number, to: number}[]} */
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open + 1; index < close; index += 1) {
    const token = tokens[index];
    if (token.kind === 'punct') {
      if (OPENERS.has(token.value)) depth += 1;
      else if (CLOSER_TO_OPEN.has(token.value)) depth -= 1;
      else if (token.value === ',' && depth === 0) {
        args.push({ from: start, to: index });
        start = index + 1;
      }
    }
  }
  if (start < close) args.push({ from: start, to: close });
  if (args.length === 0 && close === open + 1) return [];
  return args.filter((arg) => arg.to > arg.from);
}

/**
 * 实参是否是一个内联函数（`() => …` / `function () {}` / `async () => …`）。
 * @param {object[]} tokens
 * @param {{from: number, to: number}} range
 * @returns {boolean}
 */
function isFunctionArgument(tokens, range) {
  const first = tokens[range.from];
  if (isKeyword(first, 'async') || isKeyword(first, 'function')) return true;
  return isPunct(first, '(') || (first !== undefined && isIdent(first) && isPunct(tokens[range.from + 1], '=>'));
}

/**
 * 实参是否是内联箭头函数（hole 的 body 要求）。
 * @param {object[]} tokens
 * @param {{from: number, to: number}} range
 * @returns {boolean}
 */
function isArrowFunctionArgument(tokens, range) {
  for (let index = range.from; index < range.to; index += 1) {
    if (isPunct(tokens[index], '=>')) return true;
    if (isPunct(tokens[index], ';') || isPunct(tokens[index], ',')) return false;
  }
  return false;
}

/**
 * 表达式起点：从 `index` 向前找到完整的成员/调用链起点。
 * @param {object[]} tokens
 * @param {Map<number, number>} pairs
 * @param {number} index
 * @returns {number}
 */
function expressionStart(tokens, pairs, index) {
  let cursor = index;
  for (;;) {
    const token = tokens[cursor];
    if (token === undefined) return cursor;
    if (isPunct(token, ')') || isPunct(token, ']')) {
      const open = pairs.get(cursor);
      if (open === undefined) return cursor;
      const beforeOpen = tokens[open - 1];
      // 调用链/成员链继续向前：`getAgent()`、`xs[0]`
      if (isIdent(beforeOpen) || isKeyword(beforeOpen, 'this') || isKeyword(beforeOpen, 'super')) {
        cursor = open - 1;
        continue;
      }
      return open;
    }
    // 允许 `a.b.c` / `a?.b`：继续向前
    const before = tokens[cursor - 1];
    if (isPunct(before, '.') || isPunct(before, '?.')) {
      cursor -= 2;
      continue;
    }
    return cursor;
  }
}

/**
 * 把一段文本包成 JS 字符串字面量（含引号）。
 * @param {string} text
 * @returns {string}
 */
function jsString(text) {
  return JSON.stringify(text);
}

/**
 * FNV-1a 32 位，用于 hole 站点 id（`hole#%08x`，cli.md:425807-425812）。
 * @param {string} text
 * @returns {string}
 */
function fnv1a(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) & 255;
    hash ^= (text.charCodeAt(index) >> 8) & 255;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 站点计数器（`Zwt`）：每个 kind 各自从 1 递增；进入函数体加前缀。 */
class SiteCounters {
  constructor(prefix = '') {
    this.prefix = prefix;
    this.counts = new Map();
  }

  next(kind) {
    const count = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, count);
    return `${this.prefix}${kind}#${count}`;
  }
}

/* ================================================================================================
 * 5. 类型声明 → JSON Schema（typed ask 的校验依据）
 * ============================================================================================== */

const PRIMITIVE_SCHEMAS = new Map([
  ['string', { type: 'string' }],
  ['number', { type: 'number' }],
  ['boolean', { type: 'boolean' }],
  ['null', { type: 'null' }],
  ['any', {}],
  ['unknown', {}],
  ['void', {}],
  ['never', {}],
]);

/**
 * 收集 `interface X { … }` 与 `type X = …` 的 token 区间。
 * @param {object[]} tokens
 * @param {Map<number, number>} pairs
 * @returns {Map<string, { bodyFrom: number, bodyTo: number, alias: boolean }>}
 */
function collectTypeDeclarations(tokens, pairs) {
  /** @type {Map<string, { bodyFrom: number, bodyTo: number, alias: boolean }>} */
  const declarations = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isKeyword(token, 'interface') || isKeyword(token, 'type')) {
      const nameToken = tokens[index + 1];
      if (!isIdent(nameToken)) continue;
      if (isKeyword(token, 'interface')) {
        const open = findNextPunct(tokens, index + 2, '{');
        if (open < 0) continue;
        const close = pairs.get(open);
        if (close === undefined) continue;
        declarations.set(String(nameToken.value), { bodyFrom: open + 1, bodyTo: close, alias: false });
        index = close;
        continue;
      }
      const equals = findNextPunct(tokens, index + 2, '=');
      if (equals < 0) continue;
      let end = equals + 1;
      let depth = 0;
      while (end < tokens.length) {
        const current = tokens[end];
        if (current.kind === 'punct') {
          if (OPENERS.has(current.value)) depth += 1;
          else if (CLOSER_TO_OPEN.has(current.value)) depth -= 1;
          else if (current.value === ';' && depth === 0) break;
        }
        if (depth === 0 && current.line > tokens[equals].line && current.start > tokens[equals].end) {
          // `type X = …` 到行尾即结束（无分号写法）
          if (isPunct(tokens[end + 1], ';') || end === tokens.length - 1) break;
        }
        end += 1;
      }
      declarations.set(String(nameToken.value), { bodyFrom: equals + 1, bodyTo: end, alias: true });
      index = end;
    }
  }
  return declarations;
}

/**
 * 在 `from` 之后找第一个指定 punct。
 * @param {object[]} tokens
 * @param {number} from
 * @param {string} value
 * @returns {number}
 */
function findNextPunct(tokens, from, value) {
  for (let index = from; index < tokens.length; index += 1) {
    if (isPunct(tokens[index], value)) return index;
  }
  return -1;
}

/**
 * 把一段类型 token 转成 JSON Schema。
 * @param {object[]} tokens
 * @param {Map<number, number>} pairs
 * @param {number} from
 * @param {number} to
 * @param {Map<string, object>} declarations
 * @param {Map<string, {bodyFrom: number, bodyTo: number, alias: boolean}>} typeDecls
 * @param {Set<string>} [visiting]
 * @returns {object | undefined}
 */
function typeRangeToSchema(tokens, pairs, from, to, declarations, typeDecls, visiting = new Set()) {
  if (to <= from) return undefined;
  // 联合类型
  const union = splitTopLevel(tokens, pairs, from, to, '|');
  if (union.length > 1) {
    const literalValues = [];
    let allLiteral = true;
    for (const part of union) {
      const text = literalText(tokens[part.from]);
      if (text !== undefined && part.to - part.from === 1) literalValues.push(text);
      else allLiteral = false;
    }
    if (allLiteral && literalValues.length > 0) return { enum: literalValues };
    const schemas = union.map((part) => typeRangeToSchema(tokens, pairs, part.from, part.to, declarations, typeDecls, visiting));
    const nonNull = schemas.filter((schema) => schema !== undefined && schema.type !== 'null');
    const nullable = schemas.some((schema) => schema !== undefined && schema.type === 'null');
    if (nonNull.length === 1 && nullable) return { ...nonNull[0], nullable: true };
    // 多个对象/对象或基础类型：退化成 any（无法表达 union 时宁可不误报）
    return {};
  }
  // 括号
  if (isPunct(tokens[from], '(') && pairs.get(from) === to - 1) {
    return typeRangeToSchema(tokens, pairs, from + 1, to - 1, declarations, typeDecls, visiting);
  }
  // 数组后缀 `T[]`
  if (isPunct(tokens[to - 1], ']') && isPunct(tokens[to - 2], '[')) {
    const item = typeRangeToSchema(tokens, pairs, from, to - 2, declarations, typeDecls, visiting);
    return { type: 'array', items: item ?? {} };
  }
  // Array<T> / Record<string, T>
  if (isIdent(tokens[from]) && isPunct(tokens[from + 1], '<') && pairs.get(from + 1) === to - 1) {
    const name = String(tokens[from].value);
    const inner = splitTopLevel(tokens, pairs, from + 2, to - 1, ',');
    if (name === 'Array' && inner.length === 1) {
      return { type: 'array', items: typeRangeToSchema(tokens, pairs, inner[0].from, inner[0].to, declarations, typeDecls, visiting) ?? {} };
    }
    if (name === 'Record' && inner.length === 2) {
      return { type: 'object', additionalProperties: typeRangeToSchema(tokens, pairs, inner[1].from, inner[1].to, declarations, typeDecls, visiting) ?? {} };
    }
    return {};
  }
  // 字面量
  const literal = literalText(tokens[from]);
  if (literal !== undefined && to - from === 1) return { const: literal };
  if (tokens[from].kind === 'number' && to - from === 1) return { const: Number(tokens[from].value) };
  if (isKeyword(tokens[from], 'true') && to - from === 1) return { const: true };
  if (isKeyword(tokens[from], 'false') && to - from === 1) return { const: false };
  if (isKeyword(tokens[from], 'null') && to - from === 1) return { type: 'null' };
  // 内联对象类型 `{ a: string }`
  if (isPunct(tokens[from], '{') && pairs.get(from) === to - 1) {
    return objectBodyToSchema(tokens, pairs, from + 1, to - 1, declarations, typeDecls, visiting);
  }
  // 已声明的 interface / type alias
  if (isIdent(tokens[from]) && to - from === 1) {
    const name = String(tokens[from].value);
    if (PRIMITIVE_SCHEMAS.has(name)) return PRIMITIVE_SCHEMAS.get(name);
    const built = declarations.get(name);
    if (built !== undefined) return built;
    const alias = typeDecls.get(name);
    if (alias !== undefined) {
      if (visiting.has(name)) return {};
      visiting.add(name);
      try {
        const schema = typeRangeToSchema(tokens, pairs, alias.bodyFrom, alias.bodyTo, declarations, typeDecls, visiting);
        const value = schema ?? {};
        declarations.set(name, value);
        return value;
      } finally {
        visiting.delete(name);
      }
    }
  }
  return {};
}

/**
 * 对象类型体 → `{type:'object', properties, required}`。
 * @param {object[]} tokens
 * @param {Map<number, number>} pairs
 * @param {number} from
 * @param {number} to
 * @param {Map<string, object>} declarations
 * @param {Map<string, {bodyFrom: number, bodyTo: number, alias: boolean}>} typeDecls
 * @param {Set<string>} visiting
 * @returns {object}
 */
function objectBodyToSchema(tokens, pairs, from, to, declarations, typeDecls, visiting) {
  /** @type {Record<string, object>} */
  const properties = {};
  /** @type {string[]} */
  const required = [];
  const members = splitTopLevel(tokens, pairs, from, to, ';').flatMap((part) => splitTopLevel(tokens, pairs, part.from, part.to, ','));
  for (const member of members) {
    if (member.to <= member.from) continue;
    const nameToken = tokens[member.from];
    const name = nameToken.kind === 'string' ? nameToken.value : String(nameToken.value);
    let cursor = member.from + 1;
    let optional = false;
    if (isPunct(tokens[cursor], '?')) {
      optional = true;
      cursor += 1;
    }
    if (!isPunct(tokens[cursor], ':')) continue;
    cursor += 1;
    const schema = typeRangeToSchema(tokens, pairs, cursor, member.to, declarations, typeDecls, visiting) ?? {};
    properties[name] = schema;
    if (!optional) required.push(name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * 按顶层分隔符切分 token 区间。
 * @param {object[]} tokens
 * @param {Map<number, number>} pairs
 * @param {number} from
 * @param {number} to
 * @param {string} separator
 * @returns {{from: number, to: number}[]}
 */
function splitTopLevel(tokens, pairs, from, to, separator) {
  /** @type {{from: number, to: number}[]} */
  const parts = [];
  let depth = 0;
  let start = from;
  for (let index = from; index < to; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'punct') continue;
    if (OPENERS.has(token.value)) depth += 1;
    else if (CLOSER_TO_OPEN.has(token.value)) depth -= 1;
    else if (token.value === separator && depth === 0) {
      parts.push({ from: start, to: index });
      start = index + 1;
    }
  }
  if (start < to) parts.push({ from: start, to });
  return parts.length === 0 ? [{ from, to }] : parts.filter((part) => part.to > part.from);
}

/* ================================================================================================
 * 6. 结构分析：函数体、扇出回调、独立语句
 * ============================================================================================== */

/**
 * `{` 是否是函数体（而不是 if/for/while/switch/catch 的块）。
 * @param {object[]} tokens
 * @param {Map<number, number>} pairs
 * @param {number} open
 * @returns {boolean}
 */
function isFunctionBody(tokens, pairs, open) {
  const before = tokens[open - 1];
  if (isPunct(before, '=>')) return true;
  if (!isPunct(before, ')')) return false;
  const paramsOpen = pairs.get(open - 1);
  if (paramsOpen === undefined) return false;
  const head = tokens[paramsOpen - 1];
  if (head === undefined) return false;
  if (isKeyword(head, 'function') || isKeyword(head, 'async')) return true;
  if (isPunct(head, '*')) return true;
  if (isIdent(head) || head.kind === 'keyword') {
    // `name(...) {` 可能是方法定义，也可能是 if/for/while/switch/catch/with
    const control = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'do', 'else']);
    return !control.has(String(head.value));
  }
  return false;
}

/**
 * 找出包住 `index` 的函数体（开括号下标），由内到外。
 * @param {object[]} tokens
 * @param {Map<number, number>} pairs
 * @param {number} index
 * @returns {number[]}
 */
function enclosingFunctionBodies(tokens, pairs, index) {
  /** @type {number[]} */
  const bodies = [];
  for (const [opener, closer] of pairs.entries()) {
    if (!isPunct(tokens[opener], '{')) continue;
    if (!(opener < index && index < closer)) continue;
    if (isFunctionBody(tokens, pairs, opener)) bodies.push(opener);
  }
  return bodies.sort((a, b) => b - a);
}

/**
 * 每个调用实参区间里的**函数字面量**区间。
 *
 * 为什么按实参区间而不是函数体块找回调：`.map((x) => agent("w"))` 的箭头只有表达式体，
 * 没有 `{`，按块找会漏掉——这正是内联链式/单行回调的形态。
 *
 * @param {object[]} tokens
 * @param {Map<number, number>} pairs
 * @returns {{from: number, to: number}[]}
 */
function functionArgumentRanges(tokens, pairs) {
  /** @type {{from: number, to: number}[]} */
  const ranges = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isPunct(tokens[index], '(')) continue;
    const previous = tokens[index - 1];
    const isCall = isIdent(previous) || isKeyword(previous, 'super')
      || isPunct(previous, ')') || isPunct(previous, ']');
    if (!isCall) continue;
    for (const arg of callArguments(tokens, pairs, index)) {
      if (isFunctionArgument(tokens, arg)) ranges.push({ from: arg.from, to: arg.to });
    }
  }
  return ranges;
}

/**
 * 扇出数组方法的回调实参区间（`.map(`、`.forEach(`、`.reduce(` …）。
 * @param {object[]} tokens
 * @param {Map<number, number>} pairs
 * @returns {{from: number, to: number}[]}
 */
function fanOutRanges(tokens, pairs) {
  /** @type {{from: number, to: number}[]} */
  const ranges = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isPunct(tokens[index], '(')) continue;
    const member = tokens[index - 1];
    if (!isIdent(member) || !FANOUT_METHODS.has(String(member.value))) continue;
    const dot = tokens[index - 2];
    if (!isPunct(dot, '.') && !isPunct(dot, '?.')) continue;
    for (const arg of callArguments(tokens, pairs, index)) {
      if (isFunctionArgument(tokens, arg)) ranges.push({ from: arg.from, to: arg.to });
    }
  }
  return ranges;
}

/**
 * token 下标是否落在某个区间里。
 * @param {{from: number, to: number}[]} ranges
 * @param {number} index
 * @returns {boolean}
 */
function inRanges(ranges, index) {
  return ranges.some((range) => range.from <= index && index < range.to);
}

/**
 * 值位置上是内联函数的变量名（`const fn = async () => …`）：`hole(name, fn)` 的体不是内联箭头，
 * 是契约里的 9012（体必须内联，fill 要按文本拼接）。
 * @param {object[]} tokens
 * @returns {Set<string>}
 */
/**
 * 值是 `model("…")` 调用结果的变量名（`const ref = model("a/x")`，可带类型标注）。
 * 这些变量在类型上是 ModelRef，契约 9010 明确允许把它交给 persona 的 `model`——
 * 文案里那句 “or a ModelRef from model("…")” 指的就是它，只有字面量被拒是错的。
 * @param {object[]} tokens
 * @returns {Set<string>}
 */
function collectModelRefVariables(tokens) {
  /** @type {Set<string>} */
  const names = new Set();
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (!(isKeyword(tokens[index], 'const') || isKeyword(tokens[index], 'let') || isKeyword(tokens[index], 'var'))) continue;
    if (!isIdent(tokens[index + 1])) continue;
    let cursor = index + 2;
    if (isPunct(tokens[cursor], ':')) {
      cursor += 1;
      while (cursor < tokens.length && !isPunct(tokens[cursor], '=') && !isPunct(tokens[cursor], ';')) cursor += 1;
    }
    if (!isPunct(tokens[cursor], '=')) continue;
    if (isIdent(tokens[cursor + 1], 'model') && isPunct(tokens[cursor + 2], '(')) names.add(String(tokens[index + 1].value));
  }
  return names;
}

function collectFunctionVariables(tokens) {
  /** @type {Set<string>} */
  const names = new Set();
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (!(isKeyword(tokens[index], 'const') || isKeyword(tokens[index], 'let') || isKeyword(tokens[index], 'var'))) continue;
    if (!isIdent(tokens[index + 1]) || !isPunct(tokens[index + 2], '=')) continue;
    let cursor = index + 3;
    if (isKeyword(tokens[cursor], 'async')) cursor += 1;
    if (isKeyword(tokens[cursor], 'function')) {
      names.add(String(tokens[index + 1].value));
      continue;
    }
    // `(a) =>` 或 `x =>`
    if (isPunct(tokens[cursor], '(')) {
      // 找到参数表结尾，再看是否 `=>`
      let depth = 0;
      for (let scan = cursor; scan < tokens.length; scan += 1) {
        if (isPunct(tokens[scan], '(')) depth += 1;
        else if (isPunct(tokens[scan], ')')) {
          depth -= 1;
          if (depth === 0) {
            if (isPunct(tokens[scan + 1], '=>')) names.add(String(tokens[index + 1].value));
            break;
          }
        }
      }
      continue;
    }
    if (isIdent(tokens[cursor]) && isPunct(tokens[cursor + 1], '=>')) names.add(String(tokens[index + 1].value));
  }
  return names;
}

/** 数组方法集合：回调按元素并发执行。 */
const FANOUT_METHODS = new Set([
  'map', 'flatMap', 'forEach', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex',
  'some', 'every', 'reduce', 'reduceRight', 'sort', 'toSorted', 'toReversed',
]);

/**
 * 找出包住 `index` 的循环体（`for` / `while` / `do` 的块）。
 * @param {object[]} tokens
 * @param {Map<number, number>} pairs
 * @param {number} index
 * @returns {boolean}
 */
function insideLoop(tokens, pairs, index) {
  for (const [opener, closer] of pairs.entries()) {
    if (!isPunct(tokens[opener], '{')) continue;
    if (!(opener < index && index < closer)) continue;
    const head = tokens[opener - 1];
    if (isPunct(head, ')')) {
      const open = pairs.get(opener - 1);
      const keyword = tokens[(open ?? 0) - 1];
      if (isKeyword(keyword, 'for') || isKeyword(keyword, 'while') || isKeyword(keyword, 'switch')) return true;
    }
    if (isKeyword(head, 'do')) return true;
  }
  return false;
}

/**
 * 找出包住 `index` 的条件分支体。
 * @param {object[]} tokens
 * @param {Map<number, number>} pairs
 * @param {number} index
 * @returns {boolean}
 */
function insideBranch(tokens, pairs, index) {
  for (const [opener, closer] of pairs.entries()) {
    if (!isPunct(tokens[opener], '{')) continue;
    if (!(opener < index && index < closer)) continue;
    const head = tokens[opener - 1];
    if (isPunct(head, ')')) {
      const open = pairs.get(opener - 1);
      const keyword = tokens[(open ?? 0) - 1];
      if (isKeyword(keyword, 'if') || isKeyword(keyword, 'switch') || isKeyword(keyword, 'catch')) return true;
    }
    if (isKeyword(head, 'else')) return true;
  }
  return false;
}

/**
 * `phase("…")` 是否独立成句（前后都是语句边界）。
 * @param {object[]} tokens
 * @param {Map<number, number>} pairs
 * @param {number} callee 被调用的标识符下标
 * @param {number} open `(` 的下标
 * @returns {boolean}
 */
function isStandaloneStatement(tokens, pairs, callee, open) {
  const before = tokens[callee - 1];
  const boundaryBefore = before === undefined
    || isPunct(before, ';')
    || isPunct(before, '{')
    || isPunct(before, '}');
  const close = pairs.get(open);
  if (close === undefined) return false;
  const after = tokens[close + 1];
  const boundaryAfter = after === undefined
    || isPunct(after, ';')
    || isPunct(after, '}')
    || after.line > tokens[close].line;
  return boundaryBefore && boundaryAfter;
}

/**
 * 名字是否被脚本自己声明（遮蔽 facade）。
 * @param {object[]} tokens
 * @returns {Set<string>}
 */
function collectDeclaredNames(tokens) {
  /** @type {Set<string>} */
  const names = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isKeyword(token, 'const') || isKeyword(token, 'let') || isKeyword(token, 'var')) {
      let cursor = index + 1;
      while (isIdent(tokens[cursor])) {
        names.add(String(tokens[cursor].value));
        cursor += 1;
        if (isPunct(tokens[cursor], ',')) {
          cursor += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (isKeyword(token, 'function') && isIdent(tokens[index + 1])) names.add(String(tokens[index + 1].value));
    if (isKeyword(token, 'class') && isIdent(tokens[index + 1])) names.add(String(tokens[index + 1].value));
    if (isKeyword(token, 'interface') && isIdent(tokens[index + 1])) names.add(String(tokens[index + 1].value));
    if (isKeyword(token, 'type') && isIdent(tokens[index + 1])) names.add(String(tokens[index + 1].value));
    // 函数/箭头参数
    if ((isIdent(token) || isPunct(token, ')')) && isPunct(tokens[index + 1], '=>')) {
      const previous = tokens[index];
      let paramStart = index;
      if (isPunct(previous, ')')) {
        // 参数表
        let depth = 0;
        for (let back = index; back >= 0; back -= 1) {
          if (isPunct(tokens[back], ')')) depth += 1;
          else if (isPunct(tokens[back], '(')) {
            depth -= 1;
            if (depth === 0) {
              paramStart = back + 1;
              break;
            }
          }
        }
      }
      for (let cursor = paramStart; cursor <= index; cursor += 1) {
        if (isIdent(tokens[cursor])) names.add(String(tokens[cursor].value));
      }
    }
  }
  return names;
}

/* ================================================================================================
 * 7. 站点收集 + 校验
 * ============================================================================================== */

/**
 * 判断一个标识符 token 是不是「作为值被读取」（前缀/后缀 `.`、属性名、声明名都不算）。
 * @param {object[]} tokens
 * @param {number} index
 * @returns {boolean}
 */
function isValueRead(tokens, index) {
  const before = tokens[index - 1];
  const after = tokens[index + 1];
  if (isPunct(before, '.') || isPunct(before, '?.') || isPunct(before, '#')) return false;
  if (isPunct(before, ':') && isPunct(tokens[index - 2], '{')) return false;
  if (isPunct(after, ':') && (isPunct(tokens[index - 2], '{') || isPunct(tokens[index - 2], ','))) return false;
  if (isKeyword(before, 'const') || isKeyword(before, 'let') || isKeyword(before, 'var')) return false;
  if (isKeyword(before, 'function') || isKeyword(before, 'class')) return false;
  if (isKeyword(before, 'interface') || isKeyword(before, 'type')) return false;
  return true;
}

/** facade 里「只能直接调用」的函数名（`agent/phase/report/hole/log/channel/future/model`）。 */
const FACADE_CALLABLES = new Set(['agent', 'phase', 'report', 'hole', 'log', 'channel', 'future', 'model']);

/** G1 旧 Workflow facade 的名字：现行脚本里不存在，必须显式诊断（见 M1）。 */
const LEGACY_FACADE_NAMES = new Set(['parallel', 'pipeline', 'budget', 'workflow']);

/**
 * 语言内建可调用名：不算「找不到这个名字」。（Node/web API 不在此列：`process`/`require`/`fetch`。）
 * `eval`/`Function` 是 lib.es5 的全局，真 TS 不报，cell 里也调得到（hole 的 fill 就靠 eval）。
 */
const BUILTIN_CALLABLES = new Set([
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet',
  'Symbol', 'BigInt', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'JSON', 'Math', 'Date',
  'Intl', 'RegExp', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'structuredClone', 'console', 'queueMicrotask',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'TextEncoder', 'TextDecoder',
  'eval', 'Function',
]);

/** 片段（snippet）里不存在的 facade 名。 */
const SNIPPET_ABSENT = new Set(['agent', 'phase', 'report', 'artifact', 'hole', 'model']);

/**
 * 分析 + 校验。
 *
 * 返回所有站点（供 lowering 用）与结构化事实；诊断按 `{code, line, column, message}` 收集。
 *
 * @param {string} code
 * @param {object[]} tokens
 * @param {Map<number, number>} pairs
 * @param {'workflow'|'snippet'} mode
 * @returns {{diagnostics: object[], sites: object[], types: Map<string, object>}}
 */
function analyze(code, tokens, pairs, mode) {
  /** @type {object[]} */
  const diagnostics = [];
  const report = (code_, token, message) => {
    diagnostics.push({ code: code_, line: token?.line ?? 1, column: token?.column ?? 1, message });
  };

  const declared = collectDeclaredNames(tokens);
  const typeDecls = collectTypeDeclarations(tokens, pairs);
  // 回调/扇出按**实参区间**识别（内联单行回调没有函数体块，见 functionArgumentRanges 注释）。
  const functionArgs = functionArgumentRanges(tokens, pairs);
  const fanOutArgs = fanOutRanges(tokens, pairs);
  const functionVariables = collectFunctionVariables(tokens);
  const modelRefVariables = collectModelRefVariables(tokens);
  /** @type {Map<string, object>} */
  const interfaces = new Map();
  const isFacadeFree = (name) => !declared.has(name);

  /** @type {object[]} */
  const sites = [];
  /** @type {object[]} */
  const phases = [];
  /** @type {{name: string, line: number}[]} */
  const actorLiterals = [];
  /** @type {string[]} */
  const holeNames = [];
  const holeSiteIds = new Map();
  /** @type {Map<string, {op: string, line: number}>} */
  const artifactIds = new Map();

  /** phase 语句的位置（名字 + 括号结束处），用于推导站点所属阶段 */
  const phaseMarkers = [];
  const counters = new SiteCounters();

  // —— 第一遍：模块语法 / 禁止 API / facade 取引用 ——
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isKeyword(token, 'declare')) {
      report(CODE.MODULE_SYNTAX, token, DIAGNOSTIC_MESSAGES.declareModifier);
      continue;
    }
    if (isKeyword(token, 'export')) {
      report(CODE.MODULE_SYNTAX, token, DIAGNOSTIC_MESSAGES.exportStatement);
      continue;
    }
    if (isKeyword(token, 'import')) {
      report(CODE.MODULE_SYNTAX, token, DIAGNOSTIC_MESSAGES.importStatement);
      continue;
    }
    if (token.kind !== 'ident') continue;
    const name = String(token.value);
    // 名字不存在（TS 2304）：Node/web 全局在这里没有声明，与真 TS 的语义诊断同一条。
    // `fs` 不在其中：它常是脚本自己的变量名，Node 内置本就不可达。
    if (isFacadeFree(name) && (name === 'process' || name === 'require' || name === 'fetch')
      && isValueRead(tokens, index)) {
      report(CODE.UNKNOWN_NAME, token, DIAGNOSTIC_MESSAGES.unknownName(name));
      continue;
    }
    // facade 取引用（9001）
    if (FACADE_CALLABLES.has(name) && isFacadeFree(name)) {
      const next = tokens[index + 1];
      // 泛型调用 `hole<…>(` 也算直接调用（站点身份仍按调用点记）。
      const isCall = isPunct(next, '(') || isPunct(next, '<');
      if (!isCall && isValueRead(tokens, index)) report(CODE.FACADE_MISUSE, token, DIAGNOSTIC_MESSAGES.facadeReturned(name));
    }
    // 片段里不存在的 facade（9001）
    if (mode === 'snippet' && SNIPPET_ABSENT.has(name) && isFacadeFree(name)
      && (isPunct(tokens[index + 1], '(') || isPunct(tokens[index + 1], '<'))) {
      report(CODE.FACADE_MISUSE, token, DIAGNOSTIC_MESSAGES.snippetAbsent(name));
      continue;
    }
    // G1 旧 facade 名字 / 未知函数调用：脚本里根本没有这个名字（TS 2304，文案逐字）
    if (!declared.has(name) && LEGACY_FACADE_NAMES.has(name) && isValueRead(tokens, index)) {
      report(CODE.UNKNOWN_NAME, token, DIAGNOSTIC_MESSAGES.unknownName(name));
      continue;
    }
    if (!declared.has(name) && !FACADE_CALLABLES.has(name) && !BUILTIN_CALLABLES.has(name)
      && !typeDecls.has(name) && isPunct(tokens[index + 1], '(')
      && !isPunct(tokens[index - 1], '.') && !isPunct(tokens[index - 1], '?.')
      && !isKeyword(tokens[index - 1], 'new') && !isKeyword(tokens[index - 1], 'function')
      && !isKeyword(tokens[index - 1], 'async') && !isKeyword(tokens[index - 1], 'get')
      && !isKeyword(tokens[index - 1], 'set')) {
      // 类/对象字面量的方法定义（`name(...) {`）不是调用。
      const callClose = pairs.get(index + 1);
      const methodDefinition = callClose !== undefined && isPunct(tokens[callClose + 1], '{')
        && (isPunct(tokens[index - 1], '{') || isPunct(tokens[index - 1], ';')
          || isPunct(tokens[index - 1], '}') || isPunct(tokens[index - 1], ','));
      if (!methodDefinition) report(CODE.UNKNOWN_NAME, token, DIAGNOSTIC_MESSAGES.unknownName(name));
    }
  }

  // —— 先解析全部 interface / type alias，供 ask<T> 与后续站点引用 ——
  for (const [typeName, declaration] of typeDecls.entries()) {
    if (declaration.alias) {
      const schema = typeRangeToSchema(tokens, pairs, declaration.bodyFrom, declaration.bodyTo, interfaces, typeDecls);
      if (schema !== undefined) interfaces.set(typeName, schema);
    } else {
      interfaces.set(typeName, objectBodyToSchema(tokens, pairs, declaration.bodyFrom, declaration.bodyTo, interfaces, typeDecls, new Set()));
    }
  }

  /** @type {{tag: string | undefined, token: object | undefined}[]} */
  const pendingReportTags = [];
  /** @type {{name: string, token: object}[]} */
  const pendingHoleNames = [];

  // —— 第二遍：站点收集 + 各规则 ——
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'ident') continue;
    const name = String(token.value);
    // 调用点：`name(` 或 `name<…>(`（泛型调用先跳过类型参数，hole/ask 都靠它）
    let open = index + 1;
    let typeArgFrom = -1;
    let typeArgTo = -1;
    if (!isPunct(tokens[open], '(') && isPunct(tokens[open], '<')) {
      let depth = 0;
      for (let cursor = open; cursor < tokens.length; cursor += 1) {
        if (isPunct(tokens[cursor], '<')) depth += 1;
        else if (isPunct(tokens[cursor], '>')) {
          depth -= 1;
          if (depth === 0) {
            typeArgTo = cursor;
            open = cursor + 1;
            typeArgFrom = index + 2;
            break;
          }
        }
      }
    }
    // 直接调用（`name(...)`）与成员调用（`artifact.file(...)`）都要继续；其他形态跳过。
    const isDirectCall = isPunct(tokens[open], '(');
    const isMemberCall = isPunct(tokens[open], '.');
    if (!isDirectCall && !isMemberCall) continue;
    const close = isDirectCall ? pairs.get(open) : -1;
    if (isDirectCall && close === undefined) continue;
    const args = isDirectCall ? callArguments(tokens, pairs, open) : [];
    const shadowed = declared.has(name);

    // agent(name?, persona?)
    if (name === 'agent' && !shadowed) {
      const siteId = counters.next('actor');
      const nameArg = args[0];
      // 名字是「站点身份」的一部分：只有整个实参就是一个字符串字面量时才算定名，
      // 否则 `agent("reviewer-" + item)` 这种逐元素名字会被当成固定名而误报 9006——
      // 而那正是 9006 文案推荐的写法。
      const literalName = nameArg === undefined ? undefined
        : (nameArg.to - nameArg.from === 1 ? literalText(tokens[nameArg.from]) : undefined);
      const site = {
        kind: 'actor',
        id: siteId,
        callee: index,
        open,
        close,
        line: token.line,
        args,
        name: literalName,
        persona: args[1] === undefined ? undefined : rangeText(code, tokens, args[1].from, args[1].to),
      };
      sites.push(site);
      if (literalName !== undefined) {
        if (literalName !== '') actorLiterals.push({ name: literalName, line: token.line });
        if (literalName !== '' && isInsideFanOutAt(index)) report(CODE.FIXED_ACTOR_NAME, token, DIAGNOSTIC_MESSAGES.fixedActorName(literalName));
      }
      // persona.model 必须是字面量或 ModelRef（9010）
      checkPersonaModel(site, token);
      continue;
    }

    // a.ask(…) / a.ask<T>(…)
    if (name === 'ask' && !shadowed && (isPunct(tokens[index - 1], '.') || isPunct(tokens[index - 1], '?.'))) {
      const receiverEnd = index - 1;
      const receiverStart = expressionStart(tokens, pairs, receiverEnd - 1);
      const siteId = counters.next('ask');
      const spec = askSpecAt(typeArgFrom, typeArgTo, token);
      sites.push({
        kind: 'ask',
        id: siteId,
        callee: index,
        dot: index - 1,
        open,
        close,
        line: token.line,
        args,
        receiverStart,
        receiverEnd,
        optional: isPunct(tokens[index - 1], '?.'),
        typeOpen: typeArgFrom >= 0 ? index + 1 : -1,
        typeClose: typeArgTo,
        ...spec,
      });
      continue;
    }

    // hole<T>(…)
    if (name === 'hole' && !shadowed) {
      if (typeArgFrom < 0) report(CODE.HOLE, token, DIAGNOSTIC_MESSAGES.holeTypeArgument);
      const holeArgs = args;
      const holeClose = close;
      const nameToken = holeArgs[0] === undefined ? undefined : tokens[holeArgs[0].from];
      const literalName = literalText(nameToken);
      if (literalName === undefined) report(CODE.HOLE, nameToken ?? token, DIAGNOSTIC_MESSAGES.holeNameLiteral);
      else if (literalName.trim() === '') report(CODE.HOLE, nameToken, DIAGNOSTIC_MESSAGES.holeNameEmpty);
      else if (literalName.length > 128) report(CODE.HOLE, nameToken, DIAGNOSTIC_MESSAGES.holeNameLong(128));
      if (literalName !== undefined && literalName.trim() !== '') {
        const trimmed = literalName.trim();
        if (holeNames.includes(trimmed)) report(CODE.HOLE, nameToken, DIAGNOSTIC_MESSAGES.holeDuplicate(trimmed));
        holeNames.push(trimmed);
        pendingHoleNames.push({ name: trimmed, token: nameToken });
        const siteId = `hole#${fnv1a(trimmed)}`;
        if (holeSiteIds.has(siteId) && holeSiteIds.get(siteId) !== trimmed) {
          report(CODE.HOLE, nameToken, DIAGNOSTIC_MESSAGES.holeIdCollision(holeSiteIds.get(siteId), trimmed));
        }
        holeSiteIds.set(siteId, trimmed);
      }
      // await 与扇出位置
      if (!isKeyword(tokens[index - 1], 'await')) report(CODE.HOLE, token, DIAGNOSTIC_MESSAGES.holeNotAwaited);
      if (isInsideFanOutAt(index)) report(CODE.HOLE, token, DIAGNOSTIC_MESSAGES.holeInFanOut);
      // body 必须是内联箭头（函数放进变量就没有可拼接的文本，9012）
      const bodyArg = holeArgs.length >= 3 ? holeArgs[2] : (holeArgs.length === 2 && isFunctionArgument(tokens, holeArgs[1]) ? holeArgs[1] : undefined);
      if (bodyArg !== undefined && !isArrowFunctionArgument(tokens, bodyArg)) {
        report(CODE.HOLE, tokens[bodyArg.from], DIAGNOSTIC_MESSAGES.holeBodyNotArrow);
      } else if (bodyArg === undefined && holeArgs.length === 2 && isIdent(tokens[holeArgs[1].from])
        && functionVariables.has(String(tokens[holeArgs[1].from].value))) {
        report(CODE.HOLE, tokens[holeArgs[1].from], DIAGNOSTIC_MESSAGES.holeBodyNotArrow);
      }
      const typeText = typeArgFrom >= 0 ? rangeText(code, tokens, typeArgFrom, typeArgTo) : undefined;
      sites.push({
        kind: 'hole',
        id: literalName !== undefined && literalName.trim() !== '' ? `hole#${fnv1a(literalName.trim())}` : counters.next('hole'),
        callee: index,
        open,
        close: holeClose,
        line: token.line,
        args: holeArgs,
        name: literalName,
        typeText,
        hasTypeArg: typeArgFrom >= 0,
        typeOpen: typeArgFrom >= 0 ? index + 1 : -1,
        typeClose: typeArgTo,
      });
      continue;
    }

    // phase("…")
    if (name === 'phase' && !shadowed) {
      const nameToken = args[0] === undefined ? undefined : tokens[args[0].from];
      const literalName = literalText(nameToken);
      if (literalName === undefined) report(CODE.PHASE, nameToken ?? token, DIAGNOSTIC_MESSAGES.phaseLiteral);
      else if (literalName.trim() === '') report(CODE.PHASE, nameToken, DIAGNOSTIC_MESSAGES.phaseEmpty);
      else if (!isStandaloneStatement(tokens, pairs, index, open)) report(CODE.PHASE, token, DIAGNOSTIC_MESSAGES.phaseStandalone);
      if (literalName !== undefined && literalName.trim() !== '') {
        phases.push({ name: literalName.trim(), line: token.line });
        phaseMarkers.push({ name: literalName.trim(), start: tokens[index].start, close, index });
      }
      sites.push({ kind: 'phase', id: counters.next('phase'), callee: index, open, close, line: token.line, name: literalName, args });
      continue;
    }

    // log / channel / future
    if ((name === 'log' || name === 'channel' || name === 'future') && !shadowed) {
      sites.push({ kind: 'call', op: name, id: counters.next('call'), callee: index, open, close, line: token.line, args });
      continue;
    }

    // model("…")
    if (name === 'model' && !shadowed) {
      const literal = args[0] === undefined ? undefined : literalText(tokens[args[0].from]);
      if (literal === undefined || literal.length === 0) report(CODE.MODEL, token, DIAGNOSTIC_MESSAGES.modelLiteral);
      sites.push({ kind: 'model', id: counters.next('model'), callee: index, open, close, line: token.line, args, model: literal });
      continue;
    }

    // report(item, tag?)
    if (name === 'report' && !shadowed) {
      const tagArg = args[1];
      const tag = tagArg === undefined ? undefined : literalText(tokens[tagArg.from]);
      if (tagArg !== undefined && tag === undefined) report(CODE.ARTIFACT, tokens[tagArg.from], DIAGNOSTIC_MESSAGES.reportTagLiteral);
      // tag 指向的 preset 可能声明在 report 之后，所以校验放到收集结束后统一做。
      if (tag !== undefined && tag !== '') pendingReportTags.push({ tag, token: tokens[tagArg.from] });
      sites.push({ kind: 'report', id: counters.next('report'), callee: index, open, close, line: token.line, args });
      continue;
    }

    // artifact.<op>(…)
    if (name === 'artifact' && !shadowed && isPunct(tokens[index + 1], '.')) {
      const opToken = tokens[index + 2];
      const op = opToken !== undefined && opToken.kind === 'ident' ? String(opToken.value) : '';
      if (!ARTIFACT_KINDS.has(op)) {
        report(CODE.ARTIFACT, opToken ?? token, DIAGNOSTIC_MESSAGES.artifactUnknownKind(op));
        continue;
      }
      const opOpen = index + 3;
      if (!isPunct(tokens[opOpen], '(')) continue;
      const opClose = pairs.get(opOpen);
      const opArgs = callArguments(tokens, pairs, opOpen);
      const idArg = opArgs[0];
      const idToken = idArg === undefined ? undefined : tokens[idArg.from];
      const id = literalText(idToken);
      if (idToken === undefined || id === undefined) {
        report(CODE.ARTIFACT, idToken ?? opToken ?? token, DIAGNOSTIC_MESSAGES.artifactIdLiteral);
      } else if (id === '') {
        report(CODE.ARTIFACT, idToken, DIAGNOSTIC_MESSAGES.artifactIdEmpty);
      } else if (id.length > 64) {
        report(CODE.ARTIFACT, idToken, DIAGNOSTIC_MESSAGES.artifactIdLong(id, id.length, 64));
      } else if (!/^[A-Za-z0-9_.-]+$/u.test(id)) {
        report(CODE.ARTIFACT, idToken, DIAGNOSTIC_MESSAGES.artifactIdCharacters(id));
      } else {
        const previous = artifactIds.get(id);
        if (previous !== undefined && previous.op !== op) {
          report(CODE.ARTIFACT, token, DIAGNOSTIC_MESSAGES.artifactKindConflict(id, previous.op, previous.line, op));
        } else if (previous === undefined) {
          artifactIds.set(id, { op, line: token.line });
        }
      }
      // preset 必须在顶层（9008）
      if (op !== 'file' && op !== 'markdown') {
        if (isInsideCallbackAt(index)) report(CODE.PRESET_PLACEMENT, token, DIAGNOSTIC_MESSAGES.presetInCallback);
        else if (insideLoop(tokens, pairs, index)) report(CODE.PRESET_PLACEMENT, token, DIAGNOSTIC_MESSAGES.presetInLoop);
        else if (insideBranch(tokens, pairs, index)) report(CODE.PRESET_PLACEMENT, token, DIAGNOSTIC_MESSAGES.presetInBranch);
      }
      sites.push({
        kind: 'artifact',
        id: counters.next('artifact'),
        op,
        callee: index,
        memberStart: index,
        open: opOpen,
        close: opClose,
        line: token.line,
        args: opArgs,
        artifactId: id,
        primary: hasPrimary(op, opArgs),
      });
      continue;
    }

    // files.* / git.* / world.run
    const isFiles = name === 'files' && !shadowed && isPunct(tokens[index + 1], '.');
    const isGit = name === 'git' && !shadowed && isPunct(tokens[index + 1], '.');
    const isWorld = name === 'world' && !shadowed && isPunct(tokens[index + 1], '.') && isIdent(tokens[index + 2], 'run');
    if (isFiles || isGit || isWorld) {
      const op = String(tokens[index + 2]?.value);
      const opOpen = index + 3;
      if (!isPunct(tokens[opOpen], '(')) continue;
      const opClose = pairs.get(opOpen);
      const opArgs = callArguments(tokens, pairs, opOpen);
      if (isWorld && op === 'run') {
        const first = opArgs[0] === undefined ? undefined : literalText(tokens[opArgs[0].from]);
        if (first === undefined) report(CODE.WORLD_COMMAND, tokens[opArgs[0]?.from ?? index], DIAGNOSTIC_MESSAGES.worldLiteral);
      }
      sites.push({
        kind: 'worldRead',
        id: counters.next('world-read'),
        op,
        object: name,
        callee: index,
        open: opOpen,
        close: opClose,
        line: token.line,
        args: opArgs,
      });
      continue;
    }
  }

  // —— actor 重名（9005） ——
  const seenActors = new Map();
  for (const actor of actorLiterals) {
    const first = seenActors.get(actor.name);
    if (first !== undefined) {
      const token = tokens.find((candidate) => candidate.line === actor.line && candidate.kind === 'ident' && candidate.value === 'agent');
      report(CODE.DUPLICATE_ACTOR, token ?? { line: actor.line, column: 1 }, DIAGNOSTIC_MESSAGES.duplicateActor(actor.name, first.line));
    } else {
      seenActors.set(actor.name, actor);
    }
  }

  // —— 阶段归属：每个站点属于哪个 phase（由内向外找最近的、位于站点之前的 marker） ——
  const sitePhases = new Map();
  for (const site of sites) {
    const siteTokenIndex = site.callee;
    const siteStart = tokens[siteTokenIndex]?.start ?? 0;
    /** @type {{from: number, to: number}[]} */
    const scopes = [];
    for (const [opener, closer] of pairs.entries()) {
      if (!isPunct(tokens[opener], '{')) continue;
      if (opener < siteTokenIndex && siteTokenIndex < closer) scopes.push({ from: opener, to: closer });
    }
    // 内层块优先；最外层（整个脚本）兜底。
    scopes.sort((a, b) => (a.to - a.from) - (b.to - b.from));
    scopes.push({ from: 0, to: tokens.length });
    for (const scope of scopes) {
      const marker = phaseMarkers
        .filter((candidate) => candidate.start < siteStart && candidate.close < scope.to && candidate.close > scope.from)
        .sort((a, b) => b.start - a.start)[0];
      if (marker !== undefined) {
        sitePhases.set(site.id, marker.name);
        break;
      }
    }
  }

  /* ------- 局部辅助 ------- */
  function isInsideFanOutAt(callIndex) {
    return inRanges(fanOutArgs, callIndex);
  }

  function isInsideCallbackAt(callIndex) {
    // 实参里的函数字面量（含单行箭头）+ 脚本自己声明的辅助函数体，都算“回调式位置”。
    return inRanges(functionArgs, callIndex) || enclosingFunctionBodies(tokens, pairs, callIndex).length > 0;
  }

  function askSpecAt(typeFrom, typeTo, siteToken) {
    const spec = { typed: false, typeText: undefined, schema: undefined, typeName: undefined };
    if (typeFrom < 0) return spec;
    const typeText = rangeText(code, tokens, typeFrom, typeTo);
    const plain = /^([A-Za-z_$][\w$]*)(\[\])?$/u.exec(typeText.trim());
    if (plain === null) {
      report(CODE.HOLE, siteToken, DIAGNOSTIC_MESSAGES.askTypeUnsupported(typeText));
      return spec;
    }
    const baseName = plain[1];
    const built = interfaces.get(baseName);
    let schema;
    if (built !== undefined) schema = built;
    else if (PRIMITIVE_SCHEMAS.has(baseName)) schema = PRIMITIVE_SCHEMAS.get(baseName);
    else if (typeDecls.has(baseName)) schema = typeRangeToSchema(tokens, pairs, typeFrom, typeTo, interfaces, typeDecls);
    else {
      report(CODE.HOLE, siteToken, DIAGNOSTIC_MESSAGES.askTypeUndeclared(baseName));
      return spec;
    }
    const finalSchema = plain[2] === undefined ? schema : { type: 'array', items: schema ?? {} };
    return { typed: true, typeText, typeName: baseName + (plain[2] ?? ''), schema: finalSchema };
  }

  // —— 延迟校验：hole 名与 phase 重名、report tag 是否指向已声明的 preset ——
  for (const hole of pendingHoleNames) {
    if (phases.some((phase) => phase.name === hole.name)) {
      report(CODE.HOLE, hole.token, DIAGNOSTIC_MESSAGES.holePhaseCollision(hole.name));
    }
  }
  const presetIds = [...artifactIds.entries()]
    .filter(([, info]) => info.op !== 'file' && info.op !== 'markdown')
    .map(([id]) => id);
  for (const tag of pendingReportTags) {
    const declared = artifactIds.get(tag.tag);
    if (declared !== undefined && (declared.op === 'file' || declared.op === 'markdown')) {
      report(CODE.ARTIFACT, tag.token, DIAGNOSTIC_MESSAGES.reportTagContent(tag.tag));
    } else if (declared === undefined) {
      report(CODE.ARTIFACT, tag.token, DIAGNOSTIC_MESSAGES.reportTagUnknown(
        tag.tag,
        presetIds.length === 0 ? DIAGNOSTIC_MESSAGES.noPresets : DIAGNOSTIC_MESSAGES.declaredPresets(presetIds),
      ));
    }
  }

  function checkPersonaModel(site, token) {
    // persona 是第二个实参；只检查对象字面量里的 `model: <非字面量>`
    const personaArg = site.args[1];
    if (personaArg === undefined) return;
    for (let cursor = personaArg.from; cursor < personaArg.to - 1; cursor += 1) {
      if (isIdent(tokens[cursor], 'model') && isPunct(tokens[cursor + 1], ':')) {
        const valueToken = tokens[cursor + 2];
        const literal = literalText(valueToken);
        const isModelRef = (isIdent(valueToken, 'model') && isPunct(tokens[cursor + 3], '('))
          || (isIdent(valueToken) && modelRefVariables.has(String(valueToken.value)));
        const isMember = isPunct(valueToken, '.') || isIdent(valueToken);
        if (literal === undefined && !isModelRef && isMember && !(isIdent(valueToken, 'model'))) {
          report(CODE.MODEL, valueToken ?? token, DIAGNOSTIC_MESSAGES.actorModelDynamic('unknown'));
        }
      }
    }
  }

  function hasPrimary(op, opArgs) {
    // primary 在 ArtifactOptions 里，六种 kind 都收：content（file/markdown）的 opts 是第 3 个
    // 实参（id, path|content, opts），preset 的 spec 是第 2 个（id, spec）。
    const optionsArg = op === 'file' || op === 'markdown' ? opArgs[2] : opArgs[1];
    if (optionsArg === undefined) return false;
    for (let cursor = optionsArg.from; cursor < optionsArg.to - 1; cursor += 1) {
      if (isIdent(tokens[cursor], 'primary') && isPunct(tokens[cursor + 1], ':')) {
        return isKeyword(tokens[cursor + 2], 'true');
      }
    }
    return false;
  }

  // 一个 run 只能有一个交付物：第二条 primary 是契约的 9009（`cli.md:643252`），不是 9011
  // （9011 是模型可用性）。逐个对照第一条报，文案带首条所在的 kind 与行号。
  const primaries = sites.filter((site) => site.kind === 'artifact' && site.primary === true && site.artifactId);
  if (primaries.length > 1) {
    const [first, ...rest] = primaries;
    for (const extra of rest) {
      report(CODE.PRIMARY_CONFLICT, tokens[extra.callee], DIAGNOSTIC_MESSAGES.primaryConflict(extra.artifactId, first.artifactId, first.op, first.line));
    }
  }

  // 空脚本：契约里没有对应诊断（空的 `return;` 也合法），这里不报；空脚本在运行期就是一个
  // 立即完成、返回 undefined 的 run。

  return { diagnostics, sites, types: interfaces, phases, sitePhases };
}

/** artifact 的六个成员。 */
const ARTIFACT_KINDS = new Set(['file', 'markdown', 'chart', 'table', 'metrics', 'board']);

/* ================================================================================================
 * 8. lowering：文本编辑
 * ============================================================================================== */

/**
 * 把落在 `[from, to)` 里的编辑套用到这段源码上（用于把 receiver 的内部改写烘焙进外层替换文本）。
 * @param {string} code
 * @param {number} from
 * @param {number} to
 * @param {{start: number, end: number, text: string}[]} edits
 * @returns {string}
 */
function applyEditsInRange(code, from, to, edits) {
  const inner = edits.filter((edit) => edit.start >= from && edit.end <= to);
  inner.sort((a, b) => (b.start - a.start) || (b.end - a.end));
  let output = code.slice(from, to);
  for (const edit of inner) {
    output = `${output.slice(0, edit.start - from)}${edit.text}${output.slice(edit.end - from)}`;
  }
  return output;
}

/**
 * 把分析得到的站点改写为 `__host.*` 调用。
 *
 * 为什么用文本编辑而不是重新打印 AST：行号必须与用户脚本一致（诊断、journal 的
 * `scriptLine`、UI 都按行号引用）；文本编辑只在必要处插入/替换，其余字节原样保留。
 *
 * @param {string} code
 * @param {object} analysis analyze() 的返回值
 * @returns {{ code: string, edits: object[] }}
 */
function lowerScript(code, analysis) {
  const { sites } = analysis;
  /** @type {{start: number, end: number, text: string}[]} */
  const edits = [];
  const insert = (at, text) => edits.push({ start: at, end: at, text });
  const replace = (start, end, text) => edits.push({ start, end, text });

  for (const site of sites) {
    if (site.kind === 'actor') {
      // agent(…) → __host.createActor("actor#N", …)
      replace(site.calleeStart, site.calleeEnd, '__host.createActor');
      insert(site.afterOpen, `${jsString(site.id)}, `);
      continue;
    }
    if (site.kind === 'ask') {
      // 放到所有其它编辑收集完之后统一处理：ask 的替换区间包住 receiver，必须先把 receiver
      // 内部的站点改写（`agent(...)` → `__host.createActor(...)`）套用进替换文本，见 B1。
      continue;
    }
    if (site.kind === 'hole') {
      // hole<T>(name, …) → __host.hole("hole#…", name, prompt, (__src) => eval(__src), body?)
      replace(site.calleeStart, site.calleeEnd, '__host.hole');
      insert(site.afterOpen, `${jsString(site.id)}, `);
      if (site.typeRange !== undefined) replace(site.typeRange.start, site.typeRange.end, '');
      if (site.args.length >= 3) {
        insert(site.args[1].endOffset, ', (__src) => eval(__src)');
      } else if (site.args.length === 2 && site.secondIsFunction) {
        insert(site.args[1].startOffset, 'void 0, (__src) => eval(__src), ');
      } else if (site.args.length <= 1) {
        insert(site.args[0]?.endOffset ?? site.afterOpen, ', void 0, (__src) => eval(__src)');
      } else {
        // hole(name, prompt) —— 只有 prompt
        insert(site.args[1].endOffset, ', (__src) => eval(__src)');
      }
      continue;
    }
    if (site.kind === 'phase') {
      if (site.name === undefined || site.name.trim() === '') {
        replace(site.start, site.end, 'void 0');
      } else {
        replace(site.calleeStart, site.calleeEnd, '__host.enterPhase');
      }
      continue;
    }
    if (site.kind === 'call') {
      // log(x) / channel(n) / future(f) → __host.<op>(…)
      replace(site.calleeStart, site.calleeEnd, `__host.${site.op}`);
      continue;
    }
    if (site.kind === 'model') {
      if (site.model === undefined) replace(site.start, site.end, 'void 0');
      else replace(site.start, site.end, jsString(site.model));
      continue;
    }
    if (site.kind === 'report') {
      replace(site.calleeStart, site.calleeEnd, '__host.report');
      insert(site.afterOpen, `${jsString(site.id)}, `);
      continue;
    }
    if (site.kind === 'artifact') {
      const host = site.op === 'file' || site.op === 'markdown' ? 'publishArtifact' : 'declareArtifact';
      replace(site.memberStartOffset, site.afterOpen, `__host.${host}(${jsString(site.id)}, ${jsString(site.op)}, [`);
      insert(site.closeOffset, ']');
      continue;
    }
    if (site.kind === 'worldRead') {
      replace(site.memberStartOffset, site.afterOpen, `__host.worldRead(${jsString(site.id)}, ${jsString(site.op)}, [`);
      insert(site.closeOffset, ']');
      continue;
    }
  }

  // 自由标识符 args / run → __host.args / __host.run（在站点改写之后做，避免影响站点位置计算）
  for (let index = 0; index < analysis.tokens.length; index += 1) {
    const token = analysis.tokens[index];
    if (token.kind !== 'ident') continue;
    if (token.value !== 'args' && token.value !== 'run') continue;
    if (analysis.declared?.has(String(token.value)) === true) continue;
    if (!isValueRead(analysis.tokens, index)) continue;
    const before = analysis.tokens[index - 1];
    if (isPunct(before, '.') || isPunct(before, '?.')) continue;
    replace(token.start, token.end, `__host.${token.value}`);
  }

  // —— ask 站点：自底向上（先 receiver 内部、再本层）——
  // 为什么最后做：替换区间 `receiverStart..afterOpen` 包住 receiver，内联链式
  // `agent("x").ask("y")` 的 actor 改写必须已经生成，才能被"烘焙"进替换文本；
  // 被烘焙的编辑从最终应用列表里剔除，避免同一段被改两次。
  /** @type {Set<object>} */
  const consumed = new Set();
  const askSites = sites.filter((site) => site.kind === 'ask')
    .sort((a, b) => b.receiverStartOffset - a.receiverStartOffset);
  for (const site of askSites) {
    if (site.optional) {
      const receiver = applyEditsInRange(code, site.receiverStartOffset, site.dotStartOffset, edits);
      const argsText = site.afterOpen <= site.closeOffset
        ? applyEditsInRange(code, site.afterOpen, site.closeOffset, edits)
        : '';
      for (const edit of edits) {
        if (edit.start >= site.receiverStartOffset && edit.end <= site.end) consumed.add(edit);
      }
      edits.push({
        start: site.receiverStartOffset,
        end: site.end,
        text: `((__a) => __a === null || __a === undefined ? undefined : __host.ask(${jsString(site.id)}, __a${argsText.trim() === '' ? '' : `, ${argsText}`}))(${receiver})`,
      });
      continue;
    }
    const receiver = applyEditsInRange(code, site.receiverStartOffset, site.dotStartOffset, edits);
    for (const edit of edits) {
      if (edit.start >= site.receiverStartOffset && edit.end <= site.afterOpen) consumed.add(edit);
    }
    edits.push({
      start: site.receiverStartOffset,
      end: site.afterOpen,
      text: `__host.ask(${jsString(site.id)}, ${receiver}, `,
    });
  }

  // 应用编辑：从后往前，保证偏移不互相影响
  const remaining = edits.filter((edit) => !consumed.has(edit));
  remaining.sort((a, b) => (b.start - a.start) || (b.end - a.end));
  let output = code;
  for (const edit of remaining) {
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  }
  return { code: output, edits: remaining };
}

/* ================================================================================================
 * 9. 保存工作流的元数据块（`/* zcode-workflow` YAML）
 * ============================================================================================== */

const METADATA_OPEN = '/* zcode-workflow';
const ARG_TYPES = new Set(['string', 'number', 'boolean', 'json']);

/**
 * 解析保存工作流的元数据块。
 * 失败返回 `{ ok: false, reason }`，reason ∈ missing_frontmatter / unterminated_frontmatter /
 * invalid_yaml / invalid_metadata。
 *
 * @param {string} input
 * @returns {{ok: true, meta: object, script: string, bodyLineOffset: number} | {ok: false, reason: string, message: string}}
 */
export function extractMetadataHeader(input) {
  const code = normalizeSource(input);
  const lines = code.split('\n');
  let first = 0;
  while (first < lines.length && lines[first].trim() === '') first += 1;
  if (lines[first] === undefined || lines[first].trim() !== METADATA_OPEN) {
    return {
      ok: false,
      reason: 'missing_frontmatter',
      message: 'file does not start with the `/* zcode-workflow` metadata block',
    };
  }
  let close = -1;
  for (let index = first + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '*/') {
      close = index;
      break;
    }
  }
  if (close < 0) {
    return { ok: false, reason: 'unterminated_frontmatter', message: 'metadata block is never closed with `*/`' };
  }
  const yamlText = lines.slice(first + 1, close).join('\n');
  let meta;
  try {
    meta = parseYamlSubset(yamlText);
  } catch (error) {
    return { ok: false, reason: 'invalid_yaml', message: `metadata block is not valid YAML: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (meta === null || typeof meta !== 'object' || typeof meta.description !== 'string' || meta.description.trim() === '') {
    return { ok: false, reason: 'invalid_metadata', message: 'metadata block needs a non-empty `description`' };
  }
  const normalized = {
    description: meta.description,
    ...(typeof meta.whenToUse === 'string' ? { whenToUse: meta.whenToUse } : {}),
    ...(meta.args === undefined ? {} : { args: normalizeArgumentDeclarations(meta.args) }),
  };
  const script = lines.slice(close + 1).join('\n');
  return { ok: true, meta: normalized, script, bodyLineOffset: close + 1 };
}

/**
 * 反序列化 `args` 声明。
 * @param {unknown} value
 * @returns {Record<string, {type: string, description?: string, required?: boolean, default?: unknown}>}
 */
export function normalizeArgumentDeclarations(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('`args` must be a mapping of argument name to declaration');
  }
  const result = {};
  for (const [name, declaration] of Object.entries(value)) {
    if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
      throw new Error(`argument "${name}" must be a mapping with a \`type\``);
    }
    const type = declaration.type;
    if (typeof type !== 'string' || !ARG_TYPES.has(type)) {
      throw new Error(`argument "${name}" needs a type of string, number, boolean or json`);
    }
    result[name] = {
      type,
      ...(typeof declaration.description === 'string' ? { description: declaration.description } : {}),
      ...(typeof declaration.required === 'boolean' ? { required: declaration.required } : {}),
      ...(declaration.default === undefined ? {} : { default: declaration.default }),
    };
  }
  return result;
}

/**
 * 写一段元数据块 + 正文（`/* zcode-workflow\n<YAML>\n<CLOSE>\n<body>`）。
 * @param {object} meta
 * @param {string} body
 * @returns {string}
 */
export function serializeMetadataHeader(meta, body) {
  const lines = [METADATA_OPEN];
  lines.push(...serializeYamlSubset(meta, 0));
  lines.push('*/');
  return `${lines.join('\n')}\n${body.replace(/^\n+/u, '')}`;
}

/**
 * 极简 YAML 子集解析：映射、序列、标量、块标量（`|`/`>`）。
 * 为什么自己写：元数据块只允许 `description`/`whenToUse`/`args` 三个键，引一个 YAML 依赖
 * 反而扩大了可被接受的输入面。
 * @param {string} text
 * @returns {unknown}
 */
function parseYamlSubset(text) {
  const lines = text.split('\n').map((line, index) => ({ text: line.replace(/\t/gu, '  '), index, indent: line.length - line.trimStart().length, blank: line.trim() === '' || line.trim().startsWith('#') }));
  let cursor = 0;
  const skipBlank = () => {
    while (cursor < lines.length && lines[cursor].blank) cursor += 1;
  };
  const parseBlock = (parentIndent) => {
    skipBlank();
    if (cursor >= lines.length) return null;
    const line = lines[cursor];
    if (line.indent <= parentIndent && parentIndent >= 0) return null;
    if (line.text.trimStart().startsWith('- ')) return parseSequence(line.indent);
    return parseMapping(line.indent);
  };
  const parseMapping = (indent) => {
    /** @type {Record<string, unknown>} */
    const mapping = {};
    for (;;) {
      skipBlank();
      if (cursor >= lines.length) break;
      const line = lines[cursor];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new Error(`unexpected indentation on line ${line.index + 1}`);
      const content = line.text.trimStart();
      if (content.startsWith('- ')) break;
      const colon = findKeyColon(content);
      if (colon < 0) throw new Error(`expected "key: value" on line ${line.index + 1}`);
      const key = unquote(content.slice(0, colon).trim());
      const rest = content.slice(colon + 1).trim();
      cursor += 1;
      if (rest === '') {
        const nested = parseBlock(indent);
        mapping[key] = nested;
      } else if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-' || rest === '|+' || rest === '>+') {
        mapping[key] = readBlockScalar(rest, indent);
      } else {
        mapping[key] = parseScalar(rest);
      }
    }
    return mapping;
  };
  const parseSequence = (indent) => {
    /** @type {unknown[]} */
    const sequence = [];
    for (;;) {
      skipBlank();
      if (cursor >= lines.length) break;
      const line = lines[cursor];
      if (line.indent < indent) break;
      if (line.indent !== indent) break;
      const content = line.text.trimStart();
      if (!content.startsWith('- ')) break;
      const rest = content.slice(2).trim();
      cursor += 1;
      if (rest === '') sequence.push(parseBlock(indent));
      else if (findKeyColon(rest) >= 0) {
        // `- key: value` 起的映射：把该行视作映射首行
        const mapping = {};
        const colon = findKeyColon(rest);
        mapping[unquote(rest.slice(0, colon).trim())] = parseScalar(rest.slice(colon + 1).trim());
        const nested = parseMapping(indent + 2);
        if (nested !== null && typeof nested === 'object') Object.assign(mapping, nested);
        sequence.push(mapping);
      } else sequence.push(parseScalar(rest));
    }
    return sequence;
  };
  const readBlockScalar = (marker, indent) => {
    const folded = marker.startsWith('>');
    const chomping = marker.slice(1);
    const collected = [];
    let blockIndent = -1;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.text.trim() === '') {
        collected.push('');
        cursor += 1;
        continue;
      }
      if (line.indent <= indent) break;
      if (blockIndent < 0) blockIndent = line.indent;
      collected.push(line.text.slice(blockIndent));
      cursor += 1;
    }
    let value = folded ? collected.join(' ').replace(/ {2,}/gu, ' ').trim() : collected.join('\n');
    if (chomping !== '-' && value.length > 0) value += '\n';
    return chomping === '-' ? value.trimEnd() : value;
  };
  const result = parseBlock(-1);
  return result;
}

/**
 * 找 `key: value` 里的冒号（跳过引号内与行内注释）。
 * @param {string} content
 * @returns {number}
 */
function findKeyColon(content) {
  let quote = '';
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quote !== '') {
      if (char === quote) quote = '';
      else if (char === '\\') index += 1;
      continue;
    }
    if (char === '"' || char === '\'') quote = char;
    else if (char === ':' && (index === content.length - 1 || content[index + 1] === ' ')) return index;
  }
  return -1;
}

/**
 * 去引号。
 * @param {string} text
 * @returns {string}
 */
function unquote(text) {
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith('\'') && text.endsWith('\'') && text.length >= 2) return text.slice(1, -1).replace(/''/gu, '\'');
  return text;
}

/**
 * 解析标量。
 * @param {string} text
 * @returns {unknown}
 */
function parseScalar(text) {
  const stripped = text.replace(/\s+#.*$/u, '').trim();
  if (stripped === '') return '';
  if (stripped === 'true') return true;
  if (stripped === 'false') return false;
  if (stripped === 'null' || stripped === '~') return null;
  if (/^-?\d+$/u.test(stripped)) return Number.parseInt(stripped, 10);
  if (/^-?\d+\.\d+$/u.test(stripped)) return Number.parseFloat(stripped);
  if (stripped.startsWith('[') || stripped.startsWith('{')) {
    try {
      return JSON.parse(stripped.replace(/'/gu, '"'));
    } catch {
      return stripped;
    }
  }
  return unquote(stripped);
}

/**
 * 序列化 YAML 子集（元数据块只需映射/序列/标量）。
 * @param {unknown} value
 * @param {number} indent
 * @returns {string[]}
 */
function serializeYamlSubset(value, indent) {
  const pad = ' '.repeat(indent);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [pad + scalarText(value)];
  /** @type {string[]} */
  const lines = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      lines.push(`${pad}${key}:`);
      lines.push(...serializeYamlSubset(entry, indent + 2));
      continue;
    }
    if (Array.isArray(entry)) {
      lines.push(`${pad}${key}:`);
      for (const item of entry) lines.push(`${pad}  - ${scalarText(item)}`);
      continue;
    }
    if (typeof entry === 'string' && entry.includes('\n')) {
      lines.push(`${pad}${key}: |-`);
      for (const line of entry.split('\n')) lines.push(`${' '.repeat(indent + 2)}${line}`);
      continue;
    }
    lines.push(`${pad}${key}: ${scalarText(entry)}`);
  }
  return lines;
}

/**
 * 标量文本（必要时加引号）。
 * @param {unknown} value
 * @returns {string}
 */
function scalarText(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const text = String(value);
  if (text === '' || /^[\s]|[\s]$|[:#]|^-|\n/u.test(text) || ['true', 'false', 'null', '~'].includes(text) || /^-?\d+(\.\d+)?$/u.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}

/* ================================================================================================
 * 10. 编译入口
 * ============================================================================================== */

/**
 * @typedef {{code: number, line: number, column: number, message: string}} WorkflowDiagnostic
 */

/**
 * 编译一份工作流脚本（或片段）。
 *
 * @param {object} options
 * @param {string} options.code 源码
 * @param {string} [options.filename] 文件名（只用于错误消息）
 * @param {'workflow'|'snippet'} [options.mode]
 * @param {boolean} [options.snippet] 旧名兼容：等价于 mode:'snippet'
 * @returns {object}
 */
export function compileWorkflowScript({ code, filename = 'workflow-script.ts', mode, snippet = false } = {}) {
  const resolvedMode = mode ?? (snippet === true ? 'snippet' : 'workflow');
  const source = normalizeSource(String(code ?? ''));
  const tokens = tokenize(source);
  const structure = buildStructure(tokens);
  const pairs = structure.pairs;

  let analysis;
  try {
    analysis = analyze(source, tokens, pairs, resolvedMode);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{ code: CODE.HOLE, line: 1, column: 1, message: DIAGNOSTIC_MESSAGES.syntax(error instanceof Error ? error.message : String(error)) }],
      lowered: '',
      js: '',
      sites: [],
      askSpecs: new Map(),
      sitePhases: new Map(),
      phases: [],
      actors: [],
      holes: [],
      artifacts: [],
      worldReads: [],
      models: [],
      interfaces: {},
      metadata: undefined,
      scriptHash: hashSource(source),
    };
  }

  if (analysis.diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics: analysis.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      lowered: '',
      js: '',
      sites: [],
      askSpecs: new Map(),
      sitePhases: analysis.sitePhases,
      phases: analysis.phases.map((phase) => phase.name),
      actors: [],
      holes: [],
      artifacts: [],
      worldReads: [],
      models: [],
      interfaces: Object.fromEntries(analysis.types),
      metadata: metadataOf(source, resolvedMode),
      scriptHash: hashSource(source),
    };
  }

  // 站点字段补齐（lowering 需要源码偏移与实参文本）
  const sites = analysis.sites.map((site) => decorateSite(source, tokens, pairs, site));

  let loweredBody;
  let loweredSource;
  try {
    const lowered = lowerScript(source, { ...analysis, sites, tokens, declared: collectDeclaredNames(tokens) });
    loweredSource = lowered.code;
    // 类型擦除（Node 内建）。
    // 为什么先包一层函数再擦：脚本的顶层 `return` 是合法的（工作流以返回值交付），但
    // 顶层的 `return` 在 TS 里只允许出现在函数体里，所以先包成 `__workflowScript__` 再擦，
    // 擦完把函数体切出来交给 cell（cell 会再包一层 `(async (__host) => …)`）。
    const wrapped = `async function __workflowScript__() {\n${loweredSource}\n}`;
    const stripped = stripTypeScriptTypes(wrapped, { mode: 'transform', sourceMap: false });
    const bodyOpen = stripped.indexOf('{');
    const bodyClose = stripped.lastIndexOf('}');
    loweredBody = bodyOpen >= 0 && bodyClose > bodyOpen ? stripped.slice(bodyOpen + 1, bodyClose) : stripped;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: CODE.HOLE,
        line: error?.line ?? 1,
        column: error?.column ?? 1,
        message: DIAGNOSTIC_MESSAGES.syntax(error instanceof Error ? error.message : String(error)),
      }],
      lowered: '',
      js: '',
      sites: [],
      askSpecs: new Map(),
      sitePhases: analysis.sitePhases,
      phases: analysis.phases.map((phase) => phase.name),
      actors: [],
      holes: [],
      artifacts: [],
      worldReads: [],
      models: [],
      interfaces: Object.fromEntries(analysis.types),
      metadata: metadataOf(source, resolvedMode),
      scriptHash: hashSource(source),
    };
  }

  /** @type {Map<string, {typed: boolean, schema?: object, typeName?: string}>} */
  const askSpecs = new Map();
  /** @type {object[]} */
  const actors = [];
  /** @type {object[]} */
  const holes = [];
  /** @type {object[]} */
  const artifacts = [];
  /** @type {object[]} */
  const worldReads = [];
  /** @type {string[]} */
  const models = [];

  for (const site of sites) {
    if (site.kind === 'ask') {
      askSpecs.set(site.id, {
        typed: site.typed === true,
        ...(site.schema === undefined ? {} : { schema: site.schema }),
        ...(site.typeName === undefined ? {} : { typeName: site.typeName }),
      });
    } else if (site.kind === 'actor') {
      actors.push({ siteId: site.id, name: site.name, persona: site.persona, line: site.line });
    } else if (site.kind === 'hole') {
      holes.push({ siteId: site.id, name: site.name, line: site.line, typeText: site.typeText });
    } else if (site.kind === 'artifact') {
      artifacts.push({ siteId: site.id, op: site.op, id: site.artifactId, line: site.line });
    } else if (site.kind === 'worldRead') {
      worldReads.push({ siteId: site.id, op: site.op, line: site.line });
    } else if (site.kind === 'model') {
      if (site.model !== undefined) models.push(site.model);
    }
  }

  const body = loweredBody.replace(/^\n+/u, '').replace(/\n+$/u, '');
  const js = `(async (__host) => {\n${body}\n})`;

  return {
    ok: true,
    diagnostics: [],
    lowered: body,
    js,
    sites,
    askSpecs: askSpecs.size === 0 ? new Map() : askSpecs,
    sitePhases: analysis.sitePhases,
    phases: analysis.phases.map((phase) => phase.name),
    actors,
    holes,
    artifacts,
    worldReads,
    models,
    interfaces: Object.fromEntries(analysis.types),
    metadata: metadataOf(source, resolvedMode),
    scriptHash: hashSource(source),
    lineOffset: 1,
    filename,
  };
}

/**
 * 站点补全：把 lowering 需要的偏移/文本算好。
 * @param {string} code
 * @param {object[]} tokens
 * @param {Map<number, number>} pairs
 * @param {object} site
 * @returns {object}
 */
function decorateSite(code, tokens, pairs, site) {
  const enriched = { ...site };
  const callee = tokens[site.callee];
  if (callee !== undefined) {
    enriched.calleeStart = callee.start;
    enriched.calleeEnd = callee.end;
    enriched.start = callee.start;
    const open = site.open !== undefined && isPunct(tokens[site.open], '(') ? site.open : -1;
    if (open >= 0) {
      enriched.afterOpen = tokens[open].end;
      enriched.closeOffset = tokens[site.close]?.start ?? tokens[open].end;
      enriched.end = tokens[site.close]?.end ?? tokens[open].end;
    }
    enriched.end = tokens[site.close]?.end ?? enriched.afterOpen ?? callee.end;
  }
  if (Array.isArray(site.args)) {
    enriched.args = site.args.map((arg) => ({
      from: arg.from,
      to: arg.to,
      startOffset: tokens[arg.from]?.start ?? 0,
      endOffset: tokens[arg.to - 1]?.end ?? 0,
      text: arg.to > arg.from ? code.slice(tokens[arg.from].start, tokens[arg.to - 1].end) : '',
    }));
    enriched.argsText = site.open !== undefined
      ? enriched.args.map((arg) => arg.text).join(', ')
      : '';
    if (suiteSecondIsFunction(enriched, tokens)) enriched.secondIsFunction = true;
  }
  if (site.kind === 'ask') {
    const dot = tokens[site.dot];
    enriched.dotStartOffset = dot !== undefined ? dot.start : (callee !== undefined ? callee.start : 0);
    enriched.memberStartOffset = enriched.dotStartOffset;
    enriched.memberEndOffset = callee !== undefined ? callee.end : 0;
    enriched.receiverStartOffset = tokens[site.receiverStart]?.start ?? 0;
    // 接收者文本截止到 `.` 之前（不含点），可选链分支要把它整体传进去
    enriched.receiverText = site.receiverStart !== undefined && dot !== undefined
      ? code.slice(tokens[site.receiverStart].start, dot.start)
      : '';
    if (site.typeOpen !== undefined && site.typeOpen >= 0 && site.typeClose !== undefined && site.typeClose > 0) {
      enriched.typeRange = { start: tokens[site.typeOpen].start, end: tokens[site.typeClose].end };
    }
  }
  if (site.kind === 'artifact' || site.kind === 'worldRead') {
    enriched.memberStartOffset = callee !== undefined ? callee.start : 0;
  }
  if (site.kind === 'hole' && site.callee !== undefined) {
    enriched.typeRange = undefined;
    if (site.hasTypeArg === true) {
      // `hole<T>` 的 `<` 紧跟在 callee 后
      const less = tokens[site.callee + 1];
      if (isPunct(less, '<')) {
        let depth = 0;
        for (let cursor = site.callee + 1; cursor < tokens.length; cursor += 1) {
          if (isPunct(tokens[cursor], '<')) depth += 1;
          else if (isPunct(tokens[cursor], '>')) {
            depth -= 1;
            if (depth === 0) {
              enriched.typeRange = { start: less.start, end: tokens[cursor].end };
              break;
            }
          }
        }
      }
    }
  }
  return enriched;
}

/**
 * hole 的第二个实参是否是函数（body 而非 prompt）。
 * @param {object} site
 * @param {object[]} tokens
 * @returns {boolean}
 */
function suiteSecondIsFunction(site, tokens) {
  if (site.args.length !== 2) return false;
  const arg = site.args[1];
  const first = tokens.find((token) => token.start === arg.startOffset);
  if (first === undefined) return false;
  if (isKeyword(first, 'async')) return true;
  if (isKeyword(first, 'function')) return true;
  return isPunct(first, '(') && site.args[1].text.includes('=>');
}

/**
 * 去掉元数据块后的正文（片段没有元数据）。
 * @param {string} source
 * @param {'workflow'|'snippet'} mode
 * @returns {object | undefined}
 */
function metadataOf(source, mode) {
  if (mode !== 'workflow' || !source.trimStart().startsWith(METADATA_OPEN)) return undefined;
  const parsed = extractMetadataHeader(source);
  return parsed.ok ? parsed.meta : undefined;
}

/**
 * 脚本哈希：正文 + 元数据的稳定摘要（sha1 足够，只用于判断“还是不是同一份脚本”）。
 * @param {string} source
 * @returns {string}
 */
function hashSource(source) {
  // 这里刻意不用 node:crypto：编译器要保持纯函数式、可在 vm/测试里直接跑。
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index) & 255;
    hash ^= (source.charCodeAt(index) >> 8) & 255;
    hash = Math.imul(hash, 16777619);
  }
  return `s${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** 兼容旧名（tools.js/prompt.js 之前按这些名字取）。 */
export const compileWorkflow = compileWorkflowScript;
