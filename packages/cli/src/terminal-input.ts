import { spawnSync } from "node:child_process";
import { stdin, stdout } from "node:process";
import readline from "node:readline";
import readlinePromises from "node:readline/promises";
import { PassThrough } from "node:stream";
import { performanceMonitor } from "@hajicli/core";
import type { ActivityFrame } from "./activity-indicator.js";
import { type AgentPanelItem, buildAgentPanelRows, formatAgentTokens } from "./agent-panel.js";
import { ClipboardWriter, InputHistoryBuffer } from "./input-history.js";
import {
  type TerminalMouseEvent,
  type TerminalProtocolEvent,
  TerminalProtocolParser,
} from "./terminal-protocol.js";
import { redactSensitiveCommand, sanitizeTerminalText } from "./terminal-sanitize.js";
import {
  type AnsiTextLayout,
  buildLabeledDivider,
  buildScreenUpdate,
  buildViewportScrollUpdate,
  cellAtColumn,
  DEFAULT_CHAT_PADDING,
  getSelectionAutoScrollRows,
  highlightAnsiColumns,
  layoutAnsiDocument,
  layoutInput,
  SEQ,
  splitGraphemes,
  terminalWidth,
  truncateAnsiText,
  truncateTailText,
  truncateText,
  type VisibleInputLayout,
  wrapAnsi,
  wrapAnsiWithState,
} from "./terminal-text.js";
import { type TextCell, TextSelectionModel } from "./text-selection.js";
import { fillUserMsgRowEol, themeEnter } from "./theme.js";
import { resolveTuiLayout, type TuiStatusDetail } from "./tui-layout.js";

export { type AgentPanelItem, buildAgentPanelRows, formatAgentElapsed } from "./agent-panel.js";
// 保持既有 dist/terminal-input.js 导出面的兼容：拆分后的符号在此统一转发。
export { ClipboardWriter, InputHistoryBuffer } from "./input-history.js";
export {
  buildScreenUpdate,
  buildViewportScrollUpdate,
  getSelectionAutoScrollRows,
  layoutAnsiDocument,
  layoutAnsiDocumentFallback,
  wrapAnsi,
  wrapAnsiWithState,
  wrapAnsiWithStateFallback,
} from "./terminal-text.js";

function enableWindowsVirtualTerminalInput(): boolean {
  if (process.platform !== "win32") {
    return true;
  }

  const script = [
    `Add-Type -Namespace Haji -Name ConsoleMode -MemberDefinition '${[
      '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern System.IntPtr GetStdHandle(int nStdHandle);',
      '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(System.IntPtr handle, out uint mode);',
      '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(System.IntPtr handle, uint mode);',
    ].join(" ")}'`,
    "$handle = [Haji.ConsoleMode]::GetStdHandle(-10)",
    "[uint32]$mode = 0",
    "if (-not [Haji.ConsoleMode]::GetConsoleMode($handle, [ref]$mode)) { exit 1 }",
    "$virtualTerminalInput = [uint32]0x0200",
    "if (-not [Haji.ConsoleMode]::SetConsoleMode($handle, ($mode -bor $virtualTerminalInput))) { exit 1 }",
  ].join("; ");

  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      stdio: ["inherit", "ignore", "ignore"],
      windowsHide: true,
    },
  );

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
  /** 掩码显示且不写入输入历史，适用于 API Key 等敏感内容。 */
  sensitive?: boolean;
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

interface ActiveInput {
  prompt: string;
  continuationPrompt: string;
  graphemes: string[];
  cursorIndex: number;
  sensitive: boolean;
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
  padding: number;
}

interface PendingMouseSelection {
  column: number;
  row: number;
  logicalRow: number;
}

interface TaskPanelItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  agent?: {
    id: string;
    role: string;
    status: "running" | "awaiting_verification" | "verified" | "rejected" | "failed" | "aborted";
    summary?: string;
  };
}

export class TerminalInputCancelledError extends Error {
  constructor() {
    super("Terminal input cancelled");
    this.name = "TerminalInputCancelledError";
  }
}

function isRealCtrlC(value: string, key: readline.Key): boolean {
  return value === "\x03" && key.ctrl === true && key.name === "c";
}

function isRealCtrlD(value: string, key: readline.Key): boolean {
  return value === "\x04" && key.ctrl === true && key.name === "d";
}

/** 斜杠命令可能切换到选择器，提交后应由主循环接管输入状态。 */
export function shouldRestartBackgroundInput(value: string): boolean {
  return !value.trim().startsWith("/");
}

function isRealCtrlU(value: string, key: readline.Key): boolean {
  return value === "\x15" && key.ctrl === true && key.name === "u";
}

function isRealCtrlT(value: string, key: readline.Key): boolean {
  return value === "\x14" && key.ctrl === true && key.name === "t";
}

export class TerminalUI {
  private readonly options: TerminalUIOptions;
  private readonly keyInput = new PassThrough();
  private readonly protocolParser = new TerminalProtocolParser();
  private readonly textSelection = new TextSelectionModel();
  private readonly inputHistory = new InputHistoryBuffer();
  private readonly clipboardWriter = new ClipboardWriter();
  private readonly interactive = Boolean(
    stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === "function",
  );
  private started = false;
  private chatContent = "";
  private chatScrollOffset = 0;
  private maxChatScrollOffset = 0;
  private chatPageSize = 1;
  private status = "";
  private activityFrame?: ActivityFrame;
  private permissionMode = "";
  private modelName = "";
  private providerName = "";
  private reasoningEffort = "";
  private sessionTitle = "";
  private currentPath = "";
  private usedTokens = 0;
  private maxTokens = 1000000;
  private taskPanelTitle = "";
  private taskPanelItems: TaskPanelItem[] = [];
  private taskPanelExpanded = false;
  private agentPanelItems: AgentPanelItem[] = [];
  private agentPanelTimer: NodeJS.Timeout | null = null;
  private selectionAutoScrollTimer: NodeJS.Timeout | null = null;
  private pendingWheelRows = 0;
  private activeInput?: ActiveInput;
  private activeSelection?: ActiveSelection;
  private chatViewport?: ChatViewport;
  private selectionLayout?: AnsiTextLayout;
  private pendingMouseSelection?: PendingMouseSelection;
  private selectionPointer?: { column: number; row: number };
  private selectionLayoutContent = "";
  private selectionLayoutWidth = 0;
  private originalRawMode = false;
  private onShiftTabCallback?: () => void;
  private onEscCallback?: () => void;
  private queueText = "";
  private cachedContentWithStatus = "";
  private cachedWrappedWidth = 0;
  private cachedWrappedChat: string[] = [];
  private stableWrapPrefix = "";
  private stableWrapPrefixWidth = 0;
  private stableWrapPrefixRows: string[] = [];
  private stableWrapPrefixStyle = "";
  private renderScheduled = false;
  private scheduledRenderDelayMs = Number.POSITIVE_INFINITY;
  private streamRenderTimer: NodeJS.Timeout | null = null;
  private protocolFlushTimer: NodeJS.Timeout | null = null;
  private startupHeaderVisible = true;
  /** Logo 下方附加的启动信息行（provider/model/effort + 引导提示）。 */
  private headerInfo: string[] = [];
  private renderedScreenRows: string[] = [];
  private renderedScreenWidth = 0;
  private renderedScreenHeight = 0;
  private renderedCursorState = "";
  private renderedChatVisibleStart = 0;
  private renderedChatRegionStart = 0;
  private renderedChatRegionHeight = 0;
  private stdoutBackpressured = false;
  private renderPendingAfterDrain = false;

  constructor(options: TerminalUIOptions) {
    this.options = options;
  }

  setPermissionMode(mode: string): void {
    this.permissionMode = mode;
    this.scheduleRender();
  }

  setModelInfo(model: string, effort?: string, provider?: string): void {
    this.modelName = sanitizeTerminalText(model).replace(/\s*\n\s*/g, " ");
    this.reasoningEffort = sanitizeTerminalText(effort || "").replace(/\s*\n\s*/g, " ");
    this.providerName = sanitizeTerminalText(provider || "").replace(/\s*\n\s*/g, " ");
    this.scheduleRender();
  }

  setSessionTitle(title: string): void {
    this.sessionTitle = sanitizeTerminalText(title)
      .replace(/\s*\n\s*/g, " ")
      .trim();
    this.scheduleRender();
  }

  /** 设置状态栏显示的当前工作目录（模型名称右侧）。 */
  setCurrentPath(path: string): void {
    this.currentPath = sanitizeTerminalText(path).replace(/\s*\n\s*/g, " ");
    this.scheduleRender();
  }

