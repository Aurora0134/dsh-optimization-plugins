# 前端架构（工作流界面）

本插件的前端是一个 **静态 Client 模块**（`client.js`），不是动态 Cordis 包：它没有 `host.call`，也不使用 Typert Remote。所有 Host 数据都走本包注册的 `webServer` 路由，浏览器用同源 `fetch('/zcode-workflow/...')` 读取。

## 构建

`client.js` 是产物，由 `scripts/build-client.mjs` 拼接 `client-src/*.js` 生成：

- 按文件名排序拼接，所有 part 处在同一个 `factory(require)` 函数作用域内。
- `locale/en.json`、`zh.json` 的 `tool` / `ui` / `settings` 三节，加上 `locale/ui/*.json` 的片段，会编译成 `EN` / `ZH`、`UI_EN` / `UI_ZH`、`SETTINGS_EN` / `SETTINGS_ZH` 常量；不要在 part 里重复声明。
- 共享名字：`React`、`NS` / `UI_NS` / `SETTINGS_NS`、`TOOL_NAMES`、`WF_API`、`WF_UI`、`WF_UI_CSS`、`WF_CARDS`、`WF_PERMISSION`、`WF_SAVE`、`WF_DETAIL`、`WF_DIRECTORY`、`WF_SETTINGS`、`WF_STATUS`。
- 修改 part 或 locale 后运行 `node scripts/build-client.mjs`，再 `node --check client.js`。

part 的职责：

| 文件 | 职责 |
| --- | --- |
| `00-core.js` | 命名空间、工具名 |
| `10-api.js` | 同源 JSON 请求封装 `WF_API`（运行态、产物、保存的工作流、策略） |
| `15-styles.js` | 基础控件样式 `WF_UI_CSS` 与样式收集器 |
| `20-ui.js` | 共享控件、图标、格式化与轮询 hook `WF_UI` |
| `30-cards.js` | 工具卡片外壳、字典绑定、`WF_CARDS` 注册、展开记忆 |
| `31-cache.js` | 会话级 run 缓存：单定时器合并轮询、页面隐藏暂停 |
| `32-run-card.js` | 会话内联运行卡 |
| `33-snippet.js` | `EvalWorkflowSnippet` 片段卡 |
| `34-script.js` | 脚本代码块、编译诊断、脚本折叠、设置变更行 |
| `35-tool-cards.js` | 其余工具卡（状态、列表、保存、停止、续跑、提问）与兜底 |
| `40-detail.js` | 右侧栏运行详情容器与 `WF_DETAIL.open/openScript` |
| `41-detail-model.js` | 详情的数据获取与派生 |
| `42-detail-timeline.js` | 事件时间线 |
| `43-detail-phases.js` | 阶段折叠行与子代理 pill |
| `44-detail-artifacts.js` | 产物区（版本、预览、字节读取） |
| `45-detail-roster.js` | 子代理花名册 |
| `45-permission.js` | 启动确认：卡片内确认块 `WF_PERMISSION.Block` 与对话框 `WF_PERMISSION.open` |
| `46-workspace.js` | 脚本步骤（world 操作台账）工作区 |
| `47-detail-styles.js` | 详情相关样式 |
| `50-directory.js` | 工作流库主面板与侧栏入口 `WF_DIRECTORY` |
| `55-save.js` | 保存 / 从运行另存 `WF_SAVE` |
| `60-settings.js` | 设置页策略行 `WF_SETTINGS` |
| `70-status.js` | 会话标题栏运行入口与后台结果 `WF_STATUS` |
| `90-apply.js` | 注册字典、样式、槽位 |

每个 part 暴露的对象提供 `register(ctx, effect)`；`90-apply.js` 负责按顺序调用，用了存在性守卫，缺哪个 part 就跳过哪个面。

## 槽位

| 槽位 | 用途 |
| --- | --- |
| `tool.call.toolview`（按工具名） | 每类工作流工具卡 |
| `sidebar.right.pane.tab` + `sidebar.right.pane.tab.title` | 运行详情 / 脚本步骤 |
| `shell.overlay` | 启动确认对话框 |
| `main` + `sidebar.panellist` | 工作流库页与侧栏图标 |
| `settings.general.item` | 策略行 |
| `conversation.session.header.utilities` | 会话内运行入口 |

## Host 路由契约

路由由 `host/ui-api.js` 注册，均先过 `ctx.connection.requestRejection(req)`；失败返回其状态码。完整的请求/响应字段见 `docs/port-contract.md`；这里是路径索引：

- 运行态：`GET /runs`、`GET /run`、`GET /run/events`、`GET /run/artifacts`、`GET /run/workspace`、`GET /run/node`。
- 产物：`GET /artifact/data`（看板条目分页）、`GET /artifact/read`（字节分片）。
- 运行操作：`POST /run/approve`、`POST /run/stop`、`POST /run/resume`、`POST /run/fill`、`POST /run/answer`。
- 保存的工作流：`GET /workflows/list|get|runs|forRun`、`POST /workflows/save|delete|move|updateMeta`。
- 策略：`GET /policy`、`POST /policy`。

`/mode`、`/run/start`、`/workflows`、`/artifact` 是早期路由，仅为旧入口保留，前端不再使用。
