/**
 * 编辑 / 写入的 diff 预览（纯函数）：底层用标准 unified patch
 * （与 opencode 同一套 jsdiff `createTwoFilesPatch`），再解析成展示行——
 * 终端够宽（每侧 ≥ {@link SPLIT_MIN_SIDE_WIDTH} 列）用**左右分栏**（左旧右新），
 * 否则退回**单列 unified**（opencode 同款）：行号 + `│` + 标记 + 全宽内容。
 * 删除/新增行整块铺淡红/淡绿条，行内变更字符段叠强反色。授权卡片与工具块
 * 完成后的预览共用同一套渲染。所有行按显示宽度 ANSI 感知截断。
 */

import { createTwoFilesPatch } from "diff";
import { splitGraphemes, terminalWidth, truncateAnsiText } from "./terminal-text.js";
import { colors, diffToneBg, fgSeq, getTheme, themeReset } from "./theme.js";
import { resolveTuiLayout } from "./tui-layout.js";

/**
 * 分栏 diff 的构建宽度：必须与**实际渲染宽度**一致——分栏行左右补白到满宽，
 * 只要构建宽于渲染宽，每行都会被截断（右栏整体被裁掉）。
 * 有 UI 的调用方应传 `diffWidthFor(ui.getContentWidth())`：内容宽已含侧栏扣减。
 * 这里只是无 UI 时的回退口径：按 `resolveTuiLayout` 从终端列数推对话区宽再减 8
 * （授权卡比它宽，按更窄的一方建）。无 TTY（测试 / 无头）按 120 列 wide 布局取 112。
 */
export function preferredDiffWidth(): number {
  const columns = process.stdout?.columns ?? 0;
  const rows = process.stdout?.rows ?? 0;
  if (!columns) return 112;
  const layout = resolveTuiLayout(columns, Math.max(1, rows || 24));
  const chatWidth = Math.max(1, layout.safeWidth - layout.chatPadding * 2);
  return diffWidthFor(chatWidth);
}

/**
 * 按对话区实际内容宽（`ui.getContentWidth()`，侧栏可见时已扣掉侧栏与间距）
 * 折算 diff 构建宽：formatToolCell 的预览内容宽 = 内容宽 − 8。
 * 直接拿终端列数折算会在侧栏打开时建出比渲染宽宽一截的行，右栏被整列裁掉。
 */
export function diffWidthFor(contentWidth: number): number {
  return Math.min(232, Math.max(40, contentWidth - 8));
}

/** 与 opencode 一致：unified patch 默认前后各 4 行上下文。 */
export const DEFAULT_PATCH_CONTEXT = 4;
/** 行号列的最小宽度；实际宽度按本次 patch 的最大行号动态取（对齐 opencode 的 minDigits）。 */
const LINE_NUMBER_MIN_WIDTH = 3;

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

/**
 * 生成 patch 前的归一化：统一换行为 LF，并把「末尾有无换行」抹平。
 * 预览关心的是内容差异；仅结尾换行不同不应算作改动行，也不该刷出
 * `\ No newline at end of file` 噪声。
 */
