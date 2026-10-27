import assert from "node:assert/strict";
import test from "node:test";

import { TerminalUI } from "../dist/terminal-input.js";
import { terminalWidth } from "../dist/terminal-text.js";

/**
 * 费用页三层（列表 → 回合详情 → 请求详情）走**真实渲染帧**的集成测试：
 * 打开费用列表 → 按 Enter 进回合详情 → 用命中表反推屏幕坐标去点击/按键。
 * 这里验证的是「画出来的位置」和「算出来的命中区」是同一个坐标系，
 * 版式细节由 turn-detail-page.test.mjs 覆盖。
 */
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function restoreProperty(target, name, descriptor) {
  if (descriptor) Object.defineProperty(target, name, descriptor);
  else delete target[name];
}

function withFakeStdout(columns, rows, callback) {
  const target = process.stdout;
  const descriptors = {
    columns: Object.getOwnPropertyDescriptor(target, "columns"),
    rows: Object.getOwnPropertyDescriptor(target, "rows"),
    write: Object.getOwnPropertyDescriptor(target, "write"),
  };
  const writes = [];
  try {
    Object.defineProperty(target, "columns", { configurable: true, value: columns });
    Object.defineProperty(target, "rows", { configurable: true, value: rows });
    Object.defineProperty(target, "write", {
      configurable: true,
      value: (chunk) => {
        writes.push(String(chunk));
        return true;
      },
    });
    return callback(writes);
  } finally {
    restoreProperty(target, "write", descriptors.write);
    restoreProperty(target, "rows", descriptors.rows);
    restoreProperty(target, "columns", descriptors.columns);
  }
}

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
    pricing: { inputPerMTokens: 2, outputPerMTokens: 8, cachedInputPerMTokens: 0.5 },
    ...overrides,
  };
}

const DETAILS = [
  detail(1, { turn: 1, costCny: 0.01 }),
  detail(2, { turn: 1, purpose: "上下文压缩", costCny: 0.02 }),
  detail(3, { turn: 2, purpose: "标题生成", costCny: 0.001 }),
  detail(4, { turn: 2, costCny: 0.03 }),
  detail(5, { turn: 2, purpose: "子代理", costCny: 0.004 }),
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
  ui.started = true;
  ui.startupHeaderVisible = false;
  ui.permissionMode = "default";
  ui.modelName = "test-model";
  ui.reasoningEffort = "low";
  ui.currentPath = "/workspace";
  ui.usedTokens = 250;
  ui.maxTokens = 1000;
  ui.activeInput = {
    prompt: "> ",
    continuationPrompt: "  ",
    graphemes: [],
    cursorIndex: 0,
    sensitive: false,
    slashCommands: [],
    selectedCommandIndex: 0,
    historyNavigationActive: false,
    resolve() {},
    reject() {},
  };
  ui.setCostLogProvider(() => DETAILS);
  return ui;
}

function cleanup(ui) {
  for (const timer of [
    "streamRenderTimer",
    "protocolFlushTimer",
    "agentPanelTimer",
    "selectionAutoScrollTimer",
    "copiedNoticeTimer",
  ]) {
    if (ui[timer]) clearTimeout(ui[timer]);
    ui[timer] = null;
  }
  ui.started = false;
  ui.interactive = false;
}

function render(columns, rows, configure) {
  return withFakeStdout(columns, rows, () => {
    const ui = createUI();
    try {
      configure(ui);
      ui.renderFrame();
      return { ui, plainRows: ui.renderedScreenRows.map((row) => row.replace(ANSI_RE, "")) };
    } finally {
      cleanup(ui);
    }
  });
}

