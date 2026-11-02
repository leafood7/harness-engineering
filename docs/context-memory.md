# 上下文与记忆

上下文负责本次模型请求携带哪些资料，记忆负责把明确写入的资料用于以后任务。模型说“记住了”不会自动写入记忆库。

## 任务配置

在普通 task.json 中按需增加：

```json
{
  "context": {
    "maxInputTokens": 20000,
    "outputReserveTokens": 4096,
    "toolResultMaxChars": 2048,
    "compactAtTokens": 16000,
    "keepRecentTokens": 2048
  },
  "memory": { "query": "构建 测试", "limit": 8, "maxBytes": 8192 }
}
```

`maxInputTokens` 是宿主使用 UTF-8 序列化字节数得到的偏保守 Token 估算上限，不是模型供应商的精确分词。最终限制还受模型窗口减去输出预留的上限约束。监控事件同时保留 Pi 提供的上下文用量；总 Token 和费用继续使用响应中的供应商用量。请求投影超限会在公开 streamFunction 边界阻止发出，任务明确失败。默认最多估算 64000 输入 Token，输出预留最多 4096 Token；这可能比模型实际容量保守。

过长的成功工具文本在**请求投影**中保留头尾、原文长度和 SHA256，并提示按文件范围重新读取。错误结果、原始 Session 与事件不会被截短。这个机制保证追溯，不保证省略部分对当前问题无关；需要中部内容的任务应分段读取，或提高 toolResultMaxChars。当前不会剪掉原始任务、工具调用与对应结果的关联。

Pi 的原生自动压缩负责写入 CompactionEntry 和保留最近历史。宿主通过 session_before_compact 提供“原始目标 + 冻结记忆 + 消息证据索引”，不额外调用总结模型，因此不会发生隐藏的总结费用。证据索引不是完整语义摘要；完整会话仍在原生 Session。自动压缩触发由 Pi 在安全边界决定，并非每个工具调用后都压缩。长工具循环的容量控制由请求投影和超限停止承担。session_compact 和 context.compacted 记录压缩来源；后续提示和 fork 可沿用压缩后的历史。

原始目标和记忆以带明确来源的参考资料注入。记忆不能改变工具权限、预算、工作区或独立验收标准。上下文中潜在的指令文本仍应视为不可信资料；真正权限由宿主检查，不能靠提示词授予。

## 写入、检索与纠错

先保存 memory-input.json，例如：

```json
{
  "workspace": "D:\\VScodeProgects\\my-project",
  "content": "此项目使用 npm run check 检查类型",
  "source": { "kind": "manual", "reference": "项目负责人确认的构建约定", "actor": "owner" },
  "expiresAt": "2027-01-01T00:00:00Z"
}
```

workspace 必须是现有目录；expiresAt 可省略。来源也可以是当前状态库内、同一工作区的事件：`{"kind":"event","runId":"真实UUID","sequence":23,"actor":"owner"}`。来源存在不等于内容在语义上已经证实，写入者需要对事实负责。

```powershell
npm run harness -- memory put .\memory-input.json
npm run harness -- memory search D:\VScodeProgects\my-project "构建 检查"
npm run harness -- memory history <memory-id>
npm run harness -- memory revise <memory-id> .\corrected-memory.json --revision 1
npm run harness -- memory retire <memory-id> --revision 2 --actor owner
```

所有命令支持 --state，必须和 run 使用同一个状态目录。纠错和停用要求当前修订号；并发修改后旧修订会被拒绝，不会悄悄覆盖他人修改。history 保留每版内容、来源、时间、状态和内容摘要。停用和过期记录不参与后续检索。数据库自带版本和摘要检查，用于发现格式不兼容或意外内容损坏；它不是对恶意修改数据库的密码学防护。

当前检索是同一真实工作区路径内、按空格分词的子串匹配，按命中数和更新时间排序；不是向量语义搜索。任务必须显式提供 memory.query 才会检索，空查询取范围内最近资料。单条最多 16 KB，默认最多 8 条、合计 8 KB（按完整记录序列化计）。没有全局资料混入或自动网络检索。

## 运行与恢复

运行开始时写入 context.json，记录实际选中的记忆 ID、修订、内容和来源。Run 绑定摘要，每个后续检查点绑定文件摘要。恢复沿用原快照，实时记忆库后来的修改或失效不会回写已经启动的运行；有新约定时应启动新任务。篡改快照会阻止恢复。

上下文与记忆最初在 0.4.0 引入；当前版本见 package.json。旧版本的 Run 因 Harness 版本不一致仍会拒绝自动恢复，保留在历史状态中供检查；没有跨版本恢复迁移。

运行 `npm run demo:context` 可复现大文件读取、工具文本压缩、继续写入、原生压缩记录、记忆快照和纠错、独立文件验收。本地脚本模型不需要密钥、不产生模型费用。原始数据保存在 .artifacts/context-memory-demo，不上传 GitHub。另有集成测试验证原生压缩之后再发送提示，已完成写入不会在脚本路径中重复。

后续应建立固定任务集，对真实模型测量事实保留率、检索相关性、成功率与成本；本轮通过不能解释为模型推理能力提升。
