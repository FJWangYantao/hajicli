# HAJI CLI

HAJI CLI 是一个面向本地代码工作的终端 AI 助手，支持流式对话、Plan Mode、可中止工具、会话恢复、Rewind 和最多三个并行只读子代理。

运行中按 `Esc` 会立即停止 spinner 和新 token 渲染，并在后台完成网络或工具进程清理；已经生成的部分回复会保留。若承载本轮 prompt 的主 Provider 请求尚未真正发出，本轮 prompt 不会写入会话，而是自动收回输入框供修改后重发；自动压缩也不会提前提交它。

## 环境要求

- Node.js 20.18.1 或更高版本
- pnpm 10.22.0
- Windows Terminal 为主要支持终端；核心构建和测试也在 Linux CI 中执行

## 开发验证

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm pack:check
```

`pack:check` 会构建全部包，并拒绝包含 `.haji`、源码、测试或 `workspace:` 依赖的发布包。

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

## 安全边界

文件读取、写入、编辑和 Grep 默认只能访问启动 HAJI 时的当前工作区，并校验符号链接是否逃逸。若确实需要访问工作区外路径，可在可信会话中显式设置：

```powershell
$env:HAJI_ALLOW_OUTSIDE_WORKSPACE = '1'
```

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
- **记忆注入层**：高置信度规则与已确认记忆作为 system prompt 常驻分片（priority 46），每轮对话自动注入。

存储布局（两级，项目级覆盖用户级同名条目）：

- `.haji/observations.jsonl`：观测流，超 5MB/8000 行按月归档，主文件保留 30 天
- `.haji/instincts/<domain>__<id>.md`：行为规则，frontmatter 含 confidence/domain/source/observedAt
- `.haji/memory/active/<type>__<id>.md`：已确认记忆
- `.haji/memory/staging/<type>__<id>.md`：LLM 提取的记忆候选，需用户确认后转为 active
- 用户级目录：`%USERPROFILE%/.haji/instincts/`、`%USERPROFILE%/.haji/memory/`

置信度演化：规则首现时 confidence=0.5，重复观测 +0.05（上限 0.9），90 天未触发 -0.05，低于 0.55 标记 deprecated。只有 confidence ≥ 0.7 的规则才会被注入。

交互命令：

- `/memory`：列出 active 与 staging 记忆（标注 `[用户级]`/`[项目级]` 作用域）
- `/memory confirm <id>`：确认 staging 记忆为 active
- `/memory add <user|project|feedback> <内容>`：手工添加记忆（`user` 写用户级，跨项目共用；其余写项目级）
- `/memory forget <id>`：删除记忆
- `/memory promote <id>`：把项目级记忆提升到用户级（跨项目共用）
- `/instinct`：列出所有规则（按 confidence 排序，标注作用域）
- `/instinct distill`：用本会话观测手动触发提炼（不必等会话结束）
- `/instinct forget <id>`：删除规则
- `/instinct promote <id>`：把项目级规则提升到用户级（跨项目共用）
- `/instinct stats`：查看规则/记忆数量（含作用域分布）与领域分布

经验文件默认不入版本库（`.haji/` 已被 gitignore）。LLM 提炼在你的本地 provider 上完成，记忆内容不会上传第三方服务。Ctrl+C 退出时会尽力 flush 已累积的观测样本。

## 性能诊断

- `/perf`：查看事件循环、终端渲染、Markdown、工具、快照、Session 和 Trace 的耗时统计。
- `/perf reset`：读取后清空当前性能采样。

新 Trace 使用小型元数据文件与追加式 JSONL 事件流；会话存盘采用合并延迟写入，并在 `/resume` 与退出前强制刷新。
