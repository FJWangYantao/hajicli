import assert from "node:assert/strict";
import test from "node:test";
import { buildContextInspectorFrame } from "../dist/context-inspector.js";
import { buildCostLogFrame } from "../dist/cost-log-page.js";
import { TerminalUI } from "../dist/terminal-input.js";
import { terminalWidth } from "../dist/terminal-text.js";

/**
 * 两个整页视图（上下文详情页 / 费用日志页）的「返回按钮」：
 * 顶栏画成带方括号的强调色按钮，鼠标点它（连同左右各 1 列留白）都能回到对话区。
 * 点击走真实的鼠标报文通道（按下+松开同一行才算一次点击），不只测私有处理方法。
 */
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
  // 只测状态机，不真的重绘。
  ui.scheduleRender = () => {};
  return ui;
}

/**
 * SGR 鼠标左键报文：协议里的行列本身就是 1 基，与命中表（backLeft/backRow）
 * 同一套屏幕坐标，所以原样填进去，不能再 +1。
 */
const press = (column, row) => `\x1b[<0;${column};${row}M`;
const release = (column, row) => `\x1b[<0;${column};${row}m`;

function click(ui, column, row) {
  ui.handleMouseData(Buffer.from(press(column, row)));
  ui.handleMouseData(Buffer.from(release(column, row)));
}

function contextGroups() {
  return [
    {
      category: "file",
      label: "文件",
      tokens: 1200,
      items: [
        { label: "read AGENTS.md", tokens: 800, detail: "# AGENTS.md" },
        { label: "read index.ts", tokens: 400, detail: "export const x = 1;" },
      ],
    },
  ];
}

function costDetails() {
  return [
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
  ];
}

/** 把渲染帧的 back 矩形换算成屏幕坐标，与 TerminalUI 内部的 +1 列偏移保持一致。 */
function screenBack(frame, chatScreenTop) {
  return {
    backRow: chatScreenTop + frame.back.row,
    backLeft: frame.back.left + 1,
    backWidth: frame.back.width,
  };
}

/** 顶栏里的按钮文案实际落在哪一列（帧内 0 基列）。 */
function labelColumn(frame) {
  const top = frame.rows[0].replace(/\x1b\[[0-9;]*m/g, "");
  const label = top.includes("[Esc 返回]") ? "[Esc 返回]" : "[返回]";
  const index = top.indexOf(label);
  assert.ok(index > 0, "顶栏一定要画出返回按钮");
  return { column: terminalWidth(top.slice(0, index)), width: terminalWidth(label) };
}

test("上下文详情页：顶栏按钮与命中区对齐", () => {
  const frame = buildContextInspectorFrame(
    { groups: contextGroups(), categoryIndex: 0, selectedIndex: 0, scroll: 0 },
    100,
    20,
  );
  const label = labelColumn(frame);
  assert.equal(frame.back.row, 0, "按钮在顶栏那一行");
  assert.ok(frame.back.left <= label.column, "命中区包含按钮左侧留白");
  assert.ok(
    frame.back.left + frame.back.width >= label.column + label.width,
    "命中区包含整个按钮文字",
  );
});

test("上下文详情页：鼠标点顶栏返回按钮关闭页面", () => {
  const ui = createUI();
  ui.setContextItemsProvider(contextGroups);
  assert.equal(ui.openContextInspector(), true);

  // 模拟一帧渲染后的命中表：按钮在屏幕第 3 行右侧。
  const frame = buildContextInspectorFrame(
    { groups: contextGroups(), categoryIndex: 0, selectedIndex: 0, scroll: 0 },
    100,
    20,
  );
  ui.contextInspectorHit = {
    ...screenBack(frame, 2),
    listTop: 5,
    listHeight: 10,
    listLeft: 2,
    listWidth: 96,
    listOffset: 0,
  };
  const hit = ui.contextInspectorHit;

  // 按钮范围之外（往左 2 格）不关页面。
  click(ui, hit.backLeft - 2, hit.backRow);
  assert.equal(ui.isContextInspectorOpen(), true, "按钮外点击不关页面");

  click(ui, hit.backLeft, hit.backRow);
  assert.equal(ui.isContextInspectorOpen(), false, "点按钮左边缘也能关");
});

test("费用日志页：鼠标点顶栏返回按钮关闭页面", () => {
  const ui = createUI();
  ui.setCostLogProvider(costDetails);
  assert.equal(ui.openCostLog("cost"), true);

  const frame = buildCostLogFrame(
    { details: costDetails(), sort: "cost", selectedIndex: 0 },
    100,
    20,
  );
  ui.costLogHit = {
    ...screenBack(frame, 2),
    listTop: 4,
    listHeight: 12,
    listLeft: 2,
    listWidth: 96,
    listOffset: 0,
    itemHeight: 1,
  };
  const hit = ui.costLogHit;

  // 按钮文字最右一列也要能点。
  click(ui, hit.backLeft + hit.backWidth - 1, hit.backRow);
  assert.equal(ui.isCostLogOpen(), false);
});

test("窄终端也画得出返回按钮（标题让位，按钮收短）", () => {
  const frame = buildCostLogFrame(
    { details: costDetails(), sort: "cost", selectedIndex: 0 },
    48,
    10,
  );
  const label = labelColumn(frame);
  assert.ok(frame.back.left + frame.back.width <= 48 - 1, "命中区不越过右框线");
  assert.ok(frame.back.left <= label.column && label.column >= 0);
});
