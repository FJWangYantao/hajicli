import { stdout } from 'node:process';
import { MarkdownStreamRenderer } from './markdown-renderer.js';

/** ANSI 转义码匹配正则 */
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/**
 * 终端分区 TUI 渲染引擎。
 * 将终端划分为三个固定区域：Logo区（顶部）、聊天区（中间）、输入区（底部）。
 * 使用纯 ANSI 转义码实现，零外部依赖。
 */
export class TuiRenderer {
  /** Logo 区域的所有行（含 ANSI 色码） */
  private logoLines: string[] = [];
  /** 聊天缓冲区：已提交的所有行 */
  private chatBuffer: string[] = [];
  /** 流式输出中尚未提交的行片段 */
  private streamFragment = '';
  /** 流式 Markdown 渲染引擎 */
  private mdStreamRenderer = new MarkdownStreamRenderer();
  /** 当前流式输出是否启用 Markdown 格式化 */
  private isMarkdownStream = false;
  /** 当前流式输出在缓冲区中的起始索引 */
  private streamStartIndex = 0;
  /** 输入区域预留行数（上边框 + 输入行 + 下边框 + 光标落点 + 留白） */
  private readonly INPUT_RESERVED = 5;

  // ── 终端尺寸计算 ──

  /** 终端总行数 */
  get rows(): number {
    return stdout.rows || 24;
  }

  /** 终端总列数 */
  get cols(): number {
    return stdout.columns || 80;
  }

  /** Logo 区域占用的行数 */
  get logoHeight(): number {
    return this.logoLines.length;
  }

  /** 聊天区域可用行数 */
  get chatHeight(): number {
    return Math.max(1, this.rows - this.logoHeight - this.INPUT_RESERVED);
  }

  /** 聊天区域起始行（1-indexed） */
  get chatStartRow(): number {
    return this.logoHeight + 1;
  }

  /** 输入区域起始行（1-indexed） */
  get inputStartRow(): number {
    return this.rows - this.INPUT_RESERVED + 1;
  }

  // ── ANSI 光标基础操作 ──

  /** 光标移至绝对位置（1-indexed） */
  private moveTo(row: number, col: number): void {
    stdout.write(`\x1b[${row};${col}H`);
  }

  /** 清除当前行（光标位置至行尾） */
  private clearEOL(): void {
    stdout.write('\x1b[K');
  }

  /** 隐藏光标（减少绘制闪烁） */
  private hideCursor(): void {
    stdout.write('\x1b[?25l');
  }

  /** 显示光标 */
  private showCursor(): void {
    stdout.write('\x1b[?25h');
  }

  // ── 公共 API ──

  /**
   * 初始化 TUI 布局：清屏并渲染 Logo 区域。
   * @param logoText 像素风 Logo 文本（含 ANSI 色彩码）
   * @param statusLine Logo 下方的状态提示行
   */
  init(logoText: string, statusLine: string): void {
    const raw = logoText.split('\n');
    // 去除首尾空行以节省纵向空间
    while (raw.length > 0 && raw[0].replace(ANSI_RE, '').trim() === '') {
      raw.shift();
    }
    while (raw.length > 0 && raw[raw.length - 1].replace(ANSI_RE, '').trim() === '') {
      raw.pop();
    }
    this.logoLines = [...raw, statusLine];

    // 清屏并渲染 Logo
    stdout.write('\x1b[2J');
    this.hideCursor();
    for (let i = 0; i < this.logoLines.length; i++) {
      this.moveTo(i + 1, 1);
      this.clearEOL();
      stdout.write(this.logoLines[i]);
    }
    // 初始渲染空聊天区
    this.renderChatArea();
    this.showCursor();
  }

  /**
   * 渲染聊天区域：将缓冲区中最新的内容显示在聊天区域内。
   * 自动滚动到最新消息。
   */
  renderChatArea(): void {
    this.hideCursor();
    const startRow = this.chatStartRow;
    const height = this.chatHeight;

    // 合并已提交行和当前流式行
    const allLines = [...this.chatBuffer];
    if (this.streamFragment) {
      allLines.push(this.streamFragment);
    }

    // 对超宽行进行软换行
    const wrapped = this.wrapAllLines(allLines);

    // 取最后 height 行显示（自动滚动效果）
    const visible = wrapped.slice(-height);

    for (let i = 0; i < height; i++) {
      this.moveTo(startRow + i, 1);
      this.clearEOL();
      if (i < visible.length) {
        stdout.write(visible[i]);
      }
    }
    this.showCursor();
  }

  /**
   * 向聊天区追加文本并刷新。
   * @param text 文本内容
   * @param isMarkdown 是否使用 Markdown 引擎渲染
   */
  appendToChat(text: string, isMarkdown = false): void {
    if (isMarkdown) {
      const rendered = this.mdStreamRenderer.render(text, true);
      const lines = rendered.split('\n');
      this.chatBuffer.push(...lines);
    } else {
      const lines = text.split('\n');
      this.chatBuffer.push(...lines);
    }
    this.renderChatArea();
  }

