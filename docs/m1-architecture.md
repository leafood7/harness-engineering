# M1 架构与阶段验收

日期：2026-11-01。版本：Harness Engineering 0.1.0。

## 闭环

```text
CLI run
  → 任务 JSON 校验
  → 隐藏 Worker + 独立 Run ID
  → SQLite created/initializing + 初始文件摘要 + 冻结验收
  → Pi Adapter 创建原生 Session
  → running：权限、路径、预算检查 → Pi 原生工具执行
  → agent_settled
  → verifying：宿主检查文件 / 独立 Node 子进程验收
  → completed / failed / cancelled / interrupted
  → SQLite、JSONL、报告与原生 Session
```

“Agent 结束”和“验收通过”分别处理。模型的最终文本不决定 Run 成功。

## 模块职责

| 模块 | 职责 |
|---|---|
| src/cli.ts、bin/harness.mjs | run/inspect/cancel/demo、后台 Worker 管理、退出码 |
| src/pi-adapter.ts | 通过正式公开 SDK 初始化、订阅、Prompt、取消、释放资源 |
| src/engine.ts | 统一生命周期、控制信号、预算、权限、终态判定 |
| src/store.ts | SQLite 事务状态、事件、取消请求、验证记录及导出 |
| src/task.ts | 严格任务结构校验、路径解析、初始摘要、冻结检查器 |
| src/verifier.ts | 不依赖模型自评的检查，子进程超时和取消清理 |
| src/tool-policy.ts | 工具副作用、取消支持与可重试元数据 |
| src/util.ts | 范围检查、摘要、脱敏、错误类型 |
| contracts/index.ts | Task/Run/Event/Verification 正式初版契约 |

Pi 仍负责模型调用、Agent Loop、工具注册、会话和原生执行事件；本项目没有再造 Agent Loop 或第二套会话树。

## 正式 SDK 与 M0 的区别

M0 读取相邻 Pi 源码。M1 独立安装 npm 发布的 `@earendil-works/pi-coding-agent` 1.4.0 与 `@earendil-works/pi-ai` 1.4.0，直接依赖固定精确版本，并通过 package-lock.json 保存解析结果及完整性摘要。

不把同名版本等同于源码逐字节一致：Run 记录实际 npm 包版本与 integrity，不把 M0 本地提交冒充为 M1 构建来源。运行时检查 SDK VERSION，集成测试直接经过实际安装包。

类型检查纠正了两个 M0 JavaScript 示例未发现的问题：cacheWarming 正式类型是字符串 off，ExtensionMode 采用 json 等公开值，不能使用 headless。生产代码不引用 Pi 内部源码路径。

## 状态和事务

- 状态变化与对应事件在同一 SQLite 事务提交；事件序号随 Run 单调递增。
- 创建 Run 与第一条事件原子提交。
- 使用 WAL、busy_timeout 与 FULL synchronous 支持 Worker 和另一个 CLI 同时访问。
- 取消请求单独持久化，不由 cancel 命令伪造最终状态；Worker 收到后执行实际取消。
- completed 提交前在同一事务再次检查取消请求，避免“刚接收取消却标为完成”的竞态。
- 运行时 JSONL 为事件快照导出；工具获准执行前强制导出一次，导出失败会阻止效果继续发生。
- Worker 异常退出由监督 CLI 或后续 inspect 标记 interrupted。M3 再实现检查点与恢复协议。

派生报告最终写入失败时，SQLite 中的任务与验收事实仍保留；exportErrors 明确标识异常。前台命令以非零退出码提示导出故障，不伪装成报告已可用。

## 权限与控制

最小支持面为 read/write/edit/wait，未允许任意 Shell。文件工具检查绝对路径、..、链接解析与 Windows ADS 等路径形式，拒绝越界。状态目录不允许位于工作区内，检查器副本位于 Run 目录。

这些约束覆盖宿主管理的工具入口，属于应用层治理。当前没有 OS 沙盒，不承诺抵御扩展自身任意 Node API 或外部并发修改。默认不加载用户/项目扩展、Skills 和上下文文件。

持续时间与工具预算可以阻止后续工作；Token 和费用只能按 SDK 已提供的数据在响应边界统计，可能发生单次请求超额。取消是协作式机制；已写入文件不回滚。

## 验收与证据

集成测试通过 CLI 启动真实 Worker、正式 Pi SDK、真实文件工具和独立 Node 子进程，模型回复使用本地 scripted provider。

覆盖成功、模型虚假完成、工具失败、禁止工具、路径越界、工具预算、Token 预算、时间预算、跨进程取消、验收阶段取消、验收超时、原始检查器篡改、JSONL 故障、缺少密钥、空验收输入、Worker 异常退出、状态竞态、路径链接、脱敏以及报告导出故障。

最终结果见 `.artifacts/m1/tests.xml` 和 `m1/acceptance.json`。示例 Run 与报告路径由该验收记录固定，避免只留下口头结论。

本阶段未调用真实模型服务，不以 scripted 测试推导真实任务成功率或进化收益。

## 下一阶段 M2

在此闭环上增加工具级超时、错误与重试分类、审批机制和更完整的策略配置。重点处理副作用操作的幂等与不确定结果，不直接将所有错误自动重试。M1 的状态、事件和验收可以作为这些能力的共同基础。
