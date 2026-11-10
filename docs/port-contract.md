# 移植契约（ZCode Desktop 3.17.2 → DSH 插件）

本插件把 ZCode Desktop 的动态工作流移植到 DeepSeek Harness。**唯一权威依据是 ZCode Desktop 3.17.2 的安装产物**（`app.asar` 的 `out/host`、`out/renderer`、`out/main`、`out/preload` 与 `resources/glm/zcode.cjs`），不是任何旧版快照或历史文档。凡与本文冲突处，以真实产物为准并回头修本文。

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

**唯一的移植扩展**是 `StopWorkflowRun`：真实 ZCode 没有这个工具（停跑走通用后台任务工具），而 Harness 没有对应通道，所以本移植保留它作为停止入口。新增工具必须记入本表。

启动确认：真实实现是工具调用内的权限对话框（阶段图 + 可调模型/并发 + 四选项）。Harness 没有插件级的逐工具确认通道，因此本移植用 `host/approval.js` 把同一次询问拆成「工具等待 + 浏览器作答」，选项 id 与语义不变：`allow_once`、`allow_session`、`deny`、`workflowRefine`（后者按真实实现记为**带理由的拒绝**）。

## 浏览器面

九个表面：会话内联运行卡、右侧运行详情、启动确认、片段卡、代码/调整展示、问题与留白、子代理展示、工作流库、会话状态入口 + 设置行，另有脚本步骤（world 台账）工作区。

- 数据只经 `client-src/10-api.js` 的同源路由；浏览器半边没有 Host RPC。
- 文案逐字取自真实产品的中文字典，英文按同义书写；键与真实消息 ID 同名同层级，便于比对。
- 交互锚点沿用真实产品的 `data-testid`，名称不改写，便于逐项核对。

## 验收

1. 规格里每个表面、每个状态、每条文案、每个 testid 都能在代码里指到。
2. `node --test test/*.mjs` 全绿；`node scripts/build-client.mjs` 后 `client.js` 与源码一致。
3. 插件在真实 Harness 里加载：探针工具可见、运行一次真实脚本、五个界面入口都能打开。
4. 独立评审按规格逐项核对，问题清零后才算完成。
