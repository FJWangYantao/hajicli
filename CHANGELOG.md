# 更新记录

## 1.6.0（2026-10-30）

### 新功能

- **PR 巡检（Patrol）**：自动接管**已登记来源**的 agent PR —— 独立审查、退回修改、争议升级最终裁决、
  合并门禁、合并或有理由地终止，全程没有人工裁决节点。`haji/` 分支默认自动接管，也可按 label、
  本人提交（需显式开启）或 `/patrol register <PR> --task <id> --brief <任务>` 指定；
  未登记的 PR 不取得写入与合并资格，PR 正文不参与来源判定。合并前还要过一遍程序侧确定性检查
  （非草稿、无冲突、`head` 与结论版本一致、必需 CI 全绿且来源可信、未被暂停、预算未耗尽）。
  三种跑法：`/patrol run-once` 单轮（配 cron）、侧栏「PR 巡检」常驻（显示当前阶段与已耗时）、
  `scripts/patrol-daemon.mjs` 由 `systemd --user` 托管（心跳写 `.haji/patrol/daemon.json`，
  haji 侧栏据此只读状态、不再重复联网）。`/patrol watch <url>` 接入 webhook 唤醒通道，
  GitHub 事件到达即复查；轮询始终兜底，通道故障不影响巡检。
  预算上限（修改轮次 / 裁决轮次 / 费用 / 时长）命中即终止并记录原因，每次运行落盘
  `.haji/patrol/runs/<jobId>/<runId>.log`。
- **用户 Hooks**：`~/.haji/hooks.json` / `.haji/hooks.json` 配置 `PreToolUse`、`PostToolUse`、
  `UserPromptSubmit`、`Stop` 四个时机的 shell 命令。退出码 2 时 `PreToolUse` 拦下工具调用（原因回给模型）、
  `PostToolUse` 把 stderr 回注；`UserPromptSubmit` 的 stdout 作补充上下文。Hook 只能拦、不能替用户放行。
  项目级 hooks 必须经 `/hooks trust` 按内容哈希信任后才执行（CI 用 `HAJI_TRUST_PROJECT_HOOKS=1`）。
- **自定义斜杠命令**：`.haji/commands/<名称>.md` 写提示词模板（`$ARGUMENTS`、`$1`…`$9`），
  `/<名称> 参数` 展开发送；进补全，`haji -p "/review …"` 与 mcp-serve 同样可用。
- **驱动进程 `haji mcp-serve`**：把 haji 当成 MCP 工具给外部 Agent 用（`haji_send` / `wait` / `events` /
  `adjust` / `approve` / `cancel` / `status`）；授权卡与计划审批走 `selection_request` 事件。
  接入文档与最小客户端在 `examples/`。
- **无人值守硬上限**：`-p` 与 `mcp-serve` 支持 `--max-cost <元>`、`--max-turns <n>`，命中即停，
  结果带 `stopReason`。
- **无头模式 `--allow <键>`**：预放行已知安全的命令（如 `--allow "bash:npm test"`），只对本次进程生效。
- **会话**：`/fork` 复制当前对话为新会话；`/reload` 保存后原位重启（保留 PID 与前台进程组）。
- **输入**：`@` 引用支持中文与带空格的路径；`Alt+A` 管理附件、`Alt+Q` 管理待发送消息；
  回合进行中可把排队消息提升为当前回合的补充指令（steer）；模型可向用户提问，长列表支持搜索。
- **渠道单价**：同名模型走 CN 中转 / 自建代理时可按 `<渠道>/<模型>` 单独定价，不再按官方价估算；
  `scripts/token-breakdown.mjs` 按主线 / 标题 / 压缩 / 提炼拆解 token 去向。

### 行为变化

- `haji -p` 回合失败（模型请求失败、被中止、触发硬上限、会话落盘失败）时**退出码为 1**，
  此前一律为 0。CI 脚本若依赖旧行为需要调整。
- `haji mcp-serve --approval ask` 下授权卡 5 分钟无人回复**按拒绝处理**（此前会回落到默认放行）；
  拒绝与计划修改意见经 `haji_approve.reason` 回传给模型。
- `/cost` 计入子代理、上下文压缩、会话标题、经验提炼、Auto 权限判定与后台查价的模型调用，
  总额会比旧版本高（旧版本偏低）。

### 修复

- 编辑后验证发现问题时，诊断消息被插在工具调用与结果之间，下一轮把真实的编辑回执换成了
  「工具执行状态未知」；现在回注排在工具结果之后。
