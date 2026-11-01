# 检查点与中断恢复

版本：Harness Engineering 0.3.0；Pi SDK 1.4.0；SQLite schema v3。

## 快速使用

```powershell
npm run harness -- inspect <old-run-id>
npm run harness -- resume <old-run-id> --dry-run
npm run harness -- resume <old-run-id>
```

支持 --detach 和 --state。自定义状态目录时，各命令必须使用同一目录。恢复不额外引入审批：只有原任务工具策略本来配置为 ask，新操作才需要新的审批。

--dry-run 会报告 eligible、拒绝原因、检查点、恢复模式和剩余预算。它不创建新 Run、不认领恢复、不执行工具，也不改变原运行状态；打开历史数据库时仍可能进行增量结构升级。

真实中断演示：

```powershell
npm run demo:recovery
```

演示在新工作区执行 read、write、wait；写入完成后，在等待工具运行时终止本轮自建 Worker，再恢复任务并独立验收。预期恢复链只有 1 次 write、累计 4 次工具尝试。模型为本地 scripted provider，没有真实模型调用。

## 检查点保存什么

- 当前工作区文件清单与摘要。
- 原生 Pi Session 的冻结副本、摘要和会话 ID。
- 原任务、策略、独立验收标准的完整性摘要。
- 已完成模型响应的游标、已报告用量和运行时间记录。
- 对应事件序号与是否已经可以独立验收。

检查点写在初始化后的 ready、完整 turn_end、正常 agent_settled 和 verifying 边界。

Pi 的公开 message_end 监听先于会话落盘，因此不能据此直接宣称会话已保存。turn_end 时整轮工具结果已进入 SessionManager，是这里采用的完整执行边界。Session 副本先写入并 fsync，再将检查点放进 SQLite；JSON 文件是供查看的导出，SQLite 是检查点元数据的权威来源。

当前每次检查点都计算全量受跟踪文件摘要并保存 Session 副本，优先确保可核查性，尚未优化为增量快照。沿用工作区 5000 个文件/32 MiB 限制，跳过 .git、node_modules，拒绝符号链接。它不备份文件内容，也不会自动把工作区回滚。

## 操作台账

每次获准尝试在产生工具效果之前，与预算扣减一起写入 operations。记录工具名、参数摘要、是否有副作用及状态：

```text
未授权/未开始 → authorized → running → succeeded / failed
```

结果不确定的失败保留分类。恢复检查还会比较操作的事件序号与最近完整检查点，以识别检查点之后的写入。

台账记录实际尝试，不是完整的未来任务规划。没有记录的未来步骤不会被当成已经执行。

## 恢复流程

1. 确认原 Worker 已退出，源 Run 属于 interrupted 或 cancelled。
2. 查找最新完整检查点，验证工作区、Session、任务、策略、SDK 与验收标准。
3. 核查检查点之后的工具、模型和验收状态。
4. 计算原恢复链剩余预算。
5. 在同一事务中创建新 Run、记录父子关系并认领源 Run。
6. 通过 Pi 的 SessionManager.forkFrom 从冻结会话分叉，保留原历史，不覆盖旧会话。
7. 继续执行，或只重新运行独立验收。

新 Run.resumedFromRunId 指向来源，原 Run.resumedByRunId 指向唯一恢复子 Run。恢复生成新的 Session ID，recovery.sourceSessionId 保留来源会话关系。

两个 CLI 同时恢复同一来源，只能成功创建一个恢复子 Run。原 Run 一旦被认领，不可反复恢复；后续从最新子 Run继续，且仍受安全核查约束。子 Run 启动时也会保存继承的会话检查点，避免再次中断后丢失历史。

## 两种模式

- continue：保留完整会话历史，从检查点继续。无副作用的读取/等待可能重新执行。
- verify_only：执行已完成，独立验收尚未完成或被正常取消，只重新验收，不再发出模型请求或执行 Agent 工具。

