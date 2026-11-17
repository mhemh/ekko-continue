# Ekko Continue 自动继续

把 [dsh-continue](https://github.com/weibaohui/dsh-continue) 的自动续跑行为移植为 Ekko Studio 原生插件（Plugin SDK v1），在 Studio 的会话层工作，对所有内置 / 桥接 Agent 生效。

会话运行失败或输出被截断后，插件会按规则向同一会话发送续跑提示（默认“继续”），并内置判定规则、冷却时间、指数退避、单会话次数上限和活动记录页。

## 规则

| 失败判定 | 动作 |
| --- | --- |
| 认证 / 密钥错误（401、403、invalid api key…） | 停止，不重试 |
| 配额 / 余额不足 | 停止，不重试 |
| 请求参数 / 模型不存在等不可重试错误 | 停止 |
| 用户主动停止（Run canceled、aborted by user…） | 停止 |
| 为插入排队消息而中断（queue insertion） | 停止，交给排队消息 |
| 上下文溢出（context length…） | 配置了备用模型则切换模型后继续，否则停止 |
| 达到最大输出 / 截断（length、max_tokens） | 继续 |
| 限流、网络、超时、服务端 5xx、未知错误 | 继续 |

成功完成一轮后计数清零；用户手动发起新的一轮会取消待执行的续跑并清零。自动续跑本身不会重置计数，避免绕过上限。

## 配置

在插件中心的插件配置中修改：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| 启用自动继续 | 开 | 关闭后仍记录事件，但不会续跑 |
| 续跑提示词 | `继续` | 发送到会话的文本 |
| 单会话最大续跑次数 | 5 | 1–20 |
| 冷却时间 | 5000 ms | 两次续跑之间的最小间隔 |
| 退避基数 | 2000 ms | 第 n 次等待 `基数 × 2^(n-1)` |
| 退避上限 | 30000 ms | 单次等待上限 |
| 备用模型 Provider / Model / API 模式 | 空 | 上下文溢出时切换；Provider 与 Model 同时填写才生效 |

## 安装到 192.168.0.14:6060

插件文件必须位于 Studio 进程可读的服务器本地路径，安装动作需要**超级管理员交互登录**。

1. 把整个 `ekko-continue-plugin` 目录复制到 Studio 所在机器，例如 `/opt/ekko-continue-plugin`。
   - 原生部署：用 SCP / SMB / U 盘等方式复制。
   - Docker 部署：`docker cp ekko-continue-plugin <容器名>:/opt/ekko-continue-plugin`，或把它放进已挂载的宿主机目录。
2. 浏览器登录 `http://192.168.0.14:6060/`（超级管理员）。
3. 打开 **插件中心** → 安装 → 选择**本地目录安装** → 填入服务器绝对路径（如 `/opt/ekko-continue-plugin`）。
4. 信任该插件并授予 `events`、`api.read`、`api.write`、`ui` 权限，然后**启用**。
5. 在插件中心打开本插件配置；在 **设置 → 自动继续** 查看活动记录和当前计数。

> 本地目录安装只复制成品，不会在 Studio 启动时同步源码；修改源码后需重新安装或使用开发链接。
> 要求 Studio 版本支持 Plugin SDK v1（0.8.x，清单 `apiVersion: 1`）。旧版本不会加载本插件。

## 工作方式

- 订阅 `chat.run.started` / `chat.run.failed` / `chat.run.completed` 业务事件。
- Studio 的业务事件投影出于安全考虑**不包含原始错误文本**，因此插件在运行开始时通过 `host.sessions.connect()` 建立该会话的实时连接，从原始 `run.failed` 载荷读取 `error`、`stop_reason`、`interrupted`、`queue_remaining` 后再判定。
- 实时连接不可用时退回业务事件判定：仅能识别通用失败，仍会受次数上限和退避保护。
- 截断判定：先读原始 `stop_reason`；ekko-agent 的完成事件不输出 `length`，因此再查询该会话最新消息的 `finish_reason`（`length` / `max_tokens` / `max_output_tokens`）确认是否被截断。
- 发送续跑：`host.sessions.run(sessionId, prompt)`；切换模型：`host.sessions.setModel()`。
- 活动记录写入插件数据目录的 `activity.jsonl`（超过 1 MB 轮转为 `.1`），设置页展示最近 100 条。

## 范围与限制

- 仅处理普通聊天会话；跳过群聊、工作流、子智能体和私有 person 会话。
- Studio 没有向插件开放真正的上下文压缩接口，因此“上下文溢出”只能切换备用模型或停止，无法执行 compact。
- 续跑是重新发送一条消息，模型上下文会继续增长；请依靠次数上限和退避控制成本。
- 实时连接依赖会话 socket；若该连接建立失败，用户主动停止等场景只能依据业务事件兜底判断。
- 本版本未在 192.168.0.14 上做实机验证（无该机器的登录 / 文件访问权限），安装后请先在测试会话中确认。

## 开发

```bash
npm test
```

测试使用模拟的 `ctx` 和会话连接，覆盖可重试失败、认证失败、次数上限、截断续跑、持久化 `finish_reason` 截断判定、正常完成清零、重复事件、群聊跳过、上下文切换模型、原始 socket 判定、用户取消、排队中断和活动 RPC。

## 文件

- `plugin.json`：插件清单（权限、配置 schema、设置页导航）。
- `server.mjs`：判定、调度、退避、活动记录、RPC。
- `client.mjs`：设置页（状态卡片、活动表、计数表）。
- `test/server.test.mjs`：单元测试。