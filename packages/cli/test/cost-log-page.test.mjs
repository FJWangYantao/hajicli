import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCostLogFrame,
  COST_LOG_MIN_COLUMNS,
  COST_LOG_MIN_ROWS,
  formatTokenCount,
  sortRequestDetails,
} from "../dist/cost-log-page.js";
import { CostTracker } from "../dist/cost-tracker.js";
import { terminalWidth } from "../dist/terminal-text.js";

const AT = Date.parse("2024-01-02T03:04:05Z");

function detail(overrides = {}) {
  return {
    seq: 1,
    turn: 1,
    at: AT,
    model: "deepseek-chat",
    purpose: "主线回合",
    promptTokens: 1200,
    cachedPromptTokens: 0,
    completionTokens: 300,
    costCny: 0.001,
    offPeak: false,
    cacheReported: true,
    pricing: { inputPerMTokens: 2, outputPerMTokens: 8 },
    ...overrides,
  };
}

const DETAILS = [
  detail({
    seq: 1,
    turn: 1,
    promptTokens: 12_300,
    cachedPromptTokens: 8_100,
    completionTokens: 2_100,
    costCny: 0.0021,
  }),
  detail({
    seq: 2,
    turn: 2,
    model: "gpt-4o-mini",
    purpose: "压缩",
    promptTokens: 3_100,
    completionTokens: 200,
    costCny: null,
    offPeak: true,
    cacheReported: false,
  }),
  detail({
    seq: 3,
    turn: 2,
    model: "some-very-long-model-name-here",
    purpose: "标题",
    promptTokens: 900,
    completionTokens: 40,
    costCny: 0.0001,
  }),
];

function state(overrides = {}) {
  return { details: DETAILS, sort: "cost", selectedIndex: 0, ...overrides };
}

function plain(frame) {
  return frame.rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
}

