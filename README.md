# Harness Engineering

基于 Pi 的通用 Agent Harness。**已具备受控执行、检查点恢复、上下文、记忆和固定任务评测**：CLI → Pi Adapter → 工具执行 → 独立验收 → 持久化结果。

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

## 真实模型基线

已完成 deepseek-flash 的 32 次固定任务试验：基础组 5/8，仅上下文 6/8，仅记忆 7/8，组合组 8/8。全部采用独立评分，失败保留；组合组的结果不能推广为普遍 100% 成功率。累计目录估算费用约 0.0263 美元，实际账单可能不同。详见 [分层分析与边界](docs/benchmark-baseline.md) 和 [评测方法](docs/benchmark.md)。

运行 npm run benchmark:plan 查看固定计划；npm run benchmark:smoke 检查离线管线；npm run benchmark:live 使用显式环境密钥执行新的真实评测。每批结果另存，旧基线不覆盖。

## 按职责组织

源码位于 src/runtime（Pi 适配）、execution（执行与工具治理）、governance（审批）、state（存储与恢复）、verification（独立验收）、context（上下文）、memory（记忆）、benchmark（评测与经验证据）。CLI、任务配置和通用工具仍在 src 根目录。docs、examples、scripts、tests 分别保存说明、示例、验证脚本与测试。

validation 下按 runtime-compatibility、task-execution、tool-governance、recovery、context-memory 保存验收资料。以前的阶段编号仅作为历史出处，不再用作当前模块、测试、脚本或文档文件名。历史 source-manifest 中的路径和摘要描述当时的版本，可结合 validation/README.md 理解。

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

基础任务格式见 [使用说明](docs/task-format.md)，当前治理配置见 [工具治理与人工审批](docs/tool-governance.md)。

## 执行与验收

Task 固定任务、工作区、预算和验证标准。每次执行分配独立 Run、原生 Pi Session、初始文件摘要和验收副本。Pi 停稳后才进入验证，所有验收项通过后才标记 completed。

支持 read/write/edit/wait。工具白名单、路径范围、工具次数与时间预算由宿主执行。Token/费用预算在模型响应边界检查，可能发生单次请求超额。已加入工具级超时、错误分类、受控重试和人工审批。同时提供检查点、操作台账、累计预算继承和显式 resume。当前没有 OS 沙盒、任意 Shell 或无人值守自动恢复。

上下文预算、压缩、记忆 CLI、来源与修订规则见 [上下文与记忆](docs/context-memory.md)。运行 `npm run demo:context` 可体验长材料读取后的继续执行、独立验收和记忆纠错。记忆仅按工作区显式检索，模型不会自行把回答变成长期规则。

## 数据与交付

```text
.harness/
  state.sqlite             # 权威状态、事件、取消请求与验收结果
  memory.sqlite            # 记忆及修订历史
  logs/<run-id>.log         # Worker 诊断
  runs/<run-id>/
    task.json              # 任务与验证标准快照
    policy.json            # 本轮生效策略
    context.json           # 本轮固定的目标与有来源的记忆快照
    approvals/             # 绑定参数与目标状态的审核请求
    initial-workspace.json # 初始工作区文件摘要
    sessions/              # Pi 原生会话
    checkpoints/           # 文件摘要与冻结 Session 副本
    verification/          # 冻结的检查器与执行证据
    events.jsonl           # SQLite 事件的可重建导出
    report.json            # Run 与独立验收报告
```

SQLite 中的运行状态与对应事件在同一个事务中更新，JSONL 是派生导出。导出故障会有明确记录，后续工具执行被阻止；即使某个报告文件无法写入，inspect 仍可读取 SQLite。验收通过而最终报告导出失败时，任务事实仍为 completed，exportErrors 显式记录，前台 CLI 返回 2。

当前版本 0.5.0：99 项自动测试通过（原有 84 项 + 15 项评测检查）。真实基线另有 32 次模型任务和 88 项独立重查。验收入口为 [评测与经验证据](validation/benchmark/acceptance.json)，历史验收资料保留。

## 检查

```powershell
npm run check
npm test
npm run verify:runtime
npm run demo:context
```

执行、治理、恢复与上下文记忆测试通过正式 npm 包和真实子进程执行，不读取用户密钥。历史底座验证使用相邻 Pi 源码，作为历史底座验证，不能替代正式 SDK 的任务执行测试。

- [固定任务评测](docs/benchmark.md)
- [真实模型首轮基线](docs/benchmark-baseline.md)
- [上下文与记忆](docs/context-memory.md)
- [检查点与中断恢复](docs/recovery.md)
- [工具治理与人工审批](docs/tool-governance.md)
- [架构与验收](docs/architecture.md)
- [使用说明](docs/task-format.md)
- [能力表](docs/runtime-compatibility.md)
- [复用清单](docs/reuse-decisions.md)
- [边界与历史计划](docs/module-boundaries.md)

阶段总结保存在 `D:\Obsidian\main\90-Templates\Harness Engineering`。



## GitHub 仓库范围

仓库保留项目源码、文档、精确依赖锁文件、验收摘要和测试报告。原始运行数据、Pi Session、缓存、下载的参考资料快照以及包含完整轨迹的本地演示报告不提交。历史文档中指向这些本机原始证据的路径，在新克隆中可能不存在；可以运行演示和测试重新生成当前版本证据。
