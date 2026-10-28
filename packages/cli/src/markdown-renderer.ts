/**
 * 终端 Markdown 流式渲染引擎。
 * 支持增量流式防闪烁自动补全、代码块语法高亮、Diff 高亮、表格美化、任务列表及 ANSI 样式。
 * 纯 TypeScript 实现，零外部依赖。
 */

import { performanceMonitor } from "@hajicli/core";
import { sanitizeTerminalText } from "./terminal-sanitize.js";
import { wrapAnsi } from "./terminal-text.js";
import { buildAnsiStyles, getColorLevel, getTheme } from "./theme.js";

/**
 * ANSI 样式代码字典。颜色取自当前主题（24-bit 真彩色），使 Markdown 渲染
 * 不再依赖终端 16 色调色板；reset 会恢复主题前景与背景，保证背景不丢失。
 *
 * **必须在渲染时按当前主题重建**：本模块在启动早期就被 import，那时终端外观
 * （dark / light）还没探测完，模块加载期构建的字典会永远停在深色调色板上。
 * 白底终端里后果很直接：列表符号是深色板的 muted（浅灰），而 `reset` 更会把
 * 后续正文刷成深色板的 foreground `#d9dee7`——白底上的浅灰字，越看越累。
 */
let ANSI = buildAnsiStyles();
let ansiTheme = getTheme();
let ansiColorLevel = getColorLevel();

/** 主题或颜色能力变了就重建样式字典（切换主题/外观时主题对象会换身份）。 */
function refreshAnsiStyles(): void {
  const theme = getTheme();
  const level = getColorLevel();
  if (theme === ansiTheme && level === ansiColorLevel) return;
  ANSI = buildAnsiStyles();
  ansiTheme = theme;
  ansiColorLevel = level;
}

/** 常见编程语言关键字集合 */
const KEYWORDS = new Set([
  "import",
  "export",
  "from",
  "default",
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "try",
  "catch",
  "finally",
  "throw",
  "new",
  "class",
  "extends",
  "interface",
  "type",
  "async",
  "await",
  "yield",
  "typeof",
  "instanceof",
  "void",
  "public",
  "private",
  "protected",
  "readonly",
  "static",
  "as",
  "is",
  "null",
  "undefined",
  "true",
  "false",
  "boolean",
  "string",
  "number",
]);

/** Limits expensive full Markdown reparses while model chunks arrive rapidly. */
/** [text](url) 与 ![alt](url)；地址中允许一层括号（如维基百科链接）。 */
const MARKDOWN_LINK_RE = /(!)?\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g;
/** <https://...> 形式的自动链接。 */
const AUTOLINK_RE = /<(https?:\/\/[^\s>]+)>/g;
/** 正文中的裸 URL；末尾的中英文标点不计入地址。 */
const BARE_URL_RE =
  /https?:\/\/[^\s<>()（）\uE000\uE001]*[^\s<>()（）.,;:!?'"，。；：！？、\uE000\uE001]/g;

export class MarkdownRenderThrottle {
  private lastRenderAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly intervalMs = 32) {}

  /**
   * Longer accumulated replies cost more to reparse, so reduce their refresh
   * rate while preserving the final, unthrottled render performed by the caller.
   */
  shouldRender(now = Date.now(), contentLength = 0): boolean {
    const adaptiveInterval =
      contentLength >= 64_000
        ? Math.max(this.intervalMs, 64)
        : contentLength >= 24_000
          ? Math.max(this.intervalMs, 48)
          : this.intervalMs;
    if (now - this.lastRenderAt < adaptiveInterval) return false;
    this.lastRenderAt = now;
    return true;
  }
}

/**
 * 除 `\t` / `\n` 以外的 C0/C1 控制字符与 `\r`。
 *
 * `sanitizeTerminalText` 是逐字符扫描的 O(n) 实现，而正常模型输出里几乎不含控制字符。
 * 不含这些字符时 sanitize 是恒等映射（可打印字符原样保留），因此可以先做一次正则扫描
 * 跳过整趟扫描——这是纯优化，输出与慢路径完全一致。
 */
const UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** 行首为 ``` 的行数（等价于 `text.match(/^```/gm)` 的计数）。 */
function countFenceLines(text: string): number {
  let count = 0;
  let atLineStart = true;
  for (let i = 0; i < text.length; i++) {
    if (atLineStart && text.charCodeAt(i) === 0x60 && text.startsWith("```", i)) {
      count += 1;
      atLineStart = false;
      continue;
    }
    atLineStart = text.charCodeAt(i) === 0x0a;
  }
  return count;
}

/** 双星号成对出现的非重叠次数（与全局 match 计数一致）。 */
function countDoubleStars(text: string): number {
  let count = 0;
  let index = text.indexOf("**");
  while (index !== -1) {
    count += 1;
    index = text.indexOf("**", index + 2);
  }
  return count;
}

/** 单行内反引号的出现次数。 */
function countBackticks(text: string): number {
  let count = 0;
  let index = text.indexOf("`");
  while (index !== -1) {
    count += 1;
    index = text.indexOf("`", index + 1);
  }
  return count;
}

/** Only show the fallback thinking summary when a tool call has no visible assistant text. */
export function shouldShowToolThinkingSummary(textContent: string, toolCallCount: number): boolean {
  return toolCallCount > 0 && textContent.trim().length === 0;
}

/**
 * 流式 Markdown 解析与终端 ANSI 渲染器。
 */
export class MarkdownStreamRenderer {
  /** 累积接收到的原始 Markdown 全量文本 */
  private rawContent = "";

  /**
   * 流式增量解析的前缀缓存。
   *
   * 只缓存落在"空闲态"（不在代码块、表格、ASCII 卡片内）行尾之前的已渲染行——
   * 这些行的渲染彼此独立（行分类只看本行内容），后续追加的文本不会回头改写它们。
   * 命中后只解析尾部，单帧成本与新增内容成正比，而不是与全文长度成正比。
   *
   * 宽度或主题（含颜色能力）变化会让已渲染行的 ANSI 失效，因此一并记进键里。
   */
  private prefixCache:
    | {
        source: string;
        rows: string[];
        width: number;
        theme: ReturnType<typeof getTheme>;
        colorLevel: ReturnType<typeof getColorLevel>;
        /** 前缀内的代码围栏行数（autoCloseMarkdown 的奇偶判断只需增量统计）。 */
        fenceCount: number;
        /** 前缀内 `**` 的非重叠出现次数。 */
        boldCount: number;
      }
    | undefined;

  /**
   * 代码行高亮的行级缓存。
   *
   * `highlightCodeLine` 只依赖行内容与当前 ANSI 字典（纯函数），而流式期间同一个
   * 代码块里已输出的行会被每帧重新高亮一次，长代码块下这是实打实的重复正则运算。
   * 主题或颜色能力变化会让已缓存的 ANSI 失效，用身份比对整表作废。
   */
  private codeLineCache = new Map<string, string>();
  private codeLineCacheTheme: ReturnType<typeof getTheme> | undefined = undefined;
  private codeLineCacheColorLevel: ReturnType<typeof getColorLevel> | undefined = undefined;

  constructor(
    private readonly widthProvider: () => number = () =>
      Math.max(20, (process.stdout?.columns || 80) - 2),
  ) {}

  /**
   * 重置渲染器状态。
   */
  reset(): void {
    this.rawContent = "";
    this.prefixCache = undefined;
  }

  /**
   * 追加流式片段并返回格式化后的终端 ANSI 字符串。
   * @param chunk 增量吐出的 Markdown 片段
   * @param isFinal 是否为最终输出
   */
  appendAndRender(chunk: string, isFinal = false): string {
    this.rawContent += chunk;
    return this.render(this.rawContent, isFinal);
  }

  /**
   * 对指定的 Markdown 文本进行 ANSI 渲染。
   * @param content 原始 Markdown 文本
   * @param isFinal 是否已结束流式输出
   */
  render(content: string, isFinal = false): string {
    // 主题/颜色能力可能在 import 之后才确定（启动探测外观、/appearance 切换），
    // 每次渲染前对齐一次，否则 Markdown 会一直用启动那一刻的调色板。
    refreshAnsiStyles();
    return performanceMonitor.measureSync("markdown.render", () =>
      this.renderContent(content, isFinal),
    );
  }

  private renderContent(content: string, isFinal: boolean): string {
    // 1. 控制序列消毒。含控制字符时 sanitize 会删改字符，sanitize 前后的偏移不再
    //    一一对应，前缀缓存的边界就会错位——这种情况直接走全量。
    const needsSanitize = UNSAFE_CONTROL_RE.test(content);
    const safeContent = needsSanitize ? sanitizeTerminalText(content) : content;

    // 2. 命中前缀缓存时只解析尾部。缓存边界落在"空闲态"行尾，已渲染行与后续追加的
    //    文本互不影响，所以复用它们是安全的；任一键不符（宽度/主题/颜色能力/前缀不匹配）
    //    就退回全量解析。先判断复用再补全未闭合语法：补全只动尾部，不影响前缀。
    const width = this.getMaxWidth();
    const cached = this.prefixCache;
    const reuse =
      !needsSanitize &&
      cached !== undefined &&
      cached.width === width &&
      cached.theme === ansiTheme &&
      cached.colorLevel === ansiColorLevel &&
      safeContent.startsWith(cached.source);
    const baseLength = reuse && cached ? cached.source.length : 0;

    // 3. 流式中间态时补充未闭合语法标签。围栏/粗体只统计尾部，前缀计数走缓存。
    const processedContent = isFinal
      ? safeContent
      : this.autoCloseMarkdown(
          safeContent,
          baseLength,
          reuse && cached ? cached.fenceCount : 0,
          reuse && cached ? cached.boldCount : 0,
        );

    const renderedLines: string[] = reuse && cached ? cached.rows.slice() : [];
    const tail = reuse && cached ? processedContent.slice(baseLength) : processedContent;

    // 4. 按行拆解并分析元素
    const lines = tail.split(/\r?\n/);
    // 每行在 tail 中的起始偏移。用换行符位置而不是行长累加：\r\n 里 \r 被 split 吃掉，
    // 按行长 +1 累加会少算一个字符，缓存边界就会切错。
    const lineStarts: number[] = [0];
    for (let p = 0; p < tail.length; p++) {
      if (tail[p] === "\n") lineStarts.push(p + 1);
    }

    let inCodeBlock = false;
    let codeLanguage = "";
    let codeBlockBuffer: string[] = [];
    let tableBuffer: string[] = [];
    let inAsciiCard = false;
    let asciiCardHeader = "";
    let asciiCardBuffer: string[] = [];

    // 5. 记录最后一个"空闲态行尾"作为下次可复用的边界。行分类只看本行内容，
    //    因此空闲态的行渲染完就不会再被后续文本改写；要求该行之后仍有换行，
    //    否则边界落在半行上，切片语义会错。同时累计围栏/粗体计数供下次增量统计。
    let safeRowCount = -1;
    let safeTailOffset = -1;
    let safeFenceCount = 0;
    let safeBoldCount = 0;
    let fenceSeen = 0;
    let boldSeen = 0;
    const recordSafe = (index: number): void => {
      if (inCodeBlock || tableBuffer.length > 0 || inAsciiCard) return;
      if (index >= lines.length - 1) return;
      safeRowCount = renderedLines.length;
      safeTailOffset = lineStarts[index + 1];
      safeFenceCount = fenceSeen;
      safeBoldCount = boldSeen;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("```")) fenceSeen += 1;
      boldSeen += countDoubleStars(line);

      // 检测代码块边界 (``` 或 ````)
      const codeBlockMatch = line.match(/^(`{3,})([a-zA-Z0-9_-]*)/);
      if (codeBlockMatch) {
        if (inAsciiCard) {
          renderedLines.push(...this.renderAsciiCard(asciiCardHeader, asciiCardBuffer));
          inAsciiCard = false;
          asciiCardBuffer = [];
        }
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeLanguage = codeBlockMatch[2].toLowerCase();
          codeBlockBuffer = [];
        } else {
          inCodeBlock = false;
          renderedLines.push(...this.renderCodeBlock(codeBlockBuffer, codeLanguage));
          codeLanguage = "";
          codeBlockBuffer = [];
        }
        recordSafe(i);
        continue;
      }

      // 处理代码块内部内容
      if (inCodeBlock) {
        codeBlockBuffer.push(line);
        continue;
      }

      // 检测表格行 (| col1 | col2 |)
      if (this.isTableLine(line)) {
        if (inAsciiCard) {
          renderedLines.push(...this.renderAsciiCard(asciiCardHeader, asciiCardBuffer));
          inAsciiCard = false;
          asciiCardBuffer = [];
        }
        tableBuffer.push(line);
        if (i === lines.length - 1) {
          renderedLines.push(...this.renderTable(tableBuffer));
          tableBuffer = [];
        }
        continue;
      } else if (tableBuffer.length > 0) {
        renderedLines.push(...this.renderTable(tableBuffer));
        tableBuffer = [];
      }

      // 检测 ASCII 框图卡片顶栏 (如 ┌── code ──── 或 ┌──────)
      if (line.match(/^┌──/)) {
        if (inAsciiCard) {
          renderedLines.push(...this.renderAsciiCard(asciiCardHeader, asciiCardBuffer));
        }
        inAsciiCard = true;
        asciiCardHeader = line;
        asciiCardBuffer = [];
        continue;
      }

      // 检测 ASCII 框图卡片显式底栏 (如 └────────)
      if (inAsciiCard && line.match(/^\s*└─+/)) {
        renderedLines.push(...this.renderAsciiCard(asciiCardHeader, asciiCardBuffer));
        inAsciiCard = false;
        asciiCardBuffer = [];
        recordSafe(i);
        continue;
      }

      // 检测 Markdown 标题（若正处于 ASCII 卡片内则先闭合卡片）
      if (inAsciiCard && line.match(/^#{1,6}\s/)) {
        renderedLines.push(...this.renderAsciiCard(asciiCardHeader, asciiCardBuffer));
        inAsciiCard = false;
        asciiCardBuffer = [];
      }

      if (inAsciiCard) {
        asciiCardBuffer.push(line);
        continue;
      }

      // 渲染普通 Markdown 行
      renderedLines.push(this.renderNormalLine(line));
      recordSafe(i);
    }

    // 针对流式未闭合代码块的兜底渲染
    if (inCodeBlock && codeBlockBuffer.length > 0) {
      renderedLines.push(...this.renderCodeBlock(codeBlockBuffer, codeLanguage));
    }

    // 处理积攒的表格
    if (tableBuffer.length > 0) {
      renderedLines.push(...this.renderTable(tableBuffer));
    }

    // 针对未闭合 ASCII 框图卡片的自动补全底栏
    if (inAsciiCard) {
      renderedLines.push(...this.renderAsciiCard(asciiCardHeader, asciiCardBuffer));
      inAsciiCard = false;
      asciiCardBuffer = [];
    }

    // 5. 更新前缀缓存。只有真的出现空闲态行尾才延长边界；本次没找到边界但旧缓存
    //    依然有效（新文本仍以它为前缀）时保持原样，避免把已复用的前缀丢掉。
    if (safeRowCount >= 0) {
      const prefix = reuse && cached ? cached.source : "";
      this.prefixCache = {
        source: prefix + tail.slice(0, safeTailOffset),
        rows: renderedLines.slice(0, safeRowCount),
        width,
        theme: ansiTheme,
        colorLevel: ansiColorLevel,
        fenceCount: (reuse && cached ? cached.fenceCount : 0) + safeFenceCount,
        boldCount: (reuse && cached ? cached.boldCount : 0) + safeBoldCount,
      };
    } else if (!reuse) {
      this.prefixCache = undefined;
    }

    return renderedLines.join("\n");
  }

  /**
   * 渲染 4 面完整闭合的 ASCII 卡片框图，包含右侧竖线边框 `│` 且宽度按内容自适应收紧。
   */
  private renderAsciiCard(headerLine: string, lines: string[]): string[] {
    const output: string[] = [];
    const maxWidth = this.getMaxWidth();

    const match = headerLine.match(/^┌──\s*([a-zA-Z0-9_-]*)/);
    const langLabel = match?.[1] ? ` ${match[1]} ` : " code ";

    if (maxWidth < 40) {
      return [
        `${ANSI.gray}◇${langLabel.trim() ? ` ${langLabel.trim()}` : ""}${ANSI.reset}`,
        ...lines.map((line) => `${ANSI.gray}│${ANSI.reset} ${this.renderNormalLine(line)}`),
      ];
    }

    // 测量卡片内部最长文本的可视宽度（同样循环求最大值）
    let maxContentLen = 10;
    for (const line of lines) maxContentLen = Math.max(maxContentLen, this.getTextWidth(line));

    const innerWidth = Math.min(maxWidth - 4, maxContentLen);
    const cardWidth = innerWidth + 4;
    const topDashes = Math.max(2, cardWidth - 4 - langLabel.length);

    // 顶栏边框 ┌── label ───────┐
    output.push(
      `${ANSI.gray}┌──${ANSI.cyan}${langLabel}${ANSI.gray}${"─".repeat(topDashes)}┐${ANSI.reset}`,
    );

    for (const line of lines) {
      const styled = this.renderNormalLine(line);
      const truncated = this.truncateVisual(styled, innerWidth);
      const padLen = Math.max(0, innerWidth - this.getTextWidth(truncated));
      output.push(
        `${ANSI.gray}│${ANSI.reset} ${truncated}${" ".repeat(padLen)} ${ANSI.gray}│${ANSI.reset}`,
      );
    }

    // 底栏边框 └────────────────┘
    const botDashes = Math.max(2, cardWidth - 2);
    output.push(`${ANSI.gray}└${"─".repeat(botDashes)}┘${ANSI.reset}`);

    return output;
  }

  /**
   * 自动闭合流式片段中的未完结语法结构。
   *
   * 围栏与粗体的计数只需看尾部：前缀（`tailStart` 之前）的计数由调用方从缓存传入，
   * 因为前缀总在完整行尾结束，跨行不会产生新的 `**` 或围栏行。这样每次只扫描新增
   * 内容，成本与全文长度无关。
   */
  private autoCloseMarkdown(
    text: string,
    tailStart: number,
    prefixFenceCount: number,
    prefixBoldCount: number,
  ): string {
    const tail = tailStart > 0 ? text.slice(tailStart) : text;
    let closed = text;

    // 补全代码块 ```
    const codeBlockCount = prefixFenceCount + countFenceLines(tail);
    if (codeBlockCount % 2 !== 0) {
      closed += "\n```";
    }

    // 补全粗体 **（追加的围栏行不含 **，所以这里不必重扫全文）
    const boldCount = prefixBoldCount + countDoubleStars(tail);
    if (boldCount % 2 !== 0) {
      closed += "**";
    }

    // 补齐末行未闭合的单反引号 `：末行就是文本结尾，直接追加即可
    const lastLine = closed.slice(closed.lastIndexOf("\n") + 1);
    if (countBackticks(lastLine) % 2 !== 0) {
      closed += "`";
    }

    return closed;
  }

  /**
   * 渲染普通 Markdown 行。
   */
  private renderNormalLine(line: string): string {
    // 1. 标题 (# ~ ######)
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const text = this.renderInlineStyles(headerMatch[2]);
      if (level === 1) {
        return `${ANSI.bold}${ANSI.magenta}◆ ${text}${ANSI.reset}`;
      } else if (level === 2) {
        return `${ANSI.bold}◇ ${text}${ANSI.reset}`;
      } else {
        return `${ANSI.gray}›${ANSI.reset} ${ANSI.bold}${text}${ANSI.reset}`;
      }
    }

    // 2. 引用块 (> text)
    const quoteMatch = line.match(/^>\s*(.*)$/);
    if (quoteMatch) {
      const text = this.renderInlineStyles(quoteMatch[1]);
      return `${ANSI.gray}│${ANSI.reset} ${ANSI.italic}${text}${ANSI.reset}`;
    }

    // 3. 任务列表 (- [ ] / - [x])
    const taskMatch = line.match(/^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      const indent = taskMatch[1];
      const isChecked = taskMatch[3].toLowerCase() === "x";
      const text = this.renderInlineStyles(taskMatch[4]);
      if (isChecked) {
        return `${indent}${ANSI.green}☑ ${ANSI.strikethrough}${text}${ANSI.reset}`;
      } else {
        return `${indent}${ANSI.yellow}☐ ${text}${ANSI.reset}`;
      }
    }

    // 4. 无序列表 (- / * / +)
    const listMatch = line.match(/^(\s*)([-*+])\s+(.*)$/);
    if (listMatch) {
      const indent = listMatch[1];
      const text = this.renderInlineStyles(listMatch[3]);
      return `${indent}${ANSI.gray}•${ANSI.reset} ${text}`;
    }

    // 5. 有序列表 (1.)
    const numListMatch = line.match(/^(\s*)(\d+\.)\s+(.*)$/);
    if (numListMatch) {
      const indent = numListMatch[1];
      const num = numListMatch[2];
      const text = this.renderInlineStyles(numListMatch[3]);
      return `${indent}${ANSI.cyan}${num}${ANSI.reset} ${text}`;
    }

    // 6. 普通文本
    return this.renderInlineStyles(line);
  }

  /**
   * 渲染行内样式（粗体、斜体、删除线、行内代码）。
   */
  private renderInlineStyles(text: string, compactLinks = false): string {
    // 行内代码、链接与裸 URL 先替换为占位符，避免其中的 _ * 被当作强调语法改写。
    const protectedSegments: string[] = [];
    const protect = (rendered: string): string => {
      protectedSegments.push(rendered);
      return `\uE000${protectedSegments.length - 1}\uE001`;
    };
    let result = text;

    // 行内代码 `code`
    result = result.replace(/`([^`]+)`/g, (_match, code) => {
      return protect(`${ANSI.yellow}${code}${ANSI.reset}`);
    });

    // 链接 [text](url)、图片 ![alt](url)、自动链接 <url> 与裸 URL
    result = result.replace(MARKDOWN_LINK_RE, (_match, image, label, url) =>
      protect(this.renderLink(image ? `图片: ${label || url}` : label || url, url, compactLinks)),
    );
    result = result.replace(AUTOLINK_RE, (_match, url) =>
      protect(this.renderLink(url, url, compactLinks)),
    );
    result = result.replace(BARE_URL_RE, (url) => protect(this.renderLink(url, url, compactLinks)));

    // 粗体 **text** 或 __text__
    result = result.replace(/(\*\*|__)(.*?)\1/g, (_match, _p1, p2) => {
      return `${ANSI.bold}${p2}${ANSI.reset}`;
    });

    // 斜体 *text* 或 _text_
    // 与 stripMarkdown 相同的边界规则：snake_case 标识符中的下划线不会被当作斜体。
    result = result.replace(/(^|[^\w])(\*|_)(?!\s)(.+?)\2(?=[^\w]|$)/g, (_match, lead, _p2, p3) => {
      return `${lead}${ANSI.italic}${p3}${ANSI.reset}`;
    });

    // 删除线 ~~text~~
    result = result.replace(/~~(.*?)~~/g, (_match, p1) => {
      return `${ANSI.strikethrough}${p1}${ANSI.reset}`;
    });

    return result.replace(
      /\uE000(\d+)\uE001/g,
      (_match, index) => protectedSegments[Number(index)] ?? "",
    );
  }

  /**
   * 链接显示为下划线文字，并在其后以灰色附上地址（文字即地址时只显示一次）；
   * 地址保持原样输出，便于终端自动识别为可点击链接。表格内只保留文字以免撑宽列。
   */
  private renderLink(label: string, url: string, compact: boolean): string {
    const text = `${ANSI.underline}${ANSI.blue}${label}${ANSI.reset}`;
    if (compact || label === url) return text;
    return `${text} ${ANSI.gray}${url}${ANSI.reset}`;
  }

  /**
   * 获取终端当前可用可视宽度（留出安全边距）。
   */
  private getMaxWidth(): number {
    const width = this.widthProvider();
    return Math.max(1, Number.isFinite(width) ? Math.floor(width) : 78);
  }

  /**
   * 按终端可视宽度截断文本，超出部分以 `…` 替换，并包含 ANSI 样式重置。
   */
  private truncateVisual(str: string, targetWidth: number): string {
    if (targetWidth <= 0) return "";
    const totalWidth = this.getTextWidth(str);
    if (totalWidth <= targetWidth) return str;

    const limit = Math.max(1, targetWidth - 1);
    let currentWidth = 0;
    let result = "";
    const ansiPrefix = /^\x1b\[[0-?]*[ -/]*[@-~]/;
    let i = 0;

    while (i < str.length) {
      const rest = str.slice(i);
      const match = rest.match(ansiPrefix);
      if (match) {
        result += match[0];
        i += match[0].length;
        continue;
      }

      const ch = str[i];
      const cp = ch.codePointAt(0) ?? 0;
      const w = this.isWideChar(cp) ? 2 : 1;

      if (currentWidth + w > limit) {
        break;
      }

      result += ch;
      currentWidth += w;
      i++;
    }

    return `${result}${ANSI.reset}…`;
  }

  /**
   * 渲染代码块（包含 4 面完整封闭边框、自适应紧凑宽度与语法高亮）。
   */
  private renderCodeBlock(lines: string[], lang: string): string[] {
    const output: string[] = [];
    const langLabel = lang ? ` ${lang} ` : " code ";
    const maxWidth = this.getMaxWidth();

    if (maxWidth < 40) {
      output.push(`${ANSI.gray}◇ ${lang || "code"}${ANSI.reset}`);
      for (const line of lines) {
        const styled =
          lang === "diff"
            ? line.startsWith("+")
              ? `${ANSI.green}${line}${ANSI.reset}`
              : line.startsWith("-")
                ? `${ANSI.red}${line}${ANSI.reset}`
                : line.startsWith("@@")
                  ? `${ANSI.cyan}${line}${ANSI.reset}`
                  : line
            : this.highlightCodeLine(line);
        // 窄屏不在 Markdown 层截断；交给聊天区统一软换行，避免丢失代码。
        output.push(`${ANSI.gray}│${ANSI.reset} ${styled}`);
      }
      return output;
    }

    // 测量代码块内部最长行的可视宽度（循环求最大值：长代码块用 spread 会爆参数栈）
    let maxContentLen = 10;
    for (const line of lines) maxContentLen = Math.max(maxContentLen, this.getTextWidth(line));

    // 计算包含两侧边框 (│  ...  │) 的适配列宽
    const innerWidth = Math.min(maxWidth - 4, maxContentLen);
    const cardWidth = innerWidth + 4;
    const topDashes = Math.max(2, cardWidth - 4 - langLabel.length);

    // 代码块顶栏边框 ┌── label ───────┐
    output.push(
      `${ANSI.gray}┌──${ANSI.cyan}${langLabel}${ANSI.gray}${"─".repeat(topDashes)}┐${ANSI.reset}`,
    );

    for (const line of lines) {
      let styled = line;
      if (lang === "diff") {
        if (line.startsWith("+")) {
          styled = `${ANSI.green}${line}${ANSI.reset}`;
        } else if (line.startsWith("-")) {
          styled = `${ANSI.red}${line}${ANSI.reset}`;
        } else if (line.startsWith("@@")) {
          styled = `${ANSI.cyan}${line}${ANSI.reset}`;
        }
      } else {
        styled = this.highlightCodeLine(line);
      }

      // 超宽行在卡片内折行（续行以 ↪ 标记），不截断，保证代码可完整阅读与复制。
      const segments =
        this.getTextWidth(styled) > innerWidth ? wrapAnsi(styled, innerWidth) : [styled];
      segments.forEach((segment, index) => {
        const padLen = Math.max(0, innerWidth - this.getTextWidth(segment));
        const gutter = index === 0 ? " " : `${ANSI.gray}↪${ANSI.reset}`;
        output.push(
          `${ANSI.gray}│${ANSI.reset}${gutter}${segment}${ANSI.reset}${" ".repeat(padLen)} ${ANSI.gray}│${ANSI.reset}`,
        );
      });
    }

    // 代码块底栏边框 └────────────────┘
    const botDashes = Math.max(2, cardWidth - 2);
    output.push(`${ANSI.gray}└${"─".repeat(botDashes)}┘${ANSI.reset}`);

    return output;
  }

  /**
   * 单行代码语法高亮处理（带行级缓存）。
   */
  private highlightCodeLine(line: string): string {
    if (this.codeLineCacheTheme !== ansiTheme || this.codeLineCacheColorLevel !== ansiColorLevel) {
      this.codeLineCache.clear();
      this.codeLineCacheTheme = ansiTheme;
      this.codeLineCacheColorLevel = ansiColorLevel;
    }
    const cached = this.codeLineCache.get(line);
    if (cached !== undefined) return cached;
    const styled = this.styleCodeLine(line);
    // 长会话里代码行文本几乎不重复，攒满就整表清空，避免缓存无限膨胀。
    if (this.codeLineCache.size >= 4096) this.codeLineCache.clear();
    this.codeLineCache.set(line, styled);
    return styled;
  }

  /**
   * 单行代码语法高亮的实际计算（纯函数，结果只取决于行内容与当前 ANSI 字典）。
   */
  private styleCodeLine(line: string): string {
    if (line.trim().startsWith("//") || line.trim().startsWith("#")) {
      return `${ANSI.gray}${line}${ANSI.reset}`;
    }

    return line.replace(/("[^"]*"|'[^']*'|`[^`]*`|\b\d+\b|\b[a-zA-Z_]\w*\b)/g, (token) => {
      if (token.startsWith('"') || token.startsWith("'") || token.startsWith("`")) {
        return `${ANSI.green}${token}${ANSI.reset}`;
      }
      if (/^\d+$/.test(token)) {
        return `${ANSI.brightYellow}${token}${ANSI.reset}`;
      }
      if (KEYWORDS.has(token)) {
        return `${ANSI.bold}${ANSI.magenta}${token}${ANSI.reset}`;
      }
      return token;
    });
  }

  /**
   * 判断行是否为 Markdown 表格行。
   */
  private isTableLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith("|") && trimmed.endsWith("|");
  }

  /**
   * 将 Markdown 表格行安全的切分为单元格数组。
   * 支持转义管道符 \| 以及代码块内的 |。
   */
  private splitTableRow(line: string): string[] {
    const trimmed = line.trim();
    let content = trimmed;
    if (content.startsWith("|")) content = content.slice(1);
    if (content.endsWith("|")) content = content.slice(0, -1);

    const cells: string[] = [];
    let current = "";
    let inBacktick = false;

    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      if (char === "`") {
        inBacktick = !inBacktick;
        current += char;
      } else if (char === "\\" && i + 1 < content.length && content[i + 1] === "|") {
        current += "|";
        i++;
      } else if (char === "|" && !inBacktick) {
        cells.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    return cells;
  }

  /**
   * 剥离文本中的行内 Markdown 语法标记，返回纯文本内容。
   */
  private stripMarkdown(text: string): string {
    let result = text;
    // 行内代码 `code`
    result = result.replace(/`([^`]+)`/g, "$1");
    // 链接与图片只保留文字（与表格内 renderInlineStyles 的紧凑链接一致）
    result = result.replace(MARKDOWN_LINK_RE, (_match, image, label, url) =>
      image ? `图片: ${label || url}` : label || url,
    );
    result = result.replace(AUTOLINK_RE, "$1");
    // 粗体 **text** 或 __text__
    result = result.replace(/(\*\*|__)(.*?)\1/g, "$2");
    // 斜体 *text* 或 _text_（要求两侧有非字母下划线界限，避免把代码变量 write_file 当作斜体误删）
    result = result.replace(/(^|[^\w])(\*|_)(.*?)\2(?=[^\w]|$)/g, "$1$3");
    // 删除线 ~~text~~
    result = result.replace(/~~(.*?)~~/g, "$1");
    return result;
  }

  /**
   * 判断字符码位是否为东亚宽字符（CJK / 全角符号 / Emoji）。
   */
  private isWideChar(cp: number): boolean {
    return (
      cp >= 0x1100 &&
      (cp <= 0x115f ||
        cp === 0x2329 ||
        cp === 0x232a ||
        (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe10 && cp <= 0xfe19) ||
        (cp >= 0xfe30 && cp <= 0xfe6f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f300 && cp <= 0x1faff) ||
        (cp >= 0x20000 && cp <= 0x3fffd))
    );
  }

  /**
   * 渲染 Markdown 表格（美化表格边框并对齐列）。
   */
  private renderTable(lines: string[]): string[] {
    if (lines.length < 2) {
      return lines;
    }

    const rows = lines.map((line) => this.splitTableRow(line));

    const contentRows = rows.filter((row) => !row.every((cell) => /^:?-+:?$/.test(cell)));

    if (contentRows.length === 0) {
      return lines;
    }

    const colCount = Math.max(...contentRows.map((r) => r.length));
    const colWidths = new Array(colCount).fill(0);

    for (const row of contentRows) {
      for (let c = 0; c < colCount; c++) {
        const text = row[c] || "";
        colWidths[c] = Math.max(colWidths[c] || 0, this.getRawMarkdownWidth(text));
      }
    }

    // 若表格总宽度超过终端可用宽度，按比例压缩各列
    const maxWidth = this.getMaxWidth();
    const borderOverhead = 3 * colCount + 1;
    if (maxWidth < 40 || borderOverhead + colCount * 3 > maxWidth) {
      const headerRow = contentRows[0];
      if (contentRows.length === 1) {
        return [headerRow.map((cell) => this.renderInlineStyles(cell)).join(" · ")];
      }

      const stacked: string[] = [];
      for (let rowIndex = 1; rowIndex < contentRows.length; rowIndex += 1) {
        if (rowIndex > 1) stacked.push("");
        if (contentRows.length > 2) {
          stacked.push(`${ANSI.gray}◇ ${rowIndex}${ANSI.reset}`);
        }
        for (let column = 0; column < colCount; column += 1) {
          const label = headerRow[column] || `列 ${column + 1}`;
          const value = contentRows[rowIndex][column] || "";
          stacked.push(
            `${ANSI.bold}${this.renderInlineStyles(label)}${ANSI.reset}: ${this.renderInlineStyles(value)}`,
          );
        }
      }
      return stacked;
    }
    const maxContentWidth = Math.max(colCount * 3, maxWidth - borderOverhead);
    const sumWidths = colWidths.reduce((a, b) => a + b, 0);

    if (sumWidths > maxContentWidth) {
      const scaledWidths = colWidths.map((w) => {
        const ratio = sumWidths > 0 ? w / sumWidths : 1 / colCount;
        return Math.max(3, Math.floor(ratio * maxContentWidth));
      });
      let currentSum = scaledWidths.reduce((a, b) => a + b, 0);
      let idx = 0;
      while (currentSum < maxContentWidth && idx < colCount) {
        scaledWidths[idx]++;
        currentSum++;
        idx = (idx + 1) % colCount;
      }
      while (currentSum > maxContentWidth && scaledWidths.some((w) => w > 3)) {
        for (let c = colCount - 1; c >= 0; c--) {
          if (scaledWidths[c] > 3 && currentSum > maxContentWidth) {
            scaledWidths[c]--;
            currentSum--;
          }
        }
      }
      for (let c = 0; c < colCount; c++) {
        colWidths[c] = scaledWidths[c];
      }
    }

    const output: string[] = [];

    // 顶边框 ┌─────┬─────┐
    const topBorder = `┌${colWidths.map((w) => "─".repeat(w + 2)).join("┬")}┐`;
    output.push(`${ANSI.gray}${topBorder}${ANSI.reset}`);

    // 表头行
    const headerRow = contentRows[0];
    const headerCells = [];
    for (let c = 0; c < colCount; c++) {
      const rawText = headerRow[c] || "";
      const styledText = this.renderInlineStyles(rawText, true);
      const truncatedText = this.truncateVisual(styledText, colWidths[c]);
      const padLen = Math.max(0, colWidths[c] - this.getTextWidth(truncatedText));
      headerCells.push(
        ` ${ANSI.bold}${ANSI.cyan}${truncatedText}${ANSI.reset}${" ".repeat(padLen)} `,
      );
    }
    output.push(
      `${ANSI.gray}│${ANSI.reset}${headerCells.join(`${ANSI.gray}│${ANSI.reset}`)}${ANSI.gray}│${ANSI.reset}`,
    );

    // 如果包含数据行，渲染中间分隔线与表体行
    if (contentRows.length > 1) {
      // 分割边框 ├─────┼─────┤
      const midBorder = `├${colWidths.map((w) => "─".repeat(w + 2)).join("┼")}┤`;
      output.push(`${ANSI.gray}${midBorder}${ANSI.reset}`);

      // 表体行
      for (let r = 1; r < contentRows.length; r++) {
        const row = contentRows[r];
        const cells = [];
        for (let c = 0; c < colCount; c++) {
          const rawText = row[c] || "";
          const styledText = this.renderInlineStyles(rawText, true);
          const truncatedText = this.truncateVisual(styledText, colWidths[c]);
          const padLen = Math.max(0, colWidths[c] - this.getTextWidth(truncatedText));
          cells.push(` ${truncatedText}${" ".repeat(padLen)} `);
        }
        output.push(
          `${ANSI.gray}│${ANSI.reset}${cells.join(`${ANSI.gray}│${ANSI.reset}`)}${ANSI.gray}│${ANSI.reset}`,
        );
      }
    }

    // 底边框 └─────┴─────┘
    const botBorder = `└${colWidths.map((w) => "─".repeat(w + 2)).join("┴")}┘`;
    output.push(`${ANSI.gray}${botBorder}${ANSI.reset}`);

    return output;
  }

  /**
   * 计算字符串的真实终端可视宽度（仅过滤 ANSI 颜色转义码，精准保留代码下划线与所有可见字符）。
   */
  private getTextWidth(str: string): number {
    const plain = str.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    let width = 0;
    for (const ch of plain) {
      const cp = ch.codePointAt(0) ?? 0;
      width += this.isWideChar(cp) ? 2 : 1;
    }
    return width;
  }

  /**
   * 计算原始 Markdown 单元格在渲染前的可视宽度（剥离 Markdown 语法标记）。
   */
  private getRawMarkdownWidth(str: string): number {
    const plainANSI = str.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const plain = this.stripMarkdown(plainANSI);
    let width = 0;
    for (const ch of plain) {
      const cp = ch.codePointAt(0) ?? 0;
      width += this.isWideChar(cp) ? 2 : 1;
    }
    return width;
  }
}
