import { tryNativeLayoutAnsiDocument, tryNativeWrapAnsi } from "./native-terminal-engine.js";
import type { TextCell } from "./text-selection.js";
import {
  bgSeq,
  faintHex,
  fgSeq,
  getColorLevel,
  getTheme,
  softAccentHex,
  themeBg,
  themeReset,
} from "./theme.js";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_AT_OFFSET_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/y;
export const ANSI_RESET = "\x1b[0m";
export const boldSeq = (): string => (getColorLevel() === "mono" ? "" : "\x1b[1m");
/** 主题色序列：TUI 界面所有硬编码 ANSI 颜色的统一出口。 */
export const SEQ = {
  get accent() {
    return fgSeq(getTheme().accent);
  },
  get muted() {
    return fgSeq(getTheme().muted);
  },
  get faint() {
    return fgSeq(faintHex());
  },
  get softAccent() {
    return fgSeq(softAccentHex());
  },
  get green() {
    return fgSeq(getTheme().green);
  },
  get yellow() {
    return fgSeq(getTheme().yellow);
  },
  get red() {
    return fgSeq(getTheme().red);
  },
  get blue() {
    return fgSeq(getTheme().blue);
  },
  get cyan() {
    return fgSeq(getTheme().cyan);
  },
  get magenta() {
    return fgSeq(getTheme().magenta);
  },
  get bold() {
    return boldSeq();
  },
  get dim() {
    return getColorLevel() === "mono" ? "" : "\x1b[2m";
  },
  get boldAccent() {
    return boldSeq() + fgSeq(getTheme().accent);
  },
  get boldRed() {
    return boldSeq() + fgSeq(getTheme().red);
  },
  get boldYellow() {
    return boldSeq() + fgSeq(getTheme().yellow);
  },
  get reset() {
    return themeReset();
  },
  get bg() {
    return bgSeq(getTheme().background);
  },
};
const ASCII_ONLY_PATTERN = /^[\x00-\x7f]*$/;
/** 可见宽度缓存：长按帧渲染会对同一批行重复测量，命中率很高。 */
const WIDTH_CACHE_LIMIT = 512;
/** 超过该长度的字符串不入缓存，避免缓存替调用方长期持有整段文档。 */
const WIDTH_CACHE_MAX_LENGTH = 4096;
const widthCache = new Map<string, number>();
const NATIVE_LAYOUT_MIN_LENGTH = 1024;
/** 宽屏默认对话内边距；实际值由响应式布局策略决定。 */
export const DEFAULT_CHAT_PADDING = 3;
const graphemeSegmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

export interface CursorPosition {
  row: number;
  column: number;
}

export interface InputLayout {
  rows: string[];
  positions: CursorPosition[];
}

export interface AnsiLayoutRow {
  ansi: string;
  plain: string;
  startOffset: number;
  endOffset: number;
}

export interface AnsiTextLayout {
  rows: AnsiLayoutRow[];
  document: string;
}

export interface VisibleInputLayout {
  rows: string[];
  cursor: CursorPosition;
}

export function buildScreenUpdate(
  previousRows: readonly string[],
  nextRows: readonly string[],
): string {
  let output = "";
  for (let row = 0; row < nextRows.length; row += 1) {
    if (previousRows[row] === nextRows[row]) continue;
    // 写行前注入主题背景：`\x1b[2K` 清出的区域即为主题背景色
    output += `\x1b[${row + 1};1H${themeBg()}\x1b[2K${nextRows[row]}`;
  }
  return output;
}

/**
 * 使用终端滚动区域移动既有聊天行，只重绘新露出或实际变化的行。
 * scrollRows > 0 表示查看更早历史（屏幕内容向下移动）。
 */
