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

## 测试完成过的Agent

Hermes， Deepseek Harness

## 工作方式

- 订阅 `chat.run.started` / `chat.run.failed` / `chat.run.completed` / `chat.run.stopped` 业务事件。
- Studio 的业务事件投影出于安全考虑**不包含原始错误文本**，因此插件在运行开始时通过 `host.sessions.connect()` 建立该会话的实时连接，从原始 `run.failed` 载荷读取 `error`、`stop_reason`、`interrupted`、`queue_remaining` 后再判定。
- Studio 在事件处理函数返回后会立即中止该次调用的 RunContext，因此连接建立、退避等待和续跑发送都由 `apply()` 时创建的插件生命周期泵执行，不依赖事件处理函数的活动信号。
- 用户停止会同时通过 `chat.run.stopped` 业务事件和 socket 的 `abort.completed` 识别，取消待执行的续跑并清零计数；停止后 15 秒内的失败事件不会再触发续跑。
- 实时连接不可用时退回业务事件判定：仅能识别通用失败，仍会受停止抑制、次数上限和退避保护。
- 截断判定：先读原始 `stop_reason`；ekko-agent 的完成事件不输出 `length`，因此再查询该会话最新消息的 `finish_reason`（`length` / `max_tokens` / `max_output_tokens`）确认是否被截断。
- 发送续跑：`host.sessions.run(sessionId, prompt, { profile })`，并带上会话所属 Profile；切换模型：`host.sessions.setModel()`。
- 活动记录写入插件数据目录的 `activity.jsonl`（超过 1 MB 轮转为 `.1`），设置页展示最近 100 条。

## 范围与限制

- 仅处理普通聊天会话；跳过群聊、工作流、子智能体和私有 person 会话。
- Studio 没有向插件开放真正的上下文压缩接口，因此“上下文溢出”只能切换备用模型或停止，无法执行 compact。
- 续跑是重新发送一条消息，模型上下文会继续增长；请依靠次数上限和退避控制成本。
- 会话 socket 使用插件的激活身份建立，因此只有激活 Profile 的会话能拿到原始 error 文本；其他 Profile 的会话仍可续跑（发送时带上会话 Profile），但失败判定退回业务事件，只能识别通用失败。
- 若实时连接建立失败，用户主动停止仍可依据 `chat.run.stopped` / `abort.completed` 取消续跑。
- 0.1.0 已在 开发者本地部署的docker上 实测：用户停止不续跑、注入连接失败后发送续跑提示、正常完成不中止 `finish_reason` 查询。

## 开发

```bash
npm test
```

测试使用模拟的 `ctx` 和会话连接，覆盖可重试失败、认证失败、次数上限、截断续跑、持久化 `finish_reason` 截断判定、正常完成清零、重复事件、群聊跳过、上下文切换模型、原始 socket 判定、用户取消、socket abort、`chat.run.stopped` 取消、跨 Profile 续跑、排队中断和活动 RPC。

## 文件

- `plugin.json`：插件清单（权限、配置 schema、设置页导航）。
- `server.mjs`：判定、调度、退避、活动记录、RPC。
- `client.mjs`：设置页（状态卡片、活动表、计数表）。
- `test/server.test.mjs`：单元测试。

## 引用与致谢

本插件的自动续跑行为参考并移植自 [weibaohui/dsh-continue](https://github.com/weibaohui/dsh-continue)，原项目采用 MIT License（Copyright (c) 2026 weibaohui）。

本项目是针对 Ekko Studio Plugin SDK v1 的独立重写实现，与原项目及其作者无隶属关系。原项目的判定规则、冷却、指数退避和次数上限等设计是本项目的行为来源。

## 许可证

MIT License

Copyright (c) 2026 mhemh
Copyright (c) 2026 weibaohui（源自 dsh-continue 的部分）

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
