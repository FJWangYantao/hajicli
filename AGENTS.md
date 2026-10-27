# AGENTS.md — hajicli 仓库约定

pnpm workspace monorepo：`packages/core`（`@hajicli/core`）、`packages/plugins`（`@hajicli/plugins`）、
`packages/cli`（发布包名 `hajicli`，bin 为 `haji`）。TypeScript strict + project references。
整体架构与各子系统导览见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 构建（TS） | `pnpm run build`（= `tsc --build` + `scripts/postbuild.mjs` 给 bin 补执行位，按 references 增量编译到各包 `dist/`） |
| 原生终端引擎 | `pnpm run build:native`（产出 `packages/cli/dist/haji_terminal_engine.<platform>-<arch>.node`） |
| 全量构建 | `pnpm run build:full` |
| 测试 | `pnpm test`（内部会先 build，再 `node --test packages/cli/test/*.test.mjs`） |
| 单文件测试 | `node --test packages/cli/test/provider-config.test.mjs`（**必须先 build**，测试 import `../dist/*.js`） |
| 发版自检 | `pnpm run pack:check`（= `build:full` + `scripts/verify-packages.mjs`，校验 tarball 不含 `src/` `test/` `.haji/` `*.tsbuildinfo`） |
| 截图给用户看 | `pnpm shot <url\|html>`（`--full` 整页；窗口程序用 `--app "<gui 命令>"`，仅 Linux + Xvfb）→ 再用 `read` 工具读取输出的图片路径，终端会内联渲染 |

## 版本号同步（关键）

**任何改动 + 升版本后，三处 version 必须一致：**

- `package.json`（monorepo 根）
- `packages/cli/package.json`（发布包 `hajicli`）
- `packages/plugins/package.json`（`@hajicli/core` 同步看 `packages/core/package.json`）

本机（asus）全局 `haji` 不是 registry 副本，而是指向仓库的 **junction**（npm 前缀在 `E:\nodejs`）：

```
E:\nodejs\haji / haji.cmd / haji.ps1                          （npm shim）
E:\nodejs\node_modules\hajicli          <JUNCTION> → <仓库>\packages\cli
  node_modules\@hajicli\core           <JUNCTION> → <仓库>\packages\core
  node_modules\@hajicli\plugins        <JUNCTION> → <仓库>\packages\plugins
```

**记忆约定：每次跑完新版本（`pnpm run build`），全局 `haji` 经 junction 自动就是新版本，无需任何重装操作。**

- ✅ 构建完即生效，**不需要** `npm i -g` / `pnpm link`（junction 与仓库是同一份文件）
- ❌ 不要删除或移动仓库目录，否则全局 `haji` 立即失效
- ❌ 不要 `npm i -g hajicli`——会用 registry 副本覆盖 junction，此后构建不再同步到全局命令
- 收尾验证（两者应一致；不一致说明 junction 被换成了副本，需重新 `npm i -g ./packages/cli` 重建链接）：

```bash
haji --version
node -e "console.log(require('./packages/cli/package.json').version)"
```

## Lint（保持全绿）

`pnpm lint` 当前**0 error**（剩余少量 info 级 `noNonNullAssertion` 提示是刻意保留的，不挡门禁）。行尾已统一：

- `.gitattributes` 定为 `* text=auto eol=lf`，仓库与工作副本统一 LF，与 biome 的 `formatter.lineEnding: lf` 对齐；
  仅 `*.cmd` / `*.bat` 保持 CRLF（Windows 批处理要求），字体等二进制显式标记 `binary`。
- 提交前对本次改动文件跑 `pnpm exec biome check <files>`，不要让新错误进仓库。
- 需要格式修复时对**改动文件**跑 `pnpm exec biome check --write <files>` 即可，行尾统一后不会再产生巨量无关 diff。

## 架构要点：provider / 模型（踩过的坑）

- provider 名称集合来自 `packages/cli/src/provider-config.ts`：`PROVIDER_NAMES = ["deepseek", "volcengine"]`（内置），
  `loadProviderConfig()` 取 **内置 ∪ 用户级 `~/.haji/config.json` ∪ 项目级 `<cwd>/.haji/config.json`**。
  所以**内置 provider 名永远存在于配置视图里，删配置条目 ≠ 删掉这个名字**。
