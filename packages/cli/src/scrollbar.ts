/**
 * 对话区右侧竖向滚动条：几何映射 + 增量格子输出。
 *
 * 为什么单独一层而不是把滚动条画进对话行：
 *   - `flushScreen` 在能滚动视口时只发增量（`buildViewportScrollUpdate`），
 *     它按「整行字符串是否相同」决定重画哪些行。滚动条一旦写进行里，每一行都随
 *     滚动位置变化，增量滚动会立刻退化成整块重绘（闪烁 + 吞吐损失）。
 *   - 写进行里还会改变折行宽度与选区坐标——滚动条不该参与其中任何一项。
 * 所以这里只产出「绝对定位的单格输出」：每帧只写变化的格子，且不碰行内容。
 *
 * 本模块是纯函数：颜色序列由调用方传入，方便单测在没有终端时验证输出。
 */

/** thumb 在轨道内的位置（0 基，相对轨道顶部）。 */
export interface ScrollbarThumb {
  top: number;
  /** thumb 占用的行数，至少 1。 */
  size: number;
}

/** 一帧要画的滚动条几何。 */
export interface ScrollbarPaint {
  /** 滚动条所在列（1 基）。 */
  column: number;
  /** 轨道首行的屏幕行号（0 基）。 */
  row: number;
  /** 轨道行数。 */
  height: number;
  /** thumb 在轨道内的起始行（0 基，相对轨道顶部）。 */
  thumbRow: number;
  /** thumb 占用的行数，至少 1。 */
  thumbSize: number;
  /** 指针悬停 / 正在拖动：thumb 用强调色。 */
  active: boolean;
}

/** 画格子用的 SGR 序列；无色模式下全部为空串。 */
export interface ScrollbarSgr {
  background: string;
  thumb: string;
  activeThumb: string;
  reset: string;
}

/** thumb 的字符：右半块，贴着对话区右边缘，占满一格但视觉上更细。 */
export const SCROLLBAR_THUMB = "▐";

/** 轨道少于这么多行时不画：thumb + 上下各一页都放不下，只是噪音。 */
export const SCROLLBAR_MIN_ROWS = 3;

/**
 * 内容 → thumb 几何。内容不溢出视口（或视口太矮）时返回 undefined。
 *
 * `offset` 与 `chatScrollOffset` 同口径：0 表示贴底，越大越靠上。
 */
export function computeScrollbarThumb(input: {
  total: number;
  viewport: number;
  offset: number;
}): ScrollbarThumb | undefined {
  const total = Math.trunc(input.total);
  const viewport = Math.trunc(input.viewport);
  if (!Number.isFinite(total) || viewport < SCROLLBAR_MIN_ROWS || total <= viewport)
    return undefined;

  const size = Math.min(viewport, Math.max(1, Math.round((viewport * viewport) / total)));
  const maxOffset = total - viewport;
  const offset = Math.min(Math.max(0, Math.trunc(input.offset) || 0), maxOffset);
  const span = viewport - size;
  const top = maxOffset === 0 ? 0 : Math.round((span * (maxOffset - offset)) / maxOffset);
  return { top, size };
}

/**
 * 拖动反解：thumb 顶行 → 滚动偏移。
 *
 * 与 {@link computeScrollbarThumb} 同一个比例关系（offset 越大越靠上），
 * 所以拖到顶即最早期历史，拖到底即贴底。结果按整数行量化，往返会有一行以内的漂移。
 */
export function scrollOffsetFromThumbRow(input: {
  thumbRow: number;
  viewport: number;
  thumbSize: number;
  maxOffset: number;
}): number {
  const maxOffset = Math.max(0, Math.trunc(input.maxOffset) || 0);
  if (maxOffset === 0) return 0;
  const span = Math.max(0, Math.trunc(input.viewport) - Math.max(1, Math.trunc(input.thumbSize)));
  if (span === 0) return 0;
  const row = Math.min(Math.max(0, Math.trunc(input.thumbRow) || 0), span);
  return Math.min(maxOffset, Math.max(0, Math.round(maxOffset * (1 - row / span))));
}

