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
  无头模式 `haji -p "<prompt>"`（`--permission-mode`、`--output-format json`、prompt `-` 读 stdin）复用同一套放行逻辑；
  无头/CI 用 `--allow <键>`（可重复）把键并入**内存**规则视图（`withCliAllowKeys`，不落盘），
  `index.ts` 里所有 `permissionRules = loadAllPermissionRules()` 都必须走 `loadRules()`，否则刷新会丢掉 `--allow`。
- 模型单价/档位在 `model-registry.ts`（估算值），`/cost` 查会话费用；杂活（压缩/标题/distill）
  走 `resolveUtilityModel` 自动挑最便宜，偏好 `utilityModel` 可覆盖。
  内置 provider 上新模型先登记 `~/.haji/models.json`（user-models.ts），不必等发版。
  **主线以外的调用也记账**：子代理（只记 provider 上报的用量，估算值只管预算）、上下文压缩、
  会话标题、经验提炼、Auto 权限判定、后台查价都按各自实际模型与渠道记一笔（`purpose` 区分），
  index.ts 里统一走 `utilityCall(purpose)` / `recordSideCost`；新增模型调用点必须接上，
  否则 `/cost` 会偏低（测试：`side-cost.test.mjs`）。
- **单价解析优先级**（`model-pricing.ts` 的 `resolveModelPricing(model, provider?)`）：
  渠道覆盖 `<provider>/<model>` > 内置注册表 > 模型覆盖 `<model>`。渠道覆盖必须压过内置价，
  否则「同名模型走 CN 中转」永远按官方价估算（费用归属错、显示为 null 或明显偏低）。
  自定义渠道（非内置 provider）的单价由 `/cost` 写入 `<provider>/<model>` 键，内置 provider
  仍写模型名（内置价不被本地文件悄悄改掉）。新增读取单价的入口都要把当前 provider 传进去。
- **token 去向拆解**：`node scripts/token-breakdown.mjs <trace 目录>` 按主线 / 标题 / 压缩 / 提炼
  分类统计请求数、输入输出与缓存命中，并统计重复读；口径与一次实测结论见
  `design/token-cost-breakdown.md`（8 个基础任务：主线占 99.6%，标题 0.4%，辅助请求不是瓶颈）。
- **经验召回位置（experience_recall，已切默认 message）**：经验分片原本注册在 system prompt 里，
  但 system prompt 只在启动/切模型/切权限/`/skills reload` 时重建，**普通回合不重建**，
  所以召回一直用启动时的兜底词表（`workflow edit read test git error prevention`），与当前任务无关。
  现在默认由 `turn-runner` 按本轮用户消息召回，追加到用户消息尾部并用
  `<experience_recall>…</experience_recall>` 包起来；注入块随消息落盘（下一轮前缀与实际发出
  内容一致，不吃缓存惩罚），`/resume` 回放按标记剥掉。`system` 臂保留为对照组。
  **本仓库有 570 条项目级 instincts（`.haji/instincts/`），别再说「经验库是空的」。**
  首轮 pilot（任务 3/7 × 3 轮 × 2 arm）：费用 +1.7%、未命中 token +4.3%（中性），
  墙钟差异不归因；采纳理由是正确性。测试：`experiences-prompt-part.test.mjs`。
  **召回打分**：605 条 instincts 里 557 条 confidence 只有 0.50，旧默认（≥0.70）导致无论问什么
  都只召回固定那 2 条；且中文按单字切，任何共享汉字都算命中。现在 `recallInstincts` 用
  **中文双字 + IDF 加权 Jaccard + 分数下限 0.10 + 默认 top2 + minConfidence 0.5**。
  离线评测 `scripts/recall-eval.mjs`（11 个固定任务 + 10 个无关短问）：旧实现相关率 27%、
  无关注入率 60%；新实现相关率 86%、无关注入率 0%。改召回参数前先跑它（`--samples` 可人工复核）。
- 编辑后自动验证（post-edit-verify.ts）：write/edit 成功后跑项目检查，**只在发现问题时**回注诊断
  （成功不回注：实测「验证通过」这条消息换不来模型少自检，只有上下文成本，见
  `design/ab/2026-10-27-verify-notice.md`）；
  `HAJI_POST_EDIT_VERIFY=0` 关闭。**bash 写源码同样触发**：`detectShellFileWrites` 识别
  `sed -i` / `perl -i` / `>`·`>>` 重定向 / `tee`，以及 `xargs sed -i`、`find -exec sed -i`
  （目标来自管道，记为 opaque，诊断一律视为相关）；只认源码扩展名，日志/产物重定向、`2>`、
  引号里的文本都不算（测试 `shell-write-verify.test.mjs`）。探测顺序是**只认 `typecheck` 脚本** → tsconfig
  （references 结构用 `npx tsc -b`，普通结构用 `npx tsc --noEmit`）；刻意不认 `check`
  这类组合脚本（本仓库的 check = lint + 全套测试，每次编辑都只会跑满超时）。
  超时不回注上下文、只在界面提示一次；cwd 是**正在运行的 haji 自身仓库**时跳过
  （`tsc -b` 会覆盖运行中的 dist），显式设置环境变量可强制。
  静态提示也没用：`edit_verify_hint`（system prompt 写「编辑后会自动 typecheck」）实测
  模型照样自己跑 `tsc`（7→6 次/9 会话），因为 5/7 次 tsc 是**为跑测试刷新 `dist`**
  （测试 `import .../plugins/dist/*.js`），本来就省不掉。默认 `baseline`，见
  `design/ab/2026-10-28-edit-verify-hint.md`。

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
  `/worktree remove` 会把会话与快照归档到主仓库 `.haji/worktree-archive/<名称>/`；归档会话经
  `archivedSessionStoreDirs()` + `sessionManager.setArchiveDirs()` 进 `/resume`、`-c`、`-r`
  （列表标「已归档 · 工作树 <名称>」）。原树已删，所以 `loadSession` 命中归档时**把文件复制回
  当前主目录续写、不切目录**，归档副本保持原样（测试：`session-usage.test.mjs`、`worktree.test.mjs`）。

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

