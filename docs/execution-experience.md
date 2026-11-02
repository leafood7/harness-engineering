# 执行经验与改进建议

把本地 evolving-harness 的证据整理与建议审阅机制移植到当前 TypeScript Harness。源项目不被修改，不需要启动 Python 服务或安装新依赖。

## 复用的代码与适配

| 原模块 | 接入内容 | 当前实现 |
|---|---|---|
| reflection.py / GUIDANCE | 外部整理指引，区分用户报告、执行观察、待验证假设 | src/experience/guidance.ts；字段 evidence_ids 改为 evidenceIds，引用改为带类型的字符串 |
| Reflection.prepare/save | 有界证据包、严格字段和证据引用校验、全部校验后写入、摘要去重 | src/experience/store.ts |
| Reflection.edit/decide | 版本冲突检查、不可覆盖的修改历史、审阅与采纳分离 | ExperienceStore.change/history |
| ImprovementBatch.plan/save | 整理批次、没有线索时 no_change、保留建议与证据关联 | ExperienceStore.collect；不照搬原版自动评价/激活步骤 |

原文件路径和 SHA-256 见 local-reuse.json。复用依据为用户明确授权使用本地项目，没有为该项目虚构开源许可证。当前是 TypeScript 适配迁移，并非把整套 Python Runtime 再跑一遍。

原 Reflection 中审阅项目记忆后直接写入记忆的行为未迁入：当前所有建议审阅后仍保留其来源类型，不自动变成可信事实。原改进批次里的评测和启用也没有自动触发。

## 页面使用

1. 在执行记录里选择一个已经结束的任务，点击“执行经验与建议”。等待项和正在运行的任务不开放整理。
2. 查看本次执行保存的工具、验收和状态证据；补充你的反馈。反馈始终标记为用户报告。
3. 点击“整理本次执行线索”。本地规则会摘出最近用户反馈，并为未完成执行保留一条待补充的改进线索；不调用模型，不自动推断失败原因。没有线索就记录“没有改动线索”。
4. 编辑建议内容，标记已审阅或驳回。后台核对版本，两个页面不能悄悄覆盖彼此。历史中保留每个版本。
5. 如需更具体的分析，可导出证据包供人工或外部模型整理，再导入建议；本功能不会自行发送给模型。导出包含本地目标、反馈和证据摘录，分享范围由你决定。

“已审阅”不代表已验证有效、策略已启用或记忆已写入。批次保存创建时的事实，当前建议状态以建议列表为准。

## 外部建议格式

支持数组，或仅有 candidates 字段的对象。每次最多5项：

```json
[{"title":"核对验收差异","content":"先对照保存的期望与实际内容，再提出有限修改；效果尚待验证。","kind":"workflow","basis":"hypothesis","evidenceIds":["event:52"]}]
```

event:52 只是示例，必须换成当前证据包中真实存在的编号。kind 为 project_memory 或 workflow；basis 为 user_report、observation 或 hypothesis。用户报告必须引用 feedback:ID；执行观察必须引用工具或验收事件；workflow 必须为 hypothesis。不能通过导入增加工具、执行代码、改权限或启用策略。

## CLI

```powershell
node bin/harness.mjs experience inspect <run-id> --state <目录>
node bin/harness.mjs experience feedback <run-id> "这里写用户反馈" --state <目录>
node bin/harness.mjs experience collect <run-id> --state <目录>
node bin/harness.mjs experience import <run-id> <suggestions.json> --state <目录>
node bin/harness.mjs experience edit <candidate-id> <revision> <proposal.json> --state <目录>
node bin/harness.mjs experience review <candidate-id> <revision> --state <目录>
node bin/harness.mjs experience reject <candidate-id> <revision> --state <目录>
node bin/harness.mjs experience history <candidate-id> --state <目录>
```

编辑文件是完整单项建议，包含 title/content/kind/basis/evidenceIds；导入文件是数组或 candidates 对象。所有操作只使用明确选择的同一状态目录。

## 保存与边界

数据保存在该状态目录的 experience.sqlite，不重写 Run 事件或历史 benchmark 数据。证据包保留最近30条相关执行事件和10条反馈，事件摘录每条最多4000字符、目标3000字符；反馈4000字符、建议正文2000字符。每条证据带来源摘要，证据包带整体摘要和执行快照摘要；保存或处理建议时重新检查原记录，缺失、修改或跨任务引用会拒绝。原事件仍保存在 RunStore。

同一证据包、生成方法和建议内容重复整理不创建重复建议；证据包变化后可以形成新建议。修改历史和操作审计保留在同一数据库。草稿清理不会删除这些经验数据。

这次完成的是日常执行经验入口和建议处理闭环。自动模型诊断、聚合跨任务问题、可执行策略候选生成、效果评测和自动采纳尚未加入，不能把当前线索称为已经有效的优化。
