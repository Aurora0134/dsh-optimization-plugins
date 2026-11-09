# 前端架构（工作流 UI）

本插件的前端是一个 **静态 Client 模块**（`client.js`），不是动态 Cordis 包：它没有 `host.call`，也不使用 Typert Remote。所有 Host 数据都走本包注册的 `webServer` 路由，浏览器用同源 `fetch('/zcode-workflow/...')` 读取。

## 构建

`client.js` 是产物，由 `scripts/build-client.mjs` 拼接 `client-src/*.js` 生成：

- 按文件名排序拼接，所有 part 处在同一个 `factory(require)` 函数作用域内。
- `locale/en.json`、`zh.json` 的 `tool` / `ui` / `settings` 三节会编译成 `EN` / `ZH`、`UI_EN` / `UI_ZH`、`SETTINGS_EN` / `SETTINGS_ZH` 常量；不要在 part 里重复声明。
- 共享名字：`React`、`NS` / `UI_NS` / `SETTINGS_NS`、`TOOL_NAMES`、`WF_API`、`WF_UI`、`WF_UI_CSS`、`WF_DETAIL`、`WF_DIRECTORY`、`WF_SETTINGS`、`WF_STATUS`。
- 修改 part 或 locale 后运行 `node scripts/build-client.mjs`，再 `node --check client.js`。

part 的职责：

| 文件 | 职责 |
| --- | --- |
| `00-core.js` | 命名空间、工具名 |
| `10-api.js` | 同源 JSON 请求封装 `WF_API` |
| `15-styles.js` | 新界面的样式串 `WF_UI_CSS` |
| `20-ui.js` | 共享控件、图标、格式化与轮询 hook `WF_UI` |
| `30-cards.js` | 工具卡片（原有实现，勿重写） |
| `40-detail.js` | 右侧栏运行详情 tab `WF_DETAIL` |
| `50-directory.js` | 主面板工作流目录 + 侧栏图标 `WF_DIRECTORY` |
| `60-settings.js` | 设置页三态行 `WF_SETTINGS` |
| `70-status.js` | 会话内运行状态入口 `WF_STATUS` |
| `90-apply.js` | 注册字典、样式、槽位 |

每个 part 暴露的对象提供 `register(ctx, effect)`；`90-apply.js` 负责调用。不要修改 `apply` 的注册顺序约定，也不要让一个 part 声明另一个 part 的常量。

## Host 路由契约

路由由 `host/ui-api.js` 注册，均先过 `ctx.connection.requestRejection(req)`；失败返回其状态码。

| 方法 | 路径 | 入参 | 返回 |
| --- | --- | --- | --- |
| GET | `/zcode-workflow/runs` | `sessionId`, `limit?` | `{ runs: RunSummary[], truncated: boolean }` |
| GET | `/zcode-workflow/run` | `sessionId` 或 `projectRoot`, `runId` | `{ run: RunSnapshot }` |
| POST | `/zcode-workflow/run/stop` | `{ sessionId?, projectRoot?, runId }` | `{ ok, run? }` |
| POST | `/zcode-workflow/run/fill` | `{ sessionId?, projectRoot?, runId, holeId, value }` | `{ ok, run? }` |
| POST | `/zcode-workflow/run/start` | `{ sessionId, name, scope, args? }` | `{ ok, runId, run }` |
| GET | `/zcode-workflow/workflows` | `projectRoot?` | `{ entries: SavedWorkflow[], invalid: [] }` |
| POST | `/zcode-workflow/workflows/delete` | `{ projectRoot?, name, scope }` | `{ ok }` |
| POST | `/zcode-workflow/workflows/move` | `{ projectRoot, name }` | `{ ok, path }` |
| GET | `/zcode-workflow/artifact` | `sessionId`/`projectRoot`, `runId`, `artifactId`, `version` | 文本 `{ kind, contentType, text }`；二进制直接响应字节 |
| GET | `/zcode-workflow/mode` | — | `{ mode, writable, effective }` |
| POST | `/zcode-workflow/mode` | `{ mode }` | `{ mode, effective }` |

`RunSummary`：`id, name, status, createdAt, finishedAt, stopReason, possibleInterruption, spentTokens, labelSource`。
`RunSnapshot`：`runtime.getRun(runId)` 的完整返回（`phases, phasesDetail, steps, agents, reports, artifacts, holes, log, world, result, error` 等）。
`SavedWorkflow`：`name, scope, description, whenToUse, args, path`（`listSavedWorkflows` 行的 UI 投影）。

`sessionId` 由 Host 用 `ctx.sessions.get(id)` + `ctx.workingDirectory.get(session)` 解析到项目根；无 session 的全局页传 `projectRoot`，Host 只接受 `workspaceRegistry.list()` 中登记的路径。两者都失败时返回 400/404，不猜路径。

## Client 注册点

| 界面 | 槽 / 服务 |
| --- | --- |
| 工作流目录页 | `main`（key `zcode-workflow`）+ `sidebar.panellist`（同 id） |
| 运行详情 | `ctx.sidebarRightTabs.register({ id, kind, ... })` + `sidebar.right.pane.tab` + `.title`；`ctx.sidebarRight.openTab(kind, { params })` |
| 会话运行入口 | `conversation.session.header.utilities` |
| 设置行 | `settings.general.item`（id `dynamic-workflow`） |
| 工具卡片 | `tool.call.toolview`（键 = 工具名） |

右栏 tab 的 `params` 通过 `useTabInfo().tab.navigation.params` 读取；打开方式 `ctx.sidebarRight.openTab('zcode-workflow/run', { params: { runId, sessionId } })`。没有 `sidebarRight` 服务时，详情降级为 `shell.overlay` 浮层（`WF_DETAIL.register` 内判断）。

## 视觉与文案

- 只用 `--dsw-alias-*`、`--dsh-*` 主题 token；不硬编码颜色。
- 所有可见文字进 `locale/*.json` 的对应节，zh 为主、en 齐全；不暴露实现细节（路由名、字段名、内部状态码）。
- 图标：16px 线稿，`currentColor`；面板图标 20px。
