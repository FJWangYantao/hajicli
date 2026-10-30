# hajicli 架构

面向贡献者的架构导览。用户侧使用说明见 [README](README.md)，仓库协作约定见 [AGENTS](AGENTS.md)。

## 总览

hajicli 是一个终端 AI 编程助手（bin 为 `haji`），pnpm workspace monorepo，TypeScript strict + project references。分层与依赖方向：

```
packages/cli  （hajicli 发布包：TUI、命令分发、回合循环、主题）
   │  依赖
packages/plugins  (@hajicli/plugins：Provider 实现、模型注册表、工具、MCP)
packages/patrol-github  (@hajicli/patrol-github：巡检的 GitHub forge 适配器)
   │  依赖
packages/core  (@hajicli/core：会话、代理、压缩、经验、权限、Hook 等引擎)
```

另有 `packages/cli/native/terminal-engine`（Rust 原生终端渲染引擎，发布五平台预编译产物，缺失时自动回退 TS 实现）与 `spikes/`（探索性工作区，不参与 workspace 与发布）。

## CLI 层（packages/cli）

入口 `src/index.ts` 的 `main()` 只做编排，按顺序：

1. **启动**：early CLI 参数（`--version` 等）→ 终端外观探测（OSC 11 / `COLORFGBG` / 环境变量，见 `terminal-appearance.ts`）→ provider 配置与 API Key 校验 → 偏好读取（`cli-runtime.ts`，两级 `preferences.json`，项目级逐字段覆盖用户级）→ 初始模型与 provider 解析（`provider-models.ts#resolveInitialSelection`，纯函数）。
2. **引擎接线**：HookEngine / SnapshotEngine / PermissionEngine / ExperienceStore / SkillRegistry / TaskStore / SessionManager / AgentManager / SharedToolExecutor / SubagentRunner / McpManager 逐一实例化并互相注入回调。
3. **REPL 主循环**：输入队列（后台输入 + 待处理队列 + 枢纽转发）→ 斜杠命令分发 → 普通消息进入回合执行（流式渲染、工具批调度、中止语义）。
4. **收尾**：经验提炼（DistillEngine）、Trace 落盘、会话 flush、MCP 清理。

### 命令模块划分

斜杠命令按家族拆分，`main()` 中每个家族一行分发：

| 模块 | 覆盖命令 |
| --- | --- |
| `provider-commands.ts` | `/provider`（切换 / add / set / unset / 状态） |
| `subagent-commands.ts` | `/subagent`、`/preset`、`/agents` |
| `session-commands.ts` | `/clear`、`/resume`、`/rewind` |
| `workspace-commands.ts` | `/workspace`（根与路径规则：list / add / remove / allow / deny / rules） |
| `worktree-commands.ts` | `/worktree`（每个新会话自动开独立 git 工作树：on / off / list / remove） |
| `patrol/commands.ts` | `/patrol`（PR 巡检：status / inspect / register / start / stop / watch / unwatch / run-once / pause / resume / retry） |
| `index.ts` 内联 | `/model`、`/effort`、`/permission`、`/compact`、`/skill(s)`、`/memory`、`/instinct`、`/mcp`、`/perf`、`/help`、枢纽入口等小命令 |

命令模块通过 `*CommandContext` 接口注入会话状态：可变状态（当前模型、消息数组等）一律用 getter/setter 访问器，与 `main()` 的 `let` 绑定保持同步。这是新增命令时应遵循的模式。

### TUI 与渲染

