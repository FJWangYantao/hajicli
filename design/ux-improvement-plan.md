# hajicli 体验优化方案

> 范围：CLI 交互层（`packages/cli`）的用户体验、布局、工作流展示与功能补全。
> 基线：master `ac71be1`（v1.3.0 之后，含指令别名 / 指令中心 / 三行输入区）。
> 目标：**降低用户心智负担**——少记名字、少猜状态、少走弯路。

## 设计原则

1. **一个动作一个名字**：同义入口只靠 `aliases` 兼容，不在补全 / 帮助里出现第二个名字。
2. **状态可见、不靠颜色单独表达**：变色时同时给一句能操作的话（下一步该按什么 / 输什么）。
3. **错误给出路**：每条失败提示都带一个可执行的修复指令。
4. **默认安全**：误触不应造成不可逆后果（退出、丢草稿、全放行）。
5. **文案统一中文**，与现有 UI 一致；标识符沿用既有命名。

---

## 一、降低心智负担

### 1.1 指令收敛

**现状**（`cli-help.ts` 的 `COMMAND_SURFACE`）：

| 易混组 | 问题 |
| --- | --- |
| `/permission` vs `/permissions` | 只差一个 s，一个切档、一个管理永久规则 |
| `/agent`（枢纽）、`/agents`、`/subagent` | 三个名字指向同一家族 |
| `/skill`（枢纽）vs `/skills` | 同上 |
| `/memory` 枢纽内含 `/instinct` | "本能规则"是内部术语，用户不知道和记忆的区别 |

**方案**：

| 规范指令 | 收编（转为 alias 或子命令） |
| --- | --- |
| `/permission [模式]`、`/permission rules` | `/permissions` → `/permission rules` |
| `/agents`（列表/管理）、`/agents new`（向导）、`/agents presets` | `/agent`、`/subagent` → `/agents new`；`/preset` → `/agents presets` |
| `/skills`、`/skills reload`、`/skills validate` | `/skill` 枢纽取消，`/skill <名称>` 仍保留为调用入口 |
| `/memory`、`/memory rules …` | `/instinct …` → `/memory rules …`（UI 文案统一叫"规则"） |

**改动点**：

- `cli-help.ts`：调整 `COMMAND_SURFACE`；当前别名只支持一级单词指令，需要扩展 `buildCommandAliasIndex`，
  支持"别名 → 多词规范指令"（如 `permissions` → `/permission rules`），解析时把剩余参数拼回去。
- `index.ts` / `subagent-commands.ts` / `experience-commands.ts`：分发入口按新名字匹配，旧名字经别名解析后自然命中。
- README 与 `/help` 自动跟随（指令面是唯一事实源）。

**验收**：`command-alias.test.mjs` 增加多词别名用例；旧指令全部仍可执行；补全 / 帮助中每个动作只出现一个名字。

### 1.2 首次启动配置向导

**现状**：`index.ts:247` 没有任何 Key 时打印一行错误后 `process.exit(1)`，新用户第一步就退出。

**方案**：交互模式下改为进入向导，无头模式保持原退出行为（退出码 1）。

```
欢迎使用 haji，先配置一个模型提供商：
  ❯ DeepSeek        （需要 DEEPSEEK_API_KEY）
    火山方舟         （需要 VOLC_API_KEY / ARK_API_KEY）
    自定义 OpenAI 兼容端点
粘贴 API Key：********
✓ 连通测试通过 · 已写入 ~/.haji/config.json
```

**改动点**：

- 复用 `provider-commands.ts` 中 `/provider add` / `/provider set` 的交互流程，抽出一个 `runProviderOnboarding(ctx)`。
- 连通测试复用 `provider-config.ts` 已有的请求耗时探测（如无则新增一个最小 `models` / 单 token 请求）。
- Key 只写盘，不回显明文（遵守 AGENTS.md）。

**验收**：新增 `onboarding.test.mjs`，用隔离 HOME 验证"无 Key → 向导写盘 → 正常进入主循环"，以及无头模式仍为退出码 1。

