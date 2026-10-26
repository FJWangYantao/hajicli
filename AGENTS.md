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
- 测试：`packages/cli/test/immediate-command.test.mjs`（判定口径、别名、参数白名单、目录标记）。

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
