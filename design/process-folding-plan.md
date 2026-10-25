# 对话区过程折叠方案

> 范围：`packages/cli` 对话区（TerminalUI）、回合执行（turn-runner）、`/resume` 历史回显、偏好与命令。
> 基线：master `9ba210d`。
> 目标：仿 Claude Code，把模型干活的**过程**（工具调用、思考）收成一行摘要，**正文始终可见**；点击摘要行展开 / 收起。

---

## 一、效果

一轮对话完成后：

```
› 帮我修一下登录 bug

  ● 读取 4 个文件，搜索 2 次，编辑 2 个文件，运行 1 条命令 · 思考 3 次
编译还是有问题，让我看看
  ● 读取 2 个文件，编辑 1 个文件，运行 1 条命令 · 思考 2 次
已完成：问题出在 token 过期判断……
  完成 · 1m12s · 改动 2 个文件 +18 −4 · ¥0.012
```

点击某一行 `●` 摘要，下方原样展开该段的工具块与"思考 Ns"行；再点一次收起：

```
  ● 读取 2 个文件，编辑 1 个文件，运行 1 条命令 · 思考 2 次
  思考 4s · 812 tokens

  ✓ read  src/auth/token.ts  12ms
    └ 120 行
  ✓ edit  src/auth/token.ts  8ms
    └ +3 −1
  ✕ bash  pnpm build  3.2s
    └ error TS2345: …
已完成：问题出在 token 过期判断……
```

- 摘要行**不带任何操作提示**（不写"点击展开 / Ctrl+O"）。
- 用户提问回显、模型所有正文（含中间的"编译还是有问题，让我看看"）、回合小结**永不折叠**。
- 默认开启，`/fold off` 关闭（关闭后对话区与现在完全一致）。

---

## 二、交互规格

### 2.1 折叠单位：过程段

**过程段** = 两段可见正文之间、连续出现的过程输出。一轮可以有多个过程段。

一轮回合由若干次模型请求（`runAgentTurn` 的 `while (keepCalling)` 循环，下称"迭代"）组成。每次迭代的输出顺序固定为：

```
[正文（可空）] → [思考 Ns 行（仅正文为空且有工具调用时）] → [告警（可选）] → [工具块 × N]
```

切分规则：

| 时机 | 动作 |
| --- | --- |
| 某次迭代得到**有效工具调用**，且当前没有打开的过程段 | **开段**：在写"思考 Ns"行 / 工具块之前记录段起点 |
| 已有打开的过程段，又一次迭代得到有效工具调用（中间没有正文） | 继续并入同一段（这就是"思考 3 次"的来源） |
| 某次迭代流式输出的**第一个非空白正文**到达，且有打开的过程段 | **封口**：段终点 = 本次迭代的 `streamStartOffset`，该段立即折叠 |
| 回合结束（正常 / 中止 / 失败 / 连续失败止损）时仍有打开的过程段 | **不封口**，原样保持展开（等同今天的显示） |

推论：

- 封口发生在回合**进行中**——模型一开始写下一段正文，上一段过程就收起（与 Claude Code 一致）。
- 回合被中止或失败时，已封口的段照常折叠，最后那段没等到正文，保持展开，便于看出错现场。
- 纯问答回合（没有工具调用）不产生过程段，对话区与今天一致。
- 无效工具调用（`invalidToolCall`）分支写出的拦截告警不开段，保持可见。

### 2.2 摘要行格式

```
{缩进}● {工具类别计数，用"，"连接} · 思考 N 次 · N 次失败 · N 次被拒
```

- 缩进复用 `cli-runtime.ts` 的 `TOOL_CELL_INDENT`（两个空格），与工具块左对齐。
- `●`：`colors.muted`；段内有失败时改为 `colors.boldRed`。
- 类别文字：`colors.muted`；"N 次失败"：`colors.red`；"N 次被拒"：`colors.yellow`。

**工具类别**（按此顺序输出，计数为 0 的类别不出现）：

| 类别 | 工具名 | 文案 | 计数口径 |
| --- | --- | --- | --- |
| read | `read` | 读取 N 个文件 | 按 `args.path` 去重；无 path 时按调用计 |
| search | `grep`、`global` | 搜索 N 次 | 调用次数 |
| edit | `edit`、`write` | 编辑 N 个文件 | 按 `args.path` 去重 |
| command | `bash` | 运行 N 条命令 | 调用次数 |
| web | `webfetch`、`websearch` | 联网 N 次 | 调用次数 |
| agent | `subagent`、`verifyagent` | 子代理 N 次 | 调用次数 |
| task | `taskcreate`、`tasklist`、`updatetask`、`taskfinish` | 更新任务 N 次 | 调用次数 |
| skill | `loadskill`、`listskillresources`、`readskillresource` | Skill N 次 | 调用次数 |
| mcp | `mcp_` 前缀 | MCP 工具 N 次 | 调用次数 |
| other | 其余（`projectinfo` 等） | 其他工具 N 次 | 调用次数 |