### 1.3 计划审批中文化，并支持直接写修改意见

**现状**：`turn-runner.ts:690` 附近的选项为 "Auto Execute / Approve Manually / No, Revise Plan"，
是界面里唯一的英文；选 No 之后只能等下一轮再输入。

**方案**：

| value | 新文案 | 说明 |
| --- | --- | --- |
| `auto` | 批准并自动执行 | 切到 [自动]，高风险由安全引擎拦截 |
| `manual` | 批准，逐步审批 | 切到 [默认]，每个修改型工具都先询问 |
| `no` | 修改计划… | 选中后立即打开输入框，输入的意见作为下一条用户消息提交，继续留在 Plan 模式 |

**验收**：在现有计划审批测试中断言中文标签；"修改计划"分支提交的意见进入消息历史。

### 1.4 权限卡：精简选项 + 拒绝并说明

**现状**（`cli-runtime.ts:259` 的 `buildPermissionCardItems`）：本次 / 本会话 / 永久·本项目 / 永久·全局 / 拒绝，共 5 项；
拒绝后模型只收到"用户拒绝"，常换个写法重试同一件事。

**方案**：

```
需要授权 · 主 Agent 请求执行命令
  npm test
  ❯ 允许本次                       y
    本会话内总是允许 bash:npm test   a
    永久允许（本项目 ⇄ 全局）        p   ← Tab 切换作用域
    拒绝                            n
    拒绝并说明…                     e   ← 打开输入框，理由回传给模型
```

**改动点**：`buildPermissionCardItems` 合并两条永久项；`readSelection` 支持条目级 Tab 切换子值（或在选中后二级选择作用域）；
`index.ts` 授权回调对 `deny-with-reason` 返回 `USER_REJECTED_TOOL_OUTPUT + "\n用户说明：" + 理由`。

**验收**：`cli-runtime` 单测覆盖新条目结构；拒绝理由出现在工具结果中。

---

## 二、工作流程显示

### 2.1 回合小结补全

**现状**（`turn-runner.ts:760`）：`完成 · 12.3s · 输出 1.2k tokens · 5 次工具调用（Ctrl+O 展开最后一批输出）`。

**方案**：

```
  完成 · 12.3s · 改动 3 个文件 +42 −7 · 类型检查 ✓ · ¥0.012 · 5 次工具调用（Ctrl+O）
```

- **改动文件**：回合开始时记录 `SnapshotEngine` anchor，结束时与工作区做 numstat 对比（只统计本会话拥有的改动）。
- **类型检查**：`post-edit-verify.ts` 的最近一次 `ProjectCheckResult`，本轮未触发则不显示。
- **费用增量**：`CostTracker.getSummary()` 回合前后差值；未定价模型省略。
- 各段按宽度依次舍弃（工具次数 → 费用 → 类型检查），保证单行。

**改动点**：抽出纯函数 `buildTurnSummary(stats, width)` 放进 `terminal-panels.ts`，`turn-runner.ts` 只负责收集数据。

**验收**：固定宽度单测覆盖完整、窄屏、无改动三种情况。

### 2.2 编辑 diff 预览

**现状**（`cli-runtime.ts:686`）：权限卡里是 `- ` 旧文本前 6 行 + `+ ` 新文本前 6 行，没有行号和上下文，
`write` 覆盖已有文件时也看不出改了什么。

**方案**：

```
  src/foo.ts  +3 −1
   41   const a = 1;
   42 − const b = load(path);
   42 + const b = await load(path, {
   43 +   cache: true,
   44 + });
   45   return a + b;
  … 还有 12 行 · Ctrl+O 查看完整 diff
```

- 读取原文件定位 `oldText` 的起始行号，前后各带 2 行上下文。
- 行内按词高亮差异（删除段用红底、新增段用绿底，颜色走 `theme.ts` 的 token，保证对比度）。
- `write` 覆盖已有文件时用行级 LCS 生成同样的 diff；新文件显示前 N 行和总行数。
- 工具块完成后的预览沿用同一渲染函数。

