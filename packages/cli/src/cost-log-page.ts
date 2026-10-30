/**
 * 费用日志页的纯渲染层：把「每条请求一次调用」排成占据对话区的一屏。
 *
 * 与 context-inspector 同一模式：只读标量状态、输出 ANSI 行，不做 I/O、不持定时器。
 * 每行宽度严格等于传入的 width，超出统一裁剪，所以能用固定宽度直接单测
 * （见 test/cost-log-page.test.mjs）。
 *
 * 版式：进页面时临时收起右侧栏，拿回整行宽度；顶部是列名，中间是可滚动的请求列表，
 * 底部一行给出选中项的完整口径（单价档、缓存命中、用途）。窄屏降级成每条请求两行。
 */
import { formatCostCny, type RequestCostDetail, type TurnMetric } from "./cost-tracker.js";
import { SEQ, terminalWidth, truncateAnsiText, truncateText } from "./terminal-text.js";

/** 页面本身要求的最小宽度/高度；再小由调用方拦下并提示。 */
export const COST_LOG_MIN_COLUMNS = 48;
export const COST_LOG_MIN_ROWS = 8;
/** 低于该宽度时每条请求改成上下两行，避免列被挤成一团。 */
const COMPACT_MIN_WIDTH = 76;
/** 宽屏下列宽（不含模型列，模型吃剩下的空间）。 */
const SEQ_WIDTH = 3;
const TIME_WIDTH = 8;
const TURN_WIDTH = 3;
const INPUT_WIDTH = 7;
const CACHED_WIDTH = 7;
const OUTPUT_WIDTH = 7;
const COST_WIDTH = 9;
/** 模型列的最低可用宽度：再窄就降级成两行模式。 */
const MODEL_MIN_WIDTH = 8;
const FIXED_COLUMNS =
  SEQ_WIDTH + TIME_WIDTH + TURN_WIDTH + INPUT_WIDTH + CACHED_WIDTH + OUTPUT_WIDTH + COST_WIDTH;

/** 排序口径：与侧栏可点的五行指标一一对应。 */
export type CostLogSort = TurnMetric;

/** 页面状态：由调用方持有，翻页/换排序时只改这几个数。 */
export interface CostLogState {
  details: readonly RequestCostDetail[];
  sort: CostLogSort;
  /** 排序后列表里的选中下标；渲染时会夹紧到有效范围。 */
  selectedIndex: number;
}

/** 一帧的产物：屏幕行 + 鼠标命中区域（行号均为 0 基，相对本帧）。 */
export interface CostLogFrame {
  rows: string[];
  /** 列表首行与可视高度；点击落在里面就选中对应请求。 */
  listTop: number;
  listHeight: number;
  listLeft: number;
  listWidth: number;
  /** 列表首行对应的（排序后）下标；选中项滚出视野时 > 0。 */
  listOffset: number;
  /** 每条请求占几行（宽屏 1、窄屏 2），点击换算要用。 */
  itemHeight: number;
  /** 当前选中项在排序后列表里的下标（夹紧后的值，回写给调用方）。 */
  selectedIndex: number;
  /** 顶栏「Esc 返回」的命中范围。 */
  back: { row: number; left: number; width: number };
}

const SORT_LABEL: Record<CostLogSort, string> = {
  cost: "花费明细",
  requests: "请求日志",
  input: "输入明细",
  output: "输出明细",
  cached: "缓存明细",
};

/** tokens 口径与侧栏一致：不到 1000 直接给数，再大收成 k / M。 */
export function formatTokenCount(value: number): string {
  const safe = Math.max(0, Math.round(value));
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(safe < 10_000_000 ? 1 : 0)}M`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(safe < 10_000 ? 1 : 0)}k`;
  return String(safe);
}

