# dsh-session-rollback

把会话回退到任意一条用户消息：从这条消息之前分叉出一个新会话并切换过去，这条消息及它所属的整轮 agent 输出都不在新会话里；这几轮被文件工具改过、创建、删除的文件恢复到当时的内容。原会话进归档，原始会话记录不会被删除。

本包由**宿主半**（`index.js` 与 `host/`，负责快照、分叉边界与文件恢复）和**浏览器半**（`client.js`，负责按钮、二次确认、原生分叉、切换会话与写回输入框）组成，`package.json` 同时声明 `dsh.bundle` 与 `dsh.client`。

## 做什么

- 每条用户消息的动作行里多一个"回退到此消息"按钮（客户端半）。
- 点击后二次确认，确认文案写明三件事：会移除该消息及之后的全部对话；会把这轮及之后改过的文件恢复到当时的内容；原始会话记录保留。
- 确认后由宿主半与浏览器半按固定顺序执行：宿主定位目标消息并算出分叉边界；浏览器半用 DSH 原生 `sessions.fork` 从边界开出新会话并切过去；宿主恢复文件；浏览器半把正文写回新会话的输入框，最后归档原会话。
- 任何一步失败都随结果返回稳定原因码与明细，客户端负责展示；不存在静默失败。

## 回退的准确语义

**会话侧。** 回退不改写日志，也不追加替换事件，而是用 DSH 原生的会话分叉：

```js
const childId = await ctx.sessions.fork({
  sessionId: <被点击消息所属的会话>,
  atSeq: <分叉边界>,
  increaseTitle: false,
})
await ctx.uiWorkspace.openSession(childId)
await post('/session-rollback/restore', { sessionId, childSessionId: childId, turn })
await ctx.workspaces.archiveSession(sessionId)
```

- `atSeq` 是分叉边界，取**目标消息所属轮次之前的最后一个事件**：通常是上一轮的 `turn/end`；首轮没有上一轮，取它的 `turn/start` 前一个事件。这样目标轮次自己的开场记录（`turn/start`、inbox 声明、`step/start`）不会进入新会话。
- 新会话只继承到边界为止的事件。被点击的用户消息、它所属轮次的 agent 输出、以及之后所有轮次都不在继承范围内，因此对话界面、模型上下文和轨迹都不再包含它们。
- 原会话保留并归档：会话列表里仍显示新会话（标题不变），原会话可在归档里找回；归档失败只影响列表，不影响回退结果。
- 宿主在分叉前只做校验和边界计算，日志没有任何变化；分叉失败时会话保持原样。
- 子会话继承父会话在目标轮次之前的文件快照记录（目标轮次本身已被切掉），之后在子会话里继续回退仍能恢复这些文件。

**文件侧。**

- 快照在工具**真正修改文件之前**抓取：插件挂在 `fs/write-intent`、`fs/edit-intent`、`fs/delete-intent` 三个瀑布上，先 `await next()` 拿到策略所有者的判定（本插件从不改变、也从不拦截该判定），再读取被解析目标当前的内容，最后返回原判定。因此存下的是"这次修改之前的字节"。
- 同一轮内同一路径只记第一次：后续修改不再覆盖，于是该轮记录的就是"这轮开始时"的内容。
- 归属由进程内发起链 `ctx.agents.currentInitiator()` 决定；若取不到，则回退到 `tools/pre-execute` 记下的 `ToolExecution` → Agent 映射（`fs/*-intent` 的 `actor` 通常正是该对象）。轮次取 `ctx.agents.turnBoundaryOf(session).lastTurn`。
- 恢复按轮次从新到旧：每轮恢复的是该轮开始前的内容，倒序回放后最终内容正是被点击那一轮开始时的内容。因此这几轮里新建的文件被删除，被删除的文件按原内容重建，被修改的文件回到旧内容。
- 恢复写入期间挂起抓取，避免本插件自己的写入被记进轮次记录。
- 恢复失败的条目逐条报出，不影响已经完成的分叉，也不阻断其余条目。

## 边界