**思考 N 次**：段内 `reasoningContent` 非空的迭代数；为 0 时整个字段不出现（非推理模型）。

**失败 / 被拒**：按 `summarizeToolResult` 的 `status`：`failed`（含未注册工具）计失败，`rejected` 计被拒；被中止跳过（`skipped`）的不计入任何类别。

**宽度降级**（`width` = `ui.getContentWidth()`，保证单行），按顺序尝试直到放得下：

1. 完整格式；
2. 从末尾往前逐个丢弃工具类别，丢掉的合并为"等 N 类"；
3. 工具部分改成"N 次工具调用"；
4. 丢掉"思考 N 次"；
5. `truncateText` 截断。

摘要行在每次渲染时按当前宽度现算（存的是统计值，不是字符串），所以终端缩放后摘要行依然单行。

### 2.3 空行规则

过程段原文 `raw` 的首尾常带空行（工具块前的 `writeBlankLine`、工具块后的 `writeLine()`）。两种形态都保留原文的首尾空行数，只替换中间：

- **折叠**：`{raw 的首部空行}{摘要行}\n{raw 的尾部空行}`
- **展开**：`{raw 的首部空行}{摘要行}\n{raw 去掉首部空行后的内容}`
- **关闭折叠功能**（`/fold off`）：直接输出 `raw`，不出现摘要行。

### 2.4 切换方式

| 方式 | 行为 |
| --- | --- |
| 鼠标左键**单击**摘要行 | 切换该段（单击 = 按下与松开之间没有拖动，不影响拖选复制） |
| 单击其他行 | 与今天一致（清除选区） |
| `Ctrl+O` | 切换**最新**一个已封口过程段；没有时 `showTransientHint("暂无可展开的过程")`。回合进行中也可用（已封口段不再变化） |
| `/fold [on\|off]` | 开关折叠功能并写入偏好；无参切换当前状态 |
| `/output` | 承接原 Ctrl+O 的"最后一批工具完整输出"（见 4.8） |

切换后保持被点的摘要行停在原来的屏幕行（见 4.4.6）。

### 2.5 特殊情况

| 场景 | 处理 |
| --- | --- |
| 段内出现的授权提示行（"本会话内 X 将不再询问"）、前台子代理的工具块、`finish_reason=length` 告警 | 写在开段之后，随段折叠 |
| 后台子代理在回合之间写入的工具块 / 告警 | 不在任何过程段内，保持可见 |
| Plan 模式审批 | 方案正文是正文，会封口前面的调研段；审批选择器是浮层，不进对话区 |
| `/clear`、`/resume`、`/rewind` | 清空分段；`/resume` 按 4.6 重建分段 |
| 无头模式 `haji -p` / 非 TTY | 所有折叠 API 空操作，stdout 输出与今天逐字节一致 |
| 窄屏 emergencyMinimal 布局 | 规则不变（摘要行本就单行） |

### 2.6 不在本期范围

- 悬停高亮摘要行（需要 1003 鼠标跟踪，目前只在侧栏可见时开启，见 `setMouseMotionEnabled`）。列为后续可选。
- 展开时显示推理原文、完整工具输出。
- "全部展开 / 全部收起"快捷键。

---

## 三、现状要点（改动前必须理解）

1. **对话区是一整条 ANSI 字符串**：`terminal-input.ts` 的 `chatContent`（L283），由 `writeChat` / `writeLine` / `writeBlankLine` 追加，`updateChatFrom(offset, text)`（L986）按绝对偏移覆盖重写尾部（流式 Markdown 平滑重绘）。超过 200k 字符时 `slice(-160_000)` 截掉头部。
2. **换行缓存**：`getWrappedChat`（L816）利用 `stableWrapPrefix`（以 `\n` 结尾的稳定前缀）只重排尾部；`markStableChatPrefix(offset)` 由调用方声明稳定点。
3. **滚动**：`chatScrollOffset` 是**距底部的行数**。`render()`（L2059–2072）在内容变化且 `chatScrollOffset > 0` 时把行数差加到 offset 上，前提是变化都发生在底部。
4. **选区**：`getSelectionLayout()`（L1125）对整个 `chatContent` 跑 `layoutAnsiDocument`，行号与 `wrappedChat` 一一对应。
5. **鼠标**：`handleMouseEvent`（L1320）里，左键按下后没有移动就松开时进入 L1380 分支，**目前什么也不做**，是天然的"单击"入口。
6. **持有 `chatContent` 绝对偏移的调用方**（全部）：

