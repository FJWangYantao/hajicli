# HAJI CLI

HAJI CLI 是一个面向本地代码工作的终端 AI 助手，支持流式对话、Plan Mode、可中止工具、会话恢复、Rewind 和最多三个并行只读子代理。

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

## 网络代理与超时

HAJI 支持标准的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`，也支持以下专用变量：

- `HAJI_PROXY`：同时用于 HTTP 和 HTTPS
- `HAJI_HTTP_PROXY` / `HAJI_HTTPS_PROXY`：分别配置代理
- `HAJI_NO_PROXY`：配置不走代理的主机
- `HAJI_HTTP_TIMEOUT_MS`：模型或网页完整请求的超时，默认 60000，允许 1000 至 600000

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
- `/skill code-review`：确定性加载 Skill。
- `/skill code-review 审查当前 diff`：加载后立即继续执行参数中的任务。

`loadskill` 在 Plan Mode 中仍是只读工具。Skill 不能提升权限，也不能覆盖用户指令、`AGENTS.md` 或安全规则。Skill 名称不能是文件路径，`SKILL.md` 最大 64 KiB，并拒绝符号链接逃逸。

## 性能诊断

- `/perf`：查看事件循环、终端渲染、Markdown、工具、快照、Session 和 Trace 的耗时统计。
- `/perf reset`：读取后清空当前性能采样。

新 Trace 使用小型元数据文件与追加式 JSONL 事件流；会话存盘采用合并延迟写入，并在 `/resume` 与退出前强制刷新。
