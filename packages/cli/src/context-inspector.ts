/**
 * 上下文详情页的纯渲染层：把「分类 → 条目 → 原文」排成占据对话区的一屏。
 *
 * 与 terminal-panels / tui-sidebar 同一模式：只读标量状态、输出 ANSI 行，
 * 不做 I/O、不持定时器。每行宽度严格等于传入的 width，超出统一裁剪，
 * 所以能用固定宽度直接单测（见 test/context-inspector.test.mjs）。
 *
 * 版式取自设计原型「页面 B」：进页面时临时收起右侧栏，拿回整行宽度，
 * 左栏是条目列表、右栏是选中条目的原文；宽度不够时降级为上下单栏。
 */
import type { ContextItemGroup } from "./context-breakdown.js";
import { sanitizeTerminalText } from "./terminal-sanitize.js";
import {
  normalizeTerminalOutput,
  SEQ,
  terminalWidth,
  truncateAnsiText,
  truncateText,
  wrapAnsi,
} from "./terminal-text.js";

/** 低于该宽度时不再两栏，改成上下单栏。 */
const TWO_COLUMN_MIN = 76;
/** 页面本身要求的最小宽度；再窄就由调用方拦下并提示。 */
export const CONTEXT_INSPECTOR_MIN_COLUMNS = 48;
/** 页面要求的最小高度（顶框 + 分类 + 分隔 + 内容 + 分隔 + 底框）。 */
export const CONTEXT_INSPECTOR_MIN_ROWS = 9;
const LIST_MIN_WIDTH = 24;
const LIST_MAX_WIDTH = 32;
/** 单栏模式下列表最多占内容区的比例，剩下的留给原文。 */
const STACK_LIST_RATIO = 0.42;
const STACK_LIST_MIN_ROWS = 3;

/** 详情页的渲染状态：调用方持有，翻页时只改这几个数。 */
export interface ContextInspectorState {
  groups: readonly ContextItemGroup[];
  categoryIndex: number;
  selectedIndex: number;
  /** 原文区的滚动行；渲染时按内容高度夹紧，并把实际值回写进 frame.maxScroll。 */
  scroll: number;
}

/** 一帧的产物：屏幕行 + 鼠标命中区域（行号均为 0 基，相对本帧）。 */
export interface ContextInspectorFrame {
  rows: string[];
  /** 条目列表首行与行数；点击落在里面就选中对应条目。 */
  listTop: number;
  listHeight: number;
  listLeft: number;
  listWidth: number;
  /** 列表首行对应的条目下标（条目多时列表随选中项滚动，点击要加回这段偏移）。 */
  listOffset: number;
  /** 原文区可滚动上限；调用方据此夹紧 state.scroll。 */
  maxScroll: number;
  /** 顶栏「Esc 返回」的命中范围。 */
  back: { row: number; left: number; width: number };
}

/** tokens 口径与侧栏一致：不到 1000 直接给数，再大收成 k / M。 */
export function formatInspectorTokens(value: number): string {
  const safe = Math.max(0, Math.round(value));
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(safe < 10_000_000 ? 1 : 0)}M`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(safe < 10_000 ? 1 : 0)}k`;
  return String(safe);
}

/** 按可见宽度补空格（超宽先裁剪），保证整行恰好占满。 */
function padToWidth(text: string, width: number): string {
  const visible = terminalWidth(text);
  if (visible >= width) return truncateAnsiText(text, width);
  return `${text}${" ".repeat(width - visible)}`;
}

/** 顶栏右侧的返回按钮文案：带方括号，明示这是一颗可点的按钮。 */
const BACK_LABEL = "[Esc 返回]";
/** 窄屏用的短文案：标题还要留位置，所以只保留动作。 */
const BACK_LABEL_SHORT = "[返回]";

/** 按可用宽度挑按钮文案；渲染与命中矩形都走这里，保证两者永远一致。 */
function backLabelFor(width: number): string {
  return width >= 68 ? BACK_LABEL : BACK_LABEL_SHORT;
}

