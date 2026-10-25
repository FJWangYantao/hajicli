import assert from "node:assert/strict";
import test from "node:test";

import { FoldStatsCollector } from "../dist/process-fold.js";
import { TerminalUI } from "../dist/terminal-input.js";
import { setActiveColorLevel } from "../dist/theme.js";

setActiveColorLevel("mono");

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (value) => value.replace(ANSI_RE, "");

function restoreProperty(target, name, descriptor) {
  if (descriptor) Object.defineProperty(target, name, descriptor);
  else delete target[name];
}

/** 交互模式的最小 TerminalUI：不碰真实 raw mode / 备屏。 */
function createTerminalUI(columns = 80, rows = 24) {
  const ui = new TerminalUI({
    header: "",
    compactHeader: "",
    inputPrompt: "",
    renderBorder: (width) => "-".repeat(width),
  });
  ui.interactive = true;
  ui.started = true;
  ui.startupHeaderVisible = false;
  ui.sidebarEnabled = false;
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
  Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
  return ui;
}

function cleanupTerminalUI(ui) {
  if (ui.streamRenderTimer) clearTimeout(ui.streamRenderTimer);
  if (ui.protocolFlushTimer) clearTimeout(ui.protocolFlushTimer);
  if (ui.agentPanelTimer) clearInterval(ui.agentPanelTimer);
  if (ui.selectionAutoScrollTimer) clearInterval(ui.selectionAutoScrollTimer);
  if (ui.transientHintTimer) clearTimeout(ui.transientHintTimer);
  ui.streamRenderTimer = null;
  ui.protocolFlushTimer = null;
  ui.agentPanelTimer = null;
  ui.selectionAutoScrollTimer = null;
  ui.transientHintTimer = null;
  ui.started = false;
  ui.interactive = false;
}

/** 在假 stdout 上渲染一帧，返回去掉 ANSI 的屏幕行。 */
function render(ui) {
  const writes = [];
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "write");
  try {
    Object.defineProperty(process.stdout, "write", {
      configurable: true,
      value: (chunk) => {
        writes.push(String(chunk));
        return true;
      },
    });
    ui.renderFrame();
  } finally {
    restoreProperty(process.stdout, "write", descriptor);
  }
  return {
    writes,
    rows: ui.renderedScreenRows.map(stripAnsi),
  };
}

function withUI(columns, rows, callback) {
  const descriptors = {
    columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
    rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
  };
  const ui = createTerminalUI(columns, rows);
  try {
    return callback(ui);
  } finally {
    cleanupTerminalUI(ui);
    restoreProperty(process.stdout, "columns", descriptors.columns);
    restoreProperty(process.stdout, "rows", descriptors.rows);
  }
}

function readStats() {
  const collector = new FoldStatsCollector();
  collector.addTool("read", { path: "src/auth/token.ts" }, "success");
  collector.addTool("edit", { path: "src/auth/token.ts" }, "success");
  return collector.snapshot();
}

const PROMPT = "› 帮我修一下登录 bug\n\n";
const GROUP =
  "  思考 3s · 120 tokens\n\n  ✓ read src/auth/token.ts  12ms\n  ✓ edit src/auth/token.ts  8ms\n\n";
const TAIL = "已完成：问题出在 token 过期判断……\n";

test("sealFoldGroup moves the sealed range out of the tail and reports the shift", () => {
  withUI(80, 24, (ui) => {
    ui.writeLine("› 提问");
    const handle = ui.beginFoldGroup();
    assert.ok(handle, "interactive mode returns a handle");
    assert.equal(handle.start, ui.getChatLength());

    ui.writeLine("  ✓ read src/a.ts  12ms");
    ui.writeLine("  ✓ edit src/a.ts  8ms");
    const end = ui.getChatLength();
    const removed = ui.sealFoldGroup(handle, end, readStats());

    assert.equal(removed, end, "returns the number of characters removed from the tail");
    assert.equal(ui.getChatLength(), 0, "tail now starts empty");

    ui.updateChatFrom(0, "正文");
    assert.equal(ui.chatContent, "正文", "later writes only touch the tail");
  });
});

test("a sealed group collapses to one summary row and expands on demand", () => {
  withUI(80, 24, (ui) => {
    ui.writeChat(PROMPT);
    const handle = ui.beginFoldGroup();
    ui.writeChat(GROUP);
    ui.sealFoldGroup(handle, ui.getChatLength(), readStats());
    ui.writeChat(TAIL);

    const folded = render(ui).rows.join("\n");
    assert.match(folded, /● 读取 1 个文件，编辑 1 个文件/);
    assert.doesNotMatch(folded, /read src\/auth\/token\.ts/);
    assert.match(folded, /已完成：问题出在 token 过期判断/, "body text stays visible");

    ui.dispatchKeypress("\x0f", { ctrl: true, name: "o" });
    const expanded = render(ui).rows.join("\n");
    assert.match(expanded, /read src\/auth\/token\.ts/);
    assert.match(expanded, /思考 3s/, "the original tool block text comes back");
    assert.match(expanded, /● 读取 1 个文件/, "the summary row stays as the segment header");

    ui.dispatchKeypress("\x0f", { ctrl: true, name: "o" });
    assert.doesNotMatch(render(ui).rows.join("\n"), /read src\/auth\/token\.ts/);
  });
});

