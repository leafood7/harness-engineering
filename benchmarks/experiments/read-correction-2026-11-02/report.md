# 固定任务真实模型评测

状态：completed；完成 104/104。模型模式：live。

成功必须同时满足 Run 完成和全部独立验收项通过。分数为通过的独立验收项比例；没有执行验收的试验记 0 分。

| 组别 | 样本 | 成功 | 成功率 | 95% Wilson区间 | 平均分 | 平均秒 | P95秒 | 平均Token | 估算美元总计 |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| combined | 104 | 64 | 61.54% | 51.9%–70.3% | 0.64 | 5.39 | 8.57 | 6370 | 0.137214 |

## 普通任务与记忆依赖题分开看

| 组别 | 普通题成功/次数 | 记忆依赖题成功/次数 |
|---|---:|---:|
| combined | 56/96 | 8/8 |

## 配对差异

| 从 → 到 | 配对数 | 成功率差（百分点） | 胜/负 | 平均Token差 | 平均估算美元差 |
|---|---:|---:|---|---:|---:|
| baseline → context | 0 | — | 0/0 | — | — |
| baseline → memory | 0 | — | 0/0 | — | — |
| context → combined | 0 | — | 0/0 | — | — |
| memory → combined | 0 | — | 0/0 | — | — |

## 候选策略对照（相同任务、组别和重复号配对）

| 策略 | 成功/次数 | 平均Token | 总估算美元 | 纠错提示/后续有效读 | 原生压缩后保留题成功/有效次数 |
|---|---:|---:|---:|---:|---:|
| anchored-correction.v1 | 22/26 | 7309 | 0.038226 | 5/4 | 6/8 |
| read-correction.v1 | 16/26 | 6750 | 0.035423 | 4/4 | 0/8 |
| file-contract.v1 | 14/26 | 6116 | 0.033248 | 0/0 | 0/8 |
| stable.v1 | 12/26 | 5308 | 0.030317 | 0/0 | 0/8 |
- anchored-correction.v1: tradeoff_requires_review; wins=10, losses=0, estimatedCostRatio=1.26; automaticAdoption=false
- read-correction.v1: review_candidate; wins=4, losses=0, estimatedCostRatio=1.17; automaticAdoption=false
- file-contract.v1: review_candidate; wins=2, losses=0, estimatedCostRatio=1.10; automaticAdoption=false

## 失败与证据

- independent_verification_failed：17
- tool_execution：18
- scope_denied：5

每个试验的 Run、验证结果和事件序号保存在 report.json；experience 仅保存观察到的失败和证据，根因未自动认定。

## 解释边界

- Small fixed-suite sample; Wilson intervals describe observed repeated trials, not broad model capability. Repeats are not fully independent.
- Memory-dependent tasks intentionally require extra private information; report separately.
- Prices are pinned SDK catalog estimates, not account charges; cache and time-of-day affect billing.
- Request counts are host model dispatches, not guaranteed HTTP attempt counts.
- No automatic retry of failed trials, no model self-grading, no rule promotion from unverified diagnoses.
- Order is seeded and interleaved; API caching, server model updates and network variance are not fully controlled.