function normalizeDiffText(text: string): string {
  const lines = normalizeDiffLines(text);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
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

/** 行内差异切分：公共前缀/后缀之外的中间段（middle 为空表示无行内高亮，整行走 lead）。 */
interface ToneSegments {
  lead: string;
  middle: string;
  tail: string;
}

function wholeSegments(text: string): ToneSegments {
  return { lead: text, middle: "", tail: "" };
}

/**
 * 相邻删除/新增行的行内差异切分：中间段（真正的改动字符）铺强反色，
 * 前后缀落在整块的淡底色条上；中间段为空（纯增删）或过长（整行几乎都变了）
 * 时不做行内高亮，整行走淡底。
 */
function splitIntraLine(
  delText: string,
  addText: string,
): { del: ToneSegments; add: ToneSegments } {
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
  if (!delMiddle || !addMiddle || delMiddle.length > 120 || addMiddle.length > 120) {
    return { del: wholeSegments(delText), add: wholeSegments(addText) };
  }
  return {
    del: {
      lead: delChars.slice(0, prefix).join(""),
      middle: delMiddle,
      tail: delChars.slice(delChars.length - suffix).join(""),
    },
    add: {
      lead: addChars.slice(0, prefix).join(""),
      middle: addMiddle,
      tail: addChars.slice(addChars.length - suffix).join(""),
    },
  };
}

/** 行号列宽（右对齐）；列宽由本次 patch 的最大行号决定。 */
function lineNumberLabel(line: number | undefined, columnWidth: number): string {
  if (line === undefined) return " ".repeat(columnWidth);
  return String(line).padStart(columnWidth);
}

/** 单元格按显示宽度对齐：超宽 ANSI 感知截断（尾缀 …），不足右侧补空格。 */
function padCell(text: string, width: number): string {
  const fitted = truncateAnsiText(text, width);
  const pad = width - terminalWidth(fitted);
  return pad > 0 ? `${fitted}${" ".repeat(pad)}` : fitted;
}

/** 分栏一侧：行号留在栏外（内容截断也保得住位置），标记 + 已切分内容进单元格。 */
interface SplitSide {
  line?: number;
  mark: string;
  segments: ToneSegments;
  /** 整块铺色（红删/绿增）；undefined 表示上下文行，不铺底色。 */
  tone?: "red" | "green";
}

/** 无底色单元格（上下文行）：纯文本拼接后按显示宽度对齐。 */
function joinSegments(side: SplitSide): string {
  const { lead, middle, tail } = side.segments;
  return `${side.mark} ${lead}${middle}${tail}`;
}

/**
 * 带底色的单元格：从标记到右侧补白整块铺淡红/淡绿（连续色条），
 * 行内变更段叠强反色，强反色结束（其内部会重置属性）后重新续上淡底与正文色，
 * 末尾恢复主题属性。mono 模式下各序列全为空串，输出与无底色路径一致。
 */
function composeTonedCell(side: SplitSide, width: number): string {
  const isGreen = side.tone === "green";
  const toneHex = isGreen ? getTheme().green : getTheme().red;
  const resume = `${diffToneBg(isGreen ? "green" : "red")}${fgSeq(toneHex)}`;
  // 标记（−/+）自带 themeReset 会清掉铺底，拼完标记立刻续上；
  // 行内强高亮段同理，middle 之后也要续一次。
  let body = `${resume}${side.mark}${resume} ${side.segments.lead}`;
  if (side.segments.middle) {
    body += `${(isGreen ? colors.greenBg : colors.redBg)(side.segments.middle)}${resume}`;
  }
  body += side.segments.tail;
  const fitted = truncateAnsiText(body, width);
  const pad = width - terminalWidth(fitted);
  return `${fitted}${pad > 0 ? " ".repeat(pad) : ""}${themeReset()}`;
}

function renderCell(side: SplitSide | undefined, width: number): string {
  if (!side) return padCell(" ", width);
  return side.tone ? composeTonedCell(side, width) : padCell(joinSegments(side), width);
}

/**
 * 一行的固定布局：` 旧行号 左内容 │ 新行号 右内容`。
 * 左侧恒定侧宽（对齐后右栏行号不漂移），空侧用空白占位保持分栏结构。
 */
function layoutSplitRow(
  oldSide: SplitSide | undefined,
  newSide: SplitSide | undefined,
  gutter: number,
  sideWidth: number,
): string {
  const left = renderCell(oldSide, sideWidth);
  const right = renderCell(newSide, sideWidth);
  return ` ${lineNumberLabel(oldSide?.line, gutter)} ${left}${colors.faint("│")} ${lineNumberLabel(
    newSide?.line,
    gutter,
  )} ${right}`;
}

/**
 * 单列（unified）布局：` 行号 │ 标记 内容…`，内容占满剩余宽度，删除/新增整块铺色。
 * 删除行与上下文行用旧文件行号，新增行用新文件行号（unified diff 常规口径）。
 */
function layoutUnifiedRow(side: SplitSide, gutter: number, width: number): string {
  const contentWidth = Math.max(1, width - gutter - 4);
  return ` ${lineNumberLabel(side.line, gutter)} ${colors.faint("│")} ${renderCell(
    side,
    contentWidth,
  )}`;
}

/** 未配对的删/增行按模式选布局：分栏另一侧留空，单列独占一行。 */
function layoutUnifiedOrSplit(
  oldSide: SplitSide | undefined,
  newSide: SplitSide | undefined,
  useSplit: boolean,
  gutter: number,
  sideWidth: number,
  width: number,
): string {
  const side = (oldSide ?? newSide)!;
  return useSplit
    ? layoutSplitRow(oldSide, newSide, gutter, sideWidth)
    : layoutUnifiedRow(side, gutter, Math.max(1, width));
}

/**
 * 分栏一侧的单元格要放下「标记 + 一段可读代码」至少这么多列：
 * 常见 120 列终端每侧只有 40 多列，再被代码缩进吃一截后长行全靠省略号，
 * 行内高亮根本看不清。低于这条线就退回单列 unified（opencode 同款清爽感），
 * 只有全屏宽终端才值得左右对比。
 */
const SPLIT_MIN_SIDE_WIDTH = 68;

/** 把解析后的 patch 行渲染成展示行：够宽用左右分栏，否则单列 unified。 */
function renderPatch(patch: string, width: number, maxLines: number): DiffBody {
  const { rows, stats } = parseUnifiedPatch(patch);
  // 与 opencode 一致：单 hunk 不画 `@@` 头（行号已经说明位置），多 hunk 才用头分隔。
  const hunkCount = rows.filter((row) => row.type === "hunk").length;
  // 行号列宽按本次 patch 的最大行号取，小文件不浪费列宽、大文件也不会被截成省略号。
  const maxLine = rows.reduce((max, row) => Math.max(max, row.oldLine ?? 0, row.newLine ?? 0), 0);
  const gutter = Math.max(LINE_NUMBER_MIN_WIDTH, String(Math.max(1, maxLine)).length);
  // 侧宽 = (总宽 - 两个行号列 - 分隔开销) / 2；过窄终端保底 4 列，右栏可能被裁但不塌。
  const sideWidth = Math.max(4, Math.floor((Math.max(1, width) - gutter * 2 - 6) / 2));
  const useSplit = sideWidth >= SPLIT_MIN_SIDE_WIDTH;
  // 配对相邻的删除块与新增块：配上的删 + 增在分栏视图合并为同一视觉行（左删右增），
  // 行内高亮按位置对齐；单列视图虽不合并，强高亮段仍按这对切分。
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

  type RenderedRow = { row: string; kind: "head" | "context" | "change" };
  const rendered: RenderedRow[] = [];
  /** 已随配对删除行渲染掉的新增行（仅分栏视图；单列视图每行各自渲染）。 */
  const addConsumed = new Set<number>();
  /** 第一条真正改动所在的原文件行号；纯新增时取新文件行号。 */
  let startLine: number | undefined;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.type === "hunk") {
      if (hunkCount > 1) rendered.push({ row: colors.cyan(row.text), kind: "head" });
      continue;
    }
    if (row.type === "note") {
      rendered.push({ row: colors.gray(row.text), kind: "head" });
      continue;
    }
    if (row.type === "same") {
      const context = {
        line: row.oldLine,
        mark: " ",
        segments: wholeSegments(colors.muted(row.text)),
      };
      rendered.push({
        row: useSplit
          ? layoutSplitRow(context, { ...context, line: row.newLine }, gutter, sideWidth)
          : layoutUnifiedRow(context, gutter, Math.max(1, width)),
        kind: "context",
      });
      continue;
    }
    if (row.type === "del") {
      startLine ??= row.oldLine;
      const pairIndex = delPair.get(index);
      if (pairIndex !== undefined) {
        const pair = rows[pairIndex];
        const split = splitIntraLine(row.text, pair.text);
        rendered.push({
          row: useSplit
            ? layoutSplitRow(
                { line: row.oldLine, mark: colors.boldRed("−"), segments: split.del, tone: "red" },
                {
                  line: pair.newLine,
                  mark: colors.boldGreen("+"),
                  segments: split.add,
                  tone: "green",
                },
                gutter,
                sideWidth,
              )
            : layoutUnifiedRow(
                { line: row.oldLine, mark: colors.boldRed("−"), segments: split.del, tone: "red" },
                gutter,
                Math.max(1, width),
              ),
          kind: "change",
        });
        if (useSplit) addConsumed.add(pairIndex);
        continue;
      }
      rendered.push({
        row: layoutUnifiedOrSplit(
          {
            line: row.oldLine,
            mark: colors.boldRed("−"),
            segments: wholeSegments(row.text),
            tone: "red",
          },
          undefined,
          useSplit,
          gutter,
          sideWidth,
          width,
        ),
        kind: "change",
      });
      continue;
    }
    if (useSplit && addConsumed.has(index)) continue;
    startLine ??= row.newLine;
    const pairIndex = addPair.get(index);
    if (pairIndex !== undefined) {
      const pair = rows[pairIndex];
      const split = splitIntraLine(pair.text, row.text);
      rendered.push({
        row: useSplit
          ? layoutSplitRow(
              { line: pair.oldLine, mark: colors.boldRed("−"), segments: split.del, tone: "red" },
              {
                line: row.newLine,
                mark: colors.boldGreen("+"),
                segments: split.add,
                tone: "green",
              },
              gutter,
              sideWidth,
            )
          : layoutUnifiedRow(
              {
                line: row.newLine,
                mark: colors.boldGreen("+"),
                segments: split.add,
                tone: "green",
              },
              gutter,
              Math.max(1, width),
            ),
        kind: "change",
      });
      continue;
    }
    rendered.push({
      row: layoutUnifiedOrSplit(
        undefined,
        {
          line: row.newLine,
          mark: colors.boldGreen("+"),
          segments: wholeSegments(row.text),
          tone: "green",
        },
        useSplit,
        gutter,
        sideWidth,
        width,
      ),
      kind: "change",
    });
  }

  const { visible, hidden } = fitDiffRows(rendered, maxLines);
  const lines = visible.map((item) => truncateAnsiText(item.row, Math.max(1, width)));
  if (hidden > 0) {
    lines.push(colors.gray(`… 还有 ${hidden} 行`));
  }
  return { lines, stats, hiddenLines: hidden, startLine: startLine ?? 1 };
}