- 会话恢复：同 id 多副本取最新有效副本，加载前校验消息结构；断流 / 提前 EOF 时保留已收到的内容，
  执行工具前与每批结果后落盘，强退后恢复不会重复执行写操作。
- 会话保存加锁并校验基线，多进程同时写同一会话时报冲突而不是静默覆盖。
- mcp-serve：`haji_send` 返回的游标改为回合开始前，不再错过回包前就发出的授权卡。

### 开发者

- `index.ts` 拆出 `serve-mode.ts`、`permission-commands.ts`、`extension-commands.ts`；
  `terminal-input.ts` 拆出 `frame-compose.ts`、`selection-picker.ts` 等无状态模块，`renderFrame` 按阶段拆分。
- 新增包 `@hajicli/patrol-github`：GitHub 适配器只依赖 `fetch` 与 core 的 `PatrolForgeAdapter` 契约，
  不含 CLI / TUI 依赖；巡检协议、状态机、预算、合并门禁与存储放在 `core/src/patrol/`，
  CLI 侧的编排、runner、唤醒通道与守护进程心跳各自成模块。新增 GitLab / Gitea 等平台按同一契约另开包即可。
- `scripts/ab-run.mjs` 修正 `-p` JSON 结果解析（此前每次运行都记成失败）。

## 1.5.0（2026-10-28）

1.4.0 之后的第一次版本号同步，覆盖此前累积的全部改动。

### 新功能

- **启动首页重做**：像素 Logo + 光晕 + 星点，启动动效约 1.8 秒后静止（`HAJI_REDUCED_MOTION=1` 关闭）；
  输入卡片、三张入口卡片、会话时间线，空间不够时按固定顺序让步。
  「继续上次」下面一行说明上次停在哪：目标 · 任务进度 · 正在做的那一项。
- **会话目标**：模型用 `setgoal` / `goalfinish` 自动提炼、推进与收尾，侧栏显示进行中的目标。
- **自动 git worktree**：每个新会话可开独立工作树并行；`/resume` 能发现兄弟工作树的会话，
  `/worktree remove` 归档的会话也会出现在列表里（标「已归档」，选中后取回到当前目录继续）。
- **联网检索**：有 DeepSeek key 时优先走官方 Search（失败静默回落公开源）；
  `webfetch` 改为零依赖 HTML → Markdown。
- **费用**：费用日志 / 回合详情 / 请求详情三层页面；DeepSeek 内置单价与峰谷时段同步官方；
  官方检索按次计费（2026-11-01 起 ¥0.005/次）计入 `/cost` 与侧栏。
- **工具展示**：过程段折叠 + 单个工具块二级折叠（点击展开/收起，`/resume` 回放同样可用）；
  write/edit 完成块显示红绿 diff；聊天流内联图片与 `/view`。
- **外观**：浅色终端改近黑正文，`/appearance light|dark` 持久化；ansi256 量化改 Oklab 最近色。
- **Kero 集成**：自报 working / waiting / idle 状态（OSC 7501）与窗口标题（OSC 2）。

### 行为改进

- 编辑后自动验证：只在发现问题时回注诊断；bash 里 `sed -i`、重定向、`tee` 写源码同样触发。
- 经验召回改随用户消息注入，打分改双字分词 + IDF + 分数下限。
- `read`：截断时附剩余符号提纲（默认开启），批量读取按头部开销分配额度、不再整块丢文件；
  新增 `symbol` 参数按名字取定义块（实验中，默认关闭）。
- 工具调用合并：`grep.queries` / `global.patterns` 一次调用覆盖多个目标。
- 斜杠补全候选按终端高度分档，浮层移到输入框外；「回到底部」浮标可点击。
- 流式渲染加前缀行缓存与代码高亮缓存，单帧成本与新增内容成正比。

### 修复

- 中止回合时工具格不再凭空消失；失败或被拒的子代理不再堵死 `taskfinish`。
- 构建后给 bin 入口补执行位，clean 重建后 `haji` 不再报 Permission denied。
- 图片段与选区行号对齐，复制不再错位。

### 开发者

- `index.ts` / `terminal-input.ts` 拆出 `pricing-commands.ts`、`overlay-navigation.ts`、
  `terminal-keys.ts`、`terminal-menu.ts` 与 `PostEditVerifier`；鼠标与帧渲染按阶段拆成小方法。
- `node scripts/ab-run.mjs` 一键跑 A/B（固定任务 × 轮次 × arm 交替），实验记录见 `design/ab/`。
