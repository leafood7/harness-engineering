# Harness Engineering

基于 Pi 的通用 Agent Harness。**已具备受控执行、检查点恢复、上下文、记忆和固定任务评测**：CLI → Pi Adapter → 工具执行 → 独立验收 → 持久化结果。

项目固定在 `D:\VScodeProgects\harness-engineering`。原有 Pi 仓库在 `D:\VScodeProgects\pi`，当前通过独立安装的正式 Pi SDK 1.4.0 运行。

## 可视化任务操作台

```powershell
npm run dashboard
```

打开命令显示的本机地址（默认 `http://127.0.0.1:4318`），即可查看任务列表、实际进度、中文执行动态、日志和独立验收结果，并提交、取消任务或控制调度。点击“执行记录”统一查看直接执行和恢复子记录；中断/取消记录可先检查恢复条件，再点击“继续执行”，并查看关联记录和保存的文件变化。点击“创建任务”即可填写目标、目录、模型、工具、预算和验收条件，检查后入队，也可保存和载入模板。首次进入可点击“加入离线示例”再启动调度。

现在还支持历史文本与 JSON 预览、前后对比和下载、验收期望/实际内容、复制任务及来源关联；可批量取消、归档、恢复归档和导出摘要，调整等待顺序、编辑未启动任务、管理模板版本与默认预算。草稿自动保存，重复提交有持久凭据保护，同一状态目录的队列、直接执行和恢复共用工作区占用检查。配置与服务页面显示版本、数据目录、环境变量是否设置及安全清理入口。

默认查看项目 `.harness`。查看其他队列目录使用 `npm run dashboard -- --state <目录>`。完整说明见 [本地任务操作台](docs/task-dashboard.md)。

## 执行经验与改进建议

已复用本地 evolving-harness 的证据整理和建议审阅模块。选中结束的执行，点击“执行经验与建议”，即可补充反馈、整理线索、编辑/审阅/驳回建议、查看历史并导出证据包；支持人工或外部模型建议导入。不会自动调用模型、写入长期记忆或启用策略。详见 [执行经验](docs/execution-experience.md)。

## 任务队列与后台调度

支持一次提交多个任务、持久排队、限制并发、后台运行、查看任务及取消。相同或上下级工作区的队列任务依次执行，调度器重启后继续处理排队任务；异常任务保留中断记录，不自动重跑。

```powershell
npm run demo:queue
node bin/harness.mjs queue submit task-a.json task-b.json
node bin/harness.mjs queue start --concurrency 2
node bin/harness.mjs queue list
node bin/harness.mjs queue stop
```

演示创建独立目录，使用离线模型。`stop` 停止派发，已经运行的任务继续；取消任务使用 `queue cancel <job-id>`。完整说明见 [任务队列](docs/task-queue.md)。

## 策略版本管理

已支持查看策略、切换新任务默认版本、变更历史以及一键回滚。运行中和恢复中的任务保留原版本，显式任务配置优先。切换需要填写理由，不增加审批流程；候选策略不会自动启用。本轮交付功能，没有新增模型测评。

```powershell
node bin/harness.mjs strategy current
node bin/harness.mjs strategy switch read-correction.v1 --reason "启用有限读取纠错"
node bin/harness.mjs strategy rollback --reason "恢复上一版本"
```

完整使用方式与边界见 [策略管理](docs/strategy-management.md)。

## 快速体验

要求 Node >=24.22.1。在本项目目录：

```powershell
npm ci --ignore-scripts --cache .cache/npm
npm run demo
```

中断恢复演示可执行 `npm run demo:recovery`，会在本轮自建任务中模拟 Worker 中断并自动完成恢复核查。

已有 node_modules 时直接执行 `npm run demo`。演示使用本地脚本化模型，不需要密钥，不产生付费请求。每次生成一个全新的示例工作区，修复加法函数并运行独立验收；不会覆盖以前的演示。

命令输出 Run ID、终态、工具次数、用量与报告路径。正常演示应为 `completed`。模拟模型的 Token 是估算值，零费用仅表示本地模拟没有模型费用。

## 本地文件读取纠错与摘录复测

已实现可选文件契约和最多两次的无副作用读取输入纠错，失败记录、范围、权限和预算控制保留。104次预注册对照分别为12/26、14/26、16/26、22/26；目录练习题面存在格式歧义，旧分数保留并说明。另做12次明确JSON格式确认：默认/契约组0/3，纠错/组合组3/3，不与原成绩混算。

组合候选估算费用增加26.1%，未通过原定25%成本门槛，默认策略仍不变。详见 [方法与安全边界](docs/read-correction.md)、[完整结果与题面问题](docs/read-correction-results.md)。本轮没有Git提交、暂存或推送。

## 本地候选策略对照

已扩展到8道固定题，完成三个策略各24次、共72次真实任务。默认18/24，小范围读取候选19/24，原文摘录候选21/24；原生压缩保留题为0/3、0/3、3/3。默认仍为stable.v1，候选没有自动启用。本轮只保存在本地，未经明确要求不进行Git提交、推送或发布。详见 [结果与局限](docs/strategy-results.md) 和 [候选/分阶段方法](docs/strategy-experiments.md)。

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

当前版本0.7.0：131项自动测试通过（原有112项+19项读取纠错检查）。本轮104次对照与12次独立确认另有324项固定检查复核。验收入口为[读取纠错验收](validation/read-correction/acceptance.json)，历史基线保留。

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
