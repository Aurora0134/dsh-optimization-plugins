# dsh-notify-user

DSH 插件：给任意 agent 预设加一个 `notify_user` 工具，让 agent 在不结束本轮的情况下向用户发布进度更新，并在对话里渲染成一张可展开的卡片。

对应 kimi-code 的 `NotifyUser`：同一套触发语义（何时该发、怎么写、nudge 节奏），按 DSH 的工具与 UI 契约重新实现。

## 行为

- **工具**：`notify_user(title?, message)`。`message` 必填，`title` 是单行标题；成功时返回 `Update shown to the user.`。
- **卡片**：会话内替换该工具行的渲染——状态点、标题、时间、正文（轻 Markdown，长正文可折叠）；子 agent 的更新带来源角标。
- **提示词**：工具可见时追加一段使用引导，工具不可见时不出现（不占上下文）。
- **Nudge**：连续 8 轮工具调用没有发布更新时，向该 agent 注入一次提醒；每 8 轮最多提醒一次。
- **覆盖范围**：在 profile 根上下文注册，属于全局工具，因此 standard / creator / PTC / 极简 / 自定义预设，以及子 agent 都能看到并使用。

## 配置

在 `cordis.patch.yml` 覆盖本行即可：

```yaml
- id: notify-user
  name: dsh-notify-user
  config:
    enabled: true       # false 时工具与提示词一起消失
    nudgeAfterRounds: 8 # 连续多少轮没有更新后提醒
    nudgeRepeatRounds: 8
```

## 与 kimi-code 的差异

| kimi-code | 这里 |
|---|---|
| 实验开关 + `update_panel` UI 能力双门控，默认关 | 默认开，`enabled` 关 |
| 开关按会话持久化，只对之后新建的会话生效 | 开关是部署级配置，改后需重载该插件行（重启 Harness）才生效 |
| TUI Updates 面板 + web/desktop 进度行 | 只有 Web 会话内卡片；终端形态没有对等面板 |
| 遥测事件 | 未实现 |

## 验证

```
node --check index.js
node --check client.js
```

装好后在会话里查 `cordis_inspect_query` 的工具清单应能看到 `notify_user`；发一条消息让 agent 发进度更新，会话内应出现卡片。