/**
 * 顶框：`╭ 标题 ─── [Esc 返回] ╮`。
 *
 * 先给返回按钮留位再裁标题：按钮是唯一能点回对话区的控件，任何宽度下都得画出来；
 * 标题放不下时用省略号收尾。
 */
function topBorder(width: number, title: string): string {
  const rightText = truncateText(` ${backLabelFor(width)} `, Math.max(0, width - 2));
  const titleText = truncateText(` ${title} `, Math.max(0, width - 2 - terminalWidth(rightText)));
  const fill = Math.max(0, width - 2 - terminalWidth(titleText) - terminalWidth(rightText));
  return `${SEQ.faint}╭${SEQ.reset}${SEQ.boldAccent}${titleText}${SEQ.reset}${SEQ.faint}${"─".repeat(fill)}${SEQ.reset}${SEQ.accent}${rightText}${SEQ.reset}${SEQ.faint}╮${SEQ.reset}`;
}

/** 把按钮文字宽度换算成整行内的命中矩形（行 0，靠右并左右各放宽 1 列）。 */
function backHit(textWidth: number, width: number): { row: number; left: number; width: number } {
  const left = Math.max(0, width - 1 - textWidth);
  const hitLeft = Math.max(0, left - 1);
  return {
    row: 0,
    left: hitLeft,
    width: Math.max(0, Math.min(textWidth + 2, width - 1 - hitLeft)),
  };
}

/** 底框：提示靠右，`╰─── 提示 ╯`。 */
function bottomBorder(width: number, hint: string): string {
  const hintText = truncateText(` ${hint} `, Math.max(1, width - 2));
  const fill = Math.max(0, width - 2 - terminalWidth(hintText));
  return `${SEQ.faint}╰${"─".repeat(fill)}${SEQ.reset}${SEQ.muted}${hintText}${SEQ.reset}${SEQ.faint}╯${SEQ.reset}`;
}

/**
 * 一整行的水平分隔，左右用框线字符收口。
 *
 * joints 是「内容区」内的 0 基列偏移（不含左边框那一列）；jointChar 用来
 * 区分上下两种接法：分栏开始用 ┬，分栏结束用 ┴。
 */
function hLine(
  width: number,
  left: string,
  right: string,
  joints: readonly number[] = [],
  jointChar = "┬",
): string {
  const inner = Math.max(0, width - 2);
  const marks = new Set(joints);
  let body = "";
  for (let index = 0; index < inner; index += 1) body += marks.has(index) ? jointChar : "─";
  return `${SEQ.faint}${left}${body}${right}${SEQ.reset}`;
}

/** 左右各有竖线的内容行：内容按 inner 宽度裁剪并补空格。 */
function frameRow(width: number, content: string): string {
  const inner = Math.max(0, width - 2);
  const body = truncateAnsiText(content, inner);
  const gap = Math.max(0, inner - terminalWidth(body));
  return `${SEQ.faint}│${SEQ.reset}${body}${" ".repeat(gap)}${SEQ.faint}│${SEQ.reset}`;
}

/** 两栏行：`│ 左栏 │ 右栏 │`，split 是中间竖线所在列（0 基）。 */
function twoColumnRow(width: number, split: number, left: string, right: string): string {
  const leftWidth = Math.max(0, split - 1);
  const rightWidth = Math.max(0, width - split - 2);
  const leftBody = truncateAnsiText(left, leftWidth);
  const rightBody = truncateAnsiText(right, rightWidth);
  const leftGap = Math.max(0, leftWidth - terminalWidth(leftBody));
  const rightGap = Math.max(0, rightWidth - terminalWidth(rightBody));
  return `${SEQ.faint}│${SEQ.reset}${leftBody}${" ".repeat(leftGap)}${SEQ.faint}│${SEQ.reset}${rightBody}${" ".repeat(rightGap)}${SEQ.faint}│${SEQ.reset}`;
}