test("按 Enter 后整屏换成回合详情页，顶栏按钮与命中区落在同一处", () => {
  const { ui, plainRows } = render(110, 30, (ui) => {
    ui.openCostLog("requests");
    ui.costLog.selectedIndex = 3; // #4，第 2 轮第 2 次调用
    assert.equal(ui.handleCostLogKey({ name: "return", ctrl: false }), true);
  });

  assert.equal(ui.isTurnDetailOpen(), true);
  assert.ok(
    plainRows.some((row) => row.includes("回合详情 · 第 2 轮")),
    "整屏换成回合详情页",
  );
  const totalRow = plainRows.find((row) => row.includes("本轮花费"));
  assert.ok(totalRow?.includes("¥0.0350"), "本轮合计 = 0.001 + 0.03 + 0.004");
  assert.ok(
    plainRows.some((row) => row.includes("▸#4")),
    "光标落在从列表带过来的那一次调用上",
  );

  const hit = ui.costLogHit;
  assert.ok(hit, "渲染后建好了命中表");
  // 命中区必须盖住画出来的按钮文案。注意：backLeft 是 1 基**显示列**，
  // 顶栏有中文标题，字符下标不能直接当列号用，得先按显示宽度换算。
  const painted = plainRows[hit.backRow - 1];
  const labelIndex = painted.indexOf("[Esc 返回列表]");
  assert.ok(labelIndex >= 0, "按钮确实画在顶栏");
  const labelStart = terminalWidth(painted.slice(0, labelIndex)) + 1;
  const labelEnd = labelStart + terminalWidth("[Esc 返回列表]") - 1;
  assert.ok(hit.backLeft <= labelStart, "命中区左边界覆盖按钮起点");
  assert.ok(hit.backLeft + hit.backWidth - 1 >= labelEnd, "命中区右边界覆盖按钮终点");
});

test("鼠标点顶栏按钮：详情 → 列表（再点一次才关整页）", () => {
  const { ui } = render(110, 30, (ui) => {
    ui.openCostLog("requests");
    ui.costLog.selectedIndex = 3;
    ui.handleCostLogKey({ name: "return", ctrl: false });
  });
  const hit = ui.costLogHit;
  const column = hit.backLeft + 1;

  ui.handleMouseEvent({ action: "down", button: 0, column, row: hit.backRow });
  assert.equal(ui.isTurnDetailOpen(), true, "按下还没松开，不触发");
  ui.handleMouseEvent({ action: "up", button: 0, column, row: hit.backRow });
  assert.equal(ui.isTurnDetailOpen(), false, "点按钮退回列表");
  assert.equal(ui.isCostLogOpen(), true);

  // 回到列表后按钮文案变了（[Esc 返回]），重新渲染再点才关整页。
  ui.renderFrame();
  const listHit = ui.costLogHit;
  ui.handleMouseEvent({
    action: "down",
    button: 0,
    column: listHit.backLeft + 1,
    row: listHit.backRow,
  });
  ui.handleMouseEvent({
    action: "up",
    button: 0,
    column: listHit.backLeft + 1,
    row: listHit.backRow,
  });
  assert.equal(ui.isCostLogOpen(), false);
});

test("鼠标点详情页里的调用行：换选中（不退出页面）", () => {
  const { ui } = render(110, 30, (ui) => {
    ui.openCostLog("requests");
    ui.costLog.selectedIndex = 3;
    ui.handleCostLogKey({ name: "return", ctrl: false });
  });
  const hit = ui.costLogHit;
  // 列表第 0 行 = 本轮第 1 次调用（#3）。
  ui.handleMouseEvent({ action: "down", button: 0, column: hit.listLeft + 2, row: hit.listTop });
  ui.handleMouseEvent({ action: "up", button: 0, column: hit.listLeft + 2, row: hit.listTop });
  assert.equal(ui.costLog.turnDetail.selectedIndex, 0);
  assert.equal(ui.isTurnDetailOpen(), true);
});

test("窄终端（60 列）也能画出来：降级两行、行长不溢出", () => {
  const { ui, plainRows } = render(60, 20, (ui) => {
    ui.openCostLog("requests");
    ui.costLog.selectedIndex = 3;
    ui.handleCostLogKey({ name: "return", ctrl: false });
  });
  assert.equal(ui.isTurnDetailOpen(), true);
  const frameRows = plainRows.filter((row) => /^[╭│├╰]/.test(row.trimStart()));
  assert.ok(frameRows.length >= 10, "页面确实画出来了");
  const widths = new Set(frameRows.map((row) => terminalWidth(row)));
  assert.equal(widths.size, 1, `所有页面行同宽：${[...widths].join(", ")}`);
  const pageWidth = [...widths][0];
  assert.ok(pageWidth >= 40 && pageWidth <= 60, `页面宽度合理：${pageWidth}`);
  assert.ok(
    frameRows.some((row) => row.includes("[返回]")),
    "窄屏按钮收短但仍然可见",
  );
  // 60 列 < 76，菜单降级成两次一行（上限两行/条）：页面行数多于调用条数。
  assert.match(frameRows[1], /第 2 轮 · 3 次/);
});

