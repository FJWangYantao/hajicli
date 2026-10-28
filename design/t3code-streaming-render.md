# T3 Code 流式渲染拆解

> 源码：`pingdotgg/t3code`（MIT），commit `07f7f97`（2026-10-28）。稀疏克隆只取 `apps/web`、`apps/desktop`、`apps/server`、`packages`。
> 本文只讨论 **assistant 消息一边增长一边被渲染成 Markdown** 这条链路，主要文件：
>
> - `apps/web/src/markdown-incremental.ts`（增量 Markdown 解析插件）
> - `apps/web/src/lib/incrementalHighlighting.ts`（流式 Shiki 高亮）
> - `apps/web/src/components/ChatMarkdown.tsx`（渲染入口）
> - `apps/web/src/components/chat/MarkdownCodeBlock.tsx`（代码块渲染与缓存）
> - `apps/web/src/components/chat/MarkdownCodeBlock.logic.ts`（围栏闭合判定）
> - `apps/web/src/components/chat/MessagesTimeline.tsx`（时间线虚拟列表）
> - `apps/web/src/components/chat/useTimelineFollow.ts`（跟随滚动）
> - `apps/web/src/components/chat/timelineScrollAnchoring.ts`（滚动模式与锚点）
> - `apps/web/src/index.css`（流式淡入动画）

---

## 1. 一句话结论

T3 Code 的流式观感不是靠"打字机"打磨出来的：**没有任何字符级平滑/限速实现**（`typewriter`、`smoothStream`、逐帧吐字之类 grep 全无）。它的顺来自四件事叠加：

1. **三层增量化**——Markdown AST 增量解析、代码高亮增量 tokenize、DOM 行节点身份保持，让每个 chunk 的成本与"新增内容"成正比，而不是与"全文长度"成正比；
2. **块级淡入**——新插入的段落/代码块用 CSS `@starting-style` 淡入 600ms，掩盖 chunk 的"跳变"，且零布局开销；
3. **流式期降级**——未闭合的代码围栏不当作成品、流式期间禁用"在终端运行"之类动作；
4. **虚拟列表 + 滚动锚定**——`@legendapp/list` 虚拟化 + 自建 follow 状态机，长会话滚动不抖。

真正的技术含量在第 1 条，其余是工程细节的累积。

---

## 2. 增量 Markdown 解析（核心）

普通实现是每个 chunk 都 `remark` 全量重解析，文本越长越慢。这里缓存**一个"语义已完成"的前缀**，下次只解析尾部。

### 2.1 缓存点的选取

`markdown-incremental.ts:55-77`：只在"**闭合的代码围栏 + 其后一个空行**"处落缓存，其它位置一律不切（段落、列表、表格都可能被后续文本改写）：

```ts
const closing = new RegExp(`^ {0,3}${opening[0]}{${opening.length},}[ \\t]*$`);
const separator = /^\n[ \t]*\n/.exec(source.slice(end))?.[0];
if (!closing.test(lastLine) || !separator) continue;
const offset = end + separator.length;
cached = {
  source: source.slice(0, offset),
  offset,
  line: node.position!.end.line + 2,
  children: structuredClone(root.children.slice(0, index + 1)),
};
```

注意 `line: node.position!.end.line + 2`——围栏结束后还跨了空行，行号要 +2，否则后续增量 AST 的 line 全偏。

### 2.2 增量拼接

`markdown-incremental.ts:41-49`：

```ts
const prefix = cached && source.startsWith(cached.source) ? cached : undefined;
if (prefix) {
  root = parse(source.slice(prefix.offset), file);
  if (hasDefinitions(root)) return parse(source, file);
  shiftPositions(root, prefix.offset, prefix.line - 1);
  if (root.position) root.position.start = { line: 1, column: 1, offset: 0 };
  // Remark mutates nodes; give each render a clone of the pristine cache.
  root.children.unshift(...structuredClone(prefix.children));
}
```

四个必须做对的地方：

- **`shiftPositions`**（`:21-31`）：增量解析出的 AST，其 `position.offset/line` 是相对后缀的，必须整体平移回全文坐标系，否则任何依赖 position 的功能（源码映射、行内改写、点击定位）都会错位。
- **`structuredClone` 缓存节点**（`:49`）：remark 后续插件会 **mutate** 节点，直接复用缓存对象会让下一次渲染拿到被污染的 AST。这是最容易踩的坑。
- **位置重置**：根节点 `start` 强制设回 `{1,1,0}`。
- **`startsWith` 校验**（`:41`）：前缀不是当前文本的前缀（消息被整体替换/重放）就丢弃缓存，退化为全量。

### 2.3 失效条件（全部显式）

