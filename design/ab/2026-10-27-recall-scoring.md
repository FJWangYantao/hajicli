# recall_scoring：经验召回打分（单字 → 双字 + IDF + 分数下限）

日期：2026-10-27
数据：`data/2026-10-27-recall-scoring-pilot.json`（3 任务 × 2 轮 × 2 版本 = 12 会话）

## 背景

离线评测（`scripts/recall-eval.mjs`）显示旧召回有两处问题：中文按单字切（任何共享汉字都算命中）、
minConfidence 0.70 而库里 605 条有 557 条停在 0.50。结果无论问什么都只召回固定那 2 条，
无关短问也会被塞经验。改成中文双字 + IDF 加权 + 分数下限 0.10 + 默认 top2 + 门槛 0.5 之后，
离线指标是相关率 27% → 86%、无关注入率 60% → 0%。

这次验证真实会话上的效果。

## 方法

- 两臂是两个**构建**（不是实验 arm）：
  - `old` = `f3514ad`（改动前）；
  - `new` = `d45237b`（改动后）。
  - 用 `node <worktree>/packages/cli/dist/index.js` 跑 old，`haji` 跑 new，cwd 与 HOME 相同，
    读同一份 605 条 instincts。
- 任务 3（会话保存链路）、7（工具错误分类与止损）、10（subagent 并行判定），各 2 轮，交替执行。
- 每轮核对注入内容：old 固定是「grep 必须传 queries」「搜到结果后要 Read」两条；
  new 是任务相关的 project-context / error-prevention 规则。

## 结果

| 指标 | old | new | 变化 |
| --- | ---: | ---: | ---: |
| 墙钟 / 会话 | 94.2s | 65.2s | −30.8% |
| 请求 / 会话 | 25.3 | 18.7 | −26.3% |
| prompt token / 会话 | 324,556 | 217,777 | −32.9% |
| 未命中 token / 会话 | 33,164 | 29,702 | −10.4% |
| 费用 / 会话 | ¥0.1329 | ¥0.1091 | −17.9% |

分任务（墙钟秒 / 请求数，两轮）：

| 任务 | old | new |
| --- | --- | --- |
| 3 会话保存 | 50s/16、124s/19 | 57s/21、32s/9 |
| 7 错误止损 | 66s/22、215s/56 | 35s/13、103s/27 |
| 10 subagent | 58s/21、52s/18 | 111s/21、52s/21 |

**方差很大**：old 在任务 7 第二轮跑了 56 次请求 / 215s，new 在任务 10 第一轮 111s。
每格只有 2 次，均值差异不能当精确值；方向与离线评测一致。

## 质量抽查（关键结论词覆盖）

| 任务 | old | new |
| --- | --- | --- |
| 3 会话保存 | 3/3、3/3 | 3/3、3/3 |
| 7 错误止损 | **2/3、1/3** | **3/3、3/3** |
| 10 subagent | 4/4、4/4 | 4/4、4/4 |

任务 7 是唯一有差异的：old 两次都没完整覆盖 `RepeatedFailureTracker` / `noop` / `concurrent`
这组关键词，new 两次都覆盖。样本太小，但和「注入的规则从无关变成相关」是一致的。

## 结论

**保留新实现**（已在上一个提交 `d45237b` 切为默认，无开关）。成本与质量都朝好的方向，
但 12 个会话不足以给出精确幅度；需要更准的数字时应扩到 4–5 轮再算。

## 复现

```bash
git worktree add --detach /tmp/old f3514ad && (cd /tmp/old && pnpm run build)
# old 臂
node /tmp/old/packages/cli/dist/index.js -p "<任务>" --no-worktree --output-format json
# new 臂
haji -p "<任务>" --no-worktree --output-format json

node scripts/ab-extract.mjs --since 2026-10-27T16:02:00Z --json
```