test("/fold off renders exactly what an unfragmented transcript would", () => {
  const reference = withUI(80, 24, (ui) => {
    ui.writeChat(PROMPT + GROUP + TAIL);
    return render(ui).rows;
  });
  const fragmented = withUI(80, 24, (ui) => {
    ui.writeChat(PROMPT);
    const handle = ui.beginFoldGroup();
    ui.writeChat(GROUP);
    ui.sealFoldGroup(handle, ui.getChatLength(), readStats());
    ui.writeChat(TAIL);
    ui.setFoldEnabled(false);
    return render(ui).rows;
  });
  assert.deepEqual(fragmented, reference, "closing the feature equals today's rendering");
});

test("a stale handle cannot seal after the chat is cleared", () => {
  withUI(80, 24, (ui) => {
    ui.writeLine("旧内容");
    const handle = ui.beginFoldGroup();
    ui.writeLine("旧工具块");
    ui.clearChat();
    assert.equal(ui.sealFoldGroup(handle, 5, readStats()), 0);
    assert.equal(ui.chatContent, "");
  });
});

test("clicking a summary row toggles it; a drag across rows does not", () => {
  withUI(80, 24, (ui) => {
    ui.writeChat(PROMPT);
    const handle = ui.beginFoldGroup();
    ui.writeChat(GROUP);
    ui.sealFoldGroup(handle, ui.getChatLength(), readStats());
    ui.writeChat(TAIL);

    const first = render(ui).rows;
    const summaryIndex = first.findIndex((row) => row.includes("● 读取"));
    assert.ok(summaryIndex >= 0, "summary row is on screen");
    const summaryRow = summaryIndex + 1;

    // 按下与松开都在同一屏幕行 → 切换。
    ui.handleMouseEvent({ action: "down", button: 0, column: 4, row: summaryRow });
    ui.handleMouseEvent({ action: "up", button: 0, column: 4, row: summaryRow });
    assert.match(render(ui).rows.join("\n"), /read src\/auth\/token\.ts/);

    ui.handleMouseEvent({ action: "down", button: 0, column: 4, row: summaryRow });
    ui.handleMouseEvent({ action: "up", button: 0, column: 4, row: summaryRow });
    assert.doesNotMatch(render(ui).rows.join("\n"), /read src\/auth\/token\.ts/);

    // 跨行松开（等于一次拖动）不算单击。
    ui.handleMouseEvent({ action: "down", button: 0, column: 4, row: summaryRow });
    ui.handleMouseEvent({ action: "up", button: 4, column: 4, row: summaryRow + 2 });
    assert.doesNotMatch(render(ui).rows.join("\n"), /read src\/auth\/token\.ts/);
  });
});

test("toggling while scrolled up keeps the summary row in place", () => {
  withUI(80, 16, (ui) => {
    ui.writeChat(Array.from({ length: 20 }, (_, index) => `前文 ${index}\n`).join(""));
    const handle = ui.beginFoldGroup();
    ui.writeChat(GROUP);
    ui.sealFoldGroup(handle, ui.getChatLength(), readStats());
    ui.writeChat(Array.from({ length: 20 }, (_, index) => `正文行 ${index}\n`).join(""));

    render(ui);
    // 翻到中间：摘要行在视口内，但既不贴顶也不贴底。
    ui.chatScrollOffset = Math.floor(ui.maxChatScrollOffset / 2);
    const before = render(ui).rows;
    const summaryIndex = before.findIndex((row) => row.includes("● 读取"));
    assert.ok(summaryIndex >= 0, "summary row is visible after scrolling");

    const summaryRow = summaryIndex + 1;
    ui.handleMouseEvent({ action: "down", button: 0, column: 4, row: summaryRow });
    ui.handleMouseEvent({ action: "up", button: 0, column: 4, row: summaryRow });

    const after = render(ui).rows;
    assert.match(after.join("\n"), /read src\/auth\/token\.ts/, "the segment is now expanded");
    assert.ok(
      after[summaryIndex].includes("● 读取"),
      "the clicked summary row did not jump: " + JSON.stringify(after[summaryIndex]),
    );
  });
});

test("sealed segments are dropped whole once the budget is exceeded", () => {
  withUI(80, 24, (ui) => {
    const chunk = `${"工具块行\n".repeat(4000)}`; // ≈ 20k 字符
    for (let index = 0; index < 12; index += 1) {
      ui.writeChat(chunk);
      const handle = ui.beginFoldGroup();
      ui.writeChat(chunk);
      ui.sealFoldGroup(handle, ui.getChatLength(), readStats());
    }
    const sealed = ui.sealedSegments.reduce((sum, segment) => sum + segment.raw.length, 0);
    assert.ok(sealed + ui.chatContent.length <= 160_000, `budget kept: ${sealed}`);
    assert.ok(ui.sealedSegments.length > 0, "the newest segments survive");
    assert.ok(ui.sealedSegments.length < 24, "old segments were dropped");
  });
});

test("headless mode never folds", () => {
  const ui = new TerminalUI({
    header: "",
    compactHeader: "",
    inputPrompt: "",
    renderBorder: (width) => "-".repeat(width),
  });
  assert.equal(ui.beginFoldGroup(), undefined);
  assert.equal(ui.isInteractive(), false);
});
