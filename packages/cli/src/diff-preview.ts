/**
 * 编辑 / 写入的 diff 预览（纯函数）：底层用标准 unified patch
 * （与 opencode 同一套 jsdiff `createTwoFilesPatch`），再解析成
 * `@@` hunk 头 + 双列（旧 / 新）行号 + 行内差异高亮。
 * 授权卡片与工具块完成后的预览共用同一套渲染。
 * 所有行按显示宽度 ANSI 感知截断，颜色走 theme 的 token 保证对比度。
 */

import { createTwoFilesPatch } from "diff";
import { splitGraphemes, truncateAnsiText } from "./terminal-text.js";
import { colors } from "./theme.js";

/** 与 opencode 一致：unified patch 默认前后各 4 行上下文。 */
export const DEFAULT_PATCH_CONTEXT = 4;
/** 双列行号的单列宽度（右对齐）。 */
const LINE_NUMBER_WIDTH = 4;

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

/** patch 解析后的展示行；hunk 头与「no newline」提示也各占一行。 */
interface PatchRow {
  type: "hunk" | "same" | "del" | "add" | "note";
  oldLine?: number;
  newLine?: number;
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

function normalizeDiffText(text: string): string {
  return normalizeDiffLines(text).join("\n");
}

/**
 * 生成标准 unified patch（`Index` / `---` / `+++` / `@@`）。导出供 `/diff` 等
 * 需要原始 patch 文本的调用方复用，和 opencode 的 `fileDiff` 口径一致。
 */
export function buildUnifiedPatch(
  before: string,
  after: string,
  path = "",
  contextLines = DEFAULT_PATCH_CONTEXT,
): string {
  return createTwoFilesPatch(
    path,
    path,
    normalizeDiffText(before),
    normalizeDiffText(after),
    undefined,
    undefined,
    { context: contextLines },
  );
}

/** 解析 unified patch：跳过文件头，记录 hunk 起点并逐行推进双列行号。 */
function parseUnifiedPatch(patch: string): { rows: PatchRow[]; stats: DiffStats } {
  const rows: PatchRow[] = [];
  const stats: DiffStats = { added: 0, removed: 0 };
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) continue;
      inHunk = true;
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      rows.push({ type: "hunk", oldLine, newLine, text: line });
      continue;
    }
    if (line.startsWith("\\")) {
      rows.push({ type: "note", text: line });
      continue;
    }
    if (
      !inHunk &&
      (line.startsWith("Index:") ||
        line.startsWith("===") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ "))
    ) {
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ type: "add", newLine, text: line.slice(1) });
      newLine += 1;
      stats.added += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ type: "del", oldLine, text: line.slice(1) });
      oldLine += 1;
      stats.removed += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      rows.push({ type: "same", oldLine, newLine, text: line.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
  }
  return { rows, stats };
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
function lineNumberLabel(line: number | undefined, columnWidth = LINE_NUMBER_WIDTH): string {
  if (line === undefined) return " ".repeat(columnWidth);
  const text = String(line);
  return text.length > columnWidth
    ? `${" ".repeat(Math.max(0, columnWidth - 1))}…`
    : text.padStart(columnWidth);
}

/** 一行的固定布局：` 旧行号 新行号 标记 内容`。 */
function layoutRow(
  oldLine: number | undefined,
  newLine: number | undefined,
  mark: string,
  text: string,
): string {
  return ` ${lineNumberLabel(oldLine)} ${lineNumberLabel(newLine)} ${mark} ${text}`;
}

/** 把解析后的 patch 行渲染成带 hunk 头、双列行号与行内高亮的展示行。 */
function renderPatch(patch: string, width: number, maxLines: number): DiffBody {
  const { rows, stats } = parseUnifiedPatch(patch);
  // 配对相邻的删除块与新增块，按位置做行内高亮（与 patch 的输出顺序一致）。
  const delPair = new Map<number, number>();
  const addPair = new Map<number, number>();
  for (let index = 0; index < rows.length; ) {
    if (rows[index].type !== "del") {
      index += 1;
      continue;
    }
    let delEnd = index;
    while (delEnd < rows.length && rows[delEnd].type === "del") delEnd += 1;
    let addEnd = delEnd;
    while (addEnd < rows.length && rows[addEnd].type === "add") addEnd += 1;
    const pairs = Math.min(delEnd - index, addEnd - delEnd);
    for (let offset = 0; offset < pairs; offset += 1) {
      delPair.set(index + offset, delEnd + offset);
      addPair.set(delEnd + offset, index + offset);
    }
    index = addEnd;
  }

  type RenderedRow = { row: string; changed: boolean };
  const rendered: RenderedRow[] = [];
  let startLine = 1;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.type === "hunk") {
      if (startLine === 1 && row.oldLine !== undefined) startLine = row.oldLine;
      rendered.push({ row: colors.cyan(row.text), changed: false });
      continue;
    }
    if (row.type === "note") {
      rendered.push({ row: colors.gray(row.text), changed: false });
      continue;
    }
    if (row.type === "same") {
      rendered.push({
        row: layoutRow(row.oldLine, row.newLine, " ", colors.muted(row.text)),
        changed: false,
      });
      continue;
    }
    if (row.type === "del") {
      const pairIndex = delPair.get(index);
      const pair = pairIndex === undefined ? undefined : rows[pairIndex];
      const highlighted = highlightIntraLine(row.text, pair?.text);
      rendered.push({
        row: layoutRow(row.oldLine, row.newLine, colors.boldRed("-"), highlighted.del),
        changed: true,
      });
      continue;
    }
    const pairIndex = addPair.get(index);
    const pair = pairIndex === undefined ? undefined : rows[pairIndex];
    const highlighted = highlightIntraLine(pair?.text, row.text);
    rendered.push({
      row: layoutRow(row.oldLine, row.newLine, colors.boldGreen("+"), highlighted.add),
      changed: true,
    });
  }

  const visible = rendered.slice(0, Math.max(0, maxLines));
  const lines = visible.map((item) => truncateAnsiText(item.row, Math.max(1, width)));
  const hiddenLines = rendered.length - visible.length;
  if (hiddenLines > 0) {
    lines.push(colors.gray(`… 还有 ${hiddenLines} 行`));
  }
  return { lines, stats, hiddenLines, startLine };
}