export function buildViewportScrollUpdate(
  previousRows: readonly string[],
  nextRows: readonly string[],
  regionStart: number,
  regionHeight: number,
  scrollRows: number,
): string | undefined {
  const amount = Math.abs(Math.trunc(scrollRows));
  if (
    amount === 0 ||
    amount >= regionHeight ||
    regionStart < 0 ||
    regionHeight <= 0 ||
    previousRows.length !== nextRows.length ||
    regionStart + regionHeight > previousRows.length
  ) {
    return undefined;
  }

  const shiftedRows = [...previousRows];
  if (scrollRows > 0) {
    for (let index = regionHeight - 1; index >= 0; index -= 1) {
      shiftedRows[regionStart + index] =
        index >= amount ? previousRows[regionStart + index - amount] : "";
    }
  } else {
    for (let index = 0; index < regionHeight; index += 1) {
      shiftedRows[regionStart + index] =
        index + amount < regionHeight ? previousRows[regionStart + index + amount] : "";
    }
  }

  const top = regionStart + 1;
  const bottom = regionStart + regionHeight;
  const direction = scrollRows > 0 ? "T" : "S";
  const regionScroll = `\x1b[${top};${bottom}r\x1b[${top};1H${themeBg()}\x1b[${amount}${direction}\x1b[r`;
  return regionScroll + buildScreenUpdate(shiftedRows, nextRows);
}

/** 制表符在此处展开成的固定宽度：任何制表位都不会把逻辑行推出已测量的列宽。 */
export const TAB_WIDTH = 3;

/**
 * 渲染前的文本归一化（源自 pi-tui 的 normalizeTerminalOutput 的 tab 部分）：
 *
 * 制表符的显示宽度取决于终端制表位（通常 8 列），而测量只能按 1 列算，
 * 含 tab 的行会被终端自动折行、撑破已测量的布局；统一展开为固定宽度的空格。
 * ANSI 转义序列内部的字符不受影响。
 *
 * 注：pi-tui 同时会把泰/老挝的 SARA AM（U+0E33 / U+0EB3）拆成两个码位。
 * 这里不做改写：原生 Rust 布局引擎（width 逐码位判定）与 JS 回退实现拆分后
 * 会得出不同列宽，反而让两条渲染路径不一致；保留原字符并让宽度测量把
 * 组合标记计为 0 列，两条路径就都能得到正确结果。
 */
export function normalizeTerminalOutput(value: string): string {
  if (!value.includes("\t")) return value;

  const spaces = " ".repeat(TAB_WIDTH);
  let result = "";
  let offset = 0;
  while (offset < value.length) {
    if (value[offset] === "\x1b") {
      const sequence = ansiSequenceAt(value, offset);
      if (sequence) {
        result += sequence;
        offset += sequence.length;
        continue;
      }
    }
    result += value[offset] === "\t" ? spaces : value[offset];
    offset += 1;
  }
  return result;
}

export function splitGraphemes(value: string): string[] {
  // Most source code and terminal chrome is ASCII. Avoid the considerably
  // heavier Intl.Segmenter path when every UTF-16 code unit is one grapheme.
  if (ASCII_ONLY_PATTERN.test(value)) return value.split("");
  return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
}

function ansiSequenceAt(value: string, offset: number): string | undefined {
  ANSI_AT_OFFSET_PATTERN.lastIndex = offset;
  return ANSI_AT_OFFSET_PATTERN.exec(value)?.[0];
}

