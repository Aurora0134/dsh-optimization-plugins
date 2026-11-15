# 移植契约（ZCode Desktop 3.17.2 → DSH 插件）

本插件把 ZCode Desktop 的动态工作流移植到 DeepSeek Harness。**唯一权威依据是 ZCode Desktop 3.17.2 的安装产物**（`app.asar` 的 `out/host`、`out/renderer`、`out/main`、`out/preload` 与 `resources/glm/zcode.cjs`），不是任何旧版快照或历史文档。凡与本文冲突处，以真实产物为准并回头修本文。

代码注释里的 `cli.md`、`engine.md`、`ui.md` 是解包 3.17.2 后整理的取证笔记。两种坐标写法：`cli.md:<n>` 是笔记文件自身的行号（如 `cli.md:171`），`cli:<n>` 是产物 bundle 的行号（如 `cli:427451`，与笔记正文的写法一致）。

## 分层

| 层 | 位置 | 对应真实实现 |
| --- | --- | --- |
| 模型面工具 | `host/tools.js`、`host/prompt.js`、`skills/` | CLI 的工具定义与技能契约 |
| 脚本运行时 | `host/facade.js`、`host/compiler.js` | CLI 的脚本 cell 运行时 + TypeScript lowering |
| 执行引擎 | `host/runtime.js`、`host/journal.js`、`host/projection.js` | CLI 的 `WorkflowEngine` + journal 存储 |
| 数据面 | `host/ui-api.js` | Desktop host 的 workflow RPC |
| 浏览器面 | `client-src/*` → `client.js` | renderer 的工作流组件 |

## 数据面

运行态 7 个读方法（全部 unary，无服务端流式）：

| 插件路由 | 真实 RPC | 语义 |
| --- | --- | --- |
| `GET /runs` | `conversationWorkflowRuns` | 会话内运行摘要列表，`maxRuns = 8` |
| `GET /run/events` | `conversationWorkflowRunEvents` | 按 `afterSequence` 增量读事件，行数+字节双预算 |
| `GET /run/artifacts` | `conversationWorkflowRunArtifacts` | 产物台账 |
| `GET /artifact/data` | `conversationWorkflowRunArtifactData` | 产物的看板条目，按 `sequence` 分页 |
| `GET /artifact/read` | `conversationWorkflowRunArtifactRead` | 产物字节的分片读取（base64 + `nextOffset`） |
| `GET /run/workspace` | `conversationWorkflowRunWorkspace` | `world.read`/`world.run` 操作台账 |
| `GET /run/node` | `conversationWorkflowRunNodeResult` | 单个节点的结果（按 `maxBytes` 截断） |

保存的工作流 8 个方法：`/workflows/list|get|save|delete|move|updateMeta|runs|forRun`，作用域 `project|global`，元信息三字段 `description`/`whenToUse`/`args`，`args` 每项 `{type: string|number|boolean|json, description?, required?, default?}`。

策略 1 个：`GET|POST /policy`，字段 `{enabled, mode}`，`mode` 取 `disabled|onDemand|alwaysOn`；`enabled` 为假时清空 `mode`。该策略**只**控制开与关、以及工具是常驻还是按需注入，不控制并发、轮次、模型或 world 访问。

## 事件模型

26 种事件以追加日志为准：`run-started`、`run-launched`、`actor-created`、`node-queued|dispatched|executing|waiting|repairing|nudged|settled`、`node-progress`、`report`、`artifact-published|failed`、`usage-updated`、`escalation-raised|resolved`、`concurrency-changed`、`run-caps-changed`、`phase-entered`、`hole-reached|filled`、`run-settled`、`run-stalled`、`log`、`import-cache-closed`。

- `sequence` 在 run 内从 0 连续自增；`lastEventSequence` 是消费方的高水位，用来做乱序幂等。
- 运行快照是事件折叠的产物，不是第二份真源；快照与事件字段语义不同，不可混用。
- `run-stalled`、`log`、`import-cache-closed` 只落日志，不进快照投影。
- 分页先按行数、再按字节收敛；第一条永远不裁，避免消费方卡死。

