import { spawnSync } from "node:child_process";
import { stderr, stdin, stdout } from "node:process";
import readline from "node:readline";
import readlinePromises from "node:readline/promises";
import { PassThrough } from "node:stream";
import { performanceMonitor } from "@hajicli/core";
import type { ActivityFrame } from "./activity-indicator.js";
import { type AgentPanelItem, buildAgentPanelRows } from "./agent-panel.js";
import { matchSlashCommands } from "./cli-help.js";
import { captureClipboardImage, type PastedImage } from "./clipboard-image.js";
import { ClipboardWriter, InputHistoryBuffer } from "./input-history.js";
import { type ChatSegmentView, type FoldGroupStats, renderSegmentText } from "./process-fold.js";
import {
  type ActivityBadge,
  buildActivityRow,
  buildStatusBarRow,
  buildTaskPanelRows,
  formatPermissionModeLabel,
  type TaskPanelItem,
} from "./terminal-panels.js";
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
  concatAnsiLayouts,
  DEFAULT_CHAT_PADDING,
  fitText,
  getSelectionAutoScrollRows,
  highlightAnsiColumns,
  layoutAnsiDocument,
  layoutInput,
  normalizeTerminalOutput,
  SEQ,
  splitGraphemes,
  terminalWidth,
  truncateAnsiText,
  truncateText,
  type VisibleInputLayout,
  wrapAnsi,
  wrapAnsiWithState,
} from "./terminal-text.js";
import { type TextCell, TextSelectionModel } from "./text-selection.js";
import { colors, fillUserMsgRowEol, themeEnter } from "./theme.js";
import { resolveTuiLayout, type TuiStatusDetail } from "./tui-layout.js";
import {
  buildSidebarFrame,
  composeSidebarRow,
  resolveSidebarWidth,
  SIDEBAR_GAP_WIDTH,
  type SidebarState,
} from "./tui-sidebar.js";

export { type AgentPanelItem, buildAgentPanelRows, formatAgentElapsed } from "./agent-panel.js";
// 保持既有 dist/terminal-input.js 导出面的兼容：拆分后的符号在此统一转发。
export { ClipboardWriter, InputHistoryBuffer } from "./input-history.js";
export type { TaskPanelItem } from "./terminal-panels.js";
export {
  buildScreenUpdate,
  buildViewportScrollUpdate,
  concatAnsiLayouts,
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
  /** 强制非交互（无头单次模式 haji -p）：即使身处 TTY 也走 stdout 直写与 readline 降级。 */
  forceNonInteractive?: boolean;
  /** 无头 JSON 输出模式：非交互下正文也不写 stdout，由调用方统一输出 JSON。 */
  muteNonInteractiveOutput?: boolean;
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
  /** 所属枢纽名（如“模型与配置”），模糊搜索命中非顶层条目时作为来源标签显示。 */
  group?: string;
  /** 参数格式提示（如 `<id>`），显示在补全标签之后。 */
  argHint?: string;
  /** 参数为必填：Enter 只把指令填入输入框，等待补充参数。 */
  argRequired?: boolean;
  /** 只输入 `/` 时列出的顶层条目。 */
  topLevel?: boolean;
}

