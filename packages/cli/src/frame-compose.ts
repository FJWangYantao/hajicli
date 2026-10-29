/**
 * 主界面一帧的拼装纯函数：侧栏命中表换算、浮层卡片叠放、左区与侧栏逐行合成。
 *
 * 从 TerminalUI.renderFrame 拆出来，只做「给定几何 → 产出行 / 坐标」，不碰终端与实例状态，
 * 便于单测各种宽高组合下的对齐。
 */
import { terminalWidth, truncateAnsiText } from "./terminal-text.js";
import { composeSidebarRow, type SidebarRegion } from "./tui-sidebar.js";

/** 屏幕坐标（1 基、闭区间）下的命中框。 */
export interface ScreenHitBox {
  columnStart: number;
  columnEnd: number;
  rowStart: number;
  rowEnd: number;
}

/**
 * 把侧栏局部坐标的区域换算成屏幕命中框。保持 regions 的顺序（depth 升序）：
 * 调用方按插入顺序从后往前找，深层区域自然压过外层。
 */
export function sidebarHitBoxes(
  regions: readonly SidebarRegion[],
  columnBase: number,
  rowBase: number,
): Array<[string, ScreenHitBox]> {
  return regions.map((region) => {
    const columnStart = columnBase + region.hit.left;
    const rowStart = rowBase + region.hit.top;
    return [
      region.id,
      {
        columnStart,
        columnEnd: columnStart + region.hit.width - 1,
        rowStart,
        rowEnd: rowStart + region.hit.height - 1,
      },
    ];
  });
}

/**
 * 实时区域（工具草稿 / 工具格 / 推理预览）与正文之间要隔一个空行：
 * 正文不以换行结尾时补两个，已有一个补一个，已经空过一行就不补。
 */
export function liveTailSeparator(chatContent: string, liveTail: string): string {
  if (!liveTail || !chatContent) return "";
  if (chatContent.endsWith("\n\n")) return "";
  return chatContent.endsWith("\n") ? "\n" : "\n\n";
}

/**
 * 浮层卡片在对话区内的起始行：贴着锚点（圆环）上沿往上一行，且整张卡不越出对话区。
 * anchorRow 是锚点相对对话区顶部的行号。
 */
export function placeCard(cardHeight: number, chatHeight: number, anchorRow: number): number {
  return Math.max(0, Math.min(chatHeight - cardHeight, anchorRow - 1));
}

/**
 * 把卡片右对齐叠到对话区行上：卡片左边的原文按显示宽度截断，右侧补齐到 width，
 * 不改变行数，也不影响底下正文的折行与选区。
 */
export function overlayRightCard(
  rows: readonly string[],
  card: readonly string[] | undefined,
  cardTop: number,
  width: number,
): string[] {
  if (!card) return [...rows];
  return rows.map((row, index) => {
    const cardRow = card[index - cardTop];
    if (cardRow === undefined) return row;
    const cardWidth = Math.min(width, terminalWidth(cardRow));
    const left = Math.max(1, width - cardWidth + 1);
    const head = truncateAnsiText(row, left - 1);
    const pad = " ".repeat(Math.max(0, left - 1 - terminalWidth(head)));
    const tail = " ".repeat(Math.max(0, width - (left - 1) - cardWidth));
    return `${head}${pad}${truncateAnsiText(cardRow, cardWidth)}${tail}`;
  });
}

export interface SidebarColumn {
  rows: readonly string[];
  width: number;
  /** 侧栏第一行落在屏幕的第几行（0 基）。 */
  screenTop: number;
  surfaces?: ReadonlyArray<string | undefined>;
}

/**
 * 合成整屏行：左区每一行补到 leftWidth 后接侧栏（竖线贯穿整个高度，没有侧栏内容的行
 * 只留竖线与背景），不足 height 时补空行，保证右边界处处对齐。没有侧栏就只截断/补齐。
 */
export function composeScreenRows(
  leftRows: readonly string[],
  height: number,
  leftWidth: number,
  sidebar?: SidebarColumn,
): string[] {
  const screenRows = leftRows.slice(0, height).map((row, index) => {
    if (!sidebar) return row;
    const sidebarIndex = index - sidebar.screenTop;
    const sidebarRow =
      sidebarIndex >= 0 && sidebarIndex < sidebar.rows.length ? sidebar.rows[sidebarIndex] : "";
    return composeSidebarRow(
      row,
      leftWidth,
      sidebarRow ?? "",
      sidebar.width,
      sidebar.surfaces?.[sidebarIndex],
    );
  });
  while (screenRows.length < height) {
    screenRows.push(sidebar ? composeSidebarRow("", leftWidth, "", sidebar.width) : "");
  }
  return screenRows;
}
