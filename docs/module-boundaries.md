# 职责边界与 M1 实施入口

## 职责

| Pi 原生负责 | Harness 新增负责 |
|---|---|
| 模型请求、Agent Loop、工具调用 | Task 定义、Run 生命周期和预算 |
| SessionManager 与原生 JSONL 对话树 | Run 与 Session 映射、恢复关系与策略快照 |
| 工具与扩展注册、上下文压缩机制 | 工具风险元数据、授权决策、审批记录 |
| Session/Extension 事件 | 统一事件、脱敏、指标和执行报告 |
| 工具取消信号及本机进程清理机制 | 取消请求/停稳/副作用状态的分别记录 |
| 原生上下文与资源发现接口 | 明确选择资源、记忆来源管理与上下文策略 |
| 不负责业务验收 | 独立 Verification、Benchmark 和策略实验 |

工具元数据表不另造工具执行 Runtime；原生工具仍交给 Pi 注册和调用。Pi Session 是对话的权威来源，不再复制为第二套 Session Store。

## 接入方式

M0 使用相邻仓库的源码入口和 source-resolver，以确保读到被核实的版本。M1 正式适配器只依赖 coding-agent 公开导出：createAgentSession、SessionManager、SettingsManager、ModelRuntime、DefaultResourceLoader 及 Extension 类型。底层 ai/agent 类型仅在需要时显式引入。不得将 M0 的内部路径散落到生产模块。

正式打包时核对 registry 1.4.0 与当前源码基线的一致性；若需本地打包，固定提交并显式记录构建来源。未完成该核对前，不声称 npm 包已验证。

资源发现由宿主显式控制，避免无意加载用户全局扩展。SDK 不等于 CLI：MCP/codemode 等 CLI 默认能力不能假设 SDK 自动启用。

## 四个核心对象

初步定义见 `contracts/index.ts`，已准备独立类型检查。

- **Task**：要做什么；固定初始工作区、预算、允许工具和验收标准。
- **Run**：一次实际尝试；记录 Pi 提交、模型参数、策略版本、消耗和终态。一个 Task 可有多个 Run。
- **Event**：发生了什么；包含 runId、连续序号、来源、关联 ID 和产物引用。Pi 事件转换后写入；扩展权限决策单独记录。
- **Verification**：结果是否合格；固定验证器版本和产物摘要，保存检查项与证据。执行错误、未运行和验证失败应分别表达。

未知 token 或价格记为 null，不能记成零。审批绑定参数摘要与策略版本；参数变化后原审批不再有效。

## 状态规则

主链：created → initializing → running → verifying → completed / failed。

- 等待批准进入 waiting_approval；允许继续后回到 running，拒绝则结束并记录原因。
- 取消进入 cancelling；Pi 停稳后记录 settledAt，副作用必须标记 none_confirmed / present / unknown。取消并不保证撤销已经发生的操作。
- 进程意外退出、无法确认执行状态时记 interrupted，不伪装成正常失败或成功。
- 恢复创建新 Run，用 resumedFromRunId 关联旧 Run，并显式选择原 Pi Session。
- agent_end 只记录事件；agent_settled 触发终态判断。非取消、非错误的执行再进入 verifying。
- completed 要求独立验证通过且没有未解决的约束违反。没有检查项或验证未运行不算通过。

## M1 工作范围

1. 将 Pi 集中封装为 adapter，处理初始化、订阅、prompt、abort、dispose。
2. 实现 Run 状态机和 SQLite 最小表结构，定义与 JSONL 事件的序号、写入失败和对账规则。
3. 增加 CLI run/inspect/cancel；取消请求需能送达实际运行进程。
4. 加入工具白名单、最小预算与权限检查；工具元数据记录取消支持、副作用和重试能力。
5. 增加文件修改示例与独立验证脚本，保存验收产物与报告。
6. 运行正常完成、工具失败、验证失败、禁止操作、超预算、取消六类验收。

后续 M3 才承诺进程崩溃恢复与事务一致性，M4 验证长上下文和记忆。真实模型调用须使用显式配置；先在已有模拟链上验收，不扫描或读取用户密钥。

## M0 出口

底座已确定，9 项本地检查通过，参考项目复用门槛已记录，核心对象和 M1 范围已形成。可以进入 M1。外部模型网络集成、其他平台和第三方插件兼容性继续作为明确的后续验证项。
