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
import type { ContextBreakdown, ContextItemGroup } from "./context-breakdown.js";
import {
  buildContextInspectorFrame,
  CONTEXT_INSPECTOR_MIN_COLUMNS,
  CONTEXT_INSPECTOR_MIN_ROWS,
  type ContextInspectorFrame,
} from "./context-inspector.js";
import {
  buildCostLogFrame,
  COST_LOG_MIN_COLUMNS,
  COST_LOG_MIN_ROWS,
  type CostLogFrame,
  type CostLogSort,
} from "./cost-log-page.js";
import type { RequestCostDetail } from "./cost-tracker.js";
import {
  type FileMentionPreview,
  fileMentionQuery,
  formatFileMention,
  removeFileMention,
} from "./file-mentions.js";
import { ClipboardWriter, InputHistoryBuffer } from "./input-history.js";
import {
  buildInputSelectionGeometry,
  type InputSelectionGeometry,
  inputCellFromPoint,
  inputRowHighlightSpan,
} from "./input-selection.js";
import {
  type ContextInspectorState,
  type CostLogPageState,
  costLogKeyCommand,
  costLogLayer,
  enterTurnDetail,
  inspectorKeyCommand,
  moveCostLogSelection,
  moveInspectorCategory,
  moveInspectorItem,
  type OverlayHit,
  overlayClickTarget,
  scrollInspector,
  selectCostLogItem,
  selectInspectorItem,
} from "./overlay-navigation.js";
import { paperSidebarEnabled } from "./paper-sidebar.js";
import {
  buildFoldHeader,
  type ChatSegmentView,
  type FoldGroupStats,
  renderSegmentText,
  splitBlankEdges,
} from "./process-fold.js";
import {
  buildRequestDetailFrame,
  REQUEST_DETAIL_MIN_COLUMNS,
  REQUEST_DETAIL_MIN_ROWS,
  type RequestDetailFrame,
} from "./request-detail-page.js";
import { buildStartupHome, type RecentSessionEntry, startupActions } from "./startup-home.js";
import {
  buildStartupLauncher,
  STARTUP_MOTION_MS,
  STARTUP_PLACEHOLDERS,
  startupLauncherGeometry,
} from "./startup-launcher.js";
import {
  buildInlineImage,
  clipInlinePlacement,
  diffInlinePlacements,
  encodeDeleteImages,
  encodeKittyImageDispose,
  encodeKittyPlacement,
  encodeKittyPlacementDelete,
  encodeKittyUpload,
  fitImageCells,
  type ImageProtocol,
  INLINE_IMAGE_MAX_ROWS,
  type InlineImageDescription,
  type InlinePlacementSpec,
} from "./terminal-image.js";
import {
  isRealCtrlC,
  isRealCtrlD,
  isRealCtrlE,
  isRealCtrlO,
  isRealCtrlT,
  isRealCtrlU,
} from "./terminal-keys.js";
import { formatMenuRows, windowMenuRows } from "./terminal-menu.js";
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
  buildScreenUpdate,
  buildScrollJumpHint,
  buildScrollJumpHintLine,
  buildViewportScrollUpdate,
  cellAtColumn,
  concatAnsiLayouts,
  DEFAULT_CHAT_PADDING,
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
import {
  renderToolBlockRows,
  type ToolBlockRenderInfo,
  type ToolBlockWrite,
} from "./tool-block-fold.js";
import { resolveHintRowBudget, resolveTuiLayout, type TuiStatusDetail } from "./tui-layout.js";
import {
  buildContextCard,
  buildSidebarFrame,
  composeSidebarRow,
  resolveSidebarWidth,
  SIDEBAR_GAP_WIDTH,
  type SidebarGoalState,
  type SidebarPricingAgentState,
  type SidebarState,
} from "./tui-sidebar.js";
import {
  buildTurnDetailFrame,
  TURN_DETAIL_MIN_COLUMNS,
  TURN_DETAIL_MIN_ROWS,
  type TurnDetailFrame,
} from "./turn-detail-page.js";
import type { WorkspaceStatus } from "./workspace-status.js";

export { type AgentPanelItem, buildAgentPanelRows, formatAgentElapsed } from "./agent-panel.js";
// 保持既有 dist/terminal-input.js 导出面的兼容：拆分后的符号在此统一转发。
export { ClipboardWriter, InputHistoryBuffer } from "./input-history.js";
export { shouldRestartBackgroundInput } from "./terminal-keys.js";
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

/** 拆分转义序列（鼠标/粘贴）等待后续字节的上限，宽松一些以兼容慢速链路。 */
const PROTOCOL_FLUSH_MS = 80;
/** 单独 Esc 的确认窗口：只等可能紧跟的 Alt 组合键，等太久会让中止明显迟滞。 */
const LONE_ESCAPE_FLUSH_MS = 16;
/** 对话区尾部活动行占用的行数：与正文之间的空行 + 活动行本身。 */
const CHAT_ACTIVITY_ROWS = 2;
/** 详情页里 PgUp/PgDn 与滚轮一次翻多少行原文（按屏高太小、按行太碎）。 */
/** 滚轮一格对应的原文行数。 */
const INSPECTOR_WHEEL_ROWS = 3;

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

/** 全屏查看图片的状态：序列已按终端协议编码好，TUI 只负责贴到屏幕上。 */
export interface ImageOverlayView {
  protocol: ImageProtocol;
  sequence: string;
  cols: number;
  rows: number;
  caption: string;
  tmux: boolean;
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
  /**
   * 非交互模式的正文出口（默认 process.stdout）。驱动服务（`haji mcp-serve`）用它
   * 把正文/工具块接进事件总线，而不是写到已被 MCP 协议占用的 stdout。
   */
  outputSink?: (text: string) => void;
  /** 非交互模式的提示性输出出口（默认 process.stderr）。 */
  errorSink?: (text: string) => void;
  /** 点击侧栏里某个可交互区域：id 见 tui-sidebar.ts 的 SidebarRegionId，映射由调用方负责。 */
  onSidebarAction?: (id: string) => void;
  /** 首屏选中历史会话，由主循环安全接管并恢复。 */
  onResumeSession?: (id: string) => void;
  /**
   * 首屏启动动效（标语解码 / Logo 高光 / 星点闪烁，约 1.8 秒后静止）。
   * 默认关闭，由入口按交互模式开启；`HAJI_REDUCED_MOTION=1` 时强制关闭。
   */
  startupMotion?: boolean;
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
  /** 搜索用的兼容别名；候选仍显示并填入规范指令。 */
  aliases?: readonly string[];
  /** 所属枢纽名（如“模型与配置”），模糊搜索命中非顶层条目时作为来源标签显示。 */
  group?: string;
  /** 参数格式提示（如 `<id>`），显示在补全标签之后。 */
  argHint?: string;
  /** 参数为必填：Enter 只把指令填入输入框，等待补充参数。 */
  argRequired?: boolean;
  /** 只输入 `/` 时列出的顶层条目。 */
  topLevel?: boolean;
  /** 回合进行中可立即执行（不进待处理队列），见 cli-help.ts 的 immediate 元数据。 */
  immediate?: boolean;
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
  /** 输入关键词筛选选项，仅供显式开启的列表使用。 */
  searchable?: boolean;
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
  query?: string;
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
/**
 * 内联图段：kind === "image" 时有效。placementId 固定为 1
 * （每张图只维护一个 placement，移动靠同 (image id, placement id) 重放替换）。
 */
const INLINE_PLACEMENT_ID = 1;
/**
 * 滚动微调节流间隔：滚过图片时每行都会产生新的行位/裁剪，逐帧重放 a=p 会让
 * 终端反复重缩放位图（快速滚动时明显卡顿）。限频后滚动期间终端自行让图跟随
 * 文本滚动，收尾帧把最终位置精确对齐；上传 / 删除 / 首次放置不受节流影响。
 */
const INLINE_IMAGE_SCROLL_NUDGE_MS = 80;

/** 已封口段内的工具块：start/end 是 segment.raw 内的字符区间（提交格原文）。 */
interface SealedToolBlock {
  id: number;
  start: number;
  end: number;
  info: ToolBlockRenderInfo;
  expanded: boolean;
}

/** 块在本段可见行里的落位（渲染时记录，供命中表/点击/滚动锚点换算）。 */
interface ToolBlockRowSpan {
  blockId: number;
  startRow: number;
  endRow: number;
  headerRow: number;
  indicatorRow?: number;
}

interface ChatSegment {
  id: number;
  kind: "plain" | "fold" | "image";
  raw: string;
  stats?: FoldGroupStats;
  expanded: boolean;
  /** 段内工具块（二级折叠）；fold 段收起时整段只有摘要行，块不可见。 */
  blocks?: SealedToolBlock[];
  /** 本帧各块的行落位；与 rows 同批缓存。 */
  blockSpans?: ToolBlockRowSpan[];
  /** kind === "image" 时的内联图状态（placement 生命周期挂在段上）。 */
  image?: InlineImageSegmentState;
  /** 缓存键 `${width}|${expanded}|${foldEnabled}|块状态`，命中则直接复用 rows / layout。 */
  cacheKey?: string;
  /** 去掉末尾光标行后的换行结果。 */
  rows?: string[];
  /** 选区用的独立布局（惰性计算，末尾光标行保留给 concatAnsiLayouts 处理）。 */
  layout?: AnsiTextLayout;
  /** 摘要行在段内的行号（= 首部空行数）。 */
  headerRow?: number;
}

/**
 * 内联图段的运行态：数据只上传一次，placement 随帧同步。
 * uploaded/placed 挂在段上而不是全局表——段被丢弃（预算回收 / 清屏）时一起消失。
 */
interface InlineImageSegmentState {
  desc: InlineImageDescription;
  /** kitty image id（终端侧数据键）；placementId 固定 1，每图一个 placement。 */
  kittyId: number;
  uploaded: boolean;
  /** 当前已在屏幕上的 placement（1 基屏幕坐标）；undefined = 未放置。 */
  placed?: InlinePlacementSpec;
  /** 当前宽度下的折算结果（缓存，宽度变化时由 cacheKey 失效重算）。 */
  fitted?: { cols: number; rows: number };
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
  /** 段内工具块（区间相对 raw）：/resume 回放据此恢复二级折叠与点击/悬停。 */
  blocks?: readonly ToolBlockWrite[];
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
    // 图片段不走文本折行路径（renderSegmentRows 已提前分支），这里按 plain 兜底。
    kind: segment.kind === "image" ? "plain" : segment.kind,
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

/**
 * 输入行被鼠标交互（侧栏点击等）临时接管。
 * 刻意不继承 TerminalInputCancelledError：用户取消（Ctrl+D）会让主循环退出，
 * 而接管只是换一个交互继续，主循环必须继续等下一轮输入而不是收摊。
 */
export class TerminalInputTakenOverError extends Error {
  constructor() {
    super("Terminal input taken over");
    this.name = "TerminalInputTakenOverError";
  }
}

/**
 * 输入行已被占用：另一个输入请求或选择器还没结束。
 * 单独成类是为了让主循环能把「偶发竞态」和真正的编码错误区分开——
 * 前者等空闲后重取输入，不该把整场会话崩掉。
 */
export class TerminalInputBusyError extends Error {
  constructor() {
    super("已有输入请求正在等待处理");
    this.name = "TerminalInputBusyError";
  }
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
  /**
   * 内联图的 kitty image id 分配器。从 2 起：1 留给 /view 的整屏贴图
   * （其关闭时 a=d,d=A 会释放所有图数据，两者本就不该共存）。
   */
  private nextKittyImageId = 2;
  /** 上次对已放置的内联图发出 a=p 的时刻（滚动微调节流用）。 */
  private inlineImageLastPlaceAt = 0;
  /** 有被节流抑制的滚动微调还没落地：帧渲染的提前返回要给它让路。 */
  private inlineImageNudgePending = false;
  private inlineImageSettleTimer: ReturnType<typeof setTimeout> | null = null;
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
  /** 尾部（未封口）工具块：start/end 相对 chatContent；sealFoldGroup 时转成段内区间。 */
  private tailToolBlocks: Array<{
    id: number;
    start: number;
    end: number;
    info: ToolBlockRenderInfo;
    expanded: boolean;
  }> = [];
  private nextToolBlockId = 1;
  /** 逻辑行 → 块 id（头行与折叠指示行可点击）；每帧随已封口区渲染重建。 */
  private readonly toolBlockHits = new Map<number, number>();
  /** 块 id → 本帧逻辑行区间（整块范围，悬停判定用）。 */
  private readonly toolBlockRanges = new Map<number, { startRow: number; endRow: number }>();
  /** 对话区悬停目标：工具块或过程段摘要行；指针移开/目标消失时清空。 */
  private chatHoverTarget: { type: "block"; id: number } | { type: "fold"; id: number } | undefined;
  /** 下一帧要应用的滚动锚点（切换展开 / 封口时设置）。 */
  private pendingScrollAnchor?: { segmentId: number; rowInSegment: number; screenOffset: number };
  private chatScrollOffset = 0;
  private maxChatScrollOffset = 0;
  private chatPageSize = 1;
  /** 「回到底部」浮标本帧的屏幕命中区（1 基）；未绘制时清空。 */
  private chatHintHit?: {
    columnStart: number;
    columnEnd: number;
    rowStart: number;
    rowEnd: number;
  };
  /** 按下浮标时的屏幕行：松开仍落在浮标内才算一次点击。 */
  private pendingChatHintClick?: number;
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
  /** 上下文分项估算（圆环悬停卡片用）；拿不到时不弹卡片。 */
  private contextBreakdown?: ContextBreakdown;
  /**
   * 上下文详情页状态；undefined 表示页面关闭。
   * 打开时侧栏临时收起，对话区整块换成「分类 / 条目 / 原文」两栏。
   */
  private contextInspector?: ContextInspectorState;
  /** 详情页的数据来源：打开那一刻取一次快照（页面只读，回合更新不回溯）。 */
  private contextItemsProvider?: () => ContextItemGroup[];
  /** 上一帧的命中区域（屏幕绝对行，1 基）；点击条目与「Esc 返回」用。 */
  private contextInspectorHit?: OverlayHit;
  /** 上一帧原文区可滚动上限：PgUp/PgDn 与滚轮据此夹紧。 */
  private inspectorMaxScroll = 0;
  /**
   * 费用日志页状态；undefined 表示页面关闭。
   * 与上下文详情页同构：打开时收起侧栏，对话区整块换成「每次请求一行」的列表。
   */
  private costLog?: CostLogPageState;
  /** 费用日志页的数据来源：打开那一刻取一次快照（页面只读，回合更新不回溯）。 */
  private costLogProvider?: (sort: CostLogSort) => RequestCostDetail[];
  /** 上一帧的命中区域（屏幕绝对行列，1 基）；点击行与「Esc 返回」用。 */
  private costLogHit?: OverlayHit;
  /** 侧栏显示时对话区最右列（1-based）；0 表示侧栏隐藏，鼠标可整行选字。 */
  private chatAreaRightEdgeColumn = 0;
  /** 右侧会话信息栏（默认开启，可在 /config 中关闭并持久化）。 */
  private sidebarEnabled = true;
  private contextPulseAt?: number;
  private costPulseAt?: number;
  private goalPulseAt?: number;
  private taskPulseAt?: number;
  private costDetailsPulseAt?: number;
  private sidebarPulseTimer: NodeJS.Timeout | null = null;
  private costCny?: number;
  private costRequests = 0;
  private costHasUnpriced = false;
  private costPromptTokens = 0;
  private costCompletionTokens = 0;
  /** 其中命中缓存的输入 token（用来解释费用为何低于全价估算）。 */
  private costCachedPromptTokens = 0;
  /** 按谷时价计费的请求数。 */
  private costOffPeakRequests = 0;
  /** 仍未定价的模型名：侧栏费用区据此显示可点击的配置入口。 */
  private costUnpricedModels: string[] = [];
  /** 后台定价 agent 的状态行；undefined 表示没有在跑也没有结果。 */
  private pricingAgentState?: SidebarPricingAgentState;
  /**
   * 侧栏费用明细（请求/输入/缓存/谷时/输出/上一轮）是否展开。
   * 默认折叠：常驻只留「花费 + 需处理项」，逐条明细本就在费用日志页里。
   */
  private costDetailRowsExpanded = false;
  /** 会话目标（/goal 设定）；undefined 表示未设定，侧栏不渲染目标区块。 */
  private sidebarGoal?: SidebarGoalState;
  /** 上一轮回合耗时（ms）；undefined 表示本会话还没跑完一轮。 */
  private lastTurnMs?: number;
  /** 本会话上下文压缩次数（自动 + 手动）；用于解释圆环为何突然掉下来。 */
  private compactionCount = 0;
  /**
   * 侧栏命中区：区域 id → 本帧的屏幕坐标（每帧渲染时重建）。
   *
   * Map 的插入顺序就是 depth 升序，命中时从后往前找，深层（定价 agent 行、
   * 配置单价行）自然压过外层费用区块。用一张表代替每个区域一组
   * hovered/hit/pending 字段，新增可点区域不必再改这里。
   */
  private sidebarHits = new Map<
    string,
    { columnStart: number; columnEnd: number; rowStart: number; rowEnd: number }
  >();
  /** 当前鼠标压住的侧栏区域 id；只影响变色与浮层卡片，不改变行数。 */
  private sidebarHoverId?: string;
  /** 按下时记下的区域 id 与屏幕行：松开仍同 id、同一行才算一次点击。 */
  private pendingSidebarClick?: { id: string; row: number };
  /** 详情页内的按下行：松开同一行才处理点击（选中条目 / 点返回）。 */
  private pendingInspectorClickRow?: number;
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
  /** 等输入行空闲的挂起者：input/selection 全部收尾时统一唤醒。 */
  private inputIdleWaiters: Array<() => void> = [];
  private chatViewport?: ChatViewport;
  private selectionLayout?: AnsiTextLayout;
  private pendingMouseSelection?: PendingMouseSelection;
  /** 输入框自己的选区：与对话区互斥，复制的是输入的原文而不是渲染行。 */
  private readonly inputSelection = new TextSelectionModel();
  private inputSelectionGeometry?: InputSelectionGeometry;
  /** 输入框正文首行在屏幕上的 0-based 行号与行数（鼠标命中判定用）。 */
  private inputSelectionTop?: number;
  private inputSelectionHeight = 0;
  /** 输入组件局部坐标到屏幕的水平偏移；对话输入为 0，居中首屏为左留白。 */
  private inputSelectionLeft = 0;
  private renderedInputWidth?: number;
  /** 按下但还没移动：单击输入框不产生选区，拖动才算选中。 */
  private pendingInputSelection?: { column: number; row: number };
  private selectionPointer?: { column: number; row: number };
  private selectionLayoutContent = "";
  private selectionLayoutWidth = 0;
  /** 选区布局缓存对应的已封口区版本号。 */
  private selectionLayoutSealedVersion = -1;
  private originalRawMode = false;
  private onShiftTabCallback?: () => void;
  private onEscCallback?: () => void;
  /** 被 pushEscHandler 临时压栈的上层处理器，弹出时原样恢复。 */
  private escHandlerStack: Array<() => void> = [];
  private queueText = "";
  private queuedInputs: string[] = [];
  private queueSteerCallback?: (index: number, text: string) => boolean;
  private steerEnabled = false;
  private queueSteerHits: Array<{
    row: number;
    left: number;
    right: number;
    index: number;
    text: string;
  }> = [];
  private pendingQueueSteer?: {
    row: number;
    left: number;
    right: number;
    index: number;
    text: string;
  };

