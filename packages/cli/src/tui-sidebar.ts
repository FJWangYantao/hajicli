/**
 * 右侧信息栏的纯构建函数：上下文主指标、费用表、任务与子代理。
 *
 * 与 terminal-panels.ts 同一模式：只读入标量状态并输出 ANSI 行，
 * 不做 I/O 与定时器，方便用固定宽度做单元测试。
 *
 * 分工约定：工作区摘要、进行中的目标/任务/子代理在前，上下文与费用在后。
 * provider/model、推理档与权限档由顶部与底栏负责；思考/运行工具留在对话区。
 */
import { type AgentPanelItem, buildAgentPanelRows, formatAgentTokens } from "./agent-panel.js";
import {
  CONTEXT_CATEGORIES,
  CONTEXT_CATEGORY_LABELS,
  type ContextBreakdown,
  type ContextCategory,
} from "./context-breakdown.js";
import {
  paperHoverBg,
  paperSidebarBg,
  paperSidebarEnabled,
  paperSidebarTransition,
  paperWorkBg,
} from "./paper-sidebar.js";
import { buildTaskPanelRows, type TaskPanelState } from "./terminal-panels.js";
import { sanitizeTerminalText } from "./terminal-sanitize.js";
import {
  fitHint,
  SEQ,
  splitGraphemes,
  terminalWidth,
  truncateAnsiText,
  truncateText,
} from "./terminal-text.js";
import type { WorkspaceStatus } from "./workspace-status.js";

/** 右侧信息栏显示所需状态（TerminalUI 持有，渲染时快照传入）。 */
export interface SidebarState {
  workspace?: WorkspaceStatus;
  extensions?: {
    mcp: readonly { name: string; state: "running" | "failed" | "disabled"; toolCount: number }[];
    skills: readonly { name: string; resident: boolean }[];
  };
  usedTokens: number;
  maxTokens: number;
  /** 上下文按类别的估算占用（系统/工具/记忆/文件/结果/对话）；缺省时只画圆环与总量。 */
  breakdown?: ContextBreakdown;
  /** 会话目标（/goal 设定）；缺省时不渲染目标区块。 */
  goal?: SidebarGoalState;
  /** 会话累计费用（元）；无定价请求时仍是已定价部分的合计。 */
  costCny?: number;
  /**
   * 费用明细（请求/输入/缓存/谷时/输出/上一轮）是否展开。
   * 默认折叠：侧栏只留「花费 + 需处理项」，明细由用户点开关按需展开。
   */
  costDetailsExpanded?: boolean;
  costRequests?: number;
  hasUnpricedCost?: boolean;
  /** 仍未定价的模型名：费用区据此给出「点击配置单价」入口。 */
  unpricedModels?: readonly string[];
  /** 后台定价 agent 的当前状态；运行中时在费用区显示一行进度。 */
  pricingAgent?: SidebarPricingAgentState;
  /**
   * PR 巡检入口提醒：仓库可推断、但巡检没在跑时出现，点一下即自动配置并启动。
   * 探测结果由调用方缓存后传入，渲染层不做任何 I/O。
   */
  patrol?: SidebarPatrolState;
  /** 会话累计输入/输出 tokens；用来解释费用构成（哪一头在烧钱）。 */
  promptTokens?: number;
  /** 其中命中缓存的输入 tokens（有缓存折扣的模型才可能 > 0）。 */
  cachedPromptTokens?: number;
  /** 按谷时价计费的请求数。 */
  offPeakRequests?: number;
  completionTokens?: number;
  /** 上一轮回合耗时（ms）；用于感知“慢在哪”。 */
  lastTurnMs?: number;
  /** 本会话上下文压缩次数；>0 时在上下文区显示“已压缩”徽标。 */
  compactionCount?: number;
  taskPlan?: TaskPanelState;
  agents?: readonly AgentPanelItem[];
  /** 一次性状态反馈的开始时间；未变化时不传，避免动画持续重播。 */
  contextPulseAt?: number;
  costPulseAt?: number;
  goalPulseAt?: number;
  taskPulseAt?: number;
  costDetailsPulseAt?: number;
}

/** 后台定价 agent 状态（费用区的单行提示）。 */
export interface SidebarPricingAgentState {
  status: "running" | "done" | "failed";
  /** 正在查询的模型名。 */
  model: string;
  /** 失败原因或结果摘要（可选，过长会被截断）。 */
  detail?: string;
}

/**
 * 侧栏 PR 巡检入口的状态。
 * 只有 `ready` 是可操作状态（点一下自动配置并启动）；其余两种只做状态提示。
 */
export interface SidebarPatrolState {
  status: "ready" | "running" | "no-token";
  /** ready 时探测到的、分支命中 agent 前缀的开放 PR 数。 */
  pending: number;
  /** running 时的任务总数。 */
  tasks?: number;
  /** running 时已合并的任务数。 */
  merged?: number;
  /** running 时「当前在做什么」，如 `#12 审查中 · 3m`；无进行中任务时缺省。 */
  activity?: string;
  /** 巡检仓库（owner/name），窄栏降级时只留它。 */
  repo?: string;
}

/** 侧栏目标区块的状态：原文由 /goal 设定，状态只有进行中 / 已达成两档。 */
export interface SidebarGoalState {
  text: string;
  status: "active" | "achieved";
}

/** 侧栏内一块可命中区域：相对侧栏首行的行偏移与相对侧栏首列的列偏移。 */
export interface SidebarHitArea {
  top: number;
  height: number;
  left: number;
  width: number;
}

/** 上下文圆环的命中区域（沿用同一套几何描述）。 */
export type SidebarRingGeometry = SidebarHitArea;

/**
 * 侧栏里可交互区域的稳定标识。
 *
 * 悬停高亮与点击动作都按它查表，所以不能用行号（行号每帧都在变）；
 * 新增可点区域时先在这里登记，再由 buildSidebarFrame 产出几何。
 */
export type SidebarRegionId =
  | "extensions.mcp"
  | "extensions.skills"
  /** PR 巡检入口行：点一下自动配置并启动后台巡检。 */
  | "patrol.entry"
  | "context.ring"
  | "context.usage"
  | "cost.summary"
  | "cost.config"
  | "cost.pricingAgent"
  // 费用表里每一行指标：点哪一行，就按哪一种口径把每一轮摊开（见 onSidebarAction）。
  | "cost.turn.cost"
  | "cost.turn.requests"
  | "cost.turn.input"
  | "cost.turn.output"
  | "cost.turn.cached"
  /**
   * 「明细」开关：费用明细默认折叠，点它才把 token 构成摊开。
   * 这是唯一一个不直接打开浮层、而是就地改侧栏布局的区域。
   */
  | "cost.detail";

/** 悬停表现：终端里只换颜色，绝不改变文本宽度与行数（否则命中区会从鼠标下滑走）。 */
export type SidebarHoverStyle =
  /** 不参与悬停（占位用，保留给以后的纯展示区域）。 */
  | "none"
  /** 整行文字由灰转常态色：适合数值行。 */
  | "text"
  /** 标题加粗并露出 ▸ 前缀：适合区块标题与入口行。 */
  | "label"
  /** 图形本身高亮（圆环）：悬停时环上弧线加粗。 */
  | "ring";

