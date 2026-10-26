/**
 * 工具输出的显示预算：行数与显示宽度双重约束下的折叠。
 *
 * 与 process-fold.ts 同一模式：纯函数、不做 I/O，便于用固定宽度做单测。
 * 两条口径来自 design/opencode-tool-result-display.md 第 5 节：
 * - 通用工具输出保头（`collapseToolOutput`），命令输出保尾（`collapseShellOutput`）——
 *   命令的报错几乎总在最后几行，保头会把最关键的报错切掉；
 * - 行数与字符数同时约束，且按**显示宽度**（CJK 占 2 列、emoji 按 grapheme）裁剪，
 *   不能用 `String.length`，否则中文/emoji 会截出半个字符。
 */
import { fitText, terminalWidth } from "./terminal-text.js";

export interface CollapseOptions {
  /** 最多显示几行（不足 1 时按 1 处理）。 */
  maxLines: number;
  /** 整块字符预算（按显示宽度计）；每行宽度取 `maxChars / maxLines`。 */
  maxChars: number;
}

export interface CollapsedOutput {
  /** 实际展示的行（已按显示宽度截断）。 */
  lines: string[];
  /** 被折叠掉的行数；0 表示没有溢出。 */
  omitted: number;
}

/** shell 结果预览预算：10 行 / 10 × 80 列（与设计文档第 5 节的展示规则一致）。 */
export const SHELL_PREVIEW_LINES = 10;
export const SHELL_PREVIEW_MAX_CHARS = SHELL_PREVIEW_LINES * 80;

/**
 * 折叠标记：保尾（省掉的是前面的行）标在开头，保头（省掉的是后面的行）标在末尾。
 * 文字固定为「前 N 行未显示」，与 `formatExpandedToolOutput` 的「另有 N 行」区分开。
 */
export function formatOmittedLines(count: number, markerAt: "start" | "end"): string {
  if (count <= 0) return "";
  return markerAt === "start" ? `… 前 ${count} 行未显示` : `… 另有 ${count} 行未显示`;
}

function splitLines(output: string): string[] {
  const normalized = output.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return [];
  const lines = normalized.split("\n").map((line) => line.replace(/\t/g, "  ").trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function collapse(lines: readonly string[], options: CollapseOptions, keep: "head" | "tail") {
  const maxLines = Math.max(1, Math.floor(options.maxLines));
  const perLine = Math.max(1, Math.floor(options.maxChars / maxLines));
  const shown =
    lines.length <= maxLines
      ? [...lines]
      : keep === "head"
        ? lines.slice(0, maxLines)
        : lines.slice(-maxLines);
  // 单行超宽时按显示宽度截断；宽度预算按行均分，保证整块不会因为某一行特别长而挤掉其他行。
  return {
    lines: shown.map((line) => (terminalWidth(line) <= perLine ? line : fitText(line, perLine))),
    omitted: Math.max(0, lines.length - shown.length),
  };
}

/**
 * 通用工具输出：行数/宽度都达标就原样返回，超行取头部并在末尾补 `…`。
 * 展开（Ctrl+O）与结果预览共用这一份预算，保证“折叠时看到的”是“展开后的前 N 行”。
 */
export function collapseToolOutput(output: string, options: CollapseOptions): CollapsedOutput {
  return collapse(splitLines(output), options, "head");
}

/**
 * 命令输出：取尾部，前面标 `… 前 N 行未显示`。
 * 与 `collapseToolOutput` 的差别只有“保尾”，其余预算一致。
 */
export function collapseShellOutput(output: string, options: CollapseOptions): CollapsedOutput {
  return collapse(splitLines(output), options, "tail");
}
