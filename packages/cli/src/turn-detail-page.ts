/**
 * 回合详情页的纯渲染层：把「某一轮里的每一次模型调用」排成一屏。
 *
 * 与 cost-log-page / context-inspector 同一模式：只读标量状态、输出 ANSI 行，
 * 不做 I/O、不持定时器，因此能用固定宽度直接单测（见 test/turn-detail-page.test.mjs）。
 *
 * 版式：费用列表按 Enter 进来，整页换成这一轮的账单——
 * 顶栏标题带返回按钮，头部一行给出轮次/次数/模型数/时间跨度/缓存命中率，
 * 中间逐次调用一行（含占比），底部是本轮口径（模型分布、缓存、占会话比例、未定价提示）。
 * 高度不够时先砍底部口径，再砍列表行；宽度不够时每次调用降级成两行。
 */

import {
  backHit,
  bottomBorder,
  formatDurationMs,
  formatLogClock,
  formatTokenCount,
  frameRow,
  hLine,
  padToWidth,
  topBorder,
} from "./cost-log-page.js";
import { formatCostCny, type RequestCostDetail } from "./cost-tracker.js";
import { SEQ, terminalWidth, truncateText } from "./terminal-text.js";

/** 页面本身要求的最小宽度/高度；再小由调用方拦下并提示。 */
export const TURN_DETAIL_MIN_COLUMNS = 48;
export const TURN_DETAIL_MIN_ROWS = 8;
/** 低于该宽度时每次调用改成上下两行（与费用列表保持同一阈值）。 */
const COMPACT_MIN_WIDTH = 76;

const SEQ_WIDTH = 6;
const TIME_WIDTH = 8;
const PURPOSE_WIDTH = 10;
const INPUT_WIDTH = 10;
const OUTPUT_WIDTH = 10;
const COST_WIDTH = 8;
const PCT_WIDTH = 5;

/** 页面状态：只读快照 + 本轮的选中下标。 */
export interface TurnDetailState {
  /** 打开费用列表时抓的全量快照；页面自己按 turn 过滤，不额外持状态。 */
  details: readonly RequestCostDetail[];
  /** 要看的轮次（1 起）；0 表示无从归属，调用方不该打开页面。 */
  turn: number;
  /** 本轮调用列表里的选中下标；渲染时夹紧。 */
  selectedIndex: number;
}

/** 一帧的产物：屏幕行 + 鼠标命中区域（行号均为 0 基，相对本帧）。 */
export interface TurnDetailFrame {
  rows: string[];
  listTop: number;
  listHeight: number;
  listLeft: number;
  listWidth: number;
  /** 列表首行对应的（按 seq 升序的）下标；选中项滚出视野时 > 0。 */
  listOffset: number;
  /** 每次调用占几行（宽屏 1、窄屏 2）。 */
  itemHeight: number;
  /** 夹紧后的选中下标，回写给调用方。 */
  selectedIndex: number;
  /** 本轮调用数（夹紧的边界，调用方导航用）。 */
  count: number;
  /** 顶栏「返回列表」的命中范围。 */
  back: { row: number; left: number; width: number };
}

/** 挑出某一轮的调用，按序号升序（与「请求」视角一致：时间正序）。 */
export function collectTurnDetails(
  details: readonly RequestCostDetail[],
  turn: number,
): RequestCostDetail[] {
  return details
    .filter((detail) => detail.turn === turn)
    .sort((left, right) => left.seq - right.seq);
}

/** 金额文案：未定价时明确写出来，而不是显示 0。 */
function costText(detail: RequestCostDetail): string {
  return detail.costCny === null ? "未定价" : formatCostCny(detail.costCny);
}

/** 当前这条占本轮的百分比；本轮未定价时给 —。 */
function shareText(detail: RequestCostDetail, turnTotal: number): string {
  if (detail.costCny === null || turnTotal <= 0) return "—";
  return `${Math.round((detail.costCny / turnTotal) * 100)}%`;
}