## 驱动进程（`haji mcp-serve`）

`haji mcp-serve` 把本进程当成常驻 haji，经 MCP stdio 对外提供「派活 + 跟进 + 调整」的工具面（`haji_status` / `send` / `wait` / `events` / `adjust` / `cancel` / `approve`）。方向与「MCP 外部工具」相反：那里是 haji 调别人的工具，这里是别人把 haji 当工具。

- **分层**：`serve-args.ts`（纯函数解析，不读环境、不退出进程）→ `driver/types.ts`（协议面类型）→ `driver/server.ts`（事件日志 + 选择请求代理 + 回合串行队列，只做编排）→ `driver/mcp.ts`（JSON-RPC 方法分发）→ `driver/index.ts`（`startMcpStdio`：逐行读 stdin、串行写 stdout）。真正的回合执行由 `index.ts` 里的 `DriverHost` 闭包注入，引擎本身不感知驱动模式。
- **接线点全在 `index.ts`**：启动早期 `parseServeArgs(cliArgs)`（出错 `exit(1)`）→ `serveRequest`；`quietMode = headlessRequest || serveRequest` 决定不打印 Logo、不弹配置向导、不启动交互输入；`TerminalUI` 传 `outputSink` / `errorSink` 把输出改道成事件；主循环顶部 `if (serveRequest) { await runServeMode(); break; }`；`runServeMode()` 里构造 `DriverServer` 并 `await startMcpStdio(driver)`。
- **硬约束**：`startMcpStdio` 之前就产生的输出必须先缓冲到 `serveOutputBuffer`，等 `driverServerRef` 就绪后补发成 `notice` 事件——否则启动期的报错会直接写进 stdout 打断协议帧。stdout 只允许出现协议回包。
- **授权通道**：`ask` 模式下选择卡不走终端，改由 `DriverServer.requestSelection()` 发 `selection_request` 并挂起，等 `haji_approve` 或超时回落默认项；`auto` 直接取默认选项。新增「需要用户决策」的入口必须同时处理这两条通道。
- **历史坑**：曾有一次提交（`b5fd389`）把 `index.ts` 接到从未提交的 `driver/`、`serve-args` 上，导致 tsc 与全部测试无法运行，只能用 `dee4b18` 摘掉接线恢复构建。改动这条链路时，源码、`index.ts` 接线、测试必须在同一提交里齐活，别让 master 依赖未提交文件。
- `haji_send` 回 `running` 时 `lastSeq` 是**回合开始前**的游标（不是「现在」）：本回合可能在回包前就发出了
  `selection_request`，给当前游标会让客户端 `haji_wait` 错过那张卡、干等到超时拒绝。
- 外部接入文档与最小客户端在 `examples/`（`README.md` + `mcp-serve-client.mjs`），e2e 测试会真跑这个示例，
  改协议行为时一起更新。
- 测试：`packages/cli/test/driver.test.mjs`（协议与队列的单测）、
  `packages/cli/test/mcp-serve-approval.test.mjs`（假模型真子进程：授权卡、计划审批、示例客户端）、`packages/cli/test/mcp-serve.test.mjs`（起真实子进程发 `initialize` / `tools/list`、参数错误与 `--cwd` 失败路径）、`serve-args` 的解析断言在同文件内。

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
  工作日 09:00–12:00、14:00–18:00 为峰时，其余与周末全天为谷时。**刻意不接法定节假日日历**：
  官方公告只说「周六、周日全天按低谷计费」，没提节假日与调休，按字面国庆工作日仍有峰时、
  调休上班的周六仍是谷时（`pricing.test.mjs` 有断言）；官方明确前别套国务院放假安排。
- 实验记录落盘在 `design/ab/`（报告 + `data/*.json` 每会话指标）；原始 trace 在 `.haji/traces/`
  且被 gitignore，用 `pnpm ab:extract --experiment <name> --since <ISO>` 重新生成指标快照。
- **写路径基准**（`design/ab/write-bench/run.sh`）：3 个固定写任务（加函数+测试 / 跨文件重命名 /
  修边界+回归测试）在独立 worktree 里跑，`cp -al` 硬链接 `node_modules` 后先 build 预热。
  首轮 12 次运行正确性全过，但**重命名任务走 `sed -i` 一条 bash 完成、当时不触发 write/edit
  钩子**，所以它测的是 sed 不是 edit 路径。现在 bash 写源码也会跑编辑后验证（见上节），
  但任务本身仍测不到 edit 路径，要比较 edit 时得强制用 edit。
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
    未触发提纲的离群会话后总墙钟 −11.0%。样本为 4 任务 pilot，按此结论采纳，不再补确认轮。
    测试：`read-outline.test.mjs`。