- `terminal-input.ts`：`TerminalUI`——全屏布局（对话区 / 状态栏 / 输入框）、readInput / readSelection / 实时区域（setLiveTail）。输入编辑、鼠标选区与整帧渲染共享私有状态，保持为单一类；面板类构建逻辑已抽为纯函数。
- `inline-image-sync.ts`：内联图 placement 同步层（`InlineImageSync`）与 `/view` 全屏看图帧（`renderImageOverlayFrame`）。原先挂在 `TerminalUI` 上的三项节流状态（上次放置时刻 / 是否有被抑制的微调 / 收尾定时器）和 kitty 上传、删除、裁剪重放逻辑搬到这里，宿主只注入 `scheduleRender` 与 `write`；纯规划算法仍在 `terminal-image.ts`（`diffInlinePlacements` / `clipInlinePlacement`）。
- `pointer-hits.ts`：指针可点目标的登记与命中测试——队列 steer 行（`buildQueueSteerRows` / `buildQueueSteerHits`）、首页入口与侧栏区域（`rowSpanAt` / `findSidebarRegion`，侧栏按登记顺序取最后一个，即深层优先）、「回到底部」浮标（`spanContains`）。`TerminalUI` 只负责「拿到目标 → 执行动作」。
- `overlay-page.ts`：覆盖对话区的只读整页视图（上下文详情 / 费用日志三层）的渲染决策：选当前该画哪一层、按该层最小尺寸判断终端放不放得下、把帧内几何换算成屏幕坐标（1 基）的命中区域（`OverlayHit`）。`TerminalUI` 只写回命中表与夹紧后的选中下标；页面状态转移在 `overlay-navigation.ts`。
- `terminal-panels.ts`：状态栏 / 活动状态行 / 任务面板的纯构建函数（与 `agent-panel.ts` 同模式），输入标量状态输出 ANSI 行，可用固定宽度直接单测。活动行放在对话区尾部（空一行跟在最新内容后，满屏时固定在对话区底部，不进 `chatContent`），底栏状态栏常驻；细节文字用「解码」动效（`buildDecodedText`）循环还原，停滞 / 等授权 / 终止时静止。minimal 档或对话区被多行输入挤到放不下时，活动行退回底栏顶替状态栏。
- `native-terminal-engine.ts`：加载 Rust `.node` 模块（换行 / ANSI 文档排版），失败回退纯 TS；`/perf` 可看当前引擎。
- `markdown-renderer.ts`：流式 Markdown 渲染 + 节流；`theme.ts`：深浅两套调色板 + 自定义色对比度兜底（WCAG AA）。
- `activity-indicator.ts`：状态行（思考 / 生成 / 工具）与工具块视图（ToolRunView）。
- `agent-status.ts`：向终端自报「本程序在做什么」（OSC 7501）。Kero 侧栏的 working / waiting / Done 直接来自它，`done` / `error` 只在用户下一次输入前保留；在 `$KERO_PANE` 或 ssh 会话（OSC 可跨 ssh 回传）且 stdout 是 tty 时启用，无头模式强制关闭。
- `terminal-title.ts`：把会话标题写成终端窗口标题（OSC 2，`haji · <会话标题>`）。Kero 的侧栏行名与单窗格标题栏优先用前台程序设的标题，没设就显示目录名；由 `index.ts` 的 `updateStatusUI()` 同步，开关与 tty 判定复用 `agent-status.ts`。
- `process-fold.ts`：对话区过程折叠的纯函数（工具类别归类、段统计、摘要行按宽度降级、段文本折叠/展开）。TerminalUI 采用两层存储：已封口片段 `sealedSegments`（普通内容 + 过程段）+ 尾部 `chatContent`，因此 `writeChat` / `updateChatFrom` 的偏移语义不变，只有封口那一刻平移 `streamStartOffset`。`concatAnsiLayouts` 让选区布局按段拼接，折叠起来的内容不会被复制出去。

### 回合执行（turn-runner.ts）

`runAgentTurn(deps, input)` 承担一个完整对话回合：prompt 提交 → UserPromptSubmit Hook（可能触发自动压缩）→ 循环（每次请求前的安全点也会检查自动压缩）调用 `provider.completeStream`（流式正文 + 推理预览 + onRetry 提示）→ 工具调用按依赖分批（`tool-batch.ts`，只读工具并行）→ 结果写回消息。关键语义：

- **prompt 收回**：请求真正发出前按 Esc，prompt 不入会话、回填输入框（`commitPromptForRequest` 由 `onRequestStart` 划界）。
- **中止**：发出后 Esc → AbortController，部分输出保留，工具进程后台清理。
- **Plan 模式**：只读工具 + Todo 计划，`PLAN_READY_MARKER` 后进入审批选择，批准后切换权限档继续执行。
- **失败止损**：`RepeatedFailureTracker` 按「工具 + 目标」累计；`edit` 只按文件计、原因变化不重置，且只有 `edit` 成功才清零（`read` 是恢复动作，不能洗掉计数）。同一文件第 5 次编辑失败即结束本回合。`edit` 在 oldText 未命中但 newText 主体已存在时返回 `[文件无需修改]`（幂等），避免「上一笔已写入、仍按旧 oldText 重试」的空转。
- **并发写**：`edit` 发现 hash 过期且当前版本不是自己的版本链尾时，返回带 `[并发写入]` 的冲突并附「最近 N 秒内被写入」；`turn-runner` 立刻停止本回合自动编辑，把「可能有另一个代理在跑」交回用户确认。
- **状态注入**：`permissionMode` / `riskThreshold` 经 `TurnDeps` 访问器读取（Plan 审批会在回合中切档）；provider / 模型 / 思考强度在回合开始时快照。

