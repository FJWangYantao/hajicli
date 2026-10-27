# A/B 实验记录

本目录存放「调用效率」方向实验的**结论与可复现数据**。原始 trace（`.haji/traces/`，数十 MB）
不入库，只保留每个会话的指标快照（`data/*.json`），可用 `scripts/ab-extract.mjs` 从 trace 重新生成。

## 实验列表

| 日期 | 实验 | 结论 | 报告 |
| --- | --- | --- | --- |
| 2026-10-27 | `tool_batching`（批量参数） | **采纳**：调用 −24%、墙钟 −11% | [报告](2026-10-27-tool-batching.md) |
| 2026-10-27 | `scope_discipline`（范围收敛提示） | **否定**：调用 +38%，默认回退 `baseline` | [报告](2026-10-27-scope-discipline.md) |

## 已确认的事实

1. **并行批收益接近 0**（本地只读毫秒级），调用合并才是主变量；并行上限保持 5。
2. **能力可用性 >> 提示词措辞**：`grep.queries` / `global.patterns` 可用后调用数直接下降，
   同一批任务里仅改提示词只有 −1%。
3. **提示词"纪律"类改动可能反噬**：`scope_discipline` 让 `global` 调用翻倍。
4. **轮间方差约 ±30%**：同一配置两次测得 12.64 / 9.64 次调用，小于 10% 的差异不要下结论。

## 工具

```bash
pnpm ab:report                                   # arm 级聚合（并行率/子代理/调用效率）
node scripts/ab-extract.mjs --experiment <name> --since <ISO> [--json]
```

`ab-extract` 输出每个会话的 `toolCalls` / `toolCounts` / `redundantReads` /
`batchParamCalls` / `wallMs`，用于配对分析和复核。
