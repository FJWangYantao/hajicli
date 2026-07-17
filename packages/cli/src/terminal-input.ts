import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_AT_START_PATTERN = /^\x1b\[[0-?]*[ -/]*[@-~]/;
const ANSI_RESET = '\x1b[0m';
const graphemeSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });

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
}

export interface SlashCommand {
  command: string;
  description: string;
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
  originalRawMode: boolean;
  resolve: (value: string) => void;
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
  private status = '';
  private activeInput?: ActiveInput;

  constructor(options: TerminalUIOptions) {
    this.options = options;
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

    stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
    stdout.on('resize', this.handleResize);
    process.on('exit', this.handleProcessExit);
    this.render();
  }

  close(): void {
    if (!this.started) {
      return;
    }

    if (this.activeInput) {
      this.removeInputListeners(this.activeInput.originalRawMode);
      this.activeInput = undefined;
    }

    if (this.interactive) {
      stdout.off('resize', this.handleResize);
      process.off('exit', this.handleProcessExit);
      stdout.write('\x1b[?25h\x1b[0m\x1b[?1049l');
    }
    this.started = false;
  }

  clearChat(): void {
    this.chatContent = '';
    this.render();
  }

  writeChat(value: string): void {
    if (!this.interactive) {
      stdout.write(value);
      return;
    }

    this.chatContent += value;
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

    if (this.activeInput) {
      throw new Error('已有输入请求正在等待处理');
    }

    readline.emitKeypressEvents(stdin);
    return new Promise<string>((resolve, reject) => {
      this.activeInput = {
        prompt,
        continuationPrompt: options.continuationPrompt ?? this.options.continuationPrompt ?? '  ',
        graphemes: [],
        cursorIndex: 0,
        slashCommands: options.slashCommands ?? [],
        selectedCommandIndex: 0,
        originalRawMode: Boolean(stdin.isRaw),
        resolve,
        reject
      };

      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('keypress', this.handleKeypress);
      this.render();
    });
  }

  private readonly handleResize = () => {
    this.render();
  };

  private readonly handleProcessExit = () => {
    if (this.activeInput) {
      stdin.setRawMode(this.activeInput.originalRawMode);
    }
    stdout.write('\x1b[?25h\x1b[0m\x1b[?1049l');
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

  private render(): void {
    if (!this.started || !this.interactive) {
      return;
    }

    const width = Math.max(20, (stdout.columns || 80) - 1);
    const height = Math.max(8, stdout.rows || 24);
    const header = height >= 22 ? this.options.header : this.options.compactHeader;
    const headerRows = wrapAnsi(header, width);
    const divider = this.options.renderBorder(width);
    const maxSuggestionRows = Math.max(0, height - headerRows.length - 5);
    const suggestionRows = this.getCommandSuggestionRows(width, maxSuggestionRows);
    const maxInputRows = Math.max(1, height - headerRows.length - 4 - suggestionRows.length);
    const inputLayout = this.getInputLayout(width, maxInputRows);
    const inputBlock = [divider, ...inputLayout.rows, ...suggestionRows, divider];
    const chatHeight = Math.max(1, height - headerRows.length - 1 - inputBlock.length);
    const contentWithStatus = this.status
      ? `${this.chatContent}${this.chatContent && !this.chatContent.endsWith('\n') ? '\n' : ''}${this.status}`
      : this.chatContent;
    const wrappedChat = contentWithStatus ? wrapAnsi(contentWithStatus, width) : [];
    const visibleChat = wrappedChat.slice(-chatHeight);
    const chatRows = [...visibleChat, ...new Array(chatHeight - visibleChat.length).fill('')];
    const screenRows = [...headerRows, divider, ...chatRows, ...inputBlock];

    let frame = '\x1b[?25l\x1b[H';
    for (let row = 0; row < height; row += 1) {
      frame += `\x1b[2K${screenRows[row] ?? ''}${row < height - 1 ? '\r\n' : ''}`;
    }

    if (this.activeInput) {
      const inputTop = headerRows.length + 1 + chatHeight;
      const cursorColumn = Math.min(inputLayout.cursor.column, width) + 1;
      const cursorRow = inputTop + inputLayout.cursor.row + 2;
      frame += `\x1b[${cursorRow};${cursorColumn}H\x1b[?25h`;
    }
    stdout.write(frame);
  }

  private removeInputListeners(originalRawMode: boolean): void {
    stdin.off('keypress', this.handleKeypress);
    stdin.setRawMode(originalRawMode);
    stdin.pause();
  }

  private finishInput(error?: Error): void {
    const activeInput = this.activeInput;
    if (!activeInput) {
      return;
    }

    const value = activeInput.graphemes.join('');
    this.removeInputListeners(activeInput.originalRawMode);
    this.activeInput = undefined;
    this.render();

    if (error) {
      activeInput.reject(error);
    } else {
      activeInput.resolve(value);
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

  private readonly handleKeypress = (value: string, key: readline.Key) => {
    const activeInput = this.activeInput;
    if (!activeInput) {
      return;
    }

    if (key.ctrl && key.name === 'c') {
      this.finishInput(new TerminalInputCancelledError());
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

    if (key.name === 'tab') {
      this.insert('  ');
      return;
    }

    if (!key.ctrl && !key.meta && value && !value.startsWith('\x1b')) {
      this.insert(value);
    }
  };
}
