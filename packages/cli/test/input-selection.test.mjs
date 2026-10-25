import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInputSelectionGeometry,
  inputCellFromPoint,
  inputRowHighlightSpan,
} from "../dist/input-selection.js";
import { layoutInput } from "../dist/terminal-text.js";

const PROMPT = "› ";
const CONTINUATION = "│ ";

function geometryOf(graphemes, width = 80, maxRows = undefined, rowOffset = 0) {
  const layout = layoutInput(PROMPT, [...graphemes], width, CONTINUATION);
  const rowCount = maxRows ?? (rowOffset > 0 ? layout.rows.length - rowOffset : layout.rows.length);
  return {
    layout,
    geometry: buildInputSelectionGeometry(graphemes, layout, rowCount, rowOffset),
  };
}

test("鼠标列按提示符偏移映射到字符", () => {
  const { geometry } = geometryOf(["a", "b", "c"]);
  // 提示符占 2 列，首字符从第 3 列开始（1-based）。
  assert.deepEqual(
    geometry.positions.map((position) => position.column),
    [3, 4, 5],
  );
  assert.deepEqual(inputCellFromPoint(geometry, 0, 3), { startOffset: 0, endOffset: 1 });
  assert.deepEqual(inputCellFromPoint(geometry, 0, 4), { startOffset: 1, endOffset: 2 });
  // 超出行尾：夹到最后一个字符上。
  assert.deepEqual(inputCellFromPoint(geometry, 0, 99), { startOffset: 2, endOffset: 3 });
  // 落在提示符上：夹到第一个字符。
  assert.deepEqual(inputCellFromPoint(geometry, 0, 1), { startOffset: 0, endOffset: 1 });
});

test("宽字符的两格都映射到同一个字符", () => {
  const { geometry } = geometryOf(["哈", "i"]);
  assert.deepEqual(inputCellFromPoint(geometry, 0, 3), { startOffset: 0, endOffset: 1 });
  assert.deepEqual(inputCellFromPoint(geometry, 0, 4), { startOffset: 0, endOffset: 1 });
  assert.deepEqual(inputCellFromPoint(geometry, 0, 5), { startOffset: 1, endOffset: 2 });
});

test("软换行不插换行符，第二行有自己的行号", () => {
  const { geometry, layout } = geometryOf(["a", "b", "c"], 4);
  assert.deepEqual(layout.rows, ["› ab", "│ c"]);
  assert.equal(geometry.document, "abc");
  assert.equal(geometry.positions[2].row, 1);
  assert.deepEqual(inputCellFromPoint(geometry, 1, 3), { startOffset: 2, endOffset: 3 });
});

test("行被裁掉时按 rowOffset 平移到可见行号", () => {
  const graphemes = ["a", "b", "c"];
  const layout = layoutInput(PROMPT, graphemes, 4, CONTINUATION);
  assert.equal(layout.rows.length, 2);
  const geometry = buildInputSelectionGeometry(graphemes, layout, 1, 1);
  assert.equal(geometry.rowCount, 1);
  assert.deepEqual(
    geometry.positions.map((position) => position.row),
    [-1, -1, 0],
  );
  assert.deepEqual(inputCellFromPoint(geometry, 0, 3), { startOffset: 2, endOffset: 3 });
});

test("高亮区间覆盖选中的字符列，未选中时不给区间", () => {
  const { geometry } = geometryOf(["a", "b", "c"]);
  const selection = { startOffset: 0, endOffset: 2 };
  assert.deepEqual(inputRowHighlightSpan(geometry, selection, 0), {
    startColumn: 3,
    endColumn: 4,
  });
  assert.equal(inputRowHighlightSpan(geometry, selection, 1), undefined);
  assert.equal(inputRowHighlightSpan(geometry, undefined, 0), undefined);
});

test("空输入没有可选的字符", () => {
  const { geometry } = geometryOf([]);
  assert.equal(geometry.document, "");
  assert.equal(inputCellFromPoint(geometry, 0, 3), undefined);
});
