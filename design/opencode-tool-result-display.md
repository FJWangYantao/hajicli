# OpenCode 工具结果展示拆解

> 源码：`anomalyco/opencode`，tag/版本 `2.1.4`，commit `1743d1a`（2026-10-25）。
> 本文只讨论 **TUI 会话流里工具调用的渲染**，主要文件：
>
> - `packages/tui/src/routes/session/index.tsx`（各工具渲染器、InlineTool / BlockTool）
> - `packages/tui/src/routes/session/message-parts.tsx`（InlineToolRow、ReasoningPart、TextPart）
> - `packages/tui/src/routes/session/group-view.tsx`（分组折叠头）
> - `packages/tui/src/routes/session/grouping/session.ts` + `grouping/tree.ts`（分组树）
> - `packages/tui/src/routes/session/activity-summary.ts`（低噪音摘要）
> - `packages/tui/src/util/collapse-tool-output.ts`（折叠算法）
> - `packages/tui/src/util/tool-display.ts`（工具名归一化、元数据读取）
> - `packages/core/src/tool-output.ts`（服务端截断）

---

## 1. 一句话结论

OpenCode 的工具结果之所以"舒服"，不是靠花哨组件，而是把四件事做彻底：

1. **一行交代"做了什么"**：工具调用的默认形态是一行，图标 + 动词 + 关键参数，完成态不重复刷屏。
2. **结果按"信息密度"分层**：读/搜/找只给一行；写/改给代码块和 diff；命令给"命令 + 尾部输出"；未知工具给一行摘要 + 手动展开。
3. **连续动作自动折叠成摘要**：`Explored: 2 reads, 1 search`、`3 commands, 1 edit, 2 thoughts`，把"过程"压成"结果"。
4. **失败、权限、后台、截断都有固定位置和颜色**：不新增行、不改变布局，点一下才展开细节。

它本质是一个**为终端设计的"工具结果排版系统"**，而不是"把 stdout 打到屏幕上"。

---

## 2. 三个渲染层级

所有工具最终落到三种视觉容器之一，选择标准非常清晰。

### 2.1 Inline（单行）——默认真实形态

用于"参数本身就是结果摘要"的工具：`read`、`glob`、`grep`、`webfetch`、`websearch`、`skill`、`subagent`、`generic`，以及还没产出内容的 `todo` / `question`（完成后它们会升级成块）。

```
→ Read packages/tui/src/routes/session/index.tsx:1-120
✱ Grep "collapseToolOutput" in packages/tui (3 matches)
✱ Glob "**/*.test.ts" in packages/tui (12 matches)
% WebFetch https://example.com/docs
◈ Web Search via Exa "solid-js fine grained reactivity"
✓ custom.check [path=src/a.ts, strict=true]
```

关键点：

- 左边永远留 **2 列图标位**（`INLINE_TOOL_ICON_WIDTH = 2`），整体再统一 `paddingLeft={3}`。
- 运行中不是加一行，而是**同一行**换成 spinner + 进行时文案：`Reading file…`、`Finding files…`、`Searching content…`、`Delegating…`。
- 完成态只显示"动词 + 参数 + 计数"，**不显示工具原始输出**。计数来自 `metadata`，不是去解析输出文本。
- 失败时同一行换成 `✗` + 红字；权限被拒则整行加删除线（`STRIKETHROUGH`），而不是弹错误。

### 2.2 Block（块）——有"内容体积"的结果

用于 `shell`、`write`、`edit`、`apply_patch`、完成态的 `todowrite` / `question`。

统一样式（`BlockTool`）：

- 左侧一条竖线（`border={["left"]}`，自定义字符，弱色）
- 一个略亮的背景（`theme.background.raised`），hover 时再降一档亮度
- 顶部一行"标签 + 路径"：`# Wrote`、`← Edit`、`# Created`、`# Deleted`、`← Patched`、`# Todos`、`# Questions`
- 内容区放代码/diff/清单
- 错误信息固定在块底部一行红字
- 整块可点击（展开/打开详情），但**有文本选区时不触发点击**

