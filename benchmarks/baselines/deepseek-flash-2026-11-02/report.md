# 固定任务真实模型评测

状态：completed；完成 32/32。模型模式：live。

成功必须同时满足 Run 完成和全部独立验收项通过。分数为通过的独立验收项比例；没有执行验收的试验记 0 分。

| 组别 | 样本 | 成功 | 成功率 | 95% Wilson区间 | 平均分 | 平均秒 | P95秒 | 平均Token | 估算美元总计 |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| context | 8 | 6 | 75.00% | 40.9%–92.9% | 0.75 | 5.00 | 9.31 | 5069 | 0.006846 |
| combined | 8 | 8 | 100.00% | 67.6%–100.0% | 1.00 | 4.48 | 7.81 | 5109 | 0.007221 |
| memory | 8 | 7 | 87.50% | 52.9%–97.8% | 0.88 | 4.14 | 5.85 | 3834 | 0.006366 |
| baseline | 8 | 5 | 62.50% | 30.6%–86.3% | 0.63 | 4.19 | 6.29 | 3301 | 0.005866 |

## 普通任务与记忆依赖题分开看

| 组别 | 普通题成功/次数 | 记忆依赖题成功/次数 |
|---|---:|---:|
| context | 6/6 | 0/2 |
| combined | 6/6 | 2/2 |
| memory | 5/6 | 2/2 |
| baseline | 5/6 | 0/2 |

## 配对差异

| 从 → 到 | 配对数 | 成功率差（百分点） | 胜/负 | 平均Token差 | 平均估算美元差 |
|---|---:|---:|---|---:|---:|
| baseline → context | 8 | 12.50 | 1/0 | 1768 | 0.000123 |
| baseline → memory | 8 | 25.00 | 2/0 | 533 | 0.000063 |
| context → combined | 8 | 25.00 | 2/0 | 40 | 0.000047 |
| memory → combined | 8 | 12.50 | 1/0 | 1275 | 0.000107 |

## 失败与证据

- tool_execution：4
- context_capacity：2

每个试验的 Run、验证结果和事件序号保存在 report.json；experience 仅保存观察到的失败和证据，根因未自动认定。

## 解释边界

- Small fixed-suite sample; Wilson intervals describe observed repeated trials, not broad model capability. Repeats are not fully independent.
- Memory-dependent tasks intentionally require extra private information; report separately.
- Prices are pinned SDK catalog estimates, not account charges; cache and time-of-day affect billing.
- Request counts are host model dispatches, not guaranteed HTTP attempt counts.
- No automatic retry of failed trials, no model self-grading, no rule promotion from unverified diagnoses.
- Order is seeded and interleaved; API caching, server model updates and network variance are not fully controlled.