- 面向用户的列表必须走 `listVisibleProviderNames(config, hasBuiltinKey)`：内置 provider 仅在解析到可用 Key 时列出，
  自定义 provider 按配置条目列出。新增任何"列出 provider"的入口都要复用它，否则会重现"删了又出现"的困惑。
- **Key 解析优先级：环境变量 > 配置文件**（`DEEPSEEK_API_KEY` / `VOLC_API_KEY` / `ARK_API_KEY`）。
  环境变量存在时，`/provider unset` 之后重启仍然可用——这是设计语义，不是残留 bug。
- 模型元数据在 `packages/plugins/src/model-registry.ts`；例如 `glm-5.2` 的 `provider` 是 `volcengine`（火山方舟），
  不存在名为 `glm` 的 provider。
- provider 写盘只有 `provider-config.ts` 一条路径（`saveProviderConfig` / `unsetProviderConfig`），
  两者都是"读盘—改—整体写回"，作用域默认 `user`，`--project` 才写项目级。
- API Key 明文存 `.haji/config.json`（已被 `.gitignore` 忽略）。涉及该文件的日志、报错、测试输出**不得打印明文 key**。
- 跨会话持久授权在 `permission-rules.ts`（`.haji/permissions.json` / `~/.haji/permissions.json`），
  键形态复用 `getPermissionGrant`（`bash:npm test` 前缀 / 工具名）；PreToolUse 早查命中即放行，
  但 plan / bypass 两档不查表。管理入口 `/permissions`（列表+删除）。
  无头模式 `haji -p "<prompt>"`（`--permission-mode`、`--output-format json`、prompt `-` 读 stdin）复用同一套放行逻辑。
- 模型单价/档位在 `model-registry.ts`（估算值），`/cost` 查会话费用；杂活（压缩/标题/distill）
  走 `resolveUtilityModel` 自动挑最便宜，偏好 `utilityModel` 可覆盖。
  内置 provider 上新模型先登记 `~/.haji/models.json`（user-models.ts），不必等发版。
- 编辑后自动验证（post-edit-verify.ts）：write/edit 成功后跑项目 typecheck 并以系统消息回注诊断；
  `HAJI_POST_EDIT_VERIFY=0` 关闭。测试涉及真实回合时注意它会真的执行 `npx tsc --noEmit`。

## 工作区与路径边界（2026-10 重构）

- 文件工具**不再**在工具内部硬拒绝越界路径：边界判定在 `packages/core/src/path-scope.ts`，由
  `PermissionEngine.configurePathScope()` 注入根与规则，`evaluate()` 输出 allow / prompt / deny；
  越界授权键是 `read|write:<目录>`（只放开该目录），写入路径授权永远落用户级。
- 工作区根 = 启动目录 + `--add-dir`（本次进程）+ `~/.haji/workspaces.json`（`/workspace add` 持久化，
  按项目 realpath 分组，不写进项目配置）。路径规则只认用户级 `~/.haji/permissions.json` 的 `paths` 段，
  项目级同名段刻意忽略（防止克隆仓库自带扩权）。
- 快照键：工作区内 posix 相对路径，工作区外 `external:<绝对路径>`。新增任何写文件能力都必须经由
  `tool-executor.ts` 的 `mutationPaths` 传**绝对路径**，否则 `/rewind` 覆盖不到。
- 相关测试：`packages/cli/test/workspace-scope.test.mjs`（scope / engine / roots / 规则 / 外部快照）。

## worktree 并行会话与会话发现

- 自动 worktree（`worktree.ts`）开启时每个新会话建一棵随机命名的树并 `process.chdir` 进去，
  会话文件（`.haji/sessions`）、任务计划、/rewind 快照全部落在**各自树里**——主仓库互相看不见。
- 恢复链路（`/resume`、`-c`、`-r`）经 `sessionManager.setSearchDirs(siblingSessionStoreDirs())`
  把同仓库其他 haji 工作树的会话目录并进检索：`listSessions` 合并展示（同 id 多副本按 updatedAt 取最新，
  附加目录只读、不删空文件），`loadSession` 命中附加目录后**主目录跟着切过去**，后续保存写回原树不分叉。
- 选中别树的会话后 `loadAndRenderSession` 调 `ctx.enterSessionWorktree(worktreeRoot)`（index.ts 注入）：
  `chdir` + `SessionManager.setSessionsDir` + `TaskStore/SnapshotEngine.retarget()` + `syncPathScope()`
  （路径边界读实时 `process.cwd()`）。**新增 cwd 相关的持久化组件时必须同时补 retarget**，
  否则跨树恢复后该组件读写还在旧树。