## Provider 与模型（packages/plugins）

- `deepseek.ts` / `volcengine.ts` / `openai-compatible.ts` 三个 Provider；经 core 的 `ObservableModelProvider` 包装接性能观测。
- `model-registry.ts`：内置模型元数据（归属 provider、上下文窗口）。`provider-config.ts`（cli 包）：`PROVIDER_NAMES` 内置集合 + 用户级/项目级 `config.json` 合并视图；自定义 provider 走 OpenAI 兼容端点。
- Key 解析优先级：环境变量 > 配置文件。面向用户的列表必须走 `listVisibleProviderNames`（见 AGENTS.md 的踩坑记录）。

## 工具与权限

- 工具实现全部在 `packages/plugins/src/*-tool.ts`（bash / read / write / edit / grep / glob / web / skill / task / subagent / verifyagent）；MCP 外部工具由 `mcp.ts` 启动并转换为同一 `BaseTool` 接口。另有 `selfstate`（按需查询工作区根、权限档、模型、上下文用量与压缩状态）与 `history`（按 action=list/search/read 查询 `.haji/sessions`、`.haji/transcripts` 与当前会话；只读、输出有界、不接受任意路径）。
- `request`（`plugins/request-tool.ts`）是 Agent 的受控申请通道：一次只申请一个具体目标（`workspace.add` 目录 / `permission.mode` 提到 accept-edit 或 auto），由 CLI 弹单次卡片；批准后复用 `/workspace add` 的 `addWorkspaceRoot` + `syncPathScope`，权限档只改会话内状态（`applyPermissionMode(..., { persist: false })`）不写 preferences。不能申请根目录、通配符或 bypass-permissions；被拒绝的目标本会话不再重复弹卡。
- `SharedToolExecutor`（cli）统一执行：HookEngine `PreToolUse`（权限评估 → 授权卡片 / Auto 分类器拦截）→ 执行 → `PostToolUse`（Trace 记录、经验观测采集、Git 快照）。
- `PermissionEngine`（core）按 `permissionMode`（plan / default / accept-edit / auto / bypass-permissions）+ `riskThreshold`（Auto 档危险阈值）决策；只读工具（含 MCP `readOnly: true`）自动放行。
- 受保护目标（`core/protected-targets.ts`）在 `evaluate()` 最前面做确定性判定，早于 plan / bypass 短路：`forbidden`（递归强删工作区或更外层）直接拒绝；`hard`（授权配置、技能/记忆目录、快照与审计数据、强推/发布等）任何档位都必须逐次确认且不可永久授权；`sensitive`（凭据文件、`AGENTS.md`）可确认后按会话/全局记住。PreToolUse 对 hard 级跳过持久放行规则；`HAJI_ALLOW_PROTECTED=1` 可整层关闭（仅受控环境）。用户级 `paths.deny` 优先于 bypass 档。
- 文件工具的作用域判定在 `PermissionEngine` 里完成（`core/path-scope.ts`）：工具只把路径解析成绝对路径，边界由权限层给出 allow / prompt / deny。工作区根 = 启动目录 + `--add-dir`（本次进程）+ `/workspace add`（`~/.haji/workspaces.json`，按项目分组）；越界路径在 default / accept-edit / auto 档都走授权卡，授权键为「读/写 + 目录前缀」，`HAJI_ALLOW_OUTSIDE_WORKSPACE=1` 可整段跳过。
- 用户级路径规则 `~/.haji/permissions.json` 的 `paths.allow / paths.deny`（`deny` 优先）：项目级文件里的 `paths` 段被刻意忽略，避免克隆仓库自带扩权；`/workspace allow|deny|rules` 管理。bash 的只读判定复用同一组根（根内绝对路径可自动只读，/etc 之类仍需审批）。
- 会话级授权按 key 记忆（bash 按命令前缀，工作区外按目录前缀），切换会话即失效。
- 跨会话持久授权（`permission-rules.ts`）：授权卡片可选「永久允许·本项目 / 全局」，写入 `.haji/permissions.json` / `~/.haji/permissions.json`（键与会话级同形态）；PreToolUse 在权限引擎评估前命中即放行（plan / bypass 两档不查表）。`/permissions` 列出并删除规则。路径授权键只会写用户级。
- 无头单次模式 `haji -p "prompt"`（`headless.ts`）：跳过 logo 与交互主循环，跑完一个回合直接进入退出清理；TerminalUI 以 `forceNonInteractive` 强制走 stdout 直写降级，提示性输出一律改道 stderr（stdout 只含模型正文与工具块）。`--permission-mode` 可指定档位（plan 自动按 default 执行）；`--output-format json` 静音正文并输出结构化结果（text/usage/cost/sessionId）；prompt 传 `-` 从 stdin 管道读取。未命中放行规则的工具调用在 stdin 为 TTY 时 y/N 确认，管道/CI 下自动拒绝。退出码：回合完成 0 / 启动错误 1 / SIGINT 130。

