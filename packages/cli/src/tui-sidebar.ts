/**
 * 右侧信息栏的纯构建函数：上下文主指标、费用表、任务与子代理。
 *
 * 与 terminal-panels.ts 同一模式：只读入标量状态并输出 ANSI 行，
 * 不做 I/O 与定时器，方便用固定宽度做单元测试。
 *
 * 分工约定：会话标题、provider/model、推理档、权限档与 git 分支已经由顶部
 * header 和底部状态行负责，侧栏不再重复，只保留它们讲不了的“量”：上下文占用、
 * 费用构成、耗时，以及进行中的任务与子代理。
 */
import type { ActivityFrame } from "./activity-indicator.js";
import { type AgentPanelItem, buildAgentPanelRows, formatAgentTokens } from "./agent-panel.js";
import { buildActivityRow, buildTaskPanelRows, type TaskPanelState } from "./terminal-panels.js";
import { SEQ, terminalWidth, truncateAnsiText, truncateText } from "./terminal-text.js";

/** 右侧信息栏显示所需状态（TerminalUI 持有，渲染时快照传入）。 */
export interface SidebarState {
  usedTokens: number;
  maxTokens: number;
  /** 会话累计费用（元）；无定价请求时仍是已定价部分的合计。 */
  costCny?: number;
  costRequests?: number;
  hasUnpricedCost?: boolean;
  /** 会话累计输入/输出 tokens；用来解释费用构成（哪一头在烧钱）。 */
  promptTokens?: number;
  completionTokens?: number;
  /** 上一轮回合耗时（ms）；用于感知“慢在哪”。 */
  lastTurnMs?: number;
  /** 本会话上下文压缩次数；>0 时在上下文区显示“已压缩”徽标。 */
  compactionCount?: number;
  /** 当前活动帧；侧栏出现时由底部状态行搬到这里，避免重复。 */
  activity?: ActivityFrame;
  taskPlan?: TaskPanelState;
  agents?: readonly AgentPanelItem[];
}

/** 圆环在侧栏中的位置：相对侧栏首行的行偏移与相对侧栏首列的列偏移。 */
export interface SidebarRingGeometry {
  top: number;
  height: number;
  left: number;
  width: number;
}

export interface SidebarFrame {
  rows: string[];
  /** 上下文圆环的命中区域；侧栏高度不足以画环时为 undefined。 */
  ring?: SidebarRingGeometry;
}

/** 低于该宽度或高度时右侧栏让位给对话区。 */
export const SIDEBAR_MIN_COLUMNS = 96;
export const SIDEBAR_MIN_ROWS = 18;
/** 对话区与侧栏之间的分隔带（空格 + 竖线 + 空格）。 */
export const SIDEBAR_GAP_WIDTH = 3;
/** 侧栏出现时必须给对话区留下的最小宽度。 */
export const SIDEBAR_MIN_CHAT_WIDTH = 48;
/** 侧栏右侧留白：文字不贴到终端最后一列（左侧的 1 列已由分隔带提供）。 */
const SIDEBAR_RIGHT_MARGIN = 1;

/**
 * 计算右侧栏内容宽度；返回 0 表示不显示。
 * 宽度随终端增长，但保持在 24–34 列之间，避免宽屏下信息栏被拉得过散。
 */
export function resolveSidebarWidth(columns: number, rows: number, enabled: boolean): number {
  if (!enabled) return 0;
  if (!Number.isFinite(columns) || !Number.isFinite(rows)) return 0;
  if (columns < SIDEBAR_MIN_COLUMNS || rows < SIDEBAR_MIN_ROWS) return 0;
  const target = Math.min(34, Math.max(24, Math.round(columns * 0.26)));
  if (columns - target - SIDEBAR_GAP_WIDTH < SIDEBAR_MIN_CHAT_WIDTH) return 0;
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
 */
function buildContextRing(ratio: number, width: number, height: number): string[] {
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
      line += filled ? `${SEQ.accent}${glyph}${SEQ.reset}` : `${SEQ.faint}${glyph}${SEQ.reset}`;
    }
    return line;
  });
}

/**
 * 构建右侧栏各行：活动 → 上下文（主指标块）→ 费用表 → 任务 → 子代理，按高度裁剪。
 * hoverContext 为 true 时用精确 tokens 与剩余量替换紧凑用量行（鼠标悬停圆环）。
 */