/** 分类切换行：宽够就把六类并排，不够只留当前类 + 序号。 */
function categoryRow(groups: readonly ContextItemGroup[], active: number, width: number): string {
  const label = (index: number): string => {
    const group = groups[index];
    const dot = index === active ? "▣" : " ";
    const text = group.label;
    return index === active
      ? `${SEQ.boldAccent}${dot}${text}${SEQ.reset} ${SEQ.accent}${formatInspectorTokens(group.tokens)}${SEQ.reset}`
      : `${SEQ.muted}${dot}${text}${SEQ.reset} ${SEQ.faint}${formatInspectorTokens(group.tokens)}${SEQ.reset}`;
  };
  const separator = ` ${SEQ.faint}│${SEQ.reset} `;
  const full = groups.map((_, index) => label(index)).join(separator);
  if (terminalWidth(full) <= width) return full;
  const compact = `${label(active)} ${SEQ.faint}· ${active + 1}/${groups.length}${SEQ.reset}`;
  return padToWidth(compact, width);
}

/** 列表行：`1. read AGENTS.md        2.1k`，选中项高亮并加 ▸。 */
function listRows(
  group: ContextItemGroup,
  width: number,
  selectedIndex: number,
  height: number,
  offset: number,
): string[] {
  const tokenTexts = group.items.map((item) => formatInspectorTokens(item.tokens));
  const tokenWidth = Math.max(4, ...tokenTexts.map((text) => terminalWidth(text)));
  const numberWidth = Math.max(2, String(Math.max(1, group.items.length)).length + 1);
  const rows: string[] = [];
  for (let row = 0; row < height; row += 1) {
    const index = offset + row;
    const item = group.items[index];
    if (!item) {
      rows.push("");
      continue;
    }
    const selected = index === selectedIndex;
    const marker = selected ? "▸" : " ";
    const number = `${String(index + 1).padStart(numberWidth - 1)}.`;
    const token = tokenTexts[index].padStart(tokenWidth);
    const labelWidth = Math.max(1, width - 2 - numberWidth - tokenWidth - 1);
    const label = truncateText(item.label, labelWidth);
    const labelGap = Math.max(0, labelWidth - terminalWidth(label));
    const numberPart = selected
      ? `${SEQ.boldAccent}${marker}${number}${SEQ.reset}`
      : ` ${SEQ.faint}${number}${SEQ.reset}`;
    const labelPart = selected
      ? `${SEQ.accent}${label}${SEQ.reset}`
      : `${SEQ.muted}${label}${SEQ.reset}`;
    const tokenPart = selected
      ? `${SEQ.boldAccent}${token}${SEQ.reset}`
      : `${SEQ.faint}${token}${SEQ.reset}`;
    rows.push(`${numberPart}${labelPart}${" ".repeat(labelGap)} ${tokenPart}`);
  }
  return rows;
}

/** 原文行：先按详情宽度换行，再按 scroll 切片。 */
function detailRows(
  group: ContextItemGroup,
  selectedIndex: number,
  width: number,
): { lines: string[]; item?: (typeof group.items)[number] } {
  const item = group.items[selectedIndex];
  if (!item) return { lines: [] };
  const header = `${SEQ.boldAccent}${truncateText(item.label, Math.max(1, width))}${SEQ.reset}`;
  // 工具结果可能夹带 ANSI 与控制字符：先剥成纯文本再换行，否则一段残留序列
  // 能把整屏的框线打乱（详情页是只读页面，不值得为了保色冒这个风险）。
  const body = normalizeTerminalOutput(sanitizeTerminalText(item.detail));
  return { lines: [header, "", ...wrapAnsi(body, Math.max(1, width))], item };
}

/**
 * 排出整屏页面。
 *
 * 行结构（两栏）：顶框 / 分类 / ├─┬─┤ / 内容 ×N / ├─┴─┤ / 底框。
 * 单栏模式只是把内容区再拆一刀：上列表、下原文。
 */
