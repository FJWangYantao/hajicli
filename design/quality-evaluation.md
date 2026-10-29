# 任务质量评测

新增 `scripts/quality-run.mjs` 与 `quality-tasks.mjs`，作为已有 A/B 效率报告之外的质量入口。

## 运行

- `pnpm run quality:eval --dry-run`：仅列出任务，不调用模型。
- `pnpm run quality:eval --run --out quality-report.json`：显式调用已通过环境变量配置的模型，可能收费。先执行 `pnpm run build`。评测使用隔离 HOME，只继承环境变量凭据，不读取真实用户配置。

每个任务在独立临时目录准备源码，运行真实 CLI（accept-edit、无 worktree、JSON 输出），随后在新 Node 进程运行评测器持有的断言。脚本完成后清理临时目录。命令与验收分别限时，超时终止进程树。受测任务失败、超时、显式 ok=false 或独立断言失败均不计成功；ok=true 与退出码0不足以通过。

## 首批任务与口径

8个任务：sum、clamp、median、unique、chunk、range、parsePort 边界修复、跨文件函数重命名。测试覆盖原始产物全部失败、正确实现全部通过，以及伪成功、失败退出、超时、启动失败与汇总字段。

报告字段：

- completionRate：独立验收通过数 / 总任务数。
- interventions：显式记录的人工介入数；无人值守 CLI 运行记0，未提供记录为null，不能将它解释为交互场景的纠正需求。
- wallMs：任务运行加验收的耗时。
- costCny：CLI usage.estimatedCostCny；只有明确无未定价模型才采纳，缺失/部分未知为null，汇总不把未知费用当0。

这是可运行的基础评测集，主要测代码修改正确性，尚不代表复杂真实项目任务完成率。故障恢复由专门的进程级测试覆盖；后续可在本框架中加入定位问题、长上下文和中断继续的复杂任务。当前未运行收费模型，不能据此给出 haji 的真实任务成功率。

验收进程不构成恶意代码安全沙箱；仅在受控本地开发环境运行评测。