test("every row occupies exactly the requested width", () => {
  for (const width of [COST_LOG_MIN_COLUMNS, 60, 76, 100, 140]) {
    for (const height of [COST_LOG_MIN_ROWS, 12, 24]) {
      const frame = buildCostLogFrame(state(), width, height);
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

test("the title names the sort lens and the totals", () => {
  const cost = plain(buildCostLogFrame(state(), 120, 14))[0];
  assert.match(cost, /花费明细/);
  assert.match(cost, /共 3 次请求/);
  assert.match(cost, /1 次未定价/);
  assert.match(cost, /\[Esc 返回\]/);

  const cached = plain(buildCostLogFrame(state({ sort: "cached" }), 120, 14))[0];
  assert.match(cached, /缓存明细/);
});

test("the back button hit box covers its label and stays inside the frame", () => {
  for (const width of [48, 60, 100, 120]) {
    const frame = buildCostLogFrame(state(), width, 12);
    const top = plain(frame)[0];
    // 窄屏按钮收短成 [返回]，但任何宽度都必须画得出来。
    const label = top.includes("[Esc 返回]") ? "[Esc 返回]" : "[返回]";
    const labelStart = top.indexOf(label);
    assert.ok(labelStart > 0, `${width} 列下顶栏要有返回按钮`);
    // 顶栏含宽字符，字符下标不等于显示列，换算成列再比对命中区。
    const labelColumn = terminalWidth(top.slice(0, labelStart));
    assert.equal(frame.back.row, 0);
    assert.ok(frame.back.left <= labelColumn, "命中区要盖住按钮文字的左侧留白");
    assert.ok(
      frame.back.left + frame.back.width >= labelColumn + terminalWidth(label),
      "命中区要盖住整个按钮文字",
    );
    assert.ok(frame.back.left + frame.back.width <= width - 1, "命中区不能越过右框线");
  }
});

test("sortRequestDetails orders by the clicked metric, unpriced last", () => {
  assert.deepEqual(
    sortRequestDetails(DETAILS, "cost").map((row) => row.seq),
    [1, 3, 2],
    "花费降序，未定价排最后",
  );
  assert.deepEqual(
    sortRequestDetails(DETAILS, "input").map((row) => row.seq),
    [1, 2, 3],
  );
  assert.deepEqual(
    sortRequestDetails(DETAILS, "output").map((row) => row.seq),
    [1, 2, 3],
  );
  assert.deepEqual(
    sortRequestDetails(DETAILS, "cached").map((row) => row.seq),
    [1, 2, 3],
    "只有第一条有缓存命中，其余按序号兜底",
  );
  assert.deepEqual(
    sortRequestDetails(DETAILS, "requests").map((row) => row.seq),
    [1, 2, 3],
    "请求视角按时间（序号）正序",
  );
});

test("the sort lens is marked in the header, other columns are not", () => {
  const header = plain(buildCostLogFrame(state({ sort: "input" }), 120, 14))[1];
  assert.match(header, /输入▾/);
  assert.ok(!header.includes("花费▾"));
  const timeHeader = plain(buildCostLogFrame(state({ sort: "requests" }), 120, 14))[1];
  assert.match(timeHeader, /时间▾/);
});

test("unpriced requests never render as a misleading zero", () => {
  const frame = buildCostLogFrame(state({ sort: "cost" }), 120, 14);
  const body = plain(frame).join("\n");
  assert.match(body, /未定价/);
  assert.ok(!body.includes("¥0.0000"), "未定价不能显示成 ¥0.0000");
});

test("the selected request is marked and its full pricing shows in the footer", () => {
  const frame = buildCostLogFrame(state({ selectedIndex: 0 }), 120, 14);
  const rows = plain(frame);
  const marked = rows.filter((row) => row.includes("▸"));
  assert.equal(marked.length, 1, "同时只有一行是选中态");
  assert.match(marked[0], /deepseek-chat/);
  const footer = rows[rows.length - 2];
  assert.match(footer, /第 1 轮/);
  assert.match(footer, /主线回合/);
  assert.match(footer, /缓存命中 66%/);
  assert.match(footer, /输入 ¥2\/M/);
  assert.match(footer, /输出 ¥8\/M/);
});

test("an unpriced model explains how to fix it instead of showing prices", () => {
  const frame = buildCostLogFrame(state({ selectedIndex: 2 }), 120, 14);
  const footer = plain(frame).at(-2);
  assert.match(footer, /未定价/);
  assert.match(footer, /补上单价/);
});

test("缺少缓存上报与零命中是两件事", () => {
  const missing = buildCostLogFrame(state({ selectedIndex: 2 }), 120, 14);
  const footer = plain(missing).at(-2);
  assert.match(footer, /未上报缓存命中/);
  const reported = buildCostLogFrame(state({ selectedIndex: 0 }), 120, 14);
  assert.ok(!plain(reported).at(-2).includes("未上报"));
});

test("long logs scroll to keep the selection visible", () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    detail({ seq: index + 1, costCny: 0.001 * (index + 1) }),
  );
  // 用时间视角（序号正序）检查滚动：选中最后一条时列表必须整体下移。
  const frame = buildCostLogFrame({ details: many, sort: "requests", selectedIndex: 39 }, 120, 16);
  assert.ok(frame.listOffset > 0, "选中最后一条时列表要跟着滚");
  assert.equal(frame.selectedIndex, 39);
  const visible = plain(frame).slice(frame.listTop, frame.listTop + frame.listHeight);
  assert.ok(
    visible.some((row) => row.includes("▸40")),
    "选中的那一条必须在可视区内",
  );
  // 点击换算依赖 listOffset + itemHeight：列表首行应指向 listOffset 对应的请求。
  assert.equal(frame.itemHeight, 1);
  assert.equal(frame.listTop, 2);
  assert.equal(frame.listOffset, 39 - frame.listHeight + 1);
});

test("narrow terminals switch to a two-line layout per request", () => {
  const frame = buildCostLogFrame(state(), COST_LOG_MIN_COLUMNS, 12);
  assert.equal(frame.itemHeight, 2);
  const body = plain(frame);
  assert.ok(
    body.some((row) => row.includes("输入") && row.includes("缓存") && row.includes("输出")),
    "第二行自带数字标签",
  );
  assert.ok(!body[1].includes("┼"), "窄屏没有分栏接点");
});

test("an empty log renders a single explanation instead of crashing", () => {
  const frame = buildCostLogFrame({ details: [], sort: "cost", selectedIndex: 0 }, 100, 12);
  const body = plain(frame).join("\n");
  assert.match(body, /本会话暂无已计费的模型调用/);
  assert.equal(frame.selectedIndex, 0);
  assert.ok(!body.includes("▸"));
});

test("width and height below the minimum are clamped, not overflowed", () => {
  const frame = buildCostLogFrame(state(), 10, 3);
  assert.equal(frame.rows.length, COST_LOG_MIN_ROWS);
  for (const row of frame.rows) {
    assert.equal(terminalWidth(row), COST_LOG_MIN_COLUMNS);
  }
});

test("token formatting matches the sidebar vocabulary", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1200), "1.2k");
  assert.equal(formatTokenCount(42_000), "42k");
  assert.equal(formatTokenCount(1_400_000), "1.4M");
});

