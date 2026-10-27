# experience_recall：经验召回随用户消息注入

日期：2026-10-27
数据：`data/2026-10-27-experience-recall-pilot.json`（2 任务 × 3 轮 × 2 arm = 12 会话）

## 问题（先纠正一个此前的错误结论）

之前我判断「经验库是空的，影响为零」——**错了**。当时只看了 `~/.haji/instincts`（空的），
但本仓库有 **570 条项目级 instincts**（`.haji/instincts/`，gitignore）。所以召回一直在生效，
而且一直用错 query：

- `lastUserMessageForRecall` 每轮都更新，但 **system prompt 只在启动、切模型、切权限、
  `/skills reload` 时重建**；普通回合根本不重建。
- 结果：整个会话的经验召回都用启动时的兜底词表 `workflow edit read test git error prevention`，
  和当前任务无关。

实测（本仓库 570 条 instincts + 一条种子 memory）：

```
兜底 query →  跑测试统一用 pnpm test / 对关键匹配项调用 Read 读取上下文
任务 query →  会话保存入口是 SessionManager.saveCurrentSession…（种子 memory）+ 上面两条
```

## 改动

- `experiences-prompt-part.ts` 抽出 `buildExperienceRecall(store, query)`，系统提示词分片与
  用户消息注入共用同一份格式化逻辑。
- 新增 `experience_recall` 实验：`system`（现状）/ `message`。
  - `system` 臂：经验分片仍注册在 system prompt 里（每轮重建会断前缀，所以只在必要时重建）。
  - `message` 臂：**不注册** system 分片，改在 `turn-runner` 里按本轮用户消息召回，
    追加到用户消息尾部，用 `<experience_recall>…</experience_recall>` 包起来。
- 注入块随消息一起落盘（这样下一轮的前缀和上一轮实际发出的内容一致，不吃缓存惩罚）；
  `/resume` 回放时按标记剥掉，不冒充用户原话。

## 方法

- 任务 3（会话保存链路）、任务 7（工具错误分类与止损），各 3 轮，两臂交替。
- 临时 HOME（`/tmp/opencode/exp-home`）里种了一条与任务 3 相关的 memory，`config.json` 拷过去；
  项目级 instincts 仍来自仓库 `.haji/instincts`。
- 每轮都核对了注入位置：`system` 臂 system prompt 里有 `经验记忆`、用户消息里没有；
  `message` 臂正好相反（12/12 符合）。

## 结果

| 指标 | system | message | 变化 |
| --- | ---: | ---: | ---: |
| 墙钟 / 会话 | 80.8s | 57.2s | −29.2% |
| 请求 / 会话 | 28.3 | 22.5 | −20.6% |
| prompt token / 会话 | 349,027 | 334,297 | −4.2% |
| 未命中 token / 会话 | 27,982 | 29,188 | +4.3% |
| 费用 / 会话 | ¥0.1130 | ¥0.1149 | +1.7% |

分任务：

| 任务 | 墙钟 | 请求 | 费用 |
| --- | ---: | ---: | ---: |
| 3 会话保存 | 52.4s → 52.3s（0%） | 23.0 → 22.7 | ¥0.0856 → ¥0.0983 |
| 7 错误止损 | 109.1s → 62.2s（−43%） | 33.7 → 22.3 | ¥0.1405 → ¥0.1315 |

**墙钟差异不归因于本改动**：任务 3 完全持平，任务 7 的差距全在 system 臂三次都跑了
33–45 次请求（message 臂 17–28 次），更像探索路径的随机分叉，n=3 不足以定论。
成本侧两臂基本持平（费用 +1.7%、未命中 +4.3%），符合「同一份内容、只换了位置」的预期。

## 结论

**采纳为默认（`message`）**，但理由是**正确性**而不是性能：召回终于跟着本轮任务走，
而不是永远用启动时的兜底词表。成本中性，缓存没有额外损失（注入块随消息落盘）。

质量抽查：任务 3 的关键结论（`saveCurrentSession` / `flush` / `session-manager`）两臂 3/3 全中；
任务 7（`RepeatedFailureTracker` / `noop` / `concurrent`）两臂 3/4 左右，没有出现退化。

**副作用**：注入块会写进用户消息（会话文件里能看到 `<experience_recall>` 段），
`/resume` 回放已剥掉；压缩摘要会把它当普通上下文一起压。

## 复现

```bash
# 临时 HOME 里种 memory（脚本见报告「方法」），然后：
HAJI_EXPERIMENTS="experience_recall=message" haji -p "<任务>" --no-worktree --output-format json
HAJI_EXPERIMENTS="experience_recall=system"  haji -p "<任务>" --no-worktree --output-format json

node scripts/ab-extract.mjs --experiment experience_recall --since 2026-10-27T15:06:00Z --json
```