- **按符号读定义（read_symbol，机制已实现、默认 baseline）**：`read({ path, symbol })` 按名字
  取回整个定义块（TS/JS、Python、Go、Rust、JVM/Kotlin、Markdown、Shell），块尾用花括号配平
  （跳过注释/字符串）或 Python 缩进，Markdown 取到同级标题；找不到时按编辑距离给相近符号。
  与 `startLine/endLine/aroundLine` 互斥、不能配 `paths`；只在定义块被 limit 截断时给
  `nextStartLine`。`baseline` 臂直接从 schema 里摘掉 `symbol` 属性。
  **首轮 pilot（任务 5/7/10 × 2 轮 × 2 arm）symbol 被使用 0 次**，两臂差异全是噪声；
  显式要求时一次就成，说明问题在「发现」而不是机制。触发点已补上：symbol 臂下
  `GrepSearchTool({ symbolHint })` 在返回的命中里找第一条声明行（`buildSymbolReadHint`，复用
  read-outline 的规则；Markdown/Shell 不提示），回执末尾追加一行
  `[提示] 文件:行 是 class X 的定义；要看完整定义可直接 read({ path, symbol })`。
  baseline 臂回执不变；**这一版还没跑 A/B**，默认仍是 baseline。测试：`read-symbol.test.mjs`。
  一键跑：`node scripts/ab-run.mjs --experiment read_symbol --arms baseline,symbol --tasks 5,7,10
  --rounds 2`（任务原文取自 `data/2026-10-27-batch-only.json`，arm 每轮交替顺序；汇总里的
  `symbol 调用/提示` 由 `ab-metrics.mjs` 的 `symbolReads` / `symbolHints` 统计）。
  脚本已用假模型把「运行 → trace → 汇总」整条链路跑通（`-p` 的 JSON 是多行排版，
  `parseHeadlessOk` 必须整段解析，旧实现只看最后一行，每次都记成失败）；真实 A/B 仍待有 key 时跑。
- 子代理：工具触发的 `research` / `review` 默认只读（`subagent_access=role`），
  `implement` 才 workspace-write；子代理内部复用同一批处理（`subagent_batch`），
  写入型子代理仍然独占。
- 测试：`experiments.test.mjs`（分配/覆盖/上限）、`parallel-policy.test.mjs`（静态/动态判定）、
  `parallel-prompt.test.mjs`（提示词 arm）、`tool-batch.test.mjs`（分组与自定义判定）、
  `tool-batch-params.test.mjs`（queries/patterns 批量与 baseline 关闭）、
  `scope-discipline.test.mjs`（叠读判定/提示/提示词 arm）、
  `read-outline.test.mjs`（剩余符号提纲/抽样/预算/批量不丢块）、
  `read-symbol.test.mjs`（定义块起止/调用点误判/Python 缩进/Markdown 章节/schema 开关）、
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

## 右侧栏的信息优先级与折叠（sidebar-priority）

- 顺序即优先级：**目标 → 任务 → 代理 → 上下文 → 费用**（`buildSidebarFrame`）。当前在做什么
  排在最前，资源与账单在后；分工仍守着「进行中的活动行只在对话区出现一次」。
- 上下两块是常驻状态，按 `CONTEXT_MIN_ROWS`（4）/ `COST_MIN_ROWS`（3）预留行数，
  **预留值含各自章节前的呼吸空行**（空行 + 标题 + 进度条/花费）。上部区块用
  `upperBudget() = maxRows − 已用 − 预留`，放不下就先收摘要，而不是把上下文/费用顶出去。
  圆环高度也按 `maxRows − 已用 − COST_MIN_ROWS` 分档，`ringFits` 不满足时退回进度条；
  压缩徽标是可选行，空间只够预留额度时先让它。回归测试：
  `tui-sidebar.test.mjs`「long goals, tasks and agents never push context or cost out of view」。
- 面板紧凑化：`buildTaskPanelRows(..., { compact: true })` 把已完成项收成计数行（标题里的
  done/total 仍准确，Ctrl+T 展开后恢复逐条）；`buildAgentPanelRows(..., { compact: true })`
  只列 running/queued/awaiting_verification，已结束收成「… N 个已结束 · /agents 查看」。
  两个 compact 只由侧栏传入，对话区底部面板维持全量。
- 费用默认**摘要优先**：常驻「花费 + 未定价入口 + 定价 agent 状态」，token 构成与耗时收在
  `SidebarState.costDetailsExpanded`（默认 false）后面的「▸ 明细」开关里。开关的点击由
  `TerminalUI.dispatchSidebarAction` 就地处理（`cost.detail` → `toggleCostDetailRows()`），
  不走 `onSidebarAction`——它只改侧栏密度、不开浮层；完整逐条明细仍在费用日志页。
- 颜色口径：目标原文用正文色（强调色留给选中态与可操作入口）；悬停只换颜色、绝不改行数
  （否则命中区会从鼠标下滑走）。