| 位置 | 偏移 | 生命周期 |
| --- | --- | --- |
| `turn-runner.ts:366` | `streamStartOffset` | 单次迭代内 |
| `turn-runner.ts:263` / `index.ts:1994,2078,2674` | `promptDisplayStartOffset` | 只在请求发出前（prompt 收回）使用 |
| `index.ts:1497,2083–2089` | `lastCommandEcho {start,end}` | 指令回显到下一次枢纽转发之间 |

偏移都很短命。所以方案是：**已封口的内容移出 `chatContent`，`chatContent` 只当"尾部"**，现有偏移 API 语义不变，只有 `streamStartOffset` 在封口那一刻需要平移。

---

## 四、技术方案

### 4.1 两层存储模型

```
TerminalUI
├── sealedSegments: ChatSegment[]   已封口，raw 不再变化
│     ├── { kind: "plain", raw }                     普通内容（提问、正文、命令输出……）
│     └── { kind: "fold",  raw, stats, expanded }    过程段
└── chatContent: string             尾部，仍在写入；writeChat / updateChatFrom /
                                    getChatLength / markStableChatPrefix 只作用于它
```

不变量：

- 每个 `sealed` 段的 `raw` 以 `\n` 结尾，并且段尾不残留未闭合的 SGR 样式（封口时若 `wrapAnsiWithState(raw, w).activeStyle` 非空，在末尾 `\n` 前补 `\x1b[0m`）。这样**各段独立换行再拼接 ≡ 整串换行**，与现有 `stableWrapPrefix` 的 `rows.slice(0, -1)` 是同一个技巧。
- 屏幕上的对话 = `sealedSegments` 依次渲染 + 尾部（+ `liveTail`）。

### 4.2 新模块 `packages/cli/src/process-fold.ts`（纯函数，可单测）

```ts
export type FoldToolCategory =
  | "read" | "search" | "edit" | "command" | "web"
  | "agent" | "task" | "skill" | "mcp" | "other";

export interface FoldGroupStats {
  /** 各类别计数（read / edit 已按路径去重）。 */
  counts: Partial<Record<FoldToolCategory, number>>;
  failed: number;
  rejected: number;
  /** 段内 reasoningContent 非空的迭代数。 */
  thinking: number;
}

/** 工具名 → 类别（2.2 表）。 */
export function categorizeFoldTool(toolName: string): FoldToolCategory;

/** 段统计收集器：turn-runner 与 /resume 共用。 */
export class FoldStatsCollector {
  addTool(toolName: string, args: Record<string, unknown>, status: "success" | "failed" | "rejected"): void;
  addThinking(): void;
  isEmpty(): boolean;
  snapshot(): FoldGroupStats;   // 返回拷贝
}

/** 摘要行（含缩进与配色），按 2.2 的降级顺序保证 terminalWidth ≤ width。 */
export function buildFoldHeader(stats: FoldGroupStats, width: number): string;

/** 拆出 raw 的首部空行、正文、尾部空行（"空行" = 去 ANSI 后为空白的行）。 */
export function splitBlankEdges(raw: string): { leading: string; body: string; trailing: string };

/** 段的可见文本（2.3 空行规则）；foldEnabled=false 时原样返回 raw。 */
export function renderSegmentText(
  segment: { kind: "plain" | "fold"; raw: string; stats?: FoldGroupStats; expanded?: boolean },
  width: number,
  foldEnabled: boolean,
): { text: string; headerRow?: number };   // headerRow：摘要行在本段换行后的行号
```

`headerRow` 的算法：`terminalRows(leading)`，即首部空行数。摘要行保证单行，所以不受换行影响。

### 4.3 TerminalUI 公开 API 变更（`terminal-input.ts`）

```ts
/** 开段：保证尾部处于行首（不在行首则补 "\n"），返回段起点句柄。非交互模式返回 undefined。 */
beginFoldGroup(): FoldGroupHandle | undefined;

/**
 * 封口：尾部 [0, handle.start) 作为 plain 段、[handle.start, end) 作为 fold 段推入 sealedSegments，
 * 尾部只保留 [end, …)。返回从尾部头部移走的字符数（= end），调用方据此平移自己持有的偏移。
 * handle 过期（epoch 不符）或 start ≥ end 时为空操作，返回 0。
 */
sealFoldGroup(handle: FoldGroupHandle, end: number, stats: FoldGroupStats): number;

/** /resume 用：整体替换为预先分好段的历史（最后一段 plain 进入尾部）。 */
replaceChatSegments(pieces: Array<{ kind: "plain" | "fold"; raw: string; stats?: FoldGroupStats }>): void;

setFoldEnabled(enabled: boolean): void;
isFoldEnabled(): boolean;

/** 单调递增：clearChat / replaceChat / replaceChatSegments / 尾部 200k 截断 / 封口时 +1。 */
getChatEpoch(): number;

// 删除：onExpandOutput(callback)（Ctrl+O 改由 TerminalUI 内部处理）
```

