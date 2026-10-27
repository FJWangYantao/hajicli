/**
 * 按符号名读取定义块（`read({ path, symbol })`）。
 *
 * 动机：调研时模型常常已经知道符号名（`createToolCallBatches`），却要先 grep 找行号、
 * 再 read 一页、发现没读到函数尾再续读。`read_outline` 证明「给位置信息让模型直接跳」
 * 有效，这里再往前一步：直接按名字取回整个定义块。
 *
 * 实现仍是轻量正则 + 括号/缩进配平，不引入 AST：目标是导航，不是精确语法树。
 */

import { detectOutlineLanguage, extractOutline, type OutlineLanguage } from "./read-outline.js";

export interface SymbolDefinition {
  /** 定义起始行（1-based，含）。 */
  startLine: number;
  /** 定义结束行（1-based，含）。 */
  endLine: number;
  /** 匹配到的符号名。 */
  label: string;
}

/** 单个符号最多返回多少行，防止把整个文件当成一个函数体吐出来。 */
export const MAX_SYMBOL_BLOCK_LINES = 600;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 各语言的「定义行」模式。`name` 已转义，直接拼进正则。
 * 顺序即优先级：先函数/类型声明，再方法（方法要求行尾有 `{`，避免把调用当成定义）。
 */
function declarationPatterns(language: OutlineLanguage, name: string): RegExp[] {
  const n = escapeRegExp(name);
  switch (language) {
    case "ts":
      return [
        new RegExp(
          `^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s+${n}\\b`,
        ),
        new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${n}\\b`),
        new RegExp(`^\\s*(?:export\\s+)?interface\\s+${n}\\b`),
        new RegExp(`^\\s*(?:export\\s+)?type\\s+${n}\\b`),
        new RegExp(`^\\s*(?:export\\s+)?enum\\s+${n}\\b`),
        new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${n}\\b`),
        new RegExp(
          `^\\s+(?:(?:public|private|protected|static|readonly|async|get|set|override|abstract)\\s+)*${n}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::[^={]+)?\\{`,
        ),
      ];
    case "python":
      return [
        new RegExp(`^\\s*(?:async\\s+)?def\\s+${n}\\b`),
        new RegExp(`^\\s*class\\s+${n}\\b`),
        new RegExp(`^\\s*${n}\\s*(?::[^=]+)?=`),
      ];
    case "go":
      return [
        new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?${n}\\b`),
        new RegExp(`^type\\s+${n}\\b`),
        new RegExp(`^(?:var|const)\\s+${n}\\b`),
      ];
    case "rust":
      return [
        new RegExp(
          `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:const\\s+)?fn\\s+${n}\\b`,
        ),
        new RegExp(
          `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|enum|trait|union|type|const|static)\\s+${n}\\b`,
        ),
        new RegExp(`^\\s*impl\\b[^{]*\\b${n}\\b`),
        new RegExp(`^\\s*macro_rules!\\s*${n}\\b`),
      ];
    case "jvm":
      return [
        new RegExp(
          `^\\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|data|open|partial|override)\\s+)*(?:class|interface|enum|record|struct|object)\\s+${n}\\b`,
        ),
        new RegExp(
          `^\\s*(?:(?:public|private|protected|internal|override|suspend|inline|operator|tailrec|abstract|open|final)\\s+)*fun\\s+(?:<[^>]*>\\s*)?${n}\\s*\\(`,
        ),
        new RegExp(
          `^\\s*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|override)\\s+)+[\\w<>\\[\\],.? ]+\\s+${n}\\s*\\(`,
        ),
      ];
    case "shell":
      return [new RegExp(`^\\s*(?:function\\s+)?${n}\\s*\\(\\s*\\)\\s*\\{`)];
    case "markdown":
      return [new RegExp(`^#{1,6}\\s+.*\\b${n}\\b`)];
    default:
      return [
        new RegExp(
          `^\\s*(?:function|class|def|func|fn|const|let|var|type|interface|struct|enum)\\s+${n}\\b`,
        ),
      ];
  }
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

interface ScanState {
  inBlockComment: boolean;
}

/**
 * 扫描一行里的花括号净增量，跳过注释与字符串内容。
 * 模板字符串里的 `${}` 按字符串处理（少算一层），只影响「块尾多算几行」的极端情况。
 */
function braceDelta(line: string, state: ScanState): number {
  let delta = 0;
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (state.inBlockComment) {
      if (char === "*" && next === "/") {
        state.inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "/" && next === "/") break;
    if (char === "/" && next === "*") {
      state.inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") delta += 1;
    else if (char === "}") delta -= 1;
  }
  return delta;
}

/** 花括号配平的块尾；没有花括号的声明（类型别名、单行常量）读到 `;` 或空行为止。 */
function findBraceBlockEnd(lines: readonly string[], startIndex: number, maxLines: number): number {
  const state: ScanState = { inBlockComment: false };
  const limit = Math.min(lines.length, startIndex + maxLines);
  let depth = 0;
  let sawOpen = false;
  for (let index = startIndex; index < limit; index += 1) {
    const line = lines[index] ?? "";
    depth += braceDelta(line, state);
    if (depth > 0) sawOpen = true;
    if (sawOpen && depth <= 0) return index;
    if (!sawOpen) {
      if (/;\s*$/.test(line)) return index;
      if (index > startIndex && line.trim().length === 0) return index - 1;
    }
  }
  if (!sawOpen) return startIndex;
  return Math.max(startIndex, limit - 1);
}

/** Python 的块尾由缩进决定：遇到缩进不深于定义行的非空行即结束。 */
function findIndentBlockEnd(
  lines: readonly string[],
  startIndex: number,
  maxLines: number,
): number {
  const startIndent = indentOf(lines[startIndex] ?? "");
  const limit = Math.min(lines.length, startIndex + maxLines);
  let end = startIndex;
  for (let index = startIndex + 1; index < limit; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    if (indentOf(line) <= startIndent) break;
    end = index;
  }
  return end;
}

function findMarkdownSection(lines: readonly string[], name: string): SymbolDefinition | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(lines[index] ?? "");
    if (!heading) continue;
    const text = heading[2] ?? "";
    if (!text.includes(name)) continue;
    const level = (heading[1] ?? "").length;
    let end = lines.length - 1;
    for (let next = index + 1; next < lines.length; next += 1) {
      const other = /^(#{1,6})\s+/.exec(lines[next] ?? "");
      if (other && (other[1] ?? "").length <= level) {
        end = next - 1;
        break;
      }
    }
    while (end > index && (lines[end] ?? "").trim().length === 0) end -= 1;
    return { startLine: index + 1, endLine: end + 1, label: name };
  }
  return undefined;
}

/**
 * 在文件里找 `symbol` 的定义块。
 * 找不到返回 undefined；同名的第二次出现（例如调用点）不会被误当成定义，因为模式要求声明关键字。
 */
export function findSymbolDefinition(
  lines: readonly string[],
  symbol: string,
  filePath: string,
  maxLines = MAX_SYMBOL_BLOCK_LINES,
): SymbolDefinition | undefined {
  const name = symbol.trim();
  if (!name) return undefined;
  const language = detectOutlineLanguage(filePath);
  if (language === "markdown") return findMarkdownSection(lines, name);
  const patterns = declarationPatterns(language, name);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length === 0 || line.length > 400) continue;
    if (!patterns.some((pattern) => pattern.test(line))) continue;
    const endIndex =
      language === "python"
        ? findIndentBlockEnd(lines, index, maxLines)
        : findBraceBlockEnd(lines, index, maxLines);
    return { startLine: index + 1, endLine: endIndex + 1, label: name };
  }
  return undefined;
}

/** 有上限的编辑距离：只用来给「名字打错一个字母」兜底，超阈值直接放弃。 */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}

/** 找不到时给几个名字相近的符号，省掉一次 grep。 */
export function findSimilarSymbols(
  lines: readonly string[],
  symbol: string,
  filePath: string,
  limit = 5,
): { line: number; label: string }[] {
  const language = detectOutlineLanguage(filePath);
  if (language === "unknown") return [];
  const needle = symbol.trim().toLowerCase();
  if (!needle) return [];
  const entries = extractOutline(lines, 1, language, 400);
  const scored: { line: number; label: string; distance: number }[] = [];
  for (const entry of entries) {
    const name = entry.label.split(" ").slice(1).join(" ").toLowerCase();
    if (!name) continue;
    if (name.includes(needle) || needle.includes(name)) {
      scored.push({ ...entry, distance: 0 });
      continue;
    }
    const distance = editDistance(name, needle, 3);
    if (distance <= 3) scored.push({ ...entry, distance });
  }
  scored.sort((left, right) => left.distance - right.distance || left.line - right.line);
  return scored.slice(0, limit).map(({ line, label }) => ({ line, label }));
}
