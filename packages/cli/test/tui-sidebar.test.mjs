import assert from "node:assert/strict";
import test from "node:test";
import { TerminalUI } from "../dist/terminal-input.js";
import { SEQ, terminalWidth } from "../dist/terminal-text.js";
import {
  resetThemeAppearance,
  setActiveColorLevel,
  setThemeAppearance,
  setThemePreset,
} from "../dist/theme.js";
import {
  buildContextCard,
  buildSidebarFrame,
  buildSidebarRows,
  composeSidebarRow,
  formatTurnDuration,
  resolveSidebarWidth,
  sidebarDensity,
} from "../dist/tui-sidebar.js";

setActiveColorLevel("mono");
setThemePreset("default");
resetThemeAppearance();

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

test("extension status and detail entrances survive compact layouts", () => {
  const extensions = {
    mcp: [
      { name: "good", state: "running", toolCount: 3 },
      { name: "broken", state: "failed", toolCount: 0 },
      { name: "off", state: "disabled", toolCount: 0 },
    ],
    skills: [
      { name: "review", resident: true },
      { name: "old", resident: false },
    ],
  };
  for (const height of [18, 24, 40]) {
    const frame = buildSidebarFrame(sidebarState({ extensions }), 32, height);
    const text = frame.rows.map(stripAnsi).join("\n");
    assert.match(text, /1\/2 就绪 · 1 异常/);
    assert.match(text, /1 已加载/);
    assert.match(text, /上下文/);
    assert.match(text, /费用/);
    assert.ok(frame.regions.some((region) => region.id === "extensions.mcp"));
    assert.ok(frame.regions.some((region) => region.id === "extensions.skills"));
    if (height === 40) assert.ok(text.indexOf("broken") < text.indexOf("good"));
  }
});

test("sidebar only resolves on wide terminals and can be disabled", () => {
  assert.ok(resolveSidebarWidth(120, 30, true) >= 24);
  assert.equal(resolveSidebarWidth(120, 30, false), 0);
  assert.equal(resolveSidebarWidth(80, 24, true), 0, "narrow terminals keep the chat full width");
  assert.equal(resolveSidebarWidth(120, 10, true), 0, "short terminals hide the sidebar");
});

test("sidebar preserves at least 72 columns of reading space", () => {
  for (const preset of ["default", "paper"]) {
    setThemePreset(preset);
    for (let columns = 96; columns <= 160; columns++) {
      const width = resolveSidebarWidth(columns, 24, true);
      if (width) assert.ok(columns - width - 3 - 6 >= 72, `${preset}: ${columns}`);
    }
    assert.equal(resolveSidebarWidth(96, 24, true), 0);
  }
  setThemePreset("default");
});

