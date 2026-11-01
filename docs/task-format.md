# 使用说明

> 本文保留 M1 的基础格式与历史边界；当前超时、重试及审批能力请以 [工具治理说明](tool-governance.md) 为准。

## 1. 先运行演示

在 `D:\VScodeProgects\harness-engineering` 执行 `npm run demo`。

系统会在 `.artifacts/demos/run-*` 新建工作区，将错误的加法函数改正确，然后执行四个算术验收用例和文件产物检查。模型回复是预设的，Session、工具、文件修改和验收进程都是真实执行。

演示输出 taskFile 路径，便于打开查看任务输入；输出 runId 后可以用 inspect 查看结果。首次演示代码见 `examples/file-edit/`。

## 2. 自定义任务格式

任务文件为 UTF-8 JSON。路径以任务 JSON 所在目录为基准，工具中的 path 则以工作区为基准。

```json
{
  "schemaVersion": 1,
  "taskId": "write-answer",
  "input": "将 answer.txt 改为 after",
  "workspace": "./workspace",
  "tools": ["read", "write"],
  "budget": {
    "maxDurationMs": 30000,
    "maxToolCalls": 5,
    "maxTokens": 20000
  },
  "model": {
    "mode": "scripted",
    "responses": [
      {"calls": [{"name": "write", "arguments": {"path": "answer.txt", "content": "after"}}]},
      {"text": "修改完成"}
    ]
  },
  "verification": {
    "version": "1",
    "checks": [
      {"kind": "file", "name": "answer-content", "path": "answer.txt", "equals": "after"}
    ]
  }
}
```

先创建 workspace，再运行任务。scripted 响应耗尽会产生 model_error；每次工具轮结束后应提供下一次回复。可以通过空工具列表只允许模型输出，但仍必须配置独立验收。

任务输入在启动 Worker 前校验。空验收列表、未知字段、非法预算和不支持的工具会被拒绝。

## 3. 独立验收

支持两种检查：

- file：检查工作区文件是否与期望 UTF-8 内容逐字节一致，同时保留实际/期望摘要。
- node：运行单文件 CommonJS 检查器，退出码 0 通过，非零失败，超时或无法启动为错误。

Node 检查示例：

```json
{"kind":"node","name":"behavior","script":"./verify.cjs","args":[],"timeoutMs":3000}
```

检查器必须是 `.cjs`，启动前复制到 Run 的 verification 目录并冻结内容摘要。检查器 cwd 为任务工作区，用 process.cwd() 定位待检查产物。当前支持独立单文件检查器；不自动打包它旁边的辅助文件或 npm 依赖。

检查器是宿主信任的代码，具有当前用户权限。冻结副本与工具工作区范围防止本轮 Agent 改写检查器；这不构成 OS 隔离。不要把任意不可信脚本当作检查器。Node 子进程不继承模型密钥，只接收启动必需的少量系统环境变量。

## 4. 后台运行与取消

```powershell
npm run harness -- run .\task.json --detach --state .\.harness
npm run harness -- inspect <run-id> --state .\.harness
npm run harness -- cancel <run-id> --state .\.harness
```

Worker 在运行期间轮询取消请求，已进入验收阶段时取消会终止验收进程树。cancel 的 accepted=true 不表示已经停稳，请继续 inspect。

取消只停止后续操作，不能撤销已完成的文件修改。cancellation.effects 可能为 present、unknown 或 none_confirmed。文件修改和独立检查器都可能产生副作用，状态按已有证据保守记录。

发现 Worker 已退出而没有终态时，inspect 标记 interrupted。M1 没有 resume 命令，不会自动重试不确定的操作。

## 5. 预算含义

| 配置 | M1 行为 |
|---|---|
| maxToolCalls | 每次授权工具前检查，达到上限后拒绝新调用 |
| maxDurationMs | 从 Run 创建后的执行准备开始计时，覆盖初始化、执行和验收；支持信号的工作会被取消 |
| maxTokens | 累加 Pi 已报告的输入/输出总用量，在响应完成时检查，不能保证服务端正在生成的请求不超额 |
| maxCostUsd（可选） | 按 Pi 已报告的费用在响应边界检查，不是账单硬上限 |

一次工具错误会终止本轮 Run。自动重试与细分错误策略由 M2 扩展。文件工具依赖本机文件系统，取消不能回滚已完成的写入。

## 6. 真实模型模式

将 model 替换为：

```json
{"mode":"live","provider":"配置中的提供方标识","id":"固定模型标识","apiKeyEnv":"MY_MODEL_API_KEY"}
```

密钥由指定环境变量提供；程序不扫描已有 Pi 的全局凭据。该模型必须存在于锁定 Pi 版本的内置目录中。M1 没有自定义网关、OAuth 或模型目录刷新界面。

本阶段只验证了缺少显式密钥时的失败处理，没有发出真实模型网络请求。因此真实服务鉴权、计费和网络取消仍需配置后另行验证。

## 7. 记录和故障排查

默认状态目录是本项目 `.harness`。Worker 日志位于 logs，Pi 原始会话位于对应 Run 的 sessions。独立验收的结果文件记录退出码、stdout/stderr、超时和取消信息。

`inspect <id> --events` 从 SQLite 读取顺序事件；`--export-trace` 可在修复文件系统问题后重新生成 events.jsonl。SQLite 是权威记录，JSONL/报告是派生文件。

导出异常在 Run.exportErrors 与 export.failed 事件中显示。修复目录权限或占用后再导出；不要删除 SQLite 来“修复”日志问题。

统一事件和验收输出有敏感字段过滤、显式密钥替换及长度限制。原始任务快照、Pi Session 和 Worker 原始诊断属于本机运行数据，不承诺全部脱敏，也没有加密。不要将整个状态目录当作可直接公开的报告。

## 8. 当前边界

- 支持 Windows + Node v24.22.1；其他平台尚未在本机实测。
- 提供机械工具白名单与路径检查，未提供进程/容器沙盒或对抗外部并发文件修改的隔离。
- 初始文件摘要跳过 .git 和 node_modules；限制 5000 个文件/32 MiB，并拒绝符号链接。它是可追溯清单，不是可恢复的完整副本。
- 当前没有人工审批、恢复执行、长任务压缩、长期记忆或策略进化。
- 成功结论仅针对已配置的验收标准，不代表任意业务正确性。