- 密度三档：`sidebarDensity(maxRows)` → `full`(≥24) / `compact`(15–23) / `minimal`(≤14)。
  `minimal` 不画圆环（只剩单行进度条）、任务与代理只留标题行（done/total 与运行中数量照旧
  准确）、压缩徽标一起收掉——`minimal` 档每一行都要么是主指标，要么是可操作入口。
  `compact` 把圆环压到最高 5 行。回归测试：
  `tui-sidebar.test.mjs`「sidebar density steps down with the height budget」「the minimal tier
  keeps every number and drops only decoration」。
- 窄宽度：所有行都过 `push()` 里的宽度闸（`truncateAnsiText` 到 `contentW`），面板自身产出的
  行也必须走 `push` 而不是 `rows.push`；`tableRow` 在极窄时先缩标签保住数值。提示类文本用
  `fitHint([长, …, 短], width)` 逐级降级，**不截断成「… · Ctrl+T」这种半截提示**。
  中文折行不让标点挂行首（`NO_LINE_START` 带走上一行末字）。
- 键盘入口：`Ctrl+E` 与点「▸ 明细」等价（`toggleCostDetailRows()` 返回是否真的切换了；
  没有已计费调用时什么都不做）。宽 ≥16 列时开关上带「· Ctrl+E」，窄栏只留「▸ 明细」。
  最低高度下「配置单价」（需处理）优先于「明细」占行，键盘 / `/cost` 仍是兜底。
- 视觉对照：`node scripts/sidebar-gallery.mjs` 生成 HTML（`--text` 直接在终端打印），
  再 `node scripts/shot.mjs "$(node scripts/sidebar-gallery.mjs)" --full` 出图；
  四种宽高 × 折叠/展开两态，用来核对档位切换与窄宽度排版。
- 测试：`tui-sidebar.test.mjs`（顺序、档位、宽度不溢出、Ctrl+E、点击命中）、
  `terminal-panels.test.mjs` / `agent-manager.test.mjs`（紧凑与降级）。

## 工具块二级折叠与鼠标交互（tool-block-fold）

- 头行配色（`formatToolCell`）：**工具名加粗正文色**（`colors.boldText`）、**摘要（路径/命令）强调色**
  （`colors.accent`，不加粗）、参数展开行次要文字色、`+a −r` 加粗红绿、耗时/来源 `faint`，
  `└` 说明与输出预览仍是灰色。工具名与摘要靠**色相**区分（加粗近白/近黑 vs 紫），
  颜色只留给状态标记（✓/✕/⊘/●）、增删行数与摘要；参数与结果侧保持中性。
  历史上这里刷过青（工具名 + 摘要一片蓝，最该看清的摘要对比度反而最低），用户明确表示不要青色，
  所以别再把青色加回来（`theme.test.mjs`/`tool-block-fold.test.mjs` 有断言）；
  过程段摘要的悬停高亮也一并改成强调色（`process-fold.ts` 的 `textPaint`）。
  摘要配色候选实测：深色下 accent `#a995d6` 与 magenta `#b8a1df` 肉眼无差别，
  blue `#82aadd` 偏蓝、与当初被否的「一片蓝」同族，因此定 accent。
  测试：`tool-block-fold.test.mjs`「tool header keeps the tool name vivid and the summary at
  full contrast」。

- 两级折叠：一级是过程段收敛成 `● 摘要行`（process-fold.ts，点击/Ctrl+O 展开整段）；
  二级是**单个工具块**的按行数收口，但默认态是**全展开**——段展开（或 `/fold off`）后
  每块直接铺开预览全量 + 输出正文至 `TOOL_BLOCK_EXPAND_LINES`（20）行（bash 保尾、其余保头），
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
- /resume 回放**不需要落盘块元数据**：历史消息里本来就有工具调用与结果，`loadAndRenderSession`
  重建工具格时用 `buildReplayBlockInfo` 现算渲染配方（口径同 `ToolRunView.buildBlockInfo`，
  只是没有耗时与参数展开行），区间随 `ChatSegmentPiece.blocks` 交给 `replaceChatSegments`，
  段内块默认全展开、可单独收起；过程段被弃用并回普通内容时块区间跟着平移。最后一段
  （尾部 plain → chatContent）与实时回合一样不可点。测试：`resume-compaction.test.mjs`、
  `tool-block-fold.test.mjs`。
- 测试：`packages/cli/test/tool-block-fold.test.mjs`（纯函数折叠/计数/悬停配色、
  ToolRunView 留档与区间、TerminalUI 封口-展开-点击-悬停-关折叠全链路、归一化降级）。

## 启动首页（startup-launcher）

- 排版在 `startup-launcher.ts` 的 `buildStartupLauncher`（纯函数），TerminalUI 的
  `renderStartupLauncher` 只负责排好输入行 / 附件 chip / 补全候选再交给它。
  自上而下：像素 Logo + 疏排标语 →「继续上次」→ 输入卡片 → 三张入口卡片 → 会话时间线；
  整块在状态行上方垂直居中、略偏上（上下留白 2:3），状态行固定在倒数第二行。
- **整屏走逐格画布 `cell-canvas.ts`**：光晕要逐格改背景，字符串拼 ANSI 做不到（文字里的
  `themeReset()` 会把背景清回主题色）。画布存「已按色彩档位生成的 SGR」，`ansi()` 解析外部
  已上色的输入行，主题底色与 SGR 49 视为透明、落到卡片底色或背景层；行尾透明空白裁掉。
  新增首页元素一律画进画布，不要再往行字符串里拼。