**改动点**：新建 `diff-preview.ts`（纯函数：`buildEditDiff(original, oldText, newText, width, maxLines)`），
`buildPermissionPreview` 与 `summarizeToolResult` 复用。

**验收**：`diff-preview.test.mjs` 覆盖单行改动、多行插入、CRLF 文件、宽字符截断。

### 2.3 运行中保留关键状态

**现状**：上一版把活动行挪到底栏、运行时替换状态栏。省了一行，但长任务期间看不到权限档和 ctx 用量，
而这正是最需要确认的时候（比如是否仍在"全放行"）。

**方案**：活动行右侧用一个极简徽标取代常驻的"Esc 中止"：

```
⠹ 执行命令 npm test  8s                                    [自动] ctx 63%
```

- "Esc 中止"只在阶段开始后的前 3 秒显示，之后让位给徽标（快捷键列表里仍能查到）。
- ctx ≥ 60% / 85% 时徽标沿用状态栏的黄 / 红配色。

**改动点**：`buildActivityRow` 增加 `badge` 参数；`TerminalUI` 渲染活动行时传入当前模式与用量。

### 2.4 任务面板进度

- 标题显示整体进度：`任务 · 重构 provider 层  3/7`。
- 进行中 `●` 项右侧显示已耗时。
- 子代理行补 tokens 用量：`↳ explorer · 运行中 · 12.4k`（复用 `formatAgentTokens`）。

**改动点**：`buildTaskPanelRows` 扩展，`TaskPanelItem` 增加可选 `startedAt`、`agent.tokens`。

### 2.5 完成 / 待授权提醒

窗口失焦时，用户不知道 haji 在等授权或已经跑完。

- 偏好 `notify`：`off` | `bell` | `desktop`（默认 `bell`）。
- 触发时机：回合耗时超过 30s 后完成；出现授权卡或计划审批。
- `bell` 写 `\x07`；`desktop` 写 OSC 9（iTerm2 / Windows Terminal）/ OSC 777（部分 Linux 终端），不支持的终端静默忽略。

**改动点**：`terminal-protocol.ts` 增加 `notifyUser(kind, text)`；偏好读写走 `cli-runtime.ts`。

### 2.6 错误提示可操作化

**现状**：`onRetry` 只截取错误原文前 60 字；最终失败也基本是原文。

**方案**：新增 `explainProviderError(error, providerName)` 纯函数，把常见错误分类翻译：

| 识别 | 提示 |
| --- | --- |
| 401 / 403 | API Key 无效或无权限 · `/provider set <名称>` |
| 429 | 被限流，{n}s 后重试 · 可 `/model` 换模型 |
| 上下文超限 | 上下文超出模型窗口 · `/compact` 或换长窗口模型 |
| ENOTFOUND / ECONNRESET / 超时 | 网络不可达 · 检查代理与 Base URL |
| 其他 | 保留原文（截断） |

**验收**：`provider-error.test.mjs` 用样本错误串逐类断言。

---

## 三、布局与交互

### 3.1 Ctrl+C 防误触

**现状**（`terminal-input.ts:1240`）：无输入框、无选择器时 Ctrl+C 直接 `process.exit(130)`；
很多用户习惯用 Ctrl+C 中断任务，结果整个进程退出。

**方案**（与主流 CLI 一致）：

| 状态 | 第一次 Ctrl+C | 2 秒内第二次 |
| --- | --- | --- |
| 有选中文本 | 复制（保持现状） | — |
| 回合进行中 | 等同 Esc，中止回合 | 提示"再按一次退出" |
| 输入框有草稿 | 清空草稿（可 ↑ 找回） | 提示"再按一次退出" |
| 空闲、输入框为空 | 底栏提示"再按一次 Ctrl+C 退出" | 退出（130） |