## 运行态与派生

运行态字段见 `host/projection.js`：`actors`（`waiting|running|completed`）、`nodes`（`queued|dispatched|executing|waiting|repairing|nudged|settled` × `ok|failed|cancelled`）、`reports`、`pendingQuestions`、`concurrency`、`artifacts`、`phases`、`currentPhase`、`holes`、`unlistedByPhase`、`spentTokens`、`nodesUsed`、`lastEventSequence`。

阶段状态由 `host/phase-state.js` 推导，规则与真实实现逐分支一致：运行中只有当前阶段或仍有在飞节点的阶段是 `running`，已完成的是 `done`，未开始的是 `pending`；`completed` 只标记已声明阶段；`errored` 只把当前阶段标 `failed`；`stopped` 回落 `pending`。`alongside`（并行阶段）与 `hole`（留白）是阶段行上的附加标记。

## 工具面

`CreateWorkflow`、`AmendWorkflow`、`ResumeWorkflowRun`、`GetWorkflowRun`、`ListWorkflowRuns`、`FillWorkflowHole`、`EvalWorkflowSnippet`、`SaveWorkflow`、`ListSavedWorkflows`、`ResolveWorkflowQuestion`、`TaskOutput` 与真实实现同名同参同文案。

工具返回的编译诊断统一用 `{file}:L{line}:C{column} {message}`。文件名与行号只在**诊断指向一个已存在的文件**时同源：`path`/`script_path` 源剥掉 metadata 头后按该文件的行报、文件名也是它；`CreateWorkflow`/`AmendWorkflow` 的内联与 saved 源先把正文写成草稿再编译，行号是草稿行号、文件名是草稿。

没有这样的文件时，名字只是**占位名**，行号属于调用方提供的那段输入：无源文件的 `workflow.ts`、片段固定 `snippet.ts`（path 源也一样，行号来自被读的文件）、留白补全的 `fill.ts`、`SaveWorkflow` 内联源的 `<name>.dwf.ts`（行号是正文行号，而存盘文件是 metadata 头 + 正文，映射不过去）。

**唯一的移植扩展**是 `StopWorkflowRun`：真实 ZCode 没有这个工具（停跑走通用后台任务工具），而 Harness 没有对应通道，所以本移植保留它作为停止入口。新增工具必须记入本表。

启动确认：真实实现是工具调用内的权限对话框（阶段图 + 可调模型/并发 + 四选项）。Harness 没有插件级的逐工具确认通道，因此本移植用 `host/approval.js` 把同一次询问拆成「工具等待 + 浏览器作答」，选项 id 与语义不变：`allow_once`、`allow_session`、`deny`、`workflowRefine`（后者按真实实现记为**带理由的拒绝**）。启动 payload 额外带 `models`（`{id,label,efforts?}`，id 为 `provider/model`）：目录**只**取本会话被授权派子代理的路由，来源是 host-only 投影 `subagentModelSelectionPolicy`（key 与 `stateVersion` 与 DSH 的 `dsh-tool-subagent` 同名同构，投影注册表按引用计数共享同一单元）；没有该记录时目录只剩父会话那一条路由。`llm.listProviders()` 仅用于取显示名，全量 provider 目录不得下发——那里面既有本会话用不了、选中即被拒绝的路由，又缺会话真正在用的模型。`subagent_model` 只写显式选择，未选时不写该字段（前端据此显示「沿用会话模型」）。另有 `scriptNamesModels`（布尔）：脚本自己用 `model("…")` 点了名时为真，确认框的模型行据此说「默认」。真实实现送的是 `model_bindings`（字面名 → canonical 模型 id），本移植没有把字面名解析成 canonical id 的通道，所以只下发这个布尔；确认框对它的用法与真实实现一致（见下方「脚本命名模型」一行）。（早期版本另发过 `subagent_model_default`（用户没显式选模型）；它既不是真实实现里的字段，模型行改用 `scriptNamesModels` 后也没有消费者，已删除。）