export function buildContextInspectorFrame(
  state: ContextInspectorState,
  width: number,
  height: number,
): ContextInspectorFrame {
  const safeWidth = Math.max(CONTEXT_INSPECTOR_MIN_COLUMNS, Math.floor(width));
  const safeHeight = Math.max(CONTEXT_INSPECTOR_MIN_ROWS, Math.floor(height));
  const groups = state.groups;
  const categoryIndex = Math.min(Math.max(0, state.categoryIndex), Math.max(0, groups.length - 1));
  const group = groups[categoryIndex] ?? {
    category: "system",
    label: "系统",
    tokens: 0,
    items: [],
  };
  const selectedIndex = Math.min(
    Math.max(0, state.selectedIndex),
    Math.max(0, group.items.length - 1),
  );

  const inner = safeWidth - 2;
  const twoColumn = safeWidth >= TWO_COLUMN_MIN;
  // 内容区 = 总高 - 顶框 - 分类 - 分隔 - 分隔 - 底框
  const contentHeight = Math.max(1, safeHeight - 5);

  const split = twoColumn
    ? Math.min(LIST_MAX_WIDTH, Math.max(LIST_MIN_WIDTH, Math.round(inner * 0.3)))
    : 0;
  const listWidth = twoColumn ? Math.max(1, split - 1) : inner;
  const detailWidth = twoColumn ? Math.max(1, safeWidth - split - 2) : inner;

  // 列表在条目多于可视行时随选中项滚动，保证选中项始终可见。
  const listHeight = twoColumn
    ? contentHeight
    : Math.max(
        STACK_LIST_MIN_ROWS,
        Math.min(contentHeight - 1, Math.round(contentHeight * STACK_LIST_RATIO)),
      );
  const listOffset = Math.max(
    0,
    Math.min(selectedIndex - listHeight + 1, Math.max(0, group.items.length - listHeight)),
  );
  const detailHeight = twoColumn ? contentHeight : Math.max(0, contentHeight - listHeight - 1);

  const detail = detailRows(group, selectedIndex, detailWidth);
  const maxScroll = Math.max(0, detail.lines.length - detailHeight);
  const scroll = Math.min(Math.max(0, state.scroll), maxScroll);

  const list = listRows(group, listWidth, selectedIndex, listHeight, listOffset);

  const rows: string[] = [];
  const title = `上下文 · ${group.label} · ${group.items.length} 项`;
  rows.push(topBorder(safeWidth, title));
  rows.push(frameRow(safeWidth, categoryRow(groups, categoryIndex, inner)));

  if (twoColumn) {
    rows.push(hLine(safeWidth, "├", "┤", [split - 1], "┬"));
    for (let index = 0; index < contentHeight; index += 1) {
      const right = detail.lines[scroll + index] ?? "";
      rows.push(twoColumnRow(safeWidth, split, list[index] ?? "", right));
    }
    rows.push(hLine(safeWidth, "├", "┤", [split - 1], "┴"));
  } else {
    rows.push(hLine(safeWidth, "├", "┤"));
    for (let index = 0; index < listHeight; index += 1) {
      rows.push(frameRow(safeWidth, list[index] ?? ""));
    }
    if (detailHeight > 0) {
      rows.push(hLine(safeWidth, "├", "┤"));
      for (let index = 0; index < detailHeight; index += 1) {
        rows.push(frameRow(safeWidth, detail.lines[scroll + index] ?? ""));
      }
    }
    rows.push(hLine(safeWidth, "├", "┤"));
  }

  // 窄屏放不下完整提示，只保留最要紧的两件事：怎么查看、怎么回去。
  const hint =
    group.items.length === 0
      ? "←→ 切分类 · Esc 或点右上返回"
      : twoColumn
        ? "点条目查看 · ↑↓/←→ 切换 · PgUp/PgDn 滚动 · Esc 或点右上返回"
        : "点条目查看 · Esc 或点右上返回";
  rows.push(bottomBorder(safeWidth, hint));

  // 行数兜底：窗口比最小高度还矮时补齐，避免调用方切片越界。
  while (rows.length < safeHeight) rows.push(padToWidth("", safeWidth));

  const backText = ` ${backLabelFor(safeWidth)} `;
  return {
    rows: rows.slice(0, safeHeight),
    listTop: 3,
    listHeight,
    listLeft: 1,
    listWidth,
    /** 列表可视区第一条对应的条目下标（选中项滚出视野时 > 0）。 */
    listOffset,
    maxScroll,
    // 命中区比按钮文字左右各宽 1 列，鼠标差一格也能点中。
    back: backHit(terminalWidth(backText), safeWidth),
  };
}
