import assert from "node:assert/strict";
import test from "node:test";
import { TerminalUI } from "../dist/terminal-input.js";
import { terminalWidth } from "../dist/terminal-text.js";
import {
  buildSidebarFrame,
  buildSidebarRows,
  composeSidebarRow,
  formatTurnDuration,
  resolveSidebarWidth,
} from "../dist/tui-sidebar.js";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(value) {
  return value.replace(ANSI_RE, "");
}

function sidebarState(overrides = {}) {
  return {
    usedTokens: 250,
    maxTokens: 1000,
    costCny: 0.01,
    costRequests: 3,
    taskPlan: {
      title: "渲染",
      expanded: false,
      items: [
        { id: "1", content: "拆分侧栏", status: "completed" },
        { id: "2", content: "接入状态", status: "in_progress", startedAt: 0 },
      ],
    },
    agents: [
      {
        id: "a1",
        role: "审阅者",
        status: "running",
        totalTokens: 1200,
        startedAt: 0,
      },
    ],
    ...overrides,
  };
}

test("sidebar only resolves on wide terminals and can be disabled", () => {
  assert.ok(resolveSidebarWidth(120, 30, true) >= 24);
  assert.equal(resolveSidebarWidth(120, 30, false), 0);
  assert.equal(resolveSidebarWidth(80, 24, true), 0, "narrow terminals keep the chat full width");
  assert.equal(resolveSidebarWidth(120, 10, true), 0, "short terminals hide the sidebar");
});

test("sidebar rows show context, cost, task and agent info", () => {
  const rows = buildSidebarRows(sidebarState(), 30, 30, 5000);
  const text = rows.map(stripAnsi).join("\n");
  assert.match(text, /上下文/);
  assert.match(text, /25%/);
  assert.match(text, /250 \/ 1\.0k tokens/);
  assert.match(text, /费用/);
  assert.match(text, /¥0\.0100/);
  assert.match(text, /请求 +3 次/);
  assert.match(text, /任务 · 渲染/);
  assert.match(text, /代理 1 运行中/);
});

test("context ring geometry is exposed and shows the percentage inside", () => {
  const frame = buildSidebarFrame(sidebarState(), 30, 30, 5000);
  assert.ok(frame.ring, "ring geometry is returned");
  assert.ok(frame.ring.width < 30, "ring is narrower than the sidebar");
  const ringRows = frame.rows
    .slice(frame.ring.top, frame.ring.top + frame.ring.height)
    .map(stripAnsi);
  assert.ok(
    ringRows.some((row) => /[\u2800-\u28ff]/.test(row)),
    "braille ring glyphs are drawn",
  );
  assert.ok(
    ringRows.some((row) => row.includes("25%")),
    "percentage sits in the ring centre",
  );
});

test("hovering the context ring reveals exact token counts", () => {
  const normal = buildSidebarRows(sidebarState(), 30, 30, 5000).map(stripAnsi).join("\n");
  const hovered = buildSidebarRows(sidebarState(), 30, 30, 5000, true).map(stripAnsi).join("\n");
  assert.doesNotMatch(normal, /已用/);
  assert.match(hovered, /已用 250 \/ 1,000/);
  assert.match(hovered, /剩余 750 · 25%/);
});

test("sidebar rows are clipped to the height budget", () => {
  const rows = buildSidebarRows(sidebarState(), 30, 5, 5000);
  assert.equal(rows.length, 5);
  assert.match(stripAnsi(rows[0]), /上下文/);
});

test("composed row keeps the exact terminal width", () => {
  const row = composeSidebarRow("对话内容", 50, "右侧信息", 30);
  assert.equal(terminalWidth(row), 50 + 3 + 30);
  assert.match(stripAnsi(row), /对话内容 +│ 右侧信息/);
});

test("cost section explains the bill with an input/output token split", () => {
  const text = buildSidebarRows(
    sidebarState({ promptTokens: 1200, completionTokens: 340 }),
    30,
    30,
    5000,
  )
    .map(stripAnsi)
    .join("\n");
  assert.match(text, /输入 +↑1\.2k/);
  assert.match(text, /输出 +↓340/);
});

test("sidebar reports the last turn duration and compaction count", () => {
  const text = buildSidebarRows(
    sidebarState({ lastTurnMs: 12_400, compactionCount: 2 }),
    30,
    30,
    5000,
  )
    .map(stripAnsi)
    .join("\n");
  assert.match(text, /上一轮 +12\.4s/);
  assert.match(text, /⟳ 已压缩 ×2/);
});

test("the sidebar stays status-only when something is in flight", () => {
  const frame = { phase: "tool", tone: "active", icon: "⠋", label: "bash", elapsed: "3s" };
  const rows = buildSidebarRows(sidebarState({ activity: frame }), 30, 30, 5000).map(stripAnsi);
  assert.ok(!rows.some((row) => row.includes("bash")), "侧栏不显示进行中的活动");
  assert.ok(
    rows.some((row) => row.includes("上下文")),
    "上下文等状态信息照常显示",
  );
});