  /** 设置 Logo 下方的启动信息行（provider/model/effort + 引导提示等）。 */
  setHeaderInfo(lines: string[]): void {
    this.headerInfo = lines;
    this.scheduleRender();
  }

  setContextUsage(usedTokens: number, maxTokens = 1000000): void {
    this.usedTokens = Math.max(0, usedTokens);
    this.maxTokens = Math.max(1, maxTokens);
    this.scheduleRender();
  }

  setTaskPlan(
    plan: { title: string; tasks: TaskPanelItem[]; completedTasks?: TaskPanelItem[] } | null,
  ): void {
    this.taskPanelTitle = sanitizeTerminalText(plan?.title || "").replace(/\s*\n\s*/g, " ");
    this.taskPanelItems = plan
      ? [...(plan.completedTasks || []), ...plan.tasks].map((task) => ({
          ...task,
          content: sanitizeTerminalText(task.content).replace(/\s*\n\s*/g, " "),
          agent: task.agent
            ? {
                ...task.agent,
                role: sanitizeTerminalText(task.agent.role).replace(/\s*\n\s*/g, " "),
                summary: task.agent.summary
                  ? sanitizeTerminalText(task.agent.summary).replace(/\s*\n\s*/g, " ")
                  : undefined,
              }
            : undefined,
        }))
      : [];
    if (!plan || this.taskPanelItems.length <= 5) this.taskPanelExpanded = false;
    this.scheduleRender();
  }

  setAgentPanel(items: AgentPanelItem[]): void {
    this.agentPanelItems = items.slice(0, 20).map((item) => ({
      ...item,
      id: sanitizeTerminalText(item.id).replace(/\s*\n\s*/g, " "),
      role: sanitizeTerminalText(item.role).replace(/\s*\n\s*/g, " "),
      model: item.model ? sanitizeTerminalText(item.model).replace(/\s*\n\s*/g, " ") : undefined,
      provider: item.provider
        ? sanitizeTerminalText(item.provider).replace(/\s*\n\s*/g, " ")
        : undefined,
      currentTool: item.currentTool
        ? sanitizeTerminalText(item.currentTool).replace(/\s*\n\s*/g, " ")
        : undefined,
      preview: item.preview
        ? sanitizeTerminalText(item.preview).replace(/\s*\n\s*/g, " ")
        : undefined,
    }));
    const hasRunning = items.some((item) => item.status === "running");
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
    this.cachedContentWithStatus = "";
    this.cachedWrappedWidth = 0;
    this.scheduleRender();
  }

  onShiftTab(callback: () => void): void {
    this.onShiftTabCallback = callback;
  }

  onEsc(callback?: () => void): void {
    this.onEscCallback = callback;
  }

  setQueue(items: string[]): void {
    if (items.length === 0) {
      this.queueText = "";
    } else {
      const formatted = items
        .map((msg, idx) => {
          const safeMessage = redactSensitiveCommand(sanitizeTerminalText(msg));
          return `[${idx + 1}] ${safeMessage.replace(/\s*\n\s*/g, " ")}`;
        })
        .join("  ");
      // 保留原始队列内容，实际截断在 render 时按最新终端宽度计算。
      this.queueText = ` ${SEQ.boldYellow}⏳ 待处理队列 (${items.length} 条):${SEQ.reset} ${SEQ.cyan}${formatted}${SEQ.reset}`;
    }
    this.scheduleRender();
  }

  /** 当前聊天内容的真实可用宽度，供 Markdown 代码块和表格共享。 */
  getContentWidth(): number {
    const layout = resolveTuiLayout(
      Math.max(1, stdout.columns || 80),
      Math.max(1, stdout.rows || 24),
    );
    return Math.max(1, layout.safeWidth - layout.chatPadding * 2);
  }

  isInputActive(): boolean {
    return Boolean(this.activeInput);
  }

  cancelInput(): string | undefined {
    if (!this.activeInput) return undefined;
    const draft = this.activeInput.graphemes.join("");
    this.finishInput(new TerminalInputCancelledError());
    return draft;
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
    this.renderedCursorState = "";
    this.renderedChatVisibleStart = 0;
    this.renderedChatRegionStart = 0;
    this.renderedChatRegionHeight = 0;
    this.pendingWheelRows = 0;

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
    stdout.write(
      "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1007l\x1b[?1049h" +
        themeEnter() +
        "\x1b[2J\x1b[H\x1b[?25l\x1b[?1002h\x1b[?1006h\x1b[?2004h",
    );
    stdout.on("resize", this.handleResize);
    stdout.on("drain", this.handleStdoutDrain);
    stdin.on("data", this.handleMouseData);
    this.keyInput.on("keypress", this.dispatchKeypress);
    process.on("exit", this.handleProcessExit);
    this.scheduleRender(true);
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
      stdout.off("resize", this.handleResize);
      stdout.off("drain", this.handleStdoutDrain);
      stdin.off("data", this.handleMouseData);
      this.keyInput.off("keypress", this.dispatchKeypress);
      stdin.setRawMode(this.originalRawMode);
      stdin.pause();
      process.off("exit", this.handleProcessExit);
      stdout.write(
        "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1007l\x1b[?2004l\x1b[?25h\x1b[0m\x1b[2J\x1b[?1049l",
      );
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
    this.pendingWheelRows = 0;
    this.activityFrame = undefined;
    this.stopSelectionAutoScroll();
    this.protocolParser.reset();
    this.clipboardWriter.close();
    this.textSelection.clear();
    this.selectionLayout = undefined;
    this.pendingMouseSelection = undefined;
    this.selectionPointer = undefined;
    this.renderScheduled = false;
    this.scheduledRenderDelayMs = Number.POSITIVE_INFINITY;
    this.stdoutBackpressured = false;
    this.renderPendingAfterDrain = false;
    this.started = false;
  }

  clearChat(): void {
    this.pendingWheelRows = 0;
    this.chatContent = "";
    this.chatScrollOffset = 0;
    this.textSelection.clear();
    this.stopSelectionAutoScroll();
    this.selectionLayout = undefined;
    this.pendingMouseSelection = undefined;
    this.selectionPointer = undefined;
    this.chatViewport = undefined;
    this.cachedContentWithStatus = "";
    this.cachedWrappedChat = [];
    this.setStableWrapPrefix("");
    this.scheduleRender(true);
  }

  /**
   * 获取缓存或平滑增量计算的软换行聊天行。
   */
  private setStableWrapPrefix(value: string): void {
    const prefix = value.endsWith("\n") ? value : "";
    if (prefix === this.stableWrapPrefix) {
      return;
    }
    this.stableWrapPrefix = prefix;
    this.stableWrapPrefixWidth = 0;
    this.stableWrapPrefixRows = [];
    this.stableWrapPrefixStyle = "";
  }

  private getWrappedChat(contentWithStatus: string, width: number): string[] {
    if (!contentWithStatus) {
      this.cachedContentWithStatus = "";
      this.cachedWrappedChat = [];
      this.cachedWrappedWidth = width;
      return [];
    }

    if (contentWithStatus === this.cachedContentWithStatus && width === this.cachedWrappedWidth) {
      return this.cachedWrappedChat;
    }

    if (this.stableWrapPrefix && contentWithStatus.startsWith(this.stableWrapPrefix)) {
      if (width !== this.stableWrapPrefixWidth) {
        const wrappedPrefix = performanceMonitor.measureSync("terminal.wrap.prefix", () =>
          wrapAnsiWithState(this.stableWrapPrefix, width),
        );
        this.stableWrapPrefixRows = wrappedPrefix.rows.slice(0, -1);
        this.stableWrapPrefixStyle = wrappedPrefix.activeStyle;
        this.stableWrapPrefixWidth = width;
      }
      const wrappedTail = performanceMonitor.measureSync(
        "terminal.wrap.tail",
        () =>
          wrapAnsiWithState(
            contentWithStatus.slice(this.stableWrapPrefix.length),
            width,
            this.stableWrapPrefixStyle,
          ).rows,
      );
      this.cachedWrappedChat = [...this.stableWrapPrefixRows, ...wrappedTail];
      this.cachedContentWithStatus = contentWithStatus;
      this.cachedWrappedWidth = width;
      return this.cachedWrappedChat;
    }

    if (contentWithStatus === this.chatContent) {
      const layout = performanceMonitor.measureSync("terminal.layout.full", () =>
        layoutAnsiDocument(contentWithStatus, width),
      );
      this.selectionLayout = layout;
      this.selectionLayoutContent = this.chatContent;
      this.selectionLayoutWidth = width;
      this.cachedWrappedChat = layout.rows.map((row) => row.ansi);
    } else {
      this.cachedWrappedChat = performanceMonitor.measureSync("terminal.wrap.full", () =>
        wrapAnsi(contentWithStatus, width),
      );
    }
    this.cachedContentWithStatus = contentWithStatus;
    this.cachedWrappedWidth = width;
    return this.cachedWrappedChat;
  }