| 条件 | 位置 | 原因 |
|---|---|---|
| 文本含 `\r` | `:38-39` | 流式 CR 可能变 CRLF，单独解析后缀会丢掉内部 BOM |
| 文本含 `\uFEFF` | `:38-39` | 同上 |
| 前缀不匹配 | `:41` | 内容被替换 |
| 出现 `definition` / `footnoteDefinition` | `:13-19`、`:45`、`:52` | 定义可被文档任意位置引用，增量解析会算错 |

### 2.4 只在合适的时候启用

`ChatMarkdown.tsx:1631-1634`：

```ts
const incrementalParsing =
  props.isStreaming === true &&
  extraRemarkPlugins.length === 0 &&
  /(?:^|\n) {0,3}(?:`{3}|~{3})/.test(text);
```

三个门槛：必须正在流式、没有额外 remark 插件（插件顺序/状态会破坏缓存假设）、且文本里已出现开头代码围栏（没有围栏就没有缓存点）。

`markdown-incremental.ts:90-96` 还处理了一个隐蔽问题——ReactMarkdown 会做**第二次** parse（recovery 文本），缓存只允许第一次 parse 访问：

```ts
let documentParsed = false;
this.parser = (source, file) => {
  if (documentParsed) return original(source, file);
  documentParsed = true;
  return parseDocument(source, file);
};
```

---

## 3. 代码块增量高亮

`incrementalHighlighting.ts:57-108`，用 `@pierre/diffs` 的流式 tokenizer，而不是每次 `codeToHtml`：

```ts
const update = tokenizer.enqueue(code.slice(previous.length));
...
for (const token of update.stable) {
  if (token.content === "\n") { completedLines.push(...renderTokenLines([line], {})); line = []; }
  else line.push(token);
}
// Completed line nodes retain their identity while the final line changes.
return highlightedDocument(shell, [...completedLines, ...renderTokenLines([update.unstable], {})]);
```

关键点：

- tokenizer 把输出分成 **stable / unstable**：只有末尾未完成行会变，之前所有行的 HAST 节点引用保持不变 → React diff 几乎零成本，也不会整块 `innerHTML` 重刷（重刷会清掉用户的文本选择）。
- 每次调用前校验 `code.startsWith(previous)`，不成立就 `dispose()` 重建（`:82`）。
- 兜底：`language === "ansi"`、文本含 `\r`、或 `enqueue` 返回 Promise（异步 tokenizer）时，直接退回全量 `highlightCodeToHast`（`:78-91`）。正确性优先于性能。

---

## 4. 流式结束后的"冻结"

`MarkdownCodeBlock.tsx:283-310`：

```ts
const [hasStreamed, setHasStreamed] = useState(isStreaming);
if (isStreaming && !hasStreamed) setHasStreamed(true);
// Once lines are mounted individually, keep that renderer when streaming
// finishes so switching to cached HTML cannot clear an existing selection.
const cachedHighlightedHtml = !isStreaming && !hasStreamed ? highlightedCodeCache.get(cacheKey) : null;
```

语义是：**流式过的代码块**结束后仍走逐行渲染器（`preserveLines`），只有**从未流式过**（例如打开历史线程）才用缓存的整块 HTML。这避免了"流式结束瞬间切到 cached HTML → 选择被清空、节点重建"的抖动。

缓存策略（`:35`、`:353-361`）：`highlightedCodeCache` 是 LRU，key = `code + language + theme`，容量按 `estimateHighlightedSize(html, code)` 估算计费，且只缓存**已完成**的块。

---

## 5. 流式期的降级：不要把半成品当成品

`ChatMarkdown.tsx:1588-1606`：

```tsx
isStreaming={isStreaming && !isClosedCodeFence(node, text, codeBlock.code)}
...
onRunShellCommand={
  onRunShellCommand && !isStreaming && isClosedCodeFence(node, text, codeBlock.code)
    ? onRunShellCommand
    : undefined
}
```

- 围栏还没闭合（`isClosedCodeFence`，`MarkdownCodeBlock.logic.ts:44`）时，不告诉子组件"这块已完成"，从而不触发完成态行为；
- 流式期间不显示"Run in terminal"，避免用户点到只有半条命令的代码块。

---

## 6. 视觉平滑：块级淡入，不是打字机

`index.css:2179-2194`：

```css
/* Paragraphs and code blocks arrive in chunks while a response streams. Fade
   each new block in so the chunk does not pop. @starting-style only applies
   when an element is first inserted, and the rule is gated on data-streaming,
   so opening a finished thread never replays the fade. Opacity only, one
   shot, no layout change. */
