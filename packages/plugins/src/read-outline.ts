/**
 * read 截断时的「剩余符号提纲」。
 *
 * 当前页之后还有内容时，只给 `nextStartLine` 会让模型一页页往后翻；这里额外列出
 * 剩余区间里的函数/类/接口（带行号），模型可以直接用 `aroundLine` 跳到目标位置。
 *
 * 只做轻量正则扫描，不引入语言解析器：目标是给导航锚点，不是精确 AST。
 * 未知扩展名不输出提纲——宁可不给，也不给噪声。
 */

export type OutlineLanguage =
  | "ts"
  | "python"
  | "go"
  | "rust"
  | "jvm"
  | "markdown"
  | "shell"
  | "unknown";

export interface OutlineEntry {
  /** 1-based 行号。 */
  line: number;
  /** 展示标签，如 `fn runAgentTurn`、`class SessionManager`。 */
  label: string;
}

/** 提纲最多列多少个符号；超出时按行号均匀抽样，兼顾近处续读与远处跳转。 */
export const MAX_OUTLINE_ENTRIES = 24;
/** 提纲默认字符上限（含 `[剩余符号] ` 前缀）。 */
export const MAX_OUTLINE_CHARS = 600;
/** 扫描阶段最多收集多少个符号，避免超大文件里做无意义的长扫描。 */
const MAX_SCAN_ENTRIES = 500;

interface OutlineRule {
  readonly pattern: RegExp;
  readonly kind: string;
  /** 允许的最大缩进列数；undefined 表示只匹配顶层（缩进 0）。 */
  readonly maxIndent?: number;
}

const TS_RULES: readonly OutlineRule[] = [
  {
    pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    kind: "fn",
    maxIndent: 6,
  },
  {
    pattern:
      /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
    kind: "fn",
    maxIndent: 6,
  },
  {
    pattern: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function/,
    kind: "fn",
    maxIndent: 6,
  },
  {
    pattern: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: "class",
    maxIndent: 0,
  },
  {
    pattern: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
    kind: "interface",
    maxIndent: 0,
  },
  {
    pattern: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/,
    kind: "type",
    maxIndent: 0,
  },
  {
    pattern: /^(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/,
    kind: "enum",
    maxIndent: 0,
  },
];

const PYTHON_RULES: readonly OutlineRule[] = [
  { pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "def", maxIndent: 8 },
  { pattern: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class", maxIndent: 8 },
];

const GO_RULES: readonly OutlineRule[] = [
  { pattern: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "func", maxIndent: 0 },
  { pattern: /^type\s+([A-Za-z_]\w*)/, kind: "type", maxIndent: 0 },
];

const RUST_RULES: readonly OutlineRule[] = [
  {
    pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/,
    kind: "fn",
    maxIndent: 8,
  },
  {
    pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+([A-Za-z_]\w*)/,
    kind: "type",
    maxIndent: 0,
  },
  {
    pattern: /^(?:pub(?:\([^)]*\))?\s+)?impl\b[^{]*?\b([A-Za-z_]\w*)/,
    kind: "impl",
    maxIndent: 0,
  },
];

const JVM_RULES: readonly OutlineRule[] = [
  {
    pattern:
      /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|data|open|partial|override)\s+)*(?:class|interface|enum|record|struct|object)\s+([A-Za-z_]\w*)/,
    kind: "class",
    maxIndent: 4,
  },
  {
    pattern:
      /^\s*(?:(?:public|private|protected|internal|override|suspend|inline|operator|tailrec)\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/,
    kind: "fun",
    maxIndent: 8,
  },
];

const MARKDOWN_RULES: readonly OutlineRule[] = [
  { pattern: /^(#{1,4})\s+(.+?)\s*$/, kind: "§", maxIndent: 0 },
];

const SHELL_RULES: readonly OutlineRule[] = [
  { pattern: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/, kind: "fn", maxIndent: 0 },
];

const RULES: Readonly<Record<Exclude<OutlineLanguage, "unknown">, readonly OutlineRule[]>> = {
  ts: TS_RULES,
  python: PYTHON_RULES,
  go: GO_RULES,
  rust: RUST_RULES,
  jvm: JVM_RULES,
  markdown: MARKDOWN_RULES,
  shell: SHELL_RULES,
};

const EXTENSION_LANGUAGE: Readonly<Record<string, OutlineLanguage>> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "ts",
  ".jsx": "ts",
  ".mjs": "ts",
  ".cjs": "ts",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "jvm",
  ".kt": "jvm",
  ".kts": "jvm",
  ".scala": "jvm",
  ".cs": "jvm",
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
};

/** 按扩展名判定提纲语言；未知扩展名返回 `unknown`。 */
export function detectOutlineLanguage(filePath: string): OutlineLanguage {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return "unknown";
  const extension = filePath.slice(dot).toLowerCase();
  return EXTENSION_LANGUAGE[extension] ?? "unknown";
}

function labelFor(kind: string, rawName: string): string {
  const name = rawName.replace(/\s+/g, " ").trim().slice(0, 40);
  return kind === "§" ? `§ ${name}` : `${kind} ${name}`;
}

/**
 * 扫描 `fromLine`（1-based，含）之后的符号。
 * 结果按行号升序；超过 `limit` 时提前停止（调用方负责抽样）。
 */
export function extractOutline(
  lines: readonly string[],
  fromLine: number,
  language: OutlineLanguage,
  limit = MAX_SCAN_ENTRIES,
): OutlineEntry[] {
  if (language === "unknown") return [];
  const rules = RULES[language];
  const entries: OutlineEntry[] = [];
  const start = Math.max(0, fromLine - 1);
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length === 0 || line.length > 400) continue;
    const indent = line.length - line.trimStart().length;
    for (const rule of rules) {
      if (indent > (rule.maxIndent ?? 0)) continue;
      const match = rule.pattern.exec(line);
      if (!match) continue;
      // Markdown 的标题文本在第二组，其余规则名字在第一组。
      const name = rule.kind === "§" ? match[2] : match[1];
      if (!name) continue;
      entries.push({ line: index + 1, label: labelFor(rule.kind, name) });
      break;
    }
    if (entries.length >= limit) break;
  }
  return entries;
}

