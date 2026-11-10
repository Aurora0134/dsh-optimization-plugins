# zcode-workflow

把 ZCode 桌面版内置的 **Dynamic workflow**（动态工作流）功能移植进 DeepSeek Harness 的 Cordis 插件。

模型写一段 TypeScript 工作流脚本，插件先编译检查、请用户确认，再在后台调度大量子代理并行工作：脚本里 `agent()/ask()` 派活、`phase()` 分组、`world.run()` 跑确定性检查、`report()` 边跑边交付、`artifact.*` 发布用户可打开的产物，跑完后把脚本的最终 `return` 值作为通知送回主代理。

移植对齐的是 ZCode Desktop 3.17.2 / CLI 0.21.1 的现行实现（`app.asar` 与 `resources/glm/zcode.cjs` 解包所得），不是旧版 `Workflow` 工具。契约、偏差与验收标准见 `docs/port-contract.md`。

## 安装

```
plugin_manager(action="install_bundle", target="<本目录绝对路径>")
```

安装会写入 profile 的 `package.json`、`pnpm-lock.yaml` 与 `node_modules` 链接；关闭插件用 `set_plugin(enabled=false)`，卸载用 `remove_bundle`。宿主半改完后重启生效；`client.js` 热更。

## 启用模式

`cordis.patch.yml` 里本插件行的 `config.mode`，取值与 ZCode 设置一致：

| 值 | 含义 |
| --- | --- |
| `disabled`（别名 `off`） | 关闭：不注册工具与命令，工作流入口消失 |
| `onDemand`（别名 `onCommand`） | 只有在本会话输入 `/workflow` 后才把工具交给模型 |
| `alwaysOn`（默认） | 工具常驻；用户仍可用 `/workflow` 明确要求跑工作流 |

设置页的开关与 `GET|POST /zcode-workflow/policy` 用的是 ZCode 的 `{ enabled, mode }` 模型：关掉即把 `mode` 落成 `disabled`并清空。

其他可调项：`maxConcurrency`（同时在跑的子代理数，默认 `max(4, min(16, CPU核数-2))`，运行中按 AIMD 自适应）、`subagentProvider`（默认 `spawn`）、`subagentModel`（默认继承会话模型）、`stallMs`（无进展多久判定卡死，默认 30 分钟）、`stallCheckMs`（多久检查一次，默认 60 秒）。

## 模型侧工具

| 工具 | 作用 |
| --- | --- |
| `CreateWorkflow` | 编译并启动一次运行。三种来源互斥：`script`（内联，先落盘为草稿）、`path`（脚本文件，可带 `args`）、`saved`（按名字跑已保存工作流）。编译失败返回 `脚本路径:L行:C列 消息` 与"什么都没跑"的结论 |
| `AmendWorkflow` | 用修订后的脚本或参数重开一个运行，取代旧运行 |
| `ResumeWorkflowRun` | 继续一个 `stopped` 运行，按 journal 重放已完成的工作 |
| `GetWorkflowRun` | 读取一次运行的快照：状态、阶段、子代理、报告项、产物、等待中的 hole、日志、命令、结果/错误 |
| `ListWorkflowRuns` | 列出本项目的运行（含其他会话启动的） |
| `TaskOutput` | 等待某次运行结束或安静下来 |
| `StopWorkflowRun` | 停止运行（真实 ZCode 用通用后台任务工具，Harness 没有对插件开放的等价物，故单列） |
| `FillWorkflowHole` | 用一段脚本在 hole 处解除等待 |
| `ResolveWorkflowQuestion` | 回答子代理升级上来的问题 |
| `SaveWorkflow` / `ListSavedWorkflows` | 保存/列出可复用工作流（`.dwf.ts`，带 YAML 元数据块与参数声明） |
| `EvalWorkflowSnippet` | 同步试跑一小段脚本（只读工作区 + 命令），不产生运行记录 |

启动确认走 `host/approval.js`：编译成功且解析出阶段图后，工具等待用户在界面里选择允许一次 / 本会话允许 / 拒绝 / 提出修改，再开始执行。

