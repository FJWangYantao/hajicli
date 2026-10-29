import assert from "node:assert/strict";
import test from "node:test";

import {
  composeScreenRows,
  liveTailSeparator,
  overlayRightCard,
  placeCard,
  sidebarHitBoxes,
} from "../dist/frame-compose.js";
import { terminalWidth } from "../dist/terminal-text.js";

test("sidebarHitBoxes 换算到屏幕 1 基闭区间并保持 depth 顺序", () => {
  const boxes = sidebarHitBoxes(
    [
      { id: "cost", hit: { left: 0, top: 10, width: 20, height: 3 }, hover: {}, depth: 0 },
      { id: "cost.agent", hit: { left: 2, top: 11, width: 10, height: 1 }, hover: {}, depth: 1 },
    ],
    61,
    3,
  );
  assert.deepEqual(boxes, [
    ["cost", { columnStart: 61, columnEnd: 80, rowStart: 13, rowEnd: 15 }],
    ["cost.agent", { columnStart: 63, columnEnd: 72, rowStart: 14, rowEnd: 14 }],
  ]);
});

test("liveTailSeparator 保证正文与实时区之间恰好空一行", () => {
  assert.equal(liveTailSeparator("正文", "工具"), "\n\n");
  assert.equal(liveTailSeparator("正文\n", "工具"), "\n");
  assert.equal(liveTailSeparator("正文\n\n", "工具"), "");
  assert.equal(liveTailSeparator("", "工具"), "");
  assert.equal(liveTailSeparator("正文", ""), "");
});

test("placeCard 贴着锚点上一行，且不越出对话区", () => {
  assert.equal(placeCard(4, 20, 6), 5);
  assert.equal(placeCard(4, 20, 30), 16, "锚点太靠下时整张卡上移");
  assert.equal(placeCard(4, 20, 0), 0);
  assert.equal(placeCard(30, 20, 5), 0, "卡比对话区高时顶到第一行");
});

test("overlayRightCard 右对齐叠放，行宽不变、其余行原样", () => {
  const rows = ["第一行正文很长很长很长", "第二行", "第三行"];
  const out = overlayRightCard(rows, ["╭卡╮", "╰──╯"], 1, 20);
  assert.equal(out[0], rows[0]);
  assert.equal(terminalWidth(out[1]), 20);
  assert.ok(out[1].endsWith("╭卡╮"));
  assert.ok(out[2].startsWith("第三行") && out[2].endsWith("╰──╯"));
  assert.deepEqual(overlayRightCard(rows, undefined, 0, 20), rows);
});

test("composeScreenRows：有侧栏时每行接竖线并补满高度，无侧栏只截断/补空", () => {
  const plain = composeScreenRows(["a", "b", "c"], 2, 10);
  assert.deepEqual(plain, ["a", "b"]);
  assert.deepEqual(composeScreenRows(["a"], 3, 10), ["a", "", ""]);

  const withSidebar = composeScreenRows(["a", "b"], 4, 10, {
    rows: ["S1", "S2"],
    width: 8,
    screenTop: 1,
  });
  assert.equal(withSidebar.length, 4);
  const widths = new Set(withSidebar.map((row) => terminalWidth(row)));
  assert.equal(widths.size, 1, "每行右边界对齐");
  assert.ok(withSidebar[1].includes("S1"), "侧栏从 screenTop 开始");
  assert.ok(!withSidebar[0].includes("S"));
});