function isZeroWidth(codePoint: number): boolean {
  return (
    codePoint === 0x200d ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isWide(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

/**
 * 开头的组合标记（Mn/Me）、格式字符（Cf）与默认可忽略字符：不占列宽。
 * 覆盖手写区间没列全的脚本（泰/老挝、希伯来、阿拉伯变音符等）。
 */
const LEADING_ZERO_WIDTH_PATTERN = /^[\p{Mn}\p{Me}\p{Cf}\p{Default_Ignorable_Code_Point}]+/u;
/** 单个字符是否就是不占列的组合标记（UTF-16 长度 1 的快路径用）。 */
const SINGLE_MARK_PATTERN = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

function measureGrapheme(grapheme: string): number {
  if (grapheme.length === 1) {
    const codePoint = grapheme.charCodeAt(0);
    if (isZeroWidth(codePoint) || SINGLE_MARK_PATTERN.test(grapheme)) return 0;
    return isWide(codePoint) ? 2 : 1;
  }
  // 先剔除开头的组合标记：单独的变音符/尼空词（如泰文 SARA AM 拆分后的 U+0E4D）
  // 不占列，后面接基底字符时按基底字符计宽。
  const visible = grapheme.replace(LEADING_ZERO_WIDTH_PATTERN, "");
  if (visible === "") return 0;
  const codePoints = Array.from(visible, (character) => character.codePointAt(0) ?? 0);
  if (codePoints.every(isZeroWidth)) {
    return 0;
  }
  return codePoints.some(isWide) ? 2 : 1;
}

function measureWidth(value: string): number {
  // 纯 ASCII 且不含 ESC 时，UTF-16 单元数就是显示宽度；跳过 ANSI 正则替换与逐段测量。
  if (value.indexOf("\x1b") === -1 && ASCII_ONLY_PATTERN.test(value)) return value.length;
  return splitGraphemes(value.replace(ANSI_PATTERN, "")).reduce(
    (width, grapheme) => width + measureGrapheme(grapheme),
    0,
  );
}

/**
 * 字符串的终端显示宽度（东亚宽字符占 2 列、ANSI 转义序列占 0 列）。
 * 结果按原始字符串做 LRU 缓存：同一行在多帧之间反复测量时直接命中。
 */
export function terminalWidth(value: string): number {
  if (value.length === 0) return 0;
  const cached = widthCache.get(value);
  if (cached !== undefined) {
    // Map 保持插入顺序：删除后重插即为 LRU 触碰。
    widthCache.delete(value);
    widthCache.set(value, cached);
    return cached;
  }
  const width = measureWidth(value);
  if (value.length <= WIDTH_CACHE_MAX_LENGTH) {
    if (widthCache.size >= WIDTH_CACHE_LIMIT) {
      const oldest = widthCache.keys().next().value;
      if (oldest !== undefined) widthCache.delete(oldest);
    }
    widthCache.set(value, width);
  }
  return width;
}

/** 清空宽度缓存（测试或主题/编码环境变化时使用）。 */
export function clearTerminalWidthCache(): void {
  widthCache.clear();
}

export function highlightAnsiColumns(
  value: string,
  startColumn: number,
  endColumn: number,
): string {
  if (endColumn <= startColumn) {
    return value;
  }

  const selectionOn = "\x1b[7m";
  const selectionOff = "\x1b[27m";
  let result = "";
  let column = 0;
  let offset = 0;
  let highlighted = false;

  while (offset < value.length) {
    if (value[offset] === "\x1b") {
      const sequence = ansiSequenceAt(value, offset);
      if (sequence) {
        result += sequence;
        if (highlighted && /\x1b\[(?:0)?m/.test(sequence)) {
          result += selectionOn;
        }
        offset += sequence.length;
        continue;
      }
    }

    const grapheme = splitGraphemes(value.slice(offset))[0];
    const width = measureGrapheme(grapheme);
    const shouldHighlight = column < endColumn && column + width > startColumn;
    if (shouldHighlight !== highlighted) {
      result += shouldHighlight ? selectionOn : selectionOff;
      highlighted = shouldHighlight;
    }
    result += grapheme;
    column += width;
    offset += grapheme.length;
  }

  if (highlighted) {
    result += selectionOff;
  }
  return result;
}

export function truncateText(value: string, width: number): string {
  let result = "";
  let resultWidth = 0;

  for (const grapheme of splitGraphemes(value)) {
    const graphemeWidth = measureGrapheme(grapheme);
    if (resultWidth + graphemeWidth > width) {
      break;
    }
    result += grapheme;
    resultWidth += graphemeWidth;
  }

  return result;
}

/** 按终端显示宽度截断纯文本，超出时以省略号收尾。 */
export function fitText(value: string, width: number): string {
  if (width <= 0) return "";
  if (terminalWidth(value) <= width) return value;
  return `${truncateText(value, Math.max(0, width - 1))}…`;
}

export function truncateAnsiText(value: string, width: number): string {
  if (width <= 0) return "";
  if (terminalWidth(value) <= width) return value;

  const targetWidth = Math.max(0, width - 1);
  let result = "";
  let resultWidth = 0;
  let offset = 0;
  while (offset < value.length) {
    if (value[offset] === "\x1b") {
      const sequence = ansiSequenceAt(value, offset);
      if (sequence) {
        result += sequence;
        offset += sequence.length;
        continue;
      }
    }
    const grapheme = splitGraphemes(value.slice(offset))[0];
    const graphemeWidth = measureGrapheme(grapheme);
    if (resultWidth + graphemeWidth > targetWidth) break;
    result += grapheme;
    resultWidth += graphemeWidth;
    offset += grapheme.length;
  }
  return `${result}${SEQ.reset}…`;
}

export function truncateTailText(value: string, width: number): string {
  if (width <= 0) return "";
  if (terminalWidth(value) <= width) return value;
  if (width === 1) return "…";

  const graphemes = splitGraphemes(value);
  let suffix = "";
  let suffixWidth = 0;
  for (let index = graphemes.length - 1; index >= 0; index -= 1) {
    const grapheme = graphemes[index];
    const graphemeWidth = measureGrapheme(grapheme);
    if (suffixWidth + graphemeWidth > width - 1) break;
    suffix = grapheme + suffix;
    suffixWidth += graphemeWidth;
  }
  return `…${suffix}`;
}

export function buildLabeledDivider(width: number, label: string): string {
  if (width <= 0) return "";
  const visibleLabel = truncateText(label, Math.max(1, width - 2));
  const labelWidth = terminalWidth(visibleLabel);
  if (labelWidth + 2 >= width)
    return `${SEQ.muted}${truncateText(visibleLabel, width)}${SEQ.reset}`;
  const remaining = width - labelWidth - 2;
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return `${SEQ.muted}${"─".repeat(left)} ${visibleLabel} ${"─".repeat(right)}${SEQ.reset}`;
}

export function layoutInput(
  prompt: string,
  graphemes: string[],
  width: number,
  continuationPrompt: string,
): InputLayout {
  const rows = [prompt];
  const positions: CursorPosition[] = new Array(graphemes.length + 1);
  const continuationWidth = terminalWidth(continuationPrompt);
  let row = 0;
  let column = terminalWidth(prompt);

  for (let index = 0; index < graphemes.length; index += 1) {
    const grapheme = graphemes[index];

    if (grapheme === "\n") {
      positions[index] = { row, column };
      rows.push(continuationPrompt);
      row += 1;
      column = continuationWidth;
      continue;
    }

    const graphemeWidth = measureGrapheme(grapheme);
    if (column + graphemeWidth > width) {
      rows.push(continuationPrompt);
      row += 1;
      column = continuationWidth;
    }

    positions[index] = { row, column };
    rows[row] += grapheme;
    column += graphemeWidth;
  }

  positions[graphemes.length] = { row, column };
  return { rows, positions };
}

export interface WrappedAnsiResult {
  rows: string[];
  activeStyle: string;
}

export function wrapAnsiWithStateFallback(
  value: string,
  width: number,
  initialStyle = "",
): WrappedAnsiResult {
  const rows: string[] = [];
  let row = initialStyle;
  let rowWidth = 0;
  let activeStyle = initialStyle;
  let offset = 0;

  const pushRow = () => {
    rows.push(`${row}${ANSI_RESET}`);
    row = activeStyle;
    rowWidth = 0;
  };

  while (offset < value.length) {
    if (value[offset] === "\x1b") {
      const sequence = ansiSequenceAt(value, offset);
      if (sequence) {
        row += sequence;
        if (sequence.endsWith("m")) {
          if (/\x1b\[(?:0)?m/.test(sequence)) {
            activeStyle = "";
          } else {
            activeStyle += sequence;
          }
        }
        offset += sequence.length;
        continue;
      }
    }

    const nextAnsi = value.indexOf("\x1b", offset);
    const textEnd = nextAnsi === -1 ? value.length : nextAnsi;
    if (textEnd === offset) {
      const grapheme = value[offset];
      const graphemeWidth = measureGrapheme(grapheme);
      if (rowWidth + graphemeWidth > width && rowWidth > 0) {
        pushRow();
      }
      row += grapheme;
      rowWidth += graphemeWidth;
      offset += 1;
      continue;
    }
    const text = value.slice(offset, textEnd).replace(/\r/g, "");

    for (const grapheme of splitGraphemes(text)) {
      if (grapheme === "\n") {
        pushRow();
        continue;
      }

      const graphemeWidth = measureGrapheme(grapheme);
      if (rowWidth + graphemeWidth > width && rowWidth > 0) {
        pushRow();
      }
      row += grapheme;
      rowWidth += graphemeWidth;
    }
    offset = textEnd;
  }

  rows.push(`${row}${ANSI_RESET}`);
  return { rows, activeStyle };
}

export function wrapAnsiWithState(
  value: string,
  width: number,
  initialStyle = "",
): WrappedAnsiResult {
  if (value.length >= NATIVE_LAYOUT_MIN_LENGTH) {
    const nativeResult = tryNativeWrapAnsi(value, width, initialStyle);
    if (nativeResult) return nativeResult;
  }
  return wrapAnsiWithStateFallback(value, width, initialStyle);
}

export function wrapAnsi(value: string, width: number): string[] {
  return wrapAnsiWithState(value, width).rows;
}

export function layoutAnsiDocumentFallback(value: string, width: number): AnsiTextLayout {
  const rows: AnsiLayoutRow[] = [];
  let rowAnsi = "";
  let rowPlain = "";
  let rowWidth = 0;
  let activeStyle = "";
  let document = "";
  let rowStartOffset = 0;
  let offset = 0;

  const pushRow = () => {
    rows.push({
      ansi: `${rowAnsi}${ANSI_RESET}`,
      plain: rowPlain,
      startOffset: rowStartOffset,
      endOffset: document.length,
    });
    rowAnsi = activeStyle;
    rowPlain = "";
    rowWidth = 0;
    rowStartOffset = document.length;
  };

  const appendGrapheme = (grapheme: string) => {
    if (grapheme === "\r") {
      return;
    }
    if (grapheme === "\n") {
      pushRow();
      document += "\n";
      rowStartOffset = document.length;
      return;
    }

    const graphemeWidth = measureGrapheme(grapheme);
    if (rowWidth + graphemeWidth > width && rowWidth > 0) {
      pushRow();
    }
    rowAnsi += grapheme;
    rowPlain += grapheme;
    rowWidth += graphemeWidth;
    document += grapheme;
  };

  while (offset < value.length) {
    if (value[offset] === "\x1b") {
      const sequence = ansiSequenceAt(value, offset);
      if (sequence) {
        rowAnsi += sequence;
        if (sequence.endsWith("m")) {
          if (/\x1b\[(?:0)?m/.test(sequence)) {
            activeStyle = "";
          } else {
            activeStyle += sequence;
          }
        }
        offset += sequence.length;
        continue;
      }
    }

    const nextAnsi = value.indexOf("\x1b", offset);
    const textEnd = nextAnsi === -1 ? value.length : nextAnsi;
    if (textEnd === offset) {
      appendGrapheme(value[offset]);
      offset += 1;
      continue;
    }
    // Normalize CR before segmentation. Intl.Segmenter can otherwise group
    // CRLF differently from the ASCII fast path and corrupt selection offsets.
    const text = value.slice(offset, textEnd).replace(/\r/g, "");
    for (const grapheme of splitGraphemes(text)) {
      appendGrapheme(grapheme);
    }
    offset = textEnd;
  }

  pushRow();
  return { rows, document };
}

export function layoutAnsiDocument(value: string, width: number): AnsiTextLayout {
  if (value.length >= NATIVE_LAYOUT_MIN_LENGTH) {
    const nativeResult = tryNativeLayoutAnsiDocument(value, width);
    if (nativeResult) return nativeResult;
  }
  return layoutAnsiDocumentFallback(value, width);
}

/** Returns scroll rows for a drag pointer outside the chat viewport. Positive scrolls upward. */
export function getSelectionAutoScrollRows(
  row: number,
  screenTop: number,
  visibleRowCount: number,
): number {
  if (visibleRowCount <= 0) return 0;
  const screenBottom = screenTop + visibleRowCount - 1;
  if (row < screenTop) {
    return Math.min(3, Math.max(1, Math.ceil((screenTop - row) / 2)));
  }
  if (row > screenBottom) {
    return -Math.min(3, Math.max(1, Math.ceil((row - screenBottom) / 2)));
  }
  return 0;
}

export function cellAtColumn(
  row: AnsiLayoutRow,
  column: number,
  clampToText = false,
): TextCell | undefined {
  const targetColumn = Math.max(0, column - 1);
  let visualColumn = 0;
  let textOffset = row.startOffset;

  let lastCell: TextCell | undefined;
  for (const grapheme of splitGraphemes(row.plain)) {
    const width = measureGrapheme(grapheme);
    const cell = { startOffset: textOffset, endOffset: textOffset + grapheme.length };
    if (targetColumn >= visualColumn && targetColumn < visualColumn + width) {
      return cell;
    }
    lastCell = cell;
    visualColumn += width;
    textOffset += grapheme.length;
  }

  return clampToText ? lastCell : undefined;
}