test("真实按键通道：Enter 进详情、Esc 逐层退回（不触发发送/中止）", () => {
  const { ui } = render(110, 30, (ui) => {
    ui.openCostLog("requests");
    ui.costLog.selectedIndex = 3;
    // 走 handleKeypress（真实分发顺序：上下文页 → 费用页 → 输入框），
    // 确认费用页先接住了这两个键。
    ui.handleKeypress("\r", { name: "return" });
  });
  assert.equal(ui.isTurnDetailOpen(), true, "Enter 被费用页接住，进了回合详情");

  ui.handleKeypress("\x1b", { name: "escape" });
  assert.equal(ui.isTurnDetailOpen(), false, "第一次 Esc 退回列表");
  assert.equal(ui.isCostLogOpen(), true);
  ui.handleKeypress("\x1b", { name: "escape" });
  assert.equal(ui.isCostLogOpen(), false, "第二次 Esc 关整页");
});

test("再按一次 Enter 进请求详情页：命中表只剩返回按钮，列表区域为空", () => {
  const { ui, plainRows } = render(110, 30, (ui) => {
    ui.openCostLog("requests");
    ui.costLog.selectedIndex = 3; // #4，第 2 轮第 2 次调用
    ui.handleCostLogKey({ name: "return", ctrl: false });
    ui.handleCostLogKey({ name: "return", ctrl: false });
  });
  assert.equal(ui.isRequestDetailOpen(), true);
  assert.ok(
    plainRows.some((row) => row.includes("请求详情")),
    "整屏换成请求详情页",
  );
  assert.ok(
    plainRows.some((row) => row.includes("费用构成")),
    "费用的算式是主角",
  );
  assert.ok(
    plainRows.some((row) => row.includes("¥0.0300")),
    "这一次调用的合计（#4 的 costCny）",
  );

  const hit = ui.costLogHit;
  assert.equal(hit.listWidth, 0, "没有列表可点，避免误选");
  const painted = plainRows[hit.backRow - 1];
  const index = painted.indexOf("[Esc 返回回合]");
  assert.ok(index >= 0, "按钮确实画在顶栏");
  const start = terminalWidth(painted.slice(0, index)) + 1;
  assert.ok(hit.backLeft <= start);
  assert.ok(hit.backLeft + hit.backWidth - 1 >= start);

  // 点返回按钮回回合页，整页不关。
  ui.handleMouseEvent({ action: "down", button: 0, column: hit.backLeft + 1, row: hit.backRow });
  ui.handleMouseEvent({ action: "up", button: 0, column: hit.backLeft + 1, row: hit.backRow });
  assert.equal(ui.isRequestDetailOpen(), false);
  assert.equal(ui.isTurnDetailOpen(), true);
  assert.equal(ui.isCostLogOpen(), true);
});

test("请求详情页 ←→ 换调用：重绘后换成另一条记录", () => {
  // 按键与重绘都放在假 stdout 作用域内执行——离开作用域后列宽会回到真实终端。
  const seen = [];
  const { ui } = render(110, 30, (ui) => {
    ui.openCostLog("requests");
    ui.costLog.selectedIndex = 3;
    ui.handleCostLogKey({ name: "return", ctrl: false });
    ui.handleCostLogKey({ name: "return", ctrl: false });
    const identityRow = () =>
      ui.renderedScreenRows
        .map((row) => row.replace(ANSI_RE, ""))
        .find((row) => /#\d+ · .*第 2 轮/.test(row)) ?? "";
    ui.renderFrame();
    seen.push(identityRow());
    ui.handleKeypress("\x1b[C", { name: "right" });
    ui.renderFrame();
    seen.push(identityRow());
  });
  assert.match(seen[0], /#4/);
  assert.match(seen[1], /#5/);
  assert.equal(ui.isRequestDetailOpen(), true, "换调用不退出页面");
});

test("窄屏（60 列）请求详情页行长一致", () => {
  const { ui, plainRows } = render(60, 20, (ui) => {
    ui.openCostLog("requests");
    ui.costLog.selectedIndex = 3;
    ui.handleCostLogKey({ name: "return", ctrl: false });
    ui.handleCostLogKey({ name: "return", ctrl: false });
  });
  assert.equal(ui.isRequestDetailOpen(), true);
  const frameRows = plainRows.filter((row) => /^[╭│├╰]/.test(row.trimStart()));
  const widths = new Set(frameRows.map((row) => terminalWidth(row)));
  assert.equal(widths.size, 1, `所有页面行同宽：${[...widths].join(", ")}`);
});