```ts
interface FoldGroupHandle { epoch: number; start: number }
```

内部字段：

```ts
private sealedSegments: ChatSegment[] = [];
private nextSegmentId = 1;
private foldEnabled = true;
private chatEpoch = 0;
/** 本帧 sealed 区摘要行的逻辑行号 → 段 id（render 时重建，点击命中用）。 */
private foldHeaderRows = new Map<number, number>();
/** 下一帧要应用的滚动锚点（见 4.4.6）。 */
private pendingScrollAnchor?: { segmentId: number; rowInSegment: number; screenOffset: number };

interface ChatSegment {
  id: number;
  kind: "plain" | "fold";
  raw: string;
  stats?: FoldGroupStats;
  expanded: boolean;
  /** 缓存键 `${width}|${expanded}|${foldEnabled}`，命中则直接复用 rows / layout。 */
  cacheKey?: string;
  rows?: string[];          // 去掉末尾空行后的换行结果
  layout?: AnsiTextLayout;  // 选区用，惰性计算
  headerRow?: number;
}
```

### 4.4 TerminalUI 内部改动

#### 4.4.1 写入路径

`writeChat` / `writeLine` / `writeBlankLine` / `updateChatFrom` / `getChatLength` / `markStableChatPrefix` **代码不改**，它们天然只作用于尾部 `chatContent`。尾部 200k 截断处（L912、L997）加 `this.chatEpoch++`。

`beginFoldGroup`：

```ts
if (!this.interactive) return undefined;
if (this.chatContent && !this.chatContent.endsWith("\n")) this.writeChat("\n");
return { epoch: this.chatEpoch, start: this.chatContent.length };
```

`sealFoldGroup`：

```ts
if (!this.interactive || handle.epoch !== this.chatEpoch) return 0;
const end = Math.min(endOffset, this.chatContent.length);
if (handle.start >= end) return 0;
const before = this.chatContent.slice(0, handle.start);
const group = this.chatContent.slice(handle.start, end);
if (before) this.pushSegment({ kind: "plain", raw: ensureTrailingNewline(before) });
this.pushSegment({ kind: "fold", raw: ensureTrailingNewline(group), stats, expanded: false });
this.chatContent = this.chatContent.slice(end);
this.chatEpoch++;
this.setStableWrapPrefix("");
this.cachedContentWithStatus = "";   // 尾部变了
this.selectionLayout = undefined;
this.textSelection.clear();          // 选区偏移基于旧文档，直接清掉
this.captureScrollAnchor();          // 用户上滚时保持视口，见 4.4.6
this.enforceSegmentBudget();
this.scheduleRender();
return end;
```

> `end` 处必然在行首：上一迭代的工具块之后有 `ui.writeLine()`（turn-runner L709），而 `streamStartOffset` 在其后取得。`ensureTrailingNewline` 只是兜底。

`enforceSegmentBudget`：`sum(raw.length) + chatContent.length > 200_000` 时从头丢弃整段，直到 ≤ 160_000，被丢弃的段若持有锚点则清掉锚点。

`clearChat` / `replaceChat`：额外清空 `sealedSegments`、`foldHeaderRows`、`pendingScrollAnchor`，并 `chatEpoch++`。

#### 4.4.2 渲染与换行缓存

改造 `render()` L2059–2072 与 `getWrappedChat`：

```ts
const sealedRows: string[] = [];
this.foldHeaderRows.clear();
for (const segment of this.sealedSegments) {
  const rows = this.getSegmentRows(segment, chatWidth);   // 命中 cacheKey 直接返回
  if (segment.kind === "fold" && segment.headerRow !== undefined && this.foldEnabled) {
    this.foldHeaderRows.set(sealedRows.length + segment.headerRow, segment.id);
  }
  // 用循环 push，不要用 push(...rows)：rows 很多时展开参数会爆栈
  for (const row of rows) sealedRows.push(row);
}
const tailRows = this.getWrappedChat(contentWithStatus, chatWidth); // 尾部，原逻辑不变
const wrappedChat = sealedRows.length ? sealedRows.concat(tailRows) : tailRows;
```

