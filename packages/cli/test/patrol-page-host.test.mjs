import assert from "node:assert/strict";
import test from "node:test";

import { TerminalUI } from "../dist/terminal-input.js";

/**
 * PR 巡检页的宿主行为：打开/关闭、刷新、键盘导航、点击命中、与其它整页视图互斥。
 * 只验证状态机，不触发渲染（scheduleRender 被替换成空函数）。
 */
function job(prNumber, overrides = {}) {
  return {
    prNumber,
    branch: `haji/pr-${prNumber}`,
    targetBranch: "master",
    statusLabel: "审查中",
    terminal: false,
    headSha: "398d09dabc",
    fixRounds: 0,
    adjudicationRounds: 0,
    costCny: 0.01,
    taskBrief: `任务 ${prNumber}`,
    ...overrides,
  };
}

function pageState(overrides = {}) {
  return {
    jobs: [job(6), job(7), job(8)],
    selectedIndex: 0,
    running: true,
    paused: false,
    repo: "FJWangYantao/hajicli",
    ...overrides,
  };
}

function createUI() {
  const ui = new TerminalUI({
    header: "HAJI TERMINAL",
    compactHeader: "HAJI",
    inputPrompt: "> ",
    continuationPrompt: "  ",
    renderBorder: (width) => "-".repeat(width),
  });
  ui.interactive = true;
  ui.started = false;
  ui.scheduleRender = () => {};
  return ui;
}

test("非交互模式不开页面（无头输出继续走文本报告）", () => {
  const ui = new TerminalUI({
    header: "HAJI",
    compactHeader: "HAJI",
    inputPrompt: "> ",
    continuationPrompt: "  ",
    renderBorder: (width) => "-".repeat(width),
  });
  ui.scheduleRender = () => {};
  assert.equal(ui.openPatrolPage(pageState()), false);
  assert.equal(ui.isPatrolPageOpen(), false);
});

test("打开页面后记录状态；空任务列表也能打开（页面里给占位说明）", () => {
  const ui = createUI();
  assert.equal(ui.openPatrolPage(pageState()), true);
  assert.equal(ui.isPatrolPageOpen(), true);
  assert.equal(ui.patrolPage.jobs.length, 3);
  assert.equal(ui.patrolPage.running, true);
  assert.equal(ui.patrolPage.repo, "FJWangYantao/hajicli");

  ui.closePatrolPage();
  assert.equal(ui.openPatrolPage(pageState({ jobs: [] })), true);
  assert.equal(ui.isPatrolPageOpen(), true);
});

test("刷新任务列表时保留选中位置并夹紧到有效范围", () => {
  const ui = createUI();
  ui.openPatrolPage(pageState({ selectedIndex: 2 }));
  assert.equal(ui.patrolPage.selectedIndex, 2);

  // 任务变少：下标夹到最后一个。
  ui.updatePatrolPage(pageState({ jobs: [job(6)] }));
  assert.equal(ui.patrolPage.selectedIndex, 0);
  assert.equal(ui.patrolPage.jobs.length, 1);

  // 刷新不改选中项。
  ui.updatePatrolPage(pageState({ running: false }));
  assert.equal(ui.patrolPage.selectedIndex, 0);
  assert.equal(ui.patrolPage.running, false);
});

test("Esc 关页面，↑↓/PgUp/PgDn/Ctrl+Home/End 移动且不越界", () => {
  const ui = createUI();
  ui.openPatrolPage(pageState());
  const key = (name, extra = {}) => ui.handlePatrolKey({ name, ctrl: false, ...extra });

  assert.equal(key("down"), true);
  assert.equal(ui.patrolPage.selectedIndex, 1);
  key("down");
  key("down");
  assert.equal(ui.patrolPage.selectedIndex, 2, "到底后不再前进");
  key("up");
  assert.equal(ui.patrolPage.selectedIndex, 1);
  key("pageup");
  assert.equal(ui.patrolPage.selectedIndex, 0);
  key("pagedown");
  assert.equal(ui.patrolPage.selectedIndex, 2);
  key("end", { ctrl: true });
  assert.equal(ui.patrolPage.selectedIndex, 2);
  key("home", { ctrl: true });
  assert.equal(ui.patrolPage.selectedIndex, 0);
  assert.equal(key("home"), false, "非 Ctrl+Home 不接管");
  assert.equal(key("x"), false, "普通字符键交还输入框");

  assert.equal(key("escape"), true);
  assert.equal(ui.isPatrolPageOpen(), false);
});

test("点击某一行选中它，点击顶栏「返回」关闭页面", () => {
  const ui = createUI();
  ui.openPatrolPage(pageState());
  // 模拟一帧的命中表：列表从屏幕第 3 行开始，每条占 1 行，列表偏移 0。
  ui.patrolPageHit = {
    listTop: 3,
    listHeight: 6,
    listLeft: 1,
    listWidth: 80,
    listOffset: 0,
    itemHeight: 1,
    backRow: 1,
    backLeft: 70,
    backWidth: 10,
  };
  ui.handlePatrolClick(5, 5);
  assert.equal(ui.patrolPage.selectedIndex, 2, "第 5 行对应列表第 3 条");
  ui.handlePatrolClick(5, 4);
  assert.equal(ui.patrolPage.selectedIndex, 1);
  ui.handlePatrolClick(5, 99);
  assert.equal(ui.patrolPage.selectedIndex, 1, "列表外的点击不改变选中项");
  ui.handlePatrolClick(75, 1);
  assert.equal(ui.isPatrolPageOpen(), false, "顶栏「返回」可点");
});

test("整页视图互斥：打开巡检页会关掉费用日志页，反之亦然", () => {
  const ui = createUI();
  ui.setCostLogProvider(() => [
    {
      seq: 1,
      turn: 1,
      at: Date.parse("2024-01-02T03:04:05Z"),
      model: "deepseek-chat",
      purpose: "主线回合",
      promptTokens: 1000,
      cachedPromptTokens: 0,
      completionTokens: 200,
      costCny: 0.001,
      offPeak: false,
      cacheReported: true,
    },
  ]);

  ui.openCostLog("cost");
  assert.equal(ui.isCostLogOpen(), true);
  ui.openPatrolPage(pageState());
  assert.equal(ui.isPatrolPageOpen(), true);
  assert.equal(ui.isCostLogOpen(), false, "打开巡检页时关掉费用日志页");

  ui.openCostLog("cost");
  assert.equal(ui.isCostLogOpen(), true);
  assert.equal(ui.isPatrolPageOpen(), false, "打开费用日志页时关掉巡检页");
});

test("index 接线：点侧栏入口先启动再进页面，巡检状态变化时刷新已打开的页面", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  // 点击入口：未在跑时启动（幂等），随后无论哪种状态都打开页面。
  assert.match(source, /id === "patrol\.entry"[\s\S]{0,400}patrolHint\?\.start\(\)/);
  assert.match(
    source,
    /id === "patrol\.entry"[\s\S]{0,400}ui\.openPatrolPage\(buildPatrolPageState\(\)\)/,
  );
  // 侧栏状态变化（启动、5s 轮询）时刷新页面里的任务列表。
  assert.match(source, /ui\.setPatrolState\(state\);[\s\S]{0,200}ui\.updatePatrolPage\(/);
});