```
 ← Edit src/routes/session/index.tsx
   42 - const x = foo()
   42 + const x = bar()
```

### 2.3 Generic（兜底）

未知工具不猜语义，固定格式：

```
✓ my_mcp_tool [path=src/a.ts, depth=2]
```

- 参数只取 `string | number | boolean`，拼成 `[k=v, k=v]`
- 点击展开成逐行 `key: value`（对象用 2 空格 JSON），末尾可选 `output: ...`
- 没有参数也没有输出时，行不可点击（`expandable` 为 false）

**借鉴价值**：先保证"任何工具都有一行可读摘要"，再给少数高频工具做专属渲染。不要反过来。

---

## 3. 各工具的"结果语言"

| 工具 | 运行中 | 完成 | 结果呈现 |
| --- | --- | --- | --- |
| `read` | `Reading file…` | `→ Read path:1-120` | 额外把 `metadata.loaded` 的文件渲染成 `↳ Loaded ...`，提示"这次读触发了哪些上下文" |
| `glob` | `Finding files…` | `✱ Glob "pat" in dir (N matches)` | 只给计数，不列文件 |
| `grep` | `Searching content…` | `✱ Grep "pat" in dir (N matches)` | 只给计数 |
| `webfetch` | `Fetching from the web…` | `% WebFetch url` | 不展示正文 |
| `websearch` | `Searching web…` | `◈ Web Search via Provider "query"` | provider 名字带动画，强调来源 |
| `write` | `← Write path` | 块：`# Wrote` + 全文代码 + diagnostics | 写文件属于"有体积"的变更，必须给内容 |
| `edit` | 块：`# Preparing edit…` 或路径 | 块：`← Edit` + patch diff | 支持 `split` / `unified`，宽度 > 120 默认 split |
| `apply_patch` | `Patching` / `# Patch failed` | 每文件一个块，`# Created` / `# Deleted` / `← Patched` | 删除文件只显示 `-N lines`，不画 diff |
| `shell` | spinner + `$ cmd` | 块：`$ cmd` + 尾部输出 | 见第 4 节 |
| `subagent` | `│` + `Delegating…` | `✓ Agent Subagent — 描述 · model` | 点击跳到子会话；续跑用 `↳`；后台加 `Background` 徽标 |
| `execute` | `│ execute` | `✓ execute` + 每个嵌套调用一行 `› tool [args]` | 失败时附 4 行错误输出预览，点击开详情弹窗 |
| `todowrite` | `⚙ Updating todos…` | 块：`# Todos` + 勾选清单 | 没内容时退化成 `Cleared todos` |
| `question` | `→ Asking questions…` | 块：`# Questions` + 问题/答案 | 永远单独成组，不并入活动摘要 |
| `skill` | `Loading skill…` | `→ Skill "name"` | 一行 |

一眼能看出的设计取向：

- **"计数"是结果的一等公民**：`N matches`、`N files`、`N questions`。
- **不把模型的"输入参数"当输出炫耀**：除了 diff / 写入内容 / 命令，其余工具绝不展开原始返回。
- **可跳转的结果给入口**：subagent 点击进子会话，图片点击开预览，execute 点击开详情。

---

## 4. Shell：终端里最难的一块，它怎么做

Shell 是唯一同时有"命令、stdout、stderr、退出码、可能还在跑"的工具。OpenCode 的处理顺序值得直接抄：

### 4.1 命令永远带 `$`

```
$ npm test

...最后 8 行输出...
(37 earlier lines)
```

- 非运行态命令前缀 `$ `；运行态不显示 `$`，让 spinner 占位。
- `workdir` 不是 `.` 时，自动拼 `cd <dir> && `。
- 命令最多 2 行，按**字符宽度**折行（`wrapMode="char"`），展开后变 `word`。

### 4.2 输出是"看尾巴"，不是"看开头"

通用工具输出截断是**保头**（`slice(0, maxLines)`），shell 特意改成**保尾**：

