import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { TerminalProtocolParser, type TerminalMouseEvent, type TerminalProtocolEvent } from './terminal-protocol.js';
import { TextSelectionModel, type TextCell } from './text-selection.js';

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_AT_OFFSET_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/y;
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
  historyNavigationActive: boolean;
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

interface ChatViewport {
  screenTop: number;
  visibleStart: number;
  visibleEnd: number;
  width: number;
}

interface PendingMouseSelection {
  column: number;
  row: number;
  logicalRow: number;
}

interface AnsiLayoutRow {
  ansi: string;
  plain: string;
  startOffset: number;
  endOffset: number;
}

interface AnsiTextLayout {
  rows: AnsiLayoutRow[];
  document: string;
}

interface VisibleInputLayout {
  rows: string[];
  cursor: CursorPosition;
}

interface TaskPanelItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  agent?: {
    id: string;
    role: string;
    status: 'running' | 'awaiting_verification' | 'verified' | 'rejected' | 'failed' | 'aborted';
    summary?: string;
  };
}

export interface AgentPanelItem {
  id: string;
  role: string;
  status: 'queued' | 'running' | 'awaiting_verification' | 'verified' | 'rejected' | 'failed' | 'aborted';
  startedAt?: number;
  currentTool?: string;
  totalTokens: number;
}

export function formatAgentElapsed(startedAt: number | undefined, now = Date.now()): string {
  if (!startedAt) return '0s';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function formatAgentTokens(totalTokens: number): string {
  if (totalTokens < 1000) return String(totalTokens);
  return `${(totalTokens / 1000).toFixed(totalTokens < 10000 ? 1 : 0)}k`;
}

export function buildAgentPanelRows(
  items: readonly AgentPanelItem[],
  width: number,
  maxRows = 4,
  now = Date.now()
): string[] {
  if (items.length === 0 || maxRows <= 0) return [];
  const running = items.filter(item => item.status === 'running').length;
  const queued = items.filter(item => item.status === 'queued').length;
  const rows = [`\x1b[1;35mAgents ${running} running${queued ? ` · ${queued} queued` : ''}\x1b[0m`];
  for (const agent of items) {
    if (rows.length >= maxRows) break;
    const icon = agent.status === 'running' ? '●' : agent.status === 'queued' ? '○' : agent.status === 'awaiting_verification' ? '✓' : '×';
    const detail = agent.status === 'running'
      ? `${agent.currentTool || 'thinking'} · ${formatAgentElapsed(agent.startedAt, now)} · ${formatAgentTokens(agent.totalTokens)} tok`
      : agent.status.replaceAll('_', ' ');
    rows.push(`\x1b[90m${icon} ${agent.id}  ${truncateText(`${agent.role} · ${detail}`, Math.max(1, width - agent.id.length - 4))}\x1b[0m`);
  }
  return rows;
}

export class TerminalInputCancelledError extends Error {
  constructor() {
    super('Terminal input cancelled');
    this.name = 'TerminalInputCancelledError';
  }
}

function isRealCtrlC(value: string, key: readline.Key): boolean {
  return value === '\x03' && key.ctrl === true && key.name === 'c';
}

function isRealCtrlD(value: string, key: readline.Key): boolean {
  return value === '\x04' && key.ctrl === true && key.name === 'd';
}

function isRealCtrlU(value: string, key: readline.Key): boolean {
  return value === '\x15' && key.ctrl === true && key.name === 'u';
}

export class InputHistoryBuffer {
  private readonly entries: string[] = [];
  private cursor = 0;
  private draft = '';

  begin(draft = ''): void {
    this.cursor = this.entries.length;
    this.draft = draft;
  }

  record(value: string): void {
    if (value.trim()) {
      this.entries.push(value);
    }
    this.begin();
  }

  move(direction: -1 | 1, currentValue: string): string | undefined {
    if (this.entries.length === 0) {
      return undefined;
    }

    if (direction === -1) {
      if (this.cursor === this.entries.length) {
        this.draft = currentValue;
      }
      if (this.cursor === 0) {
        return undefined;
      }
      this.cursor -= 1;
      return this.entries[this.cursor];
    }

    if (this.cursor >= this.entries.length) {
      return undefined;
    }
    this.cursor += 1;
    return this.cursor === this.entries.length ? this.draft : this.entries[this.cursor];
  }

  isBrowsing(): boolean {
    return this.cursor < this.entries.length;
  }
}

class ClipboardWriter {
  private child?: ReturnType<typeof spawn>;
  private outputBuffer = '';
  private readonly pending: Array<(success: boolean) => void> = [];

  start(): void {
    if (process.platform !== 'win32' || this.child) return;

    const script = [
      '[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)',
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
      'while (($line = [Console]::In.ReadLine()) -ne $null) {',
      '  try {',
      '    $bytes = [Convert]::FromBase64String($line)',
      '    $text = [Text.Encoding]::UTF8.GetString($bytes)',
      '    Set-Clipboard -Value $text',
      "    [Console]::Out.WriteLine('OK')",
      '  } catch {',
      "    [Console]::Out.WriteLine('ERR')",
      '  }',
      '}'
    ].join('; ');

    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.outputBuffer += chunk;
      let newlineIndex = this.outputBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const result = this.outputBuffer.slice(0, newlineIndex).trim();
        this.outputBuffer = this.outputBuffer.slice(newlineIndex + 1);
        this.pending.shift()?.(result === 'OK');
        newlineIndex = this.outputBuffer.indexOf('\n');
      }
    });
    const failPending = () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.outputBuffer = '';
      for (const resolve of this.pending.splice(0)) resolve(false);
    };
    child.once('error', failPending);
    child.once('exit', failPending);
  }

  write(text: string): Promise<boolean> {
    if (!text) return Promise.resolve(false);
    if (process.platform !== 'win32') {
      stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
      return Promise.resolve(true);
    }

    this.start();
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      this.pending.push(resolve);
      child.stdin!.write(`${Buffer.from(text, 'utf8').toString('base64')}\n`, error => {
        if (!error) return;
        const pendingIndex = this.pending.indexOf(resolve);
        if (pendingIndex >= 0) this.pending.splice(pendingIndex, 1);
        resolve(false);
      });
    });
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    this.outputBuffer = '';
    for (const resolve of this.pending.splice(0)) resolve(false);
    child?.stdin?.end();
  }
}

