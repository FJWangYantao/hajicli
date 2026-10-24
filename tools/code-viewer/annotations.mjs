/**
 * code-viewer 注解数据(手动维护)
 *
 * seg.at   —— 该段起始行内容的唯一子串(构建时定位为起始行号,段间自动衔接)
 * seg.title—— 段落标题(显示在注解卡片上)
 * seg.note —— 注解正文,支持 <code> <b> 简单 HTML
 * seg.tags —— 小标签数组
 */

export const OVERVIEW = {
  intro:
    "HAJI CLI 是一个用 TypeScript 编写的终端 AI 编程助手(pnpm monorepo,MIT 协议,已发布 npm 包 <code>hajicli</code>):支持流式对话、Plan Mode、可中止工具调用、会话恢复、/rewind 代码回退,以及最多 3 个并行只读子代理与一套会自我学习的「经验系统」。本页面把整个仓库的源码按<b>逻辑段落</b>切开,一段代码配一段中文注解,可以搜索、跳转、拖动对照阅读。",
  pkgCli:
    "终端交互层:REPL 主循环、TUI 渲染、按键/鼠标输入、Markdown 流式渲染、主题系统、/provider /subagent 等命令与向导。入口 index.ts 是全项目的接线中心。",
  pkgCore:
    "引擎内核:Agent 管理器、子代理执行器、上下文四层压缩、经验存储与提炼、Skill 注册表、快照/回退引擎、权限引擎、Hook 引擎、会话与 Trace 持久化。不依赖 cli/plugins。",
  pkgPlugins:
    "工具与模型接入:18 个内置工具(bash/read/write/edit/grep/global/projectinfo/web 系列等)、3 个 OpenAI 兼容 Provider(DeepSeek/火山引擎/自定义端点)、MCP 客户端与公共基础设施(ripgrep 封装、网络策略、输出限幅)。",
  pkgNative:
    "Rust 编写的 NAPI 原生终端引擎:haji_terminal_engine 提供 ANSI 感知折行与选区文档布局两个接口,正确处理 CJK 宽字符/emoji/零宽字符;缺失时 CLI 自动回退 TS 实现。",
  pkgTests:
    "node:test 编写的端到端测试(构建后对 dist 运行),覆盖 agent 管理、经验系统、压缩管线、终端协议、权限、provider 重试等关键行为。",
  flow: [
    { no: "①", t: "启动 main()", d: "加载 /provider 两级配置与 API Key → 构建 Provider 工厂 → 注册 18 个内置工具 + MCP 外部工具 → 扫描 Skill → 起 Trace 观测服务 → 进入全屏 TUI。" },
    { no: "②", t: "REPL 主循环", d: "从输入框/待处理队列取一条输入;斜杠命令就地分发(/model /subagent /rewind …),普通消息进入「延迟提交」机制后交给 Agent 循环。" },
    { no: "③", t: "流式生成", d: "provider.completeStream 发起请求;思考/重试/用量经 ActivityIndicator 显示;正文用 MarkdownStreamRenderer 增量渲染,按帧节流刷屏。Esc 在请求发出前可无痕收回 prompt。" },
    { no: "④", t: "工具调用", d: "校验工具参数 → createToolCallBatches 分批(只读并行/写串行)→ SharedToolExecutor 统一执行:PreToolUse 权限钩子 → 变更快照 → 执行 → PostToolUse 观测采集 → 结果回填继续循环。" },
    { no: "⑤", t: "子代理(可选)", d: "SubagentRunner 在独立上下文跑 research/review/implement 子 Agent(Token/工具次数/轮数三重预算),结果强制标记 UNVERIFIED,父 Agent 必须用 verifyagent 独立验证。" },
    { no: "⑥", t: "收尾沉淀", d: "退出 finally:flush 经验观测 → Stop Hook → DistillEngine 双路径提炼(统计检测器 + 智能触发 LLM)产出规则/记忆候选 → 会话与 Trace 落盘;高置信规则下次启动作为系统提示词分片注入。" },
  ],
};