```ts
// collapse-tool-output.ts
collapseToolOutput(output, maxLines, maxChars) // 通用：保头
collapseShellOutput(input, output, maxLines, maxChars) // shell：命令 + 输出尾部
```

- 展示预算：`maxLines = 10`，`maxChars = 10 × max(20, 终端宽度 − 6)`（运行中再扣 2 列给 spinner）。
- 输出溢出时显示 `(N earlier lines)`，然后接最后几行。
- 行数、字符数同时约束；按 **grapheme / 显示宽度** 截断（`stringWidth`），对中文、emoji 安全。
- 展开后看全文；`props.shellID` 存在时，展开会去服务端拉完整输出。

**为什么重要**：命令的错误几乎总在最后几行。保头截断会把最关键的报错切掉，这是很多 CLI 工具结果"看着难受"的根因。

### 4.3 后台命令单独一条流

- 命令结束但进程还在跑（`metadata.status === "running"`）→ 打 `Background` 徽标。
- 前端每 1s 轮询 `client.api.shell.output({ id, cursor, limit })`，游标增量拉取。
- 前端最多保留最后 **1 MiB**（`SHELL_DISPLAY_LIMIT`），超了显示 `[earlier output omitted]`。
- 折叠时不轮询；展开才拉；进程结束时再 drain 一次，确保尾巴完整。

### 4.4 退出码/错误不抢戏

`shell` 的错误信息走 `BlockTool` 底部那一行，颜色切到 error；不额外插入"Command failed with exit code 1"的整段噪音。模型需要的完整错误在工具结果里，人需要的只是"这行红了、点开看"。

---

## 5. 折叠：不是 CSS，是内容预算

`collapse-tool-output.ts` 只有 95 行，但把"终端排版"的边界情况想全了：

```ts
collapseToolOutput(output, maxLines, maxChars)
```

1. 行数和字符数都达标 → 原样返回，`overflow: false`。
2. 超行 → 取前 `maxLines` 行，最后一行补 `…`。
3. 还超字符 → 按 `Array.from`（码点）截到 `maxChars - 1`，补 `…`。
4. shell 专用 `collapseShellOutput`：
   - 先给命令留 2 行预算；
   - 输出预算 = 总行数 − 命令行数 − 1，字符同理；
   - 输出用 `collapseTail`：`(N earlier lines)` + 尾部内容；
   - 命令本身按显示宽度折行，超了补 `…`。

配套的展示规则：

| 场景 | 预算 |
| --- | --- |
| shell 折叠 | 10 行 / `10 × max(20, 宽 − 6)` 字符（运行中再减 2） |
| shell 命令折叠 | 最多 2 行，按字符宽折行 |
| execute 错误输出 | 4 行 / `4 × (宽 − 6)` 字符 |
| 前端 shell 流缓存 | 1 MiB，超出保留尾部 |
| 服务端工具输出 | 2000 行 / 50 KiB |

---

## 6. 服务端先截断，客户端只排版

这是"结果展示"和"结果传输"分离的关键。

`packages/core/src/tool-output.ts`：

- 阈值：`MAX_LINES = 2000`、`MAX_BYTES = 50 KiB`（可按配置覆盖）。
- 超限时：
  - 完整输出写到 `tool-output/tool_<id>`（保留 7 天）；
  - 返回内容只保留前 N 行/字节；
  - 末尾追加一条人可读标记：
    ```
    [showing lines 1-2000 of 8123; full output saved to /path/to/tool_xxx]
    ```
  - `metadata.truncated = true`、`metadata.outputPath = file`。
- 若工具自己已经声明 `metadata.truncated`，不再二次截断。

这带来两个好处：

1. **模型拿到的是有界结果**，不会因为一条 `cat` 把上下文打爆。
2. **人拿到的是可追溯的路径**，需要时自己去翻完整文件；TUI 不需要为了"完整"而做复杂分页。

客户端只做三层：`stripAnsi` → 折叠 → 语法高亮/diff 渲染。

---

## 7. 分组：把"N 次工具调用"压成"N 个动作"