  /**
   * 统一合并流式与交互重绘。交互帧保留较低延迟，同时避免鼠标拖动、
   * 连续按键等高频事件直接触发无上限的终端写入。
   */
  private scheduleRender(interactive = false): void {
    if (this.stdoutBackpressured) {
      this.renderPendingAfterDrain = true;
      return;
    }
    const delayMs = interactive ? 8 : 16;
    if (this.renderScheduled && delayMs >= this.scheduledRenderDelayMs) return;
    this.renderScheduled = true;
    if (this.streamRenderTimer) {
      clearTimeout(this.streamRenderTimer);
    }
    this.scheduledRenderDelayMs = delayMs;
    this.streamRenderTimer = setTimeout(() => {
      this.renderScheduled = false;
      this.scheduledRenderDelayMs = Number.POSITIVE_INFINITY;
      this.streamRenderTimer = null;
      this.render();
    }, delayMs);
  }

  private readonly handleStdoutDrain = () => {
    if (!this.stdoutBackpressured) return;
    this.stdoutBackpressured = false;
    if (!this.renderPendingAfterDrain) return;
    this.renderPendingAfterDrain = false;
    this.scheduleRender(true);
  };

  writeChat(value: string): void {
    if (!this.interactive) {
      stdout.write(value);
      return;
    }

    this.chatContent += value;
    if (this.chatContent.length > 200_000) {
      this.chatContent = this.chatContent.slice(-160_000);
      this.cachedContentWithStatus = "";
      this.setStableWrapPrefix("");
    }

    this.scheduleRender();
  }

  writeLine(value: string = ""): void {
    this.writeChat(`${value}\n`);
  }
  /**
   * 写入恰好一个空行。
   * 当前内容未以换行结尾时先结束当前行（正文经 updateChatFrom 写入时不以换行结尾，
   * 直接 writeLine 只会补齐行尾而不会产生空行）。
   */
  writeBlankLine(): void {
    if (!this.interactive) {
      stdout.write("\n");
      return;
    }
    if (this.chatContent && !this.chatContent.endsWith("\n")) {
      this.writeLine();
    }
    this.writeLine();
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
    this.stopSelectionAutoScroll();
    this.pendingMouseSelection = undefined;
    this.selectionPointer = undefined;
    this.selectionLayout = undefined;
    this.selectionLayoutContent = "";
    this.selectionLayoutWidth = 0;
    this.cachedContentWithStatus = "";
    this.cachedWrappedWidth = 0;
    this.cachedWrappedChat = [];
    // 整体替换多见于 /resume。首次布局直接建立可复用的文档索引，避免第一次拖选再扫描全文。
    this.setStableWrapPrefix("");
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
      this.cachedContentWithStatus = "";
      this.setStableWrapPrefix("");
    }