拆开之后两边靠两条约定对齐，改动任一侧都要同时照顾另一侧：

- **浏览器怎么知道有提问**：等待中的启动以 `status: "pending"` 的 run 行出现在 `/runs` 首位（会话作用域），`/run` 也能按同一个 `runId` 读到它——它还没有 journal，只能由 broker 提供。卡片按 `toolCallId` 认领自己的那次启动，会话状态栏把它算作在飞，确认对话框则从该行的 `input` 读脚本、阶段图与可调设置。没有这条投递路径，工具就只能一直等到超时。
- **提问什么时候结束**：工具调用的 `signal` 一 abort（用户中断该轮、`run_code` 到期），等待立即以拒绝结算并从待答列表中消失，浏览器侧随之关闭对话框。残留的待答项意味着有一个调用会在无人可答的情况下把答案槽占满整个超时窗口。

## 浏览器面

九个表面：会话内联运行卡、右侧运行详情、启动确认、片段卡、代码/调整展示、问题与留白、子代理展示、工作流库、会话状态入口 + 设置行，另有脚本步骤（world 台账）工作区。

- 数据只经 `client-src/10-api.js` 的同源路由；浏览器半边没有 Host RPC。
- 文案逐字取自真实产品的中文字典，英文按同义书写；键与真实消息 ID 同名同层级，便于比对。
- 交互锚点沿用真实产品的 `data-testid`，名称不改写，便于逐项核对。

## 已知偏差（逐条记录，便于后来者判断"这是 bug 还是环境差异"）

