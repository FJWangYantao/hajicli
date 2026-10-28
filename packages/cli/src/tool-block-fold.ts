/**
 * 工具块的二级折叠（纯函数层）：已封口过程段里的每个工具调用块按行数收口，
 * 点击头行/指示行展开全文，鼠标扫过时整块高亮提示可点。
 *
 * 默认态：段展开后块是全展开的（最多 TOOL_BLOCK_EXPAND_LINES 行），
 * 收起只是用户对单个块的临时选择；本模块不关心默认值，由调用方传 expanded。
 *
 * 与 process-fold.ts 同一模式：不做 I/O、不持有 TerminalUI 状态。
 * 一级折叠（过程段收敛成 ● 摘要行）仍归 process-fold.ts；本模块只负责
 * 展开后的过程段内部「单个工具块该显示几行、指示行怎么写」。
 *
 * 数据来源：ToolRunView 提交工具格时为每个块留一份渲染配方（ToolBlockRenderInfo），
 * 收起/展开都从配方现算——终端缩放后块内折行仍是当前宽度的，不依赖写入时的硬折行。
 */
import { formatToolCell, TOOL_CELL_INDENT } from "./cli-runtime.js";
import { sanitizeTerminalText } from "./terminal-sanitize.js";
import { fitText, terminalWidth } from "./terminal-text.js";
import { colors } from "./theme.js";
import { collapseShellOutput, collapseToolOutput, formatOmittedLines } from "./tool-output.js";

/** 收起时正文（预览）行数：头行/参数行/结果行之外再给几行输出。 */
export const TOOL_BLOCK_COLLAPSE_LINES = 3;

/** 展开时输出正文行数上限：再长的输出也只占这些行，余下用省略行交代。 */
export const TOOL_BLOCK_EXPAND_LINES = 20;

/** 单块留档全文的字符上限：防止超长输出（整文件 read）把内存与展开视图撑爆。 */
export const TOOL_BLOCK_OUTPUT_MAX_CHARS = 20_000;

/** 工具块的渲染配方：足以在任意宽度下重出这块的收起/展开两种形态。 */
export interface ToolBlockRenderInfo {
  status: "success" | "failed" | "rejected";
  toolName: string;
  /** 头行主语；有参数展开行时为空串（与提交格的口径一致，避免命令出现两遍）。 */
  summary: string;
  /** 完成耗时文本（被拒的调用不显示）。 */
  timing?: string;
  /** 调用参数的展开行（多行命令原样分行）。 */
  argLines?: string[];
  /** 结果说明（`└ 12 行输出`）。 */
  resultText?: string;
  /** 改动行数（edit/write 并进头行的 `+a −r`）。 */
  stats?: { added: number; removed: number };
  /** 结果预览全量（summarizeToolResult 给的行，未按块预算裁剪）。 */
  preview?: string[];
  /** 原始输出留档（截到 TOOL_BLOCK_OUTPUT_MAX_CHARS）。 */
  fullOutput?: string;
  /** 展开输出正文时的保向：bash 报错多在中后段，保尾。 */
  keep: "head" | "tail";
}

/** ToolRunView 提交时带出的块描述：start/end 是整格文本内的字符区间。 */
export interface ToolBlockWrite {
  start: number;
  end: number;
  info: ToolBlockRenderInfo;
}

export interface ToolBlockRows {
  /** 这一块的可见行（含头行；不含段内其他内容）。 */
  rows: string[];
  /** 头行在 rows 中的下标（点击命中行）。 */
  headerRow: number;
  /** 折叠指示行在 rows 中的下标；不可展开的块没有。 */
  indicatorRow?: number;
}