@media (prefers-reduced-motion: no-preference) {
  .chat-markdown[data-streaming] > * {
    transition: opacity 600ms ease-out;
    @starting-style { opacity: 0; }
  }
}
```

三个设计约束值得照抄：

1. **只有 `opacity`**：不触发布局/绘制重算，不会引起滚动高度变化；
2. **`@starting-style`**：只在元素首次插入时生效，后续 chunk 更新不会反复淡入；
3. **`data-streaming` 门控**（`ChatMarkdown.tsx:1656`）：只有"正在流式"的容器才有动画，打开历史线程不会重播；并尊重 `prefers-reduced-motion`。

---

## 7. 列表与滚动：不抖动的来源

- **虚拟化**：`@legendapp/list` 的 `LegendList`（`MessagesTimeline.tsx:45, 1337`），行组件 `TimelineRowContent` 用 `memo` 包裹（`:1455`），外层 `ConversationTimeline` 也 `memo`（`:317`）。
- **按文本长度分桶 item type**（`MessagesTimeline.tsx:1448-1452`）——容易被忽略但很有效：

  ```ts
  // LegendList averages by type; length buckets prevent inflated estimates and nested-update loops.
  const lengthBucket = Math.max(0, Math.floor(Math.log2(item.message.text.length / 1000)));
  return `message:${item.message.role}:${lengthBucket}`;
  ```

  虚拟列表按 item type 估计行高，流式消息越写越长会污染"平均高度"，导致滚动条乱跳/反复校正。分桶让估计值稳定。
- **跟随滚动用外部 store + `useSyncExternalStore`**（`useTimelineFollow.ts:103-120`）：follow 状态在滚动事件回调里按事件时刻读取（`read(visit)`），渲染时通过订阅取快照；状态还带 `visit`（一次进入线程的访问），线程切换时旧状态自动失效，不需要重置。
- **三种滚动模式**：`following-end` / `anchoring-new-turn` / `free-scrolling`（`timelineScrollAnchoring.ts:40`），新一轮开始时走锚点定位而不是盲目滚到底。
- **`Debouncer` 只用于延迟"滚到底"气泡的显示**（`useTimelineFollow.ts:69-72`，150ms），隐藏立即。即：跟手不加延迟，提示不闪。
- `MessagesTimeline.tsx:285` 还有一条：读历史时主动禁用列表的"贴底重钉"（`initialScrollAtEnd` 相关），避免用户上翻被拉回。

---

## 8. 重渲染控制

- `ChatMarkdown` 整体 `memo`（`ChatMarkdown.tsx:1683`）。
- 配置类状态不直接用 atom，而是套一层"字段相等就返回旧引用"的 `Atom.family`，注释写明目的（`ChatMarkdown.tsx:427-434`）：
  *"Compare only markdown config fields to avoid rerendering replies on every provider status push."*
  即 provider 状态高频推送，但消息渲染不跟着重渲染。
- **React Compiler 已开启**：`apps/web/vite.config.ts:282` → `react({ compiler: true })`，并有 `reactCompilerCoverage.test.ts` 守着覆盖率。这解释了为何业务代码里少见手写 `useMemo/useCallback`。

---

## 9. 数据面（只做入口确认，未逐条追 schema）

- 传输是 **WebSocket**（Effect 生态）：`packages/client-runtime/src/connection/compatibility.ts:37` 的 `appendOrchestrationProtocol`，URL 上带 `wsTicket`、`connectionMethod=relay`、`orchestrationProtocol`。
- 流用 Effect `Stream` 组合：`packages/client-runtime/src/state/environmentStreams.ts` 的 `runStreamInEnvironment` / `followStreamInEnvironment`。
- 服务端在 `apps/server/src/orchestration-v2/Adapters/*AdapterV2.ts` 把各家 provider 事件归一化（如 `ClaudeAdapterV2.ts:1807` 的 `assistantTextFromSdkMessage`）。这些 adapter 单文件数千行，本次未逐条追事件 schema。
- 客户端状态层未发现"每 chunk 都 rAF 合并"的特殊处理；合并主要发生在渲染侧（增量解析 + 行身份保持），不是数据侧。

---

## 10. 若要迁移到 hajicli，按性价比排序

1. **增量 Markdown 解析**——收益最大、最难自己写对。移植时必须同时带上：position 平移、`structuredClone` 防腐、definition 失效、`\r`/BOM 退化、只用于第一次 parse。
2. **流式高亮的分行渲染**（stable/unstable 切分 + 行节点身份保持）——TUI 不直接适用，但"只重算最后一行、已完成行复用"可平移到终端行渲染。
3. **块级淡入（约 20 行 CSS）**——Web 端即时见效；终端侧对应"新行追加不整屏重绘"，与本仓库已有的 `getSegmentRows()` / `wrapAnsi()` 收口思路一致。
4. **虚拟列表按长度分桶**——长会话滚动稳定性。

---

## 11. 本文的验证边界

- 所有 `文件:行号` 均来自 commit `07f7f97` 的实际读取，代码片段为原文摘录。
- **未验证**：服务端事件 schema 的完整字段、v1/v2 两套 orchestration 的差异、断线重连与续传语义。若后续要照搬协议层，需要单独拆解。
- 曾用子代理并行调研，两次都因范围过大超出 token 预算失败；本文结论均为主代理直接读码所得。
