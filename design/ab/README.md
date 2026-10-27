# A/B 实验记录

本目录存放「调用效率」方向实验的**结论与可复现数据**。原始 trace（`.haji/traces/`，数十 MB）
不入库，只保留每个会话的指标快照（`data/*.json`），可用 `scripts/ab-extract.mjs` 从 trace 重新生成。

## 实验列表

| 日期 | 实验 | 结论 | 报告 |
| --- | --- | --- | --- |
| 2026-10-27 | `tool_batching`（批量参数） | **采纳**：调用 −24%、请求 −12%、prompt token −11%、费用 −7% | [报告](2026-10-27-tool-batching.md) |
| 2026-10-27 | `scope_discipline`（范围收敛提示） | **否定**：调用 +38%、token +42%、费用 +19%，默认回退 `baseline` | [报告](2026-10-27-scope-discipline.md) |
| 2026-10-27 | `read_budget` = `per_file`（放大全部输出） | **否定**：墙钟 −3.5% 但中位 +19%，任务 7 质量退化 | [报告](2026-10-27-read-budget.md) |
| 2026-10-27 | `read_budget` = `batch_only`（只修批量平分） | **采纳（默认）**：墙钟中性（−2.8%），请求 −9.8%、费用 ≈0、任务 7 质量 3/3 | [报告](2026-10-27-batch-only.md) |
| 2026-10-27 | `read_outline`（截断附剩余符号提纲） | **采纳（默认）**：首轮 pilot 请求 −12.9%、费用 −14.0%、中位墙钟 −16.9%；剔除 1 个未触发提纲的离群会话后总墙钟 −11.0%；样本为 4 任务 pilot（非全量），按此结论采纳 | [报告](2026-10-27-read-outline.md) |
| 2026-10-27 | 召回打分（单字 → 双字+IDF+下限） | **采纳**：墙钟 −31%、请求 −26%、费用 −18%；任务 7 关键结论覆盖 1.5/3 → 3/3；方差大，n=2 | [报告](2026-10-27-recall-scoring.md) |
| 2026-10-27 | `experience_recall`（召回随用户消息注入） | **采纳（默认）**：修正「system prompt 不重建 → 召回永远用启动兜底词表」；成本中性（费用 +1.7%、未命中 +4.3%），墙钟差异不归因 | [报告](2026-10-27-experience-recall.md) |
| 2026-10-27 | `read_symbol`（`read({ path, symbol })` 取定义块） | **未验证**：机制已实现且显式可用，但 symbol 臂 6 次运行 **0 次使用**，treatment 未生效；默认保持 `baseline` | [报告](2026-10-27-read-symbol.md) |
| 2026-10-27 | 写路径基准（3 个写任务 × 2 arm × 2 轮） | **基准，无结论**：正确性 12/12；old 臂 363s / fixed 臂 311s（−14%），但请求 +23%、费用 +17.5%，方差大于差异。发现重命名任务走 `sed -i` 绕过验证钩子 | [报告](2026-10-27-write-baseline.md) |

## 指标口径

`scripts/ab-metrics.mjs` 是唯一口径来源，`ab-report` 与 `ab-extract` 共用：

| 字段 | 含义 |
| --- | --- |
| `requests` | 模型请求数（`llm_call` 事件数，含子代理与标题/压缩等杂活） |
| `utilityRequests` | 其中没有 system 消息的杂活请求（标题、压缩、distill） |
| `toolCalls` | 工具调用数；一次请求可以并行发多个 |
| `requestsPerTool` | 请求 ÷ 工具调用，越小说明合并得越狠 |
| `promptTokens` / `completionTokens` | 按 `usage` 累加 |
| `cachedPromptTokens` | 命中缓存的输入 token（优先 `prompt_cache_hit_tokens`，缺失时回退旧字段） |
| `costCny` | 按 `~/.haji/pricing.json` > 内置单价计；缺价时为 `null`，不猜 |
| `readCalls` / `truncatedReads` | read 次数 / 回执里带 `nextStartLine=` 的次数 |