## 费用、模型路由与目录

- 单价与档位在 `model-registry.ts`（`pricing` 每百万 token 估算值、`tier` 标记 utility 档）。
- `cost-tracker.ts`：主线回合 onUsage 记账，`/cost` 按模型汇总估算费用（未定价模型只计 tokens）。
- 杂活模型路由（`provider-models.resolveUtilityModel`）：压缩摘要 / 会话标题 / 经验提炼优先走最便宜的可用模型；偏好 `utilityModel` 显式指定（不可用回退主模型）。跨 provider 时按需构建独立 provider 实例（`getUtilityRuntime` 缓存，provider 配置变更即失效）。
- 用户模型表 `~/.haji/models.json`（`user-models.ts`，mtime 缓存）：内置 provider 上新模型无需发版——登记 model/provider/contextWindowTokens 即进入 `/model` 列表、`detectProviderForModel` 路由与上下文窗口解析。
- `@路径` 文件引用（`file-mentions.ts`）：提交时把工作区（含追加根）内命中文件展开为 `<attached_file>` 附件块；越界/不存在/二进制记入 skipped 提示。
- 图片输入 `/image <路径> [提示词]`（`image-command.ts`）：本地图片（png/jpg/gif/webp/bmp，≤6MB）转 base64 附件，经 core `ChatMessage.attachments` → plugins `messageContentOrParts` 转多模态 content parts（需视觉模型）。
- 编辑后验证（`post-edit-verify.ts`，LSP 轻量替代）：主 Agent write/edit 成功后跑项目 typecheck（`HAJI_POST_EDIT_VERIFY` 可指定/`"0"` 关闭），诊断以系统消息注入会话供模型自纠；10s 冷却防编辑连发拖慢回合。

## 子代理

`AgentManager`（core）管理生命周期与并发（最多 3 个并行只读）；`SubagentRunner` 跑实际回合（独立 provider / 工具白名单 / token 与调用数预算）。后台 Agent 完成后注入系统通知，**结果必须经父 Agent `verifyagent` 独立验证**——验证上下文以标记对包裹进系统提示词（`refreshAgentVerificationContext`）。预设系统（`subagent-presets.ts`）+ 交互向导（`subagent-wizard.ts`）。

## PR 巡检（Patrol）

自动接管**已登记来源**的 agent PR：独立审查 → 退回修改 → 争议升级最终裁决 → 合并门禁 → 合并 / 有理由地终止，全程无人工裁决节点。