  onQueueSteer(callback: (index: number, text: string) => boolean): void {
    this.queueSteerCallback = callback;
  }

  setSteerEnabled(enabled: boolean): void {
    this.steerEnabled = enabled;
    this.queueSteerHits = [];
    this.pendingQueueSteer = undefined;
    this.scheduleRender(true);
  }

  private steerQueueItem(index: number, text: string): void {
    if (
      !this.steerEnabled ||
      this.inputManager?.draft ||
      this.queuedInputs[index] !== text ||
      text.trimStart().startsWith("/")
    )
      return;
    if (this.queueSteerCallback?.(index, text)) {
      this.setQueue(this.queuedInputs);
      this.showTransientHint("steer 已提交，将在安全点应用");
    }
  }

  private getQueueRows(width: number, maxItems: number): string[] {
    if (!this.queuedInputs.length || maxItems <= 0) return [];
    const rows = [
      truncateText(`待发送 (${this.queuedInputs.length} 条 · Alt+Q 管理 · 本轮结束后发送)`, width),
    ];
    for (let index = 0; index < Math.min(maxItems, this.queuedInputs.length); index++) {
      const text = this.queuedInputs[index];
      const button = this.steerEnabled && !text.trimStart().startsWith("/") ? "[steer] " : "";
      rows.push(
        truncateText(
          ` ${button}${index + 1}. ${redactSensitiveCommand(sanitizeTerminalText(text)).replace(/\s*\n\s*/g, " ")}`,
          width,
        ),
      );
    }
    if (this.queuedInputs.length > maxItems) rows.push(truncateText("… Alt+Q 查看其余消息", width));
    return rows;
  }