- `getSegmentRows`：`renderSegmentText` → `wrapAnsi(text, width)` → 去掉末尾空行 → 写入段缓存。宽度变化（`handleResize`）不必主动清缓存，`cacheKey` 不匹配时自然重算。
- 性能：封口时只给新段算一次换行；切换只重算一段；`sealedRows` 拼接是 O(行数) 的数组操作。如果 profile 显示拼接成为热点，再加"sealed 区整体 rows 缓存，任何段变化时置脏"。
- `getWrappedChat` 里 `contentWithStatus === this.chatContent` 时顺带生成选区布局的分支（L852–859）保留；它现在只覆盖尾部。

#### 4.4.3 行尾补白与用户消息底色

`fillUserMsgRowEol` / `highlightChatRow` 按 `visibleStart + index` 取逻辑行，sealed 区和尾部共用同一套逻辑行号，无需改动。

#### 4.4.4 选区布局

`getSelectionLayout()` 改为拼接：

```ts
document = sealed 各段 layout.document 依次拼接 + 尾部 layout.document
rows     = sealed 各段 layout.rows（去掉末尾空行，startOffset/endOffset 加上累计 document 长度）+ 尾部 rows（同样平移）
```

- 每段 `layout` 惰性计算并随段缓存，`cacheKey` 同 rows。
- `selectionLayoutContent !== this.chatContent` 的失效判断改为比较"sealed 版本号 + 尾部内容 + 宽度"（sealed 版本号在封口、切换、`setFoldEnabled`、丢段时 +1）。
- 折叠段只贡献可见文本（摘要行），所以**复制不会带出折叠起来的内容**。
- 在 `terminal-text.ts` 新增导出的 `concatAnsiLayouts(layouts: AnsiTextLayout[]): AnsiTextLayout`，并配一条"分段拼接 ≡ 整串布局"的单测（仿 `terminal-layout.test.mjs` 的 stable-prefix 用例）。

#### 4.4.5 点击命中

`handleMouseEvent` L1380 分支（单击松开）改为：

```ts
if (event.action === "up" && isLeftButton && this.pendingMouseSelection) {
  const pending = this.pendingMouseSelection;
  this.pendingMouseSelection = undefined;
  this.selectionPointer = undefined;
  this.selectionLayout = undefined;
  const segmentId = this.foldHeaderRows.get(pending.logicalRow);
  if (segmentId !== undefined && pending.row === event.row) {
    this.toggleFoldSegment(segmentId, pending.row - (this.chatViewport?.screenTop ?? 0));
  }
  return;
}
```

只有按下和松开都在**同一屏幕行**、并且是摘要行时才切换，避免误触。

`toggleFoldSegment(id, screenOffset)`：翻转 `expanded`，设置 `pendingScrollAnchor = { segmentId: id, rowInSegment: headerRow, screenOffset }`，sealed 版本号 +1，清选区，`scheduleRender(true)`。

#### 4.4.6 滚动锚定

`chatScrollOffset` 是距底部的行数，而切换 / 封口改的是中间的行数，L2067 的"底部增长"修正不适用。改为：

1. **锚点来源**
   - 切换：锚定被点的摘要行，`screenOffset` = 它在视口内的行位置。
   - 封口：仅当 `chatScrollOffset > 0`（用户正在往上翻）时，锚定当前视口首行（找到它所在的段与段内行号，`screenOffset = 0`）。如果首行落在尾部，锚点记为尾部首行之前的最后一个 sealed 行。
   - `chatScrollOffset === 0`（贴底）时封口不设锚点，继续贴底。
2. **应用**：render 拼出 `wrappedChat` 之后、计算 `maxChatScrollOffset` 之前：

```ts
if (this.pendingScrollAnchor) {
  const logical = segmentRowStart(anchor.segmentId) + Math.min(anchor.rowInSegment, segmentRowCount - 1);
  const desiredVisibleStart = Math.max(0, logical - anchor.screenOffset);
  this.chatScrollOffset = Math.max(0, wrappedChat.length - chatViewportHeight - desiredVisibleStart);
  this.pendingScrollAnchor = undefined;
  // 本帧跳过 L2067 的 wrappedRowDelta 修正
} else if (contentChanged && this.chatScrollOffset > 0 && tailRowDelta !== 0) {
  this.chatScrollOffset = Math.max(0, this.chatScrollOffset + tailRowDelta);   // 只用尾部的行数差
}
```

   - 锚点行在被折叠的段体内时（`rowInSegment` 超出折叠后的行数），钳到摘要行。
3. `wrappedRowDelta` 改成只统计尾部行数的变化（`tailRows.length` 前后差），sealed 区的变化一律走锚点。