test("getRequestDetails 逐条给出金额、单价档与缓存上报情况", () => {
  const tracker = new CostTracker((model) =>
    model === "priced"
      ? { inputPerMTokens: 2, outputPerMTokens: 8, cachedInputPerMTokens: 0.5 }
      : undefined,
  );
  tracker.beginTurn();
  tracker.record(
    "priced",
    {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      prompt_cache_hit_tokens: 400,
    },
    "主线回合",
    AT,
  );
  tracker.beginTurn();
  tracker.record(
    "free",
    { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 },
    "压缩",
    AT,
  );

  const rows = tracker.getRequestDetails();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => [row.seq, row.turn, row.model, row.purpose]),
    [
      [1, 1, "priced", "主线回合"],
      [2, 2, "free", "压缩"],
    ],
  );
  // (600/1e6)*2 + (400/1e6)*0.5 + (500/1e6)*8
  assert.ok(Math.abs(rows[0].costCny - 0.0054) < 1e-9);
  assert.deepEqual(rows[0].pricing, {
    inputPerMTokens: 2,
    outputPerMTokens: 8,
    cachedInputPerMTokens: 0.5,
  });
  assert.equal(rows[0].cacheReported, true);
  assert.equal(rows[1].costCny, null);
  assert.equal(rows[1].pricing, undefined);
  assert.equal(rows[1].cacheReported, false);
});

test("补上单价后历史请求会重新算出金额", () => {
  let priced = false;
  const tracker = new CostTracker(() =>
    priced ? { inputPerMTokens: 1, outputPerMTokens: 1 } : undefined,
  );
  tracker.beginTurn();
  tracker.record(
    "m",
    { prompt_tokens: 1000, completion_tokens: 0, total_tokens: 1000 },
    "主线回合",
    AT,
  );
  assert.equal(tracker.getRequestDetails()[0].costCny, null);
  priced = true;
  assert.ok(Math.abs(tracker.getRequestDetails()[0].costCny - 0.001) < 1e-12);
});

test("loadRecords 保留缓存上报标记，老记录则留空", () => {
  const tracker = new CostTracker();
  tracker.loadRecords([
    {
      model: "m",
      purpose: "主线回合",
      turn: 1,
      at: AT,
      promptTokens: 10,
      cachedPromptTokens: 0,
      completionTokens: 5,
      cacheReported: false,
    },
    {
      model: "m",
      purpose: "主线回合",
      turn: 1,
      at: AT,
      promptTokens: 10,
      cachedPromptTokens: 0,
      completionTokens: 5,
    },
  ]);
  const rows = tracker.getRequestDetails();
  assert.equal(rows[0].cacheReported, false);
  assert.equal(rows[1].cacheReported, undefined);
});
