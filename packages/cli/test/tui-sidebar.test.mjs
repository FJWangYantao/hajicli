import assert from "node:assert/strict";
import test from "node:test";
import { TerminalUI } from "../dist/terminal-input.js";
import { terminalWidth } from "../dist/terminal-text.js";
import {
  buildContextCard,
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

test("the hover card breaks the context into labelled categories", () => {
  const rows = buildContextCard(
    {
      system: 7400,
      tools: 3400,
      memory: 2800,
      file: 65_100,
      toolResult: 55_000,
      conversation: 164_000,
    },
    298_000,
    1_000_000,
    30,
  ).map(stripAnsi);
  const text = rows.join("\n");
  assert.match(text, /上下文构成/);
  assert.match(text, /对话 .*164k/);
  assert.match(text, /文件 .*65k/);
  assert.match(text, /结果 .*55k/);
  assert.match(text, /系统 .*7\.4k/);
  assert.match(text, /工具 .*3\.4k/);
  assert.match(text, /记忆 .*2\.8k/);
  assert.match(text, /已用 298,000 \/ 1,000,000/);
  assert.match(text, /剩余 702,000 · 30%/);
  // 边框必须闭合、每行等宽，否则覆盖到对话区时会撕开一排字符。
  const widths = new Set(rows.map((row) => terminalWidth(row)));
  assert.equal(widths.size, 1, "card rows share one width");
  for (const row of rows) {
    assert.match(row, /^[╭│├╰]/);
    assert.match(row, /[╮│┤╯]$/);
  }
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

test("mouse movement over the ring toggles the hover card", () => {
  const ui = createTerminalUI();
  try {
    ui.setContextUsage(250, 1000, {
      system: 100,
      tools: 50,
      memory: 0,
      file: 60,
      toolResult: 0,
      conversation: 40,
    });
    renderPlain(ui);
    const hit = ui.sidebarHits.get("context.ring");
    assert.ok(hit, "ring hit box is recorded");
    assert.equal(ui.sidebarHoverId, undefined);
    assert.ok(!renderPlain(ui).some((row) => row.includes("上下文构成")), "the card starts hidden");

    ui.handleMouseEvent({
      type: "mouse",
      action: "move",
      button: 35,
      column: hit.columnStart + 1,
      row: hit.rowStart + 1,
    });
    assert.equal(ui.sidebarHoverId, "context.ring");
    const hovered = renderPlain(ui).join("\n");
    assert.match(hovered, /上下文构成/);
    assert.match(hovered, /已用 250 \/ 1,000/);

    ui.handleMouseEvent({
      type: "mouse",
      action: "move",
      button: 35,
      column: 1,
      row: 1,
    });
    assert.equal(ui.sidebarHoverId, undefined);
    assert.doesNotMatch(renderPlain(ui).join("\n"), /上下文构成/);
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

/** 六类齐全的一份分项：总量 298k / 1M，与圆环 30% 对齐。 */
const CONTEXT_BREAKDOWN = {
  system: 7400,
  tools: 3400,
  memory: 2800,
  file: 65_100,
  toolResult: 55_000,
  conversation: 164_000,
};

function breakdownState(overrides = {}) {
  return sidebarState({
    usedTokens: 298_000,
    maxTokens: 1_000_000,
    breakdown: CONTEXT_BREAKDOWN,
    ...overrides,
  });
}

test("the sidebar itself carries no breakdown rows", () => {
  const frame = buildSidebarFrame(breakdownState(), 30, 30, 5000);
  assert.ok(frame.ring, "the ring is still drawn");
  const text = frame.rows.map(stripAnsi).join("\n");
  assert.doesNotMatch(text, /对话 164k/, "分类明细不再占用侧栏行");
  assert.match(text, /298k \/ 1\.0M tokens/, "侧栏只留一条总用量");
  // 圆环下方紧跟着就是总用量行，中间没有额外的分类条。
  assert.match(stripAnsi(frame.rows[frame.ring.top + frame.ring.height]), /298k/);
});

test("the hover card is what summarises the breakdown, not the sidebar", () => {
  const card = buildContextCard(CONTEXT_BREAKDOWN, 298_000, 1_000_000, 30).map(stripAnsi);
  const text = card.join("\n");
  assert.match(text, /已用 298,000 \/ 1,000,000/);
  assert.match(text, /对话 .*164k/);
  assert.match(text, /文件 .*65k/);
  assert.match(text, /结果 .*55k/);
  assert.match(text, /系统 .*7\.4k/);
  assert.match(text, /工具 .*3\.4k/);
  assert.match(text, /记忆 .*2\.8k/);
  assert.match(text, /剩余 702,000 · 30%/);
  // 侧栏（含 hover 时）都不再重复这些明细。
  assert.doesNotMatch(
    buildSidebarRows(breakdownState(), 30, 30, 5000, "context.ring").map(stripAnsi).join("\n"),
    /164k/,
  );
});

test("tight terminals keep the cost table because the card is an overlay", () => {
  const rows = buildSidebarRows(breakdownState(), 30, 18, 5000).map(stripAnsi);
  assert.ok(
    rows.some((row) => row.includes("花费")),
    "the cost table stays visible with the breakdown present",
  );
  const hovered = buildSidebarRows(breakdownState(), 30, 18, 5000, "context.ring").map(stripAnsi);
  assert.ok(
    hovered.some((row) => row.includes("花费")),
    "hovering the ring does not steal sidebar rows",
  );
});

test("hovering the ring paints the card over the chat area", () => {
  const ui = createTerminalUI();
  try {
    ui.setContextUsage(298_000, 1_000_000, CONTEXT_BREAKDOWN);
    const before = renderPlain(ui);
    assert.ok(
      !before.some((row) => row.includes("上下文构成")),
      "the card only shows up while hovering",
    );

    const hit = ui.sidebarHits.get("context.ring");
    assert.ok(hit, "ring hit box is recorded");
    ui.handleMouseEvent({
      type: "mouse",
      action: "move",
      button: 35,
      column: hit.columnStart + 1,
      row: hit.rowStart + 1,
    });
    const rows = renderPlain(ui);
    const cardRows = rows.filter((row) => row.includes("上下文构成") || row.includes("对话 █"));
    assert.ok(cardRows.length > 0, "the card is composed into the screen");
    assert.ok(
      rows.some((row) => row.includes("164k")),
      "the card lists the category totals",
    );
    // 卡片落在对话区一侧，侧栏那一列仍然保留。
    assert.ok(
      rows.some((row) => row.includes("│ 上下文")),
      "sidebar stays in place",
    );
  } finally {
    cleanupTerminalUI(ui);
  }
});

test("dragging over the sidebar never starts a text selection", () => {
  const ui = createTerminalUI();
  try {
    const rows = renderPlain(ui);
    assert.ok(rows.length > 0);
    const hit = ui.sidebarHits.get("context.ring");
    assert.ok(hit, "sidebar hit box is recorded");

    ui.handleMouseEvent({
      type: "mouse",
      action: "down",
      button: 0,
      column: hit.columnStart + 1,
      row: hit.rowStart,
    });
    for (let row = hit.rowStart; row < hit.rowStart + 3; row += 1) {
      ui.handleMouseEvent({
        type: "mouse",
        action: "move",
        button: 32,
        column: hit.columnStart + 2,
        row,
      });
    }
    assert.equal(ui.textSelection.active, false, "侧栏不是可复制内容");
    assert.equal(ui.pendingMouseSelection, undefined);

    // 对话区拖选照旧工作，边界只排除侧栏。起点必须落在对话视口内（createTerminalUI 只有一行内容）。
    const chatRow = ui.chatViewport?.screenTop ?? 4;
    ui.handleMouseEvent({ type: "mouse", action: "down", button: 0, column: 6, row: chatRow });
    ui.handleMouseEvent({
      type: "mouse",
      action: "move",
      button: 32,
      column: 20,
      row: chatRow + 1,
    });
    assert.equal(ui.textSelection.active, true, "对话区仍可拖选");
  } finally {
    cleanupTerminalUI(ui);
  }
});

/** 在某个已登记的侧栏区域上做一次完整的按下 + 松开。 */
function clickSidebarRegion(ui, id, rowOffset = 0) {
  const hit = ui.sidebarHits.get(id);
  assert.ok(hit, `${id} 应该有命中区`);
  const column = hit.columnStart + 1;
  const row = hit.rowStart + rowOffset;
  ui.handleMouseEvent({ type: "mouse", action: "down", button: 0, column, row });
  ui.handleMouseEvent({ type: "mouse", action: "up", button: 0, column, row });
}

test("interactive regions carry geometry and a nesting depth", () => {
  const frame = buildSidebarFrame(
    sidebarState({
      hasUnpricedCost: true,
      unpricedModels: ["glm-5.2"],
      pricingAgent: { status: "running", model: "glm-5.2" },
    }),
    30,
    30,
    5000,
  );
  const byId = new Map(frame.regions.map((region) => [region.id, region]));
  for (const id of [
    "context.ring",
    "context.usage",
    "cost.summary",
    "cost.config",
    "cost.pricingAgent",
  ]) {
    assert.ok(byId.has(id), `${id} 应该登记命中区`);
  }
  // depth 升序：命中时从后往前找，深层才压得过包着它的外层。
  const depths = frame.regions.map((region) => region.depth);
  assert.deepEqual(
    depths,
    [...depths].sort((a, b) => a - b),
  );
  assert.ok(byId.get("cost.config").depth > byId.get("cost.summary").depth);
  assert.ok(byId.get("cost.pricingAgent").depth > byId.get("cost.summary").depth);
  // 命中区不能超出真正渲染出来的行，否则鼠标能点到看不见的位置。
  for (const region of frame.regions) {
    assert.ok(region.hit.top + region.hit.height <= frame.rows.length, `${region.id} 越界`);
  }
});

test("hovering a region only recolours rows, never reflows them", () => {
  const state = sidebarState({ hasUnpricedCost: true, unpricedModels: ["glm-5.2"] });
  const plain = buildSidebarRows(state, 30, 30, 5000).map(stripAnsi);
  for (const hoverId of ["context.ring", "context.usage", "cost.summary", "cost.config"]) {
    const hovered = buildSidebarRows(state, 30, 30, 5000, hoverId).map(stripAnsi);
    assert.deepEqual(hovered, plain, `${hoverId} 悬停不该改变文字或行数`);
  }
});

test("nested regions win both the hover and the click", () => {
  const handled = [];
  const ui = createTerminalUI();
  try {
    ui.options.onSidebarAction = (id) => handled.push(id);
    ui.setContextItemsProvider(() => [
      {
        category: "conversation",
        label: "对话",
        tokens: 120,
        items: [{ label: "user: hi", tokens: 120, detail: "hi" }],
      },
    ]);
    ui.setCostInfo(0.02, 2, true, 1200, 340, ["glm-5.2"]);
    ui.setPricingAgentState({ status: "running", model: "glm-5.2" });
    renderPlain(ui);

    // 悬停在「配置单价」行上：拿到的是它自己，而不是外层费用块。
    const config = ui.sidebarHits.get("cost.config");
    assert.ok(config, "配置单价行有命中区");
    ui.handleMouseEvent({
      type: "mouse",
      action: "move",
      button: 35,
      column: config.columnStart,
      row: config.rowStart,
    });
    assert.equal(ui.sidebarHoverId, "cost.config");

    clickSidebarRegion(ui, "cost.config");
    assert.deepEqual(handled, ["cost.config"], "点配置单价行只触发它自己的动作");

    // 「花费」行现在有更深一层的命中区：点它打开“按轮次花费明细”，而不是整块汇总。
    renderPlain(ui);
    clickSidebarRegion(ui, "cost.summary", 1);
    assert.deepEqual(handled, ["cost.config", "cost.turn.cost"], "点花费行打开按轮次花费明细");

    // 点费用块标题（不落在任何指标行上）仍回到整块费用汇总。
    renderPlain(ui);
    clickSidebarRegion(ui, "cost.summary", 0);
    assert.deepEqual(handled, ["cost.config", "cost.turn.cost", "cost.summary"]);

    // 上下文区域由 TerminalUI 自己处理，不经过 onSidebarAction。
    renderPlain(ui);
    clickSidebarRegion(ui, "context.usage");
    assert.equal(ui.isContextInspectorOpen(), true, "点用量行打开上下文详情页");
    assert.deepEqual(handled, ["cost.config", "cost.turn.cost", "cost.summary"]);
  } finally {
    cleanupTerminalUI(ui);
  }
});
