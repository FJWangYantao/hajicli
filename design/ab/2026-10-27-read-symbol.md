# read_symbol：`read({ path, symbol })` 直接取定义块

日期：2026-10-27
数据：`data/2026-10-27-read-symbol-pilot.json`（6 会话 × 2 arm，任务 5/7/10 × 2 轮）

## 假设

`read_outline` 证明了「给位置信息、让模型直接跳」有效（请求 −12.9%）。再往前一步：
调研时模型往往已经知道符号名（`createToolCallBatches`），却要先 grep 找行号、再 read 一页、
发现没读到函数尾再续读。`read({ path, symbol })` 应该把这条链压成一次调用。

## 实现

- `packages/plugins/src/read-symbol.ts`：按语言匹配定义行（TS/JS、Python、Go、Rust、
  JVM/Kotlin、Markdown、Shell），块尾用**花括号配平**（跳过注释与字符串内容）或
  **Python 缩进**；Markdown 取到同级或更高级标题为止。
- 调用点不会被误认成定义（模式要求声明关键字，方法模式要求行尾 `{`）。
- 找不到时按编辑距离给相近符号，省掉一次 grep。
- `read` 新增 `symbol` 参数：与 `startLine/endLine/aroundLine` 互斥、不能配 `paths`；
  返回头多一行 `符号=X；定义=a-b`；只有定义块被 `limit` 截断时才给 `nextStartLine`；
  不附剩余符号提纲。
- 实验开关 `read_symbol`（`baseline` 时 schema 里直接没有 `symbol` 属性，不是「有参数但报错」）。
- 提示词同步加了一句「已知符号名时用 symbol 直接取回整个定义块」，同样只在 symbol 臂出现。

## 方法

- 任务：5（`createToolCallBatches` 定义与调用点）、7（工具错误分类与止损）、10（subagent 调研）。
- 每个任务 2 轮 × 2 arm，交替执行；`HAJI_EXPERIMENTS="read_symbol=baseline|symbol"`。
- 1 个 baseline 会话 300s 超时，已重跑替换（数据里剔除了 wall=0 的那条）。

## 结果

**关键事实：symbol 臂 6 次运行里，`symbol` 参数被使用 0 次。**

| 指标 | baseline | symbol | 变化 |
| --- | ---: | ---: | ---: |
| 墙钟 / 会话 | 60.5s | 54.4s | −10.1% |
| 请求 / 会话 | 17.2 | 18.8 | +9.7% |
| read / 会话 | 9.2 | 8.8 | −4.4% |
| 未命中 token / 会话 | 27,865 | 28,453 | +2.1% |
| 费用 / 会话 | ¥0.1115 | ¥0.1088 | −2.5% |
| **symbol 调用** | 0 | **0** | — |

这些差异全是噪声：treatment 根本没生效，两臂跑的其实是同一套行为。

**能力本身是通的**。显式要求时一次就成：

```
只做一次工具调用：调用 read，参数 path=packages/cli/src/tool-batch.ts、symbol=createToolCallBatches
→ 返回头：符号=createToolCallBatches；定义=55-86；总行数=308；hash=…
```

## 诊断：问题在「发现」，不在机制

- 加了提示词规则后仍然 0 次使用（抽查 system prompt 确认规则确实在里面）。
- 模型在任务 5 里选择 `read` 整文件、再 `startLine/endLine` 分段读，完全不碰 `symbol`。
- 说明静态提示词不足以改变选择：模型的默认路径是「先 grep 拿行号，再按行读」，
  而任务本身要求「所有调用点」，grep 天然是第一步，`symbol` 没有触发点。

## 结论

**机制实现完成，但按 A/B 口径「未验证」**：默认保持 `baseline`，不宣称收益。
下一步要让它在正确时机被想到，而不是再加一句提示词：

1. **在 grep 结果里给触发点**：命中行形如定义（`function X` / `class X`）时，追加一行
   「可用 `read({ path, symbol })` 直接取定义块」——上下文相关，比静态规则有效。
2. 或者做任务级对照：让任务明确要求「先拿定义再追调用点」，此时 symbol 是自然选择，
   再比较请求数与未命中 token。
3. 如果两条都不显著，就把这个参数当作「显式可用能力」保留，不再投入。

> 2026-10-28：第 1 条已实现（symbol 臂下 grep 命中声明行时回执末尾追加
> `read({ path, symbol })` 提示，见 `buildSymbolReadHint`），待跑第二轮 A/B。

## 复现

```bash
HAJI_EXPERIMENTS="read_symbol=symbol"   haji -p "<任务>" --no-worktree --output-format json
HAJI_EXPERIMENTS="read_symbol=baseline" haji -p "<任务>" --no-worktree --output-format json

node scripts/ab-extract.mjs --experiment read_symbol --since 2026-10-27T14:11:00Z --json
```