- 视觉层：
  - Logo 两档像素字（大号每像素 2 列 × 1 行共 6 行；小号半块字符 3 行），横向 accent → cyan 渐变；
    放不下（需余 ≥4 行）退单行字标 `haji · 标语`。
  - **光晕**：以 Logo 为中心的椭圆背景渐变，只在 truecolor 且知道真实底色时画——主题有
    显式背景用它，否则用 OSC 11 探测值（`getDetectedTerminalBackground()`）；拿不到就不画，
    否则光晕边缘会和真实底色对不上露出色块。半径随窗口缩放，到屏幕边缘混色 < 0.25%。
  - **星点**：只落在内容列两侧空白，按尺寸伪随机稳定；不进 16 色 / mono。
  - 输入卡片：左侧 `▌` 竖条沿高度渐变 + 铺底，正文宽 `contentWidth − 4`（`inputLeft = left + 2`）；
    卡片底部权限药丸 + 模型 · 强度 + `↵ 发送` 键帽（有草稿时点亮）。
  - 「继续上次」：最近会话在 24 小时内才出现（入口序号 3），时间线随之只列其余会话。
    下面一行 `└ 目标 … · 任务 3/7 · 进行中 …` 说明停在哪（`RecentSessionEntry.progress`，
    index.ts 用 `buildSessionProgress` 从会话 goal + 会话所在树 `.haji/tasks/<id>.json` 提炼；
    `formatResumeDetail` 放不下先去「进行中」再去目标，不截半句）。点这行同样是继续；
    空间不够时它在「会话条数」之后、「卡片留白」之前让掉。
- **启动动效**（约 1.8 秒，之后完全静止）：标语逐字解码、高光扫过 Logo、星点闪烁。
  `TerminalUIOptions.startupMotion` 打开（index.ts 交互模式开启，测试默认关），
  `HAJI_REDUCED_MOTION=1` 强制关；帧定时器 50ms 且 unref。动效帧 7–14ms（140×40 ~ 240×70）。
- 空间不够时按固定顺序让步：Logo 大→小→字标（先判）→ 会话条数 → 进度行 → 卡片上下留白 → 入口卡片改列表 →
  段间空行 → 会话 → 继续上次 → 模型行 → 小标题 → 入口改一行三格 → 字标 → 入口；
  卡片与状态行永远保留。字标、占位提示都是「放不下就换短的」，不截成半句。
- 交互：空输入 Tab / Shift+Tab 循环入口，已选中时 ↑↓ 移动、Esc 取消；入口卡片三行都可点，
  按下松开同一项才触发；悬停只换颜色（`startupHovered`），行数不变。临时提示顶替状态行左侧。
- 测试：`startup-home.test.mjs`（Logo 档位、入口卡片/列表/一行、继续上次、光晕开启条件、
  动效开关与定格、画布底色续接/宽字符/mono、键盘与悬停、尺寸 × 主题 × 色彩档位矩阵不越界）。
  效果核对：真实终端 `pnpm run build && haji`（tmux 不回 OSC 11 时看不到光晕，属预期）。

## 回到底部浮标（Jump to End）

- 滚动离开底部（`chatScrollOffset > 0`）时，对话区底部正中画一个三行小矩形
  `╭─ Jump to End ─╮`（`terminal-text.ts` 的 `buildScrollJumpHint`），**不再占用输入框上边框**。
- 只覆盖渲染行（`chatRows`），不写 `chatContent`，也不参与折行/选区布局，复制结果不受影响；
  窄/矮对话区放不下矩形时降级成一行 `↑ Jump to End`；minimal 档与详情页不画。
- 点击矩形本体（按下与松开都在 `chatHintHit` 内）等价 Ctrl+End，命中区每帧重建；
  因此它在鼠标按下分支里先于对话选区处理，避免点成拖选。
- 次要文字配色：`muted` 深底 `#b4b4b4` / 浅底 `#3a3a3a`（纯中性灰，不带蓝调），
  `faint` 的 dim 系数 0.35 → 0.2（旧值在深色终端上偏灰）。256 色终端的
  `rgbToAnsi256` 对近中性色（饱和度 ≤ 0.18）走 24 级灰阶而不是 6×6×6 色立方，
  否则 `#aab3c0` 会被量化成 `175,215,215` 的青灰。测试：`terminal-frame.test.mjs`
  （位置/居中/点击）、`contrast.test.mjs`（调色板底线）、`theme.test.mjs`（ansi256 灰阶）。

## 斜杠补全的高度预算

- 候选列表不再吃满输入区上方的剩余高度：`resolveHintRowBudget(rows)`（tui-layout.ts）按终端高度分档
  （<16 行 3、<24 行 5、<32 行 7、其余 8），`renderFrame` 取 `min(预算, 剩余高度)` 作为候选行上限；
  输入 `/` 时不再用 15 行顶层指令把对话区挤没。
- 超出一屏时窗口跟随选中项滚动（↑↓ 循环），并留最后一行 `⋯ 还有 N 条 · ↑↓ 浏览`；
  `windowMenuRows` 统一处理斜杠指令与 @ 文件补全，预算只剩 1 行时不给提示行，避免挤掉唯一候选。