### 7.1 四种组

`grouping/session.ts`：

```ts
type GroupKind = "activity" | "reasoning" | "exploration" | "instructions"
```

| 组 | 成员 | 触发 |
| --- | --- | --- |
| `reasoning` | 连续思考块 | `thinkingMode === "hide"` 时折叠成一行；否则按普通思考块显示 |
| `exploration` | `read` / `glob` / `grep` / `webfetch` / `websearch` | 连续出现即合并 |
| `instructions` | 加载 `AGENTS.md` 等指令文件的 synthetic message | 连续出现即合并，按不同文件数计数 |
| `activity` | 以上所有 + 其他工具 | 仅 `verbosity = "low"` 时启用 |

`question` 永远不分组——它需要人回答，必须独立可见。

### 7.2 组头本身就是一条 inline 工具行

不是标题栏、不是缩进块，而是和普通工具完全同构的一行，因此视觉上不会"跳层级"：

```
+ Thought: 分析工具折叠策略 · 4 steps · 12.3s
* Explored: 3 reads, 2 searches
+ 3 commands, 1 edit, 2 thoughts, 4 reads
```

- 展开/收起图标在行首：`+` / `-`（activity 用 `−`）。
- 运行中：spinner + `Exploring: ...` / 首个运行项的 `Running command…`。
- 点击整行切换；**有文本选区时不切换**（`renderer.getSelection()?.getSelectedText()`）。
- 展开状态按 `groupID(node, level)` 记忆，滚动/重渲染不丢。

### 7.3 摘要文案的两套规则

**Medium（默认）**：按组内类别计数。

```
Explored: 2 reads, 1 search
Thought: <最后一条思考的标题> · 5 steps · 8.4s
Instructions: 3 files
```

**Low**：所有东西收进一个 activity 组，按动作类型计数（`activity-summary.ts`）：

```
3 commands, 1 edit, 2 thoughts, 4 reads, 1 tool, 2 instructions
```

计数规则非常克制：

- 只计**已完成**项；运行中的通过 `active` 单独表达。
- 失败的工具**计入**（它确实发生了）。
- `execute` 不计自己，计它内部**已完成的嵌套调用**；没有嵌套调用才计 1 个 tool。
- 被权限阻塞的工具**不计入摘要**，而是渲染在折叠组外面，保持可见。
- 全被 `[REDACTED]` 的思考不计数（因为渲染出来也是空的）。
- 组还没闭合前，摘要标签退化为首个运行项的 busy label：`Running edit…`。

这套规则让摘要**只增不减、不会因为流式输出而闪变**。

### 7.4 分组的实现是"树 + 增量合并"

`grouping/tree.ts` 不是每次重算整棵树，而是：

- `groupEntries`：按每个 entry 的 `path`（如 `["activity", "exploration"]`）追加；
- `append`：新 part 到来时，若和上一个 group 同 kind，就 `splitGroups` → `mergeGroups`，只重建接缝处；
- `mergeGroups`：未触及的子树保持对象引用（Solid 的细粒度更新因此不会重渲染整段历史）；
- `pending`：权限阻塞项单独记录，渲染时从组内剔除、在组外补渲染。

**借鉴点**：分组是数据层的事（可测试的纯函数），不是渲染层临时 `groupBy`。这样流式追加、历史分页、权限插入都不会把顺序搞乱。相关测试：`packages/tui/test/cli/tui/session-verbosity.test.ts`、`group-boundary.test.ts`、`grouping-tree.test.ts`。

---

## 8. 状态、颜色、交互的"一套规矩"

### 8.1 状态机

工具 part 的 `state.status` 只有四种：

```
streaming → running → completed
                   ↘ error
```

- `streaming`：参数还没流完，`input` 可能是字符串/空对象 → 显示 `Preparing write…`、`Writing command…`。
- `running`：参数已知，工具在执行 → 显示 spinner + 进行时文案。
- `completed`：显示完成态摘要；`metadata` 此刻才可用。
- `error`：同一行变 `✗`，错误信息默认收起。

