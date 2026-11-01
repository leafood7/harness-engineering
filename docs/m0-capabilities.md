# M0 能力验证表

核实日期：2026-11-01。环境：Windows、Node v24.22.1。

## 基线

- 实际 origin：https://github.com/earendil-works/pi
- 本地提交：`42cb822f1c5d3153069dd0661bfd297424666cf1`。
- `packages/coding-agent/package.json`：`@earendil-works/pi-coding-agent` 1.4.0，MIT，Node >=22.19.0。
- 根 package.json 的 0.0.3 是 monorepo 根版本，不能当作 Coding Agent SDK 版本。
- 现有 node_modules 可支持本轮源码验证，无需安装或重新构建。
- 原有工作区修改：package-lock.json 已修改、pi-run.bat 未跟踪。本阶段未修改这些文件，也未更新 Pi。
- 关键源码 SHA-256 及仓库状态记录在 `m0/pi-baseline.json`。验证结果只对应此基线，不代表最新发布版。

## 实测能力

| 检查 | 如何验证 | 结论 |
|---|---|---|
| Session 与 Prompt | 通过 createAgentSession 创建，模拟模型返回固定文本 | 通过；收到最终文本 |
| 事件与结束信号 | subscribe 捕获事件，bindExtensions 后捕获 session_start | 通过；收到 agent_settled |
| 工具执行 | 模型发出 echo 调用，核对真实执行计数和工具结果 | 通过 |
| 自定义工具阻止 | tool_call 返回 block，核对计数没有增加 | 通过 |
| 内置工具阻止 | 阻止 PowerShell 写文件，核对文件不存在和错误结果 | 通过 |
| 策略异常 | tool_call 检查器抛错，核对工具没有执行及错误证据 | 通过 |
| 会话恢复 | dispose 原 Session，SessionManager.open 读取磁盘，新建 Session 后继续 | 通过；恢复 19 条消息，模型输入中仍有原始对话 |
| 合作工具取消 | 工具响应 AbortSignal；取消后等待原定写入时点 | 通过；没有后续副作用 |
| 不合作工具取消边界 | 工具故意忽略 AbortSignal | 确认边界；取消请求发出后，工具仍完成了一次副作用 |
| Windows 进程树取消 | PowerShell 启动 Node 父子进程；子进程写心跳与延迟标记 | 通过；子 PID 不存在、心跳停止、延迟标记未出现 |

上表将第一项测试的 Session/事件能力拆开说明，对应脚本共 9 项检查，全部通过。边界测试通过表示准确复现了限制，不能解释为所有工具都能被强制取消。

## 证据

本轮最终证据：`.artifacts/m0/run-Ari5yE/`。

- `results.json`：9 项结果、耗时、恢复消息数及进程检查结果。
- `events.jsonl`：按序保存的 Session 事件与扩展检查记录。
- `sessions/`：由 Pi 保存的原生会话。
- `workspace/`：本轮进程测试脚本、PID 和已停止更新的心跳。

## 需要保留的限制

1. 模型使用 Pi 自带 faux provider。SDK 到工具的执行链是真实的，但未验证外部模型鉴权、网络流式响应、服务端取消及真实任务质量。
2. 恢复测试是同一 Node 进程中销毁旧 Session、从磁盘重建新 Session。未声称覆盖操作系统崩溃、断电或持久化事务一致性；这些由 M3 故障注入补齐。
3. abort 会发出取消并等待 idle；忽略信号的工具可能在等待期间继续产生副作用。不能将请求取消等同于副作用已终止。
4. Windows killProcessTree 使用异步 taskkill，源码会忽略清理失败。此次已实际观察终止成功，仍不能推导出所有进程树、逃逸进程或平台均得到保证。
5. tool_call 拦截覆盖本轮模型发起的自定义和内置工具。扩展自身 Node API、直接网络/文件操作以及其他执行入口不自动构成同一安全边界。Extension 与主进程共享权限。
6. 事件包含低层 agent_end 和最终 agent_settled。收到 agent_settled 后仍须检查错误、取消及独立验证结果；它本身不代表任务成功。
7. M0 的全量本地测试事件不含真实凭据。M1 持久化真实工具输入输出之前应加入脱敏、大小限制和产物引用。

## 源码依据

相对 Pi 根目录：

- `packages/coding-agent/docs/sdk.md`：SDK 集成和事件语义。
- `packages/coding-agent/src/core/sdk.ts`：createAgentSession 与明确的依赖注入入口。
- `packages/coding-agent/src/core/agent-session.ts`：abort、waitForIdle、agent_settled、bindExtensions。
- `packages/coding-agent/src/core/session-manager.ts`：create、open、原生会话持久化。
- `packages/coding-agent/src/core/extensions/runner.ts`：tool_call 阻止机制。
- `packages/coding-agent/src/core/tools/powershell.ts`、`tools/bash.ts`、`src/utils/shell.ts`：本机执行和进程清理。
- `packages/ai/src/providers/faux.ts`：无外部模型调用的可控测试提供方。