  private updateQueueSteerHits(rows: string[], screenTop: number): void {
    this.queueSteerHits = [];
    if (!this.steerEnabled || this.activeSelection || this.inputManager?.draft) return;
    for (let offset = 0; offset < rows.length; offset++) {
      const plain = rows[offset].replace(/\x1b\[[0-9;]*m/g, "");
      const match = /^\s*›?\s*\[steer\] (\d+)\./u.exec(plain);
      if (!match) continue;
      const index = Number(match[1]) - 1;
      const text = this.queuedInputs[index];
      if (text === undefined) continue;
      const left = plain.indexOf("[steer]") + 1;
      this.queueSteerHits.push({ row: screenTop + offset, left, right: left + 6, index, text });
    }
  }

  private queueSteerHitAt(column: number, row: number) {
    return this.queueSteerHits.find(
      (hit) => hit.row === row && column >= hit.left && column <= hit.right,
    );
  }
  private inputManager?: {
    kind: "queue" | "attachments";
    selected: number;
    draft?: ActiveInput;
    original?: string;
  };
  private inputManagerWaiters: Array<() => void> = [];
  private attachmentInspector?: (input: string) => FileMentionPreview[];
  private attachmentCache?: { input: string; at: number; items: FileMentionPreview[] };

  setAttachmentInspector(inspect: (input: string) => FileMentionPreview[]): void {
    this.attachmentInspector = inspect;
    this.attachmentCache = undefined;
  }

  /** 队列编辑期间延后取出下一条消息，避免编辑到已开始执行的项。 */
  waitForInputManagement(): Promise<void> {
    if (!this.inputManager) return Promise.resolve();
    return new Promise((resolve) => this.inputManagerWaiters.push(resolve));
  }

  private closeInputManager(): void {
    if (this.inputManager?.draft) this.activeInput = this.inputManager.draft;
    this.inputManager = undefined;
    for (const resolve of this.inputManagerWaiters.splice(0)) resolve();
    this.scheduleRender(true);
  }

  private getFileAttachments(): FileMentionPreview[] {
    const input = this.activeInput?.graphemes.join("") ?? "";
    if (!this.activeInput || this.activeInput.sensitive || input.trimStart().startsWith("/"))
      return [];
    if (
      !this.attachmentCache ||
      this.attachmentCache.input !== input ||
      Date.now() - this.attachmentCache.at > 1000
    ) {
      this.attachmentCache = {
        input,
        at: Date.now(),
        items: this.attachmentInspector?.(input) ?? [],
      };
    }
    return this.attachmentCache.items;
  }

  private openInputManager(kind: "queue" | "attachments"): void {
    if (!this.activeInput || this.activeInput.sensitive) return;
    if (this.inputManager) {
      this.closeInputManager();
      return;
    }
    if (kind === "queue" && this.queuedInputs.length === 0) {
      this.showTransientHint("暂无待发送消息");
      return;
    }
    if (
      kind === "attachments" &&
      this.getFileAttachments().length === 0 &&
      this.pendingImages.length === 0
    ) {
      this.showTransientHint("暂无附件 · 使用 @路径 或粘贴图片");
      return;
    }
    this.inputManager = { kind, selected: 0 };
    this.scheduleRender(true);
  }

  private handleInputManagerKey(value: string, key: readline.Key): boolean {
    const manager = this.inputManager;
    if (!manager) return false;
    if (key.name === "escape" || isRealCtrlC(value, key)) {
      this.closeInputManager();
      return true;
    }
    if (manager.draft) {
      if ((key.name === "return" || key.name === "enter") && !key.shift && !key.meta) {
        const edited = this.activeInput?.graphemes.join("").trim() ?? "";
        if (!edited) {
          this.showTransientHint("消息不能为空 · Esc 取消编辑");
          return true;
        }
        // 授权等交互可能接管输入；旧项已变化时不覆盖其他消息。
        if (this.queuedInputs[manager.selected] === manager.original) {
          this.queuedInputs[manager.selected] = edited;
          this.setQueue(this.queuedInputs);
        }
        this.closeInputManager();
        return true;
      }
      return false;
    }
    const count =
      manager.kind === "queue"
        ? this.queuedInputs.length
        : this.getFileAttachments().length + this.pendingImages.length;
    manager.selected = Math.max(0, Math.min(manager.selected, count - 1));
    if (value === "s" && manager.kind === "queue" && count > 0) {
      this.steerQueueItem(manager.selected, this.queuedInputs[manager.selected]);
      if (!this.queuedInputs.length) this.closeInputManager();
      else manager.selected = Math.min(manager.selected, this.queuedInputs.length - 1);
    } else if (key.name === "up" || key.name === "down") {
      manager.selected =
        (manager.selected + (key.name === "up" ? -1 : 1) + count) % Math.max(1, count);
    } else if (key.name === "delete" || key.name === "backspace" || value === "d") {
      if (manager.kind === "queue") {
        this.queuedInputs.splice(manager.selected, 1);
        this.setQueue(this.queuedInputs);
      } else {
        const files = this.getFileAttachments();
        const file = files[manager.selected];
        if (file && this.activeInput) {
          this.activeInput.graphemes = splitGraphemes(
            removeFileMention(this.activeInput.graphemes.join(""), file.path),
          );
          this.activeInput.cursorIndex = this.activeInput.graphemes.length;
          this.attachmentCache = undefined;
        } else this.pendingImages.splice(manager.selected - files.length, 1);
      }
      if (count <= 1) this.closeInputManager();
      else manager.selected = Math.min(manager.selected, count - 2);
    } else if (
      (key.name === "return" || key.name === "enter" || value === "e") &&
      manager.kind === "queue" &&
      count > 0 &&
      this.activeInput
    ) {
      const text = this.queuedInputs[manager.selected];
      manager.draft = this.activeInput;
      manager.original = text;
      this.activeInput = {
        ...this.activeInput,
        graphemes: splitGraphemes(text),
        cursorIndex: splitGraphemes(text).length,
        slashCommands: [],
        historyNavigationActive: false,
      };
    }
    this.scheduleRender(true);
    return true;
  }

  private getInputManagerRows(width: number, maxRows: number): string[] {
    const manager = this.inputManager;
    if (!manager || maxRows <= 0) return [];
    const hint = manager.draft
      ? "编辑待发送消息 · Enter 保存 · Esc 取消"
      : manager.kind === "queue"
        ? "待发送 · ↑↓ 选择 · s steer · Enter 编辑 · Del 撤回 · Esc 返回"
        : "附件 · ↑↓ 选择 · Del 移除 · Esc 返回";
    const items =
      manager.kind === "queue"
        ? this.queuedInputs
        : [
            ...this.getFileAttachments().map((item) => `${item.path} · ${item.note ?? "就绪"}`),
            ...this.pendingImages.map((item) => `${item.displayName} · 图片`),
          ];
    const rows = [truncateText(hint, width)];
    if (manager.draft) return rows;
    const budget = Math.max(0, maxRows - 1);
    const start = Math.max(
      0,
      Math.min(manager.selected - Math.floor(budget / 2), items.length - budget),
    );
    for (let i = start; i < Math.min(items.length, start + budget); i++) {
      rows.push(
        truncateText(
          `${i === manager.selected ? "›" : " "} ${manager.kind === "queue" && this.steerEnabled && !items[i].trimStart().startsWith("/") ? "[steer] " : ""}${i + 1}. ${redactSensitiveCommand(sanitizeTerminalText(items[i])).replace(/\n/g, " ↵ ")}`,
          width,
        ),
      );
    }
    return rows.map((row) => `${SEQ.muted}${row}${SEQ.reset}`);
  }
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
  private recentSessions: RecentSessionEntry[] = [];
  private workspaceStatus?: WorkspaceStatus;
  private startupSelected = -1;
  /** 首屏入口的鼠标悬停项：只换颜色，不改行数。 */
  private startupHovered = -1;
  private startupMotionStartedAt?: number;
  private startupMotionTimer: NodeJS.Timeout | null = null;
  private startupHits: Array<{ row: number; index: number; left: number; right: number }> = [];
  private pendingStartupClick?: { row: number; index: number };

  setRecentSessions(sessions: readonly RecentSessionEntry[]): void {
    this.recentSessions = sessions.slice(0, 3).map((session) => ({ ...session }));
    this.startupSelected = -1;
    this.scheduleRender();
  }

  setWorkspaceStatus(status: WorkspaceStatus): void {
    this.workspaceStatus = { ...status };
    this.scheduleRender();
  }

  private startupHomeAvailable(): boolean {
    return (
      this.startupHeaderVisible &&
      !this.contextInspector &&
      !this.costLog &&
      !this.activeSelection &&
      Boolean(this.activeInput) &&
      !this.activeInput?.sensitive &&
      this.activeInput?.prompt === this.options.inputPrompt &&
      !this.liveTail &&
      !this.activityFrame &&
      this.sealedSegments.length === 0 &&
      !this.chatContent.trim()
    );
  }

  private activateStartupAction(index: number): void {
    if (!this.startupHomeAvailable() || !this.activeInput) return;
    const action = startupActions(this.recentSessions)[index];
    if (!action) return;
    this.startupSelected = -1;
    if (action.kind === "resume") {
      this.options.onResumeSession?.(action.value);
    } else {
      this.activeInput.graphemes = splitGraphemes(action.value);
      this.activeInput.cursorIndex = this.activeInput.graphemes.length;
      this.activeInput.preferredColumn = undefined;
      this.activeInput.historyNavigationActive = false;
      this.scheduleRender(true);
    }
  }
  private renderedScreenRows: string[] = [];
  private renderedScreenWidth = 0;
  private renderedScreenHeight = 0;
  private renderedCursorState = "";
  private renderedChatVisibleStart = 0;
  private renderedChatRegionStart = 0;
  private renderedChatRegionHeight = 0;
  /** 全屏查看图片时的当前视图；有值就整屏只画图，不画对话区。 */
  private imageOverlay?: ImageOverlayView;
  private stdoutBackpressured = false;
  private renderPendingAfterDrain = false;
  /** Ctrl+C 防误触：上一次按下时间与被清空的草稿（↑ 可一次性找回）。 */
  private lastCtrlCAt = 0;
  private ctrlCDraftStash = "";
  /** 底栏临时提示（Ctrl+C 确认、清空草稿等），超时自动清除。 */
  private transientHintText = "";
  private transientHintTimer: NodeJS.Timeout | null = null;
  /** 复制成功的右上角角标（自动复制 / Ctrl+C 共用），超时自动消失。 */
  private copiedNotice = "";
  private copiedNoticeTimer: NodeJS.Timeout | null = null;
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

  /** 非交互模式的正文出口：默认 stdout，驱动模式下由调用方接管。 */
  private writeOut(text: string): void {
    if (this.outputMuted) return;
    const sink = this.options.outputSink;
    if (sink) sink(text);
    else stdout.write(text);
  }

  /** 非交互模式的提示性出口：默认 stderr，驱动模式下由调用方接管。 */
  private writeErr(text: string): void {
    const sink = this.options.errorSink;
    if (sink) sink(text);
    else stderr.write(text);
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

  setContextUsage(usedTokens: number, maxTokens = 1000000, breakdown?: ContextBreakdown): void {
    const nextUsed = Math.max(0, usedTokens);
    const nextMax = Math.max(1, maxTokens);
    if (nextUsed !== this.usedTokens || nextMax !== this.maxTokens) {
      this.contextPulseAt = Date.now();
      this.scheduleSidebarPulseEnd();
    }
    this.usedTokens = nextUsed;
    this.maxTokens = nextMax;
    this.contextBreakdown = breakdown;
    this.scheduleRender();
  }

  /** 注入详情页的数据来源：每次打开页面时调用一次，读当时最新的会话上下文。 */
  setContextItemsProvider(provider: () => ContextItemGroup[]): void {
    this.contextItemsProvider = provider;
  }

  /** 上下文详情页是否打开（打开期间侧栏临时收起，输入框保持可用）。 */
  isContextInspectorOpen(): boolean {
    return this.contextInspector !== undefined;
  }

  /**
   * 打开上下文详情页。
   *
   * 数据在打开这一瞬间快照：页面是只读视图，回合继续跑也不会边看边跳；
   * 想刷新就 Esc 关掉再点一次圆环。默认落在占用最大且有明细的那一类。
   */
  openContextInspector(): boolean {
    if (!this.interactive) return false;
    if (this.costLog) this.closeCostLog();
    if (this.contextInspector) return true;
    const provider = this.contextItemsProvider;
    const groups = provider ? provider() : [];
    const ranked = [...groups].sort((a, b) => b.tokens - a.tokens);
    const initial = ranked.find((group) => group.items.length > 0);
    if (!initial) {
      this.showTransientHint("暂无上下文明细");
      return false;
    }
    this.contextInspector = {
      groups,
      categoryIndex: Math.max(0, groups.indexOf(initial)),
      selectedIndex: 0,
      scroll: 0,
    };
    // 页面覆盖对话区：清掉进行中的选区与待点击状态，避免两套交互同时生效。
    this.textSelection.clear();
    this.selectionLayout = undefined;
    this.pendingMouseSelection = undefined;
    this.pendingSidebarClick = undefined;
    this.pendingInspectorClickRow = undefined;
    this.scheduleRender(true);
    return true;
  }

  closeContextInspector(): void {
    if (!this.contextInspector) return;
    this.contextInspector = undefined;
    this.contextInspectorHit = undefined;
    this.pendingInspectorClickRow = undefined;
    this.scheduleRender(true);
  }

  /** 费用日志页是否打开。 */
  isCostLogOpen(): boolean {
    return this.costLog !== undefined;
  }

  setCostLogProvider(provider: (sort: CostLogSort) => RequestCostDetail[]): void {
    this.costLogProvider = provider;
  }

  /**
   * 打开费用日志页（逐条请求明细）。
   *
   * sort 是初始排序视角——侧栏五行各对应一个；数据在打开这一瞬间快照，
   * 之后补单价、继续对话都不会让页面在眼皮底下跳，Esc 关掉再点即刷新。
   * 返回 false 表示没打开（非交互，或本会话还没有可展示的请求）。
   */
  openCostLog(sort: CostLogSort = "cost"): boolean {
    if (!this.interactive) return false;
    if (this.contextInspector) this.closeContextInspector();
    if (this.costLog) {
      // 已打开时又点了另一行：原地换排序视角，不重新快照（否则选中项会被重置）。
      if (this.costLog.sort !== sort) {
        this.costLog.sort = sort;
        this.costLog.selectedIndex = 0;
        // 换了排序视角等于换了一份列表，停在某个回合里已经没有意义，退回列表。
        this.costLog.turnDetail = undefined;
        this.scheduleRender(true);
      }
      return true;
    }
    const details = this.costLogProvider ? this.costLogProvider(sort) : [];
    if (details.length === 0) {
      this.showTransientHint("本会话暂无已计费的模型调用");
      return false;
    }
    this.costLog = { details, sort, selectedIndex: 0 };
    // 页面覆盖对话区：清掉进行中的选区与待点击状态，避免两套交互同时生效。
    this.textSelection.clear();
    this.selectionLayout = undefined;
    this.pendingMouseSelection = undefined;
    this.pendingInputSelection = undefined;
    this.pendingSidebarClick = undefined;
    this.pendingInspectorClickRow = undefined;
    this.scheduleRender(true);
    return true;
  }

  closeCostLog(): void {
    if (!this.costLog) return;
    this.costLog = undefined;
    this.costLogHit = undefined;
    this.pendingInspectorClickRow = undefined;
    this.scheduleRender(true);
  }

  /** 回合详情页是否打开（打开时费用列表仍在其下层）。 */
  isTurnDetailOpen(): boolean {
    return this.costLog?.turnDetail !== undefined;
  }

  /**
   * 费用列表按 Enter：进选中请求所属回合的详情页。
   *
   * 进页面时光标落在「你刚才选的那一条调用」上，所以按键方向一致：
   * 列表里挑中的是哪一次调用，进来就还是它。
   * 返回 false 表示没打开（页面没开着，或这条记录没有轮次信息）。
   */
  openTurnDetail(): boolean {
    const state = this.costLog;
    if (!state) return false;
    const result = enterTurnDetail(state);
    if (result.hint) this.showTransientHint(result.hint);
    if (result.ok) this.scheduleRender(true);
    return result.ok;
  }

  /** 单次请求详情页是否打开（三层结构的最内层）。 */
  isRequestDetailOpen(): boolean {
    return this.costLog?.turnDetail?.openDetail === true;
  }

  /** 回合详情页按 Enter：看选中这一次调用的算法明细。 */
  openRequestDetail(): boolean {
    const view = this.costLog?.turnDetail;
    if (!view || view.openDetail) return false;
    view.openDetail = true;
    this.scheduleRender(true);
    return true;
  }

  /** 请求详情页 → 回合详情页（回合页的选中行原样留在那一条上）。 */
  closeRequestDetail(): void {
    const view = this.costLog?.turnDetail;
    if (!view?.openDetail) return;
    view.openDetail = false;
    this.scheduleRender(true);
  }

  /** 回合详情页 → 费用列表；列表层的选中与滚动原样保留。 */
  closeTurnDetail(): void {
    if (!this.costLog?.turnDetail) return;
    this.costLog.turnDetail = undefined;
    this.scheduleRender(true);
  }

  /** ↑↓/PgUp/PgDn/滚轮：移动选中项；列表随选中项滚动，选中项永远可见。 */
  private moveCostLogSelection(delta: number): void {
    if (this.costLog && moveCostLogSelection(this.costLog, delta)) this.scheduleRender(true);
  }

  /** 费用日志页逐层退回：请求详情 → 回合详情 → 费用列表 → 关闭。 */
  private backCostLog(): void {
    if (!this.costLog) return;
    const layer = costLogLayer(this.costLog);
    if (layer === "request") this.closeRequestDetail();
    else if (layer === "turn") this.closeTurnDetail();
    else this.closeCostLog();
  }

  /**
   * 费用日志页的按键：只接管导航键，其余键仍进输入框。
   * 返回 true 表示已消费，调用方不要再走输入框的默认处理。
   */
  private handleCostLogKey(key: readline.Key): boolean {
    if (!this.costLog) return false;
    const typing = (this.activeInput?.graphemes.length ?? 0) > 0;
    const command = costLogKeyCommand(this.costLog, key, typing);
    if (!command) return false;
    if (command.type === "back") this.backCostLog();
    else if (command.type === "enter") {
      // 列表 → 回合详情；回合详情 → 请求详情。
      if (this.costLog.turnDetail) this.openRequestDetail();
      else this.openTurnDetail();
    } else if (command.type === "move") this.moveCostLogSelection(command.delta);
    return true;
  }

  /** 费用日志页内的点击：命中「返回」按钮或某一项；其余位置忽略。 */
  private handleCostLogClick(column: number, row: number): void {
    const hit = this.costLogHit;
    const state = this.costLog;
    if (!hit || !state) return;
    const target = overlayClickTarget(hit, column, row);
    if (target === "back") this.backCostLog();
    else if (target !== undefined && selectCostLogItem(state, target)) this.scheduleRender(true);
  }

  /** PgUp/PgDn 与滚轮：只滚原文；上限取上一帧的实际可滚动行数。 */
  private scrollInspector(delta: number): void {
    const state = this.contextInspector;
    if (state && scrollInspector(state, delta, this.inspectorMaxScroll)) this.scheduleRender(true);
  }

  /**
   * 详情页打开时的按键：只接管导航键，其余键仍进输入框。
   * 返回 true 表示已消费，调用方不要再走输入框的默认处理。
   */
  private handleInspectorKey(key: readline.Key): boolean {
    const state = this.contextInspector;
    if (!state) return false;
    const command = inspectorKeyCommand(key, this.inspectorMaxScroll);
    if (!command) return false;
    if (command.type === "close") {
      this.closeContextInspector();
      return true;
    }
    const changed =
      command.type === "item"
        ? moveInspectorItem(state, command.delta)
        : command.type === "category"
          ? moveInspectorCategory(state, command.delta)
          : scrollInspector(state, command.delta, this.inspectorMaxScroll);
    if (changed) this.scheduleRender(true);
    return true;
  }

  /** 详情页内的点击：命中「Esc 返回」或列表行；其余位置忽略。 */
  private handleInspectorClick(column: number, row: number): void {
    const hit = this.contextInspectorHit;
    const state = this.contextInspector;
    if (!hit || !state) return;
    const target = overlayClickTarget(hit, column, row);
    if (target === "back") this.closeContextInspector();
    else if (target !== undefined && selectInspectorItem(state, target)) this.scheduleRender(true);
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
    unpricedModels: readonly string[] = [],
    cachedPromptTokens = 0,
    offPeakRequests = 0,
  ): void {
    if (totalCostCny !== this.costCny) {
      this.costPulseAt = Date.now();
      this.scheduleSidebarPulseEnd();
    }
    this.costCny = totalCostCny;
    this.costRequests = Math.max(0, requests);
    this.costHasUnpriced = hasUnpriced;
    this.costPromptTokens = Math.max(0, promptTokens);
    this.costCompletionTokens = Math.max(0, completionTokens);
    this.costCachedPromptTokens = Math.max(0, cachedPromptTokens);
    this.costOffPeakRequests = Math.max(0, offPeakRequests);
    this.costUnpricedModels = [...unpricedModels];
    this.scheduleRender();
  }

  /** 后台定价 agent 的状态行（费用区那一行）；传 null 清掉。 */
  setPricingAgentState(state: SidebarPricingAgentState | null): void {
    this.pricingAgentState = state ?? undefined;
    this.scheduleRender();
  }

  /**
   * 折叠/展开侧栏费用明细（「▸ 明细」那一行）。
   * 只改侧栏的展示密度，不动任何数据；逐条明细另在费用日志页可查。
   * 还没有任何已计费调用时没有明细可摊开，直接返回 false（调用方据此判断是否真的切了）。
   */
  toggleCostDetailRows(): boolean {
    if (this.costCny === undefined) return false;
    this.costDetailRowsExpanded = !this.costDetailRowsExpanded;
    this.costDetailsPulseAt = Date.now();
    this.scheduleSidebarPulseEnd();
    this.scheduleRender(true);
    return true;
  }

  /** 会话目标（侧栏目标区块）；传 undefined 清掉，/clear 与 /resume 后同步刷新。 */
  setGoal(goal: SidebarGoalState | undefined): void {
    const next = goal
      ? {
          text: sanitizeTerminalText(goal.text)
            .replace(/\s*\n\s*/g, " ")
            .trim(),
          status: goal.status,
        }
      : undefined;
    if (next?.text === this.sidebarGoal?.text && next?.status === this.sidebarGoal?.status) return;
    this.sidebarGoal = next;
    this.goalPulseAt = Date.now();
    this.scheduleSidebarPulseEnd();
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

  /** 侧栏使用的会话用量快照（切会话 / 落盘时与费用一起同步）。 */
  getSessionMetrics(): { compactionCount: number; lastTurnMs: number } {
    return { compactionCount: this.compactionCount, lastTurnMs: this.lastTurnMs ?? 0 };
  }

  /**
   * 整体恢复侧栏用量。与 setLastTurnDuration 不同，这里允许归零：
   * /clear 与恢复一个没有记录的老会话时，侧栏必须真的退回 0。
   */
  setSessionMetrics(metrics: { compactionCount?: number; lastTurnMs?: number }): void {
    const compactionCount = Math.max(0, Math.round(metrics.compactionCount ?? 0));
    const lastTurnMs = Math.max(0, Math.round(metrics.lastTurnMs ?? 0));
    if (compactionCount === this.compactionCount && lastTurnMs === this.lastTurnMs) return;
    this.compactionCount = compactionCount;
    this.lastTurnMs = lastTurnMs;
    this.scheduleRender(true);
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
    this.taskPulseAt = Date.now();
    this.scheduleSidebarPulseEnd();
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
    this.escHandlerStack = [];
  }

  /**
   * 外部请求中止当前回合：等价于用户按一次 Esc。
   * 驱动服务（`haji mcp-serve`）用它在 `haji_cancel` 时切断网络与工具。
   * 没有在跑的回合时是无操作。
   */
  requestAbort(): boolean {
    if (!this.onEscCallback) return false;
    this.onEscCallback();
    return true;
  }

  /**
   * 临时接管 ESC，返回恢复函数（可重复调用，幂等）。
   *
   * 回合进行中开选择器等场景需要它：`onEsc` 是单槽，直接覆盖会丢掉「ESC 中止回合」
   * 的上层语义——选择器里按一次 Esc 会把整轮对话也一起中止。压栈后弹出即恢复。
   */
  pushEscHandler(callback: () => void): () => void {
    if (this.onEscCallback) this.escHandlerStack.push(this.onEscCallback);
    this.onEscCallback = callback;
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      this.onEscCallback = this.escHandlerStack.pop();
    };
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
    // 段内工具块：完整落在 [handle.start, end) 的尾部块转成段内偏移，
    // 其余（理论上不存在：工具格总在段开启后写入）留在尾部不动。
    const sealedBlocks = this.tailToolBlocks
      .filter((block) => block.start >= handle.start && block.end <= end)
      .map((block) => ({
        id: block.id,
        start: block.start - handle.start,
        end: block.end - handle.start,
        info: block.info,
        // 段展开后块默认全展开：二级折叠退化为「单块手动收起」，
        // 点开摘要行就能直接看到工具输出，不用再逐块点开。
        expanded: true,
      }));
    if (sealedBlocks.length > 0) {
      this.tailToolBlocks = this.tailToolBlocks.filter(
        (block) => !(block.start >= handle.start && block.end <= end),
      );
    }
    if (before) this.pushSegment({ kind: "plain", raw: before });
    this.pushSegment({
      kind: "fold",
      raw: group,
      stats,
      expanded: false,
      blocks: sealedBlocks,
    });
    this.chatContent = this.chatContent.slice(end);
    // 兜底：仍留在 tailToolBlocks 的块（区间在段外，理论上不该有）不能悬空指向已移出尾部的偏移。
    this.tailToolBlocks = this.tailToolBlocks.filter(
      (block) => block.start >= 0 && block.end <= this.chatContent.length,
    );
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

  /**
   * 把一张图片作为独立段内联进聊天流：先封口当前尾部正文，再追加图片段。
   * kitty 协议下真实像素由帧尾同步层贴在占位行区域；其他协议降级为说明行。
   * 必须在「没有未写完的流式正文」时调用（回合内接线方负责先封口再重新开段）。
   */
  appendInlineImage(filePath: string): { ok: true } | { ok: false; error: string } {
    if (!this.interactive) return { ok: false, error: "内联贴图需要交互式终端" };
    const built = buildInlineImage(filePath);
    if (!built.ok) return built;
    if (this.chatContent) {
      this.pushSegment({ kind: "plain", raw: this.chatContent });
      this.chatContent = "";
      // 尾部清零后，调用方持有的旧偏移不再有效——与 sealFoldGroup 同一口径。
      this.chatEpoch += 1;
    }
    this.sealedSegments.push({
      id: this.nextSegmentId,
      kind: "image",
      raw: sanitizeTerminalText(built.image.caption),
      expanded: false,
      image: {
        desc: built.image,
        kittyId: this.nextKittyImageId,
        uploaded: false,
      },
    });
    this.nextSegmentId += 1;
    this.nextKittyImageId += 1;
    this.sealedVersion += 1;
    this.selectionLayout = undefined;
    this.cachedContentWithStatus = "";
    this.setStableWrapPrefix("");
    this.enforceSegmentBudget();
    this.scheduleRender();
    return { ok: true };
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
    this.disposeInlineImages(this.sealedSegments);
    this.sealedSegments = [];
    this.nextSegmentId = 1;
    for (const piece of pending) {
      this.pushSegment({
        kind: piece.kind,
        raw: piece.raw,
        stats: piece.stats,
        expanded: false,
        // 与 sealFoldGroup 同口径：段内块默认全展开，点块头可单独收起。
        ...(piece.blocks && piece.blocks.length > 0
          ? {
              blocks: piece.blocks.map((block) => ({
                id: this.nextToolBlockId++,
                start: block.start,
                end: block.end,
                info: block.info,
                expanded: true,
              })),
            }
          : {}),
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
    this.tailToolBlocks = [];
    this.toolBlockHits.clear();
    this.toolBlockRanges.clear();
    this.chatHoverTarget = undefined;
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
    this.queuedInputs = items;
    this.queueSteerHits = [];
    this.pendingQueueSteer = undefined;
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
      this.queueText = ` ${SEQ.accent}待发送 (${items.length} 条 · Alt+Q 管理 · 本轮结束后发送):${SEQ.reset} ${SEQ.muted}${formatted}${SEQ.reset}`;
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
      this.writeErr(`${text}\n`);
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
   * 复制成功的即时反馈：右上角闪一下 “Copied”，不占用底栏。
   * 头部隐藏（minimal / 矮终端）时没有可覆盖的顶行，退回底栏临时提示。
   */
  private flashCopied(durationMs = 1_200): void {
    if (!this.started) return;
    if (!this.interactive) {
      this.writeErr("Copied\n");
      return;
    }
    this.copiedNotice = "Copied";
    if (this.copiedNoticeTimer) clearTimeout(this.copiedNoticeTimer);
    this.copiedNoticeTimer = setTimeout(() => {
      this.copiedNoticeTimer = null;
      this.copiedNotice = "";
      this.scheduleRender();
    }, durationMs);
    this.copiedNoticeTimer.unref?.();
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

  /**
   * 等输入行真正空闲（既没有待处理的输入请求，也没有打开的选择器）。
   * 供主循环在偶发竞态下等待后台流程收尾，而不是把它升级成崩溃。
   */
  waitForInputIdle(): Promise<void> {
    if (!this.activeInput && !this.activeSelection) return Promise.resolve();
    return new Promise<void>((resolve) => this.inputIdleWaiters.push(resolve));
  }

  private notifyInputIdle(): void {
    if (this.activeInput || this.activeSelection) return;
    const waiters = this.inputIdleWaiters;
    this.inputIdleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  cancelInput(): string | undefined {
    return this.abortInput(new TerminalInputCancelledError());
  }

  cancelSelection(): void {
    this.finishSelection(new TerminalInputCancelledError());
  }

  /**
   * 鼠标交互要独占输入行：结束当前输入并返回未发送的草稿。
   * 与 cancelInput 的区别只在抛出的错误类型——主循环据此判断是「继续」还是「退出」。
   */
  takeOverInput(): string | undefined {
    return this.abortInput(new TerminalInputTakenOverError());
  }

  private abortInput(error: Error): string | undefined {
    if (this.inputManager) this.closeInputManager();
    if (!this.activeInput) return undefined;
    const draft = this.activeInput.graphemes.join("");
    this.pendingImages = [];
    this.finishInput(error);
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
      if (this.options.compactHeader) this.writeOut(`${this.options.compactHeader}\n`);
      return;
    }

    this.originalRawMode = Boolean(stdin.isRaw);
    // 单独的 Esc 默认要等 500ms 才判定（期间的下一个键会被并成 Alt+键，Esc 后紧跟回车
    // 会变成“确认”）。分包歧义已由协议解析器先处理，这里不再二次等待：
    // 完整转义序列仍整块到达，单独的 Esc 可以立刻上报。
    readline.emitKeypressEvents(this.keyInput, {
      escapeCodeTimeout: 0,
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
    if (this.imageOverlay) {
      const cleanup = encodeDeleteImages(this.imageOverlay.protocol, this.imageOverlay.tmux);
      this.imageOverlay = undefined;
      if (cleanup) stdout.write(cleanup);
    }
    // 关闭时没有任何输入行可用：唤醒等空闲者，避免它们永远挂着。
    this.notifyInputIdle();

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
    if (this.sidebarPulseTimer) {
      clearTimeout(this.sidebarPulseTimer);
      this.sidebarPulseTimer = null;
    }
    if (this.transientHintTimer) {
      clearTimeout(this.transientHintTimer);
      this.transientHintTimer = null;
    }
    this.transientHintText = "";
    if (this.copiedNoticeTimer) {
      clearTimeout(this.copiedNoticeTimer);
      this.copiedNoticeTimer = null;
    }
    this.copiedNotice = "";
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
    this.disposeInlineImages(this.sealedSegments);
    this.sealedSegments = [];
    this.nextSegmentId = 1;
    this.foldHeaderRows.clear();
    this.sealedRowIndex = [];
    this.tailToolBlocks = [];
    this.toolBlockHits.clear();
    this.toolBlockRanges.clear();
    this.chatHoverTarget = undefined;
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
   * 块区间按传入原文计算；归一化若改变长度则放弃块元数据（退化为纯文本段）。
   */
  private pushSegment(piece: {
    kind: "plain" | "fold";
    raw: string;
    stats?: FoldGroupStats;
    expanded?: boolean;
    blocks?: SealedToolBlock[];
  }): void {
    // 与 writeChat 同一套归一化（制表符展开等），保证段与尾部宽度口径一致。
    const normalized = normalizeTerminalOutput(piece.raw);
    const raw = ensureTrailingNewline(normalized);
    if (!raw) return;
    const sealed = closeTrailingStyle(raw);
    const blocks =
      piece.blocks && normalized.length === piece.raw.length ? piece.blocks : undefined;
    if (blocks) {
      // closeTrailingStyle 会在末个换行前插入 SGR 复位：只有触及段尾的块会被这段
      // 插入平移（其余块的区间都在插入点之前），补上偏移，避免块尾切进转义序列。
      const inserted = sealed.length - raw.length;
      if (inserted > 0) {
        for (const block of blocks) {
          if (block.end > normalized.length - 1) {
            block.end = Math.min(sealed.length, block.end + inserted);
          }
        }
      }
    }
    this.sealedSegments.push({
      id: this.nextSegmentId,
      kind: piece.kind,
      raw: sealed,
      stats: piece.stats,
      expanded: piece.expanded ?? false,
      ...(blocks ? { blocks } : {}),
    });
    this.nextSegmentId += 1;
    this.sealedVersion += 1;
    this.selectionLayout = undefined;
  }

  /** 段的换行结果（去掉末尾光标行）；宽度、展开状态或块悬停变化时重算。 */
  private getSegmentRows(segment: ChatSegment, width: number): string[] {
    const cacheKey = this.segmentCacheKey(segment, width);
    if (segment.cacheKey === cacheKey && segment.rows) return segment.rows;
    const rows = this.renderSegmentRows(segment, width);
    segment.rows = rows.length > 0 ? rows.slice(0, -1) : rows;
    segment.layout = undefined;
    segment.cacheKey = cacheKey;
    return segment.rows;
  }

  /** 图片段：占位空行 + 说明行；尺寸折算结果缓存进段，帧尾同步层直接取用。 */
  private renderImageSegmentRows(segment: ChatSegment, width: number): string[] {
    const state = segment.image;
    if (!state) return [];
    const caption = sanitizeTerminalText(
      state.desc.protocol === "kitty" && state.desc.png
        ? state.desc.caption
        : `${state.desc.caption}（此终端不支持内联贴图，/view 可整屏查看）`,
    );
    const captionRow = truncateAnsiText(`${SEQ.muted}${caption}${SEQ.reset}`, width);
    if (state.desc.protocol !== "kitty" || !state.desc.png) {
      // 末尾的空串对齐 wrapAnsi 的「光标行」，由 getSegmentRows 统一切掉。
      return [captionRow, ""];
    }
    const fitted = fitImageCells(
      state.desc.widthPx,
      state.desc.heightPx,
      width,
      INLINE_IMAGE_MAX_ROWS,
    );
    state.fitted = fitted;
    // 占位行必须是空串：图片像素由同步层贴上去，行内任何字符都会叠在图上。
    return [...new Array<string>(fitted.rows).fill(""), captionRow, ""];
  }

  private renderSegmentRows(segment: ChatSegment, width: number): string[] {
    if (segment.kind === "image") return this.renderImageSegmentRows(segment, width);
    if (this.segmentBlocksVisible(segment)) {
      return this.renderBlockSegmentRows(segment, width);
    }
    // 块不可见（fold 收起 / 无块）：不能残留上一态的行落位，否则命中表会指到隐藏行。
    segment.blockSpans = undefined;
    const rendered = renderSegmentText(
      segmentView(segment),
      width,
      this.foldEnabled,
      this.chatHoverTarget?.type === "fold" && this.chatHoverTarget.id === segment.id,
    );
    segment.headerRow = rendered.headerRow;
    return performanceMonitor.measureSync("terminal.wrap.segment", () =>
      wrapAnsi(rendered.text, width),
    );
  }

  /** 段内块是否按块渲染：有块且段处于展开态（fold 收起时整段只剩摘要行）。 */
  private segmentBlocksVisible(segment: ChatSegment): boolean {
    if ((segment.blocks?.length ?? 0) === 0) return false;
    return segment.kind === "plain" || !this.foldEnabled || segment.expanded;
  }

  /**
   * 块感知的段渲染：把 raw 里每个工具块的字符区间挖出来，块内容从渲染配方现算
   * （收起数行 + 「点击展开」指示行 / 展开 + 输出正文），其余原文片段照常换行。
   * 返回含末尾光标行的完整行集；块的行落位记进 segment.blockSpans，供命中表换算。
   */
  private renderBlockSegmentRows(segment: ChatSegment, width: number): string[] {
    const { leading, trailing } = splitBlankEdges(segment.raw);
    const rows: string[] = [];
    const spans: ToolBlockRowSpan[] = [];
    const pushWrapped = (text: string): void => {
      if (!text) return;
      const wrapped = wrapAnsi(text, width);
      // 以换行结尾的片段会多带一个光标空行；段内拼接时不重复保留。
      const visible = text.endsWith("\n") ? wrapped.slice(0, -1) : wrapped;
      for (const row of visible) rows.push(row);
    };
    pushWrapped(leading);
    if (segment.kind === "fold" && this.foldEnabled && segment.stats) {
      const hovered =
        this.chatHoverTarget?.type === "fold" && this.chatHoverTarget.id === segment.id;
      rows.push(buildFoldHeader(segment.stats, width, hovered));
      segment.headerRow = rows.length - 1;
    }
    const bodyStart = leading.length;
    const bodyEnd = segment.raw.length - trailing.length;
    const blocks = [...(segment.blocks ?? [])].sort((a, b) => a.start - b.start);
    let cursor = bodyStart;
    for (const block of blocks) {
      if (block.start > cursor) pushWrapped(segment.raw.slice(cursor, block.start));
      const hovered =
        this.chatHoverTarget?.type === "block" && this.chatHoverTarget.id === block.id;
      const rendered = renderToolBlockRows(block.info, width, {
        expanded: block.expanded,
        hovered,
      });
      const startRow = rows.length;
      for (const row of rendered.rows) rows.push(row);
      spans.push({
        blockId: block.id,
        startRow,
        endRow: rows.length - 1,
        headerRow: startRow + rendered.headerRow,
        ...(rendered.indicatorRow !== undefined
          ? { indicatorRow: startRow + rendered.indicatorRow }
          : {}),
      });
      cursor = Math.max(cursor, block.end);
    }
    if (cursor < bodyEnd) pushWrapped(segment.raw.slice(cursor, bodyEnd));
    pushWrapped(trailing);
    segment.blockSpans = spans;
    rows.push("");
    return rows;
  }

  /** 段的独立布局（选区用）；末尾光标行保留，交给 concatAnsiLayouts 处理。 */
  private getSegmentLayout(segment: ChatSegment, width: number): AnsiTextLayout {
    if (segment.layout && segment.cacheKey === this.segmentCacheKey(segment, width)) {
      return segment.layout;
    }
    if (segment.kind === "image") {
      // 图片段必须与渲染用同一份行集建布局：占位行数由聊天区宽度折算，若按说明行
      // 单独拼文档，占位行就得靠额外补的行来对齐——每张图会让后续所有行整体偏移
      // 一行（复制出来的是选中位置之上的内容）。这里直接以「可见行」建文档，
      // 说明行仍是唯一可选正文，占位行是空行。
      const rows = this.renderImageSegmentRows(segment, width);
      const layout = layoutAnsiDocument(rows.join("\n"), width);
      segment.layout = layout;
      segment.cacheKey = this.segmentCacheKey(segment, width);
      segment.rows = layout.rows.slice(0, -1).map((row) => row.ansi);
      return layout;
    }
    if (this.segmentBlocksVisible(segment)) {
      // 块感知段：布局直接建在「本帧可见文本」上，保证选区/复制与显示一致。
      const rows = this.renderBlockSegmentRows(segment, width);
      const layout = layoutAnsiDocument(rows.join("\n"), width);
      segment.layout = layout;
      segment.cacheKey = this.segmentCacheKey(segment, width);
      segment.rows = layout.rows.slice(0, -1).map((row) => row.ansi);
      return layout;
    }
    segment.blockSpans = undefined;
    const rendered = renderSegmentText(
      segmentView(segment),
      width,
      this.foldEnabled,
      this.chatHoverTarget?.type === "fold" && this.chatHoverTarget.id === segment.id,
    );
    segment.headerRow = rendered.headerRow;
    const layout = layoutAnsiDocument(rendered.text, width);
    segment.layout = layout;
    segment.cacheKey = this.segmentCacheKey(segment, width);
    segment.rows = layout.rows.slice(0, -1).map((row) => row.ansi);
    return layout;
  }

  /**
   * 段缓存键：宽度 / 段展开 / 过程折叠开关之外，块段的各块展开态与悬停态
   * 也在键里——点击或悬停只让受影响的那一段重算，其余段继续吃缓存。
   */
  private segmentCacheKey(segment: ChatSegment, width: number): string {
    let blockKey = "";
    const hover = this.chatHoverTarget;
    if (segment.blocks?.length) {
      const states = segment.blocks.map((block) => (block.expanded ? 1 : 0)).join("");
      const hovered =
        hover !== undefined &&
        ((hover.type === "block" && segment.blocks.some((block) => block.id === hover.id)) ||
          (hover.type === "fold" && hover.id === segment.id));
      blockKey = `|b${states}${hovered ? "h" : ""}`;
    } else if (hover?.type === "fold" && hover.id === segment.id) {
      blockKey = "|fh";
    }
    return `${width}|${segment.expanded ? 1 : 0}|${this.foldEnabled ? 1 : 0}${blockKey}`;
  }

  /** 已封口区的可见行；同时重建摘要行/工具块命中表与段行区间。 */
  private getSealedRows(width: number): string[] {
    this.foldHeaderRows.clear();
    this.sealedRowIndex = [];
    this.toolBlockHits.clear();
    this.toolBlockRanges.clear();
    if (this.sealedSegments.length === 0) {
      this.chatHoverTarget = undefined;
      return [];
    }
    const rows: string[] = [];
    for (const segment of this.sealedSegments) {
      const segmentRows = this.getSegmentRows(segment, width);
      if (segment.kind === "fold" && segment.headerRow !== undefined && this.foldEnabled) {
        this.foldHeaderRows.set(rows.length + segment.headerRow, segment.id);
      }
      // 块命中表：头行与折叠指示行可点击；整块行区间用于悬停判定。
      for (const span of segment.blockSpans ?? []) {
        const base = rows.length;
        this.toolBlockHits.set(base + span.headerRow, span.blockId);
        if (span.indicatorRow !== undefined) {
          this.toolBlockHits.set(base + span.indicatorRow, span.blockId);
        }
        this.toolBlockRanges.set(span.blockId, {
          startRow: base + span.startRow,
          endRow: base + span.endRow,
        });
      }
      this.sealedRowIndex.push({ id: segment.id, start: rows.length, count: segmentRows.length });
      // 用循环 push：展开后的段可能有成百上千行，push(...rows) 会爆参数栈。
      for (const row of segmentRows) rows.push(row);
    }
    // 悬停目标这一帧可能已消失（段被预算回收、组被收起）：就地作废，避免残留高亮。
    if (
      this.chatHoverTarget?.type === "block" &&
      !this.toolBlockRanges.has(this.chatHoverTarget.id)
    ) {
      this.chatHoverTarget = undefined;
    } else if (
      this.chatHoverTarget?.type === "fold" &&
      ![...this.foldHeaderRows.values()].includes(this.chatHoverTarget.id)
    ) {
      this.chatHoverTarget = undefined;
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
      if (dropped?.image) this.disposeInlineImages([dropped]);
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

  /**
   * 切换某个工具块的展开状态（二级折叠）。screenOffset 是被点行在视口内的行位置，
   * 与 toggleFoldSegment 同一套锚点语义：行数变化后视口仍钉在被点的那一行。
   */
  private toggleToolBlock(blockId: number, screenOffset: number): void {
    for (const segment of this.sealedSegments) {
      const block = segment.blocks?.find((item) => item.id === blockId);
      if (!block) continue;
      block.expanded = !block.expanded;
      this.sealedVersion += 1;
      const span = segment.blockSpans?.find((item) => item.blockId === blockId);
      this.pendingScrollAnchor = {
        segmentId: segment.id,
        rowInSegment: span ? span.startRow : 0,
        screenOffset: Math.max(0, screenOffset),
      };
      this.textSelection.clear();
      this.selectionLayout = undefined;
      this.scheduleRender(true);
      return;
    }
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
      this.writeOut(text);
      return;
    }

    this.chatContent += text;
    if (this.chatContent.length > 200_000) {
      const cut = this.chatContent.length - 160_000;
      this.chatContent = this.chatContent.slice(-160_000);
      // 尾部工具块的偏移随截断平移；头部被切掉的块直接丢弃（其正文已不在缓冲里）。
      this.tailToolBlocks = this.tailToolBlocks
        .map((block) => ({ ...block, start: block.start - cut, end: block.end - cut }))
        .filter((block) => block.start >= 0);
      this.cachedContentWithStatus = "";
      this.setStableWrapPrefix("");
      this.chatEpoch += 1;
    }

    this.scheduleRender();
  }

  /**
   * 写入一批工具格并为每个块登记二级折叠元数据：块正文照常进尾部
   * （回合进行中完整可见），封口后由 TerminalUI 按块收口成数行、点击展开。
   * 区间按提交原文计算；若写入归一化改变了文本长度（制表符展开等），
   * 区间会错位，此时退化为普通写入（块完整可见、不可点，绝不渲染错位内容）。
   */
  writeToolCells(text: string, blocks: readonly ToolBlockWrite[] = []): void {
    if (
      !this.interactive ||
      blocks.length === 0 ||
      normalizeTerminalOutput(text).length !== text.length
    ) {
      this.writeChat(text);
      return;
    }
    const base = this.chatContent.length;
    this.writeChat(text);
    for (const block of blocks) {
      this.tailToolBlocks.push({
        id: this.nextToolBlockId++,
        start: base + block.start,
        end: base + block.end,
        info: block.info,
        expanded: false,
      });
    }
  }

  writeLine(value: string = ""): void {
    // 非交互（无头/管道）下提示性整行走 stderr，stdout 只保留流式正文与工具块。
    if (!this.interactive) {
      this.writeErr(`${value}\n`);
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
      this.writeOut("\n");
      return;
    }
    if (this.chatContent && !this.chatContent.endsWith("\n")) {
      this.writeLine();
    }
    // 已经以空行结尾时不再追加，避免连续空行（例如上一条消息本就带尾部空行）。
    if (!this.chatContent.endsWith("\n\n")) this.writeLine();
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
      this.writeOut(text);
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
    this.disposeInlineImages(this.sealedSegments);
    this.sealedSegments = [];
    this.nextSegmentId = 1;
    this.foldHeaderRows.clear();
    this.sealedRowIndex = [];
    this.tailToolBlocks = [];
    this.toolBlockHits.clear();
    this.toolBlockRanges.clear();
    this.chatHoverTarget = undefined;
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
      if (delta) this.writeOut(delta);
    }

    this.markStableChatPrefix(offset);
    this.chatContent = this.chatContent.slice(0, offset) + text;
    // 流式重绘只覆盖正文区；防御性丢弃被覆盖到的尾部块，避免区间悬空。
    this.tailToolBlocks = this.tailToolBlocks.filter((block) => block.end <= offset);
    if (this.chatContent.length > 200_000) {
      const cut = this.chatContent.length - 160_000;
      this.chatContent = this.chatContent.slice(-160_000);
      this.tailToolBlocks = this.tailToolBlocks
        .map((block) => ({ ...block, start: block.start - cut, end: block.end - cut }))
        .filter((block) => block.start >= 0);
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
      throw new TerminalInputBusyError();
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
      throw new TerminalInputBusyError();
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
    this.queueSteerHits = [];
    this.pendingQueueSteer = undefined;
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
    // 侧栏与分隔带不是对话内容：拖到侧栏上时把选区钉在对话区最右列，
    // 否则 cellAtColumn 会把端点钳到行尾，看起来像"侧栏也能被选中"。
    const safeColumn = this.clampToChatArea(column);
    // chat 区有响应式左内边距：把 1-based 物理列还原成内容列。
    // cellAtColumn 内部会再做 column-1，故这里直接减 padding。
    return cellAtColumn(
      layoutRow,
      safeColumn - (this.chatViewport?.padding ?? DEFAULT_CHAT_PADDING),
      clampToText,
    );
  }

  /** 侧栏显示时把鼠标列限制在对话区内；侧栏隐藏时原样返回。 */
  private clampToChatArea(column: number): number {
    const edge = this.chatAreaRightEdgeColumn;
    if (edge <= 0) return column;
    return Math.min(column, edge);
  }

  /** 鼠标列是否落在侧栏（含分隔带）上——这块区域不参与文本选区。 */
  private isPointerInSidebar(column: number): boolean {
    const edge = this.chatAreaRightEdgeColumn;
    return edge > 0 && column > edge;
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

  /**
   * 复制当前选区。默认复制后清除选区（Ctrl+C 的旧行为）；鼠标松开时的
   * 自动复制保留高亮，方便继续调整选区。
   */
  private copyChatSelection(clearSelection = true): boolean {
    const text = this.getSelectedChatText();
    if (!text) {
      return false;
    }

    void this.clipboardWriter.write(text).then((success) => {
      if (!success) return;
      this.flashCopied();
      // 选区在复制期间被改动时不要清掉新的选区。
      if (clearSelection && this.getSelectedChatText() === text) {
        this.textSelection.clear();
        this.selectionLayout = undefined;
      }
      this.scheduleRender(true);
    });
    return true;
  }

  /** 输入框正文在屏幕上的行号（0-based）是否落在输入框内；是则返回行内序号。 */
  private inputRowIndexAt(row: number): number | undefined {
    const top = this.inputSelectionTop;
    if (top === undefined || this.inputSelectionHeight <= 0) return undefined;
    // 鼠标报文的行号是 1-based，inputSelectionTop 是 0-based 屏幕行索引。
    const screenRow = row - 1;
    if (screenRow < top || screenRow >= top + this.inputSelectionHeight) return undefined;
    return screenRow - top;
  }

  /** 拖动更新输入框选区；指针拖到输入框外时夹到首/末行，保证选区连续。 */
  private updateInputSelection(column: number, row: number): void {
    const geometry = this.inputSelectionGeometry;
    if (!geometry || !this.inputSelection.dragging) return;
    const top = this.inputSelectionTop ?? 0;
    const targetRow = Math.max(0, Math.min(geometry.rowCount - 1, row - 1 - top));
    const cell = inputCellFromPoint(geometry, targetRow, column - this.inputSelectionLeft);
    if (cell) this.inputSelection.update(cell);
    this.scheduleRender();
  }

  private getSelectedInputText(): string {
    const geometry = this.inputSelectionGeometry;
    if (!geometry) return "";
    return this.inputSelection.selectedText(geometry.document);
  }

  /**
   * 复制输入框里选中的原文。终端开着鼠标跟踪，原生拖选拿不到输入行，所以输入框
   * 走自己的选区：复制完保留高亮（clearSelection=false 同对话区）。
   */
  private copyInputSelection(clearSelection = true): boolean {
    const text = this.getSelectedInputText();
    if (!text) return false;

    void this.clipboardWriter.write(text).then((success) => {
      if (!success) return;
      this.flashCopied();
      if (clearSelection && this.getSelectedInputText() === text) {
        this.inputSelection.clear();
      }
      this.scheduleRender(true);
    });
    return true;
  }

  /** 把输入框行里的选区高亮写回 inputBlock（行的位置与内容都不变，只加反显）。 */
  private highlightInputRows(inputBlock: string[], offset: number): void {
    const geometry = this.inputSelectionGeometry;
    const selection = this.inputSelection.range();
    if (!geometry || !selection) return;
    for (let index = 0; index < geometry.rowCount; index += 1) {
      const target = offset + index;
      const row = inputBlock[target];
      if (row === undefined) break;
      const span = inputRowHighlightSpan(geometry, selection, index);
      if (!span) continue;
      inputBlock[target] = highlightAnsiColumns(row, span.startColumn - 1, span.endColumn);
    }
  }

  /** 把复制角标贴到首行右端（顶部标题行）。宽度不够时不贴。 */
  private overlayCopiedNotice(rows: string[], width: number): void {
    if (!this.copiedNotice || rows.length === 0) return;
    const badge = `${SEQ.bold}${SEQ.green}${this.copiedNotice}${SEQ.reset}`;
    const badgeWidth = terminalWidth(badge);
    if (badgeWidth + 1 >= width) return;
    const base = truncateAnsiText(rows[0] ?? "", width - badgeWidth - 1);
    const padding = " ".repeat(Math.max(1, width - terminalWidth(base) - badgeWidth));
    rows[0] = `${base}${padding}${badge}`;
  }

  /**
   * 滚动离开底部时在对话区底部正中画「回到底部」浮标。
   *
   * 只覆盖渲染行，不写进 chatContent，也不改变折行与选区坐标（复制/拖选仍按正文算）。
   * 高度不够时降级成一行 `↑ Jump to End`；一行都放不下就不画。
   */
  private paintScrollJumpHint(
    rows: string[],
    options: {
      width: number;
      height: number;
      bottomInset: number;
      screenTop: number;
      enabled: boolean;
    },
  ): void {
    this.chatHintHit = undefined;
    if (!options.enabled || this.chatScrollOffset <= 0) return;
    const bottom = Math.min(options.height, rows.length) - options.bottomInset;
    if (bottom <= 0) return;
    const box = buildScrollJumpHint();
    if (bottom >= box.rows.length && options.width >= box.width) {
      const left = Math.floor((options.width - box.width) / 2);
      const start = bottom - box.rows.length;
      for (let index = 0; index < box.rows.length; index += 1) {
        rows[start + index] = " ".repeat(left) + box.rows[index];
      }
      this.chatHintHit = {
        columnStart: left + 1,
        columnEnd: left + box.width,
        rowStart: options.screenTop + start,
        rowEnd: options.screenTop + bottom - 1,
      };
      return;
    }
    const line = buildScrollJumpHintLine();
    const lineWidth = terminalWidth(line);
    if (lineWidth >= options.width) return;
    const left = Math.floor((options.width - lineWidth) / 2);
    rows[bottom - 1] = " ".repeat(left) + line;
    this.chatHintHit = {
      columnStart: left + 1,
      columnEnd: left + lineWidth,
      rowStart: options.screenTop + bottom - 1,
      rowEnd: options.screenTop + bottom - 1,
    };
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
    // 1003 any-event 跟踪下的纯移动（无按键按下）：侧栏圆环悬停 + 对话区可点行悬停。
    if (event.action === "move" && (event.button & 3) === 3) {
      this.handlePointerHover(event);
      return;
    }
    if (event.action === "wheel") {
      this.handleMouseWheel(event);
      return;
    }
    const isLeftButton = (event.button & 3) === 0;
    const startupHit = this.startupHitAt(event.column, event.row);
    if (event.action === "down" && isLeftButton && startupHit) {
      this.pendingStartupClick = { row: startupHit.row, index: startupHit.index };
      this.startupSelected = startupHit.index;
      this.scheduleRender();
      return;
    }
    if (event.action === "up" && this.pendingStartupClick) {
      const pending = this.pendingStartupClick;
      this.pendingStartupClick = undefined;
      if (isLeftButton && startupHit?.index === pending.index && startupHit.row === pending.row) {
        this.activateStartupAction(pending.index);
      }
      return;
    }
    if (event.action === "down" && isLeftButton) {
      this.handleLeftButtonDown(event);
      return;
    }
    if (event.action === "move" && isLeftButton) {
      this.handleLeftButtonDrag(event);
      return;
    }
    if (event.action === "up" && isLeftButton) this.handleLeftButtonUp(event);
  }

  /** 首页入口在该格的命中项（首页不可用时为 undefined）。 */
  private startupHitAt(column: number, row: number) {
    if (!this.startupHomeAvailable()) return undefined;
    return this.startupHits.find(
      (hit) => hit.row === row && column >= hit.left && column <= hit.right,
    );
  }

  /** 该格是否落在「回到底部」浮标内。 */
  private isOnChatHint(column: number, row: number): boolean {
    const hit = this.chatHintHit;
    return Boolean(
      hit &&
        column >= hit.columnStart &&
        column <= hit.columnEnd &&
        row >= hit.rowStart &&
        row <= hit.rowEnd,
    );
  }

  /** 无按键移动：首页入口、侧栏与对话区的悬停高亮（只换颜色，不改行数）。 */
  private handlePointerHover(event: TerminalMouseEvent): void {
    if (this.startupHomeAvailable()) {
      const hovered = this.startupHitAt(event.column, event.row)?.index ?? -1;
      if (hovered !== this.startupHovered) {
        this.startupHovered = hovered;
        this.scheduleRender(true);
      }
    }
    this.updateSidebarHover(event.column, event.row);
    this.updateChatHover(event.column, event.row);
  }

  /** 滚轮：覆盖页打开时归覆盖页，否则合并成对话区滚动帧（拖选中端点随帧更新）。 */
  private handleMouseWheel(event: TerminalMouseEvent): void {
    // 详情页打开时滚轮归原文；费用日志页没有独立滚动区，滚轮等价于上下移动选中项。
    const rows = event.wheelRows ?? 0;
    const step = rows === 0 ? 0 : rows > 0 ? INSPECTOR_WHEEL_ROWS : -INSPECTOR_WHEEL_ROWS;
    if (this.costLog) {
      this.moveCostLogSelection(step);
      return;
    }
    if (this.contextInspector) {
      this.scrollInspector(step);
      return;
    }
    this.pendingMouseSelection = undefined;
    this.queueWheelScroll(event.wheelRows ?? 0);
    if (this.textSelection.dragging) {
      // 端点随合并后的滚动帧更新，避免每个滚轮报文都触发一次选区布局。
      this.selectionPointer = { column: event.column, row: event.row };
    }
  }

  /**
   * 左键按下：按命中优先级只登记「待定」状态（输入框选区 / 覆盖页点击 / 侧栏点击 /
   * 浮标点击 / 对话区选区锚点），真正的动作等松开或拖动时再定。
   */
  private handleLeftButtonDown(event: TerminalMouseEvent): void {
    this.pendingChatHintClick = undefined;
    this.pendingQueueSteer = this.queueSteerHitAt(event.column, event.row);
    if (this.pendingQueueSteer) return;
    // 输入框正文：鼠标跟踪下原生拖选拿不到输入行，这里开一条自己的选区通道。
    const inputRow = this.inputRowIndexAt(event.row);
    if (inputRow !== undefined) {
      this.stopSelectionAutoScroll();
      this.selectionPointer = undefined;
      this.pendingMouseSelection = undefined;
      this.pendingSidebarClick = undefined;
      this.textSelection.clear();
      this.selectionLayout = undefined;
      // 单击不产生选区：只有真的拖动才从锚点开始选，避免一点就复制一个字符。
      this.pendingInputSelection = { column: event.column, row: event.row };
      this.inputSelection.clear();
      this.scheduleRender();
      return;
    }
    // 详情页覆盖了对话区：按下只记录待点击行，不产生文本选区。
    if (this.contextInspector || this.costLog) {
      this.pendingMouseSelection = undefined;
      this.pendingInputSelection = undefined;
      this.pendingSidebarClick = undefined;
      this.pendingInspectorClickRow = event.row;
      return;
    }
    // 侧栏可交互区域：按下只记 id 与屏幕行，松开落在同一行、同一区域才算一次点击，
    // 拖动经过时不会误触。深层区域（配置单价行、定价 agent 行）由命中顺序保证优先。
    const sidebarRegionId = this.sidebarRegionAt(event.column, event.row);
    if (sidebarRegionId) {
      this.pendingMouseSelection = undefined;
      this.pendingSidebarClick = { id: sidebarRegionId, row: event.row };
      return;
    }
    // 侧栏与分隔带不是对话内容：在这里按下不开选区，否则拖选会把侧栏文字带进复制结果。
    if (this.isPointerInSidebar(event.column)) {
      this.pendingMouseSelection = undefined;
      this.pendingInputSelection = undefined;
      this.textSelection.clear();
      this.selectionLayout = undefined;
      this.scheduleRender();
      return;
    }
    // 「回到底部」浮标：按下只记屏幕行，松开仍在浮标内才算点击，不产生文本选区。
    if (this.isOnChatHint(event.column, event.row)) {
      this.pendingMouseSelection = undefined;
      this.pendingInputSelection = undefined;
      this.pendingSidebarClick = undefined;
      this.selectionPointer = undefined;
      this.textSelection.clear();
      this.selectionLayout = undefined;
      this.pendingChatHintClick = event.row;
      this.scheduleRender();
      return;
    }
    this.stopSelectionAutoScroll();
    this.selectionPointer = undefined;
    this.pendingSidebarClick = undefined;
    this.inputSelection.clear();
    this.pendingInputSelection = undefined;
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
  }

  /** 左键拖动：把待定的锚点转成真实选区，或推进进行中的选区。 */
  private handleLeftButtonDrag(event: TerminalMouseEvent): void {
    if (this.pendingInputSelection) {
      const pending = this.pendingInputSelection;
      if (pending.column === event.column && pending.row === event.row) {
        return;
      }
      this.pendingInputSelection = undefined;
      const geometry = this.inputSelectionGeometry;
      const anchorRow = this.inputRowIndexAt(pending.row);
      const anchor =
        geometry && anchorRow !== undefined
          ? inputCellFromPoint(geometry, anchorRow, pending.column - this.inputSelectionLeft)
          : undefined;
      if (anchor) {
        this.inputSelection.begin(anchor);
        this.updateInputSelection(event.column, event.row);
      }
      return;
    }

    if (this.inputSelection.dragging) {
      this.updateInputSelection(event.column, event.row);
      return;
    }

    if (this.pendingMouseSelection) {
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

    if (this.textSelection.dragging) {
      this.updateMouseSelection(event.column, event.row);
      return;
    }
  }

  /** 左键松开：按下时登记的待定状态在这里结算（同一处按下松开才算点击）。 */
  private handleLeftButtonUp(event: TerminalMouseEvent): void {
    if (this.pendingQueueSteer) {
      const pressed = this.pendingQueueSteer;
      this.pendingQueueSteer = undefined;
      const hit = this.queueSteerHitAt(event.column, event.row);
      if (
        hit &&
        hit.row === pressed.row &&
        hit.index === pressed.index &&
        hit.text === pressed.text
      ) {
        this.steerQueueItem(hit.index, hit.text);
      }
      return;
    }
    if (this.pendingInputSelection) {
      // 按下后没拖动：只是点了输入框，不产生选区，也不复制。
      this.pendingInputSelection = undefined;
      this.inputSelection.clear();
      this.scheduleRender();
      return;
    }

    if (this.inputSelection.dragging) {
      const geometry = this.inputSelectionGeometry;
      const row = this.inputRowIndexAt(event.row);
      const cell =
        geometry && row !== undefined
          ? inputCellFromPoint(geometry, row, event.column - this.inputSelectionLeft)
          : undefined;
      this.inputSelection.finish(cell);
      // 与对话区一致：松开即自动复制，高亮保留，方便继续调整选区。
      this.copyInputSelection(false);
      this.scheduleRender();
      return;
    }

    // 详情页内的点击：松开与按下同一行才处理（拖动时不误触）。
    if (this.pendingInspectorClickRow !== undefined) {
      const pressedRow = this.pendingInspectorClickRow;
      this.pendingInspectorClickRow = undefined;
      if (pressedRow === event.row) {
        // 两个整页视图共用同一个「按下-松开同一行才算点击」的通道，按当前打开的是谁分发。
        if (this.costLog) this.handleCostLogClick(event.column, event.row);
        else this.handleInspectorClick(event.column, event.row);
      }
      return;
    }

    // 侧栏可交互区域：按下与松开落在同一屏幕行、且仍命中同一块区域，才算一次点击。
    // 命中 id 相同这一点很关键——从「配置单价」行拖到「花费」行松开，不该跳出费用明细。
    if (this.pendingSidebarClick !== undefined) {
      const pending = this.pendingSidebarClick;
      this.pendingSidebarClick = undefined;
      if (
        pending.row === event.row &&
        this.sidebarRegionAt(event.column, event.row) === pending.id
      ) {
        this.dispatchSidebarAction(pending.id);
      }
      return;
    }

    // 「回到底部」浮标：按下与松开都落在浮标内才跳到底，避免拖选误触。
    if (this.pendingChatHintClick !== undefined) {
      const pressed = this.pendingChatHintClick;
      this.pendingChatHintClick = undefined;
      if (pressed === event.row && this.isOnChatHint(event.column, event.row)) {
        this.scrollChat(-this.chatScrollOffset);
      }
      return;
    }

    if (this.pendingMouseSelection) {
      const pending = this.pendingMouseSelection;
      this.pendingMouseSelection = undefined;
      this.selectionPointer = undefined;
      this.selectionLayout = undefined;
      // 单击 = 按下与松开在同一屏幕行：命中摘要行则切换该段、命中工具块头行/指示行
      // 则切换该块（二级折叠），其余情况与今天一致。
      if (pending.row === event.row) {
        const segmentId = this.foldHeaderRows.get(pending.logicalRow);
        const screenOffset = pending.row - (this.chatViewport?.screenTop ?? 0);
        if (segmentId !== undefined) {
          this.toggleFoldSegment(segmentId, screenOffset);
        } else {
          const blockId = this.toolBlockHits.get(pending.logicalRow);
          if (blockId !== undefined) {
            this.toggleToolBlock(blockId, screenOffset);
          }
        }
      }
      return;
    }

    if (this.textSelection.dragging) {
      const cell = this.getChatCellFromMouse(event.column, event.row, true);
      this.stopSelectionAutoScroll();
      this.selectionPointer = undefined;
      this.textSelection.finish(cell);
      // 松开鼠标即自动复制，不必再按 Ctrl+C；高亮保留，方便继续调整选区。
      this.copyChatSelection(false);
      this.scheduleRender();
    }
  }

  /**
   * 解析鼠标位置命中的侧栏区域 id；不在任何区域上时返回 undefined。
   *
   * 命中区按 depth 升序登记（见 buildSidebarFrame 末尾的排序），所以从后往前找
   * 就等价于"深层优先"：定价 agent 行 > 配置单价行 > 整块费用。
   */
  private sidebarRegionAt(column: number, row: number): string | undefined {
    let found: string | undefined;
    for (const [id, hit] of this.sidebarHits) {
      if (
        column >= hit.columnStart &&
        column <= hit.columnEnd &&
        row >= hit.rowStart &&
        row <= hit.rowEnd
      ) {
        found = id;
      }
    }
    return found;
  }

  /**
   * 分发一次侧栏点击。
   *
   * 上下文详情页由 TerminalUI 自己拥有，就地处理；其余交给调用方按 id 查表，
   * 这样新增可点区域时只需要在 tui-sidebar.ts 登记 + 在调用方补一条映射。
   */
  private dispatchSidebarAction(id: string): void {
    if (id === "context.ring" || id === "context.usage") {
      this.openContextInspector();
      return;
    }
    // 费用明细开关也由 TerminalUI 自己处理：它只改侧栏密度，不开浮层，
    // 让宿主去实现反而会多一层无意义的回调。
    if (id === "cost.detail") {
      this.toggleCostDetailRows();
      return;
    }
    this.options.onSidebarAction?.(id);
  }

  private readonly handleMouseData = (data: Buffer | string) => {
    if (this.protocolFlushTimer) {
      clearTimeout(this.protocolFlushTimer);
      this.protocolFlushTimer = null;
    }

    for (const event of this.protocolParser.push(data)) {
      this.dispatchProtocolEvent(event);
    }

    // 只有单独 Esc 走短窗口：它要么是真正的中止键，要么是 Alt+键的首字节。
    // 鼠标/粘贴等长序列仍用 80ms，避免慢速链路上的分包被误判成键盘输入。
    const flushDelay = this.protocolParser.isLoneEscapePending()
      ? LONE_ESCAPE_FLUSH_MS
      : PROTOCOL_FLUSH_MS;
    this.protocolFlushTimer = setTimeout(() => {
      this.protocolFlushTimer = null;
      for (const event of this.protocolParser.flushPending()) {
        this.dispatchProtocolEvent(event);
      }
    }, flushDelay);
  };

  private readonly dispatchKeypress = (value: string, key: readline.Key) => {
    // 看图模式下任意键（含 Esc / 方向键）都只做一件事：退出看图。
    if (this.imageOverlay) {
      this.closeImageOverlay();
      return;
    }
    // 输入管理优先接收 Esc / Ctrl+C，绝不透传给回合中止或其他浮层。
    if (!this.activeSelection && this.inputManager && this.handleInputManagerKey(value, key))
      return;
    if (!this.activeSelection && key.meta && !key.ctrl && (key.name === "q" || key.name === "a")) {
      this.openInputManager(key.name === "q" ? "queue" : "attachments");
      return;
    }
    if (this.toggleTaskPanel(value, key)) return;
    // Ctrl+E：侧栏费用明细的键盘入口。与鼠标点「▸ 明细」走同一条路径，
    // 没有已计费调用时什么都不做（不白刷一帧）。
    if (isRealCtrlE(value, key) && !this.activeSelection && this.toggleCostDetailRows()) return;
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
    if (this.copyChatSelection() || this.copyInputSelection()) {
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
    if (!this.activeInput || this.activeInput.sensitive || this.inputManager?.draft) return [];
    const files = this.getFileAttachments();
    const chips = [
      ...files.map((file) => `[${file.path} · ${file.note ?? "就绪"}]`),
      ...this.pendingImages.map((image) => `[${image.displayName}]`),
    ];
    if (chips.length === 0) return [];
    return [
      truncateText(
        `附件 ${chips.length} · Alt+A 管理 ${sanitizeTerminalText(chips.join(" "))}`,
        width,
      ),
    ];
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
    // 输入框选区以 layoutInput 的 positions 为准（每行提示符、软换行都不进文档）。
    const previousDocument = this.inputSelectionGeometry?.document;

    if (layout.rows.length <= maxRows) {
      this.inputSelectionGeometry = buildInputSelectionGeometry(
        graphemes,
        layout,
        layout.rows.length,
        0,
      );
      this.dropStaleInputSelection(previousDocument);
      return { rows: layout.rows, cursor };
    }

    const firstVisibleRow = Math.min(
      Math.max(0, cursor.row - maxRows + 1),
      layout.rows.length - maxRows,
    );

    this.inputSelectionGeometry = buildInputSelectionGeometry(
      graphemes,
      layout,
      maxRows,
      firstVisibleRow,
    );
    this.dropStaleInputSelection(previousDocument);

    return {
      rows: layout.rows.slice(firstVisibleRow, firstVisibleRow + maxRows),
      cursor: { row: cursor.row - firstVisibleRow, column: cursor.column },
    };
  }

  /**
   * 输入内容变了（打字、退格、召回历史、粘贴）：旧的字符偏移已经指向别的文字，
   * 选区必须丢弃——否则高亮会盖在错的字上，Ctrl+C 还会复制错内容。
   */
  private dropStaleInputSelection(previousDocument: string | undefined): void {
    if (!this.inputSelection.active) return;
    if (this.inputSelectionGeometry?.document === previousDocument) return;
    this.inputSelection.clear();
    this.pendingInputSelection = undefined;
  }

  private getCommandSuggestions(activeInput: ActiveInput): readonly SlashCommand[] {
    if (activeInput.sensitive || activeInput.historyNavigationActive) {
      return [];
    }
    return matchSlashCommands(activeInput.graphemes.join(""), activeInput.slashCommands);
  }

  /** 当前输入尾部的 @ 文件引用词（如 "src/te"）；不在引用状态时返回 undefined。 */
  private detectFileMentionQuery(text: string): string | undefined {
    return fileMentionQuery(text)?.query;
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
      : this.detectFileMentionQuery(
          activeInput.graphemes.slice(0, activeInput.cursorIndex).join(""),
        );
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
    const prefix = activeInput.graphemes.slice(0, activeInput.cursorIndex).join("");
    const match = fileMentionQuery(prefix);
    const candidate = this.fileMentionCandidates[this.fileMentionSelectedIndex];
    if (!match || !candidate) return false;
    const before = prefix.slice(0, match.start);
    const after = activeInput.graphemes.slice(activeInput.cursorIndex).join("");
    const completed = `${before}${formatFileMention(candidate)} `;
    activeInput.graphemes = splitGraphemes(`${completed}${after}`);
    activeInput.cursorIndex = splitGraphemes(completed).length;
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
    if (this.inputManager) return this.getInputManagerRows(width, maxRows);
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
      return windowMenuRows(
        this.fileMentionCandidates.map((candidate) => ({
          label: candidate,
          description: "@ 引用文件",
        })),
        this.fileMentionSelectedIndex,
        width,
        maxRows,
      );
    }

    const suggestions = this.getCommandSuggestions(activeInput);
    if (suggestions.length === 0) return [];

    activeInput.selectedCommandIndex = Math.min(
      activeInput.selectedCommandIndex,
      suggestions.length - 1,
    );
    return windowMenuRows(
      suggestions.map((item) => ({
        label: item.argHint ? `${item.command} ${item.argHint}` : item.command,
        description: item.group ? `${item.description} · ${item.group}` : item.description,
      })),
      activeInput.selectedCommandIndex,
      width,
      maxRows,
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

  private selectionItems(selection: ActiveSelection): readonly TerminalSelectionItem[] {
    const query = selection.options.searchable ? selection.query?.trim().toLowerCase() : "";
    if (!query) return selection.options.items;
    return selection.options.items.filter((item) =>
      `${item.label} ${item.value} ${item.description ?? ""}`.toLowerCase().includes(query),
    );
  }

  private getSelectionRows(width: number, maxRows: number): string[] {
    const activeSelection = this.activeSelection;
    if (!activeSelection || maxRows <= 0) {
      return [];
    }

    const { options } = activeSelection;
    const items = this.selectionItems(activeSelection);
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

    if (options.searchable) {
      rows.push(
        `${SEQ.muted}${truncateText(`搜索：${activeSelection.query || "输入关键词"} · ${items.length}/${options.items.length} · 退格删除`, width)}${SEQ.reset}`,
      );
      if (items.length === 0) rows.push(`${SEQ.muted}没有匹配的选项${SEQ.reset}`);
    }

    if (options.preview?.length) {
      // 至少给选项留出三行（或全部选项），其余高度给预览。
      const reservedItemRows = Math.min(items.length, 3);
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
      Math.max(0, items.length - availableItemRows),
    );
    const visibleItems = items.slice(firstVisibleIndex, firstVisibleIndex + availableItemRows);

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
   * 悬停提示需要 1003（any-event）跟踪，它会让终端把所有鼠标移动都发上来。
   * 侧栏圆环与对话区工具块/摘要行的悬停都依赖它，交互模式下常开；
   * 悬停目标没变就不重绘，报文密度高也不会拖慢渲染。
   */
  private setMouseMotionEnabled(enabled: boolean): void {
    if (this.mouseMotionEnabled === enabled) return;
    this.mouseMotionEnabled = enabled;
    stdout.write(enabled ? "\x1b[?1003h" : "\x1b[?1003l");
  }

  /**
   * 鼠标移动时只关心悬停区域有没有变，避免每次移动都重绘。
   * 悬停 id 变了才渲染：终端里 any-event 跟踪的报文密度很高，逐帧重绘会明显掉速。
   */
  private updateSidebarHover(column: number, row: number): void {
    const next = this.sidebarRegionAt(column, row);
    if (next === this.sidebarHoverId) return;
    this.sidebarHoverId = next;
    this.scheduleRender(true);
  }

  /**
   * 对话区悬停：指针落在工具块（整块行区间）或过程段摘要行上时记为悬停目标，
   * 渲染层据此给头行加下划线 / 摘要行换强调色。目标没变就不重绘——
   * any-event 跟踪的移动报文密度很高，逐帧重绘会明显掉速。
   */
  private updateChatHover(column: number, row: number): void {
    let next: { type: "block"; id: number } | { type: "fold"; id: number } | undefined;
    if (!this.contextInspector && !this.costLog && !this.isPointerInSidebar(column)) {
      const logicalRow = this.getLogicalChatRow(row);
      if (logicalRow !== undefined) {
        for (const [blockId, range] of this.toolBlockRanges) {
          if (logicalRow >= range.startRow && logicalRow <= range.endRow) {
            next = { type: "block", id: blockId };
            break;
          }
        }
        if (next === undefined) {
          const segmentId = this.foldHeaderRows.get(logicalRow);
          if (segmentId !== undefined) next = { type: "fold", id: segmentId };
        }
      }
    }
    const current = this.chatHoverTarget;
    const unchanged =
      (current === undefined && next === undefined) ||
      (current !== undefined &&
        next !== undefined &&
        current.type === next.type &&
        current.id === next.id);
    if (unchanged) return;
    this.chatHoverTarget = next;
    this.scheduleRender(true);
  }

  /** 一次性反馈只安排结束帧；空闲时没有动画定时器。 */
  private scheduleSidebarPulseEnd(): void {
    if (this.sidebarPulseTimer) clearTimeout(this.sidebarPulseTimer);
    this.sidebarPulseTimer = setTimeout(() => {
      this.sidebarPulseTimer = null;
      this.scheduleRender();
    }, 800);
    this.sidebarPulseTimer.unref?.();
  }

  private buildSidebarState(): SidebarState {
    const pulseActive = (at: number | undefined): number | undefined =>
      at !== undefined && Date.now() - at < 800 ? at : undefined;
    return {
      usedTokens: this.usedTokens,
      maxTokens: this.maxTokens,
      workspace: this.workspaceStatus,
      ...(this.contextBreakdown ? { breakdown: this.contextBreakdown } : {}),
      ...(this.sidebarGoal ? { goal: this.sidebarGoal } : {}),
      costCny: this.costCny,
      costRequests: this.costRequests,
      costDetailsExpanded: this.costDetailRowsExpanded,
      hasUnpricedCost: this.costHasUnpriced,
      ...(this.costUnpricedModels.length > 0 ? { unpricedModels: this.costUnpricedModels } : {}),
      ...(this.pricingAgentState ? { pricingAgent: this.pricingAgentState } : {}),
      ...(this.costCachedPromptTokens > 0
        ? { cachedPromptTokens: this.costCachedPromptTokens }
        : {}),
      ...(this.costOffPeakRequests > 0 ? { offPeakRequests: this.costOffPeakRequests } : {}),
      promptTokens: this.costPromptTokens,
      completionTokens: this.costCompletionTokens,
      lastTurnMs: this.lastTurnMs,
      compactionCount: this.compactionCount,
      taskPlan: this.taskPanelTitle
        ? {
            title: this.taskPanelTitle,
            items: this.taskPanelItems,
            expanded: this.taskPanelExpanded,
          }
        : undefined,
      agents: this.agentPanelItems,
      contextPulseAt: pulseActive(this.contextPulseAt),
      costPulseAt: pulseActive(this.costPulseAt),
      goalPulseAt: pulseActive(this.goalPulseAt),
      taskPulseAt: pulseActive(this.taskPulseAt),
      costDetailsPulseAt: pulseActive(this.costDetailsPulseAt),
    };
  }

  private buildActivityRow(width: number, withBadge = true): string {
    // 活动行右侧徽标：权限档 + ctx 用量。只在活动行顶替状态栏时需要；
    // 放在对话区尾部时状态栏仍在，徽标就重复了。
    const badge: ActivityBadge | undefined =
      withBadge && this.activityFrame && this.permissionMode
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

  /**
   * 全屏查看一张图片：清屏 → 贴图 → 图下一行说明，任意键返回原界面。
   * 序列由 terminal-image.ts 编码好，这里只负责摆放、失效旧帧和清理。
   */
  viewImage(view: ImageOverlayView): void {
    if (!this.interactive) {
      throw new Error("图片查看需要交互式终端");
    }
    this.imageOverlay = view;
    this.invalidateRenderedFrame();
    this.scheduleRender(true);
  }

  /** 关闭图片查看，并删掉 kitty 已贴在屏幕上的图。 */
  closeImageOverlay(): void {
    const overlay = this.imageOverlay;
    if (!overlay) return;
    this.imageOverlay = undefined;
    const cleanup = encodeDeleteImages(overlay.protocol, overlay.tmux);
    if (cleanup) stdout.write(cleanup);
    this.invalidateRenderedFrame();
    this.scheduleRender(true);
  }

  /**
   * 图片查看整屏一次性绘制，绕开逐行 diff：贴完图后把旧帧标记失效，
   * 返回对话区时走 fullRefresh 整体重画，避免残留图片或半截文字。
   */
  private renderImageOverlay(): void {
    const overlay = this.imageOverlay;
    if (!overlay) return;
    const width = Math.max(1, stdout.columns || 80);
    const height = Math.max(1, stdout.rows || 24);
    const captionRow = Math.min(height, overlay.rows + 1);
    const caption = truncateAnsiText(`${overlay.caption}  ·  任意键返回`, width);
    const frame =
      "\x1b[?2026h\x1b[?25l" +
      themeEnter() +
      "\x1b[2J\x1b[H" +
      overlay.sequence +
      `\x1b[${captionRow};1H${SEQ.muted}${caption}${SEQ.reset}` +
      "\x1b[?2026l";
    stdout.write(frame);
    this.invalidateRenderedFrame();
  }

  private invalidateRenderedFrame(): void {
    this.renderedScreenRows = [];
    this.renderedScreenWidth = 0;
    this.renderedScreenHeight = 0;
    // 屏幕整体失效伴随清屏或 /view 的 d=A：placement 与数据都可能没了，按未上传重置。
    this.resetInlineImageScreen();
  }

  /** 屏幕重置后：所有内联图回到「未放置、未上传」，下一次渲染强制重传重贴。 */
  private resetInlineImageScreen(): void {
    for (const segment of this.sealedSegments) {
      if (!segment.image) continue;
      segment.image.placed = undefined;
      segment.image.uploaded = false;
    }
  }

  /**
   * 内联图 placement 同步层：帧渲染末尾把每张可见内联图的 kitty placement 对齐到
   * 「本帧应有的屏幕位置」。位置未变 → 零输出；移动/改尺寸 → 同 (image id,
   * placement id) 重放，协议保证原地替换、无闪烁；部分可见 → 用源矩形（x/y/w/h）
   * 只贴可见的那段，滚动时图片随文本渐进出入视口；完全滚出 → 只删 placement
   * 保留数据，滚回来时一条 a=p 即恢复。
   */
  private syncInlineImages(frame: {
    visibleStart: number;
    visibleEnd: number;
    chatRegionStart: number;
    chatPadding: number;
    suppressed: boolean;
  }): string {
    if (this.sealedSegments.length === 0) return "";
    let output = "";
    let throttled = false;
    const now = Date.now();
    for (const segment of this.sealedSegments) {
      const state = segment.image;
      if (state?.desc.protocol !== "kitty" || !state?.desc.png) continue;
      const imageRows = state.fitted?.rows ?? 0;
      let desired: InlinePlacementSpec | undefined;
      if (!frame.suppressed && imageRows > 0 && state.fitted) {
        const entry = this.sealedRowIndex.find((item) => item.id === segment.id);
        if (entry) {
          const clipped = clipInlinePlacement(
            {
              start: entry.start,
              rows: imageRows,
              widthPx: state.desc.widthPx,
              heightPx: state.desc.heightPx,
            },
            frame,
          );
          if (clipped) {
            // 裁掉顶部若干行后，首个可见行就是图片矩形的新顶行。
            desired = {
              row:
                frame.chatRegionStart +
                1 +
                (entry.start + clipped.clippedRows - frame.visibleStart),
              col: frame.chatPadding + 1,
              cols: state.fitted.cols,
              rows: clipped.visibleRows,
              src: clipped.src,
            };
          }
        }
      }
      const verdict = diffInlinePlacements(state.placed, desired, state.uploaded);
      if (verdict.action === "none") continue;
      if (verdict.action === "delete") {
        output += encodeKittyPlacementDelete({
          id: state.kittyId,
          placementId: INLINE_PLACEMENT_ID,
          tmux: state.desc.tmux,
        });
        state.placed = undefined;
        continue;
      }
      if (verdict.plan.upload) {
        output += encodeKittyUpload(state.desc.png, { id: state.kittyId, tmux: state.desc.tmux });
        state.uploaded = true;
      }
      // 已在屏上的图滚动引发的行移/裁剪微调：节流限频。抑制时不更新状态，
      // 收尾定时器保证滚动停下后必有一帧把 placement 对齐到精确位置。
      if (
        !verdict.plan.upload &&
        state.placed !== undefined &&
        now - this.inlineImageLastPlaceAt < INLINE_IMAGE_SCROLL_NUDGE_MS
      ) {
        throttled = true;
        this.scheduleInlineImageSettle(
          INLINE_IMAGE_SCROLL_NUDGE_MS - (now - this.inlineImageLastPlaceAt),
        );
        continue;
      }
      // a=p 放在光标处：先定位到图片矩形顶行左列再放置；帧尾的 cursorState 会再定位光标。
      output += `\x1b[${verdict.plan.place.row};${verdict.plan.place.col}H`;
      output += encodeKittyPlacement({
        id: state.kittyId,
        placementId: INLINE_PLACEMENT_ID,
        cols: verdict.plan.place.cols,
        rows: verdict.plan.place.rows,
        src: verdict.plan.place.src,
        tmux: state.desc.tmux,
      });
      state.placed = verdict.plan.place;
      this.inlineImageLastPlaceAt = now;
    }
    this.inlineImageNudgePending = throttled;
    return output;
  }

  /** 滚动停下后补一帧，把被节流的图片微调落到精确位置。 */
  private scheduleInlineImageSettle(delayMs: number): void {
    if (this.inlineImageSettleTimer) return;
    this.inlineImageSettleTimer = setTimeout(
      () => {
        this.inlineImageSettleTimer = null;
        this.scheduleRender(true);
      },
      Math.max(0, delayMs),
    );
  }

  /** 段列表即将整体丢弃：释放其中内联图占用的终端图形配额。 */
  private disposeInlineImages(segments: readonly ChatSegment[]): void {
    for (const segment of segments) {
      const state = segment.image;
      if (state?.desc.protocol !== "kitty" || !state?.desc.png) continue;
      stdout.write(encodeKittyImageDispose(state.kittyId, state.desc.tmux));
    }
  }

  /** 启动动效已播放的毫秒数：首次画首屏时起算；关闭动效时返回 undefined（静止画面）。 */
  private startupMotionElapsed(): number | undefined {
    if (!this.options.startupMotion || process.env.HAJI_REDUCED_MOTION === "1") return undefined;
    this.startupMotionStartedAt ??= Date.now();
    const elapsed = Date.now() - this.startupMotionStartedAt;
    return elapsed < STARTUP_MOTION_MS ? elapsed : undefined;
  }

  /** 动效期间约 20 帧/秒；定时器 unref，不拖住进程退出。 */
  private scheduleStartupMotionFrame(): void {
    if (this.startupMotionTimer) return;
    this.startupMotionTimer = setTimeout(() => {
      this.startupMotionTimer = null;
      if (this.startupHomeAvailable()) this.scheduleRender(true);
    }, 50);
    this.startupMotionTimer.unref?.();
  }

  private renderStartupLauncher(width: number, height: number): void {
    const geometry = startupLauncherGeometry(width, height);
    const { inputWidth } = geometry;
    this.renderedInputWidth = inputWidth;
    this.inputSelectionLeft = geometry.inputLeft;
    // 卡片与状态行之外可用的行数：首行留白 + 状态行上方留白 + 状态行与末行。
    const budget = Math.max(1, height - geometry.footerRows - 2);
    const leading = this.queueText ? [truncateAnsiText(this.queueText, inputWidth)] : [];
    const chips = this.buildPastedImageRows(inputWidth).slice(0, 2);
    const reserved = leading.length + chips.length;
    const suggestions = this.getCommandSuggestionRows(
      inputWidth,
      Math.min(geometry.maxSuggestionRows, Math.max(0, budget - reserved - 1)),
    );
    const inputLayout = this.getInputLayout(
      inputWidth,
      Math.max(1, Math.min(geometry.maxInputRows, budget - reserved - suggestions.length)),
    );
    const inputRows = [...inputLayout.rows];
    if (this.activeInput && this.activeInput.graphemes.length === 0 && inputRows.length === 1) {
      const used = terminalWidth(inputRows[0]);
      const room = Math.max(0, inputWidth - used);
      const hint = STARTUP_PLACEHOLDERS.find((text) => terminalWidth(text) <= room);
      if (hint) inputRows[0] = `${inputRows[0]}${SEQ.faint}${hint}${SEQ.reset}`;
    }
    const cardRows = [...chips, ...inputRows];
    this.highlightInputRows(cardRows, chips.length);
    const frame = buildStartupLauncher({
      width,
      height,
      leading,
      cardRows,
      suggestions,
      sessions: this.recentSessions,
      selected: this.startupSelected,
      hovered: this.startupHovered,
      state: this.buildSidebarState(),
      model: {
        permissionMode: this.permissionMode,
        modelName: this.modelName,
        providerName: this.providerName,
        reasoningEffort: this.reasoningEffort,
      },
      notice: this.transientHintText || this.copiedNotice,
      hasDraft: Boolean(this.activeInput?.graphemes.length),
      motionElapsed: this.startupMotionElapsed(),
    });
    if (frame.animating) this.scheduleStartupMotionFrame();
    this.inputSelectionTop = frame.inputTop + chips.length;
    this.inputSelectionHeight = inputLayout.rows.length;
    this.startupHits = frame.hits.map((hit) => ({
      ...hit,
      row: hit.row + 1,
      left: hit.left + 1,
      right: hit.right + 1,
    }));
    if (!this.startupHits.some((hit) => hit.index === this.startupSelected))
      this.startupSelected = -1;
    this.sidebarHits.clear();
    this.sidebarHits.set("context.usage", {
      columnStart: geometry.left + 1,
      columnEnd: geometry.left + geometry.contentWidth,
      rowStart: frame.contextRow + 1,
      rowEnd: frame.contextRow + 1,
    });
    this.sidebarHoverId = undefined;
    this.chatAreaRightEdgeColumn = 0;
    this.chatViewport = undefined;
    this.chatHintHit = undefined;
    this.maxChatScrollOffset = 0;
    this.chatScrollOffset = 0;
    this.pendingWheelRows = 0;
    this.contextInspectorHit = undefined;
    this.costLogHit = undefined;
    this.setMouseMotionEnabled(true);
    const fullRefresh =
      width !== this.renderedScreenWidth ||
      height !== this.renderedScreenHeight ||
      this.renderedScreenRows.length !== height;
    const update = buildScreenUpdate(fullRefresh ? [] : this.renderedScreenRows, frame.rows);
    const cursorState = `\x1b[${this.inputSelectionTop + inputLayout.cursor.row + 1};${this.inputSelectionLeft + inputLayout.cursor.column + 1}H\x1b[?25h`;
    if (fullRefresh || update || cursorState !== this.renderedCursorState) {
      const accepted = stdout.write(
        `\x1b[?2026h\x1b[?25l${fullRefresh ? `${themeEnter()}\x1b[2J` : ""}${update}${cursorState}\x1b[?2026l`,
      );
      if (!accepted) this.stdoutBackpressured = true;
    }
    this.renderedScreenRows = frame.rows;
    this.renderedScreenWidth = width;
    this.renderedScreenHeight = height;
    this.renderedCursorState = cursorState;
    this.renderedChatRegionHeight = 0;
    this.renderedChatRegionStart = 0;
    this.renderedChatVisibleStart = 0;
  }

  /**
   * 整页视图（上下文详情 / 费用日志三层）：排出替换对话区的行，并按本帧几何重建命中表、
   * 把渲染时夹紧的选中下标回写进状态。没有打开的页面返回 undefined。
   * screenTop 是对话区首行的屏幕行号（1 基）。
   */
  private renderOverlayPage(
    width: number,
    height: number,
    screenTop: number,
  ): string[] | undefined {
    // 整页视图（上下文详情 / 费用日志）：整块替换对话区
    // （活动行、折叠段、悬停卡片都不参与本帧）。
    const inspectorFrame: ContextInspectorFrame | undefined = this.contextInspector
      ? buildContextInspectorFrame(
          {
            groups: this.contextInspector.groups,
            categoryIndex: this.contextInspector.categoryIndex,
            selectedIndex: this.contextInspector.selectedIndex,
            scroll: this.contextInspector.scroll,
          },
          width,
          height,
        )
      : undefined;
    // 费用页有两个层次：列表，以及按 Enter 进去的回合详情。详情页盖在列表之上，
    // 同一时刻只排一帧，命中表也随当前这一帧重建。
    const turnDetailView = this.costLog?.turnDetail;
    const requestFrame: RequestDetailFrame | undefined =
      this.costLog && turnDetailView?.openDetail
        ? buildRequestDetailFrame(
            {
              details: this.costLog.details,
              turn: turnDetailView.turn,
              selectedIndex: turnDetailView.selectedIndex,
              sort: this.costLog.sort,
            },
            width,
            height,
          )
        : undefined;
    const turnFrame: TurnDetailFrame | undefined =
      this.costLog && turnDetailView && !requestFrame
        ? buildTurnDetailFrame(
            {
              details: this.costLog.details,
              turn: turnDetailView.turn,
              selectedIndex: turnDetailView.selectedIndex,
            },
            width,
            height,
          )
        : undefined;
    const costLogFrame: CostLogFrame | undefined =
      this.costLog && !turnFrame
        ? buildCostLogFrame(
            {
              details: this.costLog.details,
              sort: this.costLog.sort,
              selectedIndex: this.costLog.selectedIndex,
            },
            width,
            height,
          )
        : undefined;
    const pageMinColumns = requestFrame
      ? REQUEST_DETAIL_MIN_COLUMNS
      : turnFrame
        ? TURN_DETAIL_MIN_COLUMNS
        : costLogFrame
          ? COST_LOG_MIN_COLUMNS
          : CONTEXT_INSPECTOR_MIN_COLUMNS;
    const pageMinRows = requestFrame
      ? REQUEST_DETAIL_MIN_ROWS
      : turnFrame
        ? TURN_DETAIL_MIN_ROWS
        : costLogFrame
          ? COST_LOG_MIN_ROWS
          : CONTEXT_INSPECTOR_MIN_ROWS;
    const pageName = requestFrame
      ? "请求详情页"
      : turnFrame
        ? "回合详情页"
        : costLogFrame
          ? "费用日志页"
          : "上下文详情页";
    // 页面比终端还小的时候不渲染页面内容：一行说明足够，也避免行宽溢出打乱整帧。
    const pageTooSmall = Boolean(
      (inspectorFrame || costLogFrame || turnFrame || requestFrame) &&
        (width < pageMinColumns || height < pageMinRows),
    );
    // 命中区域按屏幕坐标（1 基）换算：frame 内行号是 0 基，列号也是 0 基。
    if (inspectorFrame && !pageTooSmall) {
      this.inspectorMaxScroll = inspectorFrame.maxScroll;
      this.contextInspectorHit = {
        listTop: screenTop + inspectorFrame.listTop,
        listHeight: inspectorFrame.listHeight,
        listLeft: inspectorFrame.listLeft + 1,
        listWidth: inspectorFrame.listWidth,
        listOffset: inspectorFrame.listOffset,
        backRow: screenTop + inspectorFrame.back.row,
        backLeft: inspectorFrame.back.left + 1,
        backWidth: inspectorFrame.back.width,
      };
      if (this.contextInspector) {
        // 内容变短（换分类/换条目）时把滚动位置夹回有效范围，避免“滚过头”卡住。
        this.contextInspector.scroll = Math.min(
          this.contextInspector.scroll,
          inspectorFrame.maxScroll,
        );
      }
    } else {
      this.contextInspectorHit = undefined;
    }
    // 请求详情页没有列表：只登记返回按钮，列表区域留空（点击一律落到空）。
    if (requestFrame && !pageTooSmall && turnDetailView) {
      this.costLogHit = {
        listTop: 0,
        listHeight: 0,
        listLeft: 0,
        listWidth: 0,
        listOffset: 0,
        itemHeight: 1,
        backRow: screenTop + requestFrame.back.row,
        backLeft: requestFrame.back.left + 1,
        backWidth: requestFrame.back.width,
      };
      // 渲染时夹紧的下标回写，保证 ←→ 换页时和回合页光标一致。
      turnDetailView.selectedIndex = requestFrame.selectedIndex;
    }
    // 列表页与回合详情页共用一张命中表结构：谁在画就用谁的几何。
    const activeCostFrame = requestFrame ? undefined : (turnFrame ?? costLogFrame);
    if (activeCostFrame && !pageTooSmall && this.costLog) {
      this.costLogHit = {
        listTop: screenTop + activeCostFrame.listTop,
        listHeight: activeCostFrame.listHeight,
        listLeft: activeCostFrame.listLeft + 1,
        listWidth: activeCostFrame.listWidth,
        listOffset: activeCostFrame.listOffset,
        itemHeight: activeCostFrame.itemHeight,
        backRow: screenTop + activeCostFrame.back.row,
        backLeft: activeCostFrame.back.left + 1,
        backWidth: activeCostFrame.back.width,
      };
      // 渲染时会把超出范围的下标夹紧（比如详情页打开期间记录被清空），这里回写。
      if (turnFrame && turnDetailView) turnDetailView.selectedIndex = turnFrame.selectedIndex;
      else if (costLogFrame) this.costLog.selectedIndex = costLogFrame.selectedIndex;
    } else if (!requestFrame) {
      // 请求详情页的命中表在上面单独写好了，这里不能覆盖掉。
      this.costLogHit = undefined;
    }
    if (pageTooSmall) return [`${SEQ.muted}终端太小，放不下${pageName}（Esc 返回）${SEQ.reset}`];
    return inspectorFrame?.rows ?? requestFrame?.rows ?? turnFrame?.rows ?? costLogFrame?.rows;
  }

  /**
   * 输入区（排队提示 / 选择器或输入行 / 粘贴 chip / 补全候选 / 状态栏）按三档布局组装。
   * 返回整块行、输入行布局（选择器时为空）与光标所在输入首行在块内的偏移。
   */
  private buildInputBlock(options: {
    width: number;
    height: number;
    topRowCount: number;
    minimal: boolean;
    emergencyMinimal: boolean;
    showHints: boolean;
    statusBar: string;
    divider: string;
    inputDivider: string;
  }): { inputBlock: string[]; inputLayout?: VisibleInputLayout; inputCursorOffset: number } {
    const {
      width,
      height,
      topRowCount,
      minimal,
      emergencyMinimal,
      showHints,
      statusBar,
      divider,
      inputDivider,
    } = options;
    let inputLayout: VisibleInputLayout | undefined;
    let inputBlock: string[];
    let inputCursorOffset = 0;
    const leadingInputRows: string[] = [];
    leadingInputRows.push(
      ...this.getQueueRows(
        width,
        emergencyMinimal ? 0 : Math.max(1, Math.min(3, Math.floor(height / 6))),
      ),
    );
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
        : Math.max(1, height - topRowCount - visibleLeadingInputRows.length - (minimal ? 3 : 5));
      const selectionRows = this.getSelectionRows(width, maxSelectionRows);
      if (emergencyMinimal) {
        inputBlock = [...visibleLeadingInputRows, ...selectionRows, ...emergencyStatusRows];
      } else if (minimal) {
        inputBlock = [...visibleLeadingInputRows, ...selectionRows, statusBar];
      } else {
        inputBlock = [...visibleLeadingInputRows, divider, ...selectionRows, divider, statusBar];
      }
    } else {
      const maxSuggestionRows = showHints
        ? Math.min(
            resolveHintRowBudget(height),
            Math.max(
              0,
              height - topRowCount - visibleLeadingInputRows.length - pastedRows.length - 5,
            ),
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
              topRowCount -
              visibleLeadingInputRows.length -
              pastedRows.length -
              suggestionRows.length -
              (minimal ? 3 : 5),
          );
      // 长输入在框内跟随光标滚动，保留对话与侧栏的垂直空间。
      const visibleInputRows = emergencyMinimal
        ? maxInputRows
        : Math.min(maxInputRows, Math.max(1, Math.min(6, Math.floor(height / 4))));
      this.renderedInputWidth = width;
      inputLayout = this.getInputLayout(width, visibleInputRows);
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
        inputCursorOffset = visibleLeadingInputRows.length + 1 + pastedRows.length;
        // 输入区上下各一条分隔线：中间只放输入行（与粘贴 chip），底行由状态栏承担；
        // 有活动时活动状态顶替状态栏，不再单独占行。
        // 斜杠 / @ 补全候选画在下方分隔线之外——列表属于临时浮层，不该撑高输入框，
        // 也不该把光标顶到框中间。
        inputBlock = [
          ...visibleLeadingInputRows,
          inputDivider,
          ...pastedRows,
          ...inputLayout.rows,
          inputDivider,
          ...suggestionRows,
          statusBar,
        ];
      }
    }
    return { inputBlock, inputLayout, inputCursorOffset };
  }

  private renderFrame(): void {
    this.queueSteerHits = [];
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

    // 图片查看是独立整屏视图：有它就只画图，返回时旧帧已失效，自然回到全量重绘。
    if (this.imageOverlay) {
      this.renderImageOverlay();
      return;
    }

    const layout = resolveTuiLayout(
      Math.max(1, stdout.columns || 80),
      Math.max(1, stdout.rows || 24),
    );
    const width = Math.max(1, layout.safeWidth);
    const height = Math.max(1, layout.safeHeight);
    this.inputSelectionLeft = 0;
    if (this.startupHomeAvailable() && width >= 24 && height >= 10) {
      this.renderStartupLauncher(width, height);
      return;
    }
    // 右侧会话信息栏：只占对话区高度，顶框、输入框与状态栏都收窄到左区宽度，
    // 让整块左侧内容的右边界对齐；侧栏下方的右侧留背景空白，不再横跨整行。
    // 整页视图（上下文详情 / 费用日志）打开时侧栏临时收起，把整行宽度让给页面（退出即恢复）。
    const pageOpen = Boolean(this.contextInspector) || Boolean(this.costLog);
    const sidebarWidth = pageOpen ? 0 : resolveSidebarWidth(width, height, this.sidebarEnabled);
    const sidebarVisible = sidebarWidth > 0;
    const leftAreaWidth = Math.max(
      1,
      width - (sidebarVisible ? sidebarWidth + SIDEBAR_GAP_WIDTH : 0),
    );
    // 记下对话区的右边界：鼠标落在这之后的一律算侧栏，不参与文本选区。
    this.chatAreaRightEdgeColumn = sidebarVisible ? leftAreaWidth : 0;
    const persistentHeader = this.sessionTitle
      ? `${this.options.compactHeader}  ${SEQ.muted}${truncateText(this.sessionTitle, Math.max(1, leftAreaWidth - 7))}${SEQ.reset}`
      : this.options.compactHeader;
    const header =
      layout.headerMode === "hidden"
        ? ""
        : this.startupHeaderVisible
          ? layout.headerMode === "full"
            ? this.options.header
            : persistentHeader
          : `${" ".repeat(layout.chatPadding)}${persistentHeader}`;
    const headerInfo =
      this.startupHeaderVisible && layout.headerMode === "full" ? this.headerInfo : [];
    const headerRows = header
      ? [
          ...wrapAnsi(header, leftAreaWidth),
          ...(headerInfo.length
            ? ["", ...headerInfo.flatMap((l) => wrapAnsi(l, leftAreaWidth))]
            : []),
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
    const divider = this.options.renderBorder(leftAreaWidth);
    const inputDivider =
      paperSidebarEnabled() && this.activeInput
        ? `${SEQ.softAccent}${"-".repeat(leftAreaWidth)}${SEQ.reset}`
        : divider;
    const minimal = layout.mode === "minimal";
    const emergencyMinimal = minimal && height < 8;
    // 活动行放在对话区尾部（空一行跟在最新内容之后，内容满屏时固定在对话区底部），
    // 底栏的状态栏因此常驻。minimal 档对话区放不下，仍退回旧行为：活动行顶替状态栏。
    // 临时提示（Ctrl+C 确认等）、复制角标与状态栏轮换：有提示时占位、超时自动消失。
    // 活动行不搬进侧栏——侧栏只显示上下文/费用/任务这些状态量。
    let activityInChat = Boolean(this.activityFrame) && !minimal && !pageOpen;
    const activityRow =
      (activityInChat ? "" : this.buildActivityRow(leftAreaWidth)) ||
      (this.copiedNotice && topRows.length === 0
        ? truncateAnsiText(`${SEQ.bold}${SEQ.green}${this.copiedNotice}${SEQ.reset}`, leftAreaWidth)
        : "") ||
      (this.transientHintText ? truncateAnsiText(this.transientHintText, leftAreaWidth) : "") ||
      (this.status ? truncateAnsiText(this.status, leftAreaWidth) : "");
    const statusBar =
      !emergencyMinimal && activityRow
        ? activityRow
        : this.buildStatusBar(leftAreaWidth, layout.statusDetail);
    const { inputBlock, inputLayout, inputCursorOffset } = this.buildInputBlock({
      width: leftAreaWidth,
      height,
      topRowCount: topRows.length,
      minimal,
      emergencyMinimal,
      showHints: layout.showHints,
      statusBar,
      divider,
      inputDivider,
    });
    const chatHeight = emergencyMinimal
      ? Math.max(0, height - inputBlock.length)
      : Math.max(1, height - topRows.length - 1 - inputBlock.length);
    // 对话区至少要留一行正文给活动行（空行 + 活动行）让位；多行输入把它挤小时退回底栏。
    if (activityInChat && chatHeight < CHAT_ACTIVITY_ROWS + 1) {
      activityInChat = false;
      inputBlock[inputBlock.length - 1] = this.buildActivityRow(leftAreaWidth);
    }
    // 输入框正文的屏幕行区间（供鼠标拖选命中）与选区高亮。
    // 顺序：先按未着色的行算出几何，再把高亮写回 inputBlock 的对应位置。
    if (inputLayout) {
      const inputTop = emergencyMinimal ? chatHeight : topRows.length + 1 + chatHeight;
      this.inputSelectionTop = inputTop + inputCursorOffset;
      this.inputSelectionHeight = inputLayout.rows.length;
      this.highlightInputRows(inputBlock, inputCursorOffset);
    } else {
      // 选择器打开时输入框让位：选区一并清掉，避免残留高亮。
      this.inputSelectionTop = undefined;
      this.inputSelectionHeight = 0;
      this.inputSelection.clear();
      this.pendingInputSelection = undefined;
    }
    // 对话区使用响应式内边距：内容按收窄后的宽度换行，
    // 渲染时再在每行前补空格；右侧由 buildScreenUpdate 的 \x1b[2K 自然露出主题背景。
    const chatPadding = layout.chatPadding;
    const chatWidth = Math.max(1, leftAreaWidth - chatPadding * 2);
    // 实时区域（工具草稿 / 工具格 / 推理预览）是独立块，与正文之间留一个空行：
    // 正文经 updateChatFrom 写入时不以换行结尾，只补一个换行会让它和工具块贴在一起。
    // 正式工具格提交前已有 writeBlankLine，这里只在还缺空行时补，避免出现连续空行。
    const liveTailGap =
      !this.liveTail || !this.chatContent
        ? ""
        : this.chatContent.endsWith("\n\n")
          ? ""
          : this.chatContent.endsWith("\n")
            ? "\n"
            : "\n\n";
    const contentWithStatus = this.liveTail
      ? `${this.chatContent}${liveTailGap}${this.liveTail}`
      : this.chatContent;
    const contentChanged =
      contentWithStatus !== this.cachedContentWithStatus || chatWidth !== this.cachedWrappedWidth;
    const previousWrappedCount = this.cachedWrappedChat.length;
    const tailRows = this.getWrappedChat(contentWithStatus, chatWidth);
    // 只有尾部会在底部增长；已封口区的行数变化一律交给滚动锚点处理。
    const tailRowDelta = tailRows.length - previousWrappedCount;
    const sealedRows = this.getSealedRows(chatWidth);
    const wrappedChat = sealedRows.length > 0 ? sealedRows.concat(tailRows) : tailRows;
    // 活动行不进 chatContent：动画帧不会让折行缓存失效，也不会被选区复制出去。
    const activityRows = activityInChat
      ? ["", `${" ".repeat(chatPadding)}${this.buildActivityRow(chatWidth, false)}`]
      : [];
    const chatViewportHeight = chatHeight - (activityInChat ? CHAT_ACTIVITY_ROWS : 0);
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
    const sidebarScreenTop = this.workspaceStatus ? 0 : emergencyMinimal ? 0 : topRows.length + 1;
    const sidebarFrame = sidebarVisible
      ? buildSidebarFrame(
          this.buildSidebarState(),
          sidebarWidth,
          this.workspaceStatus ? height : chatHeight,
          Date.now(),
          this.sidebarHoverId,
        )
      : { rows: [] as string[], ring: undefined, regions: [] };
    const sidebarRows = sidebarFrame.rows;
    // 把侧栏局部坐标换算成屏幕 1-based 坐标，重建本帧的命中表。
    // 一次遍历覆盖所有区域：新增可点区域只需在 buildSidebarFrame 里登记，
    // 这里不用再跟着加一组字段、一个分支。
    this.sidebarHits.clear();
    if (sidebarVisible) {
      const columnBase = leftAreaWidth + SIDEBAR_GAP_WIDTH + 1;
      const rowBase = sidebarScreenTop + 1;
      for (const region of sidebarFrame.regions) {
        const columnStart = columnBase + region.hit.left;
        const rowStart = rowBase + region.hit.top;
        this.sidebarHits.set(region.id, {
          columnStart,
          columnEnd: columnStart + region.hit.width - 1,
          rowStart,
          rowEnd: rowStart + region.hit.height - 1,
        });
      }
    }
    // 命中的区域这一帧可能已经消失（比如费用表被挤掉）：悬停 id 一并作废。
    if (this.sidebarHoverId !== undefined && !this.sidebarHits.has(this.sidebarHoverId)) {
      this.sidebarHoverId = undefined;
    }
    if (this.pendingSidebarClick && !this.sidebarHits.has(this.pendingSidebarClick.id)) {
      this.pendingSidebarClick = undefined;
    }
    // 悬停提示（侧栏圆环 + 对话区工具块/摘要行）都需要 1003 any-event 跟踪；
    // 目标没变不重绘，移动报文本身的处理成本可以忽略。
    this.setMouseMotionEnabled(true);
    // 圆环悬停卡片：浮层贴在对话区右侧，不占侧栏行数、不改变对话滚动布局，
    // 鼠标移开就消失——比在侧栏里内联展开更不打扰（费用表不会被顶走）。
    const contextCard =
      sidebarVisible &&
      this.sidebarHoverId === "context.ring" &&
      this.contextBreakdown &&
      sidebarFrame.ring
        ? buildContextCard(this.contextBreakdown, this.usedTokens, this.maxTokens, leftAreaWidth)
        : undefined;
    const cardTop = contextCard
      ? Math.max(
          0,
          Math.min(
            chatHeight - contextCard.length,
            sidebarScreenTop +
              (sidebarFrame.ring?.top ?? 0) -
              (emergencyMinimal ? 0 : topRows.length + 1) -
              1,
          ),
        )
      : 0;
    const paintContextCard = (row: string, index: number): string => {
      const cardRow = contextCard?.[index - cardTop];
      if (cardRow === undefined) return row;
      const cardWidth = Math.min(leftAreaWidth, terminalWidth(cardRow));
      const left = Math.max(1, leftAreaWidth - cardWidth + 1);
      const head = truncateAnsiText(row, left - 1);
      const pad = " ".repeat(Math.max(0, left - 1 - terminalWidth(head)));
      const tail = " ".repeat(Math.max(0, leftAreaWidth - (left - 1) - cardWidth));
      return `${head}${pad}${truncateAnsiText(cardRow, cardWidth)}${tail}`;
    };
    // 整页视图（上下文详情 / 费用日志）：整块替换对话区
    // （活动行、折叠段、悬停卡片都不参与本帧）。命中区域按屏幕坐标（1 基）换算。
    const chatScreenTop = emergencyMinimal ? 1 : topRows.length + 2;
    const pageRows = this.renderOverlayPage(leftAreaWidth, chatHeight, chatScreenTop);
    const home = this.startupHomeAvailable()
      ? buildStartupHome(this.recentSessions, chatWidth, chatHeight, this.startupSelected)
      : undefined;
    this.startupHits = (home?.hits ?? []).map((hit) => ({
      ...hit,
      row: (emergencyMinimal ? 1 : topRows.length + 2) + hit.row,
      left: chatPadding + 1,
      right: leftAreaWidth - chatPadding,
    }));
    if (
      this.startupSelected >= 0 &&
      !this.startupHits.some((hit) => hit.index === this.startupSelected)
    ) {
      this.startupSelected = -1;
    }
    const chatColumn =
      pageRows ??
      (home?.rows.length
        ? home.rows.map((row) => chatPrefix + row)
        : [...visibleChat, ...activityRows]);
    const chatRows = [...chatColumn, ...new Array(chatHeight - chatColumn.length).fill("")];
    // 滚动离开底部时，在对话区底部正中画「回到底部」浮标：只覆盖渲染行，
    // 不参与换行/选区布局（复制出来的仍是正文原文）。
    this.paintScrollJumpHint(chatRows, {
      width: leftAreaWidth,
      height: chatHeight,
      bottomInset: activityRows.length,
      screenTop: chatScreenTop,
      enabled: !minimal && !pageOpen,
    });
    const composedChatRows = chatRows.map((row, index) => paintContextCard(row, index));
    const leftRows = emergencyMinimal
      ? [...composedChatRows, ...inputBlock]
      : [...topRows, divider, ...composedChatRows, ...inputBlock];
    this.updateQueueSteerHits(inputBlock, leftRows.length - inputBlock.length + 1);
    // 复制角标贴在顶行右端（标题行）；头部隐藏时改走底栏提示。
    // 先贴再合成侧栏，避免角标把贯穿的竖线切断。
    if (topRows.length > 0) this.overlayCopiedNotice(leftRows, leftAreaWidth);
    // 侧栏竖线贯穿整个高度：左侧每一行都补到左区宽度后接一条竖线，
    // 顶部/底部没有侧栏内容的行只留竖线与背景，保证右边界处处对齐。
    const screenRows = leftRows.slice(0, height).map((row, index) => {
      if (!sidebarVisible) return row;
      const chatIndex = index - sidebarScreenTop;
      const sidebarRow =
        chatIndex >= 0 && chatIndex < sidebarRows.length ? sidebarRows[chatIndex] : "";
      // 非对话行也走同一个拼接函数，保证宽度和三列间距不重复计算。
      return composeSidebarRow(
        row,
        leftAreaWidth,
        sidebarRow,
        sidebarWidth,
        sidebarFrame.surfaces?.[chatIndex],
      );
    });
    while (screenRows.length < height) {
      // 补齐的空行也要带上竖线，否则屏幕底部会缺一段分隔线、右边界错位。
      screenRows.push(sidebarVisible ? composeSidebarRow("", leftAreaWidth, "", sidebarWidth) : "");
    }
    const fullRefresh =
      width !== this.renderedScreenWidth ||
      height !== this.renderedScreenHeight ||
      this.renderedScreenRows.length !== height;
    const chatRegionStart = emergencyMinimal ? 0 : topRows.length + 1;
    const viewportScrollRows = this.renderedChatVisibleStart - visibleStart;
    const canScrollViewport =
      chatHeight > 0 &&
      !fullRefresh &&
      !contextCard &&
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
      const cursorColumn = Math.min(inputLayout.cursor.column, leftAreaWidth) + 1;
      const cursorRow = inputTop + inputCursorOffset + inputLayout.cursor.row + 1;
      cursorState = `\x1b[${cursorRow};${cursorColumn}H\x1b[?25h`;
    }

    // 有被节流的图片滚动微调没落地时不能提前返回：那一帧的 syncInlineImages 输出
    // 就是本帧唯一要做的事（文本与光标都没变）。
    if (
      !fullRefresh &&
      !screenUpdate &&
      cursorState === this.renderedCursorState &&
      !this.inlineImageNudgePending
    ) {
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
    // 2J 按协议清掉屏幕上的图（部分实现连同数据）：重置后全部按未上传处理，强制重传。
    if (fullRefresh) this.resetInlineImageScreen();
    // 内联图同步层：文本层画完后，把可见图的 kitty placement 对齐到本帧屏幕位置。
    // 无图或位置未变时零输出，不增加常规帧的负担。
    frame += this.syncInlineImages({
      visibleStart,
      visibleEnd,
      chatRegionStart,
      chatPadding,
      suppressed: Boolean(this.contextInspector),
    });
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
    // 草稿已提交/取消：输入框选区随之作废，避免下一次输入被高亮到错误位置。
    this.inputSelection.clear();
    this.pendingInputSelection = undefined;
    this.scheduleRender(true);

    if (error) {
      activeInput.reject(error);
    } else {
      if (!activeInput.sensitive) {
        this.inputHistory.record(redactSensitiveCommand(sanitizeTerminalText(value), ""));
      }
      activeInput.resolve(value);
    }
    // 选在 resolve 之后唤醒：先让提交方的后续（如恢复草稿的后台输入）排上队。
    this.notifyInputIdle();
  }

  private finishSelection(error?: Error): void {
    const activeSelection = this.activeSelection;
    if (!activeSelection) {
      return;
    }

    const selected = this.selectionItems(activeSelection)[activeSelection.selectedIndex];
    if (!error && !selected) return;
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
    // 选在 resolve 之后唤醒：选择器结束后才把输入行交回去。
    this.notifyInputIdle();
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

    const width = this.renderedInputWidth ?? Math.max(20, (stdout.columns || 80) - 1);
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
    if (
      activeSelection.options.searchable &&
      !key.ctrl &&
      !key.meta &&
      (key.name === "backspace" || (value && !/[\x00-\x1f\x7f]/u.test(value)))
    ) {
      const current = activeSelection.query ?? "";
      activeSelection.query =
        key.name === "backspace"
          ? splitGraphemes(current).slice(0, -1).join("")
          : (current + value).slice(0, 200);
      activeSelection.selectedIndex = 0;
      this.scheduleRender(true);
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
      const itemCount = this.selectionItems(activeSelection).length;
      if (itemCount === 0) return;
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
    // 详情页是只读覆盖层：导航键先归它；Esc 只关页面，不触发中止回合。
    // 其余按键（含普通输入）继续走输入框，所以用户可以直接打字继续对话。
    if (this.handleInspectorKey(key)) {
      return;
    }
    // 费用日志页同样是只读覆盖层：导航键先归它，Esc 只关页面。
    if (this.handleCostLogKey(key)) {
      return;
    }
    const activeInput = this.activeInput;
    if (!activeInput) {
      return;
    }
    if (this.startupHomeAvailable() && this.startupHits.length > 0) {
      // 空输入时 Tab / Shift+Tab 循环选择入口；已有选中项时 ↑↓ 也在入口间移动，Esc 取消选中。
      const empty = activeInput.graphemes.length === 0;
      const cycle =
        empty && key.name === "tab" && !key.ctrl && !key.meta
          ? key.shift
            ? -1
            : 1
          : this.startupSelected >= 0 && (key.name === "up" || key.name === "down")
            ? key.name === "up"
              ? -1
              : 1
            : 0;
      if (cycle !== 0) {
        const indices = [...new Set(this.startupHits.map((hit) => hit.index))].sort(
          (a, b) => a - b,
        );
        const current = indices.indexOf(this.startupSelected);
        const next =
          current < 0
            ? cycle > 0
              ? 0
              : indices.length - 1
            : (current + cycle + indices.length) % indices.length;
        this.startupSelected = indices[next];
        this.scheduleRender(true);
        return;
      }
      if (key.name === "escape" && this.startupSelected >= 0) {
        this.startupSelected = -1;
        this.scheduleRender(true);
        return;
      }
      if (
        (key.name === "return" || key.name === "enter") &&
        !key.shift &&
        !key.meta &&
        this.startupSelected >= 0
      ) {
        this.activateStartupAction(this.startupSelected);
        return;
      }
      this.startupSelected = -1;
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