- SIGINT（第二次 Ctrl+C 强退）也要 `sessionManager.flush()`（经 `sigintSessionFlush` 晚绑定注入，
  因为处理函数注册早于 manager 创建）；正常退出路径在 `finally` 里 flush，无需处理。
- 测试：`worktree.test.mjs`（siblingSessionStoreDirs）、`session-usage.test.mjs`（跨目录发现/去重/重定向）。
  `/worktree remove` 会把会话与快照归档到主仓库 `.haji/worktree-archive/<名称>/`（归档暂不进 resume 列表）。

## 斜杠指令：立即执行通道（回合进行中）

回合进行中的输入默认进 `pendingInputs` 排队，等本轮结束再分发（`/compact`、`/clear` 必须如此）。
但一部分指令不读改对话历史，可以就地生效（`/model`、`/effort`、`/theme`、`/cost`、`/help`）。

- **唯一事实源是元数据**：`cli-help.ts` 的 `CommandSurfaceEntry.immediate`（`args: "any" | [...]`）。
  判定走 `classifyCommandTiming(input)`（最长前缀匹配，别名先归一；未声明一律 `queued`）。
  新增指令默认排队，要放开必须显式标注 —— 别在 `index.ts` 里另写白名单。
- 分发点在 `index.ts` 的 `startBackgroundInput()`：`runImmediateCommand()` 命中就执行、不入队；
  未命中保持原排队语义。处理器与主循环分支共用同一份实现（`runModelCommand` 等），
  避免两条路径行为漂移。
- **硬约束**：立即通道不得读改 `messages` / 会话快照。需要重建 system prompt 的改走
  `requestPromptRefresh()` 置脏，由 `turn-runner.ts` 在每次请求前调用 `flushImmediateEffects()`
  落地（此时没有在飞的流，是安全点）。回合进行中的输出也不能直接 append 到对话区
  （流式渲染每帧从尾部整段重写，会被抹掉），一律经 `immediateWriteLine` / `immediateWriteChat` 寄存。
- **ESC 归属**：选择器会临时接管输入行。`ui.onEsc` 是单槽，回合用它挂「中止回合」，
  直接覆盖会让选择器里的 Esc 顺手中止整轮。用 `ui.pushEscHandler()` 压栈，返回的函数弹出恢复。
- **长耗时但不需要交互的指令**（`/compact`、`/doctor`、`/skills validate|reload`、`/instinct distill`、
  前台 `/agents`）在 `await` 前调 `startBackgroundInput()`：主循环不在 `readInput` 时输入框只是画出来，
  没有 `activeInput` 就会吞掉所有字符。回车进 `pendingInputs`，草稿由主循环 `cancelInput()` 取回；
  新增此类命令必须照此处理（同步阻塞的 git/文件操作除外，那是事件循环被占住，另需拆分）。
- 测试：`packages/cli/test/immediate-command.test.mjs`（判定口径、别名、参数白名单、目录标记）。

## 并行工具批与 A/B 实验（parallel-batch / experiments）

- 分组：同一 assistant 消息内**连续只读**调用才并行，默认最多 5 个（`MAX_PARALLEL_READ_ONLY_TOOLS`）；
  `edit` / `write` / `bash`（写）/ `subagent` / `task*` 等是屏障，顺序不变。
- 判定：静态白名单在 `tool-batch.ts`，动态部分在 `parallel-policy.ts`——实验开启时只读 bash
  （`isReadOnlyShellCommand`）与只读 MCP（`permissionEngine.isReadOnlyTool`）也可并行；
  `loadskill` 虽有加载副作用、权限引擎仍视为只读，但必须继续当屏障。
- A/B：`experiments.ts`，分配单位是本次进程的 trace session id（同进程内稳定）。
  `HAJI_AB=1` 按 `sha256(salt:unitId:name)` 五五分流；`HAJI_EXPERIMENTS="name=arm"` 或
  `all=control` 强制；不设时用推荐默认 arm。`HAJI_MAX_PARALLEL_TOOLS`（1–8）覆盖并行上限。
