# 验收资料与历史来源

当前资料按功能职责归档：runtime-compatibility（底座兼容性）、task-execution（任务闭环）、tool-governance（执行治理）、recovery（中断恢复）、context-memory（上下文记忆）。

前四组资料对应最初的 M0、M1、M2、M3。文件移动时保留历史 acceptance、test-results 和 source-manifest 内容，不重新计算历史摘要，也不把旧测试结果冒充当前结果。历史 JSON 内的 m0/、m1/、m2/、m3/ 以及 src/旧文件名都是当时路径；可在 Git 首次提交 5b493f35f05bee5dbf0d45c91cad2a54d1710afe 中查阅对应版本。部分历史证据来自首次提交前的工作区，manifest 摘要应结合当时验收记录，而非声称与首次提交逐文件完全一致。

当前文件迁移：src/pi-adapter.ts → src/runtime/pi-adapter.ts；engine/tool-governor/tool-errors/tool-policy → src/execution；approval → src/governance；store/checkpoint/recovery → src/state；verifier → src/verification。测试和文档使用同职责名称。历史 source-manifest 中的旧路径不要求在新目录下存在或匹配当前摘要。

本轮结果另存 context-memory。原始 Session、工作区、日志、记忆内容和完整运行报告仍仅保存在被忽略的本地 .artifacts 或 .harness 中。

可视化任务管理补充保存在 workspace-management：历史产出与独立验收详情、日常管理、工作区占用保护、草稿及提交凭据。完整170项离线检查及最终22项相关检查分别记录，浏览器检查使用独立4323端口，原4318服务未修改。该目录是功能交付资料，不是新增模型效果评测。

execution-experience 保存本地 evolving-harness 经验机制迁移后的功能检查、来源摘要和页面截图；不属于模型效果评测。原项目未改动，迁移范围见 docs/local-reuse.json。