- **core 侧 `packages/core/src/patrol/`**：协议类型（`PatrolJob` / `PatrolFinding` / `PatrolDecision` / `PatrolVersion` / 租约 / 动作幂等记录）、状态机（`state-machine.ts`，合法转换 + 守卫：`ready_to_merge` 必须有当前版本通过性结论且无阻塞问题）、预算（`budget.ts`，轮次 / 费用 / 时长，普通阶段预留裁决额度）、合并门禁（`merge-gate.ts`，程序侧确定性检查：非草稿、head 与结论版本一致、可信来源的必需 CI 全绿、无冲突、未暂停）、持久化（`patrol-store.ts`，`.haji/patrol/state.json` + `registry.json`，原子写；重启自动恢复：running run → aborted、死租约清除、executing 动作回退 intended）。
- **forge 适配器 `packages/patrol-github/`**：`@hajicli/patrol-github`，只依赖 `fetch` 与 `@hajicli/core` 的 `PatrolForgeAdapter` / `ForgePullRequest` 契约（契约在 `core/src/patrol/forge.ts`），不含 CLI / TUI 依赖；`GH_TOKEN` 鉴权、merge 带 sha 条件、已合并识别为幂等成功。新增 GitLab / Gitea 等平台按同一契约另开包，无需改动 CLI。
- **cli 侧 `packages/cli/src/patrol/`**：runner（`runners.ts`，结构化 fenced JSON 输出解析——非法输出一律降级 inconclusive / failed 不放行；生产实现起无头 haji 进程在独立 worktree）、编排服务（`service.ts`，事件驱动：`drain()` 连续推进到本轮无状态变化为止，`tick()` 保留为单轮对账 + 推进；`runLoop` 有进展立即继续，等外部（CI / 草稿 / head 变化）时从 20s 起指数退避复查，完全空闲时按 `pollIntervalMs` 起指数退避探测新 PR、上限 64 分钟（侧栏启动的常驻巡查传 `idleBackoffCapMs = pollIntervalMs`，即固定间隔探测，保证「PR 一来就跑」；再点侧栏或 `/patrol stop` 停止）；同目标分支一轮串行合并；远端动作先存意图再执行；`runLoop(signal, { wake })` 的等待是「事件或退避到期，先到者胜」——`wake` 来自 `wake.ts` 的出站 SSE 订阅（配置 `wakeUrl` 才创建，smee 形态），**只做加速、不替代轮询**：事件丢失 / 乱序 / 通道故障时一律退回纯轮询）、命令（`commands.ts`，`/patrol run-once` 走 `drain()` 跑到无进展；`/patrol watch <url>` 写 `wakeUrl`）。
- **关键语义**：结论只锚定 head + 规则版本（base 漂移不触发重审，合并时重查 checks/mergeable）；普通修改默认 3 轮后升级裁决，裁决后修改默认 2 轮，耗尽终止并记录原因；执行 agent 可 `disputed` 提异议，裁决 agent 可 overrule（驳回误报）/ remediate / redo / descope / terminate。
- **可观测性**：每个 run 落盘 `.haji/patrol/runs/<jobId>/<runId>.log`（start / finish 与失败摘要，换行压成单行）；侧栏运行中显示当前阶段与已耗时（如 `#12 审查中 · 3m`），巡检页显示最近一次运行摘要。
- 来源登记是接管前提：`/patrol register <PR> --task <id> --brief <任务>`，未登记的 PR 不自动取得写入 / 合并资格；PR 正文不参与来源判定。
- 测试：`patrol-core.test.mjs`（状态机 / 预算 / 门禁 / 存储）、`patrol-service.test.mjs`（假 GitHub + 剧本 runner 的闭环：通过合并、修复后合并、裁决驳回 / remediate、轮次耗尽终止、审查中新增提交、重启恢复、幂等合并、暂停、未登记不接管）、`patrol-github.test.mjs`（在 `packages/patrol-github/test/`）、`patrol-runners.test.mjs`、`patrol-commands.test.mjs`、`patrol-wake.test.mjs`（载荷解析 / SSE 唤醒源去重与超时 / `runLoop` 被事件提前打断 / 唤醒源故障退回轮询）、`patrol-daemon-state.test.mjs`（守护进程心跳文件的原子写读、陈旧与 pid 失效判据、侧栏在守护进程在跑时只读状态不联网、`/patrol stop` 改提示 systemctl）。

## 上下文管理

- token 估算：`estimateMessagesTokens` / `estimateTextTokens`（core）。
- 自动压缩：两个安全点共用同一套阈值与管线（`index.ts` 的 `autoCompactContext`）。① 用户提交 prompt 前（UserPromptSubmit Hook）：`splitPendingUserTurn` 把最新一条用户消息及其后续消息排除在压缩之外。② 回合内每次请求前（`turn-runner` 的 `TurnDeps.autoCompactContext`）：整个当前回合参与压缩，`runCompactionPipeline({ protectLastUserTurn: true })` 让 L2 裁剪不切断最后一个用户回合——长任务单回合内累积的工具输出正是撑爆窗口的主因。管线为 `runCompactionPipeline` 四层（`context-compact.ts`，模型摘要失败降级本地摘要），带 rearm 防抖。
- 手动 `/compact` 强制全管线。压缩摘要以 `[Compacted Context Summary]` 后缀保留在系统提示词尾部，刷新提示词时原样带过。
- 压缩记录随会话落盘：`SessionUsage.lastCompaction`（时间 / 前后 token 与字符 / 层级 / `transcriptPath` / 摘要来源）与消息一起写进会话文件；`/resume` 显式回放「压缩完成、字符与 Token 估算、压缩前完整记录、摘要」——摘要只存在于 system 消息里，普通历史渲染会跳过它。老会话没有该字段时按系统提示词里的标记与轨迹行兜底。`selfstate` 的 `context.lastCompaction` 也读这个持久化字段，`/resume`、`/clear` 跟着会话重置。

