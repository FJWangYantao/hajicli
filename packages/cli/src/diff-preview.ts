/**
 * 编辑 / 写入的 diff 预览（纯函数）：行级 LCS 对比 + 行内差异高亮，
 * 授权卡片与工具块完成后的预览共用同一套渲染。
 * 所有行按显示宽度 ANSI 感知截断，颜色走 theme 的 token 保证对比度。
 */

import { splitGraphemes, truncateAnsiText } from "./terminal-text.js";
import { colors } from "./theme.js";

/** 行级 LCS 的规模上限：超过后退化为整块删除 + 整块新增，避免 O(n²) 拖慢渲染。 */
const LCS_MAX_LINES = 600;
const LCS_MAX_CELLS = 90_000;

export interface DiffStats {
  added: number;
  removed: number;
}

export interface DiffBody {
  /** 已着色的展示行；有截断时末尾附「… 还有 N 行」提示。 */
  lines: string[];
  stats: DiffStats;
  /** 被截断未显示的行数。 */
  hiddenLines: number;
  /** 改动起始行（1-based；定位不到原位置时为 1）。 */
  startLine: number;
}

interface DiffOp {
  type: "same" | "del" | "add";
  aLine?: number;
  bLine?: number;
  text: string;
}

/** 统一换行为 LF；末尾单个换行不计为新行。CRLF 文件显示口径与编辑器一致。 */
export function normalizeDiffLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized) return [];
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

/** 经典 DP 行级 LCS；规模超限或一侧为空时按整块新增 / 删除展示。 */
function diffLines(a: string[], b: string[]): DiffOp[] {
  if (a.length === 0) {
    return b.map((text, index) => ({ type: "add" as const, bLine: index + 1, text }));
  }
  if (b.length === 0) {
    return a.map((text, index) => ({ type: "del" as const, aLine: index + 1, text }));
  }
  if (a.length > LCS_MAX_LINES || b.length > LCS_MAX_LINES || a.length * b.length > LCS_MAX_CELLS) {
    return [
      ...a.map((text, index) => ({ type: "del" as const, aLine: index + 1, text })),
      ...b.map((text, index) => ({ type: "add" as const, bLine: index + 1, text })),
    ];
  }
  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度；回读时先删除再插入，与 git 的展示顺序一致。
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  let aLine = 1;
  let bLine = 1;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: "same", aLine, bLine, text: a[i] });
      i += 1;
      j += 1;
      aLine += 1;
      bLine += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", aLine, text: a[i] });
      i += 1;
      aLine += 1;
    } else {
      ops.push({ type: "add", bLine, text: b[j] });
      j += 1;
      bLine += 1;
    }
  }
  while (i < a.length) {
    ops.push({ type: "del", aLine, text: a[i] });
    i += 1;
    aLine += 1;
  }
  while (j < b.length) {
    ops.push({ type: "add", bLine, text: b[j] });
    j += 1;
    bLine += 1;
  }
  return ops;
}