统一读取函数（`tool-display.ts`）：

```ts
toolDisplayMetadata(state) // streaming 时返回 {}，避免半截 metadata 造成闪烁
toolDisplayContent(state)  // streaming/running 返回 []，完成才给 content
```

**关键**：渲染器永远不假设"结果一定有"，所有字段都走可空读取（`stringValue` / `finiteNumber` / `recordValue`）。这让流式阶段不会出现 `undefined` 或布局抖动。

### 8.2 颜色语义

| 状态 | 颜色 |
| --- | --- |
| 默认/已完成 | `text.muted`（次要信息） |
| hover 且可点击 | `text.base`（提亮） |
| 权限等待 | `text.feedback.warning`（黄） |
| 失败 | `text.feedback.error`（红） |
| 权限被拒 | 红 + 删除线 |
| 思考 | warning 色，透明度 0.6 |
| diff 增/删 | `diff.background.added` / `removed`，行号单独一套底色 |

### 8.3 交互

- **点击**：展开/收起、跳子会话、开图片预览、开 execute 详情。
- **文本选区优先**：任何点击处理前都检查 `renderer.getSelection()?.getSelectedText()`，有选区就当成复制操作，不触发 UI。
- **hover 只在可点击时生效**：`onMouseOver={() => clickable() && setHover(true)}`，避免"看起来能点其实不能"。
- **展开不改布局宽度**：图标位固定 2 列，spinner 与图标共用同一个单元格。
- **错误点击**：先展开错误文本；若工具提供了 `onErrorClick`（如 execute），则改为打开详情弹窗。

### 8.4 路径展示

- 一律相对工作区显示（`path.relative(base, abs)`）；
- 工作区外才退化成 `~/...` 或绝对路径；
- 统一正斜杠；
- 超宽时用 `FilePath` 组件按可用宽度截断，标签（`Read` / `Edit`）不参与截断。

这样 `Read src/foo.ts` 比 `Read C:\Users\...\src\foo.ts` 短得多，也不会因为项目路径长而挤爆一行。

---

## 9. 附加信息：只在"值得"的时候出现

### 9.1 Diagnostics

`write` / `edit` 完成后，如果 `metadata.diagnostics` 非空，在块底部追加：

```
Error [12:5] Type 'string' is not assignable to type 'number'
```

- 只显示当前文件、当前行号的诊断；
- 颜色用 error，但与 diff 保持同一块，不另起一段；
- 没有诊断就完全不渲染（不是显示"0 errors"）。

### 9.2 图片

- 只处理 `content.type === "file" && mime.startsWith("image/") && uri.startsWith("data:image/")`；
- 最多内联 **3 张**，高度按终端高度取 `clamp(4, 8, h/4)`；
- 多余的显示 `+N more`；
- 点击打开全屏预览弹窗；
- 受 `config.session.image_preview` 开关控制。

### 9.3 后台任务

- `subagent` 和 `shell` 在"part 已完成但任务还在跑"时，追加 `Background` 徽标（`StatusBadge`，带底色的小标签）。
- 徽标不占新行，挂在摘要行尾。

### 9.4 子代理

```
✓ Explore Subagent — 查找工具渲染入口 · claude-sonnet-4
│ General Subagent — 重写 diff 渲染
↳ Continue subagent — 补充测试 · glm-5
```

- 首次委托：`│`（运行）/ `✓`（完成）；
- 续跑：`↳`，且不再显示 spinner；
- 行尾带模型名（`subagentModelLabel`），方便判断"这段结果是哪个模型产出的"；
- 点击整行 `navigate` 到子会话。

---

## 10. 可以直接搬走的 12 条规则

