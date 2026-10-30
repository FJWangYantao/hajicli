/**
 * 覆盖对话区的两类只读页面的导航逻辑：上下文详情页、费用日志页（含回合详情 / 请求详情两层）。
 *
 * 从 TerminalUI 抽出的纯状态转移：输入是页面状态与按键/点击坐标，输出是「状态有没有变」
 * 或要执行的命令。TerminalUI 只负责持有状态、调度重绘和在命令落地时清理关联状态。
 */
import type readline from "node:readline";
import type { ContextItemGroup } from "./context-breakdown.js";
import { type CostLogSort, sortRequestDetails } from "./cost-log-page.js";
import type { RequestCostDetail } from "./cost-tracker.js";
import type { PatrolPageState } from "./patrol-page.js";
import { collectTurnDetails } from "./turn-detail-page.js";

/** PgUp/PgDn 一次移动的行数。 */
export const INSPECTOR_PAGE_ROWS = 8;

export interface ContextInspectorState {
  groups: ContextItemGroup[];
  categoryIndex: number;
  selectedIndex: number;
  scroll: number;
}

export interface CostLogPageState {
  details: RequestCostDetail[];
  sort: CostLogSort;
  selectedIndex: number;
  /**
   * 非空表示正停在某一轮的详情页：记下轮次与该轮内的选中下标。
   * 页面仍是同一个只读快照，Esc 只退回列表（列表的选中与滚动都保着）。
   */
  turnDetail?: {
    turn: number;
    selectedIndex: number;
    /** true 表示又往里走了一层：单次请求详情页。 */
    openDetail?: boolean;
  };
}

/** 上一帧的命中区域（屏幕绝对行列，1 基）；点击条目与「返回」用。 */
export interface OverlayHit {
  listTop: number;
  listHeight: number;
  listLeft: number;
  listWidth: number;
  listOffset: number;
  /** 每项占几行（费用日志窄屏两行一项）；缺省 1。 */
  itemHeight?: number;
  backRow: number;
  backLeft: number;
  backWidth: number;
}

const clamp = (value: number, max: number): number =>
  Math.min(Math.max(0, value), Math.max(0, max));

/** 点击落在哪：「返回」按钮、列表第 index 项，或什么都没点到。 */
export function overlayClickTarget(
  hit: OverlayHit,
  column: number,
  row: number,
): "back" | number | undefined {
  if (row === hit.backRow && column >= hit.backLeft && column < hit.backLeft + hit.backWidth) {
    return "back";
  }
  if (column < hit.listLeft || column >= hit.listLeft + hit.listWidth) return undefined;
  const itemHeight = Math.max(1, hit.itemHeight ?? 1);
  const offset = Math.floor((row - hit.listTop) / itemHeight);
  if (offset < 0 || offset * itemHeight >= hit.listHeight) return undefined;
  const index = hit.listOffset + offset;
  return index < 0 ? undefined : index;
}

// ── 上下文详情页 ──

/** 当前分类；页面关闭时为 undefined。 */
export function inspectorGroup(state: ContextInspectorState): ContextItemGroup | undefined {
  return state.groups[state.categoryIndex];
}

/** ↑↓：换条目；换到边界不动，并把原文滚动送回顶部。返回是否有变化。 */
export function moveInspectorItem(state: ContextInspectorState, delta: number): boolean {
  const group = inspectorGroup(state);
  if (!group) return false;
  const next = clamp(state.selectedIndex + delta, group.items.length - 1);
  if (next === state.selectedIndex) return false;
  state.selectedIndex = next;
  state.scroll = 0;
  return true;
}

/** ←→：换分类；分类变了就把选中项与滚动归零。 */
export function moveInspectorCategory(state: ContextInspectorState, delta: number): boolean {
  const next = Math.min(Math.max(0, state.categoryIndex + delta), state.groups.length - 1);
  if (next === state.categoryIndex) return false;
  state.categoryIndex = next;
  state.selectedIndex = 0;
  state.scroll = 0;
  return true;
}