- 候选行数仍按 `suggestionRows.length` 从 `maxInputRows` 里扣减，所以输入框永远不会被列表顶出屏幕。
- **候选画在输入框外面**：`renderFrame` 的 inputBlock 顺序是「顶部分隔线 / 粘贴 chip / 输入行 /
  底部分隔线 / 候选 / 状态栏」。列表是临时浮层，进了框内会把输入框撑高、光标顶到框中间；
  放到底部分隔线之下，框始终只包住输入行。
- 测试：`tui-layout.test.mjs`（分档）、`terminal-frame.test.mjs`（候选在底部分隔线之下、
  24 行终端最多 6 条候选 + 1 行提示）。

## 终端外观（dark / light）与 `/appearance`

- **浅色板刻意是黑色系**：`LIGHT_THEME` 正文 `#111111`、`muted` `#3a3a3a`、`userMsgFg`
  `#0f0f0f`（Kero 预设同理 `#131315` / `#3f3f3f`）。白底终端上「中灰字」对比度不足、
  看久了疲劳，所以层次只靠明度（正文 18.9:1、muted 11.4:1、faint 6.6:1），不再靠降对比度。
- 外观决定**用哪套内置调色板**，与预设（`default` / `kero`）正交；`getThemeAppearance()`
  是唯一读点。
- 探测优先级（`terminal-appearance.ts` 的 `detectTerminalAppearance`）：
  `HAJI_THEME_APPEARANCE` 环境变量 → **用户持久化的 `theme.json.appearance`** →
  `COLORFGBG` → OSC 11 查询 → 回退 `dark`。前两者是明确选择，命中即**完全不发查询**
  （`preferred` 选项）；白底终端上 OSC 11 探测失败会退回 dark，把浅灰字压在白底上，
  光调 muted 治不了本，必须切浅色板。
- `/appearance [light|dark]` 是**立即指令**（`cli-help.ts` 的 `immediate: {}`，args 任意），
  无参显示当前外观；切换后 `setThemeAppearance` + `persistThemeAppearance` + `ui.forceRedraw()`，
  写进**用户级** `~/.haji/theme.json` 的 `appearance` 字段（与 `/theme` 写的 `preset` 共用文件、
  `writeUserThemeConfig` 合并写回，互不覆盖）。项目级同名段刻意忽略：外观是「这台终端」的事实，
  不该被克隆来的仓库配置改掉。
- **Markdown 的样式字典必须按主题重建**：`markdown-renderer.ts` 的 `ANSI = buildAnsiStyles()`
  曾经是模块加载期一次性构建，而该模块在启动早期就被 import（那时外观还没探测完），
  于是白底终端上列表符号 `•` 仍是深色板的 muted，`ANSI.reset` 更把后续正文刷成深色板
  foreground `#d9dee7`（白底上的浅灰字）——「我可以帮你之后全是灰的」就是这个。
  现在 `ANSI` 是 `let`，`render()` 开头调 `refreshAnsiStyles()` 按 `getTheme()` 身份 +
  `getColorLevel()` 比对后重建。**新增任何模块级的颜色常量都要先确认它在调用时取值**
  （`terminal-text.ts` 的 `SEQ` 用 getter，`theme.ts` 的 `fgSeq`/`themeReset` 是函数，都没问题）。
- 测试：`terminal-appearance.test.mjs`（持久化读写、`preferred` 跳过探测、env 覆盖优先）、
  `contrast.test.mjs`（浅色板近黑与对比度下限）、`immediate-command.test.mjs`（立即通道口径）、
  `hub-commands.test.mjs`（config 菜单项）、`markdown-responsive.test.mjs`
  （深色→浅色切换后 Markdown 不残留深色板颜色）。

### 256 色量化（ansi256）

- **不再逐通道取整进色立方**：`rgbToAnsi256` 在整张 xterm-256 表（216 色立方 + 24 级灰阶）里按
  **Oklab 距离**取最近色，彩度轴权重 1.8；近中性（Oklab 彩度 ≤ 0.03）只允许落到灰阶，
  免得灰字被染上邻近色相。旧实现（每通道 `round(v/255*5)` + 近中性走灰阶）色相根本不参与比较：
  浅色板绿 `#1d7a4d` 量化成青灰 `66`（95,135,135）、洋红 `#8a3aa5` 变粉、深色板蓝 `#82aadd`
  与强调紫 `#a995d6` 同落 `146`——「工具调用那块颜色怪怪的」有一半来自这里。
- diff 铺底单独走 `ansi256TintIndex`：**先按语义色相窗口筛**（增 = 绿区 120°±45、删 = 红区 0°±30），
  再在窗口内比亮度与彩度。理由：浅色板绿的色相 151° 正好夹在色块绿 120° 与青 180° 之间，
  按最近色挑会给淡绿条纹挑出淡青；纯亮度最近又会把浅底淡粉/淡绿压回灰阶（旧实现 254/255 两条都灰）。
- 测试：`theme.test.mjs`「ansi256 keeps hue and chroma…」「ansi256 diff tints stay inside their
  semantic hue family」。

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

## 终端状态上报（Kero / OSC 7501）

