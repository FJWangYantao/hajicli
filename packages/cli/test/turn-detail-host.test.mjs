import assert from "node:assert/strict";
import test from "node:test";

import { TerminalUI } from "../dist/terminal-input.js";

/**
 * 回合详情页的宿主行为：从费用列表按 Enter 进去、逐层退回、本轮内的导航与点击。
 * 只验证状态机（scheduleRender 被替换成空函数），渲染版式由 turn-detail-page.test.mjs 覆盖。
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

function createUI(details) {
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

/** 两轮：第 1 轮 2 次调用，第 2 轮 3 次调用。 */
const DETAILS = [
  detail(1, { turn: 1, costCny: 0.01 }),
  detail(2, { turn: 1, costCny: 0.02 }),
  detail(3, { turn: 2, costCny: 0.001 }),
  detail(4, { turn: 2, costCny: 0.03 }),
  detail(5, { turn: 2, costCny: 0.004 }),
];

const key = (ui, name, extra = {}) => ui.handleCostLogKey({ name, ctrl: false, ...extra });

test("列表按 Enter 进回合详情，光标落在刚才选中的那一次调用上", () => {
  const ui = createUI(DETAILS);
  ui.openCostLog("requests");
  assert.equal(ui.isTurnDetailOpen(), false);

  // 「请求」视角按序号正序：下标 3 是 #4（第 2 轮第 2 次调用）。
  ui.costLog.selectedIndex = 3;
  assert.equal(key(ui, "return"), true);
  assert.equal(ui.isTurnDetailOpen(), true);
  assert.equal(ui.costLog.turnDetail.turn, 2);
  assert.equal(ui.costLog.turnDetail.selectedIndex, 1, "本轮内第 2 次调用");
});

test("Esc 逐层退回：详情 → 列表 → 关闭整页，列表的选中不丢", () => {
  const ui = createUI(DETAILS);
  ui.openCostLog("requests");
  ui.costLog.selectedIndex = 3;
  key(ui, "return");

  assert.equal(key(ui, "escape"), true);
  assert.equal(ui.isTurnDetailOpen(), false);
  assert.equal(ui.isCostLogOpen(), true, "第一次 Esc 只退回列表");
  assert.equal(ui.costLog.selectedIndex, 3, "列表的选中位置原样保留");

  assert.equal(key(ui, "escape"), true);
  assert.equal(ui.isCostLogOpen(), false, "第二次 Esc 关掉整页");
});

test("详情页里的 ↑↓/PgUp/PgDn 只在本轮内移动，不越界", () => {
  const ui = createUI(DETAILS);
  ui.openCostLog("requests");
  ui.costLog.selectedIndex = 3;
  key(ui, "return");
  const view = () => ui.costLog.turnDetail;

  assert.equal(view().selectedIndex, 1);
  key(ui, "down");
  assert.equal(view().selectedIndex, 2);
  key(ui, "down");
  assert.equal(view().selectedIndex, 2, "本轮最后一次调用处停住");
  key(ui, "up");
  assert.equal(view().selectedIndex, 1);
  key(ui, "pageup");
  assert.equal(view().selectedIndex, 0);
  key(ui, "pagedown");
  assert.equal(view().selectedIndex, 2);
  key(ui, "end", { ctrl: true });
  assert.equal(view().selectedIndex, 2);
  key(ui, "home", { ctrl: true });
  assert.equal(view().selectedIndex, 0);
  assert.equal(ui.costLog.selectedIndex, 3, "列表的选中不被详情页的移动改掉");
});

test("没有轮次信息的旧记录不开详情页，给出提示", () => {
  const ui = createUI([detail(1, { turn: 0 })]);
  ui.openCostLog("requests");
  assert.equal(key(ui, "return"), true, "回车被消费，不会落进发送逻辑");
  assert.equal(ui.isTurnDetailOpen(), false);
});

test("输入框有内容时 Enter 不归页面，留给发送", () => {
  const ui = createUI(DETAILS);
  ui.openCostLog("requests");
  ui.activeInput = { graphemes: ["你", "好"], cursorIndex: 2 };
  assert.equal(key(ui, "return"), false);
  assert.equal(ui.isTurnDetailOpen(), false);

  ui.activeInput = { graphemes: [], cursorIndex: 0 };
  assert.equal(key(ui, "return"), true);
  assert.equal(ui.isTurnDetailOpen(), true);
});

test("详情页里再按 Enter 落到请求详情；最内层再按不再变化", () => {
  const ui = createUI(DETAILS);
  ui.openCostLog("requests");
  ui.costLog.selectedIndex = 1;
  key(ui, "return");
  // 第二层按 Enter 进第三层（单次请求详情），光标与轮次都不变。
  const before = {
    turn: ui.costLog.turnDetail.turn,
    selectedIndex: ui.costLog.turnDetail.selectedIndex,
  };
  assert.equal(key(ui, "return"), true);
  assert.equal(ui.isRequestDetailOpen(), true);
  assert.deepEqual(
    { turn: ui.costLog.turnDetail.turn, selectedIndex: ui.costLog.turnDetail.selectedIndex },
    before,
  );
  // 最内层再按仍然是消费掉，不叠层、不落到发送逻辑。
  assert.equal(key(ui, "return"), true);
  assert.equal(ui.isRequestDetailOpen(), true);
  assert.deepEqual(
    { turn: ui.costLog.turnDetail.turn, selectedIndex: ui.costLog.turnDetail.selectedIndex },
    before,
  );
});

test("点击：详情页的返回按钮回列表，点调用行换选中", () => {
  const ui = createUI(DETAILS);
  ui.openCostLog("requests");
  ui.costLog.selectedIndex = 1;
  key(ui, "return");
  // 模拟详情页那一帧的命中表。
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
  ui.handleCostLogClick(5, 4);
  assert.equal(ui.costLog.turnDetail.selectedIndex, 1, "第 4 行 = 本轮第 2 次调用");
  ui.handleCostLogClick(5, 9);
  assert.equal(ui.costLog.turnDetail.selectedIndex, 1, "超出本轮的点击被忽略");

  ui.handleCostLogClick(75, 1);
  assert.equal(ui.isTurnDetailOpen(), false, "顶栏按钮回列表");
  assert.equal(ui.isCostLogOpen(), true, "但不关整页");
});

test("换排序视角会把详情页退回列表", () => {
  const ui = createUI(DETAILS);
  ui.openCostLog("requests");
  ui.costLog.selectedIndex = 3;
  key(ui, "return");
  assert.equal(ui.isTurnDetailOpen(), true);
  ui.openCostLog("cost");
  assert.equal(ui.isTurnDetailOpen(), false, "列表换了，停在某个回合里已无意义");
  assert.equal(ui.costLog.sort, "cost");
});

test("滚轮在详情页里移动本轮选中项（与 ↑↓ 同一条通道）", () => {
  const ui = createUI(DETAILS);
  ui.openCostLog("requests");
  ui.costLog.selectedIndex = 3;
  key(ui, "return");
  const before = ui.costLog.turnDetail.selectedIndex;
  ui.handleMouseEvent({ action: "wheel", button: 0, column: 5, row: 5, wheelRows: 1 });
  assert.notEqual(ui.costLog.turnDetail.selectedIndex, before);
});
