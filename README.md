# Harness Engineering

基于 Pi 的通用 Agent Harness。**M3 已实现检查点与受控恢复**：CLI → Pi Adapter → 工具执行 → 独立验收 → 持久化结果。

项目固定在 `D:\VScodeProgects\harness-engineering`。原有 Pi 仓库在 `D:\VScodeProgects\pi`，当前通过独立安装的正式 Pi SDK 1.4.0 运行。

## 快速体验

要求 Node >=24.22.1。在本项目目录：

```powershell
npm ci --ignore-scripts --cache .cache/npm
npm run demo
```

中断恢复演示可执行 `npm run demo:recovery`，会在本轮自建任务中模拟 Worker 中断并自动完成恢复核查。

已有 node_modules 时直接执行 `npm run demo`。演示使用本地脚本化模型，不需要密钥，不产生付费请求。每次生成一个全新的示例工作区，修复加法函数并运行独立验收；不会覆盖以前的演示。

命令输出 Run ID、终态、工具次数、用量与报告路径。正常演示应为 `completed`。模拟模型的 Token 是估算值，零费用仅表示本地模拟没有模型费用。

## CLI

```powershell
npm run harness -- run .\path\task.json
npm run harness -- run .\path\task.json --detach
npm run harness -- inspect <run-id>
npm run harness -- inspect <run-id> --events
npm run harness -- cancel <run-id>
npm run harness -- resume <old-run-id> --dry-run
npm run harness -- resume <old-run-id>
npm run harness -- demo --approval --detach
npm run harness -- approve <approval-id> --digest <requestDigest> --actor your-name
npm run harness -- reject <approval-id> --digest <requestDigest> --actor your-name
```

默认状态目录是本项目的 `.harness`。所有命令支持 `--state <directory>`；使用自定义目录时，run、inspect、cancel 必须传同一个目录。状态目录必须位于任务工作区之外。

`run` 前台等待完成；`--detach` 启动隐藏 Worker 后返回；`cancel` 将请求写进 SQLite，由实际 Worker 接收，并同步取消 Pi 或验收进程。不要用关闭终端代替正常取消。

CLI 输出 JSON Lines，便于脚本读取。退出码：0 成功或取消请求已送达，2 任务失败/命令错误/导出错误，3 运行已取消，4 Worker 中断。`cancel` 返回 accepted 只表示请求被接受；用 inspect 确认最终状态。终态任务再次取消时 accepted=false。

基础任务格式见 [M1 使用说明](docs/m1-usage.md)，当前治理配置见 [M2 工具治理与人工审批](docs/m2-governance.md)。

## 执行与验收

Task 固定任务、工作区、预算和验证标准。每次执行分配独立 Run、原生 Pi Session、初始文件摘要和验收副本。Pi 停稳后才进入验证，所有验收项通过后才标记 completed。

M1 支持 read/write/edit/wait。工具白名单、路径范围、工具次数与时间预算由宿主执行。Token/费用预算在模型响应边界检查，可能发生单次请求超额。M2 已加入工具级超时、错误分类、受控重试和人工审批。M3 增加检查点、操作台账、累计预算继承和显式 resume。当前没有 OS 沙盒、任意 Shell 或无人值守自动恢复。

## 数据与交付

```text
.harness/
  state.sqlite             # 权威状态、事件、取消请求与验收结果
  logs/<run-id>.log         # Worker 诊断
  runs/<run-id>/
    task.json              # 任务与验证标准快照
    policy.json            # 本轮生效策略
    approvals/             # 绑定参数与目标状态的审核请求
    initial-workspace.json # 初始工作区文件摘要
    sessions/              # Pi 原生会话
    checkpoints/           # 文件摘要与冻结 Session 副本
    verification/          # 冻结的检查器与执行证据
    events.jsonl           # SQLite 事件的可重建导出
    report.json            # Run 与独立验收报告
```

SQLite 中的运行状态与对应事件在同一个事务中更新，JSONL 是派生导出。导出故障会有明确记录，后续工具执行被阻止；即使某个报告文件无法写入，inspect 仍可读取 SQLite。验收通过而最终报告导出失败时，任务事实仍为 completed，exportErrors 显式记录，前台 CLI 返回 2。

## 检查

```powershell
npm run check
npm test
npm run verify:m0
```

M1/M2/M3 测试通过正式 npm 包和真实子进程执行，不读取用户密钥。M0 使用相邻 Pi 源码，作为历史底座验证，不能替代正式 SDK 的 M1 测试。

- [M3 检查点与中断恢复](docs/m3-recovery.md)
- [M2 工具治理与人工审批](docs/m2-governance.md)
- [M1 架构与验收](docs/m1-architecture.md)
- [M1 使用说明](docs/m1-usage.md)
- [M0 能力表](docs/m0-capabilities.md)
- [M0 复用清单](docs/m0-reuse.md)
- [M0 边界与历史计划](docs/m0-boundaries.md)

阶段总结保存在 `D:\Obsidian\main\90-Templates\Harness Engineering`。



## GitHub 仓库范围

仓库保留项目源码、文档、精确依赖锁文件、验收摘要和测试报告。原始运行数据、Pi Session、缓存、下载的参考资料快照以及包含完整轨迹的本地演示报告不提交。历史文档中指向这些本机原始证据的路径，在新克隆中可能不存在；可以运行演示和测试重新生成当前版本证据。
