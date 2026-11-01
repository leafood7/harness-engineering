# M0 参考项目核实与复用清单

日期：2026-11-01。区分“公开资料已核实”和“在 Pi 1.4.0 中运行验证通过”。本阶段只有 Pi 主底座完成运行验证；其他项目均未安装，也未将其源码引入正式执行链。

## 原方案需要纠正或补充

1. [agentic-labs/pi-mono](https://github.com/agentic-labs/pi-mono) 是 [earendil-works/pi](https://github.com/earendil-works/pi) 的 Fork。以本地 origin 对应的 earendil-works/pi 为底座。
2. [pi-harness/pi-harness](https://github.com/pi-harness/pi-harness) 是基于 Cordis 的独立 Web Host/CLI。去掉原文“官方项目”的称呼，作为架构参考。
3. TinyCode 的直接依赖基于 Pi ^0.84.3，与本地 1.4.0 存在版本跨度。可借鉴设计，不能默认复制后兼容。
4. RSI-Flow 的 README 快速开始面向 macOS/Linux；本机是 Windows。Python Worker/CLI 是候选接法，其集成和回滚还需要平台验证。
5. SAM README 明确测试 Pi 0.87.1 与 1.3.0。当前下载清单为 SAM 0.0.28，README 状态段仍写 0.0.27；不能据此宣称已支持 Pi 1.4.0。
6. Voluntary Compaction 要求关闭 Pi 原生自动压缩。应作为独立实验选项，不能与默认压缩方案直接叠加。
7. Pi Harness RSI 声明 Bun >=1.1.0。不能直接视作已验证的纯 Node 扩展。
8. Evolving Harness 的公开 API 未识别许可证，仓库展示也没有 LICENSE。本阶段仅参考公开架构，未迁移源码。

## 复用决定

| 项目与来源 | 核实到的版本/许可证 | 本阶段决定 | 后续接入门槛 |
|---|---|---|---|
| [Pi](https://github.com/earendil-works/pi) | 本地 coding-agent 1.4.0 / MIT | 采用 SDK 与 Extension；已实测 | 正式依赖固定版本；保留本地提交基线 |
| [TinyCode](https://github.com/helsome/tinycode) | 1.0.0 / MIT | 参考权限、工具和测试组织 | 选定具体模块后核查源码与 1.4.0 差异；保留版权 |
| [SpecPi](https://github.com/TannerMidd/SpecPi) | 直接下载清单 0.37.1 / MIT | 参考 Scope 与改进治理 | 对选定模块做接口、间接依赖及权限绕过测试 |
| [RSI-Flow](https://github.com/quqxui/RSI-Flow) | 0.14.0，Python >=3.10 / MIT | 保留为 M6–M7 候选组件 | Windows 兼容、协议、超时、产物和回滚验证 |
| [Pi Harness RSI](https://github.com/grigio/pi-harness-rsi) | 0.2.1 / MIT | 参考候选探索、预算与账本机制 | Bun/Node 边界；避免重复引入第二套候选管理 |
| [SAM](https://github.com/LePrau/pi-self-aware-memory) | 清单 0.0.28 / MIT | M4 可选实验 | Pi 1.4.0 兼容和压缩后记忆正确性验证 |
| [Voluntary Compaction](https://github.com/niker/pi-voluntary-compaction) | 1.0.10 / Apache-2.0 | M4 可选实验 | 独立配置关闭原生自动压缩；核查 NOTICE |
| [pi-harness](https://github.com/pi-harness/pi-harness) | 公开元数据 MIT | 参考模块生命周期 | 当前不引入 Cordis/Web Host |
| [Evolving Harness](https://github.com/leafood7/evolving-harness) | 未发现明确许可证 | 仅参考公开架构 | 如要迁移代码，先明确授权来源 |

这里的版本是核实快照，不是“最新版本”承诺。浏览器缓存可能滞后；清单版本以本次直接下载记录为准。源码真正进入项目之前仍需固定具体提交、审查对应 LICENSE/NOTICE 和兼容性。

## 核实材料

- `m0/reference-metadata.json`：10 个仓库的 GitHub API 来源、Fork 状态、默认分支、许可证标识和读取时间。
- `m0/references/`：6 个主要参考项目的 README 与清单快照；本轮只用于核实，未加载为插件。
- 元数据许可证标识不替代源码复用时的逐文件版权检查。
- 原文其余 WebUI、Desktop、垂直业务项目不进入 M0 依赖选择，未作兼容性承诺。

## 当前选型

主语言 TypeScript；CLI 入口；Pi 1.4.0 SDK + Extension；先用模块接口组织。M1 增加 SQLite Run 状态与 JSONL 事件；Pi 自己保存原生会话。Git 用于源码与策略版本。M0 不提前引入 Python/Bun Worker、Cordis、记忆插件或多 Agent。