export function buildSidebarFrame(
  state: SidebarState,
  width: number,
  maxRows: number,
  now = Date.now(),
  hoverContext = false,
): SidebarFrame {
  if (width <= 0 || maxRows <= 0) return { rows: [] };
  const w = Math.max(1, Math.floor(width));
  /** 文字可用宽度：右侧留 1 列，避免贴边。 */
  const contentW = Math.max(1, w - SIDEBAR_RIGHT_MARGIN);
  const rows: string[] = [];
  const push = (row: string): void => {
    if (rows.length < maxRows) rows.push(row);
  };
  const blank = (): void => {
    if (rows.length > 0 && rows.length < maxRows) push("");
  };
  /** 章节标题自带前置空行：三段的呼吸节奏一致，不再靠调用点手动补。 */
  const section = (label: string): void => {
    blank();
    push(`${SEQ.boldAccent}${label}${SEQ.reset}`);
  };
  /** 在内容宽度内水平居中（ANSI 行按可见宽度计算）。 */
  const centered = (text: string): string => {
    const pad = Math.max(0, Math.floor((contentW - terminalWidth(text)) / 2));
    return pad === 0 ? text : `${" ".repeat(pad)}${text}`;
  };
  /** 双列表格的一行：标签靠左淡色，数值靠右对齐。 */
  const tableRow = (label: string, value: string, valueColor = SEQ.reset): void => {
    const labelW = terminalWidth(label);
    const budget = Math.max(1, contentW - labelW - 1);
    const fitted = truncateText(value, budget);
    const gap = Math.max(1, contentW - labelW - terminalWidth(fitted));
    push(`${SEQ.muted}${label}${SEQ.reset}${" ".repeat(gap)}${valueColor}${fitted}${SEQ.reset}`);
  };

  // 活动行放在最上方：侧栏出现时底部状态行让位给常规状态，当前在跑什么就在这里。
  if (state.activity) {
    const activityRow = buildActivityRow(state.activity, contentW);
    if (activityRow) push(activityRow);
  }

  // ── 上下文：整栏唯一的大图形，百分比压中心、用量紧贴其下居中，形成一条中线 ──
  const used = Math.max(0, state.usedTokens);
  const max = Math.max(1, state.maxTokens);
  const ratio = Math.min(1, Math.max(0, used / max));
  const percent = `${Math.round(ratio * 100)}%`;
  section("上下文");

  // 空间够时画圆环；太挤则退回单行进度条，避免把费用/任务全部挤掉。
  let ring: SidebarRingGeometry | undefined;
  const remainingForContext = maxRows - rows.length;
  const ringHeight = remainingForContext >= 16 ? 7 : remainingForContext >= 10 ? 5 : 0;
  if (ringHeight > 0) {
    // 宽 = 2 × 高：点阵 2×4，只有这个比例在终端里才是正圆。
    const ringWidth = Math.min(ringHeight * 2, Math.max(4, contentW));
    const left = Math.max(0, Math.floor((contentW - ringWidth) / 2));
    const ringRows = buildContextRing(ratio, ringWidth, ringHeight);
    ring = { top: rows.length, height: ringHeight, left, width: ringWidth };
    for (const line of ringRows) push(left === 0 ? line : `${" ".repeat(left)}${line}`);
  } else {
    const barCapacity = Math.max(4, Math.min(14, contentW - terminalWidth(percent) - 2));
    const filled = Math.min(barCapacity, Math.max(0, Math.round(ratio * barCapacity)));
    const empty = Math.max(0, barCapacity - filled);
    const ratioColor = ratio >= 0.85 ? SEQ.boldRed : ratio >= 0.6 ? SEQ.yellow : SEQ.softAccent;
    push(
      `${ratioColor}${"█".repeat(filled)}${SEQ.reset}${SEQ.faint}${"░".repeat(empty)}${SEQ.reset} ${ratioColor}${percent}${SEQ.reset}`,
    );
  }

  if (hoverContext) {
    push(
      centered(
        `${SEQ.muted}已用 ${formatExactTokens(used)} / ${formatExactTokens(max)}${SEQ.reset}`,
      ),
    );
    push(
      centered(
        `${SEQ.muted}剩余 ${formatExactTokens(Math.max(0, max - used))} · ${percent}${SEQ.reset}`,
      ),
    );
  } else {
    push(
      centered(
        `${SEQ.muted}${formatTokenBudget(used)} / ${formatTokenBudget(max)} tokens${SEQ.reset}`,
      ),
    );
  }

  // 压缩徽标：圆环会因压缩突然掉下来，标注一次就能消掉“上下文怎么没了”的困惑。
  if (state.compactionCount !== undefined && state.compactionCount > 0) {
    push(centered(`${SEQ.accent}⟳ 已压缩 ×${state.compactionCount}${SEQ.reset}`));
  }

  // ── 费用：标签左、数值右对齐的双列小表，耗时并进同一张表 ──
  section("费用");
  if (state.costCny === undefined) {
    push(`${SEQ.muted}${truncateText("暂无已计费调用", contentW)}${SEQ.reset}`);
  } else {
    tableRow(
      "花费",
      `${formatCostAmount(state.costCny)}${state.hasUnpricedCost ? " · 含未定价" : ""}`,
    );
    if (state.costRequests !== undefined && state.costRequests > 0) {
      tableRow("请求", `${state.costRequests} 次`);
    }
  }
  const promptTokens = Math.max(0, state.promptTokens ?? 0);
  const completionTokens = Math.max(0, state.completionTokens ?? 0);
  if (promptTokens > 0) tableRow("输入", `↑${formatAgentTokens(promptTokens)}`);
  if (completionTokens > 0) tableRow("输出", `↓${formatAgentTokens(completionTokens)}`);
  if (state.lastTurnMs !== undefined && state.lastTurnMs > 0) {
    tableRow("上一轮", formatTurnDuration(state.lastTurnMs));
  }

  if (state.taskPlan && state.taskPlan.items.length > 0) {
    blank();
    const remaining = maxRows - rows.length;
    if (remaining >= 2) {
      const taskRows = buildTaskPanelRows(state.taskPlan, contentW, Math.min(remaining, 8), now);
      rows.push(...taskRows.slice(0, remaining));
    }
  }

  if (state.agents && state.agents.length > 0) {
    blank();
    const remaining = maxRows - rows.length;
    if (remaining >= 2) {
      const agentRows = buildAgentPanelRows(state.agents, contentW, Math.min(remaining, 6), now);
      rows.push(...agentRows.slice(0, remaining));
    }
  }

  return { rows: rows.slice(0, maxRows), ring };
}

/** 仅需要行内容时的便捷入口（测试与不关心圆环位置的调用方使用）。 */
export function buildSidebarRows(
  state: SidebarState,
  width: number,
  maxRows: number,
  now = Date.now(),
  hoverContext = false,
): string[] {
  return buildSidebarFrame(state, width, maxRows, now, hoverContext).rows;
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
  return `${leftPadded} ${SEQ.faint}│${SEQ.reset} ${sidebarPadded}`;
}
