import assert from "node:assert/strict";
import test from "node:test";

import { sessionMetrics } from "../../../scripts/ab-metrics.mjs";
import { buildRunPlan, loadTaskPrompts, parseHeadlessOk } from "../../../scripts/ab-run.mjs";

/** 一键 A/B：运行计划交替 arm 抵消顺序效应；指标统计 symbol 调用与提示。 */
test("buildRunPlan：奇数轮正序、偶数轮倒序，覆盖每个任务 × arm", () => {
  const plan = buildRunPlan([5, 7], ["baseline", "symbol"], 2);
  assert.deepEqual(
    plan.map((item) => `${item.round}:${item.task}:${item.arm}`),
    [
      "1:5:baseline",
      "1:5:symbol",
      "1:7:baseline",
      "1:7:symbol",
      "2:5:symbol",
      "2:5:baseline",
      "2:7:symbol",
      "2:7:baseline",
    ],
  );
});

test("loadTaskPrompts：读出历次实验共用的固定任务原文", () => {
  const prompts = loadTaskPrompts();
  for (const task of [5, 7, 10]) {
    assert.equal(typeof prompts.get(task), "string");
    assert.ok(prompts.get(task).length > 10);
  }
});

test("sessionMetrics 统计 read symbol 调用与 grep 回执里的 symbol 提示", () => {
  const metrics = sessionMetrics([
    {
      type: "tool_execution",
      data: {
        name: "grep",
        arguments: { query: "runTurn" },
        output:
          '[提示] a.ts:3 是 fn runTurn 的定义；要看完整定义可直接 read({ path: "a.ts", symbol: "runTurn" })',
      },
    },
    {
      type: "tool_execution",
      data: { name: "read", arguments: { path: "a.ts", symbol: "runTurn" } },
    },
    { type: "tool_execution", data: { name: "read", arguments: { path: "a.ts" } } },
  ]);
  assert.equal(metrics.symbolHints, 1);
  assert.equal(metrics.symbolReads, 1);
});

test("parseHeadlessOk 解析 -p 的多行 JSON 结果", () => {
  const output = `${JSON.stringify({ ok: true, text: "完成" }, null, 2)}\n`;
  assert.equal(parseHeadlessOk(output), true, "缩进排版的 JSON 要整段解析");
  assert.equal(parseHeadlessOk(JSON.stringify({ ok: false }, null, 2)), false);
  assert.equal(parseHeadlessOk("不是 JSON"), false);
});
