# dsh-session-rollback

把会话回退到任意一条用户消息：该消息及其之后的全部对话从界面与模型上下文中消失，这几轮被文件工具改过、创建、删除的文件恢复到当时的内容。原始会话记录不会被删除。

本仓库只包含**宿主半**；浏览器半（按钮、二次确认、写回输入框）由 `client.js` 提供，本包在 `package.json` 里声明其导出与 `dsh.client` 段。

## 做什么

- 每条用户消息的动作行里多一个"回退到此消息"按钮（客户端半）。
- 点击后二次确认，确认文案写明三件事：会移除该消息及之后的全部对话；会把这轮及之后改过的文件恢复到当时的内容；原始会话记录保留。
- 确认后由宿主半按固定顺序执行：先做会话替换，再按轮次从新到旧恢复文件。
- 任何一步失败都随结果返回稳定原因码与明细，客户端负责展示；不存在静默失败。

## 回退的准确语义

**会话侧。** 会话日志仍是 append-only，回退只追加一个事件：

```js
session.append(
  'developer/message',
  { turn: <被点击消息所在轮次>, step: 1, message: { role: 'developer', content: [] } },
  {
    surfaceOp: { op: 'replace', startSeq: <被点击的用户消息 seq>, endSeq: <当前最后一个 surface 节点 seq> },
    sourceEventSeqs: [...被覆盖的全部 surface 节点 seq],
  },
)
```

- 被覆盖的节点从 `session.surface.nodes` 中消失，因此不再进入后续模型输入，也不再出现在会话界面上；它们的原始日志记录保持不变。
- 替换节点本身是 content 为空的 developer 消息。空内容的 system/developer 节点不投影成任何消息，所以它自己不留可见行。
- `sourceEventSeqs` 必须覆盖被替换区间内的**全部 surface 节点**（日志 seq 之间的非 surface 事件不必列入）；框架逐项校验，缺一个即拒绝。
- surface 节点 0 若是 `system/message`（系统提示）受框架保护，本插件在执行前就拒绝，不去触发框架异常。
- 追加后本插件立即回读 `session.surface.nodes` 校验替换确实生效（目标 seq 消失、末尾是替换节点）；未生效则整体报失败，且**不**动文件。
- 回退后新的消息追加在替换节点之后，模型看到的是"系统提示 + 之后的对话"。

**文件侧。**

- 快照在工具**真正修改文件之前**抓取：插件挂在 `fs/write-intent`、`fs/edit-intent`、`fs/delete-intent` 三个瀑布上，先 `await next()` 拿到策略所有者的判定（本插件从不改变、也从不拦截该判定），再读取被解析目标当前的内容，最后返回原判定。因此存下的是"这次修改之前的字节"。
- 同一轮内同一路径只记第一次：后续修改不再覆盖，于是该轮记录的就是"这轮开始时"的内容。
- 归属由进程内发起链 `ctx.agents.currentInitiator()` 决定；若取不到，则回退到 `tools/pre-execute` 记下的 `ToolExecution` → Agent 映射（`fs/*-intent` 的 `actor` 通常正是该对象）。轮次取 `ctx.agents.turnBoundaryOf(session).lastTurn`。
- 恢复按轮次从新到旧：每轮恢复的是该轮开始前的内容，倒序回放后最终内容正是被点击那一轮开始时的内容。因此这几轮里新建的文件被删除，被删除的文件按原内容重建，被修改的文件回到旧内容。
- 恢复写入期间挂起抓取，避免本插件自己的写入被记进轮次记录。
- 恢复失败的条目逐条报出，不影响已经提交的会话替换，也不阻断其余条目。

## 边界

