import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQueueSteerHits,
  buildQueueSteerRows,
  rowSpanAt,
  sidebarRegionAt,
  spanContains,
} from "../dist/pointer-hits.js";

/** 指针命中测试与队列 steer 行的构建（TerminalUI 侧只做动作分发）。 */

const span = (rowStart, rowEnd, columnStart, columnEnd) => ({
  rowStart,
  rowEnd,
  columnStart,
  columnEnd,
});

test("矩形命中：端点算命中，越界不算", () => {
  const rect = span(3, 5, 10, 20);
  assert.equal(spanContains(rect, 10, 3), true);
  assert.equal(spanContains(rect, 20, 5), true);
  assert.equal(spanContains(rect, 15, 4), true);
  assert.equal(spanContains(rect, 9, 4), false);
  assert.equal(spanContains(rect, 21, 4), false);
  assert.equal(spanContains(rect, 15, 2), false);
  assert.equal(spanContains(rect, 15, 6), false);
});

test("侧栏区域：多个区域重叠时取最后登记的那个（深层优先）", () => {
  const hits = new Map([
    ["cost.block", span(4, 12, 100, 140)],
    ["cost.detail", span(6, 6, 100, 140)],
    ["agent.pricing", span(8, 8, 100, 140)],
  ]);
  // 命中「明细」行时，外层整块费用区也在范围里，但明细是后登记的。
  assert.equal(sidebarRegionAt(hits, 110, 6), "cost.detail");
  assert.equal(sidebarRegionAt(hits, 110, 8), "agent.pricing");
  assert.equal(sidebarRegionAt(hits, 110, 10), "cost.block");
  assert.equal(sidebarRegionAt(hits, 99, 10), undefined);
  assert.equal(sidebarRegionAt(new Map(), 110, 10), undefined);
});

test("行内命中段：行号不同不命中，左右端点都算", () => {
  const hits = [
    { row: 7, left: 3, right: 9, index: 0 },
    { row: 8, left: 3, right: 9, index: 1 },
  ];
  assert.equal(rowSpanAt(hits, 3, 7)?.index, 0);
  assert.equal(rowSpanAt(hits, 9, 7)?.index, 0);
  assert.equal(rowSpanAt(hits, 5, 8)?.index, 1);
  assert.equal(rowSpanAt(hits, 5, 6), undefined);
  assert.equal(rowSpanAt(hits, 2, 7), undefined);
  assert.equal(rowSpanAt([], 5, 5), undefined);
});

test("队列行：无排队消息时零行", () => {
  assert.deepEqual(
    buildQueueSteerRows({ queued: [], width: 40, maxItems: 3, steerEnabled: true }),
    [],
  );
  assert.deepEqual(
    buildQueueSteerRows({ queued: ["a"], width: 40, maxItems: 0, steerEnabled: true }),
    [],
  );
});

test("队列行：steer 开关与斜杠命令决定有没有按钮", () => {
  const withSteer = buildQueueSteerRows({
    queued: ["继续", "/model x"],
    width: 60,
    maxItems: 3,
    steerEnabled: true,
  });
  assert.equal(withSteer.length, 3);
  assert.match(withSteer[0], /待发送 \(2 条/);
  assert.match(withSteer[1], /\[steer\] 1\. 继续/);
  // 斜杠命令不给 steer 按钮，但行照排。
  assert.match(withSteer[2], /^ 2\. \/model x/);
  assert.doesNotMatch(withSteer[2], /\[steer\]/);

  const off = buildQueueSteerRows({
    queued: ["继续"],
    width: 60,
    maxItems: 3,
    steerEnabled: false,
  });
  assert.doesNotMatch(off[1], /\[steer\]/);
});

test("队列行：超出上限时追加溢出提示，且只排上限条", () => {
  const rows = buildQueueSteerRows({
    queued: ["a", "b", "c", "d"],
    width: 60,
    maxItems: 2,
    steerEnabled: true,
  });
  assert.equal(rows.length, 4);
  assert.match(rows[3], /Alt\+Q 查看其余消息/);
});

test("steer 命中段：从排好的行反查按钮横向范围并加屏幕行号", () => {
  const queued = ["继续", "再来"];
  const rows = buildQueueSteerRows({ queued, width: 60, maxItems: 3, steerEnabled: true });
  const hits = buildQueueSteerHits({ rows, queued, screenTop: 10 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].row, 11);
  assert.equal(hits[0].index, 0);
  assert.equal(hits[0].text, "继续");
  // 命中段盖住 "[steer]" 这 7 个字符。
  assert.equal(hits[0].right - hits[0].left, 6);
  assert.equal(rowSpanAt(hits, hits[0].left + 1, 11)?.index, 0);
  assert.equal(rowSpanAt(hits, hits[0].left - 1, 11), undefined);
});

test("steer 命中段：没有按钮的行不登记", () => {
  const queued = ["/model x"];
  const rows = buildQueueSteerRows({ queued, width: 60, maxItems: 3, steerEnabled: false });
  assert.deepEqual(buildQueueSteerHits({ rows, queued, screenTop: 1 }), []);
});