恢复读取 Run 中冻结的任务与验收副本，不重新读取外部原始任务文件来替换标准。修改原任务 JSON 或原始检查器，不会改变恢复中的验收条件。

## 哪些情况会拒绝自动恢复

| 情况 | 处理 |
|---|---|
| 原 Worker 还活着 | 拒绝并行接管 |
| Run 已完成或普通失败 | 不作为中断恢复来源 |
| M1/M2 旧 Run 没有 M3 检查点 | 明确拒绝，不伪装成可恢复 |
| 文件与检查点不同 | 拒绝覆盖或回放；保留当前文件 |
| 任务、策略、Session 或验收副本变化 | 完整性校验失败 |
| Harness / SDK / 生效策略不同 | 拒绝静默换版本恢复 |
| 写入发生在最后完整检查点之后 | 即使看到了成功记录，也先人工核查，不机械重放 |
| 模型调用尚未结束或用量不明 | 拒绝把未知消耗当成零 |
| 验收进程可能仍有未确认效果 | 拒绝再次启动验收 |
| 已耗尽剩余预算 | 不通过新 Run 重置额度 |
| 游标无效或继续所需的会话历史缺失 | 拒绝从头伪装续跑 |

这些拒绝不是新增审批。系统提供检查结果，由操作者核查后决定如何处理；没有“强制忽略检查继续写入”的开关。

## 预算继承

Run.usage 使用恢复链累计数，recovery.inheritedUsage 单独记录继承部分。工具次数在授权事务中预先记账，因此中断在授权之后也不会退回一次免费尝试。模型消耗按 Pi 已报告的 Token/费用继承。

activeMs 通过关键事件和心跳记录，运行中预留 250ms 的保守余量；正常结束时记录实际观测时长。恢复不计算停机等待时间，也不把已经记录的运行时长清零。它不是对 OS 挂起、长时间同步阻塞或极端 I/O 的硬实时计量保证。

Token/费用仍是在模型响应边界统计，不是服务端账单硬上限。中断模型调用可能计费而缺少终态，因此会拒绝自动恢复。显式重新 run 是一次新执行，不属于恢复链预算继承。

## 旧审批怎么处理

源 Run 进入中断/取消终态时，未消费的 pending/approved 请求会被关闭。恢复不会复制这些请求。新 Run 中原策略为 ask 的操作会产生绑定新 Run、参数、文件现状与策略的新请求。

默认 allow 的任务仍按默认策略运行，不会因为使用 resume 就逐步询问确认。

## 验收进程的特殊处理

杀掉 Worker 不代表验收子进程也停止。M3 在验收开始前持久化 in-flight 状态；若未得到验收结束证据就中断，会拒绝自动重跑。

验收清理还区分“输出管道已关闭”和“受管验收进程已确认结束”。清理宽限期耗尽但未确认停稳时，Verification.executionUncertain=true，保留阻止恢复的状态。

这不是 OS 沙盒，也不保证追踪任意脱离进程树的后台程序。独立检查器仍是可信本机代码，不应据此宣称任意恶意检查器可安全恢复。

## 文件与证据

- src/state/checkpoint.ts：一致边界上的检查点与 Session 冻结。
- src/state/recovery.ts：恢复资格、完整性和预算核查。
- src/state/store.ts：检查点、操作台账与唯一恢复认领事务。
- src/execution/engine.ts：执行、预算和恢复模式的统一衔接。
- examples/recovery-demo.ts：真实中断与恢复演示。
- tests/recovery*.test.ts、tests/verifier-process.test.ts：恢复、拒绝恢复、竞争和验收清理测试。
- validation/recovery/acceptance.json：阶段结果入口。

原崩溃进程可能来不及导出 report.json 或完整 JSONL。inspect 从 SQLite 读取事实；inspect --export-trace 可以重建顺序事件。恢复会保留原记录，不要求旧进程补写成功报告。

本阶段只验证本地 scripted 模型与真实 Pi 执行链。真实模型初始化、鉴权和网络恢复尚未联网验证；不承诺任意外部服务的精确一次执行或断电恢复。
