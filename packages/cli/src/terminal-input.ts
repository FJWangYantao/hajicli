import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawnSync } from 'node:child_process';

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_AT_START_PATTERN = /^\x1b\[[0-?]*[ -/]*[@-~]/;
const ANSI_RESET = '\x1b[0m';
const graphemeSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });

function enableWindowsVirtualTerminalInput(): boolean {
  if (process.platform !== 'win32') {
    return true;
  }

  const script = [
    `Add-Type -Namespace Haji -Name ConsoleMode -MemberDefinition '${[
      '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern System.IntPtr GetStdHandle(int nStdHandle);',
      '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(System.IntPtr handle, out uint mode);',
      '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(System.IntPtr handle, uint mode);'
    ].join(' ')}'`,
    '$handle = [Haji.ConsoleMode]::GetStdHandle(-10)',
    '[uint32]$mode = 0',
    'if (-not [Haji.ConsoleMode]::GetConsoleMode($handle, [ref]$mode)) { exit 1 }',
    '$virtualTerminalInput = [uint32]0x0200',
    'if (-not [Haji.ConsoleMode]::SetConsoleMode($handle, ($mode -bor $virtualTerminalInput))) { exit 1 }'
  ].join('; ');

  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script
  ], {
    stdio: ['inherit', 'ignore', 'ignore'],
    windowsHide: true
  });

  return result.status === 0;
}

export interface TerminalUIOptions {
  header: string;
  compactHeader: string;
  inputPrompt: string;
  renderBorder: (width: number) => string;
  continuationPrompt?: string;
}

export interface ReadInputOptions {
  prompt?: string;
  continuationPrompt?: string;
  slashCommands?: readonly SlashCommand[];
  initialValue?: string;
}

export interface SlashCommand {
  command: string;
  description: string;
}

export interface TerminalSelectionItem {
  value: string;
  label: string;
  description?: string;
}

export interface TerminalSelectionAxis {
  label: string;
  items: readonly TerminalSelectionItem[];
  selectedValue?: string;
}

export interface TerminalSelectionOptions {
  title: string;
  items: readonly TerminalSelectionItem[];
  selectedValue?: string;
  secondary?: TerminalSelectionAxis;
}

export interface TerminalSelectionResult {
  value: string;
  secondaryValue?: string;
}

interface CursorPosition {
  row: number;
  column: number;
}

interface InputLayout {
  rows: string[];
  positions: CursorPosition[];
}

interface ActiveInput {
  prompt: string;
  continuationPrompt: string;
  graphemes: string[];
  cursorIndex: number;
  preferredColumn?: number;
  slashCommands: readonly SlashCommand[];
  selectedCommandIndex: number;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

interface ActiveSelection {
  options: TerminalSelectionOptions;
  selectedIndex: number;
  secondaryIndex: number;
  resolve: (value: TerminalSelectionResult) => void;
  reject: (error: Error) => void;
}

interface VisibleInputLayout {
  rows: string[];
  cursor: CursorPosition;
}

export class TerminalInputCancelledError extends Error {
  constructor() {
    super('Terminal input cancelled');
    this.name = 'TerminalInputCancelledError';
  }
}

function splitGraphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), part => part.segment);
}