1. **默认一行**。任何工具先设计一行摘要；只有"内容体积不可压缩"的工具才允许块级渲染。
2. **一行 = 图标 + 动词 + 关键参数 + 计数**。计数来自结构化 `metadata`，不要 grep 输出。
3. **固定图标列（2 列）+ 固定左侧缩进（3 列）**，运行/完成/失败都在同一位置替换，布局不跳。
4. **运行态复用完成态那一行**，不要为"正在运行"新增一行；spinner 与图标同格。
5. **输出保尾不保头**（命令类），并显式标出 `(N earlier lines)`。
6. **行数和字符数双预算**，用显示宽度而非 `length` 截断，CJK/emoji 才不会错位。
7. **服务端先截断并落盘**，返回"有界内容 + 完整文件路径"；客户端只排版。
8. **失败信息默认收起**，同一行变红 + `✗`，点击展开；权限拒绝用删除线，不弹窗。
9. **连续同类动作折叠成摘要**，摘要只计已完成项；运行中用 busy label，避免文案闪烁。
10. **权限阻塞项永远可见**，即使它所在的组是折叠的。
11. **点击前先看选区**；hover 只对可点击元素生效。
12. **未知工具必须有兜底**：`tool [k=v...]` + 可展开的完整输入/输出。

---

## 11. 如果要移植到 hajicli

结合本仓库现状（`packages/cli` + `packages/plugins`），建议分四步，不要一次改完：

**Step 1：先统一"一行摘要"层**

- 在工具结果协议里补一个 `display` 字段（或复用 `metadata`）：
  ```ts
  type ToolDisplay = {
    kind: "inline" | "block"
    icon?: string
    title: string        // "Read src/foo.ts"
    detail?: string      // "(3 matches)" / "· 1.2s"
    status: "running" | "ok" | "error" | "denied"
    expandable?: boolean
  }
  ```
- 渲染器只消费 `ToolDisplay`，不再各自拼字符串。
- 给所有现有工具补默认实现：拿不到就用 `name [k=v]` 兜底。

**Step 2：把 shell 做对**

- 实现 `collapseShellOutput`（保尾 + `(N earlier lines)` + 显示宽度）；
- 命令前缀 `$ `、`workdir` 自动 `cd ... && `；
- 输出上限先按 10 行 / 宽度×10，展开看全量。

**Step 3：加"折叠组"**

- 先只做 `exploration` 和 `reasoning` 两种，`low` 档位暂不做；
- 分组逻辑放进独立纯函数模块（参考 `grouping/tree.ts`），配 `node --test` 用例；
- 组头复用 inline 行组件，保证视觉同构。

**Step 4：失败/权限/截断收口**

- 错误统一走"同行变红 + 点击展开"；
- 权限等待用 warning 色，被拒用删除线；
- 服务端截断后返回 `outputPath`，渲染层显示"完整输出见 ..."而不是静默丢弃。

**验收标准（人工）**

- 连续 10 次 `read` 只占 1~2 行；
- 一条报错的 `npm test`，不展开也能看到最后几行错误；
- 长路径不会把行尾计数挤出屏幕；
- 中文/emoji 截断不出现半个字符；
- 失败、权限、后台三种状态都不改变已有行的高度。

---

## 附：参考测试（可直接对照行为）

| 测试 | 覆盖 |
| --- | --- |
| `packages/tui/test/cli/tui/collapse-tool-output.test.ts` | 行/字符双预算、命令与输出共享预算 |
| `packages/tui/test/cli/tui/session-verbosity.test.ts` | 分组路径、low/medium 摘要、权限 pending、busy label |
| `packages/tui/test/cli/tui/group-boundary.test.ts` | 组边界与 `question` 独立 |
| `packages/tui/test/cli/tui/grouping-tree.test.ts` | 增量合并、切分、接缝合并 |
| `packages/tui/test/cli/tui/tool-display.test.ts` | 工具名归一化、元数据/内容读取 |
| `packages/tui/test/cli/tui/inline-tool-wrap-snapshot.test.tsx` | 单行工具在窄宽度下的折行快照 |

---

## 附二：hajicli 落地状态（2026-10-26）

第 11 节的四步已全部落地，对照关系如下。

