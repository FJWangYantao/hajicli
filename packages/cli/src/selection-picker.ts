/**
 * 选择器（授权卡片、模型/权限档选择、计划审批等）的排版与按键状态转移。
 *
 * 从 TerminalUI 抽出的纯逻辑：输入是选择器状态与按键，输出是要渲染的行或要执行的动作；
 * TerminalUI 只持有状态、调度重绘，并在「确认 / 取消 / 翻页」落地时处理 Promise 与对话区滚动。
 */
import type readline from "node:readline";
import { isRealCtrlC } from "./terminal-keys.js";
import { formatMenuRows } from "./terminal-menu.js";
import {
  SEQ,
  splitGraphemes,
  terminalWidth,
  truncateAnsiText,
  truncateText,
} from "./terminal-text.js";

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
  /**
   * 外部决策方随选择给出的说明（仅 mcp-serve 驱动模式，来自 `haji_approve.reason`）。
   * 有值（含空串）表示说明已经收齐，调用方不能再开输入框——驱动模式的 stdin 是协议通道。
   */
  reason?: string;
}

/** 选择器的可变状态（不含 Promise 回调）。 */
export interface SelectionPickerState {
  query?: string;
  options: TerminalSelectionOptions;
  openedAt?: number;
  selectedIndex: number;
  secondaryIndex: number;
}

/** 可搜索列表按关键词过滤（标签、值、说明都参与匹配）；不可搜索时原样返回。 */
export function filterSelectionItems(
  state: SelectionPickerState,
): readonly TerminalSelectionItem[] {
  const query = state.options.searchable ? state.query?.trim().toLowerCase() : "";
  if (!query) return state.options.items;
  return state.options.items.filter((item) =>
    `${item.label} ${item.value} ${item.description ?? ""}`.toLowerCase().includes(query),
  );
}

/**
 * 选择器的行：标题与按键提示、次级轴、搜索栏、预览卡片、选项窗口（跟随选中项滚动）。
 * 预览只占「至少给选项留三行」之后的余量，超出时最后一行说明还剩多少。
 */
