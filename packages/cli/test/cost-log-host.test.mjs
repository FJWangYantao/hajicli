import assert from "node:assert/strict";
import test from "node:test";

import { TerminalUI } from "../dist/terminal-input.js";

/**
 * 费用日志页的宿主行为：打开/关闭、排序视角切换、键盘导航、点击命中。
 * 只验证状态机，不触发渲染（scheduleRender 被替换成空函数）。
 */
function detail(seq, overrides = {}) {
  return {
    seq,
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
    ...overrides,
  };
}

function createUI(details = [detail(1), detail(2), detail(3)]) {
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
  ui.setCostLogProvider(() => details);
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
  ui.setCostLogProvider(() => [detail(1)]);
  assert.equal(ui.openCostLog("cost"), false);
  assert.equal(ui.isCostLogOpen(), false);
});

test("打开页面后按指标视角排序，再次点另一行只换视角不重快照", () => {
  const ui = createUI();
  assert.equal(ui.openCostLog("cost"), true);
  assert.equal(ui.isCostLogOpen(), true);
  assert.equal(ui.costLog.sort, "cost");
  assert.equal(ui.costLog.details.length, 3);

  ui.costLog.selectedIndex = 2;
  assert.equal(ui.openCostLog("input"), true);
  assert.equal(ui.costLog.sort, "input");
  assert.equal(ui.costLog.selectedIndex, 0, "换视角时选中项归零");
});

test("没有记录时不打开页面，避免空白页", () => {
  const ui = createUI([]);
  assert.equal(ui.openCostLog("cost"), false);
  assert.equal(ui.isCostLogOpen(), false);
});

test("Esc 关页面，↑↓/PgUp/PgDn/Ctrl+Home/End 移动且不越界", () => {
  const ui = createUI();
  ui.openCostLog("requests");
  const key = (name, extra = {}) => ui.handleCostLogKey({ name, ctrl: false, ...extra });

  assert.equal(key("down"), true);
  assert.equal(ui.costLog.selectedIndex, 1);
  key("down");
  key("down");
  assert.equal(ui.costLog.selectedIndex, 2, "到底后不再前进");
  key("up");
  assert.equal(ui.costLog.selectedIndex, 1);
  key("pageup");
  assert.equal(ui.costLog.selectedIndex, 0);
  key("pagedown");
  assert.equal(ui.costLog.selectedIndex, 2);
  key("end", { ctrl: true });
  assert.equal(ui.costLog.selectedIndex, 2);
  key("home", { ctrl: true });
  assert.equal(ui.costLog.selectedIndex, 0);
  assert.equal(key("home"), false, "非 Ctrl+Home 不接管");

  assert.equal(key("escape"), true);
  assert.equal(ui.isCostLogOpen(), false);
});

test("点击某一行选中它，点击「Esc 返回」关闭页面", () => {
  const ui = createUI();
  ui.openCostLog("requests");
  // 模拟一帧的命中表：列表从屏幕第 3 行开始，每条占 1 行，列表偏移 0。
  ui.costLogHit = {
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
  ui.handleCostLogClick(5, 5);
  assert.equal(ui.costLog.selectedIndex, 2, "第 5 行对应列表第 3 条");
  ui.handleCostLogClick(5, 4);
  assert.equal(ui.costLog.selectedIndex, 1);
  ui.handleCostLogClick(5, 99);
  assert.equal(ui.costLog.selectedIndex, 1, "列表外的点击不改变选中项");
  ui.handleCostLogClick(5, 2);
  assert.equal(ui.costLog.selectedIndex, 1, "列表上方的点击不改变选中项");
  ui.handleCostLogClick(75, 1);
  assert.equal(ui.isCostLogOpen(), false, "顶栏「Esc 返回」可点");
});

test("窄屏两行模式按 itemHeight 换算点击到哪一条", () => {
  const ui = createUI();
  ui.openCostLog("requests");
  ui.costLogHit = {
    listTop: 3,
    listHeight: 6,
    listLeft: 1,
    listWidth: 40,
    listOffset: 1,
    itemHeight: 2,
    backRow: 1,
    backLeft: 30,
    backWidth: 10,
  };
  // 屏幕第 3、4 行属于列表第 0 条（偏移 1 → 记录下标 1）。
  ui.handleCostLogClick(5, 3);
  assert.equal(ui.costLog.selectedIndex, 1);
  ui.handleCostLogClick(5, 4);
  assert.equal(ui.costLog.selectedIndex, 1);
  // 第 5 行开始进入下一条（记录下标 2）。
  ui.handleCostLogClick(5, 5);
  assert.equal(ui.costLog.selectedIndex, 2);
});

test("两个整页视图互斥：打开上下文详情页会先关掉费用日志页", () => {
  const ui = createUI();
  ui.openCostLog("cost");
  assert.equal(ui.isCostLogOpen(), true);
  // 没有上下文分项，详情页开不起来，但费用日志页必须已经被关掉。
  assert.equal(ui.openContextInspector(), false);
  assert.equal(ui.isCostLogOpen(), false);
});
