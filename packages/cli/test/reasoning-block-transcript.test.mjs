import assert from "node:assert/strict";
import test from "node:test";

import { ReasoningBlockWriter } from "../dist/cli-runtime.js";
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

/** 交互模式的最小 TerminalUI：不碰真实 raw mode / 备屏（与 process-fold-ui 同一套做法）。 */
function createTerminalUI() {
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
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 80 });
  Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
  return ui;
}

function cleanupTerminalUI(ui) {
  for (const timer of [
    "streamRenderTimer",
    "protocolFlushTimer",
    "agentPanelTimer",
    "selectionAutoScrollTimer",
    "transientHintTimer",
  ]) {
    if (ui[timer]) clearTimeout(ui[timer]);
    ui[timer] = null;
  }
  ui.started = false;
  ui.interactive = false;
}

function render(ui) {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "write");
  try {
    Object.defineProperty(process.stdout, "write", {
      configurable: true,
      value: () => true,
    });
    ui.renderFrame();
  } finally {
    restoreProperty(process.stdout, "write", descriptor);
  }
  return ui.renderedScreenRows.map(stripAnsi).filter((row) => row.trim() !== "");
}

function withUI(callback) {
  const descriptors = {
    columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
    rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
  };
  const ui = createTerminalUI();
  try {
    return callback(ui);
  } finally {
    cleanupTerminalUI(ui);
    restoreProperty(process.stdout, "columns", descriptors.columns);
    restoreProperty(process.stdout, "rows", descriptors.rows);
  }
}

function toolStats() {
  const collector = new FoldStatsCollector();
  collector.addTool("read", { path: "src/auth/token.ts" }, "success");
  collector.addTool("bash", { command: "npm test" }, "success");
  return collector.snapshot();
}

test("思维链写在过程段之前，工具折叠成一行后推理仍然可见", () => {
  withUI((ui) => {
    ui.writeLine("› 帮我修一下登录 bug");
    // 一轮推理：整段写进对话区，正文起点在它下面。
    const reasoning = "先看 token 过期判断，确认是哪一层返回 401。".repeat(2);
    const writer = new ReasoningBlockWriter(ui);
    writer.append(reasoning, true);
    writer.seal(reasoning);

    // 随后的工具调用照旧成段。
    const handle = ui.beginFoldGroup();
    ui.writeLine("  ✓ read src/auth/token.ts  12ms");
    ui.writeLine("  ✓ bash npm test  1.2s");
    ui.writeLine();
    ui.sealFoldGroup(handle, ui.getChatLength(), toolStats());

    const rows = render(ui);
    const text = rows.join("\n");
    // 推理没被折叠吃掉：正文行仍在屏幕上。
    assert.match(text, /· 先看 token 过期判断/);
    // 工具块收成一行摘要，具体调用行不再出现。
    assert.match(text, /读取 1 个文件，运行 1 条命令/);
    assert.doesNotMatch(text, /read src\/auth\/token\.ts/);
    assert.doesNotMatch(text, /bash npm test/);
  });
});

test("思维链写在新一轮过程段之前不会被后续封口吞掉", () => {
  withUI((ui) => {
    // 第一轮：前一段过程（工具）在下一轮请求前收口。
    const first = ui.beginFoldGroup();
    ui.writeLine("  ✓ read src/a.ts  8ms");
    ui.writeLine();
    ui.sealFoldGroup(first, ui.getChatLength(), toolStats());

    // 第二轮推理写在收口之后：它属于正文，不属于任何过程段。
    const reasoning = "读完了，开始改代码。";
    const writer = new ReasoningBlockWriter(ui);
    writer.append(reasoning, true);
    writer.seal(reasoning);

    const rows = render(ui).join("\n");
    assert.match(rows, /读取 1 个文件，运行 1 条命令/);
    assert.match(rows, /· 读完了，开始改代码。/);
  });
});