- 观测：trace 写 `experiment_assignment` / `tool_batch` / `subagent_launch` / `subagent_result` /
  `llm_call`（含 usage）；`pnpm ab:report` 按 arm 汇总批次数、并行率、平均批大小、节省时间、
  子代理耗时/token/工具数，「调用效率」表（`turns` / `calls` / `calls-per-turn` / `dupReads` /
  `batchParam`），以及「请求与成本」表（`requests` / `req÷tool` / `ptok` / `ctok` / `cache%` /
  `cost` / `readTrunc`）。指标口径只在 `scripts/ab-metrics.mjs` 一处实现，两个脚本共用。
- **调用数 ≠ 请求数 ≠ 未命中 token**：一次请求可并行发多个工具调用，成本跟的是
  「请求数 × 每次请求的上下文」；而上下文里约 90% 是缓存命中 token（单价约为输入的 1/50），
  所以真正敏感的是**未命中 token**。`tool_batching` 实测调用 −24%、请求 −12%、
  prompt token −11%、费用 −7%（未命中 token 只 −2%）；结论以请求/未命中 token/费用为准，
  不要拿调用数或总 token 当成本代理。
- **缓存字段口径**：trace 的 `usage` 是 provider 原样透传，缓存命中在
  `prompt_cache_hit_tokens`；`cache_read_input_tokens` / `cached_tokens` 也存在但**恒为 0**。
  `ab-metrics.mjs` 必须优先读前者（`??` 不会跳过 0，顺序错了就永远统计不到）。早期报告
  读错字段，把上下文按全价计、费用高估约 5 倍，已重算。缓存单价按官方价：
  `deepseek-flash` 命中 ¥0.04 / 未命中 ¥2 / 输出 ¥8，`deepseek-v4-pro` 命中 ¥0.3 / 未命中 ¥9 / 输出 ¥27
  （每百万 token，高峰价；谷时五折）。内置注册表已同步这两组价，峰谷按北京时间：
  工作日 09:00–12:00、14:00–18:00 为峰时，其余与周末全天为谷时（法定节假日未建模）。
- 实验记录落盘在 `design/ab/`（报告 + `data/*.json` 每会话指标）；原始 trace 在 `.haji/traces/`
  且被 gitignore，用 `pnpm ab:extract --experiment <name> --since <ISO>` 重新生成指标快照。
- **调用合并（tool_batching）**：`grep.queries`（≤5）、`global.patterns`（≤5）、`read.paths`（≤10）
  一次调用覆盖多个目标；`baseline` 组不暴露也不接受 `queries`/`patterns`（构造函数
  `{ batchParams: false }`），`read.paths` 一直可用。实测：调用数 −24%、模型请求 −12%、
  prompt token −11%、费用 −7%、墙钟 −11%，并行率反而下降——**批量参数的收益远大于并行批**。
- **范围收敛（scope_discipline，实测失败，默认 baseline）**：曾要求「用户原词优先、连续两次
  未命中禁止换同义词、先 global.patterns 定位文件再一次读完目标区块」，并由 `read-tool` 用
  `read-ranges.ts` 记账，同文件重复读重叠 ≥50%、跨度 ≥40 行时提示改走 `nextStartLine`。
  11 任务配对实测：调用 **+38%**（106→146）、请求 +19%、prompt token **+42%**、
  未命中 token +20.5%、费用 +19%、grep +44%、global +91%、墙钟 +14%，
  按请求数 2 胜 / 7 负 / 2 平；
  叠读提示实际只触发 1 次（叠读本身很罕见）。结论：**这类"先定位再搜"的提示会把模型推向更多
  枚举**，默认回退 `baseline`，代码保留供后续更窄的变体（例如只在无命中时介入）实验。
  注意：trace 只存请求参数、不存实际返回区间，按参数估算的叠读率会虚高，别据此下结论。
