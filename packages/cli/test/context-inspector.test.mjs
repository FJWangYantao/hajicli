import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContextInspectorFrame,
  CONTEXT_INSPECTOR_MIN_COLUMNS,
  CONTEXT_INSPECTOR_MIN_ROWS,
  formatInspectorTokens,
} from "../dist/context-inspector.js";
import { terminalWidth } from "../dist/terminal-text.js";

function item(label, tokens, detail = "") {
  return { label, tokens, detail: detail || `${label} 的原文` };
}

function group(category, label, tokens, items) {
  return { category, label, tokens, items };
}

function state(overrides = {}) {
  return {
    groups: [
      group("system", "系统", 18000, [item("系统提示词", 18000, "你是 haji。")]),
      group("tools", "工具", 21000, [item("工具定义 read", 21000)]),
      group("memory", "记忆", 3000, []),
      group("file", "文件", 42000, [
        item("read AGENTS.md", 2100, "正文".repeat(400)),
        item("read turn-runner.ts", 6400),
        item("grep provider", 18000),
      ]),
      group("toolResult", "结果", 28000, [item("bash pnpm test", 28000)]),
      group("conversation", "对话", 12000, [item("用户 #1", 12000)]),
    ],
    categoryIndex: 3,
    selectedIndex: 0,
    scroll: 0,
    ...overrides,
  };
}

test("every row occupies exactly the requested width", () => {
  for (const width of [CONTEXT_INSPECTOR_MIN_COLUMNS, 60, 76, 100, 140]) {
    for (const height of [CONTEXT_INSPECTOR_MIN_ROWS, 12, 24]) {
      const frame = buildContextInspectorFrame(state(), width, height);
      assert.equal(frame.rows.length, height, `${width}x${height} 必须恰好输出 height 行`);
      for (const [index, row] of frame.rows.entries()) {
        assert.equal(
          terminalWidth(row),
          width,
          `${width}x${height} 第 ${index} 行宽度必须是 ${width}`,
        );
      }
    }
  }
});

test("wide layouts draw two columns with the split exactly where the frame says", () => {
  const width = 100;
  const frame = buildContextInspectorFrame(state(), width, 20);
  const splitRow = frame.rows[2];
  assert.ok(splitRow.includes("┬"), "分栏开始的分隔线要在中间留接点");
  assert.equal(
    frame.rows.findIndex((row) => row.includes("┴")),
    3 + (20 - 5),
    "分栏结束的分隔线紧跟在内容区之后",
  );
  assert.equal(frame.listTop, 3, "列表从内容区首行开始");
  assert.equal(frame.listLeft, 1, "列表文本紧贴左边框内侧");
  assert.equal(
    frame.listWidth + 1,
    frame.rows[3].indexOf("│", 1) - 1 + 1,
    "列表宽度与中间竖线一致",
  );
  // 每一行的左右边框必须在第 0 列与最后一列
  for (const [index, row] of frame.rows.entries()) {
    const plain = row.replace(/\x1b\[[0-9;]*m/g, "");
    if (index === 0 || index === frame.rows.length - 1) continue;
    assert.ok(plain.startsWith("│") || plain.startsWith("├"), `第 ${index} 行应以左边框开头`);
    assert.ok(plain.endsWith("│") || plain.endsWith("┤"), `第 ${index} 行应以右边框结尾`);
  }
});

test("narrow terminals fall back to a stacked single column", () => {
  const frame = buildContextInspectorFrame(state(), 60, 20);
  const plain = frame.rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(!plain[2].includes("┬"), "单栏模式没有分栏接点");
  assert.ok(
    plain.some((row) => row.includes("AGENTS.md")),
    "列表仍然可见",
  );
  assert.ok(frame.listWidth > 40, "单栏时列表吃满整行宽度");
});

test("the title names the active category and the item count", () => {
  const frame = buildContextInspectorFrame(state(), 100, 20);
  const title = frame.rows[0].replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(title, /上下文 · 文件 · 3 项/);
  assert.match(title, /Esc 返回/);
  assert.equal(frame.back.row, 0);
  assert.ok(frame.back.left > 80 && frame.back.left + frame.back.width < 100);
});

test("the selected item is marked and scrolled into view", () => {
  const frame = buildContextInspectorFrame(state({ selectedIndex: 2 }), 100, 12);
  const plain = frame.rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
  const marked = plain.find((row) => row.includes("▸"));
  assert.ok(marked, "选中项要有 ▸ 标记");
  assert.match(marked, /grep provider/);
});

test("detail scrolling is clipped to the real content height", () => {
  const tall = state({ selectedIndex: 0, scroll: 9999 });
  const frame = buildContextInspectorFrame(tall, 100, 12);
  assert.ok(frame.maxScroll > 0, "长原文应可滚动");
  const clamped = buildContextInspectorFrame(tall, 100, 12);
  assert.equal(clamped.maxScroll, frame.maxScroll, "同一状态下 maxScroll 稳定");
  const short = buildContextInspectorFrame(state({ selectedIndex: 2 }), 100, 40);
  assert.equal(short.maxScroll, 0, "短原文不需要滚动");
});

test("an empty category renders without items or crashes", () => {
  const frame = buildContextInspectorFrame(state({ categoryIndex: 2 }), 100, 16);
  const plain = frame.rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.match(plain[0], /上下文 · 记忆 · 0 项/);
  assert.ok(plain.join("\n").includes("←→ 切分类"), "空分类只提示切分类");
  assert.equal(frame.maxScroll, 0);
});

test("control sequences inside tool output cannot break the frame", () => {
  const dirty = state({
    categoryIndex: 3,
    selectedIndex: 0,
    groups: state().groups.map((entry) =>
      entry.category === "file"
        ? group("file", "文件", 42000, [
            item("read x", 42000, "\x1b[2J坏掉的清屏\x1b]0;标题\x07正文"),
          ])
        : entry,
    ),
  });
  const frame = buildContextInspectorFrame(dirty, 100, 16);
  for (const row of frame.rows) {
    assert.ok(!row.includes("\x1b[2J"), "清屏序列必须被剥掉");
    assert.ok(!row.includes("\x07"), "BEL 必须被剥掉");
    assert.equal(terminalWidth(row), 100);
  }
});

test("width and height below the minimum are clamped, not overflowed", () => {
  const frame = buildContextInspectorFrame(state(), 10, 3);
  assert.equal(frame.rows.length, CONTEXT_INSPECTOR_MIN_ROWS);
  for (const row of frame.rows) {
    assert.equal(terminalWidth(row), CONTEXT_INSPECTOR_MIN_COLUMNS);
  }
});

test("token formatting matches the sidebar vocabulary", () => {
  assert.equal(formatInspectorTokens(0), "0");
  assert.equal(formatInspectorTokens(999), "999");
  assert.equal(formatInspectorTokens(1200), "1.2k");
  assert.equal(formatInspectorTokens(42000), "42k");
  assert.equal(formatInspectorTokens(1_400_000), "1.4M");
});
