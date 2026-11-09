# zcode-workflow

把 ZCode 桌面版内置的 **Dynamic workflow**（动态工作流）功能移植进 DeepSeek Harness 的 Cordis 插件。

模型写一段 TypeScript 工作流脚本，插件先编译检查，再在后台用它调度大量子代理并行工作：脚本里 `agent()/ask()` 派活、`phase()` 分组、`world.run()` 跑确定性检查、`report()` 边跑边交付、`artifact.*` 发布用户可打开的产物。跑完后把脚本的最终 `return` 值作为通知送回主代理。

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

其他可调项：`maxConcurrency`（同时在跑的子代理数，默认 `clamp(CPU核数-2, 4, 16)`）、`subagentProvider`（默认 `spawn`）、`subagentModel`（默认继承会话模型）、`stallMs`（无进展多久判定卡死，默认 30 分钟）。

## 模型侧工具

| 工具 | 作用 |
| --- | --- |
| `CreateWorkflow` | 编译并启动一次运行。三种来源：`script`（内联，先落盘为草稿）、`path`（脚本文件）、`saved`（按名字跑已保存工作流）。编译失败时返回 `脚本路径:L行:C列 消息` 和"什么都没跑"的结论 |
| `AmendWorkflow` | 用修订后的脚本或参数重开一个运行，取代旧运行；未改动的命名子代理按同一 ask 文本复用旧运行的记录 |
| `ResumeWorkflowRun` | 继续一个 `stopped` 运行 |
| `GetWorkflowRun` | 读取一次运行的快照：状态、阶段、子代理、报告项、产物、等待中的 hole、日志、命令、结果/错误 |
| `ListWorkflowRuns` | 列出本项目的运行（含其他会话启动的） |
| `TaskOutput` | 阻塞等待某次运行结束 |
| `StopWorkflowRun` | 停止运行（ZCode 用通用 `TaskStop`，DSH 没有对插件开放的等价物，故单列） |
| `FillWorkflowHole` | 解除运行在 `hole` 处的等待 |
| `SaveWorkflow` / `ListSavedWorkflows` | 保存/列出可复用工作流（`.dwf.ts`，带 YAML 元数据块） |
| `EvalWorkflowSnippet` | 同步试跑一小段脚本（只读工作区 + 命令），不产生运行记录 |

`/workflow [要求]` 是显式入口：加载技能、要求模型用 `CreateWorkflow`；`onDemand` 模式下它同时激活工具。`/dwf [list|cancel [runId]|resume <runId>]` 管理运行。

## 界面

浏览器半是静态 Client 模块，数据走本包注册的同源路由 `/zcode-workflow/*`（Host 端每条路由先过 `connection` 的信任与登录校验），不依赖 Host→Client RPC。

| 界面 | 位置 | 内容 |
| --- | --- | --- |
| 工作流目录 | 左侧栏面板图标 + 中央面板 | 按工作区列出项目与全局已保存工作流；运行（新对话）、删除、全局移到项目、刷新 |
| 运行详情 | 右侧栏 tab | 状态、步骤与阶段、子代理、留白、产物（文本/图片预览）、报告、日志、命令、结果/错误；停止运行 |
| 会话状态 | 会话标题栏右侧 | 运行中数量、运行列表、停止、打开目录；无运行时隐藏 |
| 工具卡片 | 对话内 `tool.call.toolview` | 11 个工具的卡片，含「查看实例详情」入口 |
| 设置 | 设置 → 通用 | 动态工作流三态：关闭 / 通过命令启用 / 始终开启 |

界面文案在 `locale/*.json` 与 `locale/ui/*.json`。构建产物 `client.js` 由 `client-src/` 拼接生成：改源码或文案后运行 `node scripts/build-client.mjs`。

## 工作流脚本

脚本的完整契约就是 ZCode 自己的 `dynamic-workflows` 技能，已随插件注册进 DSH 技能目录（`skills/SKILL.md`、`examples.md`、`patterns.md` 为 ZCode 原文拷贝）：

- facade：`agent/ask`、`phase`、`report`、`artifact.{file,markdown,chart,table,metrics,board}`、`files.{glob,read,grep}`、`git.{changedFiles,diff,status,log}`、`world.run`、`channel`、`future`、`hole`、`log`、`run`、`args`、`model`
- 规则：函数体内普通 TypeScript；禁止 `import/export/declare`、`process/fetch/fs`、`Date.now()/Math.random()`；必须有 `phase(...)`；子代理命名在单次运行内唯一；`world.run` 命令、`phase` 名、产物 id、`report` tag 必须是字面量
- 诊断码与消息沿用 ZCode（9001–9012），在插件内按文法规则静态检查；类型擦除用 Node 自带 `stripTypeScriptTypes`，因而不做完整 tsc 类型检查（见"与 ZCode 的差异"）

## 存储

| 内容 | 位置 |
| --- | --- |
| 运行记录（`meta.json`、`journal.jsonl`、`script.ts`、`artifacts/`） | `<工作区>/.dsh/workflow-runs/<runId>/` |
| 内联脚本草稿（机器生成，建议 git 忽略） | `<工作区>/.dsh/workflow-drafts/`（自动写 `.gitignore`=`*`） |
| 项目工作流 | `<工作区>/.dsh/workflows/<name>.dwf.ts` |
| 全局工作流 | `$DSH_HOME/workflows/<name>.dwf.ts` |

为兼容直接用 ZCode 保存过的工作流，读取时也会扫描 `<工作区>/.zcode/workflows` 与 `$DSH_HOME/.zcode/workflows`；项目覆盖全局、`.dsh` 覆盖 `.zcode`。下行写入始终用 `.dsh`。

