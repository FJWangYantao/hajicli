# 写路径基准（write_path_baseline）

日期：2026-10-27
数据：`../data/2026-10-27-write-baseline.json`（3 任务 × 2 arm × 2 轮 = 12 次运行）
脚本：`run.sh`

## 为什么做

此前所有 A/B 都是只读调研任务，写路径（edit 重试、`post-edit-verify`、审批）一次都没测过。
这次先把**固定的写任务**立起来，同时用它确认 `post-edit-verify` 探测顺序的修复效果。

## 任务

| # | 任务 | 正确性检查 |
| --- | --- | --- |
| 1 | 在 `bounded-output.ts` 新增 `clampText`，新建测试覆盖三种情况 | `tsc -b` + 测试通过 |
| 2 | 把 `truncateSingleLine` 重命名为 `truncateLine`，同步所有引用 | 旧名无残留 + `tsc -b` |
| 3 | 修 `truncateSingleLine` 在 `maxLength <= 1` 时越界的边界问题 + 回归测试 | `tsc -b` + 测试通过 |

## 方法

- 每次运行一个独立 `git worktree`（detach 到当前 HEAD），`cp -al` 硬链接 `node_modules`，
  先 `pnpm run build` 预热，让 `tsc -b` 走增量（贴近开发者本地状态，否则冷构建会吃掉超时预算）。
- 两个 arm：
  - `old`：`HAJI_POST_EDIT_VERIFY="npm run check --silent"`（修复前本仓库的探测结果）；
  - `fixed`：默认探测（`npx tsc -b`）。
- 每次跑完做正确性检查，并拷出 trace 再删工作树。

## 结果

正确性：**12/12 全部通过**（`tsc -b` 通过、测试通过、重命名无残留）。

| 任务 | old 墙钟（2 轮） | fixed 墙钟（2 轮） |
| --- | ---: | ---: |
| 1 加函数 + 测试 | 61s / 74s | 46s / 41s |
| 2 跨文件重命名 | 22s / 28s | 31s / 87s |
| 3 修边界 + 回归测试 | 80s / 98s | 50s / 56s |
| 合计 | 363s | 311s（**−14%**） |

| 指标 | old | fixed | 变化 |
| --- | ---: | ---: | ---: |
| 墙钟 | 363s | 311s | −14.3% |
| 请求 | 62 | 76 | **+22.6%** |
| prompt token | 670k | 869k | +29.8% |
| completion token | 12.5k | 15.8k | +27.2% |
| 费用 | ¥0.268 | ¥0.315 | **+17.5%** |

**这不是结论**：每个格子只有 2 次，方差远大于差异，而且任务 2 的两臂工具选择完全不同
（见下），墙钟差主要来自工具选择而不是验证开销。

## 观察（比数字更值得记）

1. **重命名任务根本不走 edit**：old 臂两次都是 `sed -i 's/truncateSingleLine/truncateLine/g'`
   一条 bash 搞定（22s / 28s），`post-edit-verify` 连一次都没触发。fixed 臂改用 6 次 `edit`
   （31s / 87s），差异全在工具选择上。**验证钩子只挂在 write/edit 上，用 bash 改文件等于绕过验证。**
2. **写路径 bash 占比很高**：每轮 6–13 次 bash，对比 1–6 次 edit。模型用 bash 做
   `grep`、`sed -n`、`npx tsc -b`、`node --test`、`git status`——其中 `tsc` / 测试这两项和
   `post-edit-verify` 的职责重叠，等于**模型自己在做一遍验证**。
3. **old 臂确实吃满 15 秒**：任务 1/3 各出现一次「npm run check 超过时限已中止」；
   因为 10 秒冷却 + 60 秒同文本去重，每次编辑窗口最多损耗一次，而不是每次编辑都 15 秒。
4. **fixed 臂请求数反而更多**：验证通过的 `[编辑后验证] … 通过` 会作为系统消息进上下文，
   模型有时会为它多花一轮。样本太小，需要更多轮次才能判断是否稳定。

## 下一步

- 把任务 2 改成「必须用 edit」的形态（例如同时改签名与调用点、要求保留格式），否则它测的是
  `sed` 而不是 edit 路径。
- 加一个「bash 改文件」的对照，确认验证钩子是否需要覆盖 `bash` 里的写操作（`sed -i`、重定向）。
- 每个格子至少 3–4 轮再下结论；主指标仍是墙钟，请求/费用作护栏。
