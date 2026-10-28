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

/** shell 结果预览预算：6 行 / 6 × 80 列。 */
export const SHELL_PREVIEW_LINES = 6;
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

/**
 * 各工具输出开头连续的回执/元信息行。对话区的工具格头行已经交代了工具名、路径、
 * 行数与成败，展开正文只需要真正的输出内容。
 */
const ENVELOPE_LEADING_PATTERNS: Readonly<Record<string, readonly RegExp[]>> = {
  bash: [/^\[命令执行结果 - 退出码 [^；\]]+；耗时 \d+ms\]$/],
  read: [
    /^\[(?:批量)?文件读取结果 - .*\]$/,
    /^\[图片读取结果 - .*\]$/,
    /^总行数=/,
    /^类型=/,
    /^nextStartLine=/,
    /^提示：/,
  ],
  grep: [/^\[Grep 搜索结果 - .*\]$/, /^引擎=/, /^nextOffset=/, /^提示：/],
  global: [/^\[全局文件查找结果 - .*\]$/, /^引擎=/, /^nextOffset=/, /^提示：/],
  readskillresource: [/^\[Skill 资源读取 - .*\]$/],
  websearch: [/^\[网络搜索结果 - .*\]$/],
  projectinfo: [/^\[项目结构摘要\]$/],
  edit: [
    /^\[文件精准编辑成功\]$/,
    /^\[文件无需修改\]$/,
    /^路径: /,
    /^oldHash=/,
    /^newHash=/,
    /^currentHash=/,
    /^替换次数=/,
    /^说明: /,
    /^改后片段（第 \d+ 行起）:$/,
  ],
  write: [/^\[文件写入成功\]$/, /^路径: /, /^大小: /, /^hash=/, /^说明: /],
};

/** 正文中间的整行分隔标记（不是开头连续块，需要逐行过滤）。 */
const ENVELOPE_INLINE_PATTERNS: Readonly<Record<string, readonly RegExp[]>> = {
  bash: [/^--- 标准(?:输出|错误) \(.*\) ---$/, /^\(命令执行完成，无控制台输出\)$/],
};

/**
 * 剥掉工具输出的回执外壳：开头连续的 `[xxx结果]` 标题与元信息行、bash 的 stdout/stderr
 * 分隔标记，以及 CLI 执行器追加在末尾的 `[verification_evidence_id: …]`。
 * 只处理已知工具；正文内容（包括以 `[` 开头或形如 `路径:` 的输出行）原样保留。
 */
export function stripToolOutputEnvelope(toolName: string, output: string): string {
  if (!output) return "";
  const name = toolName.trim().toLowerCase();
  const withoutEvidence = output.replace(/\n\[verification_evidence_id: [^\]]*\]\s*$/, "");
  let lines = withoutEvidence.replace(/\r\n?/g, "\n").split("\n");
  const leading = ENVELOPE_LEADING_PATTERNS[name];
  if (leading) {
    let start = 0;
    while (start < lines.length && leading.some((pattern) => pattern.test(lines[start])))
      start += 1;
    while (start < lines.length && lines[start].trim() === "") start += 1;
    lines = lines.slice(start);
  }
  const inline = ENVELOPE_INLINE_PATTERNS[name];
  if (inline) lines = lines.filter((line) => !inline.some((pattern) => pattern.test(line)));
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n");
}