/**
 * 精准编辑（edit）的 diff 预览：还原编辑后的完整内容，再用标准 unified patch
 * 对比前后全文，定位 hunk、带行号与上下文。定位不到 oldText（或调用方拿不到
 * 原文）时退化为 oldText/newText 片段的 patch 对比。
 */
export function buildEditDiff(
  original: string,
  oldText: string,
  newText: string,
  width: number,
  maxLines = 14,
  contextLines = DEFAULT_PATCH_CONTEXT,
): DiffBody {
  const normalizedOriginal = normalizeDiffText(original);
  const normalizedOld = normalizeDiffText(oldText);
  const normalizedNew = normalizeDiffText(newText);
  let before: string;
  let after: string;
  if (normalizedOriginal) {
    const located = normalizedOld ? normalizedOriginal.indexOf(normalizedOld) : -1;
    if (located >= 0) {
      before = normalizedOriginal;
      after =
        normalizedOriginal.slice(0, located) +
        normalizedNew +
        normalizedOriginal.slice(located + normalizedOld.length);
    } else {
      before = normalizedOld;
      after = normalizedNew;
    }
  } else {
    before = normalizedOld;
    after = normalizedNew;
  }
  return renderPatch(buildUnifiedPatch(before, after, "", contextLines), width, maxLines);
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
  const before = original === undefined ? "" : original;
  return renderPatch(buildUnifiedPatch(before, content), width, maxLines);
}

/** diff 头部行：`路径  +a −r`（新增/删除行数来自 stats）。 */
export function formatDiffHeader(path: string, stats: DiffStats, note?: string): string {
  const suffix = note ? `  ${colors.gray(note)}` : "";
  return `${colors.bold(path)}  ${colors.green(`+${stats.added}`)} ${colors.red(`−${stats.removed}`)}${suffix}`;
}