/** 一块可交互区域：纯几何 + 展示语义，动作由渲染层按 id 分发。 */
export interface SidebarRegion {
  id: SidebarRegionId;
  hit: SidebarHitArea;
  hover: SidebarHoverStyle;
  /**
   * 嵌套层级，命中时深的优先。
   * 费用区把「定价 agent 行」「配置单价行」套在整块费用之上，就靠它区分。
   */
  depth: number;
  /** 悬停时是否弹出浮层卡片（目前只有上下文圆环），供渲染层决定是否预载卡片内容。 */
  hasCard?: boolean;
}

export interface SidebarFrame {
  rows: string[];
  /**
   * 上下文圆环的几何；侧栏高度不足以画环时为 undefined。
   * 悬停卡片的定位也用它，所以这里保留几何本身而不只是命中区。
   */
  ring?: SidebarRingGeometry;
  /** 本帧全部可交互区域，按 depth 升序排列（命中时从后往前找）。 */
  regions: SidebarRegion[];
  /** 每行可选的表面色，拼接时铺满整行，不改变文本几何。 */
  surfaces?: Array<string | undefined>;
}

/** 低于该宽度或高度时右侧栏让位给对话区。 */
export const SIDEBAR_MIN_COLUMNS = 96;
export const SIDEBAR_MIN_ROWS = 18;
/** 对话区与侧栏之间的分隔带（空格 + 竖线 + 空格）。 */
export const SIDEBAR_GAP_WIDTH = 3;
/** 侧栏出现时必须给对话区留下的最小宽度。 */
export const SIDEBAR_MIN_CHAT_WIDTH = 72;
/** 侧栏右侧留白：文字不贴到终端最后一列（左侧的 1 列已由分隔带提供）。 */
const SIDEBAR_RIGHT_MARGIN = 1;
/**
 * 上下文与费用的最小预留行数，**含各自章节前的呼吸空行**：
 * 上下文 = 空行 + 标题 + 进度条 + 用量；费用 = 空行 + 标题 + 花费。
 *
 * 上下两块是常驻状态：目标、任务、代理再长也不能把它们整块挤出可见区域。
 * 上部区块按「总高度 − 预留」分配行数，宁可让目标/任务先收成摘要。
 */
const CONTEXT_MIN_ROWS = 4;
const COST_MIN_ROWS = 3;

/**
 * 侧栏密度：按可用高度逐级简化。
 *
 * - `full`：圆环（7 行）、逐条任务、逐条代理、压缩徽标、费用明细开关都给。
 * - `compact`：圆环最高 5 行，任务已完成项收成计数，代理只列活跃项。
 * - `minimal`：不画圆环（只留单行进度条）、任务与代理只留标题行（含计数）、
 *   不要压缩徽标——这时每一行都要么是主指标，要么是可操作入口。
 *
 * 三档只丢装饰，不丢数值：任务/代理的 done/total、运行中数量在标题行里仍然准确。
 */
export type SidebarDensity = "full" | "compact" | "minimal";

/** 高度 ≥ 该值时用满档；低于 `SIDEBAR_MINIMAL_MAX_ROWS` 时用最省的一档。 */
export const SIDEBAR_FULL_MIN_ROWS = 24;
export const SIDEBAR_MINIMAL_MAX_ROWS = 14;

export function sidebarDensity(maxRows: number): SidebarDensity {
  if (!Number.isFinite(maxRows) || maxRows <= SIDEBAR_MINIMAL_MAX_ROWS) return "minimal";
  if (maxRows < SIDEBAR_FULL_MIN_ROWS) return "compact";
  return "full";
}

/**
 * 计算右侧栏内容宽度；返回 0 表示不显示。
 * 宽度随终端增长；纸间需要容纳双侧内边距，保持在 32–36 列。
 */
export function resolveSidebarWidth(columns: number, rows: number, enabled: boolean): number {
  if (!enabled) return 0;
  if (!Number.isFinite(columns) || !Number.isFinite(rows)) return 0;
  if (columns < SIDEBAR_MIN_COLUMNS || rows < SIDEBAR_MIN_ROWS) return 0;
  const target = paperSidebarEnabled()
    ? Math.min(36, Math.max(32, Math.round(columns * 0.28)))
    : Math.min(34, Math.max(24, Math.round(columns * 0.26)));
  // 正文两侧最多各有三列内边距，预留后仍须满足阅读宽度。
  if (columns - target - SIDEBAR_GAP_WIDTH - 6 < SIDEBAR_MIN_CHAT_WIDTH) return 0;
  return target;
}

/** 金额：小额保留 4 位小数（否则全是 ¥0.00），大额收成 2 位。 */
function formatCostAmount(costCny: number): string {
  return `¥${costCny < 1 ? costCny.toFixed(4) : costCny.toFixed(2)}`;
}