export const ANNOTATIONS = {
  /* ================= CLI 主入口 ================= */
  "packages/cli/src/index.ts": {
    desc: "CLI 主入口(3445 行):组装 core 的全部引擎与 plugins 的全部工具,驱动 REPL 主循环——启动初始化、斜杠命令分发、流式对话 + 工具调用循环、Plan 审批、子代理接线与经验系统收尾都在这一个文件里完成。理解了它就理解了整个项目的运行时拓扑。",
    segs: [
      {
        at: 'import { exec } from "node:child_process";',
        title: "模块导入:三层依赖装配",
        note: "依赖分三组,对应架构的依赖方向 <b>cli → core ← plugins</b>:①<code>@hajicli/core</code> 提供 AgentManager、上下文压缩管线、经验系统、权限/快照/Hook 引擎等「引擎层」;②<code>@hajicli/plugins</code> 提供 18 个内置工具、三个 Provider 与 MCP 管理器「能力层」;③本包局部模块(TerminalUI、provider-config、markdown-renderer 等)「交互层」。core 不反向依赖任何一方,plugins 与 cli 互不依赖。",
        tags: ["架构"],
      },
      {
        at: "const DEEPSEEK_MODELS = MODEL_REGISTRY.filter",
        title: "顶层工具:模型归属探测与展示",
        note: "<code>detectProviderForModel</code> 判定一个模型值属于哪个 Provider:先看内置注册表(deepseek/volcengine),再查自定义 provider 声明的模型列表,最后回退 deepseek。关键边界:同名模型可能同时被内置与自定义 provider 声明,此时优先尊重用户当前使用的 provider,避免请求被静默改道到官方端点扣费。<code>EFFORT_OPTIONS</code> 是五档思考强度(low→max)的菜单数据。",
        tags: ["Provider"],
      },
      {
        at: "async function main() {",
        title: "main() 启动:埋点、配置与密钥检查",
        note: "启动流程:①<code>HAJI_STARTUP_PROFILE=1</code> 时向 stderr 输出各阶段耗时(供 scripts/profile-startup.mjs 采集),正常零输出;②<code>handleEarlyCliArgs</code> 处理 --version/--help 早退;③加载 provider 配置,从环境变量或配置文件取火山/DeepSeek 密钥,一个都没有就报错退出;④清屏 + 打印 Logo。",
        tags: ["启动"],
      },
      {
        at: "const buildProvider = (",
        title: "Provider 工厂与可用模型列表",
        note: "<code>buildProvider</code> 按 provider 名构造三类实例:火山引擎(ark 端点)、DeepSeek、自定义 OpenAI 兼容端点,统一用 <code>ObservableModelProvider</code> 包一层以接入 Trace 追踪。baseUrl 解析优先级:环境变量 > 配置文件 > 内置默认。<code>buildAvailableModels</code> 汇总有密钥的模型;每个模型的上下文窗口 = provider 配置的 <code>modelContextWindows</code> 优先于内置注册表。",
        tags: ["Provider", "上下文窗口"],
      },
      {
        at: "const envModel = (",
        title: "初始状态:模型/强度/权限的优先级链",
        note: "初始模型按 <b>环境变量 > 上次保存偏好 > 默认 deepseek-v4-flash</b> 解析;初始 provider 沿用上次保存值(API Key 可用且与模型归属不矛盾时),否则按模型反推——保证自定义 provider 重启后仍被记住。思考强度、权限模式、危险阈值同样走「环境变量 > 偏好 > 默认」。随后实例化权限引擎、Hook 引擎、快照引擎。",
        tags: ["启动", "配置"],
      },
      {
        at: 'hookEngine.register("PreToolUse"',
        title: "Hook① PreToolUse:工具调用前的权限审批",
        note: "每次工具执行前先过 <code>permissionEngine.evaluate</code>:<b>allow</b> 直接放行;<b>prompt</b>(default 模式下的修改型工具)暂停输入、向用户展示 y/N 确认,拒绝则把「用户拒绝」作为工具输出回给模型;<b>deny</b>(auto 模式安全分类器超阈值)直接拦截并给出原因。这是 Plan/默认/Auto 权限档位真正生效的位置。",
        tags: ["权限", "Hook"],
      },
      {
        at: 'hookEngine.register("PostToolUse"',
        title: "Hook② PostToolUse:观测采集(经验系统的数据源)",
        note: "工具执行后做两件事:①<code>tracker.recordToolExecution</code> 写入 Trace 轨迹(审计);②<code>experienceStore.appendObservation</code> 把这次调用(含失败样本)追加进内存观测缓冲——这是「经验系统」的全部原料,会话结束时由 DistillEngine 提炼为规则/记忆。",
        tags: ["Hook", "经验系统"],
      },
      {
        at: 'hookEngine.register("UserPromptSubmit"',
        title: "Hook③ UserPromptSubmit:自动上下文压缩",
        note: "每次用户提交消息时估算 token:超过阈值(triggerTokens)且「已装填」(armed)才触发 <code>runCompactionPipeline</code> 四层压缩;<code>splitPendingUserTurn</code> 先把当前待发送轮次从历史里切出来,只压历史不压新消息。压缩后若仍高于 rearmTokens 则不再重复触发(防抖),需先降回低位才能重新装填。模型摘要失败自动降级本地摘要并黄字提示。",
        tags: ["Hook", "上下文压缩"],
      },
      {
        at: "let provider = buildProvider",
        title: "压缩摘要器、系统提示与 Skill 扫描",
        note: "<code>summarizeMessagesForCompaction</code> 是压缩 L4 层用的摘要器:把对话转 JSONL,用一段精心设计的中文指令要求「保留目标/已完成/未完成/关键决策/精确错误文本」生成结构化摘要(reasoningEffort=low、maxTokens=6000)。随后创建 SystemPromptManager 并注册「经验召回」分片、注册 SIGINT 最小收尾(flush 观测)、扫描两级 Skill 目录、启动 3000 端口 Trace 服务。",
        tags: ["上下文压缩", "Skill", "Trace"],
      },
      {
        at: "const taskStore = new TaskStore();",
        title: "工具注册表与 MCP 外部工具接入",
        note: "注册 18 个内置工具(bash/read/write/edit/global/grep/projectinfo/web 系列/skill 系列/task 系列/subagent/verifyagent)。<code>subagent</code> 与 <code>verifyagent</code> 是薄门面:真正的执行器 <code>runSubagent</code>/<code>verifyAgent</code> 先占位、后文注入(避免循环依赖)。MCP 外部工具从用户级+项目级 .haji/config.json 读取,并行启动,单个失败降级为警告不阻塞;<code>readOnly: true</code> 的 server 工具注册进权限引擎自动放行。<code>activeTools()</code> 在 Plan 模式下只暴露只读+任务+子代理工具。",
        tags: ["工具", "MCP", "Plan"],
      },
      {
        at: "const ui = new TerminalUI({",
        title: "TUI、会话与 Agent 管理器初始化",
        note: "装配终端 UI:Logo 页眉、活动指示器、斜杠补全、状态栏。会话消息数组以系统提示开头,<code>refreshSystemPromptPreservingContext</code> 刷新系统提示时会保留已有的压缩摘要段。AgentManager 以 <code>maxReadonlyConcurrency: 3</code>(最多 3 个并行只读子代理)创建;<code>refreshAgentVerificationContext</code> 把「待验证子代理」清单注入系统消息,构成强制验证门禁的上下文侧。",
        tags: ["TUI", "会话", "子代理"],
      },
      {
        at: "const toolExecutor = new SharedToolExecutor({",
        title: "工具执行器与子代理运行时接线",
        note: "<code>SharedToolExecutor</code> 是所有 Agent 共用的执行管线:状态行、进度节流、任务面板联动、父证据记录都在回调里接上 UI。<code>SubagentRunner</code> 的依赖全部用闭包注入(取 provider/模型/工具/执行工具),它的事件流(start/tool/text_delta/usage/done)在这里被翻译成 Agent 面板刷新与任务状态更新。<code>resolveSubagentRequest</code> 做严格参数校验(自定义模型必须带 provider、provider 与模型必须匹配、instructions 限长)。<code>launchManualAgent</code> 为可写子代理先创建 git 锚点快照,失败可回退。",
        tags: ["工具", "子代理"],
      },
      {
        at: "const applyPermissionMode = async",
        title: "权限切换、输入队列与枢纽菜单基建",
        note: "<code>applyPermissionMode</code> 切换权限档(进入 Plan 时清空任务列表)并刷新系统提示;<code>Shift+Tab</code> 在五档间循环。<code>pendingInputs</code> 是待处理消息队列(枢纽菜单选择、rewind 回填都经由它进入下一轮主循环);<code>startBackgroundInput</code> 让输入框在 Agent 思考期间仍可排队输入。<code>runHubMenu</code> 弹出 /config /agent /skill /memory /diag 五个枢纽的二级菜单。",
        tags: ["权限", "交互"],
      },
      {
        at: 'markStartupStage("ready");',
        title: "REPL 主循环:三种输入来源",
        note: "<code>while(true)</code> 主循环每轮先注入后台 Agent 通知,然后按优先级取输入:rewind 回填的草稿 → 待处理队列 → 正常读取输入框(带上次未提交草稿)。非斜杠输入会隐藏启动 Logo;用户消息经 <code>redactSensitiveCommand + sanitizeTerminalText</code> 消毒后回显(密钥不落屏)。",
        tags: ["主循环"],
      },
      {
        at: 'if (command === "exit" || command === "quit") {',
        title: "斜杠命令①:exit / mcp / skills / skill / memory / instinct",
        note: "/exit 中止全部后台 Agent 后退出;/mcp 展示 MCP server 状态;/skills 支持 validate(校验)与 reload(重扫);/skill 无参进枢纽菜单,带名手动加载 Skill——有参数时还会把参数作为转发 prompt 继续本轮对话;/memory 与 /instinct 委托 experience-commands 模块管理经验系统(列表/确认/提升/蒸馏为 Skill)。",
        tags: ["命令", "Skill", "经验系统"],
      },
      {
        at: 'if (command === "subagent") {',
        title: "斜杠命令②:subagent 向导与 preset/agents 管理",
        note: "/subagent 无描述时进入多步向导(预设→前台/后台→角色→模型→预算→关联 Todo→描述→确认,支持上一步/重问),可顺手保存为预设;带 preset: 前缀则非交互应用预设(命令行参数优先)。前台启动后 Esc 可中止,完成后结果标记「需父 Agent 独立验证」。/preset 提供 list/show/edit/remove/add 的预设 CRUD;/agents 提供查看/中止/清理。",
        tags: ["命令", "子代理"],
      },
      {
        at: 'if (command === "clear") {',
        title: "斜杠命令③:clear / resume / rewind",
        note: "/clear 重置会话并同步重置任务/快照/Agent 的作用域;/resume 列出历史会话,选中后完整回显消息轨迹(用户消息、Markdown 正文、工具调用摘要);<b>/rewind</b> 是重头戏:列出历史用户消息节点 → 二次确认 → 用 <code>snapshotEngine.rollbackOwnedChanges</code> 只回退<b>本会话工具造成的且之后未被外部修改</b>的文件 → 截断消息 → 把选中消息文本回填输入框供修改重发。",
        tags: ["命令", "会话", "rewind"],
      },
      {
        at: 'if (command === "compact") {',
        title: "斜杠命令④:compact / effort / model / provider / permission / perf",
        note: "/compact 手动跑四层压缩(forceL4);/effort 切思考强度;/model 双栏选择器同时选模型与强度,切换后重建 Provider 实例并保存偏好;/provider 是最长的命令族——快速切换、add 引导向导(名称→URL→Key→模型→连通性测试)、set 掩码录入(含逐模型上下文窗口)、unset 清除、无参状态总览(API Key 掩码显示+配置来源标注);/permission 五档权限+Auto 危险阈值;/perf 输出性能采样与原生引擎状态。",
        tags: ["命令", "Provider"],
      },
      {
        at: 'if (command === "help") {',
        title: "斜杠命令⑤:help / viewer 与未知命令兜底",
        note: "/help 从 <code>COMMAND_SURFACE</code>(cli-help.ts 的唯一事实源)生成分层指令表:枢纽加粗、成员灰显缩进;同时列出全部已注册工具。/viewer 用系统命令打开浏览器中的 Trace 观测中心。未匹配的命令红字提示——除非是 /skill 转发的 prompt。",
        tags: ["命令"],
      },
      {
        at: "const promptInput = forwardedPrompt || trimmedInput;",
        title: "「延迟提交」:prompt 的无痕收回机制",
        note: "用户消息先只进内存,不写 Trace/快照/会话。<code>commitPromptForRequest</code> 在 Provider 真正开始请求时(onRequestStart 回调)才提交:记录 Trace、创建 git 锚点快照(挂在消息上供 /rewind 用)、首次消息异步生成会话标题。这样 <b>Esc 在请求发出前</b>可走 <code>reclaimPrompt</code>:回滚内存消息、清除回显、把文本放回输入框——表现为「prompt 收回」而非「请求取消」;发出后 Esc 则中止请求但保留已生成的部分回复。",
        tags: ["主循环", "abort", "rewind"],
      },
      {
        at: "let keepCalling = true;",
        title: "Agent 循环:流式调用与增量渲染",
        note: "<code>while(keepCalling)</code> 是一轮对话的核心:每轮先修复历史中损坏的工具调用配对,然后 <code>provider.completeStream</code> 流式请求。回调族:onToolCall 暂存工具调用、onReasoning 累计思考、onUsage 记 token、onRetry 展示重试倒计时(provider 层已有 5 次指数退避)。正文用 <code>MarkdownStreamRenderer</code> 增量渲染 + <code>MarkdownRenderThrottle</code> 按内容长度自适应节流(32–64ms);流结束后做最终渲染。中止时补渲染并保存已生成的部分内容;普通错误则展示友好提示。",
        tags: ["主循环", "流式"],
      },
      {
        at: "const toolCalls = currentToolCalls as ToolCall[] | null;",
        title: "工具调用校验与畸形恢复",
        note: "模型返回工具调用后逐个 <code>validateToolCall</code>(参数必须是完整合法 JSON):任何一项无效则拦截整批、不写入历史、不执行——向模型注入「系统工具调用恢复」提示要求重新生成,最多自动重试 1 次,连续两次失败就停止以防无限循环。这是对上游流截断导致半截 JSON 的防御。<code>finish_reason=length</code> 单独黄字提示。",
        tags: ["工具", "健壮性"],
      },
      {
        at: "if (toolCalls && toolCalls.length > 0) {",
        title: "工具批执行、Plan 审批与验证门禁",
        note: "<code>createToolCallBatches</code> 把调用分批:只读工具并行执行,写类工具串行;每个结果(成功/被拦/未注册/跳过)按统一格式回显并回填为 tool 消息继续循环。<b>Plan 模式</b>:taskcreate 带 finalize 标记意味着计划就绪 → 注入「停止调工具、输出供人审阅的方案」→ 用户三选一(Auto 执行/手动批准/继续改);批准后切换权限档并注入严格的任务执行纪律。<b>验证门禁</b>:每轮结束检查是否有 awaiting_verification 的子代理,有则强制继续循环让父 Agent 验证。",
        tags: ["工具", "Plan", "子代理"],
      },
      {
        at: "const sessionObs = experienceStore.getPendingObservations();",
        title: "会话收尾:Stop Hook、经验提炼与落盘",
        note: "finally 块的固定顺序(顺序不能乱):先取观测副本(flush 会清空缓冲)→ flush 落盘 → 触发 Stop Hook → <code>DistillEngine.runDistill</code> 双路径提炼本会话观测(统计检测器 + 满足条件时 LLM 分析),产出强化/新规则与记忆候选并打印摘要 → 会话 flush → Trace 保存并打印路径。外层 catch 只吞「用户取消输入」,其余异常上抛崩溃。",
        tags: ["经验系统", "收尾"],
      },
    ],
  },

  /* ================= CLI · 终端交互层 ================= */
  "packages/cli/src/terminal-input.ts": {
    desc: "整个 TUI 的核心控制器 TerminalUI(2161 行):接管终端(alternate screen + 鼠标协议 + raw mode),负责聊天区差分重绘、行编辑输入、斜杠补全、历史记录、鼠标拖选/滚轮,以及状态栏/任务面板/Agent 面板的组装。键盘走 readline keypress、鼠标/粘贴走自研 VT 协议解析器的「双通道」设计。",
    segs: [
      {
        at: "function enableWindowsVirtualTerminalInput",
        title: "导入与 Windows VT 输入启用",
        note: "L1-54 的导入体现「双通道」输入设计:Node readline 的 <code>emitKeypressEvents</code> 解码普通按键,<code>TerminalProtocolParser</code> 解码鼠标/粘贴。<code>enableWindowsVirtualTerminalInput</code> 通过 PowerShell 调 kernel32 的 SetConsoleMode 打开 stdin 的 VT 输入位(0x0200),让方向键等产生转义序列——这是 Windows 上按键解码能工作的前提。L85-206 是公共数据接口与 <code>isRealCtrlC/D/U/T</code> 等按键判别(同时校验原始字节、key.ctrl、key.name,防误判)。",
        tags: ["TUI", "输入"],
      },
      {
        at: "export class TerminalUI",
        title: "TerminalUI 类字段与状态 setter",
        note: "L207-273 是类字段全景:聊天缓冲与滚动状态、状态栏数据、任务/Agent 面板、活动输入/选择器,以及性能字段——<code>stableWrapPrefix</code> 稳定前缀缓存、<code>rendered*</code> 上一帧缓存(供差分)、stdout 背压标志。构造后的各 setter 统一「消毒 → 存值 → scheduleRender」;setAgentPanel 只要还有 running 项就起 1s 定时器周期重绘(让运行秒数跳动)。",
        tags: ["TUI"],
      },
      {
        at: "start(): void {",
        title: "start/close:终端接管与对称还原",
        note: "<code>start()</code> 保存原 raw mode 后发送一整串初始化:进 alternate screen(\\x1b[?1049h)、隐藏光标、开 1002(拖动+滚轮)+1006(SGR 坐标)+2004(括号粘贴)鼠标协议,并显式禁 1007 防滚轮变方向键。<code>close()</code> 做完全对称的清理(关协议、还原 raw mode、退 alternate screen),进程退出还有兜底还原(L1155-1160)——保证异常退出也不弄脏用户终端。",
        tags: ["TUI"],
      },
      {
        at: "private getWrappedChat(contentWithStatus",
        title: "软换行缓存引擎与渲染节流(流式性能核心)",
        note: "流式输出每帧都要对全文软换行,这里是性能关键:①命中 <code>stableWrapPrefix</code>(已渲染的稳定前缀)时只 wrap 尾部增量,把 O(全文) 降为 O(增量);②<code>scheduleRender</code> 按交互帧 8ms / 流式帧 16ms 合并重绘;③stdout 背压时挂起渲染、drain 事件后补帧。聊天写入 API(writeChat/updateChatFrom/replaceChat)把 chatContent 截到 200K 字符防无限膨胀,并维护选区文档布局缓存。",
        tags: ["TUI", "性能"],
      },
      {
        at: "async readInput(options: ReadInputOptions",
        title: "readInput / readSelection:两种输入模式",
        note: "<code>readInput</code> 是输入主入口:非交互终端降级 readline/promises;<code>sensitive</code> 模式掩码显示且不进历史(API Key 录入)。initialValue 按字素切分、光标置尾。返回 Promise,由 handleKeypress 消费。<code>readSelection</code> 是双轴选择器(主轴选模型、次轴选思考强度),非交互时直接返回默认项。",
        tags: ["输入"],
      },
      {
        at: "private getChatCellFromMouse(",
        title: "鼠标选区与协议事件分发",
        note: "选区实现链:屏幕坐标 → 逻辑行 → cellAtColumn 文本单元,依赖 <code>layoutAnsiDocument</code> 产出的行偏移索引;<code>highlightChatRow</code> 注入反显(\\x1b[7m)高亮,松开时经 ClipboardWriter 写剪贴板。滚轮采用帧内合并(同向累加、反向覆盖,clamp ±48 行)避免每个报文触发一次布局。<code>handleMouseData</code> 是 stdin 原始入口,80ms flush 定时器冲刷被拆包的转义序列。",
        tags: ["TUI", "鼠标", "输入"],
      },
      {
        at: "handleIdleKeypress = (value",
        title: "空闲态按键与输入区布局",
        note: "空闲态:Ctrl+C 先尝试复制选区、否则还原终端退出;Shift+Tab 触发权限切换;PageUp/Down、↑↓ 映射为聊天滚动。<code>getInputLayout</code> 生成输入区布局:sensitive 全掩码、<code>/provider set</code> 的内联密钥行内掩码;多行输入以光标为锚开窗滚动。<code>getCommandSuggestions</code> 只在输入形如 <code>/xxx</code> 时做前缀补全,选中项 Enter 自动补全。",
        tags: ["输入", "TUI"],
      },
      {
        at: "private buildStatusBar(",
        title: "状态栏 / 活动轨道 / 任务面板",
        note: "<code>buildStatusBar</code> 一行装下:权限档缩写(配色)、provider·model·effort(限宽截断)、上下文用量(按比率分色 + 8 格进度条,仅宽屏)、工作目录(尾部保留截断)。<code>buildActivityRow</code> 渲染 ActivityIndicator 的单行动画轨道。<code>buildTaskPanel</code> 渲染任务列表(✓/●/○ 状态色 + 子代理缩进行),默认折叠 5 项,Ctrl+T 展开。",
        tags: ["TUI"],
      },
      {
        at: "private renderFrame(",
        title: "renderFrame:全屏帧组装与差分输出",
        note: "每帧的组装流水线:resolveTuiLayout 布局解析 → 页眉/面板/输入块 → 聊天视口计算(滚动锚点修正、合并滚轮消费)→ 可见行映射(用户消息色块补尾、选区反显、左 padding)→ 差分输出:优先 <code>buildViewportScrollUpdate</code>(用终端滚动区域整块搬移旧行,滚动场景只重绘露出行),否则全屏逐行差分;最后按输入光标位置发定位序列,一次 write 输出整帧并检测背压。高度不足时逐级降级到 minimal 模式。",
        tags: ["TUI", "性能"],
      },
      {
        at: "private finishInput(",
        title: "输入结束与多行编辑",
        note: "<code>finishInput</code>:非 sensitive 输入先 redact 敏感命令再入历史。<code>moveVertically</code> 实现多行上下移动的「记忆目标列」行为:用 layoutInput 求光标位置,在目标行找列距离最小的字素位置。<code>navigateInputHistory</code> 用 InputHistoryBuffer 的三态(历史/草稿)做上/下浏览。",
        tags: ["输入"],
      },
      {
        at: "handleKeypress = (value",
        title: "handleKeypress:按键分发总表",
        note: "按序处理:Ctrl+C(复制选区或取消)、Esc(清选区+onEsc 回调)、PageUp/Down/Shift+↑↓(聊天滚动)、Enter(Shift=换行;普通=提交,补全打开时先自动补全)、Ctrl+U(剪切行,含密钥时不写剪贴板)、Backspace/Delete(Ctrl+D 空输入=取消)、←→、↑↓(补全切换 → 多行移动 → 历史导航的三级优先)、Home/End、Ctrl+W(删词)、Shift+Tab(权限切换)、普通字符插入。",
        tags: ["输入"],
      },
    ],
  },

  "packages/cli/src/terminal-text.ts": {
    desc: "终端文本度量与布局的纯函数库:字素切分、东亚宽字符/零宽字符测宽、ANSI 感知的软换行与文档布局(带偏移索引,支撑鼠标选区)、截断与差分屏幕更新。是 TerminalUI 渲染管线的地基;≥1024 字符的文本优先走 Rust 原生引擎。",
    segs: [
      {
        at: "export const SEQ = {",
        title: "ANSI 常量与颜色出口",
        note: "<code>SEQ</code> 对象用 getter 动态取当前主题色,是 TUI 所有硬编码 ANSI 颜色的唯一出口——换主题零改动。L63-88 定义布局数据结构:<code>InputLayout</code>(输入行+每字素光标位)、<code>AnsiTextLayout</code>(rows + 去除 ANSI 的规范化 document,选区用)。",
        tags: ["TUI"],
      },
      {
        at: "export function buildScreenUpdate(",
        title: "差分屏幕更新",
        note: "<code>buildScreenUpdate</code> 逐行比较上一帧/下一帧,只输出变化行(\\x1b[2K 清出的区域天然呈主题背景);<code>buildViewportScrollUpdate</code> 用终端滚动区域(\\x1b[..r)+ I/D/S 序列整块搬移旧行,使聊天滚动只重绘新露出行——滚动场景的关键性能路径。",
        tags: ["TUI", "性能"],
      },
      {
        at: "export function splitGraphemes(",
        title: "字素、测宽、高亮与截断",
        note: "<code>splitGraphemes</code> 纯 ASCII 走快路径避免 Intl.Segmenter 开销;<code>isZeroWidth/isWide/measureGrapheme</code> 按 Unicode 区间判零宽(变体选择符/ZWJ)与双列宽(CJK/emoji)。<code>highlightAnsiColumns</code> 是文本选择反显的实现(遇 reset 序列补回反显)。三个 truncate 变体:纯文本/ANSI 头部截断/尾部保留(路径显示)。",
        tags: ["TUI"],
      },
      {
        at: "export function layoutInput(",
        title: "输入区布局与 ANSI 软换行",
        note: "<code>layoutInput</code> 逐字素放置输入内容,记录每个字素的 (row, column)——多行编辑光标定位的数据基础。<code>wrapAnsiWithStateFallback</code> 是状态机软换行:SGR 样式序列累积为 activeStyle,换行时新行以 activeStyle 起始、行尾加 RESET,保证跨行颜色不断裂;≥1024 字符先试 Rust 原生 <code>wrapAnsi</code>。",
        tags: ["TUI"],
      },
      {
        at: "export function layoutAnsiDocumentFallback(",
        title: "文档布局(选区核心)",
        note: "<code>layoutAnsiDocument</code> 同时产出:每行的 ansi(带样式)与 plain(纯文本)双份、该行在重建 document 中的 [startOffset, endOffset) 偏移——终端鼠标选区靠它把屏幕行映射回原文偏移。尾部 <code>cellAtColumn</code> 把 1-based 列号映射为文本单元;getSelectionAutoScrollRows 计算拖选越界时的自动滚动速度。",
        tags: ["TUI", "鼠标"],
      },
    ],
  },

  "packages/cli/src/markdown-renderer.ts": {
    desc: "终端 Markdown 流式渲染引擎 MarkdownStreamRenderer:把模型输出的 Markdown 增量渲染成 ANSI 文本(标题/列表/表格/代码块卡片/ASCII 框图/行内样式/diff 高亮),带防闪烁自动闭合与自适应重解析节流;零外部依赖。",
    segs: [
      {
        at: "const KEYWORDS = new Set([" ,
        title: "样式字典与关键字表",
        note: "ANSI 样式字典在模块加载时从当前主题构建一次(reset 用 themeReset 保背景);<code>KEYWORDS</code> 收录约 45 个通用编程关键字供代码高亮判词。",
        tags: ["渲染"],
      },
      {
        at: "export class MarkdownRenderThrottle",
        title: "重解析节流与思考摘要",
        note: "<code>MarkdownRenderThrottle</code> 按内容长度自适应放宽全量重解析间隔:≥24k 字符 48ms、≥64k 64ms、默认 32ms——限制模型高速吐字时的重解析频率(最终渲染不受限)。<code>shouldShowToolThinkingSummary</code> 只在「有工具调用且无可见正文」时显示 Think Ns 摘要。",
        tags: ["渲染", "性能"],
      },
      {
        at: "export class MarkdownStreamRenderer",
        title: "renderContent 分块状态机(核心)",
        note: "逐行扫描维护四个缓冲状态:代码块(\\`\\`\\`\\` 切换)、表格行(缓冲到表尾才整表渲染)、ASCII 框图卡片(┌── 开栏)、普通行。非最终态先 <code>autoCloseMarkdown</code> 补齐未闭合语法防闪烁。循环后兜底渲染未闭合的块。",
        tags: ["渲染"],
      },
      {
        at: "private renderAsciiCard(",
        title: "ASCII 卡片、防闪烁与行内渲染",
        note: "<code>renderAsciiCard</code> 给已有框图包卡片(窄屏退化为两列形态);<code>autoCloseMarkdown</code> 补齐奇数个围栏/星号/反引号;<code>renderNormalLine</code> 按标题级别(◆/◇/›)、引用、任务列表、有序/无序列表分发;<code>renderInlineStyles</code> 处理行内代码/粗体/斜体/删除线。",
        tags: ["渲染"],
      },
      {
        at: "private renderCodeBlock(",
        title: "代码块卡片与表格渲染",
        note: "代码块渲染为 ┌── lang ──┐ 卡片:diff 语言按 +/−/@@ 染色,其他语言做轻量高亮(注释/字符串/数字/关键字);窄屏不在 Markdown 层截断、交给聊天区统一软换行以免丢代码。<code>renderTable</code> 手写切单元格(支持转义 \\|),窄屏退化为「label: value」堆叠卡,宽屏按比例压缩列宽后渲染 ┌┬┐ 框线表。",
        tags: ["渲染"],
      },
      {
        at: "private getTextWidth(",
        title: "宽度计算收尾",
        note: "<code>getTextWidth</code> 剥 ANSI 后逐码点计宽;<code>getRawMarkdownWidth</code> 再剥一层 Markdown 语法,让表格列宽按「渲染后纯文本」测量。",
        tags: ["渲染"],
      },
    ],
  },

  "packages/cli/src/theme.ts": {
    desc: "TUI 主题模块:双色阶 theme.json 配置(用户级/项目级)、终端颜色能力探测与降级(truecolor/256/16/mono)、hex→ANSI 换算,以及所有颜色工具(paint/SEQ 的底层)与用户消息色块卡片的后处理。",
    segs: [
      {
        at: "export interface Theme {",
        title: "Theme 接口与颜色能力",
        note: "15 个颜色键全为 #RRGGBB(含用户消息背景 userMsgBg,形成色块卡片)。<code>ColorLevel</code> 四档:mono/ansi16/ansi256/truecolor。",
        tags: ["主题"],
      },
      {
        at: "export function detectColorLevel(",
        title: "颜色能力探测与默认主题",
        note: "探测优先级:非 TTY / NO_COLOR / TERM=dumb → mono;<b>Windows 一律 truecolor</b>(老 conhost 会自行量化 24-bit SGR,而回退 ANSI16 会把深色背景映射到过亮的 black);WT_SESSION/COLORTERM → truecolor;TERM 含 256color → ansi256;否则 ansi16。默认主题「HAJI 轨迹台」为深色系;ANSI16_PALETTE 是 16 组标准 VGA 值供最近色匹配。",
        tags: ["主题"],
      },
      {
        at: "function hexToRgb(",
        title: "hex → ANSI 颜色换算算法",
        note: "三步换算:hex 解析;<code>rgbToAnsi256</code>(灰阶走专门分支,彩色按 6×6×6 立方体);<code>rgbToAnsi16</code>(对 16 色调色板做平方距离最近邻)。",
        tags: ["主题"],
      },
      {
        at: "export function fgSeq(",
        title: "SGR 生成与主题配置加载",
        note: "<code>fgSeq/bgSeq</code> 按当前能力输出:mono 空串、truecolor \\x1b[38;2;r;g;b、ansi256 \\x1b[38;5;n、ansi16 最近色。主题配置两级:<code>~/.haji/theme.json</code> 与项目级覆盖,逐键校验 #RRGGBB,非法忽略、缺失回退默认,合并后永远返回完整 Theme。<code>themeReset = \\x1b[0m + 主题前景 + 背景</code> 是所有颜色函数的统一收尾,防背景丢失。",
        tags: ["主题"],
      },
      {
        at: "function paintText(",
        title: "paint 工具集与用户消息色块",
        note: "<code>paint</code> 提供 accent/green/yellow/red/… 及 bold 变体;<code>paint.userMsg</code> 渲染用户消息:首行 ❯ 前缀、后续行 3 空格对齐,每行前置 userMsgBg 背景、行尾 \\x1b[K 清到行尾实现整行色块。<code>fillUserMsgRowEol</code> 是渲染后处理:软换行产生的中间行缺 \\x1b[K 时补上,让色块整行填充。<code>buildAnsiStyles</code> 为 markdown-renderer 构建同构样式对象。",
        tags: ["主题"],
      },
    ],
  },

  "packages/cli/src/tui-renderer.ts": {
    desc: "轻量三区(Logo/聊天/输入)独立渲染器 TuiRenderer,自带简化软换行与 Markdown 流式集成,零依赖;与 TerminalUI 属两代实现,用于简单分屏场景。结构:构造与尺寸计算 → init 清屏画 Logo → renderChatArea 整区重绘(取尾部 chatHeight 行自动滚底)→ beginStream/streamChunk/endStream 流式块替换(配合 MarkdownRenderThrottle 限频)→ positionForInput/clearInputArea → 内部 wrapSingleLine 逐字符软换行(注意:按单 UTF-16 码元推进,未做字素分组)。",
  },

  "packages/cli/src/tui-layout.ts": {
    desc: "TUI 响应式布局引擎:按终端列/行把界面映射为 wide/comfortable/compact/narrow/minimal 五档模式(列 <24 或行 <10 为 minimal、<40 narrow、<60 compact、<100 comfortable),每档一份 PROFILES 基线(聊天留白 chatPadding、头部模式、面板行数、提示开关);再按行数做高度微调(<16 强制隐藏头部、状态降级;<24 头部降为 compact)与面板预算(resolvePanelRowBudget:16/24/32/40 行阈值给 1-8 行)。safeWidth 统一 columns-1 防边界换行。",
  },

  "packages/cli/src/terminal-protocol.ts": {
    desc: "有状态 VT 输入协议解码器:把 stdin 原始字节流重组为鼠标(SGR)、键盘、括号粘贴三类结构化事件,防止鼠标字节漏进 readline 被当作按键。要点:decodeMouse 解析 SGR 码位(button&64=滚轮 ±3 行、'm'=up、bit32=move);parseAvailable 主循环处理粘贴态(找 201~ 结束标记、保留可能重叠的尾部)、SGR 鼠标、ANSI 序列;flushPending 处理残留(粘贴态残留不吐、孤立 ESC 丢弃)。80ms flush 由 TerminalUI 驱动,应对转义序列被管道拆包。",
  },

  "packages/cli/src/terminal-sanitize.ts": {
    desc: "终端安全两件套:①sanitizeTerminalText 把不可信文本(工具输出等)剥净为终端安全纯文本——按 ECMA-48 文法消费 CSI/OSC/DCS 等转义序列,CR/CRLF 归一为 LF,丢弃其余 C0/DEL/C1 控制字节,中文 emoji 原样保留;控制字符串未终止时丢弃尾部(比暴露半截 OSC payload 更安全)。②redactSensitiveCommand 在历史/回显前把 /provider set 的内联密钥替换为 [API Key 已隐藏],让历史重放打开掩码输入而非重放旧密钥。",
  },

  "packages/cli/src/text-selection.ts": {
    desc: "鼠标拖选文本的纯状态机模型 TextSelectionModel:anchor 锚点 + focus 焦点 + selecting 标志;begin/update/finish/clear 四个转移,range() 把两端归一化为 start<end(支持反向拖选),selectedText 按区间对 plain 文档字符串 slice。坐标定义在未换行文档的字符 offset 空间上,与渲染行解耦。",
  },

  "packages/cli/src/input-history.ts": {
    desc: "输入基础设施两件套:①InputHistoryBuffer 三态历史浏览(entries/cursor/draft):↑ 时先把当前值存为草稿,越过末尾时恢复草稿,游标到 0 停止;②ClipboardWriter 跨平台剪贴板:非 Windows 写 OSC 52 转义序列;Windows 惰性 spawn 常驻 PowerShell 子进程循环从 stdin 读 base64 → Set-Clipboard → 回写 OK/ERR,FIFO 唤醒 pending 队列。",
  },

  "packages/cli/src/activity-indicator.ts": {
    desc: "单行状态动画组件:7 种阶段(thinking/responding/tool/batch/permission/compacting/stopping)各有专属帧序列(星光旋转/波形条/盲文点阵),▰▱· 脉冲 meter + 耗时 + 「N 秒无新事件」闲置提示(tone: active/waiting 12s/stalled 30s)。buildActivityFrame 是纯函数可单测;ActivityIndicator 持有唯一的有界动画定时器(intervalMs≥80,默认 140),progress 高频事件按 min(100, interval) 节流,运行时长与无进展时长分开记录。",
  },

  "packages/cli/src/agent-panel.ts": {
    desc: "子代理监控面板纯渲染模块:AgentPanelItem 描述单个子代理(配置/8 种状态/进度/Token 与工具预算),buildAgentPanelRows 生成「代理 N 运行中 · N 排队」标题 + 每项状态行(running 拼 activity·elapsed·token 预算·预览详情),按面板宽度截断,最多 4 项。",
  },

  "packages/cli/src/cli-help.ts": {
    desc: "CLI 静态展示层:像素风 HAJI Logo、斜杠指令面 COMMAND_SURFACE(唯一事实源,同时驱动 / 补全、枢纽菜单、--help 三处——5 个枢纽 /config /agent /skill /memory /diag 收纳低频指令,高频动作直接置顶)、buildHubMenus 把可调用 Skill 动态注入 /skill 枢纽、handleEarlyCliArgs 处理 --version/--help 早退(含环境变量说明)。",
  },

  "packages/cli/src/cli-runtime.ts": {
    desc: "CLI 运行时小工具集:用户偏好(两级 .haji/preferences.json——~/.haji 存跨项目默认,<cwd>/.haji 存本项目,读取时项目级逐字段覆盖用户级;字段为模型/强度/provider/权限档/危险阈值;解析前去掉 UTF-8 BOM,避免记事本写出的文件被静默忽略)的容错读写;formatToolArgs 把工具参数压成单行摘要(key: \"value\" 连接,超 45 字符截断);getCliVersion 读 package.json 版本号,异常回退 1.0.0。",
  },

  "packages/cli/src/context-policy.ts": {
    desc: "CLI 侧模型上下文窗口解析策略:normalizeContextWindowTokens 把任意值归一化为 ≥1000 的整数 tokens(否则 undefined);getModelContextWindowTokens 三级解析——环境变量 HAJI_CONTEXT_WINDOW_TOKENS > provider 配置按模型声明的窗口 > 内置 MODEL_CONTEXT_WINDOWS 注册表,最终兜底 128k。这个窗口值决定自动压缩的触发阈值。",
  },

  "packages/cli/src/native-terminal-engine.ts": {
    desc: "Rust 原生引擎(.node 二进制)的惰性加载封装:HAJI_NATIVE_RENDERER 决定 mode(on=强制,加载失败报错;off=永不加载;auto=默认,可用即用、失败静默降级 TS 实现);只尝试加载一次并缓存结果;tryNativeWrapAnsi / tryNativeLayoutAnsiDocument 两个包装在运行期抛错时清空 binding 降级。getNativeTerminalEngineStatus 供 /perf 展示当前引擎。",
  },

  "packages/cli/src/rewind-flow.ts": {
    desc: "/rewind 流程的最小辅助:REWIND_CONFIRM_DEFAULT(\"yes\")是确认选择器的默认值;queueRewindRefill 把回填后重新提交的文本 unshift 进 pendingInputs 队首,让主循环重新按普通输入解析。",
  },

  "packages/cli/src/turn-lifecycle.ts": {
    desc: "回合生命周期切分:splitPendingUserTurn 从消息尾部向前找最后一条 user 消息,其之前为 history(可安全压缩),其及其之后为 pendingTurn——保证自动压缩不携带未完成的回合,ESC 收回 prompt 时也能精确回滚。",
  },

  "packages/cli/src/agent-wizard.ts": {
    desc: "交互向导的纯函数输入校验:ParseResult(ok/value 与 ok/message)、DECIMAL_INTEGER 正则、parseOptionalInteger(空串=跳过/保持现值)、validateDescription/validateInstructionsInput、budgetPrompt/textPrompt 两个提示模板。非法输入原地重问而非抛错;b 返回上一步。",
  },

  "packages/cli/src/tool-batch.ts": {
    desc: "工具调用并发调度:PARALLEL_READ_ONLY_TOOLS 白名单(8 个只读工具)+ 最大并发 3。",
    segs: [
      {
        at: "export function createToolCallBatches",
        title: "分批算法",
        note: "只把「连续的、白名单内」的只读调用聚成并行批;任何非白名单(变更/编排类)调用都是屏障——先 flush 积压再单独成串行批。flush 时按并发上限切 chunk,chunk>1 才标记 parallel。写类工具永远串行,天然避免写冲突。",
        tags: ["工具", "并发"],
      },
      {
        at: "export async function runToolCallBatch",
        title: "批执行与收益统计",
        note: "parallel 批用 Promise.all 并发;实测墙钟时间 vs 串行估算(各 duration 之和)的差值记为节省时间,三项指标上报 performanceMonitor(tool.batch.*)——/perf 里能看到并行调度真正省了多少毫秒。",
        tags: ["工具", "性能"],
      },
    ],
  },

  "packages/cli/src/tool-executor.ts": {
    desc: "SharedToolExecutor:所有 Agent(主循环与子代理)共用的工具执行管线,集中处理权限前置钩子、变更快照(checkpoint/回滚)、PostToolUse 钩子、进度节流(80ms)、任务面板联动与中止传播——是 TUI 与 core 工具体系之间的执行桥。",
    segs: [
      {
        at: "export interface ToolExecutionResult",
        title: "选项与结果类型",
        note: "ToolExecutionResult = { output, duration, blocked }。Options 注入 cwd、tools 注册表、四个引擎(hook/permission/snapshot/taskStore)与 UI 回调(setStatus 状态行、onToolProgress 进度、onTaskPlanChanged 面板刷新、onToolExecuted 完成事件——主 Agent 的调用在这里记为父验证证据)。",
        tags: ["工具"],
      },
      {
        at: "export class SharedToolExecutor",
        title: "execute 执行管线",
        note: "流程:查注册表(未注册→blocked 错误)→ abort 预检 → PreToolUse 钩子(返回非空字符串即拦截)→ 变更快照准备:mutationScope 取工具自声明的 getMutationScope,否则按只读/编辑分类映射;需要追踪时 beginMutation 建 checkpoint(scope=paths 把 args.path 解析为工作区相对路径)→ 状态行与 80ms 进度节流 → 执行(异常转「执行出错:」字符串输出)→ finally completeMutation 结算快照(警告附加到输出尾)→ task 类工具触发面板刷新 → 主 Agent 成功调用附 [verification_evidence_id] → PostToolUse 钩子 + onToolExecuted 回调。",
        tags: ["工具", "权限", "快照"],
      },
      {
        at: "private async post(",
        title: "post:统一后置钩子",
        note: "把 toolCallId/toolName/args/toolOutput 与 agent 链信息(agentId/parentAgentId/depth)交给 PostToolUse 处理器链——即 index.ts 里注册的 Trace 记录与经验观测采集。",
        tags: ["工具", "Hook"],
      },
    ],
  },

  "packages/cli/src/provider-config.ts": {
    desc: "/provider 命令的底座:两级配置文件(用户级 ~/.haji/config.json 与项目级 .haji/config.json,项目级字段覆盖用户级)的读写合并、Base URL 防误填归一化与真实连通性测试,支持为自定义端点声明逐模型上下文窗口。",
    segs: [
      {
        at: "export interface ProviderEntry",
        title: "两级配置设计与类型",
        note: "设计(模块注释):用户级存 API Key 跨项目共用,项目级存 baseUrl/模型等项目设置;API Key 明文存储但 .haji 已被 gitignore。PROVIDER_NAMES = [deepseek, volcengine] 是内置名单,其余全是用户自定义。ProviderEntry 含 apiKey/baseUrl/model/models/modelContextWindows。",
        tags: ["Provider", "配置"],
      },
      {
        at: "export function validateProviderName(",
        title: "名称校验与模型列表/窗口解析",
        note: "validateProviderName 拒绝空白与路径保留字符(长度≤32);parseModelList 按分号/逗号(含中文全角)切分去重;parseModelContextWindows 解析「模型=tokens」片段(同模型后者覆盖),经 normalizeContextWindowTokens 校验(<1000 判非法并回报 invalid 列表)。",
        tags: ["Provider", "配置"],
      },
      {
        at: "export function loadProviderConfigScope(",
        title: "读写与字段级合并",
        note: "loadProviderConfig 是合并核心:名称集合 = 内置 ∪ 用户级 ∪ 项目级,每个 provider 浅合并(项目级覆盖);readConfigFile 对损坏 JSON 容错返回空。saveProviderConfig 先读现有配置再逐字段清洗合并(空字符串=清除字段,models 过滤空项),写盘后尝试 chmod 600(Windows 可能无效,失败忽略)。resolveProviderSetting 是单项运行时解析:环境变量 > 配置 > fallback。",
        tags: ["Provider", "配置"],
      },
      {
        at: "export function normalizeBaseUrl(",
        title: "Base URL 防误填归一化",
        note: "依次处理常见填法错误:去尾部斜杠、剥掉重复/大小写不敏感的 /chat/completions 后缀、剥 Anthropic 风格 /messages 后缀(统一转 OpenAI 兼容端点),每步修正累积到 note 返回给用户提示「已自动修正为 …」。",
        tags: ["Provider"],
      },
      {
        at: "export async function testProviderConnection(",
        title: "连通性测试",
        note: "向 {归一化 baseUrl}/chat/completions 发 max_tokens=1 的 ping 请求(Bearer 鉴权、15s 超时、走 fetchWithNetworkPolicy 尊重代理策略);失败时从 JSON 响应体提取 error.message 作为诊断,TimeoutError 单独提示超时,全程附 usedUrl 与归一化说明。",
        tags: ["Provider"],
      },
    ],
  },

  "packages/cli/src/subagent-wizard.ts": {
    desc: "/subagent 与 /preset add|edit 的交互式配置向导:可导航多步流程(上一步/容错重问/最终确认),把用户选择组装成 SubagentWizardState / PresetWizardState 返回执行。",
    segs: [
      {
        at: "export interface WizardDeps",
        title: "依赖注入与预设格式化/持久化",
        note: "WizardDeps(ui/readSelectionSafely/taskStore/currentEffort/effortOptions)让向导不持有 main() 闭包即可复用;formatPresetSummary/Detail 是预设的一行/多行视图;persistPreset 按名称大小写不敏感原位替换或追加。",
        tags: ["子代理", "交互"],
      },
      {
        at: "const WIZARD_BACK",
        title: "向导导航基建(WIZARD_BACK/RESTART)",
        note: "哨兵值 + isBackInput(输入 b/back 即返回)+ withBackItem(选项列表自动追加「← 上一步」);WizardStepResult = next(value) | back 的结果联合,是所有步骤原语的统一返回形状。",
        tags: ["交互"],
      },
      {
        at: "function createWizardHelpers",
        title: "四个可复用步骤原语",
        note: "askSelectionStep(通用单选+Back)、askModelEffortStep(模型+强度双栏选择,从 MODEL_REGISTRY 反查 provider,当前自定义模型也补进选项)、askBudgetFlow(maxTokens/maxToolCalls/timeout 三字段数值流:非法重问、b 后退、回车跳过/保持现值)、askTextFlow(文本校验循环)。",
        tags: ["交互"],
      },
      {
        at: "export const runSubagentWizard",
        title: "runSubagentWizard:/subagent 主向导状态机",
        note: "显式 while 状态机,八步:preset → mode(前台/后台)→ role(research/review/implement)→ model → budget → task(关联 Todo)→ description → instructions → confirm(配置摘要+确认/重新配置)。后台模式强制只读;选预设时跳过 role 直接进 task。",
        tags: ["子代理", "交互"],
      },
      {
        at: "export const runPresetWizard",
        title: "runPresetWizard:/preset add|edit 向导",
        note: "五步状态机 role → model → budget → instructions → confirm;edit 场景以现有预设值为 initial,留空即保持原值;确认后由调用方 persistPreset 落盘。",
        tags: ["交互"],
      },
    ],
  },

  "packages/cli/src/experience-commands.ts": {
    desc: "/memory 与 /instinct 命令的业务实现:查看/确认/增删经验系统的规则与记忆、手动触发提炼、观测健康统计,并把高置信规则(≥0.8 且观测≥3 次)模板化蒸馏为用户级 SKILL.md 草稿。",
    segs: [
      {
        at: "export interface ExperienceCommandContext",
        title: "依赖注入上下文",
        note: "store/provider/model 闭包/pendingObservations/writeLine/writeChat 全部由 index.ts 注入;ExperienceColors 是六个颜色函数接口,测试可替换。",
        tags: ["经验系统"],
      },
      {
        at: "export async function handleMemoryCommand",
        title: "handleMemoryCommand:记忆管理",
        note: "confirm 把 staging 记忆确认为 active(区分 user/project 落点提示);add 手工添加(type 三分,confidence 固定 0.8,keywords 从内容提取);forget 删除;promote 项目级提升用户级;默认列表展示 active(紫)+ staging(黄,提示 confirm)两段。",
        tags: ["经验系统"],
      },
      {
        at: "export async function handleInstinctCommand",
        title: "handleInstinctCommand:规则管理",
        note: "distill 用 DistillEngine 对本会话观测手动提炼;forget/promote 同记忆;stats 展示规则/记忆计数与观测健康(总量/失败率/失败 Top 工具/近 7 天 vs 前 7 天失败率趋势);默认列表按置信度降序最多 30 条。",
        tags: ["经验系统"],
      },
      {
        at: "const DISTILL_SKILL_MIN_CONFIDENCE",
        title: "handleInstinctSkillCommand:规则蒸馏为 Skill",
        note: "门槛:confidence≥0.8 且 occurrenceCount≥3(反复验证过的规则才值得固化)。确定性模板生成 SKILL.md(不调 LLM):frontmatter 的 name 从规则 id 派生(非法字符转 -、截 64)、description/when_to_use 取 action/trigger 前缀、值经 JSON.stringify 转义防 YAML 注入;正文含触发场景、执行要点与来源元信息;目标已存在则拒绝覆盖。",
        tags: ["经验系统", "Skill"],
      },
    ],
  },

  "packages/cli/src/agent-commands.ts": {
    desc: "/subagent 与 /preset add 的纯函数命令行解析器:引号感知(单双引号包裹值)、支持 -- 终止符与 preset: 前缀,产出强类型解析结果;数值选项全部带范围校验。",
    segs: [
      {
        at: "function extractOption(",
        title: "选项提取原语",
        note: "extractOption 在字符串中引号感知地查找 --name(前须空白、后须 = 或空白),提取后从原文移除该选项;引号未闭合返回 error 而非静默吞文本。splitAtDoubleDash 把独立的 -- 之后的全部内容划为描述 tail,不再解析任何选项(POSIX 约定)。",
        tags: ["子代理"],
      },
      {
        at: "export function parseSubagentCommand(",
        title: "parseSubagentCommand:主解析器",
        note: "先切 head/tail,再游标式逐 token 解析:行首 preset:<名称> 前缀语法;裸关键字 bg/research/review/implement;九种 -- 选项(task/preset/model/provider/effort/instructions/timeout-ms/max-tokens/max-tool-calls,数值均校验范围)。首个无法识别的 token 即描述开始,其后原样保留——宽松语法,模型输错也不至于整体失败。",
        tags: ["子代理"],
      },
      {
        at: "export function parsePresetCommand(",
        title: "parsePresetCommand:/preset add 解析",
        note: "名称取第一个 token(可引号包裹,不能以 - 开头);依次提取全部选项;提取完后 remaining 仍非空则抛「无法识别的参数」——preset 语法比 subagent 严格,不容忍未知选项。尾部附 formatAgentTokens(token 数 k 格式化)。",
        tags: ["子代理"],
      },
    ],
  },

  /* ================= Core · 引擎内核 ================= */
  "packages/core/src/index.ts": {
    desc: "core 包桶式导出入口:export * 聚合 29 个内部模块(abort/agent-manager/atomic-file/context-compact/distill-engine/experience 系/skill 系/snapshot-engine/subagent-runner/task-store/trace-logger/types 等),供 CLI 从包根统一导入。core 不依赖 cli/plugins,是依赖图的中心。",
  },

  "packages/core/src/types.ts": {
    desc: "core 的基础契约层:工具(ToolCall/ToolDefinition/BaseTool)、聊天消息(ChatMessage)、补全选项与 Provider 抽象(ModelProvider)、错误体系(HajiError/ProviderError)与系统提示词分片接口,被几乎所有模块依赖。",
    segs: [
      {
        at: "export interface ToolCall",
        title: "工具契约",
        note: "ToolCall 是 OpenAI 风格调用结构(arguments 为 JSON 字符串);ToolDefinition 是暴露给模型的 schema;BaseTool 声明执行契约 + 可选 <code>getMutationScope</code>(none/paths/workspace,声明本次调用对工作区的修改范围,供权限引擎细粒度授权)。ToolExecutionContext 携带 abortSignal、agent 谱系(agentId/parentAgentId/depth)、userIntent、权限与快照锚点、批量定位与进度回调——主循环与子代理共用一份上下文。",
        tags: ["契约"],
      },
      {
        at: "export interface ChatMessage",
        title: "消息模型",
        note: "四种角色(system/user/assistant/tool);<code>snapshotId</code> 是该用户消息提交前的工作区快照 ID——专供 /rewind 定位回退锚点;reasoning_content 保存思考链;CompletionOptions 定义六个回调:onRequestStart(首次网络请求前触发,「延迟提交」机制的分界线)、onToolCall/onReasoning/onUsage/onFinish/onRetry(带重试进度)。",
        tags: ["契约"],
      },
      {
        at: "export interface ModelProvider",
        title: "Provider 抽象与错误体系",
        note: "ModelProvider 只有两个方法:complete(非流式)与 completeStream(AsyncGenerator)——ObservableModelProvider 装饰的正是它。HajiError 带 code;ProviderError 额外携带 provider 名、HTTP status 与 retryable 标志(未显式指定时由 retry.ts 的 isRetryableError 推断,衔接重试)。",
        tags: ["契约", "Provider"],
      },
      {
        at: "export const REASONING_EFFORTS",
        title: "思考强度与提示词分片接口",
        note: "五档思考强度 low→max;PromptContext 是生成系统提示词的动态上下文(recentUserMessage 供经验召回分片做相关性检索);SystemPromptPart(id 唯一 + priority 排序权重 + getContent)是 prompt-manager 分片体系的接口基础。",
        tags: ["契约"],
      },
    ],
  },

  "packages/core/src/agent-manager.ts": {
    desc: "子代理全生命周期管理器 AgentManager:启动/排队/中止、只读并发控制(上限 3、写型独占)、父代理验证证据账本(一次性消费防自证),以及按会话作用域的原子化持久化(.haji/agents/<scope>.json)。",
    segs: [
      {
        at: "export interface AgentUsage",
        title: "状态机与验证上下文格式化",
        note: "AgentStatus 七态:queued → running → awaiting_verification → verified/rejected,或 failed/aborted。<code>formatPendingAgentVerificationContext</code> 从 Manager 状态(而非聊天历史)构建「待验证子代理」提示词片段,明确指示父 Agent 必须独立用 read/grep/bash 验证后凭 verification_evidence_id 调用 verifyagent——验证门禁的上下文侧。",
        tags: ["子代理"],
      },
      {
        at: "const AGENT_STATUSES = new Set",
        title: "持久化类型与运行时守卫",
        note: "ParentEvidence 是父 Agent 工具调用证据(toolCallId/toolName/timestamp/consumedByAgentId);isAgentRecord 逐字段校验反序列化记录(role/access/status/effort 枚举、数值有限性),防止损坏的状态文件注入非法数据;超时常量:默认 10 分钟,100ms–1 小时。",
        tags: ["子代理", "健壮性"],
      },
      {
        at: "export interface AgentNotification",
        title: "启动契约与同步原子替换",
        note: "通知/启动(launch 返回 record + completion Promise)/执行器(RuntimeEntry 持 controller、超时句柄、parentAbort 钩子)契约。L227-259 是同步版原子替换:对 renameSync 的 EACCES/EBUSY/EPERM 瞬时错误按 [0,10,25,50]ms 重试(忙等实现),绝不降级为非原子 copy——AgentManager 的持久化路径是同步的,无法复用 async 版。",
        tags: ["子代理", "持久化"],
      },
      {
        at: "export class AgentManager",
        title: "构造与 setScope(作用域切换)",
        note: "maxReadonlyConcurrency clamp 到 [1,3]。setScope 是状态机重置:中止所有 runtime、记录置 aborted;读盘 error 时置 persistenceBlocked=true 仅告警(保留损坏原文件、暂停本会话持久化——降级策略);恢复时 running/queued 一律收敛为 aborted(进程重启后的孤儿态);parentEvidence 截断保留 200 条。",
        tags: ["子代理", "健壮性"],
      },
      {
        at: "launch(request: AgentLaunchRequest",
        title: "launch:入口校验与排队决策",
        note: "生成 sub-{uuid前8} id 后三条硬校验:描述非空;第一版后台 Agent 仅允许 readonly;workspace-write Agent 不能与任何 queued/running Agent 并行(写独占)。注册 parentSignal 中止监听;readonly 在「有写型在跑」或「只读并发满」时入队。随后的 updateTool/updateProgress(preview 滚动窗口 160 字符,100ms 节流不落盘)/addUsage/abort/abortAll/clearFinished/recordParentEvidence(过滤 subagent/task* 工具防自我引用,200 条 FIFO)都是运行期维护。",
        tags: ["子代理", "并发"],
      },
      {
        at: "verify(",
        title: "verify:验证闭环(防自证的核心)",
        note: "前置校验(必须 awaiting_verification、evidence 非空、证据 ID 去重非空)后,对每个 toolCallId 做<b>三重防伪</b>:证据必须存在且属于父 Agent 工具调用;证据时间不得早于子代理完成时间(防拿旧证据充数);未被其他 Agent 消费过(一次性消费)。全部通过才绑定 consumedByAgentId、写入 verification、状态流转 verified/rejected——子代理无法自证,父 Agent 也不能重复利用同一条证据。",
        tags: ["子代理", "信任"],
      },
      {
        at: "private start(agentId: string)",
        title: "start / finishRuntime / pump",
        note: "start 置 running、设超时守卫(超时以 TimeoutError 中止并以 aborted+unresolved:[timeout] 收尾,双保险);executor 的 then/catch 按结果映射状态,且先校验 runtime 未被替换(过期回调竞态守卫)。finishRuntime 统一收尾(清瞬态、resolve completion、通知、持久化)后 pump() 拉起队列中下一个只读 Agent。",
        tags: ["子代理"],
      },
      {
        at: "private persist(): void",
        title: "persist / readState:原子落盘与容错读取",
        note: "persist 写临时文件(tmp→fsync→原子改名),persistenceBlocked 时跳过。readState 兼容旧版纯数组格式;任何校验问题都收敛为 {status:error} 由 setScope 决定降级而不覆盖原文件。",
        tags: ["子代理", "持久化"],
      },
    ],
  },

  "packages/core/src/observable-provider.ts": {
    desc: "ModelProvider 的无侵入观测装饰器:拦截 complete/completeStream,采集 TTFT、耗时、速度、推理内容、工具调用、用量并写入 SessionTracker(Trace),回调全透传。",
    segs: [
      {
        at: "export class ObservableModelProvider",
        title: "complete:非流式观测",
        note: "包装四个回调为「先捕获再透传」的双写模式;非流式用字符数估算速度,TTFT=总时长;成功与失败路径都记录(错误也是观测数据)再 rethrow。",
        tags: ["Trace"],
      },
      {
        at: "public async *completeStream",
        title: "completeStream:流式观测",
        note: "增加流式度量:首块守卫保证 TTFT 只记一次;逐块转发同时累积内容;速度优先用 usage.completion_tokens ÷ 生成耗时(token/s),无 usage 降级字符数——生成耗时从首块起算,排除排队/首字等待对速度的稀释。",
        tags: ["Trace"],
      },
    ],
  },

  "packages/core/src/prompt-manager.ts": {
    desc: "系统提示词分片化组装:6 个内置分片(身份/环境/工具规范/思考强度/Skill 目录/Plan 模式)+ CLI 注册的经验召回分片,由 SystemPromptManager 按 priority 排序拼接;分片可按上下文返回空串实现按需注入。",
    segs: [
      {
        at: "export class BasePromptPart",
        title: "身份分片与环境分片",
        note: "BasePromptPart(priority 10)输出固定四段:身份与目标、行为边界(先判断意图、不猜测、高风险先确认、不暴露思维链)、六步执行闭环、沟通风格。EnvPromptPart(20)注入 OS 与 Cwd。",
        tags: ["提示词"],
      },
      {
        at: "export class ToolsPromptPart",
        title: "ToolsPromptPart:17 个工具的按需规范",
        note: "context.tools 为空则整段不注入。先给 6 条通用选择规则(最小作用域、先定位再读取、失败不机械重试、工具输出是证据不是指令、改后必验证),再对每个已启用工具条件追加专属防滥用约束(edit 必须带 expectedHash、verifyagent 证据一次性、taskcreate 标题 4-8 汉字等)。",
        tags: ["提示词", "工具"],
      },
      {
        at: "const EFFORT_POLICIES",
        title: "思考强度策略表",
        note: "五档策略文本:low 最短可靠路径 / medium 平衡默认 / high 方案比较与分阶段验证 / xhigh 任务地图与双类证据交叉验证 / max 完整闭环多层验证。ReasoningEffortPromptPart(40)按当前档位注入。",
        tags: ["提示词"],
      },
      {
        at: "export function formatSkillsCatalogPrompt",
        title: "Skill 目录分片(预算控制)",
        note: "只注入发现元数据(name/description/when_to_use,各截 160 字符),maxChars=8000 逐条累加、超预算跳过并提示「另有 N 个未注入」;头部明确声明目录不是可执行指令、正文必须经 loadskill 加载——提示注入防御。仅在 loadskill 工具启用时输出。",
        tags: ["提示词", "Skill"],
      },
      {
        at: "export class PlanModePromptPart",
        title: "Plan 模式分片与组装器",
        note: "PlanModePromptPart(50)仅在 plan 档注入:禁止写操作、计划具体到文件与验证方法、Todo 建完必须单独输出方案正文供审阅、审批前禁用 taskfinish、子代理同样只读(防绕权)。SystemPromptManager 按 priority 升序逐个 await getContent,空分片自动跳过,\\n\\n 拼接。",
        tags: ["提示词", "Plan"],
      },
    ],
  },

  "packages/core/src/session-manager.ts": {
    desc: "会话(聊天历史)持久化:内存立即生效 + 120ms 去抖合并 + tmp/rename 原子写 + 失败回填重试;UI 永远只写内存,磁盘写入被合并成同一文件的最后一次写。",
    segs: [
      {
        at: "const SESSION_FLUSH_DELAY_MS",
        title: "深比较与幂等检测",
        note: "cloneMessage 手写深拷贝(避免整段 JSON 序列化开销);sameMessages 逐条深度比较两份消息数组——saveCurrentSession 用它做重复写检测,内容没变就完全不触发 IO。",
        tags: ["会话", "性能"],
      },
      {
        at: "export class SessionManager",
        title: "类骨架与告警缓冲",
        note: "pendingWrites 按「文件路径 → 最后一次操作」合并(save 或 remove 二选一);writeChain 串行化 Promise 链防并发写竞争;告警在 handler 注册前先缓存、注册时回放,保证启动早期的持久化失败不被吞掉。",
        tags: ["会话"],
      },
      {
        at: "public saveCurrentSession(",
        title: "saveCurrentSession 与 flush",
        note: "保存流程:更新内存 → 幂等检测(零 IO 快速路径)→ 一次性克隆不可变快照(同一份快照复用于重复检测与载荷,避免长会话克隆两次卡顿)→ 空会话标记 remove(不落盘)→ 入 pendingWrites → 120ms 去抖。flush 强制落盘(resume/退出边界):mkdir → tmp → 原子替换,失败时把操作回填 pendingWrites 下次重试并告警「数据已保留」;期间又积压新写则递归 flush。",
        tags: ["会话", "持久化"],
      },
      {
        at: "public loadSession(",
        title: "loadSession / listSessions / 标题生成",
        note: "loadSession 恢复后刷新快照防止首次保存被误判未变化;listSessions 顺手清理空壳会话文件、损坏文件静默跳过;generateTitleAsync 用低强度模型生成「10 字以内无标点」标题,任何异常回退首条消息前 25 字——标题生成永不阻塞主流程。",
        tags: ["会话"],
      },
    ],
  },

  "packages/core/src/task-store.ts": {
    desc: "按会话作用域持久化的任务计划存储:为 taskcreate/tasklist/updatetask/taskfinish 提供带 blockedBy DAG 依赖与「完成必须提交验证」门禁的任务状态机。",
    segs: [
      {
        at: "export interface TaskAgentState",
        title: "数据模型",
        note: "TaskItem 含 status/blockedBy 依赖/verification(完成时必须提交)/agent(关联子代理);TaskPlan 把 tasks 与 completedTasks 分离——完成即搬运是核心结构设计,活动列表永远只剩未完成。",
        tags: ["任务"],
      },
      {
        at: "setTaskScope(",
        title: "getPlan / createTask / updateTask",
        note: "getPlan 读路径永不抛错(旧格式迁移 summary→title、逐项 normalize 容错)。createTask 校验最严:id 唯一、首条任务必须给标题(≤12 字符)、blockedBy 只能引用已存在任务(禁止前向引用)。updateTask 的 status 只允许 pending/in_progress——<b>完成必须走 taskfinish 提交验证</b>;置 in_progress 前做 DAG 就绪检查(还有活动阻塞项就拒绝)。",
        tags: ["任务"],
      },
      {
        at: "finishTask(",
        title: "finishTask:验证门禁与依赖解锁",
        note: "四重门禁:verification 非空;任务在活动列表;必须先 in_progress(错误消息直接给出应调的 updatetask 示例,引导模型自我修正);关联子代理必须已 verified(与 AgentManager 的证据绑定联动)。通过后:搬运到 completedTasks、从所有依赖它的任务中剔除该 id(解锁下游)、返回 allDone 提示总验证时机。",
        tags: ["任务", "信任"],
      },
      {
        at: "setTaskAgent(",
        title: "其余维护方法",
        note: "setTaskAgent 绑定/解绑子代理;clearTasks 幂等清理;normalizeTask 对历史/损坏数据逐字段容错(非法 status 回退 pending),保证读入后永远是安全形状。注意 writePlan 是直接覆盖写(未用原子替换,与 session/agent 不同)。",
        tags: ["任务"],
      },
    ],
  },

  "packages/core/src/experience-types.ts": {
    desc: "经验系统数据模型:观测 Observation / 规则 Instinct / 记忆 Memory 三件套。Instinct = 一个 trigger + 一个 action,置信度演化规则:首现 0.5、重复 +0.05 上限 0.9、90 天未触发 -0.05、低于 0.55 弃用、≥0.7 才注入提示词;Memory 三态生命周期(staging→active→archived)与 Instinct 互补:「要知道什么」vs「怎么做」。ToolObservation 是 PostToolUse 采集的观测样本(failed 由 isFailedToolOutput 判定,depth 区分主循环 0/子代理 1)。",
  },

  "packages/core/src/experiences-prompt-part.ts": {
    desc: "经验系统的 system prompt 分片(priority 46):每轮调用前用「项目名 + 最近一条用户消息」做 Jaccard 关键词召回,高置信规则(≤8 条)+ 已确认记忆(≤5 条)按 2000 字符预算注入「行为规则/项目知识与偏好」两段;空库返回空串不占 token,每轮重算天然反映最新经验。",
  },

  "packages/core/src/experience-store.ts": {
    desc: "经验系统持久化与召回层:观测流(.haji/observations.jsonl 30 天滚动 + 按月归档)与规则/记忆两类 Markdown 文件的两级目录存储(项目级覆盖用户级),提供置信度演化状态机与 Jaccard 关键词召回。",
    segs: [
      {
        at: "const OBSERVATIONS_MAX_BYTES",
        title: "常量表与观测缓冲",
        note: "归档阈值 5MB/8000 行、保留 30 天;演化参数(见 experience-types)。appendObservation 纯内存 push 零 I/O(会话内高频调用),flushObservations 串行链落盘,失败 unshift 回缓冲重试,落盘后异步触发归档检查。",
        tags: ["经验系统"],
      },
      {
        at: "flushObservations(): Promise<void>",
        title: "观测读取与统计",
        note: "loadRecentObservations 合并主文件+当月归档按天数过滤(损坏行静默跳过);getObservationStats 统计失败率/失败 Top5 工具/周趋势(两窗口各≥10 样本才可信)——经验系统是否生效的间接度量。",
        tags: ["经验系统"],
      },
      {
        at: "loadInstincts(",
        title: "规则:加载 / 演化状态机",
        note: "两级目录合并(项目级覆盖同名 id)。evolveInstincts 是置信度状态机:同 id 重复→+0.05 封顶 0.9、occurrenceCount++、action/trigger 取新表述;新规则强制 confidence=0.5;90 天未触发→-0.05、低于 0.55 置 deprecated。返回被强化的 id 集合。",
        tags: ["经验系统"],
      },
      {
        at: "loadMemories(",
        title: "记忆:staging → active 生命周期",
        note: "扫 4 个 scope 目录(user/project × active/staging,项目级 staging 视作 active 覆盖);stageMemory 写项目级 staging(LLM 候选须 /memory confirm 防 noise);confirm 按 type 决定 user/project 落点;pruneMemories active 超 100 条按置信度升序淘汰;promoteInstinct/promoteMemory 项目级提升用户级(提升规则必须改 source=manual,否则演化时会写回项目级)。",
        tags: ["经验系统"],
      },
      {
        at: "recallInstincts(",
        title: "召回:tokenize + Jaccard",
        note: "无向量检索:英文字母数字 token + 中文按单字入集合,Jaccard 相似度排序;instincts 取 Top8(置信度≥0.7)、memories 取 Top5(仅 active)——这就是每轮注入提示词的候选来源。",
        tags: ["经验系统"],
      },
      {
        at: "private async ensureDir",
        title: "存储基建与观测归档",
        note: "原子写(tmp + replaceFileAtomically);按文件名正则匹配 id;maybeArchiveObservations 归档状态机:仅当 ≥5MB 且 ≥8000 行才触发,30 天前的行按月追加到归档文件、主文件重写只留近期(损坏行保留在主文件)。persistInstincts 增量 upsert(先按 id 清两级旧文件再写入)——注释记录历史教训:早期清空目录重写有崩溃丢数据风险。",
        tags: ["经验系统", "持久化"],
      },
      {
        at: "private serializeInstinct",
        title: "Markdown 序列化与解析",
        note: "规则 = frontmatter(id/confidence/domain/source/deprecated/observedAt/occurrenceCount)+ 正文 ## Trigger / ## Action 两节;记忆 = frontmatter + 正文即内容;解析失败返回 null 静默跳过。尾部附极简手写 YAML 解析(不依赖 yaml 库)与 tokenize/jaccard 导出。",
        tags: ["经验系统"],
      },
    ],
  },

  "packages/core/src/distill-engine.ts": {
    desc: "经验提炼引擎:会话结束时对工具观测做双路径提炼——零成本的 6 个硬编码统计检测器 + 智能触发的 LLM 语义分析(失败≥2 或观测≥20 才触发),产出规则与记忆候选交给 ExperienceStore 演化/入 staging。",
    segs: [
      {
        at: "const LLM_TRIGGER_MIN_OBS",
        title: "触发阈值与 TOOL 常量表",
        note: "LLM 触发条件:failedCount≥2 或 obs≥20,30s 超时。TOOL 工具名常量表的注释记录了历史教训:早期硬编码 'Edit'/'ReadFile' 等大小写错误导致全部检测器失效——工具名是协议唯一真源。provider/model 用闭包按需取值,避免 /model 切换后持有失效引用。",
        tags: ["经验系统"],
      },
      {
        at: "async runDistill(",
        title: "runDistill:双路径编排",
        note: "无观测早退;路径 A(统计)始终运行;路径 B(LLM)按阈值触发,失败仅记 note 不中断;两路结果 Union-Find 去重后交 evolveInstincts(强化/新建),记忆候选逐条 stageMemory;组装 DistillSummary 并输出「统计 X / LLM Y / 强化 Z」摘要。",
        tags: ["经验系统"],
      },
      {
        at: "private detectStatisticalPatterns",
        title: "六个统计检测器",
        note: "每个检测器独立 try/catch 隔离:①Edit 前同文件 5 分钟内无 Read;②失败 bash 后有同前缀成功调用(值得先检查再重试);③Grep 成功后 5 分钟内 Read 确认;④subagent 成功后无 verifyagent 跟进;⑤同文件 Write≥2 次(该用 edit);⑥按「工具:错误签名」聚类≥3 次的失败模式(error-prevention,产出前置检查建议)。",
        tags: ["经验系统"],
      },
      {
        at: "private async analyzeWithLLM",
        title: "LLM 语义分析",
        note: "构建观测 digest(最近 40 条,每条压成一行 ✓/❌ tool(arg) → 失败前 120 字符)+ 最近 12 条消息(每条 300 字符);system 指令要求只输出 JSON(≤5 instinct、≤3 memory、稳定 kebab-case id);temperature 0.2 / low effort / 30s 超时。parseLLMResponse 正则提取首个 JSON,过滤缺字段条目,解析失败返回空(不中断)。",
        tags: ["经验系统", "LLM"],
      },
      {
        at: "private deduplicateInstincts",
        title: "Union-Find 去重与候选构造",
        note: "两两 Jaccard≥0.5 的规则合并为一组,每组取 trigger+action 更长者作代表;makeInstinct 统一 confidence=0.5(演化由 Store 负责)。",
        tags: ["经验系统"],
      },
      {
        at: "function normalizeCommand",
        title: "辅助函数",
        note: "normalizeCommand 取首个 token 供跨调用比较;extractErrorSignature 优先匹配已知错误关键词(ENOENT/timeout)退化为前 40 字符去标点;sanitizeDomain/sanitizeMemoryType 白名单兜底;withTimeout 超时 reject 以免阻塞会话退出。",
        tags: ["经验系统"],
      },
    ],
  },

  "packages/core/src/skill-registry.ts": {
    desc: "Skill(技能包)只读扫描与加载注册表:扫描两级 .haji/skills 目录的 SKILL.md(frontmatter + 正文),提供按 scope 去重的目录、幂等的上下文注入(load)与带安全沙箱约束(路径校验/符号链接拒绝/大小限额)的资源读取与校验。",
    segs: [
      {
        at: "const SKILL_NAME_PATTERN",
        title: "限额常量与路径安全工具",
        note: "SKILL.md 上限 64KB、资源 256KB、asset 10MB、每 Skill 资源 256 个。<code>normalizeResourcePath</code> 是资源路径的安全核心:拒绝绝对路径/../空段/盘符/Windows 保留设备名(con、nul、com1-9…),skill.md 本身禁读(必须走 loadskill);decodeUtf8 用 fatal TextDecoder,二进制即抛错。",
        tags: ["Skill", "安全"],
      },
      {
        at: "export class SkillRegistry",
        title: "scan / scanRoot:两级扫描",
        note: "scan 全量重建:先扫用户级再扫项目级(项目级覆盖)。scanRoot 对每个 SKILL.md:realpath 包含检查(防符号链接逃逸)、大小限制、frontmatter 解析(name 正则、description 兜底取首个标题)、双拼写兼容(when_to_use/user_invocable)、sha256 内容指纹;扫描后会联动清掉内容已变化的已加载状态。",
        tags: ["Skill"],
      },
      {
        at: "list(): SkillCatalogItem[]",
        title: "目录、已加载状态与 load 幂等注入",
        note: "restoreScopeFromMessages 从历史消息的加载标记提取激活记录(hash 一致才恢复——压缩后重建状态)。<code>load</code> 幂等:同名同 hash 已常驻则返回 ALREADY_LOADED 提示;否则输出加载标记(JSON 行)+ 安全声明(不能覆盖用户要求/权限模式)+ [SKILL_CONTENT] 包裹的正文,调用参数截断 4000。",
        tags: ["Skill"],
      },
      {
        at: "private async assertResourcePath",
        title: "资源沙箱:assertResourcePath / collectResources",
        note: "资源路径逐段 lstat,<b>拒绝任何符号链接段</b>,最后 realpath 必须落在 Skill 真实目录内。collectResources 递归遍历(排序、总数封顶、拒绝符号链接/越界/非普通文件),资源数封顶 256。",
        tags: ["Skill", "安全"],
      },
      {
        at: "async listResources(",
        title: "listResources / readResource",
        note: "readResource 按 kind 选字节上限(asset 10MB,其余 256KB),fatal UTF-8 解码;AbortError 透传为中止消息。",
        tags: ["Skill"],
      },
      {
        at: "async validate(",
        title: "validate:校验器",
        note: "不重扫的校验(/skills validate):对每个 skill 重新 collectResources 并逐资源做路径断言、大小检查、非 asset 资源强制 UTF-8 解码验证,产出 error/warning 级 issue 列表。",
        tags: ["Skill"],
      },
    ],
  },

  "packages/core/src/skill-types.ts": {
    desc: "Skill 子系统纯类型:SkillEntry(完整条目)、SkillCatalogItem(给模型的目录项,不含正文)、SkillActivation(一次加载记录:name/source/contentHash)、资源四类(reference/script/asset/resource)与校验 issue/result。",
  },

  "packages/core/src/skill-context.ts": {
    desc: "Skill 激活上下文的标记协议:extractSkillActivations 从历史消息扫描加载标记(system 中的激活区块 + tool 消息的 [HAJI_SKILL_LOADED] 行,hash 一致才 resident);formatSkillActivationContext 把提取结果重建为轻量「曾加载过」清单塞回 system prompt(附「正文被压缩移除时请重新 loadskill」提示)——压缩/恢复后技能状态不丢。",
  },

  "packages/core/src/subagent-runner.ts": {
    desc: "隔离子代理执行器 SubagentRunner:在独立上下文跑一个不可递归的子 agent 循环(流式调用+工具执行),带 Token/工具次数/轮数三重预算与畸形工具调用恢复,结果强制标记 UNVERIFIED。",
    segs: [
      {
        at: "export const MAX_SUBAGENT_INSTRUCTIONS_LENGTH",
        title: "请求/结果类型与预算常量",
        note: "预算:Token 默认 100k(1k–2M)、工具次数默认 50(1–500)、instructions ≤8000 字符;SubagentResult 六态(completed/failed/aborted/max_turns);SubagentEvent 联合(start/tool/text_delta/usage/warning/done)供 UI 流式展示。",
        tags: ["子代理"],
      },
      {
        at: "function parseFinalResult",
        title: "最终结果解析",
        note: "剥掉 \\`\\`\\`json 围栏后解析最终 JSON;<b>容错</b>:解析失败时整段文本当 summary、状态仍 completed(子代理没按格式收尾也不至于全丢)。<code>formatSubagentResult</code> 输出 [SUBAGENT_RESULT - UNVERIFIED] 前缀——强制父代理验证的输出侧。",
        tags: ["子代理"],
      },
      {
        at: "export class SubagentRunner",
        title: "runResult:子代理主循环",
        note: "<b>递归守卫</b>:depth>0 直接拒绝(子代理不能再派生子代理);工具过滤移除 subagent 与 task* 工具;系统提示词注入角色/工作目录/共享权限约束/JSON 返回格式。主循环(默认 20 轮)每轮:abort 与 Token 预算检查 → completeStream(单次输出受剩余预算约束)→ 流式事件外发 → usage 记账(provider 没给用量时保守估算并警告一次)→ <b>仅当全部 toolCalls 校验合法才挂 tool_calls</b>(防污染上下文)→ 畸形调用注入恢复提示重试(第 2 次即终止)→ 工具执行(每次调用前查 abort,异常转字符串输出而非中断)→ 无工具调用即解析最终结果返回。轮数耗尽返回 max_turns;catch 分类 aborted/Timeout/failed,均发 done 事件,不向父层抛异常。",
        tags: ["子代理"],
      },
    ],
  },

  "packages/core/src/snapshot-engine.ts": {
    desc: "内容寻址的工作区快照与会话级修改日志:快照仅用于状态比较,/rewind 只逆向撤销「本会话工具实际造成且之后未被外部修改」的变更(git HEAD 锚定 + before/after manifest 差异 + journal 倒序回放)。",
    segs: [
      {
        at: "interface SnapshotFile",
        title: "数据结构",
        note: "SnapshotManifest(version 2:id/headHash/timestamp/files,path→blob 哈希/kind(file|symlink)/mode);MutationRecord 是 journal 条目(anchor/before/after 快照 id、paths、head 哈希对)。",
        tags: ["rewind"],
      },
      {
        at: "export class SnapshotEngine",
        title: "快照创建",
        note: "磁盘布局:.haji/snapshots/{manifests,blobs,journals}。<code>createSnapshot</code> 以 git HEAD 为锚(无 HEAD 返回 null,非 git 环境功能整体失效);路径集 = git ls-files 托管+未忽略文件(排除 .haji 运行时但保留 .haji/skills);内容写 blobs(sha256 寻址去重);失败仅 warn 不抛(「本次修改可能无法回退」)。",
        tags: ["rewind"],
      },
      {
        at: "createAnchor(",
        title: "变更追踪:anchor → begin → complete",
        note: "createAnchor 记 HEAD+时间的空锚点(挂在用户消息上);beginMutation 为锚点路径集拍 before 快照;completeMutation 拍 after 快照、算 changedPaths 差集、追加 journal;<b>HEAD 变化时返回警告</b>(标记为不可自动回退)——用户手动 commit 过就不再自动回退。",
        tags: ["rewind"],
      },
      {
        at: "rollbackOwnedChanges(",
        title: "rollbackOwnedChanges:核心回退算法",
        note: "三重前置:快照元数据存在、当前 HEAD = 目标 HEAD、journal 记录的 manifest 一致。筛选目标时间之后的 journal 记录<b>倒序</b>回放:每条记录逐路径先用 currentMatches 验证当前磁盘仍等于 after 快照——<b>外部修改过的文件 preserve(不覆盖用户改动)</b>,其余 restoreFile 回 before 状态;最后截断 journal。回退的是「自己造成的且未被碰过的」,绝不误伤。",
        tags: ["rewind"],
      },
      {
        at: "private changedPaths(",
        title: "差异比较与文件恢复",
        note: "blob/kind/mode 三者全同才算未变;currentMatches 重算 sha256(kind+\\0+content) 比对;restoreFile:目标为空则删除文件并清理空父目录,symlink 用 symlinkSync,文件带 mode 写入。",
        tags: ["rewind"],
      },
      {
        at: "private storeBlob(",
        title: "blob/journal 存储与路径安全",
        note: "storeBlob 用 'wx' 独占创建实现去重;journal 按.scope 一份、读取时过滤合法记录;resolveWorkspacePath 强制解析结果落在 cwd 内(防逃逸);removeEmptyParents 删文件后向上清理空目录。",
        tags: ["rewind"],
      },
    ],
  },

  "packages/core/src/context-compact.ts": {
    desc: "四层渐进式上下文压缩管线(L1 大工具结果落盘→L2 中间对话裁剪→L3 旧工具输出占位→L4 全量结构化摘要)+ token 启发式估算器 + 工具调用配对协议修复;主会话与子代理共用。",
    segs: [
      {
        at: "export function estimateMessagesChars",
        title: "token 启发式估算",
        note: "加权估算:CJK 0.7 token/字、ASCII 字母数字 0.25、代码标点/空白 0.5;每条消息固定 +4 协议开销;默认跳过 system;tool_calls 也序列化估算。不调 tokenizer,足够做压缩触发判断。",
        tags: ["上下文压缩"],
      },
      {
        at: "export function repairToolCallPairs",
        title: "工具配对协议修复",
        note: "状态机保证:assistant 的每个 tool_call id 在紧随的 tool 消息中恰好出现一次;孤儿 tool 消息丢弃;配对不完整时保留纯文本 assistant(剥 tool_calls);未变更返回原引用(引用相等做变更检测)。另含子代理验证上下文/Skill 激活上下文的剥离与收集(压缩时不丢这些约束)。",
        tags: ["上下文压缩", "健壮性"],
      },
      {
        at: "export function toolResultBudget",
        title: "L1:大工具结果落盘",
        note: "全部 tool content 总长 >150KB 才启动:从后往前把 >5000 字符的工具结果写入 .haji/task_outputs/<toolCallId>.txt,原地替换为 <persisted-output> 标签 + 1500 字符预览 + 落盘路径提示(模型需要时可重新读取);写盘失败静默保留原文。",
        tags: ["上下文压缩"],
      },
      {
        at: "export function snipCompact",
        title: "L2/L3:对话裁剪与占位",
        note: "L2 snipCompact:消息 >40 条时保留头 3 + 尾 20(tailStart 落在 tool 消息上则后移避免拆散配对),插入「已裁切中间 N 条」占位。L3 microCompact:只保留最近 3 条工具结果完整内容,更早的超 120 字符替换为占位提示。",
        tags: ["上下文压缩"],
      },
      {
        at: "export async function compactHistory(",
        title: "L4:全量结构化摘要",
        note: "完整轨迹先落盘 .haji/transcripts/transcript_<ts>.jsonl(永不丢原文);摘要来自 summaryProvider(空返回抛错→降级 generateFallbackSummary 本地四段式);重建 system 消息:剥旧摘要段 → 拼新摘要 + transcript 路径提示 + 重建 Skill/验证上下文;保留最近 2 个 user 轮次对话;最后 repairToolCallPairs。",
        tags: ["上下文压缩"],
      },
      {
        at: "export async function runCompactionPipeline(",
        title: "管线编排",
        note: "顺序:协议修复 → L1 无条件 → forceL4 或超阈值才进 L4(L2/L3 只作为 L4 的「最近对话保留集」预处理——完整历史交给摘要模型,不再无摘要丢弃)→ summaryProvider 包装标记 model/fallback 模式 → 结束再修一次协议 → 计算 chars/tokens/freedPercentage。",
        tags: ["上下文压缩"],
      },
    ],
  },

  "packages/core/src/context-policy.ts": {
    desc: "core 侧自动压缩阈值策略(与 cli/context-policy.ts 分工:那边解析窗口大小,这边定义触发规则):默认窗口 1M tokens;触发比 0.7、重新布防比 0.5、紧急比 0.9。shouldTriggerAutoCompaction 用滞回(hysteresis)策略——emergency 线无条件触发;常规 trigger 线仅在 armed 时触发,压缩后须降回 rearm 以下才重新布防,避免在阈值附近反复压缩。",
  },

  "packages/core/src/trace-logger.ts": {
    desc: "Append-only 会话轨迹记录器 SessionTracker:user 输入/LLM 调用/工具执行三类事件经体量压缩(消息集≤12 条、文本≤12k、参数≤8k)后,以 40ms 防抖批量写入「小 meta 文件 + JSONL 事件流」双文件格式,失败重排队,兼容 v1 旧格式读取。",
    segs: [
      {
        at: "const TRACE_FLUSH_DELAY_MS",
        title: "事件类型与体量压缩",
        note: "compactMessages ≤12 条全保留,否则保留首条 system + 尾部凑满 12 条并记 omittedMessageCount;compactArguments 序列化超 8k 替换为截断标记——Trace 永远是「元数据 + 摘要」,不是完整录像。",
        tags: ["Trace"],
      },
      {
        at: "export class SessionTracker",
        title: "SessionTracker:防抖批量写",
        note: "磁盘:.haji/traces/session_<uuid>.meta.json + .events.jsonl;append 入 pendingLines 缓冲、40ms 防抖定时器(unref 不阻塞退出);flush 在串行链上 mkdir+append+writeMeta,<b>events 未写入时把行 unshift 回缓冲下次重试</b>,仍有积压则递归 flush。",
        tags: ["Trace", "持久化"],
      },
      {
        at: "public recordUserInput(",
        title: "记录 API 与静态读取",
        note: "recordUserInput/recordLlmCall(首个调用填充 meta.modelUsed)/recordToolExecution;save() 设 endTime 落盘返回路径。static readSession v2 优先(事件文件损坏仅丢事件不丢会话)、fallback v1 单文件;listSessions 按 startTime 降序。",
        tags: ["Trace"],
      },
    ],
  },

  "packages/core/src/permission-engine.ts": {
    desc: "权限引擎:按 plan/default/accept-edit/auto/bypass-permissions 五档对每次工具调用评估 allow/prompt/deny;auto 档委托 SecurityClassifier 做动态风险分级。",
    segs: [
      {
        at: "export function isPermissionMode",
        title: "模式表与只读/编辑白名单",
        note: "PERMISSION_MODES 五条目常量表是模式枚举的单一真源。isReadOnlyTool:read/grep/global/projectinfo/web 系/skill 系 + 运行期注册集(readOnly MCP 工具经 registerReadOnlyTool 加入,任何模式自动放行);isEditTool:write/edit 两对命名。",
        tags: ["权限"],
      },
      {
        at: "export class PermissionEngine",
        title: "evaluate 决策树",
        note: "顺序:①plan 只放行只读+subagent/verifyagent+task 创建类,其余 deny;②bypass-permissions 无条件 allow;③只读工具任何模式 allow;④task* 工具 allow(只写会话元数据);⑤subagent/verifyagent allow(子代理内部的真实工具调用仍会单独过本引擎);⑥accept-edit:编辑工具 allow、其余 prompt;⑦default 一律 prompt;⑧auto:classifier.assess → 安全 allow,否则 deny 带原因;兜底 prompt。",
        tags: ["权限", "安全"],
      },
    ],
  },

  "packages/core/src/security-classifier.ts": {
    desc: "工具调用危险分类器(PermissionEngine 的 auto 档依赖):bash 命令正则分级链——critical(rm -rf /、fork 炸弹、mkfs、curl|sh 远程注入)、high(rm -rf、git reset --hard、chmod 777、sudo)、medium(普通 rm、包安装)、low(常规构建测试);文件编辑看路径(.env/.ssh/id_rsa、/etc、C:\\Windows 为 high)。与用户设定阈值(low/medium/high)比较决定放行。",
  },

  "packages/core/src/hook-engine.ts": {
    desc: "生命周期 Hook 引擎:UserPromptSubmit(发往 LLM 前)/PreToolUse(执行前)/PostToolUse(返回模型前)/Stop(退出前)四个切点各挂处理器链;trigger 顺序 await 执行,任一返回非空字符串立即中断链并作为拦截/改写结果,全部放行返回 null。权限审批、经验观测、自动压缩都通过它挂进主流程,与主逻辑解耦。",
  },

  "packages/core/src/serve-chat.ts": {
    desc: "零依赖的本地 Web Chat 服务器(node:http,3001 端口):内存维护多会话,每会话独立 SessionTracker 记轨迹;POST /api/chat 以 NDJSON 流式推送 text/tool_start/tool_end/done 事件,工具<b>自动授权执行</b>(网页端无审批交互);畸形工具调用拦截(不挂 tool_calls、发 error 事件);静态页兜底回 src 目录;openBrowser 按平台打开。",
  },

  "packages/core/src/serve-traces.ts": {
    desc: "零依赖的 Trace 可视化 HTTP 服务器(/viewer,3000 端口):静态 viewer 页面(优先 dist、兜底 src)+ /api/sessions 会话列表 + /api/session/:id 详情(id 先过 ^[a-f0-9-]+$ 白名单防路径越权);CORS 全开;keepAlive=false 时 unref 不阻塞退出。",
  },

  "packages/core/src/chat.html": {
    desc: "Web Chat 前端页面(由 serve-chat.ts 托管):浏览器端对话界面,NDJSON 流式渲染助手回复与工具执行事件,配合 /api/chat 的 text/tool_start/tool_end/done 事件协议;零构建、单文件。",
  },

  "packages/core/src/trace-viewer.html": {
    desc: "Trace 观测中心页面(由 serve-traces.ts 托管,/viewer 打开):会话列表 + 详情视图,展示 user 输入/LLM 调用(TTFT、速度、用量)/工具执行轨迹,数据来自 /api/sessions 与 /api/session/:id;零构建、单文件。",
  },

  "packages/core/src/failed-output.ts": {
    desc: "工具输出失败判定的唯一标准 isFailedToolOutput(PostToolUse hook、ExperienceStore、DistillEngine 共享):「错误:」「执行出错:」前缀、[xx已中止] 模式、安全引擎拦截、SUBAGENT_RESULT 内嵌 failed/aborted/max_turns 状态——比 Trace 的 approved 字段覆盖更广。",
  },

  "packages/core/src/abort.ts": {
    desc: "中止错误统一识别与归一化:isAbortError 识别 Node/undici/浏览器三族 AbortError(沿 cause 链递归下钻);normalizeAbortError 构造稳定 AbortError(保留 message、code 挂 ABORT_ERR),网络层与工具层共享。",
  },

  "packages/core/src/atomic-file.ts": {
    desc: "Windows 友好的原子文件替换:只用 rename,对杀软/扫描器造成的短暂目标锁(EACCES/EBUSY/EPERM)按 [0,10,25,50]ms 重试,耗尽后删除临时文件并抛出——绝不回退为非原子就地拷贝,调用方保留内存内容以待重试。",
  },

  "packages/core/src/retry.ts": {
    desc: "LLM/网络请求指数退避重试:isRetryableError 三层判定(ProviderError.retryable 显式标志最优先 → HTTP 429/≥500 → timeout/fetch failed/econnreset 等关键词;AbortError 明确不重试);calculateBackoffDelay Full Jitter 抖动防惊群;withExponentialBackoff 通用包装器,onRetry 回调透传给 UI。",
  },

  "packages/core/src/performance-monitor.ts": {
    desc: "轻量性能监控:每指标 256 条环形样本 + node:perf_hooks 事件循环延迟直方图,输出 count/avg/p95/max 快照;measureSync/measure 包裹同步/异步操作自动记耗时;导出全局单例 performanceMonitor(/perf 命令、terminal-wrap 打点、tool.batch 收益统计都上报到这里)。",
  },

  "packages/core/src/tool-call-validation.ts": {
    desc: "模型返回 tool_calls 的协议级校验:validateToolCall 流水(对象/id 非空/type=function/name 非空/arguments 是 JSON 字符串且解析为对象),成功返回解析后的参数;findInvalidToolCall 在消息历史里定位第一条畸形调用——请求发出前拦截,不污染上下文。",
  },

  /* ================= Plugins · 工具与模型接入 ================= */
  "packages/plugins/src/index.ts": {
    desc: "@hajicli/plugins 桶式导出入口:export * 汇总 19 个模块(工具 + Provider + 基础设施),CLI 从包根统一导入。",
  },

  "packages/plugins/src/bash-tool.ts": {
    desc: "bash 工具:终端命令执行 + 超时/中止时的进程树清理(Windows 下 taskkill + PowerShell/C# 快照枚举兜底)+ 头尾保留输出缓冲 + 流式进度。",
    segs: [
      {
        at: "class HeadTailBuffer",
        title: "有界输出缓冲",
        note: "头部保留 1000 字符、尾部 2500 字符,中间以「[中间省略 N 个字符]」标记——长输出不撑爆上下文,又保留开头错误与结尾结果。",
        tags: ["工具", "bash"],
      },
      {
        at: "export function classifyBashMutationScope",
        title: "命令副作用分类",
        note: "含管道/重定向/命令替换/换行或 --output 的一律按修改型(要快照);白名单只读命令(git status/diff/log/show、ls、dir、Get-* 系列)返回 none 跳过快照;<b>不确定的宁可多做快照</b>——这是快照引擎判断「哪些命令可能改文件」的依据。",
        tags: ["工具", "bash", "快照"],
      },
      {
        at: "export class BashTool",
        title: "工具定义与参数",
        note: "参数:command(必填)、timeoutMs(1s–600s,超时清理进程树)。构造函数注入 commandExecutor/fileExecutor/processKiller 便于测试兜底路径;getMutationScope 委托上面的分类器。",
        tags: ["工具", "bash"],
      },
      {
        at: "public async execute(",
        title: "执行、流式进度与两级进程树清理",
        note: "exec(maxBuffer 10MB)执行;stdout/stderr 流式 chunk 经 onProgress 推给 UI 实时渲染。中止/超时清理是重头戏:优先 taskkill /PID /T /F;<b>失败则跑 PowerShell 内嵌 C#(CreateToolhelp32Snapshot 快照枚举父子关系)求后代 PID 逆序逐个杀</b>再杀父进程——Windows 没有进程组,这是 orphan 清理的兜底;非 Windows 直接 SIGTERM。等 child close 事件(最多 750ms 兜底)确保输出完整后结算。",
        tags: ["工具", "bash", "健壮性"],
      },
    ],
  },

  "packages/plugins/src/read-tool.ts": {
    desc: "read 工具:按完整行读取单文件或批量(最多 10 个),支持行区间/目标行上下文/分页,返回内容 hash(供 edit/write 乐观并发防护)与 nextStartLine。",
    segs: [
      {
        at: "interface ReadRequest",
        title: "参数解析",
        note: "startLine/endLine 与 aroundLine±contextLines 互斥;limit 默认 200 最大 1000;批量形态 paths 数组(1-10 个)与单文件形态互斥;输出预算按请求数平分(每文件至少 700 字符)。",
        tags: ["工具", "read"],
      },
      {
        at: "export class ReadFileTool",
        title: "renderFile 与执行",
        note: "resolveWorkspacePath 限工作区后读文件:前 1024 字节含 0 判二进制(只返回大小与 hash);逐行截断渲染,takeWholeRecords 按预算保留完整行;头部含总行数、返回区间、hash、hasMore 与 nextStartLine——模型凭 hash 调 edit/write,凭 nextStartLine 翻页。",
        tags: ["工具", "read"],
      },
    ],
  },

  "packages/plugins/src/write-tool.ts": {
    desc: "write 工具:文件创建/完整覆写。resolveWorkspacePath(mustExist:false 支持新路径但仍拦截双越界)→ mkdir -p → writeUtf8Atomically 原子落盘(可选 expectedHash 做写前冲突检测,文件被外部改过则拒绝并要求重读);成功返回路径/字节数/new hash。",
  },

  "packages/plugins/src/edit-tool.ts": {
    desc: "edit 工具:精准编辑——oldText 必须在文件中唯一匹配(第二次 indexOf 命中即拒绝,要求补上下文);expectedHash 乐观并发防护(hash 按原始字节计算,UTF-8 解码有损的文件也能正确比对);按原始 Buffer 读、切片拼接后原子替换。",
  },

  "packages/plugins/src/file-content.ts": {
    desc: "文件内容指纹与原子写核心(write/edit 共用):contentHash 取 sha256 前 16 位 hex;FileConflictError 携带期望/实际 hash;writeUtf8Atomically:同目录 .tmp(flag wx 防撞、mode 透传)→ 写前最后一刻重读目标验 hash → replaceFileAtomically 原子到位;finally 无条件清理临时文件。",
  },

  "packages/plugins/src/grep-tool.ts": {
    desc: "grep 工作区文本搜索:字面量/正则、glob、文件类型过滤、上下文行与 offset/limit 无状态分页;ripgrep 优先、Node 递归遍历兜底,输出统一 8000 字符预算。",
    segs: [
      {
        at: "interface SearchOptions",
        title: "选项与上限",
        note: "query ≤2000 字符(regex 模式先验证合法性);上下文行 ≤10、页大小 ≤50、offset ≤5000、原始匹配 ≤20000;include/exclude/fileTypes 经 search-filter 校验。",
        tags: ["工具", "grep"],
      },
      {
        at: "async function searchWithRipgrep",
        title: "双引擎搜索与渲染",
        note: "ripgrep 路径:组参数(--fixed-strings/--ignore-case/排除默认目录)逐行解析 file:line:col:content,凑够 offset+limit+1 条提前停止;rg 不可用返回 null 触发纯 Node 回退(递归 walk、前 1024 字节含 0 判二进制跳过)。renderMatch 支持上下文行(本次执行内缓存已读文件行数组,> 标记匹配行)。",
        tags: ["工具", "grep"],
      },
      {
        at: "export class GrepSearchTool",
        title: "工具定义与执行",
        note: "schema 覆盖全部过滤维度;execute:解析参数 → 锁定起始目录 → 先 rg 后 node → 切页 → 逐条渲染守预算 → 头部带引擎标识(ripgrep/node)与分页信息(hasMore/nextOffset)——无状态分页,翻页不依赖服务端游标。",
        tags: ["工具", "grep"],
      },
    ],
  },

  "packages/plugins/src/global-tool.ts": {
    desc: "global 文件查找工具:按名称字面量/正则、glob、类型过滤工作区文件(rg --files 优先 + Node walk 兜底),offset/limit 分页(最大 200/页),大小写默认不敏感(与 grep 相反,适配文件名搜索),输出含引擎标识与 nextOffset。",
  },

  "packages/plugins/src/project-info-tool.ts": {
    desc: "projectinfo 工具:项目语言/目录/包管理/脚本/配置/入口/Git 状态一次性摘要,带指纹缓存(最多缓存 8 个项目,按文件列表+配置文件 mtime 的 hash 失效)——减少模型进入陌生项目时的重复搜索。",
    segs: [
      {
        at: "interface ProjectInfoOptions",
        title: "类型、限额与缓存",
        note: "depth 分 summary/detailed 两档;MAX_SCANNED_FILES=20000;语言映射表(扩展名→语言名)与 CONFIG_NAMES(配置文件名集合)是两大常量表;projectInfoCache 按 cwd 记录的 LRU 缓存防长期会话内存无界。",
        tags: ["工具", "projectinfo"],
      },
      {
        at: "async function listWorkspaceFiles",
        title: "扫描与指纹",
        note: "listWorkspaceFiles 优先 rg --files(排除默认目录限 20000 行),回退手写递归 walk;readPackageSummary 解析 package.json(name/scripts/workspaces);buildProjectInfo 统计语言计数、推断包管理器(按锁文件存在性);computeFingerprint 对文件列表+配置文件 size/mtime 做 hash 作为缓存失效依据;readGitSummary 执行 git status(3s 超时)解析分支与变更。",
        tags: ["工具", "projectinfo"],
      },
      {
        at: "function renderProjectInfo(",
        title: "渲染与执行",
        note: "按 depth 决定各条目上限(summary=10/detailed=30),takeWholeRecords 限 8000 字符。execute:列文件→算指纹→查缓存(refresh 可绕过)→未命中构建并写回(先删后写维持 LRU 序)→可选读 Git→渲染。",
        tags: ["工具", "projectinfo"],
      },
    ],
  },

  "packages/plugins/src/mcp.ts": {
    desc: "MCP(Model Context Protocol)客户端:把外部 stdio JSON-RPC server 的工具以 mcp_<server>_<tool> 接入;含连接管理(initialize 握手→tools/list 分页→tools/call 超时)、readOnly 权限标记与两级配置合并。",
    segs: [
      {
        at: "export interface McpServerConfig",
        title: "配置类型与协议常量",
        note: "server 配置:command/args/env/enabled/readOnly(工具视为只读免审批)/callTimeoutMs(默认 120s);协议版本 2025-06-18;initialize 超时 20s(npx 首次下载)、list 15s;文件头注释写明安全模型:配置只来自用户显式写入的 .haji/config.json,失败输出以「错误:」开头供经验系统观测。",
        tags: ["MCP"],
      },
      {
        at: "export class McpClient",
        title: "McpClient:stdio JSON-RPC 连接",
        note: "spawn 子进程(Windows 必须 shell:true 解析 npx 的 .cmd);stdout 行缓冲分发响应(自增 id 匹配 pending、超时 timer、非 JSON 行忽略);stderr 只留尾部 2000 字符诊断;initialize 握手成功后发 initialized 通知;进程退出 reject 全部 pending;失败即关闭不自动重连。",
        tags: ["MCP"],
      },
      {
        at: "export class McpTool",
        title: "McpTool:单工具包装",
        note: "名为 mcp_<server>_<name>(清洗为合法字符、截 64);parameters 直接采用 server 的 inputSchema;getMutationScope 按 readOnly 返回 none/workspace;isError 或异常返回「错误:」前缀输出。",
        tags: ["MCP"],
      },
      {
        at: "export class McpManager",
        title: "McpManager:多 server 生命周期",
        note: "startAll 并行连接全部启用 server,单个失败降级为 failed 状态不影响其余;collectTools 构造全部工具并跨 server 去重;stopAll 退出时统一清理。",
        tags: ["MCP"],
      },
      {
        at: "export function readMcpServerConfigs",
        title: "配置读取",
        note: "依序读用户级与项目级 .haji/config.json,项目级覆盖用户级同名;JSON 非法静默跳过该层;只接受 command 为非空字符串的条目。",
        tags: ["MCP"],
      },
    ],
  },

  "packages/plugins/src/subagent-tool.ts": {
    desc: "子代理门面工具:subagent 把子任务委派给独立上下文的子代理(实际运行时由 CLI 注入 handler)、verifyagent 强制父 Agent 用独立证据验证子代理结果后才能采信(evidence 必填、evidenceToolCallIds 每个只能绑定一个子代理且使用一次)。",
  },

  "packages/plugins/src/task-tool.ts": {
    desc: "计划任务四工具(全部委托 TaskStore):taskcreate(首条带 title,finalize=true 时输出 PLAN_READY 哨兵触发用户审批)、tasklist、updatetask(只能 pending/in_progress)、taskfinish(必须提交 verification,全部完成时输出 ALL_TASKS_COMPLETE 哨兵提示总验证)。description 里写死了强约束流程「先 tasklist 检查复用」「不建重复任务」「不得跳过 in_progress」。",
  },

  "packages/plugins/src/skill-tool.ts": {
    desc: "Skill 三件套工具:loadskill 按注册表名称加载技能正文(不接受任意宿主路径,调用参数 ≤4000 字符)、listskillresources 枚举已加载技能的附属资源、readskillresource 按行区间安全读取资源文本;输出均限 8000–12000 字符,错误带「错误:」前缀供经验系统捕获。",
  },

  "packages/plugins/src/web-fetch-tool.ts": {
    desc: "webfetch 工具:GET 目标 URL(Chrome UA)后正则清洗 HTML(剥 script/style/head 块、标签换空格、合并空白),8000 字符截断;失败返回状态码或错误消息。",
  },

  "packages/plugins/src/web-search-tool.ts": {
    desc: "websearch 工具:抓取 DuckDuckGo Lite 版 HTML,正则提取 result-link 标题/链接(解 uddg= 跳转参数还原真实 URL)与 result-snippet 摘要,最多 8 条按 Markdown 组装,零结果提示可能被限流;零 API key 依赖。",
  },

  "packages/plugins/src/deepseek.ts": {
    desc: "DeepSeek Provider(OpenAI 兼容协议):默认端点 https://api.deepseek.com/v1、默认模型 deepseek-v4-flash,环境变量 DEEPSEEK_API_KEY/BASE_URL/MODEL 可覆盖。",
    segs: [
      {
        at: "export interface DeepSeekConfig",
        title: "配置与非流式调用",
        note: "构造时解析三段配置,缺 Key 抛 ProviderError;complete 解析 JSON 响应、回调 onFinish/onToolCall/onReasoning/onUsage、返回 content;completeStream 委托共享的 parseOpenAICompatibleStream。",
        tags: ["Provider"],
      },
      {
        at: "private async request(",
        title: "请求构造与重试",
        note: "findInvalidToolCall 先在本地拦截损坏的历史工具调用(不发脏数据);消息映射含 reasoning_content 多轮回传规则(思考上下文正确续接);payload 组装 stream_options.include_usage / tools / thinking{type} / reasoning_effort;发送走 fetchWithNetworkPolicy + withExponentialBackoff(最多 5 次,传输层瞬时故障显式 retryable=true),onRetry 透传给 UI 显示重试倒计时。",
        tags: ["Provider", "重试"],
      },
    ],
  },

  "packages/plugins/src/volcengine.ts": {
    desc: "火山引擎方舟 Provider(OpenAI 兼容):默认端点 https://ark.cn-beijing.volces.com/api/coding/v3、默认模型 glm-5.2(可为 Endpoint ID),环境变量 VOLC_/ARK_ 系列可覆盖;请求管道与 DeepSeek 完全同构(本地校验→消息映射→payload→网络策略+指数退避)。",
    segs: [
      {
        at: "export interface VolcengineConfig",
        title: "配置与非流式调用",
        note: "apiKey 缺省读 VOLC_API_KEY/ARK_API_KEY;complete/completeStream 与 DeepSeek 同构。",
        tags: ["Provider"],
      },
      {
        at: "export class VolcengineProvider",
        title: "请求管道",
        note: "与 deepseek.ts 的 request 逐段对应:findInvalidToolCall 本地拦截 → requestMessages(含 reasoning_content 回传)→ payload(thinking 转 {type})→ fetchWithNetworkPolicy + 5 次退避;错误分类与 retryable 标记逻辑一致。",
        tags: ["Provider", "重试"],
      },
    ],
  },

  "packages/plugins/src/openai-compatible.ts": {
    desc: "通用 OpenAI 兼容 Provider:服务 /provider add 添加的任意自定义端点(OpenAI/Moonshot/vLLM/Ollama…),apiKey/baseUrl/defaultModel 三项必填;逻辑是 DeepSeek/火山的泛化,providerName 用于错误信息与遥测(默认 custom)。",
    segs: [
      {
        at: "export interface OpenAICompatibleConfig",
        title: "配置与调用",
        note: "构造时三项配置缺失分别抛错;baseUrl 去尾斜杠;complete/completeStream 同构。",
        tags: ["Provider"],
      },
      {
        at: "export class OpenAICompatibleProvider",
        title: "请求管道",
        note: "与 deepseek.ts 逐段同构:本地校验、消息映射、payload、网络策略 + 5 次指数退避,provider 名用 this.providerName。",
        tags: ["Provider"],
      },
    ],
  },

  "packages/plugins/src/openai-stream.ts": {
    desc: "OpenAI 兼容 SSE 流解析器(三个 Provider 共用):增量重组 content/reasoning_content/tool_calls/usage/finish_reason。",
    segs: [
      {
        at: "interface StreamToolCallDelta",
        title: "类型与增量合并",
        note: "mergeToolCallDeltas 按 delta.index 定位累积槽:首片创建骨架,后续分片有 id 覆盖 id、有 name 覆盖 name、有 arguments 字符串追加——流式工具参数重组的核心。",
        tags: ["Provider", "流式"],
      },
      {
        at: "export async function* parseOpenAICompatibleStream",
        title: "SSE 主循环",
        note: "TextDecoder(stream:true) 按 \\n 切行、data: [DONE] 结束;坏帧 JSON.parse 失败<b>静默丢弃</b>(容错 provider 拆帧/keepalive),流级失败仍抛错;流结束统一 onFinish(reason)、过滤空槽后一次性 onToolCall(完整重组的工具调用)——调用方拿到的永远是校验过的完整数组。",
        tags: ["Provider", "流式"],
      },
    ],
  },

  "packages/plugins/src/network.ts": {
    desc: "共享网络层:三档超时(网页 60s/模型 300s/连接 20s,环境变量可调)、EnvHttpProxyAgent 代理缓存(HAJI_PROXY > HTTP(S)_PROXY > 标准 http_proxy)、统一 AbortController(父 signal=用户 ESC + 总超时合成)与 ECONN/ENOT 可操作错误包装。",
    segs: [
      {
        at: "export interface ProxyConfiguration",
        title: "超时与代理配置",
        note: "模型超时 300s 单独设的原因:reasoning 模型长生成,60s 会掐断;连接超时 20s 让不在线的代理快速失败。代理实例按「配置签名」缓存复用;noProxy 同理支持。",
        tags: ["网络"],
      },
      {
        at: "function createRequestController",
        title: "abort 合成器",
        note: "把「父 signal(用户 ESC)」与「总超时定时器」合成一个 AbortController:父 signal 已中止立即中止(reason 归一化,TimeoutError 透传);setTimeout 后 unref 不阻塞退出。<b>同一个 signal 贯穿响应头与流式 body 全程,ESC 始终即时生效</b>。",
        tags: ["网络", "abort"],
      },
      {
        at: "export async function fetchWithNetworkPolicy",
        title: "fetch 入口与连接错误包装",
        note: "默认超时来自 getHttpTimeoutMs;合成 controller 替换 init.signal;挂代理 dispatcher、透传 connect.timeout;非 abort 失败经 decorateConnectionError 包装:ECONN* → 无法连接提示(检查网络/HAJI_PROXY/地址)、ENOT* → DNS 解析失败提示——模型能读懂的可操作错误。",
        tags: ["网络"],
      },
    ],
  },

  "packages/plugins/src/model-registry.ts": {
    desc: "内置模型注册表 MODEL_REGISTRY:DeepSeek(deepseek-v4-flash/pro,1M 窗口)与火山方舟(glm-5.2 1M、doubao-pro/lite-32k)共 5 个模型的元数据(value/label/description/provider/contextWindowTokens/maxOutputTokens);MODEL_CONTEXT_WINDOWS 冻结为查找表,是上下文窗口解析的最终回退源。",
  },

  "packages/plugins/src/ripgrep.ts": {
    desc: "ripgrep 子进程封装:runRipgrep(整体输出,maxBuffer 1MB)与 runRipgrepLines(流式限行,凑够 maxLines 即 kill 子进程,避免全仓库结果无限缓冲);rg 未安装(ENOENT)返回 null 触发调用方的纯 JS 回退;abort 时 kill 子进程后 reject。",
  },

  "packages/plugins/src/search-filter.ts": {
    desc: "检索工具的路径过滤基础:默认排除目录/二进制扩展名表、11 类语言→glob 映射、参数解析校验(条数≤32/长度≤256)、可移植 glob 子集(*、**、? )编译为正则、字节序路径比较(与 rg --sort path 一致,保证分页前缀稳定)与 include/fileTypes/exclude 三层过滤器。",
  },

  "packages/plugins/src/workspace-path.ts": {
    desc: "工具路径安全层(全部文件工具共用):resolveWorkspacePath 同时拦截词法越界(../、绝对路径)与符号链接逃逸(realpath 二次校验;mustExist:false 时取存在祖先的 realpath 支持新建);formatWorkspaceError 把 fs 错误码映射为中文提示且<b>绝不暴露 resolve 后的宿主绝对路径</b>;HAJI_ALLOW_OUTSIDE_WORKSPACE=1 显式放行。",
  },

  "packages/plugins/src/bounded-output.ts": {
    desc: "输出截断两基元:takeWholeRecords 按完整记录累加截断(永不把一条路径/源码行切半);truncateSingleLine 把换行压成空格后截断——所有工具 8000 字符输出上限的底层。",
  },

  /* ================= Rust · 原生终端引擎 ================= */
  "packages/cli/native/terminal-engine/src/lib.rs": {
    desc: "Rust NAPI 原生终端引擎 haji_terminal_engine:ANSI 感知的文本折行(wrap_ansi)与选择文档布局(layout_ansi_document)两个接口,正确处理 CSI 序列跨行延续、字素簇、东亚宽字符与零宽字符;平台二进制缺失时 CLI 自动回退 TS 实现。",
    segs: [
      {
        at: "fn ansi_sequence_end",
        title: "NAPI 对象与 CSI 序列解析",
        note: "三个 #[napi(object)] 结构对应两个导出函数的返回形态。ansi_sequence_end 按 CSI 文法(参数字节 0x30-3f、中间字节 0x20-2f、终止字节 0x40-7e)判定转义序列结束位置;update_active_style 只在 'm' 结尾时更新样式(ESC[m 清空、否则累加)——折行后恢复样式的基础。",
        tags: ["Rust", "终端"],
      },
      {
        at: "fn is_wide",
        title: "宽字符与字素测宽",
        note: "is_zero_width 识别 ZWJ/组合附标/变体选择符;is_wide 按 Unicode 区间判 CJK/谚文/全角/emoji 双列宽;grapheme_width 按字素簇聚合(全零宽为 0、含任一宽字符为 2、否则 1);utf16_len 计算 UTF-16 码元数供 JS 侧偏移量使用。",
        tags: ["Rust", "终端"],
      },
      {
        at: "fn wrap_ansi",
        title: "wrap_ansi:主折行算法(#[napi])",
        note: "逐字节扫描:合法 CSI 序列原样写入并更新样式;文本段剔 \\r 后按字素簇迭代,\\n 强制换行,列宽超限时折行;push_wrapped_row 收行时追加 RESET、新行开头重放 active_style,保证跨行样式延续。返回全部行与结束时的 activeStyle(供调用方继续拼接)。",
        tags: ["Rust", "终端"],
      },
      {
        at: "fn layout_ansi_document",
        title: "layout_ansi_document:选区文档布局(#[napi])",
        note: "在 wrap_ansi 基础上同步构建 plain 文本与规范化 document;每行记录 [startOffset, endOffset)(按 UTF-16 码元推进)——终端选区靠它把屏幕行映射回原文偏移。release 构建 thin LTO + strip 追求体积。",
        tags: ["Rust", "终端"],
      },
    ],
  },

  "packages/cli/native/terminal-engine/build.rs": {
    desc: "napi-build 构建脚本(编译期胶水,无自定义逻辑)。",
  },

  "packages/cli/native/terminal-engine/Cargo.toml": {
    desc: "crate 清单:haji_terminal_engine,cdylib(Node 加载的动态库);依赖极简:napi 3(napi8 特性)+ napi-derive 3 + unicode-segmentation 1.12(字素簇切分);release 用 thin LTO、codegen-units=1、strip。",
  },

  "packages/cli/native/terminal-engine/README.md": {
    desc: "原生引擎说明:加速 ANSI wrapping 与 selection layout;HAJI_NATIVE_RENDERER=auto(默认)/on/off 控制模式;pnpm run build:full 构建;/perf 查看当前引擎。",
  },

  /* ================= Tests · 测试 ================= */
  "packages/cli/test/activity-indicator.test.mjs": { desc: "活动指示器测试:七种阶段帧生成、tone 判定(active/waiting/stalled)、脉冲 meter、progress 节流与定时器边界。" },
  "packages/cli/test/agent-manager.test.mjs": { desc: "AgentManager 行为测试:launch 校验、只读并发上限与写独占、abort/超时收尾、verify 三重防伪(旧证据/已消费证据拒绝)、作用域切换与孤儿态收敛、损坏状态文件降级。" },
  "packages/cli/test/agent-wizard.test.mjs": { desc: "agent-wizard.ts 纯函数校验测试:可选整数解析、描述/instructions 校验、提示模板。" },
  "packages/cli/test/cli-runtime.test.mjs": { desc: "cli-runtime 测试:偏好读写容错、formatToolArgs 摘要格式化、版本号回退。" },
  "packages/cli/test/context-compact.test.mjs": { desc: "四层压缩管线测试:token 估算、repairToolCallPairs 配对修复、L1 落盘替换、L2/L3 裁剪占位、L4 摘要与 skill/验证上下文保留、管线编排阈值。" },
  "packages/cli/test/distill-engine.test.mjs": { desc: "提炼引擎测试:六个统计检测器的触发条件、LLM 路径触发阈值与超时、JSON 解析容错、Union-Find 去重。" },
  "packages/cli/test/experience-commands.test.mjs": { desc: "/memory /instinct 命令测试:confirm/add/forget/promote 流程、distill 手动提炼、stats 统计、skill 蒸馏门槛与文件生成。" },
  "packages/cli/test/experience-store.test.mjs": { desc: "ExperienceStore 测试:观测 flush/归档状态机、规则演化(强化/衰减/弃用)、记忆 staging→active、两级目录覆盖、Jaccard 召回。" },
  "packages/cli/test/experiences-prompt-part.test.mjs": { desc: "经验提示词分片测试:召回注入格式、字符预算截断、空库零输出。" },
  "packages/cli/test/fixtures/mock-mcp-server.mjs": { desc: "MCP 测试夹具:最小 stdio JSON-RPC server 实现(initialize/tools/list/tools/call)。" },
  "packages/cli/test/grep-tool.test.mjs": { desc: "grep 工具测试:双引擎结果一致性、literal/regex、分页与截断、上下文行渲染。" },
  "packages/cli/test/hook-engine.test.mjs": { desc: "Hook 引擎测试:四类事件注册/触发、返回字符串中断链、顺序执行。" },
  "packages/cli/test/hub-commands.test.mjs": { desc: "枢纽指令测试:COMMAND_SURFACE 结构、buildHubMenus 动态 Skill 注入、顶层指令表。" },
  "packages/cli/test/input-history.test.mjs": { desc: "输入历史测试:三态浏览(历史/草稿恢复)、非空记录、ClipboardWriter Windows 子进程协议。" },
  "packages/cli/test/main-output-limit.test.mjs": { desc: "主输出上限测试:聊天缓冲 200K 截断、writeChat/updateChatFrom 行为。" },
  "packages/cli/test/markdown-responsive.test.mjs": { desc: "Markdown 响应式渲染测试:宽/窄屏表格与代码块退化、节流器自适应间隔。" },
  "packages/cli/test/mcp.test.mjs": { desc: "MCP 客户端测试(用 mock server):握手/列表/调用、超时、readOnly 权限映射、配置合并、失败降级。" },
  "packages/cli/test/native-terminal-engine.test.mjs": { desc: "原生引擎测试:auto/on/off 模式、加载失败降级、TS 回退与原生结果一致性。" },
  "packages/cli/test/performance-validation.test.mjs": { desc: "性能验证测试:性能监控样本/p95 计算、事件循环直方图、measure 包装。" },
  "packages/cli/test/persistence-performance.test.mjs": { desc: "持久化性能测试:会话去抖合并、幂等检测零 IO、Agent 同步原子写的瞬时错误重试。" },
  "packages/cli/test/plan-mode.test.mjs": { desc: "Plan 模式测试:权限引擎 plan 档只放行只读+任务、提示词分片条件注入、审批流程状态。" },
  "packages/cli/test/production-safety.test.mjs": { desc: "生产安全测试:敏感命令掩码、API Key 不落日志/历史、终端消毒、发布面检查相关约束。" },
  "packages/cli/test/project-info.test.mjs": { desc: "projectinfo 工具测试:语言统计、包管理器推断、指纹缓存失效、Git 摘要。" },
  "packages/cli/test/provider-config.test.mjs": { desc: "provider 配置测试:两级合并覆盖、名称校验、模型列表/窗口解析、Base URL 归一化、连通性测试 mock。" },
  "packages/cli/test/provider-retry.test.mjs": { desc: "Provider 重试测试:isRetryableError 三层判定、Full Jitter 退避、withExponentialBackoff 上限与 onRetry。" },
  "packages/cli/test/resume-history.test.mjs": { desc: "会话恢复测试:列表/加载/回显轨迹、空壳会话清理、标题生成降级。" },
  "packages/cli/test/rewind-flow.test.mjs": { desc: "rewind 流程测试:queueRewindRefill 入队行为与默认确认值。" },
  "packages/cli/test/sensitive-input.test.mjs": { desc: "敏感输入测试:sensitive 掩码模式、/provider set 内联密钥的行内掩码与 Ctrl+U 不写剪贴板。" },
  "packages/cli/test/skill-system.test.mjs": { desc: "Skill 系统测试:扫描/frontmatter 解析、load 幂等与安全声明、资源沙箱(符号链接拒绝/大小限额)、校验器。" },
  "packages/cli/test/snapshot-engine.test.mjs": { desc: "快照引擎测试:锚点/变更记录、回退只撤销自有修改、外部修改 preserve、HEAD 变化拒绝、journal 截断。" },
  "packages/cli/test/subagent-presets.test.mjs": { desc: "预设存储测试:原子写、损坏备份容错、逐字段清洗、补丁合并、应用优先级(命令行>预设)。" },
  "packages/cli/test/subagent.test.mjs": { desc: "SubagentRunner 测试:递归守卫、预算三重约束、畸形工具调用恢复、结果解析容错、UNVERIFIED 标记。" },
  "packages/cli/test/terminal-frame.test.mjs": { desc: "终端帧渲染测试:renderFrame 布局组装、差分输出、滚动区搬移、光标定位。" },
  "packages/cli/test/terminal-layout.test.mjs": { desc: "TUI 布局测试:五档模式映射、面板预算、高度微调、safeWidth。" },
  "packages/cli/test/terminal-protocol.test.mjs": { desc: "VT 输入协议测试:SGR 鼠标解码、括号粘贴重组、拆包 flush、畸形序列丢弃。" },
  "packages/cli/test/terminal-sanitize.test.mjs": { desc: "终端消毒测试:各类 CSI/OSC/DCS 序列剥离、CRLF 归一、中文 emoji 保留、密钥掩码。" },
  "packages/cli/test/text-selection.test.mjs": { desc: "选区模型测试:begin/update/finish、反向拖选归一、selectedText 切片。" },
  "packages/cli/test/theme.test.mjs": { desc: "主题测试:颜色能力探测(Windows 强制 truecolor 等)、两级配置合并、hex 换算、themeReset 行为。" },
  "packages/cli/test/tool-abort.test.mjs": { desc: "工具中止测试:abortSignal 贯穿、bash 进程树清理、中止输出格式([xx已中止])。" },
  "packages/cli/test/tool-batch.test.mjs": { desc: "工具批调度测试:白名单分批、写屏障、并发上限、收益统计。" },
  "packages/cli/test/tool-optimization.test.mjs": { desc: "工具优化测试:并行只读批、输出限幅、进度节流。" },
  "packages/cli/test/tui-layout.test.mjs": { desc: "resolveTuiLayout 集成测试:各尺寸档位的完整布局参数。" },
  "packages/cli/test/turn-lifecycle.test.mjs": { desc: "回合切分测试:splitPendingUserTurn 的 history/pendingTurn 边界。" },

  /* ================= Scripts / 配置 / 文档 ================= */
  "scripts/build-native.mjs": { desc: "原生引擎构建脚本:cargo release 编译 terminal-engine,按平台把产物(.dll/.dylib/.so)复制为 haji_terminal_engine.<platform>-<arch>.node 放进 packages/cli/dist。" },
  "scripts/verify-packages.mjs": { desc: "发布校验(pack:check 的一部分):对三个包 pnpm pack,检查 tarball 不含 /.haji/、/src/、/test/、.tsbuildinfo,cli 包必须含原生 .node,dependencies 不得残留 workspace: 前缀。" },
  "scripts/benchmark-terminal-engine.mjs": { desc: "原生终端引擎基准测试脚本(bench:native):对比 Rust 与 TS 实现的折行/布局性能。" },
  "scripts/profile-startup.mjs": { desc: "启动耗时采集脚本:以 HAJI_STARTUP_PROFILE=1 运行 haji,解析 stderr 的 [startup] 阶段标记。" },
  "scripts/startup-preload.mjs": { desc: "启动预载脚本:配合 profile-startup 减少 Node 模块加载开销的实验入口。" },
  "scripts/coding-plan-usage.mjs": { desc: "coding plan 用量查询脚本(独立小工具)。" },
  "README.md": { desc: "项目主文档:特性总览(流式对话/Plan Mode/可中止工具/会话恢复/Rewind/三并行只读子代理)、环境要求、开发验证(pnpm test / pack:check)、发布流程(五平台原生引擎矩阵编译,按 core→plugins→cli 顺序发布)、11 个斜杠指令表、Provider/网络/主题/MCP/Skill/经验系统全部用户面能力说明。" },
  ".agents/AGENTS.md": { desc: "面向 AI Agent 的项目强制约束:架构事实(cli→core←plugins 依赖方向)、行为红线(禁未授权删改/重构/依赖)、五步工作流、代码风格(中文注释/kebab-case/ESM 顺序)、沟通与 Git 约定——修改本项目代码前必读。" },
  "package.json": { desc: "monorepo 根清单:pnpm 10.22.0 + Node ≥20.18.1;scripts 含 build(tsc --build)、build:native、lint(biome)、test(构建后 node --test)、pack:check(构建+verify-packages);devDependencies 仅 biome/typescript/@types/node。" },
  "pnpm-workspace.yaml": { desc: "pnpm 工作区定义:packages/* 三个包。" },
  "tsconfig.json": { desc: "TypeScript 项目引用(project references)根配置,驱动 tsc --build 的增量编译拓扑。" },
  "biome.json": { desc: "Biome lint/formatter 配置(2 空格缩进、双引号等,与 AGENTS.md 风格约束对应)。" },
  "packages/core/package.json": { desc: "@hajicli/core 包清单:纯 Node 依赖、零第三方运行时依赖,发布只含 dist。" },
  "packages/plugins/package.json": { desc: "@hajicli/plugins 包清单:仅依赖 @hajicli/core 与 undici(网络策略),承载全部工具与 Provider。" },
  "packages/cli/package.json": { desc: "hajicli 包清单(npm 发布名):bin 映射 haji 命令;build:full 串联 tsc 与原生引擎构建;依赖两个 workspace 包,发布时由 CI 替换为正式版本。" },
  ".github/workflows/ci.yml": { desc: "CI 工作流:Linux 上执行构建、lint 与全部测试。" },
  ".github/workflows/release.yml": { desc: "发布工作流:推 v* 标签触发——五平台矩阵编译原生模块,汇总校验后按 core→plugins→cli 顺序发布到 npm。" },
};