- **read 输出预算（read_budget，实测失败，默认 shared）**：`shared` 是总量 8k 按文件数平分
  （单文件 7.75k、4 文件 1.9k/个），`per_file` 是单文件 16k、总量 32k、默认 400 行。
  66 次配对实测：截断 −25%，但墙钟 −3.5%（中位 +19%），任务 7 三次全部丢关键结论。
  结论：**截断不是墙钟主因**，更大的上下文抵消了翻页收益；默认回退 `shared`。
  更窄的 `batch_only`（批量读每文件 8k、总量 32k；单文件维持 8k/200 行）已实测：
  墙钟中性（−2.8%，6 胜 5 负），请求 −9.8%、prompt token −8.2%，但**费用 ≈0（+0.3%）**：
  省下的是缓存命中 token，未命中 token 反而 +6.4%；
  任务 7 的结论覆盖从 1–2/3 提升到 3/3；唯一回归是任务 3（多文件中等体量，+14.7s）。
  结论：**修"平分"有效，放大单文件无效**；默认值已切到 `batch_only`（`shared` 为对照组）。
  **额度必须把头部算进去**：单块 = 正文 + `[文件读取结果 - 路径]` 等头部行，而合并上限是
  `总量 − 180`。旧实现正文额度 `outputBudget − 300` 不含路径，n=4 时 `n × 8k` 恰好等于总量、
  余量为 0，路径 ≥198 字符就把第 4 个文件**整块丢掉**（`per_file` 2 文件只要 124 字符，
  `shared` 4 文件 224 字符——这是老 bug，只是 batch_only 把阈值拉低了）。现在
  `renderFile` 按 `outputBudget − 300 − 路径长` 算正文，`execute` 按
  `(总量 − 180 − 分隔符) / n` 算单文件额度，超限时改为保留下一块的头 + 能放下的完整行
  （不整块丢）。回归测试：`tool-optimization.test.mjs` 的
  "long paths never drop a whole file from a batch read"。
- **read 截断提纲（read_outline，首轮 pilot 正向，已切默认 outline）**：`read` 在本页之后还有内容时，
  除 `nextStartLine` 外再给一行「剩余符号」（函数/类/接口 + 行号，如
  `[剩余符号] 262 fn main · 386 fn hasCustomProviderKey · …`），模型可直接用 `aroundLine`
  跳转，不必一页页翻。实现是 `read-outline.ts` 的轻量正则扫描（TS/JS、Python、Go、Rust、
  JVM/Kotlin、Markdown、Shell），不引入 AST；未知扩展名不输出。
  - 只扫 `actualLastLine+1` 之后的区间；`aroundLine` 是模型明确指定的窗口，不附提纲。
  - 条目 >24 时按行号均匀抽样（保留首尾），字符上限 600；超出时保留远端锚点或至少加 `…`。
  - **只在单文件读时附提纲，不缩减正文**；批量读不附（单块额度小，提纲会挤占正文，
    合并时还容易把块撑过上限）。`resolveOutlineBudget` 仍按单文件额度与路径长度封顶。
  - 数据依据：单文件 read 71% 被截断、70% 是 `startLine>1` 的续读；续读里只有 33% 是
    顺序翻页，29% 是远跳、38% 是回跳/小间隔，所以「给剩余符号」比「加大额度」更对症。
  - 默认 `outline`，`baseline` 为对照组；用 `HAJI_EXPERIMENTS="read_outline=baseline"` 或
    `HAJI_AB=1` 跑 A/B，主指标看请求数，墙钟为最终判据。首轮 pilot（4 任务 × 3 轮 × 2 arm，
    12 对）：请求 −12.9%、未命中 token −12.2%、费用 −14.0%、中位墙钟 −16.9%；剔除 1 个
    未触发提纲的离群会话后总墙钟 −11.0%。样本仍小，后续可补一轮确认。
    测试：`read-outline.test.mjs`。
- 子代理：工具触发的 `research` / `review` 默认只读（`subagent_access=role`），
  `implement` 才 workspace-write；子代理内部复用同一批处理（`subagent_batch`），
  写入型子代理仍然独占。
- 测试：`experiments.test.mjs`（分配/覆盖/上限）、`parallel-policy.test.mjs`（静态/动态判定）、
  `parallel-prompt.test.mjs`（提示词 arm）、`tool-batch.test.mjs`（分组与自定义判定）、
  `tool-batch-params.test.mjs`（queries/patterns 批量与 baseline 关闭）、
  `scope-discipline.test.mjs`（叠读判定/提示/提示词 arm）、
  `read-outline.test.mjs`（剩余符号提纲/抽样/预算/批量不丢块）、
  `subagent.test.mjs`（子代理批处理）、`persistence-performance.test.mjs`（trace 事件）、
  `ab-report.test.mjs`（报告聚合）。

## 会话目标（setgoal / goalfinish，纯模型驱动）

- **没有面向用户的 /goal 指令**：目标全生命周期由模型驱动——`setgoal` 工具从用户请求中
  提炼并记录一句话目标（跨回合实质任务才设，琐碎问答不设；新方向直接替换），
  `goalfinish` 在完成审计通过后标记达成（evidence 必填、逐条「验收点 → 证据」）。
  什么时候设目标的使用纪律在 ToolsPromptPart 的 setgoal 规则里，不靠用户触发。
