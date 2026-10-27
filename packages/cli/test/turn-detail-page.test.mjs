import assert from "node:assert/strict";
import test from "node:test";

import { terminalWidth } from "../dist/terminal-text.js";
import {
  buildTurnDetailFrame,
  collectTurnDetails,
  TURN_DETAIL_MIN_COLUMNS,
  TURN_DETAIL_MIN_ROWS,
} from "../dist/turn-detail-page.js";

const AT = Date.parse("2024-01-02T03:04:05Z");

/** 去掉 SGR，只留可见文本，方便断言版式。 */
function plain(rows) {
  return rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, ""));
}

function detail(overrides = {}) {
  return {
    turn: 12,
    at: AT,
    model: "deepseek-chat",
    purpose: "主线回合",
    promptTokens: 1000,
    cachedPromptTokens: 0,
    completionTokens: 200,
    costCny: 0.001,
    offPeak: false,
    cacheReported: true,
    pricing: { inputPerMTokens: 2, outputPerMTokens: 8 },
    ...overrides,
  };
}

/** 一轮 4 次调用 + 前后各一轮，用来验证「只挑本轮」。 */
const DETAILS = [
  detail({ seq: 1, turn: 11, costCny: 0.0212 }),
  detail({ seq: 2, turn: 12, purpose: "上下文压缩", promptTokens: 9000, costCny: 0.0012 }),
  detail({ seq: 3, turn: 12, purpose: "标题生成", promptTokens: 1200, costCny: 0.0003 }),
  detail({
    seq: 4,
    turn: 12,
    promptTokens: 12000,
    cachedPromptTokens: 8000,
    completionTokens: 2000,
    costCny: 0.028,
  }),
  detail({ seq: 5, turn: 12, purpose: "子代理", model: "claude-sonnet", costCny: 0.0031 }),
  detail({ seq: 6, turn: 13, costCny: 0.0102 }),
];

test("collectTurnDetails 只挑本轮，并按序号升序", () => {
  const items = collectTurnDetails([...DETAILS].reverse(), 12);
  assert.deepEqual(
    items.map((item) => item.seq),
    [2, 3, 4, 5],
  );
  assert.deepEqual(collectTurnDetails(DETAILS, 99), []);
});