/** 条目过多时按行号均匀抽样，保留第一个和最后一个。 */
export function sampleOutlineEntries(
  entries: readonly OutlineEntry[],
  max = MAX_OUTLINE_ENTRIES,
): OutlineEntry[] {
  if (entries.length <= max) return [...entries];
  if (max <= 1) return entries.length > 0 ? [entries[0]!] : [];
  const picked: OutlineEntry[] = [];
  for (let index = 0; index < max; index += 1) {
    const sourceIndex = Math.round((index * (entries.length - 1)) / (max - 1));
    const entry = entries[sourceIndex];
    if (!entry) continue;
    if (picked.length > 0 && picked[picked.length - 1]?.line === entry.line) continue;
    picked.push(entry);
  }
  return picked;
}

/**
 * 把条目格式化成一行提纲，超出 `budgetChars` 时截断；
 * 截断时尽量保留最后一个符号作为「文件后段」的锚点。
 */
export function formatOutline(
  entries: readonly OutlineEntry[],
  budgetChars = MAX_OUTLINE_CHARS,
): string | undefined {
  if (entries.length === 0 || budgetChars <= 0) return undefined;
  const header = "[剩余符号] ";
  const separator = " · ";
  const pieces = entries.map((entry) => `${entry.line} ${entry.label}`);
  const parts: string[] = [];
  let length = header.length;
  for (const piece of pieces) {
    const addition = (parts.length > 0 ? separator.length : 0) + piece.length;
    if (length + addition > budgetChars) {
      const last = pieces[pieces.length - 1];
      if (last && parts.length > 0 && parts[parts.length - 1] !== last) {
        // " · … · <last>"：保留远端锚点，同时明确中间有省略。
        const additionLast = separator.length + 1 + separator.length + last.length;
        if (length + additionLast <= budgetChars) {
          parts.push("…", last);
        } else if (length + separator.length + 1 <= budgetChars) {
          // 远端锚点也放不下时至少标出「后面还有」。
          parts.push("…");
        }
      }
      break;
    }
    parts.push(piece);
    length += addition;
  }
  if (parts.length === 0) return undefined;
  return `${header}${parts.join(separator)}`;
}

/**
 * 生成「当前页之后」的符号提纲。
 *
 * @param lines 文件按行拆分后的内容。
 * @param fromLine 剩余区间起始行（1-based，含）。
 * @param filePath 用于判定语言。
 * @param budgetChars 提纲字符上限。
 */
export function buildRemainingOutline(
  lines: readonly string[],
  fromLine: number,
  filePath: string,
  budgetChars = MAX_OUTLINE_CHARS,
): string | undefined {
  const language = detectOutlineLanguage(filePath);
  if (language === "unknown" || budgetChars <= 0) return undefined;
  const entries = extractOutline(lines, fromLine, language);
  if (entries.length === 0) return undefined;
  return formatOutline(sampleOutlineEntries(entries), budgetChars);
}