export function buildSelectionRows(
  state: SelectionPickerState,
  width: number,
  maxRows: number,
): string[] {
  if (maxRows <= 0) return [];
  const { options } = state;
  const items = filterSelectionItems(state);
  const navigation =
    options.hint ??
    (options.secondary
      ? `↑↓ 选择 · ←→ ${options.secondary.label} · Enter 确认 · Esc 取消`
      : "↑↓ 选择 · Enter 确认 · Esc 取消");
  const rows = [
    `${SEQ.bold}${truncateText(options.title, width)}${SEQ.reset}  ${SEQ.muted}${truncateText(navigation, Math.max(1, width - terminalWidth(options.title) - 2))}${SEQ.reset}`,
  ];

  if (options.secondary) {
    const selectedSecondary = options.secondary.items[state.secondaryIndex];
    const labels = options.secondary.items.map((item, index) =>
      index === state.secondaryIndex ? `‹${item.label}›` : item.label,
    );
    const fullSecondaryText = `${options.secondary.label}  ${labels.join("  ")}`;
    if (terminalWidth(fullSecondaryText) <= width) {
      const styled = options.secondary.items.map((item, index) =>
        index === state.secondaryIndex
          ? `${SEQ.boldAccent}‹${item.label}›${SEQ.reset}`
          : `${SEQ.muted}${item.label}${SEQ.reset}`,
      );
      rows.push(`${SEQ.muted}${options.secondary.label}${SEQ.reset}  ${styled.join("  ")}`);
    } else {
      const secondaryText = `${options.secondary.label}  ‹ ${selectedSecondary?.label ?? ""} ›`;
      rows.push(`${SEQ.boldAccent}${truncateText(secondaryText, width)}${SEQ.reset}`);
    }
  }

  if (options.searchable) {
    rows.push(
      `${SEQ.muted}${truncateText(`搜索：${state.query || "输入关键词"} · ${items.length}/${options.items.length} · 退格删除`, width)}${SEQ.reset}`,
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
    Math.max(0, state.selectedIndex - availableItemRows + 1),
    Math.max(0, items.length - availableItemRows),
  );
  const visibleItems = items.slice(firstVisibleIndex, firstVisibleIndex + availableItemRows);
  rows.push(
    ...formatMenuRows(
      visibleItems.map((item) => ({
        label: `${item.label}${item.hotkey ? ` (${item.hotkey})` : ""}`,
        description: item.description,
      })),
      state.selectedIndex - firstVisibleIndex,
      width,
    ),
  );
  return rows.slice(0, maxRows);
}

/**
 * 一次按键的结果：
 * - `ctrl-c`：有对话区选区时先复制，否则取消；`escape`：取消并通知 Esc 处理器；
 * - `page-up` / `page-down` / `jump-end`：滚动对话区（选择器打开时仍可翻看上文）；
 * - `confirm`：按当前选中项结案（热键已把选中项改好）；
 * - `changed`：状态变了需要重绘；`none`：忽略。
 */
export type SelectionKeyAction =
  | "ctrl-c"
  | "escape"
  | "page-up"
  | "page-down"
  | "jump-end"
  | "confirm"
  | "changed"
  | "none";

const cycle = (index: number, delta: number, count: number): number =>
  (index + delta + count) % count;

/** 按键对选择器状态的转移（就地修改 state）；返回调用方要落地的动作。 */
export function applySelectionKey(
  state: SelectionPickerState,
  value: string,
  key: readline.Key,
  now: number = Date.now(),
): SelectionKeyAction {
  if (isRealCtrlC(value, key)) return "ctrl-c";
  if (key.name === "escape") return "escape";
  if (key.name === "pageup") return "page-up";
  if (key.name === "pagedown") return "page-down";
  if (key.ctrl && key.name === "end") return "jump-end";
  const { options } = state;
  // Tab 在选择器里循环切换次级轴（授权卡的永久允许作用域 本项目 ⇄ 全局）。
  if ((key.name === "tab" && !key.shift) || key.name === "backtab" || value === "\x1b[Z") {
    if (!options.secondary) return "none";
    const backward =
      key.name === "backtab" || value === "\x1b[Z" || (key.shift && key.name === "tab");
    state.secondaryIndex = cycle(
      state.secondaryIndex,
      backward ? -1 : 1,
      options.secondary.items.length,
    );
    return "changed";
  }
  const confirmLocked = now - (state.openedAt ?? 0) < (options.confirmDelayMs ?? 0);
  if (key.name === "return" || key.name === "enter") return confirmLocked ? "none" : "confirm";
  if (
    options.searchable &&
    !key.ctrl &&
    !key.meta &&
    (key.name === "backspace" || (value && !/[\x00-\x1f\x7f]/u.test(value)))
  ) {
    const current = state.query ?? "";
    state.query =
      key.name === "backspace"
        ? splitGraphemes(current).slice(0, -1).join("")
        : (current + value).slice(0, 200);
    state.selectedIndex = 0;
    return "changed";
  }
  const hotkeyIndex =
    value && !key.ctrl && !key.meta
      ? options.items.findIndex(
          (item) => item.hotkey && item.hotkey.toLowerCase() === value.toLowerCase(),
        )
      : -1;
  if (hotkeyIndex >= 0) {
    if (confirmLocked) return "none";
    state.selectedIndex = hotkeyIndex;
    return "confirm";
  }
  if (key.name === "up" || key.name === "down") {
    const itemCount = filterSelectionItems(state).length;
    if (itemCount === 0) return "none";
    state.selectedIndex = cycle(state.selectedIndex, key.name === "up" ? -1 : 1, itemCount);
    return "changed";
  }
  if ((key.name === "left" || key.name === "right") && options.secondary) {
    state.secondaryIndex = cycle(
      state.secondaryIndex,
      key.name === "left" ? -1 : 1,
      options.secondary.items.length,
    );
    return "changed";
  }
  return "none";
}