test("formatTurnDuration keeps short turns at one decimal and long ones in m/s", () => {
  assert.equal(formatTurnDuration(12_400), "12.4s");
  assert.equal(formatTurnDuration(83_000), "1m23s");
});

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
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else delete target[name];
    }
  }
}

function createTerminalUI() {
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
  ui.usedTokens = 250;
  ui.maxTokens = 1000;
  ui.chatContent = "CHAT LINE";
  ui.activeInput = {
    prompt: "> ",
    continuationPrompt: "  ",
    graphemes: [..."INPUT"],
    cursorIndex: 5,
    sensitive: false,
    slashCommands: [],
    selectedCommandIndex: 0,
    historyNavigationActive: false,
    resolve() {},
    reject() {},
  };
  return ui;
}

function cleanupTerminalUI(ui) {
  if (ui.streamRenderTimer) clearTimeout(ui.streamRenderTimer);
  if (ui.protocolFlushTimer) clearTimeout(ui.protocolFlushTimer);
  if (ui.agentPanelTimer) clearInterval(ui.agentPanelTimer);
  if (ui.selectionAutoScrollTimer) clearInterval(ui.selectionAutoScrollTimer);
  ui.streamRenderTimer = null;
  ui.protocolFlushTimer = null;
  ui.agentPanelTimer = null;
  ui.selectionAutoScrollTimer = null;
  ui.started = false;
  ui.interactive = false;
}

function renderPlain(ui, columns = 120, rows = 30) {
  withFakeStdout(columns, rows, () => {
    ui.renderFrame();
  });
  return ui.renderedScreenRows.map(stripAnsi);
}

test("render frame composes the sidebar beside the chat and hides it when disabled", () => {
  const ui = createTerminalUI();
  try {
    ui.setCostInfo(0.02, 2, false);
    const rows = renderPlain(ui);
    assert.ok(
      rows.some((row) => row.includes("│ 上下文")),
      "sidebar appears on the right",
    );
    assert.ok(
      rows.some((row) => row.includes("CHAT LINE")),
      "chat stays on the left",
    );

    ui.setSidebarEnabled(false);
    const without = renderPlain(ui);
    assert.ok(!without.some((row) => row.includes("│ 上下文")), "sidebar can be turned off");
  } finally {
    cleanupTerminalUI(ui);
  }
});

test("mouse movement over the ring toggles the hover detail", () => {
  const ui = createTerminalUI();
  try {
    renderPlain(ui);
    const hit = ui.sidebarRingHit;
    assert.ok(hit, "ring hit box is recorded");
    assert.equal(ui.sidebarRingHovered, false);

    ui.handleMouseEvent({
      type: "mouse",
      action: "move",
      button: 35,
      column: hit.columnStart + 1,
      row: hit.rowStart + 1,
    });
    assert.equal(ui.sidebarRingHovered, true);
    const hovered = renderPlain(ui).join("\n");
    assert.match(hovered, /已用 250 \/ 1,000/);

    ui.handleMouseEvent({
      type: "mouse",
      action: "move",
      button: 35,
      column: 1,
      row: 1,
    });
    assert.equal(ui.sidebarRingHovered, false);
    assert.doesNotMatch(renderPlain(ui).join("\n"), /已用/);
  } finally {
    cleanupTerminalUI(ui);
  }
});

test("terminal ui setters feed the sidebar stat lines", () => {
  const ui = createTerminalUI();
  try {
    ui.setCostInfo(0.02, 2, false, 1200, 340);
    ui.setLastTurnDuration(12_400);
    ui.noteCompaction();
    ui.noteCompaction();
    const text = renderPlain(ui).join("\n");
    assert.match(text, /输入 +↑1\.2k/);
    assert.match(text, /输出 +↓340/);
    assert.match(text, /上一轮 +12\.4s/);
    assert.match(text, /⟳ 已压缩 ×2/);
  } finally {
    cleanupTerminalUI(ui);
  }
});

test("activity stays in the chat column while the sidebar keeps status only", () => {
  const ui = createTerminalUI();
  try {
    ui.activityFrame = {
      phase: "tool",
      tone: "active",
      icon: "⠋",
      label: "bash",
      elapsed: "3s",
      startedAt: Date.now(),
    };
    const rows = renderPlain(ui);
    const hits = rows.filter((row) => row.includes("bash"));
    assert.equal(hits.length, 1, "activity is rendered exactly once");
    const separator = hits[0].indexOf("│");
    assert.ok(
      separator === -1 || hits[0].indexOf("bash") < separator,
      "activity stays left of the sidebar, in the chat column",
    );
    assert.ok(
      rows.some((row) => row.includes("│ 上下文")),
      "the sidebar still shows status information",
    );
  } finally {
    cleanupTerminalUI(ui);
  }
});
