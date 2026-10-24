# AGENTS.md — hajicli 仓库约定

pnpm workspace monorepo：`packages/core`（`@hajicli/core`）、`packages/plugins`（`@hajicli/plugins`）、
`packages/cli`（发布包名 `hajicli`，bin 为 `haji`）。TypeScript strict + project references。
整体架构与各子系统导览见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 构建（TS） | `pnpm run build`（= `tsc --build`，按 references 增量编译到各包 `dist/`） |
| 原生终端引擎 | `pnpm run build:native`（产出 `packages/cli/dist/haji_terminal_engine.<platform>-<arch>.node`） |
| 全量构建 | `pnpm run build:full` |
| 测试 | `pnpm test`（内部会先 build，再 `node --test packages/cli/test/*.test.mjs`） |
| 单文件测试 | `node --test packages/cli/test/provider-config.test.mjs`（**必须先 build**，测试 import `../dist/*.js`） |
| 发版自检 | `pnpm run pack:check`（= `build:full` + `scripts/verify-packages.mjs`，校验 tarball 不含 `src/` `test/` `.haji/` `*.tsbuildinfo`） |

## 版本号同步（关键）

**任何改动 + 升版本后，三处 version 必须一致：**

- `package.json`（monorepo 根）
- `packages/cli/package.json`（发布包 `hajicli`）
- `packages/plugins/package.json`（`@hajicli/core` 同步看 `packages/core/package.json`）

本机全局 `haji` 不是 registry 副本，而是指向仓库的 **junction**：

```
C:\Users\WYT\AppData\Roaming\npm\node_modules\hajicli        → packages\cli（同 inode）
  node_modules\@hajicli\core    <JUNCTION> → packages\core
  node_modules\@hajicli\plugins <JUNCTION> → packages\plugins
```

因此：

- ✅ 改完 `pnpm run build` 后，全局 `haji` 立刻是新版本，**不需要** `npm i -g` / `pnpm link`
- ❌ 不要删除或移动仓库目录，否则全局 `haji` 立即失效
- 收尾验证（版本应一致；不一致说明 junction 被换成了副本，需重新 `npm i -g ./packages/cli`）：

```bash
node -e "console.log(require('C:/Users/WYT/AppData/Roaming/npm/node_modules/hajicli/package.json').version)"
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

## 代码风格与提交

- 注释与用户可见文案用中文；标识符与既有文件保持一致（camelCase，模块内工具函数不加 `export` 除非有测试需要）。
- 纯逻辑优先抽成可测函数放进现有 `*-config.ts` / `*-policy.ts` 一类模块，`index.ts` 的 `main()` 只做编排。
  斜杠命令按家族放 `provider-commands.ts` / `subagent-commands.ts` / `session-commands.ts`，经 `*CommandContext`
  访问器注入会话状态（可变 let 绑定必须走 getter/setter，不能拷贝值）；新增命令族时照此模式新建模块。
- `dist/` 未入库（`.gitignore` 中 `dist/`），提交时不包含构建产物。
- 新增交互逻辑尽量配一条 `packages/cli/test/*.test.mjs` 用例；测试通过临时目录 + 覆盖 `HOME`/`USERPROFILE`
  做路径隔离（参考 `provider-config.test.mjs` 的 `withIsolatedPaths`），不要读写真实 `~/.haji`。