- **shell 命令改的文件抓不到。** 只有经过 `fs/*-intent` 的文件写入会被抓取。`bash`、脚本、外部编辑器、`git checkout` 等不经过该接口的改动不会被恢复。这是本插件最大的边界。
- 只对"本进程内活着、且没有 open turn"的会话提供回退；正在跑回合的会话、只存在于磁盘上的历史会话都不行。
- 快照是本进程内的状态：宿主重启后，重启前那些轮次的快照不再可用，回退会如实报告这几轮无法完整恢复。
- 单文件超过 `maxFileBytes`、单轮超过 `maxTurnBytes` / `maxTurnFiles`、单会话超过 `maxSessionBytes` 时，该轮被标记为不可完整回退；会话仍然回退，结果里列出未覆盖的轮次与原因。
- 二进制文件读不出文本，按不可完整回退处理。
- 只回写正文：用户消息里的图片、附件等非文本部分无法写回输入框，结果里用 `writeBack.nonTextParts` 报告数量。
- 输入框已有草稿时不覆盖是客户端半的责任：宿主只返回正文，是否写入由客户端判断并提示。
- **回退后继续的是新会话**：会话 id 会变，标题与位置不变，原会话进归档；依赖旧会话 id 的东西（外部链接、导出、脚本）需要指向新会话。
- 归档失败时原会话仍留在列表里，回退本身仍然有效。

## 宿主接口

宿主服务键 `sessionRollback`，三个方法各对应一条与页面同源的 HTTP 路由（`host/api.js`）。浏览器半用 `fetch` 直接调它们，不带自定义头、不走 RPC 命名空间。

| 方法 | 路径 | 请求 |
|---|---|---|
| `POST` | `/session-rollback/state` | JSON 体 `{ sessionId }`；也接受 `GET ?sessionId=<id>` |
| `POST` | `/session-rollback/prepare` | JSON 体 `{ sessionId, seq?, ordinal?, index? }` |
| `POST` | `/session-rollback/restore` | JSON 体 `{ sessionId, childSessionId?, turn? }` |

请求体必须是 `application/json`，上限 64 KiB。鉴权由组合的 `connection` 服务负责：路由先用 `requestRejection` 过 Host/Origin 围栏与浏览器登录态校验，通过后才处理请求；没有有效登录态一律拒绝。

成功一律 `200` 加业务 JSON（下面几段就是响应体），业务层的"不能回退"也是 `200`：例如 `state.available` 为 `false` 并给出 `reason`。失败是下列状态码加统一 `{ code, message }`：

| 状态 | `code` | 含义 |
|---|---|---|
| 400 | `missing-parameter` / `bad-parameter` / `bad-request` | 缺少或非法参数；请求体不是 JSON 对象 |
| 401 | `unauthorized` | 请求没有有效的浏览器登录态 |
| 403 | `forbidden` | 请求没通过 Host/Origin 围栏 |
| 405 | `method-not-allowed` | 方法不符，`Allow` 头给出可用方法 |
| 413 | `payload-too-large` | 请求体超过 64 KiB |
| 415 | `unsupported-media-type` | 请求体不是 `application/json` |
| 500 | `internal-error` | 宿主内部失败；响应只有固定句子，不含堆栈与内部路径 |

```ts
// POST /session-rollback/state  { sessionId }
{
  available: boolean            // 此刻能否回退
  reason: string                // ready | turn-open | session-not-live | no-user-message | rollback-in-progress | internal-error
  detail: string | null
  sessionId: string | null
  busy: boolean                 // 本会话是否已有回退在执行
  userMessages: {               // 当前 surface 里的用户提问，按顺序
    seq: number                 // 首选定位方式
    index: number               // 0 基
    ordinal: number             // 1 基
    turn: number | null
    preview: string
    nonTextParts: number
  }[]
  snapshotTurns: { turn: number, files: number, complete: boolean, reasons: object[] }[]
  snapshotComplete?: boolean
  limits: { maxFileBytes, maxTurnBytes, maxTurnFiles, maxSessionBytes }
}

// POST /session-rollback/prepare  { sessionId, seq?, ordinal?, index? }
{
  ok: boolean                   // 目标已定位，且分叉边界有效
  stage: 'ready' | 'precheck'
  reason: string                // ready | target-missing | target-not-user-prompt | no-fork-boundary | turn-open | session-not-live | rollback-in-progress | internal-error
  detail: string | null
  target: { seq, index, ordinal, turn, preview, nonTextParts } | null
  forkAtSeq: number | null      // 交给 ctx.sessions.fork 的 atSeq
  writeBack: { text: string, nonTextParts: number } | null
  incompleteTurns: { turn, files, complete, reasons }[]
  complete: boolean             // 文件侧可完整还原
}

// POST /session-rollback/restore  { sessionId, childSessionId?, turn? }
{
  ok: boolean                   // 文件恢复无失败
  stage: 'done' | 'files' | 'precheck'
  reason: string                // rolled-back | partial-snapshot | file-restore-incomplete | 见上表
  detail: string | null
  files: {
    turns: number[]             // 参与恢复的轮次，新→旧
    restored: { path, turn }[]
    deleted: { path, turn }[]
    skipped: { path, turn, reason }[]
    failed: { path, turn, reason }[]
    untracked: boolean          // 目标轮及之后没有任何快照记录
  } | null
  incompleteTurns: { turn, files, complete, reasons }[]
  complete: boolean             // 文件侧可完整还原且无失败
  conversation: null            // 保留字段，分叉不在宿主执行
  writeBack: null
}
```