test("paper sidebar restores its background after styled text resets", () => {
  setActiveColorLevel("truecolor");
  setThemeAppearance("light");
  setThemePreset("paper");
  try {
    const frame = buildSidebarFrame(sidebarState(), 32, 24);
    const row = frame.rows.find((line) => stripAnsi(line).includes("上下文"));
    const rendered = composeSidebarRow("", 0, row, 32);
    assert.match(rendered, /\x1b\[0m\x1b\[38;2;[^m]+m\x1b\[48;2;[^m]+m\x1b\[48;2;238;236;229m/);
    const high = buildSidebarFrame(sidebarState({ usedTokens: 950 }), 32, 24);
    const bar = high.rows.find((line) => line.includes("━"));
    assert.ok(bar.includes(`${SEQ.boldRed}━`), "high usage uses the warning color");
  } finally {
    setActiveColorLevel("mono");
    setThemePreset("default");
    resetThemeAppearance();
  }
});

test("sidebar rows show context, cost, task and agent info", () => {
  const rows = buildSidebarRows(sidebarState(), 30, 30, 5000);
  const text = rows.map(stripAnsi).join("\n");
  assert.match(text, /上下文/);
  assert.match(text, /25%/);
  assert.match(text, /250 \/ 1\.0k tokens/);
  assert.match(text, /费用/);
  assert.match(text, /¥0\.0100/);
  assert.match(text, /▸ 明细/, "费用明细默认折叠成一个开关");
  assert.match(text, /任务 · 渲染/);
  assert.match(text, /代理 1 运行中/);
});

test("the sidebar puts current work above resources and the bill", () => {
  const rows = buildSidebarRows(sidebarState(), 30, 30, 5000).map(stripAnsi);
  const indexOf = (pattern) => rows.findIndex((row) => pattern.test(row));
  const task = indexOf(/^任务 · /);
  const context = indexOf(/^上下文/);
  const cost = indexOf(/^费用/);
  assert.ok(task >= 0 && context >= 0 && cost >= 0, "三块都在");
  assert.ok(task < context, "正在做什么排在资源之前");
  assert.ok(context < cost, "费用排在最后");
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

test("paper sidebar paints a seamless warm surface without the divider", () => {
  setActiveColorLevel("truecolor");
  setThemePreset("paper");
  setThemeAppearance("light");
  try {
    const row = composeSidebarRow("对话内容", 50, "上下文", 30);
    assert.equal(terminalWidth(row), 83);
    assert.doesNotMatch(stripAnsi(row), /│/);
    assert.ok(row.includes("\x1b[48;2;238;236;229m"));
    assert.ok(
      row.includes("\x1b[48;2;243;241;236m \x1b[48;2;242;240;234m \x1b[48;2;240;238;231m "),
      "交界处逐列过渡",
    );
    const frame = buildSidebarFrame(sidebarState(), 30, 30, 5000);
    assert.equal(frame.ring, undefined, "paper uses the prototype bar instead of a ring");
    const text = frame.rows.map(stripAnsi).join("\n");
    assert.match(text, /^ {2}上下文 +25%$/m, "标题与百分比同一行");
    assert.match(text, /^ {2}250 \/ 1\.0k$/m, "数字独立成行且保留内边距");
    assert.match(text, /━+─+/);
    assert.match(text, /费用\n {2}¥0\.0100\n {2}› 查看明细/, "费用金额与入口保持两行节奏");
    assert.match(text, /¥0\.0100/);
    assert.ok(frame.regions.some((region) => region.id === "context.usage" && region.hasCard));
  } finally {
    setThemePreset("default");
    resetThemeAppearance();
    setActiveColorLevel("mono");
  }
});

test("paper sidebar keeps stable work groups and compact resource groups", () => {
  setActiveColorLevel("mono");
  setThemePreset("paper");
  try {
    assert.equal(resolveSidebarWidth(120, 30, true), 34);
    assert.equal(resolveSidebarWidth(160, 30, true), 36);
    const rows = buildSidebarRows(
      sidebarState({ goal: { status: "active", text: "调整布局" } }),
      34,
      30,
      5000,
    ).map(stripAnsi);
    const task = rows.findIndex((row) => row.includes("任务 ·"));
    const context = rows.findIndex((row) => row.includes("上下文"));
    const cost = rows.findIndex((row) => row.includes("费用"));
    assert.equal(rows[task + 1].includes("●"), true);
    assert.equal(rows[context - 1].trim(), "", "当前工作与资源之间留一行");
    assert.equal(rows[cost - 1].trim(), "", "资源与费用之间留一行");
    assert.equal(rows[cost + 1].trim(), "¥0.0100");
    assert.equal(rows[cost + 2].includes("› 查看明细"), true);
  } finally {
    setThemePreset("default");
  }
});

test("paper content is centered with aligned metrics and matching hit areas", () => {
  setActiveColorLevel("mono");
  setThemePreset("paper");
  try {
    for (const width of [30, 34, 36]) {
      for (const maxRows of [14, 24, 40]) {
        for (const costRequests of [0, 3]) {
          const frame = buildSidebarFrame(
            sidebarState({
              taskPlan: undefined,
              agents: undefined,
              costRequests,
            }),
            width,
            maxRows,
            5000,
          );
          const rows = frame.rows.map(stripAnsi);
          const first = rows.findIndex((row) => row.trim());
          const last = rows.findLastIndex((row) => row.trim());
          assert.ok(Math.abs(first - (maxRows - last - 1)) <= 1, "上下留白均衡");
          const inset = rows[first].search(/\S/);
          const usage = frame.regions.find((region) => region.id === "context.usage");
          assert.equal(usage.hit.left, inset);
          assert.ok(rows[usage.hit.top].trim(), "居中后命中区仍覆盖数值行");
          assert.ok(
            Math.abs(inset - (width - usage.hit.left - usage.hit.width)) <= 1,
            "左右留白均衡",
          );
          for (const region of frame.regions) {
            assert.ok(region.hit.top >= first && region.hit.top + region.hit.height <= maxRows);
            assert.ok(region.hit.left + region.hit.width <= width);
          }
          const bar = rows.find((row) => /[━─]/.test(row));
          if (bar) {
            const title = rows.find((row) => row.includes("上下文"));
            assert.equal(bar.search(/\S/), inset);
            assert.equal(terminalWidth(bar), terminalWidth(title), "进度与数值共享右边界");
          }
          const hovered = buildSidebarFrame(
            sidebarState({
              taskPlan: undefined,
              agents: undefined,
              costRequests,
            }),
            width,
            maxRows,
            5000,
            "cost.summary",
          );
          assert.deepEqual(hovered.regions, frame.regions, "悬停不移动命中区");
          assert.ok(frame.rows.every((row) => terminalWidth(row) <= width));
        }
      }
    }
  } finally {
    setThemePreset("default");
  }
});

test("paper sidebar expands costs without changing geometry", () => {
  setActiveColorLevel("mono");
  setThemePreset("paper");
  try {
    const state = sidebarState({ promptTokens: 1200, completionTokens: 340 });
    const folded = buildSidebarFrame(state, 34, 30, 5000);
    const expanded = buildSidebarFrame({ ...state, costDetailsExpanded: true }, 34, 30, 5000);
    assert.equal(expanded.rows.length > folded.rows.length, true);
    assert.ok(expanded.rows.every((row) => terminalWidth(row) <= 34));
    assert.match(expanded.rows.map(stripAnsi).join("\n"), /输入 +↑1\.2k/);
    for (const id of ["context.usage", "cost.detail", "cost.turn.input"]) {
      assert.ok(expanded.regions.some((region) => region.id === id));
    }
  } finally {
    setThemePreset("default");
  }
});

test("paper surfaces, hover and one-shot pulses preserve row geometry", () => {
  setActiveColorLevel("truecolor");
  setThemePreset("paper");
  setThemeAppearance("light");
  try {
    const state = sidebarState({
      goal: { status: "active", text: "调整布局" },
      contextPulseAt: 5000,
      costPulseAt: 5000,
    });
    const frame = buildSidebarFrame(state, 34, 30, 5000);
    assert.ok(frame.surfaces?.some((surface) => surface?.includes("227;224;212")));
    const workIndex = frame.rows.findIndex((row) => stripAnsi(row).includes("当前工作"));
    assert.ok(frame.surfaces?.[workIndex]?.includes("227;224;212"));
    const hover = buildSidebarFrame(state, 34, 30, 5000, "cost.detail");
    const detail = hover.regions.find((region) => region.id === "cost.detail");
    assert.ok(detail && hover.surfaces?.[detail.hit.top]?.includes("217;214;201"));
    assert.deepEqual(hover.rows.map(stripAnsi), frame.rows.map(stripAnsi));
    const settled = buildSidebarFrame(state, 34, 30, 5800);
    const cost = settled.regions.find((region) => region.id === "cost.turn.cost");
    assert.ok(cost && settled.surfaces?.[cost.hit.top] === undefined);
    setActiveColorLevel("mono");
    const mono = buildSidebarFrame(state, 34, 30, 5000);
    assert.ok(mono.surfaces?.every((surface) => surface === "" || surface === undefined));
    assert.doesNotMatch(composeSidebarRow("", 60, mono.rows[0], 34, mono.surfaces?.[0]), /\x1b/);
  } finally {
    setThemePreset("default");
    resetThemeAppearance();
    setActiveColorLevel("mono");
  }
});

test("paper current work is compact and explicit", () => {
  setActiveColorLevel("mono");
  setThemePreset("paper");
  try {
    const text = buildSidebarRows(
      sidebarState({ goal: { status: "active", text: "调整布局" } }),
      34,
      30,
      5000,
    )
      .map(stripAnsi)
      .join("\n");
    assert.match(text, /当前工作/);
    assert.match(text, /● 接入状态 进行中/);
    assert.match(text, /已完成 1 项/);
    assert.doesNotMatch(text, /另有 1 项/);
  } finally {
    setThemePreset("default");
  }
});

test("cost section explains the bill with an input/output token split", () => {
  const text = buildSidebarRows(
    sidebarState({ promptTokens: 1200, completionTokens: 340, costDetailsExpanded: true }),
    30,
    30,
    5000,
  )
    .map(stripAnsi)
    .join("\n");
  assert.match(text, /请求 +3 次/);
  assert.match(text, /输入 +↑1\.2k/);
  assert.match(text, /输出 +↓340/);
});

test("cost details stay folded until the 明细 row is clicked", () => {
  const state = sidebarState({ promptTokens: 1200, completionTokens: 340 });
  const folded = buildSidebarRows(state, 30, 30, 5000).map(stripAnsi).join("\n");
  assert.match(folded, /▸ 明细/);
  assert.doesNotMatch(folded, /输入 +↑1\.2k/, "默认不占行");
  const expanded = buildSidebarRows({ ...state, costDetailsExpanded: true }, 30, 30, 5000)
    .map(stripAnsi)
    .join("\n");
  assert.match(expanded, /▾ 明细/);
  assert.match(expanded, /输入 +↑1\.2k/);
});

test("sidebar reports the last turn duration and compaction count", () => {
  const text = buildSidebarRows(
    sidebarState({ lastTurnMs: 12_400, compactionCount: 2, costDetailsExpanded: true }),
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
    // 明细默认折叠：展开后这些行才出现（与「点 ▸ 明细」同一入口）。
    ui.toggleCostDetailRows();
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
    const hit = ui.sidebarHits.get("context.usage");
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

test("clicking the 明细 row expands cost details in place", () => {
  const ui = createTerminalUI();
  try {
    const handled = [];
    ui.options.onSidebarAction = (id) => handled.push(id);
    ui.setCostInfo(0.02, 2, false, 1200, 340);
    renderPlain(ui);
    assert.ok(!renderPlain(ui).some((row) => /输入 +↑1\.2k/.test(row)), "默认不显示 token 明细");

    clickSidebarRegion(ui, "cost.detail");
    let rows = renderPlain(ui);
    assert.ok(
      rows.some((row) => /输入 +↑1\.2k/.test(row)),
      "展开后就地出现明细行",
    );
    assert.ok(rows.some((row) => row.includes("▾ 明细")));
    assert.deepEqual(handled, [], "明细开关不改宿主动作");

    clickSidebarRegion(ui, "cost.detail");
    rows = renderPlain(ui);
    assert.ok(!rows.some((row) => /输入 +↑1\.2k/.test(row)), "再点一次收回去");
  } finally {
    cleanupTerminalUI(ui);
  }
});

test("long goals, tasks and agents never push context or cost out of view", () => {
  const state = sidebarState({
    goal: {
      status: "active",
      text: "把侧栏的信息层级重做一遍，让当前任务永远优先于账单与统计信息",
    },
    compactionCount: 3,
    taskPlan: {
      title: "重构",
      expanded: false,
      items: Array.from({ length: 9 }, (_, index) => ({
        id: `t${index}`,
        content: `第 ${index} 个任务，内容写得足够长以占据整行`,
        status: index < 4 ? "completed" : index === 5 ? "in_progress" : "pending",
      })),
    },
    agents: Array.from({ length: 6 }, (_, index) => ({
      id: `a${index}`,
      role: "research",
      status: index < 3 ? "running" : "verified",
      totalTokens: 1200,
      startedAt: 0,
    })),
  });
  for (const maxRows of [10, 12, 16, 20, 30]) {
    const rows = buildSidebarRows(state, 30, maxRows, 5000).map(stripAnsi);
    assert.ok(rows.length <= maxRows, `height ${maxRows} 不越界`);
    const text = rows.join("\n");
    assert.match(text, /上下文/, `height ${maxRows} 仍看得到上下文`);
    assert.match(text, /25%/, `height ${maxRows} 仍看得到上下文用量`);
    assert.match(text, /费用/, `height ${maxRows} 仍看得到费用`);
    assert.match(text, /¥0\.0100/, `height ${maxRows} 仍看得到花费`);
  }
});

test("sidebar density steps down with the height budget", () => {
  assert.equal(sidebarDensity(30), "full");
  assert.equal(sidebarDensity(24), "full", "24 行起是满档");
  assert.equal(sidebarDensity(23), "compact");
  assert.equal(sidebarDensity(15), "compact");
  assert.equal(sidebarDensity(14), "minimal", "14 行及以下是最省的一档");
  assert.equal(sidebarDensity(0), "minimal");
});

test("the minimal tier keeps every number and drops only decoration", () => {
  const state = sidebarState({ compactionCount: 2 });
  assert.ok(buildSidebarFrame(state, 30, 30, 5000).ring, "满档画圆环");

  const minimal = buildSidebarFrame(state, 30, 14, 5000);
  assert.equal(minimal.ring, undefined, "最省的一档不画圆环");
  const rows = minimal.rows.map(stripAnsi);
  const text = rows.join("\n");
  assert.match(text, /^上下文$/m);
  assert.ok(
    rows.some((row) => /█|░/.test(row)),
    "退回单行进度条",
  );
  assert.match(text, /250 \/ 1\.0k tokens/, "用量里程数不丢");
  assert.match(text, /任务 · 渲染 {2}1\/2/, "任务标题保留 done/total");
  assert.match(text, /代理 1 运行中/, "代理标题保留运行中计数");
  assert.match(text, /¥0\.0100/, "花费照旧");
  assert.ok(!rows.some((row) => row.includes("⟳ 已压缩")), "圆环都不画了，压缩徽标也不再占行");
  assert.ok(!rows.some((row) => row.includes("拆分侧栏")), "逐条任务让位给标题行");
});

test("the 明细 toggle drops its shortcut hint in a narrow sidebar", () => {
  const wide = buildSidebarRows(sidebarState(), 30, 30, 5000).map(stripAnsi);
  assert.ok(
    wide.some((row) => row.trim() === "▸ 明细 · Ctrl+E"),
    "宽栏把键盘入口写在开关上",
  );
  const narrow = buildSidebarRows(sidebarState(), 16, 30, 5000).map(stripAnsi);
  assert.ok(
    narrow.some((row) => row.trim() === "▸ 明细"),
    "窄栏只留可点的开关本身",
  );
  assert.ok(!narrow.some((row) => row.includes("Ctrl+E")), "提示被整段省掉，而不是截成半截");
});

test("no sidebar row overflows its column at any width", () => {
  const state = sidebarState({
    hasUnpricedCost: true,
    unpricedModels: ["mystery-model"],
    compactionCount: 1,
    goal: { status: "active", text: "把侧栏的信息层级重做一遍，让当前任务优先于账单" },
  });
  for (const width of [12, 14, 16, 18, 20, 24, 30, 34]) {
    const frame = buildSidebarFrame(state, width, 30, 5000);
    for (const row of frame.rows) {
      assert.ok(
        terminalWidth(row) <= width - 1,
        `width ${width}: 「${stripAnsi(row)}」溢出了 ${width - 1} 列的内容宽度`,
      );
    }
    for (const region of frame.regions) {
      assert.ok(
        region.hit.left + region.hit.width <= width,
        `width ${width}: ${region.id} 的命中区超出栏宽`,
      );
    }
  }
});

test("Ctrl+E toggles the cost details from the keyboard", () => {
  const ui = createTerminalUI();
  try {
    ui.setCostInfo(0.02, 2, false, 1200, 340);
    renderPlain(ui);
    assert.ok(!renderPlain(ui).some((row) => /输入 +↑1\.2k/.test(row)), "默认折叠");

    ui.dispatchKeypress("\x05", { ctrl: true, name: "e" });
    let rows = renderPlain(ui);
    assert.ok(
      rows.some((row) => /输入 +↑1\.2k/.test(row)),
      "Ctrl+E 展开明细",
    );
    assert.ok(rows.some((row) => row.includes("▾ 明细 · Ctrl+E")));

    ui.dispatchKeypress("\x05", { ctrl: true, name: "e" });
    rows = renderPlain(ui);
    assert.ok(!rows.some((row) => /输入 +↑1\.2k/.test(row)), "再按一次收回去");
  } finally {
    cleanupTerminalUI(ui);
  }
});

test("Ctrl+E is a no-op before any priced call", () => {
  const ui = createTerminalUI();
  try {
    renderPlain(ui);
    ui.dispatchKeypress("\x05", { ctrl: true, name: "e" });
    assert.equal(ui.costDetailRowsExpanded, false, "没有费用就没有明细可摊开");
  } finally {
    cleanupTerminalUI(ui);
  }
});

test("patrol entry renders one actionable row with a hit region", () => {
  const frame = buildSidebarFrame(
    sidebarState({ patrol: { status: "ready", pending: 2, repo: "owner/repo" } }),
    34,
    32,
  );
  // 窄栏降级成短文案，宽栏保留完整说法：两档都必须是可点的一行。
  assert.match(frame.rows.map(stripAnsi).join("\n"), /▸ 巡检 · 2 个 PR · 巡查/);
  assert.ok(frame.regions.some((region) => region.id === "patrol.entry"));

  const wide = buildSidebarFrame(
    sidebarState({ patrol: { status: "ready", pending: 2, repo: "owner/repo" } }),
    48,
    32,
  );
  assert.match(wide.rows.map(stripAnsi).join("\n"), /PR 巡检 · 2 个 agent PR 待接管 · 点此巡查/);
});

test("patrol entry degrades text and stops being clickable when not actionable", () => {
  // 运行中也可点：点进去看任务列表（启动动作由调用方按状态分流）。
  const running = buildSidebarFrame(
    sidebarState({ patrol: { status: "running", pending: 0, tasks: 3, merged: 1 } }),
    34,
    32,
  );
  assert.match(running.rows.map(stripAnsi).join("\n"), /巡检中 · 3 个任务/);
  assert.ok(running.regions.some((region) => region.id === "patrol.entry"));

  const wideRunning = buildSidebarFrame(
    sidebarState({ patrol: { status: "running", pending: 0, tasks: 3, merged: 1 } }),
    48,
    32,
  );
  assert.match(
    wideRunning.rows.map(stripAnsi).join("\n"),
    /巡检中 · 3 个任务 · 已合并 1 · 点此查看/,
  );
  assert.ok(wideRunning.regions.some((region) => region.id === "patrol.entry"));

  const noToken = buildSidebarFrame(
    sidebarState({ patrol: { status: "no-token", pending: 0 } }),
    34,
    32,
  );
  assert.match(noToken.rows.map(stripAnsi).join("\n"), /需令牌/);
  assert.ok(!noToken.regions.some((region) => region.id === "patrol.entry"));
});

test("patrol entry color encodes state: running amber, pending green, idle muted", () => {
  setActiveColorLevel("truecolor");
  try {
    const patrolRow = (patrol) => {
      const frame = buildSidebarFrame(sidebarState({ patrol }), 40, 32);
      return frame.rows.find((line) => stripAnsi(line).includes("巡检"));
    };
    // 巡检中：橙（主题 yellow 的琥珀橙）。
    assert.ok(patrolRow({ status: "running", pending: 0, tasks: 2 }).includes(SEQ.yellow));
    // 探测到待接管 PR：绿。
    assert.ok(patrolRow({ status: "ready", pending: 2, repo: "owner/repo" }).includes(SEQ.green));
    // 未启动且没活干：灰。
    assert.ok(patrolRow({ status: "ready", pending: 0, repo: "owner/repo" }).includes(SEQ.muted));
    // 缺令牌：橙，和「已就绪但没活干」区分开。
    assert.ok(patrolRow({ status: "no-token", pending: 0 }).includes(SEQ.yellow));
  } finally {
    setActiveColorLevel("mono");
  }
});

test("patrol entry never pushes context or cost out of view", () => {
  for (const height of [18, 20, 24, 32, 40]) {
    const withHint = buildSidebarFrame(
      sidebarState({ patrol: { status: "ready", pending: 1, repo: "owner/repo" } }),
      32,
      height,
    );
    const text = withHint.rows.map(stripAnsi).join("\n");
    assert.match(text, /上下文/, `height ${height}`);
    assert.match(text, /费用/, `height ${height}`);
  }
});

test("patrol entry shows current activity when running", () => {
  const wide = buildSidebarFrame(
    sidebarState({
      patrol: { status: "running", pending: 0, tasks: 3, merged: 1, activity: "#12 审查中 · 3m" },
    }),
    48,
    32,
  );
  assert.match(wide.rows.map(stripAnsi).join("\n"), /巡检中 · #12 审查中 · 3m · 已合并 1/);
  assert.ok(wide.regions.some((region) => region.id === "patrol.entry"));

  const narrow = buildSidebarFrame(
    sidebarState({
      patrol: { status: "running", pending: 0, tasks: 3, activity: "#12 审查中 · 3m" },
    }),
    34,
    32,
  );
  assert.match(narrow.rows.map(stripAnsi).join("\n"), /#12 审查中/);
});