- Kero（kero.sh）侧栏的 working / waiting / idle 来自两路：`internal/detect/manifests/*.toml` 猜屏幕特征，
  以及**程序自报**的 OSC 7501；自报优先（存在 working / blocked 记录时 `look()` 直接跳过屏幕推断）。
  haji 不在 Kero 内置 agents 列表里，屏幕特征永远猜不到，所以状态由 `agent-status.ts` 主动上报。
- 判定为「可能在 Kero 后面」才写，且要求 stdout 是 tty：`$KERO_PANE`（直接跑在 Kero 拉起的 shell 里）
  或 `$SSH_CONNECTION` / `$SSH_TTY`（KERO_PANE 不跨 ssh 转发，但 OSC 字节会原样回到本机终端，
  tmux 在中间时可能被吞）；`HAJI_STATUS_REPORT=1|0` 强制开关，
  `-p` 无头模式在 `index.ts` 里 `setEnabled(false)`，否则 OSC 会混进 `--output-format json` 的输出。
- 报文：`ESC ] 7501 ; state=…:app=haji[:kind=…][:progress=…][:title=<b64>][:msg=<b64>] ESC \`，
  msg 解码 ≤2048 字节、title ≤192 字节（按 UTF-8 字符边界截断），控制字符与零宽/双向控制符会被过滤；
  不合规的报文 Kero 整条丢弃（`internal/daemon/osc.go#parseStatus`），所以别手搓字符串，用 `buildStatusSequence`。
- 生命周期（`turn-runner.ts` / `index.ts`）：回合开始 `working 正在思考` → 每批工具 `working 执行 <工具名>`；
  授权卡片 `blocked:permission`，计划审批与「拒绝并说明」`blocked:question`；正常收尾 `done`
  （Kero 侧是「idle + 未读 Done」）、Provider 失败 `error`、用户中止 `idle`。同一条报文重复上报会自动去重。
- 语义边界：`done` 不是 detect 状态而是 idle + unread；用户一按键 / 输入，done/error 记录即被丢弃，
  working/blocked 在进程退出时自动清掉，所以不需要 atexit 收尾。
- **窗口标题（OSC 2）另走 `terminal-title.ts`**：Kero 的侧栏行名与单窗格标题栏都取
  `Session.DisplayName`，用户没手动重命名时用的是**前台程序设的标题**（`Pane.Title`，来自 OSC 0/2），
  没设就退化成目录名。haji 原来一条标题都不发，所以侧栏只显示目录。现在写成 `haji · <会话标题>`
  （前缀用来标识来源；无标题时只留 `haji`），长度按显示宽度截到 120 列，控制字符与零宽/双向控制符
  压掉（裸 ESC 会把 OSC 打断）。挂点是 `updateStatusUI()` 里紧跟 `ui.setSessionTitle(...)` 一行，
  `/resume`、`/clear`、`generateTitleAsync` 完成都经过它，上报器内部去重所以每批工具调用不会重复写。
  开关与状态上报同一套（`resolveStatusReportEnabled` + tty），静默不写时窗口标题一个字节都不改；
  别在标题里放 braille/`◐` 这类字符 —— Kero 的 `proto.TitleBusy` 会把它们当成「在忙」。
- 测试：`packages/cli/test/agent-status.test.mjs`（报文与 Kero 的 key/value 正则、base64 上限、
  控制字符过滤、开关与去重、turn-runner / index 挂点）、
  `packages/cli/test/terminal-title.test.mjs`（标题形态 / 清洗 / 宽度截断 / OSC 2 报文 / 开关与去重）。

## 联网检索来源（websearch）

- 顺序：**官方 DeepSeek `/v1/tools/search`（仅在解析到 key 时）→ DuckDuckGo Lite → Bing RSS → Bing CN RSS**。
  官方源任何一步失败（网络、非 2xx、空结果）都静默落回公开源，所以零 key 用户的行为与之前完全一致。
- Key 复用 chat 那把：`DEEPSEEK_API_KEY` > `~/.haji/config.json` 的 `providers.deepseek.apiKey`。
  `deepseekApiKey` 传的是 **getter**（`/provider set` 改 key 后立即生效），baseUrl 每调用现场
  `resolveProviderSetting` 解析（改端点也不用重启），而不是启动时快照。
- 请求参数刻意固定 `count:5` / `need_content:false`：条数不影响单价但会成倍放大上下文，
  正文交给 `webfetch`。**summary 优先于 snippet**——官方文档说 summary 600～800 字符，
  实测 600～3800，所以逐条截 1200、总量仍由 `formatSearchOutput` 收在 8000。
- 计费 **5 元/千次成功请求**（只有 HTTP 200 且结果非空才计费），2026-11-01 起生效；
  `HAJI_WEBSEARCH_OFFICIAL=0` 可强制只用免费公开源。官方源成功一次经 `onOfficialSearch` 回调
  记一笔 `CostTracker.recordFlatFee("websearch")`（`flatFee` 记录，token 恒 0，金额按调用时刻
  现算：11-01 前 0、之后 ¥0.005），计入总花费与轮次花费、**不算模型请求数**，`/cost` 单列一行，
  费用日志页显示为 `DeepSeek Search · 网页检索`；记录随 `costRecords` 落盘。
- **webfetch 刻意不接官方 `/v1/tools/fetch`**：实测返回的 Markdown 被转义（`\#`、`\-`、`\/`，
  标题/列表/代码块语法全失效）、GitHub 页面 10.8s（本地 1.3s）、知乎/HN 等反爬场景双方都拿不到。
  所以本地 `webfetch` 自己把 HTML 转成 Markdown（见下节），而不是买接口。