/* 分组导览页的架构说明(键名须与 GROUPS 的 name 完全一致;desc 必填,flow 可选) */
export const GROUP_ARCH = {
  "CLI · 终端交互层": {
    desc: "终端交互层:index.ts 解析 argv 与配置后交给 cli-runtime 装配 Provider、引擎与 TUI;主循环里处理按键、输入框、面板渲染与斜杠命令,子代理、计划模式、hook 等用户可见流程都从这层发起。",
    flow: ["index.ts 启动", "cli-runtime 装配", "TUI 主循环", "斜杠命令 / 子代理", "输出渲染"],
  },
  "Core · 引擎内核": {
    desc: "引擎内核:管理消息轮回(Turn 生命周期)、流式输出、工具批量执行与中止、上下文压缩与快照/回溯。它是 CLI 与 Plugins 之间的中枢,不直接依赖终端 UI。",
    flow: ["Turn 生命周期", "工具执行(批量/中止)", "上下文压缩", "快照与回溯"],
  },
  "Plugins · 工具与模型接入": {
    desc: "工具与模型接入层:内置工具(bash/文件/grep/web 等)的实现与参数校验、多 Provider 适配(OpenAI 兼容/Anthropic/Ollama),以及 MCP 外部工具桥接。",
    flow: ["工具实现与校验", "Provider 适配", "MCP 桥接"],
  },
  "Rust · 原生终端引擎": {
    desc: "Rust 原生模块:terminal-engine 通过 napi 向 Node 侧暴露高性能终端能力(帧渲染/尺寸/事件),供 TUI 渲染引擎调用。",
    flow: ["Rust 实现", "napi 绑定", "Node 侧调用"],
  },
  "Tests · 测试": {
    desc: "node:test 测试套件:覆盖 CLI 行为、Core 引擎、插件工具的主要路径与回归场景,附 fixtures 场景与性能/安全校验,pnpm test 一键跑全量。",
    flow: ["单元 / 集成用例", "fixtures 场景", "性能与安全校验"],
  },
  "Scripts · 构建脚本": {
    desc: "构建与发布脚本:原生模块编译、类型检查、打包发布等流水线胶水代码。",
  },
  "配置与文档": {
    desc: "仓库级配置与文档:workspace 清单、TypeScript/Biome/lint 配置、CI 与发布工作流、README 入口。",
  },
};