/**
 * 行数超限时的取窗：先保证「第一处改动」可见——改动之前的上下文行让位，
 * 只保留紧邻的 hunk 头（或 no-newline 提示），改动之后的行按剩余额度填充。
 * 这样紧凑的工具块（3 行）也不会被上下文挤掉真正的增删行。
 */
function fitDiffRows(
  rows: { row: string; kind: "head" | "context" | "change" }[],
  maxLines: number,
): { visible: { row: string; kind: "head" | "context" | "change" }[]; hidden: number } {
  const limit = Math.max(0, maxLines);
  if (rows.length <= limit) return { visible: rows, hidden: 0 };
  const firstChange = rows.findIndex((item) => item.kind === "change");
  let ordered = rows;
  if (firstChange > 0) {
    const headRow = rows
      .slice(0, firstChange)
      .reverse()
      .find((item) => item.kind === "head");
    ordered = [...(headRow ? [headRow] : []), ...rows.slice(firstChange)];
  }
  const visible = ordered.slice(0, limit);
  return { visible, hidden: rows.length - visible.length };
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

/**
 * 全文预览（write 完成后）：单列行号 + 原样内容，与 opencode 的 write 块一致。
 * 写盘后拿不到旧内容，所以不再假装成 diff，直接展示写入结果。
 */
export function buildContentPreview(content: string, width: number, maxLines = 14): DiffBody {
  const lines = normalizeDiffLines(content);
  const gutter = Math.max(LINE_NUMBER_MIN_WIDTH, String(Math.max(1, lines.length)).length);
  const rendered = lines.map(
    (line, index) => `${colors.muted(String(index + 1).padStart(gutter))} ${line}`,
  );
  const limit = Math.max(0, maxLines);
  const visible = rendered.slice(0, limit);
  const out = visible.map((line) => truncateAnsiText(line, Math.max(1, width)));
  const hiddenLines = rendered.length - visible.length;
  if (hiddenLines > 0) out.push(colors.gray(`… 还有 ${hiddenLines} 行`));
  return { lines: out, stats: { added: 0, removed: 0 }, hiddenLines, startLine: 1 };
}

/** diff 头部行：`路径  +a −r`（新增/删除行数来自 stats）。 */
export function formatDiffHeader(path: string, stats: DiffStats, note?: string): string {
  const suffix = note ? `  ${colors.gray(note)}` : "";
  return `${colors.bold(path)}  ${colors.green(`+${stats.added}`)} ${colors.red(`−${stats.removed}`)}${suffix}`;
}
