import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

/** UX 改进方案（design/ux-improvement-plan.md）的接线断言：源码级防回归。 */
const indexSource = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const inputSource = fs.readFileSync(new URL("../src/terminal-input.ts", import.meta.url), "utf8");
const runnerSource = fs.readFileSync(new URL("../src/turn-runner.ts", import.meta.url), "utf8");
const panelsSource = fs.readFileSync(new URL("../src/terminal-panels.ts", import.meta.url), "utf8");

test("2.1 回合小结：turn-runner 收集改动/类型检查/费用并交给 buildTurnSummary", () => {
  assert.match(runnerSource, /buildTurnSummary\(/);
  assert.match(runnerSource, /deps\.listOwnedChanges\?\.\(turnStartedAt - 1\)/);
  assert.match(runnerSource, /deps\.getLastTypeCheck\?\.\(turnStartedAt\)/);
  assert.match(runnerSource, /costBeforeTurn/);
  assert.match(panelsSource, /export function buildTurnSummary/);
});

test("2.5 完成/待授权提醒：notify 偏好 + 30s 回合 + 授权/审批触发点", () => {
  assert.match(inputSource, /notify\(kind: "bell" \| "desktop", text: string\)/);
  assert.match(inputSource, /\\x1b\]9;/);
  assert.match(inputSource, /\\x1b\]777;notify;/);
  assert.match(indexSource, /notifyPreference/);
  assert.match(indexSource, /durationMs > 30_000/);
  assert.match(indexSource, /notifyUserAttention\(\);/);
  assert.match(runnerSource, /deps\.notifyUserAttention\?\.\(\);/);
});

test("3.1 Ctrl+C 防误触：状态分支 + 2 秒窗口 + 草稿找回 + 退出码 130", () => {
  assert.match(inputSource, /private handleCtrlCInteraction\(\)/);
  assert.match(inputSource, /Date\.now\(\) - this\.lastCtrlCAt <= 2000/);
  assert.match(inputSource, /process\.exit\(130\)/);
  assert.match(inputSource, /ctrlCDraftStash/);
  assert.match(inputSource, /再按一次 Ctrl\+C 退出/);
  // 三处入口（idle/输入中/选择器）统一走 handleCtrlCInteraction；选择器保留“取消选择”语义。
  assert.match(
    inputSource,
    /if \(isRealCtrlC\(value, key\)\) \{\s*this\.handleCtrlCInteraction\(\);/,
  );
});

test("3.2/3.3 输入区不再显示占位/参数提示行 + 上下文提醒阈值各一次 + 压缩重置", () => {
  // 3.2 占位提示已按用户要求移除：空输入与已输入参数时都不再渲染提示行。
  assert.doesNotMatch(inputSource, /setInputHint/);
  assert.doesNotMatch(inputSource, /findSlashArgHint/);
  assert.match(indexSource, /contextWarnedYellow/);
  assert.match(indexSource, /contextWarnedRed/);
  assert.match(indexSource, /resetContextUsageWarnings\(\);/);
  assert.match(indexSource, /接近自动压缩阈值 · 可 \/compact 手动压缩/);
});

test("3.4 启动页信息化：provider·模型·强度·权限·工作区 + 上次会话", () => {
  assert.doesNotMatch(indexSource, /正在初始化大模型提供商/);
  assert.match(indexSource, /上次会话：/);
  assert.match(indexSource, /\/resume 继续/);
  assert.match(indexSource, /formatRelativeTime/);
});

test("4.1 haji -c / -r：启动即恢复会话", () => {
  assert.match(indexSource, /parseSessionResumeArgs\(cliArgs\)/);
  assert.match(indexSource, /await resumeLatestSession\(sessionCommandContext\)/);
  assert.match(indexSource, /await resumeByKeyword\(sessionCommandContext/);
});

test("4.2/4.3 /diff 与 /undo：快照日志口径 + 一键撤销", () => {
  assert.match(indexSource, /if \(command === "diff"\)/);
  assert.match(indexSource, /snapshotEngine\.listOwnedChanges\(0\)/);
  assert.match(indexSource, /if \(command === "undo"\)/);
  assert.match(indexSource, /handleUndoCommand\(sessionCommandContext\)/);
});

test("4.4 @ 文件补全：候选提供者接入输入框", () => {
  assert.match(inputSource, /setFileMentionProvider/);
  assert.match(inputSource, /applyFileMentionCompletion/);
  assert.match(indexSource, /matchFileMentionCandidates\(listWorkspaceFiles\(\), query\)/);
});

test("4.5/4.6 /model 价格窗口与会话预算提醒", () => {
  assert.match(indexSource, /withModelMeta/);
  assert.match(
    indexSource,
    /入 ¥\$\{pricing\.inputPerMTokens\} \/ 出 ¥\$\{pricing\.outputPerMTokens\} 每百万/,
  );
  assert.match(indexSource, /sessionBudgetCny/);
  assert.match(indexSource, /已超过预算/);
});

test("4.7 /doctor 自检命令族", () => {
  assert.match(indexSource, /if \(command === "doctor"\)/);
  assert.match(indexSource, /collectDoctorChecks\(/);
  assert.match(indexSource, /renderDoctorReport\(rows\)/);
});

test("2.3/2.4 运行中徽标与任务面板进度", () => {
  assert.match(panelsSource, /export interface ActivityBadge/);
  assert.match(inputSource, /formatPermissionModeLabel\(this\.permissionMode\)/);
  assert.match(panelsSource, /startedAt\?: number/);
  assert.match(panelsSource, /tokens\?: number/);
  assert.match(indexSource, /taskInProgressSince/);
});