建议在仓库的 `.gitignore` 中忽略 `.dsh/workflow-runs/` 与 `.dsh/workflow-drafts/`（草稿目录首次使用时会自动写入 `*`）；`.dsh/workflows/` 是项目工作流定义，按 ZCode 的约定应当入库。

## 与 ZCode 原版的差异

受 DSH 扩展点限制，以下实现方式与 ZCode 不同（行为契约尽量保持一致）：

1. **执行环境**：ZCode 每次运行单独 spawn 一个 Node 子进程，在 `node:vm` 沙箱里跑脚本；本插件在宿主进程内用 `node:vm` 上下文执行（无子进程隔离、无 `--max-old-space-size` 限制）。脚本可见的全局对象相同。
2. **类型检查**：ZCode 用 tsc 做严格类型检查并据此生成 `ask<T>` 的 JSON Schema；本插件用文法规则检查 + `stripTypeScriptTypes` 擦除类型，并从脚本里的 `interface` 声明生成 `ask<T>` 的校验 schema。类型错误（而非规则错误）不会在编译期报出。
3. **子代理**：ZCode 的每个工作流子代理有独立系统提示与 `submit_result`/`escalate` 工具；DSH 的子代理启动接口只接受一次提示，故插件把 ZCode 的 "Workflow Actor Identity" 与 "# Working inside a workflow" 提示原文拼在每条 ask 前。子代理的"逐次上下文"用插件侧保存的问答记录近似（同一命名子代理后续 ask 会带上先前问答摘要），不是同一会话。因此也不支持子代理中途 `escalate`/`ResolveWorkflowQuestion`。
4. **hole**：ZCode 的 hole 由 `FillWorkflowHole` 现场编译并拼接函数体，且能在补丁点看到此前所有绑定；本插件用 JSON 值解除 hole 的等待（`FillWorkflowHole` 的 `value`），补丁代码拿不到脚本内绑定。依赖上游变量的 hole 分支应直接写在脚本里。
5. **缓存重放**：`AmendWorkflow` 以 `resumedFrom` 建立新运行；DSH 版尚未实现按（子代理名 + ask 文本）复用旧 journal 的记录级缓存，修订后会重新跑改动前后的所有 ask。
6. **持久化位置**：ZCode 把运行 journal 写在会话 SQLite；本插件写项目目录下的 JSONL/JSON 文件。
7. **UI**：ZCode 的完整界面已按 DSH 槽位移植（工具卡片、工作流目录、运行详情、会话状态、设置三态）。行为差异：运行详情从右侧栏打开，没有挂载会话时降级为浮层；目录页的「运行」在新对话里交给模型执行（全局面板没有活动会话，不能直接起 run）；数据是 2–5 秒轮询而不是 ZCode 的会话快照订阅；设置改动写入 profile patch，可能触发插件重载；刷新浏览器后右栏 tab 的打开参数不保留。
8. **暂停/等待**：ZCode 的 hole 通知、escalation、阻塞提醒会主动注入主会话；本插件在完成时用 `followup` 投递通知——若主代理正在一轮对话中，通知会排在下一轮，而不是立刻打断。
9. **确认窗口**：ZCode 在启动运行前弹脚本确认；DSH 由工具权限/审批层决定，本插件不另设确认窗口。

## 验证

- 单元测试：`node --test test/*.test.mjs` → 107 个测试全部通过（编译器 64、存储 9、工作区 11、Host 数据通道 21、前端构建 2）。
- 集成测试：真实 compiler/store/workspace/runtime/tools 串起一次含 2 个阶段、3 个子代理、typed ask、report 与 artifact 的运行，状态 `completed`。
- 真实运行：在 `desktop` profile 安装后跑通多子代理运行（typed ask 结构化返回）、保存工作流并按 args 重跑、`EvalWorkflowSnippet`、编译诊断、hole 等待与 `FillWorkflowHole`、`AmendWorkflow` 的 script_unchanged 拒绝。
- 已安装状态：`include:zcode-workflow` 为 `active`；11 个工具出现在模型工具表；`tool.call.toolview` 上 11 个 key 的注册均 `active`；Client 槽 `main`、`sidebar.panellist`、`settings.general.item`、`conversation.session.header.utilities`、`sidebar.right.pane.tab` 均注册成功。
- 前端渲染冒烟：用构建产物和 React 服务端渲染逐个渲染 7 个槽组件，全部无异常；覆盖工具卡、目录页、侧栏图标、设置行、运行详情、详情标题、会话状态入口。
- 未验证：真实浏览器里的像素级观感与交互手感。Host 半（`index.js`、`host/ui-api.js`）改动需重启 Harness 后才注册路由；`client.js` 热更即时生效。

## 来源与许可

`skills/SKILL.md`、`examples.md`、`patterns.md` 与工具描述、子代理提示、诊断消息均拷贝自本机安装的 ZCode（`resources/glm/` 与 `resources/glm/packages/bundled-skills/skills/dynamic-workflows/`），仅作本机功能移植之用；对外分发前请自行确认 ZCode 的许可条款。

## 开发

- 构建前端：改 `client-src/**` 或 `locale/**` 后运行 `node scripts/build-client.mjs`（`client.js` 是产物，不要手改）。
- 语法检查：`node --check index.js && node --check client.js && node --check host/*.js`
- 单元测试：`node --test test/*.test.mjs`
- 改 `host/**` 或 `index.js` 后重启 Harness；改 `client.js` 热更。