## 会话、快照与 Rewind

- `SessionManager`（core）：会话持久化于 `<cwd>/.haji/sessions/`，含异步标题生成。
- 自动 worktree（`worktree.ts`）：启动时在 `main()` 最前面读取主仓库 `.haji/config.json` 的 `worktree` 开关，命中就在 `~/.haji/worktrees/<仓库名>-<指纹>/<会话名>` 建工作树、开 `haji/<会话名>` 分支并 `process.chdir()` 进去；后续所有 `process.cwd()` 读取（会话、快照、工具、工作区根）自然落在新工作树里。`-c/-r` 恢复会话与已在 linked worktree 中启动都会跳过，避免嵌套。`/worktree remove` 会先把工作树内的会话与快照归档到主仓库 `.haji/worktree-archive/`。
- `SnapshotEngine`：每条用户消息前 `createAnchor` 生成 Git 快照（`.haji/snapshots/`）。快照键工作区内为 posix 相对路径，工作区外为 `external:<绝对路径>`，因此经授权的越界写入同样可回退、可进 `/diff`。`/rewind` 选择历史节点 → `rollbackOwnedChanges` 撤销本会话拥有的改动（外部改动过的文件保留）→ 截断消息历史 → 消息文本回填输入框。bash 的工作区外副作用不在快照范围内。
- Trace：`trace-logger.ts` 落盘 `.haji/traces/`（meta + events.jsonl），`startTraceServer` 提供本地观测页（`/viewer`）。

## 经验系统

- `ExperienceStore`（core）：观测流 `<cwd>/.haji/observations.jsonl`（按月归档）；会话结束时 `DistillEngine` 双路径提炼（统计规则 + LLM 分析），产出本能规则 `.haji/instincts/` 与记忆候选 `.haji/memory/`，经 `/memory confirm` 确认。
- `ExperiencesPromptPart` 把相关记忆按最近用户消息召回进系统提示词。
- 交互入口 `/memory`、`/instinct`（`experience-commands.ts`）。

## Skill / Task / MCP

- Skill：`SkillRegistry` 扫描 `<cwd>/.haji/skills` 与 `~/.haji/skills`；`loadskill` 工具加载进上下文，支持资源文件与用户手动调用（`/skill`）。作用域随会话消息恢复（`restoreScopeFromMessages`）。
- Task：`TaskStore` 内存任务计划（Plan 模式 Todo），随会话 scope 隔离；工具族 taskcreate / tasklist / updatetask / taskfinish。
- MCP：两级 `config.json` 的 `mcpServers` 并行启动，失败降级不阻塞；`readOnly: true` 的 server 工具自动免审批。

## 磁盘布局

```
<project>/.haji/
  config.json          # 项目级 provider/MCP 配置（含明文 Key，git 忽略）
  preferences.json     # 项目级偏好（模型/强度/provider/权限档/危险阈值）
  sessions/ traces/ snapshots/ agents/
  observations.jsonl instincts/ memory/      # 经验系统
  skills/              # 项目级 Skill
~/.haji/
  config.json preferences.json skills/       # 用户级对应物
```

## 工程设施

- 构建：`pnpm build`（tsc project references 增量）；`build:native` 编译 Rust 引擎；`build:full` 全量。
- 测试：`pnpm test` = build + `scripts/run-tests.mjs`（跑 `packages/*/test/*.test.mjs`）；测试 import `dist/*.js`，改源码必须先 build。源码断言类测试（如 `resume-history.test.mjs`）直接读 `src/*.ts` 做正则检查，重构搬移代码时记得同步其读取路径。
- Lint：biome，行尾统一 LF（`.gitattributes` + `formatter.lineEnding: lf`），基线 0 error，新增代码不得引入错误。
- CI（`.github/workflows/ci.yml`）：lint + { windows, ubuntu } × { Node 20.18.1, 22, 24 } 测试矩阵，打包自检在基准 Node 上跑。
- 发布（`release.yml`）：`v*` 标签触发，五平台矩阵编译原生模块 → `verify-packages.mjs`（各包版本一致 + tag 匹配 + tarball 内容校验）→ 按依赖序发布四个包 → 自动生成 GitHub Release notes。