    this.scheduleRender();
  }

  setStatus(value: string = "", interactive = false): void {
    this.status = value;
    this.scheduleRender(interactive);
  }

  setActivity(frame?: ActivityFrame): void {
    this.activityFrame = frame;
    this.scheduleRender();
  }

  async readInput(options: ReadInputOptions = {}): Promise<string> {
    const prompt = options.prompt ?? this.options.inputPrompt;
    if (!this.interactive) {
      if (options.sensitive && (stdin.isTTY || stdout.isTTY)) {
        throw new Error("敏感输入需要完整的交互式终端；请取消输入或输出重定向后重试");
      }
      const questionInterface = readlinePromises.createInterface({ input: stdin, output: stdout });
      try {
        return await questionInterface.question(prompt);
      } finally {
        questionInterface.close();
      }
    }

    if (this.activeInput || this.activeSelection) {
      throw new Error("已有输入请求正在等待处理");
    }

    const safeInitialValue = sanitizeTerminalText(options.initialValue ?? "");
    const initialGraphemes = safeInitialValue ? splitGraphemes(safeInitialValue) : [];
    if (!options.sensitive) this.inputHistory.begin(safeInitialValue);
    return new Promise<string>((resolve, reject) => {
      this.activeInput = {
        prompt,
        continuationPrompt: options.continuationPrompt ?? this.options.continuationPrompt ?? "  ",
        graphemes: initialGraphemes,
        cursorIndex: initialGraphemes.length,
        sensitive: Boolean(options.sensitive),
        slashCommands: options.slashCommands ?? [],
        selectedCommandIndex: 0,
        historyNavigationActive: false,
        resolve,
        reject,
      };

      this.scheduleRender(true);
    });
  }

  async readSelection(options: TerminalSelectionOptions): Promise<TerminalSelectionResult> {
    if (options.items.length === 0) {
      throw new Error("选择器至少需要一个选项");
    }
    if (options.secondary && options.secondary.items.length === 0) {
      throw new Error("选择器的次级选项不能为空");
    }

    const selectedIndex = Math.max(
      0,
      options.items.findIndex((item) => item.value === options.selectedValue),
    );
    const secondaryIndex = options.secondary
      ? Math.max(
          0,
          options.secondary.items.findIndex(
            (item) => item.value === options.secondary?.selectedValue,
          ),
        )
      : 0;

    if (!this.interactive) {
      return {
        value: options.items[selectedIndex].value,
        secondaryValue: options.secondary?.items[secondaryIndex].value,
      };
    }
    if (this.activeInput || this.activeSelection) {
      throw new Error("已有输入请求正在等待处理");
    }

    return new Promise<TerminalSelectionResult>((resolve, reject) => {
      this.activeSelection = {
        options,
        selectedIndex,
        secondaryIndex,
        resolve,
        reject,
      };

      this.scheduleRender(true);
    });
  }

  private readonly handleResize = () => {
    this.cachedContentWithStatus = "";
    this.cachedWrappedWidth = 0;
    this.stableWrapPrefixWidth = 0;
    this.selectionLayout = undefined;
    this.pendingMouseSelection = undefined;
    this.stopSelectionAutoScroll();
    this.scheduleRender(true);
  };

  private getSelectionLayout(): AnsiTextLayout {
    const width = this.chatViewport?.width ?? Math.max(20, (stdout.columns || 80) - 1);
    if (
      !this.selectionLayout ||
      this.selectionLayoutContent !== this.chatContent ||
      this.selectionLayoutWidth !== width
    ) {
      this.selectionLayout = performanceMonitor.measureSync("terminal.layout.selection", () =>
        layoutAnsiDocument(this.chatContent, width),
      );
      this.selectionLayoutContent = this.chatContent;
      this.selectionLayoutWidth = width;
    }
    return this.selectionLayout;
  }

  private getChatCellFromMouse(
    column: number,
    row: number,
    clampToText = false,
  ): TextCell | undefined {
    const viewport = this.chatViewport;
    if (!viewport || viewport.visibleEnd <= viewport.visibleStart) {
      return undefined;
    }

    const visibleRowCount = viewport.visibleEnd - viewport.visibleStart;
    const screenRowOffset = Math.max(0, Math.min(visibleRowCount - 1, row - viewport.screenTop));
    const logicalRow = viewport.visibleStart + screenRowOffset;
    return this.getChatCellAtLogicalRow(column, logicalRow, clampToText);
  }

  private getChatCellAtLogicalRow(
    column: number,
    logicalRow: number,
    clampToText = false,
  ): TextCell | undefined {
    const layout = this.getSelectionLayout();
    const layoutRow = layout.rows[logicalRow];
    if (!layoutRow) return undefined;
    // chat 区有响应式左内边距：把 1-based 物理列还原成内容列。
    // cellAtColumn 内部会再做 column-1，故这里直接减 padding。
    return cellAtColumn(
      layoutRow,
      column - (this.chatViewport?.padding ?? DEFAULT_CHAT_PADDING),
      clampToText,
    );
  }

  private getLogicalChatRow(row: number): number | undefined {
    const viewport = this.chatViewport;
    if (
      !viewport ||
      viewport.visibleEnd <= viewport.visibleStart ||
      !this.isMouseInChatViewport(row)
    ) {
      return undefined;
    }
    return viewport.visibleStart + (row - viewport.screenTop);
  }

  private isMouseInChatViewport(row: number): boolean {
    const viewport = this.chatViewport;
    return Boolean(
      viewport &&
        row >= viewport.screenTop &&
        row < viewport.screenTop + (viewport.visibleEnd - viewport.visibleStart),
    );
  }

  private highlightChatRow(value: string, logicalRow: number): string {
    const selection = this.textSelection.range();
    if (!selection) {
      return value;
    }
    const layoutRow = this.getSelectionLayout().rows[logicalRow];
    if (
      !layoutRow ||
      selection.endOffset <= layoutRow.startOffset ||
      selection.startOffset >= layoutRow.endOffset
    ) {
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

    void this.clipboardWriter.write(text).then((success) => {
      if (!success || this.getSelectedChatText() !== text) return;
      this.textSelection.clear();
      this.selectionLayout = undefined;
      this.scheduleRender(true);
    });
    return true;
  }

  private dispatchProtocolEvent(event: TerminalProtocolEvent): void {
    if (event.type === "keyboard") {
      this.keyInput.write(event.data);
      return;
    }
    if (event.type === "paste") {
      if (event.text) {
        this.insert(event.text);
      }
      return;
    }
    this.handleMouseEvent(event);
  }

  private stopSelectionAutoScroll(): void {
    if (this.selectionAutoScrollTimer) {
      clearInterval(this.selectionAutoScrollTimer);
      this.selectionAutoScrollTimer = null;
    }
  }

  private startSelectionAutoScroll(): void {
    if (this.selectionAutoScrollTimer) return;
    this.selectionAutoScrollTimer = setInterval(() => {
      const pointer = this.selectionPointer;
      const viewport = this.chatViewport;
      if (!pointer || !this.textSelection.dragging || !viewport) {
        this.stopSelectionAutoScroll();
        return;
      }

      const visibleRowCount = viewport.visibleEnd - viewport.visibleStart;
      const rows = getSelectionAutoScrollRows(pointer.row, viewport.screenTop, visibleRowCount);
      if (rows === 0) {
        this.stopSelectionAutoScroll();
        return;
      }

      const previousOffset = this.chatScrollOffset;
      this.scrollChat(rows);
      if (previousOffset === this.chatScrollOffset) {
        this.stopSelectionAutoScroll();
        return;
      }

      const cell = this.getChatCellFromMouse(pointer.column, pointer.row, true);
      if (cell) this.textSelection.update(cell);
      this.scheduleRender();
    }, 50);
    this.selectionAutoScrollTimer.unref?.();
  }

  private updateMouseSelection(column: number, row: number): void {
    this.selectionPointer = { column, row };
    const viewport = this.chatViewport;
    if (viewport) {
      const visibleRowCount = viewport.visibleEnd - viewport.visibleStart;
      if (getSelectionAutoScrollRows(row, viewport.screenTop, visibleRowCount) !== 0) {
        this.startSelectionAutoScroll();
      } else {
        this.stopSelectionAutoScroll();
      }
    }
    const cell = this.getChatCellFromMouse(column, row, true);
    if (cell) this.textSelection.update(cell);
    this.scheduleRender();
  }

  private queueWheelScroll(rows: number): void {
    const normalizedRows = Math.trunc(rows);
    if (this.maxChatScrollOffset === 0 || normalizedRows === 0) return;

    // 同一帧内合并同方向滚轮；反向输入立即覆盖，避免拖尾和方向迟滞。
    if (
      this.pendingWheelRows !== 0 &&
      Math.sign(this.pendingWheelRows) !== Math.sign(normalizedRows)
    ) {
      this.pendingWheelRows = normalizedRows;
    } else {
      this.pendingWheelRows += normalizedRows;
    }
    this.pendingWheelRows = Math.max(-48, Math.min(48, this.pendingWheelRows));
    this.scheduleRender(true);
  }

  private handleMouseEvent(event: TerminalMouseEvent): void {
    if (event.action === "wheel") {
      this.pendingMouseSelection = undefined;
      this.queueWheelScroll(event.wheelRows ?? 0);
      if (this.textSelection.dragging) {
        // 端点随合并后的滚动帧更新，避免每个滚轮报文都触发一次选区布局。
        this.selectionPointer = { column: event.column, row: event.row };
      }
      return;
    }

    const isLeftButton = (event.button & 3) === 0;
    if (event.action === "down" && isLeftButton) {
      this.stopSelectionAutoScroll();
      this.selectionPointer = undefined;
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
        logicalRow,
      };
      this.textSelection.clear();
      this.selectionLayout = undefined;
      this.scheduleRender();
      return;
    }

    if (event.action === "move" && isLeftButton && this.pendingMouseSelection) {
      const pending = this.pendingMouseSelection;
      if (pending.column === event.column && pending.row === event.row) {
        return;
      }
      this.pendingMouseSelection = undefined;
      const anchor = this.getChatCellAtLogicalRow(pending.column, pending.logicalRow);
      if (anchor) {
        this.textSelection.begin(anchor);
        this.updateMouseSelection(event.column, event.row);
      }
      return;
    }

    if (event.action === "move" && isLeftButton && this.textSelection.dragging) {
      this.updateMouseSelection(event.column, event.row);
      return;
    }

    if (event.action === "up" && isLeftButton && this.pendingMouseSelection) {
      this.pendingMouseSelection = undefined;
      this.selectionPointer = undefined;
      this.selectionLayout = undefined;
      return;
    }

    if (event.action === "up" && isLeftButton && this.textSelection.dragging) {
      const cell = this.getChatCellFromMouse(event.column, event.row, true);
      this.stopSelectionAutoScroll();
      this.selectionPointer = undefined;
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
    if (this.toggleTaskPanel(value, key)) return;

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
    if ((key.name === "tab" && key.shift) || key.name === "backtab" || value === "\x1b[Z") {
      if (this.onShiftTabCallback) {
        this.onShiftTabCallback();
      }
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      this.scrollChat(key.name === "pageup" ? this.chatPageSize : -this.chatPageSize);
      return;
    }
    if (key.name === "up" || key.name === "down") {
      this.scrollChat(key.name === "up" ? 1 : -1);
      return;
    }
    if (key.name === "home") {
      this.scrollChat(this.maxChatScrollOffset);
      return;
    }
    if (key.name === "end") {
      this.scrollChat(-this.chatScrollOffset);
      return;
    }
    if (this.activeInput || this.activeSelection) {
      return;
    }
  };

  private readonly handleProcessExit = () => {
    stdin.setRawMode(this.originalRawMode);
    stdout.write(
      "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1007l\x1b[?2004l\x1b[?25h\x1b[0m\x1b[2J\x1b[?1049l",
    );
  };

  private getInputLayout(width: number, maxRows: number): VisibleInputLayout {
    const activeInput = this.activeInput;
    const prompt = activeInput?.prompt ?? this.options.inputPrompt;
    const continuationPrompt =
      activeInput?.continuationPrompt ?? this.options.continuationPrompt ?? "  ";
    const rawInput = activeInput?.graphemes.join("") ?? "";
    const inlineSecretIndexes = new Set<number>();
    const providerSetPrefix = /^(\s*\/provider\s+set\s+\S+)/iu.exec(rawInput)?.[1];
    if (providerSetPrefix !== undefined) {
      const rest = rawInput.slice(providerSetPrefix.length);
      for (const match of rest.matchAll(/\S+/gu)) {
        if (["--project", "--global", "--user"].includes(match[0].toLowerCase())) continue;
        const start = splitGraphemes(
          rawInput.slice(0, providerSetPrefix.length + (match.index ?? 0)),
        ).length;
        const end = start + splitGraphemes(match[0]).length;
        for (let index = start; index < end; index += 1) inlineSecretIndexes.add(index);
      }
    }
    const graphemes = activeInput?.sensitive
      ? activeInput.graphemes.map((grapheme) => (grapheme === "\n" ? grapheme : "•"))
      : (activeInput?.graphemes.map((grapheme, index) =>
          inlineSecretIndexes.has(index) && grapheme !== "\n" ? "•" : grapheme,
        ) ?? []);
    const cursorIndex = activeInput?.cursorIndex ?? 0;
    const layout = layoutInput(prompt, graphemes, width, continuationPrompt);
    const cursor = layout.positions[cursorIndex];

    if (layout.rows.length <= maxRows) {
      return { rows: layout.rows, cursor };
    }

    const firstVisibleRow = Math.min(
      Math.max(0, cursor.row - maxRows + 1),
      layout.rows.length - maxRows,
    );

    return {
      rows: layout.rows.slice(firstVisibleRow, firstVisibleRow + maxRows),
      cursor: { row: cursor.row - firstVisibleRow, column: cursor.column },
    };
  }

  private getCommandSuggestions(activeInput: ActiveInput): readonly SlashCommand[] {
    if (activeInput.sensitive || activeInput.historyNavigationActive) {
      return [];
    }
    const value = activeInput.graphemes.join("");
    if (!/^\/[^\s]*$/u.test(value)) {
      return [];
    }

    const prefix = value.toLowerCase();
    return activeInput.slashCommands.filter((item) =>
      item.command.toLowerCase().startsWith(prefix),
    );
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
      suggestions.length - 1,
    );

    return suggestions.map((item, index) => {
      const label = truncateText(`${item.command}  ${item.description}`, Math.max(1, width - 2));
      return index === activeInput.selectedCommandIndex
        ? `${SEQ.boldAccent}› ${label}${SEQ.reset}`
        : `${SEQ.muted}  ${label}${SEQ.reset}`;
    });
  }

  private getSelectionRows(width: number, maxRows: number): string[] {
    const activeSelection = this.activeSelection;
    if (!activeSelection || maxRows <= 0) {
      return [];
    }

    const { options } = activeSelection;
    const navigation = options.secondary
      ? "↑↓ 模型 · ←→ 强度 · Enter 确认"
      : "↑↓ 选择 · Enter 确认";
    const rows = [
      `${SEQ.bold}${truncateText(options.title, width)}${SEQ.reset}  ${SEQ.muted}${truncateText(navigation, Math.max(1, width - terminalWidth(options.title) - 2))}${SEQ.reset}`,
    ];

    if (options.secondary) {
      const selectedSecondary = options.secondary.items[activeSelection.secondaryIndex];
      const effortLabels = options.secondary.items.map((item, index) =>
        index === activeSelection.secondaryIndex ? `‹${item.label}›` : item.label,
      );
      const fullSecondaryText = `${options.secondary.label}  ${effortLabels.join("  ")}`;
      if (terminalWidth(fullSecondaryText) <= width) {
        const styledEfforts = options.secondary.items.map((item, index) =>
          index === activeSelection.secondaryIndex
            ? `${SEQ.boldAccent}‹${item.label}›${SEQ.reset}`
            : `${SEQ.muted}${item.label}${SEQ.reset}`,
        );
        rows.push(
          `${SEQ.muted}${options.secondary.label}${SEQ.reset}  ${styledEfforts.join("  ")}`,
        );
      } else {
        const secondaryText = `${options.secondary.label}  ‹ ${selectedSecondary.label} ›`;
        rows.push(`${SEQ.boldAccent}${truncateText(secondaryText, width)}${SEQ.reset}`);
      }
    }

    const availableItemRows = Math.max(1, maxRows - rows.length);
    const firstVisibleIndex = Math.min(
      Math.max(0, activeSelection.selectedIndex - availableItemRows + 1),
      Math.max(0, options.items.length - availableItemRows),
    );
    const visibleItems = options.items.slice(
      firstVisibleIndex,
      firstVisibleIndex + availableItemRows,
    );

    for (let offset = 0; offset < visibleItems.length; offset += 1) {
      const itemIndex = firstVisibleIndex + offset;
      const item = visibleItems[offset];
      const label = truncateText(
        `${item.label}${item.description ? `  ${item.description}` : ""}`,
        Math.max(1, width - 2),
      );
      rows.push(
        itemIndex === activeSelection.selectedIndex
          ? `${SEQ.boldAccent}› ${label}${SEQ.reset}`
          : `${SEQ.muted}  ${label}${SEQ.reset}`,
      );
    }

    return rows.slice(0, maxRows);
  }

  private scrollChat(rows: number, render = true, preservePendingWheel = false): number {
    if (!preservePendingWheel) this.pendingWheelRows = 0;
    if (rows === 0 || this.maxChatScrollOffset === 0) {
      return 0;
    }

    const previousOffset = this.chatScrollOffset;
    const nextOffset = Math.max(
      0,
      Math.min(this.maxChatScrollOffset, this.chatScrollOffset + rows),
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
      if (render) this.scheduleRender();
    }
    return this.chatScrollOffset - previousOffset;
  }

  private buildStatusBar(width: number, detail: TuiStatusDetail = "full"): string {
    const modeLabels: Record<string, string> = {
      plan: "PLAN",
      default: "DEFAULT",
      "accept-edit": "EDIT",
      auto: "AUTO",
      "bypass-permissions": "BYPASS",
    };
    const modeLabel = modeLabels[this.permissionMode] || this.permissionMode.toUpperCase();
    const permText = this.permissionMode ? `[${modeLabel}]` : "";
    const permColorMap: Record<string, string> = {
      plan: SEQ.cyan,
      default: SEQ.green,
      "accept-edit": SEQ.yellow,
      auto: SEQ.accent,
      "bypass-permissions": SEQ.boldRed,
    };
    const permColor = permText ? permColorMap[this.permissionMode] || SEQ.muted : "";
    const permAnsi = permText ? `${permColor}${permText}${SEQ.reset}` : "";

    let modelStr = "";
    if (detail !== "minimal" && this.modelName) {
      modelStr = [
        detail === "full" ? this.providerName : "",
        this.modelName,
        this.reasoningEffort ? this.reasoningEffort.toUpperCase() : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
    const modelLimit =
      detail === "full"
        ? Math.max(8, Math.min(36, Math.floor(width * 0.38)))
        : Math.max(6, Math.min(22, Math.floor(width * 0.36)));
    const modelAnsi = modelStr
      ? `${SEQ.bold}${SEQ.cyan}${truncateText(modelStr, modelLimit)}${SEQ.reset}`
      : "";

    const baseLeftAnsi = [permAnsi, modelAnsi].filter(Boolean).join("  ");
    const baseLeftWidth = terminalWidth(baseLeftAnsi);

    const used = this.usedTokens;
    const max = this.maxTokens;
    const ratio = Math.min(1, Math.max(0, used / max));

    let colorCode = SEQ.cyan;
    if (ratio >= 0.85) {
      colorCode = SEQ.boldRed;
    } else if (ratio >= 0.6) {
      colorCode = SEQ.yellow;
    }

    const percentText = `${Math.round(ratio * 100)}%`;
    const numText = `${formatAgentTokens(used)}/${formatAgentTokens(max)}`;
    const ctxLabel = "ctx";
    const barCapacity = detail === "full" && width >= 72 ? 8 : 0;

    const filledCount = Math.min(barCapacity, Math.max(0, Math.round(ratio * barCapacity)));
    const emptyCount = Math.max(0, barCapacity - filledCount);
    const barStr = barCapacity > 0 ? `${"█".repeat(filledCount)}${"░".repeat(emptyCount)} ` : "";
    const valueText = detail === "full" ? numText : percentText;
    const rightAnsi = `${colorCode}${barStr}${SEQ.reset}${SEQ.muted}${ctxLabel}${SEQ.reset} ${colorCode}${valueText}${SEQ.reset}`;
    const rightWidth = terminalWidth(rightAnsi);

    let pathAnsi = "";
    if (detail === "full" && this.currentPath) {
      const pathMaxWidth = Math.max(0, width - baseLeftWidth - rightWidth - 4);
      if (pathMaxWidth >= 3) {
        pathAnsi = `${SEQ.muted}${truncateTailText(this.currentPath, pathMaxWidth)}${SEQ.reset}`;
      }
    }
    const fullLeftAnsi = [baseLeftAnsi, pathAnsi].filter(Boolean).join("  ");
    const fullLeftWidth = terminalWidth(fullLeftAnsi);

    if (fullLeftWidth + rightWidth + 1 <= width) {
      const padding = " ".repeat(width - fullLeftWidth - rightWidth);
      return `${fullLeftAnsi}${padding}${rightAnsi}`;
    }

    if (rightWidth >= width) return truncateAnsiText(rightAnsi, width);
    const availableLeft = Math.max(0, width - rightWidth - 1);
    const fittedLeft = truncateAnsiText(fullLeftAnsi, availableLeft);
    const padding = " ".repeat(Math.max(1, width - terminalWidth(fittedLeft) - rightWidth));
    return `${fittedLeft}${padding}${rightAnsi}`;
  }

  private buildActivityRow(width: number): string {
    const frame = this.activityFrame;
    if (!frame || width <= 0) return "";

    const color =
      frame.tone === "stalled"
        ? SEQ.boldYellow
        : frame.tone === "waiting"
          ? SEQ.yellow
          : frame.phase === "responding"
            ? SEQ.green
            : frame.phase === "permission"
              ? SEQ.yellow
              : SEQ.cyan;
    const toneText =
      frame.tone === "stalled"
        ? "较久无进展"
        : frame.tone === "waiting" && frame.phase !== "permission"
          ? "等待新事件"
          : "";
    const detail = [toneText, frame.idleText, frame.detail].filter(Boolean).join(" · ");
    const primary = `${color}${frame.icon}${SEQ.reset} ${SEQ.bold}${frame.label}${SEQ.reset}`;
    const animated = `${SEQ.accent}${frame.meter}${SEQ.reset}`;
    const suffix = `${SEQ.muted}${frame.elapsed}${detail ? ` · ${detail}` : ""}${SEQ.reset}`;
    if (width < 32) {
      return truncateAnsiText(`${primary}  ${SEQ.muted}${frame.elapsed}${SEQ.reset}`, width);
    }
    if (width < 60) {
      const compactState = toneText ? ` · ${toneText}` : "";
      return truncateAnsiText(
        `${primary}  ${animated}  ${SEQ.muted}${frame.elapsed}${compactState}${SEQ.reset}`,
        width,
      );
    }
    return truncateAnsiText(`${primary}  ${animated}  ${suffix}`, width);
  }

  private buildTaskPanel(width: number, maxRows = 8): string[] {
    if (!this.taskPanelTitle || maxRows <= 0) return [];
    const panelTitle = this.taskPanelTitle ? `任务 · ${this.taskPanelTitle}` : "任务";
    const rows = [`${SEQ.bold}${SEQ.blue}${truncateText(panelTitle, width)}${SEQ.reset}`];
    const visibleTasks = this.taskPanelExpanded
      ? this.taskPanelItems
      : this.taskPanelItems.slice(0, 5);
    const needsFooter = this.taskPanelExpanded || this.taskPanelItems.length > visibleTasks.length;
    const taskRowLimit = Math.max(1, maxRows - (needsFooter ? 1 : 0));
    let renderedTaskCount = 0;

    for (const task of visibleTasks) {
      if (rows.length >= taskRowLimit) break;
      if (task.status === "completed") {
        rows.push(
          `${SEQ.green}✓${SEQ.reset} ${SEQ.dim}${truncateText(task.content, Math.max(1, width - 2))}${SEQ.reset}`,
        );
      } else if (task.status === "in_progress") {
        rows.push(
          `${SEQ.bold}${SEQ.blue}●${SEQ.reset} ${SEQ.bold}${truncateText(task.content, Math.max(1, width - 2))}${SEQ.reset}`,
        );
      } else {
        rows.push(
          `${SEQ.muted}○${SEQ.reset} ${truncateText(task.content, Math.max(1, width - 2))}`,
        );
      }
      renderedTaskCount += 1;
      if (task.agent && rows.length < taskRowLimit) {
        const statusLabel =
          task.agent.status === "running"
            ? "运行中"
            : task.agent.status === "awaiting_verification"
              ? "待验证"
              : task.agent.status === "verified"
                ? "已验证"
                : task.agent.status === "aborted"
                  ? "已中止"
                  : "失败";
        const color =
          task.agent.status === "running"
            ? SEQ.cyan
            : task.agent.status === "verified"
              ? SEQ.green
              : task.agent.status === "awaiting_verification"
                ? SEQ.yellow
                : SEQ.red;
        rows.push(
          `${color}    ↳ ${truncateText(`${task.agent.role} · ${statusLabel}`, Math.max(1, width - 6))}${SEQ.reset}`,
        );
      }
    }

    if (needsFooter && rows.length < maxRows) {
      const hiddenTasks = this.taskPanelItems.slice(renderedTaskCount);
      if (hiddenTasks.length > 0) {
        const doneCount = hiddenTasks.filter((task) => task.status === "completed").length;
        const activeCount = hiddenTasks.filter((task) => task.status === "in_progress").length;
        const pendingCount = hiddenTasks.filter((task) => task.status === "pending").length;
        const statusSummary = [
          doneCount > 0 ? `${doneCount} 已完成` : "",
          activeCount > 0 ? `${activeCount} 进行中` : "",
          pendingCount > 0 ? `${pendingCount} 待处理` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        const counts = statusSummary ? ` (${statusSummary})` : "";
        rows.push(
          `${SEQ.muted}${truncateText(`… 另有 ${hiddenTasks.length} 项${counts} · Ctrl+T ${this.taskPanelExpanded ? "收起" : "展开"}`, width)}${SEQ.reset}`,
        );
      } else {
        rows.push(`${SEQ.muted}${truncateText("… Ctrl+T 收起", width)}${SEQ.reset}`);
      }
    }
    return rows;
  }

  private toggleTaskPanel(value: string, key: readline.Key): boolean {
    if (!isRealCtrlT(value, key) || this.taskPanelItems.length <= 5) return false;
    this.taskPanelExpanded = !this.taskPanelExpanded;
    this.scheduleRender();
    return true;
  }

  private buildAgentPanel(width: number, maxRows = 4): string[] {
    return buildAgentPanelRows(this.agentPanelItems, width, maxRows);
  }

  private render(): void {
    performanceMonitor.measureSync("terminal.render", () => this.renderFrame());
  }

  private renderFrame(): void {
    if (this.streamRenderTimer) {
      clearTimeout(this.streamRenderTimer);
      this.streamRenderTimer = null;
    }
    this.renderScheduled = false;
    this.scheduledRenderDelayMs = Number.POSITIVE_INFINITY;

    if (!this.started || !this.interactive) {
      return;
    }
    if (this.stdoutBackpressured) {
      this.renderPendingAfterDrain = true;
      return;
    }

    const layout = resolveTuiLayout(
      Math.max(1, stdout.columns || 80),
      Math.max(1, stdout.rows || 24),
    );
    const width = Math.max(1, layout.safeWidth);
    const height = Math.max(1, layout.safeHeight);
    const persistentHeader = this.sessionTitle
      ? `${this.options.compactHeader}  ${SEQ.muted}${truncateText(this.sessionTitle, Math.max(1, width - 7))}${SEQ.reset}`
      : this.options.compactHeader;
    const header =
      layout.headerMode === "hidden"
        ? ""
        : this.startupHeaderVisible
          ? layout.headerMode === "full"
            ? this.options.header
            : persistentHeader
          : persistentHeader;
    const headerInfo =
      this.startupHeaderVisible && layout.headerMode === "full" ? this.headerInfo : [];
    const headerRows = header
      ? [
          ...wrapAnsi(header, width),
          ...(headerInfo.length ? ["", ...headerInfo.flatMap((l) => wrapAnsi(l, width))] : []),
        ]
      : [];
    const panelBudget = Math.max(0, Math.min(layout.panelRows, height - headerRows.length - 4));
    const taskRows = this.buildTaskPanel(
      width,
      this.taskPanelExpanded ? panelBudget : Math.min(5, panelBudget),
    );
    const agentRows = this.buildAgentPanel(width, Math.max(0, panelBudget - taskRows.length));
    const topRows = [...headerRows, ...taskRows, ...agentRows];
    const divider = this.options.renderBorder(width);
    let inputLayout: VisibleInputLayout | undefined;
    let inputBlock: string[];
    let inputCursorOffset = 0;
    let historyDividerIndex = -1;

    const statusBar = this.buildStatusBar(width, layout.statusDetail);
    const minimal = layout.mode === "minimal";
    const emergencyMinimal = minimal && height < 8;
    const inputPaddingRows = layout.inputPaddingRows;
    const trailingInputPadding = new Array(inputPaddingRows).fill("");
    // 活动轨道固定占据输入框上方一行。动画开始、更新和结束都不会改变
    // 聊天区高度，也不会把活动文本送入聊天正文的软换行缓存。
    const activityTrack =
      this.buildActivityRow(width) || (this.status ? truncateAnsiText(this.status, width) : "");
    const activityTrackRows = emergencyMinimal ? [] : [activityTrack];
    const leadingInputRows: string[] = [];
    if (this.queueText) leadingInputRows.push(truncateAnsiText(this.queueText, width));
    const emergencyLeadingBudget = Math.max(0, height - 2);
    const visibleLeadingInputRows = emergencyMinimal
      ? emergencyLeadingBudget === 0
        ? []
        : leadingInputRows.slice(-emergencyLeadingBudget)
      : leadingInputRows;
    const emergencyStatusRows = emergencyMinimal && height < 2 ? [] : [statusBar];

    if (this.activeSelection) {
      const maxSelectionRows = emergencyMinimal
        ? Math.max(1, height - visibleLeadingInputRows.length - emergencyStatusRows.length)
        : Math.max(1, height - topRows.length - visibleLeadingInputRows.length - (minimal ? 4 : 6));
      const selectionRows = this.getSelectionRows(width, maxSelectionRows);
      if (emergencyMinimal) {
        inputBlock = [...visibleLeadingInputRows, ...selectionRows, ...emergencyStatusRows];
      } else if (minimal) {
        inputBlock = [
          ...visibleLeadingInputRows,
          ...activityTrackRows,
          ...selectionRows,
          statusBar,
        ];
      } else {
        historyDividerIndex = visibleLeadingInputRows.length;
        inputBlock = [
          ...visibleLeadingInputRows,
          divider,
          ...activityTrackRows,
          ...selectionRows,
          divider,
          statusBar,
        ];
      }
    } else {
      const maxSuggestionRows = layout.showHints
        ? Math.max(
            0,
            height - topRows.length - visibleLeadingInputRows.length - 7 - inputPaddingRows,
          )
        : 0;
      const suggestionRows = this.getCommandSuggestionRows(width, maxSuggestionRows);
      const maxInputRows = emergencyMinimal
        ? Math.max(1, height - visibleLeadingInputRows.length - emergencyStatusRows.length)
        : Math.max(
            1,
            height -
              topRows.length -
              visibleLeadingInputRows.length -
              suggestionRows.length -
              (minimal ? 4 : 6 + inputPaddingRows),
          );
      inputLayout = this.getInputLayout(width, maxInputRows);
      if (emergencyMinimal) {
        inputCursorOffset = visibleLeadingInputRows.length;
        inputBlock = [...visibleLeadingInputRows, ...inputLayout.rows, ...emergencyStatusRows];
      } else if (minimal) {
        inputCursorOffset = visibleLeadingInputRows.length + activityTrackRows.length;
        inputBlock = [
          ...visibleLeadingInputRows,
          ...activityTrackRows,
          ...inputLayout.rows,
          statusBar,
        ];
      } else {
        historyDividerIndex = visibleLeadingInputRows.length;
        inputCursorOffset = visibleLeadingInputRows.length + 1 + activityTrackRows.length;
        inputBlock = [
          ...visibleLeadingInputRows,
          divider,
          ...activityTrackRows,
          ...inputLayout.rows,
          ...suggestionRows,
          ...trailingInputPadding,
          divider,
          statusBar,
        ];
      }
    }
    const chatHeight = emergencyMinimal
      ? Math.max(0, height - inputBlock.length)
      : Math.max(1, height - topRows.length - 1 - inputBlock.length);
    // 对话区使用响应式内边距：内容按收窄后的宽度换行，
    // 渲染时再在每行前补空格；右侧由 buildScreenUpdate 的 \x1b[2K 自然露出主题背景。
    const chatPadding = layout.chatPadding;
    const chatWidth = Math.max(1, width - chatPadding * 2);
    const contentWithStatus = this.chatContent;
    const contentChanged =
      contentWithStatus !== this.cachedContentWithStatus || chatWidth !== this.cachedWrappedWidth;
    const previousWrappedCount = this.cachedWrappedChat.length;
    const wrappedChat = this.getWrappedChat(contentWithStatus, chatWidth);
    const wrappedRowDelta = wrappedChat.length - previousWrappedCount;
    if (contentChanged && this.chatScrollOffset > 0 && wrappedRowDelta !== 0) {
      this.chatScrollOffset = Math.max(0, this.chatScrollOffset + wrappedRowDelta);
    }
    const chatViewportHeight = chatHeight;
    this.maxChatScrollOffset = Math.max(0, wrappedChat.length - chatViewportHeight);
    this.chatScrollOffset = Math.min(this.chatScrollOffset, this.maxChatScrollOffset);

    const queuedWheelRows = this.pendingWheelRows;
    this.pendingWheelRows = 0;
    const wheelMovedRows =
      queuedWheelRows === 0 ? 0 : this.scrollChat(queuedWheelRows, false, true);

    if (historyDividerIndex >= 0 && this.chatScrollOffset > 0) {
      const label =
        width < 40
          ? `↑ ${this.chatScrollOffset} 行 · Ctrl+End`
          : `↑ 历史 · 距底部 ${this.chatScrollOffset} 行 · Ctrl+End 返回`;
      inputBlock[historyDividerIndex] = buildLabeledDivider(width, label);
    }

    this.chatPageSize = Math.max(1, chatViewportHeight - 1);
    const visibleEnd = Math.max(0, wrappedChat.length - this.chatScrollOffset);
    const visibleStart = Math.max(0, visibleEnd - chatViewportHeight);
    this.chatViewport = {
      screenTop: emergencyMinimal ? 1 : topRows.length + 2,
      visibleStart,
      visibleEnd,
      width: chatWidth,
      padding: chatPadding,
    };
    if (wheelMovedRows !== 0 && this.textSelection.dragging && this.selectionPointer) {
      const cell = this.getChatCellFromMouse(
        this.selectionPointer.column,
        this.selectionPointer.row,
        true,
      );
      if (cell) this.textSelection.update(cell);
    }
    const chatPrefix = " ".repeat(chatPadding);
    const visibleChat = wrappedChat
      .slice(visibleStart, visibleEnd)
      // 顺序：先补全用户消息行的行尾背景（软换行中间行缺 \x1b[K），
      // 再做选区高亮（列基于内容，无 padding），最后补左 padding。
      .map(
        (row, index) =>
          chatPrefix + this.highlightChatRow(fillUserMsgRowEol(row), visibleStart + index),
      );
    const chatRows = [...visibleChat, ...new Array(chatHeight - visibleChat.length).fill("")];
    const screenRows = emergencyMinimal
      ? [...chatRows, ...inputBlock].slice(0, height)
      : [...topRows, divider, ...chatRows, ...inputBlock].slice(0, height);
    while (screenRows.length < height) screenRows.push("");
    const fullRefresh =
      width !== this.renderedScreenWidth ||
      height !== this.renderedScreenHeight ||
      this.renderedScreenRows.length !== height;
    const chatRegionStart = emergencyMinimal ? 0 : topRows.length + 1;
    const viewportScrollRows = this.renderedChatVisibleStart - visibleStart;
    const canScrollViewport =
      chatHeight > 0 &&
      !fullRefresh &&
      chatRegionStart === this.renderedChatRegionStart &&
      chatHeight === this.renderedChatRegionHeight;
    const screenUpdate = canScrollViewport
      ? (buildViewportScrollUpdate(
          this.renderedScreenRows,
          screenRows,
          chatRegionStart,
          chatHeight,
          viewportScrollRows,
        ) ?? buildScreenUpdate(this.renderedScreenRows, screenRows))
      : buildScreenUpdate(fullRefresh ? [] : this.renderedScreenRows, screenRows);
    let cursorState = "";
    if (this.activeInput && inputLayout) {
      const inputTop = emergencyMinimal ? chatHeight : topRows.length + 1 + chatHeight;
      const cursorColumn = Math.min(inputLayout.cursor.column, width) + 1;
      const cursorRow = inputTop + inputCursorOffset + inputLayout.cursor.row + 1;
      cursorState = `\x1b[${cursorRow};${cursorColumn}H\x1b[?25h`;
    }

    if (!fullRefresh && !screenUpdate && cursorState === this.renderedCursorState) {
      this.renderedChatVisibleStart = visibleStart;
      this.renderedChatRegionStart = chatRegionStart;
      this.renderedChatRegionHeight = chatHeight;
      return;
    }

    let frame = "\x1b[?25l";
    if (fullRefresh) frame += `${themeEnter()}\x1b[2J`;
    frame += screenUpdate;
    frame += cursorState;
    const accepted = stdout.write(frame);
    this.renderedScreenRows = screenRows;
    this.renderedScreenWidth = width;
    this.renderedScreenHeight = height;
    this.renderedCursorState = cursorState;
    this.renderedChatVisibleStart = visibleStart;
    this.renderedChatRegionStart = chatRegionStart;
    this.renderedChatRegionHeight = chatHeight;
    if (!accepted) this.stdoutBackpressured = true;
  }

  private finishInput(error?: Error): void {
    const activeInput = this.activeInput;
    if (!activeInput) {
      return;
    }

    const value = activeInput.graphemes.join("");
    this.activeInput = undefined;
    this.scheduleRender(true);

    if (error) {
      activeInput.reject(error);
    } else {
      if (!activeInput.sensitive) {
        this.inputHistory.record(redactSensitiveCommand(sanitizeTerminalText(value), ""));
      }
      activeInput.resolve(value);
    }
  }

  private finishSelection(error?: Error): void {
    const activeSelection = this.activeSelection;
    if (!activeSelection) {
      return;
    }

    const selected = activeSelection.options.items[activeSelection.selectedIndex];
    const selectedSecondary =
      activeSelection.options.secondary?.items[activeSelection.secondaryIndex];
    this.activeSelection = undefined;
    this.scheduleRender(true);

    if (error) {
      activeSelection.reject(error);
    } else {
      activeSelection.resolve({
        value: selected.value,
        secondaryValue: selectedSecondary?.value,
      });
    }
  }

  private insert(value: string): void {
    const activeInput = this.activeInput;
    if (!activeInput) {
      return;
    }

    const inserted = splitGraphemes(sanitizeTerminalText(value));
    activeInput.graphemes.splice(activeInput.cursorIndex, 0, ...inserted);
    activeInput.cursorIndex += inserted.length;
    activeInput.preferredColumn = undefined;
    activeInput.selectedCommandIndex = 0;
    activeInput.historyNavigationActive = false;
    this.scheduleRender(true);
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
      activeInput.continuationPrompt,
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
    this.scheduleRender(true);
    return true;
  }

  private navigateInputHistory(direction: -1 | 1): void {
    const activeInput = this.activeInput;
    if (!activeInput || activeInput.sensitive) {
      return;
    }

    const value = this.inputHistory.move(direction, activeInput.graphemes.join(""));
    if (value === undefined) {
      return;
    }

    activeInput.graphemes = splitGraphemes(value);
    activeInput.cursorIndex = activeInput.graphemes.length;
    activeInput.preferredColumn = undefined;
    activeInput.selectedCommandIndex = 0;
    activeInput.historyNavigationActive = this.inputHistory.isBrowsing();
    this.scheduleRender(true);
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
    if (key.name === "escape") {
      this.finishSelection(new TerminalInputCancelledError());
      this.onEscCallback?.();
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      this.scrollChat(key.name === "pageup" ? this.chatPageSize : -this.chatPageSize);
      return;
    }
    if (key.ctrl && key.name === "end") {
      this.scrollChat(-this.chatScrollOffset);
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      this.finishSelection();
      return;
    }
    if (key.name === "up" || key.name === "down") {
      const direction = key.name === "up" ? -1 : 1;
      const itemCount = activeSelection.options.items.length;
      activeSelection.selectedIndex =
        (activeSelection.selectedIndex + direction + itemCount) % itemCount;
      this.scheduleRender(true);
      return;
    }
    if ((key.name === "left" || key.name === "right") && activeSelection.options.secondary) {
      const direction = key.name === "left" ? -1 : 1;
      const itemCount = activeSelection.options.secondary.items.length;
      activeSelection.secondaryIndex =
        (activeSelection.secondaryIndex + direction + itemCount) % itemCount;
      this.scheduleRender(true);
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
    if (key.name === "escape") {
      if (this.textSelection.active) {
        this.textSelection.clear();
        this.selectionLayout = undefined;
        this.scheduleRender(true);
      }
      this.onEscCallback?.();
      return;
    }

    if (key.name === "pageup" || key.name === "pagedown") {
      this.scrollChat(key.name === "pageup" ? this.chatPageSize : -this.chatPageSize);
      return;
    }

    if (key.ctrl && key.name === "end") {
      this.scrollChat(-this.chatScrollOffset);
      return;
    }

    if (key.shift && (key.name === "up" || key.name === "down")) {
      this.scrollChat(key.name === "up" ? 3 : -3);
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      if (key.shift || key.meta) {
        this.insert("\n");
      } else {
        const suggestions = this.getCommandSuggestions(activeInput);
        if (suggestions.length > 0) {
          const selected =
            suggestions[Math.min(activeInput.selectedCommandIndex, suggestions.length - 1)];
          activeInput.graphemes = splitGraphemes(selected.command);
          activeInput.cursorIndex = activeInput.graphemes.length;
        }
        this.finishInput();
      }
      return;
    }

    if (key.ctrl && key.name === "j") {
      this.insert("\n");
      return;
    }

    if (isRealCtrlU(value, key)) {
      const inputText = activeInput.graphemes.join("");
      if (inputText) {
        const containsInlineSecret = redactSensitiveCommand(inputText, "") !== inputText;
        if (activeInput.sensitive || containsInlineSecret) {
          activeInput.graphemes = [];
          activeInput.cursorIndex = 0;
          activeInput.preferredColumn = undefined;
          activeInput.selectedCommandIndex = 0;
          activeInput.historyNavigationActive = false;
          this.scheduleRender(true);
          return;
        }
        void this.clipboardWriter.write(inputText).then((success) => {
          if (
            !success ||
            this.activeInput !== activeInput ||
            activeInput.graphemes.join("") !== inputText
          )
            return;
          activeInput.graphemes = [];
          activeInput.cursorIndex = 0;
          activeInput.preferredColumn = undefined;
          activeInput.selectedCommandIndex = 0;
          activeInput.historyNavigationActive = false;
          this.scheduleRender(true);
        });
      }
      return;
    }

    if (key.name === "backspace") {
      if (activeInput.cursorIndex > 0) {
        activeInput.graphemes.splice(activeInput.cursorIndex - 1, 1);
        activeInput.cursorIndex -= 1;
        activeInput.preferredColumn = undefined;
        activeInput.selectedCommandIndex = 0;
        activeInput.historyNavigationActive = false;
        this.scheduleRender(true);
      }
      return;
    }

    if (key.name === "delete" || isRealCtrlD(value, key)) {
      if (isRealCtrlD(value, key) && activeInput.graphemes.length === 0) {
        this.finishInput(new TerminalInputCancelledError());
      } else if (activeInput.cursorIndex < activeInput.graphemes.length) {
        activeInput.graphemes.splice(activeInput.cursorIndex, 1);
        activeInput.preferredColumn = undefined;
        activeInput.selectedCommandIndex = 0;
        activeInput.historyNavigationActive = false;
        this.scheduleRender(true);
      }
      return;
    }

    if (key.name === "left" || key.name === "right") {
      const direction = key.name === "left" ? -1 : 1;
      activeInput.cursorIndex = Math.max(
        0,
        Math.min(activeInput.graphemes.length, activeInput.cursorIndex + direction),
      );
      activeInput.preferredColumn = undefined;
      this.scheduleRender(true);
      return;
    }

    if (key.name === "up" || key.name === "down") {
      const suggestions = this.getCommandSuggestions(activeInput);
      if (suggestions.length > 0) {
        const direction = key.name === "up" ? -1 : 1;
        activeInput.selectedCommandIndex =
          (activeInput.selectedCommandIndex + direction + suggestions.length) % suggestions.length;
        this.scheduleRender(true);
        return;
      }
      const direction = key.name === "up" ? -1 : 1;
      if (!this.moveVertically(direction)) {
        this.navigateInputHistory(direction);
      }
      return;
    }

    if (key.name === "home" || (key.ctrl && key.name === "a")) {
      const previousLineBreak = activeInput.graphemes.lastIndexOf(
        "\n",
        activeInput.cursorIndex - 1,
      );
      activeInput.cursorIndex = key.ctrl ? 0 : previousLineBreak + 1;
      activeInput.preferredColumn = undefined;
      this.scheduleRender(true);
      return;
    }

    if (key.name === "end" || (key.ctrl && key.name === "e")) {
      const nextLineBreak = activeInput.graphemes.indexOf("\n", activeInput.cursorIndex);
      activeInput.cursorIndex =
        key.ctrl || nextLineBreak === -1 ? activeInput.graphemes.length : nextLineBreak;
      activeInput.preferredColumn = undefined;
      this.scheduleRender(true);
      return;
    }

    if (key.ctrl && key.name === "w") {
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
      this.scheduleRender(true);
      return;
    }

    if ((key.name === "tab" && key.shift) || key.name === "backtab" || value === "\x1b[Z") {
      if (this.onShiftTabCallback) {
        this.onShiftTabCallback();
      }
      return;
    }

    if (key.name === "tab") {
      this.insert("  ");
      return;
    }

    if (!key.ctrl && !key.meta && value && !value.startsWith("\x1b")) {
      this.insert(value);
    }
  };
}