- 目标是会话级状态：存在 `StoredSession.goal`（`SessionGoal`，core/session-manager.ts，含
  `evidence` 完成审计留档）。`setGoal()` 只改内存，落盘仍走 `saveCurrentSession`——脏检查含
  `lastQueuedGoal`，「消息没变、只有目标变了」也会写盘（与 usage 同一口径）。`/resume` 随会话
  恢复，`/clear`（startNewSession）自然归零，老会话文件无该字段按未设定处理。
- 注入通道是 `GoalPromptPart`（cli/goal-prompt.ts，priority 15）：仅 `status === "active"`
  时输出目标原文 + 完成审计约束 + goalfinish 指引；指引按 `context.tools` 是否含 goalfinish
  自动退化（Plan 模式过滤该工具后不再提它，退回「报告结果」）。目标原文对模型是任务数据
  而不是指令（防注入边界已写进提示词）。
- goal* 只写会话元数据：permission-engine 与 task* 同一放行清单（全模式 allow）。Plan 模式
  白名单只加 `setgoal`（调研阶段就该记目标）；`goalfinish` 与 taskfinish 同口径不放行。
  落地回调在 index.ts `setGoalFromTool` / `finishGoal`（共用 `applyGoal`：setGoal → 保存 →
  `requestPromptRefresh` 置脏，回合中由 turn-runner 在下一个请求前的安全点重建提示词）。
- 可见性：侧栏目标区块只渲染**进行中**的目标（`SidebarState.goal` → `TerminalUI.setGoal`，
  `updateStatusUI` 同步；达成后收尾反馈由 goalfinish 工具格承担）；`selfstate` 的
  `session.goal` 含状态、达成时间与 evidence 摘要。
- 测试：`packages/cli/test/goal-tool.test.mjs`（工具行为与校验、权限口径、提示词分片、
  持久化、侧栏与 selfstate）。

## 工具块二级折叠与鼠标交互（tool-block-fold）

- 两级折叠：一级是过程段收敛成 `● 摘要行`（process-fold.ts，点击/Ctrl+O 展开整段）；
  二级是**单个工具块**的按行数收口，但默认态是**全展开**——段展开（或 `/fold off`）后
  每块直接铺开预览全量 + 输出正文至 `TOOL_BLOCK_EXPAND_LINES`（40）行（bash 保尾、其余保头），
  点块头可单独收起成 `TOOL_BLOCK_COLLAPSE_LINES`（3）行预览 + `⋯ 还有 N 行 · 点击展开`，
  再点头行/指示行重新展开。封口时 `sealFoldGroup` 把段内块初始化为 `expanded: true`。
- 数据链路：`ToolRunView.finish(..., fullOutput)` 留档全文（截到 20k 字符/块），
  `commitWithBlocks()` 带出每个块的字符区间 + 渲染配方（`ToolBlockRenderInfo`，
  足以在任意宽度重出收起/展开两种形态）；turn-runner 提交走 `ui.writeToolCells(text, blocks)`。
  区间按提交原文计算，**写入归一化（制表符展开）改变长度时块元数据自动弃用**，退化为纯文本；
  `pushSegment` 里 `closeTrailingStyle` 的尾部 SGR 插入要给触及段尾的块补偏移（防块尾切进转义序列）。
- 渲染与命中都在 TerminalUI（terminal-input.ts）：`sealFoldGroup` 把尾部块转成段内区间
  （`ChatSegment.blocks`），`renderBlockSegmentRows` 挖出块区间按配方现算、其余原文照常换行，
  同时记录 `blockSpans` 行落位；`getSealedRows` 据此重建 `toolBlockHits`（头行/指示行 → 块 id）
  与 `toolBlockRanges`（整块行区间，悬停判定用）。封口时机：每轮工具批结束**就地收口**
  （turn-runner 批循环后，中止/连续失败提前结束的回合也收；随后的提示行写在折叠段下面
  不会被吞）。**回合进行中的尾部块保持现状**（完整可见、不可点）：点击要改写 chatContent
  中段，会破坏 turn-runner 持有的流式偏移。
