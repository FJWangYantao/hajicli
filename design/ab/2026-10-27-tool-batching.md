# A/B 实验：调用合并（tool_batching）

- 日期：2026-10-27
- 实验：`tool_batching` = `baseline` | `batch_first`
- 模型：`cn:deepseek-v4.1-flash` / `global:deepseek-v4.1-flash`
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
| 中位工具调用 | 19 | **13** | −32% |
| 平均模型请求 / 任务 | 13.55 | **11.91** | **−12%** |
| 中位模型请求 | 15 | **11** | −27% |
| prompt token / 任务 | 178k | **158k** | **−11%** |
| completion token / 任务 | 3810 | 3380 | −11% |
| 估算费用 / 任务 | ¥0.058 | **¥0.051** | **−12%** |
| 平均墙钟 / 任务 | 36.7s | **32.5s** | **−11%** |
| 中位墙钟 | 41.4s | **28.3s** | −32% |
| 请求 ÷ 工具调用 | 0.82 | 0.94 | 一个请求发出更多调用 |
| read 调用 / 任务 | 8.0 | 5.7 | −29% |
| read 截断 / 任务 | 5.6 | 4.3 | −23% |
| 重复读（同区间） | 0.55 | **0.09** | −84% |
| 批量参数调用 / 任务 | 0.91 | **5.09** | ×5.6 |

批量参数使用分布：

| 参数 | baseline | batch_first |
| --- | --- | --- |
| `read.paths` | 10 | 25 |
| `grep.queries` | 0（未暴露） | 22 |
| `global.patterns` | 0（未暴露） | 9 |

配对（同任务）对比：**11 个任务里请求更少 5 个、更多 4 个、持平 2 个**，
平均 **−1.64 次请求 / −19k token / −4.1 秒**。

典型样本：

| 任务 | baseline | batch_first |
| --- | --- | --- |
| 找出与会话保存相关的实现 | 17 请求 / 302k tok | **13 请求 / 173k tok** |
| 列出 `packages/core/src` 下所有 ts 并挑三个读 | 15 请求 / 138k tok | **7 请求 / 53k tok** |
| 找出工具执行错误的分类与止损逻辑 | 21 请求 / 484k tok | 26 请求 / 591k tok（更差） |

## 结论

1. **批量参数是主要杠杆**：`grep.queries` / `global.patterns` 让"多目标一次调用"落地，
   工具调用 −24%、模型请求 −12%、token 与费用 −11~12%。
2. **调用数 ≠ 请求数**：调用降得更多，是因为一个请求里塞了更多调用（`req/tool` 0.82→0.94）。
   真正决定成本的是请求数 × 上下文，所以本报告的收益以 **请求 −12% / 费用 −12%** 为准。
3. **提示词本身贡献很小**：早前一版两臂都有批量参数、只有提示词不同时，调用仅 −1%、墙钟 −3%。
   所以能力可用性 >> 提示词措辞。
4. **并行率反而下降**（control 20% → treatment 10%），并行批节省仍是毫秒级——本地只读没有并行收益，
   **上限保持 5，不要提到 8**。
5. 4 个任务请求数反而变多，共同点是"目标名字不确定、需要反复试探"——这是下一轮要解决的问题。

## 已知测量问题

1. **本轮对照组不是推荐默认值**：`baseline` 组跑在 `parallel_prompt=control`、`parallel_allowlist=static`、
   `parallel_max=3`、`subagent_access=write`、`subagent_batch=serial` 下，而 `batch_first` 组同样是这套配置，
   所以组间比较是干净的；但**跨轮不能和后来用默认值的实验直接比**。
   两轮之间 `12.64 → 9.64` 的差异里混着「并行开关 + 子代理分级」四个变量，不是纯随机波动。
2. **每任务只跑 1 次**：同一任务多次运行差异很大（任务 7 在 7 次运行里出现 10–26 次请求）。
   本轮结论靠的是 11 个任务的方向一致性（费用 −12%），单个任务的数字不要引用。
3. 费用按 `~/.haji/pricing.json` 的 `cn:` 单价计；`global:` 前缀的请求借用同名模型单价（报告里标 `*`）。
   provider 未上报缓存命中（cache% = 0），所以上下文增量按全价计。

## 复现

```bash
HAJI_EXPERIMENTS="all=control,tool_batching=baseline" HAJI_POST_EDIT_VERIFY=0 \
  node packages/cli/dist/index.js -p "<任务>" --permission-mode default --no-worktree
HAJI_EXPERIMENTS="all=control,tool_batching=batch_first" HAJI_POST_EDIT_VERIFY=0 \
  node packages/cli/dist/index.js -p "<任务>" --permission-mode default --no-worktree
pnpm ab:report
pnpm ab:extract --experiment tool_batching --since <开始时间> --until <结束时间> --json
```
