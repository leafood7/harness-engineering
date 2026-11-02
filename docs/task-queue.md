# 任务队列与后台调度

这是本地功能交付，不包含新增模型测评。应用版本 0.9.0，无新增依赖。

## 直接体验

在项目目录执行 `npm run demo:queue`。演示建立全新目录，提交三个修复任务，以两个并发槽执行，输出任务 ID、Run ID 和终态。使用离线脚本化模型，没有付费调用。每个任务仍经过原有 Pi Session、工具控制和独立验收。

## 日常用法

```powershell
# 一次提交多个已有任务文件；整批校验成功后才登记
node bin/harness.mjs queue submit task-a.json task-b.json --state .harness

# 启动后台调度器；关闭当前命令窗口后继续工作
node bin/harness.mjs queue start --concurrency 2 --state .harness

node bin/harness.mjs queue status --state .harness
node bin/harness.mjs queue list --state .harness
node bin/harness.mjs queue inspect <job-id> --state .harness
node bin/harness.mjs queue cancel <job-id> --state .harness

# 只停止派发，已经运行的任务继续
node bin/harness.mjs queue stop --state .harness

# 重新启动，继续排队；重启时可以换并发上限
node bin/harness.mjs queue start --concurrency 3 --state .harness

# 前台处理，队列全部进入终态后退出；适合脚本或一次性批处理
node bin/harness.mjs queue work --drain --concurrency 2 --state .harness
```

省略 `--state` 使用项目 `.harness`。并发范围 1–16，默认 1。`work` 不带 `--drain` 会持续等待新增任务。前台 Ctrl+C 只停止派发，不终止已经分离运行的任务。`start` 会等待调度器就绪后返回；同一状态目录只允许一个存活调度器。

## 状态与结果

`queued` 等待；`starting` 已占派发槽、等待工作进程确认；`running` 已由工作进程接管；终态为 `completed/failed/cancelled/interrupted`。

队列 ID 用于排队管理。Run ID 用于原有执行事件、取消、审批（仅任务主动要求时）、报告和检查点恢复。`queue inspect` 同时显示两者及 Run 的用量、验收和检查点。需要细查事件时运行 `inspect <run-id> --events`。`completed` 仍然要求原有独立验收成功，模型自称完成不算完成。

任务输出和报告沿用 `state/runs/<run-id>`；调度器日志在 `state/logs/scheduler.log`，工作进程日志在 `state/logs/queue-<job-id>.log`。报告导出错误仍保留在 Run 中，不会伪装成成功导出。

## 取消与停止

取消排队任务后不会创建 Run。取消已经派发的任务会保留请求；工作进程启动后立即处理。运行中取消通过原有协作取消机制停止工具和模型请求，状态不会提前冒充“已经停止”。取消可能无法撤销已发生的写入，仍按原执行记录判断。

停止调度器不清空队列，也不取消正在运行的任务。后台任务会自行记录结果；再次启动调度器后会接管仍存活的工作进程，并计入并发槽。降低并发时，已有任务不会被强杀，而是等待空位。

## 输入、顺序与工作区保护

提交时把任务配置和 Node 验收脚本复制到 `state/queue-inputs`，记录完整摘要；执行前核对，改动会拒绝执行。原始任务文件和原验收脚本之后改变，不影响已提交副本。不会把环境中的模型密钥写进队列；真实模型任务执行时仍需相应环境变量。

工作区使用提交时的真实绝对路径。不会复制整个工作区，排队期间工作区仍可能变化，执行时由原任务快照和验收处理。没有明确指定策略的任务在开始执行时选择当前版本，记忆也在开始执行时冻结；要固定策略，应在任务里写 `strategy`。

按等待顺序选择第一个可以执行的任务；操作台可调整未启动任务顺序。真实路径相同或上下级包含的工作区不会并发；被占用的工作区不会阻塞其他独立工作区。同一状态目录的队列、直接 `run` 和 `resume` 共用工作区占用保护；队列并发槽仍只计算队列任务。该保护不能阻止外部手工编辑或其他状态目录写入同一工作区。未知工具结果或无法确认停止的验收会保留保护，不自动重试。

## 异常退出与恢复边界

派发占位与并发判断在数据库事务中完成。工作进程必须先原子接管队列项，重复启动不会重复执行。配置副本校验失败时不启动任务。

调度器异常退出后，重新运行 `start`：已接管且存活的任务继续；未确认的派发项标记 `interrupted`，不会自动重新执行；已死工作进程的任务也标记中断。这样优先避免重复写入，而不是承诺任何故障下都自动完成。

需要继续中断的任务时，先 `queue inspect <job-id>` 获取 Run ID，再使用现有 `resume <run-id> --dry-run` 检查可恢复性，必要时明确恢复。恢复会产生子 Run；原队列项保留原中断事实，不自动改成子任务的成绩。没有 Run 的派发中断不能使用检查点恢复，应先确认没有副作用，再明确重新提交。

队列是本地持久队列，不是 Windows 系统服务；电脑重启后需手动再次启动调度器。PID 用于本机存活检查，不提供跨机器调度或进程身份安全保证。没有增加定时触发、依赖图、自动重试或跨应用版本恢复。

## 功能检查

覆盖批量校验、输入与验收脚本冻结、全局并发、工作区互斥、取消、真实离线任务执行、后台停止重启、工作进程异常退出，以及调度器异常退出后接管存活任务。最终统一回归保留全部原有检查。没有新增 benchmark、真实模型效果对比或付费请求。