- 悬停：1003 any-event 跟踪在交互模式常开（`setMouseMotionEnabled(true)`）；指针扫过
  工具块整块或摘要行 → `chatHoverTarget` → 块头行加下划线（`formatToolCell` 的 `hover` 参数）、
  摘要行换强调色（`buildFoldHeader` 的 `hovered` 参数）。目标没变不重绘；每帧校验目标
  仍存在（段被预算回收/组被收起就清空）。**块展开态与悬停态都进段缓存键**
  （`segmentCacheKey` 的 `|b…h` 段），点击/悬停只重算受影响的段。
- 展开正文前会剥掉工具回执外壳（`tool-output.ts` 的 `stripToolOutputEnvelope`）：
  bash 的 `[命令执行结果…]` 与 stdout/stderr 分隔行、read/grep/global 的元信息行、
  edit/write 的路径/hash/改后片段回执、以及末尾的 `[verification_evidence_id]`。
  只剥开头连续块与已知分隔行，正文里形如回执的真实输出不受影响；`/output` 仍给原始输出。
- /resume 回放的历史没有块元数据（session-commands 只重建文本分段），按纯文本渲染，
  不提供二级折叠；`/output` 仍可看最近一批工具全文。
- 测试：`packages/cli/test/tool-block-fold.test.mjs`（纯函数折叠/计数/悬停配色、
  ToolRunView 留档与区间、TerminalUI 封口-展开-点击-悬停-关折叠全链路、归一化降级）。

## 选区与复制（行号必须与屏幕逐行一致）

- `getSelectionLayout()`（terminal-input.ts）是**复制与拖选唯一的坐标源**：`sealedSegments`
  逐段取 `getSegmentLayout()`，尾部取 `layoutAnsiDocument(chatContent)`，再
  `concatAnsiLayouts` 拼成整串。这些布局的**行数/行序必须等于本帧真实渲染的行**
  （封口区来自 `getSegmentRows()`，尾部来自 `wrapAnsi()`），否则屏幕行索引换成文档偏移时
  整体错位——复制出来的是选中位置**上方**的内容（实测每错一行就早一行）。
- **图片段**曾经踩过：旧实现只拿说明行拼文档，再额外补一行「光标行」；而渲染行数由
  `fitImageCells` 按宽度折算。结果每张内联图让后续所有行**多偏移一行**，11 张图 ≈ 复制早
  11 行（选中「未完成的项」带出上面表格）。现在与块段同一口径：`renderImageSegmentRows()`
  的行集 `join("\n")` 后直接 `layoutAnsiDocument`，说明行同样截到聊天区宽度。
- `concatAnsiLayouts` 的契约是「段与段在屏幕上必然另起一行」：除最后一段外丢掉段末光标行，
  段文本不以 `\n` 结尾时补一个换行。**新增段类型时不要自己手搓 rows/offset**，走
  `layoutAnsiDocument(可见行)` 这一条路，缓存键仍交给 `segmentCacheKey`。
- 测试：`packages/cli/test/inline-image.test.mjs`（图片段布局与屏幕逐行对齐、拖选复制）、
  `terminal-layout.test.mjs`（layout vs wrap、拼接等价）。

## write/edit 完成块的红绿 diff

- write 的「改动前」内容**执行后无法再取**：`tool-executor.ts` 在 `targetTool.execute`
  之前抢读目标文件，挂到 `ToolExecutionResult.writeBefore`（截 200k）。挂结果不挂工具输出，
  模型上下文不膨胀。新建文件 `existed:false` → 全绿；读不了的只标 `existed:true` 不带内容。
- `cli-runtime.ts` 的 `summarizeToolResult("write", ...)` 拿 writeBefore 走
  `diff-preview.ts` 的 `buildWriteDiff`，edit 走 `buildEditDiff`（优先用
  `preEditContentForEdit` 还原旧全文，与授权卡片同口径）。
  渲染按宽度双模式：**常规宽度（每侧 <68 列）走单列 unified**（`行号 │ 标记 全宽内容`，
  opencode 同款）——硬拆两栏每侧只剩 40 多列，被代码缩进吃一截后长行全靠省略号，
  行内高亮看不清；**宽终端（构建宽 ≥148）才左右分栏**（左旧右新、双行号，相邻删/增
  配对合并为同一视觉行）。两种模式共用切分与铺色：行内变更字符段强反色，整行铺淡色条。
