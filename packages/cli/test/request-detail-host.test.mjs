import assert from "node:assert/strict";
import test from "node:test";

import { TerminalUI } from "../dist/terminal-input.js";

/**
 * 三层页面的宿主行为：费用列表 →（Enter）回合详情 →（Enter）单次请求详情。
 * 只验证状态机（scheduleRender 置空），版式与命中几何由 render 测试覆盖。
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

const DETAILS = [
  detail(1, { turn: 1, costCny: 0.01 }),
  detail(2, { turn: 1, costCny: 0.02 }),
  detail(3, { turn: 2, costCny: 0.001 }),
  detail(4, { turn: 2, costCny: 0.03 }),
  detail(5, { turn: 2, costCny: 0.004 }),
];

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
  ui.setCostLogProvider(() => DETAILS);
  return ui;
}

const key = (ui, name, extra = {}) => ui.handleCostLogKey({ name, ctrl: false, ...extra });

test("Enter 逐层深入：列表 → 回合详情 → 请求详情", () => {
  const ui = createUI();
  ui.openCostLog("requests");
  ui.costLog.selectedIndex = 3;
  assert.equal(ui.isRequestDetailOpen(), false);

  key(ui, "return");
  assert.equal(ui.isTurnDetailOpen(), true);
  assert.equal(ui.isRequestDetailOpen(), false);

  key(ui, "return");
  assert.equal(ui.isRequestDetailOpen(), true);
  assert.equal(ui.costLog.turnDetail.selectedIndex, 1, "落在同一次调用上");
});

test("Esc 逐层退回：请求详情 → 回合详情 → 列表 → 关闭，光标全程不丢", () => {
  const ui = createUI();
  ui.openCostLog("requests");
  ui.costLog.selectedIndex = 3;
  key(ui, "return");
  key(ui, "right"); // 回合内从第 2 次移到第 3 次
  assert.equal(ui.costLog.turnDetail.selectedIndex, 2);
  key(ui, "return");
  assert.equal(ui.isRequestDetailOpen(), true);

  assert.equal(key(ui, "escape"), true);
  assert.equal(ui.isRequestDetailOpen(), false);
  assert.equal(ui.isTurnDetailOpen(), true, "第一次 Esc 只回回合页");
  assert.equal(ui.costLog.turnDetail.selectedIndex, 2, "回合页的光标保留");

  assert.equal(key(ui, "escape"), true);
  assert.equal(ui.isTurnDetailOpen(), false);
  assert.equal(ui.isCostLogOpen(), true, "第二次 Esc 回列表");
  assert.equal(ui.costLog.selectedIndex, 3, "列表的选中保留");

  assert.equal(key(ui, "escape"), true);
  assert.equal(ui.isCostLogOpen(), false, "第三次 Esc 关闭整页");
});

test("←→ 在同一回合的相邻调用间切换，首尾夹紧", () => {
  const ui = createUI();
  ui.openCostLog("requests");
  ui.costLog.selectedIndex = 3;
  key(ui, "return");
  key(ui, "return");
  const view = () => ui.costLog.turnDetail;

  assert.equal(view().selectedIndex, 1);
  key(ui, "right");
  assert.equal(view().selectedIndex, 2);
  key(ui, "right");
  assert.equal(view().selectedIndex, 2, "本轮最后一次就停住");
  key(ui, "left");
  assert.equal(view().selectedIndex, 1);
  key(ui, "left");
  key(ui, "left");
  assert.equal(view().selectedIndex, 0, "不会跑到上一轮去");
  assert.equal(view().turn, 2, "轮次不变");
});

test("请求详情页里 ↑↓ 同样在本轮内移动（与回合页共用一个光标）", () => {
  const ui = createUI();
  ui.openCostLog("requests");
  ui.costLog.selectedIndex = 3;
  key(ui, "return");
  key(ui, "return");
  key(ui, "down");
  assert.equal(ui.costLog.turnDetail.selectedIndex, 2);
  key(ui, "up");
  assert.equal(ui.costLog.turnDetail.selectedIndex, 1);
});

test("最内层再按 Enter 不叠层、不落到发送逻辑", () => {
  const ui = createUI();
  ui.openCostLog("requests");
  ui.costLog.selectedIndex = 3;
  key(ui, "return");
  key(ui, "return");
  assert.equal(key(ui, "return"), true);
  assert.equal(ui.isRequestDetailOpen(), true);
  assert.equal(ui.costLog.turnDetail.turn, 2);
});

test("输入框有内容时 Enter 不归页面", () => {
  const ui = createUI();
  ui.openCostLog("requests");
  ui.activeInput = { graphemes: ["你", "好"], cursorIndex: 2 };
  assert.equal(key(ui, "return"), false, "列表层不抢");
  ui.costLog.selectedIndex = 3;
  key(ui, "return");
  assert.equal(key(ui, "return"), false, "回合层也不抢");
  assert.equal(ui.isRequestDetailOpen(), false);
});

test("请求详情页的点击：只认返回按钮，列表区域点击不误选", () => {
  const ui = createUI();
  ui.openCostLog("requests");
  ui.costLog.selectedIndex = 3;
  key(ui, "return");
  key(ui, "return");
  // 请求详情页没有列表：命中表里列表区域宽度为 0（由渲染层写入）。
  ui.costLogHit = {
    listTop: 0,
    listHeight: 0,
    listLeft: 0,
    listWidth: 0,
    listOffset: 0,
    itemHeight: 1,
    backRow: 1,
    backLeft: 60,
    backWidth: 16,
  };
  ui.handleCostLogClick(5, 10);
  assert.equal(ui.isRequestDetailOpen(), true, "点正文不会退出");
  assert.equal(ui.costLog.turnDetail.selectedIndex, 1);

  ui.handleCostLogClick(62, 1);
  assert.equal(ui.isRequestDetailOpen(), false, "点返回按钮回回合页");
  assert.equal(ui.isTurnDetailOpen(), true);
  assert.equal(ui.isCostLogOpen(), true);
});

test("换排序视角会把三层一起退回列表", () => {
  const ui = createUI();
  ui.openCostLog("requests");
  ui.costLog.selectedIndex = 3;
  key(ui, "return");
  key(ui, "return");
  assert.equal(ui.isRequestDetailOpen(), true);
  ui.openCostLog("cost");
  assert.equal(ui.isTurnDetailOpen(), false);
  assert.equal(ui.isRequestDetailOpen(), false);
});