#### 4.4.7 Ctrl+O

`dispatchKeypress` L1416：

```ts
if (isRealCtrlO(value, key) && !this.activeSelection) {
  this.toggleLatestFoldSegment();   // 从 sealedSegments 末尾往前找第一个 kind === "fold"
  return;
}
```

找不到，或 `foldEnabled === false` 时，`showTransientHint("暂无可展开的过程")`。锚点取该摘要行当前的屏幕位置；不在视口内时取 `screenOffset = 0`，展开后摘要行出现在视口顶部。删除 `onExpandOutputCallback` 字段与 `onExpandOutput()`。

#### 4.4.8 `setFoldEnabled`

翻转开关，sealed 版本号 +1（所有段 `cacheKey` 自然失效），锚定视口首行，`scheduleRender(true)`。关闭后 `foldHeaderRows` 为空，点击和 Ctrl+O 均不生效。

### 4.5 turn-runner 改动（`turn-runner.ts`）

```ts
// runAgentTurn 顶部，while 循环外（L316 附近）
let foldGroup: FoldGroupHandle | undefined;
let foldStats = new FoldStatsCollector();

// 迭代内：L366 const → let
let streamStartOffset = ui.getChatLength();

// 流式循环 L412 起，每个 chunk 追加到 textContent 之后、渲染之前：
if (foldGroup && textContent.trim()) {
  streamStartOffset -= ui.sealFoldGroup(foldGroup, streamStartOffset, foldStats.snapshot());
  foldGroup = undefined;
  foldStats = new FoldStatsCollector();
}
```

> 必须在第一次 `ui.updateChatFrom(streamStartOffset, …)` **之前**封口。`textContent.trim()` 用来跳过只有空白的首个 chunk。

开段与思考计数（L488，`shouldShowToolThinkingSummary` 之前）：

```ts
const hasValidToolCalls = Boolean(toolCalls && toolCalls.length > 0 && !invalidToolCall);
if (hasValidToolCalls) {
  if (!foldGroup) foldGroup = ui.beginFoldGroup();
  if (reasoningContent) foldStats.addThinking();
}
```

> `beginFoldGroup` 会先把未换行的正文补成整行，L560 的 `writeBlankLine()` 随后只写一个空行，视觉效果与今天一致。

工具统计（L652 结果循环内）：`BatchItemResult` 增加 `status?: ToolCellStatus`，在 `executeCall` 里取自 `summary.status`。

```ts
if (!result.skipped) {
  foldStats.addTool(toolName, args, result.unregistered ? "failed" : (result.status ?? "success"));
}
```

回合结束（L830 以后）**什么都不用做**：没封口的段就是尾部里的普通文本，保持展开。`foldGroup` 随函数作用域丢弃。

回合小结 `buildTurnSummary`（`terminal-panels.ts` L361）：`"N 次工具调用（Ctrl+O）"` 改为 `"N 次工具调用"`。同步更新 `terminal-panels.test.mjs` L154 的断言。

### 4.6 `/resume` 历史分段（`session-commands.ts` L109–159）

把 `historyOutput: string[]` 改为分段累积：

```ts
const pieces: Array<{ kind: "plain" | "fold"; raw: string; stats?: FoldGroupStats }> = [];
let plain = "";            // 当前 plain 缓冲
let group = "";            // 当前过程段缓冲（"" 表示未开段）
let collector = new FoldStatsCollector();
const flushPlain = () => { if (plain) pieces.push({ kind: "plain", raw: plain }); plain = ""; };
const sealGroup = () => {   // 遇到正文：过程段折叠
  flushPlain();
  pieces.push({ kind: "fold", raw: group, stats: collector.snapshot() });
  group = ""; collector = new FoldStatsCollector();
};
const abandonGroup = () => { plain += group; group = ""; collector = new FoldStatsCollector(); }; // 未被正文封口：保持展开
```

逐条消息：

| 消息 | 处理 |
| --- | --- |
| `user` | `abandonGroup()`；提问回显写入 `plain` |
| `assistant` 有 `content` | "深度思考 (N 字)"行写入 `group`（已开段时）或 `plain`；若已开段则 `sealGroup()`；正文写入 `plain` |
| `assistant` 有 `tool_calls` | 无 `content` 时，"深度思考"行写入 `group`；`group` 开段（为空时即开）；`reasoning_content` 非空则 `collector.addThinking()`；每个工具块写入 `group`，并 `collector.addTool(name, args, outcome.status)` |
| 结尾 | `abandonGroup(); flushPlain();` 然后 `ui.replaceChatSegments(pieces)` |

