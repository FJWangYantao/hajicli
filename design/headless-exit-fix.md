# 无头成功任务退出码修复

## 根因与修复

真实CN DeepSeek clamp任务复现：CLI JSON输出ok=true，但退出码1；stderr明确包含“经验与退出钩子失败：超时，已继续退出清理”。原退出逻辑将辅助经验提炼与Stop钩子放在同一个3秒步骤内，任一步骤失败都令runShutdownSteps返回false，最终设置退出码1。

现拆成独立的“退出钩子”和“经验提炼”步骤。只有经验提炼声明affectsExitCode:false；失败或超时继续告警、取消并执行后续保存，但不改变任务退出码。默认步骤仍影响退出状态，保留首次会话保存、Stop钩子、最终会话保存和Trace保存的失败语义。此次未放宽权限或修改模型行为。

## 验证

- 修复前真实任务：.tmp/quality-exit-repro/clamp-execution.json，code=1、ok=true，经验与退出钩子超时。
- 修复后真实任务：.tmp/quality-exit-fixed/clamp-execution.json，code=0、ok=true，stderr仍有“经验提炼失败：超时，已继续退出清理”。同目录report.json显示passed=true，独立源码断言通过；累计58304 token，低于单任务500000上限。
- pnpm run build通过。
- persistence-exit、reload、quality-benchmark三个测试文件共15项全部通过，新增回归覆盖可选维护异常/超时、后续保存继续、关键步骤仍失败。
- Biome检查无error（index.ts有5项既有info）；git diff --check通过，并审查相关差异。

复现与修复后验证共消耗114136上游累计token；两次CLI费用估算合计0.059473元，实际渠道账单未核实。本次只重跑一个针对性任务，未宣称8项完整评测已全部通过。关键保存失败时仍可能在先前JSON成功输出后以非零码退出，调用方应同时检查进程状态。