/** 耗时文案：不足一分钟给秒，超过则给「Xm Ys」；未知给「—」。 */
export function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** 时刻 → HH:MM:SS（本地时区）。 */
export function formatLogClock(atMs: number): string {
  const date = new Date(Number.isFinite(atMs) ? atMs : Date.now());
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 按指标排序（返回新数组，不改入参）。
 *
 * 「请求」是时间视角，按序号正序；其余按对应数值降序（大额/大用量先看到），
 * 同值时用序号兜底，保证每帧顺序稳定、点击不会在两次渲染间跳位。
 */
export function sortRequestDetails(
  details: readonly RequestCostDetail[],
  sort: CostLogSort,
): RequestCostDetail[] {
  const metricValue = (detail: RequestCostDetail): number => {
    switch (sort) {
      case "input":
        return detail.promptTokens;
      case "output":
        return detail.completionTokens;
      case "cached":
        return detail.cachedPromptTokens;
      case "cost":
        return detail.costCny ?? -1;
      default:
        return detail.seq;
    }
  };
  const sorted = [...details];
  if (sort === "requests") {
    sorted.sort((left, right) => left.seq - right.seq);
    return sorted;
  }
  sorted.sort((left, right) => metricValue(right) - metricValue(left) || left.seq - right.seq);
  return sorted;
}

/** 按可见宽度补空格（超宽先裁剪），保证整行恰好占满。 */
export function padToWidth(text: string, width: number, align: "left" | "right" = "left"): string {
  const visible = terminalWidth(text);
  if (visible >= width) return truncateAnsiText(text, width);
  const gap = " ".repeat(width - visible);
  return align === "right" ? `${gap}${text}` : `${text}${gap}`;
}

/** 顶栏右侧的返回按钮文案：带方括号，明示这是一颗可点的按钮。 */
const BACK_LABEL = "[Esc 返回]";
/** 窄屏用的短文案：标题还要留位置，所以只保留动作。 */
const BACK_LABEL_SHORT = "[返回]";

/** 按可用宽度挑按钮文案；渲染与命中矩形都走这里，保证两者永远一致。 */
export function backLabelFor(width: number): string {
  return width >= 68 ? BACK_LABEL : BACK_LABEL_SHORT;
}

/**
 * 顶框：`╭ 标题 ─── [Esc 返回] ╮`。
 *
 * 先给返回按钮留位再裁标题：按钮是唯一能点回对话区的控件，任何宽度下都得画出来；
 * 标题放不下时用省略号收尾。
 */
export function topBorder(width: number, title: string, label = backLabelFor(width)): string {
  const rightText = truncateText(` ${label} `, Math.max(0, width - 2));
  const titleText = truncateText(` ${title} `, Math.max(0, width - 2 - terminalWidth(rightText)));
  const fill = Math.max(0, width - 2 - terminalWidth(titleText) - terminalWidth(rightText));
  return `${SEQ.faint}╭${SEQ.reset}${SEQ.boldAccent}${titleText}${SEQ.reset}${SEQ.faint}${"─".repeat(fill)}${SEQ.reset}${SEQ.accent}${rightText}${SEQ.reset}${SEQ.faint}╮${SEQ.reset}`;
}

/** 底框：提示靠右，`╰─── 提示 ╯`。 */
export function bottomBorder(width: number, hint: string): string {
  const hintText = truncateText(` ${hint} `, Math.max(1, width - 2));
  const fill = Math.max(0, width - 2 - terminalWidth(hintText));
  return `${SEQ.faint}╰${"─".repeat(fill)}${SEQ.reset}${SEQ.muted}${hintText}${SEQ.reset}${SEQ.faint}╯${SEQ.reset}`;
}

/** 一整行的水平分隔，左右用框线字符收口。 */
export function hLine(width: number): string {
  return `${SEQ.faint}├${"─".repeat(Math.max(0, width - 2))}┤${SEQ.reset}`;
}

/** 左右各有竖线的内容行：内容按 inner 宽度裁剪并补空格。 */
export function frameRow(width: number, content: string): string {
  const inner = Math.max(0, width - 2);
  const body = truncateAnsiText(content, inner);
  const gap = Math.max(0, inner - terminalWidth(body));
  return `${SEQ.faint}│${SEQ.reset}${body}${" ".repeat(gap)}${SEQ.faint}│${SEQ.reset}`;
}

/** 列名行：当前排序键带 ▾，其余淡色。 */
function headerRow(inner: number, sort: CostLogSort, compact: boolean): string {
  const cell = (
    text: string,
    cellWidth: number,
    align: "left" | "right" = "left",
    active = false,
  ): string => {
    const body = active
      ? `${SEQ.boldAccent}${text}▾${SEQ.reset}`
      : `${SEQ.muted}${text}${SEQ.reset}`;
    return padToWidth(body, cellWidth, align);
  };
  if (compact) {
    // 窄屏两行模式：第一行只有定位用的三列，数字类列名留给第二行自带标签。
    return padToWidth(
      `${SEQ.faint}#${SEQ.reset} ${cell("时间", TIME_WIDTH)} ${cell("模型", Math.max(1, inner - SEQ_WIDTH - TIME_WIDTH - 2))}`,
      inner,
    );
  }
  const modelWidth = Math.max(MODEL_MIN_WIDTH, inner - FIXED_COLUMNS - 7);
  const cells = [
    padToWidth(`${SEQ.faint}#${SEQ.reset}`, SEQ_WIDTH),
    cell("时间", TIME_WIDTH, "left", sort === "requests"),
    cell("轮", TURN_WIDTH, "right"),
    padToWidth(`${SEQ.muted}模型${SEQ.reset}`, modelWidth),
    cell("输入", INPUT_WIDTH, "right", sort === "input"),
    cell("缓存", CACHED_WIDTH, "right", sort === "cached"),
    cell("输出", OUTPUT_WIDTH, "right", sort === "output"),
    cell("花费", COST_WIDTH, "right", sort === "cost"),
  ];
  return cells.join(" ");
}

function costText(detail: RequestCostDetail): string {
  return detail.costCny === null ? "未定价" : formatCostCny(detail.costCny);
}

/** 一行（宽屏）请求记录。 */
function wideItemRow(detail: RequestCostDetail, modelWidth: number, selected: boolean): string {
  const marker = selected ? "▸" : " ";
  const seqText = selected
    ? `${SEQ.boldAccent}${marker}${detail.seq}${SEQ.reset}`
    : `${SEQ.faint}${marker}${detail.seq}${SEQ.reset}`;
  const turnText = detail.turn > 0 ? String(detail.turn) : "—";
  const costColor = detail.costCny === null ? SEQ.yellow : selected ? SEQ.accent : SEQ.reset;
  const cells = [
    padToWidth(seqText, SEQ_WIDTH),
    padToWidth(
      `${selected ? SEQ.accent : SEQ.muted}${formatLogClock(detail.at)}${SEQ.reset}`,
      TIME_WIDTH,
    ),
    padToWidth(`${selected ? SEQ.accent : SEQ.faint}${turnText}${SEQ.reset}`, TURN_WIDTH, "right"),
    padToWidth(
      `${selected ? SEQ.accent : SEQ.muted}${truncateText(detail.model, modelWidth)}${SEQ.reset}`,
      modelWidth,
    ),
    padToWidth(
      `${selected ? SEQ.boldAccent : SEQ.reset}↑${formatTokenCount(detail.promptTokens)}${SEQ.reset}`,
      INPUT_WIDTH,
      "right",
    ),
    padToWidth(
      detail.cachedPromptTokens > 0
        ? `${selected ? SEQ.boldAccent : SEQ.faint}⛁${formatTokenCount(detail.cachedPromptTokens)}${SEQ.reset}`
        : `${SEQ.faint}—${SEQ.reset}`,
      CACHED_WIDTH,
      "right",
    ),
    padToWidth(
      `${selected ? SEQ.boldAccent : SEQ.reset}↓${formatTokenCount(detail.completionTokens)}${SEQ.reset}`,
      OUTPUT_WIDTH,
      "right",
    ),
    padToWidth(`${costColor}${costText(detail)}${SEQ.reset}`, COST_WIDTH, "right"),
  ];
  return cells.join(" ");
}

/** 两行（窄屏）请求记录：上行定位，下行给数字。 */
function compactItemRows(
  detail: RequestCostDetail,
  inner: number,
  selected: boolean,
): [string, string] {
  const marker = selected ? "▸" : " ";
  const seqText = selected
    ? `${SEQ.boldAccent}${marker}${detail.seq}${SEQ.reset}`
    : `${SEQ.faint}${marker}${detail.seq}${SEQ.reset}`;
  const head = `${seqText} ${SEQ.muted}${formatLogClock(detail.at)}${SEQ.reset} ${
    selected ? SEQ.accent : SEQ.reset
  }${truncateText(detail.model, Math.max(1, inner - 15))}${SEQ.reset}`;
  const cached =
    detail.cachedPromptTokens > 0
      ? `缓存 ${formatTokenCount(detail.cachedPromptTokens)}`
      : "缓存 —";
  const costColor = detail.costCny === null ? SEQ.yellow : selected ? SEQ.accent : SEQ.reset;
  const tail = `${SEQ.faint}输入${SEQ.reset} ${formatTokenCount(detail.promptTokens)} · ${SEQ.faint}${cached}${SEQ.reset} · ${SEQ.faint}输出${SEQ.reset} ${formatTokenCount(
    detail.completionTokens,
  )} · ${costColor}${costText(detail)}${SEQ.reset}`;
  return [padToWidth(head, inner), padToWidth(`    ${tail}`, inner)];
}

/**
 * 选中项的完整口径：轮次、用途、单价档、缓存命中。
 * 宽度不够时截断，不换行——底栏高度固定为一行，换行会把框顶掉。
 */
function detailLine(detail: RequestCostDetail, width: number): string {
  const parts: string[] = [`#${detail.seq}`];
  parts.push(detail.turn > 0 ? `第 ${detail.turn} 轮` : "未分轮");
  parts.push(detail.purpose);
  // 缓存是否上报与有没有单价无关：未定价的模型也照样要说明这一列为什么是空的。
  if (detail.cachedPromptTokens > 0) {
    const ratio = Math.round((detail.cachedPromptTokens / Math.max(1, detail.promptTokens)) * 100);
    parts.push(`缓存命中 ${ratio}%`);
  } else if (detail.cacheReported === false) {
    parts.push("provider 未上报缓存命中");
  }
  if (detail.costCny === null) {
    parts.push("未定价（补上单价后自动重算）");
  } else if (detail.flatFee) {
    parts.push("按次计费 · 5 元/千次成功请求（2026-11-01 起）");
  } else {
    if (detail.offPeak) parts.push("谷时价");
    if (detail.pricing) {
      const price = [
        `输入 ¥${detail.pricing.inputPerMTokens}/M`,
        `输出 ¥${detail.pricing.outputPerMTokens}/M`,
        ...(detail.pricing.cachedInputPerMTokens !== undefined
          ? [`缓存 ¥${detail.pricing.cachedInputPerMTokens}/M`]
          : []),
      ].join(" · ");
      parts.push(price);
    }
  }
  return frameRow(width, `${SEQ.muted}${parts.join(" · ")}${SEQ.reset}`);
}

/**
 * 排出整屏页面。
 *
 * 行结构：顶框 / 列名 / 列表 ×N / 分隔 / 选中详情 / 底框。
 * 高度不够时优先保住列表，详情行仍占一行（它是最省地方的口径展示）。
 */
export function buildCostLogFrame(
  state: CostLogState,
  width: number,
  height: number,
): CostLogFrame {
  const safeWidth = Math.max(COST_LOG_MIN_COLUMNS, Math.floor(width));
  const safeHeight = Math.max(COST_LOG_MIN_ROWS, Math.floor(height));
  const inner = safeWidth - 2;

  const sorted = sortRequestDetails(state.details, state.sort);
  const selectedIndex = Math.min(Math.max(0, state.selectedIndex), Math.max(0, sorted.length - 1));
  const selected = sorted[selectedIndex];
  const compact = safeWidth < COMPACT_MIN_WIDTH;
  const modelWidth = Math.max(MODEL_MIN_WIDTH, inner - FIXED_COLUMNS - 7);
  const itemHeight = compact ? 2 : 1;

  // 固定占位：顶框 1 + 列名 1 + 分隔 1 + 详情 1 + 底框 1 = 5 行。
  const listHeight = Math.max(itemHeight, safeHeight - 5);
  const visibleItems = Math.max(1, Math.floor(listHeight / itemHeight));
  const listOffset = Math.max(
    0,
    Math.min(selectedIndex - visibleItems + 1, Math.max(0, sorted.length - visibleItems)),
  );
  const listRows: string[] = [];
  for (let index = 0; index < visibleItems; index += 1) {
    const detail = sorted[listOffset + index];
    if (!detail) {
      listRows.push(...new Array(itemHeight).fill(""));
      continue;
    }
    const isSelected = listOffset + index === selectedIndex;
    if (compact) {
      listRows.push(...compactItemRows(detail, inner, isSelected));
    } else {
      listRows.push(wideItemRow(detail, modelWidth, isSelected));
    }
  }
  while (listRows.length < listHeight) listRows.push("");

  const totalCost = sorted.reduce((sum, detail) => sum + (detail.costCny ?? 0), 0);
  const unpricedCount = sorted.filter((detail) => detail.costCny === null).length;
  const titleParts = [
    SORT_LABEL[state.sort],
    `共 ${sorted.length} 次请求`,
    `合计 ${formatCostCny(totalCost)}`,
  ];
  if (unpricedCount > 0) titleParts.push(`${unpricedCount} 次未定价`);

  const rows: string[] = [];
  rows.push(topBorder(safeWidth, titleParts.join(" · ")));
  rows.push(frameRow(safeWidth, headerRow(inner, state.sort, compact)));
  for (const row of listRows.slice(0, listHeight)) rows.push(frameRow(safeWidth, row));
  rows.push(hLine(safeWidth));
  if (sorted.length === 0) {
    rows.push(frameRow(safeWidth, `${SEQ.muted}本会话暂无已计费的模型调用。${SEQ.reset}`));
  } else if (selected) {
    rows.push(detailLine(selected, safeWidth));
  } else {
    rows.push(frameRow(safeWidth, ""));
  }
  // 窄屏放不下完整提示，只保留最要紧的三件事：怎么进详情、怎么选中、怎么回去。
  rows.push(
    bottomBorder(
      safeWidth,
      compact
        ? "Enter 看回合 · Esc 或点右上返回"
        : "↑↓ 选请求 · Enter 看回合详情 · Esc 或点右上返回",
    ),
  );

  // 行数兜底：窗口比最小高度还矮时补齐，避免调用方切片越界。
  while (rows.length < safeHeight) rows.push(padToWidth("", safeWidth));

  const backText = ` ${backLabelFor(safeWidth)} `;
  return {
    rows: rows.slice(0, safeHeight),
    listTop: 2,
    listHeight,
    listLeft: 1,
    listWidth: inner,
    listOffset,
    itemHeight,
    selectedIndex,
    // 命中区比按钮文字左右各宽 1 列，鼠标差一格也能点中。
    back: backHit(terminalWidth(backText), safeWidth),
  };
}

/** 把按钮文字宽度换算成整行内的命中矩形（行 0，靠右并左右各放宽 1 列）。 */
export function backHit(
  textWidth: number,
  width: number,
): { row: number; left: number; width: number } {
  const left = Math.max(0, width - 1 - textWidth);
  const hitLeft = Math.max(0, left - 1);
  return {
    row: 0,
    left: hitLeft,
    width: Math.max(0, Math.min(textWidth + 2, width - 1 - hitLeft)),
  };
}