/** PgUp/PgDn 与滚轮：只滚原文；上限取上一帧的实际可滚动行数。 */
export function scrollInspector(
  state: ContextInspectorState,
  delta: number,
  maxScroll: number,
): boolean {
  if (delta === 0) return false;
  const next = clamp(state.scroll + delta, maxScroll);
  if (next === state.scroll) return false;
  state.scroll = next;
  return true;
}

export type InspectorCommand =
  | { type: "close" }
  | { type: "item"; delta: number }
  | { type: "category"; delta: number }
  | { type: "scroll"; delta: number };

/** 详情页的按键：只接管导航键，返回 undefined 表示交还输入框。 */
export function inspectorKeyCommand(
  key: readline.Key,
  maxScroll: number,
): InspectorCommand | undefined {
  switch (key.name) {
    case "escape":
      return { type: "close" };
    case "up":
      return { type: "item", delta: -1 };
    case "down":
      return { type: "item", delta: 1 };
    case "left":
      return { type: "category", delta: -1 };
    case "right":
      return { type: "category", delta: 1 };
    case "pageup":
      return { type: "scroll", delta: -INSPECTOR_PAGE_ROWS };
    case "pagedown":
      return { type: "scroll", delta: INSPECTOR_PAGE_ROWS };
    case "home":
      return key.ctrl ? { type: "scroll", delta: -Math.max(0, maxScroll) } : undefined;
    case "end":
      return key.ctrl ? { type: "scroll", delta: Math.max(0, maxScroll) } : undefined;
    default:
      return undefined;
  }
}

/** 详情页内点中列表第 index 项：换选中并把原文滚动归零。 */
export function selectInspectorItem(state: ContextInspectorState, index: number): boolean {
  const group = inspectorGroup(state);
  if (!group || index >= group.items.length || index === state.selectedIndex) return false;
  state.selectedIndex = index;
  state.scroll = 0;
  return true;
}

// ── 费用日志页（列表 → 回合详情 → 请求详情）──

/** 当前停在哪一层：Esc / 返回按钮按这个逐层退回。 */
export function costLogLayer(state: CostLogPageState): "list" | "turn" | "request" {
  if (state.turnDetail?.openDetail) return "request";
  return state.turnDetail ? "turn" : "list";
}

/** 回合详情页内的选中移动（↑↓/PgUp/PgDn/滚轮/点击共用）。 */
export function moveTurnDetailSelection(state: CostLogPageState, delta: number): boolean {
  const view = state.turnDetail;
  if (!view || delta === 0) return false;
  const count = collectTurnDetails(state.details, view.turn).length;
  const next = clamp(view.selectedIndex + delta, count - 1);
  if (next === view.selectedIndex) return false;
  view.selectedIndex = next;
  return true;
}

/** ↑↓/PgUp/PgDn/滚轮：移动选中项；详情页开着时移动的是「这一次调用」而不是列表行。 */
export function moveCostLogSelection(state: CostLogPageState, delta: number): boolean {
  if (delta === 0) return false;
  if (state.turnDetail) return moveTurnDetailSelection(state, delta);
  const next = clamp(state.selectedIndex + delta, state.details.length - 1);
  if (next === state.selectedIndex) return false;
  state.selectedIndex = next;
  return true;
}

/**
 * 列表 → 回合详情：光标落在列表里选中的那一次调用上。
 * 返回 hint 表示打不开（这条记录没有轮次信息）。
 */
export function enterTurnDetail(state: CostLogPageState): { ok: boolean; hint?: string } {
  if (state.turnDetail) return { ok: false };
  const sorted = sortRequestDetails(state.details, state.sort);
  const picked = sorted[clamp(state.selectedIndex, sorted.length - 1)];
  if (!picked) return { ok: false };
  if (picked.turn <= 0) return { ok: false, hint: "这条记录没有轮次信息（老会话未分轮）" };
  const items = collectTurnDetails(state.details, picked.turn);
  const index = items.findIndex((item) => item.seq === picked.seq);
  state.turnDetail = { turn: picked.turn, selectedIndex: index < 0 ? 0 : index, openDetail: false };
  return { ok: true };
}