| 项 | 真实实现 | 本移植 | 原因 |
| --- | --- | --- | --- |
| 脚本执行 | 独立 node 子进程 + `node:vm` | 本进程 `node:vm` cell，同一套 JSON 行协议与停滞检测 | 插件运行在 Host 进程内，没有可控的子进程入口；代价是无进程级崩溃与内存隔离 |
| 待确认的启动 | 权限对话框在工具调用内 | broker 的等待项以 `pending` run 行合成进 `/runs` 与 `/run` | 浏览器只能从数据面读到这条启动；它还没有 journal 可投影 |
| typed ask 交付 | 子代理会话内注入 `submit_result` 工具 | schema 尾巴 + 要求可解析 JSON；repair 以违规文本、nudge 以逐字提示词再开一回合 | DSH subagent 不能在会话中途动态注册工具 |
| actor 上下文 | 同一会话跨 ask 累积 | 提示词尾部合成历史 | 同上 |
| amend 闭环 | 可带 transcript 种子、可自动续跑 | 新 run，不做缓存导入；resume 才按 journal 重放 | 未在真实实现的证据范围内 |
| 运行态存储 | 会话 SQLite（`dwf_run/actor/node/event`） | JSON 文件等价映射，字段与保留策略一致 | 插件没有会话库写入通道 |
| 保存的工作流目录 | `.zcode/workflows`（全局 `~/.zcode/workflows`） | `.dsh/workflows`（全局 `$DSH_HOME/workflows`），读取兼容旧目录 | 跟随 Harness 的目录约定 |
| `TaskOutput`/`TaskStop` | 通用后台任务工具 | 按 run 语义（`run_id`）使用；停止入口为本移植扩展 `StopWorkflowRun` | Harness 没有等价的后台任务工具 |
| 模型可调行 | 从渲染进程的模型选择视图挑选子代理模型 | 目录取本会话授权的子代理路由（投影 `subagentModelSelectionPolicy`；无记录时只剩父会话路由），随启动 payload 下发；弹窗仍是模型下拉 + 默认值回写 | ZCode 的目录来自渲染进程本地服务；本移植没有该通道，只能由宿主随 payload 提供，且必须与 DSH 的子代理路由守卫同源 |
| 脚本命名模型 | 脚本点名后模型行只读，行内文案从「子代理运行在 {model}」改成「子代理默认运行在 {model}」，并可单独列出脚本命名的模型 | 行内文案同判据（脚本 `model()` 非空则说「默认」，判据来自启动 payload 的 `scriptNamesModels`），但模型行仍可调，也不单独列出脚本命名的模型；脚本 `model()` 优先，全局选择只作用于未指定模型的 actor | 只读门禁与「列出脚本命名的模型」尚未移植；文案判据已对齐，因为它只依赖编译期就能拿到的名字集合 |
| 运行目录视图 | 独立右栏 | 放进状态入口弹层的第二视图 | 没有对应的 `sidePane` 槽位 |
| 启动已保存工作流 | 直接按名启动 | 开一条新会话并把名称与参数写进提示词 | 没有跨会话的启动路由 |
| 子代理会话正文 | 打开 actor 的只读会话 | 只展示该 actor 的步骤台账与「尚未启动」两态 | Harness 没有给插件按 actor 会话读消息的通道；为只读视图新增数据面契约不划算 |
| 数据推送 | 会话快照订阅 + `workflowRunDeltas` 三层协商的增量 | 只有按需拉取：会话级 run 列表与单 run 增量轮询（隐藏页面暂停） | 插件没有会话主题订阅通道；`Lm` 快照容器因此不上线，`lastEventSequence` 水位由快照自带 |
| `workflows/runs` 的 `limit` | 必填 1..50 | 省略时按 20 | 前端始终显式传值，缺省值只是容错 |
| `/run/fill`、`/run/answer` 错误码 | §1 未定义 | `fault.workflowRunFill.*`、`fault.workflowRunAnswer.notPending` | 语义自洽的补充命名 |
| run 列表的会话过滤 | 按所属会话取行 | 行里没有会话字段时退回整项目列表 | 早期 run 行没记会话，退回比整行消失更可解释 |
| 运行中改并发 | 运行设置弹层可调并发上限 | `POST /run/configure` → 引擎 `setMaxConcurrency`，记 `run-caps-changed` 并对齐 AIMD 上界 | 语义等价，走插件自己的数据面路由 |
| 工具并发安全 | 只读类工具声明 `concurrentSafe`，可并发调用 | 12 个工具一律 `isConcurrencySafe: () => false`（串行） | 保守取值；并发安全声明需要逐工具确认副作用面，未在本轮纳入 |
| 技能加载门禁 | 未在本会话加载过技能前拒绝提交脚本 | 不设门禁：技能随插件注册即可读，提交直接编译 | Harness 没有"本会话已加载技能"的可读状态 |
| 脚本类型检查 | TypeScript 严格类型检查，类型错误以诊断返回 | 只做语法 + 规则检查（9001、9003–9010、9012，加 TS 的 1184/2304 两条语法与未知名字文案），不做类型推导 | 无 TS 编译器通道；工具描述与技能已改成"语法与规则检查"口径 |
| 模型可用性校验 | 9011 两条：目录在校验之后才出现该模型、fill 点了一个 run 不可用的模型 | 不产生 9011：`model("…")` 只校验"非空字面量"（9010） | 两条都要"这个 run 能用的模型集"，但本移植没有 per-fill 的模型选择（目录只用于启动确认的全局子代理模型） |
| actor 工具面 | 子代理看不到 `AskUserQuestion`/`EnterPlanMode`/`ExitPlanMode`/`CreateWorkflow`/`AmendWorkflow`/`ReadSessionContext`/`ResolveWorkflowQuestion` | 子代理工具集由 Harness 固定，插件无法下发 deny 列表；靠技能与提示词约束 | `subagents.startActivation` 没有工具策略参数 |
| 总条目预算 | 单 run 条目总量 6144 | 只实现 `reports ≤ 64`、`pendingQuestions ≤ 32` | 6144 总预算需要跨表计数，本轮未做 |
| 启动确认的呈现面 | 工具调用内的权限对话框 | 同一份确认有卡片内确认块与遮罩对话框两个面，按 run 互斥：卡片仍挂载在会话里时不自动弹遮罩，卡片不在（折叠、被移除、另一会话）时才弹；标题栏状态入口点 pending run 永远可开遮罩 | 浏览器端无法判断卡片是否在意视口内，而会话转录不虚拟化，「挂载」等价于「仍在会话里」 |
| 会话身份来源 | 组件从会话绑定读取 | 座位 standard props 携带 `sessionId`；工具卡的 owner 载荷另带 `callId`，卡片据此认领 run | DSH 渲染器按 kit → registration.inject → slot 注入 → ownerProps 合并，inject 传的是会话绑定键，与会话身份同值，故不再声明 inject |
| 思考强度选择器 | 模型行旁一条独立的 effort 选择器，取值进模型串 | 不提供：`efforts` 已随目录下发但界面未渲染，子代理模型串是 `provider/model`，没有层级位 | 需要先在模型串里定层级位并让 `host/subagent.js` 解析成 `reasoningEffort`；本轮未纳入 |
| 运行卡的 run 认领 | 会话 run 列表建 `toolCallId → run` 映射，卡片据此认领（不解析结果文案） | 同语义；run 行与 `/runs` 摘要都带 `toolCallId`，历史行缺失时由已投影的 run 快照回填 | 透传来源：`host/tools.js` 把 `exec.callId` 交给 `runtime.start()`/`amend()`，`host/runtime.js` 同时写进 run 行（`tool_call_id`）与 `run-launched` 事件载荷；投影只从该事件取值，`/runs` 摘要先读存储行、仅在历史行没有该列时用快照回填（不回填磁盘） |
| amend 引入新 provider 的撤回 | `predecessor.introduces_providers`：本次 amend 的模型选择（显式 `subagent_model` 与脚本 `model()` 的 canonical id）里，provider 不属于已授权集时撤回静默放行、弹常规确认框。已授权集 = 模型目录里 `current` 那个模型的 provider ∪ 前序 run 的 `subagentModel` ∪ 前序 run 的 `modelBindings`；providerId 取模型 id 里 `/` 之前那段，没有 `/` 的裸模型 id 不计（ZCode 的 `DHa`/`d9o`） | 同语义，但基准差一份数据：本移植的「当前模型 provider」取的是**子代理默认路由**的 provider（插件配置 `subagentModel`，否则调用会话 `requestHeader` 的 provider/model），查已授权集；前序 run 的 `modelBindings` 只有在 run 记录里真有这个字段时才计入（本移植目前不写它） | 没有读取"模型目录 current 模型"的通道：`llm.listModels` 只给模型清单，不给 `current` 标记。差异方向如实记两条：①基准 provider 解析不出来（没配置、`requestHeader` 缺 provider、裸模型 id）或前序 run 没有 `modelBindings` 时，已授权集偏小 → 更容易判成"引入新 provider" → **偏保守**（多问一次，不会漏问）；②插件配置的 `subagentModel` 落在与调用会话当前模型不同的 provider 上时，已授权集整个换成配置那一家：动到配置 provider 时比真实实现大 → **偏松**（这一次不问），同一局面下调用会话自己的 provider 反而不在已授权集，动到它时比真实实现小 → **偏保守**（多问一次）。两个方向都只影响"问不问"，不影响 run 实际跑在哪 |

## 验收

1. 规格里每个表面、每个状态、每条文案、每个 testid 都能在代码里指到。
2. `node --test test/*.test.mjs` 全绿；`node scripts/build-client.mjs` 后 `client.js` 与源码一致。
3. 插件在真实 Harness 里加载：探针工具可见、运行一次真实脚本、五个界面入口都能打开。
4. 独立评审按规格逐项核对，问题清零后才算完成。