/** 全文按行归一：去控制字符、统一换行、去尾部空行（口径对齐 tool-output 的 splitLines）。 */
function outputLines(info: ToolBlockRenderInfo): string[] {
  const raw = info.fullOutput;
  if (!raw?.trim()) return [];
  const lines = sanitizeTerminalText(raw)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .split("\n")
    .map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 块有没有可展开的余量：预览超预算，或全文比预览更长。 */
export function isToolBlockExpandable(info: ToolBlockRenderInfo): boolean {
  const previewTotal = info.preview?.length ?? 0;
  if (previewTotal > TOOL_BLOCK_COLLAPSE_LINES) return true;
  return outputLines(info).length > Math.max(previewTotal, TOOL_BLOCK_COLLAPSE_LINES);
}

/** 收起时被折掉的行数（展开后能多看到的行数上限）。 */
function hiddenLineCount(info: ToolBlockRenderInfo, shown: number): number {
  const previewTotal = info.preview?.length ?? 0;
  return Math.max(0, Math.max(previewTotal, outputLines(info).length) - shown);
}

/**
 * 渲染一个工具块：
 * - 收起：头行 + 参数行 + 结果行 + TOOL_BLOCK_COLLAPSE_LINES 行预览 + 「⋯ 还有 N 行 · 点击展开」；
 * - 展开：预览全量 + （预览盖不住全文时）输出正文至 TOOL_BLOCK_EXPAND_LINES 行 + 「⋯ 点击收起」；
 * - 悬停：头行加下划线、指示行提亮（hovered 由 TerminalUI 的命中表传入）。
 */
export function renderToolBlockRows(
  info: ToolBlockRenderInfo,
  width: number,
  options: { expanded: boolean; hovered?: boolean },
): ToolBlockRows {
  const hovered = options.hovered ?? false;
  const previewTotal = info.preview?.length ?? 0;
  const rows = formatToolCell({
    status: info.status,
    toolName: info.toolName,
    summary: info.summary,
    width,
    timing: info.timing,
    resultText: info.resultText,
    stats: info.stats,
    argLines: info.argLines,
    preview: info.preview,
    maxPreviewLines: options.expanded
      ? Math.max(TOOL_BLOCK_COLLAPSE_LINES, previewTotal)
      : TOOL_BLOCK_COLLAPSE_LINES,
    hover: hovered,
  });
  if (!isToolBlockExpandable(info)) {
    return { rows, headerRow: 0 };
  }
  if (!options.expanded) {
    const shown = Math.min(previewTotal, TOOL_BLOCK_COLLAPSE_LINES);
    const hidden = hiddenLineCount(info, shown);
    const indicatorRow = rows.length;
    rows.push(indicatorLine(`还有 ${hidden} 行 · 点击展开`, hovered));
    return { rows, headerRow: 0, indicatorRow };
  }
  // 预览之外还有全文：补一段输出正文（bash 保尾、其余保头），行宽按当前终端裁剪。
  const full = outputLines(info);
  if (info.fullOutput && full.length > previewTotal) {
    const collapsed =
      info.keep === "tail"
        ? collapseShellOutput(info.fullOutput, {
            maxLines: TOOL_BLOCK_EXPAND_LINES,
            maxChars: TOOL_BLOCK_EXPAND_LINES * Math.max(20, width),
          })
        : collapseToolOutput(info.fullOutput, {
            maxLines: TOOL_BLOCK_EXPAND_LINES,
            maxChars: TOOL_BLOCK_EXPAND_LINES * Math.max(20, width),
          });
    const bodyWidth = Math.max(1, width - terminalWidth(TOOL_CELL_INDENT) - 4);
    for (const line of collapsed.lines) {
      rows.push(
        `${TOOL_CELL_INDENT}  ${colors.faint("│")} ${colors.gray(fitText(line, bodyWidth))}`,
      );
    }
    if (collapsed.omitted > 0) {
      rows.push(
        `${TOOL_CELL_INDENT}  ${colors.faint("│")} ${colors.gray(
          formatOmittedLines(collapsed.omitted, info.keep === "tail" ? "start" : "end"),
        )}`,
      );
    }
  }
  const indicatorIndex = rows.length;
  rows.push(indicatorLine("点击收起", hovered));
  return { rows, headerRow: 0, indicatorRow: indicatorIndex };
}

function indicatorLine(text: string, hovered: boolean): string {
  const body = hovered ? colors.accent(text) : colors.muted(text);
  return `${TOOL_CELL_INDENT}${colors.faint("⋯")} ${body}`;
}