| 步骤 | hajicli 实现 | 说明 |
| --- | --- | --- |
| Step 1 一行摘要层 | `packages/cli/src/tool-display.ts` | `ToolDisplay { kind, toolName, title, detail, status, expandable }`；`buildToolDisplay()` 统一产出 `title`，`turn-runner`（实时登记 + 批输出）、`index.ts`（子代理回放）、`session-commands.ts`（`/resume` 回放）四处共用；未知工具兜底 `name [k=v, k=v]`，参数只取标量。测试：`test/tool-display.test.mjs` |
| Step 2 shell 做对 | `packages/cli/src/tool-output.ts` + `cli-runtime.ts` | `collapseShellOutput` 保尾、10 行 / 800 列双预算、`… 前 N 行未显示`；`collapseToolOutput` 保头供展开视图复用；`formatToolCell` 新增 `maxPreviewLines`，bash 用 10 行预算（其它工具仍 3 行）；shell 命令前缀由工具块标题行承担（多行命令折成 `首行 …(+N 行)`）。测试：`test/tool-output.test.mjs`、`test/cli-runtime.test.mjs` |
| Step 3 折叠组 | `packages/cli/src/process-fold.ts`（既有） | 采用「一段一摘要」：`FoldStatsCollector` 按类别计数（read/edit 按路径去重）、思考次数、失败与被拒单列；`buildFoldHeader` 按宽度逐级降级（合并类别 → `N 次工具调用` → 丢思考 → 截断）。测试：`test/process-fold.test.mjs`、`test/process-fold-ui.test.mjs` |
| Step 4 状态收口 | `cli-runtime.ts` / `activity-indicator.ts`（既有 + 本次） | 判定/等待态 `◈` 改 warning 黄；失败同一行 `✕` 红 + 结果说明默认收起（Ctrl+O 展开，`… 另有 N 行未显示（完整记录见 /viewer）`）；被拒 `⊘` 黄；运行态与完成态共用同一行，符号位固定 2 列 |

与 opencode 的**有意偏差**（hajicli 现有取舍，非遗漏）：

1. 折叠组只有一种「activity」形态，不分 `exploration` / `reasoning` 子组；思考以「思考 N 次」计入摘要，不单列组头。
2. 被权限阻塞/被拒的调用**计入摘要**并显示「N 次被拒」，而不是渲染到组外保持可见——摘要行本身就是可见的，且用量少。
3. 权限被拒用 `⊘` + 黄色 + 说明文字，不做删除线（ANSI 删除线在部分终端不可靠）。
4. 服务端截断（bash 的 `[中间省略 N 个字符]`、read/grep 的行数上限）不额外落盘 `outputPath`；完整记录走 `/viewer` 与展开视图。
5. 没有 `low`/`medium` 两档 verbosity，折叠行数预算固定（`process-fold` 的摘要 + 10 行 shell 预览）。

---

## 附三：思维链默认展开 + 工具参数流式（2026-10-26）

两项后续变更，都为了一个目标：模型「还没出结果」的那段时间也要看得见。

### 1. 思维链默认不折叠

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 流式过程中 | 对话区底部 3 行滚动预览（`formatReasoningPreview`），回复一开始就清掉 | 整段推理（`formatReasoningBlock`：灰色 + `┊` 竖线、按宽度折行）实时写进对话区并保留；回复写在它下面 |
| 回合结束后 | 只剩 `思考 Ns · tokens` | 推理正文留在对话区，`思考 Ns · tokens` 作为收尾行 |
| 过程折叠段 | 摘要行固定带「思考 N 次」 | 推理已可见，不再重复计数；`/think off` 时才靠计数交代 |
| `/resume` 回放 | 只显示 `深度思考 (N 字)` | 直接回放整段推理正文（在过程段之外，不受折叠影响） |

开关：`/think [on|off]`，持久化到 `preferences.json` 的 `showThinking`（缺省 `true`）。
关闭时退回旧行为（底部预览 + 摘要里的「思考 N 次」）。
管道/无头模式没有重绘能力，只在思考结束时整体写一次，避免重复回放增量。