- **shell 命令改的文件抓不到。** 只有经过 `fs/*-intent` 的文件写入会被抓取。`bash`、脚本、外部编辑器、`git checkout` 等不经过该接口的改动不会被恢复。这是本插件最大的边界。
- 只对"本进程内活着、且没有 open turn"的会话提供回退；正在跑回合的会话、只存在于磁盘上的历史会话都不行。
- 快照是本进程内的状态：宿主重启后，重启前那些轮次的快照不再可用，回退会如实报告这几轮无法完整恢复。
- 单文件超过 `maxFileBytes`、单轮超过 `maxTurnBytes` / `maxTurnFiles`、单会话超过 `maxSessionBytes` 时，该轮被标记为不可完整回退；会话仍然回退，结果里列出未覆盖的轮次与原因。
- 二进制文件读不出文本，按不可完整回退处理。
- 只回写正文：用户消息里的图片、附件等非文本部分无法写回输入框，结果里用 `writeBack.nonTextParts` 报告数量。
- 输入框已有草稿时不覆盖是客户端半的责任：宿主只返回正文，是否写入由客户端判断并提示。

## 宿主接口

宿主服务键 `sessionRollback`，两个方法以 Typert Remote 的**源码模式**（SRC）暴露为端点 `sessionRollback/state` 与 `sessionRollback/rollback`。本包不含生成物 `./typert`，所以服务实例自己在类原型上写出与 `@Remote()` 相同的版本化描述符，并给出 `typertRemote` 绑定；Gateway 以方法参数名推导线上字段。两个方法因此只用简单标识符参数。

```ts
state(sessionId: string): Promise<{
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
}>

rollback(request: {
  sessionId: string
  seq?: number                  // 优先：用户消息事件的 seq
  ordinal?: number              // 拿不到 seq 时：第几条用户提问（1 基）
  index?: number                // 0 基下标，二者等价
}): Promise<{
  ok: boolean                   // 会话替换完成且无文件失败
  stage: 'precheck' | 'surface' | 'files' | 'done' | 'internal'
  reason: string                // rolled-back | partial-snapshot | file-restore-incomplete | 见上表
  detail: string | null
  conversation: { startSeq, endSeq, shadowedNodes, replacementSeq, flushed } | null
  target: { seq, index, ordinal, turn, preview, nonTextParts } | null
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
  writeBack: { text: string, nonTextParts: number } | null
}>
```

浏览器半从 `ctx.connection` 的通用 RPC 直接调这两个端点（SRC 端点没有生成物，因此不会出现在 `ctx.remote` 的命名空间里）：

```js
const reply = await ctx.connection.rpc.call('/api', 'sessionRollback/state', { args: { sessionId } })
// reply: { ok: true, value } | { ok: false, error: { code, message, details } }
const done = await ctx.connection.rpc.call('/api', 'sessionRollback/rollback', {
  args: { request: { sessionId, seq } },
})
if (done.ok) { /* done.value.ok / reason / files / writeBack */ }
```

`args` 必须只含描述符声明的字段；多余的字段由 Gateway 以 `gateway/arguments-invalid` 拒绝，`ok:false` 的 `error.code` 取 `gateway/*` 一类传输/校验失败。业务结果始终在 `ok:true` 的 `value` 里。

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
- 会话被释放（`session/disposed`）时删除该会话目录；插件卸载时删除整个 `<profile>` 目录，不碰其它 profile 的快照。
- 插件重载后仍活着的会话会从 `turns/*.json` 重新装载索引，避免 HMR 把仍在用的快照变成孤儿。

## 安装与回滚

本包是普通 bundle：`package.json` 声明 `dsh.bundle.patch` 与 `dsh.client`，`cordis.patch.yml` 插入一行。

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
- 回退是破坏性的用户操作，本插件不提供撤销；原始日志仍在，但本插件不实现"从日志反向恢复"。
- 与其它监听 `fs/*-intent` 的插件共存时，本插件只读内容、不消费判定，不抢判定权，但会串行地多一次读取。
- 客户端按钮的插入位置依赖会话流的 DOM 结构（`[data-slot="conversation.chat.flow"]`），属于原生 DOM 注入；页面结构变化时需要跟随调整。