- 实时回合里正文先于工具块输出，所以同一条 assistant 消息"既有正文又有工具调用"时，先写正文（封口前一段），再开新段写工具块。这与实时显示一致。
- `resume-history.test.mjs` 是源码正则断言，它读取 `appendHistoryLine(colors.gray(\`深度思考 …\`))`。若改名写入函数，同步改这条断言。

### 4.7 偏好、命令与帮助

| 文件 | 改动 |
| --- | --- |
| `cli-runtime.ts` `Preferences` | 新增 `foldProcess?: boolean`，注释"对话区过程折叠；缺省视为开启（true）" |
| `index.ts` L893 附近 | `ui.setFoldEnabled(savedPreference?.foldProcess !== false);` |
| `index.ts` `/sidebar` 分支（L2586）旁 | 新增 `/fold [on\|off]`，写法照抄 `/sidebar`：参数校验 → `ui.setFoldEnabled` → `savePreference({...current, foldProcess})` → 提示"过程折叠已开启 / 已关闭" |
| `index.ts` L2454 附近持久化 | 注释补上 `foldProcess` 属于保留字段 |
| `cli-help.ts` `/config` 枢纽 members | 在 `/sidebar` 后加 `{ command: "/fold", description: "开关对话区过程折叠（工具调用 / 思考收成一行）", argHint: "[on\|off]" }` |
| `cli-help.ts` L630 快捷键 | `Ctrl+O` 描述改为"展开 / 收起最近一段过程" |
| `cli-help.ts` | 与 `/diff` 同组新增 `{ command: "/output", description: "查看最后一批工具调用的完整输出" }` |
| `index.ts` L1470–1493 | `ui.onExpandOutput(...)` 回调体原样搬进 `/output` 命令分支（保留 `foregroundAbortSignal` 判断，回合进行中提示稍后再试）；`lastToolBatchOutputs` 与 `setLastToolBatchOutputs` 保持不变 |
| `README.md` L88 | "按 `Ctrl+O` 展开最后一批工具调用的完整输出"改为：已完成的过程自动收成一行，点击或 `Ctrl+O` 展开；完整输出用 `/output` |
| `ARCHITECTURE.md` "TUI 与渲染" | 增加一条：`process-fold.ts` 和 TerminalUI 的两层存储（sealed 段 + 尾部） |

### 4.8 为什么 Ctrl+O 迁移

Claude Code 的 Ctrl+O 是"展开详情"，和过程折叠是同一类操作。原来的"完整工具输出"是低频的调试用途，改成显式的 `/output` 命令更好发现，也不会和折叠抢键。

---

## 五、测试计划

所有测试 import `../dist/*.js`，跑之前先 `pnpm run build`。

### 5.1 `packages/cli/test/process-fold.test.mjs`（新增，纯函数）

1. `categorizeFoldTool`：2.2 表里每个工具名、`mcp_x_y`、未知名 → `other`。
2. `FoldStatsCollector`：同一 path 重复 read 只计 1；edit + write 同一 path 计 1；无 path 的 read 按调用计；failed / rejected 计数；skipped 由调用方过滤，不需要测。
3. `buildFoldHeader`：
   - 完整格式的文本（去 ANSI 后断言）；
   - `thinking === 0` 时不出现"思考"；
   - 宽度递减时依次触发 2.2 的降级步骤 1→5，每一步都满足 `terminalWidth ≤ width`；
   - 有失败时 `●` 为红色（断言包含对应 SGR）。
4. `splitBlankEdges` / `renderSegmentText`：首尾空行保留；折叠 / 展开 / `foldEnabled=false` 三种形态；`headerRow` 等于首部空行数。

### 5.2 `packages/cli/test/terminal-layout.test.mjs`（追加）

5. `concatAnsiLayouts`：分段拼接的 `document` 和 `rows`（含 offset）与整串 `layoutAnsiDocument` 完全一致，覆盖跨段颜色已复位、宽字符、空段。

### 5.3 `packages/cli/test/process-fold-ui.test.mjs`（新增，TerminalUI 集成）

用 `terminal-layout.test.mjs` 的 `createTerminalUI()` 构造，直接置 `ui.interactive = true` 强制交互模式（`terminal-frame.test.mjs` L73 的做法）；如需读取 sealed 区可见行，只给 TerminalUI 加 `/** @internal 测试用 */` 访问器，不改公开行为。

