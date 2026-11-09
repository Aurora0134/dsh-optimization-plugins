# dsh-team-slot-reclaim

为「智能体团队」补一个删除入口：主会话可以把不再使用的 teammate 从团队名单里移除，收回它占用的成员名额。

## 前提

只在启用官方 `@deepseek-ai/dsh-experimental-agent-team-profile` 的 profile 里生效；Agent Teams 未启用时本插件不注册任何东西。

## 工具

`delete_teammate({ target })`

- 只注册在主会话（团队负责人）里；teammate 会话看不到这个工具。
- `target` 取 `list_agents` 或 `spawn_teammate` 返回的 teammate 名字，`lead` 不能删除。
- 只接受没有回合在跑、也没有正在创建的成员；创建失败的成员同样占用名额，可以删除。
- 成员名下进行中的任务会先退回看板，变成无主的待办；退回失败则整个删除不执行。
- 成功后该成员立即从名单消失，不能再被发消息、中断或唤醒，成员名额随之收回；它的会话记录仍保留在本地。
- 被删成员的名字会一直保留，不能再用于新成员。这延续团队原有的命名规则，插件在删除后继续执行这条规则。

## 删除的持久性

官方团队日志是追加式的，删除只改变会话当前的团队投影。插件在删除时写入投影检查点，并把删除记录到 `$DSH_HOME/team-slot-reclaim/removed.json`。投影被重建后（重启时缓存不可用、插件重载），成员可能短暂回到名单，插件会在下次加载、下一次团队状态变化或下一次调用删除工具时按记录再次移除它。检查点写入失败时，删除仍由这条记录保证。

团队面板不会在删除瞬间刷新：它在下一次团队状态变化或页面重载后更新。

## 安装 / 回滚

```
plugin_manager(action="install_bundle", target="<本目录绝对路径>")
```

禁用而不卸载，删除工具立即消失：

```
plugin_manager(action="set_plugin", target="team-slot-reclaim", enabled=false)
```

彻底移除：

```
plugin_manager(action="remove_bundle", target="dsh-team-slot-reclaim")
```

## 兼容性

本包只有 Host 半区，依赖 Agent Teams 的 `agentTeams` 服务、`agentTeam` 会话投影的成员数组、`agentTeams.spawnTeammate` 的命名检查，以及 `subagents.drainChildren` 的释放路径。这些是官方实验包的内部结构，升级后可能变化；届时禁用或卸载本插件即可回到原生行为。
