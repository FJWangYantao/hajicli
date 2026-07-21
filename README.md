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