interface ScrollbarCell {
  column: number;
  row: number;
  thumb: boolean;
}

function thumbRows(paint: ScrollbarPaint | undefined): Set<number> {
  const rows = new Set<number>();
  if (!paint) return rows;
  for (let index = 0; index < paint.thumbSize; index += 1) {
    rows.add(paint.row + paint.thumbRow + index);
  }
  return rows;
}

/**
 * 本帧要写出的滚动条格子。
 *
 * - `previous` 是上一帧已经落到终端上的几何，`next` 是本帧想要的几何；
 * - `rewrittenRows` 是 `screenUpdate` 重画过的屏幕行（0 基）——那些行先被 `\x1b[2K`
 *   清过，滚动条格子跟着没了，必须补画；
 * - `repaintAll` 表示整块不可信（全量刷新，或终端滚动区把整段内容搬移过）：整段轨道
 *   逐格重写，因为旧的 thumb 格子可能已经跟着滚动跑到任意一行上；
 * - `width`/`height` 是本帧屏幕尺寸：缩窗口后旧轨道可能落在屏外，写那些格子会被终端
 *   夹到最后一行/列，反过来擦掉新帧刚画好的内容。
 */
export function buildScrollbarUpdate(input: {
  previous?: ScrollbarPaint;
  next?: ScrollbarPaint;
  rewrittenRows: ReadonlySet<number>;
  repaintAll: boolean;
  width: number;
  height: number;
  sgr: ScrollbarSgr;
}): string {
  const { previous, next, rewrittenRows, sgr } = input;
  if (!previous && !next) return "";

  const cells = new Map<string, ScrollbarCell>();
  const put = (column: number, row: number, thumb: boolean): void => {
    const key = `${column}:${row}`;
    if (thumb) {
      cells.set(key, { column, row, thumb });
      return;
    }
    // 同一格上「画 thumb」优先于「清空格子」：清空只是兜底，不能覆盖本帧要画的 thumb。
    if (!cells.has(key)) cells.set(key, { column, row, thumb: false });
  };

  const nextThumb = thumbRows(next);
  const previousThumb = thumbRows(previous);
  // 消失（next 为空）不值得整段重写：轨道上除了 thumb 之外本来就没写过东西。
  const repaintAll =
    input.repaintAll ||
    !previous ||
    (next !== undefined &&
      (previous.column !== next.column ||
        previous.row !== next.row ||
        previous.height !== next.height));

  if (repaintAll) {
    if (previous) {
      for (let row = previous.row; row < previous.row + previous.height; row += 1) {
        put(previous.column, row, false);
      }
    }
    if (next) {
      for (let row = next.row; row < next.row + next.height; row += 1) {
        put(next.column, row, nextThumb.has(row));
      }
    }
  } else if (previous && next) {
    for (const row of previousThumb) {
      if (!nextThumb.has(row) || rewrittenRows.has(row)) put(previous.column, row, false);
    }
    for (const row of nextThumb) {
      if (!previousThumb.has(row) || rewrittenRows.has(row) || previous.active !== next.active) {
        put(next.column, row, true);
      }
    }
  } else if (previous) {
    for (const row of previousThumb) put(previous.column, row, false);
  }

  if (cells.size === 0) return "";
  const ordered = [...cells.values()].sort((a, b) =>
    a.row === b.row ? a.column - b.column : a.row - b.row,
  );
  let output = "";
  for (const cell of ordered) {
    if (cell.column > input.width || cell.row >= input.height) continue;
    const position = `\x1b[${cell.row + 1};${cell.column}H`;
    if (cell.thumb) {
      const color = next?.active ? sgr.activeThumb : sgr.thumb;
      output += `${position}${sgr.background}${color}${SCROLLBAR_THUMB}${sgr.reset}`;
    } else {
      output += `${position}${sgr.background} ${sgr.reset}`;
    }
  }
  return output;
}
