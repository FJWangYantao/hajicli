# A/B 实验：范围收敛（scope_discipline）

- 日期：2026-10-27
- 实验：`scope_discipline` = `baseline` | `converge`
- 模型：`cn:deepseek-v4.1-flash`（`cndeepseek`）
- 方式：11 个只读任务 × 2 组 = 22 次，其余实验固定为默认 arm（`tool_batching=batch_first`）
- 原始数据：[`data/2026-10-27-scope-discipline.json`](data/2026-10-27-scope-discipline.json)

## 假设

上一轮发现「目标名字不确定」的任务会反复换关键词试探。假设通过提示词把探索面收敛
（先定位文件、再一次读完目标区块）可以降低调用数。

## 改动内容

| 组 | 提示词 | 叠读提示 |
| --- | --- | --- |
| `baseline` | 无 | 关闭（不记账） |
| `converge` | 用户原词优先；连续两次未命中禁止换同义词，改用 `global.patterns` 定位或 `projectinfo`；定位后一次读完目标区块 | 开启：同文件重复读重叠 ≥50%、跨度 ≥40 行时提示改走 `nextStartLine` |

## 结果

| 指标 | baseline | converge | 变化 |
| --- | --- | --- | --- |
| 工具调用总数 | 106 | 146 | **+38%** |
| 平均调用 / 任务 | 9.64 | 13.27 | +38% |
| 平均模型请求 / 任务 | 9.45 | 11.27 | **+19%** |
| 平均墙钟 / 任务 | 30.7s | 35.0s | **+14%** |
| prompt token / 任务 | 99k | 141k | **+42%** |
| 缓存命中率 | 85.6% | 87.8% | +2.2pp |
| 未命中 prompt token / 任务 | 14.3k | 17.2k | **+20.5%** |
| 估算费用 / 任务 | ¥0.0570 | ¥0.0680 | **+19%** |
| `grep` 次数 | 25 | 36 | +44% |
| `global` 次数 | 11 | 21 | **+91%** |
| `read` 次数 | 53 | 73 | +38% |
| read 截断次数 | 35 | 59 | +69% |
| 配对胜率（按请求数） | — | **2 胜 / 7 负 / 2 平** | — |

配对平均：**+1.82 次请求 / +42k token / +4.2 秒**。

## 为什么会反着来

- 「先定位再搜」被理解成**额外的一步**：`global` 翻倍，`grep` 也没减少，等于多了一道工序。
- 模型并不知道目标在哪个文件，加一步 `global` 只是把"猜关键词"变成"猜文件名"，没有获得信息。
- 「一次读完目标区块」让单次读得更多，但读的文件数也变多，`read` 总量 +38%。
- 代价不只在调用数：**prompt token +42%、未命中 token +20.5%、费用 +19%**。多出来的
  `global`/`read` 结果会留在上下文里，后面每次请求都重发一遍；其中约 86–88% 能命中前缀缓存
  （单价约为输入的 1/50），所以费用涨幅小于 token 涨幅，但方向不变。
- `read` 截断次数 35 → 59（+69%）：提示词要求"一次读完目标区块"，但工具单次只给 8k 字符，
  指令和输出上限直接冲突，模型只能继续翻页——这是下一轮 `read_budget` 实验的动机。

## 叠读提示的实际效果

- 工具自身的叠读提示在 converge 组**只触发 1 次**（11 个任务），说明叠读本身很罕见，不是主要瓶颈。
- 曾用 trace 参数估算出"29 次重叠"，属于**虚高**：trace 只存请求区间、不存实际返回区间，
  请求 200 行但输出预算只返回 80 行时会被误判。该指标已从 `ab:report` 移除。

## 结论与处置

- **假设被否定**：这类"先定位再搜"的提示会把模型推向更多枚举，不是更少。
- 默认 arm 回退到 `baseline`；`converge` 代码保留（`read-ranges.ts` 默认关闭），
  供后续更窄的变体实验（例如只在"连续零命中"时介入）。
- 教训：**提示词层面的"纪律"收益低且可能为负**；下一步应做机制介入（工具回执直接给候选文件、
  子代理硬预算），而不是继续堆规则。

## 复现

```bash
HAJI_EXPERIMENTS="all=default,scope_discipline=baseline" HAJI_POST_EDIT_VERIFY=0 \
  node packages/cli/dist/index.js -p "<任务>" --permission-mode default --no-worktree
HAJI_EXPERIMENTS="all=default,scope_discipline=converge" HAJI_POST_EDIT_VERIFY=0 \
  node packages/cli/dist/index.js -p "<任务>" --permission-mode default --no-worktree
node scripts/ab-extract.mjs --experiment scope_discipline --since <开始时间>
```