export interface TerminalSelectionItem {
  value: string;
  label: string;
  description?: string;
  /** 单键直选（不区分大小写），例如授权卡片的 y / a / n。 */
  hotkey?: string;
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
  /** 标题与选项之间的预览行（已着色），以左侧竖线成卡片显示，按宽度与高度裁剪。 */
  preview?: readonly string[];
  /** 覆盖标题右侧的默认按键提示。 */
  hint?: string;
  /** 选择器出现后的这段时间内忽略确认键，防止提前敲下的回车误确认。 */
  confirmDelayMs?: number;
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
  /** 用户是否用方向键主动挑选过补全项；未挑选时 Enter 优先执行已完整输入的指令。 */
  commandNavigated?: boolean;
  historyNavigationActive: boolean;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

interface ActiveSelection {
  options: TerminalSelectionOptions;
  openedAt?: number;
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

/** 已封口的对话区片段：raw 不再变化，只随宽度/展开状态重算换行。 */
interface ChatSegment {
  id: number;
  kind: "plain" | "fold";
  raw: string;
  stats?: FoldGroupStats;
  expanded: boolean;
  /** 缓存键 `${width}|${expanded}|${foldEnabled}`，命中则直接复用 rows / layout。 */
  cacheKey?: string;
  /** 去掉末尾光标行后的换行结果。 */
  rows?: string[];
  /** 选区用的独立布局（惰性计算，末尾光标行保留给 concatAnsiLayouts 处理）。 */
  layout?: AnsiTextLayout;
  /** 摘要行在段内的行号（= 首部空行数）。 */
  headerRow?: number;
}

/** 过程段的开启句柄；epoch 变化（清屏 / 整体替换 / 尾部截断）后自动失效。 */
export interface FoldGroupHandle {
  epoch: number;
  start: number;
}

/** /resume 重建历史时传入的分段。 */
export interface ChatSegmentPiece {
  kind: "plain" | "fold";
  raw: string;
  stats?: FoldGroupStats;
}

/** 段尾统一补换行：封口片段必须整行结束，拼接时才不会和下一段粘在一起。 */
function ensureTrailingNewline(raw: string): string {
  if (raw.length === 0) return raw;
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}

/**
 * 段尾若残留未复位的 SGR，在最后一个换行前补一个 reset。
 * 否则段尾的颜色会漏到下一段（各段独立换行再拼接就不再等价于整串换行）。
 */
function closeTrailingStyle(raw: string): string {
  const pattern = /\x1b\[([0-9;]*)m/g;
  let active = false;
  let match = pattern.exec(raw);
  while (match !== null) {
    const params = match[1];
    active = !(params === "" || params === "0");
    match = pattern.exec(raw);
  }
  if (!active) return raw;
  return raw.endsWith("\n") ? `${raw.slice(0, -1)}\x1b[0m\n` : `${raw}\x1b[0m`;
}

function segmentView(segment: ChatSegment): ChatSegmentView {
  return {
    kind: segment.kind,
    raw: segment.raw,
    stats: segment.stats,
    expanded: segment.expanded,
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

function isRealCtrlO(value: string, key: readline.Key): boolean {
  return value === "\x0f" && key.ctrl === true && key.name === "o";
}

function isRealCtrlT(value: string, key: readline.Key): boolean {
  return value === "\x14" && key.ctrl === true && key.name === "t";
}

interface MenuRow {
  label: string;
  description?: string;
}

/**
 * 菜单行（斜杠补全与选择器共用）：标签列按最宽项对齐，说明灰显并在超宽时以省略号截断；
 * 选中项用 ▸ 标记，与输入提示符 › 区分。
 */
function formatMenuRows(items: readonly MenuRow[], selectedIndex: number, width: number): string[] {
  const contentWidth = Math.max(1, width - 2);
  const labelWidth = Math.min(
    Math.max(0, ...items.map((item) => terminalWidth(item.label))),
    Math.max(8, Math.floor(contentWidth * 0.45)),
  );
  return items.map((item, index) => {
    const selected = index === selectedIndex;
    const label = fitText(item.label, labelWidth);
    const padding = " ".repeat(Math.max(0, labelWidth - terminalWidth(label)));
    const descriptionWidth = contentWidth - labelWidth - 2;
    const description =
      item.description && descriptionWidth >= 4 ? fitText(item.description, descriptionWidth) : "";
    const marker = selected ? `${SEQ.boldAccent}▸ ` : "  ";
    const labelStyle = selected ? SEQ.boldAccent : "";
    const descriptionStyle = selected ? "" : SEQ.muted;
    return `${marker}${labelStyle}${label}${SEQ.reset}${description ? `${padding}  ${descriptionStyle}${description}${SEQ.reset}` : ""}`;
  });
}

export class TerminalUI {
  private readonly options: TerminalUIOptions;
  private readonly keyInput = new PassThrough();
  private readonly protocolParser = new TerminalProtocolParser();
  private readonly textSelection = new TextSelectionModel();
  private readonly inputHistory = new InputHistoryBuffer();
  private readonly clipboardWriter = new ClipboardWriter();
  /** Ctrl+V / Alt+V 暂存的本轮粘贴图片（已落盘），提交后由调用方 takePendingImages() 取走。 */
  private pendingImages: PastedImage[] = [];
  private clipboardCaptureInFlight = false;
  private readonly interactive: boolean;
  private readonly outputMuted: boolean;
  private started = false;
  private chatContent = "";
  /**
   * 两层存储：已封口的片段（普通内容 + 过程段）留在 sealedSegments，
   * chatContent 只当“尾部”继续被 writeChat / updateChatFrom 改写。
   * 这样所有持有尾部绝对偏移的调用方语义不变，只有封口那一刻需要平移偏移。
   */
  private sealedSegments: ChatSegment[] = [];
  private nextSegmentId = 1;
  /** 过程折叠开关（/fold 可关；关闭后对话区与改动前逐行一致）。 */
  private foldEnabled = true;
  /** 对话文档纪元：清屏 / 整体替换 / 尾部截断 / 封口时 +1，让旧偏移与旧句柄失效。 */
  private chatEpoch = 0;
  /** 已封口区版本号：段内容、展开状态或折叠开关变化时 +1（选区布局缓存用）。 */
  private sealedVersion = 0;
  /** 本帧摘要行的逻辑行号 → 段 id（render 时重建，点击命中用）。 */
  private foldHeaderRows = new Map<number, number>();
  /** 本帧已封口段的行区间（render 时重建，滚动锚定用）。 */
  private sealedRowIndex: Array<{ id: number; start: number; count: number }> = [];
  /** 下一帧要应用的滚动锚点（切换展开 / 封口时设置）。 */
  private pendingScrollAnchor?: { segmentId: number; rowInSegment: number; screenOffset: number };
  private chatScrollOffset = 0;
  private maxChatScrollOffset = 0;
  private chatPageSize = 1;
  private status = "";
  private activityFrame?: ActivityFrame;
  /** 渲染在已提交正文之后的实时区域，不写入 chatContent。 */
  private liveTail = "";
  private permissionMode = "";
  private modelName = "";
  private providerName = "";
  private reasoningEffort = "";
  private sessionTitle = "";
  private currentPath = "";
  private usedTokens = 0;
  private maxTokens = 1000000;
  /** 右侧会话信息栏（默认开启，可在 /config 中关闭并持久化）。 */
  private sidebarEnabled = true;
  private costCny?: number;
  private costRequests = 0;
  private costHasUnpriced = false;
  private costPromptTokens = 0;
  private costCompletionTokens = 0;
  /** 上一轮回合耗时（ms）；undefined 表示本会话还没跑完一轮。 */
  private lastTurnMs?: number;
  /** 本会话上下文压缩次数（自动 + 手动）；用于解释圆环为何突然掉下来。 */
  private compactionCount = 0;
  /** 鼠标是否悬停在上下文圆环上；命中区域每帧随布局更新。 */
  private sidebarRingHovered = false;
  private sidebarRingHit?: {
    columnStart: number;
    columnEnd: number;
    rowStart: number;
    rowEnd: number;
  };
  /** 悬停需要 any-event 鼠标跟踪（1003），仅在侧栏可见时开启。 */
  private mouseMotionEnabled = false;
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
  /** 选区布局缓存对应的已封口区版本号。 */
  private selectionLayoutSealedVersion = -1;
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
  /** Ctrl+C 防误触：上一次按下时间与被清空的草稿（↑ 可一次性找回）。 */
  private lastCtrlCAt = 0;
  private ctrlCDraftStash = "";
  /** 底栏临时提示（Ctrl+C 确认、清空草稿等），超时自动清除。 */
  private transientHintText = "";
  private transientHintTimer: NodeJS.Timeout | null = null;
  /** @ 文件补全：当前输入的 @ 词（含 @），空串表示不在补全状态。 */
  private fileMentionQuery = "";
  private fileMentionCandidates: string[] = [];
  private fileMentionSelectedIndex = 0;
  private fileMentionProvider?: (query: string) => string[];

  constructor(options: TerminalUIOptions) {
    this.options = options;
    // 在构造函数体内计算：无头模式需结合 options.forceNonInteractive 强制降级。
    this.interactive =
      Boolean(stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === "function") &&
      !options.forceNonInteractive;
    this.outputMuted = Boolean(options.muteNonInteractiveOutput);
  }

  /**
   * 强制下一次渲染走全量刷新：清屏并按当前主题重绘整屏。
   * 主题/配色在运行中切换后调用。注意：已提交的历史行是固化的 SGR 文本，
   * 不会重新着色，只有重绘出的新帧使用新主题。
   */
  forceRedraw(): void {
    if (!this.started || !this.interactive) return;
    // 置空尺寸缓存，令 renderFrame 的 fullRefresh 判定成立（触发 themeEnter()+清屏）。
    this.renderedScreenWidth = 0;
    this.renderedScreenHeight = 0;
    this.renderedScreenRows = [];
    this.scheduleRender();
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

  /** 开关右侧会话信息栏（宽度不足时即使开启也不显示）。 */
  setSidebarEnabled(enabled: boolean): void {
    if (this.sidebarEnabled === enabled) return;
    this.sidebarEnabled = enabled;
    this.scheduleRender();
  }

  isSidebarEnabled(): boolean {
    return this.sidebarEnabled;
  }

  /** 更新右侧栏的会话费用（元）；undefined 表示尚无已定价调用。 */
  setCostInfo(
    totalCostCny: number | undefined,
    requests = 0,
    hasUnpriced = false,
    promptTokens = 0,
    completionTokens = 0,
  ): void {
    this.costCny = totalCostCny;
    this.costRequests = Math.max(0, requests);
    this.costHasUnpriced = hasUnpriced;
    this.costPromptTokens = Math.max(0, promptTokens);
    this.costCompletionTokens = Math.max(0, completionTokens);
    this.scheduleRender();
  }

  /** 记录上一轮回合耗时（回合结束时由 turn-runner 回调；0 表示忽略）。 */
  setLastTurnDuration(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    this.lastTurnMs = durationMs;
    this.scheduleRender();
  }

  /** 记一次上下文压缩（自动或手动）；侧栏据此显示“已压缩”徽标。 */
  noteCompaction(): void {
    this.compactionCount += 1;
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

  /**
   * 开段：保证尾部处于行首（不在行首则补 "\n"），返回段起点句柄。
   * 非交互模式返回 undefined——折叠 API 在无头/管道下全部空操作。
   */
  beginFoldGroup(): FoldGroupHandle | undefined {
    if (!this.interactive) return undefined;
    if (this.chatContent && !this.chatContent.endsWith("\n")) this.writeChat("\n");
    return { epoch: this.chatEpoch, start: this.chatContent.length };
  }

  /**
   * 封口：尾部 [0, handle.start) 作为 plain 段、[handle.start, end) 作为过程段推入
   * sealedSegments，尾部只保留 [end, …)。返回从尾部头部移走的字符数（= end），
   * 调用方据此平移自己持有的偏移。句柄过期或区间为空时为空操作，返回 0。
   */
  sealFoldGroup(handle: FoldGroupHandle, endOffset: number, stats: FoldGroupStats): number {
    if (!this.interactive || handle.epoch !== this.chatEpoch) return 0;
    const end = Math.min(Math.max(0, endOffset), this.chatContent.length);
    if (handle.start >= end) return 0;
    const before = this.chatContent.slice(0, handle.start);
    const group = this.chatContent.slice(handle.start, end);
    if (before) this.pushSegment({ kind: "plain", raw: before });
    this.pushSegment({ kind: "fold", raw: group, stats, expanded: false });
    this.chatContent = this.chatContent.slice(end);
    this.chatEpoch += 1;
    this.setStableWrapPrefix("");
    this.cachedContentWithStatus = "";
    this.selectionLayout = undefined;
    this.textSelection.clear();
    // 用户正在往上翻时，中间行数变化不能把视口拽走。
    this.captureScrollAnchor();
    this.enforceSegmentBudget();
    this.scheduleRender();
    return end;
  }

  /** /resume 用：整体替换为预先分好段的历史（最后一段 plain 进入尾部）。 */
  replaceChatSegments(pieces: readonly ChatSegmentPiece[]): void {
    if (!this.interactive) {
      this.replaceChat(pieces.map((piece) => piece.raw).join(""));
      return;
    }
    const pending = pieces.map((piece) => ({ ...piece }));
    const last = pending[pending.length - 1];
    const tail = last?.kind === "plain" ? pending.pop() : undefined;
    this.sealedSegments = [];
    this.nextSegmentId = 1;
    for (const piece of pending) {
      this.pushSegment({
        kind: piece.kind,
        raw: piece.raw,
        stats: piece.stats,
        expanded: false,
      });
    }
    this.chatContent = tail ? normalizeTerminalOutput(tail.raw) : "";
    this.chatScrollOffset = 0;
    this.textSelection.clear();
    this.stopSelectionAutoScroll();
    this.pendingMouseSelection = undefined;
    this.selectionPointer = undefined;
    this.selectionLayout = undefined;
    this.selectionLayoutContent = "";
    this.selectionLayoutWidth = 0;
    this.selectionLayoutSealedVersion = -1;
    this.cachedContentWithStatus = "";
    this.cachedWrappedWidth = 0;
    this.cachedWrappedChat = [];
    this.foldHeaderRows.clear();
    this.pendingScrollAnchor = undefined;
    this.chatEpoch += 1;
    this.sealedVersion += 1;
    this.setStableWrapPrefix("");
    this.enforceSegmentBudget();
    this.scheduleRender();
  }

  setFoldEnabled(enabled: boolean): void {
    if (this.foldEnabled === enabled) return;
    this.foldEnabled = enabled;
    this.sealedVersion += 1;
    this.selectionLayout = undefined;
    this.foldHeaderRows.clear();
    this.captureScrollAnchor();
    this.scheduleRender(true);
  }

  isFoldEnabled(): boolean {
    return this.foldEnabled;
  }

  /** 单调递增：清屏 / 整体替换 / 尾部截断 / 封口时 +1（调用方据此判断旧偏移是否还有效）。 */
  getChatEpoch(): number {
    return this.chatEpoch;
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
      this.queueText = ` ${SEQ.accent}待处理队列 (${items.length} 条):${SEQ.reset} ${SEQ.muted}${formatted}${SEQ.reset}`;
    }
    this.scheduleRender();
  }

  /**
   * 底栏临时提示（覆盖状态栏位置，不进对话区）：Ctrl+C 确认、草稿清空等。
   * 有活动状态时活动行优先；非交互模式降级为 stderr 提示。
   */
  showTransientHint(text: string, durationMs = 2500): void {
    if (!this.started) return;
    if (!this.interactive) {
      stderr.write(`${text}\n`);
      return;
    }
    this.transientHintText = text;
    if (this.transientHintTimer) clearTimeout(this.transientHintTimer);
    this.transientHintTimer = setTimeout(() => {
      this.transientHintTimer = null;
      this.transientHintText = "";
      this.scheduleRender();
    }, durationMs);
    this.transientHintTimer.unref?.();
    this.scheduleRender(true);
  }

  /**
   * 完成 / 待授权提醒。bell 写 BEL；desktop 写 OSC 9（iTerm2 / Windows Terminal）
   * 与 OSC 777（部分 Linux 终端），不支持的终端静默忽略。非交互模式不提醒。
   */
  notify(kind: "bell" | "desktop", text: string): void {
    if (!this.interactive) return;
    if (kind === "bell") {
      stdout.write("\x07");
      return;
    }
    const safeText = text.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120);
    const safeTitle = "haji";
    stdout.write(`\x1b]9;${safeTitle}: ${safeText}\x07`);
    stdout.write(`\x1b]777;notify;${safeTitle};${safeText}\x07`);
  }

  /** @ 文件补全的候选提供者：入参为去掉 @ 的查询词，返回相对路径列表。 */
  setFileMentionProvider(provider?: (query: string) => string[]): void {
    this.fileMentionProvider = provider;
    this.fileMentionQuery = "";
    this.fileMentionCandidates = [];
    this.fileMentionSelectedIndex = 0;
  }

  /** 当前聊天内容的真实可用宽度，供 Markdown 代码块和表格共享。 */
  getContentWidth(): number {
    const layout = resolveTuiLayout(
      Math.max(1, stdout.columns || 80),
      Math.max(1, stdout.rows || 24),
    );
    const sidebarWidth = resolveSidebarWidth(
      layout.safeWidth,
      layout.safeHeight,
      this.sidebarEnabled,
    );
    const leftAreaWidth =
      layout.safeWidth - (sidebarWidth > 0 ? sidebarWidth + SIDEBAR_GAP_WIDTH : 0);
    return Math.max(1, leftAreaWidth - layout.chatPadding * 2);
  }

  isInteractive(): boolean {
    return this.interactive;
  }

  isInputActive(): boolean {
    return Boolean(this.activeInput);
  }

  cancelInput(): string | undefined {
    if (!this.activeInput) return undefined;
    const draft = this.activeInput.graphemes.join("");
    this.pendingImages = [];
    this.finishInput(new TerminalInputCancelledError());
    return draft;
  }

  /** 取走本轮粘贴的图片；返回后内部缓冲清空，避免串到下一轮。 */
  takePendingImages(): PastedImage[] {
    const images = this.pendingImages;
    this.pendingImages = [];
    return images;
  }

  /** Ctrl+V / Alt+V：把剪贴板位图落盘为工作区 PNG，作为本轮图片附件显示在输入框上方。 */
  private async captureClipboardAttachment(): Promise<void> {
    const owner = this.activeInput;
    if (!owner || this.clipboardCaptureInFlight) return;
    this.clipboardCaptureInFlight = true;
    try {
      const result = await captureClipboardImage();
      // 取图期间用户已回车提交：此时图片无处可挂，明确丢弃而不是悄悄带到下一轮。
      if (this.activeInput !== owner) {
        return;
      }
      if (!result.ok) {
        this.writeLine(colors.yellow(`! ${result.error}`));
        return;
      }
      this.pendingImages = [...this.pendingImages, result.image];
    } finally {
      this.clipboardCaptureInFlight = false;
      this.scheduleRender(true);
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
    // 单独的 Esc 默认要等 500ms 才判定（期间的下一个键会被并成 Alt+键，Esc 后紧跟回车
    // 会变成“确认”）。终端转义序列总是整块到达，50ms 足以区分。
    readline.emitKeypressEvents(this.keyInput, {
      escapeCodeTimeout: 50,
    } as unknown as readline.Interface);
    stdin.setRawMode(true);
    enableWindowsVirtualTerminalInput();
    stdin.resume();
    this.clipboardWriter.start();
    // 1002 负责拖动和滚轮，1006 统一为 SGR 坐标；禁用 1007，避免滚轮重复转成方向键。
    // 整段用同步输出（2026）包起来：进备屏、清屏与模式切换不会在中间状态被扫描出来。
    stdout.write(
      "\x1b[?2026h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1007l\x1b[?1049h" +
        themeEnter() +
        "\x1b[2J\x1b[H\x1b[?25l\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?2026l",
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
    if (this.transientHintTimer) {
      clearTimeout(this.transientHintTimer);
      this.transientHintTimer = null;
    }
    this.transientHintText = "";
    this.fileMentionQuery = "";
    this.fileMentionCandidates = [];
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
    this.sealedSegments = [];
    this.nextSegmentId = 1;
    this.foldHeaderRows.clear();
    this.sealedRowIndex = [];
    this.pendingScrollAnchor = undefined;
    this.selectionLayoutSealedVersion = -1;
    this.chatEpoch += 1;
    this.sealedVersion += 1;
    this.setStableWrapPrefix("");
    this.scheduleRender(true);
  }

  /**
   * 推入一个已封口片段。段尾统一补换行并复位 SGR：
   * 这样“各段独立换行再拼接 ≡ 整串换行”，与 stableWrapPrefix 的 rows.slice(0,-1) 同源。
   */
  private pushSegment(piece: {
    kind: "plain" | "fold";
    raw: string;
    stats?: FoldGroupStats;
    expanded?: boolean;
  }): void {
    // 与 writeChat 同一套归一化（制表符展开等），保证段与尾部宽度口径一致。
    const raw = ensureTrailingNewline(normalizeTerminalOutput(piece.raw));
    if (!raw) return;
    this.sealedSegments.push({
      id: this.nextSegmentId,
      kind: piece.kind,
      raw: closeTrailingStyle(raw),
      stats: piece.stats,
      expanded: piece.expanded ?? false,
    });
    this.nextSegmentId += 1;
    this.sealedVersion += 1;
    this.selectionLayout = undefined;
  }

  /** 段的换行结果（去掉末尾光标行）；宽度或展开状态变化时重算。 */
  private getSegmentRows(segment: ChatSegment, width: number): string[] {
    const cacheKey = `${width}|${segment.expanded ? 1 : 0}|${this.foldEnabled ? 1 : 0}`;
    if (segment.cacheKey === cacheKey && segment.rows) return segment.rows;
    const rendered = renderSegmentText(segmentView(segment), width, this.foldEnabled);
    segment.headerRow = rendered.headerRow;
    const rows = performanceMonitor.measureSync("terminal.wrap.segment", () =>
      wrapAnsi(rendered.text, width),
    );
    // 去掉末尾的光标行：拼接时由下一段的首行接上。
    segment.rows = rows.length > 0 ? rows.slice(0, -1) : rows;
    segment.layout = undefined;
    segment.cacheKey = cacheKey;
    return segment.rows;
  }

  /** 段的独立布局（选区用）；末尾光标行保留，交给 concatAnsiLayouts 处理。 */
  private getSegmentLayout(segment: ChatSegment, width: number): AnsiTextLayout {
    if (segment.layout && segment.cacheKey === this.segmentCacheKey(segment, width)) {
      return segment.layout;
    }
    const rendered = renderSegmentText(segmentView(segment), width, this.foldEnabled);
    segment.headerRow = rendered.headerRow;
    const layout = layoutAnsiDocument(rendered.text, width);
    segment.layout = layout;
    segment.cacheKey = this.segmentCacheKey(segment, width);
    segment.rows = layout.rows.slice(0, -1).map((row) => row.ansi);
    return layout;
  }

  private segmentCacheKey(segment: ChatSegment, width: number): string {
    return `${width}|${segment.expanded ? 1 : 0}|${this.foldEnabled ? 1 : 0}`;
  }

  /** 已封口区的可见行；同时重建摘要行命中表与段行区间。 */
  private getSealedRows(width: number): string[] {
    this.foldHeaderRows.clear();
    this.sealedRowIndex = [];
    if (this.sealedSegments.length === 0) return [];
    const rows: string[] = [];
    for (const segment of this.sealedSegments) {
      const segmentRows = this.getSegmentRows(segment, width);
      if (segment.kind === "fold" && segment.headerRow !== undefined && this.foldEnabled) {
        this.foldHeaderRows.set(rows.length + segment.headerRow, segment.id);
      }
      this.sealedRowIndex.push({ id: segment.id, start: rows.length, count: segmentRows.length });
      // 用循环 push：展开后的段可能有成百上千行，push(...rows) 会爆参数栈。
      for (const row of segmentRows) rows.push(row);
    }
    return rows;
  }

  /**
   * 记录视口首行所在的段与段内行号，供下一帧恢复滚动位置。
   * 贴底时不需要锚点：继续贴底就是正确行为。
   */
  private captureScrollAnchor(): void {
    if (this.chatScrollOffset <= 0) {
      this.pendingScrollAnchor = undefined;
      return;
    }
    const viewport = this.chatViewport;
    if (!viewport || this.sealedRowIndex.length === 0) return;
    const target = viewport.visibleStart;
    let picked = this.sealedRowIndex[0];
    for (const entry of this.sealedRowIndex) {
      if (entry.start <= target) picked = entry;
    }
    const rowInSegment = Math.min(picked.count - 1, Math.max(0, target - picked.start));
    this.pendingScrollAnchor = { segmentId: picked.id, rowInSegment, screenOffset: 0 };
  }

  /** 已封口区 + 尾部超过 200k 时从头丢整段，丢到 160k 以下。 */
  private enforceSegmentBudget(): void {
    const total = (): number =>
      this.sealedSegments.reduce((sum, segment) => sum + segment.raw.length, 0) +
      this.chatContent.length;
    if (total() <= 200_000) return;
    while (this.sealedSegments.length > 0 && total() > 160_000) {
      const dropped = this.sealedSegments.shift();
      if (dropped && this.pendingScrollAnchor?.segmentId === dropped.id) {
        this.pendingScrollAnchor = undefined;
      }
      this.sealedVersion += 1;
      this.selectionLayout = undefined;
    }
  }

  /** 切换某一段的展开状态；screenOffset 是被点摘要行在视口内的行位置。 */
  private toggleFoldSegment(segmentId: number, screenOffset: number): void {
    if (!this.foldEnabled) return;
    const segment = this.sealedSegments.find((item) => item.id === segmentId);
    if (segment?.kind !== "fold") return;
    segment.expanded = !segment.expanded;
    this.sealedVersion += 1;
    this.pendingScrollAnchor = {
      segmentId,
      rowInSegment: segment.headerRow ?? 0,
      screenOffset: Math.max(0, screenOffset),
    };
    this.textSelection.clear();
    this.selectionLayout = undefined;
    this.scheduleRender(true);
  }

  /** Ctrl+O：切换最新一个已封口的过程段。 */
  private toggleLatestFoldSegment(): void {
    const segment = [...this.sealedSegments].reverse().find((item) => item.kind === "fold");
    if (!segment || !this.foldEnabled) {
      this.showTransientHint("暂无可展开的过程");
      return;
    }
    const viewport = this.chatViewport;
    const entry = this.sealedRowIndex.find((item) => item.id === segment.id);
    let screenOffset = 0;
    if (viewport && entry) {
      const logical = entry.start + Math.min(segment.headerRow ?? 0, Math.max(0, entry.count - 1));
      if (logical >= viewport.visibleStart && logical < viewport.visibleEnd) {
        screenOffset = logical - viewport.visibleStart;
      }
    }
    this.toggleFoldSegment(segment.id, screenOffset);
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

    if (contentWithStatus === this.chatContent && this.sealedSegments.length === 0) {
      // 没有已封口段时，尾部就是全文：顺手把布局缓存给选区，省掉第一次拖选的全量扫描。
      const layout = performanceMonitor.measureSync("terminal.layout.full", () =>
        layoutAnsiDocument(contentWithStatus, width),
      );
      this.selectionLayout = layout;
      this.selectionLayoutContent = this.chatContent;
      this.selectionLayoutWidth = width;
      this.selectionLayoutSealedVersion = this.sealedVersion;
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
    // 渲染前归一化：制表符展开为固定宽度空列、泰/老挝 SARA AM 拆分，
    // 否则终端真的制表位会把已测量的行宽推超、自动折行撑破布局。
    const text = normalizeTerminalOutput(value);
    if (!this.interactive) {
      if (!this.outputMuted) stdout.write(text);
      return;
    }

    this.chatContent += text;
    if (this.chatContent.length > 200_000) {
      this.chatContent = this.chatContent.slice(-160_000);
      this.cachedContentWithStatus = "";
      this.setStableWrapPrefix("");
      this.chatEpoch += 1;
    }

    this.scheduleRender();
  }

  writeLine(value: string = ""): void {
    // 非交互（无头/管道）下提示性整行走 stderr，stdout 只保留流式正文与工具块。
    if (!this.interactive) {
      stderr.write(`${value}\n`);
      return;
    }
    this.writeChat(`${value}\n`);
  }
  /**
   * 写入恰好一个空行。
   * 当前内容未以换行结尾时先结束当前行（正文经 updateChatFrom 写入时不以换行结尾，
   * 直接 writeLine 只会补齐行尾而不会产生空行）。
   */
  writeBlankLine(): void {
    if (!this.interactive) {
      if (!this.outputMuted) stdout.write("\n");
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
    const text = normalizeTerminalOutput(value);
    if (!this.interactive) {
      stdout.write(text);
      return;
    }

    this.chatContent = text.length > 200_000 ? text.slice(-160_000) : text;
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
    this.sealedSegments = [];
    this.nextSegmentId = 1;
    this.foldHeaderRows.clear();
    this.sealedRowIndex = [];
    this.pendingScrollAnchor = undefined;
    this.selectionLayoutSealedVersion = -1;
    this.chatEpoch += 1;
    this.sealedVersion += 1;
    this.setStableWrapPrefix("");
    this.scheduleRender();
  }

  /**
   * 从指定偏置位置起覆盖更新聊天内容（用于 Markdown 流式平滑重绘）。
   * @param offset 偏移起始位置
   * @param value 新的文本内容
   */
  updateChatFrom(offset: number, value: string): void {
    const text = normalizeTerminalOutput(value);
    if (!this.interactive) {
      const delta = text.slice(Math.max(0, this.chatContent.length - offset));
      if (delta && !this.outputMuted) {
        stdout.write(delta);
      }
    }

    this.markStableChatPrefix(offset);
    this.chatContent = this.chatContent.slice(0, offset) + text;
    if (this.chatContent.length > 200_000) {
      this.chatContent = this.chatContent.slice(-160_000);
      this.cachedContentWithStatus = "";
      this.setStableWrapPrefix("");
      this.chatEpoch += 1;
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

  /**
   * 设置对话区底部的实时区域（例如正在执行的工具块）。它始终渲染在已提交
   * 正文之后，期间写入的普通消息会出现在它上方，不会被覆盖或打乱。
   * 非交互模式不输出中间帧，最终结果由调用方写入正文。
   */
  setLiveTail(value: string): void {
    if (value === this.liveTail) return;
    // 首次出现时固定正文前缀，动画帧只需重排实时区域本身。
    if (value && !this.liveTail) this.markStableChatPrefix();
    this.liveTail = value;
    if (this.interactive) this.scheduleRender();
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

    // 新一轮输入从未携带附件的干净状态开始，避免上轮残留图片跟随新 prompt 发送。
    this.pendingImages = [];
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
        openedAt: Date.now(),
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
      this.selectionLayoutWidth !== width ||
      this.selectionLayoutSealedVersion !== this.sealedVersion
    ) {
      this.selectionLayout = performanceMonitor.measureSync("terminal.layout.selection", () => {
        // 已封口段只贡献可见文本（折叠段就是摘要行），所以复制不会带出收起的内容。
        const layouts = this.sealedSegments.map((segment) => this.getSegmentLayout(segment, width));
        layouts.push(layoutAnsiDocument(this.chatContent, width));
        return layouts.length === 1 ? layouts[0] : concatAnsiLayouts(layouts);
      });
      this.selectionLayoutContent = this.chatContent;
      this.selectionLayoutWidth = width;
      this.selectionLayoutSealedVersion = this.sealedVersion;
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
    // 1003 any-event 跟踪下的纯移动（无按键按下）：只用于侧栏圆环的悬停提示。
    if (event.action === "move" && (event.button & 3) === 3) {
      this.updateSidebarHover(event.column, event.row);
      return;
    }
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
      const pending = this.pendingMouseSelection;
      this.pendingMouseSelection = undefined;
      this.selectionPointer = undefined;
      this.selectionLayout = undefined;
      // 单击 = 按下与松开在同一屏幕行：命中摘要行则切换该段，其余情况与今天一致。
      if (pending.row === event.row) {
        const segmentId = this.foldHeaderRows.get(pending.logicalRow);
        if (segmentId !== undefined) {
          const screenOffset = pending.row - (this.chatViewport?.screenTop ?? 0);
          this.toggleFoldSegment(segmentId, screenOffset);
        }
      }
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
    if (isRealCtrlO(value, key) && !this.activeSelection) {
      this.toggleLatestFoldSegment();
      return;
    }

    if (this.activeSelection) {
      this.handleSelectionKeypress(value, key);
    } else if (this.activeInput) {
      this.handleKeypress(value, key);
    } else {
      this.handleIdleKeypress(value, key);
    }
  };

  private readonly handleIdleKeypress = (value: string, key: readline.Key) => {
    if (isRealCtrlC(value, key)) {
      this.handleCtrlCInteraction();
      return;
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

  /**
   * Ctrl+C 防误触（与主流 CLI 一致）：
   * - 有选中文本：复制（保持现状）；
   * - 回合进行中：等同 Esc 中止回合，提示再按退出；
   * - 输入框有草稿：清空草稿（↑ 立即找回），提示再按退出；
   * - 空闲 / 空输入：第一次提示，2 秒内第二次退出（130）。
   */
  private handleCtrlCInteraction(): void {
    if (this.copyChatSelection()) {
      this.lastCtrlCAt = 0;
      return;
    }
    const repeated = Date.now() - this.lastCtrlCAt <= 2000;
    this.lastCtrlCAt = Date.now();

    // 回合进行中（onEscCallback 仅在回合内注册）：第一次等同 Esc 中止回合。
    if (this.onEscCallback && !repeated) {
      this.onEscCallback();
      this.showTransientHint("已请求中止当前回合 · 再按一次 Ctrl+C 退出");
      return;
    }

    const activeInput = this.activeInput;
    if (activeInput && activeInput.graphemes.length > 0 && !repeated) {
      this.ctrlCDraftStash = activeInput.graphemes.join("");
      activeInput.graphemes = [];
      activeInput.cursorIndex = 0;
      activeInput.preferredColumn = undefined;
      activeInput.selectedCommandIndex = 0;
      activeInput.commandNavigated = false;
      activeInput.historyNavigationActive = false;
      this.showTransientHint("草稿已清空（按 ↑ 立即找回）· 再按一次 Ctrl+C 退出");
      this.scheduleRender(true);
      return;
    }

    if (repeated) {
      this.close();
      process.exit(130);
    }
    this.showTransientHint("再按一次 Ctrl+C 退出");
  }

  private readonly handleProcessExit = () => {
    stdin.setRawMode(this.originalRawMode);
    stdout.write(
      "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1007l\x1b[?2004l\x1b[?25h\x1b[0m\x1b[2J\x1b[?1049l",
    );
  };

  /** 输入框上方的粘贴图片 chip 行：每张图显示为 [文件名]，Backspace 逐张移除。 */
  private buildPastedImageRows(width: number): string[] {
    if (this.pendingImages.length === 0 || !this.activeInput) return [];
    const chips = this.pendingImages.map(
      (image) => `${SEQ.softAccent}[${image.displayName}]${SEQ.reset}`,
    );
    return wrapAnsi(`  ${chips.join(" ")}`, width);
  }

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
    return matchSlashCommands(activeInput.graphemes.join(""), activeInput.slashCommands);
  }

  /** 当前输入尾部的 @ 文件引用词（如 "src/te"）；不在引用状态时返回 undefined。 */
  private detectFileMentionQuery(text: string): string | undefined {
    return /(?:^|\s)@([\w./\\:-]*)$/.exec(text)?.[1];
  }

  /** 依据当前输入刷新 @ 文件补全状态（候选变化时重置选中项）。 */
  private updateFileMentionState(): void {
    const activeInput = this.activeInput;
    if (!activeInput || activeInput.sensitive || !this.fileMentionProvider) {
      this.fileMentionQuery = "";
      this.fileMentionCandidates = [];
      this.fileMentionSelectedIndex = 0;
      return;
    }
    const query = activeInput.historyNavigationActive
      ? undefined
      : this.detectFileMentionQuery(activeInput.graphemes.join(""));
    if (query === undefined) {
      this.fileMentionQuery = "";
      this.fileMentionCandidates = [];
      this.fileMentionSelectedIndex = 0;
      return;
    }
    if (`@${query}` !== this.fileMentionQuery) {
      this.fileMentionQuery = `@${query}`;
      this.fileMentionCandidates = this.fileMentionProvider(query).slice(0, 8);
      this.fileMentionSelectedIndex = 0;
    }
  }

  /** 把选中的补全文件写回输入框：替换光标前的 @ 词，末尾补空格继续输入。 */
  private applyFileMentionCompletion(): boolean {
    const activeInput = this.activeInput;
    if (!activeInput) return false;
    const text = activeInput.graphemes.join("");
    const match = /(?:^|\s)(@[\w./\\:-]*)$/.exec(text.slice(0, activeInput.cursorIndex));
    const candidate = this.fileMentionCandidates[this.fileMentionSelectedIndex];
    if (!match || !candidate) return false;
    const replaceFrom = match.index + (match[0].startsWith(" ") ? 1 : 0);
    const before = text.slice(0, replaceFrom);
    const after = text.slice(activeInput.cursorIndex);
    activeInput.graphemes = splitGraphemes(`${before}@${candidate} ${after}`);
    activeInput.cursorIndex = splitGraphemes(`${before}@${candidate} `).length;
    activeInput.preferredColumn = undefined;
    activeInput.selectedCommandIndex = 0;
    activeInput.commandNavigated = false;
    this.fileMentionQuery = "";
    this.fileMentionCandidates = [];
    this.fileMentionSelectedIndex = 0;
    this.scheduleRender(true);
    return true;
  }

  private getCommandSuggestionRows(width: number, maxRows: number): string[] {
    const activeInput = this.activeInput;
    if (!activeInput || maxRows <= 0) {
      return [];
    }

    // @ 文件补全：候选优先于斜杠指令补全展示。
    this.updateFileMentionState();
    if (this.fileMentionCandidates.length > 0) {
      this.fileMentionSelectedIndex = Math.min(
        this.fileMentionSelectedIndex,
        this.fileMentionCandidates.length - 1,
      );
      return formatMenuRows(
        this.fileMentionCandidates.map((candidate) => ({
          label: candidate,
          description: "@ 引用文件",
        })),
        this.fileMentionSelectedIndex,
        width,
      );
    }

    const suggestions = this.getCommandSuggestions(activeInput);
    if (suggestions.length === 0) return [];

    activeInput.selectedCommandIndex = Math.min(
      activeInput.selectedCommandIndex,
      suggestions.length - 1,
    );
    // 候选多于可见行数时，窗口跟随选中项滚动。
    const visibleCount = Math.min(maxRows, suggestions.length);
    const windowStart = Math.min(
      Math.max(0, activeInput.selectedCommandIndex - visibleCount + 1),
      suggestions.length - visibleCount,
    );
    const visible = suggestions.slice(windowStart, windowStart + visibleCount);

    return formatMenuRows(
      visible.map((item) => ({
        label: item.argHint ? `${item.command} ${item.argHint}` : item.command,
        description: item.group ? `${item.description} · ${item.group}` : item.description,
      })),
      activeInput.selectedCommandIndex - windowStart,
      width,
    );
  }

  /**
   * 把选中的补全项写入输入框；需要参数的指令末尾补一个空格，便于继续输入。
   */
  private applyCommandSuggestion(activeInput: ActiveInput, item: SlashCommand): void {
    const text = item.argHint ? `${item.command} ` : item.command;
    activeInput.graphemes = splitGraphemes(text);
    activeInput.cursorIndex = activeInput.graphemes.length;
    activeInput.preferredColumn = undefined;
    activeInput.selectedCommandIndex = 0;
    activeInput.commandNavigated = false;
  }

  private getSelectionRows(width: number, maxRows: number): string[] {
    const activeSelection = this.activeSelection;
    if (!activeSelection || maxRows <= 0) {
      return [];
    }

    const { options } = activeSelection;
    const navigation =
      options.hint ??
      (options.secondary
        ? `↑↓ 选择 · ←→ ${options.secondary.label} · Enter 确认 · Esc 取消`
        : "↑↓ 选择 · Enter 确认 · Esc 取消");
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

    if (options.preview?.length) {
      // 至少给选项留出三行（或全部选项），其余高度给预览。
      const reservedItemRows = Math.min(options.items.length, 3);
      const previewBudget = Math.max(0, maxRows - rows.length - reservedItemRows);
      const bar = `${SEQ.muted}│${SEQ.reset} `;
      const lineWidth = Math.max(1, width - 2);
      const preview = options.preview;
      const fits = preview.length <= previewBudget;
      const shown = fits ? preview : preview.slice(0, Math.max(0, previewBudget - 1));
      for (const line of shown) rows.push(`${bar}${truncateAnsiText(line, lineWidth)}`);
      if (!fits && previewBudget > 0) {
        rows.push(
          `${bar}${SEQ.muted}${truncateText(`… 另有 ${preview.length - shown.length} 行（窗口高度不足）`, lineWidth)}${SEQ.reset}`,
        );
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

    rows.push(
      ...formatMenuRows(
        visibleItems.map((item) => ({
          label: `${item.label}${item.hotkey ? ` (${item.hotkey})` : ""}`,
          description: item.description,
        })),
        activeSelection.selectedIndex - firstVisibleIndex,
        width,
      ),
    );

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
    return buildStatusBarRow(
      {
        permissionMode: this.permissionMode,
        usedTokens: this.usedTokens,
        maxTokens: this.maxTokens,
        modelName: this.modelName,
        providerName: this.providerName,
        reasoningEffort: this.reasoningEffort,
        currentPath: this.currentPath,
      },
      width,
      detail,
    );
  }

  /**
   * 悬停提示需要 1003（any-event）跟踪，但它会让终端把所有鼠标移动都发上来。
   * 因此只在右侧栏真正显示的帧里开启，侧栏隐藏时立刻关闭，避免窄屏白付流量。
   */
  private setMouseMotionEnabled(enabled: boolean): void {
    if (this.mouseMotionEnabled === enabled) return;
    this.mouseMotionEnabled = enabled;
    stdout.write(enabled ? "\x1b[?1003h" : "\x1b[?1003l");
  }

  /** 鼠标移动时只关心是否进入/离开圆环命中区域，避免每次移动都重绘。 */
  private updateSidebarHover(column: number, row: number): void {
    const hit = this.sidebarRingHit;
    const hovered = Boolean(
      hit &&
        column >= hit.columnStart &&
        column <= hit.columnEnd &&
        row >= hit.rowStart &&
        row <= hit.rowEnd,
    );
    if (hovered === this.sidebarRingHovered) return;
    this.sidebarRingHovered = hovered;
    this.scheduleRender(true);
  }

  private buildSidebarState(): SidebarState {
    return {
      usedTokens: this.usedTokens,
      maxTokens: this.maxTokens,
      costCny: this.costCny,
      costRequests: this.costRequests,
      hasUnpricedCost: this.costHasUnpriced,
      promptTokens: this.costPromptTokens,
      completionTokens: this.costCompletionTokens,
      lastTurnMs: this.lastTurnMs,
      compactionCount: this.compactionCount,
      activity: this.activityFrame,
      taskPlan: this.taskPanelTitle
        ? {
            title: this.taskPanelTitle,
            items: this.taskPanelItems,
            expanded: this.taskPanelExpanded,
          }
        : undefined,
      agents: this.agentPanelItems,
    };
  }

  private buildActivityRow(width: number): string {
    // 活动行右侧徽标：权限档 + ctx 用量（长任务期间随时可见是否仍在全放行）。
    const badge: ActivityBadge | undefined =
      this.activityFrame && this.permissionMode
        ? {
            modeLabel: formatPermissionModeLabel(this.permissionMode),
            ctxRatio: this.usedTokens / Math.max(1, this.maxTokens),
          }
        : undefined;
    return buildActivityRow(this.activityFrame, width, badge);
  }

  private buildTaskPanel(width: number, maxRows = 8): string[] {
    return buildTaskPanelRows(
      {
        title: this.taskPanelTitle,
        items: this.taskPanelItems,
        expanded: this.taskPanelExpanded,
      },
      width,
      maxRows,
    );
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
    // 右侧会话信息栏：只占对话区高度，输入框与状态栏仍保持整行宽度。
    const sidebarWidth = resolveSidebarWidth(width, height, this.sidebarEnabled);
    const sidebarVisible = sidebarWidth > 0;
    const leftAreaWidth = Math.max(
      1,
      width - (sidebarVisible ? sidebarWidth + SIDEBAR_GAP_WIDTH : 0),
    );
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
    // 侧栏出现时任务与子代理面板搬进侧栏，避免与对话区上方重复占用高度。
    const taskRows = sidebarVisible
      ? []
      : this.buildTaskPanel(width, this.taskPanelExpanded ? panelBudget : Math.min(5, panelBudget));
    const agentRows = sidebarVisible
      ? []
      : this.buildAgentPanel(width, Math.max(0, panelBudget - taskRows.length));
    const topRows = [...headerRows, ...taskRows, ...agentRows];
    const divider = this.options.renderBorder(width);
    let inputLayout: VisibleInputLayout | undefined;
    let inputBlock: string[];
    let inputCursorOffset = 0;
    let historyDividerIndex = -1;

    const minimal = layout.mode === "minimal";
    const emergencyMinimal = minimal && height < 8;
    // 活动状态不再单独占用输入框上方一行，而是与状态栏共用底部这一行：
    // 有活动时顶替状态栏显示，空闲时才显示常规状态，因此聊天区高度不会随动画变化。
    // 临时提示（Ctrl+C 确认等）优先级介于两者之间：没有活动时占位、超时自动消失。
    // 侧栏出现时活动行搬进侧栏顶部（与任务/子代理面板同一策略），底部恢复常规状态行。
    const activityRow =
      (sidebarVisible ? "" : this.buildActivityRow(width)) ||
      (this.transientHintText ? truncateAnsiText(this.transientHintText, width) : "") ||
      (this.status ? truncateAnsiText(this.status, width) : "");
    const statusBar =
      !emergencyMinimal && activityRow
        ? activityRow
        : this.buildStatusBar(width, layout.statusDetail);
    const leadingInputRows: string[] = [];
    if (this.queueText) leadingInputRows.push(truncateAnsiText(this.queueText, width));
    const emergencyLeadingBudget = Math.max(0, height - 2);
    const visibleLeadingInputRows = emergencyMinimal
      ? emergencyLeadingBudget === 0
        ? []
        : leadingInputRows.slice(-emergencyLeadingBudget)
      : leadingInputRows;
    const emergencyStatusRows = emergencyMinimal && height < 2 ? [] : [statusBar];
    // 粘贴图片占输入框上方的行：文字输入行保持在 chip 下方。
    const pastedRows = this.buildPastedImageRows(width);

    if (this.activeSelection) {
      const maxSelectionRows = emergencyMinimal
        ? Math.max(1, height - visibleLeadingInputRows.length - emergencyStatusRows.length)
        : Math.max(1, height - topRows.length - visibleLeadingInputRows.length - (minimal ? 3 : 5));
      const selectionRows = this.getSelectionRows(width, maxSelectionRows);
      if (emergencyMinimal) {
        inputBlock = [...visibleLeadingInputRows, ...selectionRows, ...emergencyStatusRows];
      } else if (minimal) {
        inputBlock = [...visibleLeadingInputRows, ...selectionRows, statusBar];
      } else {
        historyDividerIndex = visibleLeadingInputRows.length;
        inputBlock = [...visibleLeadingInputRows, divider, ...selectionRows, divider, statusBar];
      }
    } else {
      const maxSuggestionRows = layout.showHints
        ? Math.max(
            0,
            height - topRows.length - visibleLeadingInputRows.length - pastedRows.length - 5,
          )
        : 0;
      const suggestionRows = this.getCommandSuggestionRows(width, maxSuggestionRows);
      const maxInputRows = emergencyMinimal
        ? Math.max(
            1,
            height -
              visibleLeadingInputRows.length -
              pastedRows.length -
              emergencyStatusRows.length,
          )
        : Math.max(
            1,
            height -
              topRows.length -
              visibleLeadingInputRows.length -
              pastedRows.length -
              suggestionRows.length -
              (minimal ? 3 : 5),
          );
      inputLayout = this.getInputLayout(width, maxInputRows);
      if (emergencyMinimal) {
        inputCursorOffset = visibleLeadingInputRows.length + pastedRows.length;
        inputBlock = [
          ...visibleLeadingInputRows,
          ...pastedRows,
          ...inputLayout.rows,
          ...emergencyStatusRows,
        ];
      } else if (minimal) {
        inputCursorOffset = visibleLeadingInputRows.length + pastedRows.length;
        inputBlock = [...visibleLeadingInputRows, ...pastedRows, ...inputLayout.rows, statusBar];
      } else {
        historyDividerIndex = visibleLeadingInputRows.length;
        inputCursorOffset = visibleLeadingInputRows.length + 1 + pastedRows.length;
        // 输入区上下各一条分隔线：中间是输入行与补全候选，底行由状态栏承担；
        // 有活动时活动状态顶替状态栏，不再单独占行。
        inputBlock = [
          ...visibleLeadingInputRows,
          divider,
          ...pastedRows,
          ...inputLayout.rows,
          ...suggestionRows,
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
    const chatWidth = Math.max(1, leftAreaWidth - chatPadding * 2);
    const contentWithStatus = this.liveTail
      ? `${this.chatContent}${this.chatContent && !this.chatContent.endsWith("\n") ? "\n" : ""}${this.liveTail}`
      : this.chatContent;
    const contentChanged =
      contentWithStatus !== this.cachedContentWithStatus || chatWidth !== this.cachedWrappedWidth;
    const previousWrappedCount = this.cachedWrappedChat.length;
    const tailRows = this.getWrappedChat(contentWithStatus, chatWidth);
    // 只有尾部会在底部增长；已封口区的行数变化一律交给滚动锚点处理。
    const tailRowDelta = tailRows.length - previousWrappedCount;
    const sealedRows = this.getSealedRows(chatWidth);
    const wrappedChat = sealedRows.length > 0 ? sealedRows.concat(tailRows) : tailRows;
    const chatViewportHeight = chatHeight;
    if (this.pendingScrollAnchor) {
      const anchor = this.pendingScrollAnchor;
      this.pendingScrollAnchor = undefined;
      const entry = this.sealedRowIndex.find((item) => item.id === anchor.segmentId);
      if (entry) {
        const logical = entry.start + Math.min(anchor.rowInSegment, Math.max(0, entry.count - 1));
        const desiredVisibleStart = Math.max(0, logical - anchor.screenOffset);
        this.chatScrollOffset = Math.max(
          0,
          wrappedChat.length - chatViewportHeight - desiredVisibleStart,
        );
      }
    } else if (contentChanged && this.chatScrollOffset > 0 && tailRowDelta !== 0) {
      this.chatScrollOffset = Math.max(0, this.chatScrollOffset + tailRowDelta);
    }
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
    const sidebarFrame = sidebarVisible
      ? buildSidebarFrame(
          this.buildSidebarState(),
          sidebarWidth,
          chatHeight,
          Date.now(),
          this.sidebarRingHovered,
        )
      : { rows: [] as string[], ring: undefined };
    const sidebarRows = sidebarFrame.rows;
    // 记录圆环在屏幕上的 1-based 命中区域，供鼠标移动时判断悬停。
    if (sidebarVisible && sidebarFrame.ring) {
      const columnStart = leftAreaWidth + SIDEBAR_GAP_WIDTH + 1 + sidebarFrame.ring.left;
      this.sidebarRingHit = {
        columnStart,
        columnEnd: columnStart + sidebarFrame.ring.width - 1,
        rowStart: (emergencyMinimal ? 0 : topRows.length + 1) + sidebarFrame.ring.top + 1,
        rowEnd: 0,
      };
      this.sidebarRingHit.rowEnd = this.sidebarRingHit.rowStart + sidebarFrame.ring.height - 1;
    } else {
      this.sidebarRingHit = undefined;
      this.sidebarRingHovered = false;
    }
    this.setMouseMotionEnabled(sidebarVisible);
    const chatRows = [...visibleChat, ...new Array(chatHeight - visibleChat.length).fill("")].map(
      (row, index) =>
        sidebarVisible
          ? composeSidebarRow(row, leftAreaWidth, sidebarRows[index] ?? "", sidebarWidth)
          : row,
    );
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

    // 同步输出（DECSET 2026）：一帧内的光标/擦除/重写/光标定位作为一个原子刷新交给
    // 终端，避免逐条转义序列被扫描到一半时的撕裂与闪烁。不支持的终端会忽略该私模式。
    let frame = "\x1b[?2026h\x1b[?25l";
    if (fullRefresh) frame += `${themeEnter()}\x1b[2J`;
    frame += screenUpdate;
    frame += cursorState;
    frame += "\x1b[?2026l";
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
    this.ctrlCDraftStash = "";
    this.fileMentionQuery = "";
    this.fileMentionCandidates = [];
    this.fileMentionSelectedIndex = 0;
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
    activeInput.commandNavigated = false;
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

    // Ctrl+C 清空的草稿在 ↑ 时优先完整找回（一次性，随后回到正常历史浏览）。
    if (direction === -1 && this.ctrlCDraftStash && activeInput.graphemes.length === 0) {
      activeInput.graphemes = splitGraphemes(this.ctrlCDraftStash);
      activeInput.cursorIndex = activeInput.graphemes.length;
      activeInput.preferredColumn = undefined;
      this.ctrlCDraftStash = "";
      this.scheduleRender(true);
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
    activeInput.commandNavigated = false;
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
    // Tab 在选择器里循环切换次级轴（授权卡的永久允许作用域 本项目 ⇄ 全局）。
    if ((key.name === "tab" && !key.shift) || key.name === "backtab" || value === "\x1b[Z") {
      if (activeSelection.options.secondary) {
        const itemCount = activeSelection.options.secondary.items.length;
        const backward =
          key.name === "backtab" || value === "\x1b[Z" || (key.shift && key.name === "tab");
        if (backward) {
          activeSelection.secondaryIndex =
            (activeSelection.secondaryIndex - 1 + itemCount) % itemCount;
        } else {
          activeSelection.secondaryIndex = (activeSelection.secondaryIndex + 1) % itemCount;
        }
        this.scheduleRender(true);
      }
      return;
    }
    const confirmLocked =
      Date.now() - (activeSelection.openedAt ?? 0) < (activeSelection.options.confirmDelayMs ?? 0);
    if (key.name === "return" || key.name === "enter") {
      if (confirmLocked) return;
      this.finishSelection();
      return;
    }
    const hotkeyIndex =
      value && !key.ctrl && !key.meta
        ? activeSelection.options.items.findIndex(
            (item) => item.hotkey && item.hotkey.toLowerCase() === value.toLowerCase(),
          )
        : -1;
    if (hotkeyIndex >= 0) {
      if (confirmLocked) return;
      activeSelection.selectedIndex = hotkeyIndex;
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
    // Ctrl+V / Alt+V：剪贴板位图落盘并作为本轮图片附件挂在输入框上方，Enter 提交时交给模型 read。
    if (key.name === "v" && ((key.ctrl && !key.shift) || (key.meta && !key.ctrl))) {
      void this.captureClipboardAttachment();
      return;
    }
    if (isRealCtrlC(value, key)) {
      this.handleCtrlCInteraction();
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
        // @ 文件补全展开中：Enter 先完成补全，不提交输入。
        this.updateFileMentionState();
        if (this.fileMentionCandidates.length > 0 && this.applyFileMentionCompletion()) {
          return;
        }
        const suggestions = this.getCommandSuggestions(activeInput);
        const typed = activeInput.graphemes.join("").trim().toLowerCase();
        const typedIsCommand = activeInput.slashCommands.some(
          (item) => item.command.toLowerCase() === typed,
        );
        // 未用方向键挑选且输入已是完整指令时直接执行输入本身（如 “/provider ” 不会误选子命令）。
        if (suggestions.length > 0 && (activeInput.commandNavigated || !typedIsCommand)) {
          const selected =
            suggestions[Math.min(activeInput.selectedCommandIndex, suggestions.length - 1)];
          if (selected.argRequired) {
            // 必填参数的指令只填入，等待用户补充参数。
            this.applyCommandSuggestion(activeInput, selected);
            this.scheduleRender(true);
            return;
          }
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
          activeInput.commandNavigated = false;
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
          activeInput.commandNavigated = false;
          activeInput.historyNavigationActive = false;
          this.scheduleRender(true);
        });
      }
      return;
    }

    if (key.name === "backspace") {
      if (activeInput.cursorIndex === 0 && this.pendingImages.length > 0) {
        // 输入框为空时 Backspace 先摘掉最后一张粘贴图片。
        this.pendingImages = this.pendingImages.slice(0, -1);
        this.scheduleRender(true);
        return;
      }
      if (activeInput.cursorIndex > 0) {
        activeInput.graphemes.splice(activeInput.cursorIndex - 1, 1);
        activeInput.cursorIndex -= 1;
        activeInput.preferredColumn = undefined;
        activeInput.selectedCommandIndex = 0;
        activeInput.commandNavigated = false;
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
        activeInput.commandNavigated = false;
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
      this.updateFileMentionState();
      if (this.fileMentionCandidates.length > 0) {
        const mentionDirection = key.name === "up" ? -1 : 1;
        this.fileMentionSelectedIndex =
          (this.fileMentionSelectedIndex + mentionDirection + this.fileMentionCandidates.length) %
          this.fileMentionCandidates.length;
        this.scheduleRender(true);
        return;
      }
      const suggestions = this.getCommandSuggestions(activeInput);
      if (suggestions.length > 0) {
        const direction = key.name === "up" ? -1 : 1;
        activeInput.selectedCommandIndex =
          (activeInput.selectedCommandIndex + direction + suggestions.length) % suggestions.length;
        activeInput.commandNavigated = true;
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
      activeInput.commandNavigated = false;
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
      this.updateFileMentionState();
      if (this.fileMentionCandidates.length > 0) {
        this.applyFileMentionCompletion();
        return;
      }
      const suggestions = this.getCommandSuggestions(activeInput);
      if (suggestions.length > 0) {
        // Tab 只补全，不执行。
        this.applyCommandSuggestion(
          activeInput,
          suggestions[Math.min(activeInput.selectedCommandIndex, suggestions.length - 1)],
        );
        this.scheduleRender(true);
        return;
      }
      this.insert("  ");
      return;
    }

    if (!key.ctrl && !key.meta && value && !value.startsWith("\x1b")) {
      this.insert(value);
    }
  };
}