Ctrl+D 在空输入时仍直接退出，作为快速通道。

**验收**：`terminal-frame` 类测试模拟按键序列，断言各状态的行为。

### 3.2 输入框占位提示

空输入框显示一条淡色轮换提示，提高新功能的可发现性：

- `@ 引用文件 · / 打开指令中心`
- `Shift+Tab 切换权限模式 · 当前 [默认]`
- `/image <路径> 让模型看图`
- `/rewind 回到任意一步并撤销改动`

每次回合结束轮换一条；偏好 `inputHints: false` 可关闭。

### 3.3 上下文用量主动提醒

状态栏变黄（≥60%）或变红（≥85%）时，在回合小结之后**各提示一次**：
`上下文已用 85%，接近自动压缩阈值 · 可 /compact 手动压缩`。同一阈值同一会话不重复提示，压缩后重新计数。

### 3.4 启动页信息化

把"正在初始化大模型提供商、系统工具和 Trace 观测服务器..."换成一行有用的信息：

```
deepseek · deepseek-v4-pro · high   [默认]   ~/code/hajicli
上次会话：重构 provider 层（2 小时前） · /resume 继续
```

---

## 四、功能补全

| 编号 | 功能 | 说明 | 复用 |
| --- | --- | --- | --- |
| 4.1 | `haji -c` / `haji -r [关键词]` | 启动即继续上次会话 / 按标题搜索恢复 | `SessionManager`、`/resume` 流程 |
| 4.2 | `/diff` | 查看本会话累计改动（文件列表 + 2.2 的 diff 渲染） | `SnapshotEngine` |
| 4.3 | `/undo` | 撤销上一轮的代码与消息，`/rewind` 的一键版 | `rewind-flow.ts` |
| 4.4 | `@` 文件补全 | 输入 `@` 弹出工作区文件模糊搜索 | `ripgrep.ts` 文件列表、补全面板 |
| 4.5 | `/model` 显示价格与窗口 | 选择器描述栏显示 `入 ¥2 / 出 ¥8 每百万 · 128k · utility` | `model-registry.ts` 的 `pricing` / `tier` |
| 4.6 | 预算提醒 | 偏好 `budget`（元），超过后回合小结给黄色提示 | `CostTracker` |
| 4.7 | `/doctor` | 一次性自检：Key 连通、原生引擎、ripgrep、typecheck 命令、MCP、全局 `haji` 版本与仓库一致 | `/perf`、`/mcp`、`provider-config` |

---

## 实施计划

按"改动小、收益大、风险低"排序，每一项单独提交，并配套 `packages/cli/test/*.test.mjs` 用例。

| 阶段 | 内容 | 预估改动 | 风险 |
| --- | --- | --- | --- |
| P0 | 1.3 计划审批中文化 · 3.1 Ctrl+C 防误触 · 2.6 错误提示 | 小 | 低 |
| P1 | 2.1 回合小结 · 1.2 首次配置向导 · 2.5 完成提醒 | 中 | 低 |
| P2 | 2.2 diff 预览 · 1.4 权限卡精简 · 2.3 运行中徽标 · 2.4 任务进度 | 中 | 中（渲染细节多，需窄屏回归） |
| P3 | 1.1 指令收敛（别名平滑迁移，保留一个版本的兼容期） | 中 | 中（影响肌肉记忆，需在 release notes 说明） |
| P4 | 3.2 / 3.3 / 3.4 提示类 · 4.1–4.7 功能补全 | 视项而定 | 低 |

**通用门禁**：

- 每项完成后跑 `pnpm test` 与 `pnpm exec biome check <改动文件>`，保持 0 error。
- 渲染类改动在 40 / 80 / 120 列三档宽度下各跑一次固定宽度单测。
- 新增偏好项写入两级 `preferences.json`，项目级可覆盖用户级。
- 涉及 `config.json` 的输出不得打印明文 Key。
- 发版时三处 version 同步（见 AGENTS.md）。