export type CostLogCommand =
  | { type: "back" }
  | { type: "enter" }
  | { type: "move"; delta: number }
  | { type: "consume" };

/**
 * 费用日志页的按键：只接管导航键，返回 undefined 表示交还输入框。
 * `typing` 为真（输入框里有字）时 Enter 是「发送」，不能被页面抢走。
 */
export function costLogKeyCommand(
  state: CostLogPageState,
  key: readline.Key,
  typing: boolean,
): CostLogCommand | undefined {
  switch (key.name) {
    case "escape":
      return { type: "back" };
    case "return":
    case "enter":
      if (typing) return undefined;
      // 请求详情已是最内层：消费掉即可。
      return state.turnDetail?.openDetail ? { type: "consume" } : { type: "enter" };
    case "left":
    case "right":
      // 详情页里左右切「同一回合内的相邻调用」，列表页仍留给输入框的左右移动。
      if (!state.turnDetail) return undefined;
      return { type: "move", delta: key.name === "left" ? -1 : 1 };
    case "up":
      return { type: "move", delta: -1 };
    case "down":
      return { type: "move", delta: 1 };
    case "pageup":
      return { type: "move", delta: -INSPECTOR_PAGE_ROWS };
    case "pagedown":
      return { type: "move", delta: INSPECTOR_PAGE_ROWS };
    case "home":
      return key.ctrl ? { type: "move", delta: -Number.MAX_SAFE_INTEGER } : undefined;
    case "end":
      return key.ctrl ? { type: "move", delta: Number.MAX_SAFE_INTEGER } : undefined;
    default:
      return undefined;
  }
}

/** 费用日志页内点中第 index 项：列表页与回合详情页各自的下标空间。 */
export function selectCostLogItem(state: CostLogPageState, index: number): boolean {
  const view = state.turnDetail;
  if (view) {
    const count = collectTurnDetails(state.details, view.turn).length;
    if (index >= count || index === view.selectedIndex) return false;
    view.selectedIndex = index;
    return true;
  }
  if (index >= state.details.length || index === state.selectedIndex) return false;
  state.selectedIndex = index;
  return true;
}

// ── PR 巡检页（单层列表：任务 → 详情行）──

/** ↑↓/PgUp/PgDn/滚轮/点击共用：移动选中项并夹紧到有效范围。 */
export function movePatrolSelection(state: PatrolPageState, delta: number): boolean {
  if (delta === 0) return false;
  const next = clamp(state.selectedIndex + delta, state.jobs.length - 1);
  if (next === state.selectedIndex) return false;
  state.selectedIndex = next;
  return true;
}

export type PatrolCommand = { type: "back" } | { type: "move"; delta: number };

/** 巡检页的按键：只接管导航键，返回 undefined 表示交还输入框。 */
export function patrolKeyCommand(key: readline.Key): PatrolCommand | undefined {
  switch (key.name) {
    case "escape":
      return { type: "back" };
    case "up":
      return { type: "move", delta: -1 };
    case "down":
      return { type: "move", delta: 1 };
    case "pageup":
      return { type: "move", delta: -INSPECTOR_PAGE_ROWS };
    case "pagedown":
      return { type: "move", delta: INSPECTOR_PAGE_ROWS };
    case "home":
      return key.ctrl ? { type: "move", delta: -Number.MAX_SAFE_INTEGER } : undefined;
    case "end":
      return key.ctrl ? { type: "move", delta: Number.MAX_SAFE_INTEGER } : undefined;
    default:
      return undefined;
  }
}

/** 巡检页内点中第 index 项。 */
export function selectPatrolItem(state: PatrolPageState, index: number): boolean {
  if (index >= state.jobs.length || index === state.selectedIndex) return false;
  state.selectedIndex = index;
  return true;
}