`/workflow [要求]` 是显式入口：加载技能、要求模型用 `CreateWorkflow`；`onDemand` 模式下它同时激活工具。`/dwf [list|cancel [runId]|resume <runId>]` 管理运行。

## 界面

浏览器半是静态 Client 模块，数据走本包注册的同源路由 `/zcode-workflow/*`（Host 端每条路由先过 `connection` 的信任校验），不依赖 Host→Client RPC。

| 界面 | 位置 | 内容 |
| --- | --- | --- |
| 工具卡片 | 对话内 `tool.call.toolview` | 每类工具一张卡：运行卡（阶段进度、子代理、产物、时间线、折叠脚本）、片段卡、状态卡、保存/列表卡、提问卡等 |
| 启动确认 | 卡片内确认块 + 浮层对话框 | 阶段图、模型与并发可调项、留白说明、脚本全文、四个决策 |
| 运行详情 | 右侧栏 tab | 配置与停止、状态行（子代理模型·工作中·步数·tokens·轮次·产物）、阶段折叠行与子代理、时间线、产物区、结果与错误、健康与残留、待答问题与留白 |
| 脚本步骤 | 右侧栏 tab | 该运行对工作区做过的 `world.read`/`world.run` 操作台账，按阶段分章，可展开单条结果 |
| 工作流库 | 左侧栏面板图标 + 中央面板 | 项目与全局工作流的列表、详情双 tab、参数表、元信息编辑、启动/移动/删除，以及从运行另存 |
| 会话状态 | 会话标题栏右侧 | 运行中数量与进度、运行列表、停止、后台结果与留白通知、运行目录视图 |
| 设置 | 设置 → 通用 | 动态工作流三态行 |

界面文案在 `locale/*.json` 与 `locale/ui/*.json`；中文逐字取自真实产品，英文同义对应。构建产物 `client.js` 由 `client-src/` 拼接生成：改源码或文案后运行 `node scripts/build-client.mjs`。

## 工作流脚本

脚本的完整契约是随插件注册的 `dynamic-workflows` 技能（`skills/SKILL.md`、`examples.md`、`patterns.md`）：

- facade：`agent(name?, persona?) → Agent{ask<T>(instructions)}`、`phase`、`log`、`report(item, artifactId?)`、`artifact.{file,markdown,chart,table,metrics,board}`、`files.{glob,read,grep}`、`git.{changedFiles,diff,status,log}`、`world.run`、`channel`、`future`、`hole`、`model`、`run`、`args`
- 规则：函数体内普通 TypeScript；禁止 `import/export/declare`、`process/fetch`、`Date.now()/Math.random()`；`phase(...)` 必须是独立语句且名字是字面量；同名子代理在单次运行内唯一；`world.run` 命令、`phase` 名、产物 id、`report` tag 必须是字面量；`report` 的条目必须 JSON 可序列化
- 运行结果就是脚本的 `return` 值；`report()` 是即发即忘的进度发射器，没有 `WorkflowReport` 类型
- 诊断码与消息沿用 ZCode（9001、9003–9010、9012，未知名字报 TS 的 2304，模块语法用 1184；9002 与 9011 在真实实现里也没有独立产生点，见 `docs/port-contract.md`），在插件内按文法规则静态检查；类型擦除用 Node 自带 `stripTypeScriptTypes`，因而只对 `ask<T>` 用到的 `interface` 做结构校验，不做完整 tsc 类型检查

## 存储

| 内容 | 位置 |
| --- | --- |
| 运行记录（`meta.json`、`journal.jsonl`、`script.ts`、`artifacts/`） | `<工作区>/.dsh/workflow-runs/<runId>/` |
| 内联脚本草稿（机器生成，建议 git 忽略） | `<工作区>/.dsh/workflow-drafts/`（自动写 `.gitignore`=`*`） |
| 项目工作流 | `<工作区>/.dsh/workflows/<name>.dwf.ts` |
| 全局工作流 | `$DSH_HOME/workflows/<name>.dwf.ts` |

