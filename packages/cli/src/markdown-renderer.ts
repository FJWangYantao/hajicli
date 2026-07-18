/**
 * 终端 Markdown 流式渲染引擎。
 * 支持增量流式防闪烁自动补全、代码块语法高亮、Diff 高亮、表格美化、任务列表及 ANSI 样式。
 * 纯 TypeScript 实现，零外部依赖。
 */

/** ANSI 样式代码字典 */
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  strikethrough: '\x1b[9m',

  // 前景色定义
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightCyan: '\x1b[96m',
};

/** 常见编程语言关键字集合 */
const KEYWORDS = new Set([
  'import', 'export', 'from', 'default', 'const', 'let', 'var', 'function',
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'try', 'catch', 'finally', 'throw', 'new', 'class', 'extends',
  'interface', 'type', 'async', 'await', 'yield', 'typeof', 'instanceof',
  'void', 'public', 'private', 'protected', 'readonly', 'static', 'as', 'is',
  'null', 'undefined', 'true', 'false', 'boolean', 'string', 'number'
]);

/**
 * 流式 Markdown 解析与终端 ANSI 渲染器。
 */
export class MarkdownStreamRenderer {
  /** 累积接收到的原始 Markdown 全量文本 */
  private rawContent = '';

  /**
   * 重置渲染器状态。
   */
  reset(): void {
    this.rawContent = '';
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
    // 1. 流式中间态时补充未闭合语法标签
    const processedContent = isFinal ? content : this.autoCloseMarkdown(content);

    // 2. 按行拆解并分析元素
    const lines = processedContent.split(/\r?\n/);
    const renderedLines: string[] = [];

    let inCodeBlock = false;
    let codeLanguage = '';
    let codeBlockBuffer: string[] = [];
    let tableBuffer: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 检测代码块边界 (``` 或 ````)
      const codeBlockMatch = line.match(/^(`{3,})([a-zA-Z0-9_-]*)/);
      if (codeBlockMatch) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeLanguage = codeBlockMatch[2].toLowerCase();
          codeBlockBuffer = [];
        } else {
          inCodeBlock = false;
          renderedLines.push(...this.renderCodeBlock(codeBlockBuffer, codeLanguage));
          codeLanguage = '';
          codeBlockBuffer = [];
        }
        continue;
      }

      // 处理代码块内部内容
      if (inCodeBlock) {
        codeBlockBuffer.push(line);
        continue;
      }

      // 检测表格行 (| col1 | col2 |)
      if (this.isTableLine(line)) {
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

      // 渲染普通 Markdown 行
      renderedLines.push(this.renderNormalLine(line));
    }

    // 针对流式未闭合代码块的兜底渲染
    if (inCodeBlock && codeBlockBuffer.length > 0) {
      renderedLines.push(...this.renderCodeBlock(codeBlockBuffer, codeLanguage));
    }

    // 处理积攒的表格
    if (tableBuffer.length > 0) {
      renderedLines.push(...this.renderTable(tableBuffer));
    }

    return renderedLines.join('\n');
  }

  /**
   * 自动闭合流式片段中的未完结语法结构。
   */
  private autoCloseMarkdown(text: string): string {
    let closed = text;

    // 补全代码块 ```
    const codeBlockCount = (text.match(/^```/gm) || []).length;
    if (codeBlockCount % 2 !== 0) {
      closed += '\n```';
    }

    // 补全粗体 **
    const boldCount = (closed.match(/\*\*/g) || []).length;
    if (boldCount % 2 !== 0) {
      closed += '**';
    }

    // 补齐末行未闭合的单反引号 `
    const lines = closed.split('\n');
    const lastIdx = lines.length - 1;
    const backtickCount = (lines[lastIdx].match(/`/g) || []).length;
    if (backtickCount % 2 !== 0) {
      lines[lastIdx] += '`';
      closed = lines.join('\n');
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
        return `${ANSI.bold}${ANSI.magenta}█ ${text.toUpperCase()}${ANSI.reset}`;
      } else if (level === 2) {
        return `${ANSI.bold}${ANSI.cyan}■ ${text}${ANSI.reset}`;
      } else {
        return `${ANSI.bold}${ANSI.blue}▲ ${text}${ANSI.reset}`;
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
      const isChecked = taskMatch[3].toLowerCase() === 'x';
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
      return `${indent}${ANSI.magenta}•${ANSI.reset} ${text}`;
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
  private renderInlineStyles(text: string): string {
    let result = text;

    // 行内代码 `code`
    result = result.replace(/`([^`]+)`/g, (_match, code) => {
      return `${ANSI.yellow}${code}${ANSI.reset}`;
    });

    // 粗体 **text** 或 __text__
    result = result.replace(/(\*\*|__)(.*?)\1/g, (_match, _p1, p2) => {
      return `${ANSI.bold}${p2}${ANSI.reset}`;
    });

    // 斜体 *text* 或 _text_
    result = result.replace(/(\*|_)(.*?)\1/g, (_match, _p1, p2) => {
      return `${ANSI.italic}${p2}${ANSI.reset}`;
    });

    // 删除线 ~~text~~
    result = result.replace(/~~(.*?)~~/g, (_match, p1) => {
      return `${ANSI.strikethrough}${p1}${ANSI.reset}`;
    });

    return result;
  }

  /**
   * 渲染代码块（包含 Diff 语法高亮与通用语言高亮）。
   */
  private renderCodeBlock(lines: string[], lang: string): string[] {
    const output: string[] = [];
    const langLabel = lang ? ` ${lang} ` : ' code ';

    // 代码块顶栏边框
    output.push(`${ANSI.gray}┌──${ANSI.cyan}${langLabel}${ANSI.gray}─────────────────────────────────────────${ANSI.reset}`);

    if (lang === 'diff') {
      // Diff 模式高亮
      for (const line of lines) {
        if (line.startsWith('+')) {
          output.push(`${ANSI.gray}│${ANSI.reset} ${ANSI.green}${line}${ANSI.reset}`);
        } else if (line.startsWith('-')) {
          output.push(`${ANSI.gray}│${ANSI.reset} ${ANSI.red}${line}${ANSI.reset}`);
        } else if (line.startsWith('@@')) {
          output.push(`${ANSI.gray}│${ANSI.reset} ${ANSI.cyan}${line}${ANSI.reset}`);
        } else {
          output.push(`${ANSI.gray}│${ANSI.reset} ${line}`);
        }
      }
    } else {
      // 通用代码高亮
      for (const line of lines) {
        const highlighted = this.highlightCodeLine(line);
        output.push(`${ANSI.gray}│${ANSI.reset} ${highlighted}`);
      }
    }

    // 代码块底栏边框
    output.push(`${ANSI.gray}└────────────────────────────────────────────${ANSI.reset}`);

    return output;
  }

  /**
   * 单行代码语法高亮处理。
   */
  private highlightCodeLine(line: string): string {
    if (line.trim().startsWith('//') || line.trim().startsWith('#')) {
      return `${ANSI.gray}${line}${ANSI.reset}`;
    }

    return line.replace(/("[^"]*"|'[^']*'|`[^`]*`|\b\d+\b|\b[a-zA-Z_]\w*\b)/g, (token) => {
      if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) {
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
    return trimmed.startsWith('|') && trimmed.endsWith('|');
  }

  /**
   * 渲染 Markdown 表格（美化表格边框并对齐列）。
   */
  private renderTable(lines: string[]): string[] {
    if (lines.length < 2) {
      return lines;
    }

    const rows = lines.map(line => {
      return line.trim().slice(1, -1).split('|').map(cell => cell.trim());
    });

    const contentRows = rows.filter(row => !row.every(cell => /^:?-+:?$/.test(cell)));

    if (contentRows.length === 0) {
      return lines;
    }

    const colCount = Math.max(...contentRows.map(r => r.length));
    const colWidths = new Array(colCount).fill(0);

    for (const row of contentRows) {
      for (let c = 0; c < colCount; c++) {
        const text = row[c] || '';
        colWidths[c] = Math.max(colWidths[c] || 0, this.getTextWidth(text));
      }
    }

    const output: string[] = [];

    // 顶边框 ┌─────┬─────┐
    const topBorder = '┌' + colWidths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';
    output.push(`${ANSI.gray}${topBorder}${ANSI.reset}`);

    // 表头行
    const headerRow = contentRows[0];
    const headerCells = [];
    for (let c = 0; c < colCount; c++) {
      const text = headerRow[c] || '';
      const padLen = colWidths[c] - this.getTextWidth(text);
      headerCells.push(` ${ANSI.bold}${ANSI.cyan}${text}${ANSI.reset}${' '.repeat(padLen)} `);
    }
    output.push(`${ANSI.gray}│${ANSI.reset}${headerCells.join(ANSI.gray + '│' + ANSI.reset)}${ANSI.gray}│${ANSI.reset}`);

    // 分割边框 ├─────┼─────┤
    const midBorder = '├' + colWidths.map(w => '─'.repeat(w + 2)).join('┼') + '┤';
    output.push(`${ANSI.gray}${midBorder}${ANSI.reset}`);

    // 表体行
    for (let r = 1; r < contentRows.length; r++) {
      const row = contentRows[r];
      const cells = [];
      for (let c = 0; c < colCount; c++) {
        const rawText = row[c] || '';
        const styledText = this.renderInlineStyles(rawText);
        const padLen = colWidths[c] - this.getTextWidth(rawText);
        cells.push(` ${styledText}${' '.repeat(padLen)} `);
      }
      output.push(`${ANSI.gray}│${ANSI.reset}${cells.join(ANSI.gray + '│' + ANSI.reset)}${ANSI.gray}│${ANSI.reset}`);
    }

    // 底边框 └─────┴─────┘
    const botBorder = '└' + colWidths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';
    output.push(`${ANSI.gray}${botBorder}${ANSI.reset}`);

    return output;
  }

  /**
   * 计算字符串的真实展示宽度（过滤 ANSI 转义码与宽字符计算）。
   */
  private getTextWidth(str: string): number {
    const plain = str.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    let width = 0;
    for (const ch of plain) {
      const cp = ch.codePointAt(0) ?? 0;
      width += (cp >= 0x1100 && (
        cp <= 0x115f
        || cp === 0x2329 || cp === 0x232a
        || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
        || (cp >= 0xac00 && cp <= 0xd7a3)
        || (cp >= 0xf900 && cp <= 0xfaff)
        || (cp >= 0x1f300 && cp <= 0x1faff)
      )) ? 2 : 1;
    }
    return width;
  }
}