function formatExactTokens(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

/** 上下文用量：百万级换成 M，避免出现 "1000k tokens" 这种读不出量级的写法。 */
function formatTokenBudget(value: number): string {
  const safe = Math.max(0, Math.round(value));
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(safe < 10_000_000 ? 1 : 0)}M`;
  return formatAgentTokens(safe);
}

/** 上一轮耗时：秒级保留一位小数，超过一分钟换成 m/s，避免 "83.4s" 这种难读的数。 */
export function formatTurnDuration(durationMs: number): string {
  const safeMs = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  if (safeMs < 60_000) return `${(safeMs / 1000).toFixed(1)}s`;
  const seconds = Math.round(safeMs / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * 按显示宽度贪心折行（宽字符占 2 列），最多保留 maxLines 行；
 * 超出的内容在末行以省略号截断。侧栏目标原文可能很长，这里只给摘要。
 */
/**
 * 不能出现在行首的字符：中文标点必须贴着前一个字。
 * 侧栏最窄只有 23 列，目标原文又多是中文，行首挂一个「：」十分难扫。
 */
const NO_LINE_START = new Set([
  "：",
  "；",
  "，",
  "。",
  "、",
  "）",
  "】",
  "》",
  "」",
  "』",
  "！",
  "？",
  "…",
  "·",
  "%",
  ")",
  "]",
  ",",
  ".",
]);

export function wrapSidebarText(text: string, width: number, maxLines: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  const safeWidth = Math.max(1, width);
  const wrapped: string[] = [];
  let current = "";
  for (const grapheme of splitGraphemes(normalized)) {
    if (current && terminalWidth(current + grapheme) > safeWidth) {
      // 中文排版：标点不能挂在行首。宽 1 的侧栏里「：当前在做什么」这种断法很难扫，
      // 把上一行最后一个字符带下来，断在标点之前，行宽不变。
      if (NO_LINE_START.has(grapheme) && terminalWidth(current) > 1) {
        const carried = splitGraphemes(current).pop() ?? "";
        wrapped.push(carried ? current.slice(0, current.length - carried.length) : current);
        current = `${carried}${grapheme}`;
      } else {
        wrapped.push(current);
        current = grapheme;
      }
    } else {
      current += grapheme;
    }
  }
  if (current) wrapped.push(current);
  if (wrapped.length <= maxLines) return wrapped;
  // 末行让出一列给省略号：恰好占满的行 fitText 不会加 …，这里必须显式补上。
  const kept = wrapped.slice(0, maxLines);
  kept[maxLines - 1] = `${truncateText(kept[maxLines - 1], Math.max(0, safeWidth - 1))}…`;
  return kept;
}

/** 圆环内圈只留 3 列，刚好放得下 "25%" / "100" 这样的短文本。 */
function formatRingPercent(ratio: number): string {
  const percent = Math.round(ratio * 100);
  return percent >= 100 ? "100" : `${percent}%`;
}

/** 单个字符格对应 2×4 个盲文点：(dx, dy, bit)。 */
const BRAILLE_DOTS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0x01],
  [0, 1, 0x02],
  [0, 2, 0x04],
  [1, 0, 0x08],
  [1, 1, 0x10],
  [1, 2, 0x20],
  [0, 3, 0x40],
  [1, 3, 0x80],
];

/**
 * 用盲文点阵画一个细圆环：一个字符格是 2×4 个点，分辨率比方块字符高得多，
 * 曲线边缘不会出现锯齿状的实心方块。环按比例从正上方顺时针上色，
 * 中心叠加百分比；未用部分保持淡色，所以进度只靠颜色区分。
 *
 * 调用方需保证 width ≈ 2 × height：点阵是 2×4，只有宽高比 2:1 时才在屏幕上
 * 呈正圆，否则会画成扁椭圆。
 *
 * emphasis 为 true 时把已用弧线加粗高亮：鼠标悬停圆环会弹出明细卡片，
 * 环本身必须给出「卡片说的是我」的反馈。
 */
function buildContextRing(
  ratio: number,
  width: number,
  height: number,
  emphasis = false,
): string[] {
  const dotsW = Math.max(1, width * 2);
  const dotsH = Math.max(1, height * 4);
  const centerX = (dotsW - 1) / 2;
  const centerY = (dotsH - 1) / 2;
  const grid: Array<Array<{ mask: number; filled: boolean }>> = [];

  for (let row = 0; row < height; row += 1) {
    const cells: Array<{ mask: number; filled: boolean }> = [];
    for (let column = 0; column < width; column += 1) {
      let mask = 0;
      let ringDots = 0;
      let filledDots = 0;
      for (const [dx, dy, bit] of BRAILLE_DOTS) {
        const nx = dotsW <= 1 ? 0 : (column * 2 + dx - centerX) / (dotsW / 2);
        const ny = dotsH <= 1 ? 0 : (row * 4 + dy - centerY) / (dotsH / 2);
        const distance = Math.hypot(nx, ny);
        if (distance < 0.7 || distance > 1.0) continue;
        mask |= bit;
        ringDots += 1;
        // 从正上方开始顺时针折算进度：0 在顶端，0.25 在右侧，0.5 在底部。
        const angle = Math.atan2(nx, -ny);
        const fraction = (angle / (2 * Math.PI) + 1) % 1;
        if (fraction <= ratio) filledDots += 1;
      }
      cells.push({ mask, filled: ringDots > 0 && filledDots * 2 >= ringDots });
    }
    grid.push(cells);
  }

  const percent = formatRingPercent(ratio);
  const middleRow = Math.floor(height / 2);
  const textStart = Math.max(0, Math.floor((width - percent.length) / 2));

  return grid.map((cells, row) => {
    let line = "";
    for (let column = 0; column < cells.length; column += 1) {
      const textIndex = column - textStart;
      if (row === middleRow && textIndex >= 0 && textIndex < percent.length) {
        line += `${SEQ.boldAccent}${percent[textIndex]}${SEQ.reset}`;
        continue;
      }
      const { mask, filled } = cells[column];
      if (mask === 0) {
        line += " ";
        continue;
      }
      const glyph = String.fromCodePoint(0x2800 | mask);
      if (!filled) {
        line += `${SEQ.faint}${glyph}${SEQ.reset}`;
        continue;
      }
      // 悬停时整圈提亮：这是「下面会弹出明细卡片」的唯一视觉提示。
      line += `${emphasis ? SEQ.boldAccent : SEQ.accent}${glyph}${SEQ.reset}`;
    }
    return line;
  });
}

/** 分类颜色：悬停卡片里标签与迷你条共用同一映射，两处颜色必须能对上号。 */
function categoryColor(category: ContextCategory): string {
  switch (category) {
    case "system":
      return SEQ.cyan;
    case "tools":
      return SEQ.blue;
    case "memory":
      return SEQ.yellow;
    case "file":
      return SEQ.green;
    case "toolResult":
      return SEQ.magenta;
    default:
      return SEQ.accent;
  }
}

/** 悬停卡片的宽度区间：太窄放不下数值，太宽会盖掉大半个对话区。 */
const CARD_MIN_COLUMNS = 20;
const CARD_MAX_COLUMNS = 30;

/** 按可见宽度补空格（内容超宽时截断），卡片每一行都靠它对齐右边框。 */
function padToWidth(text: string, width: number): string {
  const visible = terminalWidth(text);
  if (visible >= width) return truncateText(text, width);
  return `${text}${" ".repeat(width - visible)}`;
}

/**
 * 圆环悬停时弹出的明细卡片。
 *
 * 侧栏只有 24~34 列，六类明细塞不进去；卡片因此做成浮层：由渲染层覆盖到
 * 对话区右侧的空白上，鼠标移开即消失，既不占侧栏行数，也不会把费用区顶走。
 * 这里只产出纯字符串，位置与覆盖交给调用方的屏幕合成阶段。
 */
export function buildContextCard(
  breakdown: ContextBreakdown,
  usedTokens: number,
  maxTokens: number,
  availableColumns = CARD_MAX_COLUMNS,
): string[] {
  const used = Math.max(0, usedTokens);
  const max = Math.max(1, maxTokens);
  const ratio = Math.min(1, Math.max(0, used / max));
  const entries = CONTEXT_CATEGORIES.map((category, index) => ({
    category,
    index,
    tokens: Math.max(0, breakdown[category]),
  }))
    .filter((entry) => entry.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || a.index - b.index);

  const outer = Math.max(CARD_MIN_COLUMNS, Math.min(CARD_MAX_COLUMNS, availableColumns));
  const inner = outer - 4;
  const labelWidth = 4;
  const valueWidth = 7;
  const barWidth = Math.max(4, inner - labelWidth - valueWidth - 2);
  const lineWidth = Math.min(inner, labelWidth + 1 + barWidth + 1 + valueWidth);
  const border = (left: string, right: string): string =>
    `${SEQ.faint}${left}${"─".repeat(outer - 2)}${right}${SEQ.reset}`;

  const titlePrefix = `${SEQ.faint}╭${SEQ.reset} ${SEQ.boldAccent}上下文构成${SEQ.reset} `;
  // 标题行也要正好 outer 宽：前缀已经含左边框，右角的那一列必须扣掉。
  const titleFill = Math.max(0, outer - 1 - terminalWidth(titlePrefix));
  const rows: string[] = [`${titlePrefix}${SEQ.faint}${"─".repeat(titleFill)}╮${SEQ.reset}`];

  const largest = entries[0]?.tokens ?? 1;
  for (const entry of entries) {
    const filled = Math.max(1, Math.round((entry.tokens / largest) * barWidth));
    const bar = `${"█".repeat(Math.min(barWidth, filled))}${" ".repeat(Math.max(0, barWidth - filled))}`;
    const value = formatTokenBudget(entry.tokens).padStart(valueWidth);
    const color = categoryColor(entry.category);
    rows.push(
      `${SEQ.faint}│${SEQ.reset} ${color}${CONTEXT_CATEGORY_LABELS[entry.category]}${SEQ.reset} ${color}${bar}${SEQ.reset} ${SEQ.muted}${value}${SEQ.reset} ${SEQ.faint}│${SEQ.reset}`,
    );
  }

  rows.push(border("├", "┤"));
  const footers = [
    `已用 ${formatExactTokens(used)} / ${formatExactTokens(max)}`,
    `剩余 ${formatExactTokens(Math.max(0, max - used))} · ${Math.round(ratio * 100)}%`,
  ];
  for (const footer of footers) {
    rows.push(
      `${SEQ.faint}│${SEQ.reset} ${SEQ.muted}${padToWidth(footer, lineWidth)}${SEQ.reset} ${SEQ.faint}│${SEQ.reset}`,
    );
  }
  rows.push(border("╰", "╯"));
  return rows;
}

/**
 * 构建右侧栏各行：上下文（主指标块）→ 费用表 → 任务 → 子代理，按高度裁剪。
 *
 * hoverId 是鼠标当前压住的那块区域（没有就是 undefined）。所有悬停表现都按
 * "只换颜色、不改宽度、不插行"实现——插行会把鼠标下的目标整体推开。
 */
export function buildSidebarFrame(
  state: SidebarState,
  width: number,
  maxRows: number,
  now = Date.now(),
  hoverId?: string,
): SidebarFrame {
  if (width <= 0 || maxRows <= 0) return { rows: [], regions: [] };
  const w = Math.max(1, Math.floor(width));
  const paper = paperSidebarEnabled();
  /** 纸面内容使用统一宽度，整组居中，组内标签左对齐、数值右对齐。 */
  const contentW = Math.max(1, paper ? Math.min(26, w - 4) : w - SIDEBAR_RIGHT_MARGIN);
  const paperInset = paper ? Math.max(0, Math.floor((w - contentW) / 2)) : 0;
  const rows: string[] = [];
  const surfaces: Array<string | undefined> = [];
  const paperPadding = " ".repeat(paperInset);
  const pulse = (at: number | undefined): boolean =>
    paper && at !== undefined && now >= at && now - at < 800;
  // 交互区域：先登记再统一按 depth 排序，命中时从深到浅找。
  // 行号在这里同步记账（push 时就知道落在第几行），不要事后扫字符串反推。
  const regions: SidebarRegion[] = [];
  const register = (
    id: SidebarRegionId,
    top: number,
    height: number,
    hover: SidebarHoverStyle,
    options: { depth?: number; left?: number; width?: number; hasCard?: boolean } = {},
  ): void => {
    if (height <= 0 || top < 0 || top >= maxRows) return;
    // 行数被 maxRows 裁掉时，命中也必须同步裁——否则鼠标能点到看不见的行。
    const clipped = Math.min(height, maxRows - top);
    regions.push({
      id,
      hit: {
        top,
        height: clipped,
        left: (options.left ?? 0) + paperInset,
        width: options.width ?? contentW,
      },
      hover,
      depth: options.depth ?? 0,
      ...(options.hasCard ? { hasCard: true } : {}),
    });
  };
  const isHovered = (id: SidebarRegionId): boolean => hoverId === id;
  const push = (row: string, surface?: string): void => {
    // 统一守一道宽度闸：任何一行都不许溢出内容宽度（窄栏下多个区块同时变窄，
    // 逐个调用点补 truncate 容易漏，漏掉的那一行会顶穿到对话区的分隔线上）。
    const safeRow = terminalWidth(row) > contentW ? truncateAnsiText(row, contentW) : row;
    if (rows.length < maxRows) {
      rows.push(`${paperPadding}${safeRow}`);
      surfaces.push(surface);
    }
  };
  const blank = (force = false): void => {
    if (rows.length > 0 && rows.length < maxRows && (force || !paper)) push("");
  };
  /** 章节标题自带前置空行：三段的呼吸节奏一致，不再靠调用点手动补。 */
  const section = (label: string): void => {
    blank(paper);
    // 标题也要按内容宽度截断：窄栏下宁可写「费用」两个字，也不能让整行溢出到分隔线上。
    push(`${paper ? SEQ.muted : SEQ.boldAccent}${truncateText(label, contentW)}${SEQ.reset}`);
  };
  /** 在内容宽度内水平居中（ANSI 行按可见宽度计算）。 */
  const centered = (text: string): string => {
    const pad = Math.max(0, Math.floor((contentW - terminalWidth(text)) / 2));
    return pad === 0 ? text : `${" ".repeat(pad)}${text}`;
  };
  /** 双列表格的一行：标签靠左淡色，数值靠右对齐。 */
  const tableRow = (label: string, value: string, valueColor = SEQ.reset): void => {
    // 极窄栏（分隔线吃掉的宽度比标签还多）时先缩标签，保住数值：数值才是这张表的信息。
    const fittedLabel =
      terminalWidth(label) + 3 > contentW ? truncateText(label, Math.max(1, contentW - 3)) : label;
    const labelW = terminalWidth(fittedLabel);
    const budget = Math.max(1, contentW - labelW - 1);
    const fitted = truncateText(value, budget);
    const gap = Math.max(1, contentW - labelW - terminalWidth(fitted));
    push(
      `${SEQ.muted}${fittedLabel}${SEQ.reset}${" ".repeat(gap)}${valueColor}${fitted}${SEQ.reset}`,
    );
  };

  /** 整组在可用视口中居中；空行、表面色与交互命中使用同一偏移。 */
  const finish = (ring?: SidebarRingGeometry): SidebarFrame => {
    const top =
      paper && !state.workspace ? Math.max(0, Math.floor((maxRows - rows.length) / 2)) : 0;
    if (top > 0) {
      rows.unshift(...new Array<string>(top).fill(""));
      surfaces.unshift(...new Array<undefined>(top).fill(undefined));
      for (const region of regions) region.hit.top += top;
      if (ring) ring.top += top;
    }
    regions.sort((a, b) => a.depth - b.depth);
    return {
      rows: rows.slice(0, maxRows),
      ring,
      regions,
      surfaces: paper ? surfaces.slice(0, maxRows) : undefined,
    };
  };

  // 侧栏只放“量”与进度（目标、任务、代理、上下文、费用）：
  // 进行中的活动行留在对话区一侧，避免同一件事在屏幕上出现两次。
  // 顺序即优先级：当前在做什么（目标/任务/代理）在前，资源与账单在后；
  // 下部两块按 CONTEXT_MIN_ROWS / COST_MIN_ROWS 预留行数，避免长目标或长任务
  // 把它们整块顶出可见区域——宁可让上部先收成摘要。
  const reservedTailRows = CONTEXT_MIN_ROWS + COST_MIN_ROWS + (state.extensions ? 4 : 0);
  /** 扣除给上下文与费用的预留额度后，上部区块还能用几行。 */
  const upperBudget = (): number => Math.max(0, maxRows - rows.length - reservedTailRows);
  // 高度决定档位：矮屏上每一行都要么是主指标，要么是可操作入口。
  const density = sidebarDensity(maxRows);
  /** 目标/任务/代理区块是否值得展开（minimal 档只要标题行就够）。 */
  const upperMinRows = density === "minimal" ? 2 : 3;

  // 工作区是实时快照；小窗口优先让位给任务与会话用量。
  const workReserve =
    (state.goal ? 4 : 0) + (state.taskPlan?.items.length ? 4 : 0) + (state.agents?.length ? 2 : 0);
  if (state.workspace && upperBudget() >= workReserve + 7) {
    const workspace = state.workspace;
    const clean = (text: string): string => sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
    section("工作区");
    push(`${SEQ.bold}${truncateText(clean(workspace.name), contentW)}${SEQ.reset}`);
    if (workspace.branch && upperBudget() > workReserve + 1) {
      push(`${SEQ.muted}${truncateText(clean(workspace.branch), contentW)}${SEQ.reset}`);
    }
    const changes = [
      workspace.modified ? `修改 ${workspace.modified}` : "",
      workspace.added ? `新增 ${workspace.added}` : "",
      workspace.deleted ? `删除 ${workspace.deleted}` : "",
      workspace.untracked ? `未跟踪 ${workspace.untracked}` : "",
      workspace.conflicted ? `冲突 ${workspace.conflicted}` : "",
    ].filter(Boolean);
    const summary =
      workspace.gitStatus === "ready"
        ? changes.join(" · ") || "工作区干净"
        : workspace.gitStatus === "not-repository"
          ? "非 Git 仓库"
          : "Git 状态暂不可用";
    for (const line of wrapSidebarText(
      summary,
      contentW,
      Math.min(2, Math.max(1, upperBudget() - workReserve)),
    )) {
      push(`${workspace.conflicted ? SEQ.accent : SEQ.muted}${line}${SEQ.reset}`);
    }
    blank(paper);
  }

  // ── 空会话：收敛成「上下文 / 费用」两段一行摘要，不画圆环、不铺费用表 ──
  // 判定「空会话」：还没有任何请求、没有上下文分类、没有目标/任务/代理。
  // 启动屏因此只留两条主指标（占多少、花多少）+ 一句「有数据后会展开什么」，
  // 不再一上来就画满盲文圆环、摊开一张全是零的费用表，避免首屏碎点与空行。
  const hasActiveWork =
    Boolean(state.goal) ||
    (state.taskPlan?.items.length ?? 0) > 0 ||
    (state.agents?.length ?? 0) > 0;
  // 启动时 breakdown 一定存在（系统提示词 + 工具定义已计入），所以不能拿「有没有 breakdown」
  // 判断空会话；改看对话类 token 是否为 0——还没聊过天时它恒为 0，聊过之后必然 > 0。
  const noConversation = (state.breakdown?.conversation ?? 0) === 0;
  const freshSession =
    !hasActiveWork &&
    (state.costRequests ?? 0) === 0 &&
    noConversation &&
    (state.compactionCount ?? 0) === 0;
  const renderExtensions = (): void => {
    if (!state.extensions) return;
    const servers = state.extensions.mcp
      .filter((server) => server.state !== "disabled")
      .slice()
      .sort((a, b) => Number(b.state === "failed") - Number(a.state === "failed"));
    const skills = state.extensions.skills;
    const ready = servers.filter((server) => server.state === "running").length;
    const failed = servers.length - ready;
    section("扩展");
    let top = rows.length;
    tableRow(
      "MCP",
      `${ready}/${servers.length} 就绪${failed ? ` · ${failed} 异常` : ""} ›`,
      isHovered("extensions.mcp") ? SEQ.accent : SEQ.reset,
    );
    register("extensions.mcp", top, 1, "text");
    const spare = (): number => maxRows - rows.length - CONTEXT_MIN_ROWS - COST_MIN_ROWS - 1;
    if (density === "full") {
      const count = Math.min(3, servers.length, Math.max(0, spare()));
      for (const server of servers.slice(0, count)) {
        const name = sanitizeTerminalText(server.name).replace(/\s+/g, " ");
        push(
          `${SEQ.muted}  ${server.state === "failed" ? "!" : "●"} ${truncateText(name, Math.max(1, contentW - 12))} ${server.state === "failed" ? "异常" : `${server.toolCount} 工具`}${SEQ.reset}`,
        );
      }
    }
    top = rows.length;
    tableRow(
      "Skills",
      `${skills.filter((skill) => skill.resident).length} 已加载 ›`,
      isHovered("extensions.skills") ? SEQ.accent : SEQ.reset,
    );
    register("extensions.skills", top, 1, "text");
    if (density === "full") {
      const loaded = skills.filter((skill) => skill.resident);
      for (const skill of loaded.slice(0, Math.min(3, Math.max(0, spare() + 1)))) {
        push(
          `${SEQ.muted}  ◆ ${sanitizeTerminalText(skill.name).replace(/\s+/g, " ")}${SEQ.reset}`,
        );
      }
    }
  };
  if (freshSession) {
    renderExtensions();
    if (paper) push(`${SEQ.muted}SESSION${SEQ.reset}`);
    const usedC = Math.max(0, state.usedTokens);
    const maxC = Math.max(1, state.maxTokens);
    const ratioC = Math.min(1, Math.max(0, usedC / maxC));
    const pctC = `${Math.round(ratioC * 100)}%`;
    section("上下文");
    const usageTopC = rows.length;
    tableRow("占用", `${pctC} · ${formatTokenBudget(usedC)} / ${formatTokenBudget(maxC)}`);
    register("context.usage", usageTopC, 1, "text");
    push(`${SEQ.faint}${truncateText("有对话后显示分类构成", contentW)}${SEQ.reset}`);

    const costTopC = rows.length;
    section("费用");
    if (state.costCny === undefined) {
      push(`${SEQ.muted}${truncateText("暂无已计费调用", contentW)}${SEQ.reset}`);
    } else {
      const costRowTop = rows.length;
      tableRow(
        "花费",
        formatCostAmount(state.costCny),
        isHovered("cost.summary") ? SEQ.accent : SEQ.reset,
      );
      register("cost.turn.cost", costRowTop, 1, "text", { depth: 2 });
    }
    push(`${SEQ.faint}${truncateText("有请求后显示明细 · Ctrl+E", contentW)}${SEQ.reset}`);
    register("cost.summary", costTopC, rows.length - costTopC, "text", { depth: 1 });

    return finish();
  }

  // ── 目标：setgoal 记录的会话目标摘要，最多两行（完整原文与完成审计由 selfstate 查询）──
  // 只显示进行中的目标：达成后收尾反馈由对话区的 goalfinish 工具格承担，侧栏不再占行。
  if (paper) push(`${SEQ.muted}SESSION${SEQ.reset}`);
  const workSurface = paperWorkBg();
  if (paper && state.goal && state.goal.status === "active" && upperBudget() >= upperMinRows) {
    push(
      `${SEQ.boldAccent}当前工作${SEQ.reset}`,
      pulse(state.goalPulseAt) ? paperHoverBg() : workSurface,
    );
    for (const line of wrapSidebarText(state.goal.text, contentW, Math.min(2, upperBudget()))) {
      push(pulse(state.goalPulseAt) ? `${SEQ.bold}${line}${SEQ.reset}` : line, workSurface);
    }
  } else if (state.goal && state.goal.status === "active" && upperBudget() >= upperMinRows) {
    section("目标 · 进行中");
    for (const line of wrapSidebarText(state.goal.text, contentW, Math.min(2, upperBudget()))) {
      // 原文用正文色：强调色留给选中态与可操作入口，整段高亮反而看不出重点。
      push(line);
    }
  }

  // ── 任务：标题给整体进度，行内突出进行中的那一项；空间紧张时已完成项收成一行计数 ──
  if (state.taskPlan && state.taskPlan.items.length > 0 && upperBudget() >= upperMinRows) {
    blank();
    // 已经扣掉呼吸空行：剩下的每一行都要能落地，宁可只放标题，也不留一个空分区。
    const available = upperBudget();
    if (available >= 1) {
      // minimal 档只留标题行（done/total 与进行中项数都在里面），其余档收成紧凑列表。
      const limit = density === "minimal" ? 1 : Math.min(available, 7);
      const taskRows = buildTaskPanelRows(state.taskPlan, contentW, limit, now, { compact: true });
      const current = state.taskPlan.items.find((item) => item.status === "in_progress");
      if (paper && current && limit >= 3) {
        const title = `任务 · ${state.taskPlan.title}  ${state.taskPlan.items.filter((item) => item.status === "completed").length}/${state.taskPlan.items.length}`;
        push(`${SEQ.bold}${truncateText(title, contentW)}${SEQ.reset}`, workSurface);
        push(
          `${SEQ.accent}●${SEQ.reset} ${SEQ.bold}${truncateText(current.content, Math.max(1, contentW - 8))}${SEQ.reset}${SEQ.muted} 进行中${SEQ.reset}`,
          workSurface,
        );
        const done = state.taskPlan.items.filter((item) => item.status === "completed").length;
        const remaining = state.taskPlan.items.length - done - 1;
        push(
          `${SEQ.muted}${truncateText(`已完成 ${done} 项${remaining > 0 ? ` · 剩余 ${remaining} 项` : ""}`, contentW)}${SEQ.reset}`,
          workSurface,
        );
      } else {
        // 走 push 而不是 rows.push：面板自己产出的行也要过宽度闸（窄栏下标题行会超宽）。
        for (const row of taskRows.slice(0, available)) {
          push(
            paper && pulse(state.taskPulseAt) ? `${SEQ.bold}${row}${SEQ.reset}` : row,
            paper ? (pulse(state.taskPulseAt) ? paperHoverBg() : workSurface) : undefined,
          );
        }
      }
    }
  }

  // ── 代理：还在跑的先排，已结束的收成一行计数（逐个明细看 /agents）──
  if (state.agents && state.agents.length > 0 && upperBudget() >= upperMinRows) {
    blank();
    const available = upperBudget();
    if (available >= 1) {
      const limit = density === "minimal" ? 1 : Math.min(available, 5);
      const agentRows = buildAgentPanelRows(state.agents, contentW, limit, now, { compact: true });
      for (const row of agentRows.slice(0, available)) push(row);
    }
  }

  // ── PR 巡检：入口行（代理之后、扩展之前）──
  // 只占一行：可操作（就绪 / 运行中）时加 ▸，不可操作（缺令牌）退成次要色。
  if (state.patrol && upperBudget() >= 1) {
    const patrol = state.patrol;
    const entryRow = rows.length;
    const text =
      patrol.status === "running"
        ? fitHint(
            [
              `巡检中 · ${patrol.activity ?? `${patrol.tasks ?? 0} 个任务`}${patrol.merged ? ` · 已合并 ${patrol.merged}` : ""} · 点此查看`,
              `巡检中 · ${patrol.activity ?? `${patrol.tasks ?? 0} 个任务`}`,
              patrol.activity ?? "巡检中",
            ],
            contentW,
          )
        : patrol.status === "no-token"
          ? fitHint(
              ["PR 巡检 · 需要 GitHub 令牌（gh auth login）", "PR 巡检 · 需令牌", "需令牌"],
              contentW,
            )
          : fitHint(
              [
                patrol.pending > 0
                  ? `PR 巡检 · ${patrol.pending} 个 agent PR 待接管 · 点此启动`
                  : "PR 巡检未启动 · 点此启动",
                patrol.pending > 0 ? `巡检 · ${patrol.pending} 个 PR · 启动` : "PR 巡检 · 启动",
                "启动巡检",
              ],
              contentW,
            );
    // 就绪（点此启动）与运行中（点此看任务列表）都可点；缺令牌仍不可点。
    const actionable = patrol.status === "ready" || patrol.status === "running";
    // 配色按状态区分：巡检中橙（主题 yellow 为琥珀橙）、有待接管 PR 绿、
    // 未启动灰；缺令牌用橙提示「需要处理」，避免和「已就绪但没活干」混为一谈。
    const color =
      patrol.status === "running" || patrol.status === "no-token"
        ? SEQ.yellow
        : patrol.pending > 0
          ? SEQ.green
          : SEQ.muted;
    // 悬停只加粗不改色，保证三种状态的色义不被 hover 覆盖（mono 下 bold 为空序列）。
    const paint = actionable && isHovered("patrol.entry") ? `${SEQ.bold}${color}` : color;
    push(`${paint}${actionable ? "▸ " : ""}${text}${SEQ.reset}`);
    if (actionable) register("patrol.entry", entryRow, 1, "label");
  }

  renderExtensions();

  // ── 上下文：整栏唯一的大图形，百分比压中心、用量紧贴其下居中，形成一条中线 ──
  const used = Math.max(0, state.usedTokens);
  const max = Math.max(1, state.maxTokens);
  const ratio = Math.min(1, Math.max(0, used / max));
  const percent = `${Math.round(ratio * 100)}%`;
  section("上下文");
  if (paper) {
    const contextTitle = "上下文";
    const titleRow = rows.length - 1;
    const gap = Math.max(1, contentW - terminalWidth(contextTitle) - terminalWidth(percent));
    rows[titleRow] =
      `${paperPadding}${SEQ.muted}${contextTitle}${SEQ.reset}${" ".repeat(gap)}${SEQ.accent}${percent}${SEQ.reset}`;
    if (pulse(state.contextPulseAt)) surfaces[titleRow] = paperHoverBg();
  }

  // 空间够时画圆环；太挤则退回单行进度条，避免把费用/任务全部挤掉。
  let ring: SidebarRingGeometry | undefined;
  // 圆环高度按「上下文可用行数」分档：先扣掉留给费用的 COST_MIN_ROWS。
  // 档位是上限：minimal 档一律不画圆环，compact 档最高 5 行。
  const remainingForContext = maxRows - rows.length - COST_MIN_ROWS;
  const ringCap = density === "minimal" ? 0 : density === "compact" ? 5 : 7;
  const ringHeight =
    ringCap >= 7 && remainingForContext >= 16
      ? 7
      : ringCap >= 5 && remainingForContext >= 10
        ? 5
        : 0;
  // 圆环一旦放不下就退回单行进度条：宁可少画图形，也不把下面的用量行挤没。
  const ringFits = ringHeight > 0 && rows.length + ringHeight <= maxRows - COST_MIN_ROWS;
  if (ringFits && !paper) {
    // 宽 = 2 × 高：点阵 2×4，只有这个比例在终端里才是正圆。
    const ringWidth = Math.min(ringHeight * 2, Math.max(4, contentW));
    const left = Math.max(0, Math.floor((contentW - ringWidth) / 2));
    const ringRows = buildContextRing(ratio, ringWidth, ringHeight, isHovered("context.ring"));
    ring = { top: rows.length, height: ringHeight, left, width: ringWidth };
    register("context.ring", rows.length, ringHeight, "ring", { hasCard: true });
    for (const line of ringRows) push(left === 0 ? line : `${" ".repeat(left)}${line}`);
  } else {
    const barCapacity = Math.max(4, Math.min(14, contentW - terminalWidth(percent) - 2));
    const filled = Math.min(barCapacity, Math.max(0, Math.round(ratio * barCapacity)));
    const empty = Math.max(0, barCapacity - filled);
    const ratioColor = ratio >= 0.85 ? SEQ.boldRed : ratio >= 0.6 ? SEQ.yellow : SEQ.softAccent;
    if (paper) {
      const paperBar = contentW;
      const paperFilled = Math.min(paperBar, Math.round(ratio * paperBar));
      const metricSurface = pulse(state.contextPulseAt) ? paperHoverBg() : undefined;
      push(
        `${SEQ.bold}${formatTokenBudget(used)}${SEQ.reset} ${SEQ.muted}/ ${formatTokenBudget(max)}${SEQ.reset}`,
        metricSurface,
      );
      push(
        `${ratioColor}${"━".repeat(paperFilled)}${SEQ.reset}${SEQ.muted}${"─".repeat(paperBar - paperFilled)}${SEQ.reset}`,
        metricSurface,
      );
    } else {
      push(
        `${ratioColor}${"█".repeat(filled)}${SEQ.reset}${SEQ.faint}${"░".repeat(empty)}${SEQ.reset} ${ratioColor}${percent}${SEQ.reset}`,
      );
    }
  }

  // 分类明细不占侧栏行数：鼠标悬停圆环时由浮层卡片展示（buildContextCard），
  // 侧栏这里永远只保留一条总用量，悬停也只会加粗圆环里的百分比。
  // 用量行和圆环做同一件事（开上下文详情页）：圆环有 5~7 行高，宽屏下靠它定位
  // 很别扭，一条贴边的文字行才是更好点的靶子。
  const usageTop = paper ? rows.length - 2 : rows.length;
  const usageColor = isHovered("context.usage") ? SEQ.reset : SEQ.muted;
  if (!paper) {
    push(
      centered(
        `${usageColor}${formatTokenBudget(used)} / ${formatTokenBudget(max)} tokens${SEQ.reset}`,
      ),
    );
  }
  register("context.usage", usageTop, paper ? 2 : 1, "text", paper ? { hasCard: true } : {});

  // 压缩徽标：圆环会因压缩突然掉下来，标注一次就能消掉“上下文怎么没了”的困惑。
  // 压缩徽标是可选的：空间只够预留额度时先让它，别把费用区块顶出可见区域。
  // minimal 档连圆环都没有，徽标要解释的那块图形不存在，也就不占行。
  if (
    state.compactionCount !== undefined &&
    state.compactionCount > 0 &&
    density !== "minimal" &&
    rows.length < maxRows - COST_MIN_ROWS
  ) {
    push(centered(`${SEQ.accent}⟳ 已压缩 ×${state.compactionCount}${SEQ.reset}`));
  }

  // ── 费用：标签左、数值右对齐的双列小表，耗时并进同一张表 ──
  // 整段可点（点开费用明细），内嵌两个更深的目标：配置单价入口、定价 agent 状态行。
  // 先占位再回填标题行的下标：section() 会先插一个空行做呼吸，命中区不该从空行算起。
  const costSectionTop = rows.length;
  section("费用");
  const costHitTop = Math.max(costSectionTop, rows.length - 1);
  // 悬停：整块（cost.summary）或该行自身高亮时，数值列提亮；只换颜色不改宽度。
  const costRowColor = (id?: SidebarRegionId): string =>
    isHovered("cost.summary") || (id !== undefined && isHovered(id)) ? SEQ.accent : SEQ.reset;
  // 可点击的指标行：登记自己的命中区（depth 2，高于整块费用），
  // 点哪一行就按哪种口径把每一轮摊开（见 onSidebarAction / formatTurnReport）。
  const costRow = (id: SidebarRegionId | undefined, label: string, value: string): void => {
    const top = rows.length;
    if (paper && id === "cost.turn.cost") {
      push(
        `${costRowColor(id)}${SEQ.muted}¥${SEQ.reset}${SEQ.bold}${truncateText(value.slice(1), contentW - 1)}${SEQ.reset}`,
        pulse(state.costPulseAt) ? paperHoverBg() : undefined,
      );
    } else {
      tableRow(label, value, costRowColor(id));
      if (paper && pulse(state.costDetailsPulseAt)) surfaces[rows.length - 1] = paperHoverBg();
    }
    if (id !== undefined) register(id, top, 1, "text", { depth: 2 });
  };
  if (state.costCny === undefined) {
    push(`${SEQ.muted}${truncateText("暂无已计费调用", contentW)}${SEQ.reset}`);
  } else {
    costRow(
      "cost.turn.cost",
      "花费",
      `${formatCostAmount(state.costCny)}${state.hasUnpricedCost ? " · 含未定价" : ""}`,
    );
  }
  // 未定价：明确给出可点击的入口，否则用户只会看到「¥0.0000」不知道能修。
  // 它比费用区块更深一层：点在入口上直接配单价，点区块其他地方才是看明细。
  // 排在明细开关之前：这是「需要处理」的信息，任何情况下都不该被折叠掉。
  if (state.hasUnpricedCost || (state.unpricedModels?.length ?? 0) > 0) {
    const configRow = rows.length;
    const hintColor = isHovered("cost.config") ? SEQ.boldAccent : SEQ.accent;
    push(`${hintColor}${truncateText("▸ 配置单价", contentW)}${SEQ.reset}`);
    register("cost.config", configRow, 1, "label", { depth: 2 });
  }
  if (state.pricingAgent) {
    const note =
      state.pricingAgent.status === "running"
        ? `⟳ 由 agent 查询定价：${state.pricingAgent.model}`
        : state.pricingAgent.status === "done"
          ? `✓ 已定价：${state.pricingAgent.model}`
          : `✕ 定价查询失败：${state.pricingAgent.model}`;
    const color =
      state.pricingAgent.status === "failed"
        ? SEQ.yellow
        : state.pricingAgent.status === "done"
          ? SEQ.muted
          : SEQ.accent;
    const agentRow = rows.length;
    const label = isHovered("cost.pricingAgent") ? `${SEQ.boldAccent}${note}` : `${color}${note}`;
    push(`${label}${SEQ.reset}`);
    // 最深的一层：这一行在费用区块内部，命中时必须优先于整块。
    register("cost.pricingAgent", agentRow, 1, "text", { depth: 3 });
  }
  // ── 费用明细：默认折叠 ──
  // 常驻只留「花费 + 需处理项」，token 构成与耗时点开关才摊开。
  // 折叠不等于丢信息：完整逐条明细在费用日志页（点「花费」或 /cost 打开）。
  if (state.costCny !== undefined) {
    const detailTop = rows.length;
    const expanded = state.costDetailsExpanded === true;
    const arrowColor = isHovered("cost.detail") ? SEQ.boldAccent : SEQ.muted;
    const arrow = paper ? (expanded ? "⌄ 查看明细" : "› 查看明细") : expanded ? "▾ 明细" : "▸ 明细";
    // 键盘入口只在放得下时提示：宽 15 列起步，窄栏里「明细」两字仍然是完整可点的靶子。
    const label = contentW >= 16 ? (paper ? `${arrow}  Ctrl+E` : `${arrow} · Ctrl+E`) : arrow;
    push(
      `${arrowColor}${truncateText(label, contentW)}${SEQ.reset}`,
      paper && pulse(state.costDetailsPulseAt) ? paperHoverBg() : undefined,
    );
    register("cost.detail", detailTop, 1, "label", { depth: 2 });
    if (expanded) {
      const promptTokens = Math.max(0, state.promptTokens ?? 0);
      const completionTokens = Math.max(0, state.completionTokens ?? 0);
      const cachedPromptTokens = Math.max(0, state.cachedPromptTokens ?? 0);
      if (state.costRequests !== undefined && state.costRequests > 0) {
        costRow("cost.turn.requests", "请求", `${state.costRequests} 次`);
      }
      if (promptTokens > 0) {
        costRow("cost.turn.input", "输入", `↑${formatAgentTokens(promptTokens)}`);
      }
      if (cachedPromptTokens > 0) {
        const hitRatio = Math.round((cachedPromptTokens / Math.max(1, promptTokens)) * 100);
        costRow(
          "cost.turn.cached",
          "含缓存",
          `⛁${formatAgentTokens(cachedPromptTokens)} ${hitRatio}%`,
        );
      }
      if ((state.offPeakRequests ?? 0) > 0) {
        costRow(undefined, "谷时", `☾${state.offPeakRequests} 次`);
      }
      if (completionTokens > 0) {
        costRow("cost.turn.output", "输出", `↓${formatAgentTokens(completionTokens)}`);
      }
      if (state.lastTurnMs !== undefined && state.lastTurnMs > 0) {
        costRow(undefined, "上一轮", formatTurnDuration(state.lastTurnMs));
      }
    }
  }
  // 整块费用是一个命中区：从章节标题（不含前面的呼吸空行）到最后一行。
  // 高度被裁到 0 时 register 会直接跳过，调用方也就拿不到这块区域。
  register("cost.summary", costHitTop, rows.length - costHitTop, "text", { depth: 1 });

  if (paper) {
    for (const region of regions) {
      if (!isHovered(region.id)) continue;
      const end = Math.min(rows.length, region.hit.top + region.hit.height);
      for (let index = region.hit.top; index < end; index += 1) surfaces[index] = paperHoverBg();
    }
  }

  // 按 depth 升序返回：命中时从后往前找，深层（定价 agent 行、配置单价行）
  // 自然压过外层费用区块。
  return finish(ring);
}

/** 仅需要行内容时的便捷入口（测试与不关心圆环位置的调用方使用）。 */
export function buildSidebarRows(
  state: SidebarState,
  width: number,
  maxRows: number,
  now = Date.now(),
  hoverId?: string,
): string[] {
  return buildSidebarFrame(state, width, maxRows, now, hoverId).rows;
}

/**
 * 把左侧对话行与右侧栏行拼成整屏的一行：左侧补空格到固定宽度，
 * 中间一条淡色竖线，右侧按侧栏宽度截断。
 */
export function composeSidebarRow(
  left: string,
  leftWidth: number,
  sidebarRow: string,
  sidebarWidth: number,
  surface?: string,
): string {
  const leftVisible = terminalWidth(left);
  const safeLeft = leftVisible > leftWidth ? truncateAnsiText(left, leftWidth) : left;
  const leftPadded = `${safeLeft}${SEQ.reset}${" ".repeat(
    Math.max(0, leftWidth - terminalWidth(safeLeft)),
  )}`;
  const sidebarVisible = terminalWidth(sidebarRow);
  const safeSidebar =
    sidebarVisible > sidebarWidth ? truncateAnsiText(sidebarRow, sidebarWidth) : sidebarRow;
  const sidebarPadded = `${safeSidebar}${SEQ.reset}${" ".repeat(
    Math.max(0, sidebarWidth - terminalWidth(safeSidebar)),
  )}`;
  if (paperSidebarEnabled()) {
    const background = surface ?? paperSidebarBg();
    // 行内完整重置会恢复主题背景；紧接着重新铺回当前表面。
    const onSurface = SEQ.reset
      ? safeSidebar.split(SEQ.reset).join(`${SEQ.reset}${background}`)
      : safeSidebar;
    const paperRow = `${background}${onSurface}${background}${" ".repeat(
      Math.max(0, sidebarWidth - terminalWidth(safeSidebar)),
    )}${SEQ.reset}`;
    return `${leftPadded}${paperSidebarTransition()}${paperRow}`;
  }
  return `${leftPadded} ${SEQ.faint}│${SEQ.reset} ${sidebarPadded}`;
}