6. **封口偏移**：写入"提问\n" → `beginFoldGroup` → 写两个工具块 → `sealFoldGroup(h, len)` 的返回值等于 `len`；之后 `getChatLength() === 0`；继续 `updateChatFrom(0, "正文")` 只影响尾部。
7. **渲染**：`foldEnabled` 时可见行包含摘要、不包含工具块原文；`toggle` 后包含；`setFoldEnabled(false)` 后与"从未封口"时的整串渲染逐行相等（**回归基准**：关闭折叠 = 今天的显示）。
8. **epoch**：`clearChat()` 之后用旧 handle 封口返回 0，内容不变。
9. **点击命中**：构造 mouse down/up（同一行）事件 → 段 `expanded` 翻转；down/up 不同行或中间有拖动 → 不翻转。
10. **锚点**：视口上滚状态下切换某段，摘要行的屏幕位置不变；贴底状态下封口仍贴底。
11. **预算**：sealed + 尾部超过 200k 时丢的是整段，且剩余 ≤ 160k。

### 5.4 回合级

12. `turn-lifecycle.test.mjs` / `ux-improvements.test.mjs` 若有对回合输出的整串断言，按新的分段结果更新。注意 `HAJI_POST_EDIT_VERIFY` 会真跑 tsc，涉及真实回合时设为 `0`。
13. `headless.test.mjs`：`haji -p` 的 stdout 不变（本方案在非交互下全部空操作，原用例应原样通过，不需要改）。

### 5.5 手测清单

- 多段过程：读 → 写正文 → 编辑 + 跑命令 → 写正文 → 结束，确认两段各自折叠、正文都可见。
- 流式中途：模型开始写第二段正文的那一刻，第一段收起，且流式正文不闪、不错位。
- 中止（Esc）在工具执行中 → 最后一段保持展开。
- 上滚阅读时，底部封口不把视口拽走；点击展开时被点的行不跳。
- 拖选跨越折叠摘要行复制 → 只复制可见文本。
- 窗口缩放 → 摘要行仍单行；展开后的工具块保持写入时的宽度（与今天一致）。
- `/resume` 一个含多轮工具调用的会话 → 历史各段默认收起。
- `/fold off` → 与改动前截图一致；`/fold on` → 已有段重新收起。
- Windows Terminal、iTerm2、VS Code 终端各点一次（鼠标上报差异）。

---

## 六、实施步骤与提交拆分

| 步骤 | 内容 | 验收 |
| --- | --- | --- |
| 1 | `process-fold.ts` 纯函数 + `concatAnsiLayouts` + 5.1 / 5.2 测试 | `pnpm test` 绿 |
| 2 | TerminalUI 两层存储：`sealedSegments`、`beginFoldGroup` / `sealFoldGroup` / `replaceChatSegments` / epoch / 渲染拼接 / 选区拼接 / 预算；**暂不接入 turn-runner** | 现有全部测试不改即通过（尾部语义未变）；5.3 的 6/7/8/11 |
| 3 | turn-runner 接入（开段、统计、封口平移）+ `buildTurnSummary` 文案 | 手测多段过程、流式不闪 |
| 4 | 点击命中 + 滚动锚定 + Ctrl+O 迁移 + `/output` | 5.3 的 9/10，手测锚点 |
| 5 | `/resume` 分段 + `/fold` 偏好与命令 + 帮助 / README / ARCHITECTURE | 手测 resume 与开关 |

每次提交前：

```bash
pnpm run build
pnpm test
pnpm exec biome check <改动文件>
```

发版时按 AGENTS.md 同步三处 version，并核对 `haji --version`。

---

## 七、风险与已知限制

| 风险 | 说明 / 对策 |
| --- | --- |
| 封口时机与流式重绘交错 | 封口只发生在第一次 `updateChatFrom(streamStartOffset, …)` 之前，且返回值同步平移 `streamStartOffset`；用例 6 覆盖 |
| 异步写入落在过程段里 | 后台子代理的告警可能恰好在开段后写入，会随段折叠。属可接受偏差；如果介意，后续可让后台通知走单独的 plain 段（写入前先把尾部封成 plain） |
| `lastCommandEcho` 跨封口失效 | 封口只发生在回合中，枢纽转发发生在指令之间，不会交错；保险起见给它加 `epoch` 字段，`epoch !== ui.getChatEpoch()` 时视为无效 |
| 工具块宽度在写入时固定 | 与今天一致（`formatToolCell` 在 commit 时按当时宽度 `fitText`）；展开后宽度不随缩放变化。若要改，需要把工具块数据而非字符串存进段，不在本期 |
| 大会话下 sealed 区行拼接开销 | 先按 4.4.2 的简单拼接实现，用 `/perf` 观察 `terminal.wrap.*`；必要时加 sealed 区整体缓存 |
| 终端不上报鼠标 / 用户关了鼠标模式 | Ctrl+O 兜底；`/fold off` 恢复今天的样式 |