/** 宽屏一行：序号 / 时间 / 用途 / 输入 / 输出 / 花费 / 占比。 */
function wideItemRow(detail: RequestCostDetail, turnTotal: number, selected: boolean): string {
  const seqText = selected
    ? `${SEQ.boldAccent}▸#${detail.seq}${SEQ.reset}`
    : `${SEQ.faint} #${detail.seq}${SEQ.reset}`;
  const costColor = detail.costCny === null ? SEQ.yellow : selected ? SEQ.accent : SEQ.reset;
  const cells = [
    padToWidth(seqText, SEQ_WIDTH),
    padToWidth(
      `${selected ? SEQ.accent : SEQ.muted}${formatLogClock(detail.at)}${SEQ.reset}`,
      TIME_WIDTH,
    ),
    padToWidth(
      `${selected ? SEQ.accent : SEQ.muted}${truncateText(detail.purpose, PURPOSE_WIDTH)}${SEQ.reset}`,
      PURPOSE_WIDTH,
    ),
    padToWidth(
      `${selected ? SEQ.boldAccent : SEQ.reset}输入 ${formatTokenCount(detail.promptTokens)}${SEQ.reset}`,
      INPUT_WIDTH,
      "right",
    ),
    padToWidth(
      `${selected ? SEQ.boldAccent : SEQ.reset}输出 ${formatTokenCount(detail.completionTokens)}${SEQ.reset}`,
      OUTPUT_WIDTH,
      "right",
    ),
    padToWidth(`${costColor}${costText(detail)}${SEQ.reset}`, COST_WIDTH, "right"),
    padToWidth(
      `${selected ? SEQ.accent : SEQ.muted}${shareText(detail, turnTotal)}${SEQ.reset}`,
      PCT_WIDTH,
      "right",
    ),
  ];
  return cells.join(" ");
}

/** 窄屏两行：上行定位（序号/时间/用途），下行给数字与占比。 */
function compactItemRows(
  detail: RequestCostDetail,
  turnTotal: number,
  selected: boolean,
): [string, string] {
  const seqText = selected
    ? `${SEQ.boldAccent}▸#${detail.seq}${SEQ.reset}`
    : `${SEQ.faint} #${detail.seq}${SEQ.reset}`;
  const head = `${seqText} ${SEQ.muted}${formatLogClock(detail.at)}${SEQ.reset} ${
    selected ? SEQ.accent : SEQ.reset
  }${truncateText(detail.purpose, PURPOSE_WIDTH)}${SEQ.reset}`;
  const costColor = detail.costCny === null ? SEQ.yellow : selected ? SEQ.accent : SEQ.reset;
  const tail = `${SEQ.faint}输入${SEQ.reset} ${formatTokenCount(detail.promptTokens)} · ${SEQ.faint}输出${SEQ.reset} ${formatTokenCount(
    detail.completionTokens,
  )} · ${costColor}${costText(detail)}${SEQ.reset} · ${SEQ.muted}${shareText(detail, turnTotal)}${SEQ.reset}`;
  return [head, `  ${tail}`];
}

