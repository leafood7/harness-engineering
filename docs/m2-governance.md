# M2 工具治理与人工审批

版本：Harness Engineering 0.2.0。Pi SDK 保持 1.4.0。

## 1. 能做什么

- 每种工具分别设置 allow / deny / ask。
- 单次工具尝试有独立超时；超时发出取消信号并等待有限的停稳宽限期。
- 根据结构化错误分类决定是否重试，使用有上限的指数退避。
- 人工审批绑定具体参数、目标文件状态、策略摘要与执行尝试。
- 通过另一个 CLI 批准或拒绝，支持审批超时、取消与失效。
- 每次实际尝试重新检查任务预算，并留下独立记录。

## 2. 配置

在原任务 JSON 增加可选 policy：

```json
{
  "policy": {
    "version": "reviewed-policy-v1",
    "approvalTimeoutMs": 30000,
    "settleGraceMs": 1000,
    "tools": {
      "read": {
        "permission": "allow",
        "timeoutMs": 10000,
        "retry": {"maxAttempts": 3, "initialDelayMs": 100, "maxDelayMs": 1000}
      },
      "write": {"permission": "ask", "timeoutMs": 10000},
      "edit": {"permission": "ask", "timeoutMs": 10000},
      "wait": {"permission": "deny"}
    }
  }
}
```

policy 是任务根对象中的一个字段，任务的其余字段仍按 M1 格式配置。tools 白名单与 policy 同时生效，deny 不会因工具在白名单中而放行。审批不能越过白名单、路径限制或任务预算。

未提供 policy 时，使用显式记录的 m2.default：已在白名单内的工具默认 allow，默认只尝试一次；read/write/edit 超时 15 秒，wait 超时 120 秒。maxDurationMs 仍可先于工具超时结束整个 Run。

write/edit 不允许配置 maxAttempts > 1。参数校验和执行层都检查该限制。read/wait 的重试次数上限为 5，maxAttempts 包含第一次尝试。

## 3. 人工审批操作

先生成需要批准写文件的演示：

```powershell
npm run harness -- demo --approval --detach
```

记录输出的 runId，然后查看：

```powershell
npm run harness -- inspect <run-id>
```

运行会进入 waiting_approval。approvals 中会显示 approvalId、requestDigest、参数预览、requestFile 和 expiresAt。查看 requestFile 可以审核完整参数、目标文件摘要与策略绑定；预览可能截断，批准前应以完整请求为准。

批准或拒绝时使用本次请求的确切摘要：

```powershell
npm run harness -- approve <approval-id> --digest <requestDigest> --actor your-name
npm run harness -- reject <approval-id> --digest <requestDigest> --actor your-name --reason "暂不接受这次修改"
```

若用了 --state，自始至终传同一目录。actor 是本机审计标签，必须填写；它不是经过网络身份认证的账号。本系统面向可信本机用户，未实现多用户鉴权或密码学签名。

生产代码不自动批准 ask。自动化测试通过独立 CLI 模拟审核人，并明确将 actor 写为 integration-test；这证明审批流程可用，不代表实际人类已经审核这些测试。

批准只授予该请求的一次执行尝试。审批消费、工具次数扣减与授权事件在一个 SQLite 事务内完成；过期或已消费的审批不能再次使用。

## 4. 变化与失效

请求摘要绑定 runId、toolCallId、工具名、尝试序号、完整参数、工作区、策略摘要和目标文件现状。

- 参数或目标文件状态变化：旧请求 invalidated，重新生成审批请求。
- 策略变化：停止当前 Run 并使请求失效；以新策略重新启动任务。
- 修改原任务 JSON 不会热更新正在运行的配置；每次 Run 使用启动时的策略快照。
- 请求文件被篡改：原摘要不能批准修改后的内容。
- 审批超时：expired，工具未开始；晚到的决定被拒绝。
- 等待期间取消：请求 cancelled，不执行工具。
- Worker 已消失：CLI 拒绝批准并标记 interrupted。

审批是应用层约束，不消除外部进程在检查与实际写入之间修改文件的竞态；没有 OS 隔离时不能声称原子条件写入。

## 5. 超时与结果不确定

工具计时从实际尝试开始，不把等待审批时间计入该工具 timeoutMs；审批和退避仍计入整个 Run 的 maxDurationMs。

达到 timeoutMs 后，包装层发出 AbortSignal，再等待 settleGraceMs：

- 操作已经停稳：按 timeout 分类。无副作用的可重试工具才可能进入下一次尝试。
- 宽限期后仍未停稳：分类 outcome_unknown，停止后续工作，不自动重放。
- 写入发生了超时或错误：按副作用可能已经发生保守记录，不自动重试。

Node 进程内的 Promise 不能强制终止任意不合作代码。包装层不会把 Promise.race 返回误当成底层工作已停止，也不提供对同步阻塞、内核 I/O 或外部服务的硬实时终止保证。当前只接入受控的四种工具，未知结果会留在事件和 Run.error.toolFailure 中。

## 6. 错误分类与重试

| 分类 | 例子 | 自动重试 |
|---|---|---|
| transient | EBUSY、EAGAIN、EMFILE、ENFILE、ETIMEDOUT、ECONNRESET、ENETUNREACH | 仅安全工具、预算允许且未到次数上限 |
| timeout | 截止时间已到，且操作已经停稳 | 仅无副作用工具 |
| not_found | ENOENT、ENOTDIR | 否 |
| permission | EACCES、EPERM | 否 |
| invalid_input | EINVAL、EISDIR | 否 |
| cancelled | 主动取消或任务停止 | 否 |
| unknown | 无可靠错误码 | 否 |
| outcome_unknown | 取消宽限期后仍不能确认结果 | 否 |

不会根据错误文本里“请重试”这类语句决定重放。退避为 min(maxDelayMs, initialDelayMs × 2^(失败次数-1))。每次重试重新授权、检查路径和预算；若该工具为 ask，则每次尝试都需要新的审批。

write/edit 的重复执行、外部系统幂等键和外部状态核查没有被伪装成已解决：本阶段选择禁止它们自动重试。人工发起新 Run 也应先核查已有结果。

## 7. 记录、迁移与复现

- policy.json：本轮完整生效策略、工具元数据及摘要。
- approvals/<id>.json：完整待审核请求。
- SQLite approvals 表：pending、approved、rejected、expired、cancelled、invalidated、consumed 状态及审计信息。
- tool.attempt_start / tool.attempt_end：每次实际尝试、耗时和失败分类。
- tool.retry_scheduled：退避时间、失败类别和下一次尝试。
- tool.authorized：实际授权和对应审批 ID。
- Run.error.toolFailure：最终工具分类、是否具备安全重试条件、结果确定性。

usage.toolCalls 在 M2 表示实际获准尝试次数，包含重试，不等于模型发出的逻辑工具调用次数。Run.error.retryable=false 表示本轮已经终结，不授权无限继续；toolFailure.retryable 仅描述错误类型是否具备安全重试条件。

SQLite 从 v1 增量增加到 v2，保留原有运行、事件和验收数据。策略和原始请求是本机运行资料；完整审批请求需要用于人工审核，不能承诺全部脱敏或直接公开。

运行检查：

```powershell
npm run check
npm test
```

验收证据见 m2/acceptance.json、m2/test-results.xml，以及补充的审计检查报告。M1 历史验收保留在 m1/ 中。

## 8. 下一步

M3 补充任务检查点、进程中断恢复与不确定步骤核查。审批等待已可持久化，但 M2 不会在进程崩溃后自动恢复执行；这与“数据库里仍能看到审批”是两回事。
