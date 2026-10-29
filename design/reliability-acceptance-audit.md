# 可靠性与首次使用验收

本轮接续 failure-recovery-audit.md，保留已有 .tmp 内容，不提交或发布。

## 实现与证据

| 验收点 | 实现与验证 |
| --- | --- |
| 保存失败不损坏旧数据并可重试 | SessionManager 原子替换失败保留待写入数据；hasPendingWrites 包含排队与在途写入。persistence-exit 测试注入 ENOSPC 验证旧数据、告警、临时文件清理及重试。 |
| 保存失败不继续副作用 | turn-runner 在执行工具前及每批工具结果后检查保存状态；失败停止后续工具/模型请求，为跳过调用补结果并不发完成通知。故障注入覆盖执行前、首工具后两条路径。 |
| 未保存内容不因会话切换丢失 | /clear、resume 在 flush 后仍有待写入数据时保留当前消息与作用域。session-recovery 行为测试覆盖。 |
| 退出清理异常或挂起不阻止关键保存 | 退出先保存会话，再执行经验/Stop钩子，最终再次保存，Trace 独立执行。每步默认3秒限时、失败告警、退出码1；超时发取消信号，提炼向Provider传递信号并在写结果前检查。persistence-exit 与 distill-engine 行为测试覆盖。 |
| 任务与快照强退恢复 | TaskStore、快照manifest/journal/blob改同目录临时文件加rename，避免截断覆盖。真实子进程在修改完成与任务完成边界被强杀，新建各组件检查任务状态、聊天与归属记录，Rewind可恢复原文件。 |
| 同会话多进程写入不静默覆盖 | 保存阶段以wx独占锁串行化，锁内对比加载文件的SHA256基线；新版本写入者胜出，旧版本报冲突并保留待写入数据。state-consistency测试同时启动两个真实进程竞争保存，恰好一个成功。 |
| 独立质量评测 | scripts/quality-run.mjs 与 quality-tasks.mjs、quality-benchmark测试。8个固定任务与独立断言；默认dry-run，真实运行需--run。详见quality-evaluation.md。 |
| 首次配置成功与重试 | onboarding测试使用本地HTTP服务和隔离HOME，检查失败不写盘、再次配置成功、配置字段与输出不含测试key。 |
| 真实CLI首任务、退出与继续 | pnpm run first-use:smoke：本地HTTP、隔离HOME、真实CLI子进程；首任务退出后-c恢复，再输入消息，服务端确认旧上下文，第二次退出保存至同一个会话。输出ok=true、四阶段通过、4次本地请求。 |
| 发布产物离线验收 | scripts/first-use-pack.mjs 已实现：pnpm pack三个包，临时目录解包，复制冻结本地第三方依赖，运行上述smoke。执行被自动审批拒绝，尚未运行，不能认定通过。待批准运行 pnpm run first-use:pack。 |

## 已执行检查

- pnpm run build：通过。
- 保存/提炼专项：20/20通过；此前状态/快照/任务/首次配置/质量专项38/38通过。
- 首轮全量发现新增接口未同步测试替身与旧源码断言，共8失败；修正后最小回归29/29通过。
- 默认并发全量再次运行时出现Git子进程超时与Node堆内存不足（日志 .tmp/reliability-suite-20261029.log）。
- 降低并发运行 node --test --test-concurrency=2 packages/cli/test/*.test.mjs：报告1198测试、1198通过、0失败、0取消、0跳过；测试耗时59343ms。外层工具60秒超时，但完整日志已实际写出最终通过汇总（.tmp/reliability-suite-serial-20261029.log）。
- pnpm lint：退出码0，仅既有info级提示。
- pnpm run first-use:smoke：退出码0，四阶段通过。
- pnpm run quality:eval --dry-run：退出码0，列出8个任务，未调用收费模型。
- 最终补充 state-consistency、session-recovery、quality-benchmark：15/15通过，包含费用汇总与显式失败不计成功的断言。
- scripts/first-use-pack.mjs 的 node --check：通过；仅语法检查，没有执行被拒绝的验收动作。
- git diff --check：通过；haji --version 与 CLI package.json 均为1.5.0。
- 已审查生产代码差异与新增脚本/测试；未提交、未发布。first-use任务及最终完成审计保留待办，等待离线发布包验收获准并实际通过。

## 保证边界与后续

1. 会话、任务、快照仍是独立存储，当前保证执行边界的恢复与单文件原子替换，不提供跨文件事务、断电持久化或exactly-once副作用保证。工具产生副作用到回执落盘仍有窗口；已有恢复逻辑给缺回执标为未知，要求核实。
2. 写锁只覆盖会话保存阶段，不能阻止两个会话在模型请求阶段同时操作代码或任务。检测到保存冲突后停止本轮，建议并行工作使用独立worktree。遗留lock保守拒写，不自动删除：自动回收的检查/删除竞争会误删新锁；需确认进程退出后备份清理。
3. 限时依赖事件循环可运行，无法打断同步阻塞。取消信号不能强制停止不合作的第三方Hook；正常退出最终process.exit兜底，未宣称所有外部子进程已被取消。
4. 首次使用smoke覆盖管道输入的真实CLI，不覆盖Windows Terminal的中文输入、粘贴、鼠标、授权卡与Esc人工按键；需要人工验收。向导的输出断言使用非TTY流，不证明TTY输入回显遮罩。
5. 发布包验收是离线tarball布局验证，不替代registry安装/全平台原生模块检查；执行仍待批准。未运行真实收费模型，未给出实际任务完成率。
6. 自动审批明确拒绝打包验收脚本，不得通过改名/包装命令绕过；任务保持未完成直到获准并实际验证。
