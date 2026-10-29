# HAJI CLI

HAJI CLI 是一个面向本地代码工作的终端 AI 助手，支持流式对话、Plan Mode、可中止工具、会话恢复、Rewind 和最多三个并行只读子代理。

运行中按 `Esc` 会立即停止 spinner 和新 token 渲染，并在后台完成网络或工具进程清理；已经生成的部分回复会保留。若承载本轮 prompt 的主 Provider 请求尚未真正发出，本轮 prompt 不会写入会话，而是自动收回输入框供修改后重发；自动压缩也不会提前提交它。

## 环境要求

- Node.js 20.18.1 或更高版本
- 包管理器 pnpm 10.22.0（版本以仓库根 `packageManager` 字段为准）
- Windows Terminal 为主要支持终端；核心构建和测试也在 Linux CI 中执行
- Rust 工具链（可选）：编译原生终端渲染引擎。未安装或不编译时自动回退内置 JS 实现，功能与测试不受影响

## 外观与配色

界面不绘制整屏底色，背景沿用终端自身的默认背景（与 pi 等 agent 一致），因此深色/浅色终端里都能自然融合。

启动时会按以下顺序确定用深色还是浅色调色板：

1. 环境变量 `HAJI_THEME_APPEARANCE=dark|light`（显式覆盖，优先级最高）
2. `~/.haji/theme.json` 里记住的 `appearance`（`/appearance light|dark` 写入）
3. `COLORFGBG`（部分终端会设置）
4. OSC 11 查询终端默认背景色，并按相对亮度判定（最多等 120ms，超时回退深色）

白底 / 浅底终端里如果觉得字偏灰、对比度不够，执行一次 `/appearance light` 即可：它会切到
「近黑正文」的浅色调色板（正文 `#111111`、次要文字 `#3a3a3a`）并写进 `~/.haji/theme.json`，
之后每次启动都跳过自动探测直接沿用。`/appearance` 无参显示当前外观。

想强制使用固定底色（恢复旧行为）时，在 `~/.haji/theme.json` 或 `<项目>/.haji/theme.json` 里写 `{"background": "#101318"}`；写成 `""` 则表示继续跟随终端背景。其余颜色字段仍只接受 `#RRGGBB`。

自定义颜色会做可读性兜底：正文/弱化文本要求相对参考背景至少 4.5:1，强调色与语义色至少 3:1（WCAG AA），不达标时只调向黑/白到刚好达标，不改色相。参考背景优先用主题声明的 `background`，为 `""` 时按终端外观取纯黑/纯白。内置两套调色板本身已达阈值，因此默认外观不会被改动。