一个必要的顺序修正：新回合请求模型之前先收口上一段过程段（`sealFoldGroup`）。
否则下一轮推理会写进仍然打开的过程段区间，正文一出现就跟着被折叠吞掉。
收口后推理块锚点才确定，正文起点也才等于推理块之后的对话区长度。

### 2. 工具调用参数流式

`ToolCall` 之前只在参数生成完毕、provider 一次性回调 `onToolCall` 时才可见，
参数生成期间界面没有任何反馈。

- core：`CompletionOptions.onToolCallDelta?: (delta: ToolCallDelta) => void`，
  `ToolCallDelta { index, id?, name?, argumentsText }` —— `argumentsText` 是**累积**文本，
  生成到一半时不是合法 JSON。
- plugins：`openai-stream` 每次合并 `tool_calls` 分片后逐条回调，三条 provider
  （deepseek / volcengine / openai-compatible）共用这一条路径。
- cli：`formatToolCallDraft`（`tool-display.ts`）优先 `JSON.parse` 复用 `buildToolDisplay` 的标题，
  解析失败则按 `path / command / pattern / query / url / glob / prompt / name` 宽松匹配出
  「值的前缀」，拼成 `read packages/cli/src/ind · 24 字`；参数越生成越长，这一行本身就是进度。
- turn-runner：首个分片把活动行切到 `tool` 相位（`⠋ 生成工具调用 1s read … · 24 字`），
  之后每个分片刷新 detail。完整调用仍以 `onToolCall` 为准，执行阶段的工具块不变。

### 3. 参数生成期间就把指令本身显示出来（2026-10-26 修正）

上一版把「参数前缀」只放进了底部活动行的一行 detail（`read src/a.ts · 24 字`），
实测体验仍然像一次性输出：真正在涨的只有尾部的字数，指令文本本身看不见；
参数一完成，整块工具格才带着完整参数突然出现。

改为把生成中的调用渲染成一个实时块，占 `ui.setLiveTail` 这个槽位——正是执行阶段
`ToolRunView` 用的同一个位置，于是「拼装参数 → 执行」在原地连续发生：

- `formatToolCallDraftCell(draft, width, maxLines = DRAFT_MAX_LINES)`：复用 `formatToolCell`
  的 `●` 运行态样式，头部只报进度（`● bash  56 字`），块体是参数原文；块体经
  `draftBodyText` 去掉 JSON 外壳（`{"command": "git sta` → `git sta`），认不出结构时
  退回原始分片。
- 不再截在 4 行：整条指令默认完整展开（预算 20 行）。多行脚本保留自身换行
  （`wrapArgumentLines` 只压缩行内空白），单行长命令按显示宽度折行；只有超过预算才收口，
  末行标出 `… 另有 N 字符未显示`——避免「看起来完整其实被截了」。
  流式分片里的 `\n` 是 JSON 转义，也要先还原成换行（`unescapeDraftText`），
  否则多行脚本在下发过程中会被折成一行。
- turn-runner：每个分片 `ui.setLiveTail(...)`；活动行只留转圈、耗时与 `Esc 中止`，
  不再重复参数（`activityIndicator.transition("tool", "生成工具调用")`）。
- 让位与清理：`stopActiveTurnVisuals` 里 `clearToolCallDraft()` 清空实时块，
  随后 ToolRunView 接管同一槽位；中止 / 校验失败时也不会留下半截草稿块。
- 非交互（`--print`、管道）模式仍然不输出中间帧：`setLiveTail` 不落盘，正文不受影响。
- 执行完成后提交进正文的工具格同样展开：`formatToolArgLines` 只对「头行放不下」的调用
  返回内容——多行命令（摘要里被压成 `for f in …; do …(+2 行)`）或超宽单行命令
  （摘要会被宽度截断）；短命令返回 `undefined`，正文仍是干净的一行，不制造重复。
  展开时头行不再重复那份被截断的摘要（`summary` 传空），命令按原样分行写在头行下面，
  结果说明与预览跟在命令之后。执行中（`running`）不展开，实时区域只留输出尾部，
  避免与提交格的两段 `│` 行打架。