  /**
   * 开始一次新的流式输出会话。
   * @param isMarkdown 是否启用流式 Markdown 渲染
   */
  beginStream(isMarkdown = false): void {
    this.streamFragment = '';
    this.isMarkdownStream = isMarkdown;
    this.streamStartIndex = this.chatBuffer.length;
    this.mdStreamRenderer.reset();
  }

  /**
   * 流式追加文本块到聊天区。
   * @param chunk 增量片段
   */
  streamChunk(chunk: string): void {
    if (this.isMarkdownStream) {
      const rendered = this.mdStreamRenderer.appendAndRender(chunk, false);
      const lines = rendered.split('\n');
      this.chatBuffer = [
        ...this.chatBuffer.slice(0, this.streamStartIndex),
        ...lines
      ];
    } else {
      const parts = chunk.split('\n');
      this.streamFragment += parts[0];
      for (let i = 1; i < parts.length; i++) {
        this.chatBuffer.push(this.streamFragment);
        this.streamFragment = parts[i];
      }
    }
    this.renderChatArea();
  }

  /**
   * 替换当前流式行的全部内容（用于 Spinner 动画覆盖更新）。
   */
  updateStreamLine(text: string): void {
    this.streamFragment = text;
    this.renderChatArea();
  }

  /** 结束流式输出，将残余片段提交到缓冲区 */
  endStream(): void {
    if (this.isMarkdownStream) {
      const rendered = this.mdStreamRenderer.appendAndRender('', true);
      const lines = rendered.split('\n');
      this.chatBuffer = [
        ...this.chatBuffer.slice(0, this.streamStartIndex),
        ...lines
      ];
      this.isMarkdownStream = false;
    } else if (this.streamFragment) {
      this.chatBuffer.push(this.streamFragment);
      this.streamFragment = '';
    }
    this.renderChatArea();
  }

  /** 将光标定位到输入区域起始行 */
  positionForInput(): void {
    this.moveTo(this.inputStartRow, 1);
  }

  /** 清空输入区域 */
  clearInputArea(): void {
    this.hideCursor();
    for (let i = 0; i < this.INPUT_RESERVED; i++) {
      this.moveTo(this.inputStartRow + i, 1);
      this.clearEOL();
    }
    this.showCursor();
  }

  /** 全量重绘（终端 resize 时调用） */
  fullRepaint(): void {
    stdout.write('\x1b[2J');
    this.hideCursor();
    for (let i = 0; i < this.logoLines.length; i++) {
      this.moveTo(i + 1, 1);
      this.clearEOL();
      stdout.write(this.logoLines[i]);
    }
    this.renderChatArea();
    this.showCursor();
  }

  // ── 内部工具方法 ──

  /** 对一组行进行终端宽度软换行 */
  private wrapAllLines(lines: string[]): string[] {
    const maxWidth = this.cols - 1; // 留1列避免触发自动换行
    const result: string[] = [];
    for (const line of lines) {
      if (this.visualWidth(line) <= maxWidth) {
        result.push(line);
      } else {
        result.push(...this.wrapSingleLine(line, maxWidth));
      }
    }
    return result;
  }

  /** 计算字符串的视觉宽度（剔除 ANSI 转义码） */
  private visualWidth(str: string): number {
    const plain = str.replace(ANSI_RE, '');
    let width = 0;
    for (const ch of plain) {
      const cp = ch.codePointAt(0) ?? 0;
      width += this.isWideChar(cp) ? 2 : 1;
    }
    return width;
  }

  /** 判断码位是否为东亚宽字符（CJK / Emoji） */
  private isWideChar(cp: number): boolean {
    return cp >= 0x1100 && (
      cp <= 0x115f
      || cp === 0x2329 || cp === 0x232a
      || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
      || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe10 && cp <= 0xfe19)
      || (cp >= 0xfe30 && cp <= 0xfe6f)
      || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6)
      || (cp >= 0x1f300 && cp <= 0x1faff)
      || (cp >= 0x20000 && cp <= 0x3fffd)
    );
  }

  /** 将单行按视觉宽度进行软换行 */
  private wrapSingleLine(line: string, maxWidth: number): string[] {
    const segments: string[] = [];
    let current = '';
    let currentWidth = 0;
    const ansiPrefix = /^\x1b\[[0-?]*[ -/]*[@-~]/;
    let i = 0;

    while (i < line.length) {
      // 检测 ANSI 转义序列（不占视觉宽度，直接追加）
      const rest = line.slice(i);
      const match = rest.match(ansiPrefix);
      if (match) {
        current += match[0];
        i += match[0].length;
        continue;
      }

      const ch = line[i];
      const cp = ch.codePointAt(0) ?? 0;
      const charWidth = this.isWideChar(cp) ? 2 : 1;

      if (currentWidth + charWidth > maxWidth) {
        segments.push(current);
        current = '';
        currentWidth = 0;
      }

      current += ch;
      currentWidth += charWidth;
      i++;
    }

    if (current) {
      segments.push(current);
    }
    return segments.length > 0 ? segments : [''];
  }
}