**不要再用工具调用数代替成本**：`tool_batching` 那轮调用 −24%，但请求只 −12%，
因为合并让一个请求里塞进了更多调用。跟钱走的是「请求数 × 每次请求的上下文」，而上下文里
约 90% 是缓存命中 token（单价约为输入的 1/50）——所以**真正敏感的是未命中 token**，
只看总 prompt token 或调用数都会高估收益。

## 已确认的事实

1. **并行批收益接近 0**（本地只读毫秒级），调用合并才是主变量；并行上限保持 5。
2. **能力可用性 >> 提示词措辞**：`grep.queries` / `global.patterns` 可用后调用数直接下降，
   同一批任务里仅改提示词只有 −1%。
3. **提示词"纪律"类改动可能反噬**：`scope_discipline` 让 `global` 翻倍、token +42%。
4. **跨轮不能直接比**：`tool_batching` 轮跑在 `control/static/3/write/serial`，
   `scope_discipline` 轮跑在默认值 `batch/dynamic/5/role/batched`。
   两轮 baseline 的 `12.64 → 9.64` 混着四个开关的差异，**不是随机波动**；
   同一任务多次运行本身也波动很大（任务 7：10–26 次请求），单任务单次结果不要引用。
5. **read 截断很普遍，但放大额度不等于更快**：592 次 read 里 454 次（77%）被 8k 字符上限截断，
   74% 的 read 请求是 `startLine > 1` 的续读，47% 的源码文件超过 8k；然而 `per_file`
   （单文件 16k、总量 32k、400 行）只把截断降了 25%，墙钟 −3.5%、中位墙钟 +19%，
   任务 7 还出现结论缺失。**截断不是墙钟的主要来源**，更大的上下文会吃掉翻页省下的时间。
   真正的坏设计是「批量读多个文件时按文件数平分额度」：只修这一处的 `batch_only`
   （每文件 8k、总量 32k，单文件不变）墙钟中性但请求 −9.8%、费用 ≈0、任务 7 质量 3/3。
6. **前缀缓存在生效，且命中率很高**：全量 trace（239 会话 / 3805 次 `llm_call`）里
   命中 token 占 prompt token 的 **94.5%**，四轮实验的会话均值 85.6%–91.3%。
   **成本 ≈ 未命中 token 全价 + 命中 token 缓存价 + 输出**，不是「请求数 × 上下文 token」——
   省下缓存 token 几乎不省钱（单价约为输入的 1/50）。
   注意：早前版本读的是 `cache_read_input_tokens` / `cached_tokens`，这两个字段在 trace 里
   存在但恒为 0，导致所有历史报告把上下文按全价计、费用高估约 5 倍；现已改为优先读
   `prompt_cache_hit_tokens` 并重算四份数据快照。
   费用按官方人民币高峰价计（`deepseek-flash`：缓存命中 ¥0.04 / 未命中 ¥2 / 输出 ¥8 每百万 token，
   `deepseek-v4-pro`：¥0.3 / ¥9 / ¥27；谷时五折，按北京时间工作日 09–12、14–18 为峰时）。
   早前 `pricing.json` 误把美元数值当人民币，绝对费用低估约 6.7 倍，已按官方价重算；
   内置注册表 `model-registry.ts` 也已同步这两组价与峰谷时段。

## 工具

```bash
pnpm ab:report                                   # arm 级聚合（并行/子代理/调用效率/请求与成本）
pnpm ab:extract --experiment <name> --since <ISO> [--until <ISO>] [--json]
```

`ab-extract` 输出每个会话的 `requests` / `toolCalls` / `toolCounts` / `promptTokens` /
`completionTokens` / `cachedPromptTokens` / `costCny` / `readCalls` / `truncatedReads` /
`redundantReads` / `batchParamCalls` / `wallMs`，用于配对分析和复核。

`--until` 在混跑过多轮实验时必须加：`all=default` 的轮次会把其他实验也记成默认 arm。