function isZeroWidth(codePoint: number): boolean {
  return codePoint === 0x200d
    || (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
}

function isWide(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function terminalWidth(value: string): number {
  let width = 0;

  for (const grapheme of splitGraphemes(value.replace(ANSI_PATTERN, ''))) {
    const codePoints = Array.from(grapheme, character => character.codePointAt(0) ?? 0);
    if (!codePoints.every(isZeroWidth)) {
      width += codePoints.some(isWide) ? 2 : 1;
    }
  }

  return width;
}

function truncateText(value: string, width: number): string {
  let result = '';
  let resultWidth = 0;

  for (const grapheme of splitGraphemes(value)) {
    const graphemeWidth = terminalWidth(grapheme);
    if (resultWidth + graphemeWidth > width) {
      break;
    }
    result += grapheme;
    resultWidth += graphemeWidth;
  }

  return result;
}

function layoutInput(
  prompt: string,
  graphemes: string[],
  width: number,
  continuationPrompt: string
): InputLayout {
  const rows = [prompt];
  const positions: CursorPosition[] = new Array(graphemes.length + 1);
  const continuationWidth = terminalWidth(continuationPrompt);
  let row = 0;
  let column = terminalWidth(prompt);

  for (let index = 0; index < graphemes.length; index += 1) {
    const grapheme = graphemes[index];

    if (grapheme === '\n') {
      positions[index] = { row, column };
      rows.push(continuationPrompt);
      row += 1;
      column = continuationWidth;
      continue;
    }

    const graphemeWidth = terminalWidth(grapheme);
    if (column + graphemeWidth > width) {
      rows.push(continuationPrompt);
      row += 1;
      column = continuationWidth;
    }

    positions[index] = { row, column };
    rows[row] += grapheme;
    column += graphemeWidth;
  }

  positions[graphemes.length] = { row, column };
  return { rows, positions };
}

function wrapAnsi(value: string, width: number): string[] {
  const rows: string[] = [];
  let row = '';
  let rowWidth = 0;
  let activeStyle = '';
  let offset = 0;

  const pushRow = () => {
    rows.push(`${row}${ANSI_RESET}`);
    row = activeStyle;
    rowWidth = 0;
  };

  while (offset < value.length) {
    if (value[offset] === '\x1b') {
      const match = value.slice(offset).match(ANSI_AT_START_PATTERN);
      if (match) {
        const sequence = match[0];
        row += sequence;
        if (sequence.endsWith('m')) {
          if (/\x1b\[(?:0)?m/.test(sequence)) {
            activeStyle = '';
          } else {
            activeStyle += sequence;
          }
        }
        offset += sequence.length;
        continue;
      }
    }

    const nextAnsi = value.indexOf('\x1b', offset);
    const textEnd = nextAnsi === -1 ? value.length : nextAnsi;
    const text = value.slice(offset, textEnd).replace(/\r/g, '');

    for (const grapheme of splitGraphemes(text)) {
      if (grapheme === '\n') {
        pushRow();
        continue;
      }

      const graphemeWidth = terminalWidth(grapheme);
      if (rowWidth + graphemeWidth > width && rowWidth > 0) {
        pushRow();
      }
      row += grapheme;
      rowWidth += graphemeWidth;
    }
    offset = textEnd;
  }

  rows.push(`${row}${ANSI_RESET}`);
  return rows;
}

export class TerminalUI {
  private readonly options: TerminalUIOptions;
  private readonly interactive = Boolean(stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function');
  private started = false;
  private chatContent = '';
  private chatScrollOffset = 0;
  private maxChatScrollOffset = 0;
  private chatPageSize = 1;
  private status = '';
  private permissionMode = '';
  private activeInput?: ActiveInput;
  private activeSelection?: ActiveSelection;
  private originalRawMode = false;
  private suppressMouseKeypressUntil = 0;
  private onShiftTabCallback?: () => void;
  private queueText = '';
  private isPasting = false;
  private pasteBuffer = '';

  constructor(options: TerminalUIOptions) {
    this.options = options;
  }

  setPermissionMode(mode: string): void {
    this.permissionMode = mode;
    this.render();
  }

  onShiftTab(callback: () => void): void {
    this.onShiftTabCallback = callback;
  }

  setQueue(items: string[]): void {
    if (items.length === 0) {
      this.queueText = '';
    } else {
      const formatted = items.map((msg, idx) => `[${idx + 1}] ${msg}`).join('  ');
      const maxLen = Math.max(10, (stdout.columns || 80) - 26);
      this.queueText = ` \x1b[1;33m⏳ 待处理队列 (${items.length} 条):\x1b[0m \x1b[36m${truncateText(formatted, maxLen)}\x1b[0m`;
    }
    this.render();
  }

  isInputActive(): boolean {
    return Boolean(this.activeInput);
  }

  cancelInput(): void {
    if (this.activeInput) {
      this.finishInput(new TerminalInputCancelledError());
    }
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    if (!this.interactive) {
      stdout.write(`${this.options.compactHeader}\n`);
      return;
    }

    this.originalRawMode = Boolean(stdin.isRaw);
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    enableWindowsVirtualTerminalInput();
    stdin.resume();
    stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007h\x1b[?2004h');
    stdout.on('resize', this.handleResize);
    stdin.prependListener('data', this.handleMouseData);
    stdin.on('keypress', this.handleIdleKeypress);
    process.on('exit', this.handleProcessExit);
    this.render();
  }

  close(): void {
    if (!this.started) {
      return;
    }

    if (this.activeInput) {
      this.removeInputListeners();
      this.activeInput = undefined;
    }
    if (this.activeSelection) {
      this.removeSelectionListeners();
      this.activeSelection = undefined;
    }

    if (this.interactive) {
      stdout.off('resize', this.handleResize);
      stdin.off('data', this.handleMouseData);
      stdin.off('keypress', this.handleIdleKeypress);
      stdin.setRawMode(this.originalRawMode);
      stdin.pause();
      process.off('exit', this.handleProcessExit);
      stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1007l\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l');
    }
    this.started = false;
  }

  clearChat(): void {
    this.chatContent = '';
    this.chatScrollOffset = 0;
    this.render();
  }

  writeChat(value: string): void {
    if (!this.interactive) {
      stdout.write(value);
      return;
    }

    this.chatContent += value;
    // 仅当用户处于最底部（未手动向上滚动）时才重置滚轮偏移；如果用户正向上查看历史，则保留滚动位置
    if (this.chatScrollOffset === 0) {
      this.chatScrollOffset = 0;
    }
    if (this.chatContent.length > 200_000) {
      this.chatContent = this.chatContent.slice(-160_000);
    }
    this.render();
  }

  writeLine(value: string = ''): void {
    this.writeChat(`${value}\n`);
  }

  setStatus(value: string = ''): void {
    this.status = value;
    this.render();
  }

  async readInput(options: ReadInputOptions = {}): Promise<string> {
    const prompt = options.prompt ?? this.options.inputPrompt;
    if (!this.interactive) {
      const questionInterface = readlinePromises.createInterface({ input: stdin, output: stdout });
      try {
        return await questionInterface.question(prompt);
      } finally {
        questionInterface.close();
      }
    }

    if (this.activeInput || this.activeSelection) {
      throw new Error('已有输入请求正在等待处理');
    }

    const initialGraphemes = options.initialValue ? splitGraphemes(options.initialValue) : [];
    return new Promise<string>((resolve, reject) => {
      this.activeInput = {
        prompt,
        continuationPrompt: options.continuationPrompt ?? this.options.continuationPrompt ?? '  ',
        graphemes: initialGraphemes,
        cursorIndex: initialGraphemes.length,
        slashCommands: options.slashCommands ?? [],
        selectedCommandIndex: 0,
        resolve,
        reject
      };

      stdin.on('keypress', this.handleKeypress);
      this.render();
    });
  }

  async readSelection(options: TerminalSelectionOptions): Promise<TerminalSelectionResult> {
    if (options.items.length === 0) {
      throw new Error('选择器至少需要一个选项');
    }
    if (options.secondary && options.secondary.items.length === 0) {
      throw new Error('选择器的次级选项不能为空');
    }

    const selectedIndex = Math.max(
      0,
      options.items.findIndex(item => item.value === options.selectedValue)
    );
    const secondaryIndex = options.secondary
      ? Math.max(
        0,
        options.secondary.items.findIndex(item => item.value === options.secondary?.selectedValue)
      )
      : 0;

    if (!this.interactive) {
      return {
        value: options.items[selectedIndex].value,
        secondaryValue: options.secondary?.items[secondaryIndex].value
      };
    }
    if (this.activeInput || this.activeSelection) {
      throw new Error('已有输入请求正在等待处理');
    }

    return new Promise<TerminalSelectionResult>((resolve, reject) => {
      this.activeSelection = {
        options,
        selectedIndex,
        secondaryIndex,
        resolve,
        reject
      };

      stdin.on('keypress', this.handleSelectionKeypress);
      this.render();
    });
  }

  private readonly handleResize = () => {
    this.render();
  };

  private readonly handleMouseData = (data: Buffer | string) => {
    const value = typeof data === 'string' ? data : data.toString('utf-8');

    // 0ms 敏捷捕获原生 Esc 单按键 (0x1b)，绕过 readline 默认的延时等待
    if (value === '\x1b' || (Buffer.isBuffer(data) && data.length === 1 && data[0] === 0x1b)) {
      this.suppressMouseKeypressUntil = Date.now() + 100;
      if (this.onEscCallback) {
        this.onEscCallback();
      }
      return;
    }

    // 1. 括号粘贴模式 (Bracketed Paste Mode \x1b[200~ ... \x1b[201~) 原子拦截
    if (this.isPasting || value.includes('\x1b[200~')) {
      let content = value;
      if (!this.isPasting && content.includes('\x1b[200~')) {
        this.isPasting = true;
        content = content.slice(content.indexOf('\x1b[200~') + 6);
      }
      if (this.isPasting) {
        if (content.includes('\x1b[201~')) {
          const endIdx = content.indexOf('\x1b[201~');
          this.pasteBuffer += content.slice(0, endIdx);
          this.isPasting = false;
          const fullPastedText = this.pasteBuffer;
          this.pasteBuffer = '';
          this.suppressMouseKeypressUntil = Date.now() + 100;
          if (fullPastedText) {
            this.insert(fullPastedText);
          }
        } else {
          this.pasteBuffer += content;
        }
        return;
      }
    }

    let handledMouseEvent = false;

    const handleWheelButton = (button: number) => {
      if ((button & 64) === 0) {
        return;
      }
      handledMouseEvent = true;
      this.scrollChat((button & 1) === 0 ? 3 : -3);
    };

    // SGR 鼠标模式 (\x1b[<button;x;yM 或 \x1b[<button;x;ym)
    if (/\x1b\[<\d+;\d+;\d+[mM]/.test(value)) {
      handledMouseEvent = true;
      for (const match of value.matchAll(/\x1b\[<(\d+);\d+;\d+[mM]/g)) {
        handleWheelButton(Number.parseInt(match[1], 10));
      }
    }

    // URXVT 鼠标模式 (\x1b[button;x;yM)
    if (/\x1b\[\d+;\d+;\d+M/.test(value)) {
      handledMouseEvent = true;
      for (const match of value.matchAll(/\x1b\[(\d+);\d+;\d+M/g)) {
        handleWheelButton(Number.parseInt(match[1], 10));
      }
    }

    // Legacy X10 鼠标模式兼容 (\x1b[M<cb><cx><cy>)
    if (/\x1b\[M[\s\S]{3}/.test(value)) {
      handledMouseEvent = true;
      for (const match of value.matchAll(/\x1b\[M([\s\S])([\s\S])([\s\S])/g)) {
        handleWheelButton(match[1].charCodeAt(0) - 32);
      }
    }

    if (handledMouseEvent) {
      // 鼠标点击/滚轮事件触发后，忽略随后的派生按键与控制序列
      this.suppressMouseKeypressUntil = Date.now() + 100;
    }
  };

  private readonly handleIdleKeypress = (value: string, key: readline.Key) => {
    if (Date.now() <= this.suppressMouseKeypressUntil) {
      return;
    }
    if ((key.name === 'tab' && key.shift) || key.name === 'backtab' || value === '\x1b[Z') {
      if (this.onShiftTabCallback) {
        this.onShiftTabCallback();
      }
      return;
    }
    if (this.activeInput || this.activeSelection) {
      return;
    }
    if (key.ctrl && key.name === 'c') {
      this.close();
      process.exit(130);
    }
  };

  private readonly handleProcessExit = () => {
    stdin.setRawMode(this.originalRawMode);
    stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1007l\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l');
  };

  private getInputLayout(width: number, maxRows: number): VisibleInputLayout {
    const activeInput = this.activeInput;
    const prompt = activeInput?.prompt ?? this.options.inputPrompt;
    const continuationPrompt = activeInput?.continuationPrompt ?? this.options.continuationPrompt ?? '  ';
    const graphemes = activeInput?.graphemes ?? [];
    const cursorIndex = activeInput?.cursorIndex ?? 0;
    const layout = layoutInput(prompt, graphemes, width, continuationPrompt);
    const cursor = layout.positions[cursorIndex];

    if (layout.rows.length <= maxRows) {
      return { rows: layout.rows, cursor };
    }

    const firstVisibleRow = Math.min(
      Math.max(0, cursor.row - maxRows + 1),
      layout.rows.length - maxRows
    );

    return {
      rows: layout.rows.slice(firstVisibleRow, firstVisibleRow + maxRows),
      cursor: { row: cursor.row - firstVisibleRow, column: cursor.column }
    };
  }

  private getCommandSuggestions(activeInput: ActiveInput): readonly SlashCommand[] {
    const value = activeInput.graphemes.join('');
    if (!/^\/[^\s]*$/u.test(value)) {
      return [];
    }

    const prefix = value.toLowerCase();
    return activeInput.slashCommands.filter(item => item.command.toLowerCase().startsWith(prefix));
  }

  private getCommandSuggestionRows(width: number, maxRows: number): string[] {
    const activeInput = this.activeInput;
    if (!activeInput || maxRows <= 0) {
      return [];
    }

    const suggestions = this.getCommandSuggestions(activeInput).slice(0, maxRows);
    if (suggestions.length === 0) {
      return [];
    }

    activeInput.selectedCommandIndex = Math.min(
      activeInput.selectedCommandIndex,
      suggestions.length - 1
    );

    return suggestions.map((item, index) => {
      const label = truncateText(`${item.command}  ${item.description}`, Math.max(1, width - 2));
      return index === activeInput.selectedCommandIndex
        ? `\x1b[1;35m› ${label}\x1b[0m`
        : `\x1b[90m  ${label}\x1b[0m`;
    });
  }

  private getSelectionRows(width: number, maxRows: number): string[] {
    const activeSelection = this.activeSelection;
    if (!activeSelection || maxRows <= 0) {
      return [];
    }

    const { options } = activeSelection;
    const navigation = options.secondary
      ? '↑↓ 模型 · ←→ 强度 · Enter 确认'
      : '↑↓ 选择 · Enter 确认';
    const rows = [
      `\x1b[1m${truncateText(options.title, width)}\x1b[0m  \x1b[90m${truncateText(navigation, Math.max(1, width - terminalWidth(options.title) - 2))}\x1b[0m`
    ];

    if (options.secondary) {
      const selectedSecondary = options.secondary.items[activeSelection.secondaryIndex];
      const effortLabels = options.secondary.items.map((item, index) => (
        index === activeSelection.secondaryIndex ? `‹${item.label}›` : item.label
      ));
      const fullSecondaryText = `${options.secondary.label}  ${effortLabels.join('  ')}`;
      if (terminalWidth(fullSecondaryText) <= width) {
        const styledEfforts = options.secondary.items.map((item, index) => (
          index === activeSelection.secondaryIndex
            ? `\x1b[1;35m‹${item.label}›\x1b[0m`
            : `\x1b[90m${item.label}\x1b[0m`
        ));
        rows.push(`\x1b[90m${options.secondary.label}\x1b[0m  ${styledEfforts.join('  ')}`);
      } else {
        const secondaryText = `${options.secondary.label}  ‹ ${selectedSecondary.label} ›`;
        rows.push(`\x1b[1;35m${truncateText(secondaryText, width)}\x1b[0m`);
      }
    }

    const availableItemRows = Math.max(1, maxRows - rows.length);
    const firstVisibleIndex = Math.min(
      Math.max(0, activeSelection.selectedIndex - availableItemRows + 1),
      Math.max(0, options.items.length - availableItemRows)
    );
    const visibleItems = options.items.slice(
      firstVisibleIndex,
      firstVisibleIndex + availableItemRows
    );

    for (let offset = 0; offset < visibleItems.length; offset += 1) {
      const itemIndex = firstVisibleIndex + offset;
      const item = visibleItems[offset];
      const label = truncateText(
        `${item.label}${item.description ? `  ${item.description}` : ''}`,
        Math.max(1, width - 2)
      );
      rows.push(itemIndex === activeSelection.selectedIndex
        ? `\x1b[1;35m› ${label}\x1b[0m`
        : `\x1b[90m  ${label}\x1b[0m`);
    }

    return rows.slice(0, maxRows);
  }

  private scrollChat(rows: number): void {
    if (rows === 0 || this.maxChatScrollOffset === 0) {
      return;
    }

    const nextOffset = Math.max(
      0,
      Math.min(this.maxChatScrollOffset, this.chatScrollOffset + rows)
    );
    if (nextOffset !== this.chatScrollOffset) {
      this.chatScrollOffset = nextOffset;
      this.render();
    }
  }

  private render(): void {
    if (!this.started || !this.interactive) {
      return;
    }

    const width = Math.max(20, (stdout.columns || 80) - 1);
    const height = Math.max(8, stdout.rows || 24);
    const header = height >= 22 ? this.options.header : this.options.compactHeader;
    const headerRows = wrapAnsi(header, width);
    const divider = this.options.renderBorder(width);
    let inputLayout: VisibleInputLayout | undefined;
    let inputBlock: string[];

    const badgeText = this.permissionMode ? `\x1b[90m[${this.permissionMode.replace('-', ' ')}]\x1b[0m` : '';

    if (this.activeSelection) {
      const maxSelectionRows = Math.max(1, height - headerRows.length - 5);
      const selectionRows = this.getSelectionRows(width, maxSelectionRows);
      inputBlock = [divider, ...selectionRows, divider, badgeText];
    } else {
      const maxSuggestionRows = Math.max(0, height - headerRows.length - 6);
      const suggestionRows = this.getCommandSuggestionRows(width, maxSuggestionRows);
      const maxInputRows = Math.max(1, height - headerRows.length - 5 - suggestionRows.length);
      inputLayout = this.getInputLayout(width, maxInputRows);
      inputBlock = [divider, ...inputLayout.rows, ...suggestionRows, divider, badgeText];
    }
    if (this.queueText) {
      inputBlock.unshift(this.queueText);
    }
    const chatHeight = Math.max(1, height - headerRows.length - 1 - inputBlock.length);
    const contentWithStatus = this.status
      ? `${this.chatContent}${this.chatContent && !this.chatContent.endsWith('\n') ? '\n' : ''}${this.status}`
      : this.chatContent;
    const wrappedChat = contentWithStatus ? wrapAnsi(contentWithStatus, width) : [];
    let showScrollIndicator = this.chatScrollOffset > 0;
    let chatViewportHeight = Math.max(1, chatHeight - (showScrollIndicator ? 1 : 0));
    this.maxChatScrollOffset = Math.max(0, wrappedChat.length - chatViewportHeight);
    this.chatScrollOffset = Math.min(this.chatScrollOffset, this.maxChatScrollOffset);

    if (this.chatScrollOffset === 0 && showScrollIndicator) {
      showScrollIndicator = false;
      chatViewportHeight = chatHeight;
      this.maxChatScrollOffset = Math.max(0, wrappedChat.length - chatViewportHeight);
    }

    this.chatPageSize = Math.max(1, chatViewportHeight - 1);
    const visibleEnd = Math.max(0, wrappedChat.length - this.chatScrollOffset);
    const visibleStart = Math.max(0, visibleEnd - chatViewportHeight);
    const visibleChat = wrappedChat.slice(visibleStart, visibleEnd);
    const chatRows = showScrollIndicator
      ? [
        `\x1b[1;35m${truncateText(`↑ 历史消息 · 距底部 ${this.chatScrollOffset} 行 · PgDn 返回`, width)}\x1b[0m`,
        ...visibleChat,
        ...new Array(chatViewportHeight - visibleChat.length).fill('')
      ]
      : [...visibleChat, ...new Array(chatHeight - visibleChat.length).fill('')];
    const screenRows = [...headerRows, divider, ...chatRows, ...inputBlock];

    let frame = '\x1b[?25l\x1b[H';
    for (let row = 0; row < height; row += 1) {
      frame += `\x1b[2K${screenRows[row] ?? ''}${row < height - 1 ? '\r\n' : ''}`;
    }

    if (this.activeInput && inputLayout) {
      const inputTop = headerRows.length + 1 + chatHeight;
      const cursorColumn = Math.min(inputLayout.cursor.column, width) + 1;
      const cursorRow = inputTop + inputLayout.cursor.row + 2 + (this.queueText ? 1 : 0);
      frame += `\x1b[${cursorRow};${cursorColumn}H\x1b[?25h`;
    }
    stdout.write(frame);
  }

  private removeInputListeners(): void {
    stdin.off('keypress', this.handleKeypress);
  }

  private removeSelectionListeners(): void {
    stdin.off('keypress', this.handleSelectionKeypress);
  }

  private finishInput(error?: Error): void {
    const activeInput = this.activeInput;
    if (!activeInput) {
      return;
    }

    const value = activeInput.graphemes.join('');
    this.removeInputListeners();
    this.activeInput = undefined;
    this.render();

    if (error) {
      activeInput.reject(error);
    } else {
      activeInput.resolve(value);
    }
  }

  private finishSelection(error?: Error): void {
    const activeSelection = this.activeSelection;
    if (!activeSelection) {
      return;
    }

    const selected = activeSelection.options.items[activeSelection.selectedIndex];
    const selectedSecondary = activeSelection.options.secondary
      ?.items[activeSelection.secondaryIndex];
    this.removeSelectionListeners();
    this.activeSelection = undefined;
    this.render();

    if (error) {
      activeSelection.reject(error);
    } else {
      activeSelection.resolve({
        value: selected.value,
        secondaryValue: selectedSecondary?.value
      });
    }
  }

  private insert(value: string): void {
    const activeInput = this.activeInput;
    if (!activeInput) {
      return;
    }

    const inserted = splitGraphemes(value.replace(/\r\n?/g, '\n'));
    activeInput.graphemes.splice(activeInput.cursorIndex, 0, ...inserted);
    activeInput.cursorIndex += inserted.length;
    activeInput.preferredColumn = undefined;
    activeInput.selectedCommandIndex = 0;
    this.render();
  }

  private moveVertically(direction: -1 | 1): void {
    const activeInput = this.activeInput;
    if (!activeInput) {
      return;
    }

    const width = Math.max(20, (stdout.columns || 80) - 1);
    const layout = layoutInput(
      activeInput.prompt,
      activeInput.graphemes,
      width,
      activeInput.continuationPrompt
    );
    const current = layout.positions[activeInput.cursorIndex];
    const targetRow = current.row + direction;
    if (targetRow < 0 || targetRow >= layout.rows.length) {
      return;
    }

    activeInput.preferredColumn ??= current.column;
    let bestIndex = activeInput.cursorIndex;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < layout.positions.length; index += 1) {
      const position = layout.positions[index];
      if (position.row !== targetRow) {
        continue;
      }

      const distance = Math.abs(position.column - activeInput.preferredColumn);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    activeInput.cursorIndex = bestIndex;
    this.render();
  }

  private readonly handleSelectionKeypress = (_value: string, key: readline.Key) => {
    const activeSelection = this.activeSelection;
    if (!activeSelection) {
      return;
    }
    if (Date.now() <= this.suppressMouseKeypressUntil) {
      return;
    }

    if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
      this.finishSelection(new TerminalInputCancelledError());
      return;
    }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      this.scrollChat(key.name === 'pageup' ? this.chatPageSize : -this.chatPageSize);
      return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      this.finishSelection();
      return;
    }
    if (key.name === 'up' || key.name === 'down') {
      const direction = key.name === 'up' ? -1 : 1;
      const itemCount = activeSelection.options.items.length;
      activeSelection.selectedIndex = (
        activeSelection.selectedIndex + direction + itemCount
      ) % itemCount;
      this.render();
      return;
    }
    if ((key.name === 'left' || key.name === 'right') && activeSelection.options.secondary) {
      const direction = key.name === 'left' ? -1 : 1;
      const itemCount = activeSelection.options.secondary.items.length;
      activeSelection.secondaryIndex = (
        activeSelection.secondaryIndex + direction + itemCount
      ) % itemCount;
      this.render();
    }
  };

  private readonly handleKeypress = (value: string, key: readline.Key) => {
    const activeInput = this.activeInput;
    if (!activeInput) {
      return;
    }
    if (Date.now() <= this.suppressMouseKeypressUntil) {
      return;
    }
    if (value && (/^\[?<\d+;\d+;\d+[mM]$/.test(value) || /^\d+;\d+;\d+[mM]?$/.test(value) || value.includes('[M') || value.includes('[<'))) {
      return;
    }

    if (key.ctrl && key.name === 'c') {
      this.finishInput(new TerminalInputCancelledError());
      return;
    }

    if (key.name === 'pageup' || key.name === 'pagedown') {
      this.scrollChat(key.name === 'pageup' ? this.chatPageSize : -this.chatPageSize);
      return;
    }

    if (key.name === 'return' || key.name === 'enter') {
      if (key.shift || key.meta) {
        this.insert('\n');
      } else {
        const suggestions = this.getCommandSuggestions(activeInput);
        if (suggestions.length > 0) {
          const selected = suggestions[Math.min(activeInput.selectedCommandIndex, suggestions.length - 1)];
          activeInput.graphemes = splitGraphemes(selected.command);
          activeInput.cursorIndex = activeInput.graphemes.length;
        }
        this.finishInput();
      }
      return;
    }

    if (key.ctrl && key.name === 'j') {
      this.insert('\n');
      return;
    }

    if (key.name === 'backspace') {
      if (activeInput.cursorIndex > 0) {
        activeInput.graphemes.splice(activeInput.cursorIndex - 1, 1);
        activeInput.cursorIndex -= 1;
        activeInput.preferredColumn = undefined;
        activeInput.selectedCommandIndex = 0;
        this.render();
      }
      return;
    }

    if (key.name === 'delete' || (key.ctrl && key.name === 'd')) {
      if (key.ctrl && key.name === 'd' && activeInput.graphemes.length === 0) {
        this.finishInput(new TerminalInputCancelledError());
      } else if (activeInput.cursorIndex < activeInput.graphemes.length) {
        activeInput.graphemes.splice(activeInput.cursorIndex, 1);
        activeInput.preferredColumn = undefined;
        activeInput.selectedCommandIndex = 0;
        this.render();
      }
      return;
    }

    if (key.name === 'left' || key.name === 'right') {
      const direction = key.name === 'left' ? -1 : 1;
      activeInput.cursorIndex = Math.max(
        0,
        Math.min(activeInput.graphemes.length, activeInput.cursorIndex + direction)
      );
      activeInput.preferredColumn = undefined;
      this.render();
      return;
    }

    if (key.name === 'up' || key.name === 'down') {
      const suggestions = this.getCommandSuggestions(activeInput);
      if (suggestions.length > 0) {
        const direction = key.name === 'up' ? -1 : 1;
        activeInput.selectedCommandIndex = (
          activeInput.selectedCommandIndex + direction + suggestions.length
        ) % suggestions.length;
        this.render();
        return;
      }
      this.moveVertically(key.name === 'up' ? -1 : 1);
      return;
    }

    if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
      const previousLineBreak = activeInput.graphemes.lastIndexOf('\n', activeInput.cursorIndex - 1);
      activeInput.cursorIndex = key.ctrl ? 0 : previousLineBreak + 1;
      activeInput.preferredColumn = undefined;
      this.render();
      return;
    }

    if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
      const nextLineBreak = activeInput.graphemes.indexOf('\n', activeInput.cursorIndex);
      activeInput.cursorIndex = key.ctrl || nextLineBreak === -1
        ? activeInput.graphemes.length
        : nextLineBreak;
      activeInput.preferredColumn = undefined;
      this.render();
      return;
    }

    if (key.ctrl && key.name === 'w') {
      let deleteFrom = activeInput.cursorIndex;
      while (deleteFrom > 0 && /\s/u.test(activeInput.graphemes[deleteFrom - 1])) {
        deleteFrom -= 1;
      }
      while (deleteFrom > 0 && !/\s/u.test(activeInput.graphemes[deleteFrom - 1])) {
        deleteFrom -= 1;
      }
      activeInput.graphemes.splice(deleteFrom, activeInput.cursorIndex - deleteFrom);
      activeInput.cursorIndex = deleteFrom;
      activeInput.preferredColumn = undefined;
      activeInput.selectedCommandIndex = 0;
      this.render();
      return;
    }

    if ((key.name === 'tab' && key.shift) || key.name === 'backtab' || value === '\x1b[Z') {
      if (this.onShiftTabCallback) {
        this.onShiftTabCallback();
      }
      return;
    }

    if (key.name === 'tab') {
      this.insert('  ');
      return;
    }

    if (!key.ctrl && !key.meta && value && !value.startsWith('\x1b')) {
      this.insert(value);
    }
  };
}