/** 本轮口径：模型分布、缓存命中、占会话比例、未定价提示——全部可从快照直接算出。 */
function contextLines(
  items: readonly RequestCostDetail[],
  sessionPromptTokens: number,
  width: number,
): string[] {
  const turnPrompt = items.reduce((sum, item) => sum + item.promptTokens, 0);
  const turnCached = items.reduce((sum, item) => sum + item.cachedPromptTokens, 0);
  const turnOutput = items.reduce((sum, item) => sum + item.completionTokens, 0);
  const models = new Map<string, number>();
  for (const item of items) models.set(item.model, (models.get(item.model) ?? 0) + 1);
  const modelText = [...models.entries()].map(([name, count]) => `${name} ×${count}`).join(" · ");

  const lines: string[] = [];
  // 用户问题只记在每轮第一条记录上；历史会话没有这项就整行不写。
  const asked = items.find((item) => item.turnPrompt)?.turnPrompt;
  if (asked) lines.push(`用户问题：${asked}`);
  lines.push(`模型 ${modelText}`);
  const cachedRatio = turnPrompt > 0 ? Math.round((turnCached / turnPrompt) * 100) : 0;
  lines.push(
    turnCached > 0
      ? `缓存命中 ${formatTokenCount(turnCached)} / ${formatTokenCount(turnPrompt)}（${cachedRatio}%）· 输出合计 ${formatTokenCount(turnOutput)}`
      : `未命中缓存 · 输出合计 ${formatTokenCount(turnOutput)}`,
  );
  if (sessionPromptTokens > 0) {
    const share = Math.round((turnPrompt / sessionPromptTokens) * 100);
    lines.push(
      `占会话输入 ${share}%（${formatTokenCount(turnPrompt)} / ${formatTokenCount(sessionPromptTokens)}）`,
    );
  }
  const unpriced = items.filter((item) => item.costCny === null).length;
  if (unpriced > 0) lines.push(`${unpriced} 次未定价（补单价后自动重算）`);
  return lines.map((line) => truncateText(line, width));
}

/** 顶栏按钮文案：进去之后要回的是列表，不是对话区，所以文案是「返回列表」。 */
function backLabelFor(width: number): string {
  return width >= 68 ? "[Esc 返回列表]" : "[返回]";
}

/**
 * 排出整屏回合详情页。
 *
 * 行结构：顶框 / 头部 / 空行 / 「本轮花费」+ 合计 / 分隔 / 调用 ×N / 空行 /
 * 「本轮上下文」/ 分隔 / 口径 ×K / 底框。高度不够时整块砍掉上下文小节。
 */
