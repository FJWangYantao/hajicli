import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScrollbarUpdate,
  computeScrollbarThumb,
  SCROLLBAR_MIN_ROWS,
  SCROLLBAR_THUMB,
  scrollOffsetFromThumbRow,
} from "../dist/scrollbar.js";

const SGR = {
  background: "<bg>",
  thumb: "<thumb>",
  activeThumb: "<active>",
  reset: "<reset>",
};

const MONO_SGR = { background: "", thumb: "", activeThumb: "", reset: "" };

/**
 * 把输出解析成「屏幕格」列表：`\x1b[行;列H` + 颜色 + 内容 + 收尾。
 * 顺序即输出顺序，用于断言「只写了哪些格」。
 */
function parseCells(output, sgr = SGR) {
  const cells = [];
  const pattern = /\x1b\[(\d+);(\d+)H/g;
  let match = pattern.exec(output);
  let previousEnd = 0;
  while (match) {
    const start = match.index + match[0].length;
    const next = pattern.exec(output);
    const end = next ? next.index : output.length;
    const chunk = output.slice(start, end);
    let color = "";
    let body = chunk;
    for (const [seq, name] of [
      [sgr.background, "bg"],
      [sgr.thumb, "thumb"],
      [sgr.activeThumb, "active"],
      [sgr.reset, "reset"],
    ]) {
      if (!seq) continue;
      if (body.includes(seq)) {
        if (name !== "reset") color = name;
        body = body.split(seq).join("");
      }
    }
    cells.push({ row: Number(match[1]), column: Number(match[2]), color, text: body });
    previousEnd = end;
    match = next;
  }
  assert.equal(previousEnd, output.length, "输出末尾不应残留无法解析的内容");
  return cells;
}

test("内容不溢出、视口太矮或参数非法时不出滚动条", () => {
  assert.equal(computeScrollbarThumb({ total: 10, viewport: 10, offset: 0 }), undefined);
  assert.equal(computeScrollbarThumb({ total: 5, viewport: 10, offset: 0 }), undefined);
  assert.equal(
    computeScrollbarThumb({ total: 100, viewport: SCROLLBAR_MIN_ROWS - 1, offset: 0 }),
    undefined,
  );
  assert.equal(computeScrollbarThumb({ total: Number.NaN, viewport: 10, offset: 0 }), undefined);
});

test("thumb 尺寸按可见比例，且始终至少一行、不超过视口", () => {
  // 内容 4 屏：thumb 约占视口 1/4。
  assert.deepEqual(computeScrollbarThumb({ total: 40, viewport: 10, offset: 0 }), {
    top: 7,
    size: 3,
  });
  // 刚超一屏：整屏几乎都是内容，thumb 接近满高，但仍留得下一行轨道。
  const almost = computeScrollbarThumb({ total: 11, viewport: 10, offset: 0 });
  assert.equal(almost.size, 9);
  assert.equal(almost.top, 1);
  // 超长内容：thumb 保底一行。
  const huge = computeScrollbarThumb({ total: 100000, viewport: 20, offset: 0 });
  assert.equal(huge.size, 1);
  assert.ok(huge.top <= 20 - 1);
});

test("偏移两端对齐：贴底在轨道底部，最早期历史在顶部", () => {
  const bottom = computeScrollbarThumb({ total: 100, viewport: 10, offset: 0 });
  assert.equal(bottom.top, 10 - bottom.size);
  const top = computeScrollbarThumb({ total: 100, viewport: 10, offset: 90 });
  assert.equal(top.top, 0);
  // 越界偏移被夹紧，不会画到轨道外。
  assert.deepEqual(computeScrollbarThumb({ total: 100, viewport: 10, offset: 9999 }), top);
  assert.deepEqual(computeScrollbarThumb({ total: 100, viewport: 10, offset: -5 }), bottom);
});

test("拖动反解与正向映射同向：顶行最早期，底行贴底", () => {
  const args = { viewport: 10, thumbSize: 1, maxOffset: 90 };
  assert.equal(scrollOffsetFromThumbRow({ ...args, thumbRow: 0 }), 90);
  assert.equal(scrollOffsetFromThumbRow({ ...args, thumbRow: 9 }), 0);
  // 夹紧：拖出轨道不会越界。
  assert.equal(scrollOffsetFromThumbRow({ ...args, thumbRow: -3 }), 90);
  assert.equal(scrollOffsetFromThumbRow({ ...args, thumbRow: 99 }), 0);
  assert.equal(scrollOffsetFromThumbRow({ ...args, maxOffset: 0 }), 0);
  // thumb 撑满轨道时没有可拖空间。
  assert.equal(
    scrollOffsetFromThumbRow({ thumbRow: 3, viewport: 10, thumbSize: 10, maxOffset: 90 }),
    0,
  );
});

test("没有滚动条可画时零输出", () => {
  assert.equal(
    buildScrollbarUpdate({
      rewrittenRows: new Set(),
      repaintAll: false,
      width: 200,
      height: 60,
      sgr: SGR,
    }),
    "",
  );
});

test("首次出现：整段轨道逐格写出，thumb 行画块符、其余行留空", () => {
  const output = buildScrollbarUpdate({
    next: { column: 80, row: 4, height: 5, thumbRow: 2, thumbSize: 2, active: false },
    rewrittenRows: new Set(),
    repaintAll: false,
    width: 200,
    height: 60,
    sgr: SGR,
  });
  const cells = parseCells(output);
  assert.deepEqual(
    cells.map((cell) => [cell.row, cell.column, cell.text]),
    [
      [5, 80, " "],
      [6, 80, " "],
      [7, 80, SCROLLBAR_THUMB],
      [8, 80, SCROLLBAR_THUMB],
      [9, 80, " "],
    ],
  );
  assert.deepEqual([...new Set(cells.map((cell) => cell.color))], ["bg", "thumb"]);
});

test("几何不变且状态未变：一帧零输出", () => {
  const paint = { column: 80, row: 4, height: 5, thumbRow: 2, thumbSize: 2, active: false };
  assert.equal(
    buildScrollbarUpdate({
      previous: paint,
      next: { ...paint },
      rewrittenRows: new Set(),
      repaintAll: false,
      width: 200,
      height: 60,
      sgr: SGR,
    }),
    "",
  );
});

test("thumb 移动只重写新旧两格（保住增量刷新的开销上限）", () => {
  const previous = { column: 80, row: 4, height: 10, thumbRow: 2, thumbSize: 1, active: false };
  const next = { ...previous, thumbRow: 3 };
  const cells = parseCells(
    buildScrollbarUpdate({
      previous,
      next,
      rewrittenRows: new Set(),
      repaintAll: false,
      width: 200,
      height: 60,
      sgr: SGR,
    }),
  );
  assert.deepEqual(
    cells.map((cell) => [cell.row, cell.text]),
    [
      [7, " "],
      [8, SCROLLBAR_THUMB],
    ],
  );
});

test("被 \\x1b[2K 整行重写过的行会补画 thumb", () => {
  const paint = { column: 80, row: 4, height: 10, thumbRow: 2, thumbSize: 1, active: false };
  const cells = parseCells(
    buildScrollbarUpdate({
      previous: paint,
      next: { ...paint },
      rewrittenRows: new Set([6]),
      repaintAll: false,
      width: 200,
      height: 60,
      sgr: SGR,
    }),
  );
  assert.deepEqual(
    cells.map((cell) => [cell.row, cell.text, cell.color]),
    [[7, SCROLLBAR_THUMB, "thumb"]],
  );
});

test("视口整体滚动或全量刷新时整段重写", () => {
  const paint = { column: 80, row: 0, height: 4, thumbRow: 0, thumbSize: 2, active: false };
  const cells = parseCells(
    buildScrollbarUpdate({
      previous: paint,
      next: { ...paint },
      rewrittenRows: new Set(),
      repaintAll: true,
      width: 200,
      height: 60,
      sgr: SGR,
    }),
  );
  assert.equal(cells.length, 4);
  assert.deepEqual(
    cells.map((cell) => cell.text),
    [SCROLLBAR_THUMB, SCROLLBAR_THUMB, " ", " "],
  );
});

test("列位置变化时清掉旧列的残留格子", () => {
  const previous = { column: 80, row: 0, height: 2, thumbRow: 0, thumbSize: 1, active: false };
  const next = { ...previous, column: 60 };
  const cells = parseCells(
    buildScrollbarUpdate({
      previous,
      next,
      rewrittenRows: new Set(),
      repaintAll: false,
      width: 200,
      height: 60,
      sgr: SGR,
    }),
  );
  assert.deepEqual(
    cells.map((cell) => [cell.column, cell.row, cell.text]),
    [
      [60, 1, SCROLLBAR_THUMB],
      [80, 1, " "],
      [60, 2, " "],
      [80, 2, " "],
    ],
  );
});

test("悬停/拖动换强调色：thumb 全段重画", () => {
  const paint = { column: 80, row: 0, height: 4, thumbRow: 1, thumbSize: 2, active: false };
  const cells = parseCells(
    buildScrollbarUpdate({
      previous: paint,
      next: { ...paint, active: true },
      rewrittenRows: new Set(),
      repaintAll: false,
      width: 200,
      height: 60,
      sgr: SGR,
    }),
  );
  assert.deepEqual(
    cells.map((cell) => [cell.row, cell.text, cell.color]),
    [
      [2, SCROLLBAR_THUMB, "active"],
      [3, SCROLLBAR_THUMB, "active"],
    ],
  );
});

test("滚动条消失时只清掉旧 thumb 格子", () => {
  const previous = { column: 80, row: 0, height: 10, thumbRow: 4, thumbSize: 2, active: false };
  const cells = parseCells(
    buildScrollbarUpdate({
      previous,
      rewrittenRows: new Set(),
      repaintAll: false,
      width: 200,
      height: 60,
      sgr: SGR,
    }),
  );
  assert.deepEqual(
    cells.map((cell) => [cell.row, cell.text]),
    [
      [5, " "],
      [6, " "],
    ],
  );
});

test("屏幕缩小时不写落在屏外的旧轨道格子", () => {
  // 缩窗口后旧列号可能超宽：终端的 CUP 会把它夹到最后一行/列，反而擦掉新帧内容。
  const previous = { column: 120, row: 0, height: 3, thumbRow: 0, thumbSize: 1, active: false };
  const next = { column: 60, row: 0, height: 3, thumbRow: 1, thumbSize: 1, active: false };
  const cells = parseCells(
    buildScrollbarUpdate({
      previous,
      next,
      rewrittenRows: new Set(),
      repaintAll: false,
      width: 80,
      height: 60,
      sgr: SGR,
    }),
  );
  // 旧列 120 在新屏（80 列）之外：那几格一个都不写，只画新轨道。
  assert.deepEqual(
    cells.map((cell) => [cell.column, cell.row, cell.text]),
    [
      [60, 1, " "],
      [60, 2, SCROLLBAR_THUMB],
      [60, 3, " "],
    ],
  );
});

test("无色模式下只有定位与字符，不带任何 SGR", () => {
  const output = buildScrollbarUpdate({
    next: { column: 3, row: 0, height: 2, thumbRow: 0, thumbSize: 1, active: true },
    rewrittenRows: new Set(),
    repaintAll: false,
    width: 200,
    height: 60,
    sgr: MONO_SGR,
  });
  assert.equal(output, `\x1b[1;3H${SCROLLBAR_THUMB}\x1b[2;3H `);
});
