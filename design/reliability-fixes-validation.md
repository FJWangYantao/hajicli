# 权限提示、模型归属与原位重载验收

## 修复

- index.ts：无头且无法交互取得授权时，返回明确的非交互原因与授权操作提示，不再返回用户主动拒绝。受保护目标仍要求交互逐次确认；去除建议跳过保护的提示。权限判定未放宽。
- quality-configured-run.mjs：在隔离HOME配置cndeepseek模型与同模型辅助任务，仅写本地转发的占位凭据；实际凭据仍只在父进程内存使用。代理校验请求模型而不再改写模型。CLI直接报告cn:deepseek-v4.1-flash；无渠道价格时费用为null，不套用官方模型单价。
- reload.ts：使用process.execve原位替换，保持PID、前台进程组与标准流，删除spawn等待链与信号空处理器。支持能力不足时在主循环提示并保留当前会话。不支持Windows或缺少execve的Node；建议非Windows Node22.15+/24+，实际以能力检测为准。

## 验证

- pnpm run build通过。
- reload、headless、persistence-exit、quality-benchmark四个文件24项测试通过，包含连续原位替换PID不变、SIGTERM退出、恢复消息/目标/工作区、启动失败与Trace端口释放。
- 真实PTY CLI连续3次/reload，PID始终2187847，无Node子进程链，精确恢复同一会话，/exit返回0。首次探测遇到启动期短暂辅助子进程，调整探测为识别Node重载链并在恢复后观察，三次均无残留。
- 真实CN DeepSeek完整8项：.tmp/quality-cn-fixed/report.json。8/8严格通过、全部退出0、独立源码验收通过；121319ms，431110累计token，62次上游请求，单任务最高57758 token，无未知usage，全部低于500000上限。人工纠正0。
- 所有execution.json中model均为cn:deepseek-v4.1-flash，费用均null。实际账单未核实。转发层保留每次上游usage。
- 真实会话tool结果包含新非交互拒绝原因，证明操作仍被阻止且不冒称用户拒绝。
- Biome无error（index.ts既有5条info）；git diff --check通过。按code-review-and-quality技能审查相关修改，补足不支持execve时保留当前会话的处理。

## 范围与限制

8项均为基础编程任务，不能外推复杂项目成功率。本轮保留此前基线，不改写旧成绩。token预算以累计上游usage和请求字节预留控制，不是提供商tokenizer的精确硬限额。转发缓冲响应，因此不用于测流式首字延迟。未提交、未发布。此前旧进程若尚未加载这版reload逻辑，第一次重载仍可能留下一层旧父进程；手动退出再启动后使用新逻辑可消除旧链。
