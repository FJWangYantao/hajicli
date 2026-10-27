import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRequestDetailFrame,
  REQUEST_DETAIL_MIN_COLUMNS,
  REQUEST_DETAIL_MIN_ROWS,
} from "../dist/request-detail-page.js";
import { terminalWidth } from "../dist/terminal-text.js";

const AT = Date.parse("2025-01-02T03:04:05Z");

function plain(rows) {
  return rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, ""));
}

function detail(overrides = {}) {
  return {
    seq: 37,
    turn: 12,
    at: AT,
    model: "deepseek-chat",
    purpose: "主线回合",
    promptTokens: 12_000,
    cachedPromptTokens: 8000,
    completionTokens: 2000,
    costCny: 0.028,
    offPeak: false,
    cacheReported: true,
    pricing: { inputPerMTokens: 2, outputPerMTokens: 8, cachedInputPerMTokens: 0.5 },
    ...overrides,
  };
}

function render(details, overrides = {}, width = 100, height = 24) {
  return buildRequestDetailFrame(
    { details, turn: 12, selectedIndex: 0, sort: "cost", ...overrides },
    width,
    height,
  );
}

/** 从一行里取最后一个 ¥ 金额（右对齐那一列）。 */
function amountOf(row) {
  const matches = row.match(/¥[\d.]+/g);
  return matches ? matches[matches.length - 1] : undefined;
}

test("费用构成算术闭合：缓存 + 未命中 = 输入小计，输入小计 + 输出 = 合计", () => {
  const rows = plain(render([detail()]).rows);
  const hit = rows.find((row) => row.includes("缓存命中") && row.includes("× ¥"));
  const miss = rows.find((row) => row.includes("└ 未命中"));
  const output = rows.find((row) => row.includes("输出") && row.includes("× ¥"));
  const totalRow = rows.find((row) => row.includes("费用构成")) ?? "";
  assert.ok(hit && miss && output);

  const inputSubtotal = rows.find((row) => row.includes("tokens（缓存"));
  assert.ok(inputSubtotal, "有缓存命中时先给输入小计");

  const num = (text) => Number((text ?? "").replace(/[^\d.]/g, ""));
  assert.ok(
    Math.abs(num(amountOf(inputSubtotal)) - (num(amountOf(hit)) + num(amountOf(miss)))) < 1e-9,
  );
  assert.ok(
    Math.abs(num(amountOf(inputSubtotal)) + num(amountOf(output)) - 0.028) < 1e-9,
    "三项相加要等于合计",
  );
  assert.match(totalRow, /¥0\.0280/, "费用构成标题右侧给合计（取 costCny）");
});

test("没有缓存命中时只画一行输入，不出现空的 └ 分支", () => {
  const rows = plain(render([detail({ cachedPromptTokens: 0, promptTokens: 3000 })]).rows).join(
    "\n",
  );
  assert.match(rows, /输入 {2}3\.0k × ¥2\.00\/M/);
  assert.doesNotMatch(rows, /缓存命中/);
  assert.doesNotMatch(rows, /└ 未命中/);
});

test("扩展记账字段：有值显示真实耗时与推理 token，历史记录显示「—」", () => {
  const withFields = plain(render([detail({ durationMs: 4200, reasoningTokens: 820 })]).rows).join(
    "\n",
  );
  assert.match(withFields, /本次耗时 {2}4\.2s/);
  assert.match(withFields, /推理 {2}820 tokens/);

  const legacy = plain(render([detail()]).rows).join("\n");
  assert.match(legacy, /本次耗时 {2}—/);
  assert.match(legacy, /推理 {2}—/);
  assert.doesNotMatch(legacy, /推理 {2}0 tokens/, "缺字段不能显示成 0");
});

test("身份行给全日期与轮次，未分轮的记录写明", () => {
  const rows = plain(render([detail({ purpose: "上下文压缩" })]).rows);
  assert.match(rows[1], /#37/);
  assert.match(rows[1], /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  assert.match(rows[1], /第 12 轮/);
  assert.match(rows[1], /上下文压缩/);

  const unfiled = plain(render([detail({ turn: 0 })], { turn: 0 }).rows).join("\n");
  assert.match(unfiled, /未分轮/);
});

test("未定价：不编造金额，明确说补单价会重算", () => {
  const rows = plain(render([detail({ costCny: null, pricing: undefined })]).rows).join("\n");
  assert.match(rows, /未定价/);
  assert.match(rows, /无单价信息，补上后自动重算/);
  assert.doesNotMatch(rows, /¥0\.0000/, "未定价不显示成 0 元");
});

test("每行宽度严格等于页面宽度，且高度逐行对齐", () => {
  for (const width of [REQUEST_DETAIL_MIN_COLUMNS, 48, 60, 76, 100, 140]) {
    const frame = render([detail(), detail({ seq: 38 })], {}, width, 20);
    for (const row of plain(frame.rows)) {
      assert.equal(terminalWidth(row), width, `${width} 列时行长不齐：${JSON.stringify(row)}`);
    }
    assert.equal(frame.rows.length, 20, "行数等于高度");
  }
});

test("极矮高度：仍保住费用构成与返回按钮", () => {
  const frame = render([detail()], {}, 100, REQUEST_DETAIL_MIN_ROWS);
  const rows = plain(frame.rows);
  assert.equal(rows.length, REQUEST_DETAIL_MIN_ROWS);
  assert.match(rows[0], /\[Esc 返回回合\]/, "按钮永远在");
  assert.match(rows.join("\n"), /费用构成/, "主角块不被裁");
  assert.match(rows.join("\n"), /输出 {2}2\.0k/, "算术行保留");
  assert.doesNotMatch(rows.join("\n"), /数据口径/, "先砍边缘块");
});

test("命中区只在返回按钮上，且不越过右框线", () => {
  const width = 100;
  const frame = render([detail()], {}, width, 24);
  const painted = plain(frame.rows)[frame.back.row];
  const index = painted.indexOf("[Esc 返回回合]");
  assert.ok(index >= 0);
  const start = terminalWidth(painted.slice(0, index)) + 1;
  assert.ok(frame.back.left <= start, "左边界覆盖按钮起点");
  assert.ok(frame.back.left + frame.back.width - 1 >= start + terminalWidth("[Esc 返回回合]") - 1);
  assert.ok(frame.back.left + frame.back.width <= width, "不越右框线");
});

test("选中下标夹紧，且随回合内列表移动", () => {
  const items = [detail({ seq: 37 }), detail({ seq: 38 }), detail({ seq: 39 })];
  assert.equal(render(items, { selectedIndex: 99 }).selectedIndex, 2);
  assert.equal(render(items, { selectedIndex: -5 }).selectedIndex, 0);
  const second = plain(render(items, { selectedIndex: 1 }).rows)[1];
  assert.match(second, /#38/);
});