- 测试：`web-search-deepseek.test.mjs`（官方优先/回退/空结果/零 key/中止/key 抹除/summary 封顶/自定义 baseUrl），
  `web-search-fallback.test.mjs`（三源降级未回归）。

### webfetch：HTML → Markdown（零依赖）

- 转换器在 `packages/plugins/src/web-fetch-tool.ts`，**不引 turndown / jsdom**：`tokenizeHtml` 逐标签扫描
  （引号内的 `>` 不会截断），`MarkdownStream` 维护行内缓冲 + 块缓冲 + 列表栈输出 Markdown。
  块级：h1-h6、ul/ol（嵌套用缩进）、`pre` → 围栏代码块（内部空白/缩进**原样保留**）、
  `table` → 管道表（无 thead 时首行当表头，单元格里的 `|` 转义）、blockquote；行内：a/strong/em/del/code/img。
  相对链接与图片按页面 URL 补全。
- 正文容器 `pickContentRoot`：`main` 优先，但最大 `<article>` 可见文本 ≥ main 的 50% 时改用该 article
  （单篇文章页 vs 卡片流页）；两者都没有且 article ≥400 字符才用它，否则整页。
- 噪声两段式：预处理删 `script/style/head/noscript/template/svg/canvas/iframe/nav/footer/aside/form/
  button/select/textarea` 与 `link/meta/base/input`；渲染时按 `role=navigation|banner|contentinfo|search|
  complementary` 与 id/class（`nav/sidebar/toc/breadcrumb/menu/skip-to-content/sr-only/visually-hidden`…）
  **整块跳过并按同名标签配平**。另有兜底：≥40 条且 ≥80% 是「单个链接」的列表整块丢弃（站点索引/巨型菜单），
  页面内目录通常只有几条，不受影响。
- 行内杂讯：零宽字符过滤；纯锚点链接（标题后的 `#`）整段丢弃；图片只保留有 alt 且非 svg/ico/badge/logo、
  src ≤200 字符的。
- **非 HTML 原样透传**：content-type 不含 `html`（或缺失且内容不像 HTML）时直接返回原文，
  `.md`/`.json`/`.txt` 不会被清洗。首行信封 `[网页抓取成功 - 目标地址: …]` 保持不变
  （`tool-output.ts` 剥壳、`pricing-agent.ts` 校验前缀都依赖它）。
- 截断 `truncateWebMarkdown`：按 `\n\n` 块边界裁到 `8000 − 信封长度`，不切进代码块/表格；
  末尾只剩孤立标题时连标题一起退回；收尾提示「后面还有《X》《Y》等 N 个小节，可用 focus 参数定位」。
  单个巨型块（整页一个大表格）按行裁。
- focus `selectFocusedWebText`：先按「标题 + 其正文」小节匹配（最多 4 节），页首 600 字符保留
  （命中章节本来就在开头则不重复），无结构文本退回原字符窗口语义，未命中返回全文。
- 测试：`web-fetch-markdown.test.mjs`（结构映射、嵌套列表、表格表头、噪声整块丢弃、非 HTML 透传、
  信封、预算截断、focus 章节挑选/窗口回退、错误与中止）。

## 代码风格与提交

- 注释与用户可见文案用中文；标识符与既有文件保持一致（camelCase，模块内工具函数不加 `export` 除非有测试需要）。
- 纯逻辑优先抽成可测函数放进现有 `*-config.ts` / `*-policy.ts` 一类模块，`index.ts` 的 `main()` 只做编排。
  斜杠命令按家族放 `provider-commands.ts` / `subagent-commands.ts` / `session-commands.ts`，经 `*CommandContext`
  访问器注入会话状态（可变 let 绑定必须走 getter/setter，不能拷贝值）；新增命令族时照此模式新建模块。
  带内部状态的命令族用工厂（`pricing-commands.ts` 的 `createPricingCommands(ctx)`：查询是否在跑、
  过程日志、已提醒模型留在模块内）；会话级编排用类（`PostEditVerifier`）。TerminalUI 里的纯状态
  转移抽成函数模块（`overlay-navigation.ts`、`terminal-keys.ts`、`terminal-menu.ts`），类只留持有
  状态与重绘；测试会直接读 `ui.costLog` / `ui.startupHits` 这类私有字段，搬字段前先查测试。
  类内的大方法按阶段拆：`handleMouseEvent` 只分流（悬停 / 滚轮 / 首页点击 / 左键按下·拖动·松开
  各一个方法，命中判定走 `startupHitAt` / `isOnChatHint`）；`renderFrame` 的整页视图在
  `renderOverlayPage`、输入区组装在 `buildInputBlock`。新增鼠标交互或底部区块时加在对应阶段方法里。
- `dist/` 未入库（`.gitignore` 中 `dist/`），提交时不包含构建产物。
- 新增交互逻辑尽量配一条 `packages/cli/test/*.test.mjs` 用例；测试通过临时目录 + 覆盖 `HOME`/`USERPROFILE`
  做路径隔离（参考 `provider-config.test.mjs` 的 `withIsolatedPaths`），不要读写真实 `~/.haji`。