/** 相邻删除/新增行的行内高亮：公共前后缀之外的中间段用红底 / 绿底标出。 */
function highlightIntraLine(
  delText: string | undefined,
  addText: string | undefined,
): { del: string; add: string } {
  if (delText === undefined || addText === undefined) {
    return {
      del: delText === undefined ? "" : colors.red(delText),
      add: addText === undefined ? "" : colors.green(addText),
    };
  }
  const delChars = splitGraphemes(delText);
  const addChars = splitGraphemes(addText);
  let prefix = 0;
  while (
    prefix < delChars.length &&
    prefix < addChars.length &&
    delChars[prefix] === addChars[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < delChars.length - prefix &&
    suffix < addChars.length - prefix &&
    delChars[delChars.length - 1 - suffix] === addChars[addChars.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const delMiddle = delChars.slice(prefix, delChars.length - suffix).join("");
  const addMiddle = addChars.slice(prefix, addChars.length - suffix).join("");
  // 中间段为空（纯增删）或过长（整行几乎都变了）时不做行内高亮，退回整行着色。
  if (!delMiddle || !addMiddle || delMiddle.length > 120 || addMiddle.length > 120) {
    return { del: colors.red(delText), add: colors.green(addText) };
  }
  return {
    del: `${colors.red(delChars.slice(0, prefix).join(""))}${colors.redBg(delMiddle)}${colors.red(
      delChars.slice(delChars.length - suffix).join(""),
    )}`,
    add: `${colors.green(addChars.slice(0, prefix).join(""))}${colors.greenBg(
      addMiddle,
    )}${colors.green(addChars.slice(addChars.length - suffix).join(""))}`,
  };
}

/** 行号列宽（右对齐）；行数超出时收缩为省略号，避免挤占正文。 */
function lineNumberLabel(line: number | undefined, columnWidth: number): string {
  if (line === undefined) return " ".repeat(columnWidth);
  const text = String(line);
  return text.length > columnWidth
    ? `${" ".repeat(Math.max(0, columnWidth - 1))}…`
    : text.padStart(columnWidth);
}

/** 把 LCS 结果渲染成带行号与上下文的展示行。 */
function renderOps(
  ops: DiffOp[],
  options: { width: number; maxLines: number; lineNumberColumn: number; plainContext?: boolean },
): DiffBody {
  const stats: DiffStats = { added: 0, removed: 0 };
  type RenderedRow = { row: string; changed: boolean };
  const rendered: RenderedRow[] = [];
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    if (op.type === "same") {
      const label = lineNumberLabel(op.aLine, options.lineNumberColumn);
      const text = options.plainContext ? op.text : colors.muted(op.text);
      rendered.push({ row: ` ${label}   ${text}`, changed: false });
      continue;
    }
    if (op.type === "del") {
      stats.removed += 1;
      const next = ops[index + 1];
      const pair = next?.type === "add" ? next : undefined;
      const highlighted = pair
        ? highlightIntraLine(op.text, pair.text)
        : highlightIntraLine(op.text, undefined);
      const label = lineNumberLabel(op.aLine, options.lineNumberColumn);
      rendered.push({ row: ` ${label} ${colors.boldRed("−")} ${highlighted.del}`, changed: true });
      continue;
    }
    stats.added += 1;
    const previous = ops[index - 1];
    // 与前面删除行配对过的高亮已在删除侧完成，这里独立着色。
    const highlighted =
      previous?.type === "del"
        ? highlightIntraLine(previous.text, op.text)
        : highlightIntraLine(undefined, op.text);
    const label = lineNumberLabel(op.bLine, options.lineNumberColumn);
    rendered.push({ row: ` ${label} ${colors.boldGreen("+")} ${highlighted.add}`, changed: true });
  }

  const visible = rendered.slice(0, Math.max(0, options.maxLines));
  const lines = visible.map((item) => truncateAnsiText(item.row, Math.max(1, options.width)));
  const hiddenLines = rendered.length - visible.length;
  if (hiddenLines > 0) {
    lines.push(colors.gray(`… 还有 ${hiddenLines} 行`));
  }
  return { lines, stats, hiddenLines, startLine: 1 };
}

/**
 * 精准编辑（edit）的 diff 预览：在原文中定位 oldText，带前后各 2 行上下文与行号。
 * 定位不到（如编辑已应用或空白口径差异）时退化为无行号的整块对比。
 */
export function buildEditDiff(
  original: string,
  oldText: string,
  newText: string,
  width: number,
  maxLines = 14,
  contextLines = 2,
): DiffBody {
  const originalLines = normalizeDiffLines(original);
  const normalizedOriginal = originalLines.join("\n");
  const normalizedOld = normalizeDiffLines(oldText).join("\n");
  const normalizedNew = normalizeDiffLines(newText);

  const located = normalizedOriginal.indexOf(normalizedOld);
  if (located < 0 || !normalizedOld) {
    const ops: DiffOp[] = [
      ...normalizeDiffLines(oldText).map((text, index) => ({
        type: "del" as const,
        aLine: index + 1,
        text,
      })),
      ...normalizedNew.map((text, index) => ({ type: "add" as const, bLine: index + 1, text })),
    ];
    return renderOps(ops, { width, maxLines, lineNumberColumn: 0 });
  }

  const beforeText = normalizedOriginal.slice(0, located);
  const startLine = (beforeText.match(/\n/g)?.length ?? 0) + 1;
  const oldCount = normalizedOld.split("\n").length;
  const contextBefore = normalizedOriginal
    .slice(0, located)
    .split("\n")
    .slice(0, -1)
    .slice(-contextLines);
  const contextAfter = normalizedOriginal
    .slice(located + normalizedOld.length)
    .split("\n")
    .slice(1, 1 + contextLines);

  const ops: DiffOp[] = [];
  for (const [index, text] of contextBefore.entries()) {
    ops.push({ type: "same", aLine: startLine - contextBefore.length + index, bLine: 0, text });
  }
  const replacedOps = diffLines(normalizeDiffLines(oldText), normalizedNew);
  for (const op of replacedOps) {
    if (op.aLine !== undefined) op.aLine += startLine - 1;
    if (op.bLine !== undefined) op.bLine += startLine - 1;
    ops.push(op);
  }
  const afterStart = startLine + oldCount;
  for (const [index, text] of contextAfter.entries()) {
    ops.push({ type: "same", aLine: afterStart + index, bLine: 0, text });
  }
  const body = renderOps(ops, { width, maxLines, lineNumberColumn: 4 });
  return { ...body, startLine };
}

/**
 * 整文件写入（write）的 diff 预览：覆盖已有文件时对比旧内容；新建文件全量绿色展示。
 */
export function buildWriteDiff(
  original: string | undefined,
  content: string,
  width: number,
  maxLines = 14,
): DiffBody {
  const newLines = normalizeDiffLines(content);
  if (original === undefined) {
    const ops: DiffOp[] = newLines.map((text, index) => ({ type: "add", bLine: index + 1, text }));
    return renderOps(ops, { width, maxLines, lineNumberColumn: 4 });
  }
  const ops = diffLines(normalizeDiffLines(original), newLines);
  return renderOps(ops, { width, maxLines, lineNumberColumn: 4 });
}

/** diff 头部行：`路径  +a −r`（新增/删除行数来自 stats）。 */
export function formatDiffHeader(path: string, stats: DiffStats, note?: string): string {
  const suffix = note ? `  ${colors.gray(note)}` : "";
  return `${colors.bold(path)}  ${colors.green(`+${stats.added}`)} ${colors.red(`−${stats.removed}`)}${suffix}`;
}
