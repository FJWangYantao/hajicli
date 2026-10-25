/**
 * 输入框的鼠标选区几何。
 *
 * 对话区用的是「渲染后的行文档」（AnsiTextLayout）做选区；输入框不能照搬：
 * 每行开头有提示符（`› ` / `│ `）、软换行处不能插入换行符，而且鼠标列必须
 * 反映射回字符下标才能复制原文。所以这里以 layoutInput 的 positions 为准，
 * 建立「字符 → 文档偏移 / 屏幕行与列」的反查表。
 *
 * 纯函数、无 I/O，便于用固定坐标做单元测试。
 */
import type { InputLayout } from "./terminal-text.js";
import { terminalWidth } from "./terminal-text.js";
import type { TextCell } from "./text-selection.js";

/** 输入框选区的几何：文档原文 + 每个字符的位置。 */
export interface InputSelectionGeometry {
  /** 原始输入文本（字符拼接；软换行不插分隔符，与终端显示一致）。 */
  document: string;
  /** 每个字符在 document 中的起止偏移。 */
  cells: TextCell[];
  /** 每个字符所在的可见行与起始列（1-based，列含提示符）。 */
  positions: Array<{ row: number; column: number }>;
  /** 每个字符的显示宽度（宽字符占 2 列）。 */
  widths: number[];
  /** 可见行数。 */
  rowCount: number;
}

/**
 * 建立选区的反查表。
 *
 * rowCount / rowOffset 用于「输入行被裁掉一部分」的情况：layout.positions 是
 * 完整文档的行号，屏幕只显示其中 maxRows 行，因此统一减去 rowOffset 后再比较。
 */
export function buildInputSelectionGeometry(
  graphemes: readonly string[],
  layout: InputLayout,
  rowCount: number,
  rowOffset = 0,
): InputSelectionGeometry {
  const cells: TextCell[] = [];
  const positions: Array<{ row: number; column: number }> = [];
  const widths: number[] = [];
  let document = "";
  for (let index = 0; index < graphemes.length; index += 1) {
    const grapheme = graphemes[index];
    const startOffset = document.length;
    document += grapheme;
    cells.push({ startOffset, endOffset: document.length });
    const position = layout.positions[index] ?? { row: 0, column: 0 };
    // layoutInput 的列是 0-based 光标列（首字符紧跟提示符之后），这里统一换成
    // 鼠标报文的 1-based 屏幕列，两者才能直接比较。
    positions.push({ row: position.row - rowOffset, column: position.column + 1 });
    widths.push(Math.max(1, terminalWidth(grapheme)));
  }
  return { document, cells, positions, widths, rowCount };
}

/**
 * 鼠标坐标 → 字符单元。
 *
 * 同一行内取「起点列 ≤ 当前列」的最后一个字符：点到宽字符的右半格、点到行尾
 * 空白都会落在该行最后一个字符上，拖到行首左侧则落在第一个字符上。
 */
export function inputCellFromPoint(
  geometry: InputSelectionGeometry,
  row: number,
  column: number,
): TextCell | undefined {
  const target = Math.max(0, Math.min(geometry.rowCount - 1, row));
  let first: number | undefined;
  let last: number | undefined;
  let chosen: number | undefined;
  for (let index = 0; index < geometry.positions.length; index += 1) {
    const position = geometry.positions[index];
    if (position.row !== target) continue;
    if (first === undefined) first = index;
    last = index;
    if (position.column <= column) chosen = index;
  }
  const index = chosen ?? first;
  if (index === undefined) return undefined;
  // 列落在行尾之后时仍然选中最后一个字符（clamp），与对话区拖到行尾的行为一致。
  const finalIndex =
    chosen === undefined ? first : column > lastColumnOf(geometry, target) ? last : index;
  return geometry.cells[finalIndex ?? index];
}

function lastColumnOf(geometry: InputSelectionGeometry, row: number): number {
  let last = 0;
  for (let index = 0; index < geometry.positions.length; index += 1) {
    const position = geometry.positions[index];
    if (position.row !== row) continue;
    last = position.column + geometry.widths[index] - 1;
  }
  return last;
}

/**
 * 某一行被选中的列区间（1-based、左右闭合）；没有选中返回 undefined。
 * 选区按字符切分，因此同一行内的命中总是连续的。
 */
export function inputRowHighlightSpan(
  geometry: InputSelectionGeometry,
  selection: { startOffset: number; endOffset: number } | undefined,
  row: number,
): { startColumn: number; endColumn: number } | undefined {
  if (!selection || selection.endOffset <= selection.startOffset) return undefined;
  let startColumn = Number.POSITIVE_INFINITY;
  let endColumn = -1;
  for (let index = 0; index < geometry.positions.length; index += 1) {
    const cell = geometry.cells[index];
    const position = geometry.positions[index];
    if (position.row !== row) continue;
    if (cell.endOffset <= selection.startOffset || cell.startOffset >= selection.endOffset)
      continue;
    startColumn = Math.min(startColumn, position.column);
    endColumn = Math.max(endColumn, position.column + geometry.widths[index] - 1);
  }
  if (endColumn < 0) return undefined;
  return { startColumn, endColumn };
}
