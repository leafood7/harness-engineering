# 固定任务真实模型评测

状态：completed；完成 72/72。模型模式：live。

成功必须同时满足 Run 完成和全部独立验收项通过。分数为通过的独立验收项比例；没有执行验收的试验记 0 分。

| 组别 | 样本 | 成功 | 成功率 | 95% Wilson区间 | 平均分 | 平均秒 | P95秒 | 平均Token | 估算美元总计 |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| combined | 72 | 58 | 80.56% | 70.0%–88.0% | 0.81 | 3.77 | 6.57 | 5044 | 0.070159 |

## 普通任务与记忆依赖题分开看

| 组别 | 普通题成功/次数 | 记忆依赖题成功/次数 |
|---|---:|---:|
| combined | 49/63 | 9/9 |

## 配对差异

| 从 → 到 | 配对数 | 成功率差（百分点） | 胜/负 | 平均Token差 | 平均估算美元差 |
|---|---:|---:|---|---:|---:|
| baseline → context | 0 | — | 0/0 | — | — |
| baseline → memory | 0 | — | 0/0 | — | — |
| context → combined | 0 | — | 0/0 | — | — |
| memory → combined | 0 | — | 0/0 | — | — |

## 候选策略对照（相同任务、组别和重复号配对）

| 策略 | 成功/次数 | 平均Token | 总估算美元 | 原生压缩后保留题成功/有效次数 |
|---|---:|---:|---:|---:|
| anchored-summary.v1 | 21/24 | 5002 | 0.023974 | 3/3 |
| range-read.v1 | 19/24 | 5454 | 0.023626 | 0/3 |
| stable.v1 | 18/24 | 4676 | 0.022558 | 0/3 |
- anchored-summary.v1: review_candidate; wins=3, losses=0, estimatedCostRatio=1.06; automaticAdoption=false
- range-read.v1: review_candidate; wins=1, losses=0, estimatedCostRatio=1.05; automaticAdoption=false

## 失败与证据

- tool_execution：14

每个试验的 Run、验证结果和事件序号保存在 report.json；experience 仅保存观察到的失败和证据，根因未自动认定。

## 解释边界

- Small fixed-suite sample; Wilson intervals describe observed repeated trials, not broad model capability. Repeats are not fully independent.
- Memory-dependent tasks intentionally require extra private information; report separately.
- Prices are pinned SDK catalog estimates, not account charges; cache and time-of-day affect billing.
- Request counts are host model dispatches, not guaranteed HTTP attempt counts.
- No automatic retry of failed trials, no model self-grading, no rule promotion from unverified diagnoses.
- Order is seeded and interleaved; API caching, server model updates and network variance are not fully controlled.