- **变更行整块铺色**：删除/新增单元格从 `−/+` 标记到行尾补白铺成连续色条，
  行内变更字符段再叠强反色（`redBg`/`greenBg`）。色条由 theme.ts `diffToneBg` 生成：
  主题红/绿先**提纯成高饱和锚点**（取色相，S .72，深底 V .68 / 浅底 V .9），再小比例
  **sRGB 直混**到参考背景（深 0.22 / 浅 0.2，对齐 GitHub 叠底）——粉彩前景色直接混底
  会得到褐红/灰绿的脏色条，Oklab 朝深底混会把亮度非线性压垮，都不能用。
  `−/+` 标记与强反色段自带的 `themeReset` 会清掉铺底，拼接后必须**重新续上**
  `diffToneBg + 前景`，否则铺底在标记后就断了。上下文行不铺底。
  16 色降级深底为 41/42 淡条 + 101/102 强段；16 色浅底淡 tint 会退化成白底（红绿不分），
  刻意不铺条。
- **构建宽度必须等于实际渲染宽**：分栏行按满宽补白，构建宽只要比渲染宽多 1 列，
  行尾被裁的全是右栏。**宽度来源是 `ui.getContentWidth()`（已含侧栏扣减）**，经
  `diffWidthFor()`（内容宽 − 8）折算后传给 `summarizeToolResult` / `buildPermissionPreview`
  （末位可选参数 `uiContentWidth`）；`preferredDiffWidth()` 只是无 UI 时的回退
  （终端列数推 `resolveTuiLayout` 对话区宽 − 8，无 TTY 按 112）。
- 截断带 ANSI 的行必须走 `truncateAnsiText`/`fitText`（fitText 遇转义序列自动切 ANSI 分支）：
  `truncateText` 是纯文本口径，会把转义字节当可见宽度，提前截进转义序列中间（花屏/断色）。
  **writeBefore 缺失或读不了时不冒充 diff**（/resume 回放历史没有此字段），退回带行号纯内容预览。
- 16 色降级（theme.ts `rgbToAnsi16`）按**色相分桶**而非 RGB 最近色：朴素最近色会把粉彩主题
  全吸到灰阶，diff 红删绿增在 ansi16 终端分不开。语义色先保色相再按亮度分普通/明亮档；
  青蓝分界在 hue 210（主题青 #7dcfff hue≈202 归青，主题蓝 hue≥214 归蓝）。
  回归测试在 `theme.test.mjs`。

## Shell / bash 工具（Windows）

- `bash` 工具在 Windows 上不再走 cmd.exe：`resolveShellEnvironment()`（`packages/plugins/src/bash-tool.ts`）优先找
  **Git Bash**（只从 PATH 里带 `git` 的目录和常见 Git 安装位置推导，**排除** `System32\bash.exe` 这个 WSL 入口），
  找不到才回退 PowerShell；cmd 始终作为候选。`HAJI_SHELL=cmd|powershell|bash`、`HAJI_BASH_PATH` 可强制首选。
- 每条命令会按语法自动选 shell：`detectShellDialect()` 识别 heredoc / `[[ ]]`（bash）、`$env:` / here-string /
  谓词-名词（PowerShell）、`%VAR%` / `dir`（cmd），`selectShell()` 依次按「显式 `shell` 参数 → 命令方言 → 环境首选」选择。
  工具描述由 `describeEnvironment()` 列出当前可用方言，模型据此写语法。
- 显式 shell 用 `execFile(file, [...args, command])` 传 argv，命令作为单个参数原样交给 shell，
  多行命令与提交信息不会被 cmd 的引号规则拆坏。

## 代码风格与提交

- 注释与用户可见文案用中文；标识符与既有文件保持一致（camelCase，模块内工具函数不加 `export` 除非有测试需要）。
- 纯逻辑优先抽成可测函数放进现有 `*-config.ts` / `*-policy.ts` 一类模块，`index.ts` 的 `main()` 只做编排。
  斜杠命令按家族放 `provider-commands.ts` / `subagent-commands.ts` / `session-commands.ts`，经 `*CommandContext`
  访问器注入会话状态（可变 let 绑定必须走 getter/setter，不能拷贝值）；新增命令族时照此模式新建模块。
- `dist/` 未入库（`.gitignore` 中 `dist/`），提交时不包含构建产物。
- 新增交互逻辑尽量配一条 `packages/cli/test/*.test.mjs` 用例；测试通过临时目录 + 覆盖 `HOME`/`USERPROFILE`
  做路径隔离（参考 `provider-config.test.mjs` 的 `withIsolatedPaths`），不要读写真实 `~/.haji`。