`seq` 优先；拿不到（页面还没拿到事件序号）时传 `ordinal`（1 基）或 `index`（0 基），二者等价。`seq` 必须指向当前 surface 中一条 `source.kind` 为 `user` 的用户消息，注入的上下文不是用户提问，不能作为回退目标。`restore` 的 `childSessionId` 用来让子会话继承父会话的文件快照；省略时只恢复文件、不继承。

路由注册在 `ctx.inject(['webServer', 'connection'], ...)` 的子上下文里，`webServer.register` 返回的 disposer 由 `ctx.effect` 持有，所以插件卸载时三条路由随之移除。服务实例只创建一次，`ctx.provide` 与路由收到的是同一个对象。

## 快照落点

`$DSH_HOME/session-rollback/<profile>/`（`DSH_HOME` 未设置时为 `~/.dsh`，`DSH_PROFILE` 未设置时为 `default`），结构：

```
session-rollback/
  <profile>/
    <URL 编码的会话 id>/
      blobs/<sha256>          内容按哈希去重，同一内容只存一份
      turns/<轮次>.json       该轮各路径的哈希（null 表示该轮开始时不存在）
```

- 目录不在任何用户工作区内。
- 子会话继承父会话时，目标轮次及之前的 `turns/*.json` 与它们引用的 `blobs/*` 会复制到子会话目录；因此子会话第一次回退也能恢复这些轮次改过的文件。复制会额外占用磁盘。
- 会话被释放（`session/disposed`）时删除该会话目录；插件卸载时删除整个 `<profile>` 目录，不碰其它 profile 的快照。
- 插件重载后仍活着的会话会从 `turns/*.json` 重新装载索引，避免 HMR 把仍在用的快照变成孤儿。

## 安装与回滚

本包是普通 bundle：`package.json` 声明 `dsh.bundle` 与 `dsh.client`，`cordis.patch.yml` 插入一行。

- 安装：用 Plugin Manager 的 `install_bundle` 指向本目录（宿主会读 `dsh.client` 并把 `client.js` 作为浏览器模块下发）。不要手改 profile 的 `package.json` 或 `cordis.patch.yml`。
- 卸载：用 Plugin Manager 的 `remove_bundle` / `set_bundle` 移除或停用。卸载时 `apply` 注册的监听、服务与全部快照目录一并清理。
- 单独停用宿主行为时，本插件不注册任何别的入口，停用即完全失效。

可调配置（`cordis.patch.yml` 的行内 `config`，本包不声明 `Config` schema，按原样读取并做类型兜底）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxFileBytes` | 524288 | 单个文件可被抓取的最大字节数，超过则该轮标记为不可完整回退 |
| `maxTurnBytes` | 8388608 | 单轮快照总字节上限 |
| `maxTurnFiles` | 200 | 单轮可抓取的文件数上限 |
| `maxSessionBytes` | 67108864 | 单会话快照总字节上限 |

## 已知限制

- shell 命令与外部的文件改动不经过意图接口，抓不到（见"边界"）。
- 宿主重启后，重启前的轮次没有快照，只能做会话回退。
- 抓取归属依赖进程内发起链；在发起链与 `tools/pre-execute` 都取不到 Agent 的写入（例如完全脱离 Agent 的宿主代码直接写文件）不会被记录。
- 快照按内容哈希去重但不压缩；长会话会持续占用磁盘，直到会话结束或超过 `maxSessionBytes`。
- 回退是破坏性的用户操作，本插件不提供撤销；原会话仍在归档里，但本插件不实现"从归档反向恢复"。
- 回退后继续的是新会话，旧会话 id 不再承载后续对话；归档失败时旧会话会留在列表里。
- 与其它监听 `fs/*-intent` 的插件共存时，本插件只读内容、不消费判定，不抢判定权，但会串行地多一次读取。
- 客户端按钮的插入位置依赖会话流的 DOM 结构（`[data-slot="conversation.chat.flow"]`），属于原生 DOM 注入；页面结构变化时需要跟随调整。
- 分叉与归档依赖 DSH 的客户端服务（`sessions.fork`、`uiWorkspace.openSession`、`workspaces.archiveSession`）；宿主升级改名时客户端半需要跟随调整。