为兼容直接用 ZCode 保存过的工作流，读取时也会扫描 `<工作区>/.zcode/workflows` 与 `$DSH_HOME/.zcode/workflows`；项目覆盖全局、`.dsh` 覆盖 `.zcode`。下行写入始终用 `.dsh`。

建议在仓库的 `.gitignore` 中忽略 `.dsh/workflow-runs/` 与 `.dsh/workflow-drafts/`（草稿目录首次使用时会自动写入 `*`）；`.dsh/workflows/` 是项目工作流定义，应当入库。

## 与 ZCode 原版的差异

完整清单见 `docs/port-contract.md` 的"已知偏差"表。要点：

1. **执行环境**：脚本在本进程的 `node:vm` cell 里跑（同一套 JSON 协议与停滞检测），不是独立子进程，因此没有进程级崩溃与内存隔离。
2. **编译检查**：用文法规则检查 + `stripTypeScriptTypes`，并从脚本里的 `interface` 生成 `ask<T>` 的校验 schema；类型错误（而非规则错误）不会在编译期报出。
3. **子代理**：DSH 的子代理没有会话中途动态注册工具的通道，因此 `submit_result`/`escalate` 用"逐字提示 + 回合制"等价实现：typed ask 要求返回可解析 JSON，违规走 repair、空回合走 nudge，升级提问由 `escalate` 文本触发并通过 `ResolveWorkflowQuestion` 回灌。
4. **运行记录**：真实实现写在会话 SQLite；本插件用项目目录下的 JSONL/JSON 等价映射，字段与保留策略（每会话 8 条运行、产物 32 个 id / 16 个版本）一致。
5. **amend**：以新运行取代旧运行，不做 transcript 种子与记录级缓存导入；`ResumeWorkflowRun` 才按 journal 重放已完成的工作。
6. **模型清单**：Harness 未向插件暴露模型目录，启动确认里的模型一行只读，并发可调。
7. **子代理会话正文**：没有按 actor 会话读消息的通道，子代理面以该 actor 的步骤台账呈现。

## 验证

- 单元测试：`node --test test/*.test.mjs` → **231 个测试全部通过**，按文件：编译器 21、运行时 24、facade 6、数据面（journal 8 / projection 19 / phase-state 12 / store 17 / ui-api 39）、工具 54、消息 4、审批 12、工作区 11、插件加载 2、前端构建 2。
- 加载探针（`test/plugin-apply.test.mjs`）：用最小 ctx 驱动 `apply`，断言 12 个工具、2 个命令、1 个提示段、3 个技能与 27 条路由全部注册且不抛错（含 22 条数据面路由、运行设置 `POST /run/configure` 与 4 条兼容旧前端的遗留路由）；并覆盖 `onDemand` 下不注册模型面工具、只留数据通道。
- 前端构建：`node scripts/build-client.mjs` → 25 个 part、`node --check client.js` 通过、`client.js` 与源码一致。
- 前端渲染冒烟：用构建产物和 stub React 逐个渲染七个槽组件（工具卡、确认块、详情、脚本步骤、目录页、设置行、状态入口）无异常。
- 未验证：真实浏览器里的像素级观感与交互手感；宿主半改动需重启 Harness 后才注册新路由。

## 来源与许可

工具描述、子代理提示词、诊断消息与文案取自本机安装的 ZCode（`resources/glm/zcode.cjs` 与 `app.asar`），技能文档按现行 facade 重写。仅作功能移植之用；对外分发前请自行确认 ZCode 的许可条款。

## 开发

- 构建前端：改 `client-src/**` 或 `locale/**` 后运行 `node scripts/build-client.mjs`（`client.js` 是产物，不要手改）。
- 语法检查：`node --check index.js && node --check client.js && for f in host/*.js; do node --check "$f"; done`
- 单元测试：`node --test test/*.test.mjs`
- 改 `host/**` 或 `index.js` 后重启 Harness；改 `client.js` 热更。