test("整页版式：顶栏按钮、头部摘要、本轮合计、选中标记都在", () => {
  const frame = buildTurnDetailFrame({ details: DETAILS, turn: 12, selectedIndex: 2 }, 100, 24);
  const rows = plain(frame.rows);
  assert.equal(rows.length, 24, "行数严格等于高度");
  assert.match(rows[0], /回合详情 · 第 12 轮/);
  assert.match(rows[0], /\[Esc 返回列表\]/, "顶栏有可点的返回按钮");
  assert.match(rows[1], /第 12 轮 · 4 次调用 · 2 个模型/, "头部只统计本轮");
  assert.match(rows[1], /缓存命中 34%/, "缓存命中率按本轮输入算（8k/23.2k）");
  assert.match(rows.join("\n"), /本轮花费/);
  assert.match(rows.join("\n"), /¥0\.0326/, "本轮合计 = 四次调用之和");
  // 逐次调用一行，只有选中项前面有 ▸。
  const marked = rows.filter((row) => row.includes("▸"));
  assert.equal(marked.length, 1);
  assert.match(marked[0], /#4/);
  assert.doesNotMatch(rows.join("\n"), /#1\s/, "别的轮次不混进来");
});

test("占比按「本次 / 本轮合计」算，未定价项给 —", () => {
  const rows = plain(
    buildTurnDetailFrame({ details: DETAILS, turn: 12, selectedIndex: 0 }, 100, 24).rows,
  ).join("\n");
  assert.match(rows, /86%/, "0.028 / 0.0326 ≈ 86%");

  const unpriced = [
    detail({ seq: 1, turn: 1, costCny: 0.002 }),
    detail({ seq: 2, turn: 1, costCny: null }),
  ];
  const frame = plain(
    buildTurnDetailFrame({ details: unpriced, turn: 1, selectedIndex: 0 }, 100, 24).rows,
  ).join("\n");
  assert.match(frame, /未定价/);
  assert.match(frame, /1 次未定价（补单价后自动重算）/);
});

test("每行宽度严格等于页面宽度（宽屏与窄屏都一样）", () => {
  for (const width of [TURN_DETAIL_MIN_COLUMNS, 60, 75, 76, 100, 140]) {
    const frame = buildTurnDetailFrame({ details: DETAILS, turn: 12, selectedIndex: 1 }, width, 20);
    for (const row of plain(frame.rows)) {
      assert.equal(terminalWidth(row), width, `${width} 列时行长不齐：${row}`);
    }
  }
});

test("窄屏降级：每次调用两行，表格不横向挤压", () => {
  const frame = buildTurnDetailFrame({ details: DETAILS, turn: 12, selectedIndex: 3 }, 48, 20);
  assert.equal(frame.itemHeight, 2);
  const rows = plain(frame.rows);
  assert.match(rows[0], /\[返回\]/, "窄屏按钮收短");
  assert.match(rows[1], /第 12 轮 · 4 次 · 2 模型/, "窄屏头部只留要紧的几项");
  // 两行一组：上行定位，下行给数字。
  const headRow = rows.find((row) => row.includes("▸"));
  assert.ok(headRow && !headRow.includes("输入"), "上行不带数字");
  const index = rows.indexOf(headRow);
  assert.match(rows[index + 1], /输入 .*输出 .*¥.*%/);
});

test("高度不够时先砍「本轮上下文」，仍保住列表与返回按钮", () => {
  const rows = plain(
    buildTurnDetailFrame(
      { details: DETAILS, turn: 12, selectedIndex: 0 },
      100,
      TURN_DETAIL_MIN_ROWS,
    ).rows,
  );
  assert.doesNotMatch(rows.join("\n"), /本轮上下文/, "8 行时放不下上下文小节");
  assert.match(rows.join("\n"), /#2/, "列表仍在");
  assert.match(rows[0], /\[Esc 返回列表\]/);
  assert.equal(rows.length, TURN_DETAIL_MIN_ROWS);
});

test("命中区：列表覆盖调用行，返回按钮不越过右框线", () => {
  const width = 100;
  const frame = buildTurnDetailFrame({ details: DETAILS, turn: 12, selectedIndex: 1 }, width, 24);
  assert.equal(frame.listTop, 5);
  assert.equal(frame.listLeft, 1);
  assert.equal(frame.listWidth, width - 2);
  assert.equal(frame.itemHeight, 1);
  assert.equal(frame.count, 4);

  const back = frame.back;
  assert.equal(back.row, 0);
  assert.ok(back.width > 0);
  assert.ok(back.left + back.width <= width - 1 + 1, "命中区不越过右框线");
  // 命中区要盖住按钮文案本身。
  const labelStart = width - 1 - terminalWidth(" [Esc 返回列表] ");
  assert.ok(back.left <= labelStart, "左侧放宽后仍覆盖按钮起点");
  assert.ok(back.left + back.width >= labelStart + terminalWidth("[Esc 返回列表]"));
});

test("选中项滚出视野时 listOffset 跟随，且不越界", () => {
  const many = Array.from({ length: 30 }, (_, index) =>
    detail({ seq: index + 1, turn: 5, costCny: 0.001 }),
  );
  const frame = buildTurnDetailFrame({ details: many, turn: 5, selectedIndex: 29 }, 100, 20);
  assert.ok(frame.listOffset > 0, "滚到底时列表跟着走");
  assert.ok(frame.listOffset + frame.listHeight <= 30 + frame.listHeight);
  const visible = frame.rows.slice(frame.listTop, frame.listTop + frame.listHeight);
  assert.ok(
    plain(visible).some((row) => row.includes("▸")),
    "选中项永远可见",
  );

  // 下标越界时夹紧到有效范围，回写给调用方。
  const clamped = buildTurnDetailFrame({ details: many, turn: 5, selectedIndex: 999 }, 100, 20);
  assert.equal(clamped.selectedIndex, 29);
});

test("扩展字段：头部给调用耗时，上下文小节给本轮用户问题", () => {
  const withFields = [
    detail({ seq: 1, turn: 5, durationMs: 1200, turnPrompt: "帮我看看返回按钮为什么点不到" }),
    detail({ seq: 2, turn: 5, durationMs: 800 }),
  ];
  const rows = plain(
    buildTurnDetailFrame({ details: withFields, turn: 5, selectedIndex: 0 }, 110, 26).rows,
  );
  assert.match(rows[1], /调用耗时 2\.0s/, "耗时按本轮各次调用求和");
  const joined = rows.join("\n");
  assert.match(joined, /用户问题：帮我看看返回按钮为什么点不到/);
});

test("历史记录没有扩展字段时显示「—」，不显示 0", () => {
  const rows = plain(
    buildTurnDetailFrame({ details: DETAILS, turn: 12, selectedIndex: 0 }, 110, 26).rows,
  );
  assert.match(rows[1], /调用耗时 —/);
  assert.doesNotMatch(rows.join("\n"), /用户问题：/);
});