export function buildScreenUpdate(previousRows: readonly string[], nextRows: readonly string[]): string {
  let output = '';
  for (let row = 0; row < nextRows.length; row += 1) {
    if (previousRows[row] === nextRows[row]) continue;
    output += `\x1b[${row + 1};1H\x1b[2K${nextRows[row]}`;
  }
  return output;
}

function splitGraphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), part => part.segment);
}

function ansiSequenceAt(value: string, offset: number): string | undefined {
  ANSI_AT_OFFSET_PATTERN.lastIndex = offset;
  return ANSI_AT_OFFSET_PATTERN.exec(value)?.[0];
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

function measureGrapheme(grapheme: string): number {
  const codePoints = Array.from(grapheme, character => character.codePointAt(0) ?? 0);
  if (codePoints.every(isZeroWidth)) {
    return 0;
  }
  return codePoints.some(isWide) ? 2 : 1;
}

function terminalWidth(value: string): number {
  return splitGraphemes(value.replace(ANSI_PATTERN, ''))
    .reduce((width, grapheme) => width + measureGrapheme(grapheme), 0);
}

function highlightAnsiColumns(value: string, startColumn: number, endColumn: number): string {
  if (endColumn <= startColumn) {
    return value;
  }

  const selectionOn = '\x1b[7m';
  const selectionOff = '\x1b[27m';
  let result = '';
  let column = 0;
  let offset = 0;
  let highlighted = false;

  while (offset < value.length) {
    if (value[offset] === '\x1b') {
      const sequence = ansiSequenceAt(value, offset);
      if (sequence) {
        result += sequence;
        if (highlighted && /\x1b\[(?:0)?m/.test(sequence)) {
          result += selectionOn;
        }
        offset += sequence.length;
        continue;
      }
    }

    const grapheme = splitGraphemes(value.slice(offset))[0];
    const width = measureGrapheme(grapheme);
    const shouldHighlight = column < endColumn && column + width > startColumn;
    if (shouldHighlight !== highlighted) {
      result += shouldHighlight ? selectionOn : selectionOff;
      highlighted = shouldHighlight;
    }
    result += grapheme;
    column += width;
    offset += grapheme.length;
  }

  if (highlighted) {
    result += selectionOff;
  }
  return result;
}

function truncateText(value: string, width: number): string {
  let result = '';
  let resultWidth = 0;

  for (const grapheme of splitGraphemes(value)) {
    const graphemeWidth = measureGrapheme(grapheme);
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

    const graphemeWidth = measureGrapheme(grapheme);
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

interface WrappedAnsiResult {
  rows: string[];
  activeStyle: string;
}

export function wrapAnsiWithState(value: string, width: number, initialStyle = ''): WrappedAnsiResult {
  const rows: string[] = [];
  let row = initialStyle;
  let rowWidth = 0;
  let activeStyle = initialStyle;
  let offset = 0;

  const pushRow = () => {
    rows.push(`${row}${ANSI_RESET}`);
    row = activeStyle;
    rowWidth = 0;
  };

  while (offset < value.length) {
    if (value[offset] === '\x1b') {
      const sequence = ansiSequenceAt(value, offset);
      if (sequence) {
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

      const graphemeWidth = measureGrapheme(grapheme);
      if (rowWidth + graphemeWidth > width && rowWidth > 0) {
        pushRow();
      }
      row += grapheme;
      rowWidth += graphemeWidth;
    }
    offset = textEnd;
  }

  rows.push(`${row}${ANSI_RESET}`);
  return { rows, activeStyle };
}

export function wrapAnsi(value: string, width: number): string[] {
  return wrapAnsiWithState(value, width).rows;
}

export function layoutAnsiDocument(value: string, width: number): AnsiTextLayout {
  const rows: AnsiLayoutRow[] = [];
  let rowAnsi = '';
  let rowPlain = '';
  let rowWidth = 0;
  let activeStyle = '';
  let document = '';
  let rowStartOffset = 0;
  let offset = 0;

  const pushRow = () => {
    rows.push({
      ansi: `${rowAnsi}${ANSI_RESET}`,
      plain: rowPlain,
      startOffset: rowStartOffset,
      endOffset: document.length
    });
    rowAnsi = activeStyle;
    rowPlain = '';
    rowWidth = 0;
    rowStartOffset = document.length;
  };

  const appendGrapheme = (grapheme: string) => {
    if (grapheme === '\r') {
      return;
    }
    if (grapheme === '\n') {
      pushRow();
      document += '\n';
      rowStartOffset = document.length;
      return;
    }

    const graphemeWidth = measureGrapheme(grapheme);
    if (rowWidth + graphemeWidth > width && rowWidth > 0) {
      pushRow();
    }
    rowAnsi += grapheme;
    rowPlain += grapheme;
    rowWidth += graphemeWidth;
    document += grapheme;
  };

  while (offset < value.length) {
    if (value[offset] === '\x1b') {
      const sequence = ansiSequenceAt(value, offset);
      if (sequence) {
        rowAnsi += sequence;
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
    if (textEnd === offset) {
      appendGrapheme(value[offset]);
      offset += 1;
      continue;
    }
    for (const grapheme of splitGraphemes(value.slice(offset, textEnd))) {
      appendGrapheme(grapheme);
    }
    offset = textEnd;
  }

  pushRow();
  return { rows, document };
}

function cellAtColumn(row: AnsiLayoutRow, column: number, clampToText = false): TextCell | undefined {
  const targetColumn = Math.max(0, column - 1);
  let visualColumn = 0;
  let textOffset = row.startOffset;

  let lastCell: TextCell | undefined;
  for (const grapheme of splitGraphemes(row.plain)) {
    const width = measureGrapheme(grapheme);
    const cell = { startOffset: textOffset, endOffset: textOffset + grapheme.length };
    if (targetColumn >= visualColumn && targetColumn < visualColumn + width) {
      return cell;
    }
    lastCell = cell;
    visualColumn += width;
    textOffset += grapheme.length;
  }

  return clampToText ? lastCell : undefined;
}

export class TerminalUI {
  private readonly options: TerminalUIOptions;
  private readonly keyInput = new PassThrough();
  private readonly protocolParser = new TerminalProtocolParser();
  private readonly textSelection = new TextSelectionModel();
  private readonly inputHistory = new InputHistoryBuffer();
  private readonly clipboardWriter = new ClipboardWriter();
  private readonly interactive = Boolean(stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function');
  private started = false;
  private chatContent = '';
  private chatScrollOffset = 0;
  private maxChatScrollOffset = 0;
  private chatPageSize = 1;
  private status = '';
  private permissionMode = '';
  private modelName = '';
  private reasoningEffort = '';
  private usedTokens = 0;
  private maxTokens = 1000000;
  private taskPanelTitle = '';
  private taskPanelItems: TaskPanelItem[] = [];
  private agentPanelItems: AgentPanelItem[] = [];
  private agentPanelTimer: NodeJS.Timeout | null = null;
  private activeInput?: ActiveInput;
  private activeSelection?: ActiveSelection;
  private chatViewport?: ChatViewport;
  private selectionLayout?: AnsiTextLayout;
  private pendingMouseSelection?: PendingMouseSelection;
  private selectionLayoutContent = '';
  private selectionLayoutWidth = 0;
  private originalRawMode = false;
  private onShiftTabCallback?: () => void;
  private onEscCallback?: () => void;
  private queueText = '';
  private cachedContentWithStatus = '';
  private cachedWrappedWidth = 0;
  private cachedWrappedChat: string[] = [];
  private stableWrapPrefix = '';
  private stableWrapPrefixWidth = 0;
  private stableWrapPrefixRows: string[] = [];
  private stableWrapPrefixStyle = '';
  private renderScheduled = false;
  private streamRenderTimer: NodeJS.Timeout | null = null;
  private protocolFlushTimer: NodeJS.Timeout | null = null;
  private startupHeaderVisible = true;
  private renderedScreenRows: string[] = [];
  private renderedScreenWidth = 0;
  private renderedScreenHeight = 0;
  private renderedCursorState = '';

  constructor(options: TerminalUIOptions) {
    this.options = options;
  }

  setPermissionMode(mode: string): void {
    this.permissionMode = mode;
    this.scheduleRender();
  }

  setModelInfo(model: string, effort?: string): void {
    this.modelName = model;
    this.reasoningEffort = effort || '';
    this.scheduleRender();
  }

  setContextUsage(usedTokens: number, maxTokens = 1000000): void {
    this.usedTokens = Math.max(0, usedTokens);
    this.maxTokens = Math.max(1, maxTokens);
    this.scheduleRender();
  }

  setTaskPlan(plan: { title: string; tasks: TaskPanelItem[]; completedTasks?: TaskPanelItem[] } | null): void {
    this.taskPanelTitle = plan?.title || '';
    this.taskPanelItems = plan ? [...(plan.completedTasks || []), ...plan.tasks] : [];
    this.scheduleRender();
  }

  setAgentPanel(items: AgentPanelItem[]): void {
    this.agentPanelItems = items.slice(0, 20);
    const hasRunning = items.some(item => item.status === 'running');
    if (hasRunning && !this.agentPanelTimer) {
      this.agentPanelTimer = setInterval(() => this.scheduleRender(), 1000);
      this.agentPanelTimer.unref?.();
    } else if (!hasRunning && this.agentPanelTimer) {
      clearInterval(this.agentPanelTimer);
      this.agentPanelTimer = null;
    }
    this.scheduleRender();
  }

  /** 用户提交第一条普通消息后隐藏启动 Logo，并立即释放页眉空间。 */
  dismissStartupHeader(): void {
    if (!this.startupHeaderVisible) return;
    this.startupHeaderVisible = false;
    this.cachedContentWithStatus = '';
    this.cachedWrappedWidth = 0;
    this.scheduleRender();
  }

  onShiftTab(callback: () => void): void {
    this.onShiftTabCallback = callback;
  }

  onEsc(callback: () => void): void {
    this.onEscCallback = callback;
  }

  setQueue(items: string[]): void {
    if (items.length === 0) {
      this.queueText = '';
    } else {
      const formatted = items.map((msg, idx) => `[${idx + 1}] ${msg}`).join('  ');
      const maxLen = Math.max(10, (stdout.columns || 80) - 26);
      this.queueText = ` \x1b[1;33m⏳ 待处理队列 (${items.length} 条):\x1b[0m \x1b[36m${truncateText(formatted, maxLen)}\x1b[0m`;
    }
    this.scheduleRender();
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
    this.startupHeaderVisible = true;
    this.renderedScreenRows = [];
    this.renderedScreenWidth = 0;
    this.renderedScreenHeight = 0;
    this.renderedCursorState = '';

    if (!this.interactive) {
      if (this.options.compactHeader) stdout.write(`${this.options.compactHeader}\n`);
      return;
    }

    this.originalRawMode = Boolean(stdin.isRaw);
    readline.emitKeypressEvents(this.keyInput);
    stdin.setRawMode(true);
    enableWindowsVirtualTerminalInput();
    stdin.resume();
    this.clipboardWriter.start();
    // 1002 负责拖动和滚轮，1006 统一为 SGR 坐标；禁用 1007，避免滚轮重复转成方向键。
    stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1007l\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[?1002h\x1b[?1006h\x1b[?2004h');
    stdout.on('resize', this.handleResize);
    stdin.on('data', this.handleMouseData);
    this.keyInput.on('keypress', this.dispatchKeypress);
    process.on('exit', this.handleProcessExit);
    this.render();
  }

  close(): void {
    if (!this.started) {
      return;
    }

    if (this.activeInput) {
      this.activeInput = undefined;
    }
    if (this.activeSelection) {
      this.activeSelection = undefined;
    }

    if (this.interactive) {
      stdout.off('resize', this.handleResize);
      stdin.off('data', this.handleMouseData);
      this.keyInput.off('keypress', this.dispatchKeypress);
      stdin.setRawMode(this.originalRawMode);
      stdin.pause();
      process.off('exit', this.handleProcessExit);
      stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1007l\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l');
    }
    if (this.streamRenderTimer) {
      clearTimeout(this.streamRenderTimer);
      this.streamRenderTimer = null;
    }
    if (this.protocolFlushTimer) {
      clearTimeout(this.protocolFlushTimer);
      this.protocolFlushTimer = null;
    }
    if (this.agentPanelTimer) {
      clearInterval(this.agentPanelTimer);
      this.agentPanelTimer = null;
    }
    this.protocolParser.reset();
    this.clipboardWriter.close();
    this.textSelection.clear();
    this.selectionLayout = undefined;
    this.pendingMouseSelection = undefined;
    this.renderScheduled = false;
    this.started = false;
  }

  clearChat(): void {
    this.chatContent = '';
    this.chatScrollOffset = 0;
    this.textSelection.clear();
    this.selectionLayout = undefined;
    this.pendingMouseSelection = undefined;
    this.chatViewport = undefined;
    this.cachedContentWithStatus = '';
    this.cachedWrappedChat = [];
    this.setStableWrapPrefix('');
    this.render();
  }

  /**
   * 获取缓存或平滑增量计算的软换行聊天行。
   */
  private setStableWrapPrefix(value: string): void {
    const prefix = value.endsWith('\n') ? value : '';
    if (prefix === this.stableWrapPrefix) {
      return;
    }
    this.stableWrapPrefix = prefix;
    this.stableWrapPrefixWidth = 0;
    this.stableWrapPrefixRows = [];
    this.stableWrapPrefixStyle = '';
  }

  private getWrappedChat(contentWithStatus: string, width: number): string[] {
    if (!contentWithStatus) {
      this.cachedContentWithStatus = '';
      this.cachedWrappedChat = [];
      this.cachedWrappedWidth = width;
      return [];
    }

    if (contentWithStatus === this.cachedContentWithStatus && width === this.cachedWrappedWidth) {
      return this.cachedWrappedChat;
    }

    if (this.stableWrapPrefix && contentWithStatus.startsWith(this.stableWrapPrefix)) {
      if (width !== this.stableWrapPrefixWidth) {
        const wrappedPrefix = wrapAnsiWithState(this.stableWrapPrefix, width);
        this.stableWrapPrefixRows = wrappedPrefix.rows.slice(0, -1);
        this.stableWrapPrefixStyle = wrappedPrefix.activeStyle;
        this.stableWrapPrefixWidth = width;
      }
      const wrappedTail = wrapAnsiWithState(
        contentWithStatus.slice(this.stableWrapPrefix.length),
        width,
        this.stableWrapPrefixStyle
      ).rows;
      this.cachedWrappedChat = [...this.stableWrapPrefixRows, ...wrappedTail];
      this.cachedContentWithStatus = contentWithStatus;
      this.cachedWrappedWidth = width;
      return this.cachedWrappedChat;
    }

    this.cachedWrappedChat = wrapAnsi(contentWithStatus, width);
    this.cachedContentWithStatus = contentWithStatus;
    this.cachedWrappedWidth = width;
    return this.cachedWrappedChat;
  }

  /**
   * 流式输出重绘节流调度器（防抖至下一个微任务周期，兼顾平滑度与帧率）。
   */
  private scheduleRender(): void {
    if (this.renderScheduled) {
      return;
    }
    this.renderScheduled = true;
    if (this.streamRenderTimer) {
      clearTimeout(this.streamRenderTimer);
    }
    this.streamRenderTimer = setTimeout(() => {
      this.renderScheduled = false;
      this.streamRenderTimer = null;
      this.render();
    }, 16);
  }

  writeChat(value: string): void {
    if (!this.interactive) {
      stdout.write(value);
      return;
    }

    this.chatContent += value;
    if (this.chatContent.length > 200_000) {
      this.chatContent = this.chatContent.slice(-160_000);
      this.cachedContentWithStatus = '';
      this.setStableWrapPrefix('');
    }

    this.scheduleRender();
  }

  writeLine(value: string = ''): void {
    this.writeChat(`${value}\n`);
  }

  /**
   * 获取当前聊天缓冲区的总字符长度。
   */
  getChatLength(): number {
    return this.chatContent.length;
  }

  markStableChatPrefix(offset: number = this.chatContent.length): void {
    const safeOffset = Math.max(0, Math.min(offset, this.chatContent.length));
    this.setStableWrapPrefix(this.chatContent.slice(0, safeOffset));
  }

  replaceChat(value: string): void {
    if (!this.interactive) {
      stdout.write(value);
      return;
    }

    this.chatContent = value.length > 200_000 ? value.slice(-160_000) : value;
    this.chatScrollOffset = 0;
    this.textSelection.clear();
    this.pendingMouseSelection = undefined;
    this.selectionLayout = undefined;
    this.selectionLayoutContent = '';
    this.selectionLayoutWidth = 0;
    this.cachedContentWithStatus = '';
    this.cachedWrappedWidth = 0;
    this.cachedWrappedChat = [];
    this.setStableWrapPrefix(this.chatContent);
    this.scheduleRender();
  }

  /**
   * 从指定偏置位置起覆盖更新聊天内容（用于 Markdown 流式平滑重绘）。
   * @param offset 偏移起始位置
   * @param value 新的文本内容
   */
  updateChatFrom(offset: number, value: string): void {
    if (!this.interactive) {
      const delta = value.slice(Math.max(0, this.chatContent.length - offset));
      if (delta) {
        stdout.write(delta);
      }
    }

    this.markStableChatPrefix(offset);
    this.chatContent = this.chatContent.slice(0, offset) + value;
    if (this.chatContent.length > 200_000) {
      this.chatContent = this.chatContent.slice(-160_000);
      this.cachedContentWithStatus = '';
      this.setStableWrapPrefix('');
    }

    this.scheduleRender();
  }

  setStatus(value: string = ''): void {
    this.status = value;
    this.scheduleRender();
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
    this.inputHistory.begin(options.initialValue ?? '');
    return new Promise<string>((resolve, reject) => {
      this.activeInput = {
        prompt,
        continuationPrompt: options.continuationPrompt ?? this.options.continuationPrompt ?? '  ',
        graphemes: initialGraphemes,
        cursorIndex: initialGraphemes.length,
        slashCommands: options.slashCommands ?? [],
        selectedCommandIndex: 0,
        historyNavigationActive: false,
        resolve,
        reject
      };

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

      this.render();
    });
  }

  private readonly handleResize = () => {
    this.cachedContentWithStatus = '';
    this.cachedWrappedWidth = 0;
    this.stableWrapPrefixWidth = 0;
    this.selectionLayout = undefined;
    this.pendingMouseSelection = undefined;
    this.render();
  };

  private getSelectionLayout(): AnsiTextLayout {
    const width = this.chatViewport?.width ?? Math.max(20, (stdout.columns || 80) - 1);
    if (
      !this.selectionLayout
      || this.selectionLayoutContent !== this.chatContent
      || this.selectionLayoutWidth !== width
    ) {
      this.selectionLayout = layoutAnsiDocument(this.chatContent, width);
      this.selectionLayoutContent = this.chatContent;
      this.selectionLayoutWidth = width;
    }
    return this.selectionLayout;
  }

  private getChatCellFromMouse(column: number, row: number, clampToText = false): TextCell | undefined {
    const viewport = this.chatViewport;
    if (!viewport || viewport.visibleEnd <= viewport.visibleStart) {
      return undefined;
    }

    const visibleRowCount = viewport.visibleEnd - viewport.visibleStart;
    const screenRowOffset = Math.max(0, Math.min(visibleRowCount - 1, row - viewport.screenTop));
    const logicalRow = viewport.visibleStart + screenRowOffset;
    return this.getChatCellAtLogicalRow(column, logicalRow, clampToText);
  }

  private getChatCellAtLogicalRow(column: number, logicalRow: number, clampToText = false): TextCell | undefined {
    const layout = this.getSelectionLayout();
    const layoutRow = layout.rows[logicalRow];
    return layoutRow ? cellAtColumn(layoutRow, column, clampToText) : undefined;
  }

  private getLogicalChatRow(row: number): number | undefined {
    const viewport = this.chatViewport;
    if (!viewport || viewport.visibleEnd <= viewport.visibleStart || !this.isMouseInChatViewport(row)) {
      return undefined;
    }
    return viewport.visibleStart + (row - viewport.screenTop);
  }

  private isMouseInChatViewport(row: number): boolean {
    const viewport = this.chatViewport;
    return Boolean(
      viewport
      && row >= viewport.screenTop
      && row < viewport.screenTop + (viewport.visibleEnd - viewport.visibleStart)
    );
  }

  private highlightChatRow(value: string, logicalRow: number): string {
    const selection = this.textSelection.range();
    if (!selection) {
      return value;
    }
    const layoutRow = this.getSelectionLayout().rows[logicalRow];
    if (!layoutRow || selection.endOffset <= layoutRow.startOffset || selection.startOffset >= layoutRow.endOffset) {
      return value;
    }

    const startInRow = Math.max(0, selection.startOffset - layoutRow.startOffset);
    const endInRow = Math.min(layoutRow.plain.length, selection.endOffset - layoutRow.startOffset);
    const startColumn = terminalWidth(layoutRow.plain.slice(0, startInRow));
    const endColumn = terminalWidth(layoutRow.plain.slice(0, endInRow));
    return highlightAnsiColumns(value, startColumn, endColumn);
  }

  private getSelectedChatText(): string {
    return this.textSelection.selectedText(this.getSelectionLayout().document);
  }

  private copyChatSelection(): boolean {
    const text = this.getSelectedChatText();
    if (!text) {
      return false;
    }

    void this.clipboardWriter.write(text).then(success => {
      if (!success || this.getSelectedChatText() !== text) return;
      this.textSelection.clear();
      this.selectionLayout = undefined;
      this.render();
    });
    return true;
  }

  private dispatchProtocolEvent(event: TerminalProtocolEvent): void {
    if (event.type === 'keyboard') {
      this.keyInput.write(event.data);
      return;
    }
    if (event.type === 'paste') {
      if (event.text) {
        this.insert(event.text);
      }
      return;
    }
    this.handleMouseEvent(event);
  }

  private handleMouseEvent(event: TerminalMouseEvent): void {
    if (event.action === 'wheel') {
      this.pendingMouseSelection = undefined;
      this.scrollChat(event.wheelRows ?? 0);
      if (this.textSelection.dragging) {
        const cell = this.getChatCellFromMouse(event.column, event.row, true);
        if (cell) {
          this.textSelection.update(cell);
          this.scheduleRender();
        }
      }
      return;
    }

    const isLeftButton = (event.button & 3) === 0;
    if (event.action === 'down' && isLeftButton) {
      const logicalRow = this.getLogicalChatRow(event.row);
      if (logicalRow === undefined) {
        this.pendingMouseSelection = undefined;
        this.textSelection.clear();
        this.selectionLayout = undefined;
        this.scheduleRender();
        return;
      }

      // 单击只记录轻量屏幕锚点；收到真实移动事件后才计算完整文档布局。
      this.pendingMouseSelection = {
        column: event.column,
        row: event.row,
        logicalRow
      };
      this.textSelection.clear();
      this.selectionLayout = undefined;
      this.scheduleRender();
      return;
    }

    if (event.action === 'move' && isLeftButton && this.pendingMouseSelection) {
      const pending = this.pendingMouseSelection;
      if (pending.column === event.column && pending.row === event.row) {
        return;
      }
      this.pendingMouseSelection = undefined;
      const anchor = this.getChatCellAtLogicalRow(pending.column, pending.logicalRow);
      const cell = this.getChatCellFromMouse(event.column, event.row, true);
      if (anchor && cell) {
        this.textSelection.begin(anchor);
        this.textSelection.update(cell);
        this.scheduleRender();
      }
      return;
    }

    if (event.action === 'move' && isLeftButton && this.textSelection.dragging) {
      const cell = this.getChatCellFromMouse(event.column, event.row, true);
      if (cell) {
        this.textSelection.update(cell);
        this.scheduleRender();
      }
      return;
    }

    if (event.action === 'up' && isLeftButton && this.pendingMouseSelection) {
      this.pendingMouseSelection = undefined;
      this.selectionLayout = undefined;
      return;
    }

    if (event.action === 'up' && isLeftButton && this.textSelection.dragging) {
      const cell = this.getChatCellFromMouse(event.column, event.row, true);
      this.textSelection.finish(cell);
      this.scheduleRender();
    }
  }

  private readonly handleMouseData = (data: Buffer | string) => {
    if (this.protocolFlushTimer) {
      clearTimeout(this.protocolFlushTimer);
      this.protocolFlushTimer = null;
    }

    for (const event of this.protocolParser.push(data)) {
      this.dispatchProtocolEvent(event);
    }

    this.protocolFlushTimer = setTimeout(() => {
      this.protocolFlushTimer = null;
      for (const event of this.protocolParser.flushPending()) {
        this.dispatchProtocolEvent(event);
      }
    }, 80);
  };

  private readonly dispatchKeypress = (value: string, key: readline.Key) => {
    if (this.activeSelection) {
      this.handleSelectionKeypress(value, key);
    } else if (this.activeInput) {
      this.handleKeypress(value, key);
    } else {
      this.handleIdleKeypress(value, key);
    }
  };

  private readonly handleIdleKeypress = (value: string, key: readline.Key) => {
    if (isRealCtrlC(value, key) && this.copyChatSelection()) {
      return;
    }
    if (isRealCtrlC(value, key) && !this.activeInput && !this.activeSelection) {
      this.close();
      process.exit(130);
    }
    if ((key.name === 'tab' && key.shift) || key.name === 'backtab' || value === '\x1b[Z') {
      if (this.onShiftTabCallback) {
        this.onShiftTabCallback();
      }
      return;
    }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      this.scrollChat(key.name === 'pageup' ? this.chatPageSize : -this.chatPageSize);
      return;
    }
    if (key.name === 'up' || key.name === 'down') {
      this.scrollChat(key.name === 'up' ? 1 : -1);
      return;
    }
    if (key.name === 'home') {
      this.scrollChat(this.maxChatScrollOffset);
      return;
    }
    if (key.name === 'end') {
      this.scrollChat(-this.chatScrollOffset);
      return;
    }
    if (this.activeInput || this.activeSelection) {
      return;
    }
  };

  private readonly handleProcessExit = () => {
    stdin.setRawMode(this.originalRawMode);
    stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1007l\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l');
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
    if (activeInput.historyNavigationActive) {
      return [];
    }
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
      const viewport = this.chatViewport;
      if (viewport) {
        const viewportHeight = viewport.visibleEnd - viewport.visibleStart;
        const totalRows = this.maxChatScrollOffset + viewportHeight;
        viewport.visibleEnd = Math.max(0, totalRows - nextOffset);
        viewport.visibleStart = Math.max(0, viewport.visibleEnd - viewportHeight);
      }
      this.scheduleRender();
    }
  }

  private buildStatusBar(width: number): string {
    const modeLabel = this.permissionMode === 'plan' ? 'Plan Mode' : this.permissionMode.replace('-', ' ');
    const permText = this.permissionMode ? `[${modeLabel}]` : '';
    const permColorMap: Record<string, string> = {
      plan: '\x1b[36m',
      default: '\x1b[32m',
      'accept-edit': '\x1b[33m',
      auto: '\x1b[35m',
      'bypass-permissions': '\x1b[1;31m',
    };
    const permColor = permText ? (permColorMap[this.permissionMode] || '\x1b[90m') : '';
    const permAnsi = permText ? `${permColor}${permText}\x1b[0m` : '';

    let modelStr = '';
    if (this.modelName) {
      modelStr = this.reasoningEffort
        ? `${this.modelName}(${this.reasoningEffort})`
        : this.modelName;
    }
    const modelAnsi = modelStr ? `\x1b[1;36m${modelStr}\x1b[0m` : '';

    const leftAnsi = [permAnsi, modelAnsi].filter(Boolean).join('  ');
    const leftWidth = terminalWidth(leftAnsi);

    const used = this.usedTokens;
    const max = this.maxTokens;
    const ratio = Math.min(1, Math.max(0, used / max));

    let colorCode = '\x1b[36m';
    if (ratio >= 0.85) {
      colorCode = '\x1b[1;31m';
    } else if (ratio >= 0.6) {
      colorCode = '\x1b[33m';
    }

    const numText = `${used} / ${max}`;
    let barCapacity = 10;
    const minRightWidth = barCapacity + 1 + numText.length;

    if (leftWidth + minRightWidth + 1 > width) {
      barCapacity = Math.max(3, width - leftWidth - numText.length - 2);
    }

    const filledCount = Math.min(barCapacity, Math.max(0, Math.round(ratio * barCapacity)));
    const emptyCount = Math.max(0, barCapacity - filledCount);
    const barStr = `${'█'.repeat(filledCount)}${'░'.repeat(emptyCount)}`;

    const rightAnsi = `${colorCode}${barStr} ${numText}\x1b[0m`;
    const rightWidth = terminalWidth(rightAnsi);

    if (leftWidth + rightWidth + 1 <= width) {
      const padding = ' '.repeat(width - leftWidth - rightWidth);
      return `${leftAnsi}${padding}${rightAnsi}`;
    }

    return truncateText(`${leftAnsi} ${rightAnsi}`, width);
  }

  private buildTaskPanel(width: number, maxRows = 8): string[] {
    if (!this.taskPanelTitle || maxRows <= 0) return [];
    const rows = [`\x1b[1;36m${truncateText(this.taskPanelTitle, width)}\x1b[0m`];
    for (const task of this.taskPanelItems) {
      if (rows.length >= maxRows) break;
      if (task.status === 'completed') {
        rows.push(`\x1b[9;90m[x] ${truncateText(task.content, Math.max(1, width - 4))}\x1b[0m`);
      } else if (task.status === 'in_progress') {
        rows.push(`\x1b[1;33m[•] ${truncateText(task.content, Math.max(1, width - 4))}\x1b[0m`);
      } else {
        rows.push(`\x1b[90m[ ] ${truncateText(task.content, Math.max(1, width - 4))}\x1b[0m`);
      }
      if (task.agent && rows.length < maxRows) {
        const statusLabel = task.agent.status === 'running'
          ? '运行中'
          : task.agent.status === 'awaiting_verification'
            ? '待验证'
            : task.agent.status === 'verified'
              ? '已验证'
            : task.agent.status === 'aborted'
              ? '已中止'
              : '失败';
        const color = task.agent.status === 'running'
          ? '\x1b[36m'
          : task.agent.status === 'verified'
            ? '\x1b[32m'
            : task.agent.status === 'awaiting_verification'
              ? '\x1b[33m'
              : '\x1b[31m';
        rows.push(`${color}    ↳ ${truncateText(`${task.agent.role} · ${statusLabel}`, Math.max(1, width - 6))}\x1b[0m`);
      }
    }
    return rows;
  }

  private buildAgentPanel(width: number, maxRows = 4): string[] {
    return buildAgentPanelRows(this.agentPanelItems, width, maxRows);
  }

  private render(): void {
    if (this.streamRenderTimer) {
      clearTimeout(this.streamRenderTimer);
      this.streamRenderTimer = null;
    }
    this.renderScheduled = false;

    if (!this.started || !this.interactive) {
      return;
    }

    const width = Math.max(20, (stdout.columns || 80) - 1);
    const height = Math.max(8, stdout.rows || 24);
    const header = this.startupHeaderVisible
      ? (height >= 22 ? this.options.header : this.options.compactHeader)
      : '';
    const headerRows = header ? wrapAnsi(header, width) : [];
    const agentRows = this.buildAgentPanel(width, Math.max(0, Math.min(4, height - headerRows.length - 8)));
    const taskRows = this.buildTaskPanel(width, Math.max(0, Math.min(8, height - headerRows.length - agentRows.length - 8)));
    const topRows = [...headerRows, ...taskRows, ...agentRows];
    const divider = this.options.renderBorder(width);
    let inputLayout: VisibleInputLayout | undefined;
    let inputBlock: string[];

    const statusBar = this.buildStatusBar(width);

    if (this.activeSelection) {
      const maxSelectionRows = Math.max(1, height - topRows.length - 5);
      const selectionRows = this.getSelectionRows(width, maxSelectionRows);
      inputBlock = [divider, ...selectionRows, divider, statusBar];
    } else {
      const maxSuggestionRows = Math.max(0, height - topRows.length - 6);
      const suggestionRows = this.getCommandSuggestionRows(width, maxSuggestionRows);
      const maxInputRows = Math.max(1, height - topRows.length - 5 - suggestionRows.length);
      inputLayout = this.getInputLayout(width, maxInputRows);
      inputBlock = [divider, ...inputLayout.rows, ...suggestionRows, divider, statusBar];
    }
    if (this.queueText) {
      inputBlock.unshift(this.queueText);
    }
    const chatHeight = Math.max(1, height - topRows.length - 1 - inputBlock.length);
    const contentWithStatus = this.status
      ? `${this.chatContent}${this.chatContent && !this.chatContent.endsWith('\n') ? '\n' : ''}${this.status}`
      : this.chatContent;
    const contentChanged = contentWithStatus !== this.cachedContentWithStatus || width !== this.cachedWrappedWidth;
    const previousWrappedCount = this.cachedWrappedChat.length;
    const wrappedChat = this.getWrappedChat(contentWithStatus, width);
    const wrappedRowDelta = wrappedChat.length - previousWrappedCount;
    if (contentChanged && this.chatScrollOffset > 0 && wrappedRowDelta !== 0) {
      this.chatScrollOffset = Math.max(0, this.chatScrollOffset + wrappedRowDelta);
    }
    const chatViewportHeight = chatHeight;
    this.maxChatScrollOffset = Math.max(0, wrappedChat.length - chatViewportHeight);
    this.chatScrollOffset = Math.min(this.chatScrollOffset, this.maxChatScrollOffset);

    this.chatPageSize = Math.max(1, chatViewportHeight - 1);
    const visibleEnd = Math.max(0, wrappedChat.length - this.chatScrollOffset);
    const visibleStart = Math.max(0, visibleEnd - chatViewportHeight);
    this.chatViewport = {
      screenTop: topRows.length + 2,
      visibleStart,
      visibleEnd,
      width
    };
    const visibleChat = wrappedChat
      .slice(visibleStart, visibleEnd)
      .map((row, index) => this.highlightChatRow(row, visibleStart + index));
    const chatRows = [...visibleChat, ...new Array(chatHeight - visibleChat.length).fill('')];
    const screenRows = [...topRows, divider, ...chatRows, ...inputBlock].slice(0, height);
    while (screenRows.length < height) screenRows.push('');
    const fullRefresh = width !== this.renderedScreenWidth
      || height !== this.renderedScreenHeight
      || this.renderedScreenRows.length !== height;
    const screenUpdate = buildScreenUpdate(fullRefresh ? [] : this.renderedScreenRows, screenRows);
    let cursorState = '';
    if (this.activeInput && inputLayout) {
      const inputTop = topRows.length + 1 + chatHeight;
      const cursorColumn = Math.min(inputLayout.cursor.column, width) + 1;
      const cursorRow = inputTop + inputLayout.cursor.row + 2 + (this.queueText ? 1 : 0);
      cursorState = `\x1b[${cursorRow};${cursorColumn}H\x1b[?25h`;
    }

    if (!fullRefresh && !screenUpdate && cursorState === this.renderedCursorState) return;

    let frame = '\x1b[?25l';
    if (fullRefresh) frame += '\x1b[2J';
    frame += screenUpdate;
    frame += cursorState;
    stdout.write(frame);
    this.renderedScreenRows = screenRows;
    this.renderedScreenWidth = width;
    this.renderedScreenHeight = height;
    this.renderedCursorState = cursorState;
  }

  private finishInput(error?: Error): void {
    const activeInput = this.activeInput;
    if (!activeInput) {
      return;
    }

    const value = activeInput.graphemes.join('');
    this.activeInput = undefined;
    this.render();

    if (error) {
      activeInput.reject(error);
    } else {
      this.inputHistory.record(value);
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
    activeInput.historyNavigationActive = false;
    this.render();
  }

  private moveVertically(direction: -1 | 1): boolean {
    const activeInput = this.activeInput;
    if (!activeInput) {
      return false;
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
      return false;
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
    return true;
  }

  private navigateInputHistory(direction: -1 | 1): void {
    const activeInput = this.activeInput;
    if (!activeInput) {
      return;
    }

    const value = this.inputHistory.move(direction, activeInput.graphemes.join(''));
    if (value === undefined) {
      return;
    }

    activeInput.graphemes = splitGraphemes(value);
    activeInput.cursorIndex = activeInput.graphemes.length;
    activeInput.preferredColumn = undefined;
    activeInput.selectedCommandIndex = 0;
    activeInput.historyNavigationActive = this.inputHistory.isBrowsing();
    this.render();
  }

  private readonly handleSelectionKeypress = (value: string, key: readline.Key) => {
    const activeSelection = this.activeSelection;
    if (!activeSelection) {
      return;
    }
    if (isRealCtrlC(value, key) && this.copyChatSelection()) {
      return;
    }
    if (isRealCtrlC(value, key)) {
      this.finishSelection(new TerminalInputCancelledError());
      return;
    }

    if (key.name === 'escape') {
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
    if (isRealCtrlC(value, key) && this.copyChatSelection()) {
      return;
    }
    if (isRealCtrlC(value, key)) {
      this.finishInput(new TerminalInputCancelledError());
      return;
    }
    if (key.name === 'escape') {
      if (this.textSelection.active) {
        this.textSelection.clear();
        this.selectionLayout = undefined;
        this.render();
      } else if (this.onEscCallback) {
        this.onEscCallback();
      }
      return;
    }

    if (key.name === 'pageup' || key.name === 'pagedown') {
      this.scrollChat(key.name === 'pageup' ? this.chatPageSize : -this.chatPageSize);
      return;
    }

    if (key.shift && (key.name === 'up' || key.name === 'down')) {
      this.scrollChat(key.name === 'up' ? 3 : -3);
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

    if (isRealCtrlU(value, key)) {
      const inputText = activeInput.graphemes.join('');
      if (inputText) {
        void this.clipboardWriter.write(inputText).then(success => {
          if (!success || this.activeInput !== activeInput || activeInput.graphemes.join('') !== inputText) return;
          activeInput.graphemes = [];
          activeInput.cursorIndex = 0;
          activeInput.preferredColumn = undefined;
          activeInput.selectedCommandIndex = 0;
          activeInput.historyNavigationActive = false;
          this.render();
        });
      }
      return;
    }

    if (key.name === 'backspace') {
      if (activeInput.cursorIndex > 0) {
        activeInput.graphemes.splice(activeInput.cursorIndex - 1, 1);
        activeInput.cursorIndex -= 1;
        activeInput.preferredColumn = undefined;
        activeInput.selectedCommandIndex = 0;
        activeInput.historyNavigationActive = false;
        this.render();
      }
      return;
    }

    if (key.name === 'delete' || isRealCtrlD(value, key)) {
      if (isRealCtrlD(value, key) && activeInput.graphemes.length === 0) {
        this.finishInput(new TerminalInputCancelledError());
      } else if (activeInput.cursorIndex < activeInput.graphemes.length) {
        activeInput.graphemes.splice(activeInput.cursorIndex, 1);
        activeInput.preferredColumn = undefined;
        activeInput.selectedCommandIndex = 0;
        activeInput.historyNavigationActive = false;
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
      const direction = key.name === 'up' ? -1 : 1;
      if (!this.moveVertically(direction)) {
        this.navigateInputHistory(direction);
      }
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
      activeInput.historyNavigationActive = false;
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