## 开发验证

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm pack:check
```

`pack:check` 会构建全部包（含原生模块，需要 Rust），并拒绝包含 `.haji`、源码、测试或 `workspace:` 依赖的发布包。

包结构、子系统工程导览见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 安装与发布

发布到 npm 后，用户无需克隆仓库即可使用：

```powershell
npm i -g hajicli
haji
```

发布包内置 win32-x64、linux-x64、linux-arm64、darwin-x64、darwin-arm64 五个平台的原生终端引擎；未覆盖的平台（如 Alpine musl）自动回退内置 JS 实现，功能不受影响。

发布流程（维护者）：

1. 一次性准备：注册 npm 账号，生成 **Automation** 类型的 Access Token，存入仓库 Settings → Secrets and variables → Actions → `NPM_TOKEN`
2. 更新 `packages/*/package.json` 的 `version` 并提交
3. 推送 `v*` 标签触发 [release 工作流](.github/workflows/release.yml)：GitHub Actions 矩阵编译五个平台的原生模块，汇总校验通过后按依赖顺序发布 `@hajicli/core`、`@hajicli/plugins`、`hajicli`

```powershell
git tag v1.0.0
git push origin v1.0.0
```

## 斜杠指令

会话内按 `/` 列出 17 个顶层指令：4 个枢纽把低频的配置与管理入口收纳进二级菜单，高频动作（含 `/model`）直接保留在顶层。进入枢纽后用方向键选择细分项，选中后立即执行。

| 枢纽 | 细分项 |
|---|---|
| `/config` 模型与配置 | `/permission`、`/workspace`、`/worktree`、`/hooks`、`/provider`、`/effort`、`/theme`、`/appearance`、`/sidebar`、`/fold`、`/think` |
| `/agents` 子代理管理 | `/agents new`、`/agents presets`（旧 `/subagent`、`/preset`、`/agent` 仍可用） |
| `/memory` 经验系统 | `/memory list`、`/memory rules`（`/instinct` 系列经别名转入） |
| `/diag` 诊断与观测 | `/perf`、`/cost`、`/diff`、`/output`、`/doctor`、`/viewer`、`/mcp` |

顶层直接保留：`/help`、`/reload`、`/model`、`/skills`、`/compact`、`/image`、`/view`、`/clear`、`/resume`、`/fork`、`/undo`、`/rewind`、`/exit`。`haji --help` 与会话内 `/help` 均从同一份指令表生成，列出完整的枢纽与成员对应关系。`/effort` 与 `/model` 的思考强度轴重复，收纳在 `/config` 下但仍可直接输入或补全。

会话相关的几条常用指令：

- `/reload`：保存当前会话后原地重启进程（保留 PID 与终端前台进程组），用于加载更新或重新构建后的 haji。
- `/fork`：把当前对话复制成新会话并切过去，源会话文件保持原样；之后的快照、任务、子代理都记在新会话下。
- `/undo` / `/rewind`：撤销上一轮（消息 + 代码）或在历史节点里挑一个点回退；回退后对话区会重放恢复出的历史。

补全规则：

- 继续输入字母后会模糊搜索**全部**指令、子命令与可手动调用的 Skill，不必记住指令在哪个枢纽下：`/mo` → `/model`，`/perm` → `/permission`，`/reload` → `/skills reload`，`/rev` → `/skill review`。非顶层候选会在说明后标注所属枢纽。
- 指令后敲空格列出它的子命令（如 `/provider ` → `add` / `set` / `unset`）；已输入参数时显示参数格式提示（如 `/memory confirm <id>`）。
- `Tab` 只补全不执行；`Enter` 执行选中项，需要必填参数的指令（如 `/memory confirm`）只填入并等待输入参数。输入已是完整指令时，`Enter` 直接执行输入本身。
- 输错指令时会提示最接近的指令（如 `/mdoel` → “你是不是想输入 /model？”）。
- 指令不会作为用户消息气泡显示，只在对话区留一行灰色回显；经枢纽菜单执行的指令合并为一行（如 `› /config › /provider`）。

运行中的反馈：

- 状态栏显示权限档次（计划 / 默认 / 自动编辑 / 自动 / 全放行）、模型与思考强度、工作区（家目录缩写为 `~`）和当前 git 分支。
- 思考与生成进度统一以 tokens 计；每轮结束后显示一行小结：耗时、模型输出 tokens 与工具调用次数。
- 工具结果按类型给出摘要（编辑显示 `+新增 −删除` 行数，写入显示大小与行数，命令失败时优先显示首个报错行）。
- 一轮里的工具调用与思考默认收成一行 `● 读取 4 个文件，搜索 2 次 · 思考 3 次`，正文始终可见；点击该行或按 `Ctrl+O` 展开 / 收起，`/fold off` 关闭折叠。完整工具输出用 `/output` 查看。

## 模型配置

```powershell
$env:DEEPSEEK_API_KEY = '...'
# 或
$env:VOLC_API_KEY = '...'
```

也可以在 haji 会话内用 `/provider` 指令快速配置，无需设置环境变量：

- `/provider`：查看全部提供商（内置 + 自定义）的配置状态、当前模型及各字段来源（环境变量 / 全局 / 项目级）
- `/provider add [--project]`：**引导添加自定义提供商**——依次输入 Provider 名称、Base URL、API Key、模型名称（多个用分号分隔，如 `gpt-4o;gpt-4o-mini`），输入完成后自动发起连通性测试（最小请求验证 Base URL + API Key + 模型三者有效）；测试失败会显示原因，输入 `r` 重新进入引导流程或 `c` 取消。默认保存到用户全局配置，附加 `--project` 时仅保存到当前项目
- `/provider <name>`：立即切换到指定提供商（内置 `deepseek` / `volcengine` 或自定义名称）
- `/provider set <name> [--project]`：通过遮罩输入框安全配置 API Key，再设置 Base URL、默认模型与模型列表；默认保存到用户全局配置，附加 `--project` 时保存到当前项目
- `/provider unset <name> [--project]`：默认清除用户全局配置，附加 `--project` 时仅清除当前项目配置

自定义提供商需提供 OpenAI 兼容的 `POST {baseUrl}/chat/completions` 端点（如 OpenAI、Moonshot、本地 vLLM/Ollama 网关等）；`/subagent` 的 `--provider` 也支持自定义名称。

配置默认保存到 `~/.haji/config.json`（用户全局，跨项目共用），使用 `--project` 时保存到 `.haji/config.json`（项目级）。项目级覆盖用户全局；环境变量优先级始终最高（环境变量 > 项目级 > 用户全局 > 内置默认值）。API Key 为明文存储，`.haji/` 已被 git 忽略，请勿共享该文件。

## 网络代理与超时

HAJI 支持标准的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`，也支持以下专用变量：

- `HAJI_PROXY`：同时用于 HTTP 和 HTTPS
- `HAJI_HTTP_PROXY` / `HAJI_HTTPS_PROXY`：分别配置代理
- `HAJI_NO_PROXY`：配置不走代理的主机
- `HAJI_HTTP_TIMEOUT_MS`：网页请求（搜索、抓取、连通性测试等）的完整超时，默认 60000，允许 1000 至 600000
- `HAJI_MODEL_TIMEOUT_MS`：模型请求（chat/completions）的完整超时，默认 300000（5 分钟），允许 1000 至 600000；reasoning 模型长生成时需要比网页请求更宽松的超时
- `HAJI_CONNECT_TIMEOUT_MS`：连接建立阶段超时，默认 20000；代理未运行或上游不可达时快速失败，而不是干等完整超时

连接失败（代理未运行、DNS 解析失败等）会立即报出可操作的错误（如"无法连接目标服务（ECONNREFUSED）"），响应头未在时限内返回时则报告"请求在 Xms 内未完成"。

## 界面主题

HAJI 的 TUI 界面（背景、前景、边框、Logo 与 Markdown 配色）默认使用内置深色主题。输出会按终端能力自动降级为 24-bit 真彩色、256 色、16 色或无色；设置 `NO_COLOR`、使用 `TERM=dumb`、或将输出重定向到非 TTY 时会采用无色文本。像素风 Logo 由块字符绘制，退出界面时自动恢复终端默认外观。

主题支持两级配置，项目级覆盖用户级同名字段：

- 用户级：`%USERPROFILE%\.haji\theme.json`
- 项目级：`<workspace>\.haji\theme.json`

```json
{
  "background": "#101318",
  "userMsgBg": "#171b22",
  "foreground": "#d9dee7",
  "accent": "#a995d6",
  "muted": "#8f98a5",
  "red": "#e07a7a",
  "green": "#78b892",
  "yellow": "#d6a85f",
  "blue": "#82aadd",
  "magenta": "#b8a1df",
  "cyan": "#7dcfff",
  "brightGreen": "#91c7a6",
  "brightYellow": "#e2bb78",
  "brightBlue": "#9ab8e6",
  "brightCyan": "#9edcff"
}
```

所有字段均为 `#RRGGBB` 格式，缺省字段回退到内置默认值；非法值会被忽略。`.haji/` 已被 git 忽略，主题文件不会进入版本库。

## MCP 外部工具

HAJI 可接入任意 MCP（Model Context Protocol）server，把其工具作为 `mcp_<server>_<tool>` 暴露给模型。MVP 支持 stdio 传输（npx/uvx 启动的本地 server），在 `.haji/config.json`（用户级 `~/.haji/` 跨项目，或项目级）中配置：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "readOnly": true
    }
  }
}
```

字段说明：`env` 附加环境变量；`readOnly: true` 将该 server 全部工具视为只读（任何权限模式自动放行）；未标记的按修改型工具走权限审批（default/accept-edit 模式需人工确认）；`enabled: false` 临时禁用；`callTimeoutMs` 调用超时（默认 120s）。两级配置同名 server 时项目级覆盖用户级。

- `/mcp`：查看各 server 状态（running/failed/disabled）、挂载的工具与失败原因
- 启动时并行连接，单个 server 失败不影响其余与 CLI 本身；MCP 工具失败输出与内置工具同格式（`错误:` 前缀），会被经验系统纳入失败观测

## 用户 Hooks

在工具调用前后、提交消息时、退出时跑自己的命令（格式化、拦危险操作、补上下文、发通知）。配置在
`~/.haji/hooks.json`（用户级，直接生效）或项目 `.haji/hooks.json`：

```json
{
  "PreToolUse": [{ "matcher": "bash", "command": "./scripts/guard.sh", "timeoutMs": 10000 }],
  "PostToolUse": [{ "matcher": "write|edit", "command": "npx prettier --write \"$HAJI_TOOL_PATH\"" }],
  "UserPromptSubmit": [{ "command": "git status --short" }],
  "Stop": [{ "command": "notify-send haji 回合结束" }]
}
```

| 事件 | 退出码 0 | 退出码 2 | 其他非 0 / 超时 |
|---|---|---|---|
| `PreToolUse` | 照常走权限判定 | **拦下这次调用**，stderr 作为原因回给模型 | 告警，不拦截 |
| `PostToolUse` | 无事 | stderr 作为反馈回注给模型（排在工具结果之后） | 告警 |
| `UserPromptSubmit` | stdout 作为补充上下文注入本轮 | — | 告警 |
| `Stop` | 无事 | — | 告警 |

- `matcher` 是工具名正则（整名匹配、不分大小写），缺省或 `*` 匹配全部；只对工具类事件有意义。
  默认超时 30 秒。Hook 只能拦，**不能替用户放行**——放行仍走权限档与授权卡。
- 命令经系统 shell 执行，stdin 收到上下文 JSON（`event`、`toolName`、`args`、`toolOutput`、`prompt`、
  `sessionId`、`cwd`），另有环境变量 `HAJI_HOOK_EVENT`、`HAJI_TOOL_NAME`、`HAJI_TOOL_PATH`（`args.path`
  的绝对路径）、`HAJI_PROJECT_DIR`、`HAJI_SESSION_ID`。工具被权限或 Hook 拦下时不跑 `PostToolUse`。
- **项目级 hooks 默认不执行**：它可能随仓库克隆而来。`/hooks trust` 先列出每条命令，确认后按文件内容
  哈希记到 `~/.haji/hooks-trust.json`，文件一改就要重新信任；CI 里可设 `HAJI_TRUST_PROJECT_HOOKS=1`。
- `/hooks` 查看生效情况与配置错误，`/hooks reload` 重新读取。`hooks.json` 与信任表属于受保护目标，
  模型改写它们必须逐次确认。

## 驱动进程：`haji mcp-serve`

把 haji 变成常驻的**驱动进程**：挂在 stdio 上按 MCP 协议对外提供「派活 + 跟进 + 调整」的工具面，供外部 Agent（Hermes 等）或任意 MCP 客户端调用。与上一节的「MCP 外部工具」方向相反——那里是 haji 调别人的工具，这里是别人把 haji 当工具用。

```bash
haji mcp-serve [--cwd <目录>] [--approval ask|auto] [--wait-ms <毫秒>]
```

- `--cwd`：切换工作目录（默认沿用启动目录，含自动 worktree 的结果）。
- `--approval ask|auto`：需要授权时的策略。`ask`（默认）把选择卡发成 `selection_request` 事件挂起，等客户端调 `haji_approve`，5 分钟没回复**按拒绝处理**（事件里的 `default` 就是兜底值）；`auto` 只替客户端放行普通授权（仅本次），受保护目标（授权配置、凭据等）、加工作区根、临时提权一律拒绝，Plan 审批批准后切到 [默认] 而不是 [自动]。
- `--wait-ms`：单次 `haji_send` 的默认等待时长，默认 25000，上限 600000。

工具面（MCP `tools/list`）：

| 工具 | 作用 |
|---|---|
| `haji_status` | 会话 id/标题、模型、思考强度、权限档、工作目录、是否在跑回合、上下文消息数与本会话费用 |
| `haji_send` | 派一个完整回合（读代码、改文件、跑命令）；超时返回 `running` + `taskId` |
| `haji_wait` | 阻塞等下一个关键进度（工具结束 / 需要授权 / 回合结束），比轮询省调用 |
| `haji_events` | 按 `sinceSeq` 增量拉事件（正文增量、`tool_start`/`tool_end`、`selection_request`、`turn_end`） |
| `haji_adjust` | 改模型、思考强度、权限档、思维链显示、Plan 模式（下个回合生效） |
| `haji_cancel` | 中止正在执行的回合（等价于 Esc） |
| `haji_approve` | 回复一条 `selection_request`；`value` 必须是卡片里的选项，选「拒绝并说明」或「修改计划」时用 `reason` 带上理由（回传给模型） |

接入配置（Hermes 等）、推荐的调用顺序和一个可直接运行的最小客户端见 [examples/README.md](examples/README.md)。

协议细节：stdin 每行一条 JSON-RPC 消息，stdout **只**写协议回包（Logo、进度、诊断信息都不会混进去，`--output-format` 之类的交互输出全部走事件流）；长回合不阻塞其他请求，`haji_cancel` / `haji_status` 随时可处理。stdin 关闭或收到 `SIGINT`/`SIGTERM` 时正常退出。

## 并行工具批与 A/B 实验

同一条模型回复里，**连续的只读调用**会并行执行（默认最多 5 个）；`edit` / `write` / 写型 `bash` / `subagent` / `task*` 仍然是串行屏障。只读 bash 与只读 MCP 是否加入并行白名单由实验开关控制。

- `HAJI_AB=1`：按 trace session 稳定五五分流，跑对照组 / 实验组。
- `HAJI_EXPERIMENTS="all=control"`：强制全部走旧行为；也可单项覆盖，如 `parallel_prompt=control`。
- `HAJI_MAX_PARALLEL_TOOLS=1..8`：覆盖并行上限（默认 5）。
- `pnpm ab:report`：汇总 `~/.haji/traces` 与 `.haji/traces` 里的 `experiment_assignment` / `tool_batch` / `subagent_launch`，按 arm 对比批次数、并行率、平均批大小、节省时间与子代理启动数。

## 并行开发：自动 worktree

在 git 仓库里启用后，每次启动 haji（新会话）都会自动创建一个独立工作树并在其中运行，多个进程可以同时改同一个仓库而互不干扰：

- `/worktree on|off`：开关（写入主仓库 `.haji/config.json`，下次启动生效）；`/worktree` 查看当前状态与存放目录
- `/worktree list`：列出 haji 创建的工作树；`/worktree remove [--force] <名称|路径>` 清理（会话与快照会先归档到主仓库 `.haji/worktree-archive/`）
- 启动参数 `--worktree` / `--no-worktree` 可临时覆盖；`-c` / `-r` 恢复会话不新建
- 新工作树默认在 `~/.haji/worktrees/<仓库名>-<指纹>/<会话名>`，分支为 `haji/<会话名>`；项目配置与未跟踪的 `.env` 会一并带过去，`node_modules` 需要自行安装
- 配置项：`.haji/config.json` 的 `worktree` 字段，支持 `true` / `false` 或 `{ "enabled": true, "root": "~/wt/{repo}/{name}", "copy": [".env.local"] }`
- 已经在 worktree 里启动、或仓库还没有提交时会跳过，避免嵌套工作树

## 安全边界

文件读取、写入、编辑和检索的作用域是「工作区根」：启动目录，加上 `--add-dir <目录>`（本次进程）与 `/workspace add <目录>`（持久化到 `~/.haji/workspaces.json`，按项目分组）追加的目录。路径判定会解析符号链接：目标不存在时按最近的已存在上级目录判断，因此 `../`、绝对路径和指向外部的符号链接都绕不过去。

工作区外的读写不再由工具直接拒绝，而是交给权限层：

- `default` / `accept-edit` / `auto` 档都会弹出授权卡，可以「允许本次」「本会话内总是允许该目录」或「永久允许该目录」（路径授权只写用户级 `permissions.json`，不会写进项目）；
- `plan` 档的越界读取同样需要授权，越界写入按计划模式拦截；
- `bypass-permissions` 与 `HAJI_ALLOW_OUTSIDE_WORKSPACE=1` 跳过授权（后者供可信会话临时使用）；
- 无头模式（`haji -p`）回合成功退出码为 0；模型请求失败或回合被中止时退出码为 1（`--output-format json` 的 `ok` 同为 `false`），CI 可直接据此判失败。
- 无头模式没有人可确认，越界调用会被拒绝，除非命中用户级路径规则、命令行 `--allow` 预放行或设置了上面的环境变量。
  无头 / CI 场景用 `--allow "bash:npm test"`（键形态与 `permissions.json` 的 `key` 一致，可重复）把已知安全的验证命令预先放行，只对本次进程生效、不写盘。

路径规则写在用户级 `~/.haji/permissions.json` 的 `paths` 段，`deny` 优先于 `allow`；项目级文件的 `paths` 段不会生效，避免克隆仓库自带扩权配置：

```json
{
  "version": 1,
  "allow": [],
  "paths": { "allow": ["~/scratch/**"], "deny": ["**/.ssh/**"] }
}
```

对应命令：`/workspace`（查看根与规则）、`/workspace add|remove <目录>`、`/workspace allow|deny <glob>`、`/workspace rules`（删除规则）。经文件工具授权写入工作区外的文件同样进入快照日志，`/rewind` 与 `/diff` 能回退和查看；bash 命令造成的工作区外改动不在快照范围内。路径规则只作用于文件工具；bash 命令仍按只读判定与授权流程处理（`--add-dir` 的目录内相对路径可被判定为只读）。

`default` 与 `accept-edit` 模式下，可静态确认为只读的命令无需审批：`ls`、`pwd`、`cat`/`head`/`tail`/`wc`、`rg`、`git status|diff|log|show|blame|rev-parse|ls-files`、只列出分支的 `git branch` 以及对应的 PowerShell 查询命令。含命令组合、重定向、变量展开或替换的命令，以及指向工作区外（绝对路径、`~`、`..`、经符号链接逃逸）的路径参数一律仍需审批。授权卡片中的“本会话内总是允许”按命令前缀生效（如 `npm test`、`git commit`），不会一次放行全部命令；无法按前缀安全匹配的组合命令只提供单次允许。

不要在不可信项目中使用 `bypass-permissions`。会话、Trace、快照和计划数据位于 `.haji`，发布包不会包含这些运行时数据。

## Skill 系统

HAJI 使用两级加载：启动时只把精简目录交给模型，任务匹配时再通过只读的 `loadskill` 工具加载完整 `SKILL.md`。

Skill 来源按以下优先级覆盖：

- 用户级：`%USERPROFILE%/.haji/skills/<name>/SKILL.md`
- 项目级：`<workspace>/.haji/skills/<name>/SKILL.md`

```md
---
name: code-review
description: 审查代码正确性和回归风险
when_to_use: 用户要求审查代码、Diff 或 PR 时
user-invocable: true
---

# Review workflow

检查 Diff，只报告有证据支持的问题。
```

交互命令：

- `/skills`：查看可用和已加载的 Skill。
- `/skills reload`：重新扫描两个 Skill 目录。
- `/skills validate`：校验 Skill 清单、附属资源、大小限制和路径安全。
- `/skill code-review`：确定性加载 Skill。
- `/skill code-review 审查当前 diff`：加载后立即继续执行参数中的任务。

Skill 可以在自身目录中提供 `references/`、`scripts/`、`assets/` 等附属资源。模型必须先调用 `loadskill`，再使用只读的 `listskillresources` 和 `readskillresource` 按相对路径访问；普通文本资源最大 256 KiB，Asset 最大 10 MiB，单个 Skill 最多枚举 256 个资源。二进制 Asset 只能被枚举，不能作为文本注入上下文。

上述三个 Skill 工具在 Plan Mode 中仍是只读工具。Skill 不能提升权限，也不能覆盖用户指令、`AGENTS.md` 或安全规则。Skill 名称不能是文件路径，`SKILL.md` 最大 64 KiB，并拒绝路径穿越和符号链接资源。`scripts/` 中的脚本只会作为文本读取，不会由 Skill 工具直接执行。

## 经验系统（自学习记忆）

HAJI 内置一套跨会话的自学习闭环，在日常使用中观察工具调用、提炼行为规则、积累项目知识，下次会话自动应用，目标是降低重复出错率。该系统由三部分组成，全部在内核运行，不依赖外部脚本或服务：

- **行为观测层**：`PostToolUse` Hook 捕获每次工具调用（含失败样本），追加到 `.haji/observations.jsonl`；主客观测与子代理观测都会被记录。
- **模式提炼层**：会话结束时自动运行双路径提炼——
  - *统计路径*（零 token）：检测高频模式，如「Edit 前缺 Read」「同命令失败后重试」「同 tool 同错误聚集≥3次」等 6 类。
  - *LLM 路径*（智能触发）：仅当本会话出现过失败调用或新增观测≥20 条时，才调用当前 provider 做语义分析，产出更深层规则与记忆候选。
- **记忆注入层**：高置信度规则与已确认记忆作为 system prompt 常驻分片（priority 46），每轮对话自动注入。召回以最近一条用户消息 + 项目名为 query 做关键词匹配，使注入内容跟随当前任务；会话初始无消息时回落到固定领域词表。

存储布局（两级，项目级覆盖用户级同名条目）：

- `.haji/observations.jsonl`：观测流，超 5MB/8000 行按月归档，主文件保留 30 天
- `.haji/instincts/<domain>__<id>.md`：行为规则，frontmatter 含 confidence/domain/source/observedAt
- `.haji/memory/active/<type>__<id>.md`：已确认记忆
- `.haji/memory/staging/<type>__<id>.md`：LLM 提取的记忆候选，需用户确认后转为 active
- 用户级目录：`%USERPROFILE%/.haji/instincts/`、`%USERPROFILE%/.haji/memory/`

置信度演化：规则首现时 confidence=0.5，重复观测 +0.05（上限 0.9），90 天未触发 -0.05，低于 0.55 标记 deprecated。只有 confidence ≥ 0.7 的规则才会被注入。

交互命令：

- `/memory`：列出 active 与 staging 记忆（标注 `[用户级]`/`[项目级]` 作用域）
- `/memory confirm <id>`：确认 staging 记忆为 active（`user` 类型确认后进用户级，跨项目生效；其余进项目级）
- `/memory add <user|project|feedback> <内容>`：手工添加记忆（`user` 写用户级，跨项目共用；其余写项目级）
- `/memory forget <id>`：删除记忆
- `/memory promote <id>`：把项目级记忆提升到用户级（跨项目共用）
- `/instinct`：列出所有规则（按 confidence 排序，标注作用域）
- `/instinct distill`：用本会话观测手动触发提炼（不必等会话结束）
- `/instinct forget <id>`：删除规则
- `/instinct promote <id>`：把项目级规则提升到用户级（跨项目共用）
- `/instinct skill [id]`：查看可蒸馏规则（confidence ≥ 0.8 且观测 ≥ 3 次）/ 把高频规则生成为用户级 Skill 草稿（trigger→when_to_use、action→执行要点），`/skills reload` 后生效
- `/instinct stats`：查看规则/记忆数量（含作用域分布）、领域分布与观测健康（近 30 天失败率、失败集中的工具、周趋势）

经验文件默认不入版本库（`.haji/` 已被 gitignore）。LLM 提炼在你的本地 provider 上完成，记忆内容不会上传第三方服务。Ctrl+C 退出时会尽力 flush 已累积的观测样本。

## 性能诊断

- `/perf`：查看事件循环、终端渲染、Markdown、工具、快照、Session 和 Trace 的耗时统计。
- `/perf reset`：读取后清空当前性能采样。

新 Trace 使用小型元数据文件与追加式 JSONL 事件流；会话存盘采用合并延迟写入，并在 `/resume` 与退出前强制刷新。
