# A/B 实验：调用合并（tool_batching）

- 日期：2026-10-27
- 实验：`tool_batching` = `baseline` | `batch_first`
- 模型：`cn:deepseek-v4.1-flash`（`cndeepseek`）
- 方式：`haji -p "<任务>" --permission-mode default --no-worktree`，11 个只读任务 × 2 组 = 22 次
- 原始数据：[`data/2026-10-27-tool-batching.json`](data/2026-10-27-tool-batching.json)

## 改动内容

| 组 | 能力 | 提示词 |
| --- | --- | --- |
| `baseline` | `read.paths` 可用；`grep.queries` / `global.patterns` **不暴露也不接受** | 无批量指引 |
| `batch_first` | `read.paths` + `grep.queries`(≤5) + `global.patterns`(≤5) | 优先用批量参数合并调用 |

## 结果

| 指标 | baseline | batch_first | 变化 |
| --- | --- | --- | --- |
| 平均工具调用 / 任务 | 16.55 | **12.64** | **−24%** |
| 中位调用数 | 19 | **13** | −32% |
| 平均墙钟 / 任务 | 36.7s | **32.5s** | **−11%** |
| 中位墙钟 | 41.4s | **28.3s** | −32% |
| 重复读（同区间） | 0.55 | **0.09** | −84% |
| 批量参数调用 / 任务 | 0.91 | **5.09** | ×5.6 |
| 子代理启动 | 2 | 2 | — |

批量参数使用分布：

| 参数 | baseline | batch_first |
| --- | --- | --- |
| `read.paths` | 10 | 25 |
| `grep.queries` | 0（未暴露） | 22 |
| `global.patterns` | 0（未暴露） | 9 |

配对（同任务）对比：**11 个任务中 7 个调用更少、3 个更多、1 个持平**，平均 **−3.9 次调用 / −4.1 秒**。

典型样本：

| 任务 | baseline | batch_first |
| --- | --- | --- |
| 找出与会话保存相关的实现 | 27 次 / 51.4s | **9 次 / 21.3s** |
| 列出 `packages/core/src` 下所有 ts 并挑三个读 | 22 次 / 35.7s | **5 次 / 16.7s** |
| 找出工具执行错误的分类与止损逻辑 | 28 次 / 60.4s | 30 次 / 77.5s（更差） |

## 结论

1. **批量参数是主要杠杆**：`grep.queries` / `global.patterns` 让"多目标一次调用"落地，调用数 −24%。
2. **提示词本身贡献很小**：早前一版两臂都有批量参数、只有提示词不同时，调用仅 −1%、墙钟 −3%。
   所以能力可用性 >> 提示词措辞。
3. **并行率反而下降**（control 20% → treatment 10%），并行批节省仍是毫秒级——本地只读没有并行收益，
   **上限保持 5，不要提到 8**。
4. 3 个任务反而更慢，共同点是"目标名字不确定、需要反复试探"——这是下一轮要解决的问题。

## 已知测量问题

同一份 `batch_first` 配置在两轮实验里分别测到 **12.64** 和 **9.64** 次调用（轮间方差约 ±30%）。
因此单轮小于 10% 的差异不可信；本轮 −24% 方向可信，具体数值偏乐观（真实收益估计 −15%~−25%）。

## 复现

```bash
HAJI_EXPERIMENTS="all=control,tool_batching=baseline" HAJI_POST_EDIT_VERIFY=0 \
  node packages/cli/dist/index.js -p "<任务>" --permission-mode default --no-worktree
HAJI_EXPERIMENTS="all=control,tool_batching=batch_first" HAJI_POST_EDIT_VERIFY=0 \
  node packages/cli/dist/index.js -p "<任务>" --permission-mode default --no-worktree
pnpm ab:report
node scripts/ab-extract.mjs --experiment tool_batching --since <开始时间> --json
```