export function buildTurnDetailFrame(
  state: TurnDetailState,
  width: number,
  height: number,
): TurnDetailFrame {
  const safeWidth = Math.max(TURN_DETAIL_MIN_COLUMNS, Math.floor(width));
  const safeHeight = Math.max(TURN_DETAIL_MIN_ROWS, Math.floor(height));
  const inner = safeWidth - 2;
  const compact = safeWidth < COMPACT_MIN_WIDTH;
  const itemHeight = compact ? 2 : 1;

  const items = collectTurnDetails(state.details, state.turn);
  const count = items.length;
  const total = items.reduce((sum, item) => sum + (item.costCny ?? 0), 0);
  const sessionPromptTokens = state.details.reduce((sum, item) => sum + item.promptTokens, 0);
  const selectedIndex = Math.min(Math.max(0, state.selectedIndex), Math.max(0, count - 1));

  // 顶部固定：顶框 / 头部 / 空行 / 小节标题 / 分隔。
  const headRows = 5;
  const ctx = contextLines(items, sessionPromptTokens, Math.max(1, inner - 1));
  // 底部上下文小节：空行 + 标题 + 分隔 + 口径行。
  const ctxBlockRows = 3 + ctx.length;
  // 上下文小节是「锦上添花」：只有不挤占列表时才画。
  // 至少保住 3 条调用（不足 3 条时按实际条数），否则宁可整块砍掉。
  const minListRows = Math.min(3, Math.max(1, count)) * itemHeight;
  const showContext = safeHeight - headRows - 1 - minListRows >= ctxBlockRows;
  const listHeight = Math.max(
    itemHeight,
    safeHeight - headRows - 1 - (showContext ? ctxBlockRows : 0),
  );
  const visibleItems = Math.max(1, Math.floor(listHeight / itemHeight));
  const listOffset = Math.max(
    0,
    Math.min(selectedIndex - visibleItems + 1, Math.max(0, count - visibleItems)),
  );

  const listRows: string[] = [];
  for (let index = 0; index < visibleItems; index += 1) {
    const detail = items[listOffset + index];
    if (!detail) {
      listRows.push(...new Array(itemHeight).fill(""));
      continue;
    }
    const isSelected = listOffset + index === selectedIndex;
    if (compact) {
      listRows.push(...compactItemRows(detail, total, isSelected));
    } else {
      listRows.push(wideItemRow(detail, total, isSelected));
    }
  }
  while (listRows.length < listHeight) listRows.push("");

  const first = items[0];
  const last = items[count - 1];
  const turnPrompt = items.reduce((sum, item) => sum + item.promptTokens, 0);
  const turnCached = items.reduce((sum, item) => sum + item.cachedPromptTokens, 0);
  const modelCount = new Set(items.map((item) => item.model)).size;
  const cacheRatio = turnPrompt > 0 ? Math.round((turnCached / turnPrompt) * 100) : 0;
  // 窄屏放不下完整头部：只留轮次/次数/模型数/缓存命中率，时间跨度让位。
  const headerParts = compact
    ? [`第 ${state.turn} 轮`, `${count} 次`, `${modelCount} 模型`]
    : [`第 ${state.turn} 轮`, `${count} 次调用`, `${modelCount} 个模型`];
  if (!compact && first && last) {
    headerParts.push(
      first === last
        ? formatLogClock(first.at)
        : `${formatLogClock(first.at)} – ${formatLogClock(last.at)}`,
    );
  }
  if (turnPrompt > 0) headerParts.push(compact ? `缓存 ${cacheRatio}%` : `缓存命中 ${cacheRatio}%`);
  // 耗时来自扩展记账字段：老会话没有，显示 — 而不是 0。
  const durationSum = items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
  const hasDuration = items.some((item) => item.durationMs !== undefined);
  if (!compact)
    headerParts.push(`调用耗时 ${formatDurationMs(hasDuration ? durationSum : undefined)}`);

  const totalText = total > 0 ? formatCostCny(total) : "未定价";
  const rows: string[] = [];
  rows.push(topBorder(safeWidth, `回合详情 · 第 ${state.turn} 轮`, backLabelFor(safeWidth)));
  rows.push(frameRow(safeWidth, `${SEQ.muted}${headerParts.join(" · ")}${SEQ.reset}`));
  rows.push(frameRow(safeWidth, ""));
  rows.push(
    frameRow(
      safeWidth,
      `${SEQ.boldAccent}${padToWidth(`本轮花费`, Math.max(1, inner - terminalWidth(totalText) - 1))}${SEQ.reset}${SEQ.accent}${totalText}${SEQ.reset}`,
    ),
  );
  rows.push(hLine(safeWidth));
  for (const row of listRows.slice(0, listHeight)) rows.push(frameRow(safeWidth, row));
  if (showContext) {
    rows.push(frameRow(safeWidth, ""));
    rows.push(frameRow(safeWidth, `${SEQ.boldAccent}本轮上下文${SEQ.reset}`));
    rows.push(hLine(safeWidth));
    for (const line of ctx) rows.push(frameRow(safeWidth, `${SEQ.muted}${line}${SEQ.reset}`));
  }
  rows.push(
    bottomBorder(
      safeWidth,
      compact
        ? "Enter 看详情 · Esc 返回列表"
        : "↑↓ 选调用 · Enter 看这次调用 · Esc 或点右上返回列表",
    ),
  );
  // 行数兜底：窗口比最小高度还矮时补齐，避免调用方切片越界。
  while (rows.length < safeHeight) rows.push(padToWidth("", safeWidth));

  const backText = ` ${backLabelFor(safeWidth)} `;
  return {
    rows: rows.slice(0, safeHeight),
    listTop: headRows,
    listHeight,
    listLeft: 1,
    listWidth: inner,
    listOffset,
    itemHeight,
    selectedIndex,
    count,
    back: backHit(terminalWidth(backText), safeWidth),
  };
}
