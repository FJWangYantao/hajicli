/**
 * 菜单行排版（斜杠补全、@ 文件补全与选择器共用）。
 */
import { fitText, SEQ, terminalWidth, truncateText } from "./terminal-text.js";

export interface MenuRow {
  label: string;
  description?: string;
}

/**
 * 菜单行（斜杠补全与选择器共用）：标签列按最宽项对齐，说明灰显并在超宽时以省略号截断；
 * 选中项用 ▸ 标记，与输入提示符 › 区分。
 */
export function formatMenuRows(
  items: readonly MenuRow[],
  selectedIndex: number,
  width: number,
): string[] {
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

/**
 * 候选窗口：超出 maxRows 时按选中项滚动（菜单行数恒 ≤ maxRows），
 * 并在末尾留一行「还有 N 条」提示——只有一行预算时不给提示，免得挤掉唯一候选。
 */
export function windowMenuRows(
  items: readonly MenuRow[],
  selectedIndex: number,
  width: number,
  maxRows: number,
): string[] {
  if (items.length === 0 || maxRows <= 0) return [];
  const showHint = items.length > maxRows && maxRows >= 2;
  const visibleCount = Math.min(Math.max(1, maxRows - (showHint ? 1 : 0)), items.length);
  const windowStart = Math.min(
    Math.max(0, selectedIndex - visibleCount + 1),
    items.length - visibleCount,
  );
  const rows = formatMenuRows(
    items.slice(windowStart, windowStart + visibleCount),
    selectedIndex - windowStart,
    width,
  );
  if (showHint && items.length > visibleCount) {
    const remaining = items.length - visibleCount;
    rows.push(
      `${SEQ.muted}${truncateText(`  ⋯ 还有 ${remaining} 条 · ↑↓ 浏览`, width)}${SEQ.reset}`,
    );
  }
  return rows;
}
